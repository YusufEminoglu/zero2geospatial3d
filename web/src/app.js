// @ts-check
// Application state and the glue between scene, analyses and panels.
import * as THREE from 'three';
import { Viewer } from './scene/viewer.js';
import { Terrain } from './scene/terrain.js';
import { createLayer, splitKey, ExtrudedLayer, SurfaceLayer } from './scene/objects.js';
import { showOverlay, hideOverlay, setOverlayOpacity } from './scene/overlay.js';
import { Analyst } from './analysis/runners.js';
import { solarPosition, sunVector } from './core/solar.js';
import { parseEpw, typicalDoy } from './core/weather.js';
import { makeGrid, gridStats, slopeAspect } from './core/terrain_math.js';
import { rampStops, rampColor, fmt } from './core/classify.js';
import { applyRule, defaultRule } from './ui/colorize.js';
import { Tools } from './ui/tools.js';
import { h, clear, toast } from './ui/dom.js';
import { qgisOnline, qgisSelection, selectInQgis } from './ui/qgis_link.js';

export class App {
  constructor() {
    this.viewer = new Viewer(/** @type {HTMLElement} */ (document.getElementById('view')));
    this.manifest = null;
    this.terrain = null;
    this.layers = [];
    this.rules = new Map();            // layer -> { color, height }
    this.selection = new Map();        // layer -> Set(feature index)
    this.results = [];
    this.activeResult = null;
    this.weather = null;
    this.site = { lat: 0, lon: 0, utcOffset: 0 };
    const now = new Date();
    this.date = { month: now.getMonth() + 1, day: Math.min(28, now.getDate()) };
    this.time = 12;
    this.analysisArea = { mode: 'scene', rect: null, radius: 400 };
    this.cellSize = 0;                 // 0 = automatic
    this.busy = false;
    this.listeners = new Set();
    this.qgis = false;
    this.syncSelection = true;
    this._selSeq = -1;
    this.facadeMesh = null;
    this.markers = new THREE.Group();
    this.viewer.helpers.add(this.markers);
  }

  on(fn) { this.listeners.add(fn); }
  emit(what) { for (const fn of this.listeners) fn(what); }

