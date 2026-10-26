// @ts-check
// "Terrain" tab: display, section profiles, flooding and cut/fill.
import { h, clear, row, select, number, toggle, button, card, stats, download, toast, slider } from './dom.js';
import { SHADING_MODES } from '../scene/terrain.js';
import { profile, flood, cutFill, balancedLevel, gridStats } from '../core/terrain_math.js';
import { drawProfile } from './charts.js';
import { ExtrudedLayer, LineLayer, PlatformLayer } from '../scene/objects.js';
import { sendGrid, sendFields } from './qgis_link.js';
import { TERRAIN_ANALYSES, terrainAnalyses } from '../analysis/terrain_results.js';

export function buildTerrainPanel(app, root) {
  clear(root);
  root.appendChild(displayCard(app));
  root.appendChild(analysesCard(app));
  root.appendChild(profileCard(app));
  root.appendChild(floodCard(app));
  root.appendChild(cutFillCard(app));
}

function displayCard(app) {
  const t = app.terrain;
  const exSlider = slider(t.exaggeration, { min: 1, max: 5, step: 0.25, format: (v) => `× ${v}`, onChange: (v) => app.setExaggeration(v) });
  app.on((what) => { if (what === 'exaggeration') exSlider.set(app.terrain.exaggeration); });
  const body = h('div', {},
    row('Shading', select(Object.entries(SHADING_MODES), t.shading, (v) => t.setShading(v))),
    row('Vertical exaggeration', exSlider, 'Display only: analyses reset it to 1'),
    row('Contours', select([[0, 'Off'], [0.5, '0.5 m'], [1, '1 m'], [2, '2 m'], [5, '5 m'], [10, '10 m'], [25, '25 m'], [50, '50 m']], t.contourInterval,
      (v) => t.setContours(Number(v))), 'Every fifth line is drawn darker'),
    row('Buildings on slopes', select([['lowest', 'Lowest ground (buried uphill)'], ['average', 'Average ground (half plinth)'],
      ['highest', 'Highest ground (plinth downhill)']], app.slopeMode, (v) => app.setSlopeMode(v)),
      'The level a building stands on; heights count from it. A plinth fills the gap down to the ground.'),
    row('Live shadows', toggle(app.viewer.shadowsOn, (v) => app.viewer.setShadows(v))));
  return card('Display', body, { open: true });
}

// ---------------------------------------------------------------- terrain analyses
function analysesCard(app) {
  app.params.terrain ??= { kinds: ['elevation', 'slope', 'aspect', 'hillshade'], extent: 'scene', tpiRadius: 100 };
  const p = app.params.terrain;
  const list = h('div', { class: 'checks' });
  for (const a of TERRAIN_ANALYSES) {
    list.appendChild(h('div', { class: 'check-row terrain-row', title: a.help },
      toggle(p.kinds.includes(a.id), (v) => {
        p.kinds = v ? TERRAIN_ANALYSES.map((x) => x.id).filter((id) => id === a.id || p.kinds.includes(id)) : p.kinds.filter((x) => x !== a.id);
      }, a.label),
      a.id === 'tpi' ? h('span', { class: 'muted small' }, 'radius ', number(p.tpiRadius, { step: 10, width: '4.5em', onChange: (v) => { if (v > 0) p.tpiRadius = v; } }), ' m') : null));
  }
  const run = async (compare) => {
    const res = await app.run('Terrain analyses', (prog) => terrainAnalyses(app, { kinds: p.kinds, extent: p.extent, tpiRadius: p.tpiRadius, onProgress: prog }));
    if (res?.length && compare) app.compare?.showResults(res);
  };
  const body = h('div', {},
    h('p', { class: 'muted small', text: 'Maps of the DEM itself. Each becomes a result: drawn on the ground, chosen in a compare panel, sent to QGIS as a GeoTIFF.' }),
    list,
    row('Extent', select([['scene', 'Whole DEM'], ['area', 'Analysis area']], p.extent, (v) => { p.extent = v; }),
      'Large DEMs are coarsened to at most 4 million cells for these maps'),
    h('div', { class: 'btn-row' },
      button('Run', () => run(false), { kind: 'primary run' }),
      button('Run and compare', () => run(true), { title: 'Open the results side by side in 2, 4, 6 or 8 panels' })));
  return card('Terrain analyses', body, { open: true });
}

