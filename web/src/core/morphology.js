// @ts-check
// Urban morphology and heat-island indicators from a building-height grid
// (height above ground per cell, 0 = open).
//
// lambda_p  plan area fraction            lambda_f  frontal area index (wind)
// H         area-weighted mean height     H/W       canyon aspect ratio
// zd, z0    displacement height and roughness length, Macdonald, Griffiths
//           and Hall (1998), Atmos. Environ. 32(11):1857-1864,
//           doi:10.1016/S1352-2310(97)00403-2 (A = 4.43, beta = 1, Cd = 1.2)
// LCZ       approximate Local Climate Zone (built types 1-6, 8, 9) from the
//           property ranges of Stewart and Oke (2012), BAMS 93(12):1879-1900,
//           doi:10.1175/BAMS-D-11-00019.1. Types 7 and 10 depend on materials
//           and use, which geometry cannot show.

const KAPPA = 0.4;

/** Two-pass chamfer distance (metres) from every cell to the nearest built cell. */
export function distanceToBuilt(heights, cols, rows, cell) {
  const INF = 1e9;
  const d = new Float32Array(cols * rows);
  for (let i = 0; i < d.length; i++) d[i] = heights[i] > 0 ? 0 : INF;
  const a = cell, b = cell * Math.SQRT2;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      let v = d[i];
      if (c > 0) v = Math.min(v, d[i - 1] + a);
      if (r > 0) {
        v = Math.min(v, d[i - cols] + a);
        if (c > 0) v = Math.min(v, d[i - cols - 1] + b);
        if (c < cols - 1) v = Math.min(v, d[i - cols + 1] + b);
      }
      d[i] = v;
    }
  }
  for (let r = rows - 1; r >= 0; r--) {
    for (let c = cols - 1; c >= 0; c--) {
      const i = r * cols + c;
      let v = d[i];
      if (c < cols - 1) v = Math.min(v, d[i + 1] + a);
      if (r < rows - 1) {
        v = Math.min(v, d[i + cols] + a);
        if (c < cols - 1) v = Math.min(v, d[i + cols + 1] + b);
        if (c > 0) v = Math.min(v, d[i + cols - 1] + b);
      }
      d[i] = v;
    }
  }
  return d;
}

/** Macdonald et al. (1998) displacement height and roughness length (metres). */
export function macdonald(lambdaP, lambdaF, meanHeight, { A = 4.43, beta = 1.0, Cd = 1.2 } = {}) {
  if (!(meanHeight > 0) || !(lambdaP > 0)) return { zd: 0, z0: 0.03 };
  const lp = Math.min(0.95, lambdaP);
  const zdH = 1 + Math.pow(A, -lp) * (lp - 1);
  const lf = Math.max(1e-4, lambdaF);
  const z0H = (1 - zdH) * Math.exp(-Math.pow(0.5 * beta * (Cd / (KAPPA * KAPPA)) * (1 - zdH) * lf, -0.5));
  return { zd: zdH * meanHeight, z0: Math.max(0.01, z0H * meanHeight) };
}

export const LCZ_LABELS = {
  1: 'LCZ 1 Compact high-rise', 2: 'LCZ 2 Compact midrise', 3: 'LCZ 3 Compact low-rise',
  4: 'LCZ 4 Open high-rise', 5: 'LCZ 5 Open midrise', 6: 'LCZ 6 Open low-rise',
  8: 'LCZ 8 Large low-rise', 9: 'LCZ 9 Sparsely built', 0: 'Open land (LCZ A-G)'
};
export const LCZ_COLORS = { 1: '#8c0000', 2: '#d10000', 3: '#ff0000', 4: '#bf4d00', 5: '#ff6600', 6: '#ff9955', 8: '#bcbcbc', 9: '#ffccaa', 0: '#6fbf73' };

/** Approximate built LCZ from plan fraction, mean height and mean footprint area. */
export function classifyLcz(lambdaP, meanHeight, meanFootprint = 0) {
  if (!(lambdaP >= 0.1)) return lambdaP > 0.02 ? 9 : 0;
  const tall = meanHeight >= 25 ? 'high' : meanHeight >= 10 ? 'mid' : 'low';
  if (tall === 'low' && meanFootprint >= 1500 && lambdaP >= 0.3) return 8;
  if (lambdaP < 0.2) return tall === 'low' ? 9 : tall === 'mid' ? 5 : 4;
  if (lambdaP >= 0.4) return tall === 'high' ? 1 : tall === 'mid' ? 2 : 3;
  return tall === 'high' ? 4 : tall === 'mid' ? 5 : 6;
}

