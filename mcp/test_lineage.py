# -*- coding: utf-8 -*-
"""Synthetic chart lineage tests; no project files or external data are read."""

import json
import subprocess
import unittest
from pathlib import Path


MCP_DIR = Path(__file__).resolve().parent
LOAD = """
const assert = require('assert');
require('./lib/data.js');
require('./lib/lineage.js');
function chart(id, chartType, columns, rows, mapping, extra) {
  return {id, type: 'chart', chart: Object.assign({
    chartType, data: {inline: {columns, rows}, ref: null}, mapping
  }, extra || {})};
}
"""


class LineageTests(unittest.TestCase):
    def run_js(self, body):
        proc = subprocess.run(
            ['node', '-e', LOAD + body], cwd=str(MCP_DIR),
            capture_output=True, text=True, encoding='utf-8', errors='replace',
            timeout=60,
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + '\n' + proc.stderr)
        return json.loads(proc.stdout.strip().splitlines()[-1])

    def test_bar_mean_raw_values_reverse_lookup_and_real_svg(self):
        result = self.run_js(r"""
const sha = 'a'.repeat(64);
const el = chart('bar-main', 'bar', ['condition', 'response'],
  [['A', 20], ['A', 30], ['B', 40]], {x: 'condition', y: 'response'}, {
    showValues: true,
    data: {inline: {columns: ['condition', 'response'], rows: [['A', 20], ['A', 30], ['B', 40]]},
      ref: null, source_ref: 'synthetic.csv', version: 'v1', source_info: {sha256: sha}},
    statistics: {center: 'mean', spread: 'SD', uncertainty_source: 'replicates',
      n_definition: 'two explicit synthetic observations', unit_x: 'declared condition',
      unit_y: 'declared response unit', source_data: 'synthetic.csv'}
  });
const doc = {elements: [el]};
const report = FigLineage.manifest(doc);
const point = report.charts[0].points.find(p => p.x === 'A');
assert.strictEqual(point.aggregate, 'mean');
assert.strictEqual(point.value, 25);
assert.deepStrictEqual(point.raw_values, [20, 30]);
assert.strictEqual(point.count, 2);
assert.deepStrictEqual(point.source_rows, [0, 1]);
assert.strictEqual(report.charts[0].source.raw_source_sha256, sha);
assert.strictEqual(report.charts[0].source.version, 'v1');
assert.ok(FigData.renderChartSVG(el.chart, {width_mm: 120, height_mm: 90})
  .includes('>25</text>'));
for (const row of [0, 1]) {
  const found = FigLineage.lookup(doc, {element_id: 'bar-main', source_row: row});
  assert.strictEqual(found.count, 1);
  assert.strictEqual(found.matches[0].value, 25);
  assert.strictEqual(found.matches[0].raw_point.y, row === 0 ? 20 : 30);
  assert.deepStrictEqual(found.matches[0].source_rows, [0, 1]);
}
console.log(JSON.stringify({value: point.value, source_rows: point.source_rows}));
""")
        self.assertEqual(result, {"value": 25, "source_rows": [0, 1]})

    def test_statistics_error_column_has_effective_rows_and_matches_svg(self):
        self.run_js(r"""
const el = chart('error-map', 'bar', ['condition', 'response', 'declared sem'],
  [['A', 20, 0.5], ['A', 30, 0.5]], {x: 'condition', y: 'response'}, {
    statistics: {center: 'mean', spread: 'SEM', uncertainty_source: 'column',
      uncertainty_column: 'declared sem', n_definition: 'declared synthetic n',
      unit_x: 'declared condition', unit_y: 'declared response unit'}
  });
const c = FigLineage.manifest({elements: [el]}).charts[0];
assert.strictEqual(c.field_matrix_by_role.error.column, 'declared sem');
assert.strictEqual(c.field_matrix_by_role.error.column_source,
  'statistics.uncertainty_column');
assert.strictEqual(c.field_matrix_by_role.error.mapping_column, null);
assert.strictEqual(c.field_matrix_by_role.error.used, true);
assert.deepStrictEqual(c.field_matrix_by_role.error.source_rows, [0, 1]);
assert.deepStrictEqual(c.points[0].raw_points.map(p => p.error), [0.5, 0.5]);
assert.strictEqual(c.points[0].uncertainty.half, 0.5);
const found = FigLineage.lookup({elements: [el]}, {element_id: 'error-map', source_row: 1});
assert.strictEqual(found.matches[0].raw_point.error, 0.5);
assert.ok(FigData.renderChartSVG(el.chart).includes('data-error-bars="column:SEM"'));
console.log(JSON.stringify({ok: true}));
""")

    def test_grouped_semantic_key_is_stable_across_panels(self):
        self.run_js(r"""
const a = chart('panel-a-chart', 'bar_grouped', ['condition', 'arm', 'response'],
  [['A', 'good', 10], ['A', 'good', 20], ['A', 'bad', 8]],
  {x: 'condition', group: 'arm', y: 'response'}, {parent_id: 'panel-a'});
const b = chart('panel-b-chart', 'bar_grouped', ['condition', 'arm', 'response'],
  [['A', 'good', 30], ['A', 'good', 40]],
  {x: 'condition', group: 'arm', y: 'response'}, {parent_id: 'panel-b'});
const doc = {elements: [
  {id: 'panel-a', type: 'panel'}, a,
  {id: 'panel-b', type: 'panel'}, b
]};
const report = FigLineage.manifest(doc);
const points = report.charts.map(c => c.points.find(p => p.series_label === 'good'));
assert.notStrictEqual(points[0].point_id, points[1].point_id);
assert.strictEqual(points[0].semantic_key, points[1].semantic_key);
assert.strictEqual(points[0].series_key, points[1].series_key);
assert.deepStrictEqual(points.map(p => p.value), [15, 35]);
assert.deepStrictEqual(report.charts[0].series.map(s => s.label), ['good', 'bad']);
assert.deepStrictEqual(report.layout_elements.map(e => e.coverage),
  ['not_applicable', 'not_applicable']);
assert.strictEqual(report.scope, 'chart_only');
assert.strictEqual(report.coverage, 'partial');
console.log(JSON.stringify({ok: true}));
""")

    def test_line_sort_scatter_groups_and_endpoint_rows_are_unambiguous(self):
        self.run_js(r"""
const line = chart('line-main', 'line_multi', ['time', 'arm', 'measurement'],
  [[2, 'good', 20], [1, 'good', 10], [1, 'bad', 5]],
  {x: 'time', group: 'arm', y: 'measurement'});
const scatter = chart('scatter-main', 'scatter', ['dose', 'arm', 'measurement'],
  [[2, 'good', 20], [1, 'bad', 10]],
  {x: 'dose', color: 'arm', y: 'measurement'});
const doc = {elements: [line, scatter]};
const report = FigLineage.manifest(doc);
const lc = report.charts[0];
assert.deepStrictEqual(lc.points.filter(p => p.series_label === 'good')
  .map(p => p.source_row), [1, 0]);
const good = lc.series.find(s => s.label === 'good');
assert.deepStrictEqual(good.endpoints.map(e => e.source_rows), [[1], [0]]);
assert.strictEqual(lc.points[0].aggregate, null);
assert.strictEqual(lc.points[0].transforms.sort.applied, true);
assert.deepStrictEqual(report.charts[1].series.map(s => s.label), ['good', 'bad']);
assert.deepStrictEqual(report.charts[1].points.map(p => p.source_row), [0, 1]);
const raw = FigLineage.lookup(doc, {element_id: 'scatter-main', source_row: 0});
assert.strictEqual(raw.matches[0].raw_point.values_by_column.dose, 2);
assert.strictEqual(raw.matches[0].raw_point.values_by_column.measurement, 20);
assert.strictEqual(raw.matches[0].series_key,
  report.charts[1].points.find(p => p.series_label === 'good').series_key);
console.log(JSON.stringify({ok: true}));
""")

    def test_normalization_fit_column_sort_and_raw_values_stay_distinct(self):
        self.run_js(r"""
const el = chart('spectrum', 'line', ['position', 'observed', 'external fit'],
  [[2, 10, 8], [1, 0, 2], [0, 20, 4]], {x: 'position', y: 'observed'}, {
    characterization: {
      technique: 'synthetic declared measurement', x_label: 'declared x unit',
      y_label: 'declared y unit', normalize: 'max_to_unity', x_reverse: true,
      curves: [{role: 'fit', column: 'external fit', label: 'user fit label'}],
      fit_source: 'declared external analysis, not performed here'
    }
  });
const before = JSON.stringify(el.chart.data.inline);
const c = FigLineage.manifest({elements: [el]}).charts[0];
const raw = c.points.filter(p => p.role === 'raw');
const fit = c.points.filter(p => p.role === 'fit');
assert.deepStrictEqual(raw.map(p => p.source_row), [2, 1, 0]);
assert.deepStrictEqual(raw.map(p => p.rendered_value), [1, 0, 0.5]);
assert.deepStrictEqual(fit.map(p => p.raw_y), [4, 2, 8]);
assert.deepStrictEqual(fit.map(p => p.raw_values), [[4], [2], [8]]);
assert.deepStrictEqual(fit.map(p => p.value), [4, 2, 8]);
assert.ok(Math.abs(fit[2].rendered_value - 0.4) < 1e-12);
assert.strictEqual(fit[0].source_columns.y, 'external fit');
assert.strictEqual(fit[0].raw_points[0].values_by_column['external fit'], 4);
assert.strictEqual(fit[0].transforms.fit.source_status, 'user_declared');
assert.strictEqual(fit[0].transforms.x_reverse, true);
assert.strictEqual(c.series.find(s => s.role === 'fit').label, 'user fit label');
assert.strictEqual(JSON.stringify(el.chart.data.inline), before);
console.log(JSON.stringify({ok: true}));
""")

    def test_audit_reports_missing_and_semantic_conflicts_without_scientific_pass(self):
        result = self.run_js(r"""
const el = chart('needs-review', 'bar', ['condition', '20 response'],
  [['A', 20], ['A', null]], {x: 'condition', y: '20 response'}, {
    statistics: {center: 'median', spread: 'range', source_data: 'synthetic.csv'}
  });
const report = FigLineage.audit({elements: [el]});
for (const code of ['STAT_N_MISSING', 'UNIT_MISSING', 'SEMANTICS_CONFLICT',
                    'RAW_SOURCE_SHA_UNKNOWN', 'DATA_ROWS_EXCLUDED']) {
  assert.ok(report.issues.some(w => w.code === code && w.element_id === 'needs-review'), code);
}
assert.strictEqual(report.charts[0].field_matrix_by_role.y.unit, null);
assert.deepStrictEqual(report.charts[0].excluded_rows, [1]);
assert.strictEqual(report.coverage, 'partial');
assert.strictEqual(report.scientific_validation, 'not_performed');
assert.ok(!('scientific_ready' in report));
console.log(JSON.stringify({error_count: report.error_count,
  codes: report.issues.map(w => w.code)}));
""")
        self.assertGreaterEqual(result["error_count"], 1)
        self.assertIn("SEMANTICS_CONFLICT", result["codes"])

    def test_bad_mapping_empty_cached_unsupported_and_malformed_rows_are_explicit(self):
        self.run_js(r"""
const bad = chart('bad-map', 'line', ['x', 'y'], [[1, 2]], {x: 'x', y: 'missing'});
const empty = chart('empty', 'bar', ['x', 'y'], [], {x: 'x', y: 'y'});
const cached = chart('cached', 'scatter', [], [], {x: 'x', y: 'y'});
cached.chart.data = {ref: 'cache/table.json', source_ref: 'cache/table.json',
  source_version: 'cached-v1'};
const unsupported = chart('diagram', 'diagram_flow', ['x'], [[1]], {x: 'x'});
const malformed = chart('malformed', 'bar', ['x', 'y'], [['only x']], {x: 'x', y: 'y'});
const doc = {elements: [{id: 'layout', type: 'group'}, bad, empty, cached, unsupported, malformed]};
assert.throws(() => FigData.getChartPoints(bad.chart), /mapping\.y/);
assert.throws(() => FigData.getChartPoints(malformed.chart), /rows\[0\]/);
const report = FigLineage.manifest(doc);
const byId = Object.fromEntries(report.charts.map(c => [c.element_id, c]));
assert.strictEqual(byId['bad-map'].status, 'error');
assert.ok(byId['bad-map'].issues.some(w => w.code === 'MAPPING_COLUMN_MISSING'));
assert.ok(byId.empty.issues.some(w => w.code === 'DATA_ROWS_MISSING'));
assert.strictEqual(byId.cached.status, 'unavailable');
assert.ok(byId.cached.issues.some(w => w.code === 'DATA_INLINE_MISSING'));
assert.strictEqual(byId.cached.points.length, 0);
assert.strictEqual(byId.diagram.status, 'unsupported');
assert.ok(byId.diagram.issues.some(w => w.code === 'LINEAGE_UNSUPPORTED'));
assert.strictEqual(byId.malformed.status, 'error');
assert.strictEqual(report.layout_elements.length, 1);
const found = FigLineage.lookup(doc, {element_id: 'cached', source_row: 0});
assert.strictEqual(found.chart_status, 'unavailable');
assert.strictEqual(found.matches.length, 0);
assert.ok(found.chart_error.includes('inline'));
assert.strictEqual(report.coverage, 'partial');
console.log(JSON.stringify({ok: true}));
""")

    def test_source_sha_version_reference_and_error_mapping_conflicts(self):
        self.run_js(r"""
const first = chart('source-a', 'scatter', ['x', 'y', 'err'], [[1, 2, 0.1]],
  {x: 'x', y: 'y', error: 'err'}, {
    data: {inline: {columns: ['x', 'y', 'err'], rows: [[1, 2, 0.1]]},
      source_info: {locator: 'same.csv', sha256: 'not-a-hash', version: 'v1'}},
    statistics: {center: 'mean', spread: 'SD', n_definition: 'declared synthetic n',
      unit_x: 'declared x', unit_y: 'declared y', uncertainty_source: 'column',
      uncertainty_column: 'different err'}
  });
const second = chart('source-b', 'scatter', ['x', 'y'], [[2, 3]], {x: 'x', y: 'y'}, {
  data: {inline: {columns: ['x', 'y'], rows: [[2, 3]]},
    source_info: {locator: 'same.csv', sha256: 'b'.repeat(64), version: 'v2'}},
  statistics: {source_data: 'other.csv'}
});
const report = FigLineage.audit({elements: [first, second]});
for (const code of ['RAW_SOURCE_SHA_INVALID', 'MAPPING_ERROR_SHADOWED', 'SOURCE_VERSION_CONFLICT']) {
  assert.ok(report.issues.some(w => w.code === code), code);
}
assert.ok(report.issues.some(w => w.code === 'SOURCE_REFERENCE_CONFLICT' &&
  w.element_id === 'source-b'));
assert.strictEqual(report.charts[0].source.raw_source_sha256, 'unknown');
assert.strictEqual(report.charts[1].source.raw_source_sha256, 'b'.repeat(64));
console.log(JSON.stringify({ok: true}));
""")

    def test_characterization_units_fallback_and_missing_fit_source_are_audited(self):
        self.run_js(r"""
const el = chart('fit-review', 'line', ['x', 'raw', 'fit'], [[1, 2, 1]],
  {x: 'x', y: 'raw'}, {
    statistics: {center: 'mean', spread: 'SD', n_definition: 'declared synthetic n'},
    characterization: {x_label: 'declared x (unit)', y_label: 'declared y (unit)',
      curves: [{role: 'fit', column: 'fit', label: 'given fit'}]}
  });
const report = FigLineage.audit({elements: [el]});
assert.ok(!report.issues.some(w => w.code === 'UNIT_MISSING'));
assert.ok(report.issues.some(w => w.code === 'FIT_SOURCE_MISSING'));
assert.strictEqual(report.charts[0].field_matrix_by_role.x.unit_source,
  'characterization.x_label');
console.log(JSON.stringify({ok: true}));
""")

    def test_deep_frozen_input_is_unchanged_and_reports_are_repeatable_json(self):
        self.run_js(r"""
const el = chart('frozen', 'bar', ['condition', 'response'],
  [['A', 20], ['A', 30]], {x: 'condition', y: 'response'});
const doc = {elements: [el]};
(function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
})(doc);
const before = JSON.stringify(doc);
const one = JSON.stringify(FigLineage.manifest(doc));
const two = JSON.stringify(FigLineage.manifest(doc));
assert.strictEqual(one, two);
assert.strictEqual(JSON.stringify(doc), before);
const editedOutput = FigLineage.manifest(doc);
editedOutput.charts[0].points[0].value = 999;
assert.strictEqual(doc.elements[0].chart.data.inline.rows[0][1], 20);
assert.strictEqual(FigLineage.manifest(doc).charts[0].points[0].value, 25);
const roundTrip = JSON.parse(JSON.stringify(FigLineage.audit(doc)));
assert.strictEqual(roundTrip.scope, 'chart_only');
assert.throws(() => FigLineage.lookup(doc, {source_row: -1}), /非负整数/);
assert.throws(() => FigLineage.lookup(doc, 1), /query/);
console.log(JSON.stringify({ok: true}));
""")


    def test_real_inferred_heatmap_audit_preserves_column_roles_without_point_mapping(self):
        result = self.run_js(r"""
const columns = ['Category', 'Group', 'Measurement'];
const rows = [
  ['A', 'g1', 1], ['A', 'g2', 2], ['A', 'g3', 3],
  ['A', 'g4', 4], ['A', 'g5', 5], ['A', 'g1', 1.5]
];
const inferred = FigData.inferChartType(FigData.columnStats({columns, rows}));
assert.strictEqual(inferred.chart_type, 'heatmap');
const template = JSON.parse(require('fs').readFileSync('../presets/templates.json', 'utf8'))
  .templates.find(t => t.id === 'tpl-heatmap');
assert.strictEqual(template.chart_type, 'heatmap');
const el = chart('inferred-heat', template.chart_type, columns, rows, inferred.mapping, {
  template: {id: template.id, chart_type: template.chart_type},
  statistics: {center: 'mean', spread: 'SD', n_definition: 'synthetic rows'}
});
const before = JSON.stringify(el);
const report = FigLineage.audit({elements: [el]});
const heat = report.charts[0];
assert.strictEqual(JSON.stringify(el), before);
assert.strictEqual(heat.status, 'unsupported');
assert.strictEqual(heat.coverage, 'partial');
assert.strictEqual(heat.row_count, rows.length);
assert.strictEqual(heat.row_mapping_status, 'not_performed');
assert.ok(Array.isArray(heat.field_matrix));
assert.strictEqual(heat.field_matrix.length, 7);
assert.ok(heat.field_matrix.every(f => Array.isArray(f.source_rows) && !f.source_rows.length));
assert.ok(heat.field_matrix.every(f => !f.used));
assert.strictEqual(heat.field_matrix_by_role.x.column, 'Group');
assert.strictEqual(heat.field_matrix_by_role.y.column, 'Category');
assert.strictEqual(heat.field_matrix_by_role.color.column, 'Measurement');
assert.deepStrictEqual(heat.columns.find(c => c.name === 'Group').roles, ['x']);
assert.deepStrictEqual(heat.columns.find(c => c.name === 'Category').roles, ['y']);
assert.deepStrictEqual(heat.columns.find(c => c.name === 'Measurement').roles, ['color']);
assert.deepStrictEqual(heat.points, []);
assert.deepStrictEqual(heat.series, []);
assert.deepStrictEqual(heat.source_row_indices, []);
assert.deepStrictEqual(heat.rendered_row_indices, []);
assert.strictEqual(heat.glyph_count, 0);
assert.ok(heat.issues.some(w => w.code === 'LINEAGE_UNSUPPORTED' &&
  w.message.includes('不做逐行 lineage 推断')));
assert.strictEqual(report.coverage, 'partial');
assert.strictEqual(report.scientific_validation, 'not_performed');
const encoded = JSON.parse(JSON.stringify(report));
assert.ok(Array.isArray(encoded.charts[0].field_matrix));
const found = FigLineage.lookup({elements: [el]}, {element_id: 'inferred-heat', source_row: 0});
assert.strictEqual(found.chart_status, 'unsupported');
assert.strictEqual(found.count, 0);
console.log(JSON.stringify({status: heat.status, rows: heat.row_count,
  row_mapping_status: heat.row_mapping_status, roles: heat.columns}));
""")
        self.assertEqual(result["status"], "unsupported")
        self.assertEqual(result["rows"], 6)
        self.assertEqual(result["row_mapping_status"], "not_performed")

    def test_invalid_declarations_units_and_extraction_fallback_stay_per_chart(self):
        self.run_js(r"""
const invalid = chart('invalid-heat', 'heatmap', ['Category', 'Group', 'Measurement'],
  [['A', 'g1', 1]], {x: ['Group'], y: {invalid: true}, color: 'Measurement'}, {
    statistics: {unit_x: {invalid: true}, unit_y: ['invalid']}
  });
const fallback = chart('fallback-bar', 'bar', ['Category', 'Measurement'],
  [['A', 20], ['A', 30]], {x: 'Category', y: 'missing'}, {
    statistics: {unit_x: {invalid: true}, unit_y: 17}
  });
const report = FigLineage.audit({elements: [invalid, fallback]});
const badHeat = report.charts[0];
assert.strictEqual(badHeat.status, 'unsupported');
assert.ok(Array.isArray(badHeat.field_matrix));
assert.strictEqual(badHeat.row_mapping_status, 'not_performed');
assert.strictEqual(badHeat.field_matrix_by_role.x.valid_declaration, false);
assert.strictEqual(badHeat.field_matrix_by_role.y.valid_declaration, false);
assert.strictEqual(badHeat.issues.filter(w => w.code === 'MAPPING_FIELD_INVALID').length, 2);
assert.ok(report.issues.every(w => w.element_id === 'invalid-heat' ||
  w.element_id === 'fallback-bar'));
const badBar = report.charts[1];
assert.strictEqual(badBar.status, 'error');
assert.strictEqual(badBar.coverage, 'partial');
assert.strictEqual(badBar.row_count, 2);
assert.strictEqual(badBar.row_mapping_status, 'error');
assert.ok(Array.isArray(badBar.field_matrix));
assert.strictEqual(badBar.field_matrix_by_role.x.column, 'Category');
assert.strictEqual(badBar.field_matrix_by_role.x.exists, true);
assert.strictEqual(badBar.field_matrix_by_role.y.column, 'missing');
assert.strictEqual(badBar.field_matrix_by_role.y.exists, false);
assert.strictEqual(badBar.field_matrix_by_role.x.unit, null);
assert.strictEqual(badBar.field_matrix_by_role.y.unit, null);
assert.deepStrictEqual(badBar.columns.map(c => c.name), ['Category', 'Measurement']);
assert.deepStrictEqual(badBar.points, []);
assert.ok(badBar.issues.some(w => w.code === 'MAPPING_COLUMN_MISSING'));
for (const role of ['x', 'y']) {
  assert.ok(badBar.issues.some(w => w.code === 'UNIT_MISSING' && w.mapping_role === role));
}
const found = FigLineage.lookup({elements: [invalid, fallback]},
  {element_id: 'fallback-bar', source_row: 0});
assert.strictEqual(found.chart_status, 'error');
assert.strictEqual(found.count, 0);
assert.ok(found.chart_error.includes('mapping.y'));
console.log(JSON.stringify({ok: true, unsupported_issues: badHeat.issues.map(w => w.code),
  fallback_row_count: badBar.row_count}));
""")

    def test_bar_and_grouped_mean_lookup_keep_duplicate_input_rows_distinct(self):
        self.run_js(r"""
for (const type of ['bar', 'bar_grouped']) {
  const grouped = type === 'bar_grouped';
  const columns = grouped ? ['Category', 'Group', 'Measurement'] : ['Category', 'Measurement'];
  const rows = grouped
    ? [['A', 'g1', 20], ['A', 'g1', 30], ['A', 'g1', 20], ['A', 'g1', 30]]
    : [['A', 20], ['A', 30], ['A', 20], ['A', 30]];
  const mapping = grouped
    ? {x: 'Category', group: 'Group', y: 'Measurement'}
    : {x: 'Category', y: 'Measurement'};
  const el = chart('duplicate-' + type, type, columns, rows, mapping);
  const doc = {elements: [el]};
  const report = FigLineage.audit(doc);
  const c = report.charts[0];
  assert.strictEqual(c.status, 'mapped');
  assert.strictEqual(c.row_mapping_status, 'mapped');
  assert.strictEqual(c.row_count, 4);
  assert.strictEqual(c.points.length, 1);
  assert.strictEqual(c.points[0].aggregate, 'mean');
  assert.strictEqual(c.points[0].value, 25);
  assert.strictEqual(c.points[0].count, 4);
  assert.deepStrictEqual(c.points[0].raw_values, [20, 30, 20, 30]);
  assert.deepStrictEqual(c.points[0].source_rows, [0, 1, 2, 3]);
  assert.deepStrictEqual(c.source_row_indices, [0, 1, 2, 3]);
  for (const row of [0, 1, 2, 3]) {
    const found = FigLineage.lookup(doc, {element_id: el.id, source_row: row});
    assert.strictEqual(found.count, 1);
    assert.strictEqual(found.matches[0].value, 25);
    assert.strictEqual(found.matches[0].source_row, row);
    assert.strictEqual(found.matches[0].raw_point.source_row, row);
    assert.strictEqual(found.matches[0].raw_point.y, row % 2 === 0 ? 20 : 30);
    assert.deepStrictEqual(found.matches[0].source_rows, [0, 1, 2, 3]);
  }
}
console.log(JSON.stringify({ok: true}));
""")


    def test_replacement_raw_identity_is_explicit_archived_and_chart_isolated(self):
        self.run_js(r"""
for (const file of ['figdoc', 'diagram', 'ops']) require('./lib/' + file + '.js');
const crypto = require('crypto');
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const rawV1 = sha('synthetic raw v1'), rawV2 = sha('synthetic raw v2');
const valuesV1 = {columns: ['condition', 'response'], rows: [['A', 20], ['A', 30]]};
const valuesV2 = {columns: ['condition', 'response'], rows: [['A', 20], ['A', 40]]};
function withRaw(id) {
  const el = chart(id, 'bar', valuesV1.columns, valuesV1.rows,
    {x: 'condition', y: 'response'});
  el.chart.data = {inline: JSON.parse(JSON.stringify(valuesV1)), source_ref: 'v1.csv', ref: 'v1.csv',
    version: 'v1', raw_source_sha256: rawV1, source_info: {
      kind: 'csv', locator: 'v1.csv', file_name: 'v1.csv', version: 'v1',
      sha256: rawV1, bytes: 24, verification_status: 'input_bytes_hashed_unverified_origin',
      value_fingerprint: {algorithm: 'canonical_columns_rows_json_sha256',
        sha256: FigDiagram.hash(valuesV1), columns: valuesV1.columns, row_count: 2}
    }};
  return el;
}
let doc = FigDoc.create();
doc.elements = [withRaw('changed-chart'), withRaw('unchanged-chart'),
  {id: 'other-panel', type: 'panel', transform: {x: 0, y: 0, w: 10, h: 10}}];
const untouched = JSON.stringify([doc.elements[1], doc.elements[2]]);
const changed = FigOps.applyAll(doc, [{op: 'set_chart_data', targets: ['changed-chart'],
  approved: true, data: valuesV2, source_ref: 'v2.csv', version: 'v2'}], {}).doc;
const current = changed.elements[0].chart;
assert.strictEqual(FigData.getChartPoints(current).points[0].value, 30);
assert.strictEqual(current.data.raw_source_sha256, 'unknown');
assert.strictEqual(current.data.source_info, undefined);
assert.strictEqual(current.data.content_sha256, FigDiagram.hash(valuesV2));
assert.notStrictEqual(current.data.content_sha256, current.data.raw_source_sha256);
assert.strictEqual(current.data_history.length, 1);
assert.deepStrictEqual(current.data_history[0].data.source_info, doc.elements[0].chart.data.source_info);
assert.strictEqual(current.data_history[0].data.source_info.file_name, 'v1.csv');
assert.strictEqual(current.data_history[0].data.raw_source_sha256, rawV1);
assert.strictEqual(JSON.stringify([changed.elements[1], changed.elements[2]]), untouched);
const baseRev = changed.history[changed.history.length - 1].base_rev;
const reverted = FigOps.revertTo(changed, baseRev);
assert.strictEqual(FigData.getChartPoints(reverted.elements[0].chart).points[0].value, 25);
assert.strictEqual(reverted.elements[0].chart.data.raw_source_sha256, rawV1);
const verifiedOp = {op: 'set_chart_data', targets: ['changed-chart'], approved: true,
  data: valuesV2, source_ref: 'v2.csv', version: 'v2', raw_source_sha256: rawV2,
  source_info: {kind: 'csv', locator: 'v2.csv', file_name: 'v2.csv', version: 'v2',
    sha256: rawV2, bytes: 25}};
const provided = FigOps.applyAll(changed, [verifiedOp], {}).doc;
assert.strictEqual(provided.elements[0].chart.data.raw_source_sha256, rawV2);
assert.strictEqual(provided.elements[0].chart.data.source_info.file_name, 'v2.csv');
assert.strictEqual(provided.elements[0].chart.data_history[1].data.raw_source_sha256, 'unknown');
assert.strictEqual(FigLineage.audit(provided).charts[0].source.raw_source_sha256, rawV2);
const frozenProvided = JSON.stringify(provided);
const noop = FigOps.applyAll(provided, [verifiedOp], {});
assert.strictEqual(noop.applied, 0);
assert.strictEqual(JSON.stringify(noop.doc), frozenProvided);
const sameFile = FigOps.applyAll(changed, [{op: 'set_chart_data', targets: ['changed-chart'],
  approved: true, data: valuesV2, source_ref: 'v2.csv', version: 'v2',
  raw_source_sha256: rawV1}], {}).doc;
assert.strictEqual(sameFile.elements[0].chart.data.raw_source_sha256, rawV1);
assert.strictEqual(sameFile.elements[0].chart.data.source_info, undefined);
const unchanged = JSON.stringify(changed);
for (const invalid of [
  {op: 'set_chart_data', targets: ['changed-chart'], approved: true, data: valuesV2,
    source_ref: 'v3.csv', version: 'v3', raw_source_sha256: 'content-sha-is-not-proof'},
  {op: 'set_chart_data', targets: ['changed-chart'], approved: true, data: valuesV2,
    source_ref: 'v3.csv', version: 'v3', source_info: {
      locator: 'v1.csv', version: 'v1', sha256: rawV1}}
]) assert.throws(() => FigOps.applyAll(changed, [invalid], {}));
assert.strictEqual(JSON.stringify(changed), unchanged);
console.log(JSON.stringify({oldMean: 25, newMean: 30, unknownChecked: true,
  explicitProvided: true, chartIsolated: true}));
""")

    def test_source_conflicts_expose_values_and_stay_per_chart_warnings(self):
        self.run_js(r"""
const first = chart('same-source-first', 'bar', ['condition', 'response'],
  [['A', 20], ['A', 30]], {x: 'condition', y: 'response'}, {
    data: {inline: {columns: ['condition', 'response'], rows: [['A', 20], ['A', 30]]},
      source_ref: 'same.csv', version: 'v1', source_info: {
        locator: 'same.csv', version: 'v1', sha256: 'a'.repeat(64)}}
  });
const second = chart('same-source-second', 'bar', ['condition', 'response'],
  [['A', 20], ['A', 40]], {x: 'condition', y: 'response'}, {
    data: {inline: {columns: ['condition', 'response'], rows: [['A', 20], ['A', 40]]},
      source_ref: 'same.csv', version: 'v2', source_info: {
        locator: 'other.csv', version: 'v1', sha256: 'b'.repeat(64)}}
  });
const report = FigLineage.audit({elements: [first, second]});
assert.strictEqual(report.error_count, 0);
const crossChart = report.issues.find(w => w.code === 'SOURCE_VERSION_CONFLICT' &&
  w.other_element_id === 'same-source-first');
assert.strictEqual(crossChart.element_id, 'same-source-second');
assert.strictEqual(crossChart.severity, 'warning');
assert.strictEqual(crossChart.previous_version, 'v1');
assert.strictEqual(crossChart.version, 'v2');
assert.strictEqual(crossChart.previous_raw_source_sha256, 'a'.repeat(64));
assert.strictEqual(crossChart.raw_source_sha256, 'b'.repeat(64));
assert.ok(crossChart.differing_fields.includes('version'));
assert.ok(crossChart.differing_fields.includes('raw_source_sha256'));
for (const code of ['SOURCE_REFERENCE_CONFLICT', 'SOURCE_VERSION_CONFLICT']) {
  assert.ok(report.charts[1].issues.some(w => w.code === code &&
    Array.isArray(w.declarations) && w.severity === 'warning'), code);
}
const oldUnknown = FigLineage.audit({elements: [chart('unknown-chart', 'bar',
  ['x', 'y'], [['A', 25]], {x: 'x', y: 'y'}, {
    data: {inline: {columns: ['x', 'y'], rows: [['A', 25]]},
      raw_source_sha256: 'unknown', source_ref: 'v2.csv', version: 'v2',
      content_sha256: 'c'.repeat(64)}
  })]});
assert.strictEqual(oldUnknown.error_count, 0);
assert.strictEqual(oldUnknown.charts[0].source.raw_source_sha256, 'unknown');
assert.ok(oldUnknown.issues.some(w => w.code === 'RAW_SOURCE_SHA_UNKNOWN' &&
  w.element_id === 'unknown-chart' && w.severity === 'warning' &&
  w.verification === 'not_verified'));
console.log(JSON.stringify({ok: true, warningsOnly: true, perChart: true}));
""")


if __name__ == '__main__':
    unittest.main()
