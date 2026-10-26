import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ventilationEfficiency,
  VENTILATION_CLASSES,
  ventilationClass,
  pollutantDispersion,
  AIR_QUALITY_CLASSES,
  airQualityClass
} from '../../web/src/core/dispersion.js';
import {
  maekawaDiffraction,
  noisePropagation,
  buildingFacadeNoise,
  NOISE_CLASSES,
  noiseClass
} from '../../web/src/core/acoustics.js';

test('ventilationEfficiency: open high-SVF high-wind cells have higher vei and lower airAge than sheltered canyon cells', () => {
  const cols = 10, rows = 10, cell = 5;
  const heights = new Float32Array(cols * rows);
  const windRatioGrid = new Float32Array(cols * rows);
  const svf = new Float32Array(cols * rows);

  // Open cell
  const idxOpen = 2 * cols + 2;
  windRatioGrid[idxOpen] = 1.3;
  svf[idxOpen] = 0.95;

  // Sheltered street-canyon cell
  const idxCanyon = 7 * cols + 7;
  windRatioGrid[idxCanyon] = 0.15;
  svf[idxCanyon] = 0.25;

  // Solid building cell
  const idxBldg = 5 * cols + 5;
  heights[idxBldg] = 20;

  const { vei, airAge } = ventilationEfficiency({ windRatioGrid, heights, svf, cols, rows, cell });

  assert.ok(vei[idxOpen] > 1.0, `open cell VEI ${vei[idxOpen]} should be > 1.0`);
  assert.ok(vei[idxCanyon] < 0.3, `canyon cell VEI ${vei[idxCanyon]} should be < 0.3`);
  assert.ok(vei[idxOpen] > vei[idxCanyon], `open VEI (${vei[idxOpen]}) must exceed canyon VEI (${vei[idxCanyon]})`);
  assert.ok(airAge[idxOpen] < airAge[idxCanyon], `open airAge (${airAge[idxOpen]}) must be lower than canyon airAge (${airAge[idxCanyon]})`);

  assert.ok(Number.isNaN(vei[idxBldg]), 'solid building cell VEI must be NaN');
  assert.ok(Number.isNaN(airAge[idxBldg]), 'solid building cell airAge must be NaN');

  assert.equal(ventilationClass(1.1)?.label, 'Well ventilated');
  assert.equal(ventilationClass(0.6)?.label, 'Moderate exchange');
  assert.equal(ventilationClass(0.4)?.label, 'Low ventilation');
  assert.equal(ventilationClass(0.1)?.label, 'Stagnation risk');
  assert.equal(ventilationClass(NaN), null);
});

test('pollutantDispersion: downwind of road line has higher concentration than upwind; low SVF increases concentration; trees reduce concentration', () => {
  const cols = 20, rows = 20, cell = 2;
  const heights = new Float32Array(cols * rows);
  const roadX = 20; // x = 20m in a 40m x 40m grid
  const roads = [[[roadX, 0], [roadX, 40]]];

  // Wind blows towards East (from 270 deg)
  const baseConc = pollutantDispersion({
    heights,
    cols,
    rows,
    cell,
    windFromDeg: 270,
    roads,
    backgroundUgM3: 18,
    emissionRateUgMS: 500
  });

  // Cell downwind: c = 14 (x = 29m) at row = 10 (y = 19m)
  const idxDownwind = 10 * cols + 14;
  // Cell upwind: c = 4 (x = 9m) at row = 10 (y = 19m)
  const idxUpwind = 10 * cols + 4;

  const cDown = baseConc[idxDownwind];
  const cUp = baseConc[idxUpwind];

  assert.ok(cDown > cUp, `downwind concentration (${cDown}) must be higher than upwind (${cUp})`);
  assert.ok(Math.abs(cUp - 18) < 0.01, `upwind concentration (${cUp}) should remain at background 18 ug/m3`);

  // Low SVF canyon trapping
  const svfHigh = new Float32Array(cols * rows).fill(0.9);
  const svfLow = new Float32Array(cols * rows).fill(0.25);

  const concHigh = pollutantDispersion({
    heights,
    svf: svfHigh,
    cols,
    rows,
    cell,
    windFromDeg: 270,
    roads,
    backgroundUgM3: 18
  });

  const concLow = pollutantDispersion({
    heights,
    svf: svfLow,
    cols,
    rows,
    cell,
    windFromDeg: 270,
    roads,
    backgroundUgM3: 18
  });

  // Cell near road downwind: c = 11 (x = 23m, dist = 3m < 30m)
  const idxNearDown = 10 * cols + 11;
  assert.ok(
    concLow[idxNearDown] > concHigh[idxNearDown],
    `low SVF canyon trapped conc (${concLow[idxNearDown]}) must exceed high SVF (${concHigh[idxNearDown]})`
  );

  // Tree canopy filtration
  const porosity = new Float32Array(cols * rows);
  porosity[idxNearDown] = 0.5;

  const concTree = pollutantDispersion({
    heights,
    porosity,
    cols,
    rows,
    cell,
    windFromDeg: 270,
    roads,
    backgroundUgM3: 18,
    treeDepositionFactor: 0.3
  });

  const concNoTree = pollutantDispersion({
    heights,
    cols,
    rows,
    cell,
    windFromDeg: 270,
    roads,
    backgroundUgM3: 18
  });

  assert.ok(
    concTree[idxNearDown] < concNoTree[idxNearDown],
    `tree filtration conc (${concTree[idxNearDown]}) must be lower than without tree (${concNoTree[idxNearDown]})`
  );

  // Air quality classification
  assert.equal(airQualityClass(15)?.label, 'Good');
  assert.equal(airQualityClass(32)?.label, 'Moderate');
  assert.equal(airQualityClass(55)?.label, 'Elevated');
  assert.equal(airQualityClass(88)?.label, 'High');
  assert.equal(airQualityClass(NaN), null);
});

