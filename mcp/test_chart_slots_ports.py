# -*- coding: utf-8 -*-
"""Synthetic chart-slot/layout/port regressions; isolated from current.figureproj."""
import copy
import io
import json
import math
import subprocess
import tempfile
import unittest
from pathlib import Path
from xml.etree import ElementTree

import fitz
from PIL import Image

from py import svg_export
from test_schematic_mcp import MCP

MCP_DIR = Path(__file__).resolve().parent
TABLE = {"columns": ["condition", "response"], "rows": [["A", 2], ["B", 5]]}


def slot_contract(identifier="slot-regression", count=1):
    nodes = [{"id": "q", "label": "Q", "role": "question", "shape": "box",
              "x": 5, "y": 5, "w": 20, "h": 12, "evidence": ["s"]}]
    for index in range(count):
        nodes.append({"id": "slot" if index == 0 else "slot-%d" % (index + 1),
                      "label": "DATA%d" % index, "role": "evidence",
                      "kind": "chart" if index == 0 else "entity",
                      "shape": "box" if index == 0 else "chart",
                      "x": 35 + 55 * index, "y": 5, "w": 46, "h": 44,
                      "evidence": ["s"]})
    return {
        "schema_version": "1.0", "id": identifier, "template": "flow",
        "nodes": nodes, "relations": [],
        "sources": [{"id": "s", "locator": "synthetic-chart-slot-only", "version": "v1",
                     "text": "Synthetic user data only; no paper or official case."}],
        "canvas": {"width_mm": 150, "height_mm": 70, "dpi": 96, "background": "#FFFFFF"},
        "layout": {"mode": "manual", "auto_layout": False},
    }


def element(doc, element_id):
    return next(item for item in doc["elements"] if item["id"] == element_id)


def node_json(script):
    proc = subprocess.run(["node", "-e", script], cwd=MCP_DIR, capture_output=True,
                          text=True, encoding="utf-8", errors="strict", timeout=60)
    if proc.returncode:
        raise AssertionError(proc.stdout + "\n" + proc.stderr)
    return json.loads(proc.stdout.strip().splitlines()[-1])


class ChartSlotAndLayoutTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mcp = MCP()

    @classmethod
    def tearDownClass(cls):
        cls.mcp.close()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="figure-slot-layout-")
        self.out = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def create_in_slot(self, doc, scene=None, node=None):
        args = {"doc": doc, "template_id": "tpl-bar", "data": {"inline": copy.deepcopy(TABLE)}}
        if scene is not None:
            args["scene_id"] = scene
        if node is not None:
            args["node_id"] = node
        return self.mcp.call("figure_create_chart", args)

    def test_unique_explicit_slot_binding_and_real_svg_png_pdf(self):
        contract = slot_contract()
        before = self.mcp.call("figure_schematic", {"contract": contract, "preview": True})
        self.assertFalse(any(el.get("diagram_part") == "chart_slot" and el["id"] == "q.slot"
                             for el in before["doc"]["elements"]))
        self.assertIn("DATA0", before["svg"])
        made = self.create_in_slot(before["doc"])
        binding = made["slot_binding"]
        self.assertEqual(binding["chart_element_id"], "diagram-slot-regression:slot:slot:chart")
        chart = element(made["doc"], binding["chart_element_id"])
        slot = element(made["doc"], binding["slot_element_id"])
        self.assertEqual(chart["parent_id"], "slot")
        self.assertEqual(chart["transform"], slot["transform"])
        self.assertEqual(chart["chart"]["data"]["inline"], TABLE)
        self.assertEqual(chart["style"], {})
        self.assertEqual(chart["chart"]["mapping"]["x"], "condition")
        self.assertEqual(chart["chart"]["mapping"]["y"], "response")
        self.assertFalse(any(el["type"] == "panel" for el in made["doc"]["elements"]))
        self.assertNotIn("pathData", chart)
        svg = self.mcp.call("figure_render", {"doc": made["doc"], "format": "svg"})["svg"]
        root = ElementTree.fromstring(svg)
        chart_group = next(item for item in root.iter()
                           if item.get("data-fig-id") == binding["chart_element_id"])
        self.assertGreater(len(list(chart_group.iter())), 8)
        self.assertTrue(any(item.tag.endswith("rect") for item in chart_group.iter()))
        self.assertFalse(any(item.get("class") == "fig-connector-path" for item in chart_group.iter()))
        chart_text = "".join(chart_group.itertext())
        self.assertIn("A", chart_text)
        self.assertIn("B", chart_text)
        for fmt in ("png", "pdf"):
            path = self.out / ("contained-slot." + fmt)
            self.mcp.call("figure_export", {"doc": made["doc"], "format": fmt,
                                            "dpi": 96, "out_path": str(path)})
            self.assertGreater(path.stat().st_size, 500)
            if fmt == "png":
                with Image.open(path) as image:
                    image.load()
                    self.assertEqual(image.size, (567, 265))
                    t = slot["transform"]
                    crop = image.crop((math.floor(t["x"] * 96 / 25.4) + 5,
                                       math.floor(t["y"] * 96 / 25.4) + 5,
                                       math.ceil((t["x"] + t["w"]) * 96 / 25.4) - 5,
                                       math.ceil((t["y"] + t["h"]) * 96 / 25.4) - 5)).convert("RGB")
                    self.assertGreater(len(set(crop.getdata())), 10)
            else:
                with fitz.open(path) as pdf:
                    self.assertEqual(pdf.page_count, 1)
                    page = pdf[0]
                    self.assertEqual(page.get_images(full=True), [])
                    text = " ".join(page.get_text().split())
                    for value in ("Q", "DATA0", "A", "B"):
                        self.assertIn(value, text)
                    self.assertGreater(len(page.get_drawings()), 8)

    def test_multiple_slots_require_scene_and_node_without_mutation(self):
        contract = slot_contract("multi-slot-regression", count=2)
        before = self.mcp.call("figure_schematic", {"contract": contract})
        denied = self.mcp.call("figure_create_chart", {
            "doc": before["doc"], "template_id": "tpl-bar", "data": {"inline": TABLE}}, succeed=False)
        self.assertFalse(denied["ok"])
        self.assertIn("CHART_SLOT_AMBIGUOUS", denied["error"])
        scene_only = self.mcp.call("figure_create_chart", {
            "doc": before["doc"], "template_id": "tpl-bar", "data": {"inline": TABLE},
            "scene_id": contract["id"]}, succeed=False)
        self.assertIn("scene_id 与 node_id", scene_only["error"])
        explicit = self.create_in_slot(before["doc"], contract["id"], "slot-2")
        self.assertEqual(explicit["slot_binding"]["node_id"], "slot-2")
        self.assertEqual(element(explicit["doc"], "diagram-multi-slot-regression:slot:slot-2:chart")["parent_id"],
                         "slot-2")
        self.assertFalse(any(el.get("diagram_slot_id") == "slot" for el in explicit["doc"]["elements"]))
        bad_role = copy.deepcopy(contract)
        bad_role["nodes"][0]["role"] = "club"
        rejected = self.mcp.call("figure_schematic", {"doc": explicit["doc"], "contract": bad_role}, succeed=False)
        self.assertIn("INVALID_ROLE", rejected["error"])
        normalized_field_only = copy.deepcopy(contract)
        normalized_field_only["nodes"][0]["data_slot"] = {"type": "chart"}
        rejected = self.mcp.call("figure_schematic", {"contract": normalized_field_only}, succeed=False)
        self.assertIn("INVALID_CHART_SLOT", rejected["error"])

    def test_rebuild_auto_layout_and_rebind_keep_owned_and_user_content(self):
        contract = slot_contract("slot-rebuild-regression")
        before = self.mcp.call("figure_schematic", {"contract": contract})
        made = self.create_in_slot(before["doc"])
        chart_id = made["slot_binding"]["chart_element_id"]
        original_chart = copy.deepcopy(element(made["doc"], chart_id)["chart"])
        custom = {
            "id": "slot-user-note", "name": "user note", "type": "text",
            "transform": {"x": 50, "y": 20, "w": 12, "h": 5, "rotation": 0},
            "z": 90, "parent_id": "slot", "visible": True, "locked": False,
            "style": {"fill": "#123456", "fontSizePt": 6}, "text": "USER",
            "diagram_id": contract["id"], "diagramId": contract["id"],
            "diagramNodeId": "slot", "diagram_part": "slot_user_content",
            "diagram_slot_id": "slot", "source_claim": "user_provided_unverified",
        }
        added = self.mcp.call("figure_apply_edits", {"doc": made["doc"], "ops": [
            {"op": "add_element", "element": custom}]})
        changed = copy.deepcopy(contract)
        changed["sources"][0]["note"] = "same slot rebuild"
        for node in changed["nodes"]:
            if node["id"] == "slot":
                del node["x"], node["y"]
        changed["layout"]["auto_layout"] = True
        rebuilt = self.mcp.call("figure_schematic", {"doc": added["doc"], "contract": changed, "preview": True})
        chart = element(rebuilt["doc"], chart_id)
        self.assertEqual(chart["chart"], original_chart)
        self.assertEqual(element(rebuilt["doc"], "slot-user-note")["text"], "USER")
        self.assertEqual(chart["transform"], element(rebuilt["doc"], "slot.slot")["transform"])
        self.assertNotEqual(chart["transform"]["x"], made["slot_binding"]["transform"]["x"])
        resolution = rebuilt["diagram"]["layout"]["resolution"]
        self.assertTrue(resolution["auto_layout"])
        self.assertEqual(resolution["previous_placements"]["slot"]["x"], 35)
        self.assertEqual(resolution["position_basis"]["slot"], "auto_layout")
        history = rebuilt["doc"]["history"][-1]["ops"][0]["materialized_schematic"]
        materialized_ids = {item["id"] for item in history["elements"]}
        self.assertTrue({chart_id, "slot-user-note"}.issubset(materialized_ids))
        rebound = self.mcp.call("figure_create_chart", {
            "doc": rebuilt["doc"], "template_id": "tpl-bar", "data": {"inline": TABLE},
            "scene_id": contract["id"], "node_id": "slot"})
        self.assertEqual(rebound["slot_binding"]["chart_element_id"], chart_id)
        self.assertEqual(rebound["slot_binding"]["replaces_owned_chart_id"], chart_id)
        self.assertEqual(element(rebound["doc"], "slot-user-note")["text"], "USER")
        deleting_ops = [op for op in rebound["doc"]["history"][-1]["ops"] if op["op"] == "delete"]
        self.assertEqual(deleting_ops, [{"op": "delete", "targets": [chart_id]}])
        self.assertIn(chart_id, self.mcp.call(
            "figure_render", {"doc": rebound["doc"], "format": "svg"})["svg"])

    def test_legacy_cover_has_stable_collision_area_and_actionable_rebind(self):
        empty = self.mcp.call("figure_create", {"width_mm": 150, "height_mm": 70, "dpi": 96})
        legacy = self.mcp.call("figure_create_chart", {
            "doc": empty["doc"], "template_id": "tpl-bar", "data": {"inline": TABLE},
            "transform": {"x": 5, "y": 5, "w": 140, "h": 55}})
        contract = slot_contract("legacy-occlusion-regression")
        merged = self.mcp.call("figure_schematic", {"doc": legacy["doc"], "contract": contract})
        collisions = [w for w in merged["diagram"]["layout_audit"]["warnings"]
                      if w["code"] == "DIAGRAM_CONTENT_OCCLUSION"]
        self.assertTrue(collisions)
        self.assertEqual(len({w["element_id"] for w in collisions}), 1)
        for warning in collisions:
            self.assertTrue(warning["id"].startswith("layout-collision-"))
            self.assertGreater(warning["collision_area"]["area_mm2"], 0)
            self.assertEqual(warning["improvement"]["scene_id"], contract["id"])
            self.assertEqual(warning["improvement"]["node_id"], "slot")
        self.assertEqual(merged["diagram"]["status"], "partial")
        owner = collisions[0]["element_id"]
        cleared = self.mcp.call("figure_apply_edits", {
            "doc": merged["doc"], "ops": [{"op": "delete", "targets": [owner]}]})
        improved = self.create_in_slot(cleared["doc"], contract["id"], "slot")
        self.assertFalse(any(w["code"] == "DIAGRAM_CONTENT_OCCLUSION"
                             for w in improved["layout_audit"]["warnings"]))
        checked = self.mcp.call("figure_check", {"doc": improved["doc"]}, succeed=False)
        self.assertIn("layout_audit", checked)
        self.assertFalse(any(w.get("code") == "DIAGRAM_CONTENT_OCCLUSION"
                             for w in checked["warnings"] if isinstance(w, dict)))


class PortGeometryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        script = r"""
for (const name of ['figdoc','diagram','render']) require('./lib/' + name + '.js');
const spec = {
  id:'fan-ports', nodes:[
    {id:'b',label:'B',role:'method',x:10,y:45,w:10,h:10,evidence:['s']},
    {id:'a',label:'A',role:'method',x:30,y:45,w:10,h:10,evidence:['s']},
    {id:'hub',label:'HUB',role:'conclusion',x:80,y:40,w:30,h:20,evidence:['s']},
    {id:'out',label:'OUT',role:'conclusion',shape:'outcome',x:140,y:45,w:20,h:10,evidence:['s']}
  ], relations:[
    {id:'r-b-reverse-inhibit',source:'b',target:'hub',kind:'inhibit',direction:'reverse',bend:3,evidence:['s']},
    {id:'r-a-both-activate',source:'a',target:'hub',kind:'activate',direction:'both',evidence:['s']},
    {id:'r-out',source:'hub',target:'out',kind:'sequence',direction:'forward',evidence:['s']}
  ], sources:[{id:'s',locator:'synthetic-fan-ports-only'}],
  canvas:{width_mm:180,height_mm:100,dpi:96},layout:{mode:'manual'}
};
const doc = FigDiagram.build(null,spec).doc;
const shuffled = JSON.parse(JSON.stringify(spec)); shuffled.relations.reverse();
const other = FigDiagram.build(null,shuffled).doc;
function bySuffix(doc,suffix) { return doc.elements.find(el=>el.type==='connector'&&el.id.endsWith(suffix)); }
function geometry(doc,suffix) { return FigDiagram.connectorGeometry(doc,bySuffix(doc,suffix)); }
const names = [':r-b-reverse-inhibit',':r-a-both-activate',':r-out'];
console.log(JSON.stringify({doc,svg:FigRender.toSVG(doc),
  geometry:Object.fromEntries(names.map(name=>[name,geometry(doc,name)])),
  shuffled:Object.fromEntries(names.map(name=>[name,geometry(other,name)]))}));
"""
        cls.result = node_json(script)

    def test_sorted_fan_in_ports_directions_bend_and_stable_rebuild(self):
        result = self.result
        both = result["geometry"][":r-a-both-activate"]
        reverse = result["geometry"][":r-b-reverse-inhibit"]
        outgoing = result["geometry"][":r-out"]
        self.assertEqual([both["target_port"]["fraction"], reverse["target_port"]["fraction"]], [0.25, 0.75])
        self.assertEqual(both["target_port"]["point"]["x"], 80)
        self.assertEqual(both["target_port"]["point"]["y"], 45)
        self.assertEqual(reverse["target_port"]["point"]["y"], 55)
        self.assertNotEqual(both["target_port"]["id"], reverse["target_port"]["id"])
        self.assertEqual(both["target_port"]["connector_ids"],
                         ["diagram-fan-ports:relation:r-a-both-activate",
                          "diagram-fan-ports:relation:r-b-reverse-inhibit"])
        self.assertEqual(both["source"], "a")
        self.assertEqual(both["target"], "hub")
        self.assertEqual(reverse["source"], "b")
        self.assertEqual(reverse["target"], "hub")
        self.assertEqual(both["arrow"], {"start": True, "end": True})
        self.assertEqual(reverse["arrow"], {"start": True, "end": False})
        self.assertEqual(reverse["path_type"], "quadratic")
        self.assertEqual(outgoing["source_port"]["fraction"], 0.5)
        for name, geometry in result["geometry"].items():
            self.assertEqual(geometry, result["shuffled"][name])
            self.assertEqual(geometry["start"], geometry["points"][0])
            self.assertEqual(geometry["end"], geometry["points"][-1])
            self.assertTrue(all(math.isfinite(point[axis]) for point in geometry["points"]
                                for axis in ("x", "y")))
        root = ElementTree.fromstring(result["svg"])
        groups = {item.get("data-relation-direction"): item for item in root.iter()
                  if item.get("class", "").startswith("fig-connector fig-relation-")}
        self.assertEqual(sum(1 for item in groups["both"] if item.get("class") == "fig-connector-head"), 2)
        self.assertIn(" Q", next(item for item in groups["reverse"]
                                 if item.get("class") == "fig-connector-path").get("d"))
        self.assertTrue(any(item.get("class") == "fig-connector-tbar" for item in groups["reverse"]))

    def test_real_port_svg_png_and_vector_pdf(self):
        with tempfile.TemporaryDirectory(prefix="figure-fan-ports-") as temporary:
            for fmt in ("png", "pdf"):
                path = Path(temporary) / ("ports." + fmt)
                svg_export.export_svg(self.result["svg"], self.result["doc"], str(path), fmt, dpi=96)
                self.assertGreater(path.stat().st_size, 500)
                if fmt == "png":
                    with Image.open(path) as image:
                        image.verify()
                else:
                    with fitz.open(path) as pdf:
                        self.assertEqual(pdf.page_count, 1)
                        self.assertEqual(pdf[0].get_images(full=True), [])
                        drawings = pdf[0].get_drawings()
                        self.assertGreater(len(drawings), 10)
                        numbers = [coordinate for drawing in drawings for item in drawing["items"]
                                   for value in item[1:] if hasattr(value, "x")
                                   for coordinate in (value.x, value.y)]
                        self.assertTrue(all(math.isfinite(value) for value in numbers))


