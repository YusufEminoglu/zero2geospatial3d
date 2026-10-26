// @ts-check
// Object layers: extruded buildings and walls (merged into chunks), trees
// and poles (instanced), draped surfaces, platforms and section lines.
//
// Every extruded feature carries its id (`fkey`) and its layer index
// (`flayer`) as vertex attributes, so a single GPU pass can say which
// feature covers a pixel (key = layer index << 20 | id). Vertex heights are recomputed from per-vertex base
// elevations and per-feature heights, so a new height field or terrain
// exaggeration costs one pass over the vertices, not a rebuild.
import * as THREE from 'three';
import { LAYER_SURFACE, LAYER_OCCLUDER, LAYER_ID, KEY_SHIFT } from './viewer.js';
import { patchMaterial } from './overlay.js';
import { hexToRgb } from '../core/classify.js';

export { KEY_SHIFT };
export const SINK = 0.6; // metres a building is pushed into the ground
const CHUNK_FEATURES = 3000;

export function srgbToLinear(v) {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function featureKey(layerIndex, id) {
  return layerIndex * KEY_SHIFT + id;
}

export function splitKey(key) {
  return { layerIndex: Math.floor(key / KEY_SHIFT), id: key % KEY_SHIFT };
}

function ringsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

function openRing(ring) {
  const n = ring.length;
  if (n > 1 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1]) return ring.slice(0, n - 1);
  return ring;
}

function signedArea(ring) {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return s / 2;
}

/** Base class: a manifest layer and its features. */
export class ObjectLayer {
  constructor(app, entry, index, data) {
    this.app = app;
    this.entry = entry;
    this.index = index;               // 1-based layer index used in keys
    this.features = data.features;
    this.count = this.features.length;
    this.group = new THREE.Group();
    this.group.name = entry.name;
    this.visible = true;
    this.colors = new Float32Array(this.count * 3);
    this.sourceColors = new Float32Array(this.count * 3);
    this.heights = new Float32Array(this.count);
    this.sourceHeights = new Float32Array(this.count);
    for (let i = 0; i < this.count; i++) {
      const p = this.features[i].properties;
      const rgb = hexToRgb(p._c || entry.defaultColor);
      this.colors.set(rgb, i * 3);
      this.sourceColors.set(rgb, i * 3);
      const h = Number(p._h);
      this.heights[i] = Number.isFinite(h) && p._h !== null ? h : entry.defaultHeight;
      this.sourceHeights[i] = this.heights[i];
    }
    this.extraFields = new Map();     // analysis results: name -> Float32Array per feature
  }

  /** Values of a field (attribute or analysis result) per feature. */
  values(field) {
    if (this.extraFields.has(field)) return Array.from(/** @type {Float32Array} */ (this.extraFields.get(field)));
    return this.features.map((f) => f.properties[field]);
  }

  fieldNames() {
    const names = this.entry.fields.map((f) => ({ name: f.name, type: f.type }));
    for (const name of this.extraFields.keys()) names.push({ name, type: 'number', result: true });
    return names;
  }

  setResultField(name, values) {
    this.extraFields.set(name, values);
  }

  setVisible(on) {
    this.visible = on;
    this.group.visible = on;
    this.app.viewer.requestRender();
  }

  applyColors() { /* subclasses */ }
  applyHeights() { /* subclasses */ }
  updateElevation() { /* subclasses */ }
  dispose() {
    this.group.traverse((o) => {
      const m = /** @type {any} */ (o);
      if (m.geometry) m.geometry.dispose();
      if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose());
    });
  }
}

// ---------------------------------------------------------------- extrusions
class Chunk {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.feat = [];    // local feature index per vertex
    this.top = [];     // 1 = top vertex, 0 = bottom
    this.base = [];    // absolute base elevation per vertex
    this.index = [];
  }
}

