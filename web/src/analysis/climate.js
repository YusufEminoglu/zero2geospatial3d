// @ts-check
// A year of outdoor climate around each building, from an EPW file.
//
// The open ground within `ringMetres` of a building is that building's
// surroundings (each open cell goes to its nearest building). For it we take
// the sky view factor, the sheltering wind ratio per wind sector, and the
// sunlit share per sun position of the year (grouped into coarse sky bins).
// Then every hour of the chosen daily window is evaluated with the EPW
// weather: mean radiant temperature (SolarCal) and UTCI, pedestrian wind.
import { skyHemisphere, solarPosition, sunVector } from '../core/solar.js';
import { typicalDoy } from '../core/weather.js';
import { windRatio, OPEN_PEDESTRIAN_FACTOR } from '../core/wind.js';
import { meanRadiantTemperature, skyTemperature, utci } from '../core/comfort.js';
import { splitKey, ExtrudedLayer } from '../scene/objects.js';

const DEG = Math.PI / 180;

/**
 * Meteorological seasons as month groups (Dec-Feb, Mar-May, Jun-Aug,
 * Sep-Nov). Field codes name the months; the season names follow the
 * hemisphere: Dec-Feb is winter in the north and summer in the south.
 */
export const SEASONS = [['djf', 'Winter'], ['mam', 'Spring'], ['jja', 'Summer'], ['son', 'Autumn']];
export function seasonNames(lat) {
  return lat < 0 ? ['Summer', 'Autumn', 'Winter', 'Spring'] : SEASONS.map(([, name]) => name);
}
/** Month-group codes of summer and winter at a latitude. */
export function summerCode(lat) { return lat < 0 ? 'djf' : 'jja'; }
export function winterCode(lat) { return lat < 0 ? 'jja' : 'djf'; }
export function seasonOf(month) {
  return month === 12 || month <= 2 ? 0 : month <= 5 ? 1 : month <= 8 ? 2 : 3;
}

/** Open cells within `rings` steps of a building, labelled with its key (multi-source BFS). */
export function surroundings(ids, heights, cols, rows, rings, isBuilding) {
  const label = new Int32Array(cols * rows);
  const dist = new Uint16Array(cols * rows);
  let queue = [];
  for (let i = 0; i < ids.length; i++) {
    if (ids[i] && isBuilding(ids[i])) { label[i] = ids[i]; queue.push(i); }
  }
  for (let step = 1; step <= rings && queue.length; step++) {
    const next = [];
    for (const i of queue) {
      const c = i % cols, r = (i - c) / cols;
      const nb = [c > 0 ? i - 1 : -1, c < cols - 1 ? i + 1 : -1, r > 0 ? i - cols : -1, r < rows - 1 ? i + cols : -1];
      for (const j of nb) {
        if (j < 0 || label[j] || ids[j] || heights[j] > 0) continue;
        label[j] = label[i];
        dist[j] = step;
        next.push(j);
      }
    }
    queue = next;
  }
  // Building cells themselves are not "surroundings".
  for (let i = 0; i < ids.length; i++) if (ids[i]) label[i] = 0;
  return label;
}

/** A colour range that spreads the actual values (rounded to 5 %). */
function rangeOf(values) {
  let lo = Infinity, hi = -Infinity;
  for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!Number.isFinite(lo)) return { min: 0, max: 100 };
  return { min: Math.max(0, Math.floor(lo / 5) * 5), max: Math.min(100, Math.max(Math.floor(lo / 5) * 5 + 5, Math.ceil(hi / 5) * 5)) };
}

/** Mean of a per-cell array over each building's surroundings. */
function meansByKey(label, values) {
  const acc = new Map();
  for (let i = 0; i < label.length; i++) {
    const k = label[i];
    if (!k || !Number.isFinite(values[i])) continue;
    let a = acc.get(k);
    if (!a) { a = [0, 0]; acc.set(k, a); }
    a[0] += values[i];
    a[1]++;
  }
  const out = new Map();
  for (const [k, [s, n]] of acc) out.set(k, s / n);
  return out;
}

/**
 * @param {any} analyst  the Analyst (runners.js)
 * @param {object} o
 */
