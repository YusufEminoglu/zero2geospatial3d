// @ts-check
// Pointer tools on the 3D view: pick a point, draw a line, a polygon or a
// rectangle on the ground. Each returns a promise that resolves with the
// result in local metres (x east, y north), or null when cancelled.
import * as THREE from 'three';

export class Tools {
  constructor(app) {
    this.app = app;
    this.viewer = app.viewer;
    this.active = null;
    this.group = new THREE.Group();
    this.group.renderOrder = 10;
    this.viewer.helpers.add(this.group);
    const el = this.viewer.renderer.domElement;
    this._down = null;
    el.addEventListener('pointerdown', (e) => { this._down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
    el.addEventListener('pointerup', (e) => {
      if (!this._down || e.button !== 0) return;
      const moved = Math.hypot(e.clientX - this._down.x, e.clientY - this._down.y);
      this._down = null;
      if (moved > 5) return;
      if (this.active) this.active.click(e);
      else app.onClick(e);
    });
    el.addEventListener('pointermove', (e) => this.active?.move?.(e));
    el.addEventListener('dblclick', (e) => { if (this.active?.finish) { e.preventDefault(); this.active.finish(); } });
    window.addEventListener('keydown', (e) => {
      if (!this.active) return;
      if (e.key === 'Escape') this.cancel();
      else if (e.key === 'Enter') this.active.finish?.();
      else if (e.key === 'Backspace') this.active.undo?.();
    });
  }

  /** Ground point under the pointer: { world, local } or null. */
  groundAt(e, { roofs = false } = {}) {
    const ndc = this.viewer.ndc(e.clientX, e.clientY);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.viewer.camera);
    let hit = this.app.terrain.raycast(ray.ray.origin, ray.ray.direction);
    if (roofs) {
      ray.layers.set(0);
      const meshes = [];
      for (const l of this.app.layers) if (l.chunks && l.visible) for (const c of l.chunks) meshes.push(c.mesh);
      const hits = ray.intersectObjects(meshes, false);
      if (hits.length && (!hit || hits[0].distance < hit.distanceTo(ray.ray.origin))) hit = hits[0].point;
    }
    if (!hit) return null;
    return { world: hit, local: [hit.x, -hit.z] };
  }

  _hint(text) {
    const el = document.getElementById('tool-hint');
    if (!el) return;
    el.textContent = text || '';
    el.hidden = !text;
  }

  _clearGraphics() {
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      /** @type {any} */ (c).geometry?.dispose();
    }
    this.viewer.requestRender();
  }

  cancel() {
    const a = this.active;
    this.active = null;
    this._hint('');
    this._clearGraphics();
    this.viewer.renderer.domElement.style.cursor = '';
    a?.resolve(null);
  }

  _start(tool) {
    if (this.active) this.cancel();
    this.active = tool;
    this.viewer.renderer.domElement.style.cursor = 'crosshair';
  }

  _end(value) {
    const a = this.active;
    this.active = null;
    this._hint('');
    this.viewer.renderer.domElement.style.cursor = '';
    a?.resolve(value);
  }

  pickPoint(hint = 'Click a point', { roofs = true } = {}) {
    return new Promise((resolve) => {
      this._start({ resolve, click: (e) => { const p = this.groundAt(e, { roofs }); if (p) this._end(p); } });
      this._hint(`${hint} · Esc cancels`);
    });
  }

  _drawPath(closed, hint) {
    return new Promise((resolve) => {
      const pts = [];
      let cursor = null;
      const redraw = () => {
        this._clearGraphics();
        const all = cursor ? [...pts, cursor] : [...pts];
        if (closed && all.length > 2) all.push(all[0]);
        if (all.length < 2) return;
        const pos = [];
        for (const [x, y] of all) pos.push(x, this.app.terrain.groundY(x, y) + 1.5, -y);
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        const line = new THREE.Line(geom, new THREE.LineBasicMaterial({ color: 0xff4f2e, depthTest: false }));
        line.renderOrder = 20;
        this.group.add(line);
        this.viewer.requestRender();
      };
      const finish = () => {
        if (pts.length < (closed ? 3 : 2)) return;
        this._clearGraphics();
        this._end(pts.slice());
      };
      this._start({
        resolve,
        click: (e) => { const p = this.groundAt(e); if (p) { pts.push(p.local); redraw(); } },
        move: (e) => { if (!pts.length) return; const p = this.groundAt(e); if (p) { cursor = p.local; redraw(); } },
        undo: () => { pts.pop(); redraw(); },
        finish
      });
      this._hint(`${hint} · double-click or Enter finishes · Backspace undoes · Esc cancels`);
    });
  }

  drawLine(hint = 'Click points along the line') {
    return this._drawPath(false, hint);
  }

  drawPolygon(hint = 'Click the corners of the area') {
    return this._drawPath(true, hint);
  }

  drawRect(hint = 'Click two opposite corners') {
    return new Promise((resolve) => {
      let a = null;
      let b = null;
      const redraw = () => {
        this._clearGraphics();
        if (!a || !b) return;
        const ring = [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]], [a[0], a[1]]];
        const pos = [];
        for (const [x, y] of ring) pos.push(x, this.app.terrain.groundY(x, y) + 2, -y);
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        const line = new THREE.Line(geom, new THREE.LineBasicMaterial({ color: 0x1f8fff, depthTest: false }));
        line.renderOrder = 20;
        this.group.add(line);
        this.viewer.requestRender();
      };
      this._start({
        resolve,
        click: (e) => {
          const p = this.groundAt(e);
          if (!p) return;
          if (!a) { a = p.local; return; }
          b = p.local;
          this._clearGraphics();
          this._end({ minX: Math.min(a[0], b[0]), maxX: Math.max(a[0], b[0]), minY: Math.min(a[1], b[1]), maxY: Math.max(a[1], b[1]) });
        },
        move: (e) => { if (!a) return; const p = this.groundAt(e); if (p) { b = p.local; redraw(); } }
      });
      this._hint(`${hint} · Esc cancels`);
    });
  }

  /** Persistent outline of an analysis area or drawn geometry. */
  outline(name, ring, color = 0x1f8fff) {
    const prev = this.viewer.helpers.getObjectByName(name);
    if (prev) { this.viewer.helpers.remove(prev); /** @type {any} */ (prev).geometry?.dispose(); }
    if (!ring) { this.viewer.requestRender(); return; }
    const pos = [];
    const step = Math.max(2, this.app.terrain.grid.cell);
    for (let i = 0; i < ring.length - 1; i++) {
      const [x0, y0] = ring[i], [x1, y1] = ring[i + 1];
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
      for (let k = 0; k <= n; k++) {
        const x = x0 + ((x1 - x0) * k) / n, y = y0 + ((y1 - y0) * k) / n;
        pos.push(x, this.app.terrain.groundY(x, y) + 1.2, -y);
      }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const line = new THREE.Line(geom, new THREE.LineDashedMaterial({ color, dashSize: 6, gapSize: 4, depthTest: false }));
    line.computeLineDistances();
    line.name = name;
    line.renderOrder = 15;
    this.viewer.helpers.add(line);
    this.viewer.requestRender();
  }
}
