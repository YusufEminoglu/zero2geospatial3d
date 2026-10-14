// @ts-check
// "Compare" tab: scenario A/B switch and difference analyses, and the
// building-height optimiser.
import { h, clear, row, select, number, button, card, stats, toast, download } from './dom.js';
import { ExtrudedLayer } from '../scene/objects.js';
import { optimiseHeights } from '../analysis/optimize.js';
import { drawScatter } from './charts.js';
import { sendFields } from './qgis_link.js';
import { gridStats } from '../core/terrain_math.js';
import { MONTH_NAMES } from '../core/weather.js';

export function buildComparePanel(app, root) {
  clear(root);
  root.appendChild(scenarioCard(app));
  root.appendChild(optimiseCard(app));
}

function scenarioLayers(app) {
  return {
    a: app.layers.filter((l) => l.entry.scenario === 'A'),
    b: app.layers.filter((l) => l.entry.scenario === 'B')
  };
}

function showScenario(app, which) {
  const { a, b } = scenarioLayers(app);
  for (const l of a) l.setVisible(which === 'A');
  for (const l of b) l.setVisible(which === 'B');
  app.analyst.cache.clear();
  app.scenario = which;
}

function scenarioCard(app) {
  const { a, b } = scenarioLayers(app);
  if (!a.length && !b.length) {
    return card('Scenarios', h('p', { class: 'muted', text: 'To compare two plans, set building layers to "Scenario A" and "Scenario B" in the QGIS panel (step 2). Layers marked "Existing" appear in both.' }), { open: true });
  }
  const state = { kind: 'sun' };
  const info = h('div', {});
  const runPair = async () => {
    const p = app.params;
    const runners = {
      sun: (prog) => app.analyst.sunHours({ area: app.area(), cell: app.cell(), date: { month: p.sun.month, day: p.sun.day },
        startHour: p.sun.start, endHour: p.sun.end, stepMinutes: p.sun.step, onProgress: prog }),
      svf: (prog) => app.analyst.skyView({ area: app.area(), cell: app.cell(), directions: p.svf.directions, onProgress: prog }),
      solar: (prog) => app.analyst.solarRadiation({ area: app.area(), cell: app.cell(), tiltDeg: p.solar.tilt, azimuthDeg: p.solar.azimuth, onProgress: prog }),
      wind: (prog) => app.analyst.wind({ area: app.area(), cell: Math.max(2, app.cell(600)), windFromDeg: p.wind.from, speed10: p.wind.speed, onProgress: prog })
    };
    const before = app.scenario || 'A';
    await app.run('Scenario comparison', async (prog) => {
      showScenario(app, 'A');
      const ra = (await runners[state.kind]((f) => prog(f / 2)))[0];
      showScenario(app, 'B');
      const rb = (await runners[state.kind]((f) => prog(0.5 + f / 2)))[0];
      showScenario(app, before);
      const diff = new Float32Array(ra.values.length).fill(NaN);
      let gain = 0, loss = 0, n = 0;
      const tol = state.kind === 'svf' ? 0.02 : state.kind === 'wind' ? 0.2 : state.kind === 'solar' ? 20 : 0.25;
      for (let i = 0; i < diff.length; i++) {
        if (!Number.isFinite(ra.values[i]) || !Number.isFinite(rb.values[i])) continue;
        // Only open ground in both: a new building's footprint is not a "change of sun".
        if ((ra.ids && ra.ids[i]) || (rb.ids && rb.ids[i])) continue;
        diff[i] = rb.values[i] - ra.values[i];
        n++;
        if (diff[i] > tol) gain++; else if (diff[i] < -tol) loss++;
      }
      const st = gridStats(diff);
      const m = Math.max(Math.abs(st.min), Math.abs(st.max), tol * 2);
      // Per building: the value in A, in B and the change, so the report can
      // say what the proposal does to each existing building.
      const perBuilding = [];
      for (const fa of ra.fields || []) {
        const fb = (rb.fields || []).find((x) => x.layer === fa.layer && x.name === fa.name);
        if (!fb) continue;
        const d = new Float32Array(fa.values.length).fill(NaN);
        for (let i = 0; i < d.length; i++) if (Number.isFinite(fa.values[i]) && Number.isFinite(fb.values[i])) d[i] = fb.values[i] - fa.values[i];
        perBuilding.push({ layer: fa.layer, name: `${fa.name}_A`, values: fa.values }, { layer: fa.layer, name: `${fa.name}_B`, values: fb.values },
          { layer: fa.layer, name: `d_${fa.name}`, values: d });
      }
      for (const fb of rb.fields || []) {
        if (!(ra.fields || []).some((x) => x.layer === fb.layer && x.name === fb.name)) perBuilding.push({ layer: fb.layer, name: `${fb.name}_B`, values: fb.values });
      }
      app.lastScenario = { kind: state.kind, title: ra.title };
      return [{
        kind: `diff_${state.kind}`, title: `B − A: ${ra.title}`, subtitle: 'Open ground in both scenarios; blue = more in B', unit: ra.unit,
        grid: ra.grid, values: diff, display: { min: -m, max: m, ramp: state.kind === 'wind' ? 'rdbu-r' : 'rdbu' }, fields: perBuilding,
        stats: [['Mean change', `${st.mean.toFixed(2)} ${ra.unit}`], ['Area gaining', `${n ? ((100 * gain) / n).toFixed(0) : 0} %`],
          ['Area losing', `${n ? ((100 * loss) / n).toFixed(0) : 0} %`]],
        notes: `Uses the parameters of the ${state.kind} card in Analyze. Changes smaller than ${tol} ${ra.unit} count as no change.`
      }, { ...ra, title: `A: ${ra.title}`, fields: [] }, { ...rb, title: `B: ${rb.title}`, fields: [] }];
    });
  };
  const body = h('div', {},
    stats([['Scenario A layers', a.map((l) => l.entry.name).join(', ') || '–'], ['Scenario B layers', b.map((l) => l.entry.name).join(', ') || '–']]),
    row('Show', select([['A', 'Existing + A'], ['B', 'Existing + B']], app.scenario || 'A', (v) => showScenario(app, v))),
    row('Compare', select([['sun', 'Sun hours'], ['svf', 'Sky view factor'], ['solar', 'Solar irradiation'], ['wind', 'Pedestrian wind']], state.kind, (v) => { state.kind = v; })),
    h('div', { class: 'btn-row' }, button('Run A vs B', runPair, { kind: 'primary run' })),
    info);
  app.scenario = 'A';
  return card('Scenarios', body, { open: true });
}

