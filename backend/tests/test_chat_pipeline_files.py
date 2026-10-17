"""文件分析（chat_pipeline P1）单测：注入、拒绝、丢历史、历史脱敏。"""

from __future__ import annotations

import asyncio
import base64
from pathlib import Path
from typing import Any

from backend.application.chat_pipeline import ChatPipeline
from backend.application.session import SessionManager
from backend.modules.files import FileRef
from backend.shared.config import AppConfig
from fakes import ScriptedProvider
from test_chat_pipeline import FakeSink


class FileSink(FakeSink):
    """在 FakeSink 上补 notice 端口（文件分析丢历史提示）。"""

    def __init__(self) -> None:
        super().__init__()
        self.notices: list[dict[str, Any]] = []

    async def notice(self, code: str, message: str, level: str = "info") -> None:
        self.notices.append({"code": code, "message": message, "level": level})


#: 1×1 透明 PNG（图片多模态测试用；正文不落库）
TINY_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGQAAAAASUVORK5CYII="
)


def make_config(
    *,
    max_chars: int = 20_000,
    context_tokens: int = 100_000,
    max_tokens: int = 768,
    allow_images: bool = True,
) -> AppConfig:
    """按字段覆盖构造 AppConfig（其余用默认值）。"""
    return AppConfig.model_validate(
        {
            "files": {"max_chars": max_chars, "allow_images": allow_images},
            "llm": {"context_tokens": context_tokens, "max_tokens": max_tokens},
        }
    )


def run_file_turn(
    provider: ScriptedProvider,
    session_id: str,
    sessions: SessionManager,
    path: Path,
    *,
    config: AppConfig | None = None,
    user_text: str = "帮我看看这个文件",
) -> FileSink:
    pipeline = ChatPipeline(
        provider=provider,
        config=(lambda: config) if config is not None else None,
    )
    sink = FileSink()
    session = sessions.start(session_id)
    asyncio.run(
        pipeline.run_turn(
            sink,
            session=session,
            user_text=user_text,
            attachments=[FileRef(str(path))],
        )
    )
    return sink


def test_file_content_injected_but_not_stored_in_history(tmp_path: Path) -> None:
    path = tmp_path / "hello.txt"
    path.write_text("第一行\n第二行\n", encoding="utf-8")
    provider = ScriptedProvider(["好的<emo:happy>"])
    sessions = SessionManager()

    sink = run_file_turn(provider, "s", sessions, path, config=make_config())

    assert len(provider.seen_messages) == 1
    current = provider.seen_messages[0][-1]
    assert current.role == "user"
    assert "第一行" in current.content
    assert "用户的问题：帮我看看这个文件" in current.content
    assert sink.types()[-1] == "state"

    history = sessions.start("s").recent_messages()
    assert "📎 hello.txt" in history[0].content
    assert "第一行" not in history[0].content  # 正文不写入历史
    assert history[-1].role == "assistant"


def test_file_too_long_rejected_without_llm_call(tmp_path: Path) -> None:
    path = tmp_path / "long.txt"
    path.write_text("字" * 1_100, encoding="utf-8")
    provider = ScriptedProvider(["不应该被调用"])
    sessions = SessionManager()

    sink = run_file_turn(
        provider, "s", sessions, path, config=make_config(max_chars=1_000)
    )

    assert provider.seen_messages == []
    tokens = sink.data_of("token")
    assert tokens and "超过当前单轮上限" in tokens[0]["text"]
    assert sink.types()[-1] == "state"
    assert sink.data_of("state")[-1]["state"] == "idle"


def test_context_over_budget_drops_history_and_notifies(tmp_path: Path) -> None:
    path = tmp_path / "small.txt"
    path.write_text("文件内容", encoding="utf-8")
    provider = ScriptedProvider(["好"])
    sessions = SessionManager()
    session = sessions.start("s")
    session.append_message("user", "历" * 9_000)
    session.append_message("assistant", "好的")

    # context 8000 - 输出 768 - 余量 512 = 6720 输入预算；历史 9000 字必超，
    # 丢掉历史后只剩 system + 小文件，能放下。
    sink = run_file_turn(
        provider, "s", sessions, path, config=make_config(context_tokens=8_000)
    )

    assert [n["code"] for n in sink.notices] == ["context_reset"]
    sent = provider.seen_messages[0]
    assert all("历" * 20 not in m.content for m in sent)
    assert "文件内容" in sent[-1].content
    # 会话上下文从当前文件轮重新开始（旧历史已从内存窗口丢弃）
    remaining = sessions.start("s").recent_messages()
    assert len(remaining) == 2
    assert remaining[0].content.startswith("📎 small.txt")


def test_still_over_budget_after_drop_rejects_and_keeps_history(tmp_path: Path) -> None:
    path = tmp_path / "huge.txt"
    path.write_text("字" * 8_000, encoding="utf-8")
    provider = ScriptedProvider(["不应该被调用"])
    sessions = SessionManager()
    session = sessions.start("s")
    session.append_message("user", "旧历史")
    session.append_message("assistant", "好的")

    sink = run_file_turn(
        provider,
        "s",
        sessions,
        path,
        config=make_config(max_chars=20_000, context_tokens=8_000),
    )

    assert provider.seen_messages == []
    assert sink.notices == []
    tokens = sink.data_of("token")
    assert tokens and "上下文预算" in tokens[0]["text"]
    # 拒绝时不能顺手把用户原有上下文丢掉
    contents = [m.content for m in sessions.start("s").recent_messages()]
    assert contents[0] == "旧历史"


def test_image_attachment_sent_as_multimodal_message(tmp_path: Path) -> None:
    path = tmp_path / "pixel.png"
    path.write_bytes(TINY_PNG)
    provider = ScriptedProvider(["看到了"])
    sessions = SessionManager()

    sink = run_file_turn(provider, "s", sessions, path, config=make_config())

    current = provider.seen_messages[0][-1]
    assert current.role == "user"
    assert current.images and current.images[0].startswith("data:image/png;base64,")
    assert "1 张图片" in current.content
    assert sink.data_of("token")

    history = sessions.start("s").recent_messages()
    assert history[0].content.startswith("📎 pixel.png")
    assert "data:image" not in history[0].content  # 图片正文不落库


def test_image_disabled_by_config_rejected_without_llm(tmp_path: Path) -> None:
    path = tmp_path / "pixel.png"
    path.write_bytes(TINY_PNG)
    provider = ScriptedProvider(["不应该被调用"])
    sessions = SessionManager()

    sink = run_file_turn(
        provider, "s", sessions, path, config=make_config(allow_images=False)
    )

    assert provider.seen_messages == []
    tokens = sink.data_of("token")
    assert tokens and "不允许发送图片" in tokens[0]["text"]


def test_later_turn_does_not_resend_file_body(tmp_path: Path) -> None:
    path = tmp_path / "hello.txt"
    path.write_text("只应出现一次的正文", encoding="utf-8")
    provider = ScriptedProvider(["好的", "继续说"])
    sessions = SessionManager()
    config = make_config()

    run_file_turn(provider, "s", sessions, path, config=config)

    pipeline = ChatPipeline(provider=provider, config=lambda: config)
    sink = FileSink()
    asyncio.run(
        pipeline.run_turn(
            sink,
            session=sessions.start("s"),
            user_text="继续讲讲",
        )
    )

    second = provider.seen_messages[1]
    assert all("只应出现一次的正文" not in m.content for m in second)
    assert any("📎 hello.txt" in m.content for m in second)
