# -*- coding: utf-8 -*-
"""Synthetic layout/audit tests; no official project, network, or human verdict."""
import io
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from xml.etree import ElementTree

import fitz
from PIL import Image

from py import svg_export

MCP_DIR = Path(__file__).resolve().parent
LONG_CJK = "超长中文源实体关系连接节点完整名称必须原样保留并自动换行用于布局验证"
SCIENTIFIC_NAME = "Escherichia_coli_strain_K-12_substr_MG1655_record_identifier_1234567890"
CHEMICAL_ID = "C102H151N31O39"


def kernel_output():
    script = r"""
const assert = require('assert');
for (const file of ['figdoc', 'diagram', 'render']) require('./lib/' + file + '.js');
const labels = [
  '超长中文源实体关系连接节点完整名称必须原样保留并自动换行用于布局验证',
  'Escherichia_coli_strain_K-12_substr_MG1655_record_identifier_1234567890',
  'C102H151N31O39',
  'International_union_pure_applied_chemistry_entity_identifier_9876543210',
  '实体五', '实体六', '实体七', '实体八', '实体九'
];
const spec = {id:'synthetic-layout', nodes:labels.map((label, i) => ({
  id:'node-' + i, label, role:'method', evidence:['provided']
})), relations:[], sources:[{id:'provided',locator:'synthetic-layout-only'}]};
const originalSpec = JSON.parse(JSON.stringify(spec));
const empty = FigDoc.create();
const originalEmpty = JSON.stringify(empty);
const first = FigDiagram.build(empty, spec, {generated_at:'2026-11-11T00:00:00.000Z'});
assert.deepStrictEqual(spec, originalSpec);
assert.strictEqual(JSON.stringify(empty), originalEmpty);
const doc = first.doc;
const svg = FigRender.toSVG(doc);
assert.strictEqual(svg, FigRender.toSVG(doc));
assert.deepStrictEqual(FigDiagram.auditLayout(doc), FigDiagram.auditLayout(doc));
const rebuiltA = FigDiagram.build(doc, spec, {generated_at:'2026-11-11T00:00:00.000Z'});
const rebuiltB = FigDiagram.build(doc, spec, {generated_at:'2026-11-11T00:00:00.000Z'});
assert.strictEqual(FigRender.toSVG(rebuiltA.doc), FigRender.toSVG(rebuiltB.doc));
assert.deepStrictEqual(rebuiltA.doc.meta.diagrams[spec.id].warnings,
  rebuiltB.doc.meta.diagrams[spec.id].warnings);
assert.deepStrictEqual(rebuiltA.doc.meta.diagrams[spec.id].layout_audit,
  rebuiltB.doc.meta.diagrams[spec.id].layout_audit);
const manualSpec = {id:'synthetic-manual',nodes:[
  {id:'a',label:'A',role:'question',x:4,y:43,w:29,h:17,evidence:['s']},
  {id:'b',label:'B',role:'conclusion',x:80,y:8,w:25,h:16,evidence:['s']}
],relations:[{id:'r',source:'a',target:'b',kind:'sequence',evidence:['s']}],
sources:[{id:'s',locator:'synthetic-manual-only'}],layout:{mode:'manual'}};
const manualInitial = FigDiagram.build(null,manualSpec,{generated_at:'2026-11-11T00:00:00.000Z'}).doc;
const manualNode = manualInitial.elements.find(el => el.id === 'a');
manualNode.diagram_manual_layout = true;
const manualA = FigDiagram.build(manualInitial,manualSpec,{generated_at:'2026-11-11T00:00:00.000Z'});
assert.deepStrictEqual(manualA.doc.elements.find(el => el.id === 'a').transform, manualNode.transform);
const crossingSpec = {id:'synthetic-crossing',nodes:[
  {id:'a',label:'A',role:'question',x:10,y:20,w:15,h:10,evidence:['s']},
  {id:'b',label:'B',role:'conclusion',x:50,y:20,w:15,h:10,evidence:['s']},
  {id:'other',label:'Other',role:'method',x:32.5,y:20,w:15,h:10,evidence:['s']}
],relations:[{id:'r',source:'a',target:'b',kind:'sequence',bend:4,evidence:['s']}],
sources:[{id:'s',locator:'synthetic-crossing-only'}],canvas:{width_mm:80,height_mm:60},layout:{mode:'manual'}};
const crossingDoc = FigDiagram.build(null,crossingSpec,{generated_at:'2026-11-11T00:00:00.000Z'}).doc;
const dangling = JSON.parse(JSON.stringify(crossingDoc));
dangling.elements.find(el => el.type === 'connector').relation.target = 'missing-node';
const paneled = JSON.parse(JSON.stringify(crossingDoc));
paneled.elements.push({id:'layout-panel',type:'panel',transform:{x:0,y:0,w:45,h:45,rotation:0},
  z:-10,parent_id:null,children:['diagram-synthetic-crossing:root'],visible:true,style:{},panelLayout:{padding_mm:2}});
paneled.elements.find(el => el.id === 'diagram-synthetic-crossing:root').parent_id = 'layout-panel';
const panelAudit = FigDiagram.auditLayout(paneled);
assert(panelAudit.warnings.some(w => w.code === 'NODE_OUTSIDE_PANEL' && w.node_id === 'b' && w.panel_id === 'layout-panel'));
assert(!panelAudit.warnings.some(w => w.code === 'NODE_OUTSIDE_PANEL' && w.node_id === 'a'));
const overflowSpec = {id:'synthetic-overflow',nodes:[{
  id:'exact-constrained-node',label:labels[0],role:'method',x:110,y:2,w:4,h:4,evidence:['s']
}],relations:[],sources:[{id:'s',locator:'synthetic-overflow-only'}],layout:{mode:'manual'}};
const overflowDoc = FigDiagram.build(null,overflowSpec,{generated_at:'2026-11-11T00:00:00.000Z'}).doc;
const nodeOverflow = Array.from({length:257}, (_,i) => ({id:'n'+i,label:'n',role:'method'}));
const limitResults = {
  nodes:FigDiagram.validate({id:'too-many',nodes:nodeOverflow,relations:[]}).ok,
  label:FigDiagram.validate({id:'too-long',nodes:[{id:'n',label:'X'.repeat(2049),role:'method'}]}).ok,
  unsafe:FigDiagram.validate({id:'unsafe',nodes:[{id:'n',label:'<img src=x onerror=alert(1)>',role:'method'}]}).ok
};
assert(FigDoc.validate(doc).ok, FigDoc.validate(doc).errors.join(';'));
console.log(JSON.stringify({doc,svg,repeated_svg:svg,
  warning_metadata_a:rebuiltA.doc.meta.diagrams[spec.id].warnings,
  warning_metadata_b:rebuiltB.doc.meta.diagrams[spec.id].warnings,
  manual_position:manualA.doc.elements.find(el => el.id === 'a').transform,
  crossing_audit:FigDiagram.auditLayout(crossingDoc),
  dangling_audit:FigDiagram.auditLayout(dangling),overflow_doc:overflowDoc,
  limits:limitResults}));
"""
    proc = subprocess.run(["node", "-e", script], cwd=MCP_DIR, capture_output=True,
                          text=True, encoding="utf-8", errors="strict", timeout=60)
    if proc.returncode:
        raise AssertionError(proc.stdout + "\n" + proc.stderr)
    return json.loads(proc.stdout.strip().splitlines()[-1])


class DiagramLayoutTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.result = kernel_output()

    def test_wrapping_retains_all_cjk_ascii_and_chemical_text(self):
        doc = self.result["doc"]
        expected = {"node-0": LONG_CJK, "node-1": SCIENTIFIC_NAME, "node-2": CHEMICAL_ID}
        for node_id, original in expected.items():
            label = next(el for el in doc["elements"] if el["id"] == node_id + ".label")
            self.assertEqual(label["contract_label"], original)
            self.assertEqual(label["text"].replace("\n", ""), original)
            self.assertEqual(label["style"]["fontSizePt"], 7)
            self.assertGreater(label["diagram_label_layout"]["expected_width_mm"], 0)
            self.assertGreater(label["diagram_label_layout"]["expected_height_mm"], 0)
        self.assertIn("\n", next(el["text"] for el in doc["elements"] if el["id"] == "node-0.label"))
        self.assertIn("\n", next(el["text"] for el in doc["elements"] if el["id"] == "node-1.label"))

    def test_dense_grid_is_row_isolated_and_manual_positions_survive(self):
        doc = self.result["doc"]
        nodes = [el for el in doc["elements"] if el.get("diagram_part") == "node"]
        self.assertEqual(len(nodes), 9)
        self.assertGreaterEqual(len({node["transform"]["y"] for node in nodes}), 3)
        columns = doc["meta"]["diagrams"]["synthetic-layout"]["resolved_layout"]["columns"]
        rows = {}
        for index, node in enumerate(nodes):
            rows.setdefault(index // columns, []).append(node)
        self.assertEqual(len(rows), 3)
        row_bounds = [(min(n["transform"]["y"] for n in row),
                       max(n["transform"]["y"] + n["transform"]["h"] for n in row))
                      for row in rows.values()]
        for (_, previous_bottom), (next_top, _) in zip(row_bounds, row_bounds[1:]):
            self.assertGreater(next_top, previous_bottom)
        meta = doc["meta"]["diagrams"]["synthetic-layout"]
        self.assertEqual(meta["resolved_layout"]["row_heights_mm"][0],
                         max(node["transform"]["h"] for node in rows[0]))
        self.assertEqual(meta["layout_status"], "no_automatic_risk_detected")
        self.assertGreater(meta["nodes"][0]["label_layout"]["expected_height_mm"], 14)
        self.assertEqual(self.result["manual_position"], {"x": 4, "y": 43, "w": 29, "h": 17, "rotation": 0})
        self.assertEqual(self.result["svg"], self.result["repeated_svg"])
        self.assertEqual(self.result["warning_metadata_a"], self.result["warning_metadata_b"])
        self.assertFalse(any(w["code"] == "NODE_OVERLAP" for w in meta["layout_audit"]["warnings"]))

    def test_audit_finds_real_crossing_dangling_overflow_and_limits(self):
        crossing = self.result["crossing_audit"]
        warnings = [w for w in crossing["warnings"] if w["code"] == "CONNECTOR_THROUGH_NODE"]
        self.assertEqual(len(warnings), 1)
        self.assertEqual(warnings[0]["node_id"], "other")
        self.assertEqual({warnings[0]["source"], warnings[0]["target"]}, {"a", "b"})
        self.assertNotIn(warnings[0]["node_id"], {warnings[0]["source"], warnings[0]["target"]})
        dangling = self.result["dangling_audit"]
        self.assertEqual(dangling["status"], "needs_layout_review")
        self.assertEqual(dangling["visual_acceptance"], "not_assessed")
        self.assertTrue(any(w["code"] == "DANGLING_RELATION" for w in dangling["warnings"]))
        meta = self.result["overflow_doc"]["meta"]["diagrams"]["synthetic-overflow"]
        self.assertEqual(meta["status"], "partial")
        label_warning = next(w for w in meta["layout_audit"]["warnings"]
                             if w["code"] == "LABEL_TRUNCATION_RISK")
        self.assertEqual(label_warning["node_id"], "exact-constrained-node")
        self.assertGreater(label_warning["expected_width_mm"], label_warning["actual_width_mm"])
        self.assertGreater(label_warning["expected_height_mm"], label_warning["actual_height_mm"])
        self.assertEqual(label_warning["canvas"], {"width_mm": 120, "height_mm": 90})
        self.assertIn("exact-constrained-node", label_warning["message"])
        self.assertIn("120x90", label_warning["message"])
        self.assertEqual(self.result["limits"], {"nodes": False, "label": False, "unsafe": False})

    def test_real_svg_pymupdf_text_and_pillow_pixel_decode(self):
        root = ElementTree.fromstring(self.result["svg"])
        texts = {}
        for element in root.iter():
            element_id = element.get("data-fig-id", "")
            if element_id in ("node-0.label", "node-1.label", "node-2.label"):
                texts[element_id] = "".join(element.itertext())
        self.assertEqual(texts["node-0.label"].replace("\n", ""), LONG_CJK)
        self.assertEqual(texts["node-1.label"].replace("\n", ""), SCIENTIFIC_NAME)
        self.assertEqual(texts["node-2.label"], CHEMICAL_ID)
        temporary = tempfile.TemporaryDirectory(prefix="figure-diagram-layout-")
        self.addCleanup(temporary.cleanup)
        output = Path(temporary.name) / "synthetic-layout.pdf"
        svg_export.export_svg(self.result["svg"], self.result["doc"], str(output), "pdf", dpi=144)
        self.assertGreater(output.stat().st_size, 100)
        with fitz.open(output) as pdf:
            self.assertEqual(pdf.page_count, 1)
            page = pdf[0]
            extracted = "".join(page.get_text().split())
            self.assertIn(LONG_CJK, extracted)
            self.assertIn(SCIENTIFIC_NAME, extracted)
            self.assertIn(CHEMICAL_ID, extracted)
            label = next(el for el in self.result["doc"]["elements"] if el["id"] == "node-0.label")
            t = label["transform"]
            scale = 72 / 25.4
            clip = fitz.Rect((t["x"] + 1) * scale, (t["y"] + 1) * scale,
                             (t["x"] + t["w"] - 1) * scale, (t["y"] + t["h"] - 1) * scale)
            pix = page.get_pixmap(matrix=fitz.Matrix(3, 3), clip=clip, colorspace=fitz.csRGB)
            encoded_png = pix.tobytes("png")
        self.assertTrue(encoded_png.startswith(b"\x89PNG\r\n\x1a\n"))
        with Image.open(io.BytesIO(encoded_png)) as decoded:
            decoded.load()
            gray = decoded.convert("L")
            self.assertGreater(gray.width, 100)
            self.assertGreater(gray.height, 100)
            dark_pixels = sum(1 for value in gray.getdata() if value < 150)
        self.assertGreater(dark_pixels, 100)


if __name__ == "__main__":
    unittest.main(verbosity=2)
