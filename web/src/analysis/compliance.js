// @ts-check
// Planning check: pass / fail of each building against sun, daylight, wind
// and heat criteria, with the analyses it needs run on demand.
//
// These are screening proxies of the named guidance, not formal assessments:
// BRE 209 (Site layout planning for daylight and sunlight, 3rd ed. 2022) asks
// for VSC on window centres with an overcast sky; here the facade sky view
// factor stands in for it.
import { sunPath } from '../core/solar.js';
import { typicalDoy } from '../core/weather.js';
import { surroundings, summerCode } from './climate.js';
import { featureKey, splitKey, ExtrudedLayer } from '../scene/objects.js';

export const CRITERIA = [
  { id: 'amenity_sun', label: 'Sun on surrounding open ground (21 Mar)', short: 'Amenity sun',
    unit: '%', test: 'min', threshold: 50,
    help: 'Share of the open ground within 15 m that gets at least 2 h of sun on 21 March. BRE 209: at least half of an amenity area.' },
  { id: 'facade_vsc', label: 'Daylight on the walls (VSC)', short: 'Daylight',
    unit: '%', test: 'min', threshold: 27,
    help: 'Mean vertical sky component of the walls under the CIE overcast sky. BRE 209: 27 % or more at a window keeps enough daylight (39.6 % is an open wall).' },
  { id: 'neighbour_daylight', label: 'Daylight kept after scenario B (VSC B / A)', short: 'B / A daylight',
    unit: '×', test: 'min', threshold: 0.8,
    help: 'Wall VSC with scenario B divided by that with A. BRE 209: less than 0.8 times the former value is a noticeable loss. Needs "Run A vs B" with daylight (VSC).' },
  { id: 'wind', label: 'Windy hours around it', short: 'Wind',
    unit: '%', test: 'max', threshold: 5,
    help: 'Share of the hours with pedestrian wind above 5 m/s (needs the climate year and an EPW).' },
  { id: 'heat', label: 'Summer heat-stress hours around it', short: 'Summer heat',
    unit: 'h', test: 'max', threshold: 300,
    help: 'Summer hours with UTCI of 32 °C or more on the surrounding ground (needs the climate year and an EPW). The limit is a project choice.' },
  { id: 'facade_noise', label: 'Max facade noise level (Lden)', short: 'Facade noise',
    unit: 'dB(A)', test: 'max', threshold: 65,
    help: 'Highest road traffic noise level at the building perimeter. 65 dB Lden is a common noise action-plan level; the WHO 2018 guideline for road traffic is 53 dB.' },
  { id: 'green_view', label: 'Green View Index around it (GVI)', short: 'Green view',
    unit: '%', test: 'min', threshold: 15,
    help: 'Mean pedestrian-level Green View Index on the surrounding open ground.' }
];

export const PROFILE_FORMAT = '02geo3d-planning-profile';
// Criteria renamed since a profile may have been saved: the old id switches
// the new criterion on, but its threshold is not carried over (other units).
const RENAMED = { facade_daylight: 'facade_vsc' };

/** The built-in profile: every criterion at its default threshold. */
export function defaultProfile() {
  return { name: 'Defaults (BRE 209 proxies)', criteria: CRITERIA.map((c) => c.id), thresholds: Object.fromEntries(CRITERIA.map((c) => [c.id, c.threshold])) };
}

/** A profile as a JSON file: name, the criteria in use and their thresholds. */
export function profileJson(p) {
  return JSON.stringify({
    format: PROFILE_FORMAT, version: 1, name: p.name || 'Planning profile',
    criteria: CRITERIA.map((c) => ({ id: c.id, label: c.label, unit: c.unit, test: c.test === 'min' ? 'at least' : 'at most',
      enabled: p.criteria.includes(c.id), threshold: p.thresholds[c.id] ?? c.threshold }))
  }, null, 2);
}

/**
 * Read a profile file. Unknown criteria are ignored, missing ones keep their
 * default and stay off; a threshold must be a finite number.
 * @returns {{ name: string, criteria: string[], thresholds: Record<string, number>, ignored: string[] }}
 */
