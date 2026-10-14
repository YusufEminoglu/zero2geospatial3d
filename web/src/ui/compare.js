// @ts-check
// Compare views: a swipe between two states, or 2, 4, 6 or 8 synced panels.
// Every panel shares the one camera; before drawing a panel its state is
// applied (analysis drape and facade tiles, scenario A or B), so panels cost
// one render each and nothing is duplicated in memory.
import * as THREE from 'three';
import { h, clear } from './dom.js';
import { resultTexture, useOverlay, hideOverlay } from '../scene/overlay.js';
import { rampStops } from '../core/classify.js';
import { fmt } from '../core/classify.js';

const LAYOUTS = { 2: [2, 1], 4: [2, 2], 6: [3, 2], 8: [4, 2] };

export class Compare {
  constructor(app) {
    this.app = app;
    this.mode = null;      // null | 'swipe' | 2 | 4 | 6 | 8
    this.states = [];
    this.split = 0.5;
    this.layer = h('div', { class: 'compare-layer', hidden: true });
    /** @type {HTMLElement} */ (document.getElementById('view')).appendChild(this.layer);
    app.on((what) => { if (this.mode && (what === 'results' || what === 'weather')) this._buildDom(); });
  }

  hasScenarios() {
    return this.app.layers.some((l) => l.entry.scenario === 'A' || l.entry.scenario === 'B');
  }

  options() {
    const out = [['base', 'No analysis']];
    for (const r of this.app.results) if (r.grid || r.facade) out.push([r.id, r.title]);
    return out;
  }

  toggle(mode) {
    if (this.mode === mode) { this.disable(); return; }
    this.enable(mode);
  }

  enable(mode) {
    const app = this.app;
    const n = mode === 'swipe' ? 2 : Number(mode);
    const res = app.results.filter((r) => r.grid || r.facade);
    const prev = this.states;
    this.states = Array.from({ length: n }, (_, i) => prev[i] || {
      result: i === 0 ? (app.activeResult?.id || res[0]?.id || 'base') : (res[i]?.id || res[0]?.id || 'base'),
      scenario: this.hasScenarios() ? (i % 2 ? 'B' : 'A') : null
    });
    this.mode = mode;
    this.layer.hidden = false;
    const legend = document.getElementById('legend');
    if (legend) legend.hidden = true; // each panel has its own
    this.layer.className = `compare-layer ${mode === 'swipe' ? 'swipe' : 'grid'}`;
    this._buildDom();
    app.viewer.renderHook = () => this.render();
    app.viewer.requestRender();
    app.emit('compare');
  }

  disable() {
    const app = this.app;
    this.mode = null;
    this.layer.hidden = true;
    clear(this.layer);
    app.viewer.renderHook = null;
    this._restore();
    app.renderLegend();
    app.viewer.requestRender();
    app.emit('compare');
  }

  _restore() {
    const app = this.app;
    app.showResult(app.activeResult);
    for (const l of app.layers) {
      if (l.entry.scenario === 'A') l.group.visible = l.visible && app.scenario !== 'B';
      else if (l.entry.scenario === 'B') l.group.visible = l.visible && app.scenario === 'B';
      else l.group.visible = l.visible;
    }
    app.viewer.renderer.shadowMap.autoUpdate = true;
  }

