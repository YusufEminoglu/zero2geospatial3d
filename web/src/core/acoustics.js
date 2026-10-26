// @ts-check
// 3D urban acoustic and environmental noise propagation module
// (ISO 9613-2 / CNOSSOS-EU inspired with Maekawa barrier diffraction).

import { sampleRoadLines, streetCentrelines } from './road_sources.js';

/**
 * Compute Maekawa barrier diffraction attenuation in dB (0..20 dB, the ISO 9613-2 cap for single diffraction).
 * @param {number} pathDiffMetres path difference delta in metres (<= 0 if unobstructed)
 * @param {number} [freqHz] frequency in Hz (default 500 Hz)
 * @returns {number} attenuation in dB (0..20)
 */
export function maekawaDiffraction(pathDiffMetres, freqHz = 500) {
  if (!(pathDiffMetres > 0)) return 0;
  const lambda = 343 / Math.max(20, freqHz);
  const N = (2 / lambda) * pathDiffMetres;
  if (N <= -0.05) return 0;
  const val = 10 * Math.log10(Math.max(1, 3 + 20 * Math.max(0, N)));
  return Math.min(20, Math.max(0, val));
}

export const NOISE_CLASSES = [
  { min: 0, max: 55, label: 'Quiet', color: '#2b83ba' },
  { min: 55, max: 65, label: 'Moderate', color: '#abdda4' },
  { min: 65, max: 70, label: 'Loud', color: '#fdae61' },
  { min: 70, max: Infinity, label: 'High noise', color: '#d7191c' }
];

/**
 * Categorize a noise level value in dB(A).
 * @param {number} dba
 * @returns {{ min: number, max: number, label: string, color: string } | null}
 */
export function noiseClass(dba) {
  if (!Number.isFinite(dba)) return null;
  return NOISE_CLASSES.find((c) => dba < c.max) || NOISE_CLASSES[NOISE_CLASSES.length - 1];
}

/**
 * Road noise sources: the given roads sampled every max(3 m, 1.5 cells), or
 * street centrelines between buildings when there are none, or the south
 * edge of a scene without buildings.
 * @returns {Array<{ x: number, y: number, length: number }>}
 */
function noiseSources(roads, weights, cols, rows, cell, heights, porosity, minX, maxY) {
  const step = Math.max(3, cell * 1.5);
  const { sources, given } = sampleRoadLines(roads, weights, step);
  if (sources.length || given) return sources;
  const streets = streetCentrelines(heights, porosity, cols, rows, cell, minX, maxY, 25);
  if (streets.length) return streets;
  const edge = [];
  const sy = maxY - (rows - 1) * cell;
  const gridStep = Math.max(1, Math.round(step / cell));
  for (let c = 0; c < cols; c += gridStep) edge.push({ x: minX + c * cell, y: sy, length: step });
  return edge;
}

/**
 * Sources grouped into square clusters: a far receiver hears a cluster as
 * one source at its length-weighted centre, a near one hears every member.
 * @param {Array<{ x: number, y: number, length: number }>} sources
 * @param {number} size cluster side in metres
 */
function clusterSources(sources, size) {
  /** @type {Map<string, { x: number, y: number, length: number, members: typeof sources }>} */
  const bins = new Map();
  for (const s of sources) {
    if (!(s.length > 0)) continue;
    const key = `${Math.floor(s.x / size)},${Math.floor(s.y / size)}`;
    let b = bins.get(key);
    if (!b) { b = { x: 0, y: 0, length: 0, members: [] }; bins.set(key, b); }
    b.x += s.x * s.length;
    b.y += s.y * s.length;
    b.length += s.length;
    b.members.push(s);
  }
  const out = [...bins.values()];
  for (const b of out) { b.x /= b.length; b.y /= b.length; }
  return out;
}

/**
 * Precompute cells that have a solid building facade within 12 m.
 * @param {Float32Array} heights
 * @param {Float32Array|null} porosity
 * @param {number} cols
 * @param {number} rows
 * @param {number} cell
 * @returns {Uint8Array}
 */
