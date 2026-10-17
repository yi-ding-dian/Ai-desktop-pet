"""Excel 工作簿提取（文件分析 P1：.xlsx / .xlsm）。

设计约定（与用户确认，2026-10-17）：
- **只支持 .xlsx / .xlsm**；老式 .xls 是 OLE 二进制，在 reader 里明确提示另存为 .xlsx；
- 每个 **可见工作表** 输出一个块；隐藏/veryHidden 跳过并提示数量；
- 普通区域整张 **TSV**；若存在正式 Excel 表格（ListObject），按表格名/范围拆块，
  表格之外的零散单元格以 ``A1=值`` 形式补充（限 100 个）；
- 合并单元格：左上角写值、其余位置留空，标题标注「含合并单元格」，并附合并清单
  （最多 20 处；值截断到 60 字，避免清单本身吃 token）；
- 公式：优先用 ``data_only=True`` 的缓存结果；没有缓存时从 ``data_only=False`` 的
  工作簿取公式原文，标注「未计算，无缓存结果」；
- 日期/百分比按单元格格式转成可读文本；整数不显示 ``.0``；
- 只读模式（read_only=True）读取，避免大表把内存打爆；单元格总数有上限；
- 字体/颜色/图表/图片/批注不提取。

表格元数据（合并区域 / ListObject）在 read_only 模式下不可用，因此从 OOXML 的
``xl/workbook.xml``、worksheet XML 与 rels 里解析；值仍由 openpyxl 流式读取。
"""

from __future__ import annotations

import datetime as dt
import io
import posixpath
import zipfile
from dataclasses import dataclass, field
from typing import Any, Sequence
from xml.etree import ElementTree as ET

from openpyxl import load_workbook
from openpyxl.utils import get_column_letter
from openpyxl.utils.cell import range_boundaries

_MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"

#: ZIP 安全上限（与 DOCX 同思路；Excel 工作表 XML 总量通常更小）
MAX_ZIP_ENTRIES = 10_000
MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024
MAX_WORKBOOK_XML_BYTES = 20 * 1024 * 1024
#: 单个 worksheet XML 的解压上限（解析合并区域前先挡住超大 XML）
MAX_SHEET_XML_BYTES = 30 * 1024 * 1024

#: 单表单元格总数上限（防止格式化空行/列把维度撑到百万级）
MAX_CELLS_PER_SHEET = 100_000
#: 合并清单/其他单元格的展示上限
MAX_MERGE_NOTES = 20
MAX_OTHER_CELLS = 100
#: 单个单元格值的截断（合并清单/其他单元格用；正常表格不截断）
MAX_INLINE_VALUE_CHARS = 200


class ExcelExtractError(Exception):
    """Excel 提取失败（reader 转换为 FileRejected）。"""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(message)


@dataclass(frozen=True)
class TableMeta:
    name: str
    ref: str


@dataclass(frozen=True)
class SheetMeta:
    name: str
    path: str
    state: str
    merges: tuple[str, ...] = ()
    tables: tuple[TableMeta, ...] = ()


