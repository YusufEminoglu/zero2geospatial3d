// @ts-check
// Terrain grid operations. A grid is { cols, rows, cell, minX, maxY, values }
// with values row-major from the north-west cell; (minX, maxY) is the centre
// of that cell in local metres (x east, y north).

export function makeGrid(cols, rows, cell, minX, maxY, values = new Float32Array(cols * rows)) {
  return { cols, rows, cell, minX, maxY, values };
}

export function cellCentre(g, c, r) {
  return [g.minX + c * g.cell, g.maxY - r * g.cell];
}

/** Bilinear height at local (x, y); clamped at the edges. */
export function sample(g, x, y) {
  const fc = Math.max(0, Math.min(g.cols - 1, (x - g.minX) / g.cell));
  const fr = Math.max(0, Math.min(g.rows - 1, (g.maxY - y) / g.cell));
  const c0 = Math.min(g.cols - 2, Math.floor(fc));
  const r0 = Math.min(g.rows - 2, Math.floor(fr));
  if (g.cols < 2 || g.rows < 2) return g.values[0] || 0;
  const tx = fc - c0;
  const ty = fr - r0;
  const v = g.values;
  const i = r0 * g.cols + c0;
  const a = v[i] * (1 - tx) + v[i + 1] * tx;
  const b = v[i + g.cols] * (1 - tx) + v[i + g.cols + 1] * tx;
  return a * (1 - ty) + b * ty;
}

/** Horn (1981) slope (degrees) and aspect (degrees clockwise from north, facing downslope; -1 for flat). */
export function slopeAspect(g) {
  const { cols, rows, cell, values: z } = g;
  const slope = new Float32Array(cols * rows);
  const aspect = new Float32Array(cols * rows);
  const at = (c, r) => z[Math.max(0, Math.min(rows - 1, r)) * cols + Math.max(0, Math.min(cols - 1, c))];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = at(c - 1, r - 1), b = at(c, r - 1), cc = at(c + 1, r - 1);
      const d = at(c - 1, r), f = at(c + 1, r);
      const gg = at(c - 1, r + 1), h = at(c, r + 1), i = at(c + 1, r + 1);
      const dzdx = ((cc + 2 * f + i) - (a + 2 * d + gg)) / (8 * cell); // towards east
      const dzdy = ((a + 2 * b + cc) - (gg + 2 * h + i)) / (8 * cell); // towards north
      const k = r * cols + c;
      slope[k] = Math.atan(Math.hypot(dzdx, dzdy)) * 180 / Math.PI;
      if (dzdx === 0 && dzdy === 0) { aspect[k] = -1; continue; }
      // Downslope direction is -gradient; bearing clockwise from north.
      let az = Math.atan2(-dzdx, -dzdy) * 180 / Math.PI;
      if (az < 0) az += 360;
      aspect[k] = az;
    }
  }
  return { slope, aspect };
}

/** Horn slope (degrees) and aspect (degrees, -1 flat) of one cell. */
export function slopeAspectAt(g, c, r) {
  const { cols, rows, cell, values: z } = g;
  const at = (cc, rr) => z[Math.max(0, Math.min(rows - 1, rr)) * cols + Math.max(0, Math.min(cols - 1, cc))];
  const dzdx = ((at(c + 1, r - 1) + 2 * at(c + 1, r) + at(c + 1, r + 1)) - (at(c - 1, r - 1) + 2 * at(c - 1, r) + at(c - 1, r + 1))) / (8 * cell);
  const dzdy = ((at(c - 1, r - 1) + 2 * at(c, r - 1) + at(c + 1, r - 1)) - (at(c - 1, r + 1) + 2 * at(c, r + 1) + at(c + 1, r + 1))) / (8 * cell);
  const slope = Math.atan(Math.hypot(dzdx, dzdy)) * 180 / Math.PI;
  if (dzdx === 0 && dzdy === 0) return { slope, aspect: -1 };
  let aspect = Math.atan2(-dzdx, -dzdy) * 180 / Math.PI;
  if (aspect < 0) aspect += 360;
  return { slope, aspect };
}

/**
 * Hillshade 0..1 for a light from azimuth/altitude (degrees), in one pass
 * without slope/aspect arrays (a 16 M-cell DEM would need 128 MB for them).
 */
