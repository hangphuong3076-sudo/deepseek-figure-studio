// Read-only audit probes. Run from the bundle root with Node; no network or model calls.
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../../..');
for (const f of ['figdoc', 'diagram', 'ops', 'science', 'palette', 'presets', 'data', 'render'])
  require(path.join(root, 'mcp/lib', f + '.js'));
FigPresets.load(Object.fromEntries(['journals', 'templates', 'palettes'].map(k =>
  [k, JSON.parse(fs.readFileSync(path.join(root, 'presets', k + '.json'), 'utf8'))])));
function doc() { return FigDoc.create({ width_mm: 89, height_mm: 70 }); }
function imageEl(id, pxWidth, pxHeight, w, h) {
  return { id, type: 'image', transform: { x: 0, y: 0, w, h, rotation: 0 },
    style: {}, src: 'data:image/png;base64,x', pxWidth, pxHeight };
}
function dpi(d, journal_id = 'nature-single') {
  return FigPresets.checkJournalRules(d, { journal_id }).results
    .filter(r => r.property === 'raster_dpi')
    .map(r => ({ rule: r.rule_id, status: r.status, measured: r.measured }));
}
const vertical = doc();
vertical.elements.push(imageEl('vertical-low', 1200, 150, 50.8, 50.8));
const mixed = doc();
mixed.elements.push(imageEl('known', 1200, 1200, 50.8, 50.8),
  imageEl('unknown', undefined, undefined, 50.8, 50.8));
const color = doc();
color.elements.push(imageEl('color-photo', 600, 600, 50.8, 50.8));
const fonts = doc();
const built = FigPresets.templateFromStats('tpl-bar', {
  columns: ['group', 'value'], rows: [['a', 1], ['b', 2]]
}, { mapping: { x: 'group', y: 'value' } });
fonts.elements.push(...built.elements);
const chart = fonts.elements.find(e => e.type === 'chart');
chart.chart.presentation = { version: 1, axes: { x: { title: { fontSizePt: 40 } } } };
fonts.elements.push({ id: 'label-6pt', type: 'text', text: 'label',
  transform: { x: 0, y: 0, w: 10, h: 5, rotation: 0 }, style: { fontSizePt: 6 } });
const maxFont = FigPresets.checkJournalRules(fonts, { journal_id: 'nature-single' })
  .results.find(r => r.property === 'max_font_size');
// Exercise the actual UI draft/diff helpers without opening a window.
// This tests the data adapter, not browser event dispatch.
const source = fs.readFileSync(path.join(root, 'mcp/viewer_static/app/props.js'), 'utf8');
function helper(name) {
  const start = source.indexOf('  function ' + name + '(');
  const end = source.indexOf('\n  function ', start + 10);
  return source.slice(start, end < 0 ? undefined : end);
}
const original = { characterization: { technique: 'XPS', x_scale: 'linear',
  x_reverse: false, normalize: 'none', offset_each_series: 0, curves: [],
  peak_annotations: [{ id: 'pk-user', x: 284.8, label: 'C1s' }] } };
const adapt = new Function('chart', `
  function effectiveChar(c) { return JSON.parse(JSON.stringify(c.characterization)); }
  function app() { return { error: m => { throw new Error(m); } }; }
  ${helper('pendFromChart')}
  ${helper('charDiffPatch')}
  const charState = { pend: pendFromChart(chart) };
  charState.pend.x_reverse = true;
  return { draft: charState.pend.peak_annotations, patch: charDiffPatch(chart) };
`);
const report = {
  generated_at: new Date().toISOString(),
  note: 'Synthetic read-only counterexamples, not full GUI or scientific validation.',
  vertical_dpi: { expected_min_dpi: 75, observed: dpi(vertical) },
  mixed_known_unknown_dpi: { expected: 'unknown coverage, not full pass', observed: dpi(mixed) },
  acs_color_300dpi: { expected: 'only applicable color rule; type absent should remain unknown', observed: dpi(color, 'acs-single') },
  max_font: { actual_axis_title_pt: 40, observed: maxFont },
  peak_ui_adapter: { before: original.characterization.peak_annotations, after: adapt(original) }
};
console.log(JSON.stringify(report, null, 2));
