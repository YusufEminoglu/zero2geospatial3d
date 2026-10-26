// @ts-check
// 3D urban-design and biophilic planning indicators:
// 1. Green View Index (GVI) - pedestrian-level panoramic biophilic green view percentage.
// 2. Solar Envelope - Knowles (1981) / BRE right-to-light maximum buildable heights and floor budget.

/**
 * GVI qualitative classification categories (Treepedia / MIT Senseable City Lab & urban forestry thresholds).
 */
export const GVI_CLASSES = [
  { min: 0, max: 10, key: 'bare', label: 'Bare / low green', color: '#d73027' },
  { min: 10, max: 20, key: 'moderate', label: 'Moderate green', color: '#fee08b' },
  { min: 20, max: 35, key: 'street', label: 'Green street', color: '#a6d96a' },
  { min: 35, max: 100, key: 'high', label: 'High biophilic canopy', color: '#1a9850' }
];

/**
 * Classifies a Green View Index percentage (0..100) into a qualitative tier.
 * @param {number} pct
 * @returns {{ min: number, max: number, key: string, label: string, color: string } | null}
 */
export function gviClass(pct) {
  if (!Number.isFinite(pct)) return null;
  if (pct < 10) return GVI_CLASSES[0];
  if (pct < 20) return GVI_CLASSES[1];
  if (pct < 35) return GVI_CLASSES[2];
  return GVI_CLASSES[3];
}

/**
 * Inserts a 1D elevation angle interval [start, end] into a sorted disjoint list.
 * @param {Array<[number, number]>} intervals
 * @param {number} start
 * @param {number} end
 * @returns {Array<[number, number]>}
 */
function addInterval(intervals, start, end) {
  if (end <= start) return intervals;
  let s = start;
  let e = end;
  /** @type {Array<[number, number]>} */
  const next = [];
  let inserted = false;
  for (let i = 0; i < intervals.length; i++) {
    const [is, ie] = intervals[i];
    if (ie < s) {
      next.push([is, ie]);
    } else if (is > e) {
      if (!inserted) {
        next.push([s, e]);
        inserted = true;
      }
      next.push([is, ie]);
    } else {
      s = Math.min(s, is);
      e = Math.max(e, ie);
    }
  }
  if (!inserted) next.push([s, e]);
  return next;
}

/**
 * Computes pedestrian-level Green View Index (GVI) on a 2.5D raster grid.
 *
 * @param {object} params
 * @param {Float32Array|Array<number>} params.buildingHeights Obstacle / building height above ground per cell (0 = open)
 * @param {Array<[number, number, number, number]>} [params.treeObstacles] Array of [x, y, radius, height]
 * @param {Uint8Array|Float32Array|Array<number>|null} [params.greenMask] 1 where ground is vegetated, 0 elsewhere
 * @param {number} params.cols Number of grid columns
 * @param {number} params.rows Number of grid rows
 * @param {number} params.cell Cell size in metres
 * @param {number} [params.minX] Western geographic coordinate
 * @param {number} [params.maxY] Northern geographic coordinate
 * @param {number} [params.eyeHeight] Pedestrian eye level in metres (default 1.6 m)
 * @param {number} [params.maxRadius] Maximum sight distance in metres (default 80 m)
 * @param {number} [params.azimuthSteps] Number of horizontal ray azimuths sampled across 360 degrees (default 24)
 * @returns {Float32Array} Green View Index in percent (0..100 %), NaN inside solid buildings
 */
