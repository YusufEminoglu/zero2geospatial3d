import test from 'node:test';
import assert from 'node:assert/strict';
import { pet, petCategory, PET_CATEGORIES, meanRadiantTemperature, skyTemperature } from '../../web/src/core/comfort.js';
import {
  SURFACE_MATERIALS,
  canopyTransmittance,
  surfaceTemperature,
  canopyCoolingGrid,
  diurnalPointProfile
} from '../../web/src/core/microclimate.js';
import { parseEpw } from '../../web/src/core/weather.js';

test('pet: reproduces reference indoor comfort around 20 °C', () => {
  const pRef = pet(20, 20, 0.1, 50, { met: 80, clo: 0.9 });
  assert.ok(Number.isFinite(pRef), 'pet must be finite');
  assert.ok(Math.abs(pRef - 20) <= 1.5, `reference PET should be near 20 °C, got ${pRef}`);
});

test('pet: increases monotonically with air and radiant temperature', () => {
  const pWarm = pet(30, 30, 1.0, 50);
  const pCool = pet(20, 20, 1.0, 50);
  assert.ok(pWarm > pCool, `warm ${pWarm} should be > cool ${pCool}`);

  const pHighRad = pet(25, 45, 1.0, 50);
  const pLowRad = pet(25, 25, 1.0, 50);
  assert.ok(pHighRad > pLowRad, `high rad ${pHighRad} should be > low rad ${pLowRad}`);
});

test('pet: wind cooling in hot radiant conditions decreases PET significantly', () => {
  const pLowWind = pet(32, 55, 0.5, 50);
  const pHighWind = pet(32, 55, 4.0, 50);
  assert.ok(pHighWind < pLowWind - 4.0, `wind should reduce PET in heat: highWind=${pHighWind}, lowWind=${pLowWind}`);
});

test('pet: handles edge cases and invalid inputs gracefully', () => {
  assert.ok(Number.isNaN(pet(NaN, 20, 1, 50)));
  assert.ok(Number.isNaN(pet(20, NaN, 1, 50)));
  // missing optional wind or rh uses robust clamped defaults
  assert.ok(Number.isFinite(pet(25, 25, null, null)));
});

test('petCategory: maps thresholds to Matzarakis thermal stress levels', () => {
  assert.equal(PET_CATEGORIES.length, 9);
  assert.equal(petCategory(2).label, 'Extreme cold stress');
  assert.equal(petCategory(6).label, 'Strong cold stress');
  assert.equal(petCategory(11).label, 'Moderate cold stress');
  assert.equal(petCategory(16).label, 'Slight cold stress');
  assert.equal(petCategory(20).label, 'Comfortable');
  assert.equal(petCategory(26).label, 'Slight heat stress');
  assert.equal(petCategory(32).label, 'Moderate heat stress');
  assert.equal(petCategory(38).label, 'Strong heat stress');
  assert.equal(petCategory(45).label, 'Extreme heat stress');
  assert.equal(petCategory(NaN), null);
});

test('MRT: surface-aware groundTemp and wallTemp vs backward compatibility', () => {
  const base = {
    airTemp: 30,
    skyTemp: 15,
    svf: 0.8,
    sunlit: 1,
    dni: 800,
    dhi: 100,
    ghi: 750,
    elevationDeg: 60,
    albedo: 0.2,
    absorptivity: 0.7
  };

  const mrtDefault = meanRadiantTemperature(base);
  const mrtExplicitNaN = meanRadiantTemperature({ ...base, groundTemp: NaN, wallTemp: NaN });
  assert.equal(mrtDefault, mrtExplicitNaN, 'omitted groundTemp/wallTemp must match exact default formula');

  // Hot ground surface radiates strongly into the lower hemisphere
  const mrtHotGround = meanRadiantTemperature({ ...base, groundTemp: 55 });
  assert.ok(mrtHotGround > mrtDefault, `hot ground ${mrtHotGround} should be > default ${mrtDefault}`);

  // Warm canyon walls radiate into the non-sky portion of the upper hemisphere
  const canyonBase = { ...base, svf: 0.3 };
  const mrtCoolWalls = meanRadiantTemperature({ ...canyonBase, wallTemp: 30 });
  const mrtHotWalls = meanRadiantTemperature({ ...canyonBase, wallTemp: 50 });
  assert.ok(mrtHotWalls > mrtCoolWalls, `hot canyon walls ${mrtHotWalls} should be > cool walls ${mrtCoolWalls}`);
});

test('surfaceTemperature: materials in midday sun and nighttime cooling', () => {
  const midday = {
    airTemp: 30,
    skyTemp: 15,
    svf: 1.0,
    sunlit: 1,
    dni: 850,
    dhi: 120,
    ghi: 850,
    elevationDeg: 65,
    windSpeed: 2
  };

  const tAsphalt = surfaceTemperature({ ...midday, material: 'asphalt' });
  const tConcrete = surfaceTemperature({ ...midday, material: 'concrete' });
  const tCool = surfaceTemperature({ ...midday, material: 'cool_pavement' });
  const tGrass = surfaceTemperature({ ...midday, material: 'grass' });

  assert.ok(tAsphalt > tConcrete, `asphalt (${tAsphalt}) should be hotter than concrete (${tConcrete})`);
  assert.ok(tConcrete > tCool, `concrete (${tConcrete}) should be hotter than cool pavement (${tCool})`);
  assert.ok(tConcrete > tGrass, `concrete (${tConcrete}) should be hotter than grass (${tGrass})`);

  // Nighttime radiative cooling below ambient air temperature under clear open sky
  const tNight = surfaceTemperature({
    airTemp: 20,
    skyTemp: 2,
    svf: 1.0,
    sunlit: 0,
    dni: 0,
    dhi: 0,
    ghi: 0,
    elevationDeg: -20,
    windSpeed: 1.5,
    material: 'concrete'
  });
  assert.ok(tNight < 20, `nighttime surface (${tNight}) should be cooler than air (20)`);
});

