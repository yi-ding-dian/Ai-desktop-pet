"""DOCX 文本与表格提取（文件分析 P1：Word 文档）。

为什么单独一层：
- DOCX 是 ZIP + OOXML，reader 的"文本解码"路径处理不了；这里用 ``python-docx``
  按文档顺序遍历段落与表格，输出**纯文本 + Markdown/TSV 表格**，再走现有的
  字数/上下文预算链路；
- 表格对模型的价值主要在行列关系：普通表格用 Markdown 管道表（可读、模型最熟），
  超大/超宽表格自动降级 TSV（省 token、避免表头/竖线开销）；
- 文档内图片暂不提取（后续可复用图片多模态链路）；扫描件/图片版 Word 会提示
  "没有可提取的文字"。

安全边界：
- ZIP 炸弹防护：限制条目数、解压后总大小、document.xml 大小；
- 加密文档直接拒绝；宏（.docm）只读正文、绝不执行；
- 文档内容按不可信资料注入（``budget.py`` 的 ATTACHMENT_RULES）。
"""

from __future__ import annotations

import io
import re
import zipfile

from docx import Document
from docx.table import Table
from docx.text.paragraph import Paragraph

#: 普通表格用 Markdown 的行/列上限；超过任一值自动降级 TSV
MD_MAX_ROWS = 40
MD_MAX_COLS = 8

#: ZIP 安全上限（防止压缩炸弹把内存/CPU 打爆）
MAX_ZIP_ENTRIES = 5_000
MAX_UNCOMPRESSED_BYTES = 80 * 1024 * 1024
MAX_DOCUMENT_XML_BYTES = 30 * 1024 * 1024


class DocxExtractError(Exception):
    """DOCX 提取失败（reader 转换为 FileRejected）。"""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(message)


def extract_docx_if_present(data: bytes, name: str, *, max_chars: int) -> str | None:
    """是 DOCX 就提取文本并返回；不是 DOCX 返回 None（交给文本/二进制路径）。

    ``max_chars`` 是本轮还可用的字数预算（含本文档）；提取过程中一旦超出就抛
    ``FILE_TOO_LONG``，避免把超大文档全部拼成字符串后才拒绝。
    """
    suffix_docx = name.lower().endswith((".docx", ".docm"))

    if not zipfile.is_zipfile(io.BytesIO(data)):
        if suffix_docx:
            raise DocxExtractError("DOCX_INVALID", f"「{name}」不是有效的 .docx 文件～")
        return None

    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            infos = archive.infolist()
            names = {info.filename for info in infos}
            if "word/document.xml" not in names:
                if suffix_docx:
                    raise DocxExtractError(
                        "DOCX_INVALID", f"「{name}」不是有效的 .docx 文件（缺少正文）～"
                    )
                return None
            _check_zip_safety(infos, name)
    except zipfile.BadZipFile as exc:
        if suffix_docx:
            raise DocxExtractError("DOCX_INVALID", f"「{name}」不是有效的 .docx 文件～") from exc
        return None

    try:
        document = Document(io.BytesIO(data))
    except Exception as exc:  # python-docx 的异常类型较杂；统一转成可读拒绝
        raise DocxExtractError(
            "DOCX_INVALID", f"「{name}」解析失败，可能文件已损坏或不是 Word 文档～"
        ) from exc

    text = _extract_document(document, max_chars=max_chars)
    if not text.strip():
        raise DocxExtractError(
            "DOCX_NO_TEXT",
            f"「{name}」里没有可提取的文字（图片版/扫描件暂不支持）～",
        )
    return text.strip()


def _check_zip_safety(infos: list[zipfile.ZipInfo], name: str) -> None:
    if len(infos) > MAX_ZIP_ENTRIES:
        raise DocxExtractError("DOCX_TOO_COMPLEX", f"「{name}」内部文件过多，无法安全解析～")
    total = 0
    for info in infos:
        if info.flag_bits & 0x1:
            raise DocxExtractError("DOCX_ENCRYPTED", f"「{name}」是加密文档，暂不支持～")
        total += info.file_size
        if total > MAX_UNCOMPRESSED_BYTES:
            raise DocxExtractError(
                "DOCX_TOO_LARGE", f"「{name}」解压后过大，超过 80MB 的安全上限～"
            )
    document_xml = next(info for info in infos if info.filename == "word/document.xml")
    if document_xml.file_size > MAX_DOCUMENT_XML_BYTES:
        raise DocxExtractError("DOCX_TOO_LARGE", f"「{name}」正文过大，无法解析～")


