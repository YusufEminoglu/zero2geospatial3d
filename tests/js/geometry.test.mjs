import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ExtrudedLayer, featureKey, splitKey } from '../../web/src/scene/objects.js';
import { planTiles } from '../../web/src/analysis/gpu.js';

function mockApp(groundZ = (x, y) => 10 + 0.01 * x) {
  return {
    terrain: { heightAt: groundZ, toY: (z) => z, groundY: (x, y) => groundZ(x, y), exaggeration: 1 },
    viewer: { requestRender() {} }
  };
}

const square = (cx, cy, s, clockwise = false) => {
  const r = [[cx - s, cy - s], [cx + s, cy - s], [cx + s, cy + s], [cx - s, cy + s], [cx - s, cy - s]];
  return clockwise ? r.reverse() : r;
};

function entry(role) {
  return { id: 'L1', name: 'test', role, fields: [], defaultHeight: 9, defaultColor: '#cccccc', scenario: 'both' };
}

/** Every triangle's winding normal agrees with its vertex normals (faces point outwards / up). */
function assertOutward(layer) {
  let tris = 0;
  for (const c of layer.chunks) {
    const g = c.mesh.geometry;
    const pos = g.attributes.position;
    const nrm = g.attributes.normal;
    const idx = g.index.array;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3(), n = new THREE.Vector3();
    for (let i = 0; i < idx.length; i += 3) {
      a.fromBufferAttribute(pos, idx[i]);
      b.fromBufferAttribute(pos, idx[i + 1]);
      d.fromBufferAttribute(pos, idx[i + 2]);
      const face = b.clone().sub(a).cross(d.clone().sub(a));
      if (face.lengthSq() < 1e-12) continue;
      n.fromBufferAttribute(nrm, idx[i]);
      assert.ok(face.normalize().dot(n) > 0.99, `triangle ${i / 3} faces away from its normal`);
      tris++;
    }
  }
  return tris;
}

test('buildings: walls face outwards and roofs face up, whatever the ring orientation', () => {
  const app = mockApp();
  const features = [
    { properties: { _id: 1, _h: 12, _c: '#ff0000' }, geometry: { type: 'MultiPolygon', coordinates: [[square(0, 0, 5)]] } },
    { properties: { _id: 2, _h: 20, _c: '#00ff00' }, geometry: { type: 'MultiPolygon', coordinates: [[square(30, 0, 5, true)]] } },
    // Courtyard building: outer counter-clockwise, hole clockwise (and the reverse).
    { properties: { _id: 3, _h: 15 }, geometry: { type: 'MultiPolygon', coordinates: [[square(60, 0, 10), square(60, 0, 4, true)]] } },
    { properties: { _id: 4, _h: 15 }, geometry: { type: 'Polygon', coordinates: [square(100, 0, 10, true), square(100, 0, 4)] } }
  ];
  const layer = new ExtrudedLayer(app, entry('buildings'), 1, { features });
  const tris = assertOutward(layer);
  assert.ok(tris > 40, `${tris} triangles`);
  // Roof at ground + height, bottom sunk below the lowest ground point.
  const pos = layer.chunks[0].mesh.geometry.attributes.position;
  let maxY = -Infinity;
  for (let i = 0; i < pos.count; i++) maxY = Math.max(maxY, pos.getY(i));
  assert.ok(Math.abs(maxY - (10 + 0.01 * 25 + 20)) < 1e-3, `top ${maxY}`);
  assert.ok(Math.abs(layer.footprint[2] - (400 - 64)) < 1e-6, 'footprint minus courtyard');
});

test('walls: every face of the ribbon faces outwards', () => {
  const app = mockApp();
  const features = [{ properties: { _id: 1, _h: 2 }, geometry: { type: 'MultiLineString', coordinates: [[[0, 0], [10, 5], [10, 20]]] } }];
  const layer = new ExtrudedLayer(app, entry('walls'), 1, { features });
  assert.ok(assertOutward(layer) > 10);
});

