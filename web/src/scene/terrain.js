// @ts-check
// Terrain mesh, its painted texture (shading + draped surfaces + rasters),
// contour lines and the flood surface.
import * as THREE from 'three';
import { LAYER_SURFACE, LAYER_OCCLUDER } from './viewer.js';
import { patchMaterial } from './overlay.js';
import { sample, slopeAspect, hillshade, contours as contourLines } from '../core/terrain_math.js';
import { rampStops, rampColor, hexToRgb } from '../core/classify.js';

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
   */
  constructor(viewer, grid) {
    this.viewer = viewer;
    this.grid = grid;
    let lo = Infinity, hi = -Infinity;
    for (const v of grid.values) { if (v < lo) lo = v; if (v > hi) hi = v; }
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
    this.material = patchMaterial(new THREE.MeshStandardMaterial({ map: this.texture, roughness: 0.96, metalness: 0 }));
    this.mesh = this._buildMesh();
    this.mesh.receiveShadow = true;
    this.mesh.layers.enable(LAYER_SURFACE);
    this.mesh.layers.enable(LAYER_OCCLUDER);
    this.mesh.name = 'terrain';
    viewer.world.add(this.mesh);
    this.contourGroup = new THREE.Group();
    viewer.helpers.add(this.contourGroup);
    this.water = null;
    this.paint();
  }

  /** Local (x east, y north) -> absolute elevation. */
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

  _buildMesh() {
    const { cols, rows, cell, minX, maxY, values } = this.grid;
    const n = cols * rows;
    const pos = new Float32Array(n * 3);
    const uv = new Float32Array(n * 2);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        pos[i * 3] = minX + c * cell;
        pos[i * 3 + 1] = this.toY(values[i]);
        pos[i * 3 + 2] = -(maxY - r * cell);
        uv[i * 2] = (c + 0.5) / cols;
        uv[i * 2 + 1] = (r + 0.5) / rows;
      }
    }
    const index = new Uint32Array((cols - 1) * (rows - 1) * 6);
    let k = 0;
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = r * cols + c, b = a + 1, d = a + cols, e = d + 1;
        // Counter-clockwise seen from above (+y): a(north-west) -> d(south-west) -> b.
        index[k++] = a; index[k++] = d; index[k++] = b;
        index[k++] = b; index[k++] = d; index[k++] = e;
      }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geom.setIndex(new THREE.BufferAttribute(index, 1));
    geom.computeVertexNormals();
    geom.computeBoundingBox();
    geom.computeBoundingSphere();
    return new THREE.Mesh(geom, this.material);
  }

  setExaggeration(ex) {
    this.exaggeration = ex;
    const pos = this.mesh.geometry.attributes.position;
    const v = this.grid.values;
    for (let i = 0; i < v.length; i++) pos.array[i * 3 + 1] = this.toY(v[i]);
    pos.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
    this.mesh.geometry.computeBoundingBox();
    this.mesh.geometry.computeBoundingSphere();
    if (this.contourInterval) this.setContours(this.contourInterval);
    if (this.water) this.setWater(this.water.level, this.water.depth);
    this.viewer.requestRender();
  }

  _derived() {
    if (!this.derived) {
      const sa = slopeAspect(this.grid);
      this.derived = { ...sa, shade: hillshade(this.grid, 315, 40, 1.5) };
    }
    return this.derived;
  }

  /** Repaint the terrain texture: shading, raster drape, then surfaces. */
  paint() {
    const { cols, rows } = this.grid;
    const scale = Math.max(1, Math.min(4, Math.floor(2048 / Math.max(cols, rows))));
    const W = cols * scale;
    const H = rows * scale;
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
    const d = flat ? null : this._derived();
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
    const sets = contourLines(this.grid, interval, { maxLevels: 300 });
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
    let prevAbove = origin.y - this.groundY(origin.x, -origin.z) > 0;
    if (!prevAbove) return null;
    // Coarse march with growing steps, then bisection.
    let t = step;
    while (t < maxDist) {
      const x = origin.x + dir.x * t, y = origin.y + dir.y * t, z = origin.z + dir.z * t;
      const gx = x, gy = -z;
      const inside = gx >= this.grid.minX - this.grid.cell && gx <= this.grid.minX + this.grid.cols * this.grid.cell &&
        gy <= this.grid.maxY + this.grid.cell && gy >= this.grid.maxY - this.grid.rows * this.grid.cell;
      const above = y - this.groundY(gx, gy) > 0;
      if (inside && !above && prevAbove) {
        let lo = prevT, hi = t;
        for (let i = 0; i < 30; i++) {
          const mid = (lo + hi) / 2;
          const yy = origin.y + dir.y * mid;
          if (yy - this.groundY(origin.x + dir.x * mid, -(origin.z + dir.z * mid)) > 0) lo = mid; else hi = mid;
        }
        return new THREE.Vector3().copy(origin).addScaledVector(dir, hi);
      }
      prevAbove = above || !inside;
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
