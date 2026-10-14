// @ts-check
// Renderer, camera, controls, lights and the render-on-demand loop.
//
// Axes: +x east, +y up, -z north (local scene metres). Three.js object
// layers decide what each analysis pass sees:
//   0 visible     drawn on screen
//   1 SURFACE     surfaces analysed from above (terrain, roofs)
//   2 OCCLUDER    everything that blocks sun, sky or view (adds trees, walls)
//   3 ID          features that carry a feature key (for per-feature results)
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export const LAYER_SURFACE = 1;
export const LAYER_OCCLUDER = 2;
export const LAYER_ID = 3;

const ID_VERTEX = `
attribute float fkey;
varying float vKey;
#include <common>
void main() {
  vKey = fkey;
  #include <begin_vertex>
  #include <project_vertex>
}`;
const ID_FRAGMENT = `
precision highp float;
varying float vKey;
void main() {
  float k = floor(vKey + 0.5);
  float r = floor(k / 65536.0);
  float g = floor((k - r * 65536.0) / 256.0);
  float b = k - r * 65536.0 - g * 256.0;
  gl_FragColor = vec4(r / 255.0, g / 255.0, b / 255.0, 1.0);
}`;

export function makeIdMaterial() {
  return new THREE.ShaderMaterial({ vertexShader: ID_VERTEX, fragmentShader: ID_FRAGMENT, side: THREE.DoubleSide });
}

export function decodeKey(r, g, b) {
  return r * 65536 + g * 256 + b;
}

