import test from 'node:test';
import assert from 'node:assert/strict';
import { greenViewIndex, solarEnvelope, GVI_CLASSES, gviClass } from '../../web/src/core/urban_form.js';
import { WindStreamlines } from '../../web/src/scene/wind_streamlines.js';

test('greenViewIndex: returns 0 on a treeless, non-vegetated grid', () => {
  const cols = 15, rows = 15, cell = 2;
  const buildingHeights = new Float32Array(cols * rows);
  const gvi = greenViewIndex({ buildingHeights, treeObstacles: [], greenMask: null, cols, rows, cell });
  for (let i = 0; i < gvi.length; i++) {
    assert.equal(gvi[i], 0);
  }
});

test('greenViewIndex: returns significantly higher GVI (> 20 %) near trees and over greenMask cells', () => {
  const cols = 25, rows = 25, cell = 2, minX = 0, maxY = 50;
  const buildingHeights = new Float32Array(cols * rows);
  // Prominent canopy tree at center (x = 25, y = 25), height = 14m, radius = 6m
  const treeObstacles = [[25, 25, 6, 14]];
  const greenMask = new Uint8Array(cols * rows);
  for (let r = 8; r <= 16; r++) {
    for (let c = 8; c <= 16; c++) {
      greenMask[r * cols + c] = 1;
    }
  }

  const gvi = greenViewIndex({ buildingHeights, treeObstacles, greenMask, cols, rows, cell, minX, maxY });
  // Sample cell (12, 12), right under/near the tree canopy inside the park
  const gviCenter = gvi[12 * cols + 12];
  assert.ok(gviCenter > 20, `GVI near trees and greenMask should be > 20 %, got ${gviCenter}`);
});

test('greenViewIndex: solid buildings occlude trees behind them', () => {
  const cols = 30, rows = 15, cell = 2, minX = 0, maxY = 30;
  const buildingHeights = new Float32Array(cols * rows);
  // Tree at col 15, row 7 (x = 31, y = 15), height = 12m, radius = 3m
  const treeObstacles = [[31, 15, 3, 12]];

  // 30m tall building wall at col 10 (between r = 3 and 11)
  for (let r = 3; r <= 11; r++) {
    buildingHeights[r * cols + 10] = 30;
  }

  const gvi = greenViewIndex({ buildingHeights, treeObstacles, greenMask: null, cols, rows, cell, minX, maxY });

  // Cell A: col 18, row 7 (east of tree, unobstructed view of tree)
  const gviUnobstructed = gvi[7 * cols + 18];
  // Cell B: col 6, row 7 (west of wall, tree is directly behind the 30m wall)
  const gviOccluded = gvi[7 * cols + 6];

  assert.ok(gviUnobstructed > 0, `Unobstructed cell should have positive GVI, got ${gviUnobstructed}`);
  assert.ok(gviUnobstructed > gviOccluded, `Unobstructed cell (${gviUnobstructed}) should see more tree than occluded cell (${gviOccluded})`);
});

test('greenViewIndex: returns NaN inside building footprints', () => {
  const cols = 10, rows = 10, cell = 2;
  const buildingHeights = new Float32Array(cols * rows);
  buildingHeights[5 * cols + 5] = 18;

  const gvi = greenViewIndex({ buildingHeights, treeObstacles: [], greenMask: null, cols, rows, cell });
  assert.ok(Number.isNaN(gvi[5 * cols + 5]), 'GVI inside building must be NaN');
  assert.equal(gvi[0], 0, 'Open cell should have numeric 0 GVI');
});

test('greenViewIndex: classification categories and helper', () => {
  assert.equal(gviClass(4)?.key, 'bare');
  assert.equal(gviClass(14)?.key, 'moderate');
  assert.equal(gviClass(28)?.key, 'street');
  assert.equal(gviClass(45)?.key, 'high');
  assert.equal(gviClass(NaN), null);
  assert.equal(GVI_CLASSES.length, 4);
});