/** Extruded polygons (buildings) or lines (walls). */
export class ExtrudedLayer extends ObjectLayer {
  constructor(app, entry, index, data) {
    super(app, entry, index, data);
    this.isWall = entry.role === 'walls';
    this.thickness = 0.35;
    this.material = patchMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.02 }));
    this.footprint = new Float32Array(this.count);   // m2 (buildings)
    this.centroid = new Float32Array(this.count * 2);
    this.baseZ = new Float32Array(this.count);       // reference ground level (depends on slopeMode)
    this.zMin = new Float32Array(this.count);        // lowest / highest / mean ground under the footprint
    this.zMax = new Float32Array(this.count);
    this.zMean = new Float32Array(this.count);
    // Bottom of the extrusion above the reference level (OSM min_height): a
    // part that starts in the air, like a tower over a podium or a bridge.
    this.minH = new Float32Array(this.count);
    for (let i = 0; i < this.count; i++) {
      const b = Number(this.features[i].properties._b);
      this.minH[i] = Number.isFinite(b) && b > 0 ? b : 0;
    }
    this.slopeMode = app.slopeMode || 'lowest';
    this.chunks = [];
    this._build();
    this._groupGround();
    this._applySlopeMode();
    for (const c of this.chunks) { this._writePositions(c); this._writeColors(c); }
  }

  /** Parts of one building (same _grp) share one ground: the union of their footprints. */
  _groupGround() {
    const groups = new Map();
    for (let f = 0; f < this.count; f++) {
      const g = this.features[f].properties._grp;
      if (g === undefined || g === null || g === '') continue;
      let a = groups.get(g);
      if (!a) { a = { min: Infinity, max: -Infinity, sum: 0, n: 0, members: [] }; groups.set(g, a); }
      a.min = Math.min(a.min, this.zMin[f]);
      a.max = Math.max(a.max, this.zMax[f]);
      a.sum += this.zMean[f];
      a.n++;
      a.members.push(f);
    }
    for (const a of groups.values()) {
      if (a.n < 2) continue;
      for (const f of a.members) { this.zMin[f] = a.min; this.zMax[f] = a.max; this.zMean[f] = a.sum / a.n; }
    }
  }

  _applySlopeMode() {
    const src = this.slopeMode === 'highest' ? this.zMax : this.slopeMode === 'average' ? this.zMean : this.zMin;
    if (!this.isWall) this.baseZ.set(src);
  }

  /** Where a building stands on a slope: 'lowest' (buried uphill), 'average' or 'highest' (plinth downhill). */
  setSlopeMode(mode) {
    this.slopeMode = mode;
    this._applySlopeMode();
    this.applyHeights();
  }

  _build() {
    const terrain = this.app.terrain;
    let chunk = new Chunk();
    let inChunk = 0;
    const flush = () => {
      if (chunk.pos.length) this.chunks.push(this._makeMesh(chunk));
      chunk = new Chunk();
      inChunk = 0;
    };
    for (let f = 0; f < this.count; f++) {
      const geom = this.features[f].geometry;
      if (this.isWall) this._addWall(chunk, f, geom, terrain);
      else this._addPolygon(chunk, f, geom, terrain);
      if (++inChunk >= CHUNK_FEATURES) flush();
    }
    flush();
  }

  _addPolygon(chunk, f, geom, terrain) {
    const polys = ringsOf(geom).map((poly) => poly.map(openRing).filter((r) => r.length >= 3)).filter((p) => p.length);
    if (!polys.length) return;
    let zmin = Infinity, zmax = -Infinity, zsum = 0, area = 0, cx = 0, cy = 0, n = 0;
    for (const poly of polys) {
      for (const [x, y] of poly[0]) {
        const z = terrain.heightAt(x, y);
        zmin = Math.min(zmin, z); zmax = Math.max(zmax, z); zsum += z;
        cx += x; cy += y; n++;
      }
      area += Math.abs(signedArea(poly[0])) - poly.slice(1).reduce((s, h) => s + Math.abs(signedArea(h)), 0);
    }
    // Sample the centre too, so a footprint over a ridge or hollow has a fair mean.
    const zc = terrain.heightAt(cx / n, cy / n);
    this.zMin[f] = Math.min(zmin, zc);
    this.zMax[f] = Math.max(zmax, zc);
    this.zMean[f] = (zsum + zc) / (n + 1);
    this.baseZ[f] = this.zMin[f];
    this.footprint[f] = area;
    this.centroid[f * 2] = cx / n;
    this.centroid[f * 2 + 1] = cy / n;
    for (const poly of polys) {
      const outer = poly[0];
      const outerCcw = signedArea(outer) > 0;
      poly.forEach((ring, ri) => {
        // Outward normal of edge (dx, dy) is (dy, -dx) for a CCW ring; holes face inwards.
        const ccw = signedArea(ring) > 0;
        const flip = ri === 0 ? !ccw : ccw;
        for (let i = 0; i < ring.length; i++) {
          const [x0, y0] = ring[i];
          const [x1, y1] = ring[(i + 1) % ring.length];
          const dx = x1 - x0, dy = y1 - y0;
          const len = Math.hypot(dx, dy);
          if (len < 1e-6) continue;
          let nx = dy / len, ny = -dx / len;
          if (flip) { nx = -nx; ny = -ny; }
          this._quad(chunk, f, [x0, y0, terrain.heightAt(x0, y0)], [x1, y1, terrain.heightAt(x1, y1)], nx, ny);
        }
      });
      // Roof.
      const contour = outer.map(([x, y]) => new THREE.Vector2(x, y));
      const holes = poly.slice(1).map((h) => h.map(([x, y]) => new THREE.Vector2(x, y)));
      let tris;
      try {
        tris = THREE.ShapeUtils.triangulateShape(contour, holes);
      } catch {
        continue;
      }
      const all = contour.concat(...holes);
      const start = chunk.pos.length / 3;
      for (const p of all) {
        chunk.pos.push(p.x, 0, -p.y);
        chunk.nrm.push(0, 1, 0);
        chunk.feat.push(f); chunk.top.push(1); chunk.base.push(terrain.heightAt(p.x, p.y));
      }
      for (const t of tris) {
        // In (x, -y) the winding flips; emit so the face points up.
        const [a, b, c] = t;
        const ax = all[a].x, ay = all[a].y, bx = all[b].x, by = all[b].y, cx2 = all[c].x, cy2 = all[c].y;
        const ccwTri = (bx - ax) * (cy2 - ay) - (by - ay) * (cx2 - ax) > 0;
        if (ccwTri) chunk.index.push(start + a, start + b, start + c);
        else chunk.index.push(start + a, start + c, start + b);
      }
    }
  }

  _addWall(chunk, f, geom, terrain) {
    const lines = geom?.type === 'MultiLineString' ? geom.coordinates : geom?.type === 'LineString' ? [geom.coordinates] : [];
    const t = this.thickness / 2;
    let len = 0, cx = 0, cy = 0, n = 0;
    for (const line of lines) {
      for (let i = 0; i < line.length - 1; i++) {
        const [x0, y0] = line[i];
        const [x1, y1] = line[i + 1];
        const dx = x1 - x0, dy = y1 - y0;
        const l = Math.hypot(dx, dy);
        if (l < 1e-6) continue;
        len += l; cx += x0 + x1; cy += y0 + y1; n += 2;
        const nx = dy / l, ny = -dx / l;
        const z0 = terrain.heightAt(x0, y0), z1 = terrain.heightAt(x1, y1);
        // Two long faces, two end caps; a flat top.
        const p = [[x0 + nx * t, y0 + ny * t, z0], [x1 + nx * t, y1 + ny * t, z1], [x1 - nx * t, y1 - ny * t, z1], [x0 - nx * t, y0 - ny * t, z0]];
        this._quad(chunk, f, p[0], p[1], nx, ny);
        this._quad(chunk, f, p[2], p[3], -nx, -ny);
        this._quad(chunk, f, p[1], p[2], dx / l, dy / l);
        this._quad(chunk, f, p[3], p[0], -dx / l, -dy / l);
        const s = chunk.pos.length / 3;
        for (const q of p) { chunk.pos.push(q[0], 0, -q[1]); chunk.nrm.push(0, 1, 0); chunk.feat.push(f); chunk.top.push(1); chunk.base.push(q[2]); }
        chunk.index.push(s, s + 1, s + 2, s, s + 2, s + 3); // top cap faces up
      }
    }
    this.footprint[f] = len * this.thickness;
    if (n) { this.centroid[f * 2] = cx / n; this.centroid[f * 2 + 1] = cy / n; }
    this.baseZ[f] = n ? terrain.heightAt(cx / n, cy / n) : 0;
    this.zMin[f] = this.zMax[f] = this.zMean[f] = this.baseZ[f];
  }

  /** A vertical quad from p0 to p1 (each [x, y, baseZ]) facing (nx, ny). */
  _quad(chunk, f, p0, p1, nx, ny) {
    const s = chunk.pos.length / 3;
    const verts = [[p0, 0], [p1, 0], [p1, 1], [p0, 1]];
    for (const [p, top] of verts) {
      chunk.pos.push(p[0], 0, -p[1]);
      chunk.nrm.push(nx, 0, -ny);
      chunk.feat.push(f); chunk.top.push(top); chunk.base.push(p[2]);
    }
    // Choose the winding whose face normal matches (nx, 0, -ny).
    const ax = p0[0], az = -p0[1], bx = p1[0], bz = -p1[1];
    // Triangle (bottom0, bottom1, top1): normal ~ (b - a) x up.
    const ex = bx - ax, ez = bz - az;
    const cross = { x: -ez, z: ex }; // (ex, 0, ez) x (0, 1, 0) = (-ez, 0, ex)
    const outward = cross.x * nx + cross.z * -ny > 0;
    if (outward) chunk.index.push(s, s + 1, s + 2, s, s + 2, s + 3);
    else chunk.index.push(s, s + 2, s + 1, s, s + 3, s + 2);
  }

  _makeMesh(chunk) {
    const n = chunk.pos.length / 3;
    if (!this.chunkOf) this.chunkOf = new Int32Array(this.count).fill(-1);
    for (const f of chunk.feat) this.chunkOf[f] = this.chunks.length;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(chunk.pos), 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(chunk.nrm), 3));
    geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    // The ID pass reads the feature id and the layer index separately (viewer.js).
    const fkey = new Float32Array(n);
    const feat = Uint32Array.from(chunk.feat);
    for (let i = 0; i < n; i++) fkey[i] = feat[i] + 1;
    geom.setAttribute('fkey', new THREE.BufferAttribute(fkey, 1));
    geom.setAttribute('flayer', new THREE.BufferAttribute(new Float32Array(n).fill(this.index), 1));
    geom.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(chunk.index, 1) : new THREE.Uint16BufferAttribute(chunk.index, 1));
    const mesh = new THREE.Mesh(geom, this.material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.layers.enable(LAYER_OCCLUDER);
    mesh.layers.enable(LAYER_ID);
    if (!this.isWall) mesh.layers.enable(LAYER_SURFACE);
    mesh.userData = { feat, top: Uint8Array.from(chunk.top), base: Float32Array.from(chunk.base), layer: this };
    this.group.add(mesh);
    const c = { mesh, feat: mesh.userData.feat, top: mesh.userData.top, base: mesh.userData.base };
    this._writePositions(c);
    this._writeColors(c);
    return c;
  }

  _writePositions(c) {
    const terrain = this.app.terrain;
    const pos = c.mesh.geometry.attributes.position;
    const arr = pos.array;
    for (let i = 0; i < c.feat.length; i++) {
      const f = c.feat[i];
      const h = this.heights[f];
      if (this.isWall) {
        // Walls follow the ground along their length.
        arr[i * 3 + 1] = terrain.toY(c.base[i]) + (c.top[i] ? Math.max(0.05, h) : -SINK);
        continue;
      }
      const ref = terrain.toY(this.baseZ[f]);
      const top = ref + Math.max(0.05, h);
      if (c.top[i]) { arr[i * 3 + 1] = top; continue; }
      // Bottom: from min_height for a raised part, else down into the ground
      // at this vertex, which shows a plinth on the downhill side.
      const bottom = this.minH[f] > 0 ? ref + this.minH[f] : terrain.toY(c.base[i]) - SINK;
      arr[i * 3 + 1] = Math.min(bottom, top - 0.05);
    }
    pos.needsUpdate = true;
    c.mesh.geometry.computeBoundingBox();
    c.mesh.geometry.computeBoundingSphere();
  }

  _writeColors(c) {
    const col = c.mesh.geometry.attributes.color;
    const arr = col.array;
    // Layer colours are sRGB (as in QGIS); vertex colours are linear.
    for (let i = 0; i < c.feat.length; i++) {
      const f = c.feat[i];
      arr[i * 3] = srgbToLinear(this.colors[f * 3]);
      arr[i * 3 + 1] = srgbToLinear(this.colors[f * 3 + 1]);
      arr[i * 3 + 2] = srgbToLinear(this.colors[f * 3 + 2]);
    }
    col.needsUpdate = true;
  }

  applyColors() {
    for (const c of this.chunks) this._writeColors(c);
    this.app.viewer.requestRender();
  }

  applyHeights() {
    for (const c of this.chunks) this._writePositions(c);
    this.app.viewer.requestRender();
  }

  /** Rewrite only the chunks that hold the given features. */
  applyHeightsFor(features) {
    const touched = new Set();
    for (const f of features) if (this.chunkOf && this.chunkOf[f] >= 0) touched.add(this.chunkOf[f]);
    for (const i of touched) this._writePositions(this.chunks[i]);
    this.app.viewer.requestRender();
  }

  updateElevation() {
    this.applyHeights();
  }

  /** Bounding box of a feature in three coordinates (for focus). */
  featureCentre(f) {
    const x = this.centroid[f * 2], y = this.centroid[f * 2 + 1];
    return new THREE.Vector3(x, this.app.terrain.toY(this.baseZ[f]) + this.heights[f] / 2, -y);
  }
}

