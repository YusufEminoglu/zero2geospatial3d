// @ts-check
// Street-canyon ventilation, normalized air age, and traffic pollutant
// dispersion modeling (OSPM-inspired Gaussian plume + canyon recirculation).

import { sampleRoadLines, streetCentrelines } from './road_sources.js';

export const VENTILATION_CLASSES = [
  { min: 0.8, max: Infinity, label: 'Well ventilated', color: '#2b83ba' },
  { min: 0.5, max: 0.8, label: 'Moderate exchange', color: '#abdda4' },
  { min: 0.3, max: 0.5, label: 'Low ventilation', color: '#fdae61' },
  { min: 0, max: 0.3, label: 'Stagnation risk', color: '#d7191c' }
];

/**
 * Categorize a Ventilation Efficiency Index (VEI) value.
 * @param {number} veiValue
 * @returns {{ min: number, max: number, label: string, color: string } | null}
 */
export function ventilationClass(veiValue) {
  if (!Number.isFinite(veiValue)) return null;
  for (const c of VENTILATION_CLASSES) {
    if (veiValue >= c.min) return c;
  }
  return VENTILATION_CLASSES[VENTILATION_CLASSES.length - 1];
}

/**
 * Compute pedestrian-level ventilation efficiency index (VEI) and normalized air age.
 * @param {object} p
 * @param {Float32Array|null} [p.windRatioGrid] ratio to open wind (0.05..1.6)
 * @param {Float32Array} p.heights obstacle height above ground per cell (0 = open)
 * @param {Float32Array|null} [p.porosity] optical porosity per cell (null = solid)
 * @param {Float32Array|null} [p.svf] sky view factor per cell (0..1)
 * @param {number} p.cols
 * @param {number} p.rows
 * @param {number} p.cell metres per cell
 * @returns {{ vei: Float32Array, airAge: Float32Array }}
 */
export function ventilationEfficiency({ windRatioGrid = null, heights, porosity = null, svf = null, cols, rows, cell }) {
  const n = cols * rows;
  const vei = new Float32Array(n);
  const airAge = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    if (heights[i] > 0 && !(porosity && porosity[i] > 0)) {
      vei[i] = NaN;
      airAge[i] = NaN;
      continue;
    }
    const w = windRatioGrid && Number.isFinite(windRatioGrid[i]) ? windRatioGrid[i] : 0.7;
    const s = svf && Number.isFinite(svf[i]) ? svf[i] : 0.7;
    const v = Math.max(0.02, Math.min(1.5, 0.7 * w + 0.3 * s));
    vei[i] = v;
    airAge[i] = Math.max(0.5, Math.min(12, 1 / Math.max(0.08, v)));
  }

  return { vei, airAge };
}

export const AIR_QUALITY_CLASSES = [
  { min: 0, max: 20, label: 'Good', color: '#2b83ba' },
  { min: 20, max: 40, label: 'Moderate', color: '#abdda4' },
  { min: 40, max: 80, label: 'Elevated', color: '#fdae61' },
  { min: 80, max: Infinity, label: 'High', color: '#d7191c' }
];

/**
 * Categorize a pollutant concentration value (ug/m3).
 * @param {number} ugm3
 * @returns {{ min: number, max: number, label: string, color: string } | null}
 */
export function airQualityClass(ugm3) {
  if (!Number.isFinite(ugm3)) return null;
  return AIR_QUALITY_CLASSES.find((c) => ugm3 < c.max) || AIR_QUALITY_CLASSES[AIR_QUALITY_CLASSES.length - 1];
}

/**
 * Traffic emission sources: the given roads sampled every max(2 m, 1 cell),
 * or street centrelines between buildings when there are none, or a line
 * across the middle of a scene without buildings.
 * @returns {Array<{ x: number, y: number, length: number }>}
 */
