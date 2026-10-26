// A DEM clipped to a concave polygon: the bounding box around it has no data.
// Those cells must not become ground anywhere: not in the mesh, not under the
// cursor, not in contours, profiles, flooding, cut and fill or terrain maps.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { makeGrid, profile, flood, cutFill, contours, gridStats } from '../../web/src/core/terrain_math.js';
import { Terrain } from '../../web/src/scene/terrain.js';

// 21 x 21 cells of 10 m, ground at 100..120 m rising east. The data is a "U":
// two legs and a base; the notch between the legs (columns 7..13, rows 0..13)
// and a one-cell frame have no data. Heights there are filled in, as the
// exporter does, with a value that would be visible if it leaked: 0.
const N = 21, CELL = 10;
const inside = (c, r) => c > 0 && c < N - 1 && r > 0 && r < N - 1 && (c < 7 || c > 13 || r > 13);
function uDem() {
  const g = makeGrid(N, N, CELL, 0, (N - 1) * CELL);
  const mask = new Uint8Array(N * N);
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const i = r * N + c;
      mask[i] = inside(c, r) ? 1 : 0;
      g.values[i] = mask[i] ? 100 + c : 0;
    }
  }
  return { g, mask };
}

/** The parts of Terrain under test, without a WebGL viewer or a DOM canvas. */
function terrainLike(g, mask) {
  const t = Object.create(Terrain.prototype);
  Object.assign(t, { grid: g, mask, _dataGrid: null, exaggeration: 1, zBase: 0, lodEnabled: true,
    material: new THREE.MeshBasicMaterial(), group: new THREE.Group() });
  return t;
}

test('no data: the terrain mesh has no triangle with a corner in a hole', () => {
  const { g, mask } = uDem();
  const t = terrainLike(g, mask);
  for (const step of [1, 2, 4]) {
    const mesh = t._buildTileMesh({ c0: 0, r0: 0, c1: N - 1, r1: N - 1 }, step);
    const pos = mesh.geometry.getAttribute('position');
    const idx = mesh.geometry.getIndex().array;
    assert.ok(idx.length > 0 && idx.length % 3 === 0);
    for (let k = 0; k < idx.length; k++) {
      // Skirt vertices hang below the surface; every vertex, top or skirt,
      // must sit on a cell with data.
      const x = pos.getX(idx[k]), z = pos.getZ(idx[k]);
      const c = Math.round(x / CELL), r = Math.round((g.maxY + z) / CELL);
      assert.equal(mask[r * N + c], 1, `step ${step}: vertex at cell ${c},${r} is in a hole`);
    }
    // ... and none is pulled down to the filled-in 0 m (skirts hang their
    // own depth below the lowest ground, 101 m).
    let low = Infinity;
    for (const k of idx) low = Math.min(low, pos.getY(k));
    assert.ok(low >= 101 - (CELL * step * 2 + 2) - 1e-3, `step ${step}: lowest drawn vertex ${low}`);
  }
  // Full resolution keeps both triangles of every quad whose four corners have data.
  let quads = 0;
  for (let r = 0; r < N - 1; r++) for (let c = 0; c < N - 1; c++) if (inside(c, r) && inside(c + 1, r) && inside(c, r + 1) && inside(c + 1, r + 1)) quads++;
  const full = t._buildTileMesh({ c0: 0, r0: 0, c1: N - 1, r1: N - 1 }, 1);
  assert.ok(quads > 100);
  assert.ok(full.geometry.getIndex().count >= 6 * quads);
});

test('no data: dataGrid is NaN in holes, grid keeps a height for placing objects', () => {
  const { g, mask } = uDem();
  const t = terrainLike(g, mask);
  const d = t.dataGrid;
  assert.ok(Number.isNaN(d.values[5 * N + 10]), 'notch');
  assert.ok(Number.isNaN(d.values[0]), 'frame');
  assert.equal(d.values[5 * N + 3], 103);
  assert.equal(g.values[5 * N + 10], 0, 'grid untouched');
  assert.equal(t.dataGrid, d, 'built once');
  assert.equal(t.hasData(3 * CELL, g.maxY - 5 * CELL), true);
  assert.equal(t.hasData(10 * CELL, g.maxY - 5 * CELL), false);
  assert.equal(t.hasData(-500, 0), false, 'outside the grid');
  const st = gridStats(d.values);
  assert.equal(st.min, 101);
  assert.equal(st.max, 119);
  // Without a mask nothing changes.
  const plain = terrainLike(g, null);
  assert.equal(plain.dataGrid, g);
  assert.equal(plain.hasData(-500, 0), true);
});

