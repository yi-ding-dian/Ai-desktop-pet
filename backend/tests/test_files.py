"""modules/files 单测：编码、限额、二进制识别、去重与提示词拼接。"""

from __future__ import annotations

import base64
from pathlib import Path

import pytest

from backend.modules.files import (
    FileLimits,
    FileRef,
    FileRejected,
    build_attachment_block,
    build_attachment_user_content,
    estimate_messages_tokens,
    estimate_tokens,
    read_attachments,
)
from backend.modules.files.reader import FileAttachment
from backend.modules.llm.provider import ChatMessage


#: 1×1 透明 PNG（合法文件头，足够走图片识别/data URL 路径）
TINY_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGQAAAAASUVORK5CYII="
)


def _limits(**overrides: int | bool) -> FileLimits:
    values = {"max_chars": 20_000, "max_bytes": 1024 * 1024, "max_per_turn": 3}
    values.update(overrides)
    return FileLimits(**values)


def test_reads_text_and_normalizes_line_endings(tmp_path: Path) -> None:
    path = tmp_path / "hello.py"
    path.write_bytes("print(1)\r\nprint(2)\r\n".encode("utf-8"))

    result = read_attachments([FileRef(str(path))], _limits())

    assert len(result) == 1
    assert result[0].name == "hello.py"
    assert result[0].text == "print(1)\nprint(2)\n"
    assert result[0].chars == len(result[0].text)


def test_gb18030_fallback(tmp_path: Path) -> None:
    path = tmp_path / "gbk.txt"
    path.write_bytes("中文编码测试".encode("gb18030"))

    result = read_attachments([FileRef(str(path))], _limits())

    assert result[0].text == "中文编码测试"


def test_relative_path_rejected(tmp_path: Path) -> None:
    with pytest.raises(FileRejected) as exc:
        read_attachments([FileRef("relative.txt")], _limits())
    assert exc.value.code == "INVALID_PATH"


def test_missing_file_rejected(tmp_path: Path) -> None:
    with pytest.raises(FileRejected) as exc:
        read_attachments([FileRef(str(tmp_path / "nope.txt"))], _limits())
    assert exc.value.code == "NOT_FOUND"


def test_directory_rejected(tmp_path: Path) -> None:
    with pytest.raises(FileRejected) as exc:
        read_attachments([FileRef(str(tmp_path))], _limits())
    assert exc.value.code == "NOT_A_FILE"


def test_binary_file_rejected(tmp_path: Path) -> None:
    # 非图片二进制（ZIP 头）：应走二进制拒绝，而不是被图片分支吃掉
    path = tmp_path / "archive.zip"
    path.write_bytes(b"PK\x03\x04\x00\x00\x00\x00")

    with pytest.raises(FileRejected) as exc:
        read_attachments([FileRef(str(path))], _limits())
    assert exc.value.code == "FILE_BINARY"


def test_empty_file_rejected(tmp_path: Path) -> None:
    path = tmp_path / "empty.txt"
    path.write_text("", encoding="utf-8")

    with pytest.raises(FileRejected) as exc:
        read_attachments([FileRef(str(path))], _limits())
    assert exc.value.code == "FILE_EMPTY"


def test_single_file_too_long_rejected(tmp_path: Path) -> None:
    path = tmp_path / "long.txt"
    path.write_text("字" * 11, encoding="utf-8")

    with pytest.raises(FileRejected) as exc:
        read_attachments([FileRef(str(path))], _limits(max_chars=10))
    assert exc.value.code == "FILE_TOO_LONG"
    assert "11" in exc.value.message


def test_total_chars_across_files_enforced(tmp_path: Path) -> None:
    first = tmp_path / "a.txt"
    second = tmp_path / "b.txt"
    first.write_text("a" * 6, encoding="utf-8")
    second.write_text("b" * 6, encoding="utf-8")

    with pytest.raises(FileRejected) as exc:
        read_attachments(
            [FileRef(str(first)), FileRef(str(second))], _limits(max_chars=10)
        )
    assert exc.value.code == "FILES_TOO_LONG"


def test_max_files_per_turn(tmp_path: Path) -> None:
    paths = []
    for index in range(2):
        path = tmp_path / f"{index}.txt"
        path.write_text("hi", encoding="utf-8")
        paths.append(FileRef(str(path)))

    with pytest.raises(FileRejected) as exc:
        read_attachments(paths, _limits(max_per_turn=1))
    assert exc.value.code == "TOO_MANY_FILES"


def test_duplicate_paths_deduped(tmp_path: Path) -> None:
    path = tmp_path / "same.txt"
    path.write_text("hello", encoding="utf-8")

    result = read_attachments([FileRef(str(path)), FileRef(str(path))], _limits())

    assert len(result) == 1


