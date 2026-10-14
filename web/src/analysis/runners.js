// @ts-check
// The analyses. Each returns a Result:
//   { kind, title, subtitle, unit, grid, values, display, facade?, fields, stats, notes }
// grid: { cols, rows, cell, minX, maxY } in local metres (x east, y north),
// values: Float32Array row-major from the north-west, NaN = no data.
// fields: per-feature values written onto layers ([{ layer, name, values }]).
import * as THREE from 'three';
import { GpuEngine, planTiles } from './gpu.js';
import { sunPath, skyHemisphere, solarPosition, sunVector } from '../core/solar.js';
import { annualSunBins, clearSkyYear, typicalDoy, conditionsAt, windRose } from '../core/weather.js';
import { meanRadiantTemperature, skyTemperature, utci, UTCI_CATEGORIES } from '../core/comfort.js';
import { windRatio, OPEN_PEDESTRIAN_FACTOR, lawsonClass } from '../core/wind.js';
import { blockIndicators, LCZ_LABELS, LCZ_COLORS } from '../core/morphology.js';
import { gridStats } from '../core/terrain_math.js';
import { splitKey, ExtrudedLayer, PointLayer } from '../scene/objects.js';

const DEG = Math.PI / 180;

export class Analyst {
  constructor(app) {
    this.app = app;
    this.engine = new GpuEngine(app.viewer.renderer);
    this.cache = new Map(); // svf / geometry grids by area+cell
  }

  // ------------------------------------------------------------ geometry helpers
  sceneBounds() {
    const box = new THREE.Box3().setFromObject(this.app.viewer.world);
    return { minY: Number.isFinite(box.min.y) ? box.min.y - 5 : -50, maxY: Number.isFinite(box.max.y) ? box.max.y + 5 : 200 };
  }

  occluderMargin(minElevationDeg = 8) {
    const b = this.sceneBounds();
    const rise = Math.max(20, b.maxY - b.minY);
    return Math.max(80, Math.min(900, rise / Math.tan(minElevationDeg * DEG)));
  }

  defaultCell(area, perSide = 1024) {
    const side = Math.max(area.maxX - area.minX, area.maxY - area.minY);
    const raw = side / perSide;
    return Math.max(1, Math.ceil(raw * 2) / 2);
  }

  // ------------------------------------------------------------ core runs
  /** Height-field run over an area, tiled. */
  async gridRun({ area, cell, directions = [], cosMode = 0, normal = [0, 1, 0], lift = 0.3, eye = null, maxDistance = 1000, withIds = false, onProgress = null }) {
    // Terrain tiles in the area are drawn at the analysis resolution while it runs.
    this.app.terrain.lockForAnalysis(area, cell);
    try {
      return await this._gridRun({ area, cell, directions, cosMode, normal, lift, eye, maxDistance, withIds, onProgress });
    } finally {
      this.app.terrain.lockForAnalysis(null);
    }
  }

  async _gridRun({ area, cell, directions, cosMode, normal, lift, eye, maxDistance, withIds, onProgress }) {
    const { grid, tiles } = planTiles(area, cell, Math.min(1024, this.engine.maxTexture));
    const n = grid.cols * grid.rows;
    const values = new Float32Array(n).fill(NaN);
    const potential = new Float32Array(n).fill(NaN);
    const heights = new Float32Array(n).fill(NaN);
    const ids = withIds ? new Int32Array(n) : null;
    const b = this.sceneBounds();
    const margin = eye ? 0 : this.occluderMargin();
    const scene = this.app.viewer.scene;
    for (let t = 0; t < tiles.length; t++) {
      const tile = tiles[t];
      const bounds = { ...tile.bounds, minY: b.minY, maxY: b.maxY };
      const res = await this.engine.run({
        scene, tile: bounds, cols: tile.cols, rows: tile.rows, directions, cosMode, normal, lift, eye, maxDistance,
        margin, depthResolution: 4096,
        onProgress: onProgress ? (f) => onProgress((t + f) / tiles.length) : undefined
      });
      const tileIds = withIds ? this.engine.idGrid(scene, bounds, tile.cols, tile.rows) : null;
      for (let r = 0; r < tile.rows; r++) {
        for (let c = 0; c < tile.cols; c++) {
          const src = r * tile.cols + c;
          const dst = (tile.r0 + r) * grid.cols + tile.c0 + c;
          if (!Number.isFinite(res.heights[src])) continue;
          values[dst] = res.values[src];
          potential[dst] = res.potential[src];
          heights[dst] = res.heights[src];
          if (ids && tileIds) ids[dst] = tileIds[src];
        }
      }
      if (onProgress && !directions.length && !eye) onProgress((t + 1) / tiles.length);
    }
    return { grid, values, potential, heights, ids };
  }

