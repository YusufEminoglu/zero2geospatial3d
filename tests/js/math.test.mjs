import test from 'node:test';
import assert from 'node:assert/strict';
import { nsga2, dominates, nonDominatedSort, makeRng } from '../../web/src/core/nsga2.js';
import { jenksBreaks, quantileBreaks, equalBreaks, classOf, rampStops, rampColor, categories } from '../../web/src/core/classify.js';
import { makeGrid, sample, slopeAspect, hillshade, contours, profile, flood, cutFill, balancedLevel } from '../../web/src/core/terrain_math.js';
import { distanceToBuilt, macdonald, classifyLcz, blockIndicators } from '../../web/src/core/morphology.js';
import { windRatio, lawsonClass } from '../../web/src/core/wind.js';

// ---------------------------------------------------------------- NSGA-II
test('dominance respects feasibility first', () => {
  assert.ok(dominates({ objectives: [1, 1], violation: 0 }, { objectives: [2, 2], violation: 0 }));
  assert.ok(!dominates({ objectives: [1, 3], violation: 0 }, { objectives: [2, 2], violation: 0 }));
  assert.ok(dominates({ objectives: [9, 9], violation: 0 }, { objectives: [0, 0], violation: 1 }));
  assert.ok(dominates({ objectives: [9, 9], violation: 0.5 }, { objectives: [0, 0], violation: 1 }));
  const pop = [{ objectives: [1, 2], violation: 0 }, { objectives: [2, 1], violation: 0 }, { objectives: [3, 3], violation: 0 }];
  const fronts = nonDominatedSort(pop);
  assert.deepEqual(fronts[0].sort(), [0, 1]);
  assert.deepEqual(fronts[1], [2]);
});

test('NSGA-II converges on ZDT1 and is reproducible with a seed', async () => {
  const n = 6;
  const problem = {
    lower: new Array(n).fill(0), upper: new Array(n).fill(1),
    evaluate: (x) => {
      const f1 = x[0];
      const g = 1 + (9 * x.slice(1).reduce((a, b) => a + b, 0)) / (n - 1);
      return { objectives: [f1, g * (1 - Math.sqrt(f1 / g))] };
    }
  };
  const run = await nsga2(problem, { populationSize: 40, generations: 80, seed: 7 });
  const err = run.front.reduce((s, p) => s + Math.abs(p.objectives[1] - (1 - Math.sqrt(p.objectives[0]))), 0) / run.front.length;
  assert.ok(err < 0.08, `mean distance to the true front ${err}`);
  const spread = Math.max(...run.front.map((p) => p.objectives[0])) - Math.min(...run.front.map((p) => p.objectives[0]));
  assert.ok(spread > 0.6, `front spread ${spread}`);
  const again = await nsga2(problem, { populationSize: 40, generations: 80, seed: 7 });
  assert.deepEqual(again.front.map((p) => p.x), run.front.map((p) => p.x));
});

test('NSGA-II keeps integer variables integral and honours a constraint', async () => {
  const problem = {
    lower: [1, 1, 1], upper: [10, 10, 10], integer: true,
    evaluate: (x) => ({ objectives: [x.reduce((a, b) => a + b, 0)], violation: Math.max(0, 15 - x.reduce((a, b) => a + b, 0)) })
  };
  const run = await nsga2(problem, { populationSize: 20, generations: 30, seed: 3 });
  for (const p of run.population) for (const v of p.x) assert.equal(v, Math.round(v));
  const best = Math.min(...run.front.filter((p) => p.violation === 0).map((p) => p.objectives[0]));
  assert.equal(best, 15);
});

test('seeded RNG is deterministic and uniform enough', () => {
  const a = makeRng(42), b = makeRng(42);
  let mean = 0;
  for (let i = 0; i < 10000; i++) { const v = a(); assert.equal(v, b()); mean += v; }
  assert.ok(Math.abs(mean / 10000 - 0.5) < 0.02);
});

// ---------------------------------------------------------------- classify
test('natural breaks separate obvious clusters', () => {
  const values = [1, 2, 3, 2, 1, 50, 51, 52, 100, 101, 99];
  const br = jenksBreaks(values, 3);
  assert.equal(br.length, 4);
  assert.equal(classOf(2, br), 0);
  assert.equal(classOf(51, br), 1);
  assert.equal(classOf(100, br), 2);
  assert.deepEqual(equalBreaks([0, 10], 2), [0, 5, 10]);
  assert.equal(quantileBreaks([1, 2, 3, 4], 2)[1], 3);
  assert.equal(classOf(null, br), -1);
  assert.equal(categories(['a', 'b', 'a', null])[0].value, 'a');
});

