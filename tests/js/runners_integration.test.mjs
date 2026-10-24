import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Analyst, setDiurnalFrame } from '../../web/src/analysis/runners.js';
import { FIELD_INFO } from '../../web/src/ui/building_report.js';
import { CRITERIA, judge } from '../../web/src/analysis/compliance.js';

function createMockApp() {
  let inInit = true;
  const app = {
    viewer: {
      get renderer() {
        return inInit
          ? {
              getContext: () => ({ getParameter: () => 4096, MAX_TEXTURE_SIZE: 4096 }),
              extensions: { has: () => true }
            }
          : null;
      },
      set renderer(_v) {},
      world: new THREE.Group(),
      scene: new THREE.Scene(),
      helpers: new THREE.Group(),
      requestRender() {}
    },
    terrain: {
      groundY: () => 0,
      toY: (z) => z,
      exaggeration: 1,
      lockForAnalysis() {}
    },
    site: {
      lat: 38.4,
      lon: 27.1,
      utcOffset: 3
    },
    layers: [],
    plantedTrees: [[20, 20, 4, 10]],
    drawnRoads: [[[5, 20], [35, 20]]]
  };

  const analyst = new Analyst(app);
  inInit = false;

  analyst.gridRun = async ({ area, cell, withIds }) => {
    const cols = 10;
    const rows = 10;
    const n = cols * rows;
    const grid = { cols: 10, rows: 10, cell: 4, minX: 2, maxY: 38 };
    const values = new Float32Array(n).fill(0.8);
    const potential = new Float32Array(n).fill(1.0);
    const heights = new Float32Array(n).fill(0);
    heights[55] = 15;
    const ids = new Int32Array(n).fill(0);
    ids[55] = (1 << 20) | 1;
    return { grid, values, potential, heights, ids };
  };

  return { app, analyst };
}

test('Analyst comfort: returns utci, pet, mrt, tsurf, dt_cool and masks building footprint', async () => {
  const { analyst } = createMockApp();
  const res = await analyst.comfort({
    area: { minX: 0, maxX: 40, minY: 0, maxY: 40 },
    cell: 4,
    month: 7,
    day: 21,
    hour: 15,
    conditions: {
      airTemp: 32,
      rh: 45,
      windSpeed: 2.5,
      windDir: 270,
      dni: 750,
      dhi: 120,
      ghi: 800,
      ir: 380
    },
    material: 'asphalt',
    lai: 3.5
  });

  assert.equal(res.length, 5);
  const kinds = res.map((r) => r.kind);
  assert.deepEqual(kinds, ['utci', 'pet', 'mrt', 'tsurf', 'dt_cool']);

  for (const r of res) {
    assert.ok(Number.isNaN(r.values[55]), `Building cell 55 must be NaN for ${r.kind}`);
    assert.ok(Number.isFinite(r.values[0]), `Open cell 0 must be finite for ${r.kind}`);
    assert.ok(Number.isFinite(r.values[10]), `Open cell 10 must be finite for ${r.kind}`);
  }
});

test('Analyst diurnalStudy: returns diurnalstudy result with hourly frames and setDiurnalFrame works', async () => {
  const { analyst } = createMockApp();
  const res = await analyst.diurnalStudy({
    area: { minX: 0, maxX: 40, minY: 0, maxY: 40 },
    cell: 4,
    date: { month: 7, day: 21 },
    startHour: 10,
    endHour: 12
  });

  assert.equal(res.length, 1);
  assert.equal(res[0].kind, 'diurnalstudy');
  assert.equal(res[0].frames.length, 3);

  setDiurnalFrame(res[0], 2);
  assert.equal(res[0].frame, 2);
});

test('Analyst ventilation: returns vei, airage, and dispersion results', async () => {
  const { analyst } = createMockApp();
  const res = await analyst.ventilation({
    area: { minX: 0, maxX: 40, minY: 0, maxY: 40 },
    cell: 4,
    windFromDeg: 270,
    speed10: 4
  });

  assert.equal(res.length, 3);
  const kinds = res.map((r) => r.kind);
  assert.deepEqual(kinds, ['vei', 'airage', 'dispersion']);
});