export class Viewer {
  /** @param {HTMLElement} container */
  constructor(container) {
    this.container = container;
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, logarithmicDepthBuffer: false });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xdfe8f0);
    this.camera = new THREE.PerspectiveCamera(45, container.clientWidth / Math.max(1, container.clientHeight), 1, 60000);
    this.camera.position.set(400, 500, 600);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener('change', () => this.requestRender());

    this.hemi = new THREE.HemisphereLight(0xeaf2ff, 0x8a8174, 1.2);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff4e0, 2.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.sunDir = new THREE.Vector3(0.3, 0.8, -0.4).normalize();
    this.shadowsOn = true;

    this.world = new THREE.Group();
    this.scene.add(this.world);
    this.helpers = new THREE.Group();
    this.scene.add(this.helpers);

    this.idMaterial = makeIdMaterial();
    this._pickTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.UnsignedByteType });
    this._dirty = true;
    this._frameHooks = [];
    this.extentRadius = 1000;
    this.stats = { fps: 0, frames: 0, last: performance.now(), drawCalls: 0, triangles: 0 };

    window.addEventListener('resize', () => this.resize());
    if ('ResizeObserver' in window) new ResizeObserver(() => this.resize()).observe(container);
    renderer.setAnimationLoop(() => this._loop());
  }

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  requestRender() {
    this._dirty = true;
  }

  onFrame(fn) {
    this._frameHooks.push(fn);
  }

  _loop() {
    const moved = this.controls.update();
    for (const fn of this._frameHooks) if (fn()) this._dirty = true;
    if (!this._dirty && !moved) return;
    this._dirty = false;
    this._fitShadow();
    this.renderer.render(this.scene, this.camera);
    const s = this.stats;
    s.frames++;
    s.drawCalls = this.renderer.info.render.calls;
    s.triangles = this.renderer.info.render.triangles;
    const now = performance.now();
    if (now - s.last > 1000) { s.fps = (s.frames * 1000) / (now - s.last); s.frames = 0; s.last = now; }
  }

  /** Sun direction (unit vector towards the sun) and whether it is up. */
  setSun(dir) {
    this.sunDir.set(dir[0], dir[1], dir[2]).normalize();
    const up = this.sunDir.y > 0.005;
    this.sun.visible = up;
    // Dimmer, warmer light near the horizon; sky ambience follows.
    const elev = Math.asin(Math.max(-1, Math.min(1, this.sunDir.y)));
    const k = Math.max(0, Math.min(1, elev / 0.5));
    this.sun.intensity = up ? 0.6 + 2.0 * k : 0;
    this.sun.color.setRGB(1, 0.82 + 0.16 * k, 0.62 + 0.3 * k);
    this.hemi.intensity = 0.35 + 0.9 * Math.max(0, Math.min(1, (elev + 0.1) / 0.6));
    const sky = new THREE.Color().setRGB(0.55 + 0.33 * k, 0.62 + 0.29 * k, 0.72 + 0.22 * k);
    if (!up) sky.setRGB(0.16, 0.19, 0.26);
    this.scene.background = sky;
    this.requestRender();
  }

  setShadows(on) {
    this.shadowsOn = on;
    this.sun.castShadow = on;
    this.requestRender();
  }

  /** Fit the sun's shadow camera around the area the camera looks at. */
  _fitShadow() {
    if (!this.sun.visible || !this.shadowsOn) return;
    const target = this.controls.target;
    const dist = this.camera.position.distanceTo(target);
    const r = Math.max(120, Math.min(this.extentRadius, dist * 1.2));
    const cam = this.sun.shadow.camera;
    cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
    cam.near = 1; cam.far = 4 * r + 2000;
    cam.updateProjectionMatrix();
    this.sun.position.copy(target).addScaledVector(this.sunDir, 2 * r + 800);
    this.sun.target.position.copy(target);
    this.sun.target.updateMatrixWorld();
    // Bias in proportion to the shadow-map texel: enough to avoid acne, small
    // enough that shadows still touch the walls that cast them up close.
    this.sun.shadow.normalBias = Math.min(1.5, Math.max(0.03, ((2 * r) / 4096) * 0.8));
  }

  /** Frame a box (three coordinates). */
  frame(box, { pitch = 0.9, yaw = -0.6 } = {}) {
    const centre = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(50, Math.hypot(size.x, size.z) / 2);
    this.extentRadius = Math.max(300, radius * 1.4);
    const dist = radius / Math.tan((this.camera.fov * Math.PI) / 360) * 0.9;
    this.controls.target.copy(centre);
    this.camera.position.set(centre.x + Math.sin(yaw) * Math.cos(pitch) * dist,
      centre.y + Math.sin(pitch) * dist, centre.z + Math.cos(yaw) * Math.cos(pitch) * dist);
    this.camera.near = Math.max(0.5, dist / 2000);
    this.camera.far = Math.max(20000, dist * 20);
    this.camera.updateProjectionMatrix();
    this.controls.maxDistance = dist * 6;
    this.controls.update();
    this.requestRender();
  }

  /** Feature key under a screen position (client pixels), 0 for none. */
  pickKey(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const w = rect.width;
    const h = rect.height;
    const cam = this.camera;
    cam.setViewOffset(w, h, Math.floor(x), Math.floor(y), 1, 1);
    const prevBg = this.scene.background;
    const prevOverride = this.scene.overrideMaterial;
    const prevMask = cam.layers.mask;
    this.scene.background = null;
    this.scene.overrideMaterial = this.idMaterial;
    cam.layers.set(LAYER_ID);
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const clear = r.getClearColor(new THREE.Color());
    const alpha = r.getClearAlpha();
    r.setRenderTarget(this._pickTarget);
    r.setClearColor(0x000000, 0);
    r.clear();
    r.render(this.scene, cam);
    const px = new Uint8Array(4);
    r.readRenderTargetPixels(this._pickTarget, 0, 0, 1, 1, px);
    r.setRenderTarget(prevTarget);
    r.setClearColor(clear, alpha);
    cam.clearViewOffset();
    cam.layers.mask = prevMask;
    this.scene.background = prevBg;
    this.scene.overrideMaterial = prevOverride;
    this.requestRender();
    return px[3] > 0 ? decodeKey(px[0], px[1], px[2]) : 0;
  }

  /** Normalised device coordinates of a client position. */
  ndc(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  }

  screenshot() {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }
}
