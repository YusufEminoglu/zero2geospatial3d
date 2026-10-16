import test from 'node:test';
import assert from 'node:assert/strict';
import { makeGrid, slopeAspect } from '../../web/src/core/terrain_math.js';
import { cropGrid, curvature, tpi, ruggedness, aspectClasses, flowAccumulation, wetness, percentile } from '../../web/src/core/terrain_analysis.js';
import { CRITERIA, parseProfile, profileJson, defaultProfile } from '../../web/src/analysis/compliance.js';
import { qgisStyle } from '../../web/src/ui/qgis_link.js';
import { RAMPS } from '../../web/src/core/classify.js';

const surface = (cols, rows, cell, f) => {
  const g = makeGrid(cols, rows, cell, 0, (rows - 1) * cell);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) g.values[r * cols + c] = f(c * cell, (rows - 1 - r) * cell, c, r);
  return g;
};

// ---------------------------------------------------------------- terrain derivatives
test('crop: cells inside the area, coarsened by whole cells with block means', () => {
  const g = surface(10, 10, 1, (x, y) => x + 10 * y);
  const part = cropGrid(g, { minX: 2, maxX: 5, minY: 3, maxY: 6 }, 1e9);
  assert.equal(part.cols, 4);
  assert.equal(part.rows, 4);
  assert.equal(part.minX, 2);
  assert.equal(part.maxY, 6);
  assert.equal(part.values[0], 2 + 60);
  const coarse = cropGrid(g, { minX: 0, maxX: 9, minY: 0, maxY: 9 }, 25);
  assert.equal(coarse.factor, 2);
  assert.equal(coarse.cols, 5);
  assert.equal(coarse.cell, 2);
  // The first block holds x 0..1, y 9..8: its centre and its mean.
  assert.equal(coarse.minX, 0.5);
  assert.equal(coarse.maxY, 8.5);
  assert.equal(coarse.values[0], 0.5 + 85);
});

test('curvature: a dome is convex (positive), a bowl concave (negative), a plane zero', () => {
  const dome = surface(21, 21, 1, (x, y) => -((x - 10) ** 2 + (y - 10) ** 2) / 10);
  const bowl = surface(21, 21, 1, (x, y) => ((x - 10) ** 2 + (y - 10) ** 2) / 10);
  const plane = surface(21, 21, 1, (x, y) => 0.3 * x + 0.1 * y);
  const mid = 10 * 21 + 10;
  assert.ok(curvature(dome)[mid] > 0);
  assert.ok(curvature(bowl)[mid] < 0);
  // z = (x² + y²) / 10 has a Laplacian of 0.4 per m²: -2 (D + E) x 100 = -40 in 1/100 m.
  assert.ok(Math.abs(curvature(bowl)[mid] + 40) < 1e-3);
  assert.ok(Math.abs(curvature(plane)[mid]) < 1e-4);
});

test('topographic position: a hilltop stands above its surroundings, a valley below', () => {
  const hill = surface(41, 41, 1, (x, y) => 20 - Math.hypot(x - 20, y - 20) * 0.5);
  const v = tpi(hill, 5);
  assert.ok(v[20 * 41 + 20] > 1);
  const valley = surface(41, 41, 1, (x) => Math.abs(x - 20));
  assert.ok(tpi(valley, 5)[20 * 41 + 20] < -1);
  const plane = surface(41, 41, 1, (x, y) => 0.2 * x + 0.1 * y);
  assert.ok(Math.abs(tpi(plane, 5)[20 * 41 + 20]) < 1e-4);
});

test('ruggedness: zero on flat ground, the root of the squared steps on a step', () => {
  const flat = surface(5, 5, 1, () => 7);
  assert.equal(ruggedness(flat)[12], 0);
  // A 1 m step east of the centre column: three of the eight neighbours are 1 m higher.
  const step = surface(5, 5, 1, (x) => (x > 2 ? 1 : 0));
  assert.ok(Math.abs(ruggedness(step)[12] - Math.sqrt(3)) < 1e-6);
});

test('aspect classes: a slope down to the south is class 5, flat ground class 0', () => {
  const south = surface(9, 9, 1, (x, y) => y * 0.5);
  const { slope, aspect } = slopeAspect(south);
  assert.equal(aspectClasses(slope, aspect)[40], 5);
  const east = surface(9, 9, 1, (x) => -x * 0.5);
  const e = slopeAspect(east);
  assert.equal(aspectClasses(e.slope, e.aspect)[40], 3);
  const flat = surface(9, 9, 1, (x) => x * 0.001);
  const f = slopeAspect(flat);
  assert.equal(aspectClasses(f.slope, f.aspect)[40], 0);
});

test('flow: a valley drains every cell to its lowest outlet, a pit is filled and passed through', () => {
  const cols = 15, rows = 20;
  // A V valley along the middle column, falling to the south.
  const g = surface(cols, rows, 1, (x, y) => Math.abs(x - 7) + 0.1 * y);
  const { acc } = flowAccumulation(g);
  // Even the last-row cells run diagonally into the lower valley floor.
  const above = (rows - 2) * cols + 7, outlet = (rows - 1) * cols + 7;
  assert.equal(acc[outlet], cols * rows);
  assert.equal(acc[above], cols * rows - 1);
  // Every cell counts itself at least.
  assert.ok(acc.every((v) => v >= 1));
  // Dig a pit half way down: it is filled and the water still reaches the same outlet.
  g.values[10 * cols + 7] -= 5;
  assert.equal(flowAccumulation(g).acc[outlet], cols * rows);
});