// ---------------------------------------------------------------- profile
function profileCard(app) {
  const state = { line: null, data: null, withBuildings: true };
  const canvas = h('canvas', { class: 'chart' });
  const summary = h('div', {});
  const sections = [];
  for (const layer of app.layers) {
    if (!(layer instanceof LineLayer)) continue;
    layer.lines.forEach((parts, f) => { if (parts[0]?.length >= 2) sections.push([`${layer.index}:${f}`, `${layer.entry.name} #${f + 1}`, parts[0]]); });
  }
  const compute = async () => {
    if (!state.line) return;
    const t = app.terrain;
    let len = 0;
    for (let i = 0; i < state.line.length - 1; i++) len += Math.hypot(state.line[i + 1][0] - state.line[i][0], state.line[i + 1][1] - state.line[i][1]);
    const step = Math.max(0.5, Math.min(t.grid.cell / 2, len / 800));
    const pts = profile(t.grid, state.line, step);
    if (state.withBuildings && app.layers.some((l) => l instanceof ExtrudedLayer && l.visible)) {
      const xs = state.line.map((p) => p[0]), ys = state.line.map((p) => p[1]);
      const pad = step * 2;
      const sc = app.sceneArea();
      const area = { minX: Math.max(sc.minX, Math.min(...xs) - pad), maxX: Math.min(sc.maxX, Math.max(...xs) + pad),
        minY: Math.max(sc.minY, Math.min(...ys) - pad), maxY: Math.min(sc.maxY, Math.max(...ys) + pad) };
      const cell = Math.max(step, Math.sqrt(((area.maxX - area.minX) * (area.maxY - area.minY)) / 4e6));
      const geo = await app.analyst.gridRun({ area, cell, withIds: true });
      const g = geo.grid;
      for (const p of pts) {
        const c = Math.round((p.x - g.minX) / g.cell), r = Math.round((g.maxY - p.y) / g.cell);
        if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) continue;
        const i = r * g.cols + c;
        // Building heights are not exaggerated: take the height above the drawn ground.
        if (geo.ids[i] && Number.isFinite(geo.heights[i])) p.top = p.z + Math.max(0, geo.heights[i] - t.toY(p.z));
      }
    }
    state.data = { points: pts, water: app.waterLevel ?? NaN };
    drawProfile(canvas, state.data);
    let up = 0, down = 0, maxSlope = 0;
    for (let i = 1; i < pts.length; i++) {
      const dz = pts[i].z - pts[i - 1].z;
      if (dz > 0) up += dz; else down -= dz;
      const dd = pts[i].d - pts[i - 1].d;
      if (dd > 0) maxSlope = Math.max(maxSlope, Math.abs(dz / dd));
    }
    const st = gridStats(pts.map((p) => p.z));
    clear(summary);
    summary.appendChild(stats([['Length', `${len.toFixed(0)} m`], ['Elevation', `${st.min.toFixed(1)} – ${st.max.toFixed(1)} m`],
      ['Climb / descent', `${up.toFixed(0)} / ${down.toFixed(0)} m`], ['Steepest', `${(maxSlope * 100).toFixed(0)} %`]]));
    app.tools.outline('profile-line', state.line, 0xff4f2e);
  };
  const draw = async () => {
    const line = await app.tools.drawLine('Draw the section line');
    if (line) { state.line = line; compute(); }
  };
  const body = h('div', {},
    h('div', { class: 'btn-row' }, button('Draw section', draw, { kind: 'primary' }),
      sections.length ? select([['', 'Section line from QGIS…'], ...sections.map(([k, l]) => [k, l])], '', (v) => {
        const s = sections.find(([k]) => k === v);
        if (s) { state.line = s[2]; compute(); }
      }) : null),
    row('Show buildings', toggle(state.withBuildings, (v) => { state.withBuildings = v; compute(); })),
    canvas, summary,
    h('div', { class: 'btn-row' },
      button('PNG', () => state.data && download('profile.png', canvas.toDataURL('image/png'))),
      button('CSV', () => state.data && download('profile.csv', profileCsv(app, state.data), 'text/csv')),
      button('DXF', () => state.data && download('profile.dxf', profileDxf(state.data), 'application/dxf'))));
  return card('Section & profile', body);
}