test('ramps interpolate from end to end and reverse', () => {
  const s = rampStops('viridis');
  const r = rampStops('viridis-r');
  assert.deepEqual(rampColor(s, 0), s[0]);
  assert.deepEqual(rampColor(s, 1), s[s.length - 1]);
  assert.deepEqual(rampColor(r, 0), s[s.length - 1]);
});

// ---------------------------------------------------------------- terrain
function planeGrid(cols, rows, cell, f) {
  const g = makeGrid(cols, rows, cell, -((cols - 1) * cell) / 2, ((rows - 1) * cell) / 2);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) g.values[r * cols + c] = f(g.minX + c * cell, g.maxY - r * cell);
  return g;
}

test('bilinear sampling is exact on a plane', () => {
  const g = planeGrid(20, 20, 5, (x, y) => 100 + 0.1 * x + 0.05 * y);
  assert.ok(Math.abs(sample(g, 3.3, -7.1) - (100 + 0.33 - 0.355)) < 1e-4);
});

test('slope and aspect of an inclined plane', () => {
  // Rises to the east by 10 percent: slope atan(0.1), faces (downslope) west.
  const g = planeGrid(15, 15, 2, (x) => 0.1 * x);
  const { slope, aspect } = slopeAspect(g);
  const k = 7 * 15 + 7;
  assert.ok(Math.abs(slope[k] - (Math.atan(0.1) * 180) / Math.PI) < 1e-3);
  assert.ok(Math.abs(aspect[k] - 270) < 1e-3, `aspect ${aspect[k]}`);
  const north = planeGrid(15, 15, 2, (x, y) => -0.2 * y); // lower towards the north
  assert.ok(Math.abs(slopeAspect(north).aspect[k] - 0) < 1e-3 || Math.abs(slopeAspect(north).aspect[k] - 360) < 1e-3);
  // A west-facing slope is lit by a western sun more than an eastern one.
  assert.ok(hillshade(g, 270, 30)[k] > hillshade(g, 90, 30)[k]);
});

test('contours of a cone are concentric rings at the right levels', () => {
  const g = planeGrid(41, 41, 1, (x, y) => 20 - Math.hypot(x, y));
  const cs = contours(g, 5);
  const levels = cs.map((c) => c.level);
  assert.ok(levels.includes(5) && levels.includes(10) && levels.includes(15));
  const ring10 = cs.find((c) => c.level === 10).segments;
  for (let i = 0; i < ring10.length; i += 2) {
    assert.ok(Math.abs(Math.hypot(ring10[i], ring10[i + 1]) - 10) < 0.6);
  }
});

test('profile follows the ground and measures the distance', () => {
  const g = planeGrid(30, 30, 2, (x) => 0.5 * x);
  const p = profile(g, [[-20, 0], [20, 0]], 1);
  assert.ok(Math.abs(p[p.length - 1].d - 40) < 1e-9);
  assert.ok(Math.abs(p[0].z - -10) < 1e-6 && Math.abs(p[p.length - 1].z - 10) < 1e-6);
});

test('flooding: bathtub vs connected to a seed', () => {
  // Two basins at height 0 separated by a 5 m ridge, the rest at 10 m.
  const g = makeGrid(10, 1, 1, 0, 0, Float32Array.from([10, 0, 0, 0, 5, 0, 0, 0, 10, 10]));
  const all = flood(g, 2);
  assert.equal(all.floodedCells, 6);
  assert.ok(Math.abs(all.volume - 12) < 1e-9);
  const left = flood(g, 2, [2, 0]);
  assert.equal(left.floodedCells, 3);
  const high = flood(g, 6, [2, 0]);
  assert.equal(high.floodedCells, 7);
});

test('cut and fill volumes, and the balancing level', () => {
  const g = planeGrid(21, 21, 1, (x) => x); // -10..10
  const ring = [[-5.5, -5.5], [5.5, -5.5], [5.5, 5.5], [-5.5, 5.5]]; // edges between cell centres
  const flat0 = cutFill(g, ring, 0);
  assert.ok(Math.abs(flat0.cut - flat0.fill) < 1e-6);
  assert.ok(flat0.cut > 0);
  const high = cutFill(g, ring, 10);
  assert.equal(high.cut, 0);
  assert.ok(Math.abs(balancedLevel(g, ring)) < 0.01);
});

