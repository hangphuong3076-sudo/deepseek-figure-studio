# -*- coding: utf-8 -*-
"""True stdio MCP scenarios with explicit synthetic DEMO entities and data only."""
import collections
import copy
import hashlib
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

import fitz
from PIL import Image

MCP_DIR = Path(__file__).resolve().parent


def contract(identifier, graphical=False):
    roles = ["question", "method", "evidence", "conclusion"]
    labels = ["DEMO question", "DEMO method", "DEMO observation", "DEMO bounded conclusion"]
    shapes = ["box", "process", "material", "outcome"]
    return {
        "schema_version": "1.0", "id": identifier,
        "template": "graphical_abstract" if graphical else "flow",
        "nodes": [{"id": "node-%d" % (i + 1), "label": labels[i], "role": roles[i] if graphical else "method",
                   "shape": shapes[i], "kind": "entity", "x": 10 + 40 * i, "y": 15, "w": 25, "h": 14,
                   "evidence": ["DEMO-SOURCE"]} for i in range(4)],
        "relations": [
            {"id": "activation", "from": "node-1", "to": "node-2", "kind": "activate",
             "label": "DEMO link", "evidence": ["DEMO-SOURCE"]},
            {"id": "inhibition", "source": "node-2", "target": "node-3", "kind": "inhibit",
             "direction": "reverse", "evidence": ["DEMO-SOURCE"]},
            {"id": "association", "source": "node-3", "target": "node-4", "kind": "associate",
             "bend": 4, "evidence": ["DEMO-SOURCE"]},
            {"id": "containment", "source": "node-1", "target": "node-2", "kind": "include",
             "evidence": ["DEMO-SOURCE"]},
        ],
        "sources": [{"id": "DEMO-SOURCE", "locator": "DEMO only/synthetic narrative §1",
                     "version": "demo-v1", "sha256": "d" * 64,
                     "text": "Synthetic DEMO source text, not a paper or executable code."}],
        "canvas": {"width_mm": 180, "height_mm": 60, "dpi": 96, "background": "#FFFFFF"},
        "layout": {"mode": "manual", "auto_layout": False},
    }


