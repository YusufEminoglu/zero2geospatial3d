// @ts-check
// Building-height optimisation: NSGA-II over the floor counts of selected
// buildings, trading floor area against sun on the open ground around them,
// optionally within planning constraints. Each candidate is evaluated with
// one GPU sun-hours pass at a coarse cell; the constraints add no pass of
// their own:
//   - sun on the ground around each building reuses that pass, with the
//     open ground shared out among the buildings once (footprints do not
//     change, only heights);
//   - the BRE 209 25° test for neighbouring windows is prepared once from
//     the footprints and is a few multiplications per design.
// Both follow BRE 209 for places that are built up already: meet the limit,
// or keep at least 0.8 times the value now (VSC for windows, sunny area for
// open ground). "Now" is the current design as the optimiser sees it
// (heights rounded to whole floors).
// Analyses too slow to run per design (sky view, the climate year) belong to
// the planning check of the design that is finally chosen.
import { nsga2 } from '../core/nsga2.js';
import { sunPath } from '../core/solar.js';
import { typicalDoy } from '../core/weather.js';
import { surroundings } from './climate.js';
import { featureKey, ExtrudedLayer } from '../scene/objects.js';
import { prepareRule, checkRule, reach25, BRE_FACTOR } from '../core/daylight_rule.js';

/** Height of the centre of a neighbour's lowest window above its floor (m). */
export const WINDOW_HEIGHT = 1.6;

/** Shadow-map size whose texels are at most half a cell over the depth camera's view (1024..4096). */
export function optimiserDepthResolution(area, cell, margin) {
  const side = 2 * (Math.max(area.maxX - area.minX, area.maxY - area.minY) / 2 + margin);
  let size = 1024;
  while (size < 4096 && side / size > cell / 2) size *= 2;
  return size;
}

function outerRings(geometry) {
  if (!geometry) return [];
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  return polys.map((p) => p[0]).filter((r) => r && r.length >= 3);
}

/** Bounding box of rings of [x, y] points. */
function ringsBox(rings) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const ring of rings) for (const [x, y] of ring) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  return { minX, maxX, minY, maxY };
}

/** The 25° test prepared for the targets and the other buildings around them. */
function prepareDaylight(app, targets, o, topsNow) {
  const targetSet = new Set(targets.map(({ layer, f }) => `${layer.index}:${f}`));
  const tallest = Math.max(...targets.map(({ layer, f }) => layer.baseZ[f])) + o.maxFloors * o.floorHeight;
  const tg = targets.map(({ layer, f }) => ({ rings: outerRings(layer.features[f].geometry) }));
  const box = ringsBox(tg.flatMap((t) => t.rings));
  // Every other building, then only those whose footprint comes within the
  // 25° reach of the tallest allowed roof (measured from the target walls,
  // not from the scored area): windows farther away pass the 25° test alone.
  const candidates = [];
  for (const layer of app.layers) {
    if (!(layer instanceof ExtrudedLayer) || layer.isWall || !layer.visible) continue;
    for (let f = 0; f < layer.count; f++) {
      if (targetSet.has(`${layer.index}:${f}`)) continue;
      const windowZ = layer.baseZ[f] + layer.minH[f] + WINDOW_HEIGHT;
      for (const ring of outerRings(layer.features[f].geometry)) candidates.push({ ring, windowZ, box: ringsBox([ring]) });
    }
  }
  const lowest = candidates.length ? Math.min(...candidates.map((n) => n.windowZ)) : 0;
  const reach = reach25(tallest - lowest) + 1;
  const neighbours = candidates
    .filter((n) => n.box.maxX >= box.minX - reach && n.box.minX <= box.maxX + reach
      && n.box.maxY >= box.minY - reach && n.box.minY <= box.maxY + reach)
    .map(({ ring, windowZ }) => ({ ring, windowZ }));
  return prepareRule(neighbours, tg, topsNow, { maxDist: reach });
}

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
 * @param {{ amenity?: { on: boolean, share: number, radius?: number }, daylight?: { on: boolean } }} [o.constraints]
 *   amenity: at least `share` (0..1) of the open ground within `radius` m of each target gets 2 h of sun on the day;
 *   daylight: the BRE 209 25° test for the windows of the buildings around them.
 * @param {(g: any) => void} [o.onGeneration]
 * @param {() => boolean} [o.shouldStop]
 */
