// @ts-check
// Daylight to neighbouring windows after BRE 209 (Site layout planning for
// daylight and sunlight). Seen from the centre of a neighbour's lowest window,
// in a section at right angles to the window wall, new building rising more
// than 25° above the horizontal may take noticeable daylight; it then passes
// if the window keeps at least 0.8 times its former vertical sky component.
// Here the VSC is that of a long obstruction at the angle the new building
// subtends (closed form for the CIE overcast sky below), which overstates the
// loss for a short building: a screening on the safe side.
// Prepared once for a set of neighbour walls and buildings whose heights
// change; checking a design is then a few operations per window, so it can
// sit inside an optimiser.

const TAN25 = Math.tan((25 * Math.PI) / 180);
const DEG = 180 / Math.PI;
/** BRE 209: a loss to less than 0.8 times the former value is noticeable. */
export const BRE_FACTOR = 0.8;

/**
 * Vertical sky component (0..1) of a window facing a long obstruction
 * parallel to it whose top is `angle` radians above the horizontal in the
 * section at right angles to the wall, under the CIE standard overcast sky
 * (luminance ∝ 1 + 2 sin γ). With ψ the elevation in that section and β the
 * angle out of it, a direction is (cos β cos ψ, cos β sin ψ, sin β); the sky
 * above ψ = θ, weighted by the cosine to the wall normal and divided by the
 * unobstructed horizontal illuminance 7π/3, integrates to
 *   VSC(θ) = [ (π/2)(1 − sin θ) + (4/3) cos²θ ] / (7π/3):
 * 39.6 % for an open window and 27.3 % at 25°, the pair BRE 209 relates
 * (checked against direct numerical integration in the tests).
 */
export function vscLong(angle) {
  const t = Math.max(0, Math.min(Math.PI / 2, angle));
  return ((Math.PI / 2) * (1 - Math.sin(t)) + (4 / 3) * Math.cos(t) ** 2) / ((7 * Math.PI) / 3);
}

function signedArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return a / 2;
}

/** Distance along a ray (p + t d, t > 0) to the nearest edge of the rings, or Infinity. */
export function rayToRings(px, py, dx, dy, rings) {
  let best = Infinity;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const ax = ring[j][0], ay = ring[j][1];
      const ex = ring[i][0] - ax, ey = ring[i][1] - ay;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const wx = ax - px, wy = ay - py;
      const t = (wx * ey - wy * ex) / den;
      const u = (wx * dy - wy * dx) / den;
      if (t > 1e-9 && u >= 0 && u <= 1 && t < best) best = t;
    }
  }
  return best;
}

function inside(x, y, rings) {
  let odd = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) odd = !odd;
    }
  }
  return odd;
}

/** Window samples on the outer walls of a building: every `step` metres, with the outward normal. */
export function wallSamples(ring, step = 3) {
  const out = [];
  const ccw = signedArea(ring) > 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ax = ring[j][0], ay = ring[j][1], ex = ring[i][0] - ax, ey = ring[i][1] - ay;
    const len = Math.hypot(ex, ey);
    if (len < 1) continue;
    const nx = (ccw ? ey : -ey) / len, ny = (ccw ? -ex : ex) / len;
    const n = Math.max(1, Math.round(len / step));
    for (let k = 0; k < n; k++) {
      const s = (k + 0.5) / n;
      out.push({ x: ax + ex * s, y: ay + ey * s, nx, ny });
    }
  }
  return out;
}

/**
 * @param {{ ring: number[][], windowZ: number }[]} neighbours outer ring and window-centre height of each neighbour
 * @param {{ rings: number[][][] }[]} targets footprints of the buildings whose heights change
 * @param {number[]} topsNow roof heights of the targets now (absolute)
 * @param {{ step?: number, maxDist?: number, partyWall?: number }} [o]
 *   maxDist: no target farther than this can reach 25° (from the tallest allowed roof);
 *   partyWall: hits closer than this are a shared wall, not a window opposite.
 */
