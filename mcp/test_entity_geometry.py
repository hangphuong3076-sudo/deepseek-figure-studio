# -*- coding: utf-8 -*-
"""Synthetic connector geometry and persistence checks; never opens the current project."""
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from xml.etree import ElementTree

from py import docio, figraster, svg_export

MCP_DIR = Path(__file__).resolve().parent


def kernel_output():
    script = r"""
const assert = require('assert');
for (const file of ['figdoc', 'diagram', 'ops', 'render']) require('./lib/' + file + '.js');
const spec = {id:'synthetic-geometry',nodes:[
  {id:'a',label:'A',role:'question',x:10,y:10,w:20,h:10},
  {id:'b',label:'B',role:'method',x:50,y:10,w:20,h:10},
  {id:'c',label:'C',role:'evidence',x:10,y:50,w:20,h:10},
  {id:'near',label:'N',role:'method',x:35,y:10,w:5,h:5},
  {id:'outer',label:'O',role:'conclusion',x:75,y:40,w:25,h:30}
],relations:[
  {id:'r1',source:'a',target:'b',kind:'activate',bend:1,label:'<unsafe&'},
  {id:'r2',source:'a',target:'c',kind:'inhibit',direction:'backwards'},
  {id:'r3',source:'a',target:'near',kind:'sequence'},
  {id:'r4',source:'b',target:'c',kind:'associate'},
  {id:'r5',source:'outer',target:'c',kind:'include'}
],sources:[{id:'provided',locator:'synthetic-only',text:'not code'}],layout:{mode:'manual'}};
let doc = FigDiagram.build(null,spec,{generated_at:'2026-01-01T00:00:00.000Z'}).doc;
const originalSvg = FigRender.toSVG(doc);
assert.strictEqual(originalSvg, FigRender.toSVG(doc));
assert(FigDoc.validate(doc).ok,FigDoc.validate(doc).errors.join(';'));
const connector = id => doc.elements.find(el => el.type === 'connector' && el.semantic_relation.id === id);
assert.strictEqual(connector('r1').pathData,undefined);
assert.strictEqual(FigDiagram.connectorGeometry(doc,connector('r2')).start.x,20);
assert.strictEqual(doc.elements.filter(el => el.type === 'connector').length,4);
const svg1 = FigRender.toSVG(doc), svg2 = FigRender.toSVG(doc);
assert.strictEqual(svg1,svg2);
doc = FigOps.applyAll(doc,[{op:'rotate',targets:['a'],rotation:90},{op:'move',targets:['c'],dx:5,dy:6}],{ts:'2026-01-01T00:00:01.000Z'}).doc;
const movedSvg = FigRender.toSVG(doc);
assert.notStrictEqual(movedSvg,originalSvg);
assert(movedSvg.includes('data-fig-id="'+connector('r1').label_element_id+'"'));
const deleted = FigOps.applyAll(doc,[{op:'delete',targets:['b']}],{ts:'2026-01-01T00:00:02.000Z'}).doc;
assert.strictEqual(FigDoc.get(deleted,connector('r1').label_element_id),null);
assert(!deleted.elements.some(el => el.type === 'connector' && (el.relation.source === 'b' || el.relation.target === 'b')));
assert(deleted.meta.connector_audit.some(entry => entry.connector_id === connector('r1').id));
assert(FigDoc.validate(deleted).ok,FigDoc.validate(deleted).errors.join(';'));
const scoped = FigDiagram.build(null,spec,{generated_at:'2026-01-01T00:00:00.000Z'}).doc;
const panel = {id:'selected-panel',type:'panel',transform:{x:0,y:0,w:120,h:90},children:[],parent_id:null,z:-10,style:{},panelLayout:{label:'',padding_mm:0}};
const root = scoped.elements.find(el => el.id === 'diagram-synthetic-geometry:root');
scoped.elements.push(panel); root.parent_id = panel.id; panel.children = [root.id];
const panelSvg = FigRender.toSVG(scoped,{panel_id:'selected-panel'});
assert(panelSvg.includes('viewBox="0 0 120 90"'));
assert(panelSvg.includes('data-fig-id="'+connector('r1').id+'"'));
console.log(JSON.stringify({doc:FigDiagram.build(null,spec,{generated_at:'2026-01-01T00:00:00.000Z'}).doc,svg:originalSvg,panelSvg}));
"""
    proc = subprocess.run(["node", "-e", script], cwd=MCP_DIR, capture_output=True,
                          check=True, text=True, encoding="utf-8", errors="strict",
                          env=dict(os.environ, PYTHONIOENCODING="utf-8"), timeout=60)
    return json.loads(proc.stdout.strip().splitlines()[-1])


class EntityGeometryTests(unittest.TestCase):
    def test_geometry_deletion_and_single_panel_export(self):
        result = kernel_output()
        for svg in (result["svg"], result["panelSvg"]):
            root = ElementTree.fromstring(svg)
            kinds = [el.get("data-relation-kind") for el in root.iter()]
            for kind in ("activate", "inhibit", "sequence", "associate"):
                self.assertIn(kind, kinds)
        self.assertTrue(svg_export._parse_svg(result["panelSvg"]).tag.endswith("svg"))
        _replace = result["svg"].replace('data-relation-kind="associate"',
                                         'data-relation-kind="associate-conflict"', 1)
        with self.assertRaisesRegex(ValueError, "kind 非法"):
            svg_export._validate_tree(svg_export._parse_svg(_replace))

    def test_project_roundtrip_and_real_svg_exports(self):
        result = kernel_output()
        doc = result["doc"]
        self.assertEqual(docio.validate_doc(doc), [])
        temporary = tempfile.TemporaryDirectory(prefix="figure-entity-geometry-")
        self.addCleanup(temporary.cleanup)
        project = Path(temporary.name) / "synthetic.figureproj.json"
        docio.save_project(doc, str(project))
        loaded = docio.load_project(str(project))["doc"]
        self.assertEqual(docio.validate_doc(loaded), [])
        connectors = [el for el in loaded["elements"] if el.get("type") == "connector"]
        self.assertEqual(len(connectors), 4)
        self.assertFalse(any("pathData" in el for el in connectors))
        image = figraster.render_to_image(loaded, dpi=36)
        self.assertEqual(image.size, (171, 128))
        for extension, magic in (("png", b"\x89PNG\r\n\x1a\n"), ("pdf", b"%PDF-")):
            output = Path(temporary.name) / ("synthetic." + extension)
            svg_export.export_svg(result["svg"], loaded, str(output), extension, dpi=72)
            self.assertTrue(output.read_bytes().startswith(magic))


if __name__ == "__main__":
    unittest.main(verbosity=2)
