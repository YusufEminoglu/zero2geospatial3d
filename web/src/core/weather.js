// @ts-check
// Weather: EnergyPlus EPW parsing, monthly summaries, wind rose, annual
// sun-direction bins for radiation, and a clear-sky year when no EPW exists.
import { solarPosition, sunVector } from './solar.js';

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MONTH_START = MONTH_DAYS.reduce((acc, d, i) => { acc.push(i ? acc[i - 1] + MONTH_DAYS[i - 1] : 0); return acc; }, []);
export const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Day of year in a 365-day typical year. */
export function typicalDoy(month, day) {
  return MONTH_START[month - 1] + day;
}

/**
 * Parse EPW text.
 * @param {string} text
 * @returns {{ location: object, hours: number,
 *   month: Uint8Array, day: Uint8Array, hour: Uint8Array,
 *   dryBulb: Float32Array, dewPoint: Float32Array, rh: Float32Array, pressure: Float32Array,
 *   ir: Float32Array, ghi: Float32Array, dni: Float32Array, dhi: Float32Array,
 *   windDir: Float32Array, windSpeed: Float32Array, skyCover: Float32Array }}
 */
export function parseEpw(text) {
  const lines = text.split(/\r?\n/);
  const loc = lines[0].split(',').map((s) => s.trim());
  if (loc[0]?.toUpperCase() !== 'LOCATION' || loc.length < 10) throw new Error('Not an EPW file (no LOCATION line).');
  const location = {
    city: loc[1], region: loc[2], country: loc[3], source: loc[4], wmo: loc[5],
    lat: Number(loc[6]), lon: Number(loc[7]), utcOffset: Number(loc[8]), elevation: Number(loc[9])
  };
  const rows = [];
  for (let i = 8; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !/^\s*-?\d/.test(line)) continue;
    rows.push(line.split(','));
  }
  if (rows.length < 8760) throw new Error(`EPW has ${rows.length} hourly records; 8760 are required.`);
  const n = 8760;
  const f32 = () => new Float32Array(n);
  const data = {
    location, hours: n,
    month: new Uint8Array(n), day: new Uint8Array(n), hour: new Uint8Array(n),
    dryBulb: f32(), dewPoint: f32(), rh: f32(), pressure: f32(), ir: f32(),
    ghi: f32(), dni: f32(), dhi: f32(), windDir: f32(), windSpeed: f32(), skyCover: f32()
  };
  // Leap-year files carry Feb 29: drop it so the year has 8760 hours.
  let k = 0;
  for (const r of rows) {
    if (k >= n) break;
    const m = Number(r[1]);
    const d = Number(r[2]);
    if (m === 2 && d === 29) continue;
    data.month[k] = m;
    data.day[k] = d;
    data.hour[k] = Number(r[3]);
    data.dryBulb[k] = num(r[6], 99.9, 20);
    data.dewPoint[k] = num(r[7], 99.9, 10);
    data.rh[k] = num(r[8], 999, 50);
    data.pressure[k] = num(r[9], 999999, 101325);
    data.ir[k] = num(r[12], 9999, NaN);
    data.ghi[k] = Math.max(0, num(r[13], 9999, 0));
    data.dni[k] = Math.max(0, num(r[14], 9999, 0));
    data.dhi[k] = Math.max(0, num(r[15], 9999, 0));
    data.windDir[k] = num(r[20], 999, 0);
    data.windSpeed[k] = Math.max(0, num(r[21], 999, 0));
    data.skyCover[k] = num(r[22], 99, 5);
    k++;
  }
  if (k < n) throw new Error('EPW ended before 8760 hours.');
  return data;
}

function num(text, missing, fallback) {
  const v = Number(text);
  return Number.isFinite(v) && v < missing ? v : fallback;
}

/** Index of the EPW record for a month, day and clock hour (1..24 = hour ending). */
export function hourIndex(month, day, hourEnding) {
  return (typicalDoy(month, day) - 1) * 24 + (hourEnding - 1);
}

/** Monthly means and sums for charts. */
export function monthlySummary(w) {
  const out = MONTH_NAMES.map((name) => ({ name, tMean: 0, tMin: Infinity, tMax: -Infinity, rh: 0, ghiKwh: 0, wind: 0, n: 0 }));
  for (let i = 0; i < w.hours; i++) {
    const m = out[w.month[i] - 1];
    const t = w.dryBulb[i];
    m.tMean += t; m.rh += w.rh[i]; m.wind += w.windSpeed[i]; m.ghiKwh += w.ghi[i] / 1000; m.n++;
    if (t < m.tMin) m.tMin = t;
    if (t > m.tMax) m.tMax = t;
  }
  for (const m of out) {
    if (!m.n) continue;
    m.tMean /= m.n; m.rh /= m.n; m.wind /= m.n;
  }
  return out;
}

/**
 * Wind rose: frequency (fraction of hours) per direction sector and speed
 * class. Calm hours (< 0.5 m/s) are counted separately.
 */