export function prepareRule(neighbours, targets, topsNow, { step = 3, maxDist = 200, partyWall = 1 } = {}) {
  const sampleZ = [], sampleNowTan = [], pairStart = [0], pairTarget = [], pairDist = [], owner = [];
  neighbours.forEach((nb, k) => {
    for (const s of wallSamples(nb.ring, step)) {
      const before = pairTarget.length;
      let shared = false;
      targets.forEach((t, ti) => {
        if (shared) return;
        // A wall the target stands against (the point just in front of it is
        // inside the target) or one a hair away is a shared wall, not a window.
        if (inside(s.x + s.nx * partyWall * 0.5, s.y + s.ny * partyWall * 0.5, t.rings)) { shared = true; return; }
        const d = rayToRings(s.x, s.y, s.nx, s.ny, t.rings);
        if (d < partyWall) { shared = true; return; }
        if (d <= maxDist) { pairTarget.push(ti); pairDist.push(d); }
      });
      if (shared || pairTarget.length === before) { pairTarget.length = before; pairDist.length = before; continue; }
      let now = 0;
      for (let p = before; p < pairTarget.length; p++) now = Math.max(now, (topsNow[pairTarget[p]] - nb.windowZ) / pairDist[p]);
      sampleZ.push(nb.windowZ);
      sampleNowTan.push(now);
      owner.push(k);
      pairStart.push(pairTarget.length);
    }
  });
  return {
    windows: sampleZ.length,
    sampleZ: Float64Array.from(sampleZ), nowTan: Float64Array.from(sampleNowTan), owner: Int32Array.from(owner),
    pairStart: Int32Array.from(pairStart), pairTarget: Int32Array.from(pairTarget), pairDist: Float64Array.from(pairDist)
  };
}

/**
 * Check a design. A window passes when the targets stay under 25° from it,
 * or when its VSC stays at least 0.8 times what it is now.
 * excessDeg: how far, in degrees, the failing windows' obstruction rises
 * above the highest angle they would still pass at (for an optimiser).
 * @param {ReturnType<typeof prepareRule>} prep
 * @param {ArrayLike<number>} tops roof heights of the targets in this design (absolute)
 * @returns {{ failing: number, excessDeg: number, worstDeg: number, neighboursHit: number }}
 */
export function checkRule(prep, tops) {
  let failing = 0, excess = 0, worst = 0;
  const hit = new Set();
  for (let s = 0; s < prep.windows; s++) {
    const z = prep.sampleZ[s];
    let tan = 0;
    for (let p = prep.pairStart[s]; p < prep.pairStart[s + 1]; p++) {
      const v = (tops[prep.pairTarget[p]] - z) / prep.pairDist[p];
      if (v > tan) tan = v;
    }
    if (tan > worst) worst = tan;
    if (tan <= TAN25 + 1e-12) continue;
    const allowed = allowedAngle(prep.nowTan[s]);
    const angle = Math.atan(tan);
    if (angle > allowed + 1e-9) {
      failing++;
      excess += (angle - allowed) * DEG;
      hit.add(prep.owner[s]);
    }
  }
  return { failing, excessDeg: excess, worstDeg: Math.atan(worst) * DEG, neighboursHit: hit.size };
}

/** VSC of an unobstructed vertical window (0.396). */
export const VSC_OPEN = vscLong(0);
/** BRE 209: a window with a VSC of 27 % or more keeps enough daylight. */
export const VSC_TARGET = 0.27;

/**
 * Sky directions weighted so that the GPU sum of weight x visibility x
 * max(0, n.d) on a vertical window is its VSC: each direction stands for an
 * equal solid angle 2π/n of the hemisphere, the CIE overcast sky luminance
 * goes as 1 + 2 sin γ, and the unobstructed horizontal illuminance is 7π/3
 * in the same units, so weight = (2π/n)(1 + 2 sin γ) / (7π/3).
 * @param {{ dir: number[] }[]} hemisphere directions uniform in solid angle (y up)
 */
export function vscDirections(hemisphere) {
  const n = hemisphere.length;
  return hemisphere.map((d) => ({ dir: d.dir, weight: (6 / (7 * n)) * (1 + 2 * Math.max(0, d.dir[1])) }));
}

const allowedCache = new Map();
/** The highest obstruction angle (radians) a window may have: 25°, or what keeps 0.8 of its VSC now. */
export function allowedAngle(nowTan) {
  const key = Math.round(Math.max(0, nowTan) * 1e4);
  let a = allowedCache.get(key);
  if (a !== undefined) return a;
  const target = BRE_FACTOR * vscLong(Math.atan(key / 1e4));
  // VSC falls with the angle: bisect for VSC(a) = target.
  let lo = 0, hi = Math.PI / 2;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (vscLong(mid) > target) lo = mid; else hi = mid;
  }
  a = Math.max(Math.atan(TAN25), lo);
  if (allowedCache.size < 50000) allowedCache.set(key, a);
  return a;
}

/** Distance beyond which a roof `rise` metres above a window stays under 25°. */
export function reach25(rise) {
  return Math.max(0, rise) / TAN25;
}