// ---------------------------------------------------------------- instanced points
export class PointLayer extends ObjectLayer {
  constructor(app, entry, index, data) {
    super(app, entry, index, data);
    this.isTree = entry.role === 'trees';
    this.points = [];   // [featureIndex, x, y]
    for (let f = 0; f < this.count; f++) {
      const g = this.features[f].geometry;
      const pts = g?.type === 'MultiPoint' ? g.coordinates : g?.type === 'Point' ? [g.coordinates] : [];
      for (const [x, y] of pts) this.points.push([f, x, y]);
    }
    const n = this.points.length;
    if (this.isTree) {
      const crownGeom = new THREE.IcosahedronGeometry(1, 1);
      const trunkGeom = new THREE.CylinderGeometry(0.12, 0.16, 1, 6);
      trunkGeom.translate(0, 0.5, 0);
      this.crowns = new THREE.InstancedMesh(crownGeom, new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }), n);
      this.trunks = new THREE.InstancedMesh(trunkGeom, new THREE.MeshStandardMaterial({ color: 0x6b5139, roughness: 0.9 }), n);
      for (const m of [this.crowns, this.trunks]) {
        m.castShadow = true;
        m.receiveShadow = true;
        m.layers.enable(LAYER_OCCLUDER);
        this.group.add(m);
      }
    } else {
      const geom = new THREE.CylinderGeometry(0.22, 0.26, 1, 8);
      geom.translate(0, 0.5, 0);
      this.poles = new THREE.InstancedMesh(geom, new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.3 }), n);
      this.poles.castShadow = true;
      this.poles.layers.enable(LAYER_OCCLUDER);
      this.group.add(this.poles);
    }
    this.applyHeights();
    this.applyColors();
  }

  crownRadius(h) {
    return Math.max(1.2, Math.min(7, h * 0.32));
  }

  applyHeights() {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const terrain = this.app.terrain;
    this.points.forEach(([f, x, y], i) => {
      const h = Math.max(0.5, this.heights[f]);
      const gy = terrain.groundY(x, y);
      if (this.isTree) {
        const r = this.crownRadius(h);
        const trunkH = Math.max(0.8, h - 1.6 * r);
        m.compose(new THREE.Vector3(x, gy, -y), q, new THREE.Vector3(1.4, trunkH + 0.4, 1.4));
        this.trunks.setMatrixAt(i, m);
        m.compose(new THREE.Vector3(x, gy + h - r, -y), q, new THREE.Vector3(r, r * 1.05, r));
        this.crowns.setMatrixAt(i, m);
      } else {
        m.compose(new THREE.Vector3(x, gy - 0.2, -y), q, new THREE.Vector3(1, h + 0.2, 1));
        this.poles.setMatrixAt(i, m);
      }
    });
    for (const mesh of [this.crowns, this.trunks, this.poles]) {
      if (!mesh) continue;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
    this.app.viewer.requestRender();
  }

  applyColors() {
    const target = this.isTree ? this.crowns : this.poles;
    const c = new THREE.Color();
    this.points.forEach(([f], i) => {
      c.setRGB(this.colors[f * 3], this.colors[f * 3 + 1], this.colors[f * 3 + 2], THREE.SRGBColorSpace);
      target.setColorAt(i, c);
    });
    if (target.instanceColor) target.instanceColor.needsUpdate = true;
    this.app.viewer.requestRender();
  }

  updateElevation() {
    this.applyHeights();
  }

  /** Obstacles for the wind model: [x, y, radius, height]. */
  obstacles() {
    return this.points.map(([f, x, y]) => [x, y, this.isTree ? this.crownRadius(this.heights[f]) : 0.3, this.heights[f]]);
  }
}

