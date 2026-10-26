// @ts-check
// 3D animated wind streamline and particle flow visualization for the Three.js viewer.
// Deflects wind smoothly around solid obstacles and colors lines by local pedestrian speed.

import * as THREE from 'three';
import { rampStops, rampColor } from '../core/classify.js';

const getRaf = () => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => setTimeout(cb, 16));
const getCaf = () => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : (id) => clearTimeout(id));

export class WindStreamlines {
  /**
   * @param {any} app Reference to the main 3D application instance
   */
  constructor(app) {
    this.app = app;
    this.group = new THREE.Group();
    this.group.name = 'wind_streamlines';
    this.active = false;
    this._raf = 0;
    this._lastTime = 0;
  }

  /**
   * Generates and starts animating wind streamlines.
   *
   * @param {object} params
   * @param {{ cols: number, rows: number, cell: number, minX: number, maxY: number }} params.grid Grid dimension metadata
   * @param {Float32Array} params.values Local wind speed ratios or values per cell (NaN inside buildings)
   * @param {Int32Array|Float32Array|Array<number>|null} [params.ids] Optional building ID mask
   * @param {number} [params.windFromDeg] Meteorological wind direction in degrees (default 270)
   * @param {number} [params.speed10] Reference wind speed at 10 m height in m/s (default 4)
   * @param {number} [params.count] Total number of animated streamlines (default 450)
   * @param {number} [params.trailSteps] Number of simulation vertices per streamline (default 14)
   */
  show({
    grid,
    values,
    ids = null,
    windFromDeg = 270,
    speed10 = 4,
    count = 450,
    trailSteps = 14
  }) {
    this.hide();
    this.active = true;

    const { cols, rows, cell, minX = 0, maxY = 0 } = grid;
    if (cols <= 0 || rows <= 0 || cell <= 0) return;

    // 1. Two-pass chamfer distance field to nearest building obstacle in metres
    const INF = 1e6;
    const distField = new Float32Array(cols * rows);
    for (let i = 0; i < cols * rows; i++) {
      distField[i] = ((ids && ids[i] > 0) || !Number.isFinite(values[i])) ? 0 : INF;
    }

    const d1 = cell;
    const d2 = cell * Math.SQRT2;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        let v = distField[i];
        if (c > 0) v = Math.min(v, distField[i - 1] + d1);
        if (r > 0) {
          v = Math.min(v, distField[i - cols] + d1);
          if (c > 0) v = Math.min(v, distField[i - cols - 1] + d2);
          if (c < cols - 1) v = Math.min(v, distField[i - cols + 1] + d2);
        }
        distField[i] = v;
      }
    }
    for (let r = rows - 1; r >= 0; r--) {
      for (let c = cols - 1; c >= 0; c--) {
        const i = r * cols + c;
        let v = distField[i];
        if (c < cols - 1) v = Math.min(v, distField[i + 1] + d1);
        if (r < rows - 1) {
          v = Math.min(v, distField[i + cols] + d1);
          if (c < cols - 1) v = Math.min(v, distField[i + cols + 1] + d2);
          if (c > 0) v = Math.min(v, distField[i + cols - 1] + d2);
        }
        distField[i] = v;
      }
    }

    // 2. Base wind vector (blows towards toRad)
    const toRad = (((windFromDeg + 180) % 360) * Math.PI) / 180;
    const wx = Math.sin(toRad); // +x = east
    const wy = Math.cos(toRad); // +y = north

    // Helper to evaluate local deflected velocity and speed at world coordinate (x, y)
    const sampleFlow = (x, y) => {
      const col = (x - minX) / cell - 0.5;
      const row = (maxY - y) / cell - 0.5;
      const ic = Math.max(0, Math.min(cols - 1, Math.round(col)));
      const ir = Math.max(0, Math.min(rows - 1, Math.round(row)));
      const idx = ir * cols + ic;

      const dVal = distField[idx];
      const cl = Math.max(0, ic - 1);
      const cr = Math.min(cols - 1, ic + 1);
      const ru = Math.max(0, ir - 1);
      const rd = Math.min(rows - 1, ir + 1);

      // Distance gradient pointing away from obstacle
      const gradX = (distField[ir * cols + cr] - distField[ir * cols + cl]) / (cell * Math.max(1, cr - cl));
      const gradY = -(distField[rd * cols + ic] - distField[ru * cols + ic]) / (cell * Math.max(1, rd - ru));
      const gLen = Math.hypot(gradX, gradY);

      let vx = wx;
      let vy = wy;

      if (dVal < 4 * cell && gLen > 1e-4) {
        const nx = gradX / gLen;
        const ny = gradY / gLen;
        const dot = wx * nx + wy * ny;
        if (dot < 0) {
          // Deflect along the obstacle tangent
          const tx = -ny;
          const ty = nx;
          const sign = (wx * tx + wy * ty >= 0) ? 1 : -1;
          const tanX = sign * tx;
          const tanY = sign * ty;
          const blend = Math.exp(-dVal / (1.5 * cell));
          vx = (1 - blend) * wx + blend * tanX;
          vy = (1 - blend) * wy + blend * tanY;
        }
      }

      const vLen = Math.hypot(vx, vy);
      if (vLen > 1e-5) {
        vx /= vLen;
        vy /= vLen;
      }

      const rawRatio = Number.isFinite(values[idx]) ? values[idx] : 0.8;
      const spd = speed10 * Math.max(0.1, Math.min(2.0, rawRatio));
      return { vx, vy, speed: spd };
    };

    // 3. Find open seed locations
    const openCells = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (distField[r * cols + c] > cell * 0.4) {
          openCells.push({ c, r });
        }
      }
    }
    if (openCells.length === 0) return;

    // 4. Trace count streamlines
    const stops = rampStops('spectral-r');
    const stepDist = cell * 1.0;
    const streamlines = [];

    for (let s = 0; s < count; s++) {
      const seedCell = openCells[Math.floor(Math.random() * openCells.length)];
      let curX = minX + (seedCell.c + 0.5 + (Math.random() - 0.5) * 0.6) * cell;
      let curY = maxY - (seedCell.r + 0.5 + (Math.random() - 0.5) * 0.6) * cell;

      const pts = [];
      let speedSum = 0;

      for (let step = 0; step < trailSteps; step++) {
        const flow = sampleFlow(curX, curY);
        speedSum += flow.speed;

        const ground = (this.app?.terrain?.groundY) ? this.app.terrain.groundY(curX, curY) : 0;
        // Three.js scene axes: +x east, +y up, -z north
        const threeX = curX;
        const threeY = ground + 1.8;
        const threeZ = -curY;

        const normSpeed = Math.max(0, Math.min(1, flow.speed / (speed10 * 1.6)));
        const col = rampColor(stops, normSpeed);

        pts.push({
          pos: [threeX, threeY, threeZ],
          col: [col[0], col[1], col[2]],
          speed: flow.speed
        });

        curX += flow.vx * stepDist;
        curY += flow.vy * stepDist;

        // A streamline that leaves the grid ends there; respawning it inside
        // would draw a stray segment from the edge to the new point.
        if (curX < minX || curX > minX + cols * cell || curY < maxY - rows * cell || curY > maxY) break;
      }

      streamlines.push({
        pts,
        meanSpeed: speedSum / pts.length,
        phase: Math.random()
      });
    }

    // 5. Construct THREE.LineSegments geometry for animated streaks
    // Each streamline renders an animated head-tail streak of sub-segments
    const segmentsPerStreak = 3;
    const vertexCount = count * segmentsPerStreak * 2;
    const positions = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 3);

    const geometry = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(positions, 3);
    const colAttr = new THREE.BufferAttribute(colors, 3);
    geometry.setAttribute('position', posAttr);
    geometry.setAttribute('color', colAttr);

    const material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.88,
      depthWrite: false
    });

    const lines = new THREE.LineSegments(geometry, material);
    lines.name = 'streamlines_mesh';
    this.group.add(lines);

    if (this.app?.viewer?.helpers && this.group.parent !== this.app.viewer.helpers) {
      this.app.viewer.helpers.add(this.group);
    }

    // 6. Animation loop advancing phase along each streamline
    this._lastTime = performance.now();

    const animateLoop = (time) => {
      if (!this.active) return;

      const dt = Math.min(0.05, (time - this._lastTime) * 0.001);
      this._lastTime = time;

      let vOffset = 0;

      for (let s = 0; s < count; s++) {
        const sl = streamlines[s];
        sl.phase = (sl.phase + dt * (sl.meanSpeed / Math.max(1, speed10)) * 0.35) % 1.0;

        const numPts = sl.pts.length;
        const headIdxFloat = sl.phase * (numPts - 1);

        for (let seg = 0; seg < segmentsPerStreak; seg++) {
          const tailFrac = seg / segmentsPerStreak;
          const nextFrac = (seg + 1) / segmentsPerStreak;

          const p0Index = Math.max(0, Math.min(numPts - 1, Math.floor(headIdxFloat - (1 - tailFrac) * 3)));
          const p1Index = Math.max(0, Math.min(numPts - 1, Math.floor(headIdxFloat - (1 - nextFrac) * 3)));

          const ptA = sl.pts[p0Index];
          const ptB = sl.pts[p1Index];

          const alphaA = 0.2 + 0.8 * tailFrac;
          const alphaB = 0.2 + 0.8 * nextFrac;

          // Vertex 1
          positions[vOffset] = ptA.pos[0];
          positions[vOffset + 1] = ptA.pos[1];
          positions[vOffset + 2] = ptA.pos[2];
          colors[vOffset] = ptA.col[0] * alphaA;
          colors[vOffset + 1] = ptA.col[1] * alphaA;
          colors[vOffset + 2] = ptA.col[2] * alphaA;

          // Vertex 2
          positions[vOffset + 3] = ptB.pos[0];
          positions[vOffset + 4] = ptB.pos[1];
          positions[vOffset + 5] = ptB.pos[2];
          colors[vOffset + 3] = ptB.col[0] * alphaB;
          colors[vOffset + 4] = ptB.col[1] * alphaB;
          colors[vOffset + 5] = ptB.col[2] * alphaB;

          vOffset += 6;
        }
      }

      posAttr.needsUpdate = true;
      colAttr.needsUpdate = true;

      if (this.app?.viewer?.requestRender) {
        this.app.viewer.requestRender();
      }

      this._raf = getRaf()(animateLoop);
    };

    this._raf = getRaf()(animateLoop);
  }

  /**
   * Stops animation, clears geometry and removes streamlines from the viewer.
   */
  hide() {
    this.active = false;
    if (this._raf) {
      getCaf()(this._raf);
      this._raf = 0;
    }

    if (this.group.parent) {
      this.group.parent.remove(this.group);
    }

    this._dispose();

    if (this.app?.viewer?.requestRender) {
      this.app.viewer.requestRender();
    }
  }

  /**
   * Internal cleanup of Three.js geometries and materials.
   * @private
   */
  _dispose() {
    while (this.group.children.length > 0) {
      const child = /** @type {any} */ (this.group.children[0]);
      this.group.remove(child);
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
        else child.material.dispose();
      }
    }
  }
}