test('maekawaDiffraction: returns 0 for unobstructed and increases monotonically up to 20 dB', () => {
  assert.equal(maekawaDiffraction(0), 0);
  assert.equal(maekawaDiffraction(-1.5), 0);

  const d1 = maekawaDiffraction(0.05);
  const d2 = maekawaDiffraction(0.2);
  const d3 = maekawaDiffraction(0.6);
  const d4 = maekawaDiffraction(1.5);
  const dCapped = maekawaDiffraction(100.0);

  assert.ok(d1 > 0, `d1 (${d1}) should be > 0`);
  assert.ok(d2 > d1, `d2 (${d2}) should be > d1 (${d1})`);
  assert.ok(d3 > d2, `d3 (${d3}) should be > d2 (${d2})`);
  assert.ok(d4 > d3, `d4 (${d4}) should be > d3 (${d3})`);
  assert.equal(dCapped, 20, 'single diffraction is capped at 20 dB (ISO 9613-2)');
});

test('noisePropagation and buildingFacadeNoise: distance decay, shadow zone barrier attenuation, and quiet facade detection', async () => {
  const cols = 30, rows = 30, cell = 2;
  const heights = new Float32Array(cols * rows);
  const ids = new Int32Array(cols * rows);

  // Road along south boundary (y = 2m in grid)
  const roads = [[[0, 2], [60, 2]]];

  // 1. Distance decay check on open flat terrain
  const openNoise = await noisePropagation({
    heights,
    cols,
    rows,
    cell,
    roads,
    soundPowerDb: 80
  });

  // Near road (row = 28, y = 3m) vs far (row = 5, y = 49m)
  const idxNear = 28 * cols + 15;
  const idxFar = 5 * cols + 15;
  assert.ok(
    openNoise[idxNear] > openNoise[idxFar],
    `near noise (${openNoise[idxNear]}) must exceed far noise (${openNoise[idxFar]})`
  );

  // 2. Tall building barrier: building 1 at rows 18..22, cols 8..22 (height = 20m)
  for (let r = 18; r <= 22; r++) {
    for (let c = 8; c <= 22; c++) {
      const idx = r * cols + c;
      heights[idx] = 20;
      ids[idx] = 1;
    }
  }

  const barrierNoise = await noisePropagation({
    heights,
    cols,
    rows,
    cell,
    roads,
    soundPowerDb: 80
  });

  // Front facade cell (south of building, row = 25, y = 9m)
  const idxFront = 25 * cols + 15;
  // Shielded back facade cell (north of building, row = 15, y = 29m)
  const idxBack = 15 * cols + 15;

  assert.ok(
    Number.isNaN(barrierNoise[20 * cols + 15]),
    'building interior must be NaN'
  );
  assert.ok(
    barrierNoise[idxFront] - barrierNoise[idxBack] >= 10,
    `front noise (${barrierNoise[idxFront]}) should exceed shadow zone back noise (${barrierNoise[idxBack]}) by at least 10 dB(A)`
  );

  // 3. Facade noise summary
  const facadeMap = buildingFacadeNoise(barrierNoise, ids, cols, rows);
  const bldg1 = facadeMap.get(1);

  assert.ok(bldg1, 'building 1 stats must exist');
  assert.ok(bldg1.max > bldg1.min, `facade max (${bldg1.max}) must exceed min (${bldg1.min})`);
  assert.ok(bldg1.max - bldg1.min >= 6, `facade difference (${bldg1.max - bldg1.min}) must be >= 6 dB(A)`);
  assert.equal(bldg1.quietFacade, 1, 'quietFacade must be 1 due to shielded courtyard/back');

  // 4. Noise classification
  assert.equal(noiseClass(48)?.label, 'Quiet');
  assert.equal(noiseClass(58)?.label, 'Moderate');
  assert.equal(noiseClass(67)?.label, 'Loud');
  assert.equal(noiseClass(74)?.label, 'High noise');
  assert.equal(noiseClass(NaN), null);
});