function profileCsv(app, data) {
  const [ox, oy] = app.manifest.origin;
  const out = ['distance_m,x,y,ground_m,building_top_m'];
  for (const p of data.points) out.push(`${p.d.toFixed(2)},${(p.x + ox).toFixed(3)},${(p.y + oy).toFixed(3)},${p.z.toFixed(3)},${Number.isFinite(p.top) ? p.top.toFixed(3) : ''}`);
  return out.join('\n');
}

/** Minimal DXF R12: ground line and building outlines in (distance, elevation). */
function profileDxf(data) {
  const out = ['0', 'SECTION', '2', 'ENTITIES'];
  const poly = (pts, layer) => {
    out.push('0', 'POLYLINE', '8', layer, '66', '1', '70', '0');
    for (const [x, y] of pts) out.push('0', 'VERTEX', '8', layer, '10', x.toFixed(3), '20', y.toFixed(3), '30', '0');
    out.push('0', 'SEQEND');
  };
  poly(data.points.map((p) => [p.d, p.z]), 'GROUND');
  let run = null;
  const flush = (end) => { if (run) { poly([[run.d0, run.z0], [run.d0, run.top], [end.d, run.top], [end.d, end.z]], 'BUILDINGS'); run = null; } };
  for (const p of data.points) {
    if (Number.isFinite(p.top)) {
      if (run && Math.abs(run.top - p.top) > 0.5) flush(p);
      if (!run) run = { d0: p.d, z0: p.z, top: p.top };
    } else if (run) flush(p);
  }
  // A building still open where the section line ends.
  if (data.points.length) flush(data.points[data.points.length - 1]);
  out.push('0', 'ENDSEC', '0', 'EOF');
  return out.join('\n');
}

// ---------------------------------------------------------------- flooding
function floodCard(app) {
  const t = app.terrain;
  const lo = Math.floor(t.min), hi = Math.ceil(t.max);
  const state = { level: Math.round(t.min + (t.max - t.min) * 0.15), seed: null, result: null };
  const info = h('div', {});
  const levelSlider = slider(state.level, { min: lo, max: hi, step: Math.max(0.1, (hi - lo) / 400), format: (v) => `${v.toFixed(1)} m`,
    onChange: (v) => { state.level = v; apply(); } });
  const apply = () => {
    const res = flood(t.grid, state.level, state.seed);
    state.result = res;
    app.waterLevel = state.level;
    t.setWater(state.level, res.floodedCells ? res.depth : null);
    // Buildings standing in flooded cells.
    let hit = 0;
    const fields = [];
    for (const layer of app.layers) {
      if (!(layer instanceof ExtrudedLayer) || layer.isWall) continue;
      const depth = new Float32Array(layer.count).fill(NaN);
      const g = t.grid;
      for (let f = 0; f < layer.count; f++) {
        const c = Math.round((layer.centroid[f * 2] - g.minX) / g.cell), r = Math.round((g.maxY - layer.centroid[f * 2 + 1]) / g.cell);
        if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) continue;
        const wet = Number.isFinite(res.depth[r * g.cols + c]) || (!state.seed && layer.zMin[f] < state.level);
        // Water reaches a building at its lowest ground point, whatever the slope setting.
        if (wet && layer.zMin[f] < state.level) { depth[f] = state.level - layer.zMin[f]; hit++; }
      }
      layer.setResultField('flood_depth_m', depth);
      fields.push({ layer, name: 'flood_depth_m', values: depth });
    }
    state.fields = fields;
    clear(info);
    info.appendChild(stats([['Flooded area', `${(res.area / 10000).toFixed(2)} ha`], ['Water volume', `${Math.round(res.volume).toLocaleString('en-US')} m³`],
      ['Deepest', `${res.maxDepth.toFixed(2)} m`], ['Buildings reached', String(hit)]]));
  };
  const body = h('div', {},
    h('p', { class: 'muted small', text: 'A still water level: everything below it floods ("bathtub"), or only the ground connected to a point you pick, as water rising from a river or a low spot. Not a hydraulic model.' }),
    row('Water level', levelSlider),
    row('Flooding from', select([['all', 'All low ground'], ['seed', 'A picked point']], state.seed ? 'seed' : 'all', async (v) => {
      if (v === 'seed') {
        const p = await app.tools.pickPoint('Click where the water comes from', { roofs: false });
        state.seed = p ? p.local : null;
      } else state.seed = null;
      apply();
    })),
    info,
    h('div', { class: 'btn-row' }, button('Apply', apply, { kind: 'primary' }), button('Clear', () => { app.waterLevel = null; t.setWater(0, null); clear(info); }),
      app.qgis ? button('To QGIS', async () => {
        if (!state.result) return;
        const r = { title: `Flood depth at ${state.level.toFixed(1)} m`, unit: 'm', grid: t.grid, values: state.result.depth, display: { min: 0, max: Math.max(0.1, state.result.maxDepth), ramp: 'blues' } };
        await sendGrid(r, `flood_${state.level.toFixed(1).replace('.', '_')}m`);
        if (state.fields?.length) await sendFields(state.fields, 'blues');
        toast('Flood depth sent to QGIS.');
      }) : null));
  return card('Water level & flooding', body);
}

