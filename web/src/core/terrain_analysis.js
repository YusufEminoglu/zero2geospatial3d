// @ts-check
// Terrain derivatives of a DEM grid ({ cols, rows, cell, minX, maxY, values },
// row-major from the north-west): curvature, topographic position,
// ruggedness, flow accumulation and wetness, and aspect classes.
// Edges are handled by repeating the border cell; NaN cells stay NaN.

const clampIndex = (v, n) => (v < 0 ? 0 : v >= n ? n - 1 : v);

/**
 * The part of a grid inside an area, coarsened by whole cells until it has
 * at most maxCells (block means, NaN ignored).
 */
export function cropGrid(g, area, maxCells = 4_000_000) {
  const c0 = Math.max(0, Math.floor((area.minX - g.minX) / g.cell + 0.5));
  const c1 = Math.min(g.cols - 1, Math.ceil((area.maxX - g.minX) / g.cell - 0.5));
  const r0 = Math.max(0, Math.floor((g.maxY - area.maxY) / g.cell + 0.5));
  const r1 = Math.min(g.rows - 1, Math.ceil((g.maxY - area.minY) / g.cell - 0.5));
  if (c1 < c0 || r1 < r0) throw new Error('The area does not overlap the terrain.');
  const w = c1 - c0 + 1, hgt = r1 - r0 + 1;
  const k = Math.max(1, Math.ceil(Math.sqrt((w * hgt) / maxCells)));
  const cols = Math.ceil(w / k), rows = Math.ceil(hgt / k);
  const values = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let s = 0, n = 0;
      for (let dr = 0; dr < k; dr++) {
        const rr = r0 + r * k + dr;
        if (rr > r1) break;
        for (let dc = 0; dc < k; dc++) {
          const cc = c0 + c * k + dc;
          if (cc > c1) break;
          const v = g.values[rr * g.cols + cc];
          if (Number.isFinite(v)) { s += v; n++; }
        }
      }
      values[r * cols + c] = n ? s / n : NaN;
    }
  }
  // Cell centres of the coarse grid: the centre of each k x k block.
  const cell = g.cell * k;
  return { cols, rows, cell, minX: g.minX + (c0 + (k - 1) / 2) * g.cell, maxY: g.maxY - (r0 + (k - 1) / 2) * g.cell, values, factor: k };
}

/**
 * General curvature (Zevenbergen and Thorne 1987) in 1/100 m, the
 * convention of most GIS: positive on convex ground (ridges, crests),
 * negative on concave ground (valleys, hollows).
 */
export function curvature(g) {
  const { cols, rows, cell, values: z } = g;
  const out = new Float32Array(cols * rows);
  const L2 = cell * cell;
  for (let r = 0; r < rows; r++) {
    const ru = clampIndex(r - 1, rows), rd = clampIndex(r + 1, rows);
    for (let c = 0; c < cols; c++) {
      const cl = clampIndex(c - 1, cols), cr = clampIndex(c + 1, cols);
      const z5 = z[r * cols + c];
      const D = ((z[r * cols + cl] + z[r * cols + cr]) / 2 - z5) / L2;
      const E = ((z[ru * cols + c] + z[rd * cols + c]) / 2 - z5) / L2;
      out[r * cols + c] = -2 * (D + E) * 100;
    }
  }
  return out;
}

/** Summed-area table (with NaN cells counted as missing) for window means. */
function integral(g) {
  const { cols, rows, values: z } = g;
  const W = cols + 1;
  const sum = new Float64Array(W * (rows + 1));
  const cnt = new Float64Array(W * (rows + 1));
  for (let r = 0; r < rows; r++) {
    let rs = 0, rc = 0;
    for (let c = 0; c < cols; c++) {
      const v = z[r * cols + c];
      if (Number.isFinite(v)) { rs += v; rc++; }
      sum[(r + 1) * W + c + 1] = sum[r * W + c + 1] + rs;
      cnt[(r + 1) * W + c + 1] = cnt[r * W + c + 1] + rc;
    }
  }
  return { sum, cnt, W };
}

