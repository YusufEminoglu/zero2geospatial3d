// @ts-check
// Terrain mesh, its painted texture (shading + draped surfaces + rasters),
// contour lines and the flood surface.
import * as THREE from 'three';
import { LAYER_SURFACE, LAYER_OCCLUDER } from './viewer.js';
import { patchMaterial } from './overlay.js';
import { sample, slopeAspect, hillshade, contours as contourLines } from '../core/terrain_math.js';
import { rampStops, rampColor, hexToRgb } from '../core/classify.js';

const TILE_CELLS = 256;
const LOD_STEPS = [1, 2, 4, 8, 16];
const LOD_THRESHOLD = 1100 * 1100;
const VERTEX_BUDGET = 6_000_000;

export const SHADING_MODES = {
  natural: 'Natural',
  elevation: 'Elevation',
  slope: 'Slope',
  aspect: 'Aspect',
  hillshade: 'Hillshade',
  plain: 'Plain'
};

export class Terrain {
  /**
   * @param {import('./viewer.js').Viewer} viewer
   * @param {{ cols: number, rows: number, cell: number, minX: number, maxY: number, values: Float32Array }} grid
   * @param {Uint8Array|null} [mask] 1 = DEM data, 0 = no data. A DEM clipped to
   *   a polygon has holes: they are not drawn, not hit and not analysed. grid
   *   still carries a filled-in height there, so objects get a base.
   */
  constructor(viewer, grid, mask = null) {
    this.viewer = viewer;
    this.grid = grid;
    this.mask = mask && mask.length === grid.cols * grid.rows && mask.includes(0) ? mask : null;
    this._dataGrid = null;
    let lo = Infinity, hi = -Infinity;
    const m = this.mask;
    grid.values.forEach((v, i) => { if (m && !m[i]) return; if (v < lo) lo = v; if (v > hi) hi = v; });
    if (!(lo <= hi)) lo = hi = 0;
    this.min = lo;
    this.max = hi;
    this.zBase = Math.floor(lo);
    this.exaggeration = 1;
    this.shading = 'natural';
    this.surfaces = [];         // [{ layer, colors }] painted on the texture
    this.drape = null;          // { values, min, max, ramp, opacity }
    this.contourInterval = 0;
    this.derived = null;        // cached slope/aspect/hillshade
    this.canvas = document.createElement('canvas');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.flipY = false;
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
    this.material = patchMaterial(new THREE.MeshStandardMaterial({ map: this.texture, roughness: 0.96, metalness: 0 }), { ground: true });
    this.group = new THREE.Group();
    this.group.name = 'terrain';
    viewer.world.add(this.group);
    // Grids above about 1024 x 1024 are drawn in tiles whose density follows
    // the distance to the camera; smaller ones are drawn whole, at full
    // resolution, exactly as before.
    this.lodEnabled = grid.cols * grid.rows > LOD_THRESHOLD;
    this.lock = null;
    this._makeTiles();
    this._lastCam = new THREE.Vector3(Infinity, Infinity, Infinity);
    this.updateLod(true);
    viewer.onFrame(() => this.updateLod());
    this.contourGroup = new THREE.Group();
    viewer.helpers.add(this.contourGroup);
    this.water = null;
    this.paint();
  }

  /**
   * The DEM as measured: the same grid with NaN where there is no data. Use it
   * for anything that reads the ground as data (contours, profiles, flooding,
   * cut and fill, terrain analyses); `grid` is only for placing objects.
   */
  get dataGrid() {
    if (!this.mask) return this.grid;
    if (!this._dataGrid) {
      const values = Float32Array.from(this.grid.values, (v, i) => (this.mask[i] ? v : NaN));
      this._dataGrid = { ...this.grid, values };
    }
    return this._dataGrid;
  }