export function windRose(w, { sectors = 16, classes = [0.5, 2, 4, 6, 8, 11], months = null, hours = null } = {}) {
  const table = Array.from({ length: sectors }, () => new Array(classes.length).fill(0));
  let calm = 0;
  let total = 0;
  let speedSum = 0;
  for (let i = 0; i < w.hours; i++) {
    if (months && !months.includes(w.month[i])) continue;
    if (hours && !hours.includes(w.hour[i])) continue;
    const v = w.windSpeed[i];
    total++;
    speedSum += v;
    if (v < classes[0]) { calm++; continue; }
    const s = Math.floor((((w.windDir[i] % 360) + 360) % 360) / (360 / sectors) + 0.5) % sectors;
    let c = classes.length - 1;
    for (let j = 1; j < classes.length; j++) if (v < classes[j]) { c = j - 1; break; }
    table[s][c]++;
  }
  const freq = table.map((row) => row.map((x) => (total ? x / total : 0)));
  const sectorFreq = freq.map((row) => row.reduce((a, b) => a + b, 0));
  let prevailing = 0;
  sectorFreq.forEach((f, i) => { if (f > sectorFreq[prevailing]) prevailing = i; });
  // Mean speed of the prevailing sector (non-calm hours).
  let pSum = 0;
  let pN = 0;
  for (let i = 0; i < w.hours; i++) {
    if (months && !months.includes(w.month[i])) continue;
    if (hours && !hours.includes(w.hour[i])) continue;
    const v = w.windSpeed[i];
    if (v < classes[0]) continue;
    const s = Math.floor((((w.windDir[i] % 360) + 360) % 360) / (360 / sectors) + 0.5) % sectors;
    if (s === prevailing) { pSum += v; pN++; }
  }
  return {
    sectors, classes, freq, sectorFreq, calm: total ? calm / total : 0,
    meanSpeed: total ? speedSum / total : 0,
    prevailingDirection: prevailing * (360 / sectors),
    prevailingSpeed: pN ? pSum / pN : 0
  };
}

// ASHRAE clear-sky model constants per month (A in W/m2, B, C; ASHRAE
// Handbook of Fundamentals, 1985): DNI = A exp(-B / sin(altitude)), DHI = C DNI.
const ASHRAE_CLEAR = [
  [1230, 0.142, 0.058], [1215, 0.144, 0.060], [1186, 0.156, 0.071], [1136, 0.180, 0.097],
  [1104, 0.196, 0.121], [1088, 0.205, 0.134], [1085, 0.207, 0.136], [1107, 0.201, 0.122],
  [1151, 0.177, 0.092], [1192, 0.160, 0.073], [1221, 0.149, 0.063], [1233, 0.142, 0.057]
];

/** Hourly clear-sky DNI/DHI/GHI (Wh/m2 per hour) for a site: an upper bound with no clouds. */
export function clearSkyYear(lat, lon, utcOffset) {
  const n = 8760;
  const w = { location: { lat, lon, utcOffset, city: 'Clear sky', clearSky: true }, hours: n,
    month: new Uint8Array(n), day: new Uint8Array(n), hour: new Uint8Array(n),
    ghi: new Float32Array(n), dni: new Float32Array(n), dhi: new Float32Array(n) };
  let k = 0;
  for (let m = 1; m <= 12; m++) {
    for (let d = 1; d <= MONTH_DAYS[m - 1]; d++) {
      for (let h = 1; h <= 24; h++) {
        w.month[k] = m; w.day[k] = d; w.hour[k] = h;
        const p = solarPosition(typicalDoy(m, d), h - 0.5, lat, lon, utcOffset);
        if (p.elevation > 0.0175) {
          const [A, B, C] = ASHRAE_CLEAR[m - 1];
          const s = Math.sin(p.elevation);
          const dni = A * Math.exp(-B / s);
          w.dni[k] = dni;
          w.dhi[k] = C * dni;
          w.ghi[k] = dni * s + C * dni;
        }
        k++;
      }
    }
  }
  return w;
}

/**
 * Bin the year's direct-beam hours into sky patches. Each patch becomes one
 * direction (the DNI-weighted mean sun vector of its hours) with the patch's
 * DNI sum in Wh/m2 as weight. Also returns DHI and GHI sums for the diffuse
 * and ground-reflected terms.
 * @param {any} w weather (EPW or clear sky)
 * @param {{ lat: number, lon: number, utcOffset: number, months?: number[]|null, altStepDeg?: number, azStepDeg?: number }} site
 */
export function annualSunBins(w, { lat, lon, utcOffset, months = null, altStepDeg = 5, azStepDeg = 7.5 }) {
  const bins = new Map();
  let dhiSum = 0;
  let ghiSum = 0;
  let dniSum = 0;
  for (let i = 0; i < w.hours; i++) {
    if (months && !months.includes(w.month[i])) continue;
    dhiSum += w.dhi[i];
    ghiSum += w.ghi[i];
    const dni = w.dni[i];
    if (dni <= 0) continue;
    const p = solarPosition(typicalDoy(w.month[i], w.day[i]), w.hour[i] - 0.5, lat, lon, utcOffset);
    if (p.elevation <= 0.0087) continue; // below 0.5 degrees
    dniSum += dni;
    const altBin = Math.floor(p.elevation / (altStepDeg * Math.PI / 180));
    const azBin = Math.floor(p.azimuth / (azStepDeg * Math.PI / 180));
    const key = altBin * 1000 + azBin;
    const v = sunVector(p.elevation, p.azimuth);
    let b = bins.get(key);
    if (!b) { b = { x: 0, y: 0, z: 0, weight: 0 }; bins.set(key, b); }
    b.x += v[0] * dni; b.y += v[1] * dni; b.z += v[2] * dni; b.weight += dni;
  }
  const directions = [];
  for (const b of bins.values()) {
    const len = Math.hypot(b.x, b.y, b.z) || 1;
    directions.push({ dir: [b.x / len, b.y / len, b.z / len], weight: b.weight });
  }
  return { directions, dhiSum, ghiSum, dniSum };
}

/** Hourly conditions for comfort analysis. */
export function conditionsAt(w, month, day, hourEnding) {
  const i = hourIndex(month, day, hourEnding);
  return {
    airTemp: w.dryBulb?.[i], rh: w.rh?.[i], windSpeed: w.windSpeed?.[i], windDir: w.windDir?.[i],
    ghi: w.ghi[i], dni: w.dni[i], dhi: w.dhi[i], ir: w.ir?.[i]
  };
}
