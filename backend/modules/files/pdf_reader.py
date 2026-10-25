"""PDF 文本提取（文件分析 P2：PDF 文档）。

为什么单独一层（与 docx_reader / excel_reader 同构）：
- PDF 是"对象树 + zlib 压缩的内容流"，reader 的文本解码路径只会得到乱码；
  这里用 ``pypdf`` 解压内容流、按字体 ToUnicode 映射回文字，再把每页正文拼成
  纯文本，走现有的字数/上下文预算链路；
- 每页前加 ``— 第 N 页 —``，方便模型在回答里引用页码（PDF 没有行号概念）；
- 扫描件 / 图片版 PDF 没有文字层，``extract_text()`` 返回空：明确拒绝并提示，
  不返回空串让模型"凭空回答"。

安全边界：
- 只按文件头 ``%PDF-`` 识别（不信任扩展名）；扩展名是 .pdf 但内容不对 → 明确报错；
- 加密 PDF 先尝试空密码（很多文件只是 owner 权限限制）；仍解不开 → 拒绝；
- 页数上限 + 提取过程逐页累计字数，超限立即抛错，避免把超大文档全部拼成字符串；
- 绝对路径不进入提示词（沿用 reader 的展示名规则）。
"""

from __future__ import annotations

import io
import re

from pypdf import PdfReader

#: 单份 PDF 最多提取多少页（防止几百页文档把 CPU/内存打爆；字数另有上限兜底）
MAX_PAGES = 500

#: 文件头允许出现在前 1KB 内（规范允许头部前有少量垃圾字节）
_HEADER_WINDOW = 1024


class PdfExtractError(Exception):
    """PDF 提取失败（reader 转换为 FileRejected）。"""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(message)


def extract_pdf_if_present(
    data: bytes, name: str, *, max_chars: int, pages: str | None = None
) -> str | None:
    """是 PDF 就提取文本并返回；不是 PDF 返回 None（交给文本/二进制路径）。

    ``max_chars`` 是本轮还可用的字数预算（含本文档）；提取过程中一旦超出就抛
    ``FILE_TOO_LONG``，不静默截断。

    ``pages`` 是可选页范围（如 ``"1-20"`` / ``"3"``）；给了范围时只抽出这些页，
    页数上限 MAX_PAGES 不生效（大文档可以按页分段读）——任务模式的 read_file 用。
    """
    suffix_pdf = name.lower().endswith(".pdf")
    if not _looks_like_pdf(data):
        if suffix_pdf:
            raise PdfExtractError("PDF_INVALID", f"「{name}」不是有效的 PDF 文件～")
        return None

    try:
        reader = PdfReader(io.BytesIO(data))
    except Exception as exc:  # pypdf 的异常类型较杂；统一转成可读拒绝
        raise PdfExtractError("PDF_INVALID", f"「{name}」解析失败，可能文件已损坏～") from exc

    if reader.is_encrypted:
        try:
            unlocked = reader.decrypt("")
        except Exception as exc:  # AES 等需要额外依赖时也按"有密码"处理
            raise PdfExtractError(
                "PDF_ENCRYPTED", f"「{name}」有密码保护，请取消密码后再发～"
            ) from exc
        if not unlocked:
            raise PdfExtractError("PDF_ENCRYPTED", f"「{name}」有密码保护，请取消密码后再发～")

    try:
        page_count = len(reader.pages)
    except Exception as exc:
        raise PdfExtractError("PDF_INVALID", f"「{name}」解析失败，可能文件已损坏～") from exc

    if pages is None and page_count > MAX_PAGES:
        raise PdfExtractError(
            "PDF_TOO_MANY_PAGES",
            f"「{name}」有 {page_count} 页，超过 {MAX_PAGES} 页上限；"
            "可以拆分后再发，或用 read_file 的 pages 按页读取～",
        )

    first_page, last_page = _parse_pages(pages, page_count, name)

    parts: list[str] = []
    used = 0
    try:
        for index in range(first_page, last_page + 1):
            text = (reader.pages[index - 1].extract_text() or "").strip()
            if not text:
                continue
            block = f"— 第 {index} 页 —\n{text}"
            used += len(block) + 2  # 页块之间的空行
            if used > max_chars:
                raise PdfExtractError(
                    "FILE_TOO_LONG",
                    f"「{name}」提取出的文字超过当前单轮上限 {max_chars:,} 字～"
                    "可以拆分 PDF，或在设置 → 文件里调高上限。",
                )
            parts.append(block)
    except PdfExtractError:
        raise
    except Exception as exc:
        raise PdfExtractError("PDF_INVALID", f"「{name}」解析失败，可能文件已损坏～") from exc

    if not parts:
        scope = f"第 {first_page}–{last_page} 页" if pages else ""
        raise PdfExtractError(
            "PDF_NO_TEXT",
            f"「{name}」{scope}没有可提取的文字层，可能是扫描件或图片版 PDF～",
        )
    return "\n\n".join(parts)


def _parse_pages(raw: str | None, page_count: int, name: str) -> tuple[int, int]:
    """解析页范围（``"3"`` / ``"1-20"``）；空 = 全部页。超界按最后一页截断。"""
    text = (raw or "").strip()
    if not text:
        return 1, page_count
    match = re.fullmatch(r"(\d+)(?:\s*-\s*(\d+))?", text)
    if match is None:
        raise PdfExtractError(
            "PDF_PAGE_RANGE", "页范围格式不对，请用 1-20 或 3 这种写法～"
        )
    first = int(match.group(1))
    last = int(match.group(2) or first)
    if first < 1 or last < first:
        raise PdfExtractError("PDF_PAGE_RANGE", "页范围要从第 1 页开始，且结束页不能小于起始页～")
    if first > page_count:
        raise PdfExtractError(
            "PDF_PAGE_RANGE", f"「{name}」只有 {page_count} 页，起始页超出范围～"
        )
    return first, min(last, page_count)


def _looks_like_pdf(data: bytes) -> bool:
    """按文件头识别 PDF（规范允许头部前有少量垃圾字节）。"""
    return b"%PDF-" in data[:_HEADER_WINDOW]
