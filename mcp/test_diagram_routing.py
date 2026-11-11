# -*- coding: utf-8 -*-
"""Synthetic connector-routing and manual-layout regressions; no official cases."""
import copy
import json
import math
import re
import subprocess
import tempfile
import unittest
from pathlib import Path
from xml.etree import ElementTree

import fitz

from py import svg_export
from test_schematic_mcp import MCP

MCP_DIR = Path(__file__).resolve().parent
R3_ID = "diagram-ga-routing-regression:relation:r3"


def schematic_contract():
    return {
        "schema_version": "1.0",
        "id": "ga-routing-regression",
        "template": "graphical_abstract",
        "nodes": [
            {"id": "q", "label": "DEMO question", "role": "question", "shape": "box",
             "x": 5, "y": 25, "w": 20, "h": 12, "evidence": ["s"]},
            {"id": "m", "label": "DEMO method", "role": "method", "shape": "process",
             "x": 35, "y": 25, "w": 20, "h": 12, "evidence": ["s"]},
            {"id": "a", "label": "DEMO evidence A", "role": "evidence", "shape": "material",
             "x": 65, "y": 25, "w": 20, "h": 12, "evidence": ["s"]},
            {"id": "b", "label": "DEMO bounded conclusion", "role": "conclusion", "shape": "outcome",
             "x": 95, "y": 25, "w": 20, "h": 12, "evidence": ["s"]},
            {"id": "c", "label": "DEMO evidence C", "role": "evidence", "shape": "box",
             "x": 65, "y": 50, "w": 20, "h": 12, "evidence": ["s"]},
        ],
        "relations": [
            {"id": "r1", "source": "q", "target": "m", "kind": "sequence", "evidence": ["s"]},
            {"id": "r2", "source": "m", "target": "a", "kind": "sequence", "evidence": ["s"]},
            {"id": "r3", "source": "m", "target": "b", "kind": "activate", "evidence": ["s"]},
            {"id": "r4", "source": "a", "target": "c", "kind": "associate", "evidence": ["s"]},
        ],
        "sources": [{"id": "s", "locator": "synthetic-r3-regression-only", "version": "v1",
                     "text": "DEMO source text; not a published paper or an official case."}],
        "canvas": {"width_mm": 130, "height_mm": 80, "dpi": 96, "background": "#FFFFFF"},
        "layout": {"mode": "manual", "auto_layout": False},
    }


def element(doc, element_id):
    return next(item for item in doc["elements"] if item["id"] == element_id)


def relation_group(svg, relation_id=R3_ID):
    root = ElementTree.fromstring(svg)
    return next(item for item in root.iter() if item.get("data-fig-id") == relation_id)


def segment_through_box(a, b, box):
    epsilon = 0.001
    bounds = (box["x"] + epsilon, box["y"] + epsilon,
              box["x"] + box["w"] - epsilon, box["y"] + box["h"] - epsilon)
    if bounds[0] >= bounds[2] or bounds[1] >= bounds[3]:
        return False
    dx, dy = b[0] - a[0], b[1] - a[1]
    lo, hi = 0.0, 1.0
    for p, q in ((-dx, a[0] - bounds[0]), (dx, bounds[2] - a[0]),
                 (-dy, a[1] - bounds[1]), (dy, bounds[3] - a[1])):
        if abs(p) < 1e-12:
            if q < 0:
                return False
            continue
        ratio = q / p
        if p < 0:
            if ratio > hi:
                return False
            lo = max(lo, ratio)
        else:
            if ratio < lo:
                return False
            hi = min(hi, ratio)
    return hi - lo > 1e-9


class RoutingKernelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        script = r"""
const assert = require('assert');
for (const file of ['figdoc', 'diagram', 'ops', 'render']) require('./lib/' + file + '.js');
const spec = CONTRACT;
function apply(doc, op) {
  return FigOps.apply(doc, op, {ts:'2026-11-11T00:00:00.000Z'}).doc;
}
function connector(doc, suffix) {
  return doc.elements.find(el => el.type === 'connector' && el.id.endsWith(suffix));
}
function geometry(doc, suffix) { return FigDiagram.connectorGeometry(doc, connector(doc, suffix)); }
const initial = apply(FigDoc.create(), {op:'apply_schematic',contract:spec});
const moved = apply(initial, {op:'move',targets:['m'],dx:4,dy:2});
const repeated = apply(moved, {op:'apply_schematic',contract:spec});
const rebuilt = FigDiagram.build(moved, spec, {generated_at:'2026-11-11T00:00:00.000Z'}).doc;
assert.deepStrictEqual(moved.meta.diagrams[spec.id].sources, FigDiagram.normalize(spec).sources);
assert.strictEqual(moved.meta.diagrams[spec.id].sources[0].version, initial.meta.diagrams[spec.id].sources[0].version);
assert.strictEqual(moved.meta.diagrams[spec.id].sources[0].text, initial.meta.diagrams[spec.id].sources[0].text);
assert.strictEqual(moved.meta.diagrams[spec.id].source_sha256, initial.meta.diagrams[spec.id].source_sha256);
const explicitSpec = JSON.parse(JSON.stringify(spec));
explicitSpec.relations.find(rel => rel.id === 'r3').bend = 4;
const explicitDoc = FigDiagram.build(null, explicitSpec, {generated_at:'2026-11-11T00:00:00.000Z'}).doc;
const explicitGroup = FigRender.toSVG(explicitDoc).match(new RegExp('<g class="fig-connector[^>]*data-fig-id="' + connector(explicitDoc, ':r3').id + '"[\\s\\S]*?</g>'))[0];
const blockedSpec = {
  id:'unavoidable-route', nodes:[
    {id:'s',label:'S',role:'question',x:10,y:20,w:10,h:10,evidence:['s']},
    {id:'t',label:'T',role:'conclusion',x:40,y:20,w:10,h:10,evidence:['s']},
    {id:'blocker',label:'BLOCK',role:'evidence',x:0,y:0,w:60,h:50,evidence:['s']}
  ], relations:[{id:'r',source:'s',target:'t',kind:'sequence',evidence:['s']}],
  sources:[{id:'s',locator:'synthetic-unavoidable-route-only'}],
  canvas:{width_mm:60,height_mm:50},layout:{mode:'manual'}
};
const blockedDoc = FigDiagram.build(null, blockedSpec).doc;
const includedSpec = {
  id:'native-parent-frame', nodes:[
    {id:'p',label:'PARENT',role:'question',shape:'container',x:5,y:15,w:50,h:25,evidence:['s']},
    {id:'s',label:'S',role:'method',x:10,y:20,w:10,h:10,evidence:['s']},
    {id:'t',label:'T',role:'conclusion',x:35,y:20,w:15,h:10,evidence:['s']}
  ], relations:[
    {id:'ps',source:'p',target:'s',kind:'include',evidence:['s']},
    {id:'pt',source:'p',target:'t',kind:'include',evidence:['s']},
    {id:'r',source:'s',target:'t',kind:'sequence',evidence:['s']}
  ], sources:[{id:'s',locator:'synthetic-native-parent-only'}],
  canvas:{width_mm:60,height_mm:50},layout:{mode:'manual'}
};
const includedDoc = FigDiagram.build(null, includedSpec).doc;
const rotatedDoc = JSON.parse(JSON.stringify(includedDoc));
rotatedDoc.elements.find(el => el.id === 'diagram-native-parent-frame:root').transform.rotation = 30;
const result = {
  initial_canvas:initial.canvas,
  moved_svg:FigRender.toSVG(moved),
  moved_doc:moved,
  move_repeat_same:FigRender.toSVG(moved) === FigRender.toSVG(repeated),
  direct_rebuild_same:FigRender.toSVG(moved) === FigRender.toSVG(rebuilt),
  moved_geometry:geometry(moved, ':r3'),
  initial_geometry:geometry(initial, ':r3'),
  initial_warnings:initial.meta.diagrams[spec.id].layout_audit.warnings,
  no_path_data:[initial,moved,repeated,rebuilt].every(doc => doc.elements.filter(el => el.type === 'connector').every(el => el.pathData === undefined)),
  explicit_geometry:geometry(explicitDoc, ':r3'),
  explicit_group:explicitGroup,
  explicit_warnings:FigDiagram.auditLayout(explicitDoc).warnings,
  blocked_geometry:geometry(blockedDoc, ':r'),
  blocked_warnings:FigDiagram.auditLayout(blockedDoc).warnings,
  included_geometry:geometry(includedDoc, ':r'),
  rotated_geometry:geometry(rotatedDoc, ':r'),
  included_warnings:FigDiagram.auditLayout(includedDoc).warnings,
  rotated_warnings:FigDiagram.auditLayout(rotatedDoc).warnings,
  included_connectors:includedDoc.elements.filter(el => el.type === 'connector').map(el => el.id),
  included_parents:includedDoc.elements.filter(el => el.diagram_part === 'node').map(el => ({id:el.id,parent_id:el.parent_id}))
};
console.log(JSON.stringify(result));
""".replace("CONTRACT", json.dumps(schematic_contract(), ensure_ascii=False))
        proc = subprocess.run(["node", "-e", script], cwd=MCP_DIR, capture_output=True,
                              text=True, encoding="utf-8", errors="strict", timeout=60)
        if proc.returncode:
            raise AssertionError(proc.stdout + "\n" + proc.stderr)
        cls.result = json.loads(proc.stdout.strip().splitlines()[-1])

    def test_dynamic_route_uses_current_document_and_same_branch_as_renderer(self):
        result = self.result
        self.assertEqual(result["initial_canvas"]["width_mm"], 130)
        self.assertEqual(result["initial_canvas"]["height_mm"], 80)
        self.assertEqual(result["initial_warnings"], [])
        self.assertTrue(result["move_repeat_same"])
        self.assertTrue(result["direct_rebuild_same"])
        self.assertTrue(result["no_path_data"])
        geometry = result["moved_geometry"]
        self.assertEqual(geometry["path_type"], "orthogonal")
        self.assertTrue(geometry["route_resolved"])
        self.assertEqual(geometry["sourceBox"]["x"], 39)
        self.assertEqual(geometry["start"], geometry["points"][0])
        self.assertEqual(geometry["end"], geometry["points"][-1])
        self.assertNotEqual(geometry["middle"], {"x": 0, "y": 0})
        self.assertGreaterEqual(len(geometry["points"]), 3)
        for a, b in zip(geometry["points"], geometry["points"][1:]):
            self.assertTrue(math.isclose(a["x"], b["x"], abs_tol=1e-8) or
                            math.isclose(a["y"], b["y"], abs_tol=1e-8))
        doc = result["moved_doc"]
        for a, b in zip(geometry["points"], geometry["points"][1:]):
            for node_id in ("q", "a", "c"):
                self.assertFalse(segment_through_box((a["x"], a["y"]), (b["x"], b["y"]),
                                                     element(doc, node_id)["transform"]), node_id)
        group = relation_group(result["moved_svg"])
        path = next(item for item in group if item.get("class") == "fig-connector-path")
        numbers = [float(value) for value in re.findall(r"-?(?:\d+\.?\d*|\.\d+)", path.get("d"))]
        rendered = list(zip(numbers[::2], numbers[1::2]))
        self.assertEqual(len(rendered), len(geometry["points"]))
        for actual, expected in zip(rendered, geometry["points"]):
            self.assertAlmostEqual(actual[0], expected["x"], places=3)
            self.assertAlmostEqual(actual[1], expected["y"], places=3)
        head = next(item for item in group if item.get("class") == "fig-connector-head")
        self.assertTrue(head.get("d").startswith("M%s %s L" % (
            format(geometry["end"]["x"], "g"), format(geometry["end"]["y"], "g"))))

    def test_explicit_bend_unavoidable_warning_and_native_parent_frames(self):
        explicit = self.result["explicit_geometry"]
        self.assertEqual(explicit["path_type"], "quadratic")
        self.assertIn(" Q", self.result["explicit_group"])
        self.assertTrue(any(w["code"] == "CONNECTOR_THROUGH_NODE" and w["node_id"] == "a"
                            for w in self.result["explicit_warnings"]))
        blocked = self.result["blocked_geometry"]
        self.assertFalse(blocked["route_resolved"])
        self.assertEqual(blocked["path_type"], "straight")
        self.assertTrue(any(w["code"] == "CONNECTOR_THROUGH_NODE" and w["node_id"] == "blocker"
                            for w in self.result["blocked_warnings"]))
        self.assertEqual(self.result["included_connectors"], ["diagram-native-parent-frame:relation:r"])
        self.assertEqual(self.result["included_geometry"]["path_type"], "straight")
        parents = {entry["id"]: entry["parent_id"] for entry in self.result["included_parents"]}
        self.assertEqual(parents["s"], "p")
        self.assertEqual(parents["t"], "p")
        self.assertFalse([w for w in self.result["included_warnings"]
                          if w["code"] in ("DANGLING_RELATION", "DIRECTION_KIND_CONFLICT",
                                           "CONNECTOR_THROUGH_NODE", "NODE_OVERLAP")])
        rotated = self.result["rotated_geometry"]
        self.assertTrue(all(math.isfinite(point[axis]) for point in rotated["points"] for axis in ("x", "y")))
        self.assertNotEqual(rotated["middle"], {"x": 0, "y": 0})
        self.assertFalse(any(w["code"] == "CONNECTOR_THROUGH_NODE" for w in self.result["rotated_warnings"]))

    def test_real_svg_pymupdf_glyphs_lines_and_independent_intersection(self):
        result = self.result
        doc = result["moved_doc"]
        group = relation_group(result["moved_svg"])
        path = next(item for item in group if item.get("class") == "fig-connector-path")
        values = [float(value) for value in re.findall(r"-?(?:\d+\.?\d*|\.\d+)", path.get("d"))]
        points = list(zip(values[::2], values[1::2]))
        m, b, a = (element(doc, node_id)["transform"] for node_id in ("m", "b", "a"))
        old_line = ((m["x"] + m["w"], m["y"] + m["h"] / 2), (b["x"], b["y"] + b["h"] / 2))
        self.assertTrue(segment_through_box(*old_line, a), "fixture must reproduce the old r3 crossing")
        for start, end in zip(points, points[1:]):
            self.assertFalse(segment_through_box(start, end, a))
            self.assertFalse(segment_through_box(start, end, element(doc, "q")["transform"]))
            self.assertFalse(segment_through_box(start, end, element(doc, "c")["transform"]))
        with tempfile.TemporaryDirectory(prefix="figure-routing-pdf-") as temporary:
            output = Path(temporary) / "r3-routed.pdf"
            svg_export.export_svg(result["moved_svg"], doc, str(output), "pdf", dpi=144)
            with fitz.open(output) as pdf:
                self.assertEqual(pdf.page_count, 1)
                page = pdf[0]
                text = " ".join(page.get_text().split())
                for glyph in ("DEMO", "question", "method", "evidence A", "bounded conclusion", "evidence C"):
                    self.assertIn(glyph, text)
                self.assertEqual(page.get_images(full=True), [])
                scale = 72 / 25.4
                expected_segments = [(fitz.Point(start[0] * scale, start[1] * scale),
                                      fitz.Point(end[0] * scale, end[1] * scale))
                                     for start, end in zip(points, points[1:])]
                actual_segments = [(item[1], item[2]) for drawing in page.get_drawings()
                                   for item in drawing["items"] if item[0] == "l"]
                for expected in expected_segments:
                    self.assertTrue(any(abs(actual[0].x - expected[0].x) < 0.02 and
                                         abs(actual[0].y - expected[0].y) < 0.02 and
                                         abs(actual[1].x - expected[1].x) < 0.02 and
                                         abs(actual[1].y - expected[1].y) < 0.02
                                         for actual in actual_segments), expected)


