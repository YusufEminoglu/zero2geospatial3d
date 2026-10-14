// @ts-check
// Minimal icon bar on the view: image, video, PDF, 3D model / HTML, compare.
import { h, clear, select, toggle, download, toast } from './dom.js';
import { renderImage, canvasBlob, exportPdf, exportGlb, exportHtml, Recorder, videoType, fileStem } from '../export/exporters.js';
import { Compare } from './compare.js';

const ICONS = {
  image: '<path d="M4 7h3l2-2.5h6L17 7h3v12H4z"/><circle cx="12" cy="13" r="3.6"/>',
  video: '<rect x="3.5" y="6.5" width="12" height="11" rx="2"/><path d="M15.5 10.5l5-3v9l-5-3z"/>',
  pdf: '<path d="M6 3.5h8.5L19 8v12.5H6z"/><path d="M14.5 3.5V8H19"/><path d="M9 13h7M9 16.5h5"/>',
  model: '<path d="M12 3.5l8 4.5v8l-8 4.5-8-4.5v-8z"/><path d="M12 12.5l8-4.5M12 12.5L4 8M12 12.5v8"/>',
  swipe: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M12 3v18"/><path d="M8.5 12h-3l1.5-1.5M5.5 12l1.5 1.5M15.5 12h3l-1.5-1.5M18.5 12l-1.5 1.5"/>',
  grid2: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M12 5v14"/>',
  grid4: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M12 5v14M3.5 12h17"/>',
  grid6: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M9.2 5v14M14.8 5v14M3.5 12h17"/>',
  grid8: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M7.75 5v14M12 5v14M16.25 5v14M3.5 12h17"/>'
};

function icon(name) {
  const span = h('span', { class: 'vt-icon' });
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return span;
}

const SIZES = [['view', 'This view'], ['1920x1080', 'Full HD 1920×1080'], ['2560x1440', 'QHD 2560×1440'], ['3840x2160', '4K 3840×2160'],
  ['7680x4320', '8K 7680×4320'], ['3508x2480', 'A4 300 dpi (landscape)']];

function parseSize(v) {
  if (v === 'view') return [0, 0];
  const [w, hh] = v.split('x').map(Number);
  return [w, hh];
}

