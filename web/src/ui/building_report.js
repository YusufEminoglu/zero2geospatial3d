// @ts-check
// Building report: everything known about one building (facts, analysis
// results with their rank among all buildings, attributes), a one-click
// analysis of its surroundings, and a one-page PDF sheet.
import * as THREE from 'three';
import { h, button, toast, download } from './dom.js';
import { fmt } from '../core/classify.js';
import { renderImage } from '../export/exporters.js';
import { PdfPage, wrap } from '../export/pdf.js';

/** Label, unit and one-line explanation of each result field. */
export const FIELD_INFO = {
  sun_h_roof: ['Sun on the roof', 'h', 'Direct sun hours on the roof on the analysed day'],
  sun_h_facade: ['Sun on the facades', 'h', 'Direct sun hours on the walls (mean over all facades)'],
  shade_h_roof: ['Roof in shade', 'h', 'Hours the roof is shaded while the sun is up'],
  shade_pct_roof: ['Roof shade share', '%', 'Share of the sunny period the roof is shaded'],
  svf_roof: ['Sky view, roof', '', 'Visible sky from the roof (1 = open)'],
  svf_facade: ['Sky view, facades', '', 'Visible sky from the walls (0.5 = unobstructed wall)'],
  roof_kwh_m2: ['Roof irradiation', 'kWh/m²', 'Solar energy reaching the roof per square metre in the period'],
  pv_kwh_yr: ['Rooftop PV yield', 'kWh', 'Electricity from panels on the suitable part of the roof'],
  pv_area_m2: ['Panel area', 'm²', 'Roof area that keeps enough sun for panels'],
  facade_kwh_m2: ['Facade irradiation', 'kWh/m²', 'Solar energy reaching the walls per square metre'],
  facade_pv_kwh_yr: ['Facade PV yield', 'kWh', 'Electricity from panels on the walls'],
  visible_roof_pct: ['Roof visible', '%', 'Share of the roof seen from the observer'],
  lambda_p: ['Built fraction (block)', '', 'Plan area fraction of the surrounding block'],
  h_w: ['Canyon ratio H/W (block)', '', 'Street canyon height-to-width ratio around the building'],
  lcz: ['Local Climate Zone', '', 'Approximate LCZ of the surrounding block'],
  flood_depth_m: ['Flood depth at the door', 'm', 'Water depth at the lowest ground point for the chosen level'],
  opt_floors: ['Optimised floors', '', 'Floor count of the applied optimisation design'],
  opt_height_m: ['Optimised height', 'm', 'Height of the applied optimisation design']
};

function infoFor(name) {
  if (FIELD_INFO[name]) return FIELD_INFO[name];
  if (name.startsWith('clim_')) return [`${name.slice(5)} (climate raster)`, '', 'Mean of the climate raster over the footprint'];
  return [name, '', ''];
}

/** Share of buildings (with a value) whose value is below this one, 0..100. */
export function percentileRank(values, v) {
  let below = 0, n = 0;
  for (const x of values) {
    if (!Number.isFinite(x)) continue;
    n++;
    if (x < v) below++;
  }
  return n ? (100 * below) / n : NaN;
}

const FLOOR_FIELDS = ['floors', 'levels', 'building_levels', 'kat', 'kat_sayisi', 'num_floors', 'storeys'];

export function buildingFacts(app, layer, f) {
  const props = layer.features[f].properties;
  const lower = Object.fromEntries(Object.keys(props).map((k) => [k.toLowerCase(), k]));
  const floorKey = FLOOR_FIELDS.find((k) => lower[k] && Number.isFinite(Number(props[lower[k]])));
  const floors = floorKey ? Number(props[lower[floorKey]]) : Math.max(1, Math.round(layer.heights[f] / 3));
  const facts = [
    ['Height', `${layer.heights[f].toFixed(1)} m`],
    ['Floors', `${floors}${floorKey ? '' : ' (from the height)'}`],
    ['Footprint', `${Math.round(layer.footprint[f]).toLocaleString('en-US')} m²`],
    ['Floor area (est.)', `${Math.round(layer.footprint[f] * floors).toLocaleString('en-US')} m²`],
    ['Ground level', `${layer.baseZ[f].toFixed(1)} m`]
  ];
  const analyses = [];
  for (const [name, arr] of layer.extraFields) {
    const v = arr[f];
    if (!Number.isFinite(v)) continue;
    const [label, unit, help] = infoFor(name);
    const rank = percentileRank(arr, v);
    let mean = 0, n = 0;
    for (const x of arr) if (Number.isFinite(x)) { mean += x; n++; }
    analyses.push({ name, label, unit, help, value: v, rank, mean: n ? mean / n : NaN, count: n });
  }
  const attributes = Object.entries(props).filter(([k, v]) => !k.startsWith('_') && v !== null && v !== '').slice(0, 24)
    .map(([k, v]) => [k, typeof v === 'number' ? fmt(v) : String(v)]);
  const name = props.name || props.NAME || props.ad || `#${f + 1}`;
  return { name: String(name), facts, analyses, attributes };
}