  /** Facade sample points of buildings whose centre lies in the area. */
  facadeSamples(area, spacing = 2, maxPoints = 1_500_000) {
    const layers = this.app.layers.filter((l) => l instanceof ExtrudedLayer && !l.isWall && l.visible);
    let totalArea = 0;
    for (const layer of layers) {
      for (let f = 0; f < layer.count; f++) {
        if (!inArea(layer.centroid[f * 2], layer.centroid[f * 2 + 1], area)) continue;
        totalArea += perimeter(layer.features[f].geometry) * layer.heights[f];
      }
    }
    const s = Math.max(spacing, Math.sqrt(totalArea / maxPoints));
    const pos = [], nrm = [], keys = [], areas = [];
    const terrain = this.app.terrain;
    for (const layer of layers) {
      for (let f = 0; f < layer.count; f++) {
        if (!inArea(layer.centroid[f * 2], layer.centroid[f * 2 + 1], area)) continue;
        const h = layer.heights[f];
        if (h < 1) continue;
        const baseY = terrain.toY(layer.baseZ[f]);
        const key = layer.index * (1 << 20) + f + 1;
        const nv = Math.max(1, Math.round(h / s));
        for (const poly of polygons(layer.features[f].geometry)) {
          poly.forEach((ring, ri) => {
            const ccw = ringArea(ring) > 0;
            const flip = ri === 0 ? !ccw : ccw;
            for (let i = 0; i < ring.length; i++) {
              const [x0, y0] = ring[i];
              const [x1, y1] = ring[(i + 1) % ring.length];
              const len = Math.hypot(x1 - x0, y1 - y0);
              if (len < 0.5) continue;
              let nx = (y1 - y0) / len, ny = -(x1 - x0) / len;
              if (flip) { nx = -nx; ny = -ny; }
              const nh = Math.max(1, Math.round(len / s));
              const cellArea = (len / nh) * (h / nv);
              for (let a = 0; a < nh; a++) {
                const t = (a + 0.5) / nh;
                const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
                for (let v = 0; v < nv; v++) {
                  pos.push(x, baseY + ((v + 0.5) * h) / nv, -y);
                  nrm.push(nx, 0, -ny);
                  keys.push(key);
                  areas.push(cellArea);
                }
              }
            }
          });
        }
      }
    }
    return { positions: Float32Array.from(pos), normals: Float32Array.from(nrm), keys: Int32Array.from(keys),
      areas: Float32Array.from(areas), count: keys.length, spacing: s };
  }

  async facadeRun(samples, { directions, cosMode, lift = 0.35, area, onProgress = null }) {
    this.app.terrain.lockForAnalysis(area, samples.spacing);
    try {
      return await this._facadeRun(samples, { directions, cosMode, lift, area, onProgress });
    } finally {
      this.app.terrain.lockForAnalysis(null);
    }
  }

  async _facadeRun(samples, { directions, cosMode, lift, area, onProgress }) {
    const b = this.sceneBounds();
    const tile = { minX: area.minX, maxX: area.maxX, minZ: -area.maxY, maxZ: -area.minY, minY: b.minY, maxY: b.maxY };
    const res = await this.engine.run({ scene: this.app.viewer.scene, tile, cols: 1, rows: 1, directions, cosMode, lift,
      points: samples, margin: this.occluderMargin(), depthResolution: 4096, onProgress });
    return res;
  }

  /** Per-feature means (and area-weighted sums) of a grid over each feature's roof cells. */
  aggregateGrid(ids, values, cellArea) {
    const acc = new Map();
    for (let i = 0; i < ids.length; i++) {
      const k = ids[i];
      if (!k || !Number.isFinite(values[i])) continue;
      let a = acc.get(k);
      if (!a) { a = { sum: 0, n: 0 }; acc.set(k, a); }
      a.sum += values[i];
      a.n++;
    }
    for (const a of acc.values()) { a.mean = a.sum / a.n; a.area = a.n * cellArea; a.total = a.sum * cellArea; }
    return acc;
  }

  aggregateSamples(keys, values, areas) {
    const acc = new Map();
    for (let i = 0; i < keys.length; i++) {
      const v = values[i];
      if (!Number.isFinite(v)) continue;
      let a = acc.get(keys[i]);
      if (!a) { a = { sum: 0, w: 0, total: 0, n: 0 }; acc.set(keys[i], a); }
      a.sum += v * areas[i]; a.w += areas[i]; a.total += v * areas[i]; a.n++;
    }
    for (const a of acc.values()) { a.mean = a.sum / a.w; a.area = a.w; }
    return acc;
  }

  /** Write aggregated per-key values into result fields on their layers. */
  toFields(acc, name, pick = (a) => a.mean) {
    const byLayer = new Map();
    for (const [key, a] of acc) {
      const { layerIndex, id } = splitKey(key);
      const layer = this.app.layers.find((l) => l.index === layerIndex);
      if (!layer) continue;
      let arr = byLayer.get(layer);
      if (!arr) { arr = new Float32Array(layer.count).fill(NaN); byLayer.set(layer, arr); }
      arr[id - 1] = pick(a);
    }
    return [...byLayer].map(([layer, values]) => ({ layer, name, values }));
  }

  openMask(ids) {
    return (i) => !ids || ids[i] === 0;
  }

  site() {
    return this.app.site;
  }

