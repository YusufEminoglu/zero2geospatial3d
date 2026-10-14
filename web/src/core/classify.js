// @ts-check
// Colour ramps and classification (equal interval, quantile, natural
// breaks, categories) for recolouring features and analysis grids.

export const RAMPS = {
  viridis: ['#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'],
  magma: ['#000004', '#1c1044', '#4f127b', '#812581', '#b5367a', '#e55964', '#fb8761', '#fec287', '#fcfdbf'],
  inferno: ['#000004', '#1f0c48', '#550f6d', '#88226a', '#ba3655', '#e35933', '#f98e09', '#f9cb35', '#fcffa4'],
  rdylbu: ['#a50026', '#d73027', '#f46d43', '#fdae61', '#fee090', '#ffffbf', '#e0f3f8', '#abd9e9', '#74add1', '#4575b4', '#313695'],
  spectral: ['#9e0142', '#d53e4f', '#f46d43', '#fdae61', '#fee08b', '#ffffbf', '#e6f598', '#abdda4', '#66c2a5', '#3288bd', '#5e4fa2'],
  rdbu: ['#67001f', '#b2182b', '#d6604d', '#f4a582', '#fddbc7', '#f7f7f7', '#d1e5f0', '#92c5de', '#4393c3', '#2166ac', '#053061'],
  blues: ['#f7fbff', '#deebf7', '#c6dbef', '#9ecae1', '#6baed6', '#4292c6', '#2171b5', '#08519c', '#08306b'],
  reds: ['#fff5f0', '#fee0d2', '#fcbba1', '#fc9272', '#fb6a4a', '#ef3b2c', '#cb181d', '#a50f15', '#67000d'],
  greens: ['#f7fcf5', '#e5f5e0', '#c7e9c0', '#a1d99b', '#74c476', '#41ab5d', '#238b45', '#006d2c', '#00441b'],
  terrain: ['#2b6b3f', '#5f9a4f', '#a8c47a', '#e9dfa3', '#d2b47c', '#a47b55', '#8a7a72', '#f2f2f2']
};
export const QUALITATIVE = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac',
  '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'];
export const RAMP_LABELS = {
  viridis: 'Viridis', magma: 'Magma', inferno: 'Inferno', rdylbu: 'Red-Yellow-Blue', spectral: 'Spectral',
  rdbu: 'Red-Blue', blues: 'Blues', reds: 'Reds', greens: 'Greens', terrain: 'Terrain'
};

export function hexToRgb(hex) {
  const h = String(hex || '#cccccc').replace('#', '');
  const v = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export function rgbToHex([r, g, b]) {
  const c = (x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Ramp stops as RGB triples; name may end in '-r' for reversed. */
export function rampStops(name) {
  const reversed = String(name).endsWith('-r');
  const key = reversed ? String(name).slice(0, -2) : String(name);
  const stops = (RAMPS[key] || RAMPS.viridis).map(hexToRgb);
  return reversed ? stops.reverse() : stops;
}

/** Colour at t in [0, 1] along a ramp (stops from rampStops). */
export function rampColor(stops, t, out = [0, 0, 0]) {
  const v = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(v));
  const f = v - i;
  for (let k = 0; k < 3; k++) out[k] = stops[i][k] + (stops[i + 1][k] - stops[i][k]) * f;
  return out;
}

function finiteSorted(values) {
  const out = [];
  for (const v of values) if (v !== null && v !== '' && Number.isFinite(Number(v))) out.push(Number(v));
  return out.sort((a, b) => a - b);
}

export function equalBreaks(values, k) {
  const s = finiteSorted(values);
  if (!s.length) return [];
  const lo = s[0];
  const hi = s[s.length - 1];
  return Array.from({ length: k + 1 }, (_, i) => lo + ((hi - lo) * i) / k);
}

export function quantileBreaks(values, k) {
  const s = finiteSorted(values);
  if (!s.length) return [];
  const out = [s[0]];
  for (let i = 1; i < k; i++) out.push(s[Math.min(s.length - 1, Math.floor((i * s.length) / k))]);
  out.push(s[s.length - 1]);
  return out;
}

/** Jenks natural breaks (Fisher-Jenks dynamic programme) on at most 3000 sampled values. */
export function jenksBreaks(values, k) {
  let s = finiteSorted(values);
  if (!s.length) return [];
  if (s.length > 3000) {
    const step = s.length / 3000;
    s = Array.from({ length: 3000 }, (_, i) => s[Math.floor(i * step)]);
    s.push(finiteSorted(values).pop());
  }
  const n = s.length;
  k = Math.max(1, Math.min(k, new Set(s).size));
  const lower = Array.from({ length: n + 1 }, () => new Int32Array(k + 1));
  const variance = Array.from({ length: n + 1 }, () => new Float64Array(k + 1).fill(Infinity));
  for (let j = 1; j <= k; j++) { lower[1][j] = 1; variance[1][j] = 0; }
  for (let l = 2; l <= n; l++) {
    let sum = 0;
    let sumSq = 0;
    let w = 0;
    let v = 0;
    for (let m = 1; m <= l; m++) {
      const i3 = l - m + 1;
      const val = s[i3 - 1];
      w++;
      sum += val;
      sumSq += val * val;
      v = sumSq - (sum * sum) / w;
      const i4 = i3 - 1;
      if (i4 !== 0) {
        for (let j = 2; j <= k; j++) {
          if (variance[l][j] >= v + variance[i4][j - 1]) {
            lower[l][j] = i3;
            variance[l][j] = v + variance[i4][j - 1];
          }
        }
      }
    }
    lower[l][1] = 1;
    variance[l][1] = v;
  }
  const breaks = new Array(k + 1);
  breaks[k] = s[n - 1];
  breaks[0] = s[0];
  let idx = n;
  for (let j = k; j >= 2; j--) {
    const id = lower[idx][j] - 2;
    breaks[j - 1] = s[Math.max(0, id)];
    idx = lower[idx][j] - 1;
  }
  return breaks;
}

export function breaksFor(method, values, k) {
  if (method === 'quantile') return quantileBreaks(values, k);
  if (method === 'jenks') return jenksBreaks(values, k);
  return equalBreaks(values, k);
}

/** Class index of a value for breaks [b0..bk]: 0..k-1, or -1 if not finite. */
export function classOf(value, breaks) {
  const v = Number(value);
  if (value === null || value === '' || !Number.isFinite(v) || breaks.length < 2) return -1;
  for (let i = 1; i < breaks.length - 1; i++) if (v < breaks[i]) return i - 1;
  return breaks.length - 2;
}

/** Distinct values by frequency, most common first (at most `limit`). */
export function categories(values, limit = 20) {
  const counts = new Map();
  for (const v of values) {
    const key = v === null || v === undefined || v === '' ? '(empty)' : String(v);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([value, count]) => ({ value, count }));
}

/** Short number formatting for legends. */
export function fmt(v, unit = '') {
  if (!Number.isFinite(v)) return '–';
  if (Number.isInteger(v)) return unit ? `${v.toLocaleString('en-US')} ${unit}` : v.toLocaleString('en-US');
  const a = Math.abs(v);
  const s = a >= 1000 ? Math.round(v).toLocaleString('en-US') : a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
  return unit ? `${s} ${unit}` : s;
}
