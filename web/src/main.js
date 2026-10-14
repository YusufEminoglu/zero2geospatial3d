// @ts-check
// Entry point: load the scene named in ?scene=..., then build the panels.
import { App } from './app.js';
import { buildLayersPanel } from './ui/panel_layers.js';
import { buildAnalyzePanel } from './ui/panel_analyze.js';
import { buildTerrainPanel } from './ui/panel_terrain.js';
import { buildComparePanel } from './ui/panel_compare.js';
import { buildSunClock } from './ui/sunclock.js';
import { toast } from './ui/dom.js';

const TABS = [
  ['layers', 'Layers', buildLayersPanel],
  ['analyze', 'Analyze', buildAnalyzePanel],
  ['terrain', 'Terrain', buildTerrainPanel],
  ['compare', 'Compare', buildComparePanel]
];

async function start() {
  const params = new URLSearchParams(location.search);
  const sceneUrl = params.get('scene') || '/scene/scene.json';
  const app = new App();
  /** @type {any} */ (window).geo3d = app; // handy in the browser console
  try {
    await app.load(sceneUrl);
  } catch (e) {
    console.error(e);
    app.status(`Could not open the scene: ${e.message}`);
    const el = document.getElementById('empty');
    if (el) { el.hidden = false; el.querySelector('.detail').textContent = e.message; }
    return;
  }
  document.title = `${app.manifest.title} · 02 Geo3D Analyzer`;
  const title = document.getElementById('scene-title');
  if (title) title.textContent = app.manifest.title;
  buildSunClock(app, document.getElementById('sun-clock'));
  const nav = document.getElementById('tabs');
  const panels = document.getElementById('panels');
  const built = new Map();
  const show = (key) => {
    for (const b of nav.querySelectorAll('button')) b.classList.toggle('active', b.dataset.tab === key);
    for (const p of panels.children) /** @type {HTMLElement} */ (p).hidden = /** @type {HTMLElement} */ (p).dataset.tab !== key;
    if (!built.has(key)) {
      const [, , builder] = TABS.find(([k]) => k === key);
      builder(app, panels.querySelector(`[data-tab="${key}"]`));
      built.set(key, true);
    }
  };
  for (const [key, label] of TABS) {
    const b = document.createElement('button');
    b.textContent = label;
    b.dataset.tab = key;
    b.onclick = () => show(key);
    nav.appendChild(b);
    const p = document.createElement('div');
    p.dataset.tab = key;
    p.className = 'panel';
    p.hidden = true;
    panels.appendChild(p);
  }
  show('layers');
  // Build the analysis panel up front: it owns the shared parameters.
  buildAnalyzePanel(app, panels.querySelector('[data-tab="analyze"]'));
  built.set('analyze', true);
  const fps = document.getElementById('fps');
  setInterval(() => {
    if (fps) fps.textContent = `${app.viewer.stats.fps.toFixed(0)} fps · ${app.viewer.stats.drawCalls} draws`;
  }, 1000);
  const warn = app.manifest.warnings || [];
  if (warn.length) toast(warn[0], 'warn');
  if (!app.qgis) toast('Opened without QGIS: results can be saved as files, not sent to QGIS.');
}

start();