  // ------------------------------------------------------------ sun hours + shadow
  async sunHours({ area, cell, date, startHour = 0, endHour = 24, stepMinutes = 10, facades = false, onProgress }) {
    const s = this.site();
    const doy = typicalDoy(date.month, date.day);
    const dirs = sunPath(doy, s.lat, s.lon, s.utcOffset, { startHour, endHour, stepMinutes });
    if (!dirs.length) throw new Error('The sun does not rise above the horizon in this period.');
    const run = await this.gridRun({ area, cell, directions: dirs, cosMode: 0, lift: 0.3, withIds: true,
      onProgress: (f) => onProgress?.(facades ? f * 0.6 : f) });
    const possible = dirs.reduce((a, d) => a + d.weight, 0);
    const shade = new Float32Array(run.values.length).fill(NaN);
    for (let i = 0; i < shade.length; i++) if (Number.isFinite(run.values[i])) shade[i] = 1 - run.values[i] / possible;
    const fields = this.toFields(this.aggregateGrid(run.ids, run.values, cell * cell), 'sun_h_roof');
    let facade = null;
    if (facades) {
      const samples = this.facadeSamples(area);
      if (samples.count) {
        const res = await this.facadeRun(samples, { directions: dirs, cosMode: 2, area, onProgress: (f) => onProgress?.(0.6 + 0.4 * f) });
        facade = { ...samples, values: res.values, unit: 'h', min: 0, max: possible, ramp: 'inferno' };
        fields.push(...this.toFields(this.aggregateSamples(samples.keys, res.values, samples.areas), 'sun_h_facade'));
      }
    }
    const open = [];
    let twoHours = 0;
    for (let i = 0; i < run.values.length; i++) {
      if (!Number.isFinite(run.values[i]) || run.ids[i] !== 0) continue;
      open.push(run.values[i]);
      if (run.values[i] >= 2) twoHours++;
    }
    const st = gridStats(open);
    const label = `${date.day} ${monthName(date.month)}`;
    return [{
      kind: 'sun', title: `Sun hours, ${label}`, subtitle: `${fmtHour(startHour)}–${fmtHour(endHour)}, every ${stepMinutes} min`,
      unit: 'h', grid: run.grid, values: run.values, ids: run.ids, display: { min: 0, max: Math.ceil(possible), ramp: 'inferno' },
      facade, fields,
      stats: [
        ['Possible sunshine', `${possible.toFixed(1)} h`],
        ['Open ground, mean', `${st.mean.toFixed(2)} h`],
        ['Open ground with ≥ 2 h', `${open.length ? ((100 * twoHours) / open.length).toFixed(0) : 0} %`]
      ],
      notes: 'BRE 209 guidance: at least half of an amenity area should receive 2 hours of sun on 21 March.'
    }, {
      kind: 'shadow', title: `Hours in shade, ${label}`, subtitle: `Of ${possible.toFixed(1)} h with the sun up, ${fmtHour(startHour)}–${fmtHour(endHour)}`,
      unit: 'h', grid: run.grid, values: run.values.map((v) => (Number.isFinite(v) ? possible - v : NaN)), ids: run.ids,
      display: { min: 0, max: Math.ceil(possible), ramp: 'blues' },
      fields: [
        ...this.toFields(this.aggregateGrid(run.ids, run.values.map((v) => possible - v), cell * cell), 'shade_h_roof'),
        ...this.toFields(this.aggregateGrid(run.ids, shade, cell * cell), 'shade_pct_roof', (a) => a.mean * 100)
      ],
      stats: [
        ['Open ground, mean time in shade', `${(possible - st.mean).toFixed(2)} h`],
        ['Open ground, mean shade share', `${(100 * gridStats(shade.filter((_, i) => run.ids[i] === 0)).mean).toFixed(0)} %`],
        ['Open ground in shade all day', `${open.length ? ((100 * open.filter((v) => v < 0.01).length) / open.length).toFixed(0) : 0} %`]
      ]
    }];
  }

  // ------------------------------------------------------------ shadow study (animation frames)
  /**
   * Sun or shade at each time step of one day: one frame per step, played in
   * step with the sun clock (and recorded by the "sun through the day" video).
   */
  async shadowStudy({ area, cell, date, startHour = 6, endHour = 20, stepMinutes = 30, onProgress }) {
    const s = this.site();
    const doy = typicalDoy(date.month, date.day);
    const steps = [];
    for (let hh = startHour; hh <= endHour + 1e-9; hh += stepMinutes / 60) {
      const p = solarPosition(doy, hh, s.lat, s.lon, s.utcOffset);
      if (p.elevation > 0.5 * DEG) steps.push({ hour: hh, dir: sunVector(p.elevation, p.azimuth) });
    }
    if (!steps.length) throw new Error('The sun does not rise above the horizon in this period.');
    let grid = null, ids = null;
    const frames = [];
    for (let k = 0; k < steps.length; k++) {
      const run = await this.gridRun({ area, cell, directions: [{ dir: steps[k].dir, weight: 1 }], cosMode: 0, lift: 0.3, withIds: k === 0,
        onProgress: (f) => onProgress?.((k + f) / steps.length) });
      if (!grid) { grid = run.grid; ids = run.ids; }
      // 1 sunlit, 0 shade, 255 no surface.
      const frame = new Uint8Array(run.values.length);
      for (let i = 0; i < frame.length; i++) frame[i] = Number.isFinite(run.values[i]) ? (run.values[i] > 0.5 ? 1 : 0) : 255;
      frames.push(frame);
    }
    const label = `${date.day} ${monthName(date.month)}`;
    const result = {
      kind: 'shadowstudy', title: `Shadow study, ${label}`, subtitle: `${steps.length} moments, every ${stepMinutes} min`,
      unit: '', grid, ids, frames, hours: steps.map((x) => x.hour), frame: 0, date,
      values: new Float32Array(frames[0].length), display: { min: 0, max: 1, categorical: { 0: '#26346b', 1: '#ffd36b' } },
      legend: [{ color: '#ffd36b', label: 'In the sun' }, { color: '#26346b', label: 'In shade' }], fields: [],
      stats: [['Moments', String(steps.length)], ['From – to', `${fmtHour(steps[0].hour)}–${fmtHour(steps[steps.length - 1].hour)}`]],
      notes: 'Move the sun clock or press play: the map follows the time. The "Sun through the day" video records it.'
    };
    setShadowFrame(result, 0);
    return [result];
  }

