"""内置工具集：``build_default_registry`` 装配本产品的全部内置工具。

按业务域拆分，每个子模块只负责自己那一组工具：

- ``reminders.py``   ← create_reminder / list_reminders / cancel_reminder（backend）
- ``memory_book.py`` ← 记忆本（backend + 带 ``prepare`` 的 frontend 型）
- ``search.py``      ← web_search / web_fetch（backend + feedback）
- ``disk.py``        ← disk_report / clean_disk（只读 + 确认后清理）
- ``system.py``      ← inspect_system（只读巡检）

新增内置工具时只需在对应子模块 ``registry.register(ToolSpec(...))``：
``description`` 写清“何时调用”（system 里的工具清单按注册表自动生成，不再手工
维护 ``prompts/capabilities.md``）；跨工具策略/安全边界才写进 capabilities.md。

可选注入（不传时注册表与旧版一致，避免模块间硬依赖）：

- ``reminders``（2026-10-18）：提醒服务（application 层实现）——注册
  create_reminder / list_reminders / cancel_reminder 三个 **backend 型**工具；
- ``memory_book``（2026-10-18）：记忆本服务（application 层实现）——注册
  save_item / list_items / rename_item / delete_item / open_item / delete_path。
  ``open_item`` / ``delete_path`` 是 **frontend 型**，但带 ``prepare``：
  模型只传名字，chat 管道派发前由后端解析成精确值并校验用户本轮原话；
  ``delete_path`` 到前端后还要弹确认气泡，用户点「删除」才由主进程移入回收站。
- ``search``（2026-10-18）：联网搜索服务（application 层实现）——注册
  web_search / web_fetch 两个 **backend 型 + feedback** 工具：结果会回喂给模型，
  由 chat 管道再跑一轮 LLM 生成最终回答（搜索/抓取由 DeepSeek 官方接口提供）。
- ``disk``（2026-10-22）：磁盘体检/清理服务（application 层实现）——注册
  disk_report（backend + feedback，只读）与 clean_disk（frontend + prepare，
  只传白名单 key，实际清理在主进程确认气泡后移入回收站）。
- ``system``（2026-10-23）：只读系统巡检服务（application 层实现）——注册
  inspect_system（backend + feedback）：系统信息/磁盘/目录占用/大文件/启动项/
  已安装程序/服务/进程；不执行任意命令、不读写文件正文。
"""

from __future__ import annotations

from typing import Any

from backend.modules.tools.builtin.disk import register_disk_tools
from backend.modules.tools.builtin.memory_book import register_memory_book_tools
from backend.modules.tools.builtin.reminders import register_reminder_tools
from backend.modules.tools.builtin.search import register_search_tools
from backend.modules.tools.builtin.system import register_system_tools
from backend.modules.tools.registry import ToolRegistry, ToolSpec


def build_default_registry(
    reminders: Any | None = None,
    memory_book: Any | None = None,
    search: Any | None = None,
    disk: Any | None = None,
    system: Any | None = None,
) -> ToolRegistry:
    """构建内置工具注册表（每次返回全新实例，避免调用方之间共享可变状态）。"""
    registry = ToolRegistry()
    registry.register(
        ToolSpec(
            name="open_settings",
            description=(
                "打开小兔的设置面板"
                "（用户想改配置、换模型或服务商、改名字、主题、声音等时使用）"
            ),
            parameters={"type": "object", "properties": {}},
            executor="frontend",
            ack="好嘞，设置给你开好啦~ 改完记得保存哦",
        )
    )
    registry.register(
        ToolSpec(
            name="open_work",
            description=(
                "打开工作模式聊天窗（完整对话记录、历史导航、深度思考/联网搜索开关；"
                "用户想展开长对话、回看历史或认真处理一件事时使用）"
            ),
            parameters={"type": "object", "properties": {}},
            executor="frontend",
            ack="好，工作台给你打开啦~",
        )
    )
    if reminders is not None:
        register_reminder_tools(registry, reminders)
    if memory_book is not None:
        register_memory_book_tools(registry, memory_book)
    if search is not None:
        register_search_tools(registry, search)
    if disk is not None:
        register_disk_tools(registry, disk)
    if system is not None:
        register_system_tools(registry, system)
    return registry
