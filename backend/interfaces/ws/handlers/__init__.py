"""WS 事件处理器：按业务域拆分，每域一个 ``register_*_handlers`` 装配函数。

- ``chat.py``        ← 心跳 / 鉴权 / 用户消息 / 打断 / 历史 / 台词补录
- ``pet.py``         ← 宠物交互与自主行为事件
- ``reminders.py``   ← 提醒列表与时钟视图
- ``memory_book.py`` ← 设置页记忆本与删文件回调
- ``config.py``      ← 设置面板配置读写与连接测试
- ``profile.py``     ← 用户画像摘要（启动称呼引导）

``sinks.py`` 放把 ConnectionContext 适配成下层端口的出站适配器；
``types.py`` 放处理器类型与注册表协议，避免 handlers 反向依赖 dispatcher。
"""

from backend.interfaces.ws.handlers.chat import register_chat_handlers
from backend.interfaces.ws.handlers.config import register_config_handlers
from backend.interfaces.ws.handlers.memory_book import register_memory_book_handlers
from backend.interfaces.ws.handlers.pet import register_pet_handlers
from backend.interfaces.ws.handlers.profile import register_profile_handlers
from backend.interfaces.ws.handlers.reminders import register_reminder_handlers

__all__ = [
    "register_chat_handlers",
    "register_config_handlers",
    "register_memory_book_handlers",
    "register_pet_handlers",
    "register_profile_handlers",
    "register_reminder_handlers",
]