function emissionSources(roads, weights, cols, rows, cell, heights, porosity, minX, maxY) {
  const { sources, given } = sampleRoadLines(roads, weights, Math.max(2, cell));
  if (sources.length || given) return sources;
  const streets = streetCentrelines(heights, porosity, cols, rows, cell, minX, maxY, 25);
  if (streets.length) return streets;
  const midY = maxY - Math.floor(rows / 2) * cell;
  return Array.from({ length: cols }, (_, c) => ({ x: minX + c * cell, y: midY, length: cell }));
}

/**
 * Model pedestrian-level traffic pollutant dispersion (NO2 or PM2.5 in ug/m3).
 * @param {object} p
 * @param {Float32Array} p.heights obstacle height above ground per cell
 * @param {Float32Array|null} [p.porosity] optical porosity per cell (null = solid)
 * @param {Float32Array|null} [p.windRatioGrid] wind speed ratio per cell
 * @param {Float32Array|null} [p.svf] sky view factor per cell
 * @param {number} p.cols
 * @param {number} p.rows
 * @param {number} p.cell metres per cell
 * @param {number} [p.minX]
 * @param {number} [p.maxY]
 * @param {number} [p.windFromDeg] meteorological direction wind comes from (0=N, 90=E, 180=S, 270=W)
 * @param {number} [p.windSpeed10] reference wind speed at 10m (m/s)
 * @param {Array<Array<[number, number]>>} [p.roads] polylines of road centerlines
 * @param {ArrayLike<number>|null} [p.roadWeights] relative traffic per road polyline (1 = the stated level; 2 doubles it)
 * @param {number} [p.emissionRateUgMS] line source emission rate (ug / (m * s))
 * @param {number} [p.backgroundUgM3] ambient background concentration (ug / m3)
 * @param {number} [p.treeDepositionFactor] fraction of pollutant filtered by trees (0..1)
 * @param {((f: number) => void)|null} [p.onProgress] progress 0..1; the page stays responsive
 * @returns {Promise<Float32Array>} concentration in ug/m3, NaN inside solid buildings
 */