export function greenViewIndex({
  buildingHeights,
  treeObstacles = [],
  greenMask = null,
  cols,
  rows,
  cell,
  minX = 0,
  maxY = 0,
  eyeHeight = 1.6,
  maxRadius = 80,
  azimuthSteps = 24
}) {
  const out = new Float32Array(cols * rows);
  const bHeights = buildingHeights || new Float32Array(cols * rows);

  // 1. Rasterize tree obstacles into fast O(1) lookup grids for treeTop and treeBase.
  const treeTop = new Float32Array(cols * rows);
  const treeBase = new Float32Array(cols * rows);

  for (let t = 0; t < treeObstacles.length; t++) {
    const [tx, ty, trad, th] = treeObstacles[t];
    if (!(th > 0)) continue;
    const rad = Math.max(trad, cell * 0.5);
    const c0 = Math.max(0, Math.floor((tx - rad - minX) / cell));
    const c1 = Math.min(cols - 1, Math.ceil((tx + rad - minX) / cell));
    const r0 = Math.max(0, Math.floor((maxY - ty - rad) / cell));
    const r1 = Math.min(rows - 1, Math.ceil((maxY - ty + rad) / cell));
    const tb = Math.max(1.2, 0.35 * th);

    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cx = minX + (c + 0.5) * cell;
        const cy = maxY - (r + 0.5) * cell;
        if (Math.hypot(cx - tx, cy - ty) <= rad) {
          const idx = r * cols + c;
          if (th > treeTop[idx]) {
            treeTop[idx] = th;
            treeBase[idx] = tb;
          }
        }
      }
    }
  }

  // 2. Raymarch panoramic horizontal rays for each open cell.
  const stepDist = cell;
  const maxSteps = Math.ceil(maxRadius / stepDist);
  // Total vertical field of view of standard horizontal panoramic eye view ([-45 deg, +45 deg] = pi / 2 rad)
  const TOTAL_VFOV = Math.PI / 2;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const originIdx = r * cols + c;
      if (bHeights[originIdx] > 0) {
        out[originIdx] = NaN;
        continue;
      }

      let totalRayPct = 0;

      for (let a = 0; a < azimuthSteps; a++) {
        const theta = (a * 2 * Math.PI) / azimuthSteps;
        const dc = Math.cos(theta);
        const dr = -Math.sin(theta); // north is -row

        let maxBuildTan = 0;
        /** @type {Array<[number, number]>} */
        let treeIntervals = [];
        let groundAngleSum = 0;

        for (let s = 1; s <= maxSteps; s++) {
          const dist = s * stepDist;
          const curC = Math.round(c + (dist / cell) * dc);
          const curR = Math.round(r + (dist / cell) * dr);

          if (curC < 0 || curC >= cols || curR < 0 || curR >= rows) break;

          const idx = curR * cols + curC;
          const bH = bHeights[idx] || 0;

          // Track solid building elevation angle
          if (bH > 0) {
            const buildTan = (bH - eyeHeight) / dist;
            if (buildTan > maxBuildTan) maxBuildTan = buildTan;
            // Stop early if occluded by a tall wall right in front
            if (maxBuildTan > 2.5) break;
          }

          // Visible tree canopy vertical angular span
          const tTop = treeTop[idx];
          if (tTop > eyeHeight) {
            const topH = tTop - eyeHeight;
            const tBase = treeBase[idx];
            const botH = Math.max(0, tBase - eyeHeight, dist * maxBuildTan);
            if (topH > botH) {
              const phiTop = Math.atan2(topH, dist);
              const phiBot = Math.atan2(botH, dist);
              if (phiTop > phiBot) {
                treeIntervals = addInterval(treeIntervals, phiBot, phiTop);
              }
            }
          }

          // Ground vegetation downward view contribution (within 30 m, unoccluded)
          if (greenMask && greenMask[idx] > 0 && dist <= 30 && maxBuildTan <= 0) {
            const dNear = Math.max(cell * 0.5, dist - cell * 0.5);
            const dFar = dist + cell * 0.5;
            const gAngle = Math.atan2(eyeHeight, dNear) - Math.atan2(eyeHeight, dFar);
            if (gAngle > 0) groundAngleSum += gAngle;
          }
        }

        let treeAngleSum = 0;
        for (let k = 0; k < treeIntervals.length; k++) {
          treeAngleSum += (treeIntervals[k][1] - treeIntervals[k][0]);
        }

        const rayGreen = treeAngleSum + groundAngleSum;
        const rayPct = Math.min(100, Math.max(0, (rayGreen / TOTAL_VFOV) * 100));
        totalRayPct += rayPct;
      }

      out[originIdx] = totalRayPct / azimuthSteps;
    }
  }

  return out;
}

