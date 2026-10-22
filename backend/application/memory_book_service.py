"""记忆本用例编排（2026-10-18，application 层）。

职责：
- 工具 ``save_item / list_items / rename_item / delete_item`` 的业务处理；
- 打开前解析（``open_item``：名字 → 精确值 / 临时 URL 本轮消息校验）；
- 删除真实文件前解析（``delete_path``：路径存在性 + 保护目录 + "删记录还是删文件"歧义判定）；
- 删除/更新时联动长期记忆：清掉包含旧值的记忆，并写入遗忘名单，防止后台提取
  从旧对话里把用户已"忘掉"的链接/路径再捞回来。

**本服务不删除任何真实文件。** ``delete_path`` 只负责校验并返回给前端；前端弹
确认气泡，用户点「删除」后由 Electron 主进程 ``shell.trashItem`` 移入回收站。
"""

from __future__ import annotations

import difflib
import os
import re
from typing import Any, Iterable

from loguru import logger

from backend.modules.memory.store import MemoryStore
from backend.modules.memory_book import (
    KINDS,
    ItemNotFound,
    NameConflict,
    MemoryBookError,
    MemoryBookStore,
    SavedItem,
    build_memory_book_block,
    deletable_block_reason,
    normalize_link,
    normalize_name,
    normalize_path,
    normalize_program_path,
    resolve_kind,
)

#: 一次工具调用最多处理的条目数（防模型一次塞爆）
MAX_BATCH = 10
#: 短文本做记忆清理/遗忘名单的最小长度——太短的文本（如"123"）做子串匹配会误伤
MIN_FORGET_TEXT_LEN = 8

#: 删除意图判定（只用于"路径条目"的歧义保护）
#: “连…一起”必须连着文件/文件夹/目录，否则“连记录一起删”会被误判成删文件。
_FILE_INTENT_RE = re.compile(
    r"(文件|文件夹|目录|磁盘|硬盘|本地|回收站|电脑上|连.{0,8}(?:文件|文件夹|目录).{0,4}一起)"
)
_RECORD_INTENT_RE = re.compile(r"(记录|记忆本|忘掉|别记|不用记|不要记|别存|移除)")

#: 逐条结果里展示值的长度
_VALUE_PREVIEW = 200


def _string(args: dict[str, Any], key: str) -> str:
    """取字符串参数：非字符串按空串（避免 str(None) 变成 "None"）。"""
    value = args.get(key)
    return value.strip() if isinstance(value, str) else ""


def _text_key(text: str) -> str:
    """用户原话归一化（空白压缩 + casefold），用于"是否点名"判定。"""
    return " ".join(str(text or "").split()).casefold()


def _path_key(text: str) -> str:
    """路径比较键：分隔符统一 + Windows 大小写不敏感。"""
    return os.path.normcase(str(text or "").replace("\\", "/"))


