// @ts-check
// "Analyze" tab: analysis area, one card per analysis, and the results list.
import { h, clear, row, select, number, toggle, button, card, stats, download, toast, slider } from './dom.js';
import { MONTH_NAMES, windRose } from '../core/weather.js';
import { sendGrid, sendFields } from './qgis_link.js';
import { clearSkyYear, conditionsAt, typicalDoy } from '../core/weather.js';
import { solarPosition } from '../core/solar.js';
import { ExtrudedLayer } from '../scene/objects.js';
import { CRITERIA, planningCheck, parseProfile, profileJson, defaultProfile } from '../analysis/compliance.js';
import { planningSheet, planningCsv } from '../export/check_pdf.js';
import { SURFACE_MATERIALS } from '../core/microclimate.js';

const MONTHS = MONTH_NAMES.map((m, i) => [i + 1, m]);
const DATE_PRESETS = [['3-21', '21 Mar (equinox)'], ['6-21', '21 Jun (summer solstice)'], ['12-21', '21 Dec (winter solstice)'], ['custom', 'Custom date']];
const PERIODS = [['year', 'Whole year'], ['summer', 'Summer (Jun–Aug)'], ['winter', 'Winter (Dec–Feb)'], ['heating', 'Heating season (Oct–Apr)']];
const PERIOD_MONTHS = { year: null, summer: [6, 7, 8], winter: [12, 1, 2], heating: [10, 11, 12, 1, 2, 3, 4] };

export function defaultParams(app) {
  const rose = app.weather?.windSpeed ? windRose(app.weather) : null;
  return {
    sun: { preset: '3-21', month: 3, day: 21, start: 0, end: 24, step: 10, facades: false },
    svf: { directions: 192, facades: false },
    solar: { period: 'year', tilt: 0, azimuth: 180, efficiency: 0.2, pr: 0.8, coverage: 0.6, minShare: 0.7, facades: false },
    view: { height: 1.6, radius: 600 },
    wind: { from: rose ? rose.prevailingDirection : 270, speed: rose ? Math.max(1, rose.prevailingSpeed) : 4, cell: 0 },
    comfort: { month: 7, day: 21, hour: 15, manual: !app.weather?.dryBulb, airTemp: 32, rh: 45, windSpeed: 2.5, windDir: rose ? rose.prevailingDirection : 270, material: 'concrete', lai: 3.0, treeHeight: 10, treeRadius: 3.5 },
    vent: { from: rose ? rose.prevailingDirection : 270, speed: rose ? Math.max(1, rose.prevailingSpeed) : 3.5, emission: 60, background: 18, deposition: 0.25 },
    noise: { power: 78, receiverHeight: 1.5, ground: 0.5 },
    form: { eyeHeight: 1.6, radius: 80, preset: '12-21', month: 12, day: 21, start: 9, end: 15, minHours: 2, maxH: 72, floorH: 3.2 },
    morph: { block: 100, from: rose ? rose.prevailingDirection : 270 },
    climate: { from: 7, to: 22, sectors: 8, ring: 15 },
    check: { scope: 'selected', criteria: CRITERIA.map((c) => c.id), thresholds: Object.fromEntries(CRITERIA.map((c) => [c.id, c.threshold])) }
  };
}

export function buildAnalyzePanel(app, root) {
  app.params = defaultParams(app);
  const resultsBox = h('div', { class: 'results' });
  const render = () => {
    clear(root);
    root.appendChild(areaCard(app));
    root.appendChild(sunCard(app));
    root.appendChild(svfCard(app));
    root.appendChild(vscCard(app));
    root.appendChild(solarCard(app));
    root.appendChild(viewCard(app));
    root.appendChild(windCard(app));
    root.appendChild(comfortCard(app));
    root.appendChild(morphCard(app));
    root.appendChild(ventilationCard(app));
    root.appendChild(noiseCard(app));
    root.appendChild(urbanFormCard(app));
    root.appendChild(climateCard(app));
    root.appendChild(checkCard(app));
    root.appendChild(h('h3', { class: 'section', text: 'Results' }));
    root.appendChild(resultsBox);
    renderResults(app, resultsBox);
  };
  app.on((what) => {
    if (what === 'results' || what === 'active') renderResults(app, resultsBox);
    if (what === 'weather') { app.params = defaultParams(app); render(); }
    if (what === 'params' || what === 'trees') render();
    if (what === 'busy') root.querySelectorAll('button.run').forEach((b) => { /** @type {any} */ (b).disabled = app.busy; });
  });
  render();
}

function runButton(app, label, fn) {
  return button(label, fn, { kind: 'primary run' });
}

// ---------------------------------------------------------------- area
function areaCard(app) {
  const a = app.analysisArea;
  const info = h('div', { class: 'muted small' });
  const update = () => {
    const ar = app.area();
    const cell = app.cell();
    const cols = Math.ceil((ar.maxX - ar.minX) / cell), rows = Math.ceil((ar.maxY - ar.minY) / cell);
    info.textContent = `${((ar.maxX - ar.minX) / 1000).toFixed(2)} × ${((ar.maxY - ar.minY) / 1000).toFixed(2)} km at ${cell} m → ${(cols * rows / 1e6).toFixed(2)} M cells`;
    app.showAreaOutline();
  };
  const radius = number(a.radius, { min: 50, step: 50, onChange: (v) => { a.radius = v; update(); } });
  const body = h('div', {},
    row('Area', select([['scene', 'Whole scene'], ['view', 'Around the view centre'], ['rect', 'Drawn rectangle']], a.mode, (v) => {
      a.mode = v;
      if (v === 'rect' && !a.rect) drawRect();
      update();
    })),
    row('Radius (m)', radius, 'For "Around the view centre"'),
    row('Cell size', select([[0, 'Automatic'], [0.5, '0.5 m'], [1, '1 m'], [2, '2 m'], [4, '4 m'], [8, '8 m']], app.cellSize, (v) => { app.cellSize = Number(v); update(); }),
      'Smaller cells are sharper and slower. Large areas are split into tiles automatically.'),
    h('div', { class: 'btn-row' }, button('Draw rectangle', () => drawRect()), button('Show area', () => update())),
    info);
  async function drawRect() {
    const rect = await app.tools.drawRect('Draw the analysis area');
    if (rect) { a.rect = rect; a.mode = 'rect'; update(); }
  }
  requestAnimationFrame(update);
  return card('Analysis area', body, { open: true });
}