export async function optimiseHeights(app, o) {
  const { targets } = o;
  const cons = o.constraints || {};
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
  // Shadow maps fine enough for the coarse cell: same ranking of designs as the
  // full analysis (checked against it), at a fraction of the cost.
  const depthResolution = optimiserDepthResolution(area, cell, app.analyst.occluderMargin());
  const original = targets.map(({ layer, f }) => layer.heights[f]);
  const byLayer = new Map();
  for (const t of targets) { if (!byLayer.has(t.layer)) byLayer.set(t.layer, []); byLayer.get(t.layer).push(t.f); }
  const setFloors = (x) => {
    targets.forEach(({ layer, f }, i) => { layer.heights[f] = x[i] * o.floorHeight; });
    for (const [layer, fs] of byLayer) layer.applyHeightsFor(fs);
  };
  const gfa = (x) => targets.reduce((sum, { layer, f }, i) => sum + x[i] * layer.footprint[f], 0);
  const roofs = (x) => targets.map(({ layer, f }, i) => layer.baseZ[f] + x[i] * o.floorHeight);

  const current = targets.map(({ layer, f }) => Math.max(o.minFloors, Math.min(o.maxFloors, Math.round(layer.heights[f] / o.floorHeight) || o.minFloors)));
  const amenity = cons.amenity?.on ? { share: cons.amenity.share, radius: cons.amenity.radius ?? 15 } : null;
  const daylight = cons.daylight?.on ? prepareDaylight(app, targets, o, roofs(current)) : null;
  const keyIndex = new Map(targets.map(({ layer, f }, i) => [featureKey(layer.index, f + 1), i]));
  // Footprints do not change between designs: building ids are drawn once,
  // and the open ground is shared out among the targets once.
  let ids = null, owner = null, nowShare = null;
  const okCells = new Int32Array(targets.length), allCells = new Int32Array(targets.length);

  const evaluate = async (x) => {
    setFloors(x);
    const run = await app.analyst.gridRun({ area, cell, directions: dirs, withIds: !ids, depthResolution, lock: false });
    if (!ids) {
      ids = run.ids;
      if (amenity) {
        const label = surroundings(ids, new Float32Array(ids.length), run.grid.cols, run.grid.rows, Math.max(1, Math.round(amenity.radius / cell)), (k) => keyIndex.has(k));
        owner = new Int16Array(ids.length).fill(-1);
        for (let i = 0; i < label.length; i++) if (!ids[i] && label[i]) owner[i] = keyIndex.get(label[i]) ?? -1;
      }
    }
    okCells.fill(0); allCells.fill(0);
    let sum = 0, n = 0, twoH = 0;
    for (let i = 0; i < run.values.length; i++) {
      const v = run.values[i];
      if (ids[i] !== 0 || !Number.isFinite(v)) continue;
      sum += v; n++;
      if (v >= 2) twoH++;
      if (owner && owner[i] >= 0) { allCells[owner[i]]++; if (v >= 2) okCells[owner[i]]++; }
    }
    const sun = n ? sum / n : 0;
    const area2 = gfa(x);
    let violation = o.minGfa > 0 ? Math.max(0, (o.minGfa - area2) / o.minGfa) : 0;
    const extra = { sun, gfa: area2, twoHourShare: n ? twoH / n : 0 };
    if (amenity) {
      // The first design evaluated is the current one: it sets "now".
      const shares = Array.from(allCells, (nc, t) => (nc ? okCells[t] / nc : NaN));
      nowShare ??= shares;
      let pass = 0, checked = 0, short = 0, worse = 0;
      for (let t = 0; t < targets.length; t++) {
        if (!Number.isFinite(shares[t])) continue;
        checked++;
        if (shares[t] >= amenity.share) { pass++; continue; }
        const limit = Math.min(amenity.share, BRE_FACTOR * nowShare[t]);
        if (shares[t] < limit - 1e-9) { worse++; short += (limit - shares[t]) / amenity.share; }
      }
      violation += short;
      Object.assign(extra, { amenityPass: pass, amenityChecked: checked, amenityWorse: worse });
    }
    if (daylight) {
      const r = checkRule(daylight, roofs(x));
      violation += r.excessDeg / 25;
      Object.assign(extra, { windowsOver: r.failing, neighboursHit: r.neighboursHit, worstDeg: r.worstDeg });
    }
    return { objectives: [-sun, -area2], violation, extra };
  };
  app.terrain.lockForAnalysis(area, cell);
  try {
    const baseline = await evaluate(current);
    const seeds = [current, targets.map(() => o.minFloors), targets.map(() => o.maxFloors)];
    if (amenity || daylight) {
      // Under constraints the feasible designs sit close to the current one:
      // start half the population one floor up on a single building each.
      const room = Math.floor(o.populationSize / 2);
      for (let i = 0; i < targets.length && seeds.length < room + 3; i++) {
        if (current[i] < o.maxFloors) seeds.push(current.map((v, k) => (k === i ? v + 1 : v)));
      }
    }
    const run = await nsga2({
      lower: targets.map(() => o.minFloors), upper: targets.map(() => o.maxFloors), integer: true, evaluate, seeds
    }, { populationSize: o.populationSize, generations: o.generations, seed: o.seed, onGeneration: o.onGeneration, shouldStop: o.shouldStop });
    return { ...run, baseline: { x: current, ...baseline }, area, cell, dirs: dirs.length, depthResolution,
      windows: daylight?.windows ?? 0, constraints: { amenity, daylight: !!daylight, minGfa: o.minGfa } };
  } finally {
    app.terrain.lockForAnalysis(null);
    targets.forEach(({ layer, f }, i) => { layer.heights[f] = original[i]; });
    for (const [layer, fs] of byLayer) layer.applyHeightsFor(fs);
  }
}