test('flow: water reaching the DEM edge leaves it instead of running along the edge', () => {
  const cols = 12, rows = 10;
  // Steep to the south, slightly to the east: each column drains to its own bottom cell.
  const g = surface(cols, rows, 1, (x, y) => y - 0.1 * x);
  const { acc } = flowAccumulation(g);
  // Inner columns arrive whole at their own bottom cell (the side columns
  // turn inward into their neighbours)...
  for (let c = 2; c < cols - 2; c++) assert.equal(acc[(rows - 1) * cols + c], rows, `column ${c}`);
  // ...and nothing runs east along the bottom edge: without the rule the
  // south-east corner would gather the whole grid.
  assert.ok(Math.max(...acc) < 2 * rows, `max ${Math.max(...acc)}`);
  assert.equal(acc[rows * cols - 1], 1);
});

test('wetness: higher in the valley bottom than on its flanks', () => {
  const g = surface(15, 20, 2, (x, y) => Math.abs(x - 14) * 0.3 + 0.05 * y);
  const { slope } = slopeAspect(g);
  const w = wetness(g, slope);
  assert.ok(w[18 * 15 + 7] > w[18 * 15 + 2]);
  assert.ok(Number.isFinite(percentile(w, 0.5)));
});

// ---------------------------------------------------------------- planning profiles
test('planning profile: a saved profile reads back the same', () => {
  const p = defaultProfile();
  p.name = 'İzmir housing';
  p.thresholds.heat = 450;
  p.criteria = p.criteria.filter((id) => id !== 'wind');
  const back = parseProfile(profileJson(p));
  assert.equal(back.name, 'İzmir housing');
  assert.equal(back.thresholds.heat, 450);
  assert.deepEqual(back.criteria, CRITERIA.map((c) => c.id).filter((id) => id !== 'wind'));
  assert.equal(back.thresholds.wind, CRITERIA.find((c) => c.id === 'wind').threshold);
  assert.deepEqual(back.ignored, []);
});

test('planning profile: unknown criteria ignored, bad thresholds keep the default, other files refused', () => {
  const text = JSON.stringify({ format: '02geo3d-planning-profile', name: 'x', criteria: [
    { id: 'amenity_sun', threshold: 'lots' }, { id: 'noise', threshold: 55 }, { id: 'heat', threshold: 120, enabled: true }] });
  const p = parseProfile(text);
  assert.deepEqual(p.criteria, ['amenity_sun', 'heat']);
  assert.equal(p.thresholds.amenity_sun, 50);
  assert.equal(p.thresholds.heat, 120);
  assert.deepEqual(p.ignored, ['noise']);
  assert.throws(() => parseProfile('{"criteria": []}'), /not a planning-check profile/);
  assert.throws(() => parseProfile('not json'), /not JSON/);
});

// ---------------------------------------------------------------- colours sent to QGIS
test('QGIS colours: reversed ramps arrive reversed, classes carry their legend labels', () => {
  const fwd = qgisStyle({ ramp: 'magma' }).stops;
  const rev = qgisStyle({ ramp: 'magma-r' }).stops;
  assert.deepEqual(fwd, RAMPS.magma);
  assert.deepEqual(rev, [...RAMPS.magma].reverse());
  const st = qgisStyle({ categorical: { 0: '#3B4A6B', 1: '#f6c945' } }, [{ color: '#f6c945', label: 'Visible' }, { color: '#3b4a6b', label: 'Hidden' }]);
  assert.deepEqual(st.categories, [{ value: 0, color: '#3B4A6B', label: 'Hidden' }, { value: 1, color: '#f6c945', label: 'Visible' }]);
  const lab = qgisStyle({ categorical: { 1: '#ff0000' }, labels: { 1: 'North' } });
  assert.equal(lab.categories[0].label, 'North');
});

// ---------------------------------------------------------------- terrain results
test('terrain results: ridges and crests drawn red, every map kept off the roofs', async () => {
  const { terrainAnalyses, TERRAIN_ANALYSES } = await import('../../web/src/analysis/terrain_results.js');
  const { rampStops, rampColor } = await import('../../web/src/core/classify.js');
  const dem = surface(41, 41, 2, (x, y) => 30 - Math.hypot(x - 40, y - 40) * 0.25);
  const ext = { minX: 0, maxX: 80, minY: 0, maxY: 80 };
  const app = { terrain: { grid: dem }, sceneArea: () => ext, area: () => ext };
  const res = await terrainAnalyses(app, { kinds: TERRAIN_ANALYSES.map((a) => a.id), tpiRadius: 20 });
  assert.equal(res.length, TERRAIN_ANALYSES.length);
  assert.ok(res.every((r) => r.groundOnly && r.grid && r.values.length === 41 * 41));
  const colourAt = (r, v) => rampColor(rampStops(r.display.ramp), (v - r.display.min) / (r.display.max - r.display.min));
  for (const title of ['Curvature', 'Topographic position']) {
    const r = res.find((x) => x.title.startsWith(title));
    const top = r.values[20 * 41 + 20];
    assert.ok(top > 0, `${title} positive on the hilltop`);
    const [red, , blue] = colourAt(r, r.display.max);
    assert.ok(red > blue, `${title}: the convex / high end is red`);
  }
  const aspect = res.find((r) => r.title === 'Aspect');
  assert.ok(aspect.legend.length >= 8);
  // East of the hilltop the ground faces east (class 3).
  assert.equal(aspect.values[20 * 41 + 35], 3);
});