test('road traffic weights: doubling the traffic adds 3 dB and doubles the traffic increment; zero traffic is silent', async () => {
  const cols = 20, rows = 20, cell = 2;
  const heights = new Float32Array(cols * rows);
  const roads = [[[20, 0], [20, 40]]];
  const base = { heights, cols, rows, cell, minX: 1, maxY: 39, roads };
  const i = 10 * cols + 15; // 9 m east of the road

  const n1 = await noisePropagation({ ...base, roadWeights: [1] });
  const n2 = await noisePropagation({ ...base, roadWeights: [2] });
  assert.ok(Math.abs(n2[i] - n1[i] - 10 * Math.log10(2)) < 0.05, `+${(n2[i] - n1[i]).toFixed(2)} dB, expected +3.01 dB`);
  // A road without traffic stays silent instead of falling back to street corridors.
  const n0 = await noisePropagation({ ...base, roadWeights: [0] });
  assert.equal(n0[i], 35);

  const wind = { windFromDeg: 270, windSpeed10: 3, backgroundUgM3: 18 };
  const c1 = pollutantDispersion({ ...base, ...wind, roadWeights: [1] });
  const c2 = pollutantDispersion({ ...base, ...wind, roadWeights: [2] });
  const inc1 = c1[i] - 18, inc2 = c2[i] - 18;
  assert.ok(inc1 > 0, 'downwind cell sees traffic');
  assert.ok(Math.abs(inc2 / inc1 - 2) < 0.01, `traffic increment x${(inc2 / inc1).toFixed(3)}, expected x2`);
  const c0 = pollutantDispersion({ ...base, ...wind, roadWeights: [0] });
  assert.equal(c0[i], 18);
});

test('streetCentrelines: one source line per street, on its centre, none without buildings', async () => {
  const { streetCentrelines, STREET_TRAFFIC } = await import('../../web/src/core/road_sources.js');
  const cols = 30, rows = 10, cell = 1;
  const heights = new Float32Array(cols * rows);
  // Two building rows with a 9 m street (columns 10..18) between them.
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (c < 10 || c > 18) heights[r * cols + c] = 12;
  const src = streetCentrelines(heights, null, cols, rows, cell, 0.5, rows - 0.5);
  const xs = new Set(src.map((s) => s.x));
  assert.deepEqual([...xs], [14.5], 'the street centre column only');
  assert.equal(src.length, rows - 2);
  assert.ok(src.every((s) => s.length === cell * STREET_TRAFFIC));
  // An even-width street (10 m) still gives one line.
  heights.fill(0);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (c < 10 || c > 19) heights[r * cols + c] = 12;
  assert.equal(new Set(streetCentrelines(heights, null, cols, rows, cell, 0.5, rows - 0.5).map((s) => s.x)).size, 1);
  assert.equal(streetCentrelines(new Float32Array(cols * rows), null, cols, rows, cell, 0.5, rows - 0.5).length, 0);
});