/** Report block for the inspector panel. */
export function reportBlock(app, layer, f) {
  const info = buildingFacts(app, layer, f);
  const wrapEl = h('div', { class: 'report' });
  wrapEl.appendChild(h('table', { class: 'stats' }, ...info.facts.map(([k, v]) => h('tr', {}, h('td', { text: k }), h('td', { text: v })))));
  if (info.analyses.length) {
    wrapEl.appendChild(h('div', { class: 'insp-sub', text: 'Analysis results' }));
    for (const a of info.analyses) {
      wrapEl.appendChild(h('div', { class: 'rep-row', title: a.help },
        h('div', { class: 'rep-head' }, h('span', { text: a.label }), h('b', { text: fmt(a.value, a.unit) })),
        h('div', { class: 'rep-bar' }, h('i', { style: { width: `${Math.max(2, a.rank).toFixed(0)}%` } })),
        h('div', { class: 'muted small', text: `Higher than ${a.rank.toFixed(0)} % of ${a.count} buildings · mean ${fmt(a.mean, a.unit)}` })));
    }
  } else {
    wrapEl.appendChild(h('p', { class: 'muted small', text: 'No analysis results for this building yet: press "Analyse this building".' }));
  }
  wrapEl.appendChild(h('div', { class: 'btn-row' },
    button('Analyse this building', () => analyseBuilding(app, layer, f), { kind: 'primary', title: 'Winter sun, sky view and annual solar, with facades, around this building' }),
    button('Report PDF', async () => {
      try {
        const { blob, name } = await buildingPdf(app, layer, f);
        download(`building_${name.replace(/[^A-Za-z0-9_-]+/g, '_')}.pdf`, blob);
        toast('Building report saved.');
      } catch (e) { toast(e.message, 'error'); }
    })));
  return wrapEl;
}

/** Sun (21 Dec), sky view and annual solar around one building, facades included. */
export async function analyseBuilding(app, layer, f) {
  const x = layer.centroid[f * 2], y = layer.centroid[f * 2 + 1];
  const r = Math.max(120, 2.5 * layer.heights[f], Math.sqrt(layer.footprint[f]) * 2);
  const sc = app.sceneArea();
  const area = { minX: Math.max(sc.minX, x - r), maxX: Math.min(sc.maxX, x + r), minY: Math.max(sc.minY, y - r), maxY: Math.min(sc.maxY, y + r) };
  const prev = { ...app.analysisArea };
  app.analysisArea = { mode: 'rect', rect: area, radius: prev.radius };
  const done = await app.run('Building analysis', async (prog) => {
    const a = app.analyst;
    const sun = await a.sunHours({ area, cell: 1, date: { month: 12, day: 21 }, facades: true, onProgress: (q) => prog(q * 0.3) });
    const svf = await a.skyView({ area, cell: 1, directions: 144, facades: true, onProgress: (q) => prog(0.3 + q * 0.3) });
    const solar = await a.solarRadiation({ area, cell: 1, facades: true, onProgress: (q) => prog(0.6 + q * 0.4) });
    return [...solar, ...svf, ...sun];
  });
  app.analysisArea = prev;
  if (done) app.inspect(layer, f);
}