  // ------------------------------------------------------------ sky view factor
  async skyView({ area, cell, directions = 192, facades = false, onProgress }) {
    const dirs = skyHemisphere(directions);
    const run = await this.gridRun({ area, cell, directions: dirs, cosMode: 1, lift: 0.3, withIds: true,
      onProgress: (f) => onProgress?.(facades ? f * 0.6 : f) });
    this.cache.set(cacheKey('svf', area, cell), run);
    const fields = this.toFields(this.aggregateGrid(run.ids, run.values, cell * cell), 'svf_roof');
    let facade = null;
    if (facades) {
      const samples = this.facadeSamples(area);
      if (samples.count) {
        const res = await this.facadeRun(samples, { directions: dirs, cosMode: 1, area, onProgress: (f) => onProgress?.(0.6 + 0.4 * f) });
        facade = { ...samples, values: res.values, unit: '', min: 0, max: 0.5, ramp: 'viridis' };
        fields.push(...this.toFields(this.aggregateSamples(samples.keys, res.values, samples.areas), 'svf_facade'));
      }
    }
    const open = run.values.filter((v, i) => Number.isFinite(v) && run.ids[i] === 0);
    const st = gridStats(open);
    return [{
      kind: 'svf', title: 'Sky view factor', subtitle: `${directions} sky directions, cosine-weighted`, unit: '',
      grid: run.grid, values: run.values, ids: run.ids, display: { min: 0, max: 1, ramp: 'viridis' }, facade, fields,
      stats: [['Open ground, mean SVF', st.mean.toFixed(2)], ['Open ground, min SVF', st.min.toFixed(2)]],
      notes: 'SVF = 1 for an open horizontal surface, 0.5 for an unobstructed wall.'
    }];
  }

