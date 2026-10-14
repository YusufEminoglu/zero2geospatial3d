import test from 'node:test';
import assert from 'node:assert/strict';
import { solarPosition, sunriseSunset, sunPath, skyHemisphere, dayOfYear, sunVector } from '../../web/src/core/solar.js';

const deg = (r) => (r * 180) / Math.PI;

test('matches the NREL SPA reference case within 0.3 degrees', () => {
  // Reda & Andreas (2004) example: 2003-10-17 12:30:30 local, UTC-7,
  // 39.742476 N, 105.1786 W -> zenith 50.11162, azimuth 194.34024.
  const doy = dayOfYear(2003, 10, 17);
  const p = solarPosition(doy, 12 + 30 / 60 + 30 / 3600, 39.742476, -105.1786, -7);
  assert.ok(Math.abs(90 - deg(p.elevation) - 50.11162) < 0.3, `zenith ${90 - deg(p.elevation)}`);
  assert.ok(Math.abs(deg(p.azimuth) - 194.34024) < 0.3, `azimuth ${deg(p.azimuth)}`);
});

test('sun is due south at solar noon in the northern mid-latitudes', () => {
  // At lon = 15 * utcOffset the clock and solar time differ only by the equation of time.
  const doy = 172;
  let best = { el: -1, az: 0 };
  for (let h = 11; h <= 13; h += 1 / 120) {
    const p = solarPosition(doy, h, 41, 30, 2);
    if (p.elevation > best.el) best = { el: p.elevation, az: p.azimuth };
  }
  assert.ok(Math.abs(deg(best.az) - 180) < 1.5, `azimuth at max elevation ${deg(best.az)}`);
  // Noon elevation at the June solstice: 90 - 41 + 23.44.
  assert.ok(Math.abs(deg(best.el) - 72.44) < 0.3, `elevation ${deg(best.el)}`);
});

test('morning sun is in the east, afternoon sun in the west', () => {
  const am = solarPosition(80, 8, 38.4, 27.1, 3);
  const pm = solarPosition(80, 17, 38.4, 27.1, 3);
  assert.ok(deg(am.azimuth) > 60 && deg(am.azimuth) < 140, `am ${deg(am.azimuth)}`);
  assert.ok(deg(pm.azimuth) > 220 && deg(pm.azimuth) < 300, `pm ${deg(pm.azimuth)}`);
  const v = sunVector(am.elevation, am.azimuth);
  assert.ok(v[0] > 0, 'morning sun vector points east (+x)');
});

test('equinox day length is about 12 hours at the equator; polar night has no sunrise', () => {
  const { sunrise, sunset } = sunriseSunset(80, 0, 0, 0);
  assert.ok(sunrise !== null && sunset !== null);
  assert.ok(Math.abs(sunset - sunrise - 12.1) < 0.3, `day length ${sunset - sunrise}`);
  const polar = sunriseSunset(355, 80, 0, 0);
  assert.equal(polar.sunrise, null);
});

test('sun path weights add up to the daylight hours', () => {
  const lat = 38.4, lon = 27.1, tz = 3;
  const path = sunPath(172, lat, lon, tz, { stepMinutes: 5, minElevationDeg: 0 });
  const total = path.reduce((s, p) => s + p.weight, 0);
  const { sunrise, sunset } = sunriseSunset(172, lat, lon, tz);
  assert.ok(Math.abs(total - (sunset - sunrise)) < 0.15, `${total} vs ${sunset - sunrise}`);
  for (const p of path) assert.ok(p.dir[1] > 0);
});

test('hemisphere sampling gives sky view factor 1 for a roof and 0.5 for a wall', () => {
  const dirs = skyHemisphere(256);
  const svf = (n) => dirs.reduce((s, d) => s + d.weight * Math.max(0, n[0] * d.dir[0] + n[1] * d.dir[1] + n[2] * d.dir[2]), 0);
  assert.ok(Math.abs(svf([0, 1, 0]) - 1) < 0.01, `roof ${svf([0, 1, 0])}`);
  assert.ok(Math.abs(svf([1, 0, 0]) - 0.5) < 0.02, `wall ${svf([1, 0, 0])}`);
  assert.ok(Math.abs(svf([0, 0, -1]) - 0.5) < 0.02, `north wall ${svf([0, 0, -1])}`);
});
