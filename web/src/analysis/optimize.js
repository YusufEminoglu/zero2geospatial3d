// @ts-check
// Building-height optimisation: NSGA-II over the floor counts of selected
// buildings, trading floor area against sun on the open ground around them.
// Each candidate is evaluated with the GPU sun-hours pass at a coarse cell.
import { nsga2 } from '../core/nsga2.js';
import { sunPath } from '../core/solar.js';
import { typicalDoy } from '../core/weather.js';

/**
 * @param {any} app
 * @param {object} o
 * @param {{ layer: any, f: number }[]} o.targets
 * @param {number} o.floorHeight metres per floor
 * @param {number} o.minFloors
 * @param {number} o.maxFloors
 * @param {number} o.minGfa required floor area (m2), 0 for none
 * @param {{ month: number, day: number }} o.date
 * @param {number} o.startHour
 * @param {number} o.endHour
 * @param {number} o.margin metres of ground around the targets that are scored
 * @param {number} o.populationSize
 * @param {number} o.generations
 * @param {number} o.seed
 * @param {(g: any) => void} [o.onGeneration]
 * @param {() => boolean} [o.shouldStop]
 */
export async function optimiseHeights(app, o) {
  const { targets } = o;
  const s = app.site;
  const dirs = sunPath(typicalDoy(o.date.month, o.date.day), s.lat, s.lon, s.utcOffset,
    { startHour: o.startHour, endHour: o.endHour, stepMinutes: 30 });
  if (!dirs.length) throw new Error('No sun in the chosen period.');
  // Scored area: the targets' bounding box plus a margin, inside the scene.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const { layer, f } of targets) {
    const x = layer.centroid[f * 2], y = layer.centroid[f * 2 + 1];
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const sc = app.sceneArea();
  const area = { minX: Math.max(sc.minX, minX - o.margin), maxX: Math.min(sc.maxX, maxX + o.margin),
    minY: Math.max(sc.minY, minY - o.margin), maxY: Math.min(sc.maxY, maxY + o.margin) };
  const cell = Math.max(2, Math.sqrt(((area.maxX - area.minX) * (area.maxY - area.minY)) / 90000));
  const original = targets.map(({ layer, f }) => layer.heights[f]);
  const byLayer = new Map();
  for (const t of targets) { if (!byLayer.has(t.layer)) byLayer.set(t.layer, []); byLayer.get(t.layer).push(t.f); }
  const setFloors = (x) => {
    targets.forEach(({ layer, f }, i) => { layer.heights[f] = x[i] * o.floorHeight; });
    for (const [layer, fs] of byLayer) layer.applyHeightsFor(fs);
  };
  const gfa = (x) => targets.reduce((sum, { layer, f }, i) => sum + x[i] * layer.footprint[f], 0);
  const evaluate = async (x) => {
    setFloors(x);
    const run = await app.analyst.gridRun({ area, cell, directions: dirs, withIds: true });
    let sum = 0, n = 0, twoH = 0;
    for (let i = 0; i < run.values.length; i++) {
      if (run.ids[i] !== 0 || !Number.isFinite(run.values[i])) continue;
      sum += run.values[i]; n++;
      if (run.values[i] >= 2) twoH++;
    }
    const sun = n ? sum / n : 0;
    const area2 = gfa(x);
    return { objectives: [-sun, -area2], violation: o.minGfa > 0 ? Math.max(0, (o.minGfa - area2) / o.minGfa) : 0,
      extra: { sun, gfa: area2, twoHourShare: n ? twoH / n : 0 } };
  };
  const current = targets.map(({ layer, f }) => Math.max(o.minFloors, Math.min(o.maxFloors, Math.round(layer.heights[f] / o.floorHeight) || o.minFloors)));
  try {
    const baseline = await evaluate(current);
    const run = await nsga2({
      lower: targets.map(() => o.minFloors), upper: targets.map(() => o.maxFloors), integer: true,
      evaluate, seeds: [current, targets.map(() => o.minFloors), targets.map(() => o.maxFloors)]
    }, { populationSize: o.populationSize, generations: o.generations, seed: o.seed, onGeneration: o.onGeneration, shouldStop: o.shouldStop });
    return { ...run, baseline: { x: current, ...baseline }, area, cell, dirs: dirs.length };
  } finally {
    targets.forEach(({ layer, f }, i) => { layer.heights[f] = original[i]; });
    for (const [layer, fs] of byLayer) layer.applyHeightsFor(fs);
  }
}
