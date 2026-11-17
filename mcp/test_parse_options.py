"""test_parse_options.py — G19：分隔符自洽 + numberFormat/parseCell/sniffNumberFormat

内核测试（node 直接调用 lib/data.js，不经浏览器）：
1. 分号+小数逗号自动分隔符 → columns ["x","y"]，plain 保留字符串；
2. numberFormat "comma_decimal" → 数值 [[3.14,2.5],[1.5,2.25]]；
3. comma_decimal 单元格边界（1.234,56 / 1.234 / 0.5 / 1e3 / -0,5 / ,5 / NA）；
4. comma_thousands（"1,234.5"/"2,500" → 数值；"12,34" 保持文本）；
5. 默认行为不变：sample.csv 与 git HEAD 版 parseCSV 结果深度相等；
6. 非法 numberFormat 抛错；
7. sniffNumberFormat 五例；
8. parseCell 三例；
9. 引号内逗号 + 分号分隔 → 判为分号；
10. reviewContext：manual_edits → data_manual_edits(info)；无键文档不变。
"""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
BUNDLE = HERE.parent

NODE_SCRIPT = r"""
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ctx = { console, module: { exports: {} }, exports: {}, require, process, Buffer, setTimeout, clearTimeout, setInterval, clearInterval, URL, TextEncoder, TextDecoder };
ctx.globalThis = ctx; ctx.window = ctx;
vm.createContext(ctx);
function load(f) { vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: f }); }
load(path.join(process.argv[1], 'lib', 'figdoc.js'));
load(path.join(process.argv[1], 'lib', 'ops.js'));
load(path.join(process.argv[1], 'lib', 'data.js'));
load(path.join(process.argv[1], 'lib', 'science.js'));
const D = ctx.FigData, S = ctx.FigScience;
// HEAD 旧版 data.js：独立 context 加载，取其 parseCSV 做逐字节对比
let oldParseCSV = null, oldErr = null;
try {
  const oldSrc = fs.readFileSync(process.argv[2], 'utf8');
  const ctxOld = { console, module: { exports: {} }, exports: {}, require, process, Buffer, setTimeout, clearTimeout, setInterval, clearInterval, URL, TextEncoder, TextDecoder };
  ctxOld.globalThis = ctxOld; ctxOld.window = ctxOld;
  vm.createContext(ctxOld);
  vm.runInContext(oldSrc, ctxOld, { filename: 'data.head.js' });
  oldParseCSV = ctxOld.FigData && ctxOld.FigData.parseCSV;
  if (!oldParseCSV) oldErr = 'FigData.parseCSV missing';
} catch (e) { oldErr = String(e && e.message || e); }
const out = { _argv2: process.argv[2] || null, _oldErr: oldErr };
function j(x) { return JSON.stringify(x); }

// 1+2：分号小数逗号
const semi = 'x;y\n3,14;2,5\n1,5;2,25\n';
const d1 = D.parseCSV(semi);
out.d1 = { columns: d1.columns, rows: d1.rows };
const d2 = D.parseCSV(semi, { numberFormat: 'comma_decimal' });
out.d2 = d2.rows;

// 3：comma_decimal 单元格边界
const cells = ['1.234,56','1.234','0.5','1e3','-0,5',',5','NA'];
out.cells = cells.map(c => D.parseCell(c, 'comma_decimal'));
out.cellsPlain = cells.map(c => D.parseCell(c));

// 4：comma_thousands
const thou = 'name,value\na,"1,234.5"\nb,"2,500"\n';
const t1 = D.parseCSV(thou, { numberFormat: 'comma_thousands' });
out.thou = t1.rows;
const t2 = D.parseCSV('name,value\na,"12,34"\n', { numberFormat: 'comma_thousands' });
out.thouAmb = t2.rows;

// 5：默认行为不变 —— 与 git HEAD 版对比由 Python 侧做；这里先给 plain/缺省/显式 plain
const samplePath = path.join(process.argv[1], '..', 'examples', 'sample.csv');
let sampleText = '';
try { sampleText = fs.readFileSync(samplePath, 'utf8'); } catch (e) {}
out.sampleNoOpt = sampleText ? D.parseCSV(sampleText) : null;
out.samplePlain = sampleText ? D.parseCSV(sampleText, { numberFormat: 'plain' }) : null;
const quoted = 'a,b\n"x,y",1\n"p,q",2\n';
out.quotedNoOpt = D.parseCSV(quoted);
out.quotedPlain = D.parseCSV(quoted, { numberFormat: 'plain' });
const tab = 'a\tb\n1\t2\n3\t4\n';
out.tabNoOpt = D.parseCSV(tab);
out.tabPlain = D.parseCSV(tab, { numberFormat: 'plain' });
// 与 git HEAD 旧版逐一对比：同参调用，结果必须深度相等
function cmpOld(text) {
  if (!oldParseCSV) return { skipped: true };
  const nw = D.parseCSV(text, { delimiter: 'auto', header: true });
  const ol = oldParseCSV(text, { delimiter: 'auto', header: true });
  return { eq: JSON.stringify(nw) === JSON.stringify(ol), nw: nw, ol: ol };
}
out.cmpSample = sampleText ? cmpOld(sampleText) : { skipped: true };
out.cmpQuoted = cmpOld(quoted);
out.cmpTab = cmpOld(tab);

// 6：非法 numberFormat
try { D.parseCSV('a,b\n1,2\n', { numberFormat: 'bogus' }); out.badFmt = 'NO_THROW'; }
catch (e) { out.badFmt = 'THROW:' + e.message.slice(0, 60); }

// 7：sniffNumberFormat
out.sniff1 = D.sniffNumberFormat('x;y\n1;3,14\n2;2,5');
out.sniff2 = D.sniffNumberFormat(thou);
out.sniff3 = D.sniffNumberFormat('x;y\n1;1,234\n2;2,500');
out.sniff4 = D.sniffNumberFormat(sampleText || 'a,b\n1,2\n');
out.sniff5 = D.sniffNumberFormat('x;y\n1;3,14\n2;abc\n');

// 8：parseCell
out.pc1 = D.parseCell('3,14', 'comma_decimal');
out.pc2 = D.parseCell('NA');
out.pc3 = D.parseCell(' abc ');

// 9：引号内逗号 + 分号
out.semiQuote = D.parseCSV('name;note\nA;"x, y, z"\n');

// 10：reviewContext —— manual_edits / parse_options
function mkDoc(srcInfo) {
  return {
    schema_version: '1.0', id: 'd', title: 't',
    canvas: { width_mm: 120, height_mm: 90, dpi: 300 },
    elements: [{
      id: 'chart-1', type: 'chart', name: '测试图',
      chart: {
        chartType: 'bar',
        data: { inline: { columns: ['x','y'], rows: [[1,2]] },
                source_info: srcInfo },
        statistics: { n_definition: 'n', center: 'mean', spread: 'sd' }
      },
      x_mm: 0, y_mm: 0, width_mm: 60, height_mm: 40, rotation_deg: 0, locked: false
    }],
    anchors: [], panels: [], history: [], meta: {}
  };
}
const withEdits = mkDoc({ manual_edits: { count: 1, cells: [{row:0,column:'y',from:1,to:2}], parsed_value_fingerprint: {sha256:'x'} } });
out.rcEdits = S.reviewContext(withEdits).warnings.filter(w => w.code === 'data_manual_edits' || w.code === 'data_parse_options');
const withParse = mkDoc({ parse_options: { delimiter: ';', number_format: 'comma_decimal' } });
out.rcParse = S.reviewContext(withParse).warnings.filter(w => w.code === 'data_manual_edits' || w.code === 'data_parse_options');
const plainDoc = mkDoc({ sha256: 'abc' });
out.rcPlain = S.reviewContext(plainDoc).warnings.filter(w => w.code === 'data_manual_edits' || w.code === 'data_parse_options');

process.stdout.write('@@JSON@@' + j(out));
"""


