// Extra checks 2: shadow animation, multi-panel compare and swipe, video,
// section downloads, building PDF, colour by attribute, height rules.
const { chromium } = require('playwright');
const fs = require('fs');
const URL = process.argv[2] || 'http://127.0.0.1:8660/index.html?scene=/scene/scene.json';

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text().slice(0, 300)); });
  await page.goto(URL);
  await page.waitForFunction(() => window.geo3d?.manifest && !/Starting|Loading/.test(document.getElementById('status-text').textContent) && window.geo3d.weather, null, { timeout: 180000 });
  const log = (k, v) => console.log(`## ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  const idle = () => page.waitForFunction(() => !window.geo3d.busy && !/…/.test(document.getElementById('status-text').textContent), null, { timeout: 900000, polling: 500 });
  const tab = async (n) => { await page.locator('#tabs >> text=' + n).first().click(); await page.waitForTimeout(300); };
  const card = async (t) => { const c = page.locator('details.card', { has: page.locator('summary', { hasText: t }) }).first(); await c.evaluate((el) => { el.open = true; }); return c; };
  const download = async (fn) => { const [d] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), fn()]); const p = await d.path(); return { name: d.suggestedFilename(), bytes: fs.statSync(p).size, head: fs.readFileSync(p).subarray(0, 12).toString('latin1') }; };

  // 1. Shadow animation (shadow study played with the sun clock).
  await tab('Analyze');
  await (await card('Sun hours')).locator('button', { hasText: 'Animate shadows' }).click();
  await page.waitForTimeout(1500); await idle();
  const study = await page.evaluate(async () => {
    const app = window.geo3d; const r = app.results[0];
    const before = r.frame;
    app.time = 15; app.updateSun();
    await new Promise((res) => setTimeout(res, 300));
    return { kind: r.kind, frames: r.frames?.length, frameBefore: before, frameAt15: r.frame, status: document.getElementById('status-text').textContent };
  });
  log('shadow study', study);

  // 2. Terrain maps opened side by side; then swipe.
  await tab('Terrain');
  await page.evaluate(() => { window.geo3d.params.terrain.kinds = ['elevation', 'slope', 'aspect', 'hillshade']; });
  await (await card('Terrain analyses')).locator('button', { hasText: 'Run and compare' }).click();
  await page.waitForTimeout(1500); await idle(); await page.waitForTimeout(800);
  log('multi-panel', await page.evaluate(() => ({ mode: window.geo3d.compare.mode, panels: window.geo3d.compare.states.length })));
  await page.screenshot({ path: 'compare4.png' });
  await page.evaluate(() => { window.geo3d.compare.disable(); window.geo3d.compare.toggle('swipe'); });
  await page.waitForTimeout(800);
  log('swipe', await page.evaluate(() => ({ mode: window.geo3d.compare.mode })));
  await page.screenshot({ path: 'swipe.png' });

  // 3. Video: 2 s orbit, with the compare overlay on.
  const video = await page.evaluate(async () => {
    const e = await import('/src/export/exporters.js');
    const rec = new e.Recorder(window.geo3d);
    try {
      const blob = await rec.start({ mode: 'orbit', seconds: 2, fps: 10 });
      return { type: blob.type, bytes: blob.size };
    } catch (err) { return { error: String(err) }; }
  });
  log('video', video);
  await page.evaluate(() => window.geo3d.compare.disable());

  // 4. Section from the QGIS line: PNG, CSV, DXF downloads.
  const sec = await card('Section & profile');
  const s = sec.locator('select', { has: page.locator('option', { hasText: 'Section line from QGIS' }) });
  await s.selectOption(await s.locator('option').nth(1).getAttribute('value'));
  await page.waitForTimeout(800);
  for (const b of ['PNG', 'CSV', 'DXF']) log(`section ${b}`, await download(() => sec.locator('button', { hasText: b }).first().click()));

  // 5. Building report PDF of the tallest building.
  const pdf = await page.evaluate(async () => {
    const app = window.geo3d; const m = await import('/src/ui/building_report.js');
    const l = app.layers.find((x) => x.entry.role === 'buildings'); let b = 0; for (let f = 1; f < l.count; f++) if (l.heights[f] > l.heights[b]) b = f;
    const { blob, name } = await m.buildingPdf(app, l, b);
    return { name, bytes: blob.size, head: await blob.slice(0, 8).text() };
  });
  log('building PDF', pdf);

  // 6. Layers tab: colour by an attribute (graduated and categories) and a height field.
  await tab('Layers');
  const layerCheck = await page.evaluate(async () => {
    const app = window.geo3d; const l = app.layers.find((x) => x.entry.role === 'buildings');
    const fields = l.fieldNames().map((f) => f.name);
    return { fields: fields.slice(0, 12), count: l.count };
  });
  log('layer fields', layerCheck);
  const panelText = await page.locator('#panels').innerText();
  log('layers panel has colour controls', /Colour by/.test(panelText));
  log('errors', errors.length ? errors : 'none');
  await browser.close();
})();