export function parseProfile(text) {
  let data;
  try { data = typeof text === 'string' ? JSON.parse(text) : text; } catch { throw new Error('This file is not JSON.'); }
  if (!data || data.format !== PROFILE_FORMAT || !Array.isArray(data.criteria)) throw new Error('This is not a planning-check profile.');
  const known = new Map(CRITERIA.map((c) => [c.id, c]));
  const out = defaultProfile();
  out.name = String(data.name || 'Planning profile').slice(0, 80);
  out.criteria = [];
  const ignored = [];
  for (const item of data.criteria) {
    const renamed = RENAMED[item?.id];
    if (renamed) {
      if (item.enabled !== false && !out.criteria.includes(renamed)) out.criteria.push(renamed);
      continue;
    }
    const c = known.get(item?.id);
    if (!c) { ignored.push(String(item?.id)); continue; }
    const v = Number(item.threshold);
    if (item.threshold !== undefined && item.threshold !== null && Number.isFinite(v)) out.thresholds[c.id] = v;
    if (item.enabled !== false) out.criteria.push(c.id);
  }
  return { ...out, ignored };
}

/** Pass (true), fail (false) or not available (null) for one value. */
export function judge(criterion, value) {
  if (!Number.isFinite(value)) return null;
  return criterion.test === 'min' ? value >= criterion.threshold : value <= criterion.threshold;
}

/** Buildings to check: the selection, scenario B layers, all in the area, or a given list ('targets'). */
export function scopeBuildings(app, scope, targets = null) {
  if (scope === 'targets') return [...(targets || [])];
  const out = [];
  const layers = app.layers.filter((l) => l instanceof ExtrudedLayer && !l.isWall);
  if (scope === 'selected') {
    for (const l of layers) for (const f of app.selectedIndices(l)) out.push({ layer: l, f });
  } else if (scope === 'scenarioB') {
    for (const l of layers.filter((x) => x.entry.scenario === 'B')) for (let f = 0; f < l.count; f++) out.push({ layer: l, f });
  } else {
    const a = app.area();
    for (const l of layers) {
      if (!l.visible) continue;
      for (let f = 0; f < l.count; f++) {
        const x = l.centroid[f * 2], y = l.centroid[f * 2 + 1];
        if (x >= a.minX && x <= a.maxX && y >= a.minY && y <= a.maxY) out.push({ layer: l, f });
      }
    }
  }
  return out;
}

function areaAround(app, targets, margin = 150) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const { layer, f } of targets) {
    const x = layer.centroid[f * 2], y = layer.centroid[f * 2 + 1];
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const sc = app.sceneArea();
  return { minX: Math.max(sc.minX, minX - margin), maxX: Math.min(sc.maxX, maxX + margin),
    minY: Math.max(sc.minY, minY - margin), maxY: Math.min(sc.maxY, maxY + margin) };
}

/**
 * Run the check.
 * @param {any} app
 * @param {{ scope: string, criteria: string[], thresholds: Record<string, number>, onProgress?: (f: number) => void }} o
 */