export async function climateAroundBuildings(analyst, { area, cell, sectors = 8, hourFrom = 7, hourTo = 22, ringMetres = 15, onProgress }) {
  const app = analyst.app;
  const w = app.weather;
  if (!w?.dryBulb) throw new Error('This analysis needs an EPW weather file (Layers > Scene > Load EPW, or pick one in QGIS).');
  const s = app.site;
  const prog = (a, b) => (f) => onProgress?.(a + (b - a) * f);
  // 1. Geometry, surroundings.
  const og = await analyst.obstacleGrid({ area, cell, onProgress: prog(0, 0.08) });
  const { grid } = og;
  const n = grid.cols * grid.rows;
  const buildingLayers = new Set(app.layers.filter((l) => l instanceof ExtrudedLayer && !l.isWall).map((l) => l.index));
  const label = surroundings(og.ids, og.heights, grid.cols, grid.rows, Math.max(1, Math.round(ringMetres / cell)),
    (key) => buildingLayers.has(splitKey(key).layerIndex));
  // 2. Sky view at pedestrian height.
  const sky = await analyst.gridRun({ area, cell, directions: skyHemisphere(96), cosMode: 1, lift: 1.1, onProgress: prog(0.08, 0.2) });
  const svfB = meansByKey(label, sky.values);
  // 3. Wind per sector from the EPW, sheltering ratio per sector.
  const sectorFreq = new Float64Array(sectors), sectorSpeed = new Float64Array(sectors);
  const seasonFreq = SEASONS.map(() => new Float64Array(sectors));
  const seasonSpeed = SEASONS.map(() => new Float64Array(sectors));
  const seasonHours = new Float64Array(4), seasonCalm = new Float64Array(4);
  let calmHours = 0, windowHours = 0;
  const inWindow = (i) => w.hour[i] - 1 >= hourFrom && w.hour[i] - 1 < hourTo;
  for (let i = 0; i < w.hours; i++) {
    if (!inWindow(i)) continue;
    windowHours++;
    const sea = seasonOf(w.month[i]);
    seasonHours[sea]++;
    if (w.windSpeed[i] < 0.5) { calmHours++; seasonCalm[sea]++; continue; }
    const k = Math.floor((((w.windDir[i] % 360) + 360) % 360) / (360 / sectors) + 0.5) % sectors;
    sectorFreq[k]++;
    sectorSpeed[k] += w.windSpeed[i];
    seasonFreq[sea][k]++;
    seasonSpeed[sea][k] += w.windSpeed[i];
  }
  const ratioB = new Map(); // key -> Float32Array(sectors)
  const annualWind = new Float32Array(n);
  for (let k = 0; k < sectors; k++) {
    if (!sectorFreq[k]) continue;
    sectorSpeed[k] /= sectorFreq[k];
    const ratio = await windRatio({ heights: og.heights, porosity: og.porosity, cols: grid.cols, rows: grid.rows, cell,
      windFromDeg: (k * 360) / sectors, onProgress: (f) => prog(0.2 + (0.25 * k) / sectors, 0.2 + (0.25 * (k + 1)) / sectors)(f) });
    const share = sectorFreq[k] / Math.max(1, windowHours);
    for (let i = 0; i < n; i++) if (Number.isFinite(ratio[i])) annualWind[i] += share * sectorSpeed[k] * ratio[i] * OPEN_PEDESTRIAN_FACTOR;
    for (const [key, m] of meansByKey(label, ratio)) {
      if (!ratioB.has(key)) ratioB.set(key, new Float32Array(sectors).fill(1));
      ratioB.get(key)[k] = m;
    }
  }
  for (let i = 0; i < n; i++) if (og.ids[i] || !Number.isFinite(sky.values[i])) annualWind[i] = NaN;
  // 4. Sun: coarse sky bins of the window's sun positions; sunlit share per bin.
  const binOfHour = new Int16Array(w.hours).fill(-1);
  const bins = new Map();
  const elevOfHour = new Float32Array(w.hours);
  for (let i = 0; i < w.hours; i++) {
    if (!inWindow(i)) continue;
    const p = solarPosition(typicalDoy(w.month[i], w.day[i]), w.hour[i] - 0.5, s.lat, s.lon, s.utcOffset);
    elevOfHour[i] = p.elevation / DEG;
    if (p.elevation <= 1 * DEG) continue;
    const key = Math.floor(p.elevation / (10 * DEG)) * 100 + Math.floor(p.azimuth / (15 * DEG));
    let b = bins.get(key);
    if (!b) { b = { id: bins.size, v: [0, 0, 0] }; bins.set(key, b); }
    const v = sunVector(p.elevation, p.azimuth);
    b.v[0] += v[0]; b.v[1] += v[1]; b.v[2] += v[2];
    binOfHour[i] = b.id;
  }
  const binList = [...bins.values()];
  const sunlitB = new Map(); // key -> Float32Array(bins)
  for (let j = 0; j < binList.length; j++) {
    const v = binList[j].v;
    const len = Math.hypot(v[0], v[1], v[2]) || 1;
    const run = await analyst.gridRun({ area, cell, directions: [{ dir: [v[0] / len, v[1] / len, v[2] / len], weight: 1 }], lift: 1.1,
      onProgress: prog(0.45 + (0.4 * j) / binList.length, 0.45 + (0.4 * (j + 1)) / binList.length) });
    for (const [key, m] of meansByKey(label, run.values)) {
      if (!sunlitB.has(key)) sunlitB.set(key, new Float32Array(binList.length));
      sunlitB.get(key)[j] = m;
    }
  }
  // 5. Every hour of the window, for every building.
  const keys = [...svfB.keys()];
  const blank = () => ({ comfort: 0, heat: 0, cold: 0, windSum: 0, windy: 0, hours: 0 });
  const stats = new Map(keys.map((k) => [k, { ...blank(), seasons: SEASONS.map(blank) }]));
  for (let i = 0; i < w.hours; i++) {
    if (!inWindow(i)) continue;
    const ta = w.dryBulb[i], rh = w.rh[i], ws = w.windSpeed[i];
    const k = ws < 0.5 ? -1 : Math.floor((((w.windDir[i] % 360) + 360) % 360) / (360 / sectors) + 0.5) % sectors;
    const tSky = skyTemperature(ta, w.ir[i]);
    const bin = binOfHour[i];
    const sea = seasonOf(w.month[i]);
    for (const key of keys) {
      const svf = svfB.get(key);
      const r = k < 0 ? 1 : (ratioB.get(key)?.[k] ?? 1);
      const sunlit = bin >= 0 ? (sunlitB.get(key)?.[bin] ?? 0) : 0;
      const tr = meanRadiantTemperature({ airTemp: ta, skyTemp: tSky, svf, sunlit, dni: w.dni[i], dhi: w.dhi[i], ghi: w.ghi[i], elevationDeg: elevOfHour[i] });
      const v10 = Math.max(0.5, Math.min(17, ws * r));
      const u = utci(ta, tr, v10, rh);
      const ped = ws * r * OPEN_PEDESTRIAN_FACTOR;
      const all = stats.get(key);
      for (const st of [all, all.seasons[sea]]) {
        st.hours++;
        if (u >= 9 && u < 26) st.comfort++;
        else if (u >= 32) st.heat++;
        else if (u < 0) st.cold++;
        st.windSum += ped;
        if (ped > 5) st.windy++;
      }
    }
    if (i % 400 === 0) { onProgress?.(0.85 + (0.15 * i) / w.hours); await new Promise((res) => setTimeout(res, 0)); }
  }
  // 6. Fields per building, a comfort halo grid, the wind map.
  const perLayer = new Map();
  const field = (layer, name) => {
    let m = perLayer.get(layer);
    if (!m) { m = new Map(); perLayer.set(layer, m); }
    if (!m.has(name)) m.set(name, new Float32Array(layer.count).fill(NaN));
    return m.get(name);
  };
  const comfortOfKey = new Map();
  const seasonComfortOfKey = SEASONS.map(() => new Map());
  const seasonal = new Map(); // key -> per-season summary for the report
  for (const [key, st] of stats) {
    const { layerIndex, id } = splitKey(key);
    const layer = app.layers.find((l) => l.index === layerIndex);
    if (!layer || !st.hours) continue;
    const f = id - 1;
    const pct = (100 * st.comfort) / st.hours;
    comfortOfKey.set(key, pct);
    field(layer, 'comfort_pct')[f] = pct;
    field(layer, 'heat_stress_h')[f] = st.heat;
    field(layer, 'cold_stress_h')[f] = st.cold;
    field(layer, 'ped_wind_ms')[f] = st.windSum / st.hours;
    field(layer, 'windy_pct')[f] = (100 * st.windy) / st.hours;
    field(layer, 'svf_ground')[f] = svfB.get(key);
    const rows = st.seasons.map((x) => (x.hours ? { comfort: (100 * x.comfort) / x.hours, heat: x.heat, cold: x.cold,
      wind: x.windSum / x.hours, windy: (100 * x.windy) / x.hours, hours: x.hours } : null));
    seasonal.set(key, rows);
    SEASONS.forEach(([code], s) => {
      if (!rows[s]) return;
      seasonComfortOfKey[s].set(key, rows[s].comfort);
      field(layer, `comfort_pct_${code}`)[f] = rows[s].comfort;
    });
    const summer = rows[SEASONS.findIndex(([code]) => code === summerCode(s.lat))];
    const winter = rows[SEASONS.findIndex(([code]) => code === winterCode(s.lat))];
    if (summer) field(layer, `heat_stress_h_${summerCode(s.lat)}`)[f] = summer.heat;
    if (winter) {
      field(layer, `cold_stress_h_${winterCode(s.lat)}`)[f] = winter.cold;
      field(layer, `ped_wind_ms_${winterCode(s.lat)}`)[f] = winter.wind;
      field(layer, `windy_pct_${winterCode(s.lat)}`)[f] = winter.windy;
    }
  }
  const fields = [];
  for (const [layer, m] of perLayer) for (const [name, values] of m) fields.push({ layer, name, values });
  const haloOf = (map) => {
    const out = new Float32Array(n).fill(NaN);
    for (let i = 0; i < n; i++) if (label[i] && map.has(label[i])) out[i] = map.get(label[i]);
    return out;
  };
  const halo = haloOf(comfortOfKey);
  const haloSeasons = { year: halo };
  SEASONS.forEach(([code], s) => { haloSeasons[code] = haloOf(seasonComfortOfKey[s]); });
  const allComfort = [...comfortOfKey.values(), ...seasonComfortOfKey.flatMap((m) => [...m.values()])];
  // Per-building wind roses for the report.
  const freq = Array.from(sectorFreq, (x) => x / Math.max(1, windowHours));
  const names = seasonNames(s.lat);
  const bySeason = SEASONS.map(([code], k) => ({ code, name: names[k],
    freq: Array.from(seasonFreq[k], (x) => x / Math.max(1, seasonHours[k])),
    speed: Array.from(seasonSpeed[k], (x, j) => (seasonFreq[k][j] ? x / seasonFreq[k][j] : 0)),
    calm: seasonCalm[k] / Math.max(1, seasonHours[k]) }));
  app.climateRoses = { sectors, freq, speed: Array.from(sectorSpeed), calm: calmHours / Math.max(1, windowHours), ratios: ratioB,
    window: [hourFrom, hourTo], source: w.location.city || app.weatherSource, bySeason };
  app.climateSeasonal = seasonal;
  const windowLabel = `${String(hourFrom).padStart(2, '0')}:00–${String(hourTo).padStart(2, '0')}:00`;
  let sum = 0, cnt = 0;
  for (const v of comfortOfKey.values()) { sum += v; cnt++; }
  let windMax = 1;
  for (const v of annualWind) if (v > windMax) windMax = v; // no spread: the grid can hold millions of cells
  return [{
    kind: 'climate', title: 'Comfortable hours around buildings (year)', subtitle: `${windowLabel}, ${w.location.city || 'EPW'}; UTCI 9–26 °C`,
    unit: '%', grid, values: halo, ids: og.ids, display: { ...rangeOf(allComfort), ramp: 'rdylbu' }, fields,
    seasonal: haloSeasons, season: 'year',
    stats: [['Buildings', String(cnt)], ['Mean comfortable share', `${cnt ? (sum / cnt).toFixed(0) : 0} %`],
      ['Hours evaluated per building', String(windowHours)], ['Sun positions', String(binList.length)]],
    notes: 'Each building\'s surroundings: open ground within ' + ringMetres + ' m. Hourly UTCI from the EPW weather with the local sky view, sun and sheltered wind (screening model). Fields: comfort_pct, heat_stress_h, cold_stress_h, ped_wind_ms, windy_pct, svf_ground; per month group (djf = Dec–Feb …) comfort_pct_djf/mam/jja/son; summer heat_stress_h and winter cold_stress_h, ped_wind_ms and windy_pct of the hemisphere\'s summer and winter months.'
  }, {
    kind: 'windyear', title: 'Annual pedestrian wind', subtitle: `${windowLabel}, frequency-weighted over ${sectors} directions`,
    unit: 'm/s', grid, values: annualWind, ids: og.ids, display: { min: 0, max: Math.ceil(windMax), ramp: 'spectral-r' },
    fields: [], stats: [['Calm hours', `${((100 * calmHours) / Math.max(1, windowHours)).toFixed(0)} %`]],
    notes: 'Mean of the sheltered pedestrian wind over the year (screening, not CFD).'
  }];
}