export function buildViewTools(app) {
  const bar = h('div', { class: 'viewtools' });
  const pop = h('div', { class: 'vt-pop', hidden: true });
  const view = /** @type {HTMLElement} */ (document.getElementById('view'));
  view.append(bar, pop);
  const compare = new Compare(app);
  app.compare = compare;
  const recorder = new Recorder(app);
  const state = { size: 'view', format: 'png', title: true, legend: true, north: true, scale: true, credits: true,
    vmode: 'orbit', seconds: 12, vsize: '1920x1080', fps: 30, paper: 'a4', area: 'scene' };
  let open = null;
  const buttons = {};

  const show = (key, build) => {
    if (open === key) { close(); return; }
    open = key;
    clear(pop);
    build(pop);
    pop.hidden = false;
    const b = buttons[key].getBoundingClientRect();
    const v = view.getBoundingClientRect();
    pop.style.top = `${b.top - v.top}px`;
    for (const [k, btn] of Object.entries(buttons)) btn.classList.toggle('on', k === key);
  };
  const close = () => {
    open = null;
    pop.hidden = true;
    for (const btn of Object.values(buttons)) btn.classList.remove('on');
    syncCompare();
  };
  const busy = async (label, fn) => {
    toast(`${label} …`);
    try { await fn(); } catch (e) { console.error(e); toast(`${label} failed: ${e.message}`, 'error'); }
  };
  const row = (label, control) => h('label', { class: 'vt-row' }, h('span', { text: label }), control);
  const furniture = () => h('div', { class: 'vt-checks' },
    toggle(state.title, (v) => { state.title = v; }, 'Title'), toggle(state.legend, (v) => { state.legend = v; }, 'Legend'),
    toggle(state.north, (v) => { state.north = v; }, 'North'), toggle(state.scale, (v) => { state.scale = v; }, 'Scale'),
    toggle(state.credits, (v) => { state.credits = v; }, 'Credits'));
  const add = (key, iconName, title, build) => {
    const b = h('button', { class: 'vt-btn', title, onclick: () => show(key, build) }, icon(iconName));
    buttons[key] = b;
    bar.appendChild(b);
  };

  add('image', 'image', 'Save an image', (p) => {
    p.append(h('div', { class: 'vt-title', text: 'Image' }),
      row('Size', select(SIZES, state.size, (v) => { state.size = v; })),
      row('Format', select([['png', 'PNG'], ['jpeg', 'JPEG']], state.format, (v) => { state.format = v; })),
      furniture(),
      h('div', { class: 'vt-actions' },
        h('button', { class: 'btn primary', text: 'Save', onclick: () => busy('Image', async () => {
          const [w, hh] = parseSize(state.size);
          const canvas = renderImage(app, { width: w, height: hh, furniture: state });
          const type = state.format === 'jpeg' ? 'image/jpeg' : 'image/png';
          download(`${fileStem(app)}.${state.format === 'jpeg' ? 'jpg' : 'png'}`, await canvasBlob(canvas, type));
          toast(`Saved ${canvas.width}×${canvas.height} image.`);
        }) }),
        h('button', { class: 'btn', text: 'Copy', title: 'Copy a PNG of this view to the clipboard', onclick: () => busy('Copy', async () => {
          const canvas = renderImage(app, { furniture: state });
          const blob = await canvasBlob(canvas, 'image/png');
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          toast('Image copied.');
        }) })));
  });

  add('video', 'video', 'Record a video', (p) => {
    const type = videoType();
    const status = h('div', { class: 'vt-note', text: type ? `Format: ${type.includes('mp4') ? 'MP4' : 'WebM'}` : 'This browser cannot record video.' });
    const startBtn = h('button', { class: 'btn primary', text: recorder.active ? 'Stop' : 'Record', disabled: !type });
    startBtn.onclick = () => {
      if (recorder.active) { recorder.stop(); return; }
      const [w, hh] = parseSize(state.vsize);
      startBtn.textContent = 'Stop';
      bar.classList.add('recording');
      recorder.start({ mode: state.vmode, seconds: state.seconds, fps: state.fps, width: w, height: hh,
        onTick: (f) => { status.textContent = state.vmode === 'free' ? `Recording ${f.toFixed(0)} s …` : `Recording ${Math.round(f * 100)} % …`; } })
        .then((blob) => {
          bar.classList.remove('recording');
          startBtn.textContent = 'Record';
          status.textContent = `Saved ${(blob.size / 1e6).toFixed(1)} MB.`;
          download(`${fileStem(app)}_${state.vmode}.${blob.type.includes('mp4') ? 'mp4' : 'webm'}`, blob);
        })
        .catch((e) => { bar.classList.remove('recording'); startBtn.textContent = 'Record'; toast(e.message, 'error'); });
    };
    p.append(h('div', { class: 'vt-title', text: 'Video' }),
      row('Motion', select([['orbit', '360° orbit'], ['day', 'Sun through the day'], ['free', 'Free (until Stop)']], state.vmode, (v) => { state.vmode = v; })),
      row('Length', select([[8, '8 s'], [12, '12 s'], [20, '20 s'], [30, '30 s']], state.seconds, (v) => { state.seconds = Number(v); })),
      row('Size', select([['view', 'This view'], ['1280x720', '720p'], ['1920x1080', '1080p'], ['3840x2160', '4K']], state.vsize, (v) => { state.vsize = v; })),
      row('Frame rate', select([[30, '30 fps'], [60, '60 fps']], state.fps, (v) => { state.fps = Number(v); })),
      h('div', { class: 'vt-actions' }, startBtn), status);
  });

  add('pdf', 'pdf', 'Save a PDF sheet', (p) => {
    const title = h('input', { type: 'text', value: app.manifest.title || '' });
    p.append(h('div', { class: 'vt-title', text: 'PDF sheet' }),
      row('Title', title),
      row('Paper', select([['a4', 'A4 landscape'], ['a3', 'A3 landscape']], state.paper, (v) => { state.paper = v; })),
      h('div', { class: 'vt-note', text: 'The view, legend, statistics and notes of the shown result, sun time and CRS.' }),
      h('div', { class: 'vt-actions' }, h('button', { class: 'btn primary', text: 'Save PDF', onclick: () => busy('PDF', async () => {
        download(`${fileStem(app)}.pdf`, await exportPdf(app, { paper: state.paper, title: title.value }));
        toast('PDF saved.');
      }) })));
  });

  add('model', 'model', '3D model or interactive page', (p) => {
    const areaOf = () => (state.area === 'analysis' ? app.area() : null);
    p.append(h('div', { class: 'vt-title', text: '3D export' }),
      row('Area', select([['scene', 'Whole scene'], ['analysis', 'Analysis area']], state.area, (v) => { state.area = v; })),
      h('div', { class: 'vt-note', text: 'Colours and the shown analysis are baked in. HTML opens anywhere, offline; GLB goes to Blender, SketchUp or the web.' }),
      h('div', { class: 'vt-actions' },
        h('button', { class: 'btn primary', text: 'Interactive HTML', onclick: () => busy('HTML', async () => {
          const blob = await exportHtml(app, { area: areaOf() });
          download(`${fileStem(app)}_3d.html`, blob);
          toast(`HTML saved (${(blob.size / 1e6).toFixed(1)} MB).`);
        }) }),
        h('button', { class: 'btn', text: 'GLB model', onclick: () => busy('GLB', async () => {
          const blob = await exportGlb(app, { area: areaOf() });
          download(`${fileStem(app)}.glb`, blob);
          toast(`GLB saved (${(blob.size / 1e6).toFixed(1)} MB).`);
        }) })));
  });

  bar.appendChild(h('div', { class: 'vt-sep' }));
  const cmp = {};
  for (const [mode, ic, title] of [['swipe', 'swipe', 'Swipe between two views'], [2, 'grid2', '2 synced panels'], [4, 'grid4', '4 synced panels'],
    [6, 'grid6', '6 synced panels'], [8, 'grid8', '8 synced panels']]) {
    const b = h('button', { class: 'vt-btn', title, onclick: () => { close(); compare.toggle(mode); syncCompare(); } }, icon(ic));
    cmp[mode] = b;
    bar.appendChild(b);
  }
  function syncCompare() {
    for (const [k, b] of Object.entries(cmp)) b.classList.toggle('on', String(compare.mode) === k);
  }
  window.addEventListener('resize', () => compare.onResize());
  if ('ResizeObserver' in window) new ResizeObserver(() => compare.onResize()).observe(view);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) close(); });
  return { compare };
}
