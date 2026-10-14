// @ts-check
// Analysis drape: a result grid shown on every upward-facing surface (ground
// and roofs) by sampling a texture at the fragment's world position. Patched
// into MeshStandardMaterial with onBeforeCompile so terrain and buildings
// share one overlay.
import * as THREE from 'three';
import { rampStops, rampColor } from '../core/classify.js';

const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
blank.needsUpdate = true;

export const overlayUniforms = {
  uOverlay: { value: /** @type {THREE.Texture} */ (blank) },
  uOverlayRect: { value: new THREE.Vector4(0, 1, 0, 1) }, // minX, maxX, minZ, maxZ
  uOverlayOn: { value: 0 },
  uOverlayOpacity: { value: 0.92 }
};

/** Make a MeshStandardMaterial show the shared overlay. */
export function patchMaterial(material) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, overlayUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vOvWorld;\nvarying float vOvNy;')
      .replace('#include <project_vertex>', `#include <project_vertex>
  vOvWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vOvNy = normalize(mat3(modelMatrix) * objectNormal).y;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vOvWorld;
varying float vOvNy;
uniform sampler2D uOverlay;
uniform vec4 uOverlayRect;
uniform float uOverlayOn;
uniform float uOverlayOpacity;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
  vec4 ovSample = vec4(0.0);
  if (uOverlayOn > 0.5 && vOvNy > 0.55) {
    vec2 ouv = vec2((vOvWorld.x - uOverlayRect.x) / (uOverlayRect.y - uOverlayRect.x),
                    (vOvWorld.z - uOverlayRect.z) / (uOverlayRect.w - uOverlayRect.z));
    if (ouv.x >= 0.0 && ouv.x <= 1.0 && ouv.y >= 0.0 && ouv.y <= 1.0) {
      ovSample = texture2D(uOverlay, ouv);
      ovSample.a *= uOverlayOpacity;
      diffuseColor.rgb = mix(diffuseColor.rgb, ovSample.rgb, ovSample.a);
    }
  }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  totalEmissiveRadiance = mix(totalEmissiveRadiance, ovSample.rgb * 0.38, ovSample.a);`);
  };
  material.customProgramCacheKey = () => 'g3d-overlay';
  return material;
}

/**
 * Show a grid result. grid: { cols, rows, cell, minX, maxY } (local x east,
 * y north, cell centres), values row-major from the north-west.
 */
/** RGBA pixels (row 0 = north) for a result grid, as drawn on the map. */
export function overlayPixels(grid, values, { min, max, ramp = 'viridis', classes = null, categorical = null } = {}) {
  const { cols, rows } = grid;
  const data = new Uint8Array(cols * rows * 4);
  const stops = rampStops(ramp);
  const c = [0, 0, 0];
  const span = max - min || 1;
  for (let i = 0; i < cols * rows; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    if (categorical) {
      const hex = categorical[v];
      if (!hex) continue;
      const n = parseInt(hex.slice(1), 16);
      data[i * 4] = (n >> 16) & 255; data[i * 4 + 1] = (n >> 8) & 255; data[i * 4 + 2] = n & 255; data[i * 4 + 3] = 255;
      continue;
    }
    let t = (v - min) / span;
    if (classes) t = (Math.min(classes - 1, Math.floor(Math.max(0, Math.min(0.9999, t)) * classes)) + 0.5) / classes;
    rampColor(stops, t, c);
    data[i * 4] = c[0] * 255; data[i * 4 + 1] = c[1] * 255; data[i * 4 + 2] = c[2] * 255; data[i * 4 + 3] = 255;
  }
  return data;
}

/** Cell-edge bounds of a grid in three coordinates (x east, z = -north). */
export function gridRect(grid) {
  const minX = grid.minX - grid.cell / 2;
  const maxX = grid.minX + (grid.cols - 0.5) * grid.cell;
  const northY = grid.maxY + grid.cell / 2;
  const southY = grid.maxY - (grid.rows - 0.5) * grid.cell;
  return { minX, maxX, minZ: -northY, maxZ: -southY };
}

/**
 * Show a grid result. grid: { cols, rows, cell, minX, maxY } (local x east,
 * y north, cell centres), values row-major from the north-west.
 */
export function showOverlay(grid, values, display = {}) {
  const { cols, rows } = grid;
  const data = overlayPixels(grid, values, display);
  const tex = new THREE.DataTexture(data, cols, rows, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  const old = overlayUniforms.uOverlay.value;
  if (old !== blank && !old.userData.cached) old.dispose();
  overlayUniforms.uOverlay.value = tex;
  const r = gridRect(grid);
  overlayUniforms.uOverlayRect.value.set(r.minX, r.maxX, r.minZ, r.maxZ);
  overlayUniforms.uOverlayOn.value = 1;
}

/** A result's drape texture, built once and kept on the result (compare views switch between them). */
export function resultTexture(result) {
  if (result._tex) return result._tex;
  const { cols, rows } = result.grid;
  const tex = new THREE.DataTexture(overlayPixels(result.grid, result.values, result.display), cols, rows, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.userData.cached = true;
  tex.needsUpdate = true;
  result._tex = tex;
  return tex;
}

/** Drape a cached texture (no copy, no dispose). */
export function useOverlay(tex, grid) {
  overlayUniforms.uOverlay.value = tex;
  const r = gridRect(grid);
  overlayUniforms.uOverlayRect.value.set(r.minX, r.maxX, r.minZ, r.maxZ);
  overlayUniforms.uOverlayOn.value = 1;
}

export function hideOverlay() {
  overlayUniforms.uOverlayOn.value = 0;
}

export function setOverlayOpacity(v) {
  overlayUniforms.uOverlayOpacity.value = v;
}
