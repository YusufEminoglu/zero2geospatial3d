import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEpw, windRose, clearSkyYear, annualSunBins, monthlySummary, conditionsAt, typicalDoy } from '../../web/src/core/weather.js';
import { utci, meanRadiantTemperature, utciCategory, projectedAreaFactor, skyTemperature } from '../../web/src/core/comfort.js';

const HEADER = [
  'LOCATION,Testville,TR,TUR,TMYx,172200,38.4,27.1,3.0,29.0',
  'DESIGN CONDITIONS,0', 'TYPICAL/EXTREME PERIODS,0', 'GROUND TEMPERATURES,0',
  'HOLIDAYS/DAYLIGHT SAVINGS,No,0,0,0', 'COMMENTS 1,synthetic', 'COMMENTS 2,synthetic',
  'DATA PERIODS,1,1,Data,Sunday, 1/ 1,12/31'
];
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function syntheticEpw({ windFrom = (h) => 0, windSpeed = () => 3 } = {}) {
  const rows = [];
  let k = 0;
  for (let m = 1; m <= 12; m++) {
    for (let d = 1; d <= DAYS[m - 1]; d++) {
      for (let h = 1; h <= 24; h++) {
        const dry = 10 + m;              // month-dependent temperature
        const ghi = h >= 8 && h <= 17 ? 400 : 0;
        const dni = h >= 8 && h <= 17 ? 500 : 0;
        const dhi = h >= 8 && h <= 17 ? 100 : 0;
        const f = [2001, m, d, h, 60, 'A7', dry, 5, 60, 101325, 0, 0, 330, ghi, dni, dhi, 0, 0, 0, 0, windFrom(k), windSpeed(k), 5, 5];
        rows.push(f.join(','));
        k++;
      }
    }
  }
  return HEADER.concat(rows).join('\n');
}

test('parses an EPW: location, 8760 hours, field positions', () => {
  const w = parseEpw(syntheticEpw());
  assert.equal(w.hours, 8760);
  assert.equal(w.location.city, 'Testville');
  assert.equal(w.location.utcOffset, 3);
  const c = conditionsAt(w, 7, 15, 12);
  assert.equal(c.airTemp, 17);
  assert.equal(c.dni, 500);
  assert.equal(c.dhi, 100);
  assert.equal(c.ir, 330);
  const months = monthlySummary(w);
  assert.ok(Math.abs(months[0].tMean - 11) < 1e-6);
  // 10 sunny hours x 400 Wh/m2 x 31 days = 124 kWh/m2 in January.
  assert.ok(Math.abs(months[0].ghiKwh - 124) < 1e-6);
});

test('rejects text that is not an EPW', () => {
  assert.throws(() => parseEpw('hello,world'));
});

test('wind rose finds the prevailing direction', () => {
  const w = parseEpw(syntheticEpw({ windFrom: (k) => (k % 4 === 0 ? 90 : 0), windSpeed: () => 5 }));
  const rose = windRose(w);
  assert.equal(rose.prevailingDirection, 0);
  assert.ok(Math.abs(rose.sectorFreq[0] - 0.75) < 1e-6);
  assert.ok(Math.abs(rose.sectorFreq[4] - 0.25) < 1e-6);
  assert.ok(Math.abs(rose.prevailingSpeed - 5) < 1e-6);
});

test('annual sun bins conserve the direct-beam total and point upwards', () => {
  const w = clearSkyYear(38.4, 27.1, 3);
  const bins = annualSunBins(w, { lat: 38.4, lon: 27.1, utcOffset: 3 });
  const sum = bins.directions.reduce((s, d) => s + d.weight, 0);
  assert.ok(Math.abs(sum - bins.dniSum) / bins.dniSum < 1e-9);
  assert.ok(bins.directions.length > 50 && bins.directions.length < 600, `${bins.directions.length} bins`);
  for (const d of bins.directions) {
    assert.ok(d.dir[1] > 0);
    assert.ok(Math.abs(Math.hypot(...d.dir) - 1) < 1e-6);
  }
  // Clear-sky global horizontal irradiation at 38 N: roughly 2000-2600 kWh/m2/yr.
  const ghi = bins.ghiSum / 1000;
  assert.ok(ghi > 1900 && ghi < 2700, `clear-sky GHI ${ghi}`);
});

test('typical day of year', () => {
  assert.equal(typicalDoy(1, 1), 1);
  assert.equal(typicalDoy(3, 1), 60);
  assert.equal(typicalDoy(12, 31), 365);
});

test('UTCI reproduces the documented reference values', () => {
  assert.equal(Math.round(utci(25, 25, 1.0, 50) * 10) / 10, 24.6);
  assert.equal(Math.round(utci(40, 25, 1.0, 50) * 10) / 10, 40.4);
  assert.ok(Number.isNaN(utci(25, 25, 0.1, 50, { limit: true })));
  assert.equal(utciCategory(20).label, 'No thermal stress');
  assert.equal(utciCategory(40).label, 'Very strong heat stress');
});

test('UTCI rises with radiant temperature and falls with wind in the heat', () => {
  assert.ok(utci(30, 50, 1, 40) > utci(30, 30, 1, 40));
  assert.ok(utci(30, 50, 4, 40) < utci(30, 50, 1, 40));
});

test('MRT: sun raises it, shade and open sky lower it', () => {
  const base = { airTemp: 30, skyTemp: skyTemperature(30, 380), dni: 800, dhi: 100, ghi: 750, elevationDeg: 60 };
  const sun = meanRadiantTemperature({ ...base, svf: 0.8, sunlit: 1 });
  const shade = meanRadiantTemperature({ ...base, svf: 0.8, sunlit: 0 });
  const night = meanRadiantTemperature({ ...base, svf: 1, sunlit: 0, ghi: 0, dni: 0, dhi: 0, elevationDeg: -10 });
  assert.ok(sun > shade + 10, `sun ${sun} shade ${shade}`);
  assert.ok(night < 30, `open sky at night ${night}`);
  assert.ok(sun > 45 && sun < 75, `sunlit MRT ${sun}`);
  assert.ok(projectedAreaFactor(0) > projectedAreaFactor(80));
});