test('solarEnvelope: equatorward cells have lower maxHeight than far away or poleward cells', () => {
  const cols = 31, rows = 31, cell = 2;
  const buildingHeights = new Float32Array(cols * rows);
  // Existing sensitive building at col 15, row 15 (height 15 m)
  buildingHeights[15 * cols + 15] = 15;

  // Northern hemisphere sun at solar noon (azimuth 180 = south = +row, 45 degree elevation)
  // In scene axes: [dx=east=0, dy=up=sin(45), dz=south=-north=cos(45)]
  const sunVectors = [{ dir: [0, Math.SQRT1_2, Math.SQRT1_2], weight: 2 }];

  const { maxHeight, maxFloors } = solarEnvelope({
    buildingHeights,
    cols,
    rows,
    cell,
    sunVectors,
    minSunHours: 2,
    maxBuildableHeight: 80,
    floorHeight: 3.2
  });

  const hImmediateSouth = maxHeight[16 * cols + 15]; // immediately south (+row)
  const hNorth = maxHeight[14 * cols + 15];          // poleward (north, -row)
  const hFarSouth = maxHeight[28 * cols + 15];       // far south

  assert.ok(hImmediateSouth < hNorth, `Immediate south (${hImmediateSouth}) must be lower than north (${hNorth})`);
  assert.ok(hImmediateSouth < hFarSouth, `Immediate south (${hImmediateSouth}) must be lower than far south (${hFarSouth})`);
  assert.equal(hNorth, 80, 'North cell receives full buildable height because sun shines from south');
});

test('solarEnvelope: higher sun elevation allows taller maxHeight at same distance than low winter sun', () => {
  const cols = 31, rows = 31, cell = 2;
  const buildingHeights = new Float32Array(cols * rows);
  buildingHeights[15 * cols + 15] = 15;

  // Winter sun (elevation 20 deg):
  const elWinter = (20 * Math.PI) / 180;
  const winterVectors = [{ dir: [0, Math.sin(elWinter), Math.cos(elWinter)], weight: 2 }];
  const envWinter = solarEnvelope({
    buildingHeights,
    cols,
    rows,
    cell,
    sunVectors: winterVectors,
    minSunHours: 2,
    maxBuildableHeight: 80
  });

  // Summer sun (elevation 65 deg):
  const elSummer = (65 * Math.PI) / 180;
  const summerVectors = [{ dir: [0, Math.sin(elSummer), Math.cos(elSummer)], weight: 2 }];
  const envSummer = solarEnvelope({
    buildingHeights,
    cols,
    rows,
    cell,
    sunVectors: summerVectors,
    minSunHours: 2,
    maxBuildableHeight: 80
  });

  // Compare at same distance south of the building (col 15, row 18, distance ~ 6 m)
  const hWinter = envWinter.maxHeight[18 * cols + 15];
  const hSummer = envSummer.maxHeight[18 * cols + 15];

  assert.ok(hSummer > hWinter, `Summer sun height (${hSummer}) must be taller than winter sun (${hWinter})`);
});

test('solarEnvelope: maxFloors equals Math.floor(maxHeight / floorHeight)', () => {
  const cols = 20, rows = 20, cell = 2, floorHeight = 3.5;
  const buildingHeights = new Float32Array(cols * rows);
  buildingHeights[10 * cols + 10] = 10;

  const sunVectors = [{ dir: [0, Math.SQRT1_2, Math.SQRT1_2], weight: 2 }];
  const { maxHeight, maxFloors } = solarEnvelope({
    buildingHeights,
    cols,
    rows,
    cell,
    sunVectors,
    minSunHours: 2,
    maxBuildableHeight: 80,
    floorHeight
  });

  for (let i = 0; i < cols * rows; i++) {
    assert.equal(maxFloors[i], Math.floor(maxHeight[i] / floorHeight));
  }
});

test('WindStreamlines: can initialize, show, and hide cleanly without throwing', () => {
  const mockApp = {
    viewer: {
      helpers: { add() {}, remove() {} },
      requestRender() {}
    },
    terrain: {
      groundY(x, y) { return 10; }
    }
  };

  const ws = new WindStreamlines(mockApp);
  assert.equal(ws.active, false);

  const cols = 20, rows = 20, cell = 2;
  const values = new Float32Array(cols * rows).fill(1.0);
  values[5 * cols + 5] = NaN; // building
  const grid = { cols, rows, cell, minX: 0, maxY: 40 };

  ws.show({ grid, values, windFromDeg: 270, speed10: 5, count: 20, trailSteps: 8 });
  assert.equal(ws.active, true);
  assert.ok(ws.group.children.length > 0);

  ws.hide();
  assert.equal(ws.active, false);
  assert.equal(ws.group.children.length, 0);
});
