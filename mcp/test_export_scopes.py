# -*- coding: utf-8 -*-
import json
import subprocess
import unittest
from pathlib import Path


MCP_DIR = Path(__file__).resolve().parent


class ExportScopeTests(unittest.TestCase):
    def test_workbench_validator_accepts_chart_and_keeps_panel_scope(self):
        script = r"""
const assert = require('assert');
const fs = require('fs');
for (const name of ['figdoc', 'palette', 'presets', 'data', 'ops']) {
  require('./lib/' + name + '.js');
}
const presetBundle = {};
for (const name of ['journals', 'templates', 'palettes']) {
  presetBundle[name] = JSON.parse(fs.readFileSync('../presets/' + name + '.json', 'utf8'));
}
FigPresets.load(presetBundle);
const phase5 = require('./viewer_static/app/main.js');
const base = FigDoc.create({width_mm: 120, height_mm: 90, title: 'scope-test'});
const data = {columns: ['Binding energy', 'Intensity'], rows: [[1200, 50], [1100, 65], [800, 80], [300, 45]]};
const applied = FigOps.applyAll(base, [{
  op: 'apply_template', template_id: 'tpl-xps-two-regions', data,
  options: {journal_id: 'nature-single', palette_id: 'npg'}
}], {source: 'user', label: 'scope-test'});
assert.strictEqual(applied.applied, 1);
const doc = applied.doc;
const panel = doc.elements.find(el => el.type === 'panel');
const charts = doc.elements.filter(el => el.type === 'chart');
assert.strictEqual(charts.length, 2);
for (const chart of charts) {
  assert.strictEqual(phase5.assertRenderable(doc, chart.id), true);
}
assert.strictEqual(phase5.assertRenderable(doc, panel.id), true);
const duplicate = JSON.parse(JSON.stringify(doc));
duplicate.elements.find(el => el.type === 'chart').id = charts[1].id;
assert.throws(() => phase5.assertRenderable(duplicate, charts[1].id), /唯一有效/);
const invalid = JSON.parse(JSON.stringify(doc));
invalid.elements.push({
  id: 'plain-shape', type: 'rect', x: 0, y: 0,
  transform: {x: 1, y: 1, w: 5, h: 5}, style: {fill: '#fff'}
});
assert.throws(() => phase5.assertRenderable(invalid, 'plain-shape'), /panel 或 chart/);
console.log(JSON.stringify({ok: true, panel: panel.id, charts: charts.map(el => el.id)}));
"""
        proc = subprocess.run(
            ['node', '-e', script], cwd=str(MCP_DIR), capture_output=True,
            text=True, encoding='utf-8', errors='replace', timeout=60,
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + '\n' + proc.stderr)
        payload = json.loads(proc.stdout.strip().splitlines()[-1])
        self.assertTrue(payload['ok'])
        self.assertEqual(len(payload['charts']), 2)


if __name__ == '__main__':
    unittest.main()