  /** Whether local (x, y) lies on DEM data (nearest cell). */
  hasData(x, y) {
    if (!this.mask) return true;
    const g = this.grid;
    const c = Math.round((x - g.minX) / g.cell), r = Math.round((g.maxY - y) / g.cell);
    if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) return false;
    return this.mask[r * g.cols + c] === 1;
  }

  /** Local (x, y) -> absolute elevation. */
  heightAt(x, y) {
    return sample(this.grid, x, y);
  }

  /** Absolute elevation -> scene y. */
  toY(z) {
    return (z - this.zBase) * this.exaggeration;
  }

  fromY(y) {
    return y / this.exaggeration + this.zBase;
  }

  /** Scene y of the ground at local (x, y). */
  groundY(x, y) {
    return this.toY(this.heightAt(x, y));
  }

  // ------------------------------------------------------------ tiled mesh
  /** Vertex normal at grid point (c, r) from its neighbours, so tiles meet without seams. */
  _normalAt(c, r, out, k) {
    const { cols, rows, cell, values: z } = this.grid;
    const ex = this.exaggeration;
    const ru = Math.max(0, r - 1), rd = Math.min(rows - 1, r + 1);
    const cl = Math.max(0, c - 1), cr = Math.min(cols - 1, c + 1);
    const dx = ((z[r * cols + cr] - z[r * cols + cl]) * ex) / (cell * (cr - cl || 1));
    // Rows run north -> south, i.e. towards +z in the scene.
    const dz = ((z[rd * cols + c] - z[ru * cols + c]) * ex) / (cell * (rd - ru || 1));
    const len = Math.hypot(dx, 1, dz);
    out[k * 3] = -dx / len; out[k * 3 + 1] = 1 / len; out[k * 3 + 2] = -dz / len;
  }

  _makeTiles() {
    const { cols, rows, cell, minX, maxY } = this.grid;
    const size = this.lodEnabled ? TILE_CELLS : Math.max(cols, rows);
    this.tiles = [];
    for (let r0 = 0; r0 < rows - 1; r0 += size) {
      for (let c0 = 0; c0 < cols - 1; c0 += size) {
        const c1 = Math.min(cols - 1, c0 + size);
        const r1 = Math.min(rows - 1, r0 + size);
        const cx = minX + ((c0 + c1) / 2) * cell;
        const cz = -(maxY - ((r0 + r1) / 2) * cell);
        this.tiles.push({ c0, r0, c1, r1, cx, cz, radius: (Math.hypot(c1 - c0, r1 - r0) * cell) / 2, meshes: new Map(), step: 0 });
      }
    }
  }

  _indices(from, to, step) {
    const out = [];
    for (let i = from; i < to; i += step) out.push(i);
    out.push(to);
    return out;
  }

  _buildTileMesh(tile, step) {
    const { cols, rows, cell, minX, maxY, values } = this.grid;
    const cs = this._indices(tile.c0, tile.c1, step);
    const rs = this._indices(tile.r0, tile.r1, step);
    const nc = cs.length, nr = rs.length;
    const skirt = this.lodEnabled;
    const ring = [];
    if (skirt) {
      for (let i = 0; i < nc; i++) ring.push([i, 0]);
      for (let j = 1; j < nr; j++) ring.push([nc - 1, j]);
      for (let i = nc - 2; i >= 0; i--) ring.push([i, nr - 1]);
      for (let j = nr - 2; j >= 0; j--) ring.push([0, j]);
    }
    const count = nc * nr + ring.length;
    const pos = new Float32Array(count * 3);
    const nrm = new Float32Array(count * 3);
    const uv = new Float32Array(count * 2);
    const put = (k, c, r, drop) => {
      const g = r * cols + c;
      pos[k * 3] = minX + c * cell;
      pos[k * 3 + 1] = this.toY(values[g]) - drop;
      pos[k * 3 + 2] = -(maxY - r * cell);
      this._normalAt(c, r, nrm, k);
      uv[k * 2] = (c + 0.5) / cols;
      uv[k * 2 + 1] = (r + 0.5) / rows;
    };
    for (let j = 0; j < nr; j++) for (let i = 0; i < nc; i++) put(j * nc + i, cs[i], rs[j], 0);
    // Typed index of the largest size needed: no growing JS array to collect later.
    const index = new (count > 65535 ? Uint32Array : Uint16Array)((nc - 1) * (nr - 1) * 6 + ring.length * 12);
    const mask = this.mask;
    const on = mask ? (i, j) => mask[rs[j] * cols + cs[i]] === 1 : () => true;
    let q6 = 0;
    for (let j = 0; j < nr - 1; j++) {
      for (let i = 0; i < nc - 1; i++) {
        const a = j * nc + i, b = a + 1, d = a + nc, e = d + 1;
        // No data at a corner: no ground there (a DEM clipped to a polygon).
        // Each half of the quad is kept when its own three corners have data,
        // so the edge follows the outline diagonally rather than in steps.
        const oa = on(i, j), ob = on(i + 1, j), od = on(i, j + 1), oe = on(i + 1, j + 1);
        // Counter-clockwise seen from above (+y): a(north-west) -> d(south-west) -> b.
        if (oa && od && ob) { index[q6++] = a; index[q6++] = d; index[q6++] = b; }
        if (ob && od && oe) { index[q6++] = b; index[q6++] = d; index[q6++] = e; }
      }
    }
    if (skirt) {
      // A curtain hanging below each tile edge hides the cracks where a fine
      // tile meets a coarser neighbour. Both windings, so it shows from any side.
      const drop = cell * step * 2 + 2 * this.exaggeration;
      let k = nc * nr;
      const top = [];
      const bottom = [];
      for (const [i, j] of ring) {
        top.push(j * nc + i);
        put(k, cs[i], rs[j], drop);
        bottom.push(k++);
      }
      top.push(top[0]);
      bottom.push(bottom[0]);
      ring.push(ring[0]);
      for (let q = 0; q < top.length - 1; q++) {
        // No curtain under a hole in the DEM.
        if (!on(ring[q][0], ring[q][1]) || !on(ring[q + 1][0], ring[q + 1][1])) continue;
        const a = top[q], b = top[q + 1], c2 = bottom[q], d = bottom[q + 1];
        index.set([a, c2, b, b, c2, d, a, b, c2, b, d, c2], q6);
        q6 += 12;
      }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geom.setIndex(new THREE.BufferAttribute(q6 < index.length ? index.slice(0, q6) : index, 1));
    geom.computeBoundingBox();
    geom.computeBoundingSphere();
    const mesh = new THREE.Mesh(geom, this.material);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    mesh.layers.enable(LAYER_SURFACE);
    mesh.layers.enable(LAYER_OCCLUDER);
    mesh.visible = false;
    mesh.userData.vertices = count;
    this.group.add(mesh);
    return mesh;
  }

  _stepFor(tile, cam) {
    if (!this.lodEnabled) return 1;
    const cell = this.grid.cell;
    const L = this.lock;
    if (L && tile.cx + tile.radius >= L.minX && tile.cx - tile.radius <= L.maxX &&
        -tile.cz + tile.radius >= L.minY && -tile.cz - tile.radius <= L.maxY) return L.step;
    const dist = Math.max(0, Math.hypot(cam.x - tile.cx, cam.y - this.toY((this.min + this.max) / 2), cam.z - tile.cz) - tile.radius);
    const spacing = Math.max(cell, dist * 0.003);
    let step = 1;
    for (const s of LOD_STEPS) if (s * cell <= spacing) step = s;
    return step;
  }

  /** Pick a density per tile for the current camera. Returns true when the scene changed. */
  updateLod(force = false) {
    const cam = this.viewer.camera.position;
    if (!force) {
      if (!this.lodEnabled) return false;
      const moved = cam.distanceTo(this._lastCam);
      if (!this._pending && moved < Math.max(1, 0.02 * cam.distanceTo(this.viewer.controls.target))) return false;
    }
    this._lastCam.copy(cam);
    const wanted = this.tiles.map((t) => this._stepFor(t, cam));
    // Keep the total under the vertex budget by coarsening the farthest tiles first.
    const verts = (t, s) => (Math.floor((t.c1 - t.c0) / s) + 2) * (Math.floor((t.r1 - t.r0) / s) + 2);
    let total = this.tiles.reduce((sum, t, i) => sum + verts(t, wanted[i]), 0);
    if (total > VERTEX_BUDGET) {
      const order = this.tiles.map((t, i) => [Math.hypot(cam.x - t.cx, cam.z - t.cz), i]).sort((a, b) => b[0] - a[0]);
      for (const [, i] of order) {
        while (total > VERTEX_BUDGET && wanted[i] < LOD_STEPS[LOD_STEPS.length - 1]) {
          total -= verts(this.tiles[i], wanted[i]);
          wanted[i] *= 2;
          total += verts(this.tiles[i], wanted[i]);
        }
        if (total <= VERTEX_BUDGET) break;
      }
    }
    let changed = false;
    // Building tiles costs time: spread it over frames (about 12 ms each) so a
    // jump of the camera never freezes the view. Nearest tiles go first; a
    // forced update (analysis, first frame) builds everything at once.
    const deadline = performance.now() + (force ? Infinity : 12);
    this._pending = false;
    const order = this.tiles.map((t, i) => [Math.hypot(cam.x - t.cx, cam.z - t.cz), i]).sort((a, b) => a[0] - b[0]);
    for (const [, i] of order) {
      const t = this.tiles[i];
      const step = wanted[i];
      if (t.step === step) continue;
      let mesh = t.meshes.get(step);
      if (!mesh) {
        if (performance.now() > deadline && t.step) { this._pending = true; continue; }
        mesh = this._buildTileMesh(t, step);
        t.meshes.set(step, mesh);
      }
      const old = t.meshes.get(t.step);
      if (old) old.visible = false;
      mesh.visible = true;
      t.step = step;
      changed = true;
      // Keep at most two densities per tile in memory.
      for (const [s, m] of t.meshes) {
        if (s !== step && t.meshes.size > 2) { this.group.remove(m); m.geometry.dispose(); t.meshes.delete(s); }
      }
    }
    this.stats = { tiles: this.tiles.length, vertices: total };
    return changed;
  }

  /** Draw an area at (at least) a given cell size for an analysis; null releases it. */
  lockForAnalysis(area, cell) {
    if (!this.lodEnabled) return;
    if (!area) { this.lock = null; this.updateLod(true); return; }
    const g = this.grid.cell;
    let step = 1;
    for (const s of LOD_STEPS) if (s * g <= Math.max(g, cell)) step = s;
    const cells = ((area.maxX - area.minX) / g) * ((area.maxY - area.minY) / g);
    while (cells / (step * step) > VERTEX_BUDGET && step < LOD_STEPS[LOD_STEPS.length - 1]) step *= 2;
    this.lock = { ...area, step };
    this.updateLod(true);
  }

  _disposeTiles() {
    for (const t of this.tiles) {
      for (const m of t.meshes.values()) { this.group.remove(m); m.geometry.dispose(); }
      t.meshes.clear();
      t.step = 0;
    }
  }

  setExaggeration(ex) {
    this.exaggeration = ex;
    this._disposeTiles();
    this.updateLod(true);
    if (this.contourInterval) this.setContours(this.contourInterval);
    if (this.water) this.setWater(this.water.level, this.water.depth);
    this.viewer.requestRender();
  }

  /** Hillshade always; slope and aspect only while a mode shows them (64 MB each on a 4096 grid). */
  _derived(needSlope = false) {
    if (!this.derived) this.derived = { shade: hillshade(this.grid, 315, 40, 1.5) };
    if (needSlope && !this.derived.slope) Object.assign(this.derived, slopeAspect(this.grid));
    if (!needSlope && this.derived.slope) { delete this.derived.slope; delete this.derived.aspect; }
    return this.derived;
  }

  /** Repaint the terrain texture: shading, raster drape, then surfaces. */
  paint() {
    const { cols, rows } = this.grid;
    const longest = Math.max(cols, rows);
    const scale = Math.min(4, Math.min(4096, Math.max(2048, longest)) / longest);
    const W = Math.round(cols * scale);
    const H = Math.round(rows * scale);
    this.canvas.width = W;
    this.canvas.height = H;
    const ctx = /** @type {CanvasRenderingContext2D} */ (this.canvas.getContext('2d'));
    // 1. Shading at grid resolution, scaled up.
    const base = document.createElement('canvas');
    base.width = cols;
    base.height = rows;
    const bctx = /** @type {CanvasRenderingContext2D} */ (base.getContext('2d'));
    const img = bctx.createImageData(cols, rows);
    const flat = this.max - this.min < 0.5;
    const d = flat ? null : this._derived(this.shading === 'slope' || this.shading === 'aspect');
    const elevStops = rampStops('terrain');
    const slopeStops = rampStops('magma-r');
    const c = [0, 0, 0];
    for (let i = 0; i < cols * rows; i++) {
      const z = this.grid.values[i];
      const shade = d ? d.shade[i] : 0.75;
      const t = (z - this.min) / Math.max(1e-6, this.max - this.min);
      switch (this.shading) {
        case 'elevation': rampColor(elevStops, t, c); mul(c, 0.55 + 0.45 * shade); break;
        case 'slope': rampColor(slopeStops, d ? Math.min(1, d.slope[i] / 45) : 0, c); mul(c, 0.75 + 0.25 * shade); break;
        case 'aspect': {
          const a = d ? d.aspect[i] : -1;
          if (a < 0) { c[0] = c[1] = c[2] = 0.8; } else hsl(a / 360, 0.55, 0.6, c);
          mul(c, 0.7 + 0.3 * shade);
          break;
        }
        case 'hillshade': c[0] = c[1] = c[2] = 0.15 + 0.85 * shade; break;
        case 'plain': c[0] = 0.86; c[1] = 0.86; c[2] = 0.84; mul(c, 0.82 + 0.18 * shade); break;
        default: {
          // Natural: muted ground tones by height, lit by the hillshade.
          c[0] = 0.78 - 0.08 * t; c[1] = 0.79 - 0.02 * t; c[2] = 0.70 + 0.02 * t;
          mul(c, 0.68 + 0.32 * shade);
        }
      }
      img.data[i * 4] = c[0] * 255; img.data[i * 4 + 1] = c[1] * 255; img.data[i * 4 + 2] = c[2] * 255; img.data[i * 4 + 3] = 255;
    }
    if (this.drape) {
      const { values, min, max, ramp, opacity } = this.drape;
      const stops = rampStops(ramp);
      for (let i = 0; i < cols * rows; i++) {
        const v = values[i];
        if (!Number.isFinite(v)) continue;
        rampColor(stops, (v - min) / Math.max(1e-9, max - min), c);
        for (let k = 0; k < 3; k++) img.data[i * 4 + k] = img.data[i * 4 + k] * (1 - opacity) + c[k] * 255 * opacity;
      }
    }
    bctx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(base, 0, 0, W, H);
    // 2. Draped surfaces (parks, water, squares ...), drawn as vectors.
    const g = this.grid;
    const toPx = (x, y) => [((x - (g.minX - g.cell / 2)) / g.cell) * scale, (((g.maxY + g.cell / 2) - y) / g.cell) * scale];
    for (const { features, colors, visible } of this.surfaces) {
      if (!visible) continue;
      for (let f = 0; f < features.length; f++) {
        const geom = features[f].geometry;
        if (!geom) continue;
        const rgb = colors.subarray(f * 3, f * 3 + 3);
        ctx.fillStyle = `rgba(${rgb[0] * 255 | 0},${rgb[1] * 255 | 0},${rgb[2] * 255 | 0},0.82)`;
        ctx.beginPath();
        for (const poly of geom.coordinates) {
          for (const ring of poly) {
            ring.forEach(([x, y], i) => { const [px, py] = toPx(x, y); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
            ctx.closePath();
          }
        }
        ctx.fill('evenodd');
      }
    }
    this.texture.needsUpdate = true;
    this.viewer.requestRender();
  }

  setShading(mode) {
    this.shading = mode;
    this.paint();
  }

  setDrape(drape) {
    this.drape = drape;
    this.paint();
  }

  addSurfaceLayer(entry) {
    this.surfaces.push(entry);
    this.paint();
  }

  setContours(interval) {
    this.contourInterval = interval;
    for (const child of [...this.contourGroup.children]) {
      this.contourGroup.remove(child);
      /** @type {any} */ (child).geometry.dispose();
    }
    if (!(interval > 0)) { this.viewer.requestRender(); return; }
    const sets = contourLines(this.dataGrid, interval, { maxLevels: 300 });
    const minor = [];
    const major = [];
    for (const { level, segments } of sets) {
      const target = Math.abs(level / (interval * 5) - Math.round(level / (interval * 5))) < 1e-6 ? major : minor;
      const y = this.toY(level) + 0.25;
      for (let i = 0; i < segments.length; i += 4) {
        target.push(segments[i], y, -segments[i + 1], segments[i + 2], y, -segments[i + 3]);
      }
    }
    for (const [arr, color, opacity] of [[minor, 0x5b4a3a, 0.55], [major, 0x3b2a1a, 0.9]]) {
      if (!arr.length) continue;
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
      this.contourGroup.add(new THREE.LineSegments(geom, mat));
    }
    this.viewer.requestRender();
  }

  /** Water surface over the flooded cells. depth: Float32Array (NaN = dry). */
  setWater(level, depth) {
    if (this.waterMesh) {
      this.viewer.helpers.remove(this.waterMesh);
      this.waterMesh.geometry.dispose();
      this.waterMesh = null;
    }
    this.water = depth ? { level, depth } : null;
    if (!depth) { this.viewer.requestRender(); return; }
    const { cols, rows, cell, minX, maxY } = this.grid;
    const pos = [];
    const y = this.toY(level);
    const h = cell / 2;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!Number.isFinite(depth[r * cols + c])) continue;
        const x = minX + c * cell;
        const z = -(maxY - r * cell);
        pos.push(x - h, y, z - h, x - h, y, z + h, x + h, y, z - h, x + h, y, z - h, x - h, y, z + h, x + h, y, z + h);
      }
    }
    if (!pos.length) { this.viewer.requestRender(); return; }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geom.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: 0x2f7fc1, transparent: true, opacity: 0.62, roughness: 0.15, metalness: 0.1, depthWrite: false });
    this.waterMesh = new THREE.Mesh(geom, mat);
    this.waterMesh.renderOrder = 2;
    this.viewer.helpers.add(this.waterMesh);
    this.viewer.requestRender();
  }

  /**
   * Intersect a ray (three coordinates) with the terrain by marching over
   * the height grid. Returns the hit point or null.
   */
  raycast(origin, dir, maxDist = 100000) {
    const step = Math.max(0.5, this.grid.cell / 2);
    let prevT = 0;
    // Over a hole in the DEM there is no ground: the ray is always above it.
    const above = (x, y, h) => !this.hasData(x, y) || h - this.groundY(x, y) > 0;
    let prevAbove = above(origin.x, -origin.z, origin.y);
    if (!prevAbove) return null;
    // Coarse march with growing steps, then bisection.
    let t = step;
    while (t < maxDist) {
      const x = origin.x + dir.x * t, y = origin.y + dir.y * t, z = origin.z + dir.z * t;
      const gx = x, gy = -z;
      const inside = gx >= this.grid.minX - this.grid.cell && gx <= this.grid.minX + this.grid.cols * this.grid.cell &&
        gy <= this.grid.maxY + this.grid.cell && gy >= this.grid.maxY - this.grid.rows * this.grid.cell;
      const isAbove = above(gx, gy, y);
      if (inside && !isAbove && prevAbove) {
        let lo = prevT, hi = t;
        for (let i = 0; i < 30; i++) {
          const mid = (lo + hi) / 2;
          const yy = origin.y + dir.y * mid;
          if (above(origin.x + dir.x * mid, -(origin.z + dir.z * mid), yy)) lo = mid; else hi = mid;
        }
        return new THREE.Vector3().copy(origin).addScaledVector(dir, hi);
      }
      prevAbove = isAbove || !inside;
      prevT = t;
      t += step * Math.max(1, t / 400);
    }
    return null;
  }
}

function mul(c, k) { c[0] *= k; c[1] *= k; c[2] *= k; }

function hsl(h, s, l, out) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
  };
  out[0] = f(0); out[1] = f(8); out[2] = f(4);
  return out;
}

export { hexToRgb };
