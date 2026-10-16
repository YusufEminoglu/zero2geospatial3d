// @ts-check
// Terrain analyses as results: elevation, slope, aspect, hillshade,
// curvature, topographic position, ruggedness and wetness of the DEM. Each is
// a grid result like sun hours or sky view, so it can be drawn on the ground,
// put in a compare panel and sent to QGIS as a GeoTIFF.
import { slopeAspect, hillshade, gridStats } from '../core/terrain_math.js';
import { cropGrid, curvature, tpi, ruggedness, aspectClasses, flowAccumulation, wetness, percentile } from '../core/terrain_analysis.js';

export const TERRAIN_ANALYSES = [
  { id: 'elevation', label: 'Elevation', help: 'Height above sea level of the DEM.' },
  { id: 'slope', label: 'Slope', help: 'Steepness in degrees (Horn 1981), with the area in slope bands.' },
  { id: 'aspect', label: 'Aspect', help: 'The compass direction the slope faces, in eight classes; ground under 1° is flat.' },
  { id: 'hillshade', label: 'Hillshade', help: 'Relief lit from the north-west at 45°.' },
  { id: 'curvature', label: 'Curvature', help: 'Convex ground (crests, ridges) positive, concave ground (hollows, valleys) negative.' },
  { id: 'tpi', label: 'Topographic position', help: 'Height above (+) or below (−) the mean of the surroundings within the radius: ridges and valleys at that scale.' },
  { id: 'tri', label: 'Ruggedness', help: 'Terrain ruggedness index (Riley 1999): how much the height changes between neighbouring cells.' },
  { id: 'twi', label: 'Wetness index', help: 'Topographic wetness index ln(a / tan β): where water collects and the ground stays wet. From the DEM alone, without soil or drains.' }
];

export const ASPECT_COLORS = { 0: '#b8b8b8', 1: '#e63b2e', 2: '#f39a2b', 3: '#f2df3a', 4: '#78c04a', 5: '#3cb7a4', 6: '#3f8fd2', 7: '#5b55b5', 8: '#c24d9c' };
export const ASPECT_LABELS = { 0: 'Flat', 1: 'North', 2: 'North-east', 3: 'East', 4: 'South-east', 5: 'South', 6: 'South-west', 7: 'West', 8: 'North-west' };

const pct = (n, total) => `${((100 * n) / Math.max(1, total)).toFixed(1)} %`;
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A symmetric range around 0 that holds 98 % of the values. */
function symmetric(values, floor) {
  const m = Math.max(Math.abs(percentile(values, 0.01)), Math.abs(percentile(values, 0.99)), floor);
  return { min: -m, max: m };
}

/**
 * Run the chosen terrain analyses.
 * @param {any} app
 * @param {{ kinds: string[], extent?: 'scene' | 'area', tpiRadius?: number, maxCells?: number, onProgress?: (f: number) => void }} o
 */
