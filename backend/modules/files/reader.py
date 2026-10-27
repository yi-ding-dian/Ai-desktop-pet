"""本地文件读取（文件分析 P1/P2）：读取文本/代码、图片、Word .docx、Excel 与 PDF。

设计约束（与产品讨论对齐，2026-10-17；PDF 2026-10-25）：
- 文件由用户在原生选择框/粘贴路径/拖拽时显式指定；后端只读**普通文件**，不执行、不修改；
- 文本：单文件与"本轮合计"都受 ``max_chars`` 限制；超限**拒绝整轮**，不做静默截断；
- .docx：提取正文与表格（普通表格 Markdown、超大/超宽自动 TSV），提取文本走同一字数限额；
  老式 .doc 不支持，提示另存为 .docx；文档内图片暂不提取；
- .xlsx/.xlsm：openpyxl 读可见工作表（TSV）、正式表格按名称拆块、合并单元格清单、公式缓存值优先；
  老式 .xls 不支持，提示另存为 .xlsx；
- .pdf：pypdf 解压内容流并抽取文字，每页加页码分隔；扫描件/无文字层明确拒绝；
  加密 PDF 先试空密码，仍失败提示取消密码；
- 图片：PNG/JPEG/WebP/GIF（按 magic bytes，不信任扩展名），单张受
  ``max_image_bytes`` 限制；是否允许由 ``allow_images`` 控制（多模态模型开关）；
- 只读 ``max_bytes`` 以内；先 stat 再读，避免超大文件把内存/CPU 吃掉；
- 绝对路径只用于本地读取，**不进入提示词、不写日志**（只记文件名/字数）；
- 图片转成 data URL 由 provider 组装成多模态 content；正文不落库、不跨轮重发；
- 二进制 / 无法解码 / 空文件 / 目录 / 不存在 → ``FileRejected``（可读中文原因）。
"""

from __future__ import annotations

import base64
import codecs
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from backend.modules.files.docx_reader import DocxExtractError, extract_docx_if_present
from backend.modules.files.excel_reader import ExcelExtractError, extract_excel_if_present
from backend.modules.files.pdf_reader import PdfExtractError, extract_pdf_if_present


@dataclass(frozen=True)
class FileRef:
    """渲染侧传来的附件引用（路径 + 可选显示名）。

    ``name`` 只用于展示；为空时取路径 basename。无论传什么，展示名都会再取一次
    basename，防止路径分隔符/目录信息进入提示词。
    """

    path: str
    name: str = ""
    #: 正文引用名（图片1 / 文件1.pdf）：只用于提示词里的对应关系，限长防注入
    ref: str = ""

    @property
    def display_name(self) -> str:
        """安全显示名：只保留最后一段（兼容 Windows / POSIX 分隔符），空则回退 '文件'。"""
        candidate = self.name.strip() or self.path
        base = candidate.replace("\\", "/").rstrip("/").rsplit("/", 1)[-1].strip()
        return base or "文件"


@dataclass(frozen=True)
class FileLimits:
    """文件读取限额（来自 ``[files]`` 配置；测试/未装配配置时用默认值）。"""

    max_chars: int = 20_000
    max_bytes: int = 20 * 1024 * 1024
    max_per_turn: int = 3
    max_image_bytes: int = 8 * 1024 * 1024
    allow_images: bool = True


@dataclass(frozen=True)
class FileAttachment:
    """成功读取的附件（正文只在当前轮使用，不写入会话历史）。

    文本附件用 ``text``/``chars``；图片附件用 ``image_url``（data URL）与 ``mime``，
    ``text`` 为空、``chars`` 为 0（图片不占文字字数，token 估算按张另算）。
    """

    name: str
    text: str = ""
    chars: int = 0
    image_url: str | None = None
    mime: str | None = None
    #: 正文引用名（图片1 / 文件1.pdf），与 FileRef.ref 一致
    ref: str = ""

    @property
    def is_image(self) -> bool:
        return self.image_url is not None


class FileRejected(Exception):
    """文件不可用（给用户看的中文原因；``code`` 供日志/测试断言）。"""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(message)


#: OLE 复合文档头（.doc / .xls / .ppt 等老式 Office 二进制）
_OLE_COMPOUND_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"


