# -*- coding: utf-8 -*-
"""受限的 Excel 表格读取；不计算公式，不执行宏，也不加载外部工作簿。

xlsx/xlsm 使用 openpyxl read_only + data_only，原始 OOXML 只用于识别公式位置及
缓存错误。旧 xls 只能取得 BIFF 中存储的结果，xlrd 无法区分缺缓存与普通空白；
datetime 编号只有被 xlrd 识别为日期格式时才转成 ISO。所有 header_row 均为 1 起始，
sheet 索引为 0 起始。sheets 是工作表名称数组，rows 是等长、可 JSON 编码的数组。
"""

from __future__ import annotations

import base64
import binascii
import datetime as _datetime
import hashlib
import io
import json
import math
import re
import xml.etree.ElementTree as ET
import zipfile
from decimal import Decimal
from pathlib import Path, PurePosixPath

MAX_WORKBOOK_BYTES = 20 * 1024 * 1024
MAX_SHEETS = 100
MAX_HEADER_ROW = 10000
MAX_DATA_ROWS = 50000
MAX_COLUMNS = 256
MAX_CELLS = 500000
MAX_ARCHIVE_BYTES = 200 * 1024 * 1024
MAX_ARCHIVE_MEMBERS = 4096
MAX_ZIP_RATIO = 200.0
FORMULA_NOTICE_LIMIT = 50
SUPPORTED_EXTENSIONS = (".xlsx", ".xlsm", ".xls")

_OLE_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
_CELL_REFERENCE = re.compile(r"^([A-Z]{1,3})([1-9][0-9]*)$")


class SpreadsheetError(ValueError):
    """可供 GUI 或 MCP 直接呈现的中文工作簿错误。"""


def _notice(code, message, details=None):
    item = {"code": code, "message": message}
    if details is not None:
        item["details"] = details
    return item


