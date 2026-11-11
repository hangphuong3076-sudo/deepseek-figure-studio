# -*- coding: utf-8 -*-
"""spreadsheet.py 的离线测试；样例只存在于内存和自动清理的独立临时目录。

XLS fixture 是直接构造的 OLE2/BIFF8 字节（未使用未安装的 xlwt）。旧 XLS
只能验证 xlrd 暴露的存储值，不能测试或承诺公式缓存缺口识别。MCP 测试使用
真实本地 Node 桥，不访问正式 current 工程。
"""

import base64
import hashlib
import io
import json
import re
import struct
import sys
import tempfile
import unittest
import zipfile
from datetime import date, datetime, time
from pathlib import Path
from unittest import mock

from openpyxl import Workbook

MCP_DIR = Path(__file__).resolve().parent
PY_DIR = MCP_DIR / "py"
if str(PY_DIR) not in sys.path:
    sys.path.insert(0, str(PY_DIR))

import spreadsheet  # noqa: E402


def workbook_bytes(sheets):
    output = io.BytesIO()
    book = Workbook()
    book.remove(book.active)
    for title, rows in sheets:
        sheet = book.create_sheet(title)
        for row in rows:
            sheet.append(row)
    book.save(output)
    book.close()
    return output.getvalue()


def open_bytes(raw, name="sample.xlsx", **kwargs):
    return spreadsheet.open_spreadsheet(
        data_base64=base64.b64encode(raw).decode("ascii"),
        file_name=name,
        **kwargs,
    )


def patched_sheet(raw, reference, cached_text, cell_type=None):
    source = io.BytesIO(raw)
    target = io.BytesIO()
    changed = False
    with zipfile.ZipFile(source) as old, zipfile.ZipFile(target, "w") as new:
        for item in old.infolist():
            payload = old.read(item.filename)
            if item.filename == "xl/worksheets/sheet1.xml":
                text = payload.decode("utf-8")
                pattern = r'(<c r="%s"[^>]*>.*?<v>)(.*?)(</v>)' % reference
                match = re.search(pattern, text, re.DOTALL)
                if not match:
                    raise AssertionError("test fixture lacks formula cell " + reference)
                cell = match.group(0)
                if cell_type:
                    opening = re.match(r'<c r="%s"[^>]*>' % reference, cell).group(0)
                    replacement = opening[:-1] + ' t="%s">' % cell_type
                    text = text.replace(opening, replacement, 1)
                text, count = re.subn(
                    pattern, lambda m: m.group(1) + cached_text + m.group(3),
                    text, count=1, flags=re.DOTALL)
                if count != 1:
                    raise AssertionError("failed to patch formula cache")
                payload = text.encode("utf-8")
                changed = True
            new.writestr(item, payload)
    if not changed:
        raise AssertionError("test fixture contains no first worksheet XML")
    return target.getvalue()


def biff_record(record_type, payload=b""):
    return struct.pack("<HH", record_type, len(payload)) + payload


def biff_bof(stream_type):
    return biff_record(0x0809, struct.pack("<HHHHII", 0x0600, stream_type, 0, 0, 0, 0))


def biff_short_string(text):
    raw = text.encode("latin1")
    return struct.pack("<BB", len(raw), 0) + raw


def biff_unicode_string(text):
    raw = text.encode("latin1")
    return struct.pack("<HB", len(raw), 0) + raw