/**
 * Indicators per block of `blockCells` x `blockCells` grid cells.
 * @param {object} p
 * @param {Float32Array} p.heights building height above ground per cell
 * @param {number} p.cols
 * @param {number} p.rows
 * @param {number} p.cell metres
 * @param {number} p.blockCells cells per block side
 * @param {number} [p.windFromDeg] wind direction (from), for lambda_f
 * @param {Float32Array|null} [p.svf] optional sky view factor per cell
 * @param {Int32Array|null} [p.featureIds] building id per cell (0 = none), for mean footprint
 */
export function blockIndicators({ heights, cols, rows, cell, blockCells, windFromDeg = 270, svf = null, featureIds = null }) {
  const bc = Math.ceil(cols / blockCells);
  const br = Math.ceil(rows / blockCells);
  const nb = bc * br;
  const f32 = () => new Float32Array(nb);
  const out = { cols: bc, rows: br, cell: cell * blockCells,
    lambdaP: f32(), lambdaF: f32(), meanHeight: f32(), maxHeight: f32(), heightStd: f32(),
    hw: f32(), zd: f32(), z0: f32(), svf: f32(), lcz: new Uint8Array(nb), volumeDensity: f32() };
  // Wind blows towards (sin, cos) of the "to" bearing; windward faces of a
  // cell point upwind.
  const toRad = ((windFromDeg + 180) % 360) * Math.PI / 180;
  const ux = Math.sin(toRad);
  const uy = Math.cos(toRad); // +y north
  const dist = distanceToBuilt(heights, cols, rows, cell);
  const footprintCells = new Map();
  if (featureIds) for (const id of featureIds) if (id > 0) footprintCells.set(id, (footprintCells.get(id) || 0) + 1);
  const acc = Array.from({ length: nb }, () => ({ n: 0, built: 0, hSum: 0, h2Sum: 0, hMax: 0, frontal: 0, openD: 0, openN: 0, svfSum: 0, svfN: 0, ids: new Set() }));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const a = acc[Math.floor(r / blockCells) * bc + Math.floor(c / blockCells)];
      const h = heights[i];
      a.n++;
      if (h > 0) {
        a.built++; a.hSum += h; a.h2Sum += h * h; if (h > a.hMax) a.hMax = h;
        if (featureIds && featureIds[i] > 0) a.ids.add(featureIds[i]);
        // Windward faces: neighbour on the upwind side lower than this cell.
        // x faces (east/west neighbours) project with |ux|, y faces with |uy|.
        const upX = ux > 0 ? c - 1 : c + 1;
        if (upX >= 0 && upX < cols) a.frontal += Math.max(0, h - heights[r * cols + upX]) * cell * Math.abs(ux);
        const upY = uy > 0 ? r + 1 : r - 1; // rows run north->south: upwind of a northward wind is south (r+1)
        if (upY >= 0 && upY < rows) a.frontal += Math.max(0, h - heights[upY * cols + c]) * cell * Math.abs(uy);
      } else {
        a.openD += dist[i]; a.openN++;
      }
      if (svf && Number.isFinite(svf[i])) { a.svfSum += svf[i]; a.svfN++; }
    }
  }
  for (let k = 0; k < nb; k++) {
    const a = acc[k];
    const plan = a.n * cell * cell;
    const lp = a.n ? a.built / a.n : 0;
    const H = a.built ? a.hSum / a.built : 0;
    out.lambdaP[k] = lp;
    out.meanHeight[k] = H;
    out.maxHeight[k] = a.hMax;
    out.heightStd[k] = a.built ? Math.sqrt(Math.max(0, a.h2Sum / a.built - H * H)) : 0;
    out.lambdaF[k] = plan ? a.frontal / plan : 0;
    out.volumeDensity[k] = plan ? (a.hSum * cell * cell) / plan : 0;
    // Mean distance from open ground to the nearest building is half a
    // typical gap, so the canyon width W ~ 2 x that mean.
    const W = a.openN ? 2 * (a.openD / a.openN) : 0;
    out.hw[k] = W > 0 && H > 0 ? H / W : (H > 0 ? 3 : 0);
    const { zd, z0 } = macdonald(lp, out.lambdaF[k], H);
    out.zd[k] = zd;
    out.z0[k] = z0;
    out.svf[k] = a.svfN ? a.svfSum / a.svfN : NaN;
    let fp = 0;
    if (a.ids.size) { let s = 0; for (const id of a.ids) s += (footprintCells.get(id) || 0) * cell * cell; fp = s / a.ids.size; }
    out.lcz[k] = classifyLcz(lp, H, fp);
  }
  return out;
}
