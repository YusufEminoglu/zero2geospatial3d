// End-to-end sweep: every analysis through the real viewer UI, in headless
// Chromium. Each result is checked for empty, flat or NaN values; errors,
// failed runs and the longest main-thread freeze are reported.
// Usage: see tests/e2e/README.md.
const { chromium } = require('playwright');
const URL = process.argv[2] || 'http://127.0.0.1:8660/index.html?scene=/scene/scene.json';
const ONLY = process.argv[3] ? new RegExp(process.argv[3]) : null;

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`console.${m.type()}: ${m.text().slice(0, 300)}`); });
  await page.goto(URL);
  await page.waitForFunction(() => window.geo3d?.manifest && !/Starting|Loading/.test(document.getElementById('status-text').textContent) && (!window.geo3d.manifest.weather || window.geo3d.weather), null, { timeout: 180000 });
  await page.waitForTimeout(1500);
  console.log('loaded:', await page.locator('#status-text').innerText(), '| weather:', await page.evaluate(() => !!window.geo3d.weather?.dryBulb));
  // Main-thread freeze monitor.
  await page.evaluate(() => {
    window.__gap = 0; let last = performance.now();
    const tick = (t) => { window.__gap = Math.max(window.__gap, t - last); last = t; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });

  const report = [];
  async function inspect(label, before) {
    return page.evaluate(([label, before]) => {
      const app = window.geo3d;
      const fresh = app.results.slice(0, Math.max(0, app.results.length - before));
      return fresh.map((r) => {
        const v = r.values ? Array.from(r.values) : [];
        const fin = v.filter(Number.isFinite);
        let min = Infinity, max = -Infinity; for (const x of fin) { if (x < min) min = x; if (x > max) max = x; } if (!fin.length) { min = NaN; max = NaN; }
        const mean = fin.length ? fin.reduce((a, b) => a + b, 0) / fin.length : NaN;
        const fields = (r.fields || []).map((f) => {
          const fv = Array.from(f.values).filter(Number.isFinite);
          return `${f.name}:${fv.length}/${f.values.length}`;
        });
        const d = r.display || {};
        const flags = [];
        if (r.values && !fin.length) flags.push('NO FINITE VALUES');
        if (fin.length > 10 && min === max) flags.push('FLAT');
        if (r.values && (!Number.isFinite(d.min) || !Number.isFinite(d.max)) && !d.categorical) flags.push('BAD DISPLAY RANGE');
        if (r.stats?.some(([, s]) => /NaN|undefined|Infinity/.test(String(s)))) flags.push('NaN IN STATS');
        if ((r.fields || []).some((f) => Array.from(f.values).every((x) => !Number.isFinite(x)))) flags.push('EMPTY FIELD');
        return { label, kind: r.kind, title: r.title, cells: `${fin.length}/${v.length}`, min: +min.toFixed?.(3), max: +max.toFixed?.(3), mean: +mean.toFixed?.(3),
          display: `${d.min}..${d.max}`, fields: fields.join(' '), flags, stats: (r.stats || []).slice(0, 4).map((s) => s.join('=')).join('; ') };
      });
    }, [label, before]);
  }

  async function act(label, clickFn, { timeout = 900000 } = {}) {
    if (ONLY && !ONLY.test(label)) return;
    const before = await page.evaluate(() => window.geo3d.results.length);
    await page.evaluate(() => { window.__gap = 0; });
    const errBefore = errors.length;
    const statusBefore = await page.locator('#status-text').innerText();
    const t0 = Date.now();
    await page.evaluate(() => { window.__t0 = Date.now(); });
    await clickFn();
    // Done when a run has ended with a new status line, or nothing started within 8 s.
    await page.waitForFunction((before) => {
      const st = document.getElementById('status-text').textContent;
      if (window.geo3d.busy) return false;
      if (st !== before && !/…/.test(st)) return true;
      return Date.now() - window.__t0 > 8000 && !/…/.test(st);
    }, statusBefore, { timeout, polling: 500 }).catch(() => console.log(`  TIMEOUT ${label}`));
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const status = await page.locator('#status-text').innerText();
    const gap = await page.evaluate(() => Math.round(window.__gap));
    const res = await inspect(label, before);
    const errs = errors.slice(errBefore);
    console.log(`\n## ${label}  [${secs} s, longest freeze ${gap} ms] status: ${status}`);
    for (const r of res) console.log(`   ${r.kind} "${r.title}" cells ${r.cells} range ${r.min}..${r.max} mean ${r.mean} display ${r.display} ${r.flags.length ? '<<' + r.flags.join(',') + '>>' : ''}\n      fields: ${r.fields}\n      stats: ${r.stats}`);
    if (!res.length) console.log('   (no new result)');
    for (const e of errs) console.log('   ' + e);
    report.push({ label, secs, gap, status, res, errs });
  }

  const tab = async (name) => { await page.locator('#tabs >> text=' + name).first().click(); await page.waitForTimeout(400); };
  const openCard = async (title) => {
    const c = page.locator('details.card', { has: page.locator('summary', { hasText: title }) }).first();
    await c.evaluate((el) => { el.open = true; });
    return c;
  };
  const clickIn = (title, btn) => async () => { const c = await openCard(title); await c.locator('button', { hasText: btn }).first().click({ noWaitAfter: true, timeout: 300000 }); };

  // ------------------------------------------------------------ Analyze
  await tab('Analyze');
  const analyze = [
    ['Sun hours', 'Run sun hours'], ['Sun hours', 'Summer ⇆ winter'], ['Sky view factor', 'Run sky view factor'],
    ['Daylight on facades', 'Run daylight (VSC)'], ['Solar radiation', 'Run solar & PV'], ['Visibility', 'From selected building'],
    ['Wind', 'Run wind'], ['Thermal comfort', 'Run UTCI & PET'], ['Thermal comfort', '24 h diurnal study'],
    ['Heat island', 'Run morphology'], ['Canyon ventilation', 'Run ventilation & dispersion'], ['Acoustic', 'Run noise map'],
    ['Green view', 'Run Green View Index (GVI)'], ['Green view', 'Run solar envelope'], ['Climate around buildings', 'Run climate year'],
    ['Planning check', 'Run planning check']
  ];
  await page.evaluate(() => { window.geo3d.params.check.scope = 'all'; });
  for (const [card, btn] of analyze) await act(`Analyze/${card}/${btn}`, clickIn(card, btn));

  // ------------------------------------------------------------ Terrain
  await tab('Terrain');
  await page.evaluate(async () => {
    const { TERRAIN_ANALYSES } = await import('/src/analysis/terrain_results.js').catch(() => ({}));
    if (TERRAIN_ANALYSES) window.geo3d.params.terrain.kinds = TERRAIN_ANALYSES.map((a) => a.id);
  });
  await act('Terrain/all terrain analyses', clickIn('Terrain analyses', 'Run'));
  await act('Terrain/flood apply', clickIn('Water level', 'Apply'));
  await act('Terrain/section from QGIS', async () => {
    const c = await openCard('Section & profile');
    const s = c.locator('select', { has: page.locator('option', { hasText: 'Section line from QGIS' }) });
    const val = await s.locator('option').nth(1).getAttribute('value');
    await s.selectOption(val);
  });
  await act('Terrain/cut & fill platform', async () => {
    const c = await openCard('Cut & fill');
    const s = c.locator('select', { has: page.locator('option', { hasText: 'Platform from QGIS' }) });
    const val = await s.locator('option').nth(1).getAttribute('value');
    await s.selectOption(val);
    await page.waitForTimeout(800);
    await c.locator('button', { hasText: 'Balance' }).click();
  });
  for (const t of ['Section & profile', 'Water level', 'Cut & fill']) {
    const txt = await (await openCard(t)).innerText();
    console.log(`\n## Terrain readout: ${t}\n` + txt.split('\n').filter((l) => /\d/.test(l)).slice(0, 12).join(' | '));
  }

  // ------------------------------------------------------------ Compare
  await tab('Compare');
  for (const kind of ['sun', 'svf', 'vsc', 'solar', 'wind', 'comfort', 'vent', 'noise', 'gvi']) {
    await act(`Compare/A vs B ${kind}`, async () => {
      const c = await openCard('Scenarios');
      await c.locator('select', { has: page.locator('option[value="gvi"]') }).selectOption(kind);
      await c.locator('button', { hasText: 'Run A vs B' }).click();
    });
  }
  await act('Compare/optimise (stopped after 40 s)', async () => {
    const c = await openCard('Optimise building heights');
    await c.locator('button', { hasText: 'Optimise' }).click();
    setTimeout(() => c.locator('button', { hasText: 'Stop' }).click().catch(() => {}), 40000);
  });
  await act('Compare/check this design', clickIn('Optimise building heights', 'Check this design'));

  await page.screenshot({ path: 'sweep_end.png' });
  const bad = report.filter((r) => r.errs.length || r.res.some((x) => x.flags.length) || /failed|error/i.test(r.status) || r.gap > 3000);
  console.log('\n================ SUMMARY ================');
  for (const r of report) console.log(`${r.label.padEnd(58)} ${String(r.secs).padStart(6)} s  freeze ${String(r.gap).padStart(6)} ms  ${r.res.map((x) => x.flags.join(',')).filter(Boolean).join(' ')} ${r.errs.length ? 'ERRORS ' + r.errs.length : ''} ${/failed/i.test(r.status) ? 'FAILED' : ''}`);
  console.log(`\n${bad.length} actions need attention`);
  // Errors and failed runs fail the sweep; freezes and flags are reported only
  // (freeze times depend on the machine, and some flags are expected, e.g. no
  // scenario B daylight before a Compare run).
  const hard = report.filter((r) => r.errs.length || /failed/i.test(r.status));
  if (hard.length) console.log(`${hard.length} actions failed or logged errors`);
  process.exitCode = hard.length ? 1 : 0;
  await browser.close();
})();