def read_attachments(
    refs: Sequence[FileRef], limits: FileLimits, *, pages: str | None = None
) -> list[FileAttachment]:
    """读取并校验本轮附件；任一文件不合法即抛 ``FileRejected``（整轮拒绝）。

    为什么整轮拒绝而不是跳过坏文件：用户看到的问题/文件是一组语义，静默少读一个
    会让模型基于不完整材料回答，比明确失败更糟；同时符合"超限不给输入"的产品定稿。
    """
    if len(refs) > limits.max_per_turn:
        raise FileRejected(
            "TOO_MANY_FILES",
            f"一次最多发 {limits.max_per_turn} 个文件/图片，这次选了 {len(refs)} 个～",
        )

    seen: set[str] = set()
    result: list[FileAttachment] = []
    total_chars = 0

    for ref in refs:
        path, resolved_key = _resolve_file(ref)
        if resolved_key in seen:
            continue  # 重复选择同一文件：去重，不重复计字数
        seen.add(resolved_key)

        name = ref.display_name
        try:
            size = path.stat().st_size
        except OSError as exc:
            raise FileRejected("READ_FAILED", f"读取「{name}」失败，请确认文件还能访问～") from exc

        if size > limits.max_bytes:
            raise FileRejected(
                "FILE_TOO_LARGE",
                f"「{name}」有 {size / 1024 / 1024:.1f}MB，超过 {limits.max_bytes / 1024 / 1024:.0f}MB 的文件大小上限～",
            )

        try:
            with path.open("rb") as fh:
                data = fh.read(limits.max_bytes + 1)
        except OSError as exc:
            raise FileRejected("READ_FAILED", f"读取「{name}」失败，请确认文件还能访问～") from exc
        if len(data) > limits.max_bytes:
            raise FileRejected(
                "FILE_TOO_LARGE",
                f"「{name}」超过 {limits.max_bytes / 1024 / 1024:.0f}MB 的文件大小上限～",
            )

        # 图片：按 magic bytes 识别（不信任扩展名）；PNG/JPEG/WebP/GIF 走多模态。
        image_mime = _detect_image_mime(data)
        if image_mime is not None:
            if not limits.allow_images:
                raise FileRejected(
                    "IMAGE_DISABLED",
                    f"「{name}」是图片，但当前设置不允许发送图片～"
                    "如果你用的是多模态模型，可以在设置 → 文件里打开「允许发送图片」。",
                )
            if len(data) > limits.max_image_bytes:
                raise FileRejected(
                    "IMAGE_TOO_LARGE",
                    f"「{name}」有 {len(data) / 1024 / 1024:.1f}MB，"
                    f"超过 {limits.max_image_bytes / 1024 / 1024:.0f}MB 的图片大小上限～",
                )
            encoded = base64.b64encode(data).decode("ascii")
            result.append(
                FileAttachment(
                    name=name,
                    image_url=f"data:{image_mime};base64,{encoded}",
                    mime=image_mime,
                    ref=ref.ref,
                )
            )
            continue

        # 老式 Office（OLE 复合文档）：没有可靠的纯 Python 解析器，明确引导另存为新格式。
        # 注意：给 .xlsx/.docx 加密码后也会变成 OLE 容器，不能一律当成"老式 .doc"。
        lower_name = name.lower()
        if data.startswith(_OLE_COMPOUND_MAGIC):
            if lower_name.endswith((".xlsx", ".xlsm")):
                raise FileRejected(
                    "XLSX_ENCRYPTED",
                    f"「{name}」可能是加密的 Excel 文件（或老式 .xls 改了扩展名）～"
                    "请取消密码，或另存为未加密的 .xlsx 再发给我。",
                )
            if lower_name.endswith(".docx"):
                raise FileRejected(
                    "DOCX_ENCRYPTED",
                    f"「{name}」可能是加密的 Word 文件～"
                    "请取消密码，或另存为未加密的 .docx 再发给我。",
                )
            if lower_name.endswith(".xls"):
                raise FileRejected(
                    "XLS_LEGACY",
                    f"「{name}」是老式 .xls 表格，暂时只支持 .xlsx～"
                    "用 Excel/WPS 另存为 .xlsx 再发给我吧。",
                )
            raise FileRejected(
                "DOC_LEGACY",
                f"「{name}」是老式 .doc 文档，暂时只支持 .docx～"
                "用 Word 另存为 .docx 再发给我吧。",
            )

        remaining_chars = max(1, limits.max_chars - total_chars)

        # .pdf：按文件头识别，解压内容流抽文字；扫描件/加密在提取层明确拒绝
        try:
            pdf_text = extract_pdf_if_present(
                data, name, max_chars=remaining_chars, pages=pages
            )
        except PdfExtractError as exc:
            raise FileRejected(exc.code, exc.message) from exc

        # .docx：ZIP + OOXML，提取正文与表格（表格 Markdown/TSV）后按普通文本限额处理
        try:
            docx_text = extract_docx_if_present(data, name, max_chars=remaining_chars)
        except DocxExtractError as exc:
            if exc.code == "FILE_TOO_LONG":
                raise FileRejected(
                    "FILE_TOO_LONG",
                    f"「{name}」提取出的文字超过当前单轮上限 {limits.max_chars:,} 字～"
                    "可以换小一点的文档，或在设置 → 文件里调高上限。",
                ) from exc
            raise FileRejected(exc.code, exc.message) from exc

        # .xlsx / .xlsm：openpyxl 读值；缓存值优先、公式原文兜底；工作表按 TSV 发送
        excel_text: str | None = None
        if docx_text is None:
            try:
                excel_text = extract_excel_if_present(
                    data, name, max_chars=remaining_chars
                )
            except ExcelExtractError as exc:
                if exc.code == "FILE_TOO_LONG":
                    raise FileRejected(
                        "FILE_TOO_LONG",
                        f"「{name}」提取出的文字超过当前单轮上限 {limits.max_chars:,} 字～"
                        "可以只保留需要的工作表/区域，或在设置 → 文件里调高上限。",
                    ) from exc
                raise FileRejected(exc.code, exc.message) from exc

        text = (
            pdf_text
            if pdf_text is not None
            else docx_text
            if docx_text is not None
            else excel_text
            if excel_text is not None
            else _decode_text(data, name)
        )
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        chars = len(text)
        if chars == 0:
            raise FileRejected("FILE_EMPTY", f"「{name}」是空文件，没有可以看的内容～")
        if chars > limits.max_chars:
            raise FileRejected(
                "FILE_TOO_LONG",
                f"「{name}」约 {chars:,} 字，超过当前单轮上限 {limits.max_chars:,} 字～"
                f"可以在设置 → 文件里调高（最多 100,000 字），或换个小一点的文件。",
            )

        total_chars += chars
        if total_chars > limits.max_chars:
            raise FileRejected(
                "FILES_TOO_LONG",
                f"这些文件合计约 {total_chars:,} 字，超过当前单轮上限 {limits.max_chars:,} 字～"
                f"可以少发几个、换小文件，或在设置 → 文件里调高上限。",
            )

        result.append(FileAttachment(name=name, text=text, chars=chars, ref=ref.ref))

    return result


