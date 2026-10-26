// @ts-check
// Road line sources shared by the noise (acoustics.js) and traffic
// dispersion (dispersion.js) models: given polylines sampled into points that
// carry their share of road length times relative traffic, or, without
// roads, street centrelines found between the buildings.

/** Relative traffic of the streets found when no roads are given: a
 * residential street, as for OSM highway=residential (osm_tags.py). */
export const STREET_TRAFFIC = 0.4;

/**
 * Relative traffic of road polyline q: 1 without weights, 0 for a road
 * without traffic, never negative.
 * @param {ArrayLike<number>|null} weights
 * @param {number} q
 */
export function roadWeight(weights, q) {
  const w = weights ? Number(weights[q]) : 1;
  return Number.isFinite(w) ? Math.max(0, w) : 1;
}

/**
 * Points along road polylines, about `step` metres apart. Each point's
 * `length` is the road length it stands for times the road's traffic.
 * `given` is true when at least one usable polyline was passed, even if
 * all of them carry no traffic (those roads stay silent; no fallback).
 * @param {Array<Array<[number, number]>>|null|undefined} roads
 * @param {ArrayLike<number>|null} weights relative traffic per polyline (default 1)
 * @param {number} step metres between samples
 * @returns {{ sources: Array<{ x: number, y: number, length: number }>, given: boolean }}
 */
export function sampleRoadLines(roads, weights, step) {
  /** @type {Array<{ x: number, y: number, length: number }>} */
  const sources = [];
  let given = false;
  if (!Array.isArray(roads)) return { sources, given };
  for (let q = 0; q < roads.length; q++) {
    const poly = roads[q];
    if (!Array.isArray(poly) || poly.length < 2) continue;
    given = true;
    const w = roadWeight(weights, q);
    if (w === 0) continue;
    for (let p = 0; p < poly.length - 1; p++) {
      const [x1, y1] = poly[p];
      const [x2, y2] = poly[p + 1];
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (!(len > 0)) continue;
      const count = Math.max(1, Math.round(len / step));
      const segLen = len / count;
      for (let k = 0; k < count; k++) {
        const t = (k + 0.5) / count;
        sources.push({ x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1), length: segLen * w });
      }
    }
  }
  return { sources, given };
}

/**
 * Street centrelines when no roads are given: the ridge of the distance to
 * the nearest solid building (the open cells farthest from both sides of a
 * street), for streets up to 2 * maxHalfWidth wide. One source per ridge
 * cell, `cell` metres of residential street (STREET_TRAFFIC), so a street
 * counts once and not once per lane of cells. Empty without buildings.
 * @param {Float32Array} heights obstacle height per cell (0 = open)
 * @param {Float32Array|null} porosity tree porosity per cell (> 0 = not solid)
 * @param {number} cols
 * @param {number} rows
 * @param {number} cell metres per cell
 * @param {number} minX x of the first column's centre
 * @param {number} maxY y of the first row's centre
 * @param {number} [maxHalfWidth] metres from a facade to the street centre
 * @returns {Array<{ x: number, y: number, length: number }>}
 */
export function streetCentrelines(heights, porosity, cols, rows, cell, minX, maxY, maxHalfWidth = 25) {
  const n = cols * rows;
  const INF = 1e9;
  const dist = new Float32Array(n);
  let hasSolid = false;
  for (let i = 0; i < n; i++) {
    if (heights[i] > 0 && !(porosity && porosity[i] > 0)) { dist[i] = 0; hasSolid = true; } else dist[i] = INF;
  }
  if (!hasSolid) return [];
  // Two-pass chamfer distance (metres).
  const a = cell, b = cell * Math.SQRT2;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      let v = dist[i];
      if (c > 0) v = Math.min(v, dist[i - 1] + a);
      if (r > 0) {
        v = Math.min(v, dist[i - cols] + a);
        if (c > 0) v = Math.min(v, dist[i - cols - 1] + b);
        if (c < cols - 1) v = Math.min(v, dist[i - cols + 1] + b);
      }
      dist[i] = v;
    }
  }
  for (let r = rows - 1; r >= 0; r--) {
    for (let c = cols - 1; c >= 0; c--) {
      const i = r * cols + c;
      let v = dist[i];
      if (c < cols - 1) v = Math.min(v, dist[i + 1] + a);
      if (r < rows - 1) {
        v = Math.min(v, dist[i + cols] + a);
        if (c < cols - 1) v = Math.min(v, dist[i + cols + 1] + b);
        if (c > 0) v = Math.min(v, dist[i + cols - 1] + b);
      }
      dist[i] = v;
    }
  }
  /** @type {Array<{ x: number, y: number, length: number }>} */
  const sources = [];
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      const i = r * cols + c;
      const d = dist[i];
      if (d < cell || d > maxHalfWidth) continue;
      // A ridge across x or across y. Strict on one side only, so the
      // two-cell ridge of an even-width street counts once.
      const ridgeX = d >= dist[i - 1] && d > dist[i + 1];
      const ridgeY = d >= dist[i - cols] && d > dist[i + cols];
      if (ridgeX || ridgeY) sources.push({ x: minX + c * cell, y: maxY - r * cell, length: cell * STREET_TRAFFIC });
    }
  }
  return sources;
}