// ---------------------------------------------------------------- sun
function dateRows(p, onChange = () => {}) {
  const wrap = h('div', {});
  const draw = () => {
    clear(wrap);
    wrap.appendChild(row('Date', select(DATE_PRESETS, p.preset, (v) => {
      p.preset = v;
      if (v !== 'custom') { const [m, d] = v.split('-').map(Number); p.month = m; p.day = d; }
      draw(); onChange();
    })));
    if (p.preset === 'custom') {
      wrap.appendChild(row('Month / day', h('span', { class: 'inline' },
        select(MONTHS, p.month, (v) => { p.month = Number(v); onChange(); }),
        number(p.day, { min: 1, max: 31, step: 1, width: '4em', onChange: (v) => { p.day = v; onChange(); } }))));
    }
  };
  draw();
  return wrap;
}

function sunCard(app) {
  const p = app.params.sun;
  const body = h('div', {},
    h('p', { class: 'muted small', text: 'Direct sun hours on the ground and roofs (and optionally facades) for one day, and the share of the day each place spends in shade.' }),
    dateRows(p),
    row('From – to (h)', h('span', { class: 'inline' },
      number(p.start, { min: 0, max: 24, step: 0.5, width: '4.5em', onChange: (v) => { p.start = v; } }),
      number(p.end, { min: 0, max: 24, step: 0.5, width: '4.5em', onChange: (v) => { p.end = v; } }))),
    row('Time step', select([[5, '5 min'], [10, '10 min'], [15, '15 min'], [30, '30 min']], p.step, (v) => { p.step = Number(v); })),
    row('Facades too', toggle(p.facades, (v) => { p.facades = v; })),
    h('div', { class: 'btn-row' }, runButton(app, 'Run sun hours', () => app.run('Sun hours', (prog) => app.analyst.sunHours({
      area: app.area(), cell: app.cell(), date: { month: p.month, day: p.day }, startHour: p.start, endHour: p.end,
      stepMinutes: p.step, facades: p.facades, onProgress: prog })))),
    h('div', { class: 'btn-row' },
      runButton(app, 'Animate shadows', async () => {
        const res = await app.run('Shadow study', (prog) => app.analyst.shadowStudy({
          area: app.area(), cell: app.cell(800), date: { month: p.month, day: p.day },
          startHour: Math.max(p.start, 4), endHour: Math.min(p.end, 21), stepMinutes: 30, onProgress: prog }));
        if (res?.[0]) {
          app.date = { month: p.month, day: p.day };
          app.time = res[0].hours[0];
          app.updateSun();
          toast('Press ▶ on the sun clock (or drag it) to play the day.');
        }
      }),
      runButton(app, 'Summer ⇆ winter', async () => {
        const run = (month) => app.analyst.sunHours({ area: app.area(), cell: app.cell(), date: { month, day: 21 }, startHour: 0, endHour: 24,
          stepMinutes: p.step, onProgress: () => {} });
        const out = await app.run('Summer and winter sun', async (prog) => {
          prog(0.1);
          const summer = await run(6);
          prog(0.55);
          const winter = await run(12);
          return [summer[0], winter[0], summer[1], winter[1]];
        });
        if (out && app.compare) {
          app.compare.enable('swipe');
          app.compare.states[0].result = out[0].id;
          app.compare.states[1].result = out[1].id;
          app.compare._buildDom();
          app.viewer.requestRender();
        }
      }, { title: 'Sun hours on 21 June and 21 December, side by side' })));
  return card('Sun hours & shadows', body, { open: true });
}

function svfCard(app) {
  const p = app.params.svf;
  const body = h('div', {},
    h('p', { class: 'muted small', text: 'How much of the sky each point sees (1 = open sky). Low values mean deep street canyons, warmer nights and less daylight.' }),
    row('Sky directions', select([[96, '96 (fast)'], [192, '192'], [384, '384 (fine)']], p.directions, (v) => { p.directions = Number(v); })),
    row('Facades too', toggle(p.facades, (v) => { p.facades = v; })),
    h('div', { class: 'btn-row' }, runButton(app, 'Run sky view factor', () => app.run('Sky view factor', (prog) => app.analyst.skyView({
      area: app.area(), cell: app.cell(), directions: p.directions, facades: p.facades, onProgress: prog })))));
  return card('Sky view factor', body);
}

function vscCard(app) {
  app.params.vsc ??= { directions: 192 };
  const p = app.params.vsc;
  const body = h('div', {},
    h('p', { class: 'muted small', text: 'Vertical sky component on every wall (BRE 209): how much daylight from an overcast sky reaches the facade. 39.6 % is an open wall; 27 % or more keeps a window well lit.' }),
    row('Sky directions', select([[96, '96 (fast)'], [192, '192'], [384, '384 (fine)']], p.directions, (v) => { p.directions = Number(v); })),
    h('div', { class: 'btn-row' }, runButton(app, 'Run daylight (VSC)', () => app.run('Daylight (VSC)', (prog) => app.analyst.daylightVsc({
      area: app.area(), directions: p.directions, onProgress: prog })))));
  return card('Daylight on facades (VSC)', body);
}