# ------------------------------------------------------------------ 内部工具


def _resolve_file(ref: FileRef) -> tuple[Path, str]:
    """校验绝对路径 → 解析真实路径；返回 (Path, 去重键)。

    - 空路径 / 相对路径直接拒绝（避免依赖后端 cwd 造成"读错文件"）；
    - ``resolve(strict=True)`` 同时处理符号链接与不存在；目录不是合法附件。
    """
    name = ref.display_name
    raw = ref.path.strip()
    if not raw:
        raise FileRejected("INVALID_PATH", f"「{name}」的路径是空的，请重新选择～")

    path = Path(raw).expanduser()
    if not path.is_absolute():
        raise FileRejected("INVALID_PATH", f"「{name}」不是绝对路径，请用文件选择按钮重新选～")

    try:
        resolved = path.resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise FileRejected("NOT_FOUND", f"找不到文件「{name}」，可能被移动或删除了～") from exc
    if not resolved.is_file():
        raise FileRejected("NOT_A_FILE", f"「{name}」不是普通文件，选一个文件试试～")
    return resolved, str(resolved)


def _detect_image_mime(data: bytes) -> str | None:
    """按文件头识别受支持的图片格式；不支持/非图片返回 None。

    只认 PNG/JPEG/GIF/WebP——这是 OpenAI 兼容视觉接口的通用格式。BMP/TIFF/HEIC
    等按二进制文件拒绝（提示语会列出支持范围），避免把不支持的 data URL 发给模型。
    """
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def _decode_text(data: bytes, name: str) -> str:
    """字节 → 文本：先认 BOM，再 UTF-8，最后 GB18030（中文 Windows 常见编码）。

    NUL 字节（UTF-16 BOM 除外）视为二进制；解码后再做一次控制字符比例检查，
    防止压缩包等被 GB18030 "蒙混"解码成乱码文本（图片此前已按 magic bytes 分流）。
    """
    if data.startswith(codecs.BOM_UTF16_LE) or data.startswith(codecs.BOM_UTF16_BE):
        try:
            text = data.decode("utf-16")
        except UnicodeDecodeError as exc:
            raise FileRejected("FILE_ENCODING", f"「{name}」编码无法识别，暂时只支持文本/代码文件，以及 PNG/JPEG/WebP/GIF 图片～") from exc
    else:
        if b"\x00" in data[:8192]:
            raise FileRejected("FILE_BINARY", f"「{name}」看起来是二进制文件，暂时只支持文本/代码文件，以及 PNG/JPEG/WebP/GIF 图片～")
        for encoding in ("utf-8-sig", "gb18030"):
            try:
                text = data.decode(encoding)
                break
            except UnicodeDecodeError:
                continue
        else:
            raise FileRejected("FILE_ENCODING", f"「{name}」编码无法识别，暂时只支持文本/代码文件，以及 PNG/JPEG/WebP/GIF 图片～")

    sample = text[:4000]
    if sample:
        controls = sum(
            1 for ch in sample if ord(ch) < 32 and ch not in ("\n", "\r", "\t")
        )
        if controls / len(sample) > 0.05:
            raise FileRejected("FILE_BINARY", f"「{name}」看起来是二进制文件，暂时只支持文本/代码文件，以及 PNG/JPEG/WebP/GIF 图片～")
    return text
