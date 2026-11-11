# -*- coding: utf-8 -*-
"""Real offline XLSX integration tests for MCP, loopback HTTP and the GUI module."""

import base64
import hashlib
import http.client
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import unittest.mock
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

from openpyxl import Workbook

MCP_DIR = Path(__file__).resolve().parent
if str(MCP_DIR) not in sys.path:
    sys.path.insert(0, str(MCP_DIR))

import server  # noqa: E402
import viewer  # noqa: E402
from selftest import MCPClient  # noqa: E402


def make_workbook(path):
    workbook = Workbook()
    alpha = workbook.active
    alpha.title = "Alpha"
    alpha.append(["group", "value"])
    alpha.append(["A", 1])
    alpha.append(["B", 2])
    beta = workbook.create_sheet("Beta")
    beta.append(["measurements"])
    beta.append(["x", "y"])
    beta.append([1, 10])
    beta.append([2, 20])
    beta.append([3, 30])
    workbook.save(path)
    return path.read_bytes()


class SpreadsheetIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.sandbox = tempfile.TemporaryDirectory(prefix="figure-xlsx-integration-")
        self.addCleanup(self.sandbox.cleanup)
        self.workbook_path = Path(self.sandbox.name) / "two-sheets.xlsx"
        self.workbook_bytes = make_workbook(self.workbook_path)
        self.workbook_base64 = base64.b64encode(self.workbook_bytes).decode("ascii")
        self.viewer_server = None
        self.viewer_thread = None

    def tearDown(self):
        if self.viewer_server is not None:
            self.viewer_server.shutdown()
            self.viewer_server.server_close()
        if self.viewer_thread is not None:
            self.viewer_thread.join(timeout=10)

    def start_viewer(self):
        self.previous_paths = (viewer.PROJECT_DIR, viewer.CURRENT_PROJECT_PATH)
        self.previous_state = viewer._STATE
        viewer.PROJECT_DIR = Path(self.sandbox.name) / "isolated-project"
        viewer.CURRENT_PROJECT_PATH = viewer.PROJECT_DIR / "current.figureproj.json"
        viewer._STATE = {"doc": None, "project_path": None}
        self.addCleanup(self.restore_viewer)
        self.viewer_server = ThreadingHTTPServer(("127.0.0.1", 0), viewer.ViewerHandler)
        self.viewer_thread = threading.Thread(target=self.viewer_server.serve_forever, daemon=True)
        self.viewer_thread.start()
        return "http://127.0.0.1:%d" % self.viewer_server.server_address[1]

    def restore_viewer(self):
        if self.viewer_server is not None:
            self.viewer_server.shutdown()
            self.viewer_server.server_close()
            self.viewer_server = None
        if self.viewer_thread is not None:
            self.viewer_thread.join(timeout=10)
            self.viewer_thread = None
        viewer.PROJECT_DIR, viewer.CURRENT_PROJECT_PATH = self.previous_paths
        viewer._STATE = self.previous_state

    def http_post(self, base_url, payload, content_type="application/json"):
        raw = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            base_url + "/api/import-spreadsheet", data=raw,
            headers={"Content-Type": content_type}, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read().decode("utf-8"))

    def test_real_mcp_two_sheets_sources_recommendations_and_chart_rows(self):
        client = MCPClient()
        try:
            client.start()
            tools = client.request("tools/list")["result"]["tools"]
            self.assertEqual(len(tools), 26)
            open_schema = next(tool for tool in tools if tool["name"] == "figure_open_data")
            properties = open_schema["inputSchema"]["properties"]
            self.assertTrue({"xlsx_base64", "sheet_name", "sheet", "header_row"} <= set(properties))

            alpha = client.call_tool("figure_open_data", {"path": str(self.workbook_path)})
            self.assertTrue(alpha["ok"], alpha.get("error"))
            self.assertEqual(alpha["sheet_name"], "Alpha")
            self.assertEqual(alpha["sheets"], ["Alpha", "Beta"])
            self.assertEqual(alpha["data"]["rows"], [["A", 1], ["B", 2]])
            self.assertEqual(alpha["stats"]["n_rows"], 2)
            self.assertTrue(alpha["recommended"])
            self.assertTrue(all(item["can_apply"] and item["capability"] != "unsupported"
                                for item in alpha["recommended"]))
            self.assertEqual(alpha["source_info"]["sha256"],
                             hashlib.sha256(self.workbook_bytes).hexdigest())
            self.assertEqual(alpha["notices"], alpha["warnings"])

            beta = client.call_tool("figure_open_data", {
                "path": str(self.workbook_path), "sheet": "Beta", "header_row": 2,
            })
            expected = {"columns": ["x", "y"], "rows": [[1, 10], [2, 20], [3, 30]]}
            self.assertEqual(beta["data"], expected)
            encoded = client.call_tool("figure_open_data", {
                "xlsx_base64": self.workbook_base64, "file_name": "two-sheets.xlsx",
                "sheet_name": "Beta", "header_row": 2,
            })
            self.assertEqual(encoded["data"], expected)
            self.assertEqual(encoded["stats"], beta["stats"])
            self.assertEqual(encoded["source_info"]["sha256"], alpha["source_info"]["sha256"])

            base = client.call_tool("figure_create", {"title": "XLSX integration"})
            created = client.call_tool("figure_create_chart", {
                "doc": base["doc"], "data": {"inline": encoded["data"]},
                "template_id": "tpl-scatter",
            })
            self.assertTrue(created["ok"], created.get("error"))
            chart = next(element for element in created["doc"]["elements"]
                         if element["type"] == "chart")
            self.assertEqual(chart["chart"]["data"]["inline"], expected)
            self.assertEqual(len(created["doc"]["history"]), 1)
            rendered = client.call_tool("figure_render", {"doc": created["doc"], "format": "svg"})
            self.assertTrue(rendered["ok"], rendered.get("error"))
            self.assertIn("data-chart-type=\"scatter\"", rendered["svg"])

            direct = client.call_tool("figure_create_chart", {
                "doc": base["doc"],
                "data": {"path": str(self.workbook_path), "sheet_name": "Beta", "header_row": 2},
                "template_id": "tpl-scatter",
            })
            direct_chart = next(element for element in direct["doc"]["elements"]
                                if element["type"] == "chart")
            self.assertEqual(direct_chart["chart"]["data"]["inline"], expected)

            for arguments in (
                {"path": str(self.workbook_path), "sheet_name": "missing"},
                {"path": str(self.workbook_path), "sheet": "Beta", "sheet_name": "Alpha"},
                {"path": str(self.workbook_path), "csv": "x,y\n1,2"},
                {"xlsx_base64": "%%%not-base64%%%", "file_name": "two-sheets.xlsx"},
                {"xlsx_base64": "data:image/png;base64," + self.workbook_base64,
                 "file_name": "two-sheets.xlsx"},
            ):
                rejected = client.call_tool("figure_open_data", arguments)
                self.assertFalse(rejected["ok"], arguments)
                self.assertIn("error", rejected)
            conflict = client.call_tool("figure_create_chart", {
                "doc": base["doc"],
                "data": {"inline": expected, "path": str(self.workbook_path)},
                "template_id": "tpl-scatter",
            })
            self.assertFalse(conflict["ok"])
            self.assertEqual(base["doc"]["elements"], [])
        finally:
            client.stop()
            if client.proc is not None:
                for stream in (client.proc.stdout, client.proc.stderr):
                    if stream is not None:
                        stream.close()

    def test_loopback_http_switch_errors_limits_and_no_document_history(self):
        base_url = self.start_viewer()
        initial = {
            "file_name": "two-sheets.xlsx", "content_base64": self.workbook_base64,
        }
        status, alpha = self.http_post(base_url, initial)
        self.assertEqual(status, 200, alpha)
        self.assertEqual(alpha["sheet_name"], "Alpha")
        self.assertTrue(alpha["stats"] and alpha["recommended"])

        status, beta = self.http_post(base_url, {
            **initial, "sheet": "Beta", "header_row": 2,
        })
        self.assertEqual(status, 200, beta)
        self.assertEqual(beta["data"], {
            "columns": ["x", "y"], "rows": [[1, 10], [2, 20], [3, 30]],
        })
        self.assertEqual(beta["header_row"], 2)
        self.assertEqual(beta["source_info"]["sha256"], alpha["source_info"]["sha256"])

        bad_requests = (
            {**initial, "sheet": "not-a-sheet"},
            {**initial, "header_row": 0},
            {**initial, "content_base64": "not-base64"},
            {**initial, "content_base64": "data:image/png;base64," + self.workbook_base64},
            {**initial, "path": str(self.workbook_path)},
        )
        for payload in bad_requests:
            status, result = self.http_post(base_url, payload)
            self.assertEqual(status, 400, result)
            self.assertFalse(result["ok"])
        status, result = self.http_post(base_url, initial, content_type="text/plain")
        self.assertEqual(status, 400)
        status, result = self.http_post(base_url, b"{broken-json")
        self.assertEqual(status, 400)

        port = self.viewer_server.server_address[1]
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        connection.putrequest("POST", "/api/import-spreadsheet")
        connection.putheader("Content-Type", "application/json")
        connection.putheader("Content-Length", str(viewer.MAX_SPREADSHEET_JSON_BYTES + 1))
        connection.endheaders()
        response = connection.getresponse()
        self.assertEqual(response.status, 413)
        connection.close()

        self.assertFalse(viewer.CURRENT_PROJECT_PATH.exists())
        self.assertIsNone(viewer._STATE["doc"])

    def test_gui_real_http_preview_then_single_commit_and_figdoc_validation(self):
        base_url = self.start_viewer()
        script = r"""
const assert = require('assert');
const fs = require('fs');
class Node {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase(); this.children = []; this.parentNode = null;
    this.attributes = {}; this.eventListeners = {}; this.style = {}; this.value = '';
    this.checked = false; this.selected = false; this._text = '';
  }
  set textContent(value) { this.children = []; this._text = String(value); }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set innerHTML(value) { this.children = []; this._text = ''; }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (['type', 'name', 'value', 'min', 'max', 'step'].includes(name)) this[name] = String(value);
  }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this; this.children.push(child);
    if (this.tagName === 'SELECT' && child.tagName === 'OPTION' && child.selected) this.value = child.value;
    return child;
  }
  removeChild(child) { const i = this.children.indexOf(child); if (i >= 0) this.children.splice(i, 1); child.parentNode = null; }
  addEventListener(name, handler) { (this.eventListeners[name] || (this.eventListeners[name] = [])).push(handler); }
  dispatch(name) { let result; for (const handler of this.eventListeners[name] || []) result = handler({target: this}); return result; }
  querySelectorAll(selector) {
    const out = [];
    function visit(node) {
      if (selector === 'input[type="radio"]' && node.tagName === 'INPUT' && node.type === 'radio') out.push(node);
      for (const child of node.children) visit(child);
    }
    visit(this); return out;
  }
}
function walk(node, out = []) { out.push(node); for (const child of node.children) walk(child, out); return out; }
global.document = {
  createElement: tag => new Node(tag),
  createTextNode: text => { const node = new Node('#text'); node.textContent = text; return node; },
  body: new Node('body'),
  addEventListener() {}
};
for (const file of ['./lib/figdoc.js', './lib/palette.js', './lib/presets.js', './lib/data.js',
                     './lib/ops.js', './viewer_static/app/state.js']) require(file);
const presetDir = '../presets';
FigPresets.load({
  journals: JSON.parse(fs.readFileSync(presetDir + '/journals.json', 'utf8')),
  templates: JSON.parse(fs.readFileSync(presetDir + '/templates.json', 'utf8')),
  palettes: JSON.parse(fs.readFileSync(presetDir + '/palettes.json', 'utf8'))
});
let modal = null;
global.Ui = { modal: opts => { modal = opts; return {close() {}}; }, toast() {} };
require('./viewer_static/app/import.js');
require('./viewer_static/app/spreadsheet-import.js');
const panel = new Node('section');
Import.mount(panel);
assert.deepStrictEqual(
  walk(panel).filter(node => node.tagName === 'BUTTON').map(node => node.textContent),
  ['导入数据', '导入图片', '导入 SVG']);
assert.ok(!walk(panel).some(n => n.attributes['data-spreadsheet-mount'] === '1'),
  '原生导入数据入口不得自动追加重复 Excel 按钮');
const nativeFetch = global.fetch;
global.fetch = (url, opts) => nativeFetch(process.env.XLSX_TEST_BASE + url, opts);
App.setDoc(FigDoc.create({title: 'GUI XLSX isolated'}), {reason: 'test'});
let commits = 0;
const originalCommit = App.commit.bind(App);
App.commit = (ops, opts) => { commits++; return originalCommit(ops, opts); };
let callbackResult = null;
const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
(async () => {
  const initial = await SpreadsheetImport._openBase64('two-sheets.xlsx', payload.base64,
    (err, result) => { assert.ifError(err); callbackResult = result; });
  assert.strictEqual(initial.sheet_name, 'Alpha');
  assert.ok(modal, '初始化后应出现工作表/表头/推荐模板 GUI');
  assert.strictEqual(commits, 0);
  assert.strictEqual(App.doc.history.length, 0);
  assert.strictEqual(App.doc.elements.length, 0);
  const nodes = walk(modal.body);
  const sheets = nodes.find(n => n.attributes['data-spreadsheet-sheet'] === '1');
  const header = nodes.find(n => n.attributes['data-spreadsheet-header'] === '1');
  const status = nodes.find(n => n.attributes['data-spreadsheet-status'] === '1');
  assert.ok(sheets && header && status);
  sheets.value = 'Beta'; header.value = '2';
  sheets.dispatch('change');
  for (let i = 0; i < 500 && !status.textContent.includes('3 行数据'); i++) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(status.textContent.includes('工作表「Beta」'), status.textContent);
  assert.ok(status.textContent.includes('表头第 2 行'), status.textContent);
  assert.strictEqual(commits, 0, 'worksheet preview 不得调用 App.commit');
  assert.strictEqual(App.doc.history.length, 0, 'worksheet preview 不得写 history');
  const radios = modal.body.querySelectorAll('input[type="radio"]');
  assert.ok(radios.length > 0, '真实 FigPresets 推荐已渲染');
  const scatter = radios.find(radio => radio.value === 'tpl-scatter');
  assert.ok(scatter, '两个数值列应推荐可真实生成的散点图');
  scatter.checked = true;
  const commitPromise = modal.actions[1].onClick();
  assert.ok(commitPromise && typeof commitPromise.then === 'function');
  assert.strictEqual(await commitPromise, true);
  assert.strictEqual(commits, 1);
  assert.strictEqual(App.doc.history.length, 1);
  const charts = App.doc.elements.filter(el => el.type === 'chart');
  assert.strictEqual(charts.length, 1);
  assert.deepStrictEqual(charts[0].chart.data.inline,
    {columns: ['x', 'y'], rows: [[1, 10], [2, 20], [3, 30]]});
  const validation = FigDoc.validate(App.doc);
  assert.strictEqual(validation.ok, true, JSON.stringify(validation));
  const svg = FigData.renderChartSVG(charts[0].chart, {width_mm: 120, height_mm: 90, dpi: 300});
  assert.ok(svg.includes('<g') && svg.includes('data-chart-type="scatter"'), svg.slice(0, 500));
  const noteOp = App.doc.history[0].ops.find(op => op.op === 'note');
  assert.ok(noteOp, JSON.stringify(App.doc.history));
  const note = noteOp.note;
  assert.ok(note.includes('工作表 Beta') && note.includes('表头第 2 行') && note.includes('sha256='), note);
  assert.ok(callbackResult, 'GUI 必须回传真实提交结果');
  assert.strictEqual(callbackResult.sheet_name, 'Beta');
  console.log(JSON.stringify({ok: true, chartType: charts[0].chart.chartType,
    rows: charts[0].chart.data.inline.rows, history: App.doc.history.length, commits}));
})().catch(err => { console.error(err && err.stack || err); process.exitCode = 1; });
"""
        env = dict(os.environ, XLSX_TEST_BASE=base_url, PYTHONDONTWRITEBYTECODE="1")
        completed = subprocess.run(
            ["node", "-e", script], cwd=str(MCP_DIR), env=env,
            input=json.dumps({"base64": self.workbook_base64}),
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=90)
        self.assertEqual(completed.returncode, 0,
                         "GUI stdout=%s\nGUI stderr=%s" % (completed.stdout, completed.stderr))
        result = json.loads(completed.stdout.strip().splitlines()[-1])
        self.assertTrue(result["ok"])
        self.assertEqual(result["rows"], [[1, 10], [2, 20], [3, 30]])
        self.assertEqual(result["commits"], 1)
        self.assertEqual(result["history"], 1)
        self.assertFalse(viewer.CURRENT_PROJECT_PATH.exists())

    def test_legacy_shape_and_source_validation(self):
        with unittest.mock.patch.object(
                server, "bcall", side_effect=lambda name, **kwargs: (
                    {"columns": ["x"], "rows": [[1]]} if name == "data.parse_csv"
                    else {"n_rows": 1, "columns": []} if name == "data.column_stats"
                    else [])) as bridge:
            legacy = server.tool_figure_open_data({"csv": "x\n1"})
        self.assertEqual(set(legacy), {"ok", "columns", "stats", "recommended"})
        inline = {"columns": ["x"], "rows": [[1]]}
        self.assertIs(server._parse_data_source({"inline": inline}), inline)
        with self.assertRaisesRegex(server.ToolError, "多个数据源"):
            server._parse_data_source({"csv": "x\n1", "inline": inline})
        with self.assertRaisesRegex(server.ToolError, "过大"):
            with unittest.mock.patch.object(server, "MAX_SPREADSHEET_BYTES", 8):
                server._validate_spreadsheet_base64(base64.b64encode(b"123456789").decode())
        with self.assertRaisesRegex(server.ToolError, "MIME"):
            server._validate_spreadsheet_base64("data:image/png;base64,AAAA")
        self.assertEqual(server.tools_spec.build_tools_json()["count"], 26)


if __name__ == "__main__":
    unittest.main()
