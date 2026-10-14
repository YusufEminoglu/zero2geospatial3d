// @ts-check
// "Layers" tab: scene and weather summary, per-layer colour, filter and height.
import { h, clear, row, select, number, toggle, button, card, stats, toast } from './dom.js';
import { applyHeightRule, fieldRange } from './colorize.js';
import { RAMP_LABELS } from '../core/classify.js';
import { parseEpw, monthlySummary, windRose } from '../core/weather.js';
import { drawMonthly, drawWindRose } from './charts.js';
import { ExtrudedLayer, PointLayer, SurfaceLayer } from '../scene/objects.js';
import * as THREE from 'three';

const ROLE_NAMES = { buildings: 'Buildings', walls: 'Walls', trees: 'Trees', poles: 'Poles', surfaces: 'Surfaces', platforms: 'Platforms', sections: 'Sections' };
const RAMP_OPTIONS = Object.entries(RAMP_LABELS).flatMap(([k, v]) => [[k, v], [`${k}-r`, `${v} (reversed)`]]);

export function buildLayersPanel(app, root) {
  const render = () => {
    clear(root);
    root.appendChild(sceneCard(app, render));
    for (const layer of app.layers) root.appendChild(layerCard(app, layer, render));
    for (const raster of app.manifest.rasters || []) root.appendChild(rasterCard(app, raster));
  };
  app.on((what) => { if (what === 'results' || what === 'weather') render(); });
  render();
}

function sceneCard(app, rerender) {
  const m = app.manifest;
  const w = m.extent.maxX - m.extent.minX;
  const d = m.extent.maxY - m.extent.minY;
  const t = app.terrainStats();
  const body = h('div', {},
    stats([
      ['CRS', m.crs.authid],
      ['Area', `${(w / 1000).toFixed(2)} × ${(d / 1000).toFixed(2)} km`],
      ['Centre', `${app.site.lat.toFixed(4)}°, ${app.site.lon.toFixed(4)}°`],
      ['Elevation', m.terrain ? `${t.min.toFixed(0)} – ${t.max.toFixed(0)} m` : 'flat (no DEM)'],
      ['Grid', `${m.grid.cols} × ${m.grid.rows}, ${m.grid.cell.toFixed(1)} m`]
    ]),
    row('Time zone (UTC +h)', number(app.site.utcOffset, { step: 0.5, onChange: (v) => { app.site.utcOffset = v; app.updateSun(); } }),
      'Clock time used for the sun. An EPW file sets it automatically.'));
  // Weather.
  const wbox = h('div', { class: 'weather' });
  const fileInput = h('input', { type: 'file', accept: '.epw', hidden: true, onchange: async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      app.setWeather(parseEpw(await file.text()), file.name);
      toast(`Weather loaded: ${file.name}`);
    } catch (e) {
      toast(e.message, 'error');
    }
  } });
  if (app.weather?.dryBulb) {
    const loc = app.weather.location;
    const rose = windRose(app.weather);
    wbox.appendChild(stats([
      ['Weather', `${loc.city || app.weatherSource} (${loc.lat.toFixed(2)}, ${loc.lon.toFixed(2)})`],
      ['Prevailing wind', `from ${rose.prevailingDirection}°, ${rose.prevailingSpeed.toFixed(1)} m/s`],
      ['Calm hours', `${(rose.calm * 100).toFixed(0)} %`]
    ]));
    const monthly = h('canvas', { class: 'chart' });
    const roseCanvas = h('canvas', { class: 'chart' });
    wbox.appendChild(h('div', { class: 'chart-title', text: 'Monthly global radiation (bars) and mean temperature (line)' }));
    wbox.appendChild(monthly);
    wbox.appendChild(h('div', { class: 'chart-title', text: 'Wind rose (frequency by direction and speed)' }));
    wbox.appendChild(roseCanvas);
    requestAnimationFrame(() => { drawMonthly(monthly, monthlySummary(app.weather)); drawWindRose(roseCanvas, rose); });
  } else {
    wbox.appendChild(h('p', { class: 'muted', text: 'No weather file: radiation uses a clear-sky estimate, wind and comfort use the values you enter. Pick an EPW in QGIS or load one here.' }));
  }
  wbox.appendChild(h('div', { class: 'btn-row' }, button('Load EPW file…', () => fileInput.click()), fileInput));
  body.appendChild(wbox);
  void rerender;
  return card('Scene', body, { open: true, badge: `${app.layers.length} layers` });
}