export function hillshade(g, azimuthDeg = 315, altitudeDeg = 45, zFactor = 1) {
  const { cols, rows, cell, values: z } = g;
  const out = new Float32Array(cols * rows);
  const zen = (90 - altitudeDeg) * Math.PI / 180;
  const az = azimuthDeg * Math.PI / 180;
  // Unit vector towards the light in (east, north, up).
  const lx = Math.sin(zen) * Math.sin(az), ly = Math.sin(zen) * Math.cos(az), lz = Math.cos(zen);
  const k = zFactor / (8 * cell);
  for (let r = 0; r < rows; r++) {
    const ru = r > 0 ? r - 1 : 0, rd = r < rows - 1 ? r + 1 : rows - 1;
    for (let c = 0; c < cols; c++) {
      const cl = c > 0 ? c - 1 : 0, cr = c < cols - 1 ? c + 1 : cols - 1;
      const a = z[ru * cols + cl], b = z[ru * cols + c], cc = z[ru * cols + cr];
      const d = z[r * cols + cl], f = z[r * cols + cr];
      const gg = z[rd * cols + cl], hh = z[rd * cols + c], i = z[rd * cols + cr];
      const dzdx = ((cc + 2 * f + i) - (a + 2 * d + gg)) * k;  // towards east
      const dzdy = ((a + 2 * b + cc) - (gg + 2 * hh + i)) * k;  // towards north
      // Surface normal (-dz/dx, -dz/dy, 1), normalised, dotted with the light.
      out[r * cols + c] = Math.max(0, (-dzdx * lx - dzdy * ly + lz) / Math.sqrt(dzdx * dzdx + dzdy * dzdy + 1));
    }
  }
  return out;
}

/**
 * Contour line segments by marching squares.
 * @returns {{ level: number, segments: number[] }[]} segments as flat [x1, y1, x2, y2, ...]
 */
export function contours(g, interval, { base = 0, maxLevels = 400 } = {}) {
  const { cols, rows, values: z } = g;
  let lo = Infinity, hi = -Infinity;
  for (const v of z) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!(interval > 0) || !Number.isFinite(lo)) return [];
  // One pass over the cells: each cell emits segments only for the levels
  // between its lowest and highest corner, so the cost does not grow with
  // the number of levels (a 4096 x 4096 DEM stays interactive).
  const kFirst = Math.ceil((lo - base) / interval);
  const kLast = Math.min(Math.floor((hi - base) / interval), kFirst + maxLevels - 1);
  const segs = new Map();
  const { cell, minX, maxY } = g;
  const pts = [];
  for (let r = 0; r < rows - 1; r++) {
    const ya = maxY - r * cell;
    const yb = ya - cell;
    for (let c = 0; c < cols - 1; c++) {
      const v0 = z[r * cols + c], v1 = z[r * cols + c + 1];
      const v2 = z[(r + 1) * cols + c + 1], v3 = z[(r + 1) * cols + c];
      const cmin = Math.min(v0, v1, v2, v3);
      const cmax = Math.max(v0, v1, v2, v3);
      const k0 = Math.max(kFirst, Math.ceil((cmin - base) / interval));
      const k1 = Math.min(kLast, Math.floor((cmax - base) / interval));
      if (k1 < k0) continue;
      const xa = minX + c * cell;
      const xb = xa + cell;
      for (let k = k0; k <= k1; k++) {
        const level = base + k * interval;
        pts.length = 0;
        if ((v0 < level) !== (v1 < level)) { const t = (level - v0) / (v1 - v0); pts.push(xa + cell * t, ya); }
        if ((v1 < level) !== (v2 < level)) { const t = (level - v1) / (v2 - v1); pts.push(xb, ya - cell * t); }
        if ((v2 < level) !== (v3 < level)) { const t = (level - v2) / (v3 - v2); pts.push(xb - cell * t, yb); }
        if ((v3 < level) !== (v0 < level)) { const t = (level - v3) / (v0 - v3); pts.push(xa, yb + cell * t); }
        if (pts.length !== 4 && pts.length !== 8) continue; // 8: a saddle, two segments
        let arr = segs.get(k);
        if (!arr) { arr = []; segs.set(k, arr); }
        for (const p of pts) arr.push(p);
      }
    }
  }
  return [...segs.keys()].sort((a, b) => a - b).map((k) => ({ level: base + k * interval, segments: segs.get(k) }));
}

/** Sample heights along a polyline every `step` metres: [{ d, x, y, z }]. */
export function profile(g, points, step = null) {
  const s = step || g.cell / 2;
  const out = [];
  let dist = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.ceil(len / s));
    for (let k = i === 0 ? 0 : 1; k <= n; k++) {
      const t = k / n;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      out.push({ d: dist + len * t, x, y, z: sample(g, x, y) });
    }
    dist += len;
  }
  return out;
}

