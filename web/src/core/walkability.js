// @ts-check
// Pedestrian Cool Walkability Index (PCWI) and A* thermally-optimal route
// finder across the open-ground analysis grid.
//
// Combines thermal comfort (UTCI), solar shade, Green View Index (Konijnendijk
// 3-30-300 rule), road traffic noise (WHO 53/65 dB thresholds) and terrain
// slope into a 0-100 pedestrian quality index, and compares the shortest
// obstacle-free route against the coolest / highest-comfort route.

export const WALKABILITY_CLASSES = [
  { min: 75, max: 101, label: 'Excellent (cool, shaded & quiet)', color: '#1d8f5f' },
  { min: 55, max: 75, label: 'Good pedestrian comfort', color: '#6dbf67' },
  { min: 35, max: 55, label: 'Moderate (exposed or noisy)', color: '#f0b429' },
  { min: 0, max: 35, label: 'Poor (heat stress / high noise / steep)', color: '#d64545' }
];

export function walkabilityClass(score) {
  if (!Number.isFinite(score)) return null;
  const s = Math.max(0, Math.min(100, score));
  return WALKABILITY_CLASSES.find((c) => s >= c.min && s < c.max) || WALKABILITY_CLASSES[WALKABILITY_CLASSES.length - 1];
}

export function thermalSubscore(utciC) {
  if (!Number.isFinite(utciC)) return NaN;
  if (utciC >= 9 && utciC <= 26) return 100;
  if (utciC > 26) return Math.max(0, Math.min(100, 100 * (1 - (utciC - 26) / 16)));
  return Math.max(0, Math.min(100, 100 * (1 - (9 - utciC) / 19)));
}

export function shadeSubscore(shadeVal) {
  if (!Number.isFinite(shadeVal)) return NaN;
  const frac = shadeVal > 1.01 ? shadeVal / 100 : shadeVal;
  return Math.max(0, Math.min(100, frac * 100));
}

export function greenSubscore(gviPct) {
  if (!Number.isFinite(gviPct)) return NaN;
  return Math.max(0, Math.min(100, (gviPct / 30) * 100));
}

export function quietSubscore(noiseDba) {
  if (!Number.isFinite(noiseDba)) return NaN;
  if (noiseDba <= 50) return 100;
  if (noiseDba >= 75) return 0;
  return 100 * (1 - (noiseDba - 50) / 25);
}

export function slopeSubscore(slopeDeg) {
  if (!Number.isFinite(slopeDeg)) return NaN;
  if (slopeDeg <= 2) return 100;
  if (slopeDeg >= 12) return 0;
  return 100 * (1 - (slopeDeg - 2) / 10);
}

/**
 * Compute a 0-100 Pedestrian Cool Walkability Index on open ground.
 */
export function pedestrianWalkabilityIndex({
  ids = null,
  utciGrid = null,
  shadeGrid = null,
  gviGrid = null,
  noiseGrid = null,
  slopeDegGrid = null,
  cols,
  rows,
  weights = {}
}) {
  const n = cols * rows;
  const out = new Float32Array(n).fill(NaN);
  const wThermal = Math.max(0, weights.thermal ?? 0.35);
  const wShade = Math.max(0, weights.shade ?? 0.25);
  const wGreen = Math.max(0, weights.green ?? 0.15);
  const wQuiet = Math.max(0, weights.quiet ?? 0.15);
  const wSlope = Math.max(0, weights.slope ?? 0.10);

  for (let i = 0; i < n; i++) {
    if (ids && ids[i] !== 0) continue;
    let sum = 0;
    let wSum = 0;
    if (utciGrid) {
      const s = thermalSubscore(utciGrid[i]);
      if (Number.isFinite(s)) { sum += wThermal * s; wSum += wThermal; }
    }
    if (shadeGrid) {
      const s = shadeSubscore(shadeGrid[i]);
      if (Number.isFinite(s)) { sum += wShade * s; wSum += wShade; }
    }
    if (gviGrid) {
      const s = greenSubscore(gviGrid[i]);
      if (Number.isFinite(s)) { sum += wGreen * s; wSum += wGreen; }
    }
    if (noiseGrid) {
      const s = quietSubscore(noiseGrid[i]);
      if (Number.isFinite(s)) { sum += wQuiet * s; wSum += wQuiet; }
    }
    if (slopeDegGrid) {
      const s = slopeSubscore(slopeDegGrid[i]);
      if (Number.isFinite(s)) { sum += wSlope * s; wSum += wSlope; }
    }
    if (wSum > 0) out[i] = Math.max(0, Math.min(100, sum / wSum));
  }
  return out;
}