export async function planningCheck(app, { scope, criteria, thresholds, profile = '', targets: given = null, fresh = false, onProgress }) {
  const targets = scopeBuildings(app, scope, given);
  if (!targets.length) throw new Error(scope === 'selected' ? 'Select buildings first (click, Shift+click, or select them in QGIS).' : 'No buildings to check.');
  const active = CRITERIA.filter((c) => criteria.includes(c.id)).map((c) => ({ ...c, threshold: thresholds[c.id] ?? c.threshold }));
  const area = scope === 'area' ? app.area() : areaAround(app, targets);
  const cell = Math.max(1, Math.min(2, app.analyst.defaultCell(area, 1024)));
  const a = app.analyst;
  const values = new Map(active.map((c) => [c.id, new Map()])); // id -> key -> value
  const keyOf = ({ layer, f }) => featureKey(layer.index, f + 1);
  const want = new Set(targets.map(keyOf));
  const step = (k) => (f) => onProgress?.((k + f) / 4);
  // 1. Amenity sun: 2 h on 21 March over each building's surroundings.
  if (values.has('amenity_sun')) {
    const s = app.site;
    const dirs = sunPath(typicalDoy(3, 21), s.lat, s.lon, s.utcOffset, { stepMinutes: 10 });
    const run = await a.gridRun({ area, cell, directions: dirs, withIds: true, lift: 0.3, onProgress: step(0) });
    const label = surroundings(run.ids, new Float32Array(run.ids.length), run.grid.cols, run.grid.rows, Math.round(15 / cell), (k) => want.has(k));
    const acc = new Map();
    for (let i = 0; i < label.length; i++) {
      const k = label[i];
      if (!k || !Number.isFinite(run.values[i])) continue;
      const v = acc.get(k) || [0, 0];
      v[1]++;
      if (run.values[i] >= 2) v[0]++;
      acc.set(k, v);
    }
    for (const [k, [ok, n]] of acc) values.get('amenity_sun').set(k, (100 * ok) / n);
  }
  // 2. Daylight on the walls: vertical sky component.
  if (values.has('facade_vsc')) {
    const res = await a.daylightVsc({ area, directions: 192, onProgress: step(1) });
    for (const fld of res[0].fields) {
      fld.layer.setResultField(fld.name, fld.values);
      if (fld.name !== 'vsc_facade') continue;
      fld.values.forEach((v, i) => { if (Number.isFinite(v)) values.get('facade_vsc').set(featureKey(fld.layer.index, i + 1), v); });
    }
  }
  // 3. Neighbour daylight after scenario B (from a previous "Run A vs B" with daylight).
  if (values.has('neighbour_daylight')) {
    for (const t of targets) {
      const A = t.layer.extraFields.get('vsc_facade_A')?.[t.f];
      const B = t.layer.extraFields.get('vsc_facade_B')?.[t.f];
      if (Number.isFinite(A) && Number.isFinite(B) && A > 0) values.get('neighbour_daylight').set(keyOf(t), B / A);
    }
  }
  // 4-5. Wind and summer heat from the climate year (run it if an EPW exists).
  const needClimate = values.has('wind') || values.has('heat');
  if (needClimate && app.weather?.dryBulb) {
    // fresh: heights have changed since the stored climate fields were made.
    const missing = fresh || targets.some((t) => !Number.isFinite(t.layer.extraFields.get('windy_pct')?.[t.f]));
    if (missing) {
      const res = await a.climateYear({ area, cell: Math.max(2, cell), sectors: 8, hourFrom: 7, hourTo: 22, ringMetres: 15, onProgress: step(2) });
      for (const fld of res[0].fields) fld.layer.setResultField(fld.name, fld.values);
    }
    for (const t of targets) {
      const k = keyOf(t);
      if (values.has('wind')) values.get('wind').set(k, t.layer.extraFields.get('windy_pct')?.[t.f]);
      if (values.has('heat')) values.get('heat').set(k, t.layer.extraFields.get(`heat_stress_h_${summerCode(app.site.lat)}`)?.[t.f]);
    }
  }
  // 6. Facade noise level (Lden).
  if (values.has('facade_noise')) {
    const missing = fresh || targets.some((t) => !Number.isFinite(t.layer.extraFields.get('noise_dba_max')?.[t.f]));
    if (missing) {
      const res = await a.noise({ area, cell: Math.max(2, cell) });
      for (const fld of res[0].fields) fld.layer.setResultField(fld.name, fld.values);
    }
    for (const t of targets) {
      values.get('facade_noise').set(keyOf(t), t.layer.extraFields.get('noise_dba_max')?.[t.f]);
    }
  }
  // 7. Green View Index (GVI).
  if (values.has('green_view')) {
    const missing = fresh || targets.some((t) => !Number.isFinite(t.layer.extraFields.get('gvi_pct')?.[t.f]));
    if (missing) {
      const res = await a.greenView({ area, cell: Math.max(2, cell) });
      for (const fld of res[0].fields) fld.layer.setResultField(fld.name, fld.values);
    }
    for (const t of targets) {
      values.get('green_view').set(keyOf(t), t.layer.extraFields.get('gvi_pct')?.[t.f]);
    }
  }
  onProgress?.(1);
  // Verdicts.
  const rows = targets.map((t) => {
    const k = keyOf(t);
    const props = t.layer.features[t.f].properties;
    const checks = active.map((c) => {
      const v = values.get(c.id).get(k);
      return { id: c.id, value: Number.isFinite(v) ? v : NaN, pass: judge(c, v) };
    });
    const failed = checks.filter((c) => c.pass === false).length;
    const passed = checks.filter((c) => c.pass === true).length;
    return { key: k, layer: t.layer, f: t.f, name: String(props.name || props.NAME || `#${t.f + 1}`), height: t.layer.heights[t.f], checks, failed, passed };
  });
  rows.sort((p, q) => q.failed - p.failed || p.name.localeCompare(q.name));
  // Fields: per criterion 1 / 0, and the number failed.
  const fields = [];
  const byLayer = new Map();
  for (const r of rows) {
    let m = byLayer.get(r.layer);
    if (!m) {
      m = { failed: new Float32Array(r.layer.count).fill(NaN), per: new Map(active.map((c) => [c.id, new Float32Array(r.layer.count).fill(NaN)])) };
      byLayer.set(r.layer, m);
    }
    m.failed[r.f] = r.failed;
    for (const ch of r.checks) if (ch.pass !== null) m.per.get(ch.id)[r.f] = ch.pass ? 1 : 0;
  }
  for (const [layer, m] of byLayer) {
    fields.push({ layer, name: 'check_failed', values: m.failed });
    for (const [id, v] of m.per) fields.push({ layer, name: `check_${id}`, values: v });
  }
  const passAll = rows.filter((r) => r.failed === 0 && r.passed > 0).length;
  const stats = [['Buildings checked', String(rows.length)], ['Pass every available check', `${passAll} (${Math.round((100 * passAll) / rows.length)} %)`]];
  for (const c of active) {
    const judged = rows.map((r) => r.checks.find((x) => x.id === c.id)).filter((x) => x.pass !== null);
    stats.push([c.short, judged.length ? `${judged.filter((x) => x.pass).length} / ${judged.length} pass` : 'n/a']);
  }
  const result = {
    kind: 'compliance', title: 'Planning check', subtitle: `${rows.length} buildings · ${active.length} criteria`, unit: '',
    fields, stats, rows, criteria: active, scope, profile,
    legend: [{ color: '#2e9e5b', label: 'Passes every check' }, { color: '#f0b429', label: 'Fails one' }, { color: '#d64545', label: 'Fails two or more' },
      { color: '#c9c9c9', label: 'Not checked' }],
    notes: 'Screening proxies of the named guidance (BRE 209 for sun and daylight); confirm borderline cases with a formal assessment.'
  };
  // In QGIS: the same three colours on check_failed, in 2D and in the 3D view.
  const hex = (rgb) => `#${rgb.map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('')}`;
  result.qgisStyle = {
    field: 'check_failed',
    categories: [{ value: 0, color: hex(VERDICT[0]), label: 'Passes every check' }, { value: 1, color: hex(VERDICT[1]), label: 'Fails one' },
      ...[2, 3, 4, 5].map((k) => ({ value: k, color: hex(VERDICT[2]), label: `Fails ${k} checks` }))],
    other: { color: '#c9c9c9', label: 'Not checked' }
  };
  // Show it as building colours while the result is on screen.
  result.onShow = () => paintVerdicts(app, rows);
  result.onHide = () => { for (const l of app.layers) if (l instanceof ExtrudedLayer) app.recolor(l); };
  return [result];
}

const VERDICT = { 0: [0.18, 0.62, 0.36], 1: [0.94, 0.71, 0.16], 2: [0.84, 0.27, 0.27] };
function paintVerdicts(app, rows) {
  const touched = new Set();
  for (const l of app.layers) {
    if (!(l instanceof ExtrudedLayer) || l.isWall) continue;
    for (let f = 0; f < l.count; f++) l.colors.set([0.79, 0.79, 0.79], f * 3);
    touched.add(l);
  }
  for (const r of rows) r.layer.colors.set(VERDICT[Math.min(2, r.failed)], r.f * 3);
  for (const l of touched) l.applyColors();
}

export { splitKey };