  // ------------------------------------------------------------ radiation + PV
  async solarRadiation({ area, cell, months = null, tiltDeg = 0, azimuthDeg = 180, efficiency = 0.2, performanceRatio = 0.8,
    coverage = 0.6, minShare = 0.7, albedo = 0.2, facades = false, onProgress }) {
    const s = this.site();
    const weather = this.app.weather || clearSkyYear(s.lat, s.lon, s.utcOffset);
    const bins = annualSunBins(weather, { lat: s.lat, lon: s.lon, utcOffset: s.utcOffset, months });
    // Accumulate in kWh so the sums stay small enough for half-float targets.
    const sunDirs = bins.directions.map((d) => ({ dir: d.dir, weight: d.weight / 1000 }));
    const dhi = bins.dhiSum / 1000;
    const ghi = bins.ghiSum / 1000;
    const sky = skyHemisphere(144);
    const tilt = tiltDeg * DEG;
    const az = azimuthDeg * DEG;
    const n = [Math.sin(az) * Math.sin(tilt), Math.cos(tilt), -Math.cos(az) * Math.sin(tilt)];
    const split = facades ? 0.55 : 1;
    const direct = await this.gridRun({ area, cell, directions: sunDirs, cosMode: 1, normal: n, lift: 0.3, withIds: true,
      onProgress: (f) => onProgress?.(f * 0.6 * split) });
    const diffuse = await this.gridRun({ area, cell, directions: sky, cosMode: 1, normal: n, lift: 0.3,
      onProgress: (f) => onProgress?.((0.6 + 0.4 * f) * split) });
    const reflected = albedo * ghi * (1 - Math.cos(tilt)) / 2;
    const irr = new Float32Array(direct.values.length).fill(NaN);
    const potentialIrr = new Float32Array(direct.values.length).fill(NaN);
    for (let i = 0; i < irr.length; i++) {
      if (!Number.isFinite(direct.values[i])) continue;
      irr[i] = direct.values[i] + dhi * diffuse.values[i] + reflected;
      potentialIrr[i] = direct.potential[i] + dhi * diffuse.potential[i] + reflected;
    }
    // Roof PV: cells that keep at least minShare of their unshaded potential.
    const yieldPerCell = new Float32Array(irr.length).fill(NaN);
    for (let i = 0; i < irr.length; i++) {
      if (!direct.ids[i] || !Number.isFinite(irr[i])) continue;
      if (irr[i] >= minShare * potentialIrr[i]) yieldPerCell[i] = irr[i] * efficiency * performanceRatio * coverage;
    }
    const cellArea = cell * cell;
    const roofIrr = this.aggregateGrid(direct.ids, irr, cellArea);
    const pv = this.aggregateGrid(direct.ids, yieldPerCell, cellArea);
    const fields = [
      ...this.toFields(roofIrr, 'roof_kwh_m2'),
      ...this.toFields(pv, 'pv_kwh_yr', (a) => a.total),
      ...this.toFields(pv, 'pv_area_m2', (a) => a.area * coverage)
    ];
    let facade = null;
    if (facades) {
      const samples = this.facadeSamples(area);
      if (samples.count) {
        const d = await this.facadeRun(samples, { directions: sunDirs, cosMode: 1, area, onProgress: (f) => onProgress?.(0.55 + 0.25 * f) });
        const k = await this.facadeRun(samples, { directions: sky, cosMode: 1, area, onProgress: (f) => onProgress?.(0.8 + 0.2 * f) });
        const fv = new Float32Array(samples.count);
        for (let i = 0; i < samples.count; i++) fv[i] = d.values[i] + dhi * k.values[i] + albedo * ghi * 0.5;
        facade = { ...samples, values: fv, unit: 'kWh/m²', min: 0, max: 0, ramp: 'magma' };
        const facadeAcc = this.aggregateSamples(samples.keys, fv, samples.areas);
        fields.push(...this.toFields(facadeAcc, 'facade_kwh_m2'));
        // Facade PV only where a wall keeps at least minShare of what the best
        // unshaded wall in the scene receives (north walls never qualify).
        let best = 0;
        for (let i = 0; i < samples.count; i++) {
          const pot = d.potential[i] + dhi * k.potential[i] + albedo * ghi * 0.5;
          if (pot > best) best = pot;
        }
        const fy = fv.map((v) => (v >= minShare * best ? v * efficiency * performanceRatio : NaN));
        const facadePv = this.aggregateSamples(samples.keys, fy, samples.areas);
        // Yield is summed over suitable tiles only; buildings with none get 0.
        const pvByKey = new Map();
        for (const [key, a] of facadePv) pvByKey.set(key, a.total * coverage);
        for (const key of facadeAcc.keys()) if (!pvByKey.has(key)) pvByKey.set(key, 0);
        fields.push(...this.toFields(new Map([...pvByKey].map(([key, v]) => [key, { v }])), 'facade_pv_kwh_yr', (a) => a.v));
      }
    }
    let total = 0, area2 = 0;
    for (const a of pv.values()) { total += a.total; area2 += a.area * coverage; }
    const st = gridStats(irr);
    const display = { min: 0, max: Math.ceil(st.max / 100) * 100, ramp: 'magma' };
    if (facade) facade.max = display.max;
    const source = weather.location?.clearSky ? 'clear-sky estimate (upper bound, no clouds)' : `weather: ${weather.location.city || 'EPW'}`;
    return [{
      kind: 'radiation', title: months ? `Solar irradiation, ${months.map(monthName).join(', ')}` : 'Annual solar irradiation',
      subtitle: `${tiltDeg ? `${tiltDeg}° tilt facing ${azimuthDeg}°, ` : ''}${source}`, unit: 'kWh/m²',
      grid: direct.grid, values: irr, ids: direct.ids, display, facade, fields,
      stats: [
        ['Roof PV yield (all buildings)', `${fmtBig(total)} kWh/yr`],
        ['Suitable panel area', `${fmtBig(area2)} m²`],
        ['Horizontal, unshaded', `${ghi.toFixed(0)} kWh/m²`],
        ['Highest surface value', `${st.max.toFixed(0)} kWh/m²`]
      ],
      notes: `PV = irradiation x efficiency ${efficiency} x performance ratio ${performanceRatio} x panel coverage ${coverage}, on roof cells keeping at least ${Math.round(minShare * 100)} % of their unshaded potential; facade panels only on walls receiving at least ${Math.round(minShare * 100)} % of what the best unshaded wall gets. Diffuse light: isotropic sky.`
    }];
  }

  // ------------------------------------------------------------ visibility
  async viewshed({ area, cell, eye, observerHeight = 1.6, radius = 600, onProgress }) {
    const terrain = this.app.terrain;
    const e = new THREE.Vector3(eye.x, eye.y + observerHeight, eye.z);
    const sub = clipArea({ minX: e.x - radius, maxX: e.x + radius, minY: -e.z - radius, maxY: -e.z + radius }, area);
    const run = await this.gridRun({ area: sub, cell, eye: e, maxDistance: radius, lift: 0.3, withIds: true, onProgress });
    const vis = run.values.map((v, i) => (Number.isFinite(v) && run.potential[i] > 0 ? (v > 0 ? 1 : 0) : NaN));
    let seen = 0, total = 0;
    vis.forEach((v) => { if (Number.isFinite(v)) { total++; if (v > 0) seen++; } });
    const visibleRoofs = this.aggregateGrid(run.ids, vis, cell * cell);
    void terrain;
    return [{
      kind: 'viewshed', title: 'Viewshed', subtitle: `Observer ${observerHeight} m above the surface, radius ${radius} m`,
      unit: '', grid: run.grid, values: vis, ids: run.ids, display: { min: 0, max: 1, categorical: { 0: '#3b4a6b', 1: '#f6c945' } },
      fields: this.toFields(visibleRoofs, 'visible_roof_pct', (a) => a.mean * 100),
      stats: [['Visible share of the surface', `${total ? ((100 * seen) / total).toFixed(0) : 0} %`], ['Visible area', `${fmtBig(seen * cell * cell)} m²`]],
      marker: { x: e.x, y: e.y, z: e.z },
      legend: [{ color: '#f6c945', label: 'Visible' }, { color: '#3b4a6b', label: 'Hidden' }]
    }];
  }

