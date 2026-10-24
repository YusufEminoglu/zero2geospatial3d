// @ts-check
// Street-canyon ventilation, normalized air age, and traffic pollutant
// dispersion modeling (OSPM-inspired Gaussian plume + canyon recirculation).

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
 * Sample road emission sources from polylines or synthesize from street corridors.
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
function sampleEmissionSources(roads, cols, rows, cell, heights, porosity, minX = 0.5 * cell, maxY = (rows - 0.5) * cell) {
  /** @type {Array<{ x: number, y: number, length: number }>} */
  const sources = [];

  if (Array.isArray(roads) && roads.length > 0) {
    const step = Math.max(2, cell);
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
    // Automatically synthesize emission sources along open street cells within 15 m of buildings
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
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c;
          const d = dist[i];
          if (d > 0 && d <= 15 && (c % 2 === 0 || r % 2 === 0)) {
            const sx = minX + c * cell;
            const sy = maxY - r * cell;
            sources.push({ x: sx, y: sy, length: cell * 2 });
          }
        }
      }
    }
    if (sources.length === 0) {
      // Scene centerline fallback
      const midR = Math.floor(rows / 2);
      for (let c = 0; c < cols; c++) {
        const sx = minX + c * cell;
        const sy = maxY - midR * cell;
        sources.push({ x: sx, y: sy, length: cell });
      }
    }
  }

  return sources;
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
 * @param {number} [p.emissionRateUgMS] line source emission rate (ug / (m * s))
 * @param {number} [p.backgroundUgM3] ambient background concentration (ug / m3)
 * @param {number} [p.treeDepositionFactor] fraction of pollutant filtered by trees (0..1)
 * @returns {Float32Array} concentration in ug/m3, NaN inside solid buildings
 */
export function pollutantDispersion({
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
  emissionRateUgMS = 450,
  backgroundUgM3 = 18,
  treeDepositionFactor = 0.25
}) {
  const sources = sampleEmissionSources(roads, cols, rows, cell, heights, porosity, minX, maxY);

  // Wind vector blows towards (windFromDeg + 180) degrees
  const toRad = (((windFromDeg + 180) % 360) * Math.PI) / 180;
  const wx = Math.sin(toRad);
  const wy = Math.cos(toRad);

  const out = new Float32Array(cols * rows);

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

      for (let s = 0; s < sources.length; s++) {
        const src = sources[s];
        const dx = rx - src.x;
        const dy = ry - src.y;
        const dist = Math.hypot(dx, dy);
        if (dist < minRoadDist) minRoadDist = dist;

        if (dist > 250) continue;

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
  }

  return out;
}
