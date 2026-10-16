import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareRule, checkRule, wallSamples, rayToRings, reach25, vscLong, allowedAngle, BRE_FACTOR } from '../../web/src/core/daylight_rule.js';

const square = (x0, y0, s) => [[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s]];
const tan25 = Math.tan((25 * Math.PI) / 180);

test('wall samples face outwards whichever way the ring runs', () => {
  for (const ring of [square(0, 0, 10), [...square(0, 0, 10)].reverse()]) {
    const east = wallSamples(ring, 3).filter((s) => Math.abs(s.x - 10) < 1e-9);
    assert.equal(east.length, 3);
    assert.ok(east.every((s) => s.nx === 1 && s.ny === 0));
  }
  assert.equal(rayToRings(5, 5, 1, 0, [square(20, 0, 10)]), 15);
  assert.equal(rayToRings(5, 5, -1, 0, [square(20, 0, 10)]), Infinity);
});

test('25° test: a building opposite passes under 25° and fails above it', () => {
  // Neighbour 0..10, target 10 m east of it (20..30); window centres 1.6 m up.
  const nb = [{ ring: square(0, 0, 10), windowZ: 1.6 }];
  const tg = [{ rings: [square(20, 0, 10)] }];
  const at25 = 1.6 + 10 * tan25;
  const prep = prepareRule(nb, tg, [5]);
  assert.equal(prep.windows, 3); // the three east-wall windows face the target
  assert.equal(checkRule(prep, [at25 - 0.05]).failing, 0);
  const r = checkRule(prep, [at25 + 2]);
  assert.equal(r.failing, 3);
  assert.equal(r.neighboursHit, 1);
  assert.ok(r.worstDeg > 25 && r.excessDeg > 0);
  assert.ok(Math.abs(reach25(10 * tan25) - 10) < 1e-9);
});

test('VSC of a long obstruction under the CIE overcast sky', () => {
  // An open vertical window: the 39.6 % maximum of the guidance.
  assert.ok(Math.abs(vscLong(0) - 0.396) < 0.001);
  assert.ok(Math.abs(vscLong(Math.PI / 2)) < 1e-12);
  // BRE 209 pairs a 25° obstruction with a VSC of about 27 %.
  assert.ok(Math.abs(vscLong((25 * Math.PI) / 180) - 0.273) < 0.001);
  let prev = vscLong(0);
  for (let d = 5; d <= 90; d += 5) { const v = vscLong((d * Math.PI) / 180); assert.ok(v < prev); prev = v; }
});

test('25° test: a window already over 25° may lose up to a fifth of its sky, not more', () => {
  const nb = [{ ring: square(0, 0, 10), windowZ: 1.6 }];
  const tg = [{ rings: [square(20, 0, 10)] }];
  const nowTop = 12; // about 46° now
  const prep = prepareRule(nb, tg, [nowTop]);
  assert.equal(checkRule(prep, [nowTop]).failing, 0);
  assert.equal(checkRule(prep, [nowTop - 1]).failing, 0);
  // The highest roof that keeps 0.8 of the window's VSC.
  const a = allowedAngle((nowTop - 1.6) / 10);
  assert.ok(Math.abs(vscLong(a) - BRE_FACTOR * vscLong(Math.atan((nowTop - 1.6) / 10))) < 1e-6);
  const limitTop = 1.6 + 10 * Math.tan(a);
  assert.ok(limitTop > nowTop + 0.5, `${limitTop}`);
  assert.equal(checkRule(prep, [limitTop - 0.05]).failing, 0);
  assert.equal(checkRule(prep, [limitTop + 0.05]).failing, 3);
});

test('25° test: a shared wall is not a window, a far building cannot reach 25°', () => {
  const nb = [{ ring: square(0, 0, 10), windowZ: 1.6 }];
  assert.equal(prepareRule(nb, [{ rings: [square(10, 0, 10)] }], [30]).windows, 0);
  assert.equal(prepareRule(nb, [{ rings: [square(300, 0, 10)] }], [30], { maxDist: 100 }).windows, 0);
});

// ---------------------------------------------------------------- VSC on the GPU's direction set
test('VSC weights: an open wall sums to 39.6 %, a long obstruction to the closed form', async () => {
  const { vscDirections, VSC_OPEN } = await import('../../web/src/core/daylight_rule.js');
  const { skyHemisphere } = await import('../../web/src/core/solar.js');
  const n = [1, 0, 0]; // a wall facing +x
  const sum = (dirs, visible) => dirs.reduce((s, d) => s + (visible(d.dir) ? d.weight * Math.max(0, d.dir[0] * n[0] + d.dir[1] * n[1] + d.dir[2] * n[2]) : 0), 0);
  const coarse = vscDirections(skyHemisphere(192));
  assert.ok(Math.abs(sum(coarse, () => true) - VSC_OPEN) / VSC_OPEN < 0.02, 'open wall within 2 % at 192 directions');
  // A long obstruction rising θ above the horizontal, seen at right angles to the wall:
  // a direction is blocked when its elevation in that section is below θ.
  const fine = vscDirections(skyHemisphere(20000));
  for (const deg of [10, 25, 45, 60]) {
    const t = (deg * Math.PI) / 180;
    const got = sum(fine, (d) => d[0] <= 0 || Math.atan2(d[1], d[0]) >= t);
    assert.ok(Math.abs(got - vscLong(t)) < 0.003, `${deg}°: ${got.toFixed(4)} vs ${vscLong(t).toFixed(4)}`);
  }
});

test('planning profile: an old facade_daylight entry switches on the VSC criterion at its own threshold', async () => {
  const { parseProfile } = await import('../../web/src/analysis/compliance.js');
  const p = parseProfile({ format: '02geo3d-planning-profile', name: 'old', criteria: [{ id: 'facade_daylight', threshold: 0.34 }, { id: 'wind', threshold: 4 }] });
  assert.deepEqual(p.criteria, ['facade_vsc', 'wind']);
  assert.equal(p.thresholds.facade_vsc, 27);
  assert.deepEqual(p.ignored, []);
});

test('party walls: closed against a neighbour up to its roof, open above it and in the street', async () => {
  const { coverIndex, coverAt, isOpen } = await import('../../web/src/core/party_walls.js');
  // A (0..10, 15 m tall) stands against B (10..20, 6 m tall); C is across a 12 m street.
  const idx = coverIndex([
    { id: 1, rings: [square(0, 0, 10)], bottom: 100, top: 115 },
    { id: 2, rings: [square(10, 0, 10)], bottom: 100, top: 106 },
    { id: 3, rings: [square(0, 22, 10)], bottom: 100, top: 120 }]);
  const spans = coverAt(idx, 10.6, 5, 1); // just east of A's east wall: inside B
  assert.deepEqual(spans, [[100, 106]]);
  assert.equal(isOpen(103, spans), false); // against B
  assert.equal(isOpen(110, spans), true);  // above B's roof: a real wall again
  assert.deepEqual(coverAt(idx, 5, 10.6, 1), []); // A's north wall faces the street
  assert.deepEqual(coverAt(idx, 5, 5, 1), []);     // its own footprint does not count
});