// ---------------------------------------------------------------- draped surfaces
export class SurfaceLayer extends ObjectLayer {
  constructor(app, entry, index, data) {
    super(app, entry, index, data);
    this.paintEntry = { features: this.features.map((f) => ({ geometry: polygonsOf(f.geometry) })), colors: this.colors, visible: true };
    app.terrain.addSurfaceLayer(this.paintEntry);
  }

  setVisible(on) {
    this.visible = on;
    this.paintEntry.visible = on;
    this.app.terrain.paint();
  }

  applyColors() {
    this.app.terrain.paint();
  }

  /** Feature index containing local point (x, y), or -1. */
  featureAt(x, y) {
    for (let f = this.count - 1; f >= 0; f--) {
      for (const poly of ringsOf(this.features[f].geometry)) {
        if (inPoly(x, y, poly)) return f;
      }
    }
    return -1;
  }
}

function polygonsOf(geom) {
  return { type: 'MultiPolygon', coordinates: ringsOf(geom) };
}

function inPoly(x, y, poly) {
  let inside = false;
  poly.forEach((ring, ri) => {
    let hit = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi) hit = !hit;
    }
    if (ri === 0) inside = hit; else if (hit) inside = false;
  });
  return inside;
}

// ---------------------------------------------------------------- platforms
export class PlatformLayer extends ObjectLayer {
  constructor(app, entry, index, data) {
    super(app, entry, index, data);
    this.material = new THREE.MeshStandardMaterial({ color: 0xc9a46b, transparent: true, opacity: 0.55, roughness: 0.8, side: THREE.DoubleSide, depthWrite: false });
    this.rings = this.features.map((f) => ringsOf(f.geometry).map((p) => openRing(p[0])).filter((r) => r.length >= 3));
    // A platform with no design level (0 or empty) gets the cut/fill-balancing level later.
    this.levels = Float32Array.from(this.heights);
    this._rebuild();
  }