function nearestWalkableCell(ids, walkScore, cols, rows, cell, minX, maxY, xy) {
  const c0 = Math.max(0, Math.min(cols - 1, Math.round((xy[0] - minX) / cell)));
  const r0 = Math.max(0, Math.min(rows - 1, Math.round((maxY - xy[1]) / cell)));
  const isOk = (idx) => (!ids || ids[idx] === 0) && (!walkScore || Number.isFinite(walkScore[idx]));
  if (isOk(r0 * cols + c0)) return r0 * cols + c0;
  const maxRad = Math.max(cols, rows);
  for (let rad = 1; rad <= maxRad; rad++) {
    let best = -1;
    let bestDist = Infinity;
    const rMin = Math.max(0, r0 - rad), rMax = Math.min(rows - 1, r0 + rad);
    const cMin = Math.max(0, c0 - rad), cMax = Math.min(cols - 1, c0 + rad);
    for (let r = rMin; r <= rMax; r++) {
      for (let c = cMin; c <= cMax; c++) {
        if (Math.abs(r - r0) !== rad && Math.abs(c - c0) !== rad) continue;
        const idx = r * cols + c;
        if (!isOk(idx)) continue;
        const d = (r - r0) * (r - r0) + (c - c0) * (c - c0);
        if (d < bestDist) { bestDist = d; best = idx; }
      }
    }
    if (best >= 0) return best;
  }
  return -1;
}

function aStarPath(cols, rows, startIdx, endIdx, passableFn, stepPenaltyFn) {
  const n = cols * rows;
  const gScore = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const endR = Math.floor(endIdx / cols), endC = endIdx % cols;

  // Binary min-heap of (fScore, cellIndex)
  const heapF = [];
  const heapIdx = [];
  const push = (f, idx) => {
    let i = heapF.length;
    heapF.push(f);
    heapIdx.push(idx);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapF[p] <= f) break;
      heapF[i] = heapF[p]; heapIdx[i] = heapIdx[p];
      i = p;
    }
    heapF[i] = f; heapIdx[i] = idx;
  };
  const pop = () => {
    const topIdx = heapIdx[0];
    const lastF = heapF.pop();
    const lastIdx = heapIdx.pop();
    if (heapF.length > 0 && lastF !== undefined && lastIdx !== undefined) {
      let i = 0;
      const half = heapF.length >> 1;
      while (i < half) {
        let l = (i << 1) + 1;
        const r = l + 1;
        if (r < heapF.length && heapF[r] < heapF[l]) l = r;
        if (lastF <= heapF[l]) break;
        heapF[i] = heapF[l]; heapIdx[i] = heapIdx[l];
        i = l;
      }
      heapF[i] = lastF; heapIdx[i] = lastIdx;
    }
    return topIdx;
  };

  gScore[startIdx] = 0;
  push(Math.hypot(Math.floor(startIdx / cols) - endR, (startIdx % cols) - endC), startIdx);

  const dr = [-1, -1, -1, 0, 0, 1, 1, 1];
  const dc = [-1, 0, 1, -1, 1, -1, 0, 1];
  const dLen = [Math.SQRT2, 1, Math.SQRT2, 1, 1, Math.SQRT2, 1, Math.SQRT2];

  while (heapF.length > 0) {
    const curr = pop();
    if (curr === endIdx) break;
    if (closed[curr]) continue;
    closed[curr] = 1;
    const r = Math.floor(curr / cols), c = curr % cols;
    const baseG = gScore[curr];
    for (let k = 0; k < 8; k++) {
      const nr = r + dr[k], nc = c + dc[k];
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      const next = nr * cols + nc;
      if (closed[next] || !passableFn(next)) continue;
      // Prevent corner-cutting through diagonal building cells
      if (dr[k] !== 0 && dc[k] !== 0) {
        if (!passableFn(r * cols + nc) || !passableFn(nr * cols + c)) continue;
      }
      const stepCost = dLen[k] * stepPenaltyFn(next);
      const candG = baseG + stepCost;
      if (candG < gScore[next]) {
        gScore[next] = candG;
        prev[next] = curr;
        const h = Math.hypot(nr - endR, nc - endC);
        push(candG + h, next);
      }
    }
  }

  if (!Number.isFinite(gScore[endIdx])) return null;
  const cells = [];
  let cur = endIdx;
  while (cur >= 0) {
    cells.push(cur);
    if (cur === startIdx) break;
    cur = prev[cur];
  }
  cells.reverse();
  return cells;
}