class RealMCPRepeatTests(unittest.TestCase):
    def setUp(self):
        self.mcp = MCP()
        self.temporary = tempfile.TemporaryDirectory(prefix="figure-routing-mcp-")

    def tearDown(self):
        self.mcp.close()
        self.temporary.cleanup()

    def test_save_before_move_repeat_and_explicit_auto_layout(self):
        contract = schematic_contract()
        before = self.mcp.call("figure_schematic", {"contract": copy.deepcopy(contract), "preview": True})
        repeated = self.mcp.call("figure_schematic", {
            "doc": before["doc"], "contract": copy.deepcopy(contract), "preview": True})
        self.assertEqual(before["svg"], repeated["svg"])
        moved = self.mcp.call("figure_apply_edits", {"doc": repeated["doc"], "ops": [
            {"op": "move", "targets": ["m"], "dx": 4, "dy": 2}]})
        after_move = self.mcp.call("figure_render", {"doc": moved["doc"], "format": "svg"})["svg"]
        self.assertNotEqual(after_move, repeated["svg"])
        self.assertEqual(element(moved["doc"], "m")["transform"]["x"], 39)
        self.assertEqual(element(moved["doc"], "m")["transform"]["y"], 27)
        self.assertEqual(element(moved["doc"], "m")["declared_transform"],
                         element(moved["doc"], "m")["transform"])
        self.assertEqual(moved["doc"]["meta"]["diagrams"][contract["id"]]["layout_overrides"]["m"],
                         element(moved["doc"], "m")["transform"])
        after_repeat = self.mcp.call("figure_schematic", {
            "doc": moved["doc"], "contract": copy.deepcopy(contract), "preview": True})
        self.assertEqual(after_repeat["svg"], after_move)
        self.assertEqual(after_repeat["svg"], self.mcp.call(
            "figure_render", {"doc": after_repeat["doc"], "format": "svg"})["svg"])
        for name, svg in (("01_before.svg", before["svg"]), ("02_after_move.svg", after_move),
                          ("03_after_same_schematic.svg", after_repeat["svg"])):
            path = Path(self.temporary.name) / name
            path.write_text(svg, encoding="utf-8")
            self.assertGreater(path.stat().st_size, 100)
        self.assertFalse(any(w.get("code") == "CONNECTOR_THROUGH_NODE" and
                             w.get("connector_id", "").endswith(":r3")
                             for w in after_repeat["warnings"]))
        self.assertEqual(after_repeat["diagram"]["sources"], before["diagram"]["sources"])
        automatic_contract = copy.deepcopy(contract)
        automatic_contract["layout"]["auto_layout"] = True
        automatic = self.mcp.call("figure_schematic", {
            "doc": after_repeat["doc"], "contract": automatic_contract, "preview": True})
        self.assertEqual((element(automatic["doc"], "m")["transform"]["x"],
                          element(automatic["doc"], "m")["transform"]["y"]), (35, 25))
        self.assertNotEqual(automatic["svg"], after_repeat["svg"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
