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

  _rects() {
    const el = this.app.viewer.renderer.domElement;
    const W = el.clientWidth, H = el.clientHeight;
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
    const el = r.domElement;
    const W = el.clientWidth, H = el.clientHeight;
    const rects = this._rects();
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
    });
    if (this.mode === 'swipe') {
      const W = this.app.viewer.renderer.domElement.clientWidth;
      const bar = h('div', { class: 'cmp-divider', style: { left: `${Math.round(W * this.split)}px` } }, h('span', { class: 'cmp-grip', text: '⇆' }));
      bar.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        bar.setPointerCapture(e.pointerId);
        const move = (ev) => {
          const rect = this.layer.getBoundingClientRect();
          this.split = Math.max(0.05, Math.min(0.95, (ev.clientX - rect.left) / rect.width));
          this._buildDom();
          this.app.viewer.requestRender();
        };
        const up = () => { bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', up); };
        bar.addEventListener('pointermove', move);
        bar.addEventListener('pointerup', up);
      });
      this.layer.appendChild(bar);
    }
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
