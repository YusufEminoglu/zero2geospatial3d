// @ts-check
// Building report: everything known about one building (facts, analysis
// results with their rank among all buildings, attributes), a one-click
// analysis of its surroundings, and a one-page PDF sheet.
import * as THREE from 'three';
import { h, button, toast, download } from './dom.js';
import { fmt } from '../core/classify.js';
import { renderImage } from '../export/exporters.js';
import { PdfPage, wrap } from '../export/pdf.js';
import { featureKey } from '../scene/objects.js';
import { rampStops, rampColor } from '../core/classify.js';
import { OPEN_PEDESTRIAN_FACTOR } from '../core/wind.js';

/** Label, unit and one-line explanation of each result field. */
export const FIELD_INFO = {
  sun_h_roof: ['Sun on the roof', 'h', 'Direct sun hours on the roof on the analysed day'],
  sun_h_facade: ['Sun on the facades', 'h', 'Direct sun hours on the walls (mean over all facades)'],
  shade_h_roof: ['Roof in shade', 'h', 'Hours the roof is shaded while the sun is up'],
  shade_pct_roof: ['Roof shade share', '%', 'Share of the sunny period the roof is shaded'],
  svf_roof: ['Sky view, roof', '', 'Visible sky from the roof (1 = open)'],
  svf_facade: ['Sky view, facades', '', 'Visible sky from the walls (0.5 = unobstructed wall)'],
  vsc_facade: ['Daylight on the walls (VSC)', '%', 'Mean vertical sky component of the walls; 39.6 % is an open wall, BRE 209 looks for 27 % at a window'],
  vsc_ground: ['Daylight, lowest storey (VSC)', '%', 'Mean VSC of the walls in the lowest 3 m, where daylight is scarcest'],
  vsc27_share: ['Walls at 27 % VSC', '%', 'Share of the wall area with a VSC of 27 % or more (BRE 209)'],
  vsc_ratio_BA: ['Daylight kept under B', '×', 'Wall VSC with scenario B divided by that with A; under 0.8 is a noticeable loss (BRE 209)'],
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
  comfort_pct: ['Comfortable hours around it', '%', 'Share of the year (chosen hours) with UTCI 9–26 °C on the surrounding open ground'],
  heat_stress_h: ['Heat-stress hours', 'h', 'Hours a year with UTCI of 32 °C or more around the building'],
  cold_stress_h: ['Cold-stress hours', 'h', 'Hours a year with UTCI below 0 °C around the building'],
  ped_wind_ms: ['Pedestrian wind (year)', 'm/s', 'Mean sheltered wind at 1.5 m around the building'],
  windy_pct: ['Windy hours', '%', 'Share of hours with pedestrian wind above 5 m/s'],
  svf_ground: ['Sky view around it', '', 'Mean sky view factor of the surrounding open ground'],
  opt_height_m: ['Optimised height', 'm', 'Height of the applied optimisation design']
};

