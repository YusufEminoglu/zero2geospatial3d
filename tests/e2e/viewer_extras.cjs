// Extra checks: a selected building (viewshed, building report, planning
// check on the selection), every export, and results sent "To QGIS".
const { chromium } = require('playwright');
const URL = process.argv[2] || 'http://127.0.0.1:8660/index.html?scene=/scene/scene.json';

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text().slice(0, 300)); });
  await page.goto(URL);
  await page.waitForFunction(() => window.geo3d?.manifest && !/Starting|Loading/.test(document.getElementById('status-text').textContent) && window.geo3d.weather, null, { timeout: 180000 });
  const log = (k, v) => console.log(`## ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  const waitIdle = () => page.waitForFunction(() => !window.geo3d.busy && !/…/.test(document.getElementById('status-text').textContent), null, { timeout: 900000, polling: 500 });

  // Select the tallest building of the first building layer.
  const picked = await page.evaluate(() => {
    const app = window.geo3d;
    const layer = app.layers.find((l) => l.entry.role === 'buildings');
    let best = 0;
    for (let f = 1; f < layer.count; f++) if (layer.heights[f] > layer.heights[best]) best = f;
    app.select(layer, [best]);
    return { layer: layer.entry.name, f: best, h: layer.heights[best] };
  });
  log('selected', picked);

  await page.locator('#tabs >> text=Analyze').first().click();
  const card = async (t) => { const c = page.locator('details.card', { has: page.locator('summary', { hasText: t }) }).first(); await c.evaluate((el) => { el.open = true; }); return c; };
  const status = () => page.locator('#status-text').innerText();

  const before = await page.evaluate(() => window.geo3d.results.length);
  await (await card('Visibility')).locator('button', { hasText: 'From selected building' }).click();
  await page.waitForTimeout(1500); await waitIdle();
  log('viewshed from selected', await status());
  log('viewshed result', await page.evaluate((b) => { const r = window.geo3d.results[0]; const v = Array.from(r.values || []).filter(Number.isFinite); return window.geo3d.results.length > b ? { kind: r.kind, title: r.title, visible: v.filter((x) => x > 0).length, n: v.length } : 'none'; }, before));

  await page.evaluate(() => { window.geo3d.params.check.scope = 'selected'; });
  await (await card('Planning check')).locator('button', { hasText: 'Run planning check' }).click();
  await page.waitForTimeout(1500); await waitIdle();
  log('planning check (selected)', await status());
  log('planning result', await page.evaluate(() => { const r = window.geo3d.results[0]; return { kind: r.kind, title: r.title, rows: r.rows?.length ?? r.buildings?.length, stats: r.stats?.slice(0, 6) }; }));

  // Building report of the selected building + its PDF.
  const report = await page.evaluate(async () => {
    const app = window.geo3d;
    const m = await import('/src/ui/building_report.js');
    const layer = app.layers.find((l) => l.entry.role === 'buildings');
    const f = app.selectedIndices(layer)[0];
    const el = m.reportBlock(app, layer, f);
    const text = el.innerText || el.textContent;
    return { length: text.length, sample: text.slice(0, 400).replace(/\s+/g, ' '), nan: /NaN|undefined/.test(text) };
  });
  log('building report', report);

  // Exports.
  const ex = await page.evaluate(async () => {
    const app = window.geo3d;
    const e = await import('/src/export/exporters.js');
    const out = {};
    const t0 = performance.now();
    const c = await e.renderImage(app, { width: 3840, height: 2160, furniture: { title: true, legend: true, north: true, scale: true, credits: true } });
    const png = await e.canvasBlob(c);
    out.png4k = { w: c.width, h: c.height, bytes: png.size, ms: Math.round(performance.now() - t0) };
    const pdf = await e.exportPdf(app, { paper: 'a4', title: 'Test sheet' });
    const head = await pdf.slice(0, 8).text();
    out.pdf = { bytes: pdf.size, head };
    const glb = await e.exportGlb(app, {});
    const gh = new Uint8Array(await glb.slice(0, 4).arrayBuffer());
    out.glb = { bytes: glb.size, magic: String.fromCharCode(...gh) };
    const html = await e.exportHtml(app, {});
    const txt = await html.text();
    out.html = { bytes: html.size, doctype: txt.slice(0, 15), hasData: /<script/.test(txt) };
    window.__html = txt;
    return out;
  }).catch((err) => ({ error: String(err) }));
  log('exports', ex);

  // Open the offline HTML on its own, from a file, with no server.
  const fs = require('fs');
  const htmlPath = require('path').resolve('offline_export.html');
  fs.writeFileSync(htmlPath, await page.evaluate(() => window.__html || ''));
  const off = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const offErrors = [];
  off.on('pageerror', (e) => offErrors.push(e.message));
  off.on('console', (m) => { if (m.type() === 'error') offErrors.push(m.text().slice(0, 200)); });
  await off.goto('file://' + htmlPath);
  await off.waitForTimeout(8000);
  await off.screenshot({ path: 'offline_export.png' });
  log('offline HTML', { errors: offErrors, canvas: await off.evaluate(() => !!document.querySelector('canvas')), title: await off.title() });
  await off.close();

  // To QGIS: the demo server accepts and logs results.
  const toQgis = await page.evaluate(async () => {
    const app = window.geo3d;
    const q = await import('/src/ui/qgis_link.js');
    const online = await q.qgisOnline();
    const r = app.results.find((x) => x.grid && x.values);
    let sent = null, bytes = 0;
    const realFetch = window.fetch;
    window.fetch = (url, opts) => { if (opts?.body) bytes = Math.max(bytes, opts.body.length); return realFetch(url, opts); };
    try { sent = await q.sendGrid(r, 'sweep_test'); } catch (err) { sent = String(err); }
    const fr = app.results.find((x) => x.fields?.length);
    let fsent = null;
    try { fsent = await q.sendFields(fr.fields.slice(0, 2)); } catch (err) { fsent = String(err); }
    window.fetch = realFetch;
    return { online, grid: r.title, cells: r.grid.cols * r.grid.rows, bodyBytes: bytes, sent, fields: fr.title, fsent };
  });
  log('to QGIS', toQgis);
  log('errors', errors.length ? errors : 'none');
  await browser.close();
})();
