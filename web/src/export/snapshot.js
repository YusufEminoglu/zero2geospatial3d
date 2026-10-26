// @ts-check
// A baked, self-contained copy of what the viewer shows: terrain (thinned,
// with its painted texture and the active analysis drape), extrusions with
// their current colours (the drape baked into roof vertices), trees and
// poles, facade tiles and the flood surface. GLB and interactive HTML
// exports are both built from it.
import * as THREE from 'three';
import { ExtrudedLayer, PointLayer } from '../scene/objects.js';
import { overlayPixels, gridRect, overlayUniforms } from '../scene/overlay.js';
import { rampStops, rampColor } from '../core/classify.js';

const MAX_TERRAIN_VERTS_SIDE = 512;
const MAX_TEXTURE = 2048;

/**
 * @param {any} app
 * @param {{ area?: { minX: number, maxX: number, minY: number, maxY: number } | null }} [opts]
 */
export function bakeScene(app, { area = null } = {}) {
  const t = app.terrain;
  const g = t.grid;
  const a = area || app.sceneArea();
  const inArea = (x, y) => x >= a.minX && x <= a.maxX && y >= a.minY && y <= a.maxY;
  const r = app.activeResult?.grid ? app.activeResult : null;
  const opacity = overlayUniforms.uOverlayOpacity.value;
  const overlay = r ? { pixels: overlayPixels(r.grid, r.values, r.display), grid: r.grid } : null;

  // ---------------------------------------------------------- terrain
  const c0 = Math.max(0, Math.floor((a.minX - g.minX) / g.cell));
  const c1 = Math.min(g.cols - 1, Math.ceil((a.maxX - g.minX) / g.cell));
  const r0 = Math.max(0, Math.floor((g.maxY - a.maxY) / g.cell));
  const r1 = Math.min(g.rows - 1, Math.ceil((g.maxY - a.minY) / g.cell));
  const step = Math.max(1, Math.ceil(Math.max(c1 - c0, r1 - r0) / MAX_TERRAIN_VERTS_SIDE));
  const cs = [], rs = [];
  for (let c = c0; c < c1; c += step) cs.push(c);
  cs.push(c1);
  for (let rr = r0; rr < r1; rr += step) rs.push(rr);
  rs.push(r1);
  const nc = cs.length, nr = rs.length;
  const tPos = new Float32Array(nc * nr * 3);
  const tUv = new Float32Array(nc * nr * 2);
  for (let j = 0; j < nr; j++) {
    for (let i = 0; i < nc; i++) {
      const k = j * nc + i;
      tPos[k * 3] = g.minX + cs[i] * g.cell;
      tPos[k * 3 + 1] = t.toY(g.values[rs[j] * g.cols + cs[i]]);
      tPos[k * 3 + 2] = -(g.maxY - rs[j] * g.cell);
      // Vertices sit at cell centres; the texture spans whole cells c0..c1.
      tUv[k * 2] = (cs[i] - c0 + 0.5) / (c1 - c0 + 1);
      tUv[k * 2 + 1] = 1 - (rs[j] - r0 + 0.5) / (r1 - r0 + 1); // image row 0 = north
    }
  }
  const tIdx = new Uint32Array((nc - 1) * (nr - 1) * 6);
  let q = 0;
  for (let j = 0; j < nr - 1; j++) {
    for (let i = 0; i < nc - 1; i++) {
      const aa = j * nc + i, b = aa + 1, d = aa + nc, e = d + 1;
      tIdx[q++] = aa; tIdx[q++] = d; tIdx[q++] = b; tIdx[q++] = b; tIdx[q++] = d; tIdx[q++] = e;
    }
  }
  const terrainTexture = composeTerrainTexture(app, { c0, c1, r0, r1 }, overlay, opacity);

  // ---------------------------------------------------------- extrusions
  const meshes = [];
  const sampleOverlay = makeSampler(overlay);
  for (const layer of app.layers) {
    if (!(layer instanceof ExtrudedLayer) || !layer.visible) continue;
    for (const c of layer.chunks) {
      const geom = c.mesh.geometry;
      const pos = geom.attributes.position.array;
      const nrm = geom.attributes.normal.array;
      const col = geom.attributes.color.array;
      const idx = geom.index.array;
      const keep = new Int32Array(c.feat.length).fill(-1);
      let n = 0;
      for (let v = 0; v < c.feat.length; v++) {
        const f = c.feat[v];
        if (inArea(layer.centroid[f * 2], layer.centroid[f * 2 + 1])) keep[v] = n++;
      }
      if (!n) continue;
      const P = new Float32Array(n * 3), N = new Float32Array(n * 3), C = new Uint8Array(n * 3);
      const rgb = [0, 0, 0];
      for (let v = 0; v < keep.length; v++) {
        const k = keep[v];
        if (k < 0) continue;
        for (let m = 0; m < 3; m++) { P[k * 3 + m] = pos[v * 3 + m]; N[k * 3 + m] = nrm[v * 3 + m]; }
        rgb[0] = col[v * 3]; rgb[1] = col[v * 3 + 1]; rgb[2] = col[v * 3 + 2];
        if (overlay && !r.groundOnly && nrm[v * 3 + 1] > 0.55) {
          const o = sampleOverlay(pos[v * 3], -pos[v * 3 + 2]);
          if (o) for (let m = 0; m < 3; m++) rgb[m] = rgb[m] * (1 - opacity) + toLinear(o[m] / 255) * opacity;
        }
        for (let m = 0; m < 3; m++) C[k * 3 + m] = Math.round(toSrgb(rgb[m]) * 255);
      }
      const I = [];
      for (let i = 0; i < idx.length; i += 3) {
        const x = keep[idx[i]], y = keep[idx[i + 1]], z = keep[idx[i + 2]];
        if (x >= 0 && y >= 0 && z >= 0) I.push(x, y, z);
      }
      meshes.push({ name: layer.entry.name, positions: P, normals: N, colors: C, index: n > 65535 ? Uint32Array.from(I) : Uint16Array.from(I) });
    }
  }

  // ---------------------------------------------------------- trees and poles
  const instances = [];
  for (const layer of app.layers) {
    if (!(layer instanceof PointLayer) || !layer.visible) continue;
    const rows = [];
    for (const [f, x, y] of layer.points) {
      if (!inArea(x, y)) continue;
      const h = Math.max(0.5, layer.heights[f]);
      rows.push(x, t.groundY(x, y), -y, h, layer.isTree ? layer.crownRadius(h) : 0.25,
        layer.colors[f * 3], layer.colors[f * 3 + 1], layer.colors[f * 3 + 2]); // sRGB
    }
    if (rows.length) instances.push({ name: layer.entry.name, kind: layer.isTree ? 'tree' : 'pole', data: Float32Array.from(rows) });
  }

  // ---------------------------------------------------------- facade tiles
  let facade = null;
  const fr = app.activeResult?.facade && app.activeResult.showFacade !== false ? app.activeResult.facade : null;
  if (fr) {
    const stops = rampStops(fr.ramp);
    const keepIdx = [];
    for (let i = 0; i < fr.count; i++) if (inArea(fr.positions[i * 3], -fr.positions[i * 3 + 2])) keepIdx.push(i);
    const P = new Float32Array(keepIdx.length * 3), N = new Float32Array(keepIdx.length * 3), C = new Uint8Array(keepIdx.length * 3);
    const cc = [0, 0, 0];
    keepIdx.forEach((i, k) => {
      for (let m = 0; m < 3; m++) { P[k * 3 + m] = fr.positions[i * 3 + m]; N[k * 3 + m] = fr.normals[i * 3 + m]; }
      rampColor(stops, (fr.values[i] - fr.min) / Math.max(1e-9, fr.max - fr.min), cc);
      for (let m = 0; m < 3; m++) C[k * 3 + m] = Math.round(cc[m] * 255);
    });
    facade = { positions: P, normals: N, colors: C, size: fr.spacing * 0.94 };
  }

  // ---------------------------------------------------------- water
  let water = null;
  if (t.waterMesh) {
    const p = t.waterMesh.geometry.attributes.position.array;
    water = { positions: Float32Array.from(p) };
  }

  const cam = app.viewer.camera;
  return {
    format: 'geo3d-snapshot', version: 1,
    title: app.manifest.title,
    created: new Date().toISOString(),
    crs: app.manifest.crs.authid, origin: app.manifest.origin,
    terrain: { positions: tPos, uvs: tUv, index: tIdx, texture: terrainTexture },
    meshes, instances, facade, water,
    sun: app.viewer.sunDir.toArray(),
    camera: { position: cam.position.toArray(), target: app.viewer.controls.target.toArray(), fov: cam.fov },
    legend: legendOf(app),
    attribution: attributionOf(app)
  };
}