  // ------------------------------------------------------------ geometry grid (wind, morphology)
  async obstacleGrid({ area, cell, onProgress }) {
    const key = cacheKey('geom', area, cell);
    if (this.cache.has(key)) return this.cache.get(key);
    const run = await this.gridRun({ area, cell, withIds: true, onProgress });
    const terrain = this.app.terrain;
    const { grid } = run;
    const heights = new Float32Array(grid.cols * grid.rows);
    const porosity = new Float32Array(grid.cols * grid.rows);
    for (let r = 0; r < grid.rows; r++) {
      for (let c = 0; c < grid.cols; c++) {
        const i = r * grid.cols + c;
        if (!run.ids[i]) continue;
        const ground = terrain.groundY(grid.minX + c * cell, grid.maxY - r * cell);
        heights[i] = Math.max(0, (run.heights[i] - ground) / terrain.exaggeration);
      }
    }
    // Trees: porous obstacles rasterised from their crowns.
    for (const layer of this.app.layers) {
      if (!(layer instanceof PointLayer) || !layer.visible || !layer.isTree) continue;
      for (const [x, y, rad, h] of layer.obstacles()) {
        const c0 = Math.floor((x - rad - grid.minX) / cell), c1 = Math.ceil((x + rad - grid.minX) / cell);
        const r0 = Math.floor((grid.maxY - y - rad) / cell), r1 = Math.ceil((grid.maxY - y + rad) / cell);
        for (let r = Math.max(0, r0); r <= Math.min(grid.rows - 1, r1); r++) {
          for (let c = Math.max(0, c0); c <= Math.min(grid.cols - 1, c1); c++) {
            const i = r * grid.cols + c;
            if (heights[i] > 0 && !porosity[i]) continue;
            if (Math.hypot(grid.minX + c * cell - x, grid.maxY - r * cell - y) > rad) continue;
            heights[i] = Math.max(heights[i], h);
            porosity[i] = 0.5;
          }
        }
      }
    }
    const out = { grid, heights, porosity, ids: run.ids };
    this.cache.set(key, out);
    return out;
  }

  async wind({ area, cell, windFromDeg, speed10, onProgress }) {
    const og = await this.obstacleGrid({ area, cell, onProgress: (f) => onProgress?.(0.3 * f) });
    const { grid } = og;
    const ratio = await windRatio({ heights: og.heights, porosity: og.porosity, cols: grid.cols, rows: grid.rows, cell,
      windFromDeg, onProgress: (f) => onProgress?.(0.3 + 0.7 * f) });
    const speed = ratio.map((r) => r * speed10 * OPEN_PEDESTRIAN_FACTOR);
    const open = speed.filter(Number.isFinite);
    const st = gridStats(open);
    const sheltered = open.filter((v) => v < 0.5 * speed10 * OPEN_PEDESTRIAN_FACTOR).length;
    const counts = new Map();
    for (const v of open) { const c = lawsonClass(v); if (c) counts.set(c.label, (counts.get(c.label) || 0) + 1); }
    return [{
      kind: 'wind', title: `Pedestrian wind, from ${windFromDeg}°`, subtitle: `${speed10.toFixed(1)} m/s at 10 m; screening estimate, not CFD`,
      unit: 'm/s', grid, values: speed, ids: og.ids, display: { min: 0, max: Math.max(1, Math.ceil(st.max)), ramp: 'spectral-r' },
      fields: [],
      stats: [
        ['Open-terrain pedestrian wind', `${(speed10 * OPEN_PEDESTRIAN_FACTOR).toFixed(1)} m/s`],
        ['Mean at pedestrian level', `${st.mean.toFixed(1)} m/s`],
        ['Sheltered (< half of open)', `${open.length ? ((100 * sheltered) / open.length).toFixed(0) : 0} %`],
        ...[...counts].map(([k, v]) => [`Comfort: ${k}`, `${((100 * v) / open.length).toFixed(0)} %`])
      ],
      wind: { fromDeg: windFromDeg },
      notes: 'Geometric screening (wakes, channelling, tall-building corners). Confirm critical places with CFD or a wind-tunnel study. Comfort classes use LDDC (Lawson) thresholds, which apply to the speed exceeded 5 % of the time.'
    }];
  }

