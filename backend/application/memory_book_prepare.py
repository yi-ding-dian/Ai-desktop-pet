"""记忆本工具的前置解析：打开 / 运行程序 / 删除真实路径。

模型只传名字或本轮原话里的值，这里负责解析成精确值并校验出处；
**本模块不删除任何真实文件**——``prepare_delete_path`` 只校验并返回目标，
用户在前端确认后才由 Electron 主进程移入回收站。
"""

from __future__ import annotations

from typing import Any

from backend.application.memory_book_resolver import (
    name_mentioned,
    not_found_message,
    path_delete_intent,
    path_mentioned,
    string_arg,
    url_mentioned,
)
from backend.modules.memory_book import (
    MemoryBookStore,
    deletable_block_reason,
    normalize_link,
    normalize_path,
    normalize_program_path,
)


def prepare_open(
    store: MemoryBookStore, args: dict[str, Any], user_text: str
) -> dict[str, Any]:
    """``open_item`` 的前置解析：名字 → 精确值；临时 URL 必须有本轮出处。"""
    name = string_arg(args, "name")
    url = string_arg(args, "url")
    if not name and not url:
        return {
            "ok": False,
            "code": "open_item_missing",
            "message": "要打开记忆本里的哪一条？或者把要打开的链接发我。",
        }

    if name:
        item = store.find_by_name(name)
        if item is None:
            return {
                "ok": False,
                "code": "item_not_found",
                "message": not_found_message(store, name),
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
        if item.kind == "path" and not store.path_ok(item):
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
    if not url_mentioned(normalized, user_text):
        return {
            "ok": False,
            "code": "url_not_in_message",
            "message": (
                "只能打开你本轮消息里出现过的链接，或者先把链接记到记忆本。"
                "这样别人写在文件/网页里的链接不能诱导我打开。"
            ),
        }
    return {"ok": True, "args": {"kind": "link", "value": normalized}}


def prepare_run_program(
    store: MemoryBookStore, args: dict[str, Any], user_text: str
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
    name = string_arg(args, "name")
    raw_path = string_arg(args, "path")
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
        item = store.find_by_name(name)
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
            if not store.path_ok(item):
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

        if not name_mentioned(name, user_text):
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
    if not path_mentioned(raw_path, user_text):
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


def prepare_delete_path(
    store: MemoryBookStore, args: dict[str, Any], user_text: str
) -> dict[str, Any]:
    """``delete_path`` 的前置解析：只校验并返回目标；删除由前端确认后主进程执行。"""
    name = string_arg(args, "name")
    raw_path = string_arg(args, "path")
    if not name and not raw_path:
        return {
            "ok": False,
            "code": "delete_path_missing",
            "message": "要删哪个文件或文件夹？给我名字或绝对路径。",
        }

    item_name = ""
    target_text = raw_path
    if name:
        item = store.find_by_name(name)
        if item is None:
            return {
                "ok": False,
                "code": "item_not_found",
                "message": not_found_message(store, name),
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
        if not name_mentioned(item.name, user_text):
            return {
                "ok": False,
                "code": "item_not_mentioned",
                "message": (
                    f"请明确告诉我要删的是『{item.name}』，我才会弹确认气泡；"
                    "只说“那个文件夹”时我会先问清楚。"
                ),
            }
        intent = path_delete_intent(user_text)
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
        if not path_mentioned(raw_path, user_text):
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