class DiagramButtonCommitTests(unittest.TestCase):
    def test_button_commit_all_roles_collisions_and_club_rejection(self):
        contract = slot_contract("gui-extreme-regression")
        contract["nodes"].extend([
            {"id": "method", "label": "METHOD", "role": "method", "shape": "process",
             "x": 5, "y": 5, "w": 20, "h": 12, "evidence": ["s"]},
            {"id": "conclusion", "label": "END", "role": "conclusion", "shape": "outcome",
             "x": 105, "y": 5, "w": 20, "h": 12, "evidence": ["s"]},
        ])
        script = r"""
const assert = require('assert'), fs = require('fs'), vm = require('vm');
class Element {
  constructor(tag) { this.tagName=tag.toUpperCase(); this.nodeType=1; this.children=[]; this.attributes={}; this.style={}; this.listeners={}; this.value=''; this.checked=false; this._text=''; }
  appendChild(c) { this.children.push(c); c.parentNode=this; return c; }
  get firstChild() { return this.children[0]||null; }
  set textContent(v) { this._text=String(v); this.children=[]; }
  get textContent() { return this._text+this.children.map(c=>c.textContent).join(''); }
  setAttribute(k,v) { this.attributes[k]=String(v); if(k==='value')this.value=String(v); if(k==='id')this.id=String(v); }
  addEventListener(k,f) { (this.listeners[k]||(this.listeners[k]=[])).push(f); }
  click() { (this.listeners.click||[]).forEach(f=>f.call(this,{})); }
  querySelector(selector) { const wanted=selector.startsWith('#')?selector.slice(1):null; const tag=!wanted?selector.toUpperCase():null; let found=null;
    function visit(n) { if(found)return; if(wanted&&n.id===wanted){found=n;return;} if(tag&&n.tagName===tag){found=n;return;} n.children.forEach(visit); } visit(this); return found; }
  querySelectorAll(selector) { const tags=selector.split(',').map(s=>s.trim().toUpperCase()),out=[];
    function visit(n) { if(tags.includes(n.tagName))out.push(n); n.children.forEach(visit); } visit(this); return out; }
  set innerHTML(v) { this._html=String(v); this.children=v?[new Element('svg')]:[]; if(v)this._svg=this.children[0]; }
  get innerHTML() { return this._html||''; }
}
const document={createElement:tag=>new Element(tag),createTextNode:text=>{const n=new Element('#text');n.textContent=text;return n;}};
const sandbox={console,document,setTimeout,clearTimeout}; vm.createContext(sandbox);
for(const name of ['figdoc','diagram','ops','render'])vm.runInContext(fs.readFileSync('lib/'+name+'.js','utf8'),sandbox);
const App=sandbox.App={doc:sandbox.FigDoc.create(),commits:[],selections:[],messages:[],
  commit(ops,meta){this.commits.push({ops,meta});const result=sandbox.FigOps.applyAll(this.doc,ops,meta);this.doc=result.doc;return Promise.resolve(result);},
  select(ids){this.selections.push(ids);},status(v){this.messages.push(v);},error(v){throw new Error(v);}};
vm.runInContext(fs.readFileSync('viewer_static/app/diagram-panel.js','utf8'),sandbox);
const panel=new Element('div'); sandbox.DiagramPanel.mount(panel);
const spec=CONTRACT; sandbox.DiagramPanel.loadSpec(spec,spec.id);
assert(panel.querySelectorAll('option').some(o=>o.attributes.value==='chart'));
panel.querySelector('#diagram-add-relation').click();
(async()=>{
  const committed=await sandbox.DiagramPanel.commit();
  assert.strictEqual(committed.applied,1); assert.strictEqual(App.commits.length,1);
  assert(App.doc.elements.some(el=>el.diagram_part==='chart_slot'&&el.id==='slot.slot'));
  assert(!App.doc.elements.some(el=>el.slot_generated_chart===true));
  const meta=App.doc.meta.diagrams[spec.id];
  assert(meta.layout_audit.warnings.some(w=>w.code==='NODE_OVERLAP'&&w.node_id==='q'&&w.other_node_id==='method'));
  assert.strictEqual(App.doc.elements.filter(el=>el.diagram_part==='node').map(el=>el.semantic_role).join(','),
    'question,evidence,method,conclusion');
  const invalid=JSON.parse(JSON.stringify(spec)); invalid.nodes[0].role='club';
  assert.throws(()=>sandbox.DiagramPanel.loadSpec(invalid,spec.id),/INVALID_ROLE/);
  assert.strictEqual(App.commits.length,1);
  console.log(JSON.stringify({ok:true,commits:App.commits.length,slot:App.doc.elements.find(el=>el.id==='slot.slot'),
    roles:App.doc.elements.filter(el=>el.diagram_part==='node').map(el=>el.semantic_role),visualAcceptance:'not_assessed'}));
})().catch(err=>{console.error(err);process.exitCode=1;});
""".replace("CONTRACT", json.dumps(contract, ensure_ascii=False))
        result = node_json(script)
        self.assertTrue(result["ok"])
        self.assertEqual(result["commits"], 1)
        self.assertEqual(result["slot"]["diagram_part"], "chart_slot")
        self.assertEqual(result["roles"], ["question", "evidence", "method", "conclusion"])
        self.assertEqual(result["visualAcceptance"], "not_assessed")


if __name__ == "__main__":
    unittest.main(verbosity=2)
