// @ts-check
// Image, PDF, GLB, interactive HTML and video exports of the current view.
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { bakeScene, toBase64 } from './snapshot.js';
import { buildGroup } from './snapshot_scene.js';
import { PdfPage, wrap } from './pdf.js';
import { fmt } from '../core/classify.js';
import { MONTH_NAMES, typicalDoy } from '../core/weather.js';
import { sunriseSunset } from '../core/solar.js';

export function fileStem(app) {
  return String(app.manifest.title || 'scene').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'scene';
}

// ---------------------------------------------------------------- map furniture
/** What the legend, north arrow and scale bar need from the current view. */
export function viewInfo(app) {
  const v = app.viewer;
  const cam = v.camera;
  const dist = cam.position.distanceTo(v.controls.target);
  const f = v.controls.target.clone().sub(cam.position);
  const heading = Math.atan2(f.x, -f.z); // clockwise from north
  const r = app.activeResult;
  let legend = null;
  if (r) {
    if (r.legend) legend = { title: r.title, items: r.legend };
    else if (!r.display?.categorical) {
      const el = document.querySelector('#legend .legend-ramp');
      legend = { title: r.title, gradient: el ? getComputedStyle(el).backgroundImage : null, min: fmt(r.display.min, r.unit), max: fmt(r.display.max, r.unit), result: r };
    }
  } else if (app.layerLegend) legend = app.layerLegend;
  const p = app.sunPosition();
  const when = `${app.date.day} ${MONTH_NAMES[app.date.month - 1]} ${String(Math.floor(app.time)).padStart(2, '0')}:${String(Math.round((app.time % 1) * 60) % 60).padStart(2, '0')} (UTC${app.site.utcOffset >= 0 ? '+' : ''}${app.site.utcOffset})`;
  return {
    title: app.manifest.title, subtitle: r ? `${r.title}${r.subtitle ? ` — ${r.subtitle}` : ''}` : `Sun ${when}`,
    legend, heading, fov: cam.fov, dist, sunUp: p.elevation > 0, when,
    attribution: attribution(app)
  };
}

function attribution(app) {
  const names = app.layers.map((l) => l.entry.name.toLowerCase()).join(' ');
  const parts = [];
  if (names.includes('osm')) parts.push('Map data © OpenStreetMap contributors');
  if (app.manifest.terrain?.source) parts.push(`Terrain: ${app.manifest.terrain.source}`);
  parts.push(`${app.manifest.crs.authid} · 02 Geo3D Analyzer`);
  return parts.join(' · ');
}

function niceLength(m) {
  const p = Math.pow(10, Math.floor(Math.log10(m)));
  for (const k of [5, 2, 1]) if (k * p <= m) return k * p;
  return p;
}