function summarizeRouteCells(cells, { routeType, label, color, cols, cell, minX, maxY, walkScore, utciGrid, shadeGrid, gviGrid, noiseGrid }) {
  const coords = cells.map((idx) => {
    const r = Math.floor(idx / cols), c = idx % cols;
    return [minX + c * cell, maxY - r * cell];
  });
  let lengthM = 0;
  for (let i = 1; i < coords.length; i++) {
    lengthM += Math.hypot(coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1]);
  }
  const meanOf = (arr) => {
    if (!arr) return NaN;
    let s = 0, cnt = 0;
    for (const idx of cells) {
      const v = arr[idx];
      if (Number.isFinite(v)) { s += v; cnt++; }
    }
    return cnt > 0 ? s / cnt : NaN;
  };
  let shadePct = NaN;
  if (shadeGrid) {
    let s = 0, cnt = 0;
    for (const idx of cells) {
      const v = shadeGrid[idx];
      if (Number.isFinite(v)) {
        s += v > 1.01 ? v : v * 100;
        cnt++;
      }
    }
    if (cnt > 0) shadePct = s / cnt;
  }
  return {
    route_type: routeType,
    label,
    color,
    cells,
    coords,
    length_m: lengthM,
    mean_utci_c: meanOf(utciGrid),
    shade_pct: shadePct,
    mean_gvi_pct: meanOf(gviGrid),
    mean_noise_dba: meanOf(noiseGrid),
    walk_score: meanOf(walkScore)
  };
}

/**
 * Find and compare the shortest obstacle-free pedestrian route vs. the
 * thermally/environmentally optimal (coolest & shaded) route.
 */
export function findCoolRoute({
  ids = null,
  walkScore,
  utciGrid = null,
  shadeGrid = null,
  gviGrid = null,
  noiseGrid = null,
  cols,
  rows,
  cell,
  minX,
  maxY,
  startXY,
  endXY,
  coolBias = 2.8
}) {
  const startIdx = nearestWalkableCell(ids, walkScore, cols, rows, cell, minX, maxY, startXY);
  const endIdx = nearestWalkableCell(ids, walkScore, cols, rows, cell, minX, maxY, endXY);
  if (startIdx < 0 || endIdx < 0) return null;
  const passable = (idx) => (!ids || ids[idx] === 0) && (!walkScore || Number.isFinite(walkScore[idx]));

  const shortestCells = aStarPath(cols, rows, startIdx, endIdx, passable, () => 1.0);
  if (!shortestCells) return null;

  const bias = Math.max(0.2, coolBias);
  const coolestCells = aStarPath(cols, rows, startIdx, endIdx, passable, (idx) => {
    const sc = walkScore && Number.isFinite(walkScore[idx]) ? walkScore[idx] : 50;
    const discomfort = Math.max(0, Math.min(1, (100 - sc) / 100));
    return 1 + bias * Math.pow(discomfort, 1.5);
  }) || shortestCells;

  const meta = { cols, cell, minX, maxY, walkScore, utciGrid, shadeGrid, gviGrid, noiseGrid };
  const shortest = summarizeRouteCells(shortestCells, {
    routeType: 'shortest', label: 'Shortest path', color: '#e4572e', ...meta
  });
  const coolest = summarizeRouteCells(coolestCells, {
    routeType: 'coolest', label: 'Coolest & shaded path', color: '#1d8f5f', ...meta
  });

  const detourPct = shortest.length_m > 0 ? ((coolest.length_m - shortest.length_m) / shortest.length_m) * 100 : 0;
  const utciDeltaC = Number.isFinite(coolest.mean_utci_c) && Number.isFinite(shortest.mean_utci_c)
    ? coolest.mean_utci_c - shortest.mean_utci_c : NaN;
  const shadeGainPct = Number.isFinite(coolest.shade_pct) && Number.isFinite(shortest.shade_pct)
    ? coolest.shade_pct - shortest.shade_pct : NaN;
  const walkScoreGain = Number.isFinite(coolest.walk_score) && Number.isFinite(shortest.walk_score)
    ? coolest.walk_score - shortest.walk_score : NaN;

  return { shortest, coolest, detourPct, utciDeltaC, shadeGainPct, walkScoreGain };
}