/**
 * Topographic position index (Weiss 2001): elevation minus the mean
 * elevation of a square window of radius `radius` cells around it.
 * Positive on hilltops and ridges, negative in valleys, near 0 on flat
 * ground and even slopes.
 */
export function tpi(g, radius) {
  const { cols, rows, values: z } = g;
  const R = Math.max(1, Math.round(radius));
  const { sum, cnt, W } = integral(g);
  const out = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const a = Math.max(0, r - R), b = Math.min(rows - 1, r + R);
    for (let c = 0; c < cols; c++) {
      const v = z[r * cols + c];
      if (!Number.isFinite(v)) { out[r * cols + c] = NaN; continue; }
      const l = Math.max(0, c - R), rt = Math.min(cols - 1, c + R);
      const s = sum[(b + 1) * W + rt + 1] - sum[a * W + rt + 1] - sum[(b + 1) * W + l] + sum[a * W + l];
      const n = cnt[(b + 1) * W + rt + 1] - cnt[a * W + rt + 1] - cnt[(b + 1) * W + l] + cnt[a * W + l];
      // Mean of the neighbours, the cell itself left out.
      out[r * cols + c] = n > 1 ? v - (s - v) / (n - 1) : 0;
    }
  }
  return out;
}

/** Terrain ruggedness index (Riley et al. 1999): root of the summed squared differences to the 8 neighbours, in metres. */
export function ruggedness(g) {
  const { cols, rows, values: z } = g;
  const out = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = z[r * cols + c];
      if (!Number.isFinite(v)) { out[r * cols + c] = NaN; continue; }
      let s = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const n = z[clampIndex(r + dr, rows) * cols + clampIndex(c + dc, cols)];
          if (Number.isFinite(n)) s += (n - v) * (n - v);
        }
      }
      out[r * cols + c] = Math.sqrt(s);
    }
  }
  return out;
}

/** Aspect classes: 0 flat (slope under flatDeg), 1 N, 2 NE, ... 8 NW. */
export function aspectClasses(slope, aspect, flatDeg = 1) {
  const out = new Float32Array(slope.length);
  for (let i = 0; i < slope.length; i++) {
    if (!Number.isFinite(slope[i])) { out[i] = NaN; continue; }
    if (slope[i] < flatDeg || aspect[i] < 0) { out[i] = 0; continue; }
    out[i] = 1 + (Math.floor((aspect[i] + 22.5) / 45) % 8);
  }
  return out;
}

// ---------------------------------------------------------------- flow
/** Binary min-heap of cell indices keyed by a Float64 priority. */
class Heap {
  constructor(capacity) {
    this.idx = new Int32Array(capacity);
    this.key = new Float64Array(capacity);
    this.n = 0;
  }

  push(i, k) {
    let p = this.n++;
    while (p > 0) {
      const q = (p - 1) >> 1;
      if (this.key[q] <= k) break;
      this.idx[p] = this.idx[q]; this.key[p] = this.key[q];
      p = q;
    }
    this.idx[p] = i; this.key[p] = k;
  }

  pop() {
    const top = this.idx[0];
    const li = this.idx[--this.n], lk = this.key[this.n];
    let p = 0;
    for (;;) {
      let q = 2 * p + 1;
      if (q >= this.n) break;
      if (q + 1 < this.n && this.key[q + 1] < this.key[q]) q++;
      if (this.key[q] >= lk) break;
      this.idx[p] = this.idx[q]; this.key[p] = this.key[q];
      p = q;
    }
    this.idx[p] = li; this.key[p] = lk;
    return top;
  }
}

const DC = [-1, 0, 1, -1, 1, -1, 0, 1], DR = [-1, -1, -1, 0, 0, 1, 1, 1];

/**
 * Flow accumulation in cells (each cell counts itself) by D8 steepest
 * descent on a depression-filled surface: priority flood from the edges
 * (Barnes et al. 2014) with a small rise across flats so every cell drains
 * to the edge. NaN cells are outlets, like the edge; water that reaches an
 * edge cell leaves the DEM there instead of running along the edge (the
 * ground beyond it is unknown).
 * @returns {{ acc: Float32Array, filled: Float32Array, order: Int32Array }}
 */