  // ------------------------------------------------------------ thermal comfort
  async comfort({ area, cell, month, day, hour, conditions, onProgress }) {
    const s = this.site();
    const doy = typicalDoy(month, day);
    const p = solarPosition(doy, hour - 0.5, s.lat, s.lon, s.utcOffset);
    const elevDeg = p.elevation / DEG;
    const svfKey = cacheKey('svf', area, cell);
    let svfRun = this.cache.get(svfKey);
    if (!svfRun) {
      svfRun = await this.gridRun({ area, cell, directions: skyHemisphere(96), cosMode: 1, lift: 1.1, withIds: true,
        onProgress: (f) => onProgress?.(0.45 * f) });
    }
    let sunlit = null;
    if (elevDeg > 0.5) {
      const dir = sunVector(p.elevation, p.azimuth);
      const sun = await this.gridRun({ area, cell, directions: [{ dir, weight: 1 }], cosMode: 0, lift: 1.1,
        onProgress: (f) => onProgress?.(0.45 + 0.15 * f) });
      sunlit = sun.values;
    }
    const og = await this.obstacleGrid({ area, cell, onProgress: (f) => onProgress?.(0.6 + 0.1 * f) });
    const ratio = await windRatio({ heights: og.heights, porosity: og.porosity, cols: og.grid.cols, rows: og.grid.rows, cell,
      windFromDeg: conditions.windDir ?? 270, onProgress: (f) => onProgress?.(0.7 + 0.3 * f) });
    const grid = svfRun.grid;
    const n = grid.cols * grid.rows;
    const tSky = skyTemperature(conditions.airTemp, conditions.ir);
    const mrt = new Float32Array(n).fill(NaN);
    const index = new Float32Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      if (svfRun.ids[i] !== 0 || !Number.isFinite(svfRun.values[i])) continue; // open ground only
      const tr = meanRadiantTemperature({ airTemp: conditions.airTemp, skyTemp: tSky, svf: svfRun.values[i],
        sunlit: sunlit ? sunlit[i] : 0, dni: conditions.dni, dhi: conditions.dhi, ghi: conditions.ghi, elevationDeg: elevDeg });
      mrt[i] = tr;
      // UTCI takes the 10 m wind; scale it by the local sheltering ratio.
      const v10 = Math.max(0.5, Math.min(17, (conditions.windSpeed ?? 2) * (Number.isFinite(ratio[i]) ? ratio[i] : 1)));
      index[i] = utci(conditions.airTemp, tr, v10, conditions.rh ?? 50);
    }
    const st = gridStats(index);
    const counts = new Map();
    for (const v of index) {
      if (!Number.isFinite(v)) continue;
      const c = UTCI_CATEGORIES.find((k) => v < k.max);
      if (c) counts.set(c.label, (counts.get(c.label) || 0) + 1);
    }
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    const when = `${day} ${monthName(month)} ${String(hour - 1).padStart(2, '0')}:00–${String(hour).padStart(2, '0')}:00`;
    const cond = `air ${conditions.airTemp.toFixed(1)} °C, RH ${Math.round(conditions.rh ?? 50)} %, wind ${(conditions.windSpeed ?? 2).toFixed(1)} m/s`;
    const utciMin = Math.floor(Math.min(st.min, conditions.airTemp - 5));
    const utciMax = Math.ceil(Math.max(st.max, conditions.airTemp + 5));
    return [{
      kind: 'utci', title: `UTCI, ${when}`, subtitle: cond, unit: '°C', grid, values: index, ids: svfRun.ids,
      display: { min: utciMin, max: utciMax, ramp: 'rdylbu-r' }, fields: [],
      stats: [['Mean UTCI on open ground', `${st.mean.toFixed(1)} °C`], ['Range', `${st.min.toFixed(1)} – ${st.max.toFixed(1)} °C`],
        ...[...counts].map(([k, v]) => [k, `${((100 * v) / total).toFixed(0)} %`])],
      notes: 'UTCI (Bröde et al. 2012) from air temperature, humidity, sheltered wind and a SolarCal mean radiant temperature; surfaces are taken at air temperature.'
    }, {
      kind: 'mrt', title: `Mean radiant temperature, ${when}`, subtitle: cond, unit: '°C', grid, values: mrt, ids: svfRun.ids,
      display: { min: Math.floor(gridStats(mrt).min), max: Math.ceil(gridStats(mrt).max), ramp: 'inferno' }, fields: [],
      stats: [['Mean MRT on open ground', `${gridStats(mrt).mean.toFixed(1)} °C`]]
    }];
  }

  // ------------------------------------------------------------ morphology / heat island
  async morphology({ area, cell, blockSize = 100, windFromDeg = 270, onProgress }) {
    const og = await this.obstacleGrid({ area, cell, onProgress });
    const { grid } = og;
    const buildingHeights = og.heights.map((h, i) => (og.ids[i] ? h : 0));
    const svfRun = this.cache.get(cacheKey('svf', area, cell));
    const blockCells = Math.max(2, Math.round(blockSize / cell));
    const ind = blockIndicators({ heights: buildingHeights, cols: grid.cols, rows: grid.rows, cell, blockCells, windFromDeg,
      svf: svfRun ? svfRun.values : null, featureIds: og.ids });
    const bgrid = { cols: ind.cols, rows: ind.rows, cell: ind.cell, minX: grid.minX - cell / 2 + ind.cell / 2, maxY: grid.maxY + cell / 2 - ind.cell / 2 };
    // Per building: the indicators of the block containing its centre.
    const fields = [];
    for (const layer of this.app.layers) {
      if (!(layer instanceof ExtrudedLayer) || layer.isWall) continue;
      const pick = (arr) => {
        const out = new Float32Array(layer.count).fill(NaN);
        for (let f = 0; f < layer.count; f++) {
          const c = Math.floor((layer.centroid[f * 2] - (bgrid.minX - bgrid.cell / 2)) / bgrid.cell);
          const r = Math.floor(((bgrid.maxY + bgrid.cell / 2) - layer.centroid[f * 2 + 1]) / bgrid.cell);
          if (c >= 0 && r >= 0 && c < bgrid.cols && r < bgrid.rows) out[f] = arr[r * bgrid.cols + c];
        }
        return out;
      };
      fields.push({ layer, name: 'lambda_p', values: pick(ind.lambdaP) }, { layer, name: 'h_w', values: pick(ind.hw) },
        { layer, name: 'lcz', values: pick(ind.lcz) });
    }
    const lczValues = Float32Array.from(ind.lcz);
    const results = [
      { key: 'lambdaP', title: 'Plan area fraction λp', unit: '', ramp: 'reds', values: ind.lambdaP, max: 1 },
      { key: 'meanHeight', title: 'Mean building height', unit: 'm', ramp: 'viridis', values: ind.meanHeight },
      { key: 'hw', title: 'Canyon aspect ratio H/W', unit: '', ramp: 'magma-r', values: ind.hw, max: 3 },
      { key: 'lambdaF', title: `Frontal area index λf (wind from ${windFromDeg}°)`, unit: '', ramp: 'blues', values: ind.lambdaF },
      { key: 'z0', title: 'Roughness length z0', unit: 'm', ramp: 'greens', values: ind.z0 }
    ].map((r) => ({
      kind: 'morph', title: r.title, subtitle: `${blockSize} m blocks`, unit: r.unit, grid: bgrid, values: r.values,
      display: { min: 0, max: r.max ?? Math.max(0.01, gridStats(r.values).max), ramp: r.ramp }, fields: [], stats: [['Mean', gridStats(r.values).mean.toFixed(2)]]
    }));
    const lczCounts = new Map();
    for (const v of ind.lcz) lczCounts.set(v, (lczCounts.get(v) || 0) + 1);
    results.unshift({
      kind: 'lcz', title: 'Local Climate Zones (approximate)', subtitle: `${blockSize} m blocks, built types from geometry`,
      unit: '', grid: bgrid, values: lczValues, display: { min: 0, max: 10, categorical: LCZ_COLORS }, fields,
      legend: [...lczCounts.keys()].sort((a, b) => a - b).map((k) => ({ color: LCZ_COLORS[k], label: LCZ_LABELS[k] })),
      stats: [...lczCounts].sort((a, b) => b[1] - a[1]).map(([k, v]) => [LCZ_LABELS[k], `${((100 * v) / lczValues.length).toFixed(0)} %`]),
      notes: 'Classes from plan fraction, mean height and footprint size (Stewart and Oke 2012). LCZ 7 and 10 need material and land-use information.'
    });
    return results;
  }

  windStats() {
    return this.app.weather?.windSpeed ? windRose(this.app.weather) : null;
  }

  conditionsFor(month, day, hour) {
    if (this.app.weather?.dryBulb) return conditionsAt(this.app.weather, month, day, hour);
    return null;
  }
}

