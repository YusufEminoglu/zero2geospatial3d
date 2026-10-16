// @ts-check
// Viewer <-> QGIS link through the plugin's local server (core/server.py).
import { rampStops, rgbToHex } from '../core/classify.js';

let online = null;

export async function qgisOnline() {
  if (online !== null) return online;
  try {
    const r = await fetch('/api/ping', { cache: 'no-store' });
    online = r.ok;
  } catch {
    online = false;
  }
  return online;
}

export function float32ToBase64(values) {
  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  let out = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) out += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  return btoa(out);
}

async function post(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`QGIS link: HTTP ${r.status}`);
  return r.json();
}

/**
 * The viewer's colours for QGIS: the ramp's stops (reversed ramps already
 * reversed), or the classes of a class result with their legend labels.
 */
export function qgisStyle(display = {}, legend = null) {
  if (display.categorical) {
    const labels = display.labels || {};
    const byColor = new Map((legend || []).map((it) => [String(it.color).toLowerCase(), it.label]));
    const categories = Object.entries(display.categorical).map(([value, color]) => ({
      value: Number(value), color, label: labels[value] ?? byColor.get(String(color).toLowerCase()) ?? String(value)
    }));
    return { categories };
  }
  const ramp = String(display.ramp || 'viridis');
  return { ramp, stops: rampStops(ramp).map(rgbToHex) };
}

/** Send a grid result as a GeoTIFF layer. */
export async function sendGrid(result, key) {
  const values = result.values instanceof Float32Array ? result.values : Float32Array.from(result.values);
  return post('/api/result', {
    type: 'grid', name: result.title, key, unit: result.unit,
    grid: result.grid, data: float32ToBase64(values),
    style: { min: result.display.min, max: result.display.max, ...qgisStyle(result.display, result.legend) }
  });
}

/**
 * Send per-feature fields ([{ layer, name, values }]) grouped by layer.
 * style: a ramp name, or { field, categories, other } / { ramp } for QGIS.
 */
export async function sendFields(fields, style = 'viridis') {
  const st = typeof style === 'string' ? qgisStyle({ ramp: style }) : (style.categories ? style : { ...qgisStyle({ ramp: style.ramp }), ...style });
  const byLayer = new Map();
  for (const f of fields) {
    const out = byLayer.get(f.layer) || {};
    const values = {};
    f.values.forEach((v, i) => { if (Number.isFinite(v)) values[i + 1] = Math.round(v * 1000) / 1000; });
    out[f.name] = { values };
    byLayer.set(f.layer, out);
  }
  const sent = [];
  for (const [layer, fieldsObj] of byLayer) {
    await post('/api/result', { type: 'features', layer: layer.entry.id, fields: fieldsObj, style: st });
    sent.push(layer.entry.name);
  }
  return sent;
}

export async function selectInQgis(layer, ids) {
  return post('/api/select', { layer: layer.entry.id, ids });
}

export async function qgisSelection() {
  const r = await fetch('/api/selection', { cache: 'no-store' });
  return r.ok ? r.json() : { seq: 0, layers: {} };
}