def ole_xls_bytes(with_error=False):
    sheet = biff_bof(0x0010)
    sheet += biff_record(0x0200, struct.pack("<IIHHH", 0, 3, 0, 2, 0))
    sheet += biff_record(0x0204, struct.pack("<HHH", 0, 0, 0) + biff_unicode_string("Name"))
    sheet += biff_record(0x0204, struct.pack("<HHH", 0, 1, 0) + biff_unicode_string("Value"))
    sheet += biff_record(0x0204, struct.pack("<HHH", 1, 0, 0) + biff_unicode_string("A"))
    sheet += biff_record(0x0203, struct.pack("<HHHd", 1, 1, 0, 0.0))
    sheet += biff_record(0x0204, struct.pack("<HHH", 2, 0, 0) + biff_unicode_string("B"))
    sheet += biff_record(0x0205, struct.pack(
        "<HHHBB", 2, 1, 0, 42 if with_error else 1, 1 if with_error else 0))
    sheet += biff_record(0x000A)

    codepage = biff_record(0x0042, struct.pack("<H", 1200))
    bound = struct.pack("<IBB", 0, 0, 0) + biff_short_string("Sheet1")
    position = len(biff_bof(0x0005)) + len(codepage) + 4 + len(bound) + 4
    bound = struct.pack("<IBB", position, 0, 0) + biff_short_string("Sheet1")
    globals_stream = (biff_bof(0x0005) + codepage + biff_record(0x0085, bound)
                      + biff_record(0x000A))
    workbook_stream = globals_stream + sheet
    if len(workbook_stream) > 4096:
        raise AssertionError("XLS fixture unexpectedly needs mini-stream storage")
    workbook_stream += b"\0" * (4096 - len(workbook_stream))

    end_of_chain = 0xFFFFFFFE
    free_sector = 0xFFFFFFFF
    header = bytearray(512)
    header[:8] = bytes.fromhex("d0cf11e0a1b11ae1")
    struct.pack_into("<HHHHH", header, 24, 0x003E, 3, 0xFFFE, 9, 6)
    struct.pack_into("<III", header, 44, 1, 1, 0)
    struct.pack_into("<I", header, 56, 4096)
    struct.pack_into("<IIII", header, 60, end_of_chain, 0, end_of_chain, 0)
    struct.pack_into("<I", header, 76, 0)
    for index in range(1, 109):
        struct.pack_into("<I", header, 76 + index * 4, free_sector)

    fat = [free_sector] * 128
    chain = [0xFFFFFFFD, end_of_chain, 3, 4, 5, 6, 7, 8, 9, end_of_chain]
    fat[:len(chain)] = chain

    def directory_entry(name, object_type, start, size, child=free_sector):
        entry = bytearray(128)
        encoded = (name + "\0").encode("utf-16le")
        entry[:len(encoded)] = encoded
        struct.pack_into("<H", entry, 64, len(encoded))
        entry[66], entry[67] = object_type, 1
        struct.pack_into("<III", entry, 68, free_sector, free_sector, child)
        struct.pack_into("<I", entry, 116, start)
        struct.pack_into("<Q", entry, 120, size)
        return entry

    directories = directory_entry("Root Entry", 5, end_of_chain, 0, child=1)
    directories += directory_entry("Workbook", 2, 2, len(workbook_stream))
    directories += bytes(256)
    return bytes(header) + struct.pack("<128I", *fat) + directories + workbook_stream


class SpreadsheetTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory(prefix="spreadsheet-unit-")
        self.addCleanup(self.temp_dir.cleanup)

    def assert_notice(self, result, code):
        return next(item for item in result["notices"] if item["code"] == code)

    def test_two_sheets_default_note_header_and_reselect(self):
        raw = workbook_bytes([
            ("说明", [["单表标题"], [None], ["组别", "数值"], ["甲", 4]]),
            ("测量", [["日期", "读数"], [date(2025, 1, 2), -3.5]]),
        ])
        first = open_bytes(raw)
        self.assertEqual(first["sheets"], ["说明", "测量"])
        self.assertEqual(first["sheet_name"], "说明")
        self.assertEqual(first["header_row"], 3)
        self.assertEqual(first["data"], {
            "columns": ["组别", "数值"], "rows": [["甲", 4]],
        })
        self.assert_notice(first, "header_row_inferred")
        self.assert_notice(first, "preamble_skipped")
        second = open_bytes(raw, sheet="测量")
        self.assertEqual(second["sheet_name"], "测量")
        self.assertEqual(second["header_row"], 1)
        self.assertEqual(second["data"]["rows"], [["2025-01-02T00:00:00", -3.5]])
        self.assertEqual(second["source_info"]["selected_worksheet"], "测量")
        by_index = open_bytes(raw, sheet=1)
        self.assertEqual(by_index["data"], second["data"])

    def test_custom_header_and_empty_header_override(self):
        raw = workbook_bytes([("Data", [[10, 20], [30, 40], [50, 60]])])
        result = open_bytes(raw, header_row=2)
        self.assertEqual(result["header_row"], 2)
        self.assertEqual(result["data"], {
            "columns": ["30", "40"], "rows": [[50, 60]],
        })
        blank = workbook_bytes([("Data", [[None, None], ["x", 1]])])
        blank_result = open_bytes(blank, header_row=1)
        self.assertEqual(blank_result["data"]["columns"], ["列_1", "列_2"])
        self.assert_notice(blank_result, "empty_headers")

    def test_duplicate_empty_headers_and_numeric_zero(self):
        raw = workbook_bytes([("Data", [
            [0, "指标", "指标", None, "指标_2"],
            ["sample", 0, -2.75, False, 9],
            [None, 3.25, 2, True, 10],
        ])])
        result = open_bytes(raw)
        columns = result["data"]["columns"]
        self.assertEqual(len(columns), len(set(columns)))
        self.assertEqual(columns[:4], ["0", "指标", "指标_2", "列_4"])
        self.assertEqual(result["data"]["rows"][0][:4], ["sample", 0, -2.75, False])
        self.assertIs(result["data"]["rows"][1][0], None)
        self.assertIsInstance(result["data"]["rows"][1][1], float)
        self.assert_notice(result, "duplicate_headers")
        self.assert_notice(result, "empty_headers")
        json.dumps(result, ensure_ascii=False, allow_nan=False)

    def test_datetime_none_bool_and_rectangular_rows(self):
        raw = workbook_bytes([("Data", [
            ["日期时间", "日期", "时间", "布尔", "可空", "数值"],
            [datetime(2024, 2, 3, 4, 5, 6), date(2024, 2, 4), time(7, 8, 9),
             True, None, 0],
            [None, None, None, False, -1.5],
        ])])
        result = open_bytes(raw)
        self.assertEqual(result["data"]["rows"], [
            ["2024-02-03T04:05:06", "2024-02-04T00:00:00", "07:08:09", True, None, 0],
            [None, None, None, False, -1.5, None],
        ])
        self.assertTrue(all(len(row) == 6 for row in result["data"]["rows"]))

    def test_missing_formula_cache_preserves_none_and_position(self):
        raw = workbook_bytes([("公式", [["样本", "结果"], ["A", "=1+1"]])])
        result = open_bytes(raw)
        self.assertEqual(result["data"]["rows"], [["A", None]])
        notice = self.assert_notice(result, "formula_cache_missing")
        self.assertEqual(notice["details"]["cells"], ["公式!B2"])
        self.assertEqual(notice["details"]["missing"], 1)
        self.assertEqual(result["source_info"]["cache_mode"], "only_cached")
        self.assertFalse(result["source_info"]["formulas_evaluated"])
        self.assertFalse(result["source_info"]["external_links_loaded"])

    def test_cached_formula_zero_is_not_missing(self):
        raw = workbook_bytes([("公式", [["样本", "结果"], ["A", "=1+1"]])])
        raw = patched_sheet(raw, "B2", "0")
        result = open_bytes(raw)
        self.assertEqual(result["data"]["rows"], [["A", 0]])
        self.assertEqual(result["source_info"]["formula_cache_missing"], 0)
        self.assertFalse(any(item["code"] == "formula_cache_missing"
                             for item in result["notices"]))
        self.assertEqual(self.assert_notice(result, "formula_cached_values")["details"]["cached"], 1)

    def test_formula_error_is_never_legal_data(self):
        raw = workbook_bytes([("公式", [["样本", "结果"], ["A", "=1+1"]])])
        raw = patched_sheet(raw, "B2", "#DIV/0!", cell_type="e")
        with self.assertRaisesRegex(spreadsheet.SpreadsheetError, "公式缓存.*B2|B2.*公式缓存"):
            open_bytes(raw)

    def test_magic_mismatch_corruption_and_encrypted_input(self):
        good = workbook_bytes([("Data", [["x"], [1]])])
        with self.assertRaisesRegex(spreadsheet.SpreadsheetError, "扩展名"):
            open_bytes(good, name="renamed.csv")
        with self.assertRaisesRegex(spreadsheet.SpreadsheetError, "不能按 CSV"):
            open_bytes(b"x,y\n1,2\n")
        with self.assertRaisesRegex(spreadsheet.SpreadsheetError, "内容不符"):
            open_bytes(b"not an xls", name="sample.xls")
        with self.assertRaisesRegex(spreadsheet.SpreadsheetError, "ZIP.*损坏|格式无效"):
            open_bytes(b"PK-broken")
        with self.assertRaisesRegex(spreadsheet.SpreadsheetError, "加密|OLE"):
            open_bytes(bytes.fromhex("d0cf11e0a1b11ae1") + b"rest")

    def test_missing_file_bad_base64_and_bad_arguments(self):
        missing = Path(self.temp_dir.name) / "missing.xlsx"
        with self.assertRaisesRegex(spreadsheet.SpreadsheetError, "不存在"):
            spreadsheet.open_spreadsheet(path=missing)
        with self.assertRaisesRegex(spreadsheet.SpreadsheetError, "Base64"):
            spreadsheet.open_spreadsheet(
                data_base64="not base64", file_name="sample.xlsx")
        with self.assertRaisesRegex(spreadsheet.SpreadsheetError, "只能提供一个"):
            spreadsheet.open_spreadsheet(path=missing, data_base64="AA==")

    def test_unknown_sheet_and_invalid_headers(self):
        raw = workbook_bytes([("Data", [["x", "y"], [1, 2]])])
        with self.assertRaisesRegex(spreadsheet.SpreadsheetError, "找不到工作表"):
            open_bytes(raw, sheet="unknown")
        for value in (True, 0, 1.5, "1"):
            with self.subTest(header=value):
                with self.assertRaisesRegex(spreadsheet.SpreadsheetError, "header_row"):
                    open_bytes(raw, header_row=value)
        with self.assertRaisesRegex(spreadsheet.SpreadsheetError, "header_row=3.*超出"):
            open_bytes(raw, header_row=3)
        with self.assertRaisesRegex(spreadsheet.SpreadsheetError, "未找到有效表头"):
            open_bytes(workbook_bytes([("NoHeader", [[0, -1.5], [2, 3]])]))
        empty = workbook_bytes([("Empty", [])])
        with self.assertRaisesRegex(spreadsheet.SpreadsheetError, "没有有效.*表头"):
            open_bytes(empty)

    def test_zip_ratio_expansion_and_cell_resource_guards(self):
        raw = workbook_bytes([("Data", [["a", "b", "c"], [1, 2, 3]])])
        bomb = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(raw)) as source, zipfile.ZipFile(bomb, "w") as target:
            for item in source.infolist():
                target.writestr(item, source.read(item.filename))
            target.writestr("payload.txt", b"0" * 70000, compress_type=zipfile.ZIP_DEFLATED)
        with self.assertRaisesRegex(spreadsheet.SpreadsheetError, "压缩比"):
            open_bytes(bomb.getvalue())
        with mock.patch.object(spreadsheet, "MAX_ARCHIVE_BYTES", 128):
            with self.assertRaisesRegex(spreadsheet.SpreadsheetError, "解压后"):
                open_bytes(raw)
        with mock.patch.object(spreadsheet, "MAX_COLUMNS", 2):
            with self.assertRaisesRegex(spreadsheet.SpreadsheetError, "列数"):
                open_bytes(raw)
        with mock.patch.object(spreadsheet, "MAX_CELLS", 3):
            with self.assertRaisesRegex(spreadsheet.SpreadsheetError, "单元格"):
                open_bytes(raw)
        with mock.patch.object(spreadsheet, "MAX_HEADER_ROW", 1), \
                mock.patch.object(spreadsheet, "MAX_DATA_ROWS", 1):
            with self.assertRaisesRegex(spreadsheet.SpreadsheetError, "行数超过"):
                open_bytes(workbook_bytes([("Rows", [["x"], [1], [2]])]))

    def test_xls_basic_path_values_and_source_boundaries(self):
        raw = ole_xls_bytes()
        path = Path(self.temp_dir.name) / "legacy.xls"
        path.write_bytes(raw)
        result = spreadsheet.open_spreadsheet(path=path)
        self.assertEqual(result["sheets"], ["Sheet1"])
        self.assertEqual(result["data"], {
            "columns": ["Name", "Value"], "rows": [["A", 0.0], ["B", True]],
        })
        self.assertEqual(result["source_info"]["sha256"], hashlib.sha256(raw).hexdigest())
        self.assertEqual(result["source_info"]["parser"], "xlrd")
        self.assertIsNone(result["source_info"]["formula_count"])
        self.assertEqual(result["source_info"]["cache_mode"],
                         "stored_values_formula_boundaries_unavailable")
        self.assertFalse(result["source_info"]["macros_executed"])
        json.dumps(result, allow_nan=False)

    def test_xls_formula_or_literal_error_is_rejected(self):
        with self.assertRaisesRegex(spreadsheet.SpreadsheetError, "错误.*#N/A|#N/A.*错误"):
            open_bytes(ole_xls_bytes(with_error=True), name="legacy.xls")

    def test_xlsm_macro_and_real_local_file_contract(self):
        raw = workbook_bytes([("Data", [["x", "y"], [0, -2.5]])])
        path = Path(self.temp_dir.name) / "macro.xlsm"
        path.write_bytes(raw)
        result = spreadsheet.open_spreadsheet(path=path)
        self.assertEqual(result["source_info"]["file_name"], "macro.xlsm")
        self.assertTrue(result["source_info"]["macros_ignored"])
        self.assertFalse(result["source_info"]["macros_executed"])
        self.assertFalse(result["source_info"]["has_vba"])
        self.assertEqual(result["source_info"]["bytes"], len(raw))

    def test_result_feeds_real_column_stats_and_mcp_open_data(self):
        sys.path.insert(0, str(MCP_DIR)) if str(MCP_DIR) not in sys.path else None
        import server
        raw = workbook_bytes([("Data", [["样本", "数值"], ["A", 0], ["B", -4.5]])])
        encoded = base64.b64encode(raw).decode("ascii")
        result = open_bytes(raw)
        try:
            stats = server.bcall("data.column_stats", data=result["data"])
            self.assertEqual(stats["n_rows"], 2)
            numeric = next(item for item in stats["columns"] if item["name"] == "数值")
            self.assertEqual((numeric["kind"], numeric["min"], numeric["max"]),
                             ("numeric", -4.5, 0))
            mcp = server.tool_figure_open_data({
                "xlsx_base64": encoded, "file_name": "sample.xlsx",
                "sheet": "Data", "header_row": 1,
            })
            self.assertTrue(mcp["ok"])
            self.assertEqual(mcp["data"], result["data"])
            self.assertEqual(mcp["header_row"], 1)
            self.assertEqual(mcp["sheets"], ["Data"])
        finally:
            if server._BRIDGE is not None:
                bridge = server._BRIDGE
                process = bridge._proc
                bridge._kill()
                if process is not None:
                    process.wait(timeout=10)
                server._BRIDGE = None


if __name__ == "__main__":
    unittest.main()