def _load_bytes(path, data_base64, file_name):
    if path is not None and data_base64 is not None:
        raise SpreadsheetError("path 与 data_base64 只能提供一个")
    if path is None and data_base64 is None:
        raise SpreadsheetError("必须提供本机工作簿 path 或 data_base64")
    if file_name is not None and (not isinstance(file_name, str) or not file_name.strip()):
        raise SpreadsheetError("file_name 必须是非空文件名")
    supplied_name = file_name.strip() if isinstance(file_name, str) else None
    if path is not None:
        if not isinstance(path, (str, Path)) or not str(path).strip():
            raise SpreadsheetError("path 必须是非空的本机工作簿路径")
        source = Path(path).expanduser()
        try:
            if not source.is_file():
                raise SpreadsheetError("工作簿文件不存在：%s" % source)
            size = source.stat().st_size
            if size > MAX_WORKBOOK_BYTES:
                raise SpreadsheetError(
                    "工作簿过大：不得超过 %d MiB" % (MAX_WORKBOOK_BYTES // 1048576))
            raw = source.read_bytes()
        except SpreadsheetError:
            raise
        except OSError as exc:
            raise SpreadsheetError("无法读取工作簿文件：%s" % exc) from exc
        name = supplied_name or source.name
    else:
        if not isinstance(data_base64, str) or not data_base64:
            raise SpreadsheetError("data_base64 必须是非空 Base64 字符串")
        max_chars = 4 * ((MAX_WORKBOOK_BYTES + 2) // 3)
        if len(data_base64) > max_chars + 4:
            raise SpreadsheetError(
                "工作簿过大：解码后不得超过 %d MiB" % (MAX_WORKBOOK_BYTES // 1048576))
        try:
            raw = base64.b64decode(data_base64.encode("ascii"), validate=True)
        except (UnicodeEncodeError, binascii.Error, ValueError) as exc:
            raise SpreadsheetError("data_base64 不是合法的 Base64 工作簿数据") from exc
        name = supplied_name or "workbook.xlsx"
    if not raw:
        raise SpreadsheetError("工作簿内容为空")
    if len(raw) > MAX_WORKBOOK_BYTES:
        raise SpreadsheetError(
            "工作簿过大：不得超过 %d MiB" % (MAX_WORKBOOK_BYTES // 1048576))
    return raw, name


def _format_for(raw, file_name):
    suffix = Path(file_name).suffix.lower()
    if suffix not in SUPPORTED_EXTENSIONS:
        raise SpreadsheetError(
            "不支持的工作簿扩展名 %s；仅支持 .xlsx、.xlsm、.xls，不支持 .xlsb"
            % (suffix or "（无扩展名）"))
    if suffix == ".xls":
        if not raw.startswith(_OLE_MAGIC):
            raise SpreadsheetError(
                ".xls 扩展名与内容不符：必须是 OLE2 BIFF 工作簿，不能改名将 CSV 等内容当作 Excel")
        return "xls"
    if raw.startswith(_OLE_MAGIC):
        raise SpreadsheetError(
            "%s 文件是 OLE 容器，可能已加密；不支持加密工作簿或仅修改扩展名的文件" % suffix)
    if not raw.startswith(b"PK"):
        raise SpreadsheetError(
            "%s 扩展名与内容不符：必须是 ZIP/XML 工作簿，不能按 CSV 或未知二进制猜测" % suffix)
    return suffix.lstrip(".")


def _check_archive(raw):
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            members = archive.infolist()
            if len(members) > MAX_ARCHIVE_MEMBERS:
                raise SpreadsheetError("工作簿 ZIP 成员过多，已停止解析")
            names = {member.filename for member in members}
            if "[Content_Types].xml" not in names or "xl/workbook.xml" not in names:
                raise SpreadsheetError("ZIP 内容不是有效的 xlsx/xlsm 工作簿")
            total = 0
            compressed = 0
            for member in members:
                normalized = member.filename.replace("\\", "/")
                if (normalized.startswith("/") or
                        ".." in PurePosixPath(normalized).parts):
                    raise SpreadsheetError("工作簿 ZIP 包含不安全的路径")
                if member.flag_bits & 0x1:
                    raise SpreadsheetError("工作簿 ZIP 含加密成员，不支持加密工作簿")
                if member.file_size < 0 or member.compress_size < 0:
                    raise SpreadsheetError("工作簿 ZIP 的长度字段无效")
                total += member.file_size
                compressed += member.compress_size
                if total > MAX_ARCHIVE_BYTES:
                    raise SpreadsheetError(
                        "工作簿解压后超过 %d MiB，已停止解析"
                        % (MAX_ARCHIVE_BYTES // 1048576))
                if (member.file_size > 65536 and
                        member.file_size / max(1, member.compress_size) > MAX_ZIP_RATIO):
                    raise SpreadsheetError("工作簿 ZIP 压缩比异常，可能为压缩炸弹，已停止解析")
            if total > 65536 and total / max(1, compressed) > MAX_ZIP_RATIO:
                raise SpreadsheetError("工作簿 ZIP 总压缩比异常，可能为压缩炸弹，已停止解析")
            return names
    except zipfile.BadZipFile as exc:
        raise SpreadsheetError("工作簿 ZIP 已损坏或格式无效") from exc


def _select_sheet(names, sheet):
    if not names:
        raise SpreadsheetError("工作簿不含工作表")
    if len(names) > MAX_SHEETS:
        raise SpreadsheetError("工作表超过 %d 个上限" % MAX_SHEETS)
    if sheet is None or sheet == "":
        return names[0]
    if isinstance(sheet, bool):
        raise SpreadsheetError("sheet 必须是工作表名称或从 0 开始的索引")
    if isinstance(sheet, int):
        if 0 <= sheet < len(names):
            return names[sheet]
        raise SpreadsheetError("工作表索引超出范围：%d" % sheet)
    if isinstance(sheet, str):
        if sheet in names:
            return sheet
        raise SpreadsheetError("找不到工作表：%s" % sheet)
    raise SpreadsheetError("sheet 必须是工作表名称或从 0 开始的索引")


def _header_number(header_row):
    if header_row is None:
        return 1
    if isinstance(header_row, bool) or not isinstance(header_row, int):
        raise SpreadsheetError("header_row 必须是从 1 开始的整数行号，不能是布尔值")
    if header_row < 1 or header_row > MAX_HEADER_ROW:
        raise SpreadsheetError("header_row 必须在 1 到 %d 之间" % MAX_HEADER_ROW)
    return header_row


def _column_letter(number):
    result = ""
    while number:
        number, remainder = divmod(number - 1, 26)
        result = chr(65 + remainder) + result
    return result


def _duration_iso(value):
    micros = round(value.total_seconds() * 1000000)
    sign = "-" if micros < 0 else ""
    micros = abs(micros)
    days, micros = divmod(micros, 86400000000)
    hours, micros = divmod(micros, 3600000000)
    minutes, micros = divmod(micros, 60000000)
    seconds, fraction = divmod(micros, 1000000)
    date = "%dD" % days if days else ""
    clock = ""
    if hours:
        clock += "%dH" % hours
    if minutes:
        clock += "%dM" % minutes
    if fraction:
        clock += ("%d.%06d" % (seconds, fraction)).rstrip("0") + "S"
    elif seconds or not (days or hours or minutes):
        clock += "%dS" % seconds
    return sign + "P" + date + ("T" + clock if clock else "")


def _json_value(value, where):
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise SpreadsheetError("%s 含 NaN 或无穷大，不能作为合法 JSON 数值导入" % where)
        return value
    if isinstance(value, Decimal):
        if not value.is_finite():
            raise SpreadsheetError("%s 含非有限数值，不能导入" % where)
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, (_datetime.datetime, _datetime.date, _datetime.time)):
        return value.isoformat()
    if isinstance(value, _datetime.timedelta):
        return _duration_iso(value)
    raise SpreadsheetError("%s 的单元格类型 %s 不受支持，未擅自转换为文本"
                           % (where, type(value).__name__))


def _is_empty(row):
    return all(value is None or (isinstance(value, str) and not value.strip())
               for value in row)


def _occupied(row):
    return sum(value is not None and (not isinstance(value, str) or bool(value.strip()))
               for value in row)


def _columns_for(matrix):
    width = 0
    for row in matrix:
        for index, value in enumerate(row):
            if value is not None and (not isinstance(value, str) or value.strip()):
                width = max(width, index + 1)
    return width


def _cell_ordinals(coordinate):
    match = _CELL_REFERENCE.match(coordinate or "")
    if not match:
        raise SpreadsheetError("工作表公式单元格地址无效：%s" % (coordinate or "（缺失）"))
    letters, row = match.groups()
    column = 0
    for letter in letters:
        column = column * 26 + ord(letter) - 64
    if int(row) > MAX_HEADER_ROW + MAX_DATA_ROWS or column > MAX_COLUMNS:
        raise SpreadsheetError("公式位置 %s 超出单工作表资源上限" % coordinate)
    return int(row), column


def _formula_info(raw, worksheet_path):
    path = worksheet_path.lstrip("/")
    formulas = set()
    errors = set()
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            if path not in archive.namelist():
                raise SpreadsheetError("工作簿中找不到所选工作表对应的 XML，文件可能损坏")
            with archive.open(path) as stream:
                for _event, element in ET.iterparse(stream, events=("end",)):
                    if element.tag.rsplit("}", 1)[-1] != "c":
                        continue
                    coordinate = element.attrib.get("r", "")
                    _cell_ordinals(coordinate)
                    has_formula = any(child.tag.rsplit("}", 1)[-1] == "f"
                                      for child in element)
                    if has_formula:
                        formulas.add(coordinate)
                    if element.attrib.get("t") == "e":
                        errors.add(coordinate)
                    element.clear()
    except SpreadsheetError:
        raise
    except (zipfile.BadZipFile, ET.ParseError, OSError, RuntimeError) as exc:
        raise SpreadsheetError("所选工作表 XML 损坏，无法安全识别公式缓存") from exc
    return formulas, errors


def _formula_notices(sheet_name, missing, formula_count):
    if formula_count:
        cached = formula_count - len(missing)
        cached_notice = _notice(
            "formula_cached_values",
            "工作表「%s」读取到 %d 个公式；仅使用 %d 个已保存缓存，不计算公式。"
            % (sheet_name, formula_count, cached),
            {"sheet": sheet_name, "formulas": formula_count, "cached": cached},
        )
    else:
        cached_notice = None
    if not missing:
        return [cached_notice] if cached_notice else []
    shown = missing[:FORMULA_NOTICE_LIMIT]
    positions = ", ".join(shown)
    if len(missing) > len(shown):
        positions += " …另有 %d 个" % (len(missing) - len(shown))
    missing_notice = _notice(
        "formula_cache_missing",
        "工作表「%s」有 %d 个公式单元格缺少缓存，保留为空而未伪造为 0 或均值；位置：%s。"
        "请在本机表格软件中重算并保存后重新导入。" % (sheet_name, len(missing), positions),
        {"sheet": sheet_name, "missing": len(missing), "formulas": formula_count,
         "cells": shown, "truncated": len(missing) > len(shown),
         "omitted": len(missing) - len(shown)},
    )
    return [cached_notice, missing_notice] if cached_notice else [missing_notice]


def _parse_openpyxl(raw, fmt, sheet, header_row, explicit_header):
    try:
        import openpyxl
    except ImportError as exc:
        raise SpreadsheetError(
            "Excel .xlsx/.xlsm 导入需要项目现有 openpyxl 依赖") from exc

    names = _check_archive(raw)
    try:
        book = openpyxl.load_workbook(
            io.BytesIO(raw), read_only=True, data_only=True,
            keep_links=False, keep_vba=False)
    except Exception as exc:
        text = str(exc).lower()
        if "encrypt" in text or "password" in text:
            raise SpreadsheetError("加密工作簿不受支持，请先解除密码保护") from exc
        raise SpreadsheetError("无法读取 %s 工作簿，文件可能损坏或格式不受支持" % fmt) from exc
    try:
        sheet_name = _select_sheet(book.sheetnames, sheet)
        table = book[sheet_name]
        max_row = table.max_row or 0
        max_column = table.max_column or 0
        if max_column > MAX_COLUMNS:
            raise SpreadsheetError("工作表列数超过 %d 列上限" % MAX_COLUMNS)
        if max_row > MAX_HEADER_ROW + MAX_DATA_ROWS:
            raise SpreadsheetError("工作表行数超过资源上限")
        if max_row * max_column > MAX_CELLS:
            raise SpreadsheetError("工作表单元格超过 %d 个上限" % MAX_CELLS)
        if explicit_header and header_row > max_row:
            raise SpreadsheetError("header_row=%d 超出工作表实际行数 %d" % (header_row, max_row))
        if not max_row or not max_column:
            raise SpreadsheetError("工作表「%s」没有可导入的单元格" % sheet_name)

        worksheet_path = getattr(table, "_worksheet_path", None)
        if not worksheet_path:
            raise SpreadsheetError("当前 openpyxl 未提供只读工作表路径，无法验证公式缓存")
        formulas, formula_errors = _formula_info(raw, worksheet_path)
        values = []
        missing = []
        cells_seen = 0
        for row_number, row in enumerate(table.iter_rows(
                min_row=1, max_row=min(max_row, MAX_HEADER_ROW + MAX_DATA_ROWS),
                min_col=1, max_col=max_column), 1):
            cells_seen += len(row)
            if cells_seen > MAX_CELLS:
                raise SpreadsheetError("工作表实际单元格超过 %d 个上限" % MAX_CELLS)
            current = []
            for column_number, cell in enumerate(row, 1):
                coordinate = "%s%d" % (_column_letter(column_number), row_number)
                where = "%s!%s" % (sheet_name, coordinate)
                data_type = getattr(cell, "data_type", "n")
                if coordinate in formulas and (
                        data_type == "e" or coordinate in formula_errors):
                    raise SpreadsheetError(
                        "%s 的公式缓存是 Excel 错误值 %s，已停止导入；不会将错误当成合法数据"
                        % (where, cell.value or "（未提供缓存）"))
                if data_type == "e":
                    raise SpreadsheetError(
                        "%s 是 Excel 错误值 %s，已停止导入；不会将错误当成合法数据"
                        % (where, cell.value))
                current.append(_json_value(cell.value, where))
                if coordinate in formulas and cell.value is None:
                    missing.append(where)
            if not _is_empty(current):
                values.append((row_number, current))
        notices = _formula_notices(sheet_name, missing, len(formulas))
        info = {
            "formula_count": len(formulas),
            "formula_cache_missing": len(missing),
            "has_vba": "xl/vbaProject.bin" in names,
            "worksheet_rows": max_row,
        }
        return values, list(book.sheetnames), sheet_name, notices, info
    finally:
        book.close()


def _parse_xls(raw, sheet, header_row, explicit_header):
    try:
        import xlrd
    except ImportError as exc:
        raise SpreadsheetError("Excel .xls 导入需要项目现有 xlrd 2.x 依赖") from exc
    log_sink = io.StringIO()
    try:
        book = xlrd.open_workbook(
            file_contents=raw, on_demand=True, ragged_rows=True, logfile=log_sink)
    except Exception as exc:
        text = str(exc).lower()
        if "encrypt" in text or "password" in text:
            raise SpreadsheetError("加密 .xls 工作簿不受支持，请先解除密码保护") from exc
        raise SpreadsheetError("无法读取 .xls 工作簿，文件可能损坏或不是 BIFF 格式") from exc
    try:
        sheet_name = _select_sheet(book.sheet_names(), sheet)
        table = book.sheet_by_name(sheet_name)
        if table.ncols > MAX_COLUMNS:
            raise SpreadsheetError("工作表列数超过 %d 列上限" % MAX_COLUMNS)
        if table.nrows > MAX_HEADER_ROW + MAX_DATA_ROWS:
            raise SpreadsheetError("工作表行数超过资源上限")
        if table.nrows * table.ncols > MAX_CELLS:
            raise SpreadsheetError("工作表单元格超过 %d 个上限" % MAX_CELLS)
        if explicit_header and header_row > table.nrows:
            raise SpreadsheetError("header_row=%d 超出工作表实际行数 %d"
                                   % (header_row, table.nrows))
        if not table.nrows or not table.ncols:
            raise SpreadsheetError("工作表「%s」没有可导入的单元格" % sheet_name)
        values = []
        for row_index in range(table.nrows):
            row = []
            for column_index, cell in enumerate(table.row(row_index)):
                where = "%s!%s%d" % (sheet_name, _column_letter(column_index + 1),
                                      row_index + 1)
                value = cell.value
                try:
                    if cell.ctype in (xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK):
                        value = None
                    elif cell.ctype == xlrd.XL_CELL_BOOLEAN:
                        value = bool(value)
                    elif cell.ctype == xlrd.XL_CELL_ERROR:
                        code = xlrd.error_text_from_code.get(value, "#ERROR")
                        raise SpreadsheetError(
                            "%s 是 Excel 错误或公式错误结果 %s，不能作为合法数据导入" % (where, code))
                    elif cell.ctype == xlrd.XL_CELL_DATE:
                        value = xlrd.xldate.xldate_as_datetime(value, book.datemode)
                    elif cell.ctype not in (xlrd.XL_CELL_TEXT, xlrd.XL_CELL_NUMBER):
                        raise SpreadsheetError("%s 的 BIFF 单元格类型不受支持" % where)
                    row.append(_json_value(value, where))
                except SpreadsheetError:
                    raise
                except (ValueError, OverflowError) as exc:
                    raise SpreadsheetError("%s 的日期时间值无效" % where) from exc
            if not _is_empty(row):
                values.append((row_index + 1, row))
        info = {"formula_count": None, "formula_cache_missing": None,
                "has_vba": None, "worksheet_rows": table.nrows}
        return values, list(book.sheet_names()), sheet_name, [], info
    finally:
        book.release_resources()


def _infer_header(meaningful):
    index = 0
    while index + 1 < len(meaningful):
        if _occupied(meaningful[index][1]) == 1 and _occupied(meaningful[index + 1][1]) >= 2:
            index += 1
            continue
        break
    row_number, header = meaningful[index]
    if not any(isinstance(value, str) and value.strip() for value in header):
        raise SpreadsheetError(
            "未找到有效表头：首个有效行不是文本标签行，不会把数值数据或整列盲当表头；"
            "请用 header_row 明确指定表头")
    return index, row_number


def _decode_headers(header):
    columns = []
    seen = set()
    empty = []
    duplicate = []
    for index, raw in enumerate(header):
        original = raw
        name = raw.strip() if isinstance(raw, str) else (str(raw) if raw is not None else "")
        is_empty = not name
        if is_empty:
            name = "列_%d" % (index + 1)
        base = name
        suffix = 2
        while name in seen:
            name = "%s_%d" % (base, suffix)
            suffix += 1
        location = {"index": index, "column": _column_letter(index + 1),
                    "original": original, "name": name}
        if is_empty:
            empty.append(location)
        elif name != base:
            duplicate.append(location)
        seen.add(name)
        columns.append(name)
    return columns, empty, duplicate


def open_spreadsheet(path=None, data_base64=None, file_name=None, sheet=None, header_row=None):
    """读取一个所选工作表，返回约定的 data/sheets/header/notices/source_info。"""
    raw, actual_name = _load_bytes(path, data_base64, file_name)
    fmt = _format_for(raw, actual_name)
    header = _header_number(header_row)
    explicit_header = header_row is not None
    if fmt in ("xlsx", "xlsm"):
        meaningful, sheets, sheet_name, notices, parse_info = _parse_openpyxl(
            raw, fmt, sheet, header, explicit_header)
        cache_mode = "only_cached"
    else:
        meaningful, sheets, sheet_name, notices, parse_info = _parse_xls(
            raw, sheet, header, explicit_header)
        cache_mode = "stored_values_formula_boundaries_unavailable"
    if not meaningful:
        raise SpreadsheetError("工作表「%s」没有有效的表或表头" % sheet_name)
    if explicit_header:
        matches = [index for index, (number, _row) in enumerate(meaningful)
                   if number == header]
        if not matches and header <= parse_info["worksheet_rows"]:
            insert_at = next((index for index, (number, _row) in enumerate(meaningful)
                              if number > header), len(meaningful))
            meaningful.insert(insert_at, (header, []))
            matches = [insert_at]
        if not matches:
            raise SpreadsheetError("header_row=%d 是空行或超出了有效单元格范围" % header)
        header_index = matches[0]
    else:
        header_index, header = _infer_header(meaningful)
        notices.append(_notice(
            "header_row_inferred",
            "按表格结构自动选择第 %d 行作为表头（1 起始），未按列名猜测科学含义" % header,
            {"header_row": header},
        ))
    table_rows = meaningful[header_index:]
    matrix = [row for _number, row in table_rows]
    width = _columns_for(matrix)
    if not width:
        raise SpreadsheetError("工作表「%s」没有有效表头" % sheet_name)
    normalized = [list(row[:width]) + [None] * max(0, width - len(row))
                  for row in matrix]
    columns, empty_headers, duplicate_headers = _decode_headers(normalized[0])
    if empty_headers:
        notices.append(_notice(
            "empty_headers", "空表头已按原列位置生成唯一可读列名",
            {"header_row": header, "columns": empty_headers}))
    if duplicate_headers:
        notices.append(_notice(
            "duplicate_headers", "重复表头已添加序号以便逐列 key 映射",
            {"header_row": header, "columns": duplicate_headers}))
    if header > 1:
        notices.append(_notice(
            "preamble_skipped", "表头前的空行、标题或注释行未作为数据导入",
            {"header_row": header, "rows_before_header": header - 1}))
    rows = normalized[1:]
    result = {
        "data": {"columns": columns, "rows": rows},
        "sheets": sheets,
        "sheet_name": sheet_name,
        "header_row": header,
        "notices": notices,
        "source_info": {
            "file_name": actual_name,
            "sha256": hashlib.sha256(raw).hexdigest(),
            "bytes": len(raw),
            "format": fmt,
            "parser": "openpyxl" if fmt in ("xlsx", "xlsm") else "xlrd",
            "selected_worksheet": sheet_name,
            "sheet_name": sheet_name,
            "read_only": True,
            "data_only": fmt in ("xlsx", "xlsm"),
            "cache_mode": cache_mode,
            "cached_only": True,
            "formulas_evaluated": False,
            "macros_executed": False,
            "macros_ignored": True,
            "external_links_loaded": False,
            "has_vba": parse_info["has_vba"],
            "formula_count": parse_info["formula_count"],
            "formula_cache_missing": parse_info["formula_cache_missing"],
        },
    }
    try:
        json.dumps(result, ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise SpreadsheetError("工作簿结果无法安全编码为 JSON") from exc
    return result


__all__ = ["SpreadsheetError", "open_spreadsheet"]