/**
 * Computes the 3D Solar Envelope / Right-to-Light maximum buildable heights and floor capacities
 * based on Knowles (1981) "Sun Rhythm Form" and the BRE Right-to-Light principles.
 *
 * @param {object} params
 * @param {Float32Array|Array<number>} params.buildingHeights Height of existing buildings in metres
 * @param {Int32Array|Float32Array|Array<number>|null} [params.ids] Optional feature ID grid
 * @param {number} params.cols Number of grid columns
 * @param {number} params.rows Number of grid rows
 * @param {number} params.cell Cell size in metres
 * @param {Array<{ dir: [number, number, number], weight?: number }>} [params.sunVectors]
 *   Sun directions [east (+col), up (+height), south (+row / -north)] with duration weights in hours
 * @param {number} [params.minSunHours] Minimum hours of direct sunlight required at sensitive receptors (default 2)
 * @param {number} [params.stepHours] Nominal time duration of each sun vector step (default 0.5 h)
 * @param {number} [params.maxBuildableHeight] Global height limit cap in metres (default 80 m)
 * @param {number} [params.floorHeight] Typical story / floor height in metres (default 3.2 m)
 * @param {Uint8Array|Float32Array|Array<number>|null} [params.targetMask] Development site mask (cells to be built, not receptors)
 * @returns {{ maxHeight: Float32Array, maxFloors: Float32Array }}
 */