function solarCard(app) {
  const p = app.params.solar;
  const source = app.weather?.dryBulb ? `Weather: ${app.weather.location.city || app.weatherSource}` : 'No EPW: clear-sky estimate (an upper bound)';
  const body = h('div', {},
    h('p', { class: 'muted small', text: `Irradiation on roofs and ground (and facades) with shading, plus rooftop PV yield per building. ${source}.` }),
    row('Period', select(PERIODS, p.period, (v) => { p.period = v; })),
    row('Panel tilt (°)', number(p.tilt, { min: 0, max: 90, step: 5, onChange: (v) => { p.tilt = v; } }), '0 = flat; analysed surfaces are tilted towards the azimuth'),
    row('Panel azimuth (°)', number(p.azimuth, { min: 0, max: 360, step: 5, onChange: (v) => { p.azimuth = v; } }), '180 = south'),
    row('Module efficiency', number(p.efficiency, { min: 0.05, max: 0.3, step: 0.01, onChange: (v) => { p.efficiency = v; } })),
    row('Performance ratio', number(p.pr, { min: 0.5, max: 0.95, step: 0.01, onChange: (v) => { p.pr = v; } })),
    row('Panel coverage', number(p.coverage, { min: 0.1, max: 1, step: 0.05, onChange: (v) => { p.coverage = v; } }), 'Share of a suitable roof that can hold panels'),
    row('Suitable if ≥', number(p.minShare, { min: 0.3, max: 1, step: 0.05, onChange: (v) => { p.minShare = v; } }), 'Share of the unshaded potential a roof cell must keep'),
    row('Facades too', toggle(p.facades, (v) => { p.facades = v; })),
    h('div', { class: 'btn-row' }, runButton(app, 'Run solar & PV', () => app.run('Solar radiation', (prog) => app.analyst.solarRadiation({
      ...solarOptions(app), facades: p.facades, onProgress: prog })))));
  return card('Solar radiation & PV', body);
}

/** The solar card's settings as runner options (also used by Compare). */
export function solarOptions(app) {
  const p = app.params.solar;
  return { area: app.area(), cell: app.cell(), months: PERIOD_MONTHS[p.period], tiltDeg: p.tilt, azimuthDeg: p.azimuth,
    efficiency: p.efficiency, performanceRatio: p.pr, coverage: p.coverage, minShare: p.minShare };
}

/**
 * The comfort card's weather for its date and hour: the EPW hour, or the
 * typed values with clear-sky radiation (also used by Compare).
 */
export function comfortConditions(app) {
  const p = app.params.comfort;
  if (!p.manual && app.weather?.dryBulb) return conditionsAt(app.weather, p.month, p.day, p.hour);
  const s = app.site;
  const sky = clearSkyYear(s.lat, s.lon, s.utcOffset);
  const i = (typicalDoy(p.month, p.day) - 1) * 24 + (p.hour - 1);
  return { airTemp: p.airTemp, rh: p.rh, windSpeed: p.windSpeed, windDir: p.windDir, ghi: sky.ghi[i], dni: sky.dni[i], dhi: sky.dhi[i], ir: NaN };
}

/**
 * Points along the top edge of a building, 1 m outside the walls and just
 * above the roof: a viewshed from them is where the building can be seen
 * from (its own roof would hide almost everything from the roof's centre).
 */
function roofEdgePoints(app, layer, f, count = 8) {
  const g = layer.features[f].geometry;
  const polys = g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [];
  const ring = polys.map((pp) => pp[0]).filter(Boolean).sort((a, b) => b.length - a.length)[0] || [];
  const top = app.terrain.toY(layer.baseZ[f]) + layer.heights[f] + 0.3;
  const cx = layer.centroid[f * 2], cy = layer.centroid[f * 2 + 1];
  const seg = [];
  let total = 0;
  for (let i = 0; i + 1 < ring.length; i++) {
    const len = Math.hypot(ring[i + 1][0] - ring[i][0], ring[i + 1][1] - ring[i][1]);
    seg.push([ring[i], ring[i + 1], total, len]);
    total += len;
  }
  if (!total) return [{ x: cx, y: top + 1.3, z: -cy }];
  const out = [];
  for (let k = 0; k < count; k++) {
    const d = (k + 0.5) * total / count;
    const [a, b, s0, len] = seg.find(([, , s0, len]) => d <= s0 + len) || seg[seg.length - 1];
    const t = len ? (d - s0) / len : 0;
    let x = a[0] + t * (b[0] - a[0]), y = a[1] + t * (b[1] - a[1]);
    const r = Math.hypot(x - cx, y - cy) || 1;
    x += (x - cx) / r; y += (y - cy) / r; // 1 m outwards
    out.push({ x, y: top, z: -y });
  }
  return out;
}

