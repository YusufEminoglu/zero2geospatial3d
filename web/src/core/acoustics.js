// @ts-check
// 3D urban acoustic and environmental noise propagation module
// (ISO 9613-2 / CNOSSOS-EU inspired with Maekawa barrier diffraction).

/**
 * Compute Maekawa barrier diffraction attenuation in dB (0..25 dB).
 * @param {number} pathDiffMetres path difference delta in metres (<= 0 if unobstructed)
 * @param {number} [freqHz] frequency in Hz (default 500 Hz)
 * @returns {number} attenuation in dB (0..25)
 */
export function maekawaDiffraction(pathDiffMetres, freqHz = 500) {
  if (!(pathDiffMetres > 0)) return 0;
  const lambda = 343 / Math.max(20, freqHz);
  const N = (2 / lambda) * pathDiffMetres;
  if (N <= -0.05) return 0;
  const val = 10 * Math.log10(Math.max(1, 3 + 20 * Math.max(0, N)));
  return Math.min(25, Math.max(0, val));
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
 * Sample road noise source points from polylines or synthesize from street corridors.
 * @param {Array<Array<[number, number]>>} roads
 * @param {number} cols
 * @param {number} rows
 * @param {number} cell
 * @param {Float32Array} heights
 * @param {Float32Array|null} porosity
 * @param {number} [minX]
 * @param {number} [maxY]
 * @returns {Array<{ x: number, y: number, length: number }>}
 */
function sampleNoiseSources(roads, cols, rows, cell, heights, porosity, minX = 0.5 * cell, maxY = (rows - 0.5) * cell) {
  /** @type {Array<{ x: number, y: number, length: number }>} */
  const sources = [];
  const step = Math.max(3, cell * 1.5);

  if (Array.isArray(roads) && roads.length > 0) {
    for (const poly of roads) {
      if (!Array.isArray(poly) || poly.length < 2) continue;
      for (let p = 0; p < poly.length - 1; p++) {
        const p1 = poly[p];
        const p2 = poly[p + 1];
        const x1 = p1[0], y1 = p1[1];
        const x2 = p2[0], y2 = p2[1];
        const len = Math.hypot(x2 - x1, y2 - y1);
        if (len <= 0) continue;
        const count = Math.max(1, Math.round(len / step));
        const segLen = len / count;
        for (let k = 0; k < count; k++) {
          const t = (k + 0.5) / count;
          sources.push({
            x: x1 + t * (x2 - x1),
            y: y1 + t * (y2 - y1),
            length: segLen
          });
        }
      }
    }
  }

  if (sources.length === 0) {
    // If roads is empty, automatically place road source points along major open street corridors
    // between buildings (open cells 10..25 m from buildings) or along scene boundary roads
    const INF = 1e9;
    const dist = new Float32Array(cols * rows);
    let hasSolid = false;
    for (let i = 0; i < cols * rows; i++) {
      if (heights[i] > 0 && !(porosity && porosity[i] > 0)) {
        dist[i] = 0;
        hasSolid = true;
      } else {
        dist[i] = INF;
      }
    }
    if (hasSolid) {
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
      const gridStep = Math.max(1, Math.round(step / cell));
      for (let r = 0; r < rows; r += gridStep) {
        for (let c = 0; c < cols; c += gridStep) {
          const i = r * cols + c;
          const d = dist[i];
          if (d >= 10 && d <= 25) {
            const sx = minX + c * cell;
            const sy = maxY - r * cell;
            sources.push({ x: sx, y: sy, length: step });
          }
        }
      }
    }
    if (sources.length === 0) {
      // Scene boundary fallback (south edge)
      const sy = maxY - (rows - 1) * cell;
      const gridStep = Math.max(1, Math.round(step / cell));
      for (let c = 0; c < cols; c += gridStep) {
        const sx = minX + c * cell;
        sources.push({ x: sx, y: sy, length: step });
      }
    }
  }

  return sources;
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
 * @param {number} [p.soundPowerDb] road sound power level per metre (dB(A))
 * @param {number} [p.receiverHeight] receiver height above ground in metres
 * @param {number} [p.sourceHeight] source height above ground in metres
 * @param {number} [p.groundFactor] ground absorption factor 0..1 (0=hard, 1=porous)
 * @param {number} [p.maxDist] maximum calculation distance in metres
 * @returns {Float32Array} noise grid in dB(A), NaN inside solid buildings
 */
export function noisePropagation({
  heights,
  porosity = null,
  cols,
  rows,
  cell,
  minX = 0.5 * cell,
  maxY = (rows - 0.5) * cell,
  roads = [],
  soundPowerDb = 78,
  receiverHeight = 1.5,
  sourceHeight = 0.5,
  groundFactor = 0.5,
  maxDist = 400
}) {
  const sources = sampleNoiseSources(roads, cols, rows, cell, heights, porosity, minX, maxY);
  const nearFacades = findNearSolidFacades(heights, porosity, cols, rows, cell);

  const out = new Float32Array(cols * rows);
  const stepM = Math.max(1, cell * 0.5);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (heights[i] > 0 && !(porosity && porosity[i] > 0)) {
        out[i] = NaN;
        continue;
      }

      const rx = minX + c * cell;
      const ry = maxY - r * cell;
      const hasFacadeNearby = nearFacades[i] === 1;

      let energySum = 0;

      for (let s = 0; s < sources.length; s++) {
        const src = sources[s];
        const dx = rx - src.x;
        const dy = ry - src.y;
        const dist2d = Math.hypot(dx, dy);

        if (dist2d > maxDist) continue;

        const dz = receiverHeight - sourceHeight;
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
            const px = src.x + t * dx;
            const py = src.y + t * dy;
            const gc = Math.floor((px - minX) / cell + 0.5);
            const gr = Math.floor((maxY - py) / cell + 0.5);

            if (gc < 0 || gc >= cols || gr < 0 || gr >= rows) continue;

            const gidx = gr * cols + gc;
            const h = heights[gidx];
            const isTree = Boolean(porosity && porosity[gidx] > 0);

            if (isTree) {
              dTree += segStep;
            } else if (h > 0) {
              const zLos = sourceHeight + t * dz;
              if (h > zLos) {
                const d1 = t * dist2d;
                const d2 = (1 - t) * dist2d;
                const pathDiff = Math.hypot(d1, h - sourceHeight) + Math.hypot(d2, h - receiverHeight) - dDirect;
                if (pathDiff > maxPathDiff) maxPathDiff = pathDiff;
              }
            }
          }
        }

        const aBar = maekawaDiffraction(maxPathDiff);
        const aTree = Math.min(4, 0.08 * dTree);
        const aDiv = 20 * Math.log10(d) + 8;
        const aAir = 0.005 * d;
        const aGround = 1.5 * groundFactor * Math.log10(Math.max(1, d / 2));
        const reflectionBonus = hasFacadeNearby ? 1.8 : 0;

        const lwSeg = soundPowerDb + 10 * Math.log10(Math.max(0.1, src.length));
        const li = lwSeg - aDiv - aAir - aGround - aBar - aTree + reflectionBonus;

        energySum += Math.pow(10, li / 10);
      }

      if (energySum > 0) {
        const dba = 10 * Math.log10(energySum);
        out[i] = Math.max(35, Math.min(90, dba));
      } else {
        out[i] = 35;
      }
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
