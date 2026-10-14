// @ts-check
// GPU exposure engine.
//
// Samples are either the top surface of the scene seen from straight above
// (a height field: ground and roofs, one per texel) or an explicit list of
// points with normals (building facades). For each direction (sun position,
// sky direction) a depth map is rendered from that direction, like a shadow
// map, and a full-screen pass adds the direction's weight to every sample
// the depth map shows as unobstructed. Viewsheds use six perspective views
// from the observer instead. One read-back returns all samples.
//
// Output channels: R = sum of weight x visibility x cosine term,
//                  G = sum of weight x cosine term (the unobstructed potential).
// Cosine modes: 0 none, 1 weight by max(0, n.d), 2 gate (count only n.d > 0).
//
// Large areas are split into tiles so every tile keeps its own depth maps
// sharp; each tile's depth cameras cover the tile plus a margin for distant
// occluders.
import * as THREE from 'three';
import { LAYER_SURFACE, LAYER_OCCLUDER, LAYER_ID, makeIdMaterial, decodeKey } from '../scene/viewer.js';

const FULLSCREEN_VERTEX = `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const ACCUMULATE_FRAGMENT = `
precision highp float;
#include <packing>
varying vec2 vUv;
uniform sampler2D tHeight;
uniform sampler2D tPos;
uniform sampler2D tNrm;
uniform float uPoints;
uniform sampler2D tDepth;
uniform mat4 uTopInvViewProj;
uniform mat4 uDirViewProj;
uniform vec3 uDir;
uniform vec3 uNormal;
uniform float uCosMode;
uniform float uWeight;
uniform float uBias;
uniform float uLift;
uniform float uPerspective;
uniform mat4 uDirView;
uniform vec3 uEye;
uniform float uNear;
uniform float uFar;
uniform float uBiasMeters;
uniform float uMaxDistance;
void main() {
  vec3 world;
  vec3 n;
  if (uPoints > 0.5) {
    vec4 p = texture2D(tPos, vUv);
    if (p.w < 0.5) discard;
    world = p.xyz;
    n = normalize(texture2D(tNrm, vUv).xyz);
  } else {
    float d = texture2D(tHeight, vUv).r;
    if (d <= 0.0) discard;
    vec4 w = uTopInvViewProj * vec4(vUv * 2.0 - 1.0, (1.0 - d) * 2.0 - 1.0, 1.0);
    world = w.xyz / w.w;
    n = uNormal;
  }
  world += n * uLift;
  if (uPerspective > 0.5) {
    vec4 clip = uDirViewProj * vec4(world, 1.0);
    if (clip.w <= 0.0) discard;
    vec3 pndc = clip.xyz / clip.w;
    vec2 puv = pndc.xy * 0.5 + 0.5;
    if (puv.x < 0.0 || puv.x > 1.0 || puv.y < 0.0 || puv.y > 1.0 || pndc.z > 1.0) discard;
    float dist = length(world - uEye);
    if (dist > uMaxDistance) discard;
    float selfDepth = -(uDirView * vec4(world, 1.0)).z;
    float occ = 1.0 - texture2D(tDepth, puv).r;
    float occDepth = occ >= 1.0 ? 1e9 : -perspectiveDepthToViewZ(occ, uNear, uFar);
    float seen = selfDepth <= occDepth + uBiasMeters ? 1.0 : 0.0;
    // A surface seen edge-on or from behind does not count as visible.
    if (uPoints > 0.5 && dot(n, uEye - world) <= 0.0) seen = 0.0;
    gl_FragColor = vec4(uWeight * seen, uWeight, 0.0, 1.0);
    return;
  }
  float c = dot(n, uDir);
  float cosf = uCosMode > 1.5 ? (c > 0.0 ? 1.0 : 0.0) : (uCosMode > 0.5 ? max(c, 0.0) : 1.0);
  if (cosf <= 0.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec4 clip = uDirViewProj * vec4(world, 1.0);
  vec3 ndc = clip.xyz / clip.w;
  vec2 duv = ndc.xy * 0.5 + 0.5;
  float lit = 1.0;
  if (duv.x >= 0.0 && duv.x <= 1.0 && duv.y >= 0.0 && duv.y <= 1.0) {
    float occluder = 1.0 - texture2D(tDepth, duv).r;
    float self = ndc.z * 0.5 + 0.5;
    lit = self <= occluder + uBias ? 1.0 : 0.0;
  }
  gl_FragColor = vec4(uWeight * lit * cosf, uWeight * cosf, 0.0, 1.0);
}`;

export class GpuEngine {
  /** @param {THREE.WebGLRenderer} renderer */
  constructor(renderer) {
    this.renderer = renderer;
    const gl = renderer.getContext();
    this.floatOk = renderer.extensions.has('EXT_color_buffer_float') && renderer.extensions.has('EXT_float_blend');
    this.type = this.floatOk ? THREE.FloatType : THREE.HalfFloatType;
    this.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.BasicDepthPacking, side: THREE.DoubleSide });
    this.idMaterial = makeIdMaterial();
    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const blank = new THREE.DataTexture(new Float32Array(4), 1, 1, THREE.RGBAFormat, THREE.FloatType);
    blank.needsUpdate = true;
    this.accumulate = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: ACCUMULATE_FRAGMENT,
      uniforms: {
        tHeight: { value: blank }, tPos: { value: blank }, tNrm: { value: blank }, uPoints: { value: 0 },
        tDepth: { value: null }, uTopInvViewProj: { value: new THREE.Matrix4() }, uDirViewProj: { value: new THREE.Matrix4() },
        uDir: { value: new THREE.Vector3(0, 1, 0) }, uNormal: { value: new THREE.Vector3(0, 1, 0) }, uCosMode: { value: 0 },
        uWeight: { value: 1 }, uBias: { value: 0.0005 }, uLift: { value: 0.3 }, uPerspective: { value: 0 },
        uDirView: { value: new THREE.Matrix4() }, uEye: { value: new THREE.Vector3() }, uNear: { value: 0.5 },
        uFar: { value: 1000 }, uBiasMeters: { value: 0.6 }, uMaxDistance: { value: 1e9 }
      },
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      depthTest: false,
      depthWrite: false
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.accumulate);
    quad.frustumCulled = false;
    this.quadScene.add(quad);
  }

  _target(w, h, type = this.type) {
    return new THREE.WebGLRenderTarget(w, h, {
      type, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true
    });
  }

  _render(scene, camera, target, material, layer) {
    const r = this.renderer;
    const prev = { override: scene.overrideMaterial, bg: scene.background, target: r.getRenderTarget(),
      clear: r.getClearColor(new THREE.Color()), alpha: r.getClearAlpha(), mask: camera.layers.mask, shadow: r.shadowMap.autoUpdate };
    scene.overrideMaterial = material;
    scene.background = null;
    camera.layers.set(layer);
    r.shadowMap.autoUpdate = false;
    r.setRenderTarget(target);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, false);
    r.render(scene, camera);
    r.setRenderTarget(prev.target);
    r.setClearColor(prev.clear, prev.alpha);
    r.shadowMap.autoUpdate = prev.shadow;
    camera.layers.mask = prev.mask;
    scene.overrideMaterial = prev.override;
    scene.background = prev.bg;
  }

  _readChannels(target, w, h, channels) {
    const n = w * h;
    const raw = this.type === THREE.FloatType ? new Float32Array(n * 4) : new Uint16Array(n * 4);
    this.renderer.readRenderTargetPixels(target, 0, 0, w, h, raw);
    const out = channels.map(() => new Float32Array(n));
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < channels.length; k++) {
        const v = raw[i * 4 + channels[k]];
        out[k][i] = this.type === THREE.FloatType ? v : THREE.DataUtils.fromHalfFloat(v);
      }
    }
    return out;
  }

  /** Top camera looking straight down over a tile, north (-z) up. */
  _topCamera(tile) {
    const cx = (tile.minX + tile.maxX) / 2;
    const cz = (tile.minZ + tile.maxZ) / 2;
    const hx = (tile.maxX - tile.minX) / 2;
    const hz = (tile.maxZ - tile.minZ) / 2;
    const top = tile.maxY + 50;
    const cam = new THREE.OrthographicCamera(-hx, hx, hz, -hz, 1, top - tile.minY + 100);
    cam.position.set(cx, top, cz);
    cam.up.set(0, 0, -1);
    cam.lookAt(cx, tile.minY, cz);
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();
    return cam;
  }

  /** Feature key per texel of a tile (row 0 = north), 0 where no feature. */
  idGrid(scene, tile, cols, rows) {
    const cam = this._topCamera(tile);
    const target = this._target(cols, rows, THREE.UnsignedByteType);
    this._render(scene, cam, target, this.idMaterial, LAYER_ID);
    const raw = new Uint8Array(cols * rows * 4);
    this.renderer.readRenderTargetPixels(target, 0, 0, cols, rows, raw);
    target.dispose();
    const out = new Int32Array(cols * rows);
    for (let y = 0; y < rows; y++) {
      const src = (rows - 1 - y) * cols;
      for (let x = 0; x < cols; x++) {
        const i = (src + x) * 4;
        out[y * cols + x] = raw[i + 3] ? decodeKey(raw[i], raw[i + 1], raw[i + 2]) : 0;
      }
    }
    return out;
  }

  /**
   * Run one tile.
   * @param {object} a
   * @param {THREE.Scene} a.scene
   * @param {{ minX: number, maxX: number, minZ: number, maxZ: number, minY: number, maxY: number }} a.tile
   * @param {number} a.cols texels across (heightfield mode)
   * @param {number} a.rows texels down
   * @param {{ dir: number[], weight: number }[]} [a.directions]
   * @param {number} [a.cosMode]
   * @param {number[]} [a.normal] normal of heightfield samples
   * @param {number} [a.lift] metres the sample is lifted along its normal
   * @param {{ positions: Float32Array, normals: Float32Array, count: number }} [a.points] point mode
   * @param {THREE.Vector3} [a.eye] viewshed mode
   * @param {number} [a.maxDistance]
   * @param {number} [a.margin] metres of occluders around the tile
   * @param {number} [a.depthResolution]
   * @param {(f: number) => void} [a.onProgress]
   */
  async run({ scene, tile, cols, rows, directions = [], cosMode = 0, normal = [0, 1, 0], lift = 0.3, points = null,
    eye = null, maxDistance = 1000, margin = 200, depthResolution = 2048, onProgress }) {
    const r = this.renderer;
    const u = this.accumulate.uniforms;
    let w = cols, h = rows;
    let heightTarget = null;
    let posTex = null, nrmTex = null;
    let topInv = null;
    if (points) {
      w = Math.min(this.maxTexture, Math.ceil(Math.sqrt(points.count)));
      h = Math.ceil(points.count / w);
      const pos = new Float32Array(w * h * 4);
      const nrm = new Float32Array(w * h * 4);
      for (let i = 0; i < points.count; i++) {
        pos.set([points.positions[i * 3], points.positions[i * 3 + 1], points.positions[i * 3 + 2], 1], i * 4);
        nrm.set([points.normals[i * 3], points.normals[i * 3 + 1], points.normals[i * 3 + 2], 0], i * 4);
      }
      posTex = new THREE.DataTexture(pos, w, h, THREE.RGBAFormat, THREE.FloatType);
      nrmTex = new THREE.DataTexture(nrm, w, h, THREE.RGBAFormat, THREE.FloatType);
      posTex.needsUpdate = true;
      nrmTex.needsUpdate = true;
      u.tPos.value = posTex;
      u.tNrm.value = nrmTex;
      u.uPoints.value = 1;
    } else {
      const topCam = this._topCamera(tile);
      heightTarget = this._target(cols, rows);
      this._render(scene, topCam, heightTarget, this.depthMaterial, LAYER_SURFACE);
      topInv = new THREE.Matrix4().multiplyMatrices(topCam.projectionMatrix, topCam.matrixWorldInverse).invert();
      u.tHeight.value = heightTarget.texture;
      u.uTopInvViewProj.value.copy(topInv);
      u.uPoints.value = 0;
    }
    const dSize = Math.min(depthResolution, this.maxTexture);
    const depthTarget = this._target(dSize, dSize);
    const accum = this._target(w, h);
    const prevTarget = r.getRenderTarget();
    r.setRenderTarget(accum);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, false);
    r.setRenderTarget(prevTarget);

    const cx = (tile.minX + tile.maxX) / 2;
    const cz = (tile.minZ + tile.maxZ) / 2;
    const half = Math.max(tile.maxX - tile.minX, tile.maxZ - tile.minZ) / 2 + margin;
    const radius = Math.hypot(half, half, (tile.maxY - tile.minY) / 2) + 20;
    const centre = new THREE.Vector3(cx, (tile.minY + tile.maxY) / 2, cz);
    const dirCam = new THREE.OrthographicCamera(-radius, radius, radius, -radius, 1, 4 * radius);
    u.tDepth.value = depthTarget.texture;
    u.uNormal.value.set(normal[0], normal[1], normal[2]).normalize();
    u.uCosMode.value = cosMode;
    u.uLift.value = lift;
    // About 1 m of depth bias, more where depth texels are coarse.
    u.uBias.value = Math.max(1, ((2 * radius) / dSize) * 2) / (4 * radius);

    const views = [];
    if (eye) {
      const faces = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
      for (const [x, y, z] of faces) {
        const cam = new THREE.PerspectiveCamera(90, 1, 0.3, maxDistance * 1.8);
        cam.position.copy(eye);
        cam.up.set(0, 1, 0);
        if (y !== 0) cam.up.set(0, 0, -1);
        cam.lookAt(eye.x + x, eye.y + y, eye.z + z);
        cam.updateMatrixWorld();
        cam.updateProjectionMatrix();
        views.push({ camera: cam, weight: 1 });
      }
      u.uEye.value.copy(eye);
    } else {
      for (const d of directions) views.push(d);
    }
    u.uPerspective.value = eye ? 1 : 0;
    u.uMaxDistance.value = eye ? maxDistance : 1e9;
    for (let i = 0; i < views.length; i++) {
      const view = views[i];
      let cam = view.camera;
      if (!cam) {
        const d = new THREE.Vector3(view.dir[0], view.dir[1], view.dir[2]).normalize();
        cam = dirCam;
        dirCam.position.copy(centre).addScaledVector(d, 2 * radius);
        dirCam.up.set(0, 1, 0);
        if (Math.abs(d.y) > 0.99) dirCam.up.set(0, 0, -1);
        dirCam.lookAt(centre);
        dirCam.updateMatrixWorld();
        u.uDir.value.copy(d);
      }
      this._render(scene, cam, depthTarget, this.depthMaterial, LAYER_OCCLUDER);
      u.uDirViewProj.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      u.uDirView.value.copy(cam.matrixWorldInverse);
      u.uNear.value = cam.near;
      u.uFar.value = cam.far;
      u.uWeight.value = view.weight;
      const before = r.getRenderTarget();
      const autoClear = r.autoClear;
      r.autoClear = false;
      r.setRenderTarget(accum);
      r.render(this.quadScene, this.quadCamera);
      r.setRenderTarget(before);
      r.autoClear = autoClear;
      if (onProgress && (i % 6 === 5 || i === views.length - 1)) {
        onProgress((i + 1) / views.length);
        await new Promise((res) => setTimeout(res, 0));
      }
    }
    const [valuesRaw, potentialRaw] = this._readChannels(accum, w, h, [0, 1]);
    let heights = null;
    let values = valuesRaw;
    let potential = potentialRaw;
    if (!points) {
      // Render-target rows start in the south: flip to north-first.
      values = flipRows(valuesRaw, w, h);
      potential = flipRows(potentialRaw, w, h);
      const [hRaw] = this._readChannels(heightTarget, w, h, [0]);
      heights = new Float32Array(w * h);
      const p = new THREE.Vector4();
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const d = hRaw[(h - 1 - y) * w + x];
          if (d > 0) {
            p.set(((x + 0.5) / w) * 2 - 1, ((h - 1 - y + 0.5) / h) * 2 - 1, (1 - d) * 2 - 1, 1).applyMatrix4(/** @type {THREE.Matrix4} */ (topInv));
            heights[y * w + x] = p.y / p.w;
          } else heights[y * w + x] = NaN;
        }
      }
      heightTarget?.dispose();
    } else {
      values = valuesRaw.subarray(0, points.count);
      potential = potentialRaw.subarray(0, points.count);
      posTex?.dispose();
      nrmTex?.dispose();
    }
    accum.dispose();
    depthTarget.dispose();
    return { values, potential, heights };
  }

  dispose() {
    this.depthMaterial.dispose();
    this.idMaterial.dispose();
    this.accumulate.dispose();
  }
}

function flipRows(src, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) out.set(src.subarray((h - 1 - y) * w, (h - y) * w), y * w);
  return out;
}

/**
 * Split an analysis area into tiles of at most maxCells texels a side.
 * area: { minX, maxX, minY(north-south local y), maxY } in local metres
 * (x east, y north). Returns grid info and tiles with three-coordinate
 * bounds and their offsets into the full grid.
 */
export function planTiles(area, cell, maxCells = 1024) {
  const cols = Math.max(1, Math.ceil((area.maxX - area.minX) / cell));
  const rows = Math.max(1, Math.ceil((area.maxY - area.minY) / cell));
  const grid = { cols, rows, cell, minX: area.minX + cell / 2, maxY: area.maxY - cell / 2 };
  const tiles = [];
  for (let r0 = 0; r0 < rows; r0 += maxCells) {
    for (let c0 = 0; c0 < cols; c0 += maxCells) {
      const tc = Math.min(maxCells, cols - c0);
      const tr = Math.min(maxCells, rows - r0);
      const minX = area.minX + c0 * cell;
      const northY = area.maxY - r0 * cell;
      tiles.push({ c0, r0, cols: tc, rows: tr,
        bounds: { minX, maxX: minX + tc * cell, minZ: -northY, maxZ: -(northY - tr * cell) } });
    }
  }
  return { grid, tiles };
}