def extract_excel_if_present(data: bytes, name: str, *, max_chars: int) -> str | None:
    """是 Excel 就提取文本并返回；不是 Excel 返回 None。

    ``max_chars`` 是本轮剩余字数预算；提取过程中超限立即抛 ``FILE_TOO_LONG``。
    """
    suffix_excel = name.lower().endswith((".xlsx", ".xlsm"))
    if not zipfile.is_zipfile(io.BytesIO(data)):
        if suffix_excel:
            raise ExcelExtractError("XLSX_INVALID", f"「{name}」不是有效的 .xlsx 文件～")
        return None

    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            names = set(archive.namelist())
            if "xl/workbook.xml" not in names:
                if suffix_excel:
                    raise ExcelExtractError(
                        "XLSX_INVALID", f"「{name}」不是有效的 .xlsx 文件（缺少工作簿）～"
                    )
                return None
            _check_zip_safety(archive, name)
            sheets = _parse_workbook_meta(archive, name)
    except zipfile.BadZipFile as exc:
        if suffix_excel:
            raise ExcelExtractError("XLSX_INVALID", f"「{name}」不是有效的 .xlsx 文件～") from exc
        return None

    wb_values: Any = None
    try:
        wb_values = load_workbook(
            io.BytesIO(data), read_only=True, data_only=True, keep_links=False
        )
        wb_formulas = load_workbook(
            io.BytesIO(data), read_only=True, data_only=False, keep_links=False
        )
    except Exception as exc:
        if wb_values is not None:
            wb_values.close()
        raise ExcelExtractError(
            "XLSX_INVALID", f"「{name}」解析失败，可能文件已损坏或不是 Excel 表格～"
        ) from exc

    try:
        if not sheets:
            # 元数据解析失败时退化为"按 openpyxl 的 sheet 列表读值，无合并/表格信息"
            sheets = [
                SheetMeta(name=sheet_name, path="", state="visible")
                for sheet_name in wb_values.sheetnames
            ]
        text = _extract_workbook(wb_values, wb_formulas, sheets, max_chars=max_chars)
    finally:
        wb_values.close()
        wb_formulas.close()

    if not text.strip():
        raise ExcelExtractError("XLSX_NO_DATA", f"「{name}」里没有可提取的单元格数据～")
    return text.strip()


# ---------------------------------------------------------------- ZIP / OOXML 元数据


def _check_zip_safety(archive: zipfile.ZipFile, name: str) -> None:
    infos = archive.infolist()
    if len(infos) > MAX_ZIP_ENTRIES:
        raise ExcelExtractError("XLSX_TOO_COMPLEX", f"「{name}」内部文件过多，无法安全解析～")
    total = 0
    for info in infos:
        if info.flag_bits & 0x1:
            raise ExcelExtractError("XLSX_ENCRYPTED", f"「{name}」是加密表格，暂不支持～")
        total += info.file_size
        if total > MAX_UNCOMPRESSED_BYTES:
            raise ExcelExtractError(
                "XLSX_TOO_LARGE", f"「{name}」解压后过大，超过 100MB 的安全上限～"
            )
        if (
            info.filename.startswith("xl/worksheets/")
            and info.filename.endswith(".xml")
            and info.file_size > MAX_SHEET_XML_BYTES
        ):
            raise ExcelExtractError(
                "XLSX_TOO_LARGE", f"「{name}」单个工作表过大，超过 30MB 的安全上限～"
            )
    workbook_xml = archive.getinfo("xl/workbook.xml")
    if workbook_xml.file_size > MAX_WORKBOOK_XML_BYTES:
        raise ExcelExtractError("XLSX_TOO_LARGE", f"「{name}」工作簿结构过大，无法解析～")


def _parse_workbook_meta(archive: zipfile.ZipFile, name: str) -> list[SheetMeta]:
    try:
        workbook_root = ET.fromstring(archive.read("xl/workbook.xml"))
    except ET.ParseError as exc:
        raise ExcelExtractError("XLSX_INVALID", f"「{name}」工作簿结构损坏～") from exc

    workbook_rels = {
        rel_id: target
        for rel_id, _rel_type, target in _parse_relationships(
            archive, "xl/_rels/workbook.xml.rels"
        )
    }

    sheets: list[SheetMeta] = []
    for sheet_el in workbook_root.findall(f".//{{{_MAIN_NS}}}sheet"):
        sheet_name = (sheet_el.get("name") or "").strip()
        if not sheet_name:
            continue
        state = sheet_el.get("state") or "visible"
        rel_id = sheet_el.get(f"{{{_REL_NS}}}id") or ""
        target = workbook_rels.get(rel_id, "")
        path = _resolve_path("xl", target) if target else ""
        merges = _parse_merges(archive, path) if path else ()
        tables = _parse_tables(archive, path) if path else ()
        sheets.append(
            SheetMeta(name=sheet_name, path=path, state=state, merges=merges, tables=tables)
        )
    return sheets


