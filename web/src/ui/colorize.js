// @ts-check
// Colour and height rules for object layers.
//
// rule = { mode: 'source'|'single'|'graduated'|'categorized', field, method,
//          classes, ramp, color, filter: { on, field, min, max } }
import { breaksFor, classOf, categories, rampStops, rampColor, hexToRgb, QUALITATIVE, fmt } from '../core/classify.js';

const DIM = [0.86, 0.86, 0.86];
const HIGHLIGHT = [1.0, 0.8, 0.1];

export function defaultRule() {
  return { mode: 'source', field: '', method: 'jenks', classes: 6, ramp: 'viridis', color: '#d9d4cc',
    filter: { on: false, field: '', min: 0, max: 0, hide: false } };
}

/**
 * Compute per-feature colours and a legend for a layer.
 * @returns {{ legend: { title: string, items: { color: string, label: string }[] } | null }}
 */
export function applyRule(layer, rule, highlight = null) {
  const n = layer.count;
  const out = layer.colors;
  let legend = null;
  if (rule.mode === 'single') {
    const c = hexToRgb(rule.color);
    for (let i = 0; i < n; i++) out.set(c, i * 3);
    legend = { title: layer.entry.name, items: [{ color: rule.color, label: 'All features' }] };
  } else if (rule.mode === 'graduated' && rule.field) {
    const values = layer.values(rule.field);
    const breaks = breaksFor(rule.method, values, rule.classes);
    const stops = rampStops(rule.ramp);
    const k = Math.max(1, breaks.length - 1);
    const classColors = Array.from({ length: k }, (_, i) => rampColor(stops, k === 1 ? 0.5 : i / (k - 1), [0, 0, 0]));
    for (let i = 0; i < n; i++) {
      const cl = classOf(values[i], breaks);
      out.set(cl < 0 ? DIM : classColors[cl], i * 3);
    }
    const unit = unitOf(rule.field);
    legend = { title: `${layer.entry.name}: ${rule.field}`, items: classColors.map((c, i) => ({
      color: rgbHex(c), label: `${fmt(breaks[i], '')} – ${fmt(breaks[i + 1], unit)}` })) };
  } else if (rule.mode === 'categorized' && rule.field) {
    const values = layer.values(rule.field);
    const cats = categories(values, 18);
    const map = new Map(cats.map((c, i) => [c.value, hexToRgb(QUALITATIVE[i % QUALITATIVE.length])]));
    for (let i = 0; i < n; i++) {
      const key = values[i] === null || values[i] === undefined || values[i] === '' ? '(empty)' : String(values[i]);
      out.set(map.get(key) || DIM, i * 3);
    }
    legend = { title: `${layer.entry.name}: ${rule.field}`, items: cats.map((c, i) => ({ color: QUALITATIVE[i % QUALITATIVE.length], label: `${c.value} (${c.count})` })) };
    if (cats.length >= 18) legend.items.push({ color: rgbHex(DIM), label: 'Other values' });
  } else {
    out.set(layer.sourceColors);
  }
  const f = rule.filter;
  if (f?.on && f.field) {
    const values = layer.values(f.field);
    for (let i = 0; i < n; i++) {
      const v = Number(values[i]);
      if (!(Number.isFinite(v) && v >= f.min && v <= f.max)) out.set(DIM, i * 3);
    }
  }
  if (highlight) for (const i of highlight) if (i >= 0 && i < n) out.set(HIGHLIGHT, i * 3);
  layer.applyColors();
  return { legend };
}

/** Numeric range of a field. */
export function fieldRange(layer, field) {
  let lo = Infinity, hi = -Infinity;
  for (const v of layer.values(field)) {
    const x = Number(v);
    if (v === null || v === '' || !Number.isFinite(x)) continue;
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  return Number.isFinite(lo) ? [lo, hi] : [0, 0];
}

/**
 * Heights from a rule: { mode: 'source'|'field'|'uniform', field, factor, value }.
 */
export function applyHeightRule(layer, rule) {
  const n = layer.count;
  if (rule.mode === 'field' && rule.field) {
    const values = layer.values(rule.field);
    for (let i = 0; i < n; i++) {
      const v = Number(values[i]);
      layer.heights[i] = Number.isFinite(v) && values[i] !== null ? Math.max(0, v * rule.factor) : 0;
    }
  } else if (rule.mode === 'uniform') {
    layer.heights.fill(Math.max(0, rule.value));
  } else {
    layer.heights.set(layer.sourceHeights);
  }
  layer.applyHeights();
}

const UNITS = { sun_h_roof: 'h', sun_h_facade: 'h', shade_pct_roof: '%', roof_kwh_m2: 'kWh/m²', pv_kwh_yr: 'kWh', pv_area_m2: 'm²',
  facade_kwh_m2: 'kWh/m²', facade_pv_kwh_yr: 'kWh', visible_roof_pct: '%', svf_roof: '', svf_facade: '' };
function unitOf(field) { return UNITS[field] || ''; }
function rgbHex(c) { return `#${c.map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0')).join('')}`; }