test('surfaceTemperature: tree canopy shading attenuates solar radiation', () => {
  const midday = {
    airTemp: 32,
    skyTemp: 18,
    svf: 0.9,
    sunlit: 1,
    dni: 800,
    dhi: 100,
    ghi: 800,
    elevationDeg: 60,
    windSpeed: 2,
    material: 'concrete'
  };

  const tUnshaded = surfaceTemperature({ ...midday, treeShade: 0 });
  const tShaded = surfaceTemperature({ ...midday, treeShade: 1, lai: 3.5 });
  assert.ok(tShaded < tUnshaded - 10, `shaded surface (${tShaded}) should be much cooler than unshaded (${tUnshaded})`);

  // Beer-Lambert canopy transmittance
  assert.ok(canopyTransmittance(4.0) < canopyTransmittance(1.5));
  assert.ok(Math.abs(canopyTransmittance(0) - 1.0) < 1e-6);
});

test('canopyCoolingGrid: evapotranspiration cooling under trees and downwind advection', () => {
  const cols = 25;
  const rows = 25;
  const cell = 5;
  const heights = new Float32Array(cols * rows);
  const porosity = new Float32Array(cols * rows);
  const svf = new Float32Array(cols * rows).fill(0.8);

  // Tree cell at row 12, col 8
  const treeR = 12;
  const treeC = 8;
  const treeIdx = treeR * cols + treeC;
  porosity[treeIdx] = 0.5;
  heights[treeIdx] = 7;

  // Solid building at row 2, col 2
  const bldgIdx = 2 * cols + 2;
  heights[bldgIdx] = 15;

  // Deep canyon at row 20, col 20
  const canyonIdx = 20 * cols + 20;
  svf[canyonIdx] = 0.2;

  // Wind from 270 (blowing East, towards +col)
  const dTa = canopyCoolingGrid({
    heights,
    porosity,
    cols,
    rows,
    cell,
    windFromDeg: 270,
    windSpeed: 2.5,
    airTemp: 32,
    rh: 40,
    lai: 3.0,
    svf
  });

  // Solid building cell is NaN
  assert.ok(Number.isNaN(dTa[bldgIdx]), 'building cell should be NaN');

  // Tree cell generates significant cooling (< -1.0 °C)
  const treeCooling = dTa[treeIdx];
  assert.ok(treeCooling < -1.0, `tree cell cooling should be < -1.0 °C, got ${treeCooling}`);

  // Downwind cell (e.g. 15 m east at treeR, treeC + 3) receives advected cooling
  const downwindIdx = treeR * cols + (treeC + 3);
  const downwindCooling = dTa[downwindIdx];
  assert.ok(downwindCooling < -0.2, `downwind cell should receive advected cooling, got ${downwindCooling}`);
  assert.ok(downwindCooling > treeCooling, `cooling should decay downwind: tree=${treeCooling}, downwind=${downwindCooling}`);

  // Upwind cell (e.g. 15 m west at treeR, treeC - 3) receives no tree cooling
  const upwindIdx = treeR * cols + (treeC - 3);
  assert.equal(dTa[upwindIdx], 0, 'upwind cell should not receive tree cooling');

  // Deep canyon cell with low SVF shows urban canyon heat trapping increment
  assert.ok(dTa[canyonIdx] > 0, `low-SVF canyon should have positive dTa, got ${dTa[canyonIdx]}`);
});

test('diurnalPointProfile: generates 24-hour finite thermal comfort profile with diurnal wave', () => {
  const profile = diurnalPointProfile({
    lat: 38.4,
    lon: 27.1,
    utcOffset: 3,
    month: 7,
    day: 15,
    airTempMean: 28,
    airTempAmp: 6,
    rhMean: 50,
    windSpeed: 2,
    svf: 0.7,
    material: 'concrete'
  });

  assert.equal(profile.length, 24);
  for (let h = 0; h < 24; h++) {
    const p = profile[h];
    assert.equal(p.hour, h);
    assert.ok(Number.isFinite(p.airTemp), `hour ${h} airTemp must be finite`);
    assert.ok(Number.isFinite(p.surfaceTemp), `hour ${h} surfaceTemp must be finite`);
    assert.ok(Number.isFinite(p.mrt), `hour ${h} mrt must be finite`);
    assert.ok(Number.isFinite(p.utci), `hour ${h} utci must be finite`);
    assert.ok(Number.isFinite(p.pet), `hour ${h} pet must be finite`);
  }

  // Midday conditions (e.g. 14:00) should be warmer than early morning night conditions (04:00)
  const pMidday = profile[14];
  const pNight = profile[4];
  assert.ok(pMidday.airTemp > pNight.airTemp, 'midday airTemp should be > night airTemp');
  assert.ok(pMidday.surfaceTemp > pNight.surfaceTemp, 'midday surfaceTemp should be > night surfaceTemp');
  assert.ok(pMidday.mrt > pNight.mrt, 'midday MRT should be > night MRT');
  assert.ok(pMidday.utci > pNight.utci, 'midday UTCI should be > night UTCI');
  assert.ok(pMidday.pet > pNight.pet, 'midday PET should be > night PET');
});