def _parse_relationships(
    archive: zipfile.ZipFile, path: str
) -> list[tuple[str, str, str]]:
    if path not in archive.namelist():
        return []
    try:
        root = ET.fromstring(archive.read(path))
    except ET.ParseError:
        return []
    return [
        (el.get("Id") or "", el.get("Type") or "", el.get("Target") or "")
        for el in root.findall(f".//{{{_PKG_REL_NS}}}Relationship")
    ]


def _parse_merges(archive: zipfile.ZipFile, sheet_path: str) -> tuple[str, ...]:
    if sheet_path not in archive.namelist():
        return ()
    try:
        root = ET.fromstring(archive.read(sheet_path))
    except ET.ParseError:
        return ()
    return tuple(
        ref
        for ref in (el.get("ref") for el in root.findall(f".//{{{_MAIN_NS}}}mergeCell"))
        if ref
    )


def _parse_tables(archive: zipfile.ZipFile, sheet_path: str) -> tuple[TableMeta, ...]:
    if not sheet_path:
        return ()
    directory, filename = posixpath.split(sheet_path)
    rels_path = posixpath.join(directory, "_rels", f"{filename}.rels")
    tables: list[TableMeta] = []
    for _rel_id, rel_type, target in _parse_relationships(archive, rels_path):
        if not rel_type.endswith("/table") or not target:
            continue
        table_path = _resolve_path(directory, target)
        if table_path not in archive.namelist():
            continue
        try:
            root = ET.fromstring(archive.read(table_path))
        except ET.ParseError:
            continue
        ref = (root.get("ref") or "").strip()
        if not ref:
            continue
        table_name = (root.get("displayName") or root.get("name") or "表格").strip()
        tables.append(TableMeta(name=table_name or "表格", ref=ref))
    tables.sort(key=_table_sort_key)
    return tuple(tables)


def _table_sort_key(table: TableMeta) -> tuple[int, int]:
    bounds = _parse_range(table.ref)
    return (bounds[1], bounds[0]) if bounds else (10**9, 10**9)


def _resolve_path(base: str, target: str) -> str:
    target = target.replace("\\", "/").strip()
    if target.startswith("/"):
        return target.lstrip("/")
    return posixpath.normpath(posixpath.join(base, target))


# ---------------------------------------------------------------- 工作簿 / 工作表


def _extract_workbook(
    wb_values: Any, wb_formulas: Any, sheets: Sequence[SheetMeta], *, max_chars: int
) -> str:
    blocks: list[str] = []
    used = 0
    hidden_count = 0
    has_sheet_content = False

    for meta in sheets:
        if meta.state != "visible":
            hidden_count += 1
            continue
        if meta.name not in wb_values.sheetnames:
            continue
        ws_values = wb_values[meta.name]
        ws_formulas = (
            wb_formulas[meta.name] if meta.name in wb_formulas.sheetnames else None
        )
        block = _extract_sheet(ws_values, ws_formulas, meta)
        if not block:
            continue
        has_sheet_content = True
        used += len(block) + 2
        if used > max_chars:
            raise ExcelExtractError("FILE_TOO_LONG", "Excel 提取出的文字超过本轮字数上限")
        blocks.append(block)

    if not has_sheet_content:
        return ""

    if hidden_count:
        note = f"（已跳过 {hidden_count} 个隐藏工作表）"
        used += len(note) + 2
        if used > max_chars:
            raise ExcelExtractError("FILE_TOO_LONG", "Excel 提取出的文字超过本轮字数上限")
        blocks.insert(0, note)

    return "\n\n".join(blocks)