/** Draw title, legend, north arrow, scale bar and attribution on a 2D canvas. */
export function drawFurniture(ctx, w, h, info, { title = true, legend = true, north = true, scale = true, credits = true } = {}) {
  const u = Math.max(1, Math.min(w, h) / 900); // scale with the output size
  const pad = 18 * u;
  ctx.save();
  ctx.textBaseline = 'top';
  const box = (x, y, bw, bh) => {
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.strokeStyle = 'rgba(30,40,55,0.18)';
    ctx.lineWidth = 1 * u;
    ctx.beginPath();
    ctx.roundRect(x, y, bw, bh, 8 * u);
    ctx.fill();
    ctx.stroke();
  };
  if (title && info.title) {
    ctx.font = `600 ${22 * u}px system-ui, sans-serif`;
    const tw = ctx.measureText(info.title).width;
    ctx.font = `${14 * u}px system-ui, sans-serif`;
    const sw = info.subtitle ? ctx.measureText(info.subtitle).width : 0;
    box(pad, pad, Math.max(tw, sw) + 24 * u, (info.subtitle ? 58 : 38) * u);
    ctx.fillStyle = '#1d2430';
    ctx.font = `600 ${22 * u}px system-ui, sans-serif`;
    ctx.fillText(info.title, pad + 12 * u, pad + 9 * u);
    if (info.subtitle) {
      ctx.font = `${14 * u}px system-ui, sans-serif`;
      ctx.fillStyle = '#4a5260';
      ctx.fillText(info.subtitle, pad + 12 * u, pad + 36 * u);
    }
  }
  if (legend && info.legend) {
    const L = info.legend;
    ctx.font = `${13 * u}px system-ui, sans-serif`;
    const items = L.items || [];
    const bw = 260 * u;
    const bh = (L.items ? 34 + items.slice(0, 14).length * 20 : 70) * u;
    const x = pad, y = h - pad - bh - (credits ? 22 * u : 0);
    box(x, y, bw, bh);
    ctx.fillStyle = '#1d2430';
    ctx.font = `600 ${13 * u}px system-ui, sans-serif`;
    ctx.fillText(clip(ctx, L.title, bw - 24 * u), x + 12 * u, y + 10 * u);
    ctx.font = `${12 * u}px system-ui, sans-serif`;
    if (L.items) {
      items.slice(0, 14).forEach((it, i) => {
        ctx.fillStyle = it.color;
        ctx.fillRect(x + 12 * u, y + (32 + i * 20) * u, 14 * u, 14 * u);
        ctx.fillStyle = '#333a45';
        ctx.fillText(clip(ctx, it.label, bw - 50 * u), x + 34 * u, y + (32 + i * 20) * u);
      });
    } else if (L.result) {
      const grad = ctx.createLinearGradient(x + 12 * u, 0, x + bw - 12 * u, 0);
      const stops = L.stops || ['#888888', '#dddddd'];
      stops.forEach((c, i) => grad.addColorStop(i / (stops.length - 1), c));
      ctx.fillStyle = grad;
      ctx.fillRect(x + 12 * u, y + 32 * u, bw - 24 * u, 12 * u);
      ctx.fillStyle = '#4a5260';
      ctx.fillText(L.min, x + 12 * u, y + 50 * u);
      const mw = ctx.measureText(L.max).width;
      ctx.fillText(L.max, x + bw - 12 * u - mw, y + 50 * u);
    }
  }
  if (north) {
    const cx = w - pad - 26 * u, cy = pad + 30 * u;
    ctx.beginPath();
    ctx.arc(cx, cy, 24 * u, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fill();
    ctx.translate(cx, cy);
    ctx.rotate(-info.heading);
    ctx.beginPath();
    ctx.moveTo(0, -18 * u); ctx.lineTo(8 * u, 8 * u); ctx.lineTo(0, 3 * u); ctx.lineTo(-8 * u, 8 * u); ctx.closePath();
    ctx.fillStyle = '#1d2430';
    ctx.fill();
    ctx.font = `600 ${11 * u}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('N', 0, -32 * u);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.textAlign = 'left';
  }
  if (scale) {
    const mPerPx = (2 * info.dist * Math.tan((info.fov * Math.PI) / 360)) / (info.panelH || h);
    const len = niceLength(mPerPx * (info.panelW || w) * 0.16);
    const px = len / mPerPx;
    ctx.font = `${10 * u}px system-ui, sans-serif`;
    const noteW = ctx.measureText('at the view centre').width;
    const x = w - pad - Math.max(px, noteW), y = h - pad - (credits ? 40 : 18) * u;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(x - 8 * u, y - 18 * u, Math.max(px, noteW) + 16 * u, 30 * u);
    ctx.fillStyle = '#1d2430';
    ctx.fillRect(x, y, px, 4 * u);
    ctx.fillRect(x, y - 4 * u, 2 * u, 8 * u);
    ctx.fillRect(x + px - 2 * u, y - 4 * u, 2 * u, 8 * u);
    ctx.font = `${12 * u}px system-ui, sans-serif`;
    ctx.fillText(len >= 1000 ? `${len / 1000} km` : `${len} m`, x, y - 16 * u);
    ctx.fillStyle = '#6b7380';
    ctx.font = `${10 * u}px system-ui, sans-serif`;
    ctx.fillText('at the view centre', x, y + 7 * u);
  }
  if (credits) {
    ctx.font = `${11 * u}px system-ui, sans-serif`;
    const tw = ctx.measureText(info.attribution).width;
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillRect(w - tw - 16 * u, h - 20 * u, tw + 16 * u, 20 * u);
    ctx.fillStyle = '#4a5260';
    ctx.fillText(info.attribution, w - tw - 8 * u, h - 16 * u);
  }
  ctx.restore();
}

function clip(ctx, text, max) {
  let t = String(text ?? '');
  while (t.length > 3 && ctx.measureText(t).width > max) t = `${t.slice(0, -2)}…`;
  return t;
}

// ---------------------------------------------------------------- image
/**
 * Render the current view at a target size and return a canvas with the
 * map furniture drawn on top.
 */
export function renderImage(app, { width = 0, height = 0, furniture = {} } = {}) {
  const v = app.viewer;
  const r = v.renderer;
  const cam = v.camera;
  const canvas = r.domElement;
  const oldW = canvas.clientWidth, oldH = canvas.clientHeight;
  const oldRatio = r.getPixelRatio();
  const w = Math.round(width || oldW * oldRatio);
  const h = Math.round(height || oldH * oldRatio);
  const maxSide = r.capabilities.maxTextureSize || 8192;
  const k = Math.min(1, maxSide / Math.max(w, h));
  const W = Math.round(w * k), H = Math.round(h * k);
  r.setPixelRatio(1);
  r.setSize(W, H, false);
  cam.aspect = W / H;
  cam.updateProjectionMatrix();
  v._fitClipping();
  v._fitShadow();
  v.draw(); // compare views draw their panels
  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const ctx = /** @type {CanvasRenderingContext2D} */ (out.getContext('2d'));
  ctx.drawImage(canvas, 0, 0);
  // Restore the live view.
  r.setPixelRatio(oldRatio);
  r.setSize(oldW, oldH, false);
  cam.aspect = oldW / oldH;
  cam.updateProjectionMatrix();
  v.requestRender();
  const info = viewInfo(app);
  if (info.legend?.result) info.legend.stops = rampStops(app);
  const cmp = app.compare?.mode ? app.compare : null;
  if (cmp) {
    // Each panel carries its own caption and legend; the scene title moves
    // into the credits line so it does not cover the first panel's caption.
    const ps = cmp.panelSize(W, H);
    info.panelW = ps.w;
    info.panelH = ps.h;
    if (furniture.title !== false && info.title) info.attribution = `${info.title} · ${info.attribution}`;
    const u = Math.max(1, Math.min(W, H) / 900);
    cmp.drawOverlay(ctx, W, H, { legends: furniture.legend !== false, reserveRight: furniture.north !== false ? 70 * u : 0,
      reserveBottom: furniture.credits !== false ? 20 * u : 0, reserveCorner: furniture.scale !== false ? 46 * u : 0 });
    drawFurniture(ctx, W, H, info, { ...furniture, title: false, legend: false });
  } else {
    drawFurniture(ctx, W, H, info, furniture);
  }
  return out;
}

function rampStops(app) {
  const el = document.querySelector('#legend .legend-ramp');
  if (!el) return undefined;
  const m = getComputedStyle(el).backgroundImage.match(/rgb\([^)]+\)/g);
  return m || undefined;
}

export function canvasBlob(canvas, type = 'image/png', quality = 0.92) {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, quality));
}

// ---------------------------------------------------------------- PDF
const PAPER = { a4: [842, 595], a3: [1191, 842] };

export async function exportPdf(app, { paper = 'a4', title = '' } = {}) {
  const [PW, PH] = PAPER[paper] || PAPER.a4;
  const margin = 28;
  const side = 230;
  const imgW = PW - margin * 3 - side;
  const imgH = PH - margin * 2 - 64;
  const scale = 2.2; // pixels per point for a sharp print
  const canvas = renderImage(app, { width: Math.round(imgW * scale), height: Math.round(imgH * scale),
    furniture: { title: false, legend: false, north: true, scale: true, credits: false } });
  const jpegUrl = canvas.toDataURL('image/jpeg', 0.9);
  const bytes = Uint8Array.from(atob(jpegUrl.split(',')[1]), (c) => c.charCodeAt(0));
  const info = viewInfo(app);
  const page = new PdfPage(PW, PH);
  const ink = [0.11, 0.14, 0.19];
  const muted = [0.42, 0.45, 0.5];
  page.text(margin, margin + 18, title || info.title, { size: 18, bold: true, color: ink });
  page.text(margin, margin + 36, info.subtitle, { size: 10, color: muted });
  page.jpeg(bytes, canvas.width, canvas.height, margin, margin + 50, imgW, imgH);
  page.rect(margin, margin + 50, imgW, imgH, { stroke: [0.8, 0.82, 0.85] });
  // Side column: legend, statistics, notes.
  let x = margin * 2 + imgW, y = margin + 64;
  const L = info.legend;
  if (L) {
    page.text(x, y, L.title, { size: 10, bold: true, color: ink });
    y += 10;
    if (L.items) {
      for (const it of L.items.slice(0, 16)) {
        page.rect(x, y, 10, 10, { fill: hexRgb(it.color) });
        page.text(x + 16, y + 9, it.label, { size: 8.5, color: ink });
        y += 14;
      }
    } else if (L.result) {
      const stops = (rampStops(app) || []).map(parseRgb);
      const n = 40;
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const k = t * (stops.length - 1);
        const a = stops[Math.floor(k)] || [0, 0, 0], b = stops[Math.min(stops.length - 1, Math.floor(k) + 1)] || a;
        const f = k - Math.floor(k);
        page.rect(x + (side / n) * i, y, side / n + 0.3, 10, { fill: a.map((v, j) => v + (b[j] - v) * f) });
      }
      y += 22;
      page.text(x, y, L.min, { size: 8.5, color: muted });
      page.text(x + side - 60, y, L.max, { size: 8.5, color: muted });
      y += 6;
    }
    y += 14;
  }
  const r = app.activeResult;
  if (r?.stats?.length) {
    page.text(x, y, 'Results', { size: 10, bold: true, color: ink });
    y += 6;
    for (const [k, val] of r.stats.slice(0, 14)) {
      y += 13;
      page.text(x, y, k, { size: 8.5, color: muted });
      page.text(x + side - Math.min(side * 0.45, 7 + String(val).length * 4.6), y, val, { size: 8.5, color: ink });
      page.line(x, y + 3, x + side, y + 3, { color: [0.88, 0.89, 0.91], width: 0.4 });
    }
    y += 18;
  }
  if (r?.notes) {
    for (const line of wrap(r.notes, 8, side).slice(0, 12)) { page.text(x, y, line, { size: 8, color: muted }); y += 10.5; }
    y += 8;
  }
  const s = app.site;
  const doy = typicalDoy(app.date.month, app.date.day);
  const { sunrise, sunset } = sunriseSunset(doy, s.lat, s.lon, s.utcOffset);
  const facts = [['View lit', info.when], ['Daylight', sunrise !== null ? `${hm(sunrise)} – ${hm(sunset)}` : '–'],
    ['Centre', `${s.lat.toFixed(4)}°, ${s.lon.toFixed(4)}°`], ['CRS', app.manifest.crs.authid]];
  for (const [k, val] of facts) {
    if (y > PH - margin - 30) break;
    page.text(x, y, k, { size: 8, color: muted });
    page.text(x + 52, y, val, { size: 8, color: ink });
    y += 11;
  }
  page.line(margin, PH - margin - 8, PW - margin, PH - margin - 8, { color: [0.85, 0.86, 0.88] });
  page.text(margin, PH - margin + 4, info.attribution, { size: 7.5, color: muted });
  page.text(PW - margin - 110, PH - margin + 4, new Date().toISOString().slice(0, 16).replace('T', ' '), { size: 7.5, color: muted });
  return new Blob([page.build({ title: title || info.title, author: '' })], { type: 'application/pdf' });
}

function hm(h) { return `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60) % 60).padStart(2, '0')}`; }
function hexRgb(hex) { const n = parseInt(String(hex).slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; }
function parseRgb(s) { const m = String(s).match(/\d+(\.\d+)?/g) || ['0', '0', '0']; return m.slice(0, 3).map((v) => Number(v) / 255); }

// ---------------------------------------------------------------- GLB
export async function exportGlb(app, { area = null } = {}) {
  const snap = bakeScene(app, { area });
  const group = await buildGroup(THREE, snap);
  const exporter = new GLTFExporter();
  const buffer = await new Promise((resolve, reject) => exporter.parse(group, resolve, reject, { binary: true }));
  return new Blob([buffer], { type: 'model/gltf-binary' });
}

// ---------------------------------------------------------------- interactive HTML
function encodeSnapshot(snap) {
  return JSON.stringify(snap, (k, v) => (ArrayBuffer.isView(v) ? { __ta: v.constructor.name, b64: toBase64(v) } : v));
}

function dataModule(text) {
  const bytes = new TextEncoder().encode(text);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  return `data:text/javascript;base64,${btoa(s)}`;
}

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

export async function exportHtml(app, { area = null } = {}) {
  const snap = bakeScene(app, { area });
  const [three, orbit, builder] = await Promise.all([
    fetch('vendor/three/three.module.js').then((r) => r.text()),
    fetch('vendor/three/addons/controls/OrbitControls.js').then((r) => r.text()),
    fetch('src/export/snapshot_scene.js').then((r) => r.text())
  ]);
  const info = viewInfo(app);
  const stops = rampStops(app);
  let legend = '';
  if (info.legend?.items) {
    legend = `<b>${esc(info.legend.title)}</b>${info.legend.items.slice(0, 16).map((i) => `<div class="li"><i style="background:${esc(i.color)}"></i>${esc(i.label)}</div>`).join('')}`;
  } else if (info.legend?.result && stops) {
    legend = `<b>${esc(info.legend.title)}</b><div class="ramp" style="background:linear-gradient(90deg,${stops.join(',')})"></div><div class="sc"><span>${esc(info.legend.min)}</span><span>${esc(info.legend.max)}</span></div>`;
  }
  const importMap = { imports: { three: dataModule(three), 'three/addons/controls/OrbitControls.js': dataModule(orbit), 'g3d/scene': dataModule(builder) } };
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(info.title)}</title>
<style>
html,body{margin:0;height:100%;overflow:hidden;font:13px system-ui,sans-serif;color:#1d2430;background:#dfe8f0}
#c{position:fixed;inset:0}
.card{position:fixed;background:rgba(255,255,255,.93);border:1px solid #e2e5ea;border-radius:8px;padding:10px 12px;box-shadow:0 4px 18px rgba(20,30,50,.12)}
#t{left:12px;top:12px;max-width:60vw}#t h1{font-size:17px;margin:0 0 3px}#t p{margin:0;color:#4a5260}
#l{left:12px;bottom:34px;min-width:200px;max-width:280px}.li{display:flex;gap:8px;align-items:center;margin-top:4px}.li i{width:13px;height:13px;border-radius:3px;display:inline-block}
.ramp{height:12px;border-radius:3px;margin-top:6px}.sc{display:flex;justify-content:space-between;color:#687384;font-size:11px;margin-top:3px}
#a{position:fixed;right:8px;bottom:6px;color:#4a5260;font-size:11px;background:rgba(255,255,255,.8);padding:2px 6px;border-radius:4px}
#h{position:fixed;left:50%;bottom:6px;transform:translateX(-50%);color:#4a5260;font-size:11px}
</style>
<script type="importmap">${JSON.stringify(importMap)}</script>
</head><body>
<canvas id="c"></canvas>
<div id="t" class="card"><h1>${esc(info.title)}</h1><p>${esc(info.subtitle)}</p></div>
${legend ? `<div id="l" class="card">${legend}</div>` : ''}
<div id="h">Drag to orbit · right-drag to pan · wheel to zoom</div>
<div id="a">${esc(info.attribution)}</div>
<script type="application/json" id="snap">${encodeSnapshot(snap).replace(/</g, '\\u003c')}</script>
<script type="module">
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildGroup, decodeSnapshot } from 'g3d/scene';
const snap = decodeSnapshot(document.getElementById('snap').textContent);
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xdfe8f0);
const camera = new THREE.PerspectiveCamera(snap.camera.fov, 1, 0.5, 200000);
camera.position.fromArray(snap.camera.position);
const controls = new OrbitControls(camera, canvas);
controls.target.fromArray(snap.camera.target);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.495;
scene.add(new THREE.HemisphereLight(0xeaf2ff, 0x8a8174, 1.2));
const sun = new THREE.DirectionalLight(0xfff4e0, 2.4);
const dir = new THREE.Vector3().fromArray(snap.sun).normalize();
sun.castShadow = dir.y > 0;
sun.visible = dir.y > 0;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.bias = -0.0004;
scene.add(sun, sun.target);
const group = await buildGroup(THREE, snap);
scene.add(group);
const box = new THREE.Box3().setFromObject(group);
const radius = box.getSize(new THREE.Vector3()).length() / 2;
function fitShadow() {
  const r = Math.max(150, Math.min(radius, camera.position.distanceTo(controls.target) * 1.2));
  const sc = sun.shadow.camera;
  sc.left = -r; sc.right = r; sc.top = r; sc.bottom = -r; sc.near = 1; sc.far = 4 * r + 2000;
  sc.updateProjectionMatrix();
  sun.position.copy(controls.target).addScaledVector(dir, 2 * r + 800);
  sun.target.position.copy(controls.target);
  sun.shadow.normalBias = Math.max(0.03, (2 * r) / 4096 * 0.8);
}
function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();
let dirty = true;
controls.addEventListener('change', () => { dirty = true; });
renderer.setAnimationLoop(() => {
  const moved = controls.update();
  if (!dirty && !moved) return;
  dirty = false;
  const d = camera.position.distanceTo(controls.target);
  camera.near = Math.max(0.2, Math.min(50, d / 1500));
  camera.far = Math.max(d * 40, radius * 6, 5000);
  camera.updateProjectionMatrix();
  fitShadow();
  renderer.render(scene, camera);
});
</script>
</body></html>`;
  return new Blob([html], { type: 'text/html' });
}