test('Analyst noise: returns noise result', async () => {
  const { analyst } = createMockApp();
  const res = await analyst.noise({
    area: { minX: 0, maxX: 40, minY: 0, maxY: 40 },
    cell: 4,
    soundPowerDb: 78
  });

  assert.equal(res.length, 1);
  assert.equal(res[0].kind, 'noise');
});

test('Analyst greenView: returns gvi result and open cells near planted tree have positive values', async () => {
  const { analyst } = createMockApp();
  const res = await analyst.greenView({
    area: { minX: 0, maxX: 40, minY: 0, maxY: 40 },
    cell: 4
  });

  assert.equal(res.length, 1);
  assert.equal(res[0].kind, 'gvi');
  const cellNearTree = 4 * 10 + 4;
  assert.ok(res[0].values[cellNearTree] > 0, `Expected cell near tree to have GVI > 0, got ${res[0].values[cellNearTree]}`);
});

test('Analyst solarEnvelope: returns solarenvelope and solarfloors results', async () => {
  const { analyst } = createMockApp();
  const res = await analyst.solarEnvelope({
    area: { minX: 0, maxX: 40, minY: 0, maxY: 40 },
    cell: 4,
    date: { month: 12, day: 21 },
    startHour: 10,
    endHour: 14
  });

  assert.equal(res.length, 2);
  const kinds = res.map((r) => r.kind);
  assert.deepEqual(kinds, ['solarenvelope', 'solarfloors']);
});

test('FIELD_INFO contains all 11 new microclimate, ventilation, acoustic and urban form fields', () => {
  const fields = [
    'utci_c',
    'pet_c',
    'tsurf_c',
    'dt_cool_c',
    'vent_index',
    'air_no2_ugm3',
    'noise_dba_max',
    'noise_dba_mean',
    'quiet_facade',
    'gvi_pct',
    'env_max_h'
  ];

  for (const f of fields) {
    assert.ok(f in FIELD_INFO, `Field ${f} missing from FIELD_INFO`);
    const info = FIELD_INFO[f];
    assert.ok(Array.isArray(info), `FIELD_INFO[${f}] must be an array [label, unit, help]`);
    assert.equal(info.length, 3, `FIELD_INFO[${f}] must have 3 elements`);
    assert.equal(typeof info[0], 'string', `Label for ${f} must be string`);
    assert.equal(typeof info[1], 'string', `Unit for ${f} must be string`);
    assert.equal(typeof info[2], 'string', `Help for ${f} must be string`);
    assert.ok(info[0].length > 0, `Label for ${f} must not be empty`);
    assert.ok(info[2].length > 0, `Help for ${f} must not be empty`);
  }
});

test('CRITERIA and judge: facade_noise and green_view criteria behave correctly', () => {
  const cNoise = CRITERIA.find((c) => c.id === 'facade_noise');
  assert.ok(cNoise, 'facade_noise criterion must exist in CRITERIA');
  assert.equal(cNoise.test, 'max');
  assert.equal(cNoise.threshold, 65);
  assert.equal(judge(cNoise, 60), true, '60 dB(A) <= 65 dB(A) should pass');
  assert.equal(judge(cNoise, 65), true, '65 dB(A) <= 65 dB(A) should pass');
  assert.equal(judge(cNoise, 70), false, '70 dB(A) > 65 dB(A) should fail');
  assert.equal(judge(cNoise, NaN), null, 'NaN should return null');

  const cGreen = CRITERIA.find((c) => c.id === 'green_view');
  assert.ok(cGreen, 'green_view criterion must exist in CRITERIA');
  assert.equal(cGreen.test, 'min');
  assert.equal(cGreen.threshold, 15);
  assert.equal(judge(cGreen, 20), true, '20 % >= 15 % should pass');
  assert.equal(judge(cGreen, 15), true, '15 % >= 15 % should pass');
  assert.equal(judge(cGreen, 10), false, '10 % < 15 % should fail');
  assert.equal(judge(cGreen, NaN), null, 'NaN should return null');
});