def _extract_sheet(ws_values: Any, ws_formulas: Any, meta: SheetMeta) -> str:
    bounds = _used_bounds(ws_values)
    if bounds is None:
        return ""

    min_col, min_row, max_col, max_row = bounds
    cell_count = (max_row - min_row + 1) * (max_col - min_col + 1)
    if cell_count > MAX_CELLS_PER_SHEET:
        raise ExcelExtractError(
            "XLSX_TOO_LARGE",
            f"工作表「{meta.name}」范围过大（约 {cell_count:,} 个单元格），请缩小数据范围再发～",
        )

    matrix, formula_missing = _read_matrix(
        ws_values, ws_formulas, bounds, meta.name
    )
    if not matrix:
        return ""

    merge_notes, has_merge = _apply_merges(matrix, meta.merges, min_row, min_col)
    table_blocks, other_cells = _table_blocks_and_other_cells(
        matrix, meta.tables, min_row, min_col, meta.merges
    )

    header = _sheet_header(
        meta.name, matrix, has_merge, merge_notes, formula_missing, bool(table_blocks)
    )

    parts: list[str] = [header]
    if table_blocks:
        parts.extend(table_blocks)
        if other_cells:
            parts.append(other_cells)
    else:
        grid = _trimmed_tsv(matrix, trim_leading=True)
        if not grid:
            return ""
        parts.append(grid)

    return "\n\n".join(part for part in parts if part)


def _sheet_header(
    sheet_name: str,
    matrix: list[list[str]],
    has_merge: bool,
    merge_notes: list[str],
    formula_missing: int,
    has_tables: bool,
) -> str:
    display_rows, display_cols = _display_size(matrix)
    merge_suffix = "（含合并单元格）" if has_merge else ""
    lines = [f"工作表：{_one_line(sheet_name)}（{display_rows} 行 × {display_cols} 列）{merge_suffix}"]
    if has_tables:
        lines.append("以下按 Excel 表格拆分：")
    if merge_notes:
        shown = "；".join(_one_line(note, MAX_INLINE_VALUE_CHARS) for note in merge_notes)
        lines.append(f"合并单元格：{shown}")
    if formula_missing:
        lines.append(
            f"注：{formula_missing} 个公式单元格没有缓存结果，已发送公式原文（标注“未计算”）。"
        )
    return "\n".join(line for line in lines if line)


def _read_matrix(
    ws_values: Any, ws_formulas: Any, bounds: tuple[int, int, int, int], sheet_name: str
) -> tuple[list[list[str]], int]:
    min_col, min_row, max_col, max_row = bounds
    row_count = max_row - min_row + 1
    col_count = max_col - min_col + 1
    if row_count * col_count > MAX_CELLS_PER_SHEET:
        raise ExcelExtractError(
            "XLSX_TOO_LARGE",
            f"工作表「{sheet_name}」范围过大（约 {row_count * col_count:,} 个单元格），请缩小数据范围再发～",
        )

    value_iter = ws_values.iter_rows(
        min_row=min_row, max_row=max_row, min_col=min_col, max_col=max_col, values_only=False
    )
    formula_iter = (
        ws_formulas.iter_rows(
            min_row=min_row,
            max_row=max_row,
            min_col=min_col,
            max_col=max_col,
            values_only=False,
        )
        if ws_formulas is not None
        else iter(())
    )

    matrix: list[list[str]] = []
    formula_missing = 0
    for value_row in value_iter:
        try:
            formula_row = next(formula_iter)
        except StopIteration:
            formula_row = ()
        row: list[str] = []
        for index, value_cell in enumerate(value_row):
            formula_cell = formula_row[index] if index < len(formula_row) else None
            value = getattr(value_cell, "value", None)
            formula = getattr(formula_cell, "value", None) if formula_cell is not None else None
            number_format = getattr(value_cell, "number_format", "") or ""
            if value is None and isinstance(formula, str) and formula.startswith("="):
                row.append(f"{_one_line(formula, 500)}（未计算，无缓存结果）")
                formula_missing += 1
            else:
                row.append(_format_value(value, number_format))
        matrix.append(row)

    # 补成矩形（不同行 cells 数量理论上一致，防异常表）
    for row in matrix:
        if len(row) < col_count:
            row.extend([""] * (col_count - len(row)))
    return matrix, formula_missing