function viewCard(app) {
  const p = app.params.view;
  const fromSelected = async () => {
    for (const layer of app.layers) {
      if (!(layer instanceof ExtrudedLayer)) continue;
      const sel = app.selectedIndices(layer);
      if (!sel.length) continue;
      return app.run('Where the building is seen from', (prog) => app.analyst.viewshed({
        area: app.area(), cell: app.cell(), eyes: roofEdgePoints(app, layer, sel[0]), radius: p.radius, onProgress: prog }));
    }
    toast('Select a building first (click it).');
    return null;
  };
  const pick = async () => {
    const pt = await app.tools.pickPoint('Click the observer position (ground or roof)');
    if (pt) run(pt.world, 'from the picked point');
  };
  const run = (eye, how) => app.run(`Viewshed ${how}`, (prog) => app.analyst.viewshed({
    area: app.area(), cell: app.cell(), eye, observerHeight: p.height, radius: p.radius, onProgress: prog }));
  const body = h('div', {},
    h('p', { class: 'muted small', text: 'Which surfaces an observer can see. From the selected building: the ground and roofs that see its top edge, which is where the building can be seen from.' }),
    row('Eye height (m)', number(p.height, { min: 0, step: 0.1, onChange: (v) => { p.height = v; } })),
    row('Radius (m)', number(p.radius, { min: 50, step: 50, onChange: (v) => { p.radius = v; } })),
    h('div', { class: 'btn-row' }, runButton(app, 'Pick observer…', pick), runButton(app, 'From selected building', fromSelected)));
  return card('Visibility', body);
}

function windCard(app) {
  const p = app.params.wind;
  const rose = app.weather?.windSpeed ? windRose(app.weather) : null;
  const p95 = rose ? percentile(app.weather.windSpeed, 0.95) : null;
  const body = h('div', {},
    h('p', { class: 'muted small', text: 'Screening of pedestrian wind: wakes behind buildings, channelling along streets and corner streams of tall buildings. Not CFD.' }),
    row('Wind from (°)', number(p.from, { min: 0, max: 359, step: 5, onChange: (v) => { p.from = v; } })),
    row('Speed at 10 m', number(p.speed, { min: 0.5, max: 30, step: 0.5, onChange: (v) => { p.speed = v; } })),
    rose ? h('div', { class: 'btn-row' },
      button('Prevailing', () => { p.from = rose.prevailingDirection; p.speed = Math.round(rose.prevailingSpeed * 10) / 10; app.emit('params'); }),
      button('95th percentile', () => { p.from = rose.prevailingDirection; p.speed = Math.round(p95 * 10) / 10; app.emit('params'); },
        { title: 'Use with the comfort classes, which are defined on the speed exceeded 5 % of the time' })) : null,
    h('div', { class: 'btn-row' }, runButton(app, 'Run wind', () => app.run('Wind screening', (prog) => app.analyst.wind({
      area: app.area(), cell: Math.max(2, app.cell(600)), windFromDeg: p.from, speed10: p.speed, onProgress: prog })))));
  return card('Wind', body);
}

function comfortCard(app) {
  const p = app.params.comfort;
  const condBox = h('div', {});
  const conditions = () => comfortConditions(app);
  const drawCond = () => {
    clear(condBox);
    const c = conditions();
    const pos = solarPosition(typicalDoy(p.month, p.day), p.hour - 0.5, app.site.lat, app.site.lon, app.site.utcOffset);
    if (p.manual || !app.weather?.dryBulb) {
      condBox.appendChild(row('Air temperature (°C)', number(p.airTemp, { step: 0.5, onChange: (v) => { p.airTemp = v; } })));
      condBox.appendChild(row('Humidity (%)', number(p.rh, { min: 0, max: 100, step: 5, onChange: (v) => { p.rh = v; } })));
      condBox.appendChild(row('Wind at 10 m (m/s)', number(p.windSpeed, { min: 0, step: 0.5, onChange: (v) => { p.windSpeed = v; } })));
      condBox.appendChild(row('Wind from (°)', number(p.windDir, { min: 0, max: 359, step: 5, onChange: (v) => { p.windDir = v; } })));
    }
    condBox.appendChild(stats([
      ['Sun elevation', `${(pos.elevation * 180 / Math.PI).toFixed(1)}°`],
      ['Air / humidity', `${c.airTemp.toFixed(1)} °C / ${Math.round(c.rh)} %`],
      ['Wind', `${c.windSpeed.toFixed(1)} m/s from ${Math.round(c.windDir)}°`],
      ['Direct / diffuse', `${Math.round(c.dni)} / ${Math.round(c.dhi)} W/m²`]
    ]));
  };
  const treeCountText = h('span', { class: 'muted small', text: `${app.plantedTrees?.length || 0} planted` });
  const body = h('div', {},
    h('p', { class: 'muted small', text: 'Outdoor heat stress (UTCI) and Physiological Equivalent Temperature (PET) at pedestrian level with surface energy balance.' }),
    row('Month / day', h('span', { class: 'inline' },
      select(MONTHS, p.month, (v) => { p.month = Number(v); drawCond(); }),
      number(p.day, { min: 1, max: 31, step: 1, width: '4em', onChange: (v) => { p.day = v; drawCond(); } }))),
    row('Hour ending', select(Array.from({ length: 24 }, (_, i) => [i + 1, `${String(i).padStart(2, '0')}:00–${String(i + 1).padStart(2, '0')}:00`]), p.hour, (v) => { p.hour = Number(v); drawCond(); })),
    row('Surface material', select(Object.entries(SURFACE_MATERIALS).map(([k, v]) => [k, v.label]), p.material, (v) => { p.material = v; })),
    row('Tree canopy LAI', number(p.lai, { min: 0.5, max: 6, step: 0.5, onChange: (v) => { p.lai = v; } })),
    app.weather?.dryBulb ? row('Conditions', select([['epw', 'From the weather file'], ['manual', 'Enter manually']], p.manual ? 'manual' : 'epw', (v) => { p.manual = v === 'manual'; drawCond(); })) : null,
    condBox,
    row('What-if greening', h('span', { class: 'inline' },
      button('Plant tree…', async () => {
        const pt = await app.tools.pickPoint('Click ground to plant a tree', { roofs: false });
        if (pt) app.addPlantedTree(pt.local[0], pt.local[1], p.treeHeight, p.treeRadius);
      }),
      button('Clear trees', () => app.clearPlantedTrees()),
      treeCountText)),
    h('div', { class: 'btn-row' },
      runButton(app, 'Run UTCI & PET', () => {
        const c = conditions();
        return app.run('Thermal comfort', (prog) => app.analyst.comfort({ area: app.area(), cell: Math.max(1, app.cell(700)),
          month: p.month, day: p.day, hour: p.hour, conditions: c, material: p.material, lai: p.lai, onProgress: prog }));
      }),
      runButton(app, '24 h diurnal study', async () => {
        const res = await app.run('Diurnal thermal study', (prog) => app.analyst.diurnalStudy({
          area: app.area(), cell: Math.max(2, app.cell(600)), date: { month: p.month, day: p.day },
          material: p.material, lai: p.lai, onProgress: prog,
          manual: p.manual || !app.weather?.dryBulb
            ? { airTemp: p.airTemp, rh: p.rh, windSpeed: p.windSpeed, windDir: p.windDir, hour: p.hour } : null }));
        if (res?.[0]) {
          app.date = { month: p.month, day: p.day };
          app.time = res[0].hours ? res[0].hours[0] : 12;
          app.updateSun();
          toast('Press ▶ on the sun clock (or drag it) to play the day.');
        }
      })));
  drawCond();
  return card('Thermal comfort (UTCI & PET)', body);
}

