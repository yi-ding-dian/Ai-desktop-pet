"""PDF 解析单测：文字抽取、页码分隔、加密/扫描件/页数/字数拒绝。

测试用的 PDF 由 pypdf 现场生成（Helvetica 内嵌 Type1 字体），不依赖外部样本文件。
"""

from __future__ import annotations

import io
from pathlib import Path

import pytest
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from backend.modules.files import FileLimits, FileRef, FileRejected, read_attachments
from backend.modules.files import pdf_reader
from backend.modules.files.pdf_reader import PdfExtractError, extract_pdf_if_present


def _limits(**overrides: int) -> FileLimits:
    values = {"max_chars": 20_000, "max_bytes": 1024 * 1024, "max_per_turn": 3}
    values.update(overrides)
    return FileLimits(**values)


def _make_pdf(pages: list[str], *, password: str | None = None) -> bytes:
    """生成带文字的 PDF（每项一页）；password 非空时加密。"""
    writer = PdfWriter()
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }
    )
    font_ref = writer._add_object(font)
    for text in pages:
        page = writer.add_blank_page(width=612, height=792)
        page[NameObject("/Resources")] = DictionaryObject(
            {NameObject("/Font"): DictionaryObject({NameObject("/F1"): font_ref})}
        )
        stream = DecodedStreamObject()
        stream.set_data(f"BT /F1 24 Tf 72 720 Td ({text}) Tj ET".encode())
        page[NameObject("/Contents")] = writer._add_object(stream)
    if password:
        writer.encrypt(password)
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


def _blank_pdf(pages: int = 1) -> bytes:
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=612, height=792)
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


def test_extracts_text_with_page_markers(tmp_path: Path) -> None:
    path = tmp_path / "report.pdf"
    path.write_bytes(_make_pdf(["Hello PDF", "Second page"]))

    text = read_attachments([FileRef(str(path))], _limits())[0].text

    assert text.index("— 第 1 页 —") < text.index("Hello PDF")
    assert text.index("Hello PDF") < text.index("— 第 2 页 —") < text.index("Second page")


def test_non_pdf_returns_none() -> None:
    assert extract_pdf_if_present(b"just text", "a.txt", max_chars=100) is None


def test_pdf_extension_with_wrong_content_rejected() -> None:
    with pytest.raises(PdfExtractError) as exc:
        extract_pdf_if_present(b"not a pdf", "fake.pdf", max_chars=100)
    assert exc.value.code == "PDF_INVALID"


def test_encrypted_pdf_rejected() -> None:
    with pytest.raises(PdfExtractError) as exc:
        extract_pdf_if_present(_make_pdf(["secret"], password="pw"), "secret.pdf", max_chars=100)
    assert exc.value.code == "PDF_ENCRYPTED"


def test_pdf_without_text_layer_rejected() -> None:
    with pytest.raises(PdfExtractError) as exc:
        extract_pdf_if_present(_blank_pdf(), "scan.pdf", max_chars=100)
    assert exc.value.code == "PDF_NO_TEXT"


def test_page_range_only_extracts_selected_pages() -> None:
    text = extract_pdf_if_present(
        _make_pdf(["one", "two", "three"]), "range.pdf", max_chars=1_000, pages="2-3"
    )
    assert text is not None
    assert "第 1 页" not in text
    assert "第 2 页" in text and "two" in text
    assert "第 3 页" in text and "three" in text


def test_page_range_bypasses_page_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(pdf_reader, "MAX_PAGES", 1)
    text = extract_pdf_if_present(
        _make_pdf(["one", "two"]), "range.pdf", max_chars=1_000, pages="2"
    )
    assert text is not None
    assert "第 2 页" in text
    assert "第 1 页" not in text


def test_bad_page_range_rejected() -> None:
    with pytest.raises(PdfExtractError) as exc:
        extract_pdf_if_present(_make_pdf(["one"]), "x.pdf", max_chars=100, pages="abc")
    assert exc.value.code == "PDF_PAGE_RANGE"


def test_page_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(pdf_reader, "MAX_PAGES", 1)
    with pytest.raises(PdfExtractError) as exc:
        extract_pdf_if_present(_make_pdf(["one", "two"]), "long.pdf", max_chars=1_000)
    assert exc.value.code == "PDF_TOO_MANY_PAGES"


def test_char_limit() -> None:
    with pytest.raises(PdfExtractError) as exc:
        extract_pdf_if_present(_make_pdf(["Hello PDF"]), "long.pdf", max_chars=5)
    assert exc.value.code == "FILE_TOO_LONG"


def test_reader_converts_error_to_file_rejected(tmp_path: Path) -> None:
    path = tmp_path / "scan.pdf"
    path.write_bytes(_blank_pdf())

    with pytest.raises(FileRejected) as exc:
        read_attachments([FileRef(str(path))], _limits())
    assert exc.value.code == "PDF_NO_TEXT"