function optimiseCard(app) {
  const o = { floorHeight: 3.2, minFloors: 1, maxFloors: 12, minGfa: 0, month: 12, day: 21, startHour: 8, endHour: 16, margin: 60,
    populationSize: 16, generations: 12, seed: 1 };
  const chart = h('canvas', { class: 'chart' });
  const info = h('div', {});
  const progressEl = h('div', { class: 'muted small' });
  let last = null;
  let stop = false;
  let selected = null;
  const targetsNow = () => {
    const out = [];
    for (const layer of app.layers) {
      if (!(layer instanceof ExtrudedLayer) || layer.isWall) continue;
      for (const f of app.selectedIndices(layer)) out.push({ layer, f });
    }
    return out;
  };
  const targetInfo = h('div', { class: 'muted small' });
  const refreshTargets = () => {
    const t = targetsNow();
    const gfaNow = t.reduce((s, { layer, f }) => s + Math.max(1, Math.round(layer.heights[f] / o.floorHeight)) * layer.footprint[f], 0);
    targetInfo.textContent = t.length ? `${t.length} selected building(s), floor area now ≈ ${Math.round(gfaNow).toLocaleString('en-US')} m²` :
      'Select the buildings to optimise: click them (Shift+click adds) or select them in QGIS.';
  };
  app.on((w) => { if (w === 'selection') refreshTargets(); });
  refreshTargets();
  const apply = (ind) => {
    if (!last) return;
    selected = ind;
    const fields = new Map();
    last.targets.forEach(({ layer, f }, i) => {
      layer.heights[f] = ind.x[i] * o.floorHeight;
      if (!fields.has(layer)) fields.set(layer, { floors: new Float32Array(layer.count).fill(NaN), h: new Float32Array(layer.count).fill(NaN) });
      fields.get(layer).floors[f] = ind.x[i];
      fields.get(layer).h[f] = ind.x[i] * o.floorHeight;
    });
    for (const layer of fields.keys()) layer.applyHeightsFor(last.targets.filter((t) => t.layer === layer).map((t) => t.f));
    last.fields = [];
    for (const [layer, v] of fields) {
      layer.setResultField('opt_floors', v.floors);
      layer.setResultField('opt_height_m', v.h);
      last.fields.push({ layer, name: 'opt_floors', values: v.floors }, { layer, name: 'opt_height_m', values: v.h });
    }
    app.analyst.cache.clear();
    // Kept for the building report and its PDF.
    app.lastOptimisation = { targets: last.targets, now: last.baseline, design: ind, floorHeight: o.floorHeight,
      date: { month: o.month, day: o.day }, hours: [o.startHour, o.endHour] };
    draw();
    clear(info);
    info.appendChild(stats([['Sun on open ground', `${ind.extra.sun.toFixed(2)} h (now ${last.baseline.extra.sun.toFixed(2)} h)`],
      ['Ground with ≥ 2 h sun', `${(ind.extra.twoHourShare * 100).toFixed(0)} % (now ${(last.baseline.extra.twoHourShare * 100).toFixed(0)} %)`],
      ['Floor area', `${Math.round(ind.extra.gfa).toLocaleString('en-US')} m² (now ${Math.round(last.baseline.extra.gfa).toLocaleString('en-US')} m²)`],
      ['Floors', ind.x.join(', ')]]));
  };
  const draw = () => {
    if (!last) return;
    const pts = last.population.map((p, i) => ({ x: p.extra.gfa, y: p.extra.sun, front: p.rank === 0 && p.violation === 0, id: i }));
    pts.push({ x: last.baseline.extra.gfa, y: last.baseline.extra.sun, front: false, current: true, id: -1 });
    const pick = drawScatter(chart, pts, { xLabel: 'Floor area (m²) →', yLabel: 'Sun on open ground (h) →', selected: selected ? last.population.indexOf(selected) : null });
    chart.onclick = (e) => { const id = pick(e); if (id !== null && id >= 0) apply(last.population[id]); };
  };
  const run = async () => {
    const targets = targetsNow();
    if (!targets.length) { toast('Select buildings first.'); return; }
    if (targets.length > 80) { toast('Select at most 80 buildings.'); return; }
    stop = false;
    const res = await app.run('Height optimisation', async (prog) => {
      const r = await optimiseHeights(app, { ...o, targets, date: { month: o.month, day: o.day },
        onGeneration: (g) => { prog(g.generation / g.generations); progressEl.textContent = `Generation ${g.generation}/${g.generations}, ${g.evaluations} designs evaluated, ${g.front.length} on the front`; },
        shouldStop: () => stop });
      last = { ...r, targets };
      return [];
    });
    if (res === null || !last) return;
    draw();
    const best = last.front.filter((p) => p.violation === 0).sort((a2, b2) => b2.extra.sun - a2.extra.sun);
    clear(info);
    info.appendChild(h('p', { class: 'muted small', text: `${last.evaluations} designs, ${best.length} on the Pareto front (blue). The ringed point marked "now" is the current design. Click a point to apply it.` }));
  };
  const body = h('div', {},
    h('p', { class: 'muted small', text: 'Searches floor counts of the selected buildings for the best trade-offs between floor area and sun on the open ground around them (NSGA-II).' }),
    targetInfo,
    row('Floor height (m)', number(o.floorHeight, { min: 2.4, max: 6, step: 0.1, onChange: (v) => { o.floorHeight = v; refreshTargets(); } })),
    row('Floors min / max', h('span', { class: 'inline' }, number(o.minFloors, { min: 1, step: 1, width: '4em', onChange: (v) => { o.minFloors = v; } }),
      number(o.maxFloors, { min: 1, step: 1, width: '4em', onChange: (v) => { o.maxFloors = v; } }))),
    row('Required floor area (m²)', number(o.minGfa, { min: 0, step: 100, onChange: (v) => { o.minGfa = v; } }), '0 = no requirement; designs below it are infeasible'),
    row('Sun on', h('span', { class: 'inline' }, select(MONTH_NAMES.map((m, i) => [i + 1, m]), o.month, (v) => { o.month = Number(v); }),
      number(o.day, { min: 1, max: 31, step: 1, width: '4em', onChange: (v) => { o.day = v; } }))),
    row('Hours', h('span', { class: 'inline' }, number(o.startHour, { min: 0, max: 24, step: 1, width: '4em', onChange: (v) => { o.startHour = v; } }),
      number(o.endHour, { min: 0, max: 24, step: 1, width: '4em', onChange: (v) => { o.endHour = v; } }))),
    row('Ground scored within (m)', number(o.margin, { min: 10, step: 10, onChange: (v) => { o.margin = v; } })),
    row('Population / generations', h('span', { class: 'inline' }, number(o.populationSize, { min: 8, step: 4, width: '4em', onChange: (v) => { o.populationSize = v; } }),
      number(o.generations, { min: 2, step: 2, width: '4em', onChange: (v) => { o.generations = v; } }))),
    row('Random seed', number(o.seed, { min: 1, step: 1, onChange: (v) => { o.seed = v; } }), 'Same seed and settings give the same result'),
    h('div', { class: 'btn-row' }, button('Optimise', run, { kind: 'primary run' }), button('Stop', () => { stop = true; })),
    progressEl, chart, info,
    h('div', { class: 'btn-row' },
      button('Reset heights', () => {
        if (!last) return;
        last.targets.forEach(({ layer, f }) => { layer.heights[f] = layer.sourceHeights[f]; });
        for (const layer of new Set(last.targets.map((t) => t.layer))) layer.applyHeights();
        selected = null;
        draw();
      }),
      app.qgis ? button('To QGIS', async () => {
        if (!last?.fields?.length) { toast('Apply a design first (click a point).'); return; }
        const names = await sendFields(last.fields, 'viridis');
        toast(`opt_floors and opt_height_m sent to ${names.join(', ')}.`);
      }, { kind: 'primary' }) : null,
      button('CSV', () => {
        if (!last) return;
        const lines = ['design,on_front,sun_h,ground_2h_share,floor_area_m2,floors'];
        last.population.forEach((p, i) => lines.push(`${i},${p.rank === 0},${p.extra.sun.toFixed(3)},${p.extra.twoHourShare.toFixed(3)},${Math.round(p.extra.gfa)},"${p.x.join(' ')}"`));
        download('height_designs.csv', lines.join('\n'), 'text/csv');
      })));
  return card('Optimise building heights', body);
}