/** Terrain canvas cropped to the area, with the analysis drape drawn over it. */
function composeTerrainTexture(app, { c0, c1, r0, r1 }, overlay, opacity) {
  const t = app.terrain;
  const g = t.grid;
  const src = t.canvas;
  const sx = src.width / g.cols, sy = src.height / g.rows;
  const w = Math.min(MAX_TEXTURE, Math.max(2, Math.round((c1 - c0 + 1) * sx)));
  const h = Math.min(MAX_TEXTURE, Math.max(2, Math.round((r1 - r0 + 1) * sy)));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  ctx.drawImage(src, c0 * sx, r0 * sy, (c1 - c0 + 1) * sx, (r1 - r0 + 1) * sy, 0, 0, w, h);
  if (overlay) {
    const og = overlay.grid;
    const img = new ImageData(new Uint8ClampedArray(overlay.pixels.buffer), og.cols, og.rows);
    const oc = document.createElement('canvas');
    oc.width = og.cols;
    oc.height = og.rows;
    /** @type {CanvasRenderingContext2D} */ (oc.getContext('2d')).putImageData(img, 0, 0);
    const rect = gridRect(og);
    // Area pixel coordinates of the overlay rectangle.
    const ax0 = g.minX + (c0 - 0.5) * g.cell, ay0 = g.maxY - (r0 - 0.5) * g.cell;
    const pxPerM = w / ((c1 - c0 + 1) * g.cell);
    const pyPerM = h / ((r1 - r0 + 1) * g.cell);
    ctx.globalAlpha = opacity;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(oc, (rect.minX - ax0) * pxPerM, (ay0 - -rect.minZ) * pyPerM, (rect.maxX - rect.minX) * pxPerM, (rect.maxZ - rect.minZ) * pyPerM);
    ctx.globalAlpha = 1;
  }
  return canvas.toDataURL('image/jpeg', 0.9);
}

