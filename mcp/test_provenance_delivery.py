# -*- coding: utf-8 -*-
"""Synthetic provenance/delivery boundaries only; no current project, network or scores."""
import contextlib
import hashlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

MCP_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(MCP_DIR))
import server  # noqa: E402


def diagram_with_layout_group():
    doc = server.tool_figure_create({"title": "synthetic delivery only"})["doc"]
    doc = server.tool_figure_schematic({
        "doc": doc,
        "contract": {
            "id": "synthetic-provenance",
            "nodes": [{"id": "n", "label": "Synthetic node", "role": "method", "evidence": ["note"]}],
            "relations": [],
            "sources": [{"id": "note", "locator": "synthetic note", "version": "v1"}],
        },
    })["doc"]
    doc["elements"].append({
        "id": "harmless-layout-group", "type": "group", "parent_id": None,
        "transform": {"x": 0, "y": 0, "w": 0, "h": 0}, "children": [],
    })
    return doc


class ProvenanceDeliveryTests(unittest.TestCase):
    def test_raw_sources_exact_bytes_noop_version_and_value_lineage(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            base = server.tool_figure_create({"title": "synthetic raw"})["doc"]
            csv_text = "group,value\nA,2\nA,4\n"
            made = server.tool_figure_create_chart({
                "doc": base, "chart_type": "bar", "data": {"csv": csv_text},
            })
            info = made["source_info"]
            self.assertEqual(info["sha256"], hashlib.sha256(csv_text.encode("utf-8")).hexdigest())
            self.assertIn("unverified", info["verification_status"])
            self.assertEqual(info["locator_kind"], "provided_text_not_a_file")
            self.assertEqual(made["doc"]["meta"]["source_info"], info)
            self.assertEqual(made["doc"]["meta"]["data_sources"][-1], info)
            chart = next(item for item in made["doc"]["elements"] if item["type"] == "chart")
            self.assertEqual(chart["chart"]["data"]["inline"],
                             server.bcall("data.parse_csv", text=csv_text))
            self.assertEqual(chart["chart"]["mapping"], {"x": "group", "y": "value", "group": None})
            self.assertEqual(chart["chart"]["data"]["source_info"], info)
            lineage = server.tool_figure_lineage({"doc": made["doc"]})
            self.assertEqual(lineage["charts"][0]["value_comparison"]["status"], "match")

            cid = chart["id"]
            operation = {
                "op": "set_chart_data", "targets": [cid], "approved": True,
                "data": {"columns": ["group", "value"], "rows": [["A", 2], ["A", 4]]},
                "source_ref": info["locator"], "version": "explicit-v1",
            }
            versioned = server.tool_figure_apply_edits({"doc": made["doc"], "ops": [operation]})
            self.assertTrue(versioned["ok"])
            self.assertEqual(versioned["applied"], 1)
            before = json.dumps(versioned["doc"], ensure_ascii=False, sort_keys=True)
            repeated = server.tool_figure_apply_edits({"doc": versioned["doc"], "ops": [operation]})
            self.assertTrue(repeated["ok"])
            self.assertEqual(repeated["applied"], 0)
            self.assertEqual(json.dumps(repeated["doc"], ensure_ascii=False, sort_keys=True), before)
            denied = server.tool_figure_apply_edits({
                "doc": versioned["doc"], "ops": [dict(operation, approved=False)],
            })
            self.assertFalse(denied["ok"])
            self.assertEqual(json.dumps(denied["doc"], ensure_ascii=False, sort_keys=True), before)

            changed_data = dict(operation, data={"columns": ["group", "value"],
                                                "rows": [["A", 2], ["A", 8]]})
            changed = server.tool_figure_apply_edits({"doc": versioned["doc"], "ops": [changed_data]})
            self.assertEqual(changed["applied"], 1)
            current = next(item for item in changed["doc"]["elements"] if item["id"] == cid)["chart"]
            self.assertEqual(current["data"]["raw_source_sha256"], "unknown")
            self.assertNotIn("source_info", current["data"])
            self.assertEqual(current["data_history"][0]["data"]["source_info"], info)
            lineage = server.tool_figure_lineage({"doc": changed["doc"]})
            comparison = lineage["charts"][0]["value_comparison"]
            self.assertEqual(comparison["status"], "not_recorded")
            self.assertIsNone(comparison["value_matches_import"])
            unknown = next(issue for issue in lineage["issues"]
                           if issue["code"] == "RAW_SOURCE_SHA_UNKNOWN")
            self.assertEqual(unknown["severity"], "warning")
            self.assertEqual(unknown["element_id"], cid)
            self.assertEqual(unknown["verification"], "not_verified")

            raw = b"\xef\xbb\xbfgroup,value\r\nA,2\r\nA,4\r\n"
            path = root / "mini.csv"
            path.write_bytes(raw)
            from_path = server.tool_figure_create_chart({
                "doc": base, "chart_type": "bar", "data": {"path": str(path)},
            })
            self.assertEqual(from_path["source_info"]["sha256"], hashlib.sha256(raw).hexdigest())
            path_chart = next(item for item in from_path["doc"]["elements"] if item["type"] == "chart")
            self.assertEqual(path_chart["chart"]["data"]["inline"], chart["chart"]["data"]["inline"])
            self.assertEqual(path.read_bytes(), raw)

            json_text = '[{"group":"B","value":8}]'
            from_json = server.tool_figure_create_chart({
                "doc": base, "chart_type": "bar", "data": {"json": json_text},
            })
            self.assertEqual(from_json["source_info"]["sha256"],
                             hashlib.sha256(json_text.encode("utf-8")).hexdigest())
            json_chart = next(item for item in from_json["doc"]["elements"] if item["type"] == "chart")
            self.assertEqual(json_chart["chart"]["data"]["inline"], {
                "columns": ["group", "value"], "rows": [["B", 8]],
            })

            secret = root / "unintended-secret.key"
            secret.write_text("must-not-be-read", encoding="utf-8")
            with mock.patch("builtins.open", side_effect=AssertionError("secret file was read")):
                with self.assertRaises(server.ToolError):
                    server._parse_data_source_with_info({"path": str(secret)})
                with self.assertRaises(server.ToolError):
                    server.tool_figure_open_data({"path": str(secret)})
            self.assertEqual(secret.read_text(encoding="utf-8"), "must-not-be-read")

    def test_bundle_ready_partial_duplicates_nan_traversal_and_redaction(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "mini-raw.xlsx"
            raw = b"synthetic source bytes; not a parsed workbook or paper"
            source.write_bytes(raw)
            sha = hashlib.sha256(raw).hexdigest()
            doc = diagram_with_layout_group()
            with self.subTest("ready requires real decoded artifacts"):
                output = root / "ready"
                result = server.tool_figure_export_bundle({
                    "doc": doc, "output_directory": str(output),
                    "input_source": [{"path": str(source), "sha256": sha}] * 2,
                    "output_contract": {"formats": ["svg", {"format": "png", "dpi": 24}, "pdf"]},
                })
                self.assertEqual(result["status"], "ready_for_review")
                lineage = json.loads((output / "lineage.json").read_text(encoding="utf-8"))
                self.assertFalse(any(issue.get("code") == "UNIT_MISSING"
                                     and issue.get("element_id") == "harmless-layout-group"
                                     for issue in lineage.get("issues", [])))
                self.assertEqual(lineage["diagrams"][0]["sources"], [{
                    "id": "note", "locator": "synthetic note", "version": "v1",
                    "verification": "user_provided_unverified",
                }])
                decoded = [item for item in result["artifacts"] if item.get("role") == "export"]
                self.assertEqual({item["format"] for item in decoded}, {"svg", "png", "pdf"})
                self.assertEqual(next(item for item in decoded if item["format"] == "png")["decoded"]["mime_type"],
                                 "image/png")
                self.assertTrue(next(item for item in decoded if item["format"] == "pdf")["decoded"]["text_available"])

            target_secret = root / "targetdir-secret.svg"
            secret_text = "outside-content-must-not-change"
            target_secret.write_text(secret_text, encoding="utf-8")
            output = root / "partial"
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                result = server.tool_figure_export_bundle({
                    "doc": doc, "output_directory": str(output),
                    "input_source": [{"path": str(source), "sha256": sha}] * 2,
                    "output_contract": {
                        "apiKey": "top-secret-api-value",
                        "nested": {"client_secret": "top-secret-client-value"},
                        "formats": [
                            {"format": "png", "filename": "mini.png", "dpi": 24},
                            {"format": "png", "filename": "mini.png", "dpi": 24},
                            {"format": "png", "filename": "nan.png", "dpi": float("nan")},
                            {"format": "svg", "filename": "../targetdir-secret.svg"},
                        ],
                    },
                })
            self.assertEqual(result["status"], "partial")
            self.assertEqual(len(result["errors"]), 2)
            self.assertTrue((output / "mini.png").is_file())
            self.assertTrue((output / "mini-2.png").is_file())
            self.assertFalse((output / "nan.png").exists())
            self.assertEqual(target_secret.read_text(encoding="utf-8"), secret_text)
            self.assertTrue(all(item["hash_match"] is True for item in result["source"]))
            self.assertTrue(all(item["status"] != "verified" for item in result["source"] + result["artifacts"]))
            public = json.dumps(result, ensure_ascii=False)
            self.assertNotIn("top-secret-api-value", public + stderr.getvalue())
            self.assertNotIn("top-secret-client-value", public + stderr.getvalue())
            self.assertNotIn(secret_text, public + stderr.getvalue())
            self.assertNotIn("top-secret-api-value", (output / "result.json").read_text(encoding="utf-8"))
            self.assertNotIn("top-secret-client-value", (output / "manifest.json").read_text(encoding="utf-8"))

            mismatch = server.tool_figure_export_bundle({
                "doc": doc, "output_directory": str(root / "mismatch"),
                "input_source": {"path": str(source), "sha256": "0" * 64},
                "output_contract": {"formats": ["svg"]},
            })
            self.assertEqual(mismatch["status"], "partial")
            self.assertEqual(mismatch["source"][0]["status"], "hash_mismatch")
            missing = server.tool_figure_export_bundle({
                "doc": doc, "output_directory": str(root / "missing"),
                "input_source": str(root / "not-seen.pdf"),
                "output_contract": {"formats": ["svg"]},
            })
            self.assertEqual(missing["status"], "partial")
            self.assertEqual(missing["source"][0]["fetch_status"], "not_attempted_local_only")
            self.assertNotIn("fetch success", json.dumps(missing))

    def test_real_node_local_file_bytes_and_commit_metadata(self):
        script = r"""
const assert = require('assert');
const fs = require('fs');
const crypto = require('crypto');
for (const file of ['figdoc', 'ops', 'palette', 'presets', 'data']) require('./lib/' + file + '.js');
FigPresets.load({
  journals: JSON.parse(fs.readFileSync('../presets/journals.json', 'utf8')),
  templates: JSON.parse(fs.readFileSync('../presets/templates.json', 'utf8')),
  palettes: JSON.parse(fs.readFileSync('../presets/palettes.json', 'utf8'))
});
class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null;
    this.style = {}; this.attributes = {}; this.listeners = {}; this.value = ''; this.checked = false; this._text = ''; }
  set textContent(value) { this.children = []; this._text = String(value); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(value) { this.children = []; this._text = ''; }
  appendChild(child) { if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this; this.children.push(child); return child; }
  removeChild(child) { const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1); child.parentNode = null; }
  setAttribute(key, value) { this.attributes[key] = String(value); if (key === 'value') this.value = String(value); }
  getAttribute(key) { return this.attributes[key] == null ? null : this.attributes[key]; }
  addEventListener(name, handler) { (this.listeners[name] || (this.listeners[name] = [])).push(handler); }
  querySelectorAll() { return []; }
}
global.document = {body: new Element('body'), createElement: tag => new Element(tag),
  createTextNode: text => { const node = new Element('#text'); node.textContent = text; return node; },
  addEventListener() {}, getElementById() { return null; }};
const modals = [];
global.Ui = {modal(options) { modals.push(options); return {close() {}}; }, toast() {}};
global.App = {doc: FigDoc.create({title: 'synthetic node raw'}), commits: 0,
  commit(ops, context) { const result = FigOps.applyAll(this.doc, ops,
    {label: context.label, source: context.source, ts: '2026-01-01T00:00:00Z'});
    if (result.applied) { this.doc = result.doc; this.commits++; }
    return Promise.resolve({applied: result.applied, doc: this.doc}); },
  select() {}, error(text) { throw new Error(text); }, status() {}};
require('./viewer_static/app/import.js');
(async () => {
  const raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('group,value\r\n甲,2\r\n乙,4\r\n', 'utf8')]);
  const expected = crypto.createHash('sha256').update(raw).digest('hex');
  assert.strictEqual(Import._sha256Bytes(new Uint8Array(raw)), expected);
  let reads = 0, csvResult = null;
  await Import._applyDataFile({name: 'mini.csv', arrayBuffer: async () => { reads++;
    return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength); }},
  (error, result) => { assert.ifError(error); csvResult = result; });
  assert.strictEqual(reads, 1);
  assert.strictEqual(await modals[modals.length - 1].actions[1].onClick(), true);
  const chart = App.doc.elements.find(element => element.type === 'chart');
  assert.deepStrictEqual(chart.chart.data.inline,
    {columns: ['group', 'value'], rows: [['甲', 2], ['乙', 4]]});
  const reference = FigPresets.templateFromStats(csvResult.template_id, chart.chart.data.inline,
    {journal_id: null, palette_id: null});
  const referenceChart = reference.elements.find(element => element.type === 'chart');
  assert.deepStrictEqual(chart.chart.mapping, referenceChart.chart.mapping);
  assert.strictEqual(chart.chart.data.source_info.sha256, expected);
  assert.strictEqual(chart.chart.data.source_info.bytes, raw.length);
  assert.strictEqual(csvResult.source_info.verification_status, 'input_bytes_hashed_unverified_origin');
  assert.ok(csvResult.source_info.value_fingerprint.sha256);
  const jsonText = '[{"group":"B","value":8}]';
  let jsonResult = null;
  Import._applyDataTable(jsonText, 'mini.json', (error, result) => {
    assert.ifError(error); jsonResult = result;
  }, new TextEncoder().encode(jsonText));
  await modals[modals.length - 1].actions[1].onClick();
  assert.strictEqual(jsonResult.source_info.sha256,
    crypto.createHash('sha256').update(jsonText).digest('hex'));
  assert.strictEqual(App.commits, 2);
  assert.strictEqual(App.doc.history.length, 2);
  console.log(JSON.stringify({ok: true, sha: expected, rows: chart.chart.data.inline.rows, commits: App.commits}));
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
"""
        completed = subprocess.run(
            ["node", "-e", script], cwd=MCP_DIR, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=90,
        )
        self.assertEqual(completed.returncode, 0, completed.stdout + "\n" + completed.stderr)
        result = json.loads(completed.stdout.strip().splitlines()[-1])
        self.assertTrue(result["ok"])
        self.assertEqual(result["rows"], [["甲", 2], ["乙", 4]])
        self.assertEqual(result["commits"], 2)


if __name__ == "__main__":
    unittest.main()