function morphCard(app) {
  const p = app.params.morph;
  const body = h('div', {},
    h('p', { class: 'muted small', text: 'Heat-island indicators per block: built fraction, heights, street canyon ratio, frontal area, roughness and an approximate Local Climate Zone. Run the sky view factor first to include it.' }),
    row('Block size (m)', select([[50, '50 m'], [100, '100 m'], [200, '200 m'], [250, '250 m']], p.block, (v) => { p.block = Number(v); })),
    row('Wind from (°)', number(p.from, { min: 0, max: 359, step: 5, onChange: (v) => { p.from = v; } }), 'For the frontal area index'),
    h('div', { class: 'btn-row' }, runButton(app, 'Run morphology', () => app.run('Urban morphology', (prog) => app.analyst.morphology({
      area: app.area(), cell: Math.max(1, app.cell(800)), blockSize: p.block, windFromDeg: p.from, onProgress: prog })))));
  return card('Heat island & morphology', body);
}

function ventilationCard(app) {
  const p = app.params.vent;
  const roadsInfo = h('span', { class: 'muted small', text: `${app.drawnRoads?.length || 0} drawn` });
  const roadsNote = roadSourcesNote(app);
  const body = h('div', {},
    h('p', { class: 'muted small', text: 'Street canyon ventilation efficiency (VEI), local air age and line-source pollutant dispersion with vegetative canopy filtration.' }),
    row('Wind from (°)', number(p.from, { min: 0, max: 359, step: 5, onChange: (v) => { p.from = v; } })),
    row('Speed at 10 m (m/s)', number(p.speed, { min: 0.5, max: 25, step: 0.5, onChange: (v) => { p.speed = v; } })),
    row('Traffic emission (µg/(m·s))', number(p.emission, { min: 1, max: 2000, step: 5, onChange: (v) => { p.emission = v; } }),
      'NO2 per metre of a road with traffic 1: about 60 for a busy two-lane road (20,000 vehicles a day)'),
    row('Background (µg/m³)', number(p.background, { min: 0, max: 200, step: 1, onChange: (v) => { p.background = v; } })),
    row('Tree filtration share', number(p.deposition, { min: 0, max: 0.8, step: 0.05, onChange: (v) => { p.deposition = v; } })),
    roadsNote,
    row('Road line sources', h('span', { class: 'inline' },
      button('Draw road source…', async () => {
        const line = await app.tools.drawLine('Click points along the road source');
        if (line) {
          app.drawnRoads.push(line);
          app.tools.outline(`drawn_road_${app.drawnRoads.length}`, line, 0xff4f2e);
          roadsInfo.textContent = `${app.drawnRoads.length} drawn`;
        }
      }),
      button('Clear roads', () => {
        for (let i = 1; i <= app.drawnRoads.length; i++) app.tools.outline(`drawn_road_${i}`, null);
        app.drawnRoads = [];
        roadsInfo.textContent = '0 drawn';
      }),
      roadsInfo)),
    h('div', { class: 'btn-row' }, runButton(app, 'Run ventilation & dispersion', () => app.run('Ventilation & dispersion', (prog) => app.analyst.ventilation({
      area: app.area(), cell: Math.max(2, app.cell(600)), windFromDeg: p.from, speed10: p.speed,
      emissionRateUgMS: p.emission, backgroundUgM3: p.background, treeDepositionFactor: p.deposition,
      onProgress: prog })))));
  return card('Canyon ventilation & air quality', body);
}

/** Which roads the noise and dispersion runs will use. */
function roadSourcesNote(app) {
  const layers = app.layers.filter((l) => l.entry.role === 'roads');
  const text = layers.length
    ? `Roads: ${layers.map((l) => l.entry.name).join(', ')} (Traffic expression from QGIS), plus lines drawn here.`
    : 'No layer has the Roads role: draw road lines here, or give a QGIS line layer the Roads role. Without roads, street corridors between buildings are used.';
  return h('p', { class: 'muted small', text });
}