// ---------------------------------------------------------------- cut / fill
function cutFillCard(app) {
  const t = app.terrain;
  const state = { ring: null, level: 0, result: null };
  const info = h('div', {});
  const levelInput = number(0, { step: 0.1, onChange: (v) => { state.level = v; compute(); } });
  const platforms = [];
  for (const layer of app.layers) {
    if (!(layer instanceof PlatformLayer)) continue;
    layer.rings.forEach((rings, f) => { if (rings[0]) platforms.push([`${layer.index}:${f}`, `${layer.entry.name} #${f + 1}`, rings[0], layer, f]); });
  }
  const compute = () => {
    if (!state.ring) return;
    const res = cutFill(t.grid, state.ring, state.level);
    state.result = res;
    clear(info);
    info.appendChild(stats([['Platform area', `${Math.round(res.area).toLocaleString('en-US')} m²`], ['Cut', `${Math.round(res.cut).toLocaleString('en-US')} m³`],
      ['Fill', `${Math.round(res.fill).toLocaleString('en-US')} m³`], ['Net (fill − cut)', `${Math.round(res.net).toLocaleString('en-US')} m³`]]));
    const st = gridStats(res.delta);
    const m = Math.max(Math.abs(st.min), Math.abs(st.max), 0.5);
    app.results.unshift({ id: `cf${Date.now()}`, kind: 'cutfill', title: `Cut & fill to ${state.level.toFixed(2)} m`, subtitle: 'Blue: fill, red: cut',
      unit: 'm', grid: t.grid, values: res.delta, display: { min: -m, max: m, ramp: 'rdbu' }, fields: [], created: new Date(),
      stats: [['Cut', `${Math.round(res.cut)} m³`], ['Fill', `${Math.round(res.fill)} m³`]] });
    app.showResult(app.results[0]);
    app.emit('results');
    const sel = state.platform;
    if (sel) sel[3].setLevel(sel[4], state.level);
  };
  const setRing = (ring, platform = null) => {
    state.ring = ring;
    state.platform = platform;
    const lvl = platform && platform[3].levels[platform[4]] > 0 ? platform[3].levels[platform[4]] : balancedLevel(t.grid, ring);
    state.level = Math.round(lvl * 100) / 100;
    levelInput.value = String(state.level);
    app.tools.outline('cutfill-outline', [...ring, ring[0]], 0xc9a46b);
    compute();
  };
  const body = h('div', {},
    h('p', { class: 'muted small', text: 'Earthwork to bring an area to one flat design level. "Balance" finds the level where cut equals fill.' }),
    h('div', { class: 'btn-row' }, button('Draw platform', async () => {
      const ring = await app.tools.drawPolygon('Draw the platform outline');
      if (ring) setRing(ring);
    }, { kind: 'primary' }),
    platforms.length ? select([['', 'Platform from QGIS…'], ...platforms.map(([k, l]) => [k, l])], '', (v) => {
      const p = platforms.find(([k]) => k === v);
      if (p) setRing(p[2], p);
    }) : null),
    row('Design level (m)', levelInput),
    h('div', { class: 'btn-row' }, button('Balance', () => { if (state.ring) { state.level = Math.round(balancedLevel(t.grid, state.ring) * 100) / 100; levelInput.value = String(state.level); compute(); } })),
    info);
  return card('Cut & fill', body);
}