  /** Panel rectangles (top-left origin) for a W x H view; screen size by default. */
  _rects(W, H) {
    if (W === undefined) {
      const el = this.app.viewer.renderer.domElement;
      W = el.clientWidth; H = el.clientHeight;
    }
    if (this.mode === 'swipe') {
      const x = Math.round(W * this.split);
      return [{ x: 0, y: 0, w: x, h: H, full: true }, { x, y: 0, w: W - x, h: H, full: true }];
    }
    const [cols, rows] = LAYOUTS[this.mode];
    const out = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x0 = Math.round((W * c) / cols), x1 = Math.round((W * (c + 1)) / cols);
        const y0 = Math.round((H * r) / rows), y1 = Math.round((H * (r + 1)) / rows);
        out.push({ x: x0, y: y0, w: x1 - x0 - (c < cols - 1 ? 1 : 0), h: y1 - y0 - (r < rows - 1 ? 1 : 0) });
      }
    }
    return out;
  }

  _apply(state) {
    const app = this.app;
    const r = app.results.find((x) => x.id === state.result) || null;
    if (r?.grid) useOverlay(resultTexture(r), r.grid); else hideOverlay();
    if (app.facadeMesh) app.facadeMesh.visible = false;
    for (const res of app.results) if (res.facade?._mesh) res.facade._mesh.visible = false;
    if (r?.facade && r.showFacade !== false) {
      const mesh = app.facadeMeshFor(r.facade);
      if (!mesh.parent) app.viewer.helpers.add(mesh);
      mesh.visible = true;
    }
    if (state.scenario) {
      for (const l of app.layers) {
        if (l.entry.scenario === 'A') l.group.visible = l.visible && state.scenario === 'A';
        else if (l.entry.scenario === 'B') l.group.visible = l.visible && state.scenario === 'B';
      }
    }
  }

  render() {
    const app = this.app;
    const v = app.viewer;
    const r = v.renderer;
    const cam = v.camera;
    const size = r.getSize(new THREE.Vector2());
    const W = size.x, H = size.y;
    const rects = this._rects(W, H);
    r.setScissorTest(true);
    // Shadows only change when the buildings do (a different scenario).
    r.shadowMap.autoUpdate = false;
    let lastScenario;
    rects.forEach((rect, i) => {
      const state = this.states[i];
      if (!state) return;
      this._apply(state);
      if (i === 0 || state.scenario !== lastScenario) r.shadowMap.needsUpdate = true;
      lastScenario = state.scenario;
      if (rect.full) {
        r.setViewport(0, 0, W, H);
        cam.aspect = W / H;
      } else {
        r.setViewport(rect.x, H - rect.y - rect.h, rect.w, rect.h);
        cam.aspect = rect.w / Math.max(1, rect.h);
      }
      cam.updateProjectionMatrix();
      r.setScissor(rect.x, H - rect.y - rect.h, rect.w, rect.h);
      r.render(v.scene, cam);
    });
    r.setScissorTest(false);
    r.setViewport(0, 0, W, H);
    cam.aspect = W / H;
    cam.updateProjectionMatrix();
  }

  // ------------------------------------------------------------ labels, legends, divider
  _buildDom() {
    clear(this.layer);
    const rects = this._rects();
    const opts = this.options();
    this._boxes = [];
    this._bar = null;
    rects.forEach((rect, i) => {
      const st = this.states[i];
      const box = h('div', { class: 'cmp-panel', style: { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` } });
      const head = h('div', { class: 'cmp-head' });
      const sel = h('select', { title: 'What this panel shows', onchange: () => { st.result = sel.value; this._legend(box, st); this.app.viewer.requestRender(); } });
      for (const [k, label] of opts) sel.appendChild(h('option', { value: k, text: label, selected: k === st.result }));
      head.appendChild(sel);
      if (this.hasScenarios()) {
        const sc = h('select', { class: 'cmp-scn', title: 'Scenario', onchange: () => { st.scenario = sc.value; this.app.viewer.requestRender(); } });
        for (const k of ['A', 'B']) sc.appendChild(h('option', { value: k, text: k, selected: k === st.scenario }));
        head.appendChild(sc);
      }
      box.appendChild(head);
      this._legend(box, st);
      if (this.mode === 'swipe') {
        box.classList.add(i === 0 ? 'left' : 'right');
        if (i === 1) { head.style.left = 'auto'; head.style.right = '64px'; } // clear of the icon bar
      }
      this.layer.appendChild(box);
      this._boxes.push(box);
    });
    if (this.mode === 'swipe') {
      const W = this.app.viewer.renderer.domElement.clientWidth;
      const bar = h('div', { class: 'cmp-divider', title: 'Drag to swipe', style: { left: `${Math.round(W * this.split)}px` } }, h('span', { class: 'cmp-grip', text: '⇆' }));
      // Dragging only moves the divider and the panel frames: rebuilding the
      // DOM here would remove the element holding the pointer capture and end
      // the drag after its first move.
      bar.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        bar.setPointerCapture(e.pointerId);
        bar.classList.add('dragging');
        const move = (ev) => {
          const rect = this.layer.getBoundingClientRect();
          if (!rect.width) return;
          this.split = Math.max(0.02, Math.min(0.98, (ev.clientX - rect.left) / rect.width));
          this._layoutSwipe();
          this.app.viewer.requestRender();
        };
        const up = () => {
          bar.classList.remove('dragging');
          bar.removeEventListener('pointermove', move);
          bar.removeEventListener('pointerup', up);
          bar.removeEventListener('pointercancel', up);
        };
        bar.addEventListener('pointermove', move);
        bar.addEventListener('pointerup', up);
        bar.addEventListener('pointercancel', up);
      });
      this.layer.appendChild(bar);
      this._bar = bar;
    }
  }

  /** Move the swipe divider and the two panel frames to the current split. */
  _layoutSwipe() {
    const rects = this._rects();
    rects.forEach((rect, i) => {
      const box = this._boxes?.[i];
      if (!box) return;
      box.style.left = `${rect.x}px`;
      box.style.width = `${rect.w}px`;
    });
    if (this._bar) this._bar.style.left = `${rects[1].x}px`;
  }

  /** The label a panel shows: what it displays, and its scenario. */
  caption(i) {
    const st = this.states[i];
    if (!st) return '';
    const r = this.app.results.find((x) => x.id === st.result);
    const name = r ? r.title : 'No analysis';
    return st.scenario ? `${name} · ${st.scenario}` : name;
  }

  /**
   * Draw the panel captions, legends and dividers on a 2D canvas of W x H
   * (an image export or a video frame), as the page shows them over the view.
   */
  drawOverlay(ctx, W, H, { legends = true, reserveRight = 0, reserveBottom = 0, reserveCorner = 0 } = {}) {
    if (!this.mode) return;
    const u = Math.max(1, Math.min(W, H) / 900);
    const rects = this._rects(W, H);
    const swipe = this.mode === 'swipe';
    ctx.save();
    ctx.textBaseline = 'top';
    // Panel borders and the swipe line.
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    if (swipe) ctx.fillRect(rects[1].x - 1.5 * u, 0, 3 * u, H);
    else for (const rc of rects) {
      if (rc.x > 0) ctx.fillRect(rc.x - 1, rc.y, Math.max(1, u), rc.h);
      if (rc.y > 0) ctx.fillRect(rc.x, rc.y - 1, rc.w, Math.max(1, u));
    }
    rects.forEach((rc, i) => {
      if (!this.states[i]) return;
      const right = swipe && i === 1;
      // Caption.
      ctx.font = `600 ${13 * u}px system-ui, sans-serif`;
      const text = this.caption(i);
      const maxW = (swipe ? rc.w : rc.w) - 40 * u - (right ? reserveRight : 0);
      let t = text;
      while (t.length > 3 && ctx.measureText(t).width > maxW) t = `${t.slice(0, -2)}…`;
      const tw = ctx.measureText(t).width;
      const bx = right ? rc.x + rc.w - tw - 20 * u - 8 * u - reserveRight : rc.x + 8 * u;
      const by = rc.y + 8 * u;
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.beginPath();
      ctx.roundRect(bx, by, tw + 20 * u, 26 * u, 6 * u);
      ctx.fill();
      ctx.fillStyle = '#1d2430';
      ctx.fillText(t, bx + 10 * u, by + 6 * u);
      // Legend (a ramp, as on the page).
      if (!legends) return;
      const r = this.app.results.find((x) => x.id === this.states[i].result);
      if (!r || !r.display || r.display.categorical) return;
      const lw = Math.min(170 * u, rc.w - 16 * u), lh = 40 * u;
      const lx = right ? rc.x + rc.w - lw - 8 * u : rc.x + 8 * u;
      // Clear of the credits line (bottom row) and the scale bar (bottom-right corner).
      const bottomRow = rc.y + rc.h >= H - 1;
      const ly = rc.y + rc.h - lh - 8 * u - (bottomRow ? reserveBottom + (right ? reserveCorner : 0) : 0);
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.beginPath();
      ctx.roundRect(lx, ly, lw, lh, 6 * u);
      ctx.fill();
      const stops = rampStops(r.display.ramp);
      const grad = ctx.createLinearGradient(lx + 8 * u, 0, lx + lw - 8 * u, 0);
      stops.forEach((s, k) => grad.addColorStop(k / Math.max(1, stops.length - 1), `rgb(${s.map((x) => Math.round(x * 255)).join(',')})`));
      ctx.fillStyle = grad;
      ctx.fillRect(lx + 8 * u, ly + 8 * u, lw - 16 * u, 9 * u);
      ctx.fillStyle = '#4a5260';
      ctx.font = `${11 * u}px system-ui, sans-serif`;
      const lo = fmt(r.display.min, r.unit), hi = fmt(r.display.max, r.unit);
      ctx.fillText(lo, lx + 8 * u, ly + 22 * u);
      ctx.fillText(hi, lx + lw - 8 * u - ctx.measureText(hi).width, ly + 22 * u);
    });
    ctx.restore();
  }

  /** Rows of the layout, for the scale bar of one panel. */
  panelSize(W, H) {
    if (!this.mode || this.mode === 'swipe') return { w: W, h: H };
    const [cols, rows] = LAYOUTS[this.mode];
    return { w: W / cols, h: H / rows };
  }

  _legend(box, st) {
    box.querySelector('.cmp-legend')?.remove();
    const r = this.app.results.find((x) => x.id === st.result);
    if (!r || !r.display || r.display.categorical) return;
    const stops = rampStops(r.display.ramp);
    const css = stops.map((s, i) => `rgb(${s.map((x) => Math.round(x * 255)).join(',')}) ${(100 * i) / (stops.length - 1)}%`).join(',');
    box.appendChild(h('div', { class: 'cmp-legend' },
      h('div', { class: 'cmp-ramp', style: { background: `linear-gradient(90deg, ${css})` } }),
      h('div', { class: 'cmp-scale' }, h('span', { text: fmt(r.display.min, r.unit) }), h('span', { text: fmt(r.display.max, r.unit) }))));
  }

  onResize() {
    if (this.mode) this._buildDom();
  }
}

export { THREE };
