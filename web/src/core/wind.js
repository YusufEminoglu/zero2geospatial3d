// @ts-check
// Pedestrian-level wind screening on a building-height grid. NOT CFD: a fast
// geometric estimate meant to find sheltered and exposed places, to be
// confirmed with a flow simulation or wind-tunnel test where it matters.
//
// For each open cell the ratio to the open-terrain pedestrian wind is
//   ratio = (1 - wake deficit) x channelling x corner factor
// wake deficit   strongest upwind wake: A exp(-x / (k h)) for an obstacle of
//                height h at distance x (recovery over about 10-15 h, the
//                usual near-wake length behind a building)
// channelling    open fetch along the wind with buildings close on both
//                sides (a street aligned with the wind) speeds the flow up
// corner factor  cells beside a building much taller than its surroundings
//                (downwash and corner streams)
// The open-terrain pedestrian wind is the 10 m reference speed scaled by a
// log profile over open terrain: ln(1.5/z0) / ln(10/z0) with z0 = 0.03 m.

export const OPEN_PEDESTRIAN_FACTOR = Math.log(1.5 / 0.03) / Math.log(10 / 0.03);

/**
 * @param {object} p
 * @param {Float32Array} p.heights obstacle height above ground per cell (0 = open)
 * @param {Float32Array|null} [p.porosity] optical porosity per cell 0..1 (trees ~0.5), null = solid
 * @param {number} p.cols
 * @param {number} p.rows
 * @param {number} p.cell metres
 * @param {number} p.windFromDeg meteorological direction the wind comes from
 * @param {number} [p.wakeAmplitude]
 * @param {number} [p.wakeLength] recovery length in obstacle heights
 * @param {(f: number) => void} [p.onProgress]
 * @returns {Promise<Float32Array>} ratio per cell, NaN inside buildings
 */
export async function windRatio({ heights, porosity = null, cols, rows, cell, windFromDeg, wakeAmplitude = 0.75, wakeLength = 3.5, onProgress }) {
  const out = new Float32Array(cols * rows);
  // Unit vector pointing upwind (towards where the wind comes from), in
  // grid steps: +x east = +col, +y north = -row.
  const from = windFromDeg * Math.PI / 180;
  const ux = Math.sin(from);
  const uy = Math.cos(from);
  const dc = ux;
  const dr = -uy;
  // Perpendicular (for channelling).
  const pc = -dr;
  const pr = dc;
  let hMax = 0, hSum = 0, hN = 0;
  for (const h of heights) { if (h > hMax) hMax = h; if (h > 0) { hSum += h; hN++; } }
  const hMean = hN ? hSum / hN : 0;
  let hasTall = false;
  for (const h of heights) if (h > 2 * hMean && h > 20) { hasTall = true; break; }
  const maxSteps = Math.ceil(Math.min(600, Math.max(60, wakeLength * 5 * hMax)) / cell);
  const sideSteps = Math.ceil(40 / cell);
  const at = (c, r) => (c < 0 || r < 0 || c >= cols || r >= rows ? 0 : heights[Math.round(r) * cols + Math.round(c)]);
  const poro = (c, r) => (porosity ? porosity[Math.round(r) * cols + Math.round(c)] || 0 : 0);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (heights[i] > 0 && !(porosity && porosity[i] > 0)) { out[i] = NaN; continue; }
      // 1. Wake deficit from upwind obstacles.
      let deficit = 0;
      let fetch = maxSteps * cell;
      for (let s = 1; s <= maxSteps; s++) {
        const cc = c + dc * s;
        const rr = r + dr * s;
        if (cc < 0 || rr < 0 || cc > cols - 1 || rr > rows - 1) break;
        const h = at(cc, rr);
        if (h <= 0) continue;
        const x = s * cell;
        if (x < fetch) fetch = x;
        const d = wakeAmplitude * (1 - poro(cc, rr)) * Math.exp(-x / (wakeLength * h));
        if (d > deficit) deficit = d;
        if (x > wakeLength * 5 * hMax) break;
      }
      // 2. Channelling: buildings close on both sides, open along the wind.
      let left = 0, right = 0, hl = 0, hr = 0;
      for (let s = 1; s <= sideSteps && !left; s++) { const h = at(c + pc * s, r + pr * s); if (h > 0) { left = s * cell; hl = h; } }
      for (let s = 1; s <= sideSteps && !right; s++) { const h = at(c - pc * s, r - pr * s); if (h > 0) { right = s * cell; hr = h; } }
      let channel = 1;
      if (left && right) {
        const width = left + right;
        const hSide = Math.min(hl, hr);
        const along = Math.min(1, fetch / (3 * width));
        channel = 1 + 0.25 * along * Math.min(1, hSide / width);
      }
      // 3. Corner/downwash: a much taller building close by.
      let corner = 1;
      if (hasTall) {
        const rad = Math.ceil(30 / cell);
        let best = 0;
        for (let dy = -rad; dy <= rad; dy += 2) {
          for (let dx = -rad; dx <= rad; dx += 2) {
            const h = at(c + dx, r + dy);
            if (h > 2 * hMean && h > 20) {
              const dist = Math.hypot(dx, dy) * cell;
              if (dist < 0.6 * h) best = Math.max(best, (1 - dist / (0.6 * h)) * Math.min(1, h / (4 * hMean)));
            }
          }
        }
        corner = 1 + 0.35 * best;
      }
      out[i] = Math.max(0.05, Math.min(1.6, (1 - deficit) * channel * corner));
    }
    if (onProgress && r % 32 === 0) {
      onProgress(r / rows);
      await new Promise((res) => setTimeout(res, 0));
    }
  }
  return out;
}

/**
 * Indicative pedestrian comfort class for a wind speed (m/s) at pedestrian
 * height, with the thresholds of the LDDC (Lawson) criteria: sitting < 4,
 * standing < 6, strolling < 8, business walking < 10. Lawson applies them to
 * the speed exceeded 5 percent of the time, so feed it the 95th-percentile
 * reference speed, not the mean.
 */
export function lawsonClass(speed) {
  if (!Number.isFinite(speed)) return null;
  if (speed < 4) return { key: 'sitting', label: 'Sitting', color: '#2c7bb6' };
  if (speed < 6) return { key: 'standing', label: 'Standing', color: '#abd9e9' };
  if (speed < 8) return { key: 'strolling', label: 'Strolling', color: '#ffffbf' };
  if (speed < 10) return { key: 'walking', label: 'Business walking', color: '#fdae61' };
  return { key: 'uncomfortable', label: 'Uncomfortable', color: '#d7191c' };
}