function findNearSolidFacades(heights, porosity, cols, rows, cell) {
  const result = new Uint8Array(cols * rows);
  const rad = Math.ceil(12 / cell);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (heights[idx] > 0 && !(porosity && porosity[idx] > 0)) continue;
      let hasNear = false;
      for (let dr = -rad; dr <= rad && !hasNear; dr++) {
        for (let dc = -rad; dc <= rad; dc++) {
          const nr = r + dr, nc = c + dc;
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
            const nidx = nr * cols + nc;
            if (heights[nidx] > 0 && !(porosity && porosity[nidx] > 0)) {
              if (Math.hypot(dc * cell, dr * cell) <= 12) {
                hasNear = true;
                break;
              }
            }
          }
        }
      }
      if (hasNear) result[idx] = 1;
    }
  }
  return result;
}

/**
 * Compute pedestrian-level environmental noise Lden (in dB(A)).
 * @param {object} p
 * @param {Float32Array} p.heights obstacle height above ground per cell (0 = open)
 * @param {Float32Array|null} [p.porosity] optical porosity per cell (null = solid)
 * @param {number} p.cols
 * @param {number} p.rows
 * @param {number} p.cell metres per cell
 * @param {number} [p.minX]
 * @param {number} [p.maxY]
 * @param {Array<Array<[number, number]>>} [p.roads] road polylines
 * @param {ArrayLike<number>|null} [p.roadWeights] relative traffic per road polyline (1 = the stated level; 2 doubles it)
 * @param {number} [p.soundPowerDb] road sound power level per metre (dB(A))
 * @param {number} [p.receiverHeight] receiver height above ground in metres
 * @param {number} [p.sourceHeight] source height above ground in metres
 * @param {number} [p.groundFactor] ground absorption factor 0..1 (0=hard, 1=porous)
 * @param {number} [p.maxDist] maximum calculation distance in metres
 * @param {((f: number) => void)|null} [p.onProgress] progress 0..1; the page stays responsive
 * @returns {Promise<Float32Array>} noise grid in dB(A), NaN inside solid buildings
 */
export async function noisePropagation({
  heights,
  porosity = null,
  cols,
  rows,
  cell,
  minX = 0.5 * cell,
  maxY = (rows - 0.5) * cell,
  roads = [],
  roadWeights = null,
  soundPowerDb = 78,
  receiverHeight = 1.5,
  sourceHeight = 0.5,
  groundFactor = 0.5,
  maxDist = 400,
  onProgress = null
}) {
  const sources = noiseSources(roads, roadWeights, cols, rows, cell, heights, porosity, minX, maxY);
  // Clusters of about 8 m heard as one source beyond 64 m: within 0.5 dB of
  // summing every source on a block grid, four times faster.
  const clusterSize = Math.max(8, 2 * Math.max(3, cell * 1.5));
  const clusters = clusterSources(sources, clusterSize);
  const near = 8 * clusterSize;
  const nearFacades = findNearSolidFacades(heights, porosity, cols, rows, cell);
  const dz = receiverHeight - sourceHeight;

  const out = new Float32Array(cols * rows);

  /** Energy (10^(L/10)) at a receiver from one source, rays marched every stepM metres. */
  const energyFrom = (rx, ry, src, stepM, reflectionBonus) => {
    const dx = rx - src.x;
    const dy = ry - src.y;
    const dist2d = Math.hypot(dx, dy);
    if (dist2d > maxDist) return 0;
    const dDirect = Math.hypot(dx, dy, dz);
    const d = Math.max(2, dDirect);

    // Ray march from source to receiver to find barriers and tree foliage
    let maxPathDiff = 0;
    let dTree = 0;
    if (dist2d >= 1) {
      const nSteps = Math.max(2, Math.ceil(dist2d / stepM));
      const segStep = dist2d / nSteps;
      for (let stepIdx = 1; stepIdx < nSteps; stepIdx++) {
        const t = stepIdx / nSteps;
        const gc = Math.floor((src.x + t * dx - minX) / cell + 0.5);
        const gr = Math.floor((maxY - (src.y + t * dy)) / cell + 0.5);
        if (gc < 0 || gc >= cols || gr < 0 || gr >= rows) continue;
        const gidx = gr * cols + gc;
        const h = heights[gidx];
        if (porosity && porosity[gidx] > 0) {
          dTree += segStep;
        } else if (h > 0 && h > sourceHeight + t * dz) {
          const d1 = t * dist2d;
          const d2 = (1 - t) * dist2d;
          const pathDiff = Math.hypot(d1, h - sourceHeight) + Math.hypot(d2, h - receiverHeight) - dDirect;
          if (pathDiff > maxPathDiff) maxPathDiff = pathDiff;
        }
      }
    }

    const aBar = maekawaDiffraction(maxPathDiff);
    const aTree = Math.min(4, 0.08 * dTree);
    const aDiv = 20 * Math.log10(d) + 8;
    // ISO 9613-2 Table 2 at 500 Hz (10 °C, 70 %): about 1.9 dB/km.
    const aAir = 0.0019 * d;
    const aGround = 1.5 * groundFactor * Math.log10(Math.max(1, d / 2));
    const lwSeg = soundPowerDb + 10 * Math.log10(Math.max(0.1, src.length));
    return Math.pow(10, (lwSeg - aDiv - aAir - aGround - aBar - aTree + reflectionBonus) / 10);
  };

  const fineStep = Math.max(1, cell);
  const coarseStep = 2 * fineStep;
  let lastYield = Date.now();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (heights[i] > 0 && !(porosity && porosity[i] > 0)) {
        out[i] = NaN;
        continue;
      }
      const rx = minX + c * cell;
      const ry = maxY - r * cell;
      const bonus = nearFacades[i] === 1 ? 1.8 : 0;
      let energySum = 0;
      for (const k of clusters) {
        const dk = Math.hypot(rx - k.x, ry - k.y);
        if (dk > maxDist + clusterSize) continue;
        if (dk > near) {
          energySum += energyFrom(rx, ry, k, coarseStep, bonus);
        } else {
          for (const src of k.members) energySum += energyFrom(rx, ry, src, fineStep, bonus);
        }
      }
      out[i] = energySum > 0 ? Math.max(35, Math.min(90, 10 * Math.log10(energySum))) : 35;
    }
    if (onProgress && Date.now() - lastYield > 50) {
      onProgress((r + 1) / rows);
      await new Promise((res) => setTimeout(res, 0));
      lastYield = Date.now();
    }
  }

  return out;
}