function noiseCard(app) {
  const p = app.params.noise;
  const roadsInfo = h('span', { class: 'muted small', text: `${app.drawnRoads?.length || 0} drawn` });
  const roadsNote = roadSourcesNote(app);
  const body = h('div', {},
    h('p', { class: 'muted small', text: 'Environmental road traffic noise propagation, Maekawa building edge diffraction and facade quiet-side detection.' }),
    row('Road sound power Lw (dB(A)/m)', number(p.power, { min: 50, max: 110, step: 1, onChange: (v) => { p.power = v; } })),
    row('Receiver height (m)', number(p.receiverHeight, { min: 0.5, max: 10, step: 0.5, onChange: (v) => { p.receiverHeight = v; } })),
    row('Ground absorption', number(p.ground, { min: 0, max: 1, step: 0.1, onChange: (v) => { p.ground = v; } }), '0 = hard paved ground, 1 = soft grass / soil'),
    roadsNote,
    row('Road line sources', h('span', { class: 'inline' },
      button('Draw road source…', async () => {
        const line = await app.tools.drawLine('Click points along the road source');
        if (line) {
          app.drawnRoads.push(line);
          app.tools.outline(`drawn_road_${app.drawnRoads.length}`, line, 0xff4f2e);
          roadsInfo.textContent = `${app.drawnRoads.length} drawn`;
        }
      }),
      button('Clear roads', () => {
        for (let i = 1; i <= app.drawnRoads.length; i++) app.tools.outline(`drawn_road_${i}`, null);
        app.drawnRoads = [];
        roadsInfo.textContent = '0 drawn';
      }),
      roadsInfo)),
    h('div', { class: 'btn-row' }, runButton(app, 'Run noise map', () => app.run('Environmental noise', (prog) => app.analyst.noise({
      area: app.area(), cell: Math.max(2, app.cell(600)), soundPowerDb: p.power,
      receiverHeight: p.receiverHeight, groundFactor: p.ground, onProgress: prog })))));
  return card('Acoustic & noise screening', body);
}

function urbanFormCard(app) {
  const p = app.params.form;
  const body = h('div', {},
    h('p', { class: 'muted small', text: 'Panoramic pedestrian Green View Index (GVI) and Knowles / BRE right-to-light 3D solar envelope volume.' }),
    row('Eye height (m)', number(p.eyeHeight, { min: 0.5, max: 3, step: 0.1, onChange: (v) => { p.eyeHeight = v; } })),
    row('Sight radius (m)', number(p.radius, { min: 20, max: 300, step: 10, onChange: (v) => { p.radius = v; } })),
    h('div', { class: 'btn-row' }, runButton(app, 'Run Green View Index (GVI)', () => app.run('Green View Index', (prog) => app.analyst.greenView({
      area: app.area(), cell: Math.max(2, app.cell(600)), eyeHeight: p.eyeHeight, maxRadius: p.radius, onProgress: prog })))),
    h('div', { class: 'insp-sub', text: '3D Solar Envelope (right to light)' }),
    dateRows(p),
    row('Sun window From–To (h)', h('span', { class: 'inline' },
      number(p.start, { min: 6, max: 18, step: 0.5, width: '4.5em', onChange: (v) => { p.start = v; } }),
      number(p.end, { min: 6, max: 18, step: 0.5, width: '4.5em', onChange: (v) => { p.end = v; } }))),
    row('Min sun hours (h)', number(p.minHours, { min: 1, max: 6, step: 0.5, onChange: (v) => { p.minHours = v; } })),
    row('Max height cap (m)', number(p.maxH, { min: 10, max: 200, step: 5, onChange: (v) => { p.maxH = v; } })),
    row('Floor height (m)', number(p.floorH, { min: 2.5, max: 5, step: 0.1, onChange: (v) => { p.floorH = v; } })),
    h('div', { class: 'btn-row' }, runButton(app, 'Run solar envelope', () => app.run('Solar envelope', (prog) => app.analyst.solarEnvelope({
      area: app.area(), cell: Math.max(2, app.cell(600)), date: { month: p.month, day: p.day },
      startHour: p.start, endHour: p.end, minSunHours: p.minHours, maxBuildableHeight: p.maxH, floorHeight: p.floorH, onProgress: prog })))));
  return card('Green view & solar envelope', body);
}

function climateCard(app) {
  const p = app.params.climate;
  const has = !!app.weather?.dryBulb;
  const body = h('div', {},
    h('p', { class: 'muted small', text: 'A whole year of weather around every building: comfortable hours (UTCI 9–26 °C), heat- and cold-stress hours, pedestrian wind and a wind rose per building, from the local sky view, sun and shelter.' }),
    has ? null : h('p', { class: 'note', text: 'Needs an EPW weather file: load one in Layers > Scene, or pick the nearest station in QGIS.' }),
    row('Hours of the day', h('span', { class: 'inline' },
      number(p.from, { min: 0, max: 23, step: 1, width: '4em', onChange: (v) => { p.from = v; } }),
      number(p.to, { min: 1, max: 24, step: 1, width: '4em', onChange: (v) => { p.to = v; } }))),
    row('Wind directions', select([[8, '8'], [16, '16 (slower)']], p.sectors, (v) => { p.sectors = Number(v); })),
    row('Surroundings (m)', select([[10, '10 m'], [15, '15 m'], [25, '25 m']], p.ring, (v) => { p.ring = Number(v); }), 'Open ground this close to a building counts as its surroundings'),
    h('div', { class: 'btn-row' }, runButton(app, 'Run climate year', () => {
      if (!app.weather?.dryBulb) { toast('Load an EPW weather file first.'); return null; }
      return app.run('Climate around buildings', (prog) => app.analyst.climateYear({
        area: app.area(), cell: Math.max(2, app.cell(700)), sectors: p.sectors, hourFrom: p.from, hourTo: p.to, ringMetres: p.ring, onProgress: prog }));
    })));
  return card('Climate around buildings (year)', body, { badge: has ? 'EPW' : 'needs EPW' });
}