test('no data: a click over the notch goes through to the ground behind it', () => {
  const { g, mask } = uDem();
  const t = terrainLike(g, mask);
  // Looking straight down into the notch: no ground there (the filled 0 m
  // must not be hit).
  const down = new THREE.Vector3(0, -1, 0);
  assert.equal(t.raycast(new THREE.Vector3(10 * CELL, 500, -(g.maxY - 5 * CELL)), down), null);
  // Straight down on a leg: hits the ground at 103 m.
  const hit = t.raycast(new THREE.Vector3(3 * CELL, 500, -(g.maxY - 5 * CELL)), down);
  assert.ok(hit && Math.abs(hit.y - 103) < 0.5, `hit ${hit?.y}`);
  // A shallow ray from the west across the notch at 105 m hits the east leg's
  // wall of ground (column 14, 114 m), not the hole.
  const across = t.raycast(new THREE.Vector3(8 * CELL, 112, -(g.maxY - 5 * CELL)), new THREE.Vector3(1, -0.001, 0).normalize());
  assert.ok(across && across.x >= 13 * CELL && across.x <= 14.5 * CELL, `hit x ${across?.x}`);
  assert.ok(across.y > 110, `hit the leg's side, not the floor of the hole: y ${across.y}`);
});

test('no data: contours, profile, flooding and cut & fill skip the holes', () => {
  const { g, mask } = uDem();
  const d = terrainLike(g, mask).dataGrid;
  // Contours: none at 50 m, i.e. none along the cliff down to the filled 0 m.
  const sets = contours(d, 10);
  assert.deepEqual(sets.map((s) => s.level), [110]);
  for (let i = 0; i < sets[0].segments.length; i += 2) {
    const c = Math.round(sets[0].segments[i] / CELL);
    assert.ok(c === 10, `110 m contour only on the base, column ${c}`);
  }
  // Profile across the notch: a gap, not a drop to 0.
  const y = g.maxY - 5 * CELL;
  const pts = profile(d, [[2 * CELL, y], [18 * CELL, y]], CELL);
  assert.ok(pts.some((p) => Number.isNaN(p.z)));
  assert.ok(pts.filter((p) => Number.isFinite(p.z)).every((p) => p.z > 100));
  // Flooding at 105.5 m: only the west leg (columns 1..5, below 105.5 m)
  // floods, never a hole cell.
  const fl = flood(d, 105.5);
  for (let i = 0; i < N * N; i++) if (!mask[i]) assert.ok(Number.isNaN(fl.depth[i]));
  assert.equal(fl.floodedCells, 5 * (N - 2));
  // Seeded in the west leg, the water reaches the east leg round the base of
  // the U (real ground), never across the notch.
  const seeded = flood(d, 116, [2 * CELL, y]);
  assert.ok(seeded.depth[5 * N + 15] > 0, 'east leg reached via the base');
  for (let i = 0; i < N * N; i++) if (!mask[i]) assert.ok(Number.isNaN(seeded.depth[i]));
  // Cut & fill over a ring that spans the notch: finite, only data cells.
  const ring = [[0, 0], [20 * CELL, 0], [20 * CELL, 20 * CELL], [0, 20 * CELL], [0, 0]];
  const cf = cutFill(d, ring, 110);
  assert.ok(Number.isFinite(cf.cut) && Number.isFinite(cf.fill));
  let cells = 0;
  for (let i = 0; i < N * N; i++) cells += mask[i];
  assert.ok(cf.area > 0 && cf.area <= cells * CELL * CELL + 1e-6);
});

test('no data: terrain maps leave the holes empty', async () => {
  const { terrainAnalyses } = await import('../../web/src/analysis/terrain_results.js');
  const { g, mask } = uDem();
  const t = terrainLike(g, mask);
  const ext = { minX: -CELL / 2, maxX: (N - 0.5) * CELL, minY: -CELL / 2, maxY: (N - 0.5) * CELL };
  const app = { terrain: t, sceneArea: () => ext, area: () => ext };
  const [elev, slope] = await terrainAnalyses(app, { kinds: ['elevation', 'slope'] });
  assert.ok(Number.isNaN(elev.values[5 * N + 10]));
  assert.equal(elev.display.min, 101);
  // Slope next to the cliff is not 45°+ (a filled 0 m would make it ~84°).
  assert.ok(slope.display.max < 10, `slope max ${slope.display.max}`);
});
