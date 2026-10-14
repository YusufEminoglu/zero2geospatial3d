import test from 'node:test';
import assert from 'node:assert/strict';
import { PdfPage, pdfString, pdfInfoString, wrap, textWidth } from '../../web/src/export/pdf.js';

// A 1x1 white baseline JPEG.
const JPEG = Uint8Array.from(Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////' +
  'wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64'));

test('xref offsets point at their objects and the trailer is consistent', () => {
  const page = new PdfPage(842, 595);
  page.text(40, 40, 'Sun hours — Kadifekale (İzmir), ≥ 2 h: 64 %', { size: 16, bold: true });
  page.rect(40, 60, 100, 20, { fill: [0.2, 0.4, 0.8], stroke: [0, 0, 0] });
  page.line(40, 90, 200, 90);
  page.jpeg(JPEG, 1, 1, 40, 100, 300, 200);
  const bytes = page.build({ title: 'Test (1)' });
  const s = Buffer.from(bytes).toString('latin1');
  assert.ok(s.startsWith('%PDF-1.4'));
  const startxref = Number(s.match(/startxref\n(\d+)\n%%EOF/)[1]);
  assert.equal(s.slice(startxref, startxref + 4), 'xref');
  const rows = s.slice(startxref).split('\n').slice(2).filter((l) => /^\d{10} \d{5} n $/.test(l));
  rows.forEach((row, i) => {
    const off = Number(row.slice(0, 10));
    assert.equal(s.slice(off, off + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`, `object ${i + 1}`);
  });
  assert.match(s, /\/Size 9 /);
  // Stream lengths are byte-exact.
  const content = s.match(/4 0 obj\n<< \/Length (\d+) >>\nstream\n/);
  const start = content.index + content[0].length;
  assert.equal(s.slice(start + Number(content[1]), start + Number(content[1]) + 10), '\nendstream');
  assert.ok(s.includes('/Filter /DCTDecode'));
});

test('text is WinAnsi: Turkish letters outside it fall back, parentheses escaped', () => {
  assert.equal(pdfString('İzmir şehir ğ ı'), 'Izmir sehir g i');
  assert.equal(pdfString('çöü ÇÖÜ'), 'çöü ÇÖÜ');
  assert.equal(pdfString('a (b) \\ c'), 'a \\(b\\) \\\\ c');
  assert.equal(pdfString('–'), String.fromCharCode(0x96));
  assert.equal(pdfString('m²'), 'm²');
});

test('document info is UTF-16BE so any title survives', () => {
  assert.equal(pdfInfoString('Aş—'), '<FEFF0041015F2014>');
});

test('wrapping respects the width', () => {
  const lines = wrap('The quick brown fox jumps over the lazy dog again and again', 10, 120);
  assert.ok(lines.length > 1);
  for (const l of lines) assert.ok(textWidth(l, 10) <= 120 || !l.includes(' '));
});