/**
 * Cells under a water level. With a seed (local x, y) only cells connected to
 * it (4-neighbours) flood, like water rising from that point; without one,
 * every cell below the level floods (a plain "bathtub").
 * @returns {{ depth: Float32Array, floodedCells: number, area: number, volume: number, maxDepth: number }}
 */
export function flood(g, level, seed = null) {
  const { cols, rows, cell, values: z } = g;
  const depth = new Float32Array(cols * rows).fill(NaN);
  let count = 0, volume = 0, maxDepth = 0;
  const mark = (i) => {
    const d = level - z[i];
    depth[i] = d;
    count++;
    volume += d * cell * cell;
    if (d > maxDepth) maxDepth = d;
  };
  if (seed) {
    const c0 = Math.round((seed[0] - g.minX) / cell);
    const r0 = Math.round((g.maxY - seed[1]) / cell);
    if (c0 < 0 || r0 < 0 || c0 >= cols || r0 >= rows || z[r0 * cols + c0] >= level) {
      return { depth, floodedCells: 0, area: 0, volume: 0, maxDepth: 0 };
    }
    const seen = new Uint8Array(cols * rows);
    const stack = [r0 * cols + c0];
    seen[stack[0]] = 1;
    while (stack.length) {
      const i = /** @type {number} */ (stack.pop());
      mark(i);
      const c = i % cols, r = (i - c) / cols;
      const next = [c > 0 ? i - 1 : -1, c < cols - 1 ? i + 1 : -1, r > 0 ? i - cols : -1, r < rows - 1 ? i + cols : -1];
      for (const j of next) {
        if (j >= 0 && !seen[j] && z[j] < level) { seen[j] = 1; stack.push(j); }
      }
    }
  } else {
    for (let i = 0; i < z.length; i++) if (z[i] < level) mark(i);
  }
  return { depth, floodedCells: count, area: count * cell * cell, volume, maxDepth };
}

export function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Cut and fill to bring the ground inside a polygon to a flat design level.
 * @returns {{ cut: number, fill: number, net: number, area: number, delta: Float32Array }}
 *   cut/fill in m3; delta = design - ground per cell (NaN outside)
 */
export function cutFill(g, ring, designLevel) {
  const { cols, rows, cell, values: z } = g;
  const delta = new Float32Array(cols * rows).fill(NaN);
  let cut = 0, fill = 0, n = 0;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of ring) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const c0 = Math.max(0, Math.floor((minX - g.minX) / cell));
  const c1 = Math.min(cols - 1, Math.ceil((maxX - g.minX) / cell));
  const r0 = Math.max(0, Math.floor((g.maxY - maxY) / cell));
  const r1 = Math.min(rows - 1, Math.ceil((g.maxY - minY) / cell));
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const [x, y] = cellCentre(g, c, r);
      if (!pointInRing(x, y, ring)) continue;
      const i = r * cols + c;
      const d = designLevel - z[i];
      delta[i] = d;
      n++;
      if (d > 0) fill += d * cell * cell; else cut -= d * cell * cell;
    }
  }
  return { cut, fill, net: fill - cut, area: n * cell * cell, delta };
}

/**
 * Design level that balances cut and fill inside the polygon (bisection
 * between the lowest and highest ground inside it). A polygon smaller than
 * a cell holds no cell centre: the ground at its centre is the balance.
 */
export function balancedLevel(g, ring) {
  let lo = Infinity, hi = -Infinity;
  const { delta } = cutFill(g, ring, 0); // -ground inside, NaN outside
  for (const d of delta) { if (Number.isFinite(d)) { if (-d < lo) lo = -d; if (-d > hi) hi = -d; } }
  if (!(lo <= hi)) {
    let x = 0, y = 0;
    for (const p of ring) { x += p[0]; y += p[1]; }
    const c = Math.max(0, Math.min(g.cols - 1, Math.round((x / ring.length - g.minX) / g.cell)));
    const r = Math.max(0, Math.min(g.rows - 1, Math.round((g.maxY - y / ring.length) / g.cell)));
    return g.values[r * g.cols + c];
  }
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const { net } = cutFill(g, ring, mid);
    if (net > 0) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

export function gridStats(values) {
  let min = Infinity, max = -Infinity, sum = 0, n = 0;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    n++;
  }
  return { min, max, mean: n ? sum / n : NaN, count: n };
}