class MemoryBookService:
    """记忆本工具用例：保存/列表/改名/删记录 + 打开/删文件的前置解析。"""

    def __init__(self, store: MemoryBookStore, memories: MemoryStore | None = None) -> None:
        self._store = store
        self._memories = memories

    # ---------------------------------------------------------------- 工具：保存

    def save_from_tool(self, items: Any, *, allow_program: bool = False) -> dict[str, Any]:
        """批量保存/同名更新；返回 ``{ok, code, message}``（汇总为一条通知）。

        ``allow_program``：只有设置页（WS ``client_role=settings``）传 True。
        对话工具路径一律拒绝 ``program``——否则模型被网页/文件内容诱导后，可以
        批量登记"免确认可运行"的程序。
        """
        entries = self._coerce_items(items)
        if not entries:
            return {
                "ok": False,
                "code": "items_save_failed",
                "message": "要记住什么？把链接、路径或内容告诉我就行～",
            }

        saved: list[str] = []
        updated: list[str] = []
        auto_named: list[str] = []
        failed: list[str] = []
        for entry in entries[:MAX_BATCH]:
            name = _string(entry, "name")
            kind = _string(entry, "kind") or None
            value = _string(entry, "value")
            if not value:
                failed.append("（有一项没给内容）")
                continue
            if not allow_program and resolve_kind(kind) == "program":
                failed.append(
                    f"{value[:40]}：程序条目只能在设置 → 记忆本里手动添加"
                )
                continue
            try:
                outcome = self._store.save(name=name, kind=kind, value=value)
            except (ValueError, MemoryBookError) as exc:
                failed.append(f"{value[:40]}：{exc}")
                continue

            # 同名更新：旧值从长期记忆里清掉并加入遗忘名单，防止旧链接又被翻出来
            if outcome.old_value and outcome.old_value != outcome.item.value:
                self._forget_value(outcome.old_value, outcome.item.kind)
            # 用户重新保存了这个值 → 解除遗忘
            self._store.clear_forgotten(outcome.item.value)

            label = f"{outcome.item.name}（{outcome.item.kind_label}）"
            if outcome.updated:
                updated.append(label)
            else:
                saved.append(label)
            if outcome.auto_name and outcome.created:
                auto_named.append(outcome.item.name)

        parts: list[str] = []
        if saved:
            parts.append("记好啦：" + "、".join(saved))
        if updated:
            parts.append("已更新：" + "、".join(updated))
        if auto_named:
            parts.append(
                "（没给名字，我先按这些名字记的："
                + "、".join(auto_named)
                + "；想改名跟我说）"
            )
        if failed:
            parts.append("没记成：" + "；".join(failed))
        if not parts:
            parts.append("没记成，再说一次好吗？")
        ok = bool(saved or updated)
        return {
            "ok": ok,
            "code": "items_saved" if ok else "items_save_failed",
            "message": "\n".join(parts),
        }

    # ---------------------------------------------------------------- 工具：列表

    def list_from_tool(self, kind: str | None = None, limit: int = 50) -> dict[str, Any]:
        """列出条目（路径类顺手检查是否存在）；作为通知展示给用户。"""
        valid_kind = kind if kind in KINDS else None
        try:
            count = max(1, min(100, int(limit)))
        except (TypeError, ValueError):
            count = 50
        all_items = self._store.list_all(valid_kind)
        items = all_items[:count]
        if not items:
            scope = f"（{self._kind_label(valid_kind)}）" if valid_kind else ""
            return {
                "ok": True,
                "code": "items_listed",
                "message": (
                    f"记忆本里还没有{scope}条目。跟小兔说“记住……”就会记在这里。"
                    if self._store.count() == 0
                    else f"记忆本里没有{scope}条目。"
                ),
            }

        lines = [
            f"记忆本里共有 {self._store.count()} 条"
            + (f"，当前显示 {len(items)} 条{self._kind_label(valid_kind)}" if valid_kind else "")
            + "："
        ]
        for index, item in enumerate(items, start=1):
            status = ""
            if item.kind == "path" and not self._store.path_ok(item):
                status = "  ⚠ 路径不存在"
            elif item.kind == "program" and not self._store.path_ok(item):
                status = "  ⚠ 程序不存在或不可执行"
            lines.append(f"{index}. {item.name}（{item.kind_label}）{status}")
            preview = " ".join(item.value.split())[:_VALUE_PREVIEW]
            lines.append(f"   {preview}")
        remaining = len(all_items) - len(items)
        if remaining > 0:
            lines.append(f"……还有 {remaining} 条，可以在设置 → 记忆本里查看。")
        return {"ok": True, "code": "items_listed", "message": "\n".join(lines)}

    # ---------------------------------------------------------------- 工具：改名

    def rename_from_tool(self, old_name: str, new_name: str) -> dict[str, Any]:
        """按名字改名；冲突/不存在返回可直接展示的原因。"""
        old_clean = normalize_name(old_name)
        new_clean = normalize_name(new_name)
        if not old_clean or not new_clean:
            return {
                "ok": False,
                "code": "item_rename_failed",
                "message": "要改哪一条？改成什么名字？",
            }
        try:
            item = self._store.rename(old_clean, new_clean)
        except ItemNotFound:
            return {
                "ok": False,
                "code": "item_not_found",
                "message": self._not_found_message(old_clean),
            }
        except NameConflict as exc:
            return {"ok": False, "code": "item_name_conflict", "message": str(exc)}
        except (ValueError, MemoryBookError) as exc:
            return {"ok": False, "code": "item_rename_failed", "message": str(exc)}
        return {
            "ok": True,
            "code": "item_renamed",
            "message": f"好，『{old_clean}』改名叫『{item.name}』啦",
        }

    # ---------------------------------------------------------------- 工具：删记录

    def delete_from_tool(
        self, names: Any, user_text: str = "", *, trust: bool = False
    ) -> dict[str, Any]:
        """只从记忆本删除记录（不动磁盘文件）。

        ``trust=False``（模型工具路径）的保护：
        - 用户本轮话里必须点名（防止模型/文件内容诱导删除）；
        - 路径条目必须先说清"只删记录"——只说"删掉 X"时返回反问，不猜。

        ``trust=True``（设置页用户亲手点删记录）：跳过上述两项——
        设置页的删除按钮本身就是明确的用户操作，且按钮文案就是"只删记录"。
        """
        entries = self._coerce_names(names)
        if not entries:
            return {
                "ok": False,
                "code": "item_delete_failed",
                "message": "要忘掉哪一条？把名字告诉我就行。",
            }

        deleted: list[str] = []
        failed: list[str] = []
        for name in entries[:MAX_BATCH]:
            item = self._store.find_by_name(name)
            if item is None:
                failed.append(self._not_found_message(name))
                continue
            if not trust and not self._name_mentioned(item.name, user_text):
                failed.append(f"『{item.name}』：请明确点名要删哪一条")
                continue
            if not trust and item.kind == "path":
                intent = self._path_delete_intent(user_text)
                if intent == "file":
                    failed.append(
                        f"『{item.name}』是本机路径。如果要把磁盘上的文件/文件夹也删掉，"
                        "请用删除文件（我会先弹确认）；如果只删记忆本记录，请说“从记忆本删掉”。"
                    )
                    continue
                if intent in ("both", "ambiguous"):
                    failed.append(
                        f"『{item.name}』是本机路径。你是想只删记忆本记录，"
                        f"还是连 {item.value} 这个文件/文件夹一起删？"
                    )
                    continue
            self._store.delete(item.name)
            self._forget_value(item.value, item.kind)
            deleted.append(item.name)

        parts: list[str] = []
        if deleted:
            parts.append("已经从记忆本删掉：" + "、".join(deleted))
        if failed:
            parts.append("没删成：" + "；".join(failed))
        return {
            "ok": bool(deleted),
            "code": "items_deleted" if deleted else "item_delete_failed",
            "message": "\n".join(parts) if parts else "没有要删的条目。",
        }

    # ---------------------------------------------------------------- 打开前解析

    def prepare_open(self, args: dict[str, Any], user_text: str) -> dict[str, Any]:
        """``open_item`` 的前置解析：名字 → 精确值；临时 URL 必须有本轮出处。"""
        name = _string(args, "name")
        url = _string(args, "url")
        if not name and not url:
            return {
                "ok": False,
                "code": "open_item_missing",
                "message": "要打开记忆本里的哪一条？或者把要打开的链接发我。",
            }

        if name:
            item = self._store.find_by_name(name)
            if item is None:
                return {
                    "ok": False,
                    "code": "item_not_found",
                    "message": self._not_found_message(name),
                }
            if item.kind == "text":
                return {
                    "ok": False,
                    "code": "item_not_openable",
                    "message": f"『{item.name}』是一段文字，不是链接或文件；你可以直接问我它的内容。",
                }
            if item.kind == "program":
                return {
                    "ok": False,
                    "code": "item_is_program",
                    "message": (
                        f"『{item.name}』是一个程序，不是链接或文件。"
                        f"说“运行 {item.name}”我就会启动它。"
                    ),
                }
            if item.kind == "path" and not self._store.path_ok(item):
                return {
                    "ok": False,
                    "code": "path_missing",
                    "message": (
                        f"『{item.name}』的路径现在找不到：{item.value}\n"
                        "可能被移动/删除，或磁盘没连接。可以在设置 → 记忆本里更新，"
                        "或者告诉我新路径。"
                    ),
                }
            return {
                "ok": True,
                "args": {"kind": item.kind, "value": item.value, "name": item.name},
            }

        try:
            normalized = normalize_link(url)
        except ValueError as exc:
            return {"ok": False, "code": "bad_url", "message": str(exc)}
        if not self._url_mentioned(normalized, user_text):
            return {
                "ok": False,
                "code": "url_not_in_message",
                "message": (
                    "只能打开你本轮消息里出现过的链接，或者先把链接记到记忆本。"
                    "这样别人写在文件/网页里的链接不能诱导我打开。"
                ),
            }
        return {"ok": True, "args": {"kind": "link", "value": normalized}}

    # ---------------------------------------------------------------- 运行前解析

    def prepare_run_program(
        self, args: dict[str, Any], user_text: str
    ) -> dict[str, Any]:
        """``run_program`` 的前置解析：三种来源 → 前端可执行参数。

        返回的 ``args.kind``：

        - ``program``：命中了记忆本里用户手动登记的程序（免确认）；
        - ``app``：用户本轮点名的已安装应用，由主进程在开始菜单/.desktop 里匹配（免确认）；
        - ``path``：用户本轮给出的临时绝对路径（主进程会弹确认气泡）。

        授权规则：
        - 记忆本命中即放行（与 ``open_item`` 一致；条目本身是用户授权过的）；
        - 系统应用名 / 临时路径必须出现在用户本轮原话里——防止文件/网页内容诱导。
        """
        name = _string(args, "name")
        raw_path = _string(args, "path")
        if not name and not raw_path:
            return {
                "ok": False,
                "code": "run_program_missing",
                "message": "要运行哪个程序？告诉我名字或可执行文件的绝对路径。",
            }
        if name and raw_path:
            return {
                "ok": False,
                "code": "run_program_ambiguous_args",
                "message": "一次只能运行一个程序：给我名字，或者给绝对路径。",
            }

        if name:
            item = self._store.find_by_name(name)
            if item is not None:
                if item.kind != "program":
                    return {
                        "ok": False,
                        "code": "item_not_program",
                        "message": (
                            f"『{item.name}』是一条{item.kind_label}，不是程序。"
                            + (
                                f"想打开它请说“打开 {item.name}”。"
                                if item.kind in ("link", "path")
                                else ""
                            )
                        ),
                    }
                if not self._store.path_ok(item):
                    return {
                        "ok": False,
                        "code": "program_missing",
                        "message": (
                            f"『{item.name}』现在运行不了：{item.value}\n"
                            "可能被移动/删除，或没有执行权限。可以在设置 → 记忆本里更新。"
                        ),
                    }
                return {
                    "ok": True,
                    "args": {"kind": "program", "name": item.name, "path": item.value},
                }

            if not self._name_mentioned(name, user_text):
                return {
                    "ok": False,
                    "code": "name_not_in_message",
                    "message": (
                        "只能运行你本轮消息里点名说出的应用，或者先在设置 → 记忆本里登记。"
                        "这样别人写在文件/网页里的应用名不能诱导我启动。"
                    ),
                }
            return {"ok": True, "args": {"kind": "app", "name": name}}

        # 临时绝对路径：必须是用户本轮话里明确给出的 + 真正的可执行文件
        try:
            target = normalize_program_path(raw_path)
        except ValueError as exc:
            return {"ok": False, "code": "bad_program", "message": str(exc)}
        if not self._path_mentioned(raw_path, user_text):
            return {
                "ok": False,
                "code": "path_not_in_message",
                "message": (
                    "只能运行你本轮消息里明确给出的路径，或者先在设置 → 记忆本里登记。"
                    "这样别人写在文件/网页里的路径不能诱导我运行。"
                ),
            }
        return {
            "ok": True,
            "args": {"kind": "path", "name": target.name, "path": str(target)},
        }

    # ---------------------------------------------------------------- 删文件前解析

    def prepare_delete_path(self, args: dict[str, Any], user_text: str) -> dict[str, Any]:
        """``delete_path`` 的前置解析：只校验并返回目标；删除由前端确认后主进程执行。"""
        name = _string(args, "name")
        raw_path = _string(args, "path")
        if not name and not raw_path:
            return {
                "ok": False,
                "code": "delete_path_missing",
                "message": "要删哪个文件或文件夹？给我名字或绝对路径。",
            }

        item_name = ""
        target_text = raw_path
        if name:
            item = self._store.find_by_name(name)
            if item is None:
                return {
                    "ok": False,
                    "code": "item_not_found",
                    "message": self._not_found_message(name),
                }
            if item.kind == "program":
                return {
                    "ok": False,
                    "code": "item_is_program",
                    "message": (
                        f"『{item.name}』是程序条目，只能从记忆本删除记录，"
                        "不会删除磁盘上的程序文件。"
                    ),
                }
            if item.kind != "path":
                return {
                    "ok": False,
                    "code": "item_not_path",
                    "message": (
                        f"『{item.name}』是一条{item.kind_label}，不是本机文件/文件夹。"
                        "如果只想删记忆本记录，请用删除记录。"
                    ),
                }
            if not self._name_mentioned(item.name, user_text):
                return {
                    "ok": False,
                    "code": "item_not_mentioned",
                    "message": (
                        f"请明确告诉我要删的是『{item.name}』，我才会弹确认气泡；"
                        "只说“那个文件夹”时我会先问清楚。"
                    ),
                }
            intent = self._path_delete_intent(user_text)
            if intent == "record":
                return {
                    "ok": False,
                    "code": "delete_record_not_file",
                    "message": (
                        f"你是在删记忆本记录，不是删文件。已经用「从记忆本删掉」处理就好——"
                        f"我不会动 {item.value} 这个文件/文件夹。"
                    ),
                }
            if intent == "ambiguous":
                return {
                    "ok": False,
                    "code": "delete_path_ambiguous",
                    "message": (
                        f"『{item.name}』是本机路径（{item.value}）。你是想只删记忆本记录，"
                        "还是连这个文件/文件夹一起删？如果连文件一起删，请明确说"
                        "“把『…』这个文件夹删了”，我会弹确认气泡再动手。"
                    ),
                }
            # intent == "file"：用户明确要删磁盘文件；"both"：文件+记录都要——
            # delete_path 成功后本来就会移除记录，两种都放行。
            target_text = item.value
            item_name = item.name
        else:
            # 临时路径：必须是用户本轮话里明确给出的完整路径
            if not self._path_mentioned(raw_path, user_text):
                return {
                    "ok": False,
                    "code": "path_not_in_message",
                    "message": "只能删除你本轮消息里明确给出的路径。",
                }

        try:
            target = normalize_path(target_text)
        except ValueError as exc:
            return {"ok": False, "code": "bad_path", "message": str(exc)}

        reason = deletable_block_reason(target)
        if reason is not None:
            return {
                "ok": False,
                "code": "path_protected",
                "message": f"这个路径不能删：{reason}\n{target}",
            }

        return {
            "ok": True,
            "args": {
                "kind": "dir" if target.is_dir() else "file",
                "path": str(target),
                "name": item_name,
            },
        }

    # ---------------------------------------------------------------- 删文件成功后

    def forget_by_path(self, path: str) -> dict[str, Any]:
        """主进程确认删除了真实文件后：移除对应记录 + 清理记忆 + 遗忘名单。"""
        try:
            target = normalize_path(path)
        except ValueError:
            target = None

        removed: list[str] = []
        items = self._store.find_path_items(str(target) if target else path)
        for item in items:
            self._store.delete(item.name)
            self._forget_value(item.value, item.kind)
            removed.append(item.name)
        # 即使没有对应条目，也把路径本身加入遗忘名单（可能有记忆里提到了它）
        self._forget_value(str(target) if target else path, "path")
        logger.info("真实文件已删除：{}（同时移除 {} 条记忆本记录）", target or path, len(removed))
        return {
            "ok": True,
            "code": "file_forgotten",
            "message": "已经从记忆本移除对应记录。" if removed else "",
        }

    # ---------------------------------------------------------------- 注入 / 过滤

    def build_prompt_block(self) -> str | None:
        """system prompt 用的记忆本清单（无条目返回 None）。"""
        return build_memory_book_block(self._store.list_all())

    def count(self) -> int:
        """条目总数（日志/设置页快照用）。"""
        return self._store.count()

    def snapshot(self, kind: str | None = None) -> dict[str, Any]:
        """设置页列表快照（含路径存在性；值原样返回——设置页是本地 UI）。

        ``path_exists`` 让前端把失效路径标 ⚠；链接不做联网预检（打开时交给浏览器）。
        """
        valid_kind = kind if kind in KINDS else None
        items = self._store.list_all(valid_kind)
        return {
            "count": self._store.count(),
            "items": [
                {
                    "id": item.id,
                    "name": item.name,
                    "kind": item.kind,
                    "value": item.value,
                    "is_dir": item.is_dir,
                    "created_at": item.created_at,
                    "updated_at": item.updated_at,
                    "path_exists": self._store.path_ok(item),
                }
                for item in items
            ],
        }

    def is_forgotten(self, text: str) -> bool:
        """后台记忆提取过滤：这段文本是否撞上遗忘名单。"""
        return self._store.is_forgotten_text(text)

    # ---------------------------------------------------------------- 内部

    @staticmethod
    def _coerce_items(items: Any) -> list[dict[str, Any]]:
        """宽容解析 ``save_item`` 的 items 参数（模型偶尔传对象/字符串）。"""
        if isinstance(items, dict):
            return [items]
        if isinstance(items, str):
            return [{"value": items}]
        if isinstance(items, list):
            return [item for item in items if isinstance(item, dict)]
        return []

    @staticmethod
    def _coerce_names(names: Any) -> list[str]:
        """宽容解析 ``delete_item`` 的 names 参数。"""
        if isinstance(names, str):
            values: Iterable[Any] = [names]
        elif isinstance(names, list):
            values = names
        else:
            return []
        result: list[str] = []
        for value in values:
            if isinstance(value, str) and value.strip():
                result.append(value.strip())
        return result

    @staticmethod
    def _kind_label(kind: str | None) -> str:
        return {
            "link": "链接",
            "path": "文件/文件夹",
            "text": "文字",
            "program": "程序",
        }.get(kind or "", "")

    def _not_found_message(self, name: str) -> str:
        """找不到条目时的可展示提示：尽量给出相近名字。"""
        items = self._store.list_all()
        if not items:
            return "记忆本还是空的。跟小兔说“记住……”就会记在这里。"
        names = [item.name for item in items]
        close = difflib.get_close_matches(name, names, n=3, cutoff=0.4)
        if close:
            return f"记忆本里没有『{name}』，你是不是指：{'、'.join(close)}？"
        preview = "、".join(names[:10])
        more = f" 等 {len(names)} 条" if len(names) > 10 else ""
        return f"记忆本里没有『{name}』。现在有：{preview}{more}。"

    @staticmethod
    def _name_mentioned(name: str, user_text: str) -> bool:
        """用户本轮是否点名了这个条目（删除记录的硬保护）。"""
        return _text_key(name) in _text_key(user_text)

    @staticmethod
    def _path_mentioned(path: str, user_text: str) -> bool:
        """用户本轮是否明确给出了这个路径（临时路径的硬保护）。

        兼容三种写法：用户原样输入、``~``/环境变量展开后、realpath 解析后
        （例如用户说 ``~/bin/app``，模型传来的是 ``/home/me/bin/app``）。
        """
        raw = str(path or "").strip()
        if not raw:
            return False
        text = _text_key(user_text)
        candidates = {raw}
        try:
            expanded = os.path.expandvars(os.path.expanduser(raw.strip("\"'")))
            candidates.add(expanded)
            candidates.add(os.path.realpath(os.path.abspath(expanded)))
        except (OSError, ValueError):
            pass
        return any(
            _path_key(candidate) in _path_key(user_text) or candidate.casefold() in text
            for candidate in candidates
            if candidate
        )

    @staticmethod
    def _url_mentioned(url: str, user_text: str) -> bool:
        """用户本轮消息里是否出现过这个链接。

        允许模型把 ``example.com/x`` 补成 ``https://example.com/x``：除完整 URL
        外再比一次"域名 + 路径 + 查询串"。
        """
        text = _text_key(user_text)
        if url.casefold() in text:
            return True
        try:
            from urllib.parse import urlsplit

            parts = urlsplit(url)
        except ValueError:
            return False
        bare = f"{parts.netloc}{parts.path}"
        if parts.query:
            bare += f"?{parts.query}"
        return bool(bare) and bare.casefold() in text

    @staticmethod
    def _path_delete_intent(user_text: str) -> str:
        """判定用户这轮说的是"删记录"还是"删文件"。

        返回 ``record``（只删记录）/ ``file``（删真实文件）/ ``both``（两者都要）/
        ``ambiguous``（没说清——必须先反问）。
        """
        text = str(user_text or "")
        file_intent = bool(_FILE_INTENT_RE.search(text))
        record_intent = bool(_RECORD_INTENT_RE.search(text))
        if record_intent and not file_intent:
            return "record"
        if file_intent and not record_intent:
            return "file"
        if file_intent and record_intent:
            return "both"
        return "ambiguous"

    def _forget_value(self, value: str, kind: str) -> None:
        """把值加入遗忘名单并清掉长期记忆里的同值条目。

        短文本（< 8 字）跳过：子串匹配会误伤大量无关记忆。
        """
        cleaned = str(value or "").strip()
        if not cleaned:
            return
        if kind == "text" and len(cleaned) < MIN_FORGET_TEXT_LEN:
            return
        self._store.add_forgotten(cleaned)
        if self._memories is None:
            return
        try:
            deleted = self._memories.delete_containing(cleaned)
        except Exception:
            logger.exception("清理长期记忆失败（不影响记忆本操作）")
            return
        if deleted:
            logger.info("记忆清理：{} 条含已遗忘值的记忆已删除", deleted)