  _rebuild() {
    for (const child of [...this.group.children]) { this.group.remove(child); /** @type {any} */ (child).geometry.dispose(); }
    const terrain = this.app.terrain;
    this.rings.forEach((rings, f) => {
      for (const ring of rings) {
        const shape = new THREE.Shape(ring.map(([x, y]) => new THREE.Vector2(x, y)));
        const geom = new THREE.ShapeGeometry(shape);
        geom.rotateX(-Math.PI / 2); // (x, y) plane -> (x, -z) ground plane
        const mesh = new THREE.Mesh(geom, this.material);
        const level = this.levels[f] > 0 ? this.levels[f] : terrain.heightAt(ring[0][0], ring[0][1]);
        mesh.position.y = terrain.toY(level) + 0.05;
        mesh.renderOrder = 3;
        this.group.add(mesh);
      }
    });
    this.app.viewer.requestRender();
  }

  setLevel(f, level) {
    this.levels[f] = level;
    this._rebuild();
  }

  updateElevation() {
    this._rebuild();
  }
}

// ---------------------------------------------------------------- section lines
export class LineLayer extends ObjectLayer {
  constructor(app, entry, index, data) {
    super(app, entry, index, data);
    this.lines = this.features.map((f) => {
      const g = f.geometry;
      return g?.type === 'MultiLineString' ? g.coordinates : g?.type === 'LineString' ? [g.coordinates] : [];
    });
    this._rebuild();
  }