const PROFILE_KEY = 'g3d.planningProfile';

function applyProfile(p, prof) {
  p.name = prof.name;
  p.criteria = [...prof.criteria];
  p.thresholds = { ...prof.thresholds };
}

function checkCard(app) {
  const p = app.params.check;
  if (!p.restored) {
    // The last profile used in this browser (a convenience; files are the record).
    p.restored = true;
    try {
      const saved = localStorage.getItem(PROFILE_KEY);
      if (saved) applyProfile(p, parseProfile(saved));
    } catch { /* storage blocked or an old file: keep the defaults */ }
  }
  p.name ??= defaultProfile().name;
  const remember = () => { try { localStorage.setItem(PROFILE_KEY, profileJson(p)); } catch { /* storage blocked */ } };
  const hasB = app.layers.some((l) => l.entry.scenario === 'B');
  const crit = h('div', { class: 'checks' });
  const nameInput = h('input', { type: 'text', value: p.name, title: 'Name of this set of thresholds; shown on the planning sheet',
    onchange: () => { p.name = nameInput.value.trim() || 'Planning profile'; remember(); } });
  const renderCriteria = () => {
    clear(crit);
    nameInput.value = p.name;
    for (const c of CRITERIA) {
      const on = p.criteria.includes(c.id);
      crit.appendChild(h('div', { class: 'check-row', title: c.help },
        toggle(on, (v) => { p.criteria = v ? CRITERIA.map((x) => x.id).filter((id) => id === c.id || p.criteria.includes(id)) : p.criteria.filter((x) => x !== c.id); remember(); }, c.short),
        h('span', { class: 'muted small', text: c.test === 'min' ? '≥' : '≤' }),
        number(p.thresholds[c.id], { step: c.unit === '' || c.unit === '×' ? 0.01 : 1, width: '5em', onChange: (v) => { if (Number.isFinite(v)) { p.thresholds[c.id] = v; remember(); } } }),
        h('span', { class: 'muted small', text: c.unit })));
    }
  };
  renderCriteria();
  const file = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: async () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    try {
      const prof = parseProfile(await f.text());
      applyProfile(p, prof);
      remember();
      renderCriteria();
      toast(`Profile "${prof.name}" loaded${prof.ignored.length ? ` (ignored: ${prof.ignored.join(', ')})` : ''}.`);
    } catch (e) { toast(e.message, 'error'); }
  } });
  const fileStemOf = (name) => String(name).normalize('NFKD').replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50) || 'planning_profile';
  const body = h('div', {},
    h('p', { class: 'muted small', text: 'Pass or fail for each building: sun on the open ground around it, facade daylight, daylight kept after scenario B, windy and summer heat-stress hours. Missing analyses run on their own.' }),
    row('Buildings', select([['selected', 'Selected buildings'], ['area', 'All in the analysis area'], ...(hasB ? [['scenarioB', 'Scenario B buildings']] : [])], p.scope, (v) => { p.scope = v; })),
    row('Profile', nameInput),
    crit,
    h('div', { class: 'btn-row' },
      button('Save profile', () => download(`${fileStemOf(p.name)}.json`, profileJson(p), 'application/json'), { title: 'Save these criteria and thresholds as a JSON file to reuse or share' }),
      button('Load…', () => file.click(), { title: 'Load a saved profile' }),
      button('Defaults', () => { applyProfile(p, defaultProfile()); remember(); renderCriteria(); }, { title: 'Back to the default thresholds' }),
      file),
    h('div', { class: 'btn-row' }, runButton(app, 'Run planning check', () => app.run('Planning check', (prog) => planningCheck(app, {
      scope: p.scope, criteria: p.criteria, thresholds: p.thresholds, profile: p.name, onProgress: prog })))));
  return card('Planning check', body);
}