  // ------------------------------------------------------------ loading
  async load(sceneUrl) {
    this.status('Loading scene …');
    const base = sceneUrl.slice(0, sceneUrl.lastIndexOf('/') + 1);
    const res = await fetch(sceneUrl, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Scene not found (${res.status}). Export it from QGIS with "Open in 3D".`);
    const m = await res.json();
    this.manifest = m;
    this.base = base;
    this.site = { lat: m.geo.lat, lon: m.geo.lon, utcOffset: m.geo.utcOffset };
    const g = m.grid;
    let values = new Float32Array(g.cols * g.rows);
    if (m.terrain) {
      this.status('Loading terrain …');
      const buf = await (await fetch(base + m.terrain.file)).arrayBuffer();
      values = new Float32Array(buf);
      if (values.length !== g.cols * g.rows) throw new Error('terrain.bin does not match the grid in scene.json');
    }
    this.terrain = new Terrain(this.viewer, makeGrid(g.cols, g.rows, g.cell, g.minX, g.maxY, values));
    let index = 0;
    for (const entry of m.layers) {
      index++;
      this.status(`Loading ${entry.name} (${entry.count.toLocaleString('en-US')}) …`);
      await new Promise((r) => setTimeout(r, 0));
      const data = await (await fetch(base + entry.file)).json();
      const layer = createLayer(this, entry, index, data);
      if (!layer) continue;
      this.layers.push(layer);
      this.viewer.world.add(layer.group);
      this.rules.set(layer, { color: defaultRule(), height: { mode: 'source', field: '', factor: 1, value: 10 } });
      if (entry.scenario === 'B') layer.setVisible(false);
    }
    if (m.weather) {
      try {
        const text = await (await fetch(base + m.weather.file)).text();
        this.setWeather(parseEpw(text), m.weather.source);
      } catch (e) {
        toast(`Weather file not usable: ${e.message}`, 'warn');
      }
    }
    const box = new THREE.Box3().setFromObject(this.viewer.world);
    this.viewer.frame(box);
    this.updateSun();
    this.qgis = await qgisOnline();
    if (this.qgis) setInterval(() => this.pollSelection(), 1500);
    this.tools = new Tools(this);
    this.analyst = new Analyst(this);
    this.status(`Ready · ${this.layers.reduce((s, l) => s + l.count, 0).toLocaleString('en-US')} features`);
    this.emit('loaded');
  }

  setWeather(w, source = '') {
    this.weather = w;
    if (w?.location && Number.isFinite(w.location.utcOffset)) this.site.utcOffset = w.location.utcOffset;
    this.weatherSource = source || w?.location?.city || 'EPW';
    this.updateSun();
    this.emit('weather');
  }

  // ------------------------------------------------------------ sun
  sunPosition() {
    const doy = typicalDoy(this.date.month, this.date.day);
    return solarPosition(doy, this.time, this.site.lat, this.site.lon, this.site.utcOffset);
  }

  updateSun() {
    const p = this.sunPosition();
    this.viewer.setSun(sunVector(p.elevation, p.azimuth));
    this.emit('sun');
  }

  // ------------------------------------------------------------ status
  status(text, progress = null) {
    const el = document.getElementById('status-text');
    if (el) el.textContent = text;
    const bar = /** @type {HTMLElement|null} */ (document.getElementById('status-progress'));
    if (bar) {
      bar.hidden = progress === null;
      if (progress !== null) /** @type {HTMLElement} */ (bar.firstElementChild).style.width = `${Math.round(progress * 100)}%`;
    }
  }

  // ------------------------------------------------------------ analysis area
  sceneArea() {
    const e = this.manifest.extent;
    return { minX: e.minX, maxX: e.maxX, minY: e.minY, maxY: e.maxY };
  }

  area() {
    const scene = this.sceneArea();
    const a = this.analysisArea;
    let out = scene;
    if (a.mode === 'rect' && a.rect) out = a.rect;
    else if (a.mode === 'view') {
      const t = this.viewer.controls.target;
      out = { minX: t.x - a.radius, maxX: t.x + a.radius, minY: -t.z - a.radius, maxY: -t.z + a.radius };
    }
    return { minX: Math.max(scene.minX, out.minX), maxX: Math.min(scene.maxX, out.maxX),
      minY: Math.max(scene.minY, out.minY), maxY: Math.min(scene.maxY, out.maxY) };
  }

  cell(perSide = 1024) {
    return this.cellSize > 0 ? this.cellSize : this.analyst.defaultCell(this.area(), perSide);
  }

  showAreaOutline() {
    const a = this.area();
    this.tools.outline('analysis-area', [[a.minX, a.minY], [a.maxX, a.minY], [a.maxX, a.maxY], [a.minX, a.maxY], [a.minX, a.minY]]);
  }

  // ------------------------------------------------------------ running analyses
  async run(label, fn) {
    if (this.busy) { toast('Another analysis is running.'); return null; }
    if (this.terrain.exaggeration !== 1) {
      this.setExaggeration(1);
      toast('Vertical exaggeration reset to 1 for the analysis.');
    }
    this.busy = true;
    this.emit('busy');
    const t0 = performance.now();
    this.showAreaOutline();
    try {
      this.status(`${label} …`, 0);
      const results = await fn((f) => this.status(`${label} … ${Math.round(f * 100)} %`, f));
      for (const r of results) {
        r.id = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        r.created = new Date();
        r.seconds = (performance.now() - t0) / 1000;
        for (const f of r.fields || []) f.layer.setResultField(f.name, f.values);
      }
      this.results.unshift(...results); // keep the analysis' own order, newest run on top
      if (results.length) this.showResult(results[0]);
      this.status(`${label} done in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
      this.emit('results');
      return results;
    } catch (e) {
      console.error(e);
      this.status(`${label} failed: ${e.message}`);
      toast(`${label} failed: ${e.message}`, 'error');
      return null;
    } finally {
      this.busy = false;
      this.emit('busy');
    }
  }

  showResult(r) {
    this.activeResult = r;
    if (r?.grid) {
      showOverlay(r.grid, r.values, r.display);
    } else hideOverlay();
    this._showFacade(r?.facade && r.showFacade !== false ? r.facade : null);
    this._showMarker(r?.marker);
    this.renderLegend();
    this.viewer.requestRender();
    this.emit('active');
  }

  hideResult() {
    this.activeResult = null;
    hideOverlay();
    this._showFacade(null);
    this._showMarker(null);
    this.renderLegend();
    this.viewer.requestRender();
    this.emit('active');
  }

  setOverlayOpacity(v) {
    setOverlayOpacity(v);
    this.viewer.requestRender();
  }