def _used_bounds(ws: Any) -> tuple[int, int, int, int] | None:
    try:
        dimension = ws.calculate_dimension()
        min_col, min_row, max_col, max_row = range_boundaries(dimension)
    except Exception:
        min_row = getattr(ws, "min_row", None) or 1
        min_col = getattr(ws, "min_column", None) or 1
        max_row = getattr(ws, "max_row", None) or 0
        max_col = getattr(ws, "max_column", None) or 0
    if max_row < 1 or max_col < 1:
        return None
    return min_col, min_row, max_col, max_row


# ---------------------------------------------------------------- 合并 / 表格 / 其他区域


def _apply_merges(
    matrix: list[list[str]], merges: Sequence[str], min_row: int, min_col: int
) -> tuple[list[str], bool]:
    """合并区域：值留左上角、其余清空；返回（清单，是否含合并）。"""
    rows = len(matrix)
    cols = max((len(row) for row in matrix), default=0)
    notes: list[str] = []
    has_merge = False

    # 按单元格位置排序（top-left 行/列），确保清单顺序稳定、可读
    entries: list[tuple[tuple[int, int, int, int], str]] = []
    for ref in merges:
        bounds = _parse_range(ref)
        if bounds is not None:
            entries.append((bounds, ref))
    entries.sort(key=lambda item: (item[0][1], item[0][0]))

    for bounds, ref in entries:
        c1, r1, c2, r2 = bounds
        r1 -= min_row
        r2 -= min_row
        c1 -= min_col
        c2 -= min_col
        r1 = max(r1, 0)
        c1 = max(c1, 0)
        r2 = min(r2, rows - 1)
        c2 = min(c2, cols - 1)
        if r1 > r2 or c1 > c2:
            continue
        anchor = matrix[r1][c1] if c1 < len(matrix[r1]) else ""
        for row_index in range(r1, r2 + 1):
            for col_index in range(c1, c2 + 1):
                if row_index == r1 and col_index == c1:
                    continue
                if col_index < len(matrix[row_index]):
                    matrix[row_index][col_index] = ""
        has_merge = True
        if len(notes) < MAX_MERGE_NOTES:
            label = ref.replace("$", "")
            notes.append(f"{label}={anchor}" if anchor else label)
    return notes, has_merge


def _table_blocks_and_other_cells(
    matrix: list[list[str]],
    tables: Sequence[TableMeta],
    min_row: int,
    min_col: int,
    merges: Sequence[str],
) -> tuple[list[str], str]:
    rows = len(matrix)
    cols = max((len(row) for row in matrix), default=0)
    mask = [[False] * cols for _ in range(rows)]
    blocks: list[str] = []

    for table in tables:
        bounds = _parse_range(table.ref)
        if bounds is None:
            continue
        c1, r1, c2, r2 = bounds
        rr1 = max(r1 - min_row, 0)
        rr2 = min(r2 - min_row, rows - 1)
        cc1 = max(c1 - min_col, 0)
        cc2 = min(c2 - min_col, cols - 1)
        if rr1 > rr2 or cc1 > cc2:
            continue

        slice_rows = [
            row[cc1 : cc2 + 1] for row in matrix[rr1 : rr2 + 1]
        ]
        trimmed = _trim_trailing(slice_rows)
        if not trimmed or not any(any(cell for cell in row) for row in trimmed):
            continue
        for row_index in range(rr1, rr2 + 1):
            for col_index in range(cc1, cc2 + 1):
                mask[row_index][col_index] = True

        table_merge = _range_intersects_any(merges, (c1, r1, c2, r2))
        suffix = "（含合并单元格）" if table_merge else ""
        tsv = _serialize_tsv(trimmed)
        caption = (
            f"表格：{_one_line(table.name)}（{table.ref}，"
            f"{len(trimmed)} 行 × {len(trimmed[0]) if trimmed else 0} 列）{suffix}"
        )
        blocks.append(f"{caption}\n{tsv}")

    # 表格之外的零散单元格：A1=值，最多 100 个
    other_lines: list[str] = []
    other_count = 0
    for row_index, row in enumerate(matrix):
        for col_index, value in enumerate(row):
            if not value or mask[row_index][col_index]:
                continue
            other_count += 1
            if len(other_lines) >= MAX_OTHER_CELLS:
                continue
            address = f"{get_column_letter(min_col + col_index)}{min_row + row_index}"
            other_lines.append(
                f"{address}={_one_line(value, MAX_INLINE_VALUE_CHARS)}"
            )
    if not other_lines:
        return blocks, ""
    shown = "；".join(other_lines)
    if other_count > len(other_lines):
        shown += f"；等 {other_count - len(other_lines)} 个"
    return blocks, f"其他单元格：{shown}"