export async function pollutantDispersion({
  heights,
  porosity = null,
  windRatioGrid = null,
  svf = null,
  cols,
  rows,
  cell,
  minX = 0.5 * cell,
  maxY = (rows - 0.5) * cell,
  windFromDeg = 270,
  windSpeed10 = 3,
  roads = [],
  roadWeights = null,
  emissionRateUgMS = 450,
  backgroundUgM3 = 18,
  treeDepositionFactor = 0.25,
  onProgress = null
}) {
  const sources = emissionSources(roads, roadWeights, cols, rows, cell, heights, porosity, minX, maxY);
  // Sources in 25 m bins: a cell visits only the bins within the 250 m
  // plume reach (and within 30 m, for the canyon trap), not every source.
  const BIN = 25, REACH = 250, NEAR = 30;
  /** @type {Map<number, Array<{ x: number, y: number, length: number }>>} */
  const bins = new Map();
  const binKey = (bx, by) => (bx + 32768) * 65536 + (by + 32768);
  for (const src of sources) {
    const k = binKey(Math.floor(src.x / BIN), Math.floor(src.y / BIN));
    let b = bins.get(k);
    if (!b) { b = []; bins.set(k, b); }
    b.push(src);
  }
  const span = Math.ceil(REACH / BIN) + 1;
  // Beyond FAR the plume (sigma_y >= 13 m) is wider than half a bin: a bin
  // counts as one source at its length-weighted centre.
  const FAR = 60;
  /** @type {Map<number, Array<{ x: number, y: number, length: number }>>} */
  const merged = new Map();
  for (const [k, members] of bins) {
    let x = 0, y = 0, length = 0;
    for (const m of members) { x += m.x * m.length; y += m.y * m.length; length += m.length; }
    merged.set(k, length > 0 ? [{ x: x / length, y: y / length, length }] : []);
  }

  // Wind vector blows towards (windFromDeg + 180) degrees
  const toRad = (((windFromDeg + 180) % 360) * Math.PI) / 180;
  const wx = Math.sin(toRad);
  const wy = Math.cos(toRad);

  const out = new Float32Array(cols * rows);
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

      const localWindRatio = windRatioGrid && Number.isFinite(windRatioGrid[i]) ? windRatioGrid[i] : 0.7;
      const localSvf = svf && Number.isFinite(svf[i]) ? svf[i] : 0.7;
      const u = Math.max(0.6, windSpeed10 * 0.65 * localWindRatio);

      let directPlume = 0;
      let minRoadDist = Infinity;

      const bx0 = Math.floor(rx / BIN), by0 = Math.floor(ry / BIN);
      for (let gy = by0 - span; gy <= by0 + span; gy++) {
        for (let gx = bx0 - span; gx <= bx0 + span; gx++) {
          const key = binKey(gx, gy);
          if (!bins.has(key)) continue;
          // Nearest edge of the bin: farther than the reach, nothing to add.
          const ex = Math.max(gx * BIN - rx, 0, rx - (gx + 1) * BIN);
          const ey = Math.max(gy * BIN - ry, 0, ry - (gy + 1) * BIN);
          const edge = Math.hypot(ex, ey);
          if (edge > REACH) continue;
          const members = edge > FAR ? merged.get(key) : bins.get(key);
          // A bin wholly upwind adds no plume; it still counts for the canyon trap when near.
          const cxb = (gx + 0.5) * BIN - rx, cyb = (gy + 0.5) * BIN - ry;
          const upwind = -(cxb * wx + cyb * wy) < -BIN * Math.SQRT1_2;
          if (upwind && edge > NEAR) continue;
          for (let s = 0; s < members.length; s++) {
            const src = members[s];
            const dx = rx - src.x;
            const dy = ry - src.y;
            const dist = Math.hypot(dx, dy);
            if (dist < minRoadDist) minRoadDist = dist;

            if (dist > REACH || upwind) continue;

            // Along-wind and cross-wind distance
            const dAlong = dx * wx + dy * wy;
            if (dAlong <= 0) continue; // Upwind of this source

            const dCross = Math.abs(dx * wy - dy * wx);
            const sigmaY = 2.5 + 0.18 * dAlong;
            const sigmaZ = 1.8 + 0.12 * dAlong;

            if (dCross > 4 * sigmaY) continue;

            const expY = Math.exp(-0.5 * (dCross * dCross) / (sigmaY * sigmaY));
            const expZ = Math.exp(-0.5 * (1.5 * 1.5) / (sigmaZ * sigmaZ));
            const kernel = (src.length * (emissionRateUgMS / u) / (Math.PI * sigmaY * sigmaZ)) * expY * expZ;
            directPlume += kernel;
          }
        }
      }

      let trafficIncrement = directPlume;

      // Canyon vortex recirculation trap: when svf < 0.65 or windRatioGrid < 0.45 near road sources (< 30 m)
      if (minRoadDist < 30 && (localSvf < 0.65 || localWindRatio < 0.45)) {
        const trapFactor = 1 + 1.4 * (1 - localSvf);
        trafficIncrement *= trapFactor;
      }

      // Vegetation / Tree canopy filtration: if local cell or nearby has tree porosity
      let hasTree = Boolean(porosity && porosity[i] > 0);
      if (!hasTree && porosity) {
        for (let dr = -1; dr <= 1 && !hasTree; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const nr = r + dr, nc = c + dc;
            if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
              if (porosity[nr * cols + nc] > 0) {
                hasTree = true;
                break;
              }
            }
          }
        }
      }
      if (hasTree) {
        trafficIncrement *= (1 - treeDepositionFactor);
      }

      const totalConc = backgroundUgM3 + trafficIncrement;
      out[i] = Math.max(backgroundUgM3, Math.min(400, totalConc));
    }
    if (onProgress && Date.now() - lastYield > 50) {
      onProgress((r + 1) / rows);
      await new Promise((res) => setTimeout(res, 0));
      lastYield = Date.now();
    }
  }

  return out;
}