// ---------------------------------------------------------------- helpers
function cacheKey(kind, a, cell) {
  return `${kind}:${a.minX.toFixed(1)},${a.maxX.toFixed(1)},${a.minY.toFixed(1)},${a.maxY.toFixed(1)}@${cell}`;
}

function inArea(x, y, a) {
  return x >= a.minX && x <= a.maxX && y >= a.minY && y <= a.maxY;
}

function clipArea(a, b) {
  return { minX: Math.max(a.minX, b.minX), maxX: Math.min(a.maxX, b.maxX), minY: Math.max(a.minY, b.minY), maxY: Math.min(a.maxY, b.maxY) };
}

function polygons(geom) {
  const polys = geom?.type === 'MultiPolygon' ? geom.coordinates : geom?.type === 'Polygon' ? [geom.coordinates] : [];
  return polys.map((p) => p.map((ring) => {
    const n = ring.length;
    return n > 1 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1] ? ring.slice(0, n - 1) : ring;
  }));
}

function ringArea(ring) {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return s / 2;
}

function perimeter(geom) {
  let p = 0;
  for (const poly of polygons(geom)) for (const ring of poly) for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % ring.length];
    p += Math.hypot(x1 - x0, y1 - y0);
  }
  return p;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function monthName(m) { return MONTHS[m - 1]; }

/** Show frame k of a shadow study (values + a fresh drape texture). */
export function setShadowFrame(result, k) {
  const frame = result.frames[Math.max(0, Math.min(result.frames.length - 1, k))];
  const v = result.values;
  for (let i = 0; i < v.length; i++) v[i] = frame[i] === 255 ? NaN : frame[i];
  result.frame = k;
  if (result._tex) { result._tex.dispose(); delete result._tex; }
}

/** The frame closest to a clock time, or -1 outside the study. */
export function frameForHour(result, hour) {
  const hs = result.hours;
  const step = hs.length > 1 ? hs[1] - hs[0] : 1;
  if (hour < hs[0] - step / 2 || hour > hs[hs.length - 1] + step / 2) return -1;
  let best = 0;
  for (let i = 1; i < hs.length; i++) if (Math.abs(hs[i] - hour) < Math.abs(hs[best] - hour)) best = i;
  return best;
}
function fmtHour(h) { return `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`; }
function fmtBig(v) { return Math.round(v).toLocaleString('en-US'); }
