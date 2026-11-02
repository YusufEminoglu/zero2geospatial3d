import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WALKABILITY_CLASSES,
  walkabilityClass,
  thermalSubscore,
  shadeSubscore,
  greenSubscore,
  quietSubscore,
  slopeSubscore,
  pedestrianWalkabilityIndex,
  findCoolRoute
} from '../../web/src/core/walkability.js';

test('walkability subscores: thermal, shade, green, quiet and slope follow physical bounds', () => {
  assert.equal(thermalSubscore(20), 100, '20 °C UTCI is comfortable (100)');
  assert.ok(thermalSubscore(34) > 40 && thermalSubscore(34) < 60, '34 °C UTCI is around 50');
  assert.equal(thermalSubscore(45), 0, 'extreme heat stress clamps to 0');

  assert.equal(shadeSubscore(0.8), 80);
  assert.equal(shadeSubscore(80), 80, 'percentage shade input is also normalized');

  assert.equal(greenSubscore(30), 100, '30 % GVI reaches 100 (3-30-300 rule)');
  assert.equal(greenSubscore(15), 50);

  assert.equal(quietSubscore(45), 100, '<= 50 dB(A) is 100');
  assert.equal(quietSubscore(78), 0, '>= 75 dB(A) is 0');

  assert.equal(slopeSubscore(1.5), 100);
  assert.equal(slopeSubscore(15), 0);

  assert.equal(WALKABILITY_CLASSES.length, 4);
  assert.equal(walkabilityClass(82).label, 'Excellent (cool, shaded & quiet)');
  assert.equal(walkabilityClass(20).label, 'Poor (heat stress / high noise / steep)');
});

test('pedestrianWalkabilityIndex: masks building footprints and scores cool shaded cells higher than hot noisy ones', () => {
  const cols = 4, rows = 2;
  const ids = new Int32Array([0, 1, 0, 0, 0, 0, 0, 0]);
  const utciGrid = new Float32Array([22, 22, 38, 24, 22, 36, 25, 22]);
  const shadeGrid = new Float32Array([0.9, 0.9, 0.0, 0.8, 0.9, 0.1, 0.7, 0.9]);
  const gviGrid = new Float32Array([30, 30, 2, 25, 30, 5, 20, 30]);
  const noiseGrid = new Float32Array([48, 48, 72, 52, 48, 70, 55, 48]);

  const score = pedestrianWalkabilityIndex({
    ids, utciGrid, shadeGrid, gviGrid, noiseGrid, cols, rows
  });

  assert.ok(Number.isNaN(score[1]), 'Building cell must be NaN');
  assert.ok(score[0] > 90, `Cool shaded quiet cell should score > 90, got ${score[0]}`);
  assert.ok(score[2] < 20, `Hot unshaded noisy cell should score < 20, got ${score[2]}`);
});

test('findCoolRoute: compares shortest path vs. coolest shaded corridor around obstacles', () => {
  const cols = 10, rows = 10, cell = 5, minX = 0, maxY = 45;
  const n = cols * rows;
  const ids = new Int32Array(n).fill(0);
  // Hot sunny direct row (r = 5), cool shaded upper corridor (r = 2)
  const utciGrid = new Float32Array(n).fill(37);
  const shadeGrid = new Float32Array(n).fill(0.05);
  const gviGrid = new Float32Array(n).fill(5);
  const noiseGrid = new Float32Array(n).fill(68);

  for (let c = 1; c <= 8; c++) {
    for (const r of [2, 3, 4]) {
      const idx = r * cols + c;
      utciGrid[idx] = 23;
      shadeGrid[idx] = 0.9;
      gviGrid[idx] = 28;
      noiseGrid[idx] = 50;
    }
  }
  const walkScore = pedestrianWalkabilityIndex({
    ids, utciGrid, shadeGrid, gviGrid, noiseGrid, cols, rows
  });

  const cmp = findCoolRoute({
    ids, walkScore, utciGrid, shadeGrid, gviGrid, noiseGrid,
    cols, rows, cell, minX, maxY,
    startXY: [5, 20], // row 5, col 1
    endXY: [40, 20],  // row 5, col 8
    coolBias: 3.5
  });

  assert.ok(cmp, 'findCoolRoute should return a comparison');
  assert.equal(cmp.shortest.route_type, 'shortest');
  assert.equal(cmp.coolest.route_type, 'coolest');
  assert.ok(cmp.coolest.length_m >= cmp.shortest.length_m, 'coolest detour is >= shortest length');
  assert.ok(cmp.coolest.mean_utci_c < cmp.shortest.mean_utci_c,
    `coolest path UTCI (${cmp.coolest.mean_utci_c}) must be lower than shortest (${cmp.shortest.mean_utci_c})`);
  assert.ok(cmp.coolest.shade_pct > cmp.shortest.shade_pct,
    `coolest path shade (${cmp.coolest.shade_pct}) must exceed shortest (${cmp.shortest.shade_pct})`);
  assert.ok(cmp.utciDeltaC < 0, 'utciDeltaC should be negative (cooler)');
  assert.ok(cmp.shadeGainPct > 0, 'shadeGainPct should be positive');
});