def _range_intersects_any(
    merges: Sequence[str], target: tuple[int, int, int, int]
) -> bool:
    c1, r1, c2, r2 = target
    for ref in merges:
        bounds = _parse_range(ref)
        if bounds is None:
            continue
        mc1, mr1, mc2, mr2 = bounds
        if mc1 <= c2 and mc2 >= c1 and mr1 <= r2 and mr2 >= r1:
            return True
    return False


def _parse_range(ref: str) -> tuple[int, int, int, int] | None:
    """A1 范围 → (min_col, min_row, max_col, max_row)；非法返回 None。"""
    try:
        return range_boundaries(ref.replace("$", "").strip())
    except Exception:
        return None


# ---------------------------------------------------------------- 序列化 / 格式化


def _serialize_tsv(rows: Sequence[Sequence[str]]) -> str:
    return "\n".join("\t".join(_tsv_cell(cell) for cell in row) for row in rows)


def _trimmed_tsv(matrix: list[list[str]], *, trim_leading: bool) -> str:
    trimmed = _trim_trailing([list(row) for row in matrix])
    if trim_leading:
        while trimmed and all(not cell for cell in trimmed[0]):
            trimmed.pop(0)
    if not trimmed:
        return ""
    # 再按行裁掉尾部空列（表格 / 整表都可能出现）
    width = 0
    for row in trimmed:
        for index, cell in enumerate(row):
            if cell:
                width = max(width, index + 1)
    if width == 0:
        return ""
    return _serialize_tsv([row[:width] for row in trimmed])


def _trim_trailing(rows: list[list[str]]) -> list[list[str]]:
    while rows and all(not cell for cell in rows[-1]):
        rows.pop()
    if not rows:
        return []
    width = 0
    for row in rows:
        for index, cell in enumerate(row):
            if cell:
                width = max(width, index + 1)
    return [list(row[:width]) + [""] * (width - len(row[:width])) for row in rows]


def _display_size(matrix: list[list[str]]) -> tuple[int, int]:
    trimmed = _trim_trailing([list(row) for row in matrix])
    if not trimmed:
        return 0, 0
    return len(trimmed), len(trimmed[0]) if trimmed else 0


def _format_value(value: Any, number_format: str) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, dt.datetime):
        if value.time() == dt.time(0, 0):
            return value.date().isoformat()
        return value.strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(value, dt.date):
        return value.isoformat()
    if isinstance(value, dt.time):
        return value.strftime("%H:%M:%S")
    if isinstance(value, (int, float)):
        if "%" in (number_format or ""):
            percent = float(value) * 100
            return f"{percent:.2f}".rstrip("0").rstrip(".") + "%"
        if isinstance(value, int):
            return str(value)
        if float(value).is_integer():
            return str(int(value))
        return f"{float(value):.10g}"
    # 字符串不截断：表格单元格的完整内容应保留；只在合并清单/其他单元格里限长
    return str(value).strip()


def _tsv_cell(text: str) -> str:
    normalized = str(text).replace("\r\n", "\n").replace("\r", "\n")
    normalized = normalized.replace("\t", " ").replace("\n", " / ")
    return normalized.strip()


def _one_line(text: str, limit: int | None = None) -> str:
    normalized = str(text).replace("\r\n", " ").replace("\r", " ").replace("\n", " ")
    normalized = normalized.replace("\t", " ").strip()
    if limit is not None and len(normalized) > limit:
        return normalized[: max(0, limit - 1)] + "…"
    return normalized