// ---------------------------------------------------------------- video
const VIDEO_TYPES = ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

export function videoType() {
  if (typeof MediaRecorder === 'undefined') return null;
  return VIDEO_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) || null;
}

/**
 * Record the canvas. mode: 'orbit' (one turn around the view centre),
 * 'day' (sunrise to sunset) or 'free' (until stop()).
 */
export class Recorder {
  constructor(app) {
    this.app = app;
    this.active = false;
  }

  async start({ mode = 'orbit', seconds = 12, fps = 30, width = 0, height = 0, onTick = null } = {}) {
    const app = this.app;
    const v = app.viewer;
    const r = v.renderer;
    const type = videoType();
    if (!type) throw new Error('This browser cannot record video (MediaRecorder unavailable).');
    const canvas = r.domElement;
    this.saved = { w: canvas.clientWidth, h: canvas.clientHeight, ratio: r.getPixelRatio(), time: app.time,
      pos: v.camera.position.clone(), target: v.controls.target.clone() };
    if (width && height) {
      r.setPixelRatio(1);
      r.setSize(width, height, false);
      v.camera.aspect = width / height;
      v.camera.updateProjectionMatrix();
    }
    // Compare views: the panel captions and legends are page elements, not
    // part of the 3D canvas, so frames are composited on a 2D canvas.
    let source = canvas;
    this.unhook = null;
    const cmp = app.compare?.mode ? app.compare : null;
    if (cmp) {
      const comp = document.createElement('canvas');
      comp.width = canvas.width;
      comp.height = canvas.height;
      const ctx = /** @type {CanvasRenderingContext2D} */ (comp.getContext('2d'));
      const paint = () => {
        if (comp.width !== canvas.width || comp.height !== canvas.height) { comp.width = canvas.width; comp.height = canvas.height; }
        ctx.drawImage(canvas, 0, 0);
        cmp.drawOverlay(ctx, comp.width, comp.height);
      };
      paint();
      this.unhook = v.onPostRender(paint);
      source = comp;
    }
    const stream = source.captureStream(fps);
    const bits = (width || canvas.width) * (height || canvas.height) * fps * 0.12;
    this.rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: Math.round(Math.min(40e6, Math.max(6e6, bits))) });
    this.chunks = [];
    this.rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.type = type;
    this.active = true;
    const done = new Promise((resolve) => { this.rec.onstop = () => resolve(new Blob(this.chunks, { type: type.split(';')[0] })); });
    this.rec.start(250);
    const t0 = performance.now();
    const start = { offset: v.camera.position.clone().sub(v.controls.target) };
    let dayFrom = 0, dayTo = 24;
    if (mode === 'day') {
      const s = app.site;
      const { sunrise, sunset } = sunriseSunset(typicalDoy(app.date.month, app.date.day), s.lat, s.lon, s.utcOffset);
      dayFrom = sunrise ?? 5; dayTo = sunset ?? 20;
    }
    const tick = () => {
      if (!this.active) return;
      const f = (performance.now() - t0) / (seconds * 1000);
      if (mode !== 'free' && f >= 1) { this.stop(); return; }
      if (mode === 'orbit') {
        const p = start.offset.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), f * Math.PI * 2);
        v.camera.position.copy(v.controls.target).add(p);
        v.camera.lookAt(v.controls.target);
      } else if (mode === 'day') {
        app.time = dayFrom + (dayTo - dayFrom) * f;
        app.updateSun();
      }
      v.requestRender();
      onTick?.(mode === 'free' ? (performance.now() - t0) / 1000 : f);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return done;
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.rec.stop();
    this.unhook?.();
    this.unhook = null;
    const v = this.app.viewer;
    const r = v.renderer;
    const s = this.saved;
    r.setPixelRatio(s.ratio);
    r.setSize(s.w, s.h, false);
    v.camera.aspect = s.w / s.h;
    v.camera.updateProjectionMatrix();
    v.requestRender();
  }
}