export function flowAccumulation(g) {
  const { cols, rows, cell, values: z } = g;
  const N = cols * rows;
  const filled = new Float64Array(N);
  const done = new Uint8Array(N);
  const isEdge = new Uint8Array(N);
  const order = new Int32Array(N); // cells in pop order: every cell after the cell it drains to
  let popped = 0;
  const heap = new Heap(N);
  const eps = 1e-5 * Math.max(1, cell);
  for (let i = 0; i < N; i++) {
    const r = (i / cols) | 0, c = i - r * cols;
    if (!Number.isFinite(z[i])) { done[i] = 1; filled[i] = -Infinity; continue; }
    let edge = r === 0 || c === 0 || r === rows - 1 || c === cols - 1;
    for (let k = 0; k < 8 && !edge; k++) if (!Number.isFinite(z[(r + DR[k]) * cols + c + DC[k]])) edge = true;
    if (edge) { filled[i] = z[i]; done[i] = 1; isEdge[i] = 1; heap.push(i, z[i]); }
  }
  while (heap.n) {
    const i = heap.pop();
    order[popped++] = i;
    const r = (i / cols) | 0, c = i - r * cols;
    for (let k = 0; k < 8; k++) {
      const rr = r + DR[k], cc = c + DC[k];
      if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
      const j = rr * cols + cc;
      if (done[j]) continue;
      done[j] = 1;
      filled[j] = Math.max(z[j], filled[i] + eps);
      heap.push(j, filled[j]);
    }
  }
  // Receiver: steepest descent on the filled surface (diagonals over √2 cells).
  const acc = new Float32Array(N);
  for (let n = 0; n < popped; n++) acc[order[n]] = 1;
  for (let n = popped - 1; n >= 0; n--) {
    const i = order[n];
    const r = (i / cols) | 0, c = i - r * cols;
    let best = -1, drop = 0;
    for (let k = 0; k < 8; k++) {
      const rr = r + DR[k], cc = c + DC[k];
      if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
      const j = rr * cols + cc;
      if (!Number.isFinite(z[j]) || (isEdge[i] && isEdge[j])) continue;
      const d = (filled[i] - filled[j]) / (DC[k] && DR[k] ? Math.SQRT2 : 1);
      if (d > drop) { drop = d; best = j; }
    }
    if (best >= 0) acc[best] += acc[i];
  }
  for (let i = 0; i < N; i++) if (!Number.isFinite(z[i])) acc[i] = NaN;
  return { acc, filled: Float32Array.from(filled, (v) => (Number.isFinite(v) ? v : NaN)), order: order.subarray(0, popped) };
}

/**
 * Topographic wetness index ln(a / tan β) (Beven and Kirkby 1979): a is the
 * upslope area per unit contour width (accumulated cells x cell size), β the
 * local slope. High on flat ground that collects water.
 */
export function wetness(g, slopeDeg, acc = flowAccumulation(g).acc) {
  const out = new Float32Array(acc.length);
  const minTan = Math.tan((0.1 * Math.PI) / 180);
  for (let i = 0; i < acc.length; i++) {
    if (!Number.isFinite(acc[i]) || !Number.isFinite(slopeDeg[i])) { out[i] = NaN; continue; }
    const tanB = Math.max(minTan, Math.tan((slopeDeg[i] * Math.PI) / 180));
    out[i] = Math.log((acc[i] * g.cell) / tanB);
  }
  return out;
}

/** Value at the p-th percentile (0..1) of the finite values, from a sample. */
export function percentile(values, p, sample = 200000) {
  const step = Math.max(1, Math.floor(values.length / sample));
  const s = [];
  for (let i = 0; i < values.length; i += step) if (Number.isFinite(values[i])) s.push(values[i]);
  if (!s.length) return NaN;
  s.sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
}