function layerCard(app, layer, rerender) {
  const rule = app.rules.get(layer);
  const body = h('div', {});
  const fields = layer.fieldNames();
  const numeric = fields.filter((f) => f.type === 'number').map((f) => [f.name, f.result ? `${f.name} (result)` : f.name]);
  const all = fields.map((f) => [f.name, f.name]);
  const c = rule.color;
  const colorRows = h('div', {});
  const refresh = () => { app.recolor(layer); drawColorRows(); };
  const drawColorRows = () => {
    clear(colorRows);
    if (c.mode === 'single') {
      colorRows.appendChild(row('Colour', h('input', { type: 'color', value: c.color, oninput: (e) => { c.color = e.target.value; app.recolor(layer); } })));
    } else if (c.mode === 'graduated') {
      if (!c.field || !numeric.some(([n]) => n === c.field)) c.field = numeric[0]?.[0] || '';
      colorRows.appendChild(row('Field', select(numeric, c.field, (v) => { c.field = v; refresh(); })));
      colorRows.appendChild(row('Method', select([['jenks', 'Natural breaks'], ['quantile', 'Quantile'], ['equal', 'Equal interval']], c.method, (v) => { c.method = v; refresh(); })));
      colorRows.appendChild(row('Classes', select([3, 4, 5, 6, 7, 8, 9], c.classes, (v) => { c.classes = Number(v); refresh(); })));
      colorRows.appendChild(row('Ramp', select(RAMP_OPTIONS, c.ramp, (v) => { c.ramp = v; refresh(); })));
    } else if (c.mode === 'categorized') {
      if (!c.field) c.field = all[0]?.[0] || '';
      colorRows.appendChild(row('Field', select(all, c.field, (v) => { c.field = v; refresh(); })));
    }
    // Filter.
    if (numeric.length && c.mode !== 'source') {
      const f = c.filter;
      if (!f.field) f.field = c.field && numeric.some(([n]) => n === c.field) ? c.field : numeric[0][0];
      const [lo, hi] = fieldRange(layer, f.field);
      if (!f.on) { f.min = lo; f.max = hi; }
      const minIn = number(round(f.min), { onChange: (v) => { f.min = v; app.recolor(layer); } });
      const maxIn = number(round(f.max), { onChange: (v) => { f.max = v; app.recolor(layer); } });
      colorRows.appendChild(h('div', { class: 'filter' },
        toggle(f.on, (on) => { f.on = on; app.recolor(layer); }, 'Highlight only'),
        select(numeric, f.field, (v) => { f.field = v; f.on = false; drawColorRows(); app.recolor(layer); }),
        h('span', { class: 'range' }, minIn, h('span', { text: '–' }), maxIn),
        h('span', { class: 'muted small', text: `range ${round(lo)} – ${round(hi)}` })));
    }
  };
  if (!(layer.entry.role === 'platforms' || layer.entry.role === 'sections')) {
    body.appendChild(row('Colour by', select([['source', 'QGIS style'], ['single', 'Single colour'], ['graduated', 'Graduated (numbers)'], ['categorized', 'Categories']],
      c.mode, (v) => { c.mode = v; refresh(); })));
    body.appendChild(colorRows);
    drawColorRows();
  }
  if (layer instanceof ExtrudedLayer || layer instanceof PointLayer) {
    const hr = rule.height;
    const hRows = h('div', {});
    const drawH = () => {
      clear(hRows);
      if (hr.mode === 'field') {
        if (!hr.field) hr.field = numeric[0]?.[0] || '';
        hRows.appendChild(row('Field', select(numeric, hr.field, (v) => { hr.field = v; applyHeightRule(layer, hr); })));
        hRows.appendChild(row('× factor', number(hr.factor, { step: 0.1, onChange: (v) => { hr.factor = v; applyHeightRule(layer, hr); } }),
          'e.g. 3.2 to turn floors into metres, or a scale for a 3D bar chart'));
      } else if (hr.mode === 'uniform') {
        hRows.appendChild(row('Height (m)', number(hr.value, { step: 0.5, onChange: (v) => { hr.value = v; applyHeightRule(layer, hr); } })));
      }
    };
    body.appendChild(row('Height', select([['source', 'From QGIS expression'], ['field', 'Field × factor'], ['uniform', 'Uniform']], hr.mode,
      (v) => { hr.mode = v; drawH(); applyHeightRule(layer, hr); app.analyst?.cache.clear(); })));
    body.appendChild(hRows);
    drawH();
  }
  body.appendChild(h('div', { class: 'btn-row' }, button('Zoom to', () => {
    const box = new THREE.Box3().setFromObject(layer.group);
    if (layer instanceof SurfaceLayer || box.isEmpty()) return;
    app.viewer.frame(box);
  })));
  const vis = toggle(layer.visible, (on) => { layer.setVisible(on); app.analyst?.cache.clear(); });
  vis.addEventListener('click', (e) => e.stopPropagation());
  const el = card(layer.entry.name, body, { badge: `${ROLE_NAMES[layer.entry.role] || layer.entry.role} · ${layer.count.toLocaleString('en-US')}`,
    subtitle: layer.entry.scenario && layer.entry.scenario !== 'both' ? `Scenario ${layer.entry.scenario}` : '' });
  el.querySelector('summary').prepend(vis);
  void rerender;
  return el;
}

function rasterCard(app, raster) {
  const state = { on: false, ramp: 'rdylbu-r', opacity: 0.7 };
  let values = null;
  const apply = async () => {
    if (!state.on) { app.terrain.setDrape(null); return; }
    if (!values) values = new Float32Array(await (await fetch(app.base + raster.file, { cache: 'no-store' })).arrayBuffer());
    app.terrain.setDrape({ values, min: raster.min, max: raster.max, ramp: state.ramp, opacity: state.opacity });
  };
  const body = h('div', {},
    stats([['Range', `${raster.min.toFixed(2)} – ${raster.max.toFixed(2)}`], ['Building field', raster.field]]),
    row('Drape on ground', toggle(state.on, (on) => { state.on = on; apply(); })),
    row('Ramp', select(RAMP_OPTIONS, state.ramp, (v) => { state.ramp = v; apply(); })),
    row('Opacity', number(state.opacity, { min: 0.1, max: 1, step: 0.1, onChange: (v) => { state.opacity = v; apply(); } })),
    h('p', { class: 'muted small', text: `Each building carries the raster's mean over its footprint as "${raster.field}" — colour buildings by it in their layer card.` }));
  return card(`Climate raster: ${raster.name}`, body);
}

function round(v) {
  return Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 100) / 100;
}
