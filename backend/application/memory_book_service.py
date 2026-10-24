"""记忆本用例编排（2026-10-18，application 层）。

职责：
- 工具 ``save_item / list_items / rename_item / delete_item`` 的业务处理；
- 删除/更新时联动长期记忆：清掉包含旧值的记忆，并写入遗忘名单，防止后台提取
  从旧对话里把用户已"忘掉"的链接/路径再捞回来；
- 设置页快照与 system prompt 清单。

同目录的兄弟模块：

- ``memory_book_resolver.py``：输入解析（参数宽容解析、名字/路径/URL 是否本轮
  点名、删除意图判定）；
- ``memory_book_prepare.py``：``open_item / run_program / delete_path`` 的前置
  解析（名字 → 精确值 + 出处校验）。

**本服务不删除任何真实文件。** ``delete_path`` 只负责校验并返回给前端；前端弹
确认气泡，用户点「删除」后由 Electron 主进程 ``shell.trashItem`` 移入回收站。
"""

from __future__ import annotations

from typing import Any

from loguru import logger

from backend.application.memory_book_prepare import (
    prepare_delete_path,
    prepare_open,
    prepare_run_program,
)
from backend.application.memory_book_resolver import (
    coerce_items,
    coerce_names,
    kind_label,
    name_mentioned,
    not_found_message,
    path_delete_intent,
    string_arg,
)
from backend.modules.memory.store import MemoryStore
from backend.modules.memory_book import (
    KINDS,
    ItemNotFound,
    NameConflict,
    MemoryBookError,
    MemoryBookStore,
    build_memory_book_block,
    normalize_name,
    normalize_path,
    resolve_kind,
)

#: 一次工具调用最多处理的条目数（防模型一次塞爆）
MAX_BATCH = 10
#: 短文本做记忆清理/遗忘名单的最小长度——太短的文本（如"123"）做子串匹配会误伤
MIN_FORGET_TEXT_LEN = 8

#: 逐条结果里展示值的长度
_VALUE_PREVIEW = 200


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
        entries = coerce_items(items)
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
            name = string_arg(entry, "name")
            kind = string_arg(entry, "kind") or None
            value = string_arg(entry, "value")
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
            scope = f"（{kind_label(valid_kind)}）" if valid_kind else ""
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
            + (f"，当前显示 {len(items)} 条{kind_label(valid_kind)}" if valid_kind else "")
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
                "message": not_found_message(self._store, old_clean),
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
        entries = coerce_names(names)
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
                failed.append(not_found_message(self._store, name))
                continue
            if not trust and not name_mentioned(item.name, user_text):
                failed.append(f"『{item.name}』：请明确点名要删哪一条")
                continue
            if not trust and item.kind == "path":
                intent = path_delete_intent(user_text)
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

    # ---------------------------------------------------------------- 前置解析

    def prepare_open(self, args: dict[str, Any], user_text: str) -> dict[str, Any]:
        """``open_item`` 的前置解析（实现见 memory_book_prepare）。"""
        return prepare_open(self._store, args, user_text)

    def prepare_run_program(
        self, args: dict[str, Any], user_text: str
    ) -> dict[str, Any]:
        """``run_program`` 的前置解析（实现见 memory_book_prepare）。"""
        return prepare_run_program(self._store, args, user_text)

    def prepare_delete_path(self, args: dict[str, Any], user_text: str) -> dict[str, Any]:
        """``delete_path`` 的前置解析（实现见 memory_book_prepare）。"""
        return prepare_delete_path(self._store, args, user_text)

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