class MCP:
    def __init__(self):
        env = dict(os.environ)
        env.pop("DEEPSEEK_API_KEY", None)
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        self.process = subprocess.Popen([sys.executable, "-B", str(MCP_DIR / "server.py")],
            cwd=str(MCP_DIR), env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace", bufsize=1)
        self.responses = queue.Queue()
        self.errors = collections.deque(maxlen=20)
        self.serial = 0
        threading.Thread(target=self._stdout, daemon=True).start()
        threading.Thread(target=self._stderr, daemon=True).start()

    def _stdout(self):
        for line in self.process.stdout:
            self.responses.put(line)
        self.responses.put(None)

    def _stderr(self):
        for line in self.process.stderr:
            self.errors.append(line.rstrip()[:400])

    def call(self, name, arguments, succeed=True):
        self.serial += 1
        request = {"jsonrpc": "2.0", "id": self.serial, "method": "tools/call",
                   "params": {"name": name, "arguments": arguments}}
        self.process.stdin.write(json.dumps(request, ensure_ascii=False) + "\n")
        self.process.stdin.flush()
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            line = self.responses.get(timeout=max(0.1, deadline - time.monotonic()))
            if line is None:
                raise AssertionError("MCP stopped: " + " | ".join(self.errors))
            response = json.loads(line)
            if response.get("id") != self.serial:
                continue
            if "error" in response:
                raise AssertionError(response["error"])
            payload = json.loads(response["result"]["content"][0]["text"])
            if succeed and not payload.get("ok"):
                raise AssertionError(payload)
            return payload
        raise TimeoutError(name)

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()


class SchematicMCPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mcp = MCP()

    @classmethod
    def tearDownClass(cls):
        cls.mcp.close()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="figure-schematic-mcp-demo-")

    def tearDown(self):
        self.tmp.cleanup()
        self.assertFalse(Path(self.tmp.name).exists())

    def schematic(self, name, graphical=False, doc=None):
        args = {"contract": contract(name, graphical), "preview": True}
        if doc is not None:
            args["doc"] = doc
        return self.mcp.call("figure_schematic", args)

    def assert_native_svg(self, svg):
        self.assertIn('data-relation-kind="activate"', svg)
        self.assertIn('data-relation-kind="inhibit"', svg)
        self.assertIn('data-relation-kind="associate"', svg)
        self.assertNotIn("<script", svg.lower())
        root = ET.fromstring(svg)
        ids = [item.attrib["id"] for item in root.iter() if "id" in item.attrib]
        fig_ids = [item.attrib["data-fig-id"] for item in root.iter() if "data-fig-id" in item.attrib]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(len(fig_ids), len(set(fig_ids)))
        self.assertGreater(len(fig_ids), 10)

    def test_source_value_chart_explicit_replacement_and_reverse_lookup(self):
        created = self.mcp.call("figure_create", {"title": "DEMO source-value chart",
                                                  "width_mm": 120, "height_mm": 70, "dpi": 96})
        table = {"columns": ["condition", "response"], "rows": [["CONTROL", 2], ["TREATMENT", 4]]}
        made = self.mcp.call("figure_create_chart", {"doc": created["doc"], "template_id": "tpl-bar",
            "data": {"inline": table}, "transform": {"x": 10, "y": 5, "w": 95, "h": 55}})
        chart_id = next(el["id"] for el in made["doc"]["elements"] if el["type"] == "chart")
        chart = next(el for el in made["doc"]["elements"] if el["id"] == chart_id)
        chart["chart"]["statistics"] = {"center": "mean", "spread": "SD", "source_data": "DEMO-v1.csv"}
        before_stats = copy.deepcopy(chart["chart"]["statistics"])
        before_mapping = copy.deepcopy(chart["chart"]["mapping"])
        before_style = copy.deepcopy(chart["style"])
        denied = self.mcp.call("figure_apply_edits", {"doc": made["doc"], "ops": [{
            "op": "set_chart_data", "targets": [chart_id], "approved": False,
            "data": {"columns": ["condition", "response"], "rows": [["CONTROL", 99]]},
            "source_ref": "DEMO-v2.csv", "version": "v2"}]}, succeed=False)
        self.assertIn("approved", denied["error"])
        changed = self.mcp.call("figure_apply_edits", {"doc": made["doc"], "ops": [{
            "op": "set_chart_data", "targets": [chart_id], "approved": True,
            "data": {"columns": ["condition", "response"], "rows": [["CONTROL", 6], ["TREATMENT", 8]]},
            "source_ref": "DEMO-v2.csv", "version": "v2"}]})
        chart = next(el for el in changed["doc"]["elements"] if el["id"] == chart_id)
        self.assertEqual(chart["chart"]["statistics"], before_stats)
        self.assertEqual(chart["chart"]["mapping"], before_mapping)
        self.assertEqual(chart["style"], before_style)
        self.assertEqual(chart["chart"]["statistics_review"]["status"], "required")
        self.assertEqual(chart["chart"]["data"]["source_ref"], "DEMO-v2.csv")
        self.assertEqual(chart["chart"]["data"]["version"], "v2")
        self.assertEqual(chart["chart"]["data"]["row_mapping"][1], {"inline_row_index": 1, "source_row_index": None},
                         "Inline row indices must not be fabricated as original-file row numbers")
        self.assertTrue(chart["chart"]["data_history"])
        self.assertEqual(chart["chart"]["data_history"][0]["data"]["inline"]["rows"][0][1], 2)
        audit = self.mcp.call("figure_scientific_audit", {"doc": changed["doc"]}, succeed=False)
        self.assertFalse(audit["scientific_ready"])
        self.assertTrue(any(w["code"] == "DATA_STATS_REVIEW_REQUIRED" for w in audit["warnings"]))
        lineage = self.mcp.call("figure_lineage", {"doc": changed["doc"],
            "lookup": {"element_id": chart_id, "source_row": 1}})
        self.assertEqual(lineage["lookup"]["count"], 1)
        self.assertEqual(lineage["lookup"]["matches"][0]["raw_point"]["values_by_column"]["response"], 8)
        self.assertIn(">6</text>", self.mcp.call("figure_render", {"doc": changed["doc"], "format": "svg"})["svg"])
        same = self.mcp.call("figure_apply_edits", {"doc": changed["doc"], "ops": [{
            "op": "set_chart_data", "targets": [chart_id], "approved": True,
            "data": copy.deepcopy(chart["chart"]["data"]["inline"]),
            "source_ref": "DEMO-v2.csv", "version": "v2"}]})
        self.assertEqual(same["applied"], 0)
        external_edit = copy.deepcopy(chart["chart"]["data"])
        external_edit["source_ref"] = "DEMO different locator"
        self.assertEqual(chart["chart"]["data"]["inline"]["rows"][0][1], 6,
                         "A source-label edit in an external copy cannot secretly change actual rows")
        linked = self.mcp.call("figure_schematic", {"doc": same["doc"], "contract": contract("demo-chart-source-note")})
        linked_contract = contract("demo-chart-source-note")
        linked_contract["sources"][0]["note"] = "DEMO changed source annotation only"
        reannotated = self.mcp.call("figure_schematic", {"doc": linked["doc"], "contract": linked_contract})
        chart_after = next(el for el in reannotated["doc"]["elements"] if el["id"] == chart_id)
        self.assertEqual(chart_after["chart"]["data"]["inline"], chart["chart"]["data"]["inline"])
        self.assertEqual(chart_after["chart"]["mapping"], before_mapping)
        self.assertEqual(chart_after["chart"]["data_history"], chart["chart"]["data_history"])
        self.assertIn("DEMO changed source annotation only", reannotated["diagram"]["sources"][0]["note"])

    def test_source_linked_flow_move_and_real_svg_png_pdf_bundle(self):
        made = self.schematic("demo-source-linked-flow")
        doc = made["doc"]
        self.assertEqual(made["diagram"]["source_verification"], "user_provided_unverified")
        self.assertEqual(made["diagram"]["sources"][0]["locator"], "DEMO only/synthetic narrative §1")
        self.assertEqual(made["diagram"]["review_status"], "not_recorded")
        self.assert_native_svg(made["svg"])
        self.assertEqual(made["svg"], self.mcp.call("figure_render", {"doc": doc, "format": "svg"})["svg"])
        connector = next(el for el in doc["elements"] if el["type"] == "connector")
        self.assertNotIn("pathData", connector)
        moved = self.mcp.call("figure_apply_edits", {"doc": doc, "ops": [
            {"op": "move", "targets": ["node-2"], "dx": -15, "dy": 8}]})
        moved_svg = self.mcp.call("figure_render", {"doc": moved["doc"], "format": "svg"})["svg"]
        self.assertNotEqual(made["svg"], moved_svg)
        self.assert_native_svg(moved_svg)
        self.assertTrue(any(el.get("diagram_manual_layout") for el in moved["doc"]["elements"] if el["id"] == "node-2"))
        for fmt in ("svg", "png", "pdf"):
            path = Path(self.tmp.name) / ("flow." + fmt)
            exported = self.mcp.call("figure_export", {"doc": moved["doc"], "format": fmt,
                                                       "dpi": 96, "out_path": str(path)})
            self.assertEqual(exported["path"], str(path))
            self.assertGreater(path.stat().st_size, 100)
            if fmt == "png":
                with Image.open(path) as image:
                    image.verify()
            elif fmt == "pdf":
                with fitz.open(path) as pdf:
                    self.assertEqual(pdf.page_count, 1)
                    self.assertIn("DEMO", pdf[0].get_text())
        source = Path(self.tmp.name) / "DEMO-source.txt"
        source.write_text("Synthetic DEMO narrative, not a paper.\n", encoding="utf-8")
        bundle = self.mcp.call("figure_export_bundle", {
            "doc": moved["doc"], "output_directory": str(Path(self.tmp.name) / "bundle"),
            "case_id": "DEMO-flow-not-an-official-case",
            "input_source": {"path": str(source), "sha256": hashlib.sha256(source.read_bytes()).hexdigest()},
            "output_contract": {"formats": ["svg", {"format": "png", "dpi": 96}, {"format": "pdf", "dpi": 96}],
                                "purpose": "DEMO structure check only"},
            "ui_native_result_status": "DEMO decoded by software; not human reviewed"})
        self.assertIsNone(bundle["human_review"])
        self.assertNotIn("benchmark_score", bundle)
        self.assertTrue(any(a["format"] == "pdf" and a["decoded"]["decoded"] for a in bundle["artifacts"]))
        manifest = json.loads(Path(bundle["manifest_path"]).read_text(encoding="utf-8"))
        self.assertTrue(manifest["artifacts"])

    def test_graphical_abstract_repeat_layout_and_structural_failures(self):
        one = self.schematic("demo-graphical-abstract", graphical=True)
        two = self.schematic("demo-graphical-abstract", graphical=True)
        self.assertEqual(one["svg"], two["svg"])
        self.assertEqual(set(one["diagram"]["coverage"]), {"question", "method", "evidence", "conclusion"})
        manual = self.mcp.call("figure_apply_edits", {"doc": one["doc"], "ops": [
            {"op": "move", "targets": ["node-1"], "x": 5, "y": 35}]})
        changed = contract("demo-graphical-abstract", graphical=True)
        changed["sources"][0]["note"] = "DEMO annotation changed; no entity inference"
        updated = self.mcp.call("figure_schematic", {"doc": manual["doc"], "contract": changed, "preview": True})
        node = next(el for el in updated["doc"]["elements"] if el["id"] == "node-1")
        self.assertEqual((node["transform"]["x"], node["transform"]["y"]), (5, 35))
        self.assertIsNone(updated["human_review"])
        changed["layout"]["auto_layout"] = True
        relaid = self.mcp.call("figure_schematic", {"doc": updated["doc"], "contract": changed, "preview": True})
        self.assertNotEqual(next(el for el in relaid["doc"]["elements"] if el["id"] == "node-1")["transform"]["y"], 35)
        declared = contract("demo-declared-review")
        declared["human_review"] = {"reviewer": "DEMO declared reviewer", "checked_at": "2026-01-01T00:00:00Z",
                                    "outcome": "changes_requested", "notes": "Synthetic call record, not scientific acceptance"}
        reviewed = self.mcp.call("figure_schematic", {"contract": declared})
        self.assertEqual(reviewed["human_review"], declared["human_review"])
        self.assertEqual(reviewed["diagram"]["review_status"], "user_record_present")
        self.assertEqual(reviewed["scientific_validation"], "not_performed")
        missing = contract("demo-missing-materials")
        missing["sources"] = []
        for item in missing["nodes"] + missing["relations"]:
            item["evidence"] = []
        partial = self.mcp.call("figure_schematic", {"contract": missing})
        self.assertTrue(any(w["code"] in ("MISSING_MATERIALS", "EVIDENCE_MISSING") for w in partial["warnings"]))
        malformed = contract("demo-invalid-shape")
        malformed["nodes"][0]["shape"] = "paper-perfect-official-answer"
        invalid = self.mcp.call("figure_schematic", {"contract": malformed}, succeed=False)
        self.assertIn("INVALID_SHAPE", invalid["error"])
        broken = copy.deepcopy(one["doc"])
        next(el for el in broken["elements"] if el["type"] == "connector")["relation"]["target"] = "missing-node"
        failed_path = Path(self.tmp.name) / "failed.pdf"
        failed = self.mcp.call("figure_export", {"doc": broken, "format": "pdf", "out_path": str(failed_path)}, succeed=False)
        self.assertIn("引用", failed["error"])
        self.assertFalse(failed_path.exists())

    def test_live_template_capability(self):
        templates = self.mcp.call("figure_templates", {"include_unsupported": True})["templates"]
        self.assertEqual(len(templates), 60)
        counts = collections.Counter(item["capability"] for item in templates)
        self.assertEqual(dict(counts), {"full": 27, "layout": 12, "unsupported": 21})
        supported = {item["id"] for item in templates if item["category"] == "diagram" and item["capability"] == "full"}
        self.assertEqual(supported, {"tpl-diagram-flow", "tpl-diagram-arch", "tpl-diagram-pipeline", "tpl-graphical-abstract"})
        self.assertFalse(any(item["category"] == "diagram" and item["auto_generate"] for item in templates))


if __name__ == "__main__":
    unittest.main()