/**
 * Compute per-building facade noise statistics and quiet facade indicator.
 * @param {Float32Array} noiseGrid noise grid in dB(A)
 * @param {Int32Array|Array<number>} ids building feature keys per cell (0 = none)
 * @param {number} cols
 * @param {number} rows
 * @returns {Map<number, { max: number, min: number, mean: number, quietFacade: number }>}
 */
export function buildingFacadeNoise(noiseGrid, ids, cols, rows) {
  /** @type {Map<number, { max: number, min: number, mean: number, quietFacade: number }>} */
  const result = new Map();
  if (!ids || ids.length !== cols * rows) return result;

  /** @type {Map<number, Array<number>>} */
  const buildingCells = new Map();
  for (let i = 0; i < ids.length; i++) {
    const key = ids[i];
    if (key > 0) {
      let arr = buildingCells.get(key);
      if (!arr) {
        arr = [];
        buildingCells.set(key, arr);
      }
      arr.push(i);
    }
  }

  for (const [key, cells] of buildingCells.entries()) {
    const adjacentOpenIndices = new Set();
    for (const idx of cells) {
      const c = idx % cols;
      const r = Math.floor(idx / cols);

      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nc = c + dc;
          const nr = r + dr;
          if (nc >= 0 && nc < cols && nr >= 0 && nr < rows) {
            const nidx = nr * cols + nc;
            if (ids[nidx] !== key && Number.isFinite(noiseGrid[nidx])) {
              adjacentOpenIndices.add(nidx);
            }
          }
        }
      }
    }

    if (adjacentOpenIndices.size === 0) {
      result.set(key, { max: 35, min: 35, mean: 35, quietFacade: 1 });
      continue;
    }

    let max = -Infinity;
    let min = Infinity;
    let sum = 0;
    let count = 0;

    for (const oIdx of adjacentOpenIndices) {
      const val = noiseGrid[oIdx];
      if (Number.isFinite(val)) {
        if (val > max) max = val;
        if (val < min) min = val;
        sum += val;
        count++;
      }
    }

    if (count === 0) {
      result.set(key, { max: 35, min: 35, mean: 35, quietFacade: 1 });
      continue;
    }

    const mean = sum / count;
    // quietFacade is 1 if at least one facade side has < 55 dB(A) or max - min >= 6 dB(A)
    const quietFacade = (min < 55 || (max - min) >= 6) ? 1 : 0;
    result.set(key, { max, min, mean, quietFacade });
  }

  return result;
}