  _showMarker(m) {
    for (const c of [...this.markers.children]) {
      this.markers.remove(c);
      /** @type {any} */ (c).geometry?.dispose();
    }
    if (!m) return;
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1.6, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff4f2e, depthTest: false }));
    mesh.position.set(m.x, m.y, m.z);
    mesh.renderOrder = 30;
    this.markers.add(mesh);
  }

  _showFacade(f) {
    if (this.facadeMesh) {
      this.viewer.helpers.remove(this.facadeMesh);
      this.facadeMesh.geometry.dispose();
      /** @type {any} */ (this.facadeMesh.material).dispose();
      this.facadeMesh = null;
    }
    if (!f || !f.count) return;
    const geom = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const mesh = new THREE.InstancedMesh(geom, mat, f.count);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const z = new THREE.Vector3(0, 0, 1);
    const n = new THREE.Vector3();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3(f.spacing * 0.94, f.spacing * 0.94, 1);
    const stops = rampStops(f.ramp);
    const c = [0, 0, 0];
    const col = new THREE.Color();
    for (let i = 0; i < f.count; i++) {
      n.set(f.normals[i * 3], f.normals[i * 3 + 1], f.normals[i * 3 + 2]);
      q.setFromUnitVectors(z, n);
      p.set(f.positions[i * 3], f.positions[i * 3 + 1], f.positions[i * 3 + 2]).addScaledVector(n, 0.08);
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);
      rampColor(stops, (f.values[i] - f.min) / Math.max(1e-9, f.max - f.min), c);
      col.setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
      mesh.setColorAt(i, col);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.facadeMesh = mesh;
    this.viewer.helpers.add(mesh);
  }

  /** Legend for the active result, else for the coloured layer. */
  renderLegend() {
    const el = document.getElementById('legend');
    if (!el) return;
    clear(el);
    const r = this.activeResult;
    let legend = null;
    if (r) {
      if (r.legend) legend = { title: r.title, items: r.legend };
      else if (r.display?.categorical) legend = null;
      else {
        const stops = rampStops(r.display.ramp);
        const css = stops.map((s, i) => `rgb(${s.map((x) => Math.round(x * 255)).join(',')}) ${(100 * i) / (stops.length - 1)}%`).join(',');
        el.appendChild(h('div', { class: 'legend-title', text: r.title }));
        el.appendChild(h('div', { class: 'legend-ramp', style: { background: `linear-gradient(90deg, ${css})` } }));
        el.appendChild(h('div', { class: 'legend-scale' }, h('span', { text: fmt(r.display.min, r.unit) }), h('span', { text: fmt(r.display.max, r.unit) })));
        if (r.facade) el.appendChild(h('div', { class: 'legend-note', text: 'Facades shown as coloured tiles.' }));
        el.hidden = false;
        return;
      }
    } else if (this.layerLegend) legend = this.layerLegend;
    if (!legend) { el.hidden = true; return; }
    el.appendChild(h('div', { class: 'legend-title', text: legend.title }));
    for (const it of legend.items.slice(0, 20)) {
      el.appendChild(h('div', { class: 'legend-item' }, h('span', { class: 'swatch', style: { background: it.color } }), h('span', { text: it.label })));
    }
    el.hidden = false;
  }

  // ------------------------------------------------------------ colouring
  recolor(layer) {
    const rule = this.rules.get(layer);
    const sel = this.selection.get(layer);
    const { legend } = applyRule(layer, rule.color, sel && sel.size ? sel : null);
    if (rule.color.mode !== 'source') { this.layerLegend = legend; this.renderLegend(); }
  }

  setExaggeration(ex) {
    this.terrain.setExaggeration(ex);
    for (const l of this.layers) l.updateElevation();
    if (this.activeResult?.facade) this._showFacade(null);
    this.analyst?.cache.clear();
    this.emit('exaggeration');
  }

  // ------------------------------------------------------------ picking and selection
  onClick(e) {
    const key = this.viewer.pickKey(e.clientX, e.clientY);
    if (key) {
      const { layerIndex, id } = splitKey(key);
      const layer = this.layers.find((l) => l.index === layerIndex);
      if (layer) {
        this.select(layer, [id - 1], e.shiftKey);
        this.inspect(layer, id - 1, e);
        return;
      }
    }
    const p = this.tools.groundAt(e);
    if (p) {
      for (const layer of this.layers) {
        if (layer instanceof SurfaceLayer && layer.visible) {
          const f = layer.featureAt(p.local[0], p.local[1]);
          if (f >= 0) { this.inspect(layer, f, e, p); return; }
        }
      }
      this.inspectGround(p);
    }
    if (!e.shiftKey) this.clearSelection();
  }

  select(layer, indices, add = false) {
    if (!add) this.clearSelection(layer);
    const set = this.selection.get(layer) || new Set();
    for (const i of indices) { if (add && set.has(i)) set.delete(i); else set.add(i); }
    this.selection.set(layer, set);
    this.recolor(layer);
    if (this.qgis && this.syncSelection && layer instanceof ExtrudedLayer) {
      selectInQgis(layer, [...set].map((i) => i + 1)).catch(() => {});
    }
    this.emit('selection');
  }

  clearSelection(except = null) {
    for (const [layer, set] of this.selection) {
      if (layer === except || !set.size) continue;
      set.clear();
      this.recolor(layer);
    }
    this.emit('selection');
  }

  selectedIndices(layer) {
    return [...(this.selection.get(layer) || [])];
  }

  async pollSelection() {
    if (!this.syncSelection) return;
    try {
      const sel = await qgisSelection();
      if (sel.seq === this._selSeq) return;
      this._selSeq = sel.seq;
      for (const layer of this.layers) {
        const ids = sel.layers?.[layer.entry.id];
        if (!ids) continue;
        this.selection.set(layer, new Set(ids.map((i) => i - 1)));
        this.recolor(layer);
      }
      this.emit('selection');
    } catch { /* the plugin may have closed; keep the viewer usable */ }
  }

  resultValueAt(x, y) {
    const r = this.activeResult;
    if (!r?.grid) return null;
    const g = r.grid;
    const c = Math.round((x - g.minX) / g.cell);
    const row = Math.round((g.maxY - y) / g.cell);
    if (c < 0 || row < 0 || c >= g.cols || row >= g.rows) return null;
    const v = r.values[row * g.cols + c];
    return Number.isFinite(v) ? v : null;
  }

  inspect(layer, f, e, ground = null) {
    const el = /** @type {HTMLElement} */ (document.getElementById('inspector'));
    clear(el);
    const props = layer.features[f].properties;
    const rows = [];
    for (const [k, v] of Object.entries(props)) {
      if (k.startsWith('_') || v === null || v === '') continue;
      rows.push([k, typeof v === 'number' ? fmt(v) : String(v)]);
    }
    const results = [];
    for (const [name, arr] of layer.extraFields) if (Number.isFinite(arr[f])) results.push([name, fmt(arr[f])]);
    el.appendChild(h('div', { class: 'insp-head' }, h('b', { text: layer.entry.name }), h('button', { class: 'close', text: '×', onclick: () => { el.hidden = true; } })));
    const meta = [];
    if (layer instanceof ExtrudedLayer) {
      meta.push(['Height', `${layer.heights[f].toFixed(1)} m`], ['Ground', `${layer.baseZ[f].toFixed(1)} m`]);
      if (!layer.isWall) meta.push(['Footprint', `${layer.footprint[f].toFixed(0)} m²`]);
    }
    if (ground) {
      const v = this.resultValueAt(ground.local[0], ground.local[1]);
      if (v !== null) meta.push([this.activeResult.title, fmt(v, this.activeResult.unit)]);
    }
    const tbl = (pairs) => h('table', { class: 'stats' }, ...pairs.map(([k, v]) => h('tr', {}, h('td', { text: k }), h('td', { text: v }))));
    if (meta.length) el.appendChild(tbl(meta));
    if (results.length) { el.appendChild(h('div', { class: 'insp-sub', text: 'Analysis results' })); el.appendChild(tbl(results)); }
    if (rows.length) { el.appendChild(h('div', { class: 'insp-sub', text: 'Attributes' })); el.appendChild(tbl(rows.slice(0, 60))); }
    el.hidden = false;
    void e;
  }

  inspectGround(p) {
    const el = /** @type {HTMLElement} */ (document.getElementById('inspector'));
    clear(el);
    const [x, y] = p.local;
    const z = this.terrain.heightAt(x, y);
    const g = this.terrain.grid;
    const c = Math.round((x - g.minX) / g.cell), r = Math.round((g.maxY - y) / g.cell);
    const pairs = [['Elevation', `${z.toFixed(1)} m`]];
    if (c >= 0 && r >= 0 && c < g.cols && r < g.rows && this.terrain.max - this.terrain.min > 0.5) {
      const d = this.terrain._derived();
      const i = r * g.cols + c;
      pairs.push(['Slope', `${d.slope[i].toFixed(1)}°`], ['Aspect', d.aspect[i] < 0 ? 'flat' : `${d.aspect[i].toFixed(0)}°`]);
    }
    const v = this.resultValueAt(x, y);
    if (v !== null) pairs.push([this.activeResult.title, fmt(v, this.activeResult.unit)]);
    el.appendChild(h('div', { class: 'insp-head' }, h('b', { text: 'Ground' }), h('button', { class: 'close', text: '×', onclick: () => { el.hidden = true; } })));
    el.appendChild(h('table', { class: 'stats' }, ...pairs.map(([k, val]) => h('tr', {}, h('td', { text: k }), h('td', { text: val })))));
    el.hidden = false;
  }

  terrainStats() {
    return gridStats(this.terrain.grid.values);
  }

  slopeGrid() {
    return slopeAspect(this.terrain.grid);
  }
}