// ---------------------------------------------------------------- results
function renderResults(app, box) {
  clear(box);
  if (!app.results.length) {
    box.appendChild(h('p', { class: 'muted', text: 'Results appear here. Each can be shown on the map, sent to QGIS (GeoTIFF + building fields) or saved.' }));
    return;
  }
  box.appendChild(row('Overlay opacity', slider(0.92, { min: 0.2, max: 1, step: 0.02, format: (v) => `${Math.round(v * 100)} %`, onInput: (v) => app.setOverlayOpacity(v) })));
  for (const r of app.results) {
    const active = app.activeResult === r;
    const actions = h('div', { class: 'btn-row' },
      button(active ? 'Hide' : 'Show', () => (active ? app.hideResult() : app.showResult(r)), { kind: active ? 'on' : '' }),
      r.facade ? toggle(r.showFacade !== false, (v) => { r.showFacade = v; if (app.activeResult === r) app.showResult(r); }, 'Facades') : null,
      r.kind === 'wind' ? toggle(r.showStreamlines !== false, (v) => { r.showStreamlines = v; if (app.activeResult === r) app.showResult(r); }, 'Streamlines') : null,
      app.qgis ? button('To QGIS', async () => {
        try {
          const key = `${r.kind}_${r.created.toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
          if (r.grid) await sendGrid(r, key);
          const layers = r.fields?.length ? await sendFields(r.fields, r.qgisStyle || String(r.display?.ramp || 'viridis')) : [];
          toast(`Sent to QGIS${layers.length ? ` (+ fields on ${layers.join(', ')})` : ''}.`);
        } catch (e) { toast(e.message, 'error'); }
      }, { kind: 'primary', title: 'GeoTIFF layer plus per-building fields in a results GeoPackage' }) : null,
      r.grid ? button('.asc', () => download(`${r.kind}.asc`, asciiGrid(app, r)), { title: 'ESRI ASCII grid in the scene CRS' }) : null,
      r.fields?.length ? button('CSV', () => download(`${r.kind}_buildings.csv`, fieldsCsv(r.fields), 'text/csv')) : null,
      button('×', () => {
        app.results.splice(app.results.indexOf(r), 1);
        if (active) app.hideResult();
        if (r._tex) { r._tex.dispose(); delete r._tex; } // its drape texture on the GPU
        app.emit('results');
      }, { title: 'Remove' }));
    let studyControls = null;
    if (r.kind === 'shadowstudy' || r.kind === 'diurnalstudy') {
      const label = (k) => { const hr = r.hours[k]; return `${String(Math.floor(hr)).padStart(2, '0')}:${String(Math.round((hr % 1) * 60)).padStart(2, '0')}`; };
      const go = (k) => { app.date = { ...r.date }; app.time = r.hours[k]; if (app.activeResult !== r) app.showResult(r); app.updateSun(); };
      const sl = slider(r.frame, { min: 0, max: r.hours.length - 1, step: 1, format: label, onInput: go });
      let timer = 0;
      const play = button('▶', () => {
        if (timer) { clearInterval(timer); timer = 0; play.textContent = '▶'; return; }
        play.textContent = '❚❚';
        let k = r.frame;
        timer = window.setInterval(() => {
          k = (k + 1) % r.hours.length;
          go(k);
          sl.set(k);
        }, 450);
      }, { title: 'Play the day' });
      studyControls = h('div', { class: 'btn-row study' }, play, sl);
    }
    let seasonControls = null;
    if (r.seasonal) {
      const names = [['year', 'Year'], ['djf', 'Winter'], ['mam', 'Spring'], ['jja', 'Summer'], ['son', 'Autumn']];
      seasonControls = h('div', { class: 'btn-row chips' }, ...names.map(([code, label]) => button(label, () => {
        r.season = code;
        r.values = r.seasonal[code];
        r.title = `Comfortable hours around buildings (${label.toLowerCase()})`;
        if (r._tex) { r._tex.dispose(); delete r._tex; }
        app.showResult(r);
        app.emit('results');
      }, { kind: r.season === code ? 'on' : '' })));
    }
    let checkTable = null;
    if (r.kind === 'compliance') {
      const head = h('tr', {}, h('th', { text: 'Building' }), ...r.criteria.map((c) => h('th', { text: c.short, title: c.help })));
      const body = r.rows.slice(0, 40).map((row2) => h('tr', { onclick: () => { app.select(row2.layer, [row2.f]); app.inspect(row2.layer, row2.f); } },
        h('td', { text: row2.name }),
        ...row2.checks.map((ch, i) => h('td', { class: ch.pass === null ? 'na' : ch.pass ? 'pass' : 'fail',
          title: Number.isFinite(ch.value) ? fmtValue(ch.value, r.criteria[i].unit) : 'not available',
          text: ch.pass === null ? '–' : ch.pass ? '✓' : '✗' }))));
      checkTable = h('div', {},
        h('div', { class: 'check-table-wrap' }, h('table', { class: 'check-table' }, head, ...body)),
        r.rows.length > 40 ? h('div', { class: 'muted small', text: `${r.rows.length - 40} more in the CSV and the PDF order (worst first).` }) : null,
        h('div', { class: 'btn-row' },
          button('Planning sheet (PDF)', () => download('planning_check.pdf', planningSheet(app, r)), { kind: 'primary' }),
          button('CSV', () => download('planning_check.csv', planningCsv(r), 'text/csv'))));
    }
    const el = h('div', { class: `result ${active ? 'active' : ''}` },
      h('div', { class: 'result-title', text: r.title }),
      h('div', { class: 'muted small', text: `${r.subtitle || ''}${r.seconds ? ` · ${r.seconds.toFixed(1)} s` : ''}` }),
      actions,
      studyControls,
      seasonControls,
      checkTable,
      r.stats?.length ? stats(r.stats) : null,
      r.fields?.length ? h('div', { class: 'muted small', text: `Building fields: ${[...new Set(r.fields.map((f) => f.name))].join(', ')} (colour by them in Layers)` }) : null,
      r.notes ? h('div', { class: 'note', text: r.notes }) : null);
    box.appendChild(el);
  }
}

function fmtValue(v, unit) {
  const s = Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
  return unit ? `${s} ${unit}` : s;
}

function asciiGrid(app, r) {
  const g = r.grid;
  const [ox, oy] = app.manifest.origin;
  const lines = [`ncols ${g.cols}`, `nrows ${g.rows}`, `xllcorner ${(ox + g.minX - g.cell / 2).toFixed(3)}`,
    `yllcorner ${(oy + g.maxY - (g.rows - 0.5) * g.cell).toFixed(3)}`, `cellsize ${g.cell}`, 'NODATA_value -9999'];
  for (let r0 = 0; r0 < g.rows; r0++) {
    const vals = [];
    for (let c = 0; c < g.cols; c++) {
      const v = r.values[r0 * g.cols + c];
      vals.push(Number.isFinite(v) ? v.toFixed(3) : '-9999');
    }
    lines.push(vals.join(' '));
  }
  return lines.join('\n');
}

function fieldsCsv(fields) {
  const out = ['layer,feature_id,field,value'];
  for (const f of fields) f.values.forEach((v, i) => { if (Number.isFinite(v)) out.push(`"${f.layer.entry.name}",${i + 1},${f.name},${v}`); });
  return out.join('\n');
}

function percentile(arr, q) {
  const s = Array.from(arr).sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}