  _rebuild() {
    for (const child of [...this.group.children]) { this.group.remove(child); /** @type {any} */ (child).geometry.dispose(); }
    const terrain = this.app.terrain;
    const step = Math.max(1, terrain.grid.cell / 2);
    const pos = [];
    for (const parts of this.lines) {
      for (const line of parts) {
        for (let i = 0; i < line.length - 1; i++) {
          const [x0, y0] = line[i], [x1, y1] = line[i + 1];
          const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
          for (let k = 0; k < n; k++) {
            const ax = x0 + ((x1 - x0) * k) / n, ay = y0 + ((y1 - y0) * k) / n;
            const bx = x0 + ((x1 - x0) * (k + 1)) / n, by = y0 + ((y1 - y0) * (k + 1)) / n;
            pos.push(ax, terrain.groundY(ax, ay) + 0.6, -ay, bx, terrain.groundY(bx, by) + 0.6, -by);
          }
        }
      }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const color = new THREE.Color().setRGB(this.colors[0] ?? 0.9, this.colors[1] ?? 0.35, this.colors[2] ?? 0.2);
    this.group.add(new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color, depthTest: true })));
    this.app.viewer.requestRender();
  }

  updateElevation() {
    this._rebuild();
  }
}

export function createLayer(app, entry, index, data) {
  switch (entry.role) {
    case 'buildings':
    case 'walls':
      return new ExtrudedLayer(app, entry, index, data);
    case 'trees':
    case 'poles':
      return new PointLayer(app, entry, index, data);
    case 'surfaces':
      return new SurfaceLayer(app, entry, index, data);
    case 'platforms':
      return new PlatformLayer(app, entry, index, data);
    case 'sections':
    case 'roads':
      return new LineLayer(app, entry, index, data);
    default:
      return null;
  }
}