function makeSampler(overlay) {
  if (!overlay) return () => null;
  const g = overlay.grid;
  return (x, y) => {
    const c = Math.round((x - g.minX) / g.cell), r = Math.round((g.maxY - y) / g.cell);
    if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) return null;
    const i = (r * g.cols + c) * 4;
    return overlay.pixels[i + 3] ? [overlay.pixels[i], overlay.pixels[i + 1], overlay.pixels[i + 2]] : null;
  };
}

function legendOf(app) {
  const r = app.activeResult;
  if (r) {
    if (r.legend) return { title: r.title, items: r.legend };
    if (r.display?.categorical) return { title: r.title, items: [] };
    const stops = rampStops(r.display.ramp).map((s) => `#${s.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`);
    return { title: r.title, ramp: stops, min: r.display.min, max: r.display.max, unit: r.unit || '' };
  }
  return app.layerLegend || null;
}

function attributionOf(app) {
  const names = app.layers.map((l) => l.entry.name.toLowerCase()).join(' ');
  const parts = ['02 Geo3D Analyzer'];
  if (names.includes('osm')) parts.push('Map data © OpenStreetMap contributors');
  if (app.manifest.terrain?.source) parts.push(`Terrain: ${app.manifest.terrain.source}`);
  return parts.join(' · ');
}

function toSrgb(v) { return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055; }
function toLinear(v) { return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }

/** Typed arrays <-> base64 for embedding. */
export function toBase64(arr) {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  return btoa(s);
}