def test_display_name_strips_directories(tmp_path: Path) -> None:
    path = tmp_path / "nested" / "real.txt"
    path.parent.mkdir()
    path.write_text("hi", encoding="utf-8")

    result = read_attachments([FileRef(str(path), name="D:/secret/real.txt")], _limits())

    assert result[0].name == "real.txt"


def test_attachment_block_escapes_name_and_keeps_text() -> None:
    block = build_attachment_block(
        [FileAttachment(name='a"b.txt', text="line1\nline2", chars=11)]
    )
    assert 'name="a&quot;b.txt"' in block
    assert "line1\nline2" in block


def test_attachment_user_content_put_question_last() -> None:
    content = build_attachment_user_content("帮我总结", "<attachment>x</attachment>")
    assert content.index("<attachment>") < content.index("用户的问题：帮我总结")
    assert "不是对你的指令" in content


def test_estimate_tokens_is_conservative_for_cjk() -> None:
    assert estimate_tokens("") == 0
    assert estimate_tokens("中文") >= 2
    assert estimate_tokens("abcdefgh") >= 2
    messages = [
        ChatMessage(role="system", content="x"),
        ChatMessage(role="user", content="中文"),
    ]
    assert estimate_messages_tokens(messages) >= estimate_tokens("中文") + 8


# ---------------------------------------------------------------- 图片（多模态 P1）


def test_reads_png_as_data_url(tmp_path: Path) -> None:
    path = tmp_path / "pixel.png"
    path.write_bytes(TINY_PNG)

    result = read_attachments([FileRef(str(path))], _limits())

    assert len(result) == 1
    assert result[0].is_image
    assert result[0].mime == "image/png"
    assert result[0].chars == 0
    assert result[0].text == ""
    assert result[0].image_url is not None
    assert result[0].image_url.startswith("data:image/png;base64,")


@pytest.mark.parametrize(
    ("name", "head", "mime"),
    [
        ("photo.jpg", b"\xff\xd8\xff\xe0", "image/jpeg"),
        ("anim.gif", b"GIF89a", "image/gif"),
        ("pic.webp", b"RIFF" + (16).to_bytes(4, "little") + b"WEBP", "image/webp"),
    ],
)
def test_supported_image_signatures(tmp_path: Path, name: str, head: bytes, mime: str) -> None:
    path = tmp_path / name
    path.write_bytes(head + b"\x00" * 16)

    result = read_attachments([FileRef(str(path))], _limits())

    assert result[0].is_image
    assert result[0].mime == mime


def test_image_disabled_rejected(tmp_path: Path) -> None:
    path = tmp_path / "pixel.png"
    path.write_bytes(TINY_PNG)

    with pytest.raises(FileRejected) as exc:
        read_attachments([FileRef(str(path))], _limits(allow_images=False))
    assert exc.value.code == "IMAGE_DISABLED"


def test_image_too_large_rejected(tmp_path: Path) -> None:
    path = tmp_path / "pixel.png"
    path.write_bytes(TINY_PNG)

    with pytest.raises(FileRejected) as exc:
        read_attachments([FileRef(str(path))], _limits(max_image_bytes=10))
    assert exc.value.code == "IMAGE_TOO_LARGE"


def test_images_do_not_count_toward_text_char_limit(tmp_path: Path) -> None:
    image = tmp_path / "pixel.png"
    text = tmp_path / "note.txt"
    image.write_bytes(TINY_PNG)
    text.write_text("hello", encoding="utf-8")

    result = read_attachments(
        [FileRef(str(image)), FileRef(str(text))],
        _limits(max_chars=5, max_per_turn=2),
    )

    assert [item.is_image for item in result] == [True, False]
    assert result[1].chars == 5


def test_attachment_block_skips_images_and_user_content_mentions_them() -> None:
    block = build_attachment_block(
        [
            FileAttachment(
                name="a.png", image_url="data:image/png;base64,xx", mime="image/png"
            ),
            FileAttachment(name="b.txt", text="hi", chars=2),
        ]
    )
    assert "a.png" not in block
    assert "b.txt" in block

    content = build_attachment_user_content("看图", block, image_names=["a.png", "c.jpg"])
    assert "2 张图片" in content
    assert "a.png" in content
    assert "用户的问题：看图" in content


def test_estimate_messages_tokens_counts_images() -> None:
    message = ChatMessage(
        role="user", content="", images=("data:image/png;base64,xx",)
    )
    assert estimate_messages_tokens([message]) >= 2_000