// ---------------------------------------------------------------- morphology
test('distance transform and Macdonald limits', () => {
  const h = new Float32Array(9);
  h[4] = 10;
  const d = distanceToBuilt(h, 3, 3, 2);
  assert.equal(d[4], 0);
  assert.equal(d[1], 2);
  assert.ok(Math.abs(d[0] - 2 * Math.SQRT2) < 1e-6);
  const sparse = macdonald(0.05, 0.05, 10);
  const dense = macdonald(0.6, 0.3, 10);
  assert.ok(sparse.zd < dense.zd);
  assert.ok(dense.zd < 10 && sparse.z0 > 0);
});

test('LCZ classes follow Stewart and Oke ranges', () => {
  assert.equal(classifyLcz(0.5, 30), 1);
  assert.equal(classifyLcz(0.5, 15), 2);
  assert.equal(classifyLcz(0.5, 6), 3);
  assert.equal(classifyLcz(0.3, 30), 4);
  assert.equal(classifyLcz(0.3, 15), 5);
  assert.equal(classifyLcz(0.3, 6), 6);
  assert.equal(classifyLcz(0.35, 7, 4000), 8);
  assert.equal(classifyLcz(0.15, 6), 9);
  assert.equal(classifyLcz(0, 0), 0);
});

test('block indicators: plan fraction, frontal area and canyon ratio', () => {
  // 10 x 10 cells of 2 m, a 10 m tall wall across column 5.
  const cols = 10, rows = 10, cell = 2;
  const h = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) h[r * cols + 5] = 10;
  const west = blockIndicators({ heights: h, cols, rows, cell, blockCells: 10, windFromDeg: 270 });
  assert.ok(Math.abs(west.lambdaP[0] - 0.1) < 1e-6); // float32 storage
  // Frontal area to a west wind: 10 m x 20 m wall over 400 m2 plan.
  assert.ok(Math.abs(west.lambdaF[0] - (10 * 20) / 400) < 1e-6, `lambda_f ${west.lambdaF[0]}`);
  const north = blockIndicators({ heights: h, cols, rows, cell, blockCells: 10, windFromDeg: 0 });
  assert.ok(north.lambdaF[0] < 0.06, `edge-on wall ${north.lambdaF[0]}`);
  assert.ok(west.hw[0] > 0);
});

// ---------------------------------------------------------------- wind
test('wind: open ground is unaffected, the lee of a wall is sheltered', async () => {
  const cols = 60, rows = 20, cell = 2;
  const h = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) h[r * cols + 20] = 10; // wall at x column 20
  const ratio = await windRatio({ heights: h, cols, rows, cell, windFromDeg: 270 }); // from the west
  const at = (c, r) => ratio[r * cols + c];
  assert.ok(Number.isNaN(at(20, 10)));
  assert.ok(at(10, 10) > 0.95, `upwind ${at(10, 10)}`);
  assert.ok(at(23, 10) < 0.5, `just behind ${at(23, 10)}`);
  assert.ok(at(50, 10) > at(23, 10), 'the wake recovers downstream');
  const east = await windRatio({ heights: h, cols, rows, cell, windFromDeg: 90 });
  assert.ok(east[10 * cols + 17] < 0.5 && east[10 * cols + 23] > 0.95, 'the shelter flips with the wind');
  assert.equal(lawsonClass(3).key, 'sitting');
  assert.equal(lawsonClass(12).key, 'uncomfortable');
});

test('one-pass hillshade equals the slope/aspect formula', async () => {
  const { slopeAspectAt } = await import('../../web/src/core/terrain_math.js');
  const g = planeGrid(30, 25, 3, (x, y) => 20 * Math.sin(x / 17) + 9 * Math.cos(y / 11) + 0.2 * x);
  const hs = hillshade(g, 300, 35, 1);
  const zen = (55 * Math.PI) / 180, az = (300 * Math.PI) / 180;
  for (const [c, r] of [[5, 5], [12, 20], [29, 0], [0, 24], [17, 9]]) {
    const { slope, aspect } = slopeAspectAt(g, c, r);
    const s = (slope * Math.PI) / 180, a = aspect < 0 ? 0 : (aspect * Math.PI) / 180;
    const expect = Math.max(0, Math.cos(zen) * Math.cos(s) + Math.sin(zen) * Math.sin(s) * Math.cos(az - a));
    assert.ok(Math.abs(hs[r * 30 + c] - expect) < 1e-5, `cell ${c},${r}: ${hs[r * 30 + c]} vs ${expect}`);
  }
  const flat = hillshade(planeGrid(5, 5, 1, () => 3), 315, 40);
  assert.ok(Math.abs(flat[12] - Math.cos((50 * Math.PI) / 180)) < 1e-6);
});