function infoFor(name) {
  if (FIELD_INFO[name]) return FIELD_INFO[name];
  const sm = name.match(/^(.+)_(djf|mam|jja|son)$/);
  if (sm && FIELD_INFO[sm[1]]) {
    const season = { djf: 'winter', mam: 'spring', jja: 'summer', son: 'autumn' }[sm[2]];
    const [label, unit, help] = FIELD_INFO[sm[1]];
    return [`${label}, ${season}`, unit, `${help} (${season} only)`];
  }
  const m = name.match(/^(d_)?(.+?)(_A|_B)?$/);
  if (m && (m[1] || m[3]) && FIELD_INFO[m[2]]) {
    const [label, unit, help] = FIELD_INFO[m[2]];
    if (m[1]) return [`${label}: change B − A`, unit, `How scenario B changes it: ${help.toLowerCase()}`];
    return [`${label} (scenario ${m[3].slice(1)})`, unit, help];
  }
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
  const scenario = [];
  for (const [name, arr] of layer.extraFields) {
    const v = arr[f];
    if (!Number.isFinite(v)) continue;
    const sm = name.match(/^d_(.+)$/);
    if (sm) {
      const a = layer.extraFields.get(`${sm[1]}_A`)?.[f];
      const b = layer.extraFields.get(`${sm[1]}_B`)?.[f];
      const [label, unit] = infoFor(sm[1]);
      scenario.push({ name: sm[1], label, unit, a, b, delta: v });
      continue;
    }
    if (/_(A|B)$/.test(name) && layer.extraFields.has(`d_${name.slice(0, -2)}`)) continue;
    const [label, unit, help] = infoFor(name);
    const rank = percentileRank(arr, v);
    let mean = 0, n = 0;
    for (const x of arr) if (Number.isFinite(x)) { mean += x; n++; }
    analyses.push({ name, label, unit, help, value: v, rank, mean: n ? mean / n : NaN, count: n });
  }
  const attributes = Object.entries(props).filter(([k, v]) => !k.startsWith('_') && v !== null && v !== '').slice(0, 24)
    .map(([k, v]) => [k, typeof v === 'number' ? fmt(v) : String(v)]);
  const name = props.name || props.NAME || props.ad || `#${f + 1}`;
  // Optimisation: this building's floors now and in the applied design.
  let optimisation = null;
  const o = app.lastOptimisation;
  const k = o ? o.targets.findIndex((t) => t.layer === layer && t.f === f) : -1;
  if (o && k >= 0) {
    optimisation = {
      floorsNow: o.now.x[k], floorsDesign: o.design.x[k], floorHeight: o.floorHeight,
      gfaChange: (o.design.x[k] - o.now.x[k]) * layer.footprint[f],
      groundSunNow: o.now.extra.sun, groundSunDesign: o.design.extra.sun,
      areaNow: o.now.extra.gfa, areaDesign: o.design.extra.gfa, targets: o.targets.length, date: o.date
    };
  }
  return { name: String(name), facts, analyses, attributes, scenario, optimisation };
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
  } else if (!info.scenario.length) {
    wrapEl.appendChild(h('p', { class: 'muted small', text: 'No analysis results for this building yet: press "Analyse this building".' }));
  }
  if (info.scenario.length) {
    wrapEl.appendChild(h('div', { class: 'insp-sub', text: `Scenario impact (B − A)` }));
    wrapEl.appendChild(h('table', { class: 'stats' }, ...info.scenario.map((s) => h('tr', {},
      h('td', { text: s.label }),
      h('td', { class: s.delta < 0 ? 'neg' : s.delta > 0 ? 'pos' : '', text: `${fmtOr(s.a, s.unit)} → ${fmtOr(s.b, s.unit)} (${sign(s.delta)}${fmt(s.delta, s.unit)})` })))));
  }
  const seasons = buildingSeasons(app, layer, f);
  if (seasons) {
    wrapEl.appendChild(h('div', { class: 'insp-sub', text: 'Seasons around it' }));
    wrapEl.appendChild(h('table', { class: 'stats seasons' },
      h('tr', {}, h('td', { text: '' }), ...SEASON_NAMES.map((s) => h('td', { text: s }))),
      h('tr', {}, h('td', { text: 'Comfortable' }), ...seasons.map((x) => h('td', { text: x ? `${x.comfort.toFixed(0)} %` : '–' }))),
      h('tr', {}, h('td', { text: 'Heat stress' }), ...seasons.map((x) => h('td', { text: x ? `${x.heat} h` : '–' }))),
      h('tr', {}, h('td', { text: 'Cold stress' }), ...seasons.map((x) => h('td', { text: x ? `${x.cold} h` : '–' }))),
      h('tr', {}, h('td', { text: 'Wind' }), ...seasons.map((x) => h('td', { text: x ? `${x.wind.toFixed(1)} m/s` : '–' })))));
  }
  const rose = buildingRose(app, layer, f);
  if (rose) {
    wrapEl.appendChild(h('div', { class: 'insp-sub', text: 'Wind around it' }));
    const cv = h('canvas', { class: 'rose', width: 220, height: 220 });
    const note = h('div', { class: 'muted small' });
    const show = (season) => {
      const r2 = buildingRose(app, layer, f, season) || rose;
      const ctx = cv.getContext('2d');
      ctx.clearRect(0, 0, 220, 220);
      drawRose(ctx, r2, 110, 110, 92);
      note.textContent = `Petal length: how often the wind blows from there; colour: the sheltered pedestrian speed beside this building (blue calm, red strong). Calm ${(r2.calm * 100).toFixed(0)} %.`;
      chips.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', (i === 0 && season === null) || i - 1 === season));
    };
    const chips = h('div', { class: 'btn-row chips' }, button('Year', () => show(null)), ...SEASON_NAMES.map((s, i) => button(s, () => show(i))));
    wrapEl.appendChild(h('div', { class: 'rose-wrap' }, app.climateRoses?.bySeason ? chips : null, cv, note));
    show(null);
  }
  if (info.optimisation) {
    const o = info.optimisation;
    wrapEl.appendChild(h('div', { class: 'insp-sub', text: 'Optimisation (applied design)' }));
    wrapEl.appendChild(h('table', { class: 'stats' },
      h('tr', {}, h('td', { text: 'Floors' }), h('td', { text: `${o.floorsNow} → ${o.floorsDesign}` })),
      h('tr', {}, h('td', { text: 'Floor area change' }), h('td', { text: `${sign(o.gfaChange)}${Math.round(o.gfaChange).toLocaleString('en-US')} m²` })),
      h('tr', {}, h('td', { text: `Sun on open ground (${o.targets} buildings)` }), h('td', { text: `${o.groundSunNow.toFixed(2)} → ${o.groundSunDesign.toFixed(2)} h` }))));
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
  if (info.scenario.length && y < PH - margin - 80) {
    table('Scenario impact (B − A)', info.scenario.map((s) => [s.label, `${fmtOr(s.a, s.unit)} → ${fmtOr(s.b, s.unit)} (${sign(s.delta)}${fmt(s.delta, s.unit)})`]));
  }
  const rose = buildingRose(app, layer, f);
  if (rose && y < PH - margin - 120) {
    page.text(x, y, 'Wind around it (year)', { size: 10, bold: true, color: ink });
    const R = 42, cx = x + 50, cy = y + 56;
    const maxF = Math.max(...rose.petals.map((p) => p.freq), 0.01);
    const width = (2 * Math.PI) / rose.sectors;
    rose.petals.forEach((p, k) => {
      if (!p.freq) return;
      const a = (k * 2 * Math.PI) / rose.sectors - Math.PI / 2;
      const r = (R * p.freq) / maxF;
      const pts = [[cx, cy]];
      for (let t = 0; t <= 6; t++) {
        const ang = a - width / 2 + 0.03 + ((width - 0.06) * t) / 6;
        pts.push([cx + Math.cos(ang) * r, cy + Math.sin(ang) * r]);
      }
      page.polygon(pts, { fill: roseColor(p.speed) });
    });
    page.text(cx - 3, cy - R - 4, 'N', { size: 8, color: muted });
    let ly = y + 22;
    for (const line of wrap(`Petals: how often the wind comes from there. Colour: sheltered pedestrian speed here, blue calm to red ${ROSE_MAX_SPEED} m/s. Calm ${(rose.calm * 100).toFixed(0)} %.`, 7.5, side - 110)) {
      page.text(x + 110, ly, line, { size: 7.5, color: muted });
      ly += 10;
    }
    y += 2 * R + 30;
  }
  const seasonsPdf = buildingSeasons(app, layer, f);
  if (seasonsPdf && y < PH - margin - 90) {
    page.text(x, y, 'Seasons around it', { size: 10, bold: true, color: ink });
    y += 14;
    const colW = (side - 70) / 4;
    SEASON_NAMES.forEach((s, i) => page.text(x + 70 + colW * i, y, s, { size: 7.5, color: muted }));
    const rows2 = [['Comfortable', (v) => `${v.comfort.toFixed(0)} %`], ['Heat stress', (v) => `${v.heat} h`],
      ['Cold stress', (v) => `${v.cold} h`], ['Wind', (v) => `${v.wind.toFixed(1)} m/s`]];
    for (const [label2, fmt2] of rows2) {
      y += 12;
      page.text(x, y, label2, { size: 8, color: muted });
      seasonsPdf.forEach((v, i) => page.text(x + 70 + colW * i, y, v ? fmt2(v) : '–', { size: 8, color: ink }));
    }
    y += 18;
  }
  if (info.optimisation && y < PH - margin - 80) {
    const o = info.optimisation;
    table('Optimisation (applied design)', [['Floors', `${o.floorsNow} → ${o.floorsDesign}`],
      ['Floor area change', `${sign(o.gfaChange)}${Math.round(o.gfaChange)} m²`],
      ['Sun on open ground', `${o.groundSunNow.toFixed(2)} → ${o.groundSunDesign.toFixed(2)} h`]]);
  }
  if (y < PH - margin - 80) table('Attributes', info.attributes.slice(0, Math.floor((PH - margin - 40 - y) / 13) - 1));
  page.line(margin, PH - margin - 8, PW - margin, PH - margin - 8, { color: [0.85, 0.86, 0.88] });
  page.text(margin, PH - margin + 4, `${app.manifest.crs.authid} · 02 Geo3D Analyzer`, { size: 7.5, color: muted });
  page.text(PW - margin - 110, PH - margin + 4, new Date().toISOString().slice(0, 16).replace('T', ' '), { size: 7.5, color: muted });
  const blob = new Blob([page.build({ title: `Building report: ${info.name}` })], { type: 'application/pdf' });
  return { blob, name: info.name };
}

