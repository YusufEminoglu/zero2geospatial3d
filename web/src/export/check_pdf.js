// @ts-check
// One-page planning-check sheet: criteria with thresholds and sources, the
// summary, and a pass / fail table of the buildings (worst first).
import { PdfPage, wrap } from './pdf.js';
import { fmt } from '../core/classify.js';

const GREEN = [0.12, 0.55, 0.3], RED = [0.78, 0.2, 0.2], MUTED = [0.42, 0.45, 0.5], INK = [0.11, 0.14, 0.19];

export function planningSheet(app, result, { title = 'Planning check' } = {}) {
  const [PW, PH] = [842, 595];
  const m = 28;
  const page = new PdfPage(PW, PH);
  page.text(m, m + 18, title, { size: 18, bold: true, color: INK });
  page.text(m, m + 36, `${app.manifest.title} · ${result.rows.length} buildings${result.profile ? ` · Profile: ${result.profile}` : ''} · ${new Date().toISOString().slice(0, 10)}`, { size: 10, color: MUTED });
  // Criteria column.
  const side = 250;
  let y = m + 62;
  page.text(m, y, 'Criteria', { size: 10, bold: true, color: INK });
  y += 6;
  for (const c of result.criteria) {
    y += 13;
    const lim = `${c.test === 'min' ? '≥' : '≤'} ${fmt(c.threshold, c.unit)}`;
    page.text(m, y, `${c.label}  ${lim}`, { size: 8.5, bold: true, color: INK });
    for (const line of wrap(c.help, 7.5, side)) { y += 10; page.text(m, y, line, { size: 7.5, color: MUTED }); }
  }
  y += 22;
  page.text(m, y, 'Summary', { size: 10, bold: true, color: INK });
  for (const [k, v] of result.stats) {
    y += 12;
    page.text(m, y, k, { size: 8.5, color: MUTED });
    page.text(m + side - Math.min(side * 0.45, 6 + String(v).length * 4.6), y, v, { size: 8.5, color: INK });
  }
  y += 18;
  for (const line of wrap(result.notes, 7.5, side)) { page.text(m, y, line, { size: 7.5, color: MUTED }); y += 10; }
  // Table of buildings.
  const x0 = m * 2 + side;
  const tableW = PW - x0 - m;
  const nameW = 90, hW = 40;
  const colW = (tableW - nameW - hW) / Math.max(1, result.criteria.length);
  let ty = m + 62;
  page.rect(x0, ty - 10, tableW, 16, { fill: [0.95, 0.96, 0.97] });
  page.text(x0 + 4, ty + 2, 'Building', { size: 8, bold: true, color: INK });
  page.text(x0 + nameW, ty + 2, 'Height', { size: 8, bold: true, color: INK });
  result.criteria.forEach((c, i) => page.text(x0 + nameW + hW + colW * i, ty + 2, c.short, { size: 8, bold: true, color: INK }));
  const maxRows = Math.floor((PH - m - 40 - ty) / 14);
  for (const r of result.rows.slice(0, maxRows)) {
    ty += 14;
    page.line(x0, ty + 4, x0 + tableW, ty + 4, { color: [0.9, 0.91, 0.93], width: 0.4 });
    page.text(x0 + 4, ty + 1, r.name.slice(0, 18), { size: 8, color: INK });
    page.text(x0 + nameW, ty + 1, `${r.height.toFixed(0)} m`, { size: 8, color: MUTED });
    r.checks.forEach((ch, i) => {
      const cx = x0 + nameW + hW + colW * i;
      if (ch.pass === null) { page.text(cx, ty + 1, 'n/a', { size: 8, color: MUTED }); return; }
      page.text(cx, ty + 1, ch.pass ? 'PASS' : 'FAIL', { size: 8, bold: true, color: ch.pass ? GREEN : RED });
      page.text(cx + 26, ty + 1, fmt(ch.value, result.criteria[i].unit), { size: 7.5, color: MUTED });
    });
  }
  if (result.rows.length > maxRows) {
    page.text(x0 + 4, ty + 18, `${result.rows.length - maxRows} more buildings in the CSV (sorted by the number of failed checks).`, { size: 8, color: MUTED });
  }
  page.line(m, PH - m - 8, PW - m, PH - m - 8, { color: [0.85, 0.86, 0.88] });
  page.text(m, PH - m + 4, `${app.manifest.crs.authid} · 02 Geo3D Analyzer · screening proxies, not formal assessments`, { size: 7.5, color: MUTED });
  return new Blob([page.build({ title })], { type: 'application/pdf' });
}

export function planningCsv(result) {
  const head = ['layer', 'feature_id', 'name', 'height_m', 'failed', ...result.criteria.flatMap((c) => [`${c.id}_value`, `${c.id}_pass`])];
  const lines = result.profile ? [`# profile: ${String(result.profile).replace(/[\r\n]+/g, ' ')}`, head.join(',')] : [head.join(',')];
  for (const r of result.rows) {
    lines.push([`"${r.layer.entry.name}"`, r.f + 1, `"${r.name}"`, r.height.toFixed(2), r.failed,
      ...r.checks.flatMap((c) => [Number.isFinite(c.value) ? c.value.toFixed(3) : '', c.pass === null ? '' : c.pass ? 1 : 0])].join(','));
  }
  return lines.join('\n');
}