test('percentile rank of a building among the others', async () => {
  const { percentileRank } = await import('../../web/src/ui/building_report.js');
  assert.equal(percentileRank([1, 2, 3, 4, NaN], 3), 50);
  assert.equal(percentileRank([5, 5, 5], 5), 0);
});

test('building report: scenario changes and the optimised design', async () => {
  const { buildingFacts } = await import('../../web/src/ui/building_report.js');
  const layer = {
    features: [{ properties: { floors: 4, name: 'Block 7' } }, { properties: {} }],
    heights: [12, 9], footprint: [200, 100], baseZ: [5, 5],
    extraFields: new Map([
      ['sun_h_roof', Float32Array.from([6, 5])],
      ['sun_h_roof_A', Float32Array.from([6, 5])], ['sun_h_roof_B', Float32Array.from([4.5, 5])], ['d_sun_h_roof', Float32Array.from([-1.5, 0])]
    ])
  };
  const app = { lastOptimisation: { targets: [{ layer, f: 0 }], now: { x: [4], extra: { sun: 3.1, gfa: 800 } },
    design: { x: [6], extra: { sun: 2.7, gfa: 1200 } }, floorHeight: 3, date: { month: 12, day: 21 } } };
  const info = buildingFacts(app, layer, 0);
  assert.equal(info.name, 'Block 7');
  assert.deepEqual(info.analyses.map((a) => a.name), ['sun_h_roof']); // A/B copies are not listed twice
  assert.equal(info.scenario.length, 1);
  assert.equal(info.scenario[0].a, 6);
  assert.equal(info.scenario[0].b, 4.5);
  assert.equal(info.scenario[0].delta, -1.5);
  assert.match(info.scenario[0].label, /Sun on the roof/);
  assert.equal(info.optimisation.floorsDesign, 6);
  assert.equal(info.optimisation.gfaChange, 400);
  assert.equal(buildingFacts(app, layer, 1).optimisation, null);
  assert.equal(info.facts.find(([k]) => k === 'Floor area (est.)')[1], '800 m²');
});

test('building surroundings: open cells go to the nearest building, within the ring', async () => {
  const { surroundings } = await import('../../web/src/analysis/climate.js');
  // 11 x 1 strip: building 7 at cell 2, building 9 at cell 8, a tree (height, no id) at cell 5.
  const ids = new Int32Array(11); ids[2] = 7; ids[8] = 9;
  const heights = new Float32Array(11); heights[2] = 10; heights[8] = 10; heights[5] = 6;
  const label = surroundings(ids, heights, 11, 1, 2, () => true);
  assert.deepEqual(Array.from(label), [7, 7, 0, 7, 7, 0, 9, 9, 0, 9, 9]);
  const none = surroundings(ids, heights, 11, 1, 2, (k) => k === 7);
  assert.equal(none[9], 0);
});

test('meteorological seasons', async () => {
  const { seasonOf } = await import('../../web/src/analysis/climate.js');
  assert.deepEqual([1, 2, 3, 5, 6, 8, 9, 11, 12].map(seasonOf), [0, 0, 1, 1, 2, 2, 3, 3, 0]);
});

test('planning check verdicts: min and max criteria, missing values', async () => {
  const { judge, CRITERIA } = await import('../../web/src/analysis/compliance.js');
  const byId = Object.fromEntries(CRITERIA.map((c) => [c.id, c]));
  assert.equal(judge(byId.amenity_sun, 50), true);
  assert.equal(judge(byId.amenity_sun, 49.9), false);
  assert.equal(judge(byId.neighbour_daylight, 0.79), false);
  assert.equal(judge(byId.wind, 5), true);
  assert.equal(judge(byId.wind, 5.1), false);
  assert.equal(judge(byId.heat, NaN), null);
});