test('height changes and exaggeration move vertices without a rebuild', () => {
  const app = mockApp(() => 0);
  const features = [{ properties: { _id: 1, _h: 10 }, geometry: { type: 'MultiPolygon', coordinates: [[square(0, 0, 5)]] } }];
  const layer = new ExtrudedLayer(app, entry('buildings'), 1, { features });
  layer.heights[0] = 33;
  layer.applyHeightsFor([0]);
  const pos = layer.chunks[0].mesh.geometry.attributes.position;
  let maxY = -Infinity;
  for (let i = 0; i < pos.count; i++) maxY = Math.max(maxY, pos.getY(i));
  assert.equal(maxY, 33);
});

test('feature keys round-trip and fit 24 bits', () => {
  const k = featureKey(12, 123456);
  assert.deepEqual(splitKey(k), { layerIndex: 12, id: 123456 });
  assert.ok(featureKey(15, (1 << 20) - 1) < 2 ** 24);
});

test('tiles cover the area exactly, north first', () => {
  const { grid, tiles } = planTiles({ minX: -100, maxX: 1100, minY: -50, maxY: 950 }, 1, 512);
  assert.equal(grid.cols, 1200);
  assert.equal(grid.rows, 1000);
  assert.equal(tiles.reduce((s, t) => s + t.cols * t.rows, 0), 1200 * 1000);
  assert.equal(tiles[0].bounds.minZ, -950); // north edge is -z
  assert.equal(grid.minX, -99.5);
  assert.equal(grid.maxY, 949.5);
});

test('slope modes move the reference level; the bottom follows the ground (plinth)', () => {
  const app = mockApp((x) => 0.5 * x); // 10 m rise across a 20 m footprint
  const features = [{ properties: { _id: 1, _h: 9 }, geometry: { type: 'MultiPolygon', coordinates: [[square(10, 0, 10)]] } }];
  const layer = new ExtrudedLayer(app, entry('buildings'), 1, { features });
  const ys = () => {
    const pos = layer.chunks[0].mesh.geometry.attributes.position;
    let top = -Infinity, low = Infinity;
    for (let i = 0; i < pos.count; i++) { top = Math.max(top, pos.getY(i)); low = Math.min(low, pos.getY(i)); }
    return { top, low };
  };
  assert.equal(ys().top, 0 + 9);                 // lowest ground (x = 0) + height
  layer.setSlopeMode('highest');
  assert.equal(ys().top, 10 + 9);                // highest ground (x = 20) + height
  assert.ok(Math.abs(ys().low - (0 - 0.6)) < 1e-5, 'downhill wall reaches the ground: a plinth'); // float32 positions
  layer.setSlopeMode('average');
  assert.ok(Math.abs(ys().top - (5 + 9)) < 1e-9, `average ${ys().top}`);
  assert.equal(layer.baseZ[0], 5);
  assertOutward(layer);
});

test('a raised part starts at min_height and parts of one building share their ground', () => {
  const app = mockApp((x) => 0.1 * x);
  const features = [
    { properties: { _id: 1, _h: 12, _grp: 'w1' }, geometry: { type: 'MultiPolygon', coordinates: [[square(0, 0, 20)]] } },           // podium
    { properties: { _id: 2, _h: 60, _b: 12, _grp: 'w1' }, geometry: { type: 'MultiPolygon', coordinates: [[square(10, 0, 5)]] } }    // tower on it
  ];
  const layer = new ExtrudedLayer(app, entry('buildings'), 1, { features });
  assert.equal(layer.baseZ[0], layer.baseZ[1], 'shared ground');
  assert.ok(Math.abs(layer.baseZ[1] - -2) < 1e-9, `group lowest ground ${layer.baseZ[1]}`);
  const c = layer.chunks[0];
  const pos = c.mesh.geometry.attributes.position;
  let towerLow = Infinity, towerTop = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    if (c.feat[i] !== 1) continue;
    towerLow = Math.min(towerLow, pos.getY(i)); towerTop = Math.max(towerTop, pos.getY(i));
  }
  assert.ok(Math.abs(towerLow - (-2 + 12)) < 1e-9, `tower bottom ${towerLow}`);
  assert.ok(Math.abs(towerTop - (-2 + 60)) < 1e-9, `tower top ${towerTop}`);
});