export function solarEnvelope({
  buildingHeights,
  ids = null,
  cols,
  rows,
  cell,
  sunVectors = [],
  minSunHours = 2,
  stepHours = 0.5,
  maxBuildableHeight = 80,
  floorHeight = 3.2,
  targetMask = null
}) {
  const maxHeight = new Float32Array(cols * rows).fill(maxBuildableHeight);
  const maxFloors = new Float32Array(cols * rows);

  if (cols <= 0 || rows <= 0 || cell <= 0) {
    return { maxHeight, maxFloors };
  }

  const bHeights = buildingHeights || new Float32Array(cols * rows);

  // 1. Identify existing building cells outside the development target site.
  const isBuilding = new Uint8Array(cols * rows);
  let buildingCount = 0;
  for (let i = 0; i < cols * rows; i++) {
    if ((bHeights[i] > 0 || (ids && ids[i] > 0)) && (!targetMask || !targetMask[i])) {
      isBuilding[i] = 1;
      buildingCount++;
    }
  }

  if (buildingCount === 0) {
    for (let i = 0; i < cols * rows; i++) {
      maxFloors[i] = Math.max(0, Math.floor(maxHeight[i] / floorHeight));
    }
    return { maxHeight, maxFloors };
  }

  // 2. Identify sensitive receptors: perimeter facades of existing buildings and immediate base cells.
  /** @type {Array<{ c: number, r: number, height: number }>} */
  const receptors = [];
  const isReceptor = new Uint8Array(cols * rows);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (targetMask && targetMask[i]) continue;
      if (isBuilding[i]) {
        let isPerim = (c === 0 || c === cols - 1 || r === 0 || r === rows - 1);
        if (!isPerim) {
          if (!isBuilding[i - 1] || !isBuilding[i + 1] || !isBuilding[i - cols] || !isBuilding[i + cols]) {
            isPerim = true;
          }
        }
        if (isPerim && !isReceptor[i]) {
          isReceptor[i] = 1;
          receptors.push({ c, r, height: 0 });
        }
      }
    }
  }

  // Add immediately adjacent open base perimeter cells
  const recInitialCount = receptors.length;
  for (let k = 0; k < recInitialCount; k++) {
    const rc = receptors[k].c;
    const rr = receptors[k].r;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const nc = rc + dc;
        const nr = rr + dr;
        if (nc >= 0 && nc < cols && nr >= 0 && nr < rows) {
          const ni = nr * cols + nc;
          if (!isBuilding[ni] && (!targetMask || !targetMask[ni]) && !isReceptor[ni]) {
            isReceptor[ni] = 1;
            receptors.push({ c: nc, r: nr, height: 0 });
          }
        }
      }
    }
  }

  // 3. Filter sun vectors above horizon and select active solar access window
  let activeVectors = sunVectors.filter(sv => sv && sv.dir && sv.dir[1] > 0.05);
  if (activeVectors.length === 0) {
    // Default 45 deg solar noon vector from south if none provided
    activeVectors = [{ dir: [0, Math.SQRT1_2, Math.SQRT1_2], weight: minSunHours }];
  }

  // If total hours exceed minSunHours, prioritize the peak hours (highest solar elevation)
  let totalHours = 0;
  for (let k = 0; k < activeVectors.length; k++) {
    totalHours += (activeVectors[k].weight || stepHours);
  }

  if (totalHours > minSunHours) {
    activeVectors.sort((a, b) => b.dir[1] - a.dir[1]);
    let cum = 0;
    /** @type {typeof activeVectors} */
    const subset = [];
    for (let k = 0; k < activeVectors.length; k++) {
      subset.push(activeVectors[k]);
      cum += (activeVectors[k].weight || stepHours);
      if (cum >= minSunHours) break;
    }
    activeVectors = subset;
  }

  // 4. Project solar envelope constraints from every receptor towards each active sun vector
  for (let s = 0; s < activeVectors.length; s++) {
    const sv = activeVectors[s];
    const dx = sv.dir[0];
    const dy = sv.dir[1];
    const dz = sv.dir[2];
    const ux = dx;        // +x = +col (east)
    const uy = -dz;       // -z = +north; so +uy = +north = -row
    const hLen = Math.hypot(ux, uy);
    if (hLen < 1e-5) continue;

    const hx = ux / hLen;
    const hy = uy / hLen;
    const tanAlt = dy / hLen;
    const maxD = maxBuildableHeight / tanAlt;
    const stepDist = cell * 0.5;

    for (let k = 0; k < receptors.length; k++) {
      const rec = receptors[k];
      const recIdx = rec.r * cols + rec.c;
      const recId = ids ? ids[recIdx] : 0;
      // Cells along the ray towards the sun, past the receptor's own cell and
      // its own building (a facade is not shaded by the building behind it).
      /** @type {Array<{ idx: number, allowedH: number }>} */
      const path = [];
      let ownBuilding = isBuilding[recIdx] === 1;
      let shaded = false;
      for (let d = stepDist; d <= maxD; d += stepDist) {
        const ic = Math.round(rec.c + (hx * d) / cell);
        const ir = Math.round(rec.r - (hy * d) / cell); // +north is -row
        if (ic < 0 || ic >= cols || ir < 0 || ir >= rows) break;
        const targetIdx = ir * cols + ic;
        if (targetIdx === recIdx) continue;
        if (ownBuilding) {
          if (isBuilding[targetIdx] && (!ids || !recId || ids[targetIdx] === recId)) continue;
          ownBuilding = false;
        }
        const actualDist = Math.hypot((ic - rec.c) * cell, (ir - rec.r) * cell);
        const allowedH = rec.height + actualDist * tanAlt;
        // An existing building already takes this sun from the receptor:
        // nothing more is lost by building here, so this ray sets no limit.
        if (isBuilding[targetIdx] && bHeights[targetIdx] > allowedH) { shaded = true; break; }
        path.push({ idx: targetIdx, allowedH });
      }
      if (shaded) continue;
      for (const { idx, allowedH } of path) {
        if (allowedH < maxHeight[idx]) maxHeight[idx] = allowedH;
      }
    }
  }

  // 5. Clamp results and calculate maximum buildable floor counts
  for (let i = 0; i < cols * rows; i++) {
    maxHeight[i] = Math.max(0, Math.min(maxBuildableHeight, maxHeight[i]));
    maxFloors[i] = Math.max(0, Math.floor(maxHeight[i] / floorHeight));
  }

  return { maxHeight, maxFloors };
}
