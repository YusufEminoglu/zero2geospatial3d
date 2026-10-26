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
import { meanRadiantTemperature, skyTemperature, utci, UTCI_CATEGORIES, pet, PET_CATEGORIES } from '../core/comfort.js';
import { SURFACE_MATERIALS, surfaceTemperature, canopyCoolingGrid } from '../core/microclimate.js';
import { ventilationEfficiency, VENTILATION_CLASSES, ventilationClass, pollutantDispersion, AIR_QUALITY_CLASSES, airQualityClass } from '../core/dispersion.js';
import { noisePropagation, buildingFacadeNoise, NOISE_CLASSES, noiseClass } from '../core/acoustics.js';
import { greenViewIndex, GVI_CLASSES, gviClass, solarEnvelope as calcSolarEnvelope } from '../core/urban_form.js';
import { windRatio, OPEN_PEDESTRIAN_FACTOR, lawsonClass } from '../core/wind.js';
import { blockIndicators, LCZ_LABELS, LCZ_COLORS } from '../core/morphology.js';
import { gridStats } from '../core/terrain_math.js';
import { splitKey, ExtrudedLayer, PointLayer, SurfaceLayer, LineLayer } from '../scene/objects.js';
import { climateAroundBuildings, surroundings } from './climate.js';
import { vscDirections, VSC_OPEN, VSC_TARGET } from '../core/daylight_rule.js';
import { coverIndex, coverAt, isOpen } from '../core/party_walls.js';

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
  async gridRun({ area, cell, directions = [], cosMode = 0, normal = [0, 1, 0], lift = 0.3, eye = null, maxDistance = 1000, withIds = false,
    depthResolution = 4096, lock = true, onProgress = null }) {
    // Terrain tiles in the area are drawn at the analysis resolution while it
    // runs (lock: false when the caller holds the lock over many runs).
    if (lock) this.app.terrain.lockForAnalysis(area, cell);
    try {
      return await this._gridRun({ area, cell, directions, cosMode, normal, lift, eye, maxDistance, withIds, depthResolution, onProgress });
    } finally {
      if (lock) this.app.terrain.lockForAnalysis(null);
    }
  }

  async _gridRun({ area, cell, directions, cosMode, normal, lift, eye, maxDistance, withIds, depthResolution = 4096, onProgress }) {
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
        margin, depthResolution,
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
    const pos = [], nrm = [], keys = [], areas = [], levels = [], open = [];
    const terrain = this.app.terrain;
    // Buildings that can stand against a sampled wall: party walls are marked
    // (open = 0) so window-based measures such as VSC can leave them out.
    const near = { minX: area.minX - 60, maxX: area.maxX + 60, minY: area.minY - 60, maxY: area.maxY + 60 };
    const cover = [];
    for (const layer of layers) {
      for (let f = 0; f < layer.count; f++) {
        if (!inArea(layer.centroid[f * 2], layer.centroid[f * 2 + 1], near)) continue;
        cover.push({ id: layer.index * (1 << 20) + f + 1, rings: polygons(layer.features[f].geometry).map((p) => p[0]),
          bottom: layer.baseZ[f] + (layer.minH?.[f] || 0), top: layer.baseZ[f] + layer.heights[f] });
      }
    }
    const index = coverIndex(cover);
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
                const spans = coverAt(index, x + nx * 0.6, y + ny * 0.6, key);
                for (let v = 0; v < nv; v++) {
                  pos.push(x, baseY + ((v + 0.5) * h) / nv, -y);
                  nrm.push(nx, 0, -ny);
                  keys.push(key);
                  areas.push(cellArea);
                  levels.push(((v + 0.5) * h) / nv);
                  open.push(spans.length && !isOpen(layer.baseZ[f] + ((v + 0.5) * h) / nv, spans) ? 0 : 1);
                }
              }
            }
          });
        }
      }
    }
    return { positions: Float32Array.from(pos), normals: Float32Array.from(nrm), keys: Int32Array.from(keys),
      areas: Float32Array.from(areas), levels: Float32Array.from(levels), open: Uint8Array.from(open), count: keys.length, spacing: s };
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

  // ------------------------------------------------------------ daylight (VSC)
  /**
   * Vertical sky component on every wall (BRE 209): the share of the
   * illuminance an unobstructed horizontal surface gets from the CIE overcast
   * sky that reaches the wall point, with the buildings, trees and terrain in
   * the way. 39.6 % on an open wall; BRE 209 looks for 27 % at a window, or
   * at least 0.8 times the former value where something new is built.
   */
  async daylightVsc({ area, directions = 192, onProgress }) {
    const samples = this.facadeSamples(area);
    if (!samples.count) throw new Error('No building walls in the analysis area.');
    const dirs = vscDirections(skyHemisphere(directions));
    const res = await this.facadeRun(samples, { directions: dirs, cosMode: 1, area, onProgress });
    // Divide by the unobstructed sum and scale to the exact open value: the
    // finite set of directions then cancels out of the result.
    // Party walls (against another building) have no windows: left out.
    const vsc = new Float32Array(samples.count);
    let partyArea = 0, allArea = 0;
    for (let i = 0; i < samples.count; i++) {
      allArea += samples.areas[i];
      if (!samples.open[i]) { vsc[i] = NaN; partyArea += samples.areas[i]; continue; }
      const p = res.potential[i];
      vsc[i] = Number.isFinite(res.values[i]) && p > 0 ? (100 * VSC_OPEN * res.values[i]) / p : NaN;
    }
    // Per building: the mean, the lowest storey (the first 3 m, where BRE 209
    // looks first) and the share of wall at the 27 % target.
    const all = this.aggregateSamples(samples.keys, vsc, samples.areas);
    const lowKeys = [], lowVals = [], lowAreas = [], hitVals = new Float32Array(samples.count);
    for (let i = 0; i < samples.count; i++) {
      hitVals[i] = Number.isFinite(vsc[i]) ? (vsc[i] >= 100 * VSC_TARGET ? 100 : 0) : NaN;
      if (samples.levels[i] <= 3) { lowKeys.push(samples.keys[i]); lowVals.push(vsc[i]); lowAreas.push(samples.areas[i]); }
    }
    const fields = [
      ...this.toFields(all, 'vsc_facade'),
      ...this.toFields(this.aggregateSamples(Int32Array.from(lowKeys), Float32Array.from(lowVals), Float32Array.from(lowAreas)), 'vsc_ground'),
      ...this.toFields(this.aggregateSamples(samples.keys, hitVals, samples.areas), 'vsc27_share')
    ];
    let wallArea = 0, okArea = 0, sum = 0;
    for (let i = 0; i < samples.count; i++) {
      if (!Number.isFinite(vsc[i])) continue;
      wallArea += samples.areas[i]; sum += vsc[i] * samples.areas[i];
      if (vsc[i] >= 100 * VSC_TARGET) okArea += samples.areas[i];
    }
    let buildings = 0, okBuildings = 0;
    for (const a of all.values()) { buildings++; if (a.mean >= 100 * VSC_TARGET) okBuildings++; }
    return [{
      kind: 'vsc', title: 'Daylight on facades (VSC)', subtitle: `${directions} sky directions, CIE overcast sky`, unit: '%',
      facade: { ...samples, values: vsc, unit: '%', min: 0, max: 100 * VSC_OPEN, ramp: 'viridis' },
      display: { min: 0, max: 100 * VSC_OPEN, ramp: 'viridis' }, fields,
      stats: [['Mean VSC on walls', `${(sum / Math.max(1e-9, wallArea)).toFixed(1)} %`],
        ['Wall area at 27 % or more', `${((100 * okArea) / Math.max(1e-9, wallArea)).toFixed(0)} %`],
        ['Buildings with a mean of 27 % or more', `${okBuildings} / ${buildings}`],
        ['Party walls left out', `${((100 * partyArea) / Math.max(1e-9, allArea)).toFixed(0)} % of the wall area`]],
      notes: 'Vertical sky component (BRE 209) at points on every wall: 39.6 % for an open wall; 27 % or more at a window keeps enough daylight, and a new building should not leave a window with less than 0.8 times its former VSC. Walls built against another building have no windows and are left out. Fields: vsc_facade (mean), vsc_ground (lowest 3 m), vsc27_share (% of wall at 27 %).'
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
  /**
   * Viewshed from one observer (eye + observerHeight), or, with `eyes`, the
   * ground that sees any of several points (the top edge of a building:
   * visibility is mutual, so this is where that building can be seen from).
   */
  async viewshed({ area, cell, eye, eyes = null, observerHeight = 1.6, radius = 600, onProgress }) {
    const points = eyes ? eyes.map((p) => new THREE.Vector3(p.x, p.y, p.z)) : [new THREE.Vector3(eye.x, eye.y + observerHeight, eye.z)];
    let cx = 0, cz = 0;
    for (const p of points) { cx += p.x / points.length; cz += p.z / points.length; }
    const e = new THREE.Vector3(cx, Math.max(...points.map((p) => p.y)), cz);
    const sub = clipArea({ minX: e.x - radius, maxX: e.x + radius, minY: -e.z - radius, maxY: -e.z + radius }, area);
    let run = null;
    let vis = null;
    for (let k = 0; k < points.length; k++) {
      const one = await this.gridRun({ area: sub, cell, eye: points[k], maxDistance: radius, lift: 0.3, withIds: true,
        onProgress: (f) => onProgress?.((k + f) / points.length) });
      const v1 = one.values.map((v, i) => (Number.isFinite(v) && one.potential[i] > 0 ? (v > 0 ? 1 : 0) : NaN));
      if (!vis) { run = one; vis = v1; continue; }
      for (let i = 0; i < vis.length; i++) {
        if (v1[i] === 1) vis[i] = 1;
        else if (!Number.isFinite(vis[i]) && Number.isFinite(v1[i])) vis[i] = v1[i];
      }
    }
    let seen = 0, total = 0;
    vis.forEach((v) => { if (Number.isFinite(v)) { total++; if (v > 0) seen++; } });
    const visibleRoofs = this.aggregateGrid(run.ids, vis, cell * cell);
    return [{
      kind: 'viewshed', title: eyes ? 'Where the building is seen from' : 'Viewshed',
      subtitle: eyes ? `Ground that sees its top edge (${points.length} points), radius ${radius} m` : `Observer ${observerHeight} m above the surface, radius ${radius} m`,
      unit: '', grid: run.grid, values: vis, ids: run.ids, display: { min: 0, max: 1, categorical: { 0: '#3b4a6b', 1: '#f6c945' } },
      fields: this.toFields(visibleRoofs, 'visible_roof_pct', (a) => a.mean * 100),
      stats: [['Visible share of the surface', `${total ? ((100 * seen) / total).toFixed(0) : 0} %`], ['Visible area', `${fmtBig(seen * cell * cell)} m²`]],
      marker: { x: e.x, y: e.y, z: e.z },
      legend: [{ color: '#f6c945', label: 'Visible' }, { color: '#3b4a6b', label: 'Hidden' }]
    }];
  }

  treeObstacles() {
    const out = [];
    for (const layer of this.app.layers) {
      if (layer instanceof PointLayer && layer.visible && layer.isTree) out.push(...layer.obstacles());
    }
    if (Array.isArray(this.app.plantedTrees)) out.push(...this.app.plantedTrees);
    return out;
  }

  greenMask(grid) {
    const mask = new Uint8Array(grid.cols * grid.rows);
    for (const [x, y, rad] of this.treeObstacles()) {
      const c0 = Math.floor((x - rad - grid.minX) / grid.cell);
      const c1 = Math.ceil((x + rad - grid.minX) / grid.cell);
      const r0 = Math.floor((grid.maxY - y - rad) / grid.cell);
      const r1 = Math.ceil((grid.maxY - y + rad) / grid.cell);
      for (let r = Math.max(0, r0); r <= Math.min(grid.rows - 1, r1); r++) {
        for (let c = Math.max(0, c0); c <= Math.min(grid.cols - 1, c1); c++) {
          if (Math.hypot(grid.minX + c * grid.cell - x, grid.maxY - r * grid.cell - y) <= rad) {
            mask[r * grid.cols + c] = 1;
          }
        }
      }
    }
    const greenPattern = /green|park|grass|veg|lawn|garden|tree|forest|meadow/i;
    const greenLayers = this.app.layers.filter(
      (l) => l instanceof SurfaceLayer && l.visible && greenPattern.test(l.entry?.name || '')
    );
    if (greenLayers.length > 0) {
      for (let r = 0; r < grid.rows; r++) {
        for (let c = 0; c < grid.cols; c++) {
          const idx = r * grid.cols + c;
          if (mask[idx] === 1) continue;
          const x = grid.minX + c * grid.cell;
          const y = grid.maxY - r * grid.cell;
          for (const layer of greenLayers) {
            if (layer.featureAt(x, y) >= 0) {
              mask[idx] = 1;
              break;
            }
          }
        }
      }
    }
    return mask;
  }

  /**
   * Road sources for noise and dispersion: lines drawn in the viewer, then
   * every visible layer with the Roads role. weights holds each line's
   * relative traffic (the layer's "Traffic" expression, 1 when drawn).
   * @returns {{ lines: Array<Array<[number, number]>>, weights: number[] }}
   */
  roadLines() {
    const lines = [], weights = [];
    if (Array.isArray(this.app.drawnRoads)) {
      for (const line of this.app.drawnRoads) {
        if (Array.isArray(line) && line.length >= 2) { lines.push(line); weights.push(1); }
      }
    }
    for (const layer of this.app.layers) {
      if (!(layer instanceof LineLayer) || layer.entry.role !== 'roads' || !layer.visible) continue;
      layer.lines.forEach((parts, f) => {
        const w = layer.heights[f];
        for (const line of parts) {
          if (Array.isArray(line) && line.length >= 2) { lines.push(line); weights.push(Number.isFinite(w) ? w : 1); }
        }
      });
    }
    return { lines, weights };
  }

  surroundingFields(ids, heights, cols, rows, cell, values, fieldName, ringMetres = 15) {
    if (!ids) return [];
    const buildingLayers = new Set(this.app.layers.filter((l) => l instanceof ExtrudedLayer && !l.isWall).map((l) => l.index));
    const label = surroundings(ids, heights, cols, rows, Math.max(1, Math.round(ringMetres / cell)),
      (key) => buildingLayers.has(splitKey(key).layerIndex));
    const acc = new Map();
    for (let i = 0; i < label.length; i++) {
      const k = label[i];
      if (!k || !Number.isFinite(values[i])) continue;
      let a = acc.get(k);
      if (!a) { a = { sum: 0, n: 0 }; acc.set(k, a); }
      a.sum += values[i];
      a.n++;
    }
    for (const a of acc.values()) a.mean = a.sum / a.n;
    return this.toFields(acc, fieldName);
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
    // Trees: porous obstacles rasterised from their crowns (including planted trees).
    for (const [x, y, rad, h] of this.treeObstacles()) {
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
      fields: this.surroundingFields(og.ids, og.heights, grid.cols, grid.rows, cell, speed, 'ped_wind_ms'),
      stats: [
        ['Open-terrain pedestrian wind', `${(speed10 * OPEN_PEDESTRIAN_FACTOR).toFixed(1)} m/s`],
        ['Mean at pedestrian level', `${st.mean.toFixed(1)} m/s`],
        ['Sheltered (< half of open)', `${open.length ? ((100 * sheltered) / open.length).toFixed(0) : 0} %`],
        ...[...counts].map(([k, v]) => [`Comfort: ${k}`, `${((100 * v) / open.length).toFixed(0)} %`])
      ],
      wind: { fromDeg: windFromDeg, speed10 },
      ratio,
      notes: 'Geometric screening (wakes, channelling, tall-building corners). Confirm critical places with CFD or a wind-tunnel study. Comfort classes use LDDC (Lawson) thresholds, which apply to the speed exceeded 5 % of the time.'
    }];
  }

  // ------------------------------------------------------------ thermal comfort
  async comfort({ area, cell, month, day, hour, conditions, material = 'concrete', lai = 3.0, onProgress }) {
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

    const green = this.greenMask(grid);
    const dTa = canopyCoolingGrid({
      heights: og.heights,
      porosity: og.porosity,
      greenMask: green,
      cols: grid.cols,
      rows: grid.rows,
      cell,
      windFromDeg: conditions.windDir ?? 270,
      windSpeed: conditions.windSpeed ?? 2,
      airTemp: conditions.airTemp,
      rh: conditions.rh ?? 50,
      lai,
      svf: svfRun.values
    });

    const tSky = skyTemperature(conditions.airTemp, conditions.ir);
    const mrt = new Float32Array(n).fill(NaN);
    const index = new Float32Array(n).fill(NaN);
    const petGrid = new Float32Array(n).fill(NaN);
    const tsurf = new Float32Array(n).fill(NaN);

    let lastYield = performance.now();
    for (let i = 0; i < n; i++) {
      // PET is solved iteratively per cell: keep the page responsive.
      if ((i & 4095) === 0 && performance.now() - lastYield > 50) {
        await new Promise((res) => setTimeout(res, 0));
        lastYield = performance.now();
      }
      if (svfRun.ids[i] !== 0 || !Number.isFinite(svfRun.values[i])) continue; // open ground only

      const localTa = conditions.airTemp + (Number.isFinite(dTa[i]) ? dTa[i] : 0);
      const v10 = Math.max(0.5, Math.min(17, (conditions.windSpeed ?? 2) * (Number.isFinite(ratio[i]) ? ratio[i] : 1)));
      const vPed = Math.max(0.1, v10 * OPEN_PEDESTRIAN_FACTOR);
      const treeShade = og.porosity[i] > 0;
      const matKey = green[i] ? 'grass' : (SURFACE_MATERIALS[material] ? material : 'concrete');

      const ts = surfaceTemperature({
        airTemp: localTa,
        skyTemp: tSky,
        svf: svfRun.values[i],
        sunlit: sunlit ? sunlit[i] : 0,
        dni: conditions.dni,
        dhi: conditions.dhi,
        ghi: conditions.ghi,
        elevationDeg: elevDeg,
        windSpeed: vPed,
        material: matKey,
        treeShade,
        lai
      });
      tsurf[i] = ts;

      const tr = meanRadiantTemperature({
        airTemp: localTa,
        skyTemp: tSky,
        svf: svfRun.values[i],
        sunlit: sunlit ? sunlit[i] : 0,
        dni: conditions.dni,
        dhi: conditions.dhi,
        ghi: conditions.ghi,
        elevationDeg: elevDeg,
        groundTemp: ts,
        wallTemp: localTa
      });
      mrt[i] = tr;

      index[i] = utci(localTa, tr, v10, conditions.rh ?? 50);
      petGrid[i] = pet(localTa, tr, vPed, conditions.rh ?? 50);
    }

    const st = gridStats(index);
    const counts = new Map();
    for (const v of index) {
      if (!Number.isFinite(v)) continue;
      const c = UTCI_CATEGORIES.find((k) => v < k.max);
      if (c) counts.set(c.label, (counts.get(c.label) || 0) + 1);
    }
    const total = [...counts.values()].reduce((a, b) => a + b, 0);

    const petStats = gridStats(petGrid);
    const petCounts = new Map();
    for (const v of petGrid) {
      if (!Number.isFinite(v)) continue;
      const c = PET_CATEGORIES.find((k) => v < k.max) || PET_CATEGORIES[PET_CATEGORIES.length - 1];
      if (c) petCounts.set(c.label, (petCounts.get(c.label) || 0) + 1);
    }
    const petTotal = [...petCounts.values()].reduce((a, b) => a + b, 0);

    const when = `${day} ${monthName(month)} ${String(hour - 1).padStart(2, '0')}:00–${String(hour).padStart(2, '0')}:00`;
    const cond = `air ${conditions.airTemp.toFixed(1)} °C, RH ${Math.round(conditions.rh ?? 50)} %, wind ${(conditions.windSpeed ?? 2).toFixed(1)} m/s`;
    const utciMin = Math.floor(Math.min(st.min, conditions.airTemp - 5));
    const utciMax = Math.ceil(Math.max(st.max, conditions.airTemp + 5));

    const utciFields = this.surroundingFields(svfRun.ids, og.heights, grid.cols, grid.rows, cell, index, 'utci_c');
    const petFields = this.surroundingFields(svfRun.ids, og.heights, grid.cols, grid.rows, cell, petGrid, 'pet_c');
    const tsurfFields = this.surroundingFields(svfRun.ids, og.heights, grid.cols, grid.rows, cell, tsurf, 'tsurf_c');
    const dtCoolFields = this.surroundingFields(svfRun.ids, og.heights, grid.cols, grid.rows, cell, dTa, 'dt_cool_c');

    return [
      {
        kind: 'utci',
        title: `UTCI, ${when}`,
        subtitle: cond,
        unit: '°C',
        grid,
        values: index,
        ids: svfRun.ids,
        display: { min: utciMin, max: utciMax, ramp: 'rdylbu-r' },
        fields: [...utciFields, ...petFields, ...tsurfFields, ...dtCoolFields],
        stats: [
          ['Mean UTCI on open ground', `${st.mean.toFixed(1)} °C`],
          ['Range', `${st.min.toFixed(1)} – ${st.max.toFixed(1)} °C`],
          ...[...counts].map(([k, v]) => [k, `${((100 * v) / Math.max(1, total)).toFixed(0)} %`])
        ],
        notes: 'UTCI (Bröde et al. 2012) from air temperature, humidity, sheltered wind and a SolarCal mean radiant temperature; the ground at its modelled surface temperature, walls at the local air temperature.'
      },
      {
        kind: 'pet',
        title: `PET, ${when}`,
        subtitle: cond,
        unit: '°C',
        grid,
        values: petGrid,
        ids: svfRun.ids,
        display: {
          min: Math.floor(Math.min(petStats.min, conditions.airTemp - 5)),
          max: Math.ceil(Math.max(petStats.max, conditions.airTemp + 5)),
          ramp: 'rdylbu-r'
        },
        fields: petFields,
        stats: [
          ['Mean PET on open ground', `${petStats.mean.toFixed(1)} °C`],
          ['Range', `${petStats.min.toFixed(1)} – ${petStats.max.toFixed(1)} °C`],
          ...[...petCounts].map(([k, v]) => [k, `${((100 * v) / Math.max(1, petTotal)).toFixed(0)} %`])
        ],
        notes: 'Physiological Equivalent Temperature (Höppe 1999; Walther & Goestchel 2018 MEMI balance) at 1.1 m.'
      },
      {
        kind: 'mrt',
        title: `Mean radiant temperature, ${when}`,
        subtitle: cond,
        unit: '°C',
        grid,
        values: mrt,
        ids: svfRun.ids,
        display: { min: Math.floor(gridStats(mrt).min), max: Math.ceil(gridStats(mrt).max), ramp: 'inferno' },
        fields: [],
        stats: [['Mean MRT on open ground', `${gridStats(mrt).mean.toFixed(1)} °C`]]
      },
      {
        kind: 'tsurf',
        title: `Surface temperature, ${when}`,
        subtitle: `${SURFACE_MATERIALS[material]?.label || material}, LAI ${lai.toFixed(1)}`,
        unit: '°C',
        grid,
        values: tsurf,
        ids: svfRun.ids,
        display: { min: Math.floor(gridStats(tsurf).min), max: Math.ceil(gridStats(tsurf).max), ramp: 'magma' },
        fields: tsurfFields,
        stats: [
          ['Mean surface temp.', `${gridStats(tsurf).mean.toFixed(1)} °C`],
          ['Max surface temp.', `${gridStats(tsurf).max.toFixed(1)} °C`]
        ],
        notes: 'Steady-state radiative-convective surface energy balance with Bowen ratio partitioning and tree canopy attenuation.'
      },
      {
        kind: 'dt_cool',
        title: `Canopy & canyon air anomaly (ΔTa), ${when}`,
        subtitle: cond,
        unit: '°C',
        grid,
        values: dTa,
        ids: svfRun.ids,
        display: { min: -3.5, max: 2.0, ramp: 'rdbu-r' },
        fields: dtCoolFields,
        stats: [
          ['Mean ΔTa', `${gridStats(dTa).mean.toFixed(2)} °C`],
          ['Max cooling', `${gridStats(dTa).min.toFixed(2)} °C`]
        ],
        notes: 'Local air temperature anomaly from tree/green evapotranspiration advected downwind and deep-canyon heat trapping.'
      }
    ];
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
      unit: '', grid: bgrid, values: lczValues, display: { min: 0, max: 10, categorical: LCZ_COLORS, labels: LCZ_LABELS }, fields,
      legend: [...lczCounts.keys()].sort((a, b) => a - b).map((k) => ({ color: LCZ_COLORS[k], label: LCZ_LABELS[k] })),
      stats: [...lczCounts].sort((a, b) => b[1] - a[1]).map(([k, v]) => [LCZ_LABELS[k], `${((100 * v) / lczValues.length).toFixed(0)} %`]),
      notes: 'Classes from plan fraction, mean height and footprint size (Stewart and Oke 2012). LCZ 7 and 10 need material and land-use information.'
    });
    return results;
  }

  /** A year of outdoor comfort and wind around each building (EPW). */
  async climateYear(opts) {
    return climateAroundBuildings(this, opts);
  }

  windStats() {
    return this.app.weather?.windSpeed ? windRose(this.app.weather) : null;
  }

  conditionsFor(month, day, hour) {
    if (this.app.weather?.dryBulb) return conditionsAt(this.app.weather, month, day, hour);
    return null;
  }

  /**
   * manual: { airTemp, rh, windSpeed, windDir, hour } typed on the comfort
   * card; it replaces the weather file, and the air temperature follows a
   * day curve (amplitude 5 °C, warmest mid-afternoon) through the typed
   * value at its hour. Radiation then comes from a clear sky.
   */
  async diurnalStudy({ area, cell, date, material = 'concrete', lai = 3.0, startHour = 6, endHour = 21, manual = null, onProgress }) {
    const s = this.site();
    const doy = typicalDoy(date.month, date.day);
    const dayCurve = (hh) => 5 * Math.sin(((hh - 9) / 24) * 2 * Math.PI);
    let clearSky = null;
    const svfKey = cacheKey('svf', area, cell);
    let svfRun = this.cache.get(svfKey);
    if (!svfRun) {
      svfRun = await this.gridRun({ area, cell, directions: skyHemisphere(96), cosMode: 1, lift: 1.1, withIds: true,
        onProgress: (f) => onProgress?.(0.2 * f) });
    }
    const og = await this.obstacleGrid({ area, cell, onProgress: (f) => onProgress?.(0.2 + 0.1 * f) });
    const { grid } = og;
    const n = grid.cols * grid.rows;
    const green = this.greenMask(grid);

    const hours = [];
    const frames = [];
    let minVal = Infinity;
    let maxVal = -Infinity;

    const totalHours = Math.floor(endHour - startHour) + 1;
    let hourIdx = 0;

    for (let hh = startHour; hh <= endHour + 1e-9; hh += 1) {
      const p = solarPosition(doy, hh - 0.5, s.lat, s.lon, s.utcOffset);
      const elevDeg = p.elevation / DEG;

      let cond = manual ? null : this.conditionsFor(date.month, date.day, hh);
      if (!cond) {
        clearSky ??= clearSkyYear(s.lat, s.lon, s.utcOffset);
        const k = (doy - 1) * 24 + Math.max(0, Math.min(23, Math.round(hh) - 1));
        cond = {
          airTemp: manual ? manual.airTemp + dayCurve(hh) - dayCurve(manual.hour ?? 15) : 26 + dayCurve(hh),
          rh: manual?.rh ?? 50,
          windSpeed: manual?.windSpeed ?? 2.5,
          windDir: manual?.windDir ?? 270,
          dni: clearSky.dni[k],
          dhi: clearSky.dhi[k],
          ghi: clearSky.ghi[k],
          ir: null
        };
      }

      let sunlit = null;
      if (elevDeg > 0.5) {
        const dir = sunVector(p.elevation, p.azimuth);
        const sun = await this.gridRun({ area, cell, directions: [{ dir, weight: 1 }], cosMode: 0, lift: 1.1,
          onProgress: (f) => onProgress?.(0.3 + 0.7 * ((hourIdx + f) / totalHours)) });
        sunlit = sun.values;
      }

      const ratio = await windRatio({ heights: og.heights, porosity: og.porosity, cols: grid.cols, rows: grid.rows, cell,
        windFromDeg: cond.windDir ?? 270 });

      const dTa = canopyCoolingGrid({
        heights: og.heights,
        porosity: og.porosity,
        greenMask: green,
        cols: grid.cols,
        rows: grid.rows,
        cell,
        windFromDeg: cond.windDir ?? 270,
        windSpeed: cond.windSpeed ?? 2.5,
        airTemp: cond.airTemp,
        rh: cond.rh ?? 50,
        lai,
        svf: svfRun.values
      });

      const tSky = skyTemperature(cond.airTemp, cond.ir);
      const frame = new Float32Array(n).fill(NaN);

      let lastYield = performance.now();
      for (let i = 0; i < n; i++) {
        if ((i & 4095) === 0 && performance.now() - lastYield > 50) {
          await new Promise((res) => setTimeout(res, 0));
          lastYield = performance.now();
        }
        if (svfRun.ids[i] !== 0 || !Number.isFinite(svfRun.values[i])) continue;

        const localTa = cond.airTemp + (Number.isFinite(dTa[i]) ? dTa[i] : 0);
        const v10 = Math.max(0.5, Math.min(17, (cond.windSpeed ?? 2) * (Number.isFinite(ratio[i]) ? ratio[i] : 1)));
        const vPed = Math.max(0.1, v10 * OPEN_PEDESTRIAN_FACTOR);
        const treeShade = og.porosity[i] > 0;
        const matKey = green[i] ? 'grass' : (SURFACE_MATERIALS[material] ? material : 'concrete');

        const ts = surfaceTemperature({
          airTemp: localTa,
          skyTemp: tSky,
          svf: svfRun.values[i],
          sunlit: sunlit ? sunlit[i] : 0,
          dni: cond.dni,
          dhi: cond.dhi,
          ghi: cond.ghi,
          elevationDeg: elevDeg,
          windSpeed: vPed,
          material: matKey,
          treeShade,
          lai
        });

        const tr = meanRadiantTemperature({
          airTemp: localTa,
          skyTemp: tSky,
          svf: svfRun.values[i],
          sunlit: sunlit ? sunlit[i] : 0,
          dni: cond.dni,
          dhi: cond.dhi,
          ghi: cond.ghi,
          elevationDeg: elevDeg,
          groundTemp: ts,
          wallTemp: localTa
        });

        const u = utci(localTa, tr, v10, cond.rh ?? 50);
        frame[i] = u;
        if (Number.isFinite(u)) {
          if (u < minVal) minVal = u;
          if (u > maxVal) maxVal = u;
        }
      }

      hours.push(hh);
      frames.push(frame);
      hourIdx++;
    }

    if (!Number.isFinite(minVal)) minVal = 10;
    if (!Number.isFinite(maxVal)) maxVal = 35;

    const result = {
      kind: 'diurnalstudy',
      title: `Diurnal UTCI study, ${date.day} ${monthName(date.month)}`,
      subtitle: `${hours.length} hourly frames (${fmtHour(hours[0])}–${fmtHour(hours[hours.length - 1])})`,
      unit: '°C',
      grid,
      ids: svfRun.ids,
      frames,
      hours,
      frame: 0,
      date,
      values: new Float32Array(frames[0].length),
      display: { min: Math.floor(minVal), max: Math.ceil(maxVal), ramp: 'rdylbu-r' },
      fields: [],
      stats: [
        ['Hourly frames', String(hours.length)],
        ['Period', `${fmtHour(hours[0])}–${fmtHour(hours[hours.length - 1])}`],
        ['UTCI range', `${minVal.toFixed(1)} – ${maxVal.toFixed(1)} °C`]
      ],
      notes: 'Continuous diurnal outdoor thermal comfort animation (UTCI) accounting for surface energy balance, tree canopy shading, and evapotranspirative cooling advection.'
    };
    setDiurnalFrame(result, 0);
    return [result];
  }

  async ventilation({ area, cell, windFromDeg = 270, speed10 = 4, emissionRateUgMS = 60, backgroundUgM3 = 18, treeDepositionFactor = 0.25, roads = null, roadWeights = null, onProgress }) {
    const og = await this.obstacleGrid({ area, cell, onProgress: (f) => onProgress?.(0.25 * f) });
    const { grid } = og;
    const ratio = await windRatio({ heights: og.heights, porosity: og.porosity, cols: grid.cols, rows: grid.rows, cell,
      windFromDeg, onProgress: (f) => onProgress?.(0.25 + 0.25 * f) });
    const svfKey = cacheKey('svf', area, cell);
    let svfRun = this.cache.get(svfKey);
    if (!svfRun) {
      svfRun = await this.gridRun({ area, cell, directions: skyHemisphere(96), cosMode: 1, lift: 1.1, withIds: true,
        onProgress: (f) => onProgress?.(0.5 + 0.2 * f) });
    }
    const { vei, airAge } = ventilationEfficiency({
      windRatioGrid: ratio,
      heights: og.heights,
      porosity: og.porosity,
      svf: svfRun.values,
      cols: grid.cols,
      rows: grid.rows,
      cell
    });

    const src = roads ? { lines: roads, weights: roadWeights } : this.roadLines();
    const conc = await pollutantDispersion({
      heights: og.heights,
      porosity: og.porosity,
      windRatioGrid: ratio,
      svf: svfRun.values,
      cols: grid.cols,
      rows: grid.rows,
      cell,
      minX: grid.minX,
      maxY: grid.maxY,
      windFromDeg,
      windSpeed10: speed10,
      roads: src.lines,
      roadWeights: src.weights,
      emissionRateUgMS,
      backgroundUgM3,
      treeDepositionFactor,
      onProgress: (f) => onProgress?.(0.7 + 0.3 * f)
    });

    const ventFields = this.surroundingFields(og.ids, og.heights, grid.cols, grid.rows, cell, vei, 'vent_index');
    const no2Fields = this.surroundingFields(og.ids, og.heights, grid.cols, grid.rows, cell, conc, 'air_no2_ugm3');

    const openVei = vei.filter(Number.isFinite);
    const stVei = gridStats(openVei);
    const vCounts = new Map();
    for (const v of openVei) {
      const c = ventilationClass(v);
      if (c) vCounts.set(c.label, (vCounts.get(c.label) || 0) + 1);
    }

    const openAirAge = airAge.filter(Number.isFinite);
    const stAge = gridStats(openAirAge);

    const openConc = conc.filter(Number.isFinite);
    const stConc = gridStats(openConc);
    const aqCounts = new Map();
    for (const v of openConc) {
      const c = airQualityClass(v);
      if (c) aqCounts.set(c.label, (aqCounts.get(c.label) || 0) + 1);
    }

    return [
      {
        kind: 'vei',
        title: `Street canyon ventilation (VEI), from ${windFromDeg}°`,
        subtitle: `${speed10.toFixed(1)} m/s at 10 m`,
        unit: '',
        grid,
        values: vei,
        ids: og.ids,
        display: { min: 0, max: 1.2, ramp: 'spectral-r' },
        fields: ventFields,
        stats: [
          ['Open ground, mean VEI', stVei.mean.toFixed(2)],
          ['Open ground, min VEI', stVei.min.toFixed(2)],
          ...[...vCounts].map(([k, v]) => [k, `${((100 * v) / Math.max(1, openVei.length)).toFixed(0)} %`])
        ],
        notes: 'Ventilation Efficiency Index (VEI) combining pedestrian wind ratio and sky view factor. Low values indicate stagnant street canyons.'
      },
      {
        kind: 'airage',
        title: `Normalized air age (tau), from ${windFromDeg}°`,
        subtitle: `${speed10.toFixed(1)} m/s at 10 m`,
        unit: '',
        grid,
        values: airAge,
        ids: og.ids,
        display: { min: 1, max: 8, ramp: 'spectral' },
        fields: [],
        stats: [
          ['Mean normalized air age', stAge.mean.toFixed(1)],
          ['Max air age (stagnant pockets)', stAge.max.toFixed(1)]
        ],
        notes: 'Dimensionless mean age of air relative to open flow. Higher values signify air stagnation and poor flush rates.'
      },
      {
        kind: 'dispersion',
        title: `Traffic pollutant concentration (NO2), from ${windFromDeg}°`,
        subtitle: `Emission ${emissionRateUgMS} µg/(m·s), background ${backgroundUgM3} µg/m³; ${roadSourceText(src.lines)}`,
        unit: 'µg/m³',
        grid,
        values: conc,
        ids: og.ids,
        display: { min: backgroundUgM3, max: Math.min(150, Math.ceil(stConc.max)), ramp: 'spectral-r' },
        fields: no2Fields,
        stats: [
          ['Open ground, mean concentration', `${stConc.mean.toFixed(1)} µg/m³`],
          ['Highest local concentration', `${stConc.max.toFixed(1)} µg/m³`],
          ...[...aqCounts].map(([k, v]) => [k, `${((100 * v) / Math.max(1, openConc.length)).toFixed(0)} %`])
        ],
        notes: 'Street-canyon pollutant dispersion based on OSPM Gaussian plume and canyon vortex trapping with tree canopy filtration.'
      }
    ];
  }

  async noise({ area, cell, soundPowerDb = 78, receiverHeight = 1.5, groundFactor = 0.5, roads = null, roadWeights = null, onProgress }) {
    const og = await this.obstacleGrid({ area, cell, onProgress: (f) => onProgress?.(0.4 * f) });
    const { grid } = og;
    const src = roads ? { lines: roads, weights: roadWeights } : this.roadLines();

    const noiseGrid = await noisePropagation({
      heights: og.heights,
      porosity: og.porosity,
      cols: grid.cols,
      rows: grid.rows,
      cell,
      minX: grid.minX,
      maxY: grid.maxY,
      roads: src.lines,
      roadWeights: src.weights,
      soundPowerDb,
      receiverHeight,
      groundFactor,
      onProgress: (f) => onProgress?.(0.4 + 0.6 * f)
    });

    const facadeMap = buildingFacadeNoise(noiseGrid, og.ids, grid.cols, grid.rows);
    const fields = [
      ...this.toFields(facadeMap, 'noise_dba_max', (a) => a.max),
      ...this.toFields(facadeMap, 'noise_dba_mean', (a) => a.mean),
      ...this.toFields(facadeMap, 'quiet_facade', (a) => a.quietFacade)
    ];

    const openNoise = noiseGrid.filter(Number.isFinite);
    const st = gridStats(openNoise);
    const loudCount = openNoise.filter((v) => v >= 65).length;

    const nCounts = new Map();
    for (const v of openNoise) {
      const c = noiseClass(v);
      if (c) nCounts.set(c.label, (nCounts.get(c.label) || 0) + 1);
    }

    return [{
      kind: 'noise',
      title: 'Environmental noise (Lden)',
      subtitle: `Sound power ${soundPowerDb} dB(A)/m, receiver at ${receiverHeight.toFixed(1)} m; ${roadSourceText(src.lines)}`,
      unit: 'dB(A)',
      grid,
      values: noiseGrid,
      ids: og.ids,
      display: { min: 40, max: 80, ramp: 'magma' },
      fields,
      stats: [
        ['Mean open-ground noise', `${st.mean.toFixed(1)} dB(A)`],
        ['Max noise level', `${st.max.toFixed(1)} dB(A)`],
        ['Share of area ≥ 65 dB(A)', `${openNoise.length ? ((100 * loudCount) / openNoise.length).toFixed(0) : 0} %`],
        ...[...nCounts].map(([k, v]) => [k, `${((100 * v) / Math.max(1, openNoise.length)).toFixed(0)} %`])
      ],
      notes: '3D acoustic propagation (ISO 9613-2 / CNOSSOS-EU proxy) with Maekawa barrier diffraction and tree attenuation.'
    }];
  }

  async greenView({ area, cell, eyeHeight = 1.6, maxRadius = 80, onProgress }) {
    const og = await this.obstacleGrid({ area, cell, onProgress: (f) => onProgress?.(0.3 * f) });
    const { grid } = og;
    const buildingHeights = og.heights.map((h, i) => (og.ids[i] ? h : 0));
    const treeObs = this.treeObstacles();
    const green = this.greenMask(grid);

    const gvi = await greenViewIndex({
      buildingHeights,
      treeObstacles: treeObs,
      greenMask: green,
      cols: grid.cols,
      rows: grid.rows,
      cell,
      minX: grid.minX - 0.5 * cell,
      maxY: grid.maxY + 0.5 * cell,
      eyeHeight,
      maxRadius,
      onProgress: (f) => onProgress?.(0.3 + 0.7 * f)
    });

    const fields = this.surroundingFields(og.ids, og.heights, grid.cols, grid.rows, cell, gvi, 'gvi_pct');

    const openGvi = gvi.filter(Number.isFinite);
    const st = gridStats(openGvi);
    const highGreen = openGvi.filter((v) => v >= 20).length;

    const gCounts = new Map();
    for (const v of openGvi) {
      const c = gviClass(v);
      if (c) gCounts.set(c.label, (gCounts.get(c.label) || 0) + 1);
    }

    return [{
      kind: 'gvi',
      title: 'Green View Index (GVI)',
      subtitle: `Panoramic eye-level green visibility at ${eyeHeight.toFixed(1)} m, radius ${maxRadius} m`,
      unit: '%',
      grid,
      values: gvi,
      ids: og.ids,
      display: { min: 0, max: 50, ramp: 'greens' },
      fields,
      stats: [
        ['Mean GVI on open ground', `${st.mean.toFixed(1)} %`],
        ['Share of area ≥ 20 % green view', `${openGvi.length ? ((100 * highGreen) / openGvi.length).toFixed(0) : 0} %`],
        ...[...gCounts].map(([k, v]) => [k, `${((100 * v) / Math.max(1, openGvi.length)).toFixed(0)} %`])
      ],
      notes: 'Panoramic Green View Index (Treepedia / MIT Senseable City Lab proxy) evaluating eye-level visible green canopy and surface vegetation.'
    }];
  }

  async solarEnvelope({ area, cell, date = { month: 12, day: 21 }, startHour = 9, endHour = 15, minSunHours = 2, maxBuildableHeight = 72, floorHeight = 3.2, onProgress }) {
    const s = this.site();
    const og = await this.obstacleGrid({ area, cell, onProgress: (f) => onProgress?.(0.3 * f) });
    const { grid } = og;
    const buildingHeights = og.heights.map((h, i) => (og.ids[i] ? h : 0));
    const sunVectors = sunPath(typicalDoy(date.month, date.day), s.lat, s.lon, s.utcOffset, { startHour, endHour, stepMinutes: 30 });

    const env = calcSolarEnvelope({
      buildingHeights,
      ids: og.ids,
      cols: grid.cols,
      rows: grid.rows,
      cell,
      sunVectors,
      minSunHours,
      stepHours: 0.5,
      maxBuildableHeight,
      floorHeight
    });

    const fields = this.toFields(this.aggregateGrid(og.ids, env.maxHeight, cell * cell), 'env_max_h');
    const stH = gridStats(env.maxHeight);
    const stF = gridStats(env.maxFloors);

    return [
      {
        kind: 'solarenvelope',
        title: 'Solar envelope height limit',
        subtitle: `${date.day} ${monthName(date.month)}, ${minSunHours} h sun window (${fmtHour(startHour)}–${fmtHour(endHour)})`,
        unit: 'm',
        grid,
        values: env.maxHeight,
        ids: og.ids,
        display: { min: 0, max: maxBuildableHeight, ramp: 'viridis' },
        fields,
        stats: [
          ['Mean height limit', `${stH.mean.toFixed(1)} m`],
          ['Max allowed height', `${stH.max.toFixed(1)} m`]
        ],
        notes: 'Solar envelope (Knowles 1981): maximum buildable height that preserves neighbours\' direct solar access.'
      },
      {
        kind: 'solarfloors',
        title: 'Solar envelope floor capacity',
        subtitle: `${floorHeight.toFixed(1)} m per floor, cap ${Math.floor(maxBuildableHeight / floorHeight)} floors`,
        unit: 'floors',
        grid,
        values: env.maxFloors,
        ids: og.ids,
        display: { min: 0, max: Math.floor(maxBuildableHeight / floorHeight), ramp: 'viridis' },
        fields: [],
        stats: [
          ['Mean floor capacity', `${stF.mean.toFixed(0)} floors`]
        ]
      }
    ];
  }
}

// ---------------------------------------------------------------- helpers
/** Where the road sources of a noise or dispersion run came from. */
function roadSourceText(lines) {
  return lines.length ? `${lines.length} road line${lines.length === 1 ? '' : 's'}` : 'no roads given: the streets between buildings, as residential streets';
}

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

/** Show frame k of a continuous diurnal study (Float32Array values + fresh drape texture). */
export function setDiurnalFrame(result, k) {
  const frame = result.frames[Math.max(0, Math.min(result.frames.length - 1, k))];
  result.values.set(frame);
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