function sign(v) { return v > 0 ? '+' : ''; }

/** Wind rose of one building (season: null for the year, or 0-3): EPW sector frequencies, speeds scaled by its shelter. */
export function buildingRose(app, layer, f, season = null) {
  const c = app.climateRoses;
  const ratios = c?.ratios.get(featureKey(layer.index, f + 1));
  if (!ratios) return null;
  const src = season === null || !c.bySeason ? c : c.bySeason[season];
  return { sectors: c.sectors, calm: src.calm, petals: src.freq.map((fr, k) => ({ freq: fr, speed: src.speed[k] * ratios[k] * OPEN_PEDESTRIAN_FACTOR })) };
}

/** Per-season comfort, heat, cold and wind around one building, or null. */
export function buildingSeasons(app, layer, f) {
  return app.climateSeasonal?.get(featureKey(layer.index, f + 1)) || null;
}

const SEASON_NAMES = ['Winter', 'Spring', 'Summer', 'Autumn'];

const ROSE_MAX_SPEED = 8;
function roseColor(speed) {
  const c = rampColor(rampStops('spectral-r'), Math.min(1, speed / ROSE_MAX_SPEED), [0, 0, 0]);
  return c;
}

/** Draw a rose on a 2D canvas, petals pointing to where the wind comes from. */
export function drawRose(ctx, rose, cx, cy, R) {
  const maxF = Math.max(...rose.petals.map((p) => p.freq), 0.01);
  ctx.strokeStyle = 'rgba(120,130,140,0.35)';
  for (const q of [0.5, 1]) { ctx.beginPath(); ctx.arc(cx, cy, R * q, 0, 2 * Math.PI); ctx.stroke(); }
  const width = (2 * Math.PI) / rose.sectors;
  rose.petals.forEach((p, k) => {
    if (!p.freq) return;
    const a = (k * 360) / rose.sectors * (Math.PI / 180) - Math.PI / 2;
    const r = (R * p.freq) / maxF;
    const c = roseColor(p.speed);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, a - width / 2 + 0.03, a + width / 2 - 0.03);
    ctx.closePath();
    ctx.fillStyle = `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`;
    ctx.fill();
  });
  ctx.fillStyle = '#4a5260';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('N', cx, cy - R - 4);
  ctx.textAlign = 'left';
}
function fmtOr(v, unit) { return Number.isFinite(v) ? fmt(v, unit) : '–'; }

export { THREE };