export async function terrainAnalyses(app, { kinds, extent = 'scene', tpiRadius = 100, maxCells = 4_000_000, onProgress }) {
  if (!kinds.length) throw new Error('Tick at least one terrain analysis.');
  const t = app.terrain;
  const area = extent === 'area' ? app.area() : app.sceneArea();
  const g = cropGrid(t.grid, area, maxCells);
  const where = `${extent === 'area' ? 'Analysis area' : 'Whole DEM'}, ${g.cell.toFixed(g.cell < 10 ? 1 : 0)} m cells${g.factor > 1 ? ` (DEM ×${g.factor} coarser)` : ''}`;
  const want = new Set(kinds);
  const steps = kinds.length + (want.has('twi') ? 1 : 0);
  let done = 0;
  const step = async () => { onProgress?.(++done / steps); await tick(); };
  // groundOnly: a map of the ground itself is not drawn on roofs.
  const base = (title, values, unit, display, extra = {}) => ({ kind: 'terrain', title, subtitle: where, unit, grid: g, values, display, fields: [], groundOnly: true, ...extra });
  const out = [];
  let sa = null;
  const slopeAsp = () => (sa ??= slopeAspect(g));
  const elevStats = gridStats(g.values);
  if (want.has('elevation')) {
    out.push(base('Elevation', g.values, 'm', { min: elevStats.min, max: elevStats.max, ramp: 'terrain' }, {
      stats: [['Lowest', `${elevStats.min.toFixed(1)} m`], ['Highest', `${elevStats.max.toFixed(1)} m`], ['Mean', `${elevStats.mean.toFixed(1)} m`],
        ['Relief', `${(elevStats.max - elevStats.min).toFixed(1)} m`]] }));
    await step();
  }
  if (want.has('slope')) {
    const { slope } = slopeAsp();
    // Bands in percent rise (100 % = 45°), as slopes are usually quoted in planning.
    const bands = [5, 10, 15, 30];
    const counts = new Array(bands.length + 1).fill(0);
    let n = 0;
    for (const s of slope) {
      if (!Number.isFinite(s)) continue;
      n++;
      const rise = 100 * Math.tan((s * Math.PI) / 180);
      let k = 0;
      while (k < bands.length && rise >= bands[k]) k++;
      counts[k]++;
    }
    const st = gridStats(slope);
    const labels = ['under 5 %', '5–10 %', '10–15 %', '15–30 %', '30 % and over'];
    out.push(base('Slope', slope, '°', { min: 0, max: Math.max(5, percentile(slope, 0.99)), ramp: 'spectral-r' }, {
      stats: [['Mean', `${st.mean.toFixed(1)}° (${(100 * Math.tan((st.mean * Math.PI) / 180)).toFixed(0)} %)`], ['Steepest', `${st.max.toFixed(1)}°`],
        ...labels.map((l, k) => [`Area ${l}`, pct(counts[k], n)])],
      notes: 'Percent rise = 100 × tan(slope); 100 % is 45°.' }));
    await step();
  }
  if (want.has('aspect')) {
    const { slope, aspect } = slopeAsp();
    const cls = aspectClasses(slope, aspect, 1);
    const counts = new Map();
    let n = 0;
    for (const v of cls) if (Number.isFinite(v)) { counts.set(v, (counts.get(v) || 0) + 1); n++; }
    const keys = [...counts.keys()].sort((a, b) => a - b);
    out.push(base('Aspect', cls, '', { min: 0, max: 8, categorical: ASPECT_COLORS, labels: ASPECT_LABELS }, {
      legend: keys.map((k) => ({ color: ASPECT_COLORS[k], label: ASPECT_LABELS[k] })),
      stats: keys.map((k) => [ASPECT_LABELS[k], pct(counts.get(k), n)]),
      notes: 'The direction a slope faces (downhill). South-facing slopes get the most sun in the northern hemisphere.' }));
    await step();
  }
  if (want.has('hillshade')) {
    out.push(base('Hillshade', hillshade(g, 315, 45, 1), '', { min: 0, max: 1, ramp: 'greys' }, { stats: [['Light from', 'north-west, 45° high']] }));
    await step();
  }
  if (want.has('curvature')) {
    const cv = curvature(g);
    const st = gridStats(cv);
    out.push(base('Curvature', cv, '1/100 m', { ...symmetric(cv, 0.01), ramp: 'rdbu-r' }, {
      stats: [['Most convex', st.max.toFixed(3)], ['Most concave', st.min.toFixed(3)]],
      notes: 'General curvature (Zevenbergen and Thorne 1987) in 1/100 m. Red: convex (crests); blue: concave (hollows), where water and cold air gather.' }));
    await step();
  }
  if (want.has('tpi')) {
    const R = Math.max(1, Math.round(tpiRadius / g.cell));
    const v = tpi(g, R);
    let ridge = 0, valley = 0, n = 0;
    for (const x of v) { if (!Number.isFinite(x)) continue; n++; if (x > 1) ridge++; else if (x < -1) valley++; }
    out.push(base(`Topographic position (${Math.round(R * g.cell)} m)`, v, 'm', { ...symmetric(v, 0.5), ramp: 'rdbu-r' }, {
      stats: [['Above surroundings by 1 m+', pct(ridge, n)], ['Below surroundings by 1 m+', pct(valley, n)], ['Window', `${2 * R + 1} × ${2 * R + 1} cells`]],
      notes: 'Height minus the mean height within the radius (Weiss 2001). Red: ridges and hilltops at that scale; blue: valleys and hollows.' }));
    await step();
  }
  if (want.has('tri')) {
    const v = ruggedness(g);
    const st = gridStats(v);
    out.push(base('Ruggedness', v, 'm', { min: 0, max: Math.max(0.1, percentile(v, 0.99)), ramp: 'magma-r' }, {
      stats: [['Mean', `${st.mean.toFixed(2)} m`], ['Highest', `${st.max.toFixed(2)} m`]],
      notes: 'Terrain ruggedness index (Riley et al. 1999) at the cell size; it grows with the cell size.' }));
    await step();
  }
  if (want.has('twi')) {
    const { slope } = slopeAsp();
    const { acc } = flowAccumulation(g);
    await step();
    const v = wetness(g, slope, acc);
    const st = gridStats(v);
    const hi = percentile(v, 0.9);
    out.push(base('Wetness index', v, '', { min: percentile(v, 0.02), max: percentile(v, 0.99), ramp: 'blues' }, {
      stats: [['Mean', st.mean.toFixed(2)], ['Wettest 10 % above', hi.toFixed(2)], ['Largest catchment', `${((maxOf(acc) * g.cell * g.cell) / 10000).toFixed(1)} ha`]],
      notes: 'ln(a / tan β) (Beven and Kirkby 1979): D8 flow on the depression-filled DEM. Buildings, drains and soil are not in it; a screening map of where water gathers. Near the DEM edge catchments are cut short, so values there are less reliable.' }));
    await step();
  }
  onProgress?.(1);
  return out;
}

/** The largest finite value, without spreading a huge array into Math.max. */
function maxOf(values) {
  let m = -Infinity;
  for (const v of values) if (Number.isFinite(v) && v > m) m = v;
  return m;
}