def _extract_document(document: "Document", *, max_chars: int) -> str:
    """按文档顺序输出段落 + 表格；超过 max_chars 立即抛错（不再继续拼）。"""
    blocks: list[str] = []
    used = 0
    table_index = 0

    def push(block: str) -> None:
        nonlocal used
        text = block.strip()
        if not text:
            return
        used += len(text) + 2  # 两个换行分隔
        if used > max_chars:
            raise DocxExtractError("FILE_TOO_LONG", "文档提取出的文字超过本轮字数上限")
        blocks.append(text)

    for item in document.iter_inner_content():
        if isinstance(item, Paragraph):
            text = item.text.strip()
            if text:
                push(_heading_prefix(item) + text)
        elif isinstance(item, Table):
            table_index += 1
            push(_serialize_table(item, table_index))

    return "\n\n".join(blocks)


def _heading_prefix(paragraph: Paragraph) -> str:
    """Heading 1 / 标题 1 → ``#``；Title → ``#``；普通段落无前缀。"""
    style = (paragraph.style.name or "").strip().lower() if paragraph.style is not None else ""
    match = re.match(r"(?:heading|标题)\s*(\d+)", style)
    if match:
        level = min(6, max(1, int(match.group(1))))
        return "#" * level + " "
    if style == "title":
        return "# "
    return ""


def _serialize_table(table: Table, index: int) -> str:
    """表格 → Markdown（普通）或 TSV（超大/超宽）；含行列与合并单元格说明。"""
    rows, merged = _table_matrix(table)
    cols = max((len(row) for row in rows), default=0)
    if not rows or cols == 0:
        return ""

    # 不同行的 cells 数量可能不一致（合并/异常表），补空列保持矩形
    for row in rows:
        if len(row) < cols:
            row.extend([""] * (cols - len(row)))

    caption = f"表 {index}（{len(rows)} 行 × {cols} 列）"
    if merged:
        caption += "（含合并单元格）"
    caption += "："

    if len(rows) > MD_MAX_ROWS or cols > MD_MAX_COLS:
        body = "\n".join("\t".join(_tsv_cell(cell) for cell in row) for row in rows)
        return f"{caption}\n{body}"

    header = "| " + " | ".join(f"列{col + 1}" for col in range(cols)) + " |"
    separator = "| " + " | ".join("---" for _ in range(cols)) + " |"
    body = "\n".join(
        "| " + " | ".join(_md_cell(cell) for cell in row) + " |" for row in rows
    )
    return "\n".join([caption, header, separator, body])


def _table_matrix(table: Table) -> tuple[list[list[str]], bool]:
    """表格 → 二维文本矩阵；合并单元格只保留一次值，其余位置留空。

    判定依据是 ``_tc``（底层 XML 元素）对象身份：python-docx 对跨行/跨列合并会把
    同一个 ``tc`` 映射到多个网格位置——第一次出现写值，后续置空并标记 merged。

    **必须把 tc 元素本身放进 seen**（不能只存 ``id(tc)``）：lxml 元素是代理对象，
    代理一旦被回收，新的 ``tc`` 代理可能复用同一个 ``id``，普通表格会被误判成
    合并、甚至整行被清空（2026-10-17 真机样例踩坑）。持有元素引用可保证同一节点
    始终是同一个代理，``in`` 按身份比较。
    """
    rows: list[list[str]] = []
    seen: set[object] = set()
    merged = False
    for row in table.rows:
        cells: list[str] = []
        for cell in row.cells:
            tc = cell._tc  # noqa: SLF001（python-docx 无公开的合并网格接口）
            if tc in seen:
                cells.append("")
                merged = True
                continue
            seen.add(tc)
            cells.append(_cell_text(cell))
        rows.append(cells)
    return rows, merged


def _cell_text(cell: object) -> str:
    """单元格文本：段落换行保留；嵌套表格压成 ``[子表] ...`` 追加。"""
    raw = getattr(cell, "text", "") or ""
    parts = [line.strip() for line in raw.splitlines() if line.strip()]
    text = "\n".join(parts)

    nested_tables = getattr(cell, "tables", []) or []
    nested_lines: list[str] = []
    for nested in nested_tables:
        nested_rows, _ = _table_matrix(nested)
        for row in nested_rows:
            line = " / ".join(part.strip() for part in row if part.strip())
            if line:
                nested_lines.append(line)
    if nested_lines:
        prefix = f"{text}\n[子表] " if text else "[子表] "
        text = prefix + "；".join(nested_lines)
    return text


def _md_cell(text: str) -> str:
    """Markdown 单元格：竖线转义、换行转 <br>、去掉制表符。"""
    normalized = text.replace("\r\n", "\n").replace("\r", "\n").replace("\t", " ")
    normalized = normalized.replace("|", "\\|").replace("\n", "<br>")
    return normalized.strip()


def _tsv_cell(text: str) -> str:
    """TSV 单元格：制表符/换行不能破坏列结构（换行用 `` / ``）。"""
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    normalized = normalized.replace("\t", " ").replace("\n", " / ")
    return normalized.strip()