/** One-page building sheet: { blob, name }. */
export async function buildingPdf(app, layer, f) {
  const info = buildingFacts(app, layer, f);
  const v = app.viewer;
  const cam = v.camera;
  const saved = { pos: cam.position.clone(), target: v.controls.target.clone() };
  const c = layer.featureCentre(f);
  const size = Math.max(60, 3 * Math.max(layer.heights[f], Math.sqrt(layer.footprint[f])));
  const dir = cam.position.clone().sub(v.controls.target).normalize();
  if (dir.y < 0.35) dir.y = 0.6;
  dir.normalize();
  v.controls.target.copy(c);
  cam.position.copy(c).addScaledVector(dir, size * 1.6);
  cam.lookAt(c);
  const [PW, PH] = [842, 595];
  const margin = 28, side = 260;
  const imgW = PW - margin * 3 - side, imgH = PH - margin * 2 - 64;
  let canvas;
  try {
    canvas = renderImage(app, { width: Math.round(imgW * 2.2), height: Math.round(imgH * 2.2),
      furniture: { title: false, legend: true, north: true, scale: true, credits: false } });
  } finally {
    cam.position.copy(saved.pos);
    v.controls.target.copy(saved.target);
    cam.lookAt(saved.target);
    v.requestRender();
  }
  const jpeg = canvas.toDataURL('image/jpeg', 0.9);
  const bytes = Uint8Array.from(atob(jpeg.split(',')[1]), (ch) => ch.charCodeAt(0));
  const page = new PdfPage(PW, PH);
  const ink = [0.11, 0.14, 0.19], muted = [0.42, 0.45, 0.5];
  page.text(margin, margin + 18, `Building report: ${info.name}`, { size: 18, bold: true, color: ink });
  page.text(margin, margin + 36, `${app.manifest.title} · ${layer.entry.name}`, { size: 10, color: muted });
  page.jpeg(bytes, canvas.width, canvas.height, margin, margin + 50, imgW, imgH);
  page.rect(margin, margin + 50, imgW, imgH, { stroke: [0.8, 0.82, 0.85] });
  const x = margin * 2 + imgW;
  let y = margin + 64;
  const table = (title, rows) => {
    page.text(x, y, title, { size: 10, bold: true, color: ink });
    y += 4;
    for (const [k, val] of rows) {
      if (y > PH - margin - 40) return;
      y += 13;
      page.text(x, y, k, { size: 8.5, color: muted });
      page.text(x + side - Math.min(side * 0.5, 6 + String(val).length * 4.6), y, val, { size: 8.5, color: ink });
      page.line(x, y + 3, x + side, y + 3, { color: [0.88, 0.89, 0.91], width: 0.4 });
    }
    y += 20;
  };
  table('Building', info.facts);
  if (info.analyses.length) {
    page.text(x, y, 'Analysis results', { size: 10, bold: true, color: ink });
    y += 6;
    for (const a of info.analyses) {
      if (y > PH - margin - 60) break;
      y += 12;
      page.text(x, y, a.label, { size: 8.5, color: ink });
      page.text(x + side - Math.min(side * 0.5, 6 + fmt(a.value, a.unit).length * 4.6), y, fmt(a.value, a.unit), { size: 8.5, bold: true, color: ink });
      y += 5;
      page.rect(x, y, side, 4, { fill: [0.9, 0.91, 0.93] });
      page.rect(x, y, (side * Math.max(2, a.rank)) / 100, 4, { fill: [0.12, 0.44, 0.92] });
      y += 12;
      page.text(x, y, `Higher than ${a.rank.toFixed(0)} % of ${a.count} buildings, mean ${fmt(a.mean, a.unit)}`, { size: 7.5, color: muted });
    }
    y += 18;
  } else {
    for (const line of wrap('No analysis results yet. Use "Analyse this building" in the viewer first.', 8.5, side)) { page.text(x, y, line, { size: 8.5, color: muted }); y += 11; }
    y += 10;
  }
  if (y < PH - margin - 80) table('Attributes', info.attributes.slice(0, Math.floor((PH - margin - 40 - y) / 13) - 1));
  page.line(margin, PH - margin - 8, PW - margin, PH - margin - 8, { color: [0.85, 0.86, 0.88] });
  page.text(margin, PH - margin + 4, `${app.manifest.crs.authid} · 02 Geo3D Analyzer`, { size: 7.5, color: muted });
  page.text(PW - margin - 110, PH - margin + 4, new Date().toISOString().slice(0, 16).replace('T', ' '), { size: 7.5, color: muted });
  const blob = new Blob([page.build({ title: `Building report: ${info.name}` })], { type: 'application/pdf' });
  return { blob, name: info.name };
}

export { THREE };