class ParseOptionsTest(unittest.TestCase):
    def run_node(self, script=NODE_SCRIPT, old_data_path=None):
        proc = subprocess.run(
            ["node", "-e", script, str(BUNDLE / "mcp"), str(old_data_path or "")],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            cwd=str(BUNDLE / "mcp"), timeout=60)
        if proc.returncode != 0:
            self.fail("node failed:\n" + proc.stderr[-3000:])
        marker = "@@JSON@@"
        idx = proc.stdout.find(marker)
        self.assertGreaterEqual(idx, 0, "no JSON marker in stdout: " + proc.stdout[-2000:])
        return json.loads(proc.stdout[idx + len(marker):])

    @classmethod
    def setUpClass(cls):
        # git show HEAD:mcp/lib/data.js → 临时文件，供 node 侧旧版对比
        cls._old_tmp = None
        try:
            proc = subprocess.run(
                ["git", "show", "HEAD:mcp/lib/data.js"],
                capture_output=True, cwd=str(BUNDLE), timeout=30)
            if proc.returncode == 0 and proc.stdout:
                cls._old_tmp = tempfile.NamedTemporaryFile(
                    mode="wb", suffix=".js", delete=False)
                cls._old_tmp.write(proc.stdout)
                cls._old_tmp.close()
        except Exception:
            cls._old_tmp = None
        cls.out = cls().run_node(old_data_path=cls._old_tmp.name if cls._old_tmp else None)

    @classmethod
    def tearDownClass(cls):
        if cls._old_tmp:
            try:
                Path(cls._old_tmp.name).unlink(missing_ok=True)
            except Exception:
                pass

    def test_01_delimiter_and_plain(self):
        o = self.out
        self.assertEqual(o["d1"]["columns"], ["x", "y"])
        self.assertEqual(o["d1"]["rows"], [["3,14", "2,5"], ["1,5", "2,25"]])

    def test_02_comma_decimal(self):
        self.assertEqual(self.out["d2"], [[3.14, 2.5], [1.5, 2.25]])

    def test_03_comma_decimal_cells(self):
        c = self.out["cells"]
        self.assertAlmostEqual(c[0], 1234.56)
        self.assertAlmostEqual(c[1], 1234.0)
        self.assertEqual(c[2], "0.5")          # 0.5 保持文本
        self.assertAlmostEqual(c[3], 1000.0)   # 1e3
        self.assertAlmostEqual(c[4], -0.5)
        self.assertAlmostEqual(c[5], 0.5)
        self.assertIsNone(c[6])                # NA → null

    def test_04_comma_thousands(self):
        rows = self.out["thou"]
        self.assertAlmostEqual(rows[0][1], 1234.5)
        self.assertAlmostEqual(rows[1][1], 2500.0)
        self.assertEqual(self.out["thouAmb"][0][1], "12,34")  # 两读歧义保持文本

    def test_05_default_unchanged(self):
        o = self.out
        # 缺省 numberFormat 与显式 "plain" 深度相等
        self.assertEqual(json.dumps(o["sampleNoOpt"], sort_keys=True),
                         json.dumps(o["samplePlain"], sort_keys=True))
        self.assertEqual(json.dumps(o["quotedNoOpt"], sort_keys=True),
                         json.dumps(o["quotedPlain"], sort_keys=True))
        self.assertEqual(json.dumps(o["tabNoOpt"], sort_keys=True),
                         json.dumps(o["tabPlain"], sort_keys=True))
        # 与 git HEAD 旧版 parseCSV 深度相等（同参 {delimiter:'auto',header:true}）
        for key in ("cmpSample", "cmpQuoted", "cmpTab"):
            cmp = o.get(key) or {}
            if cmp.get("skipped"):
                self.skipTest("git HEAD 旧版 data.js 不可用，跳过 HEAD 对比")
            self.assertTrue(cmp.get("eq"),
                            key + " 新旧 parseCSV 结果不一致：\nnew=" +
                            json.dumps(cmp.get("nw"))[:400] + "\nold=" +
                            json.dumps(cmp.get("ol"))[:400])

    def test_06_invalid_numberFormat_throws(self):
        self.assertTrue(self.out["badFmt"].startswith("THROW"))

    def test_07_sniff(self):
        o = self.out
        self.assertEqual(o["sniff1"]["suggestion"], "comma_decimal")
        self.assertEqual(o["sniff1"]["columns"], ["y"])
        self.assertEqual(o["sniff1"]["example"], "3,14")
        self.assertEqual(o["sniff2"]["suggestion"], "comma_thousands")
        self.assertEqual(o["sniff2"]["columns"], ["value"])
        self.assertIsNone(o["sniff3"]["suggestion"])
        self.assertTrue(o["sniff3"]["ambiguous"])
        self.assertEqual(o["sniff3"]["columns"], ["y"])
        self.assertIsNone(o["sniff4"]["suggestion"])
        self.assertFalse(o["sniff4"]["ambiguous"])
        self.assertEqual(o["sniff4"]["columns"], [])
        self.assertIsNone(o["sniff5"]["suggestion"])
        self.assertFalse(o["sniff5"]["ambiguous"])

    def test_08_parseCell(self):
        self.assertAlmostEqual(self.out["pc1"], 3.14)
        self.assertIsNone(self.out["pc2"])
        self.assertEqual(self.out["pc3"], "abc")

    def test_09_quoted_comma_semicolon(self):
        d = self.out["semiQuote"]
        self.assertEqual(d["columns"], ["name", "note"])
        self.assertEqual(d["rows"], [["A", "x, y, z"]])

    def test_10_reviewContext(self):
        o = self.out
        codes = [w["code"] for w in o["rcEdits"]]
        self.assertIn("data_manual_edits", codes)
        me = [w for w in o["rcEdits"] if w["code"] == "data_manual_edits"][0]
        self.assertEqual(me["severity"], "info")
        self.assertIn("1 个单元格", me["message"])
        codes2 = [w["code"] for w in o["rcParse"]]
        self.assertIn("data_parse_options", codes2)
        self.assertIn("逗号是小数点", [w for w in o["rcParse"] if w["code"] == "data_parse_options"][0]["message"])
        self.assertEqual(o["rcPlain"], [])


if __name__ == "__main__":
    unittest.main()
