// @ts-check
// A minimal PDF 1.4 writer: one page, a JPEG image, Helvetica text, filled
// rectangles and lines. No dependencies; enough for a one-page analysis sheet.

const WINANSI_EXTRA = {
  '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '•': 0x95, '–': 0x96, '—': 0x97, '‘': 0x91, '’': 0x92,
  '“': 0x93, '”': 0x94, '™': 0x99, 'Œ': 0x8c, 'œ': 0x9c, 'Š': 0x8a, 'š': 0x9a, 'Ž': 0x8e, 'ž': 0x9e, 'Ÿ': 0x9f
};
// Characters Helvetica/WinAnsi cannot show, replaced by the closest ASCII.
const FALLBACK = { 'ı': 'i', 'İ': 'I', 'ş': 's', 'Ş': 'S', 'ğ': 'g', 'Ğ': 'G', 'λ': 'lambda ', '≥': '>=', '≤': '<=',
  '→': '->', '←': '<-', 'α': 'a', 'β': 'b', 'Δ': 'd', '−': '-', '·': '·' };

/** Document-info strings use PDFDocEncoding, not WinAnsi: write them as UTF-16BE hex. */
export function pdfInfoString(text) {
  let hex = 'FEFF';
  for (const ch of String(text ?? '')) {
    const cp = ch.codePointAt(0);
    if (cp > 0xffff) {
      const v = cp - 0x10000;
      hex += (0xd800 + (v >> 10)).toString(16).padStart(4, '0') + (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0');
    } else hex += cp.toString(16).padStart(4, '0');
  }
  return `<${hex.toUpperCase()}>`;
}

/** Encode text for a PDF string in WinAnsiEncoding, escaping ( ) \ . */
export function pdfString(text) {
  let out = '';
  for (const ch of String(text ?? '')) {
    const sub = FALLBACK[ch];
    const s = sub !== undefined ? sub : ch;
    for (const c of s) {
      let code = c.codePointAt(0);
      if (WINANSI_EXTRA[c] !== undefined) code = WINANSI_EXTRA[c];
      else if (code > 255 || (code >= 0x80 && code < 0xa0)) code = 0x3f; // '?'
      if (code === 0x28 || code === 0x29 || code === 0x5c) out += '\\';
      out += String.fromCharCode(code);
    }
  }
  return out;
}

// Helvetica advance widths (1/1000 em) for ASCII 32..126; others ~ 556.
const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722,
  667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556,
  333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];

export function textWidth(text, size, bold = false) {
  let w = 0;
  for (const ch of pdfString(text)) {
    const c = ch.charCodeAt(0);
    w += c >= 32 && c <= 126 ? HELV[c - 32] : 556;
  }
  return (w / 1000) * size * (bold ? 1.06 : 1);
}

/** Split text into lines no wider than maxWidth points. */
export function wrap(text, size, maxWidth) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (textWidth(t, size) > maxWidth && line) { lines.push(line); line = w; } else line = t;
  }
  if (line) lines.push(line);
  return lines;
}

export class PdfPage {
  /** @param {number} width points  @param {number} height points */
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.ops = [];
    this.image = null;
  }

  /** Top-left based coordinates are converted to PDF's bottom-left origin. */
  _y(y) { return this.height - y; }

  text(x, y, text, { size = 10, bold = false, color = [0, 0, 0] } = {}) {
    this.ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${rgb(color)} rg ${n(x)} ${n(this._y(y))} Td (${pdfString(text)}) Tj ET`);
  }

  rect(x, y, w, h, { fill = null, stroke = null, lineWidth = 0.5 } = {}) {
    const parts = [];
    if (fill) parts.push(`${rgb(fill)} rg`);
    if (stroke) parts.push(`${rgb(stroke)} RG ${n(lineWidth)} w`);
    parts.push(`${n(x)} ${n(this._y(y + h))} ${n(w)} ${n(h)} re ${fill && stroke ? 'B' : fill ? 'f' : 'S'}`);
    this.ops.push(parts.join(' '));
  }

  /** A filled polygon; points are top-left based [x, y]. */
  polygon(points, { fill = [0, 0, 0] } = {}) {
    if (points.length < 3) return;
    const path = points.map(([x, y], i) => `${n(x)} ${n(this._y(y))} ${i ? 'l' : 'm'}`).join(' ');
    this.ops.push(`${rgb(fill)} rg ${path} h f`);
  }

  line(x1, y1, x2, y2, { color = [0, 0, 0], width = 0.5 } = {}) {
    this.ops.push(`${rgb(color)} RG ${n(width)} w ${n(x1)} ${n(this._y(y1))} m ${n(x2)} ${n(this._y(y2))} l S`);
  }

  /** Place a JPEG (bytes, pixel size) in the box x, y, w, h (top-left). One image per page. */
  jpeg(bytes, pxWidth, pxHeight, x, y, w, h) {
    this.image = { bytes, pxWidth, pxHeight };
    this.ops.push(`q ${n(w)} 0 0 ${n(h)} ${n(x)} ${n(this._y(y + h))} cm /Im1 Do Q`);
  }

  /** @returns {Uint8Array} the PDF file */
  build({ title = '', author = '', creator = '02 Geo3D Analyzer' } = {}) {
    const enc = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 255);
    const chunks = [];
    const offsets = [];
    let size = 0;
    const push = (u8) => { chunks.push(u8); size += u8.length; };
    const obj = (id, body) => { offsets[id] = size; push(enc(`${id} 0 obj\n`)); for (const b of body) push(typeof b === 'string' ? enc(b) : b); push(enc('\nendobj\n')); };
    push(enc('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'));
    const content = this.ops.join('\n');
    const resources = `/Font << /F1 5 0 R /F2 6 0 R >>${this.image ? ' /XObject << /Im1 7 0 R >>' : ''}`;
    obj(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
    obj(2, ['<< /Type /Pages /Kids [3 0 R] /Count 1 >>']);
    obj(3, [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(this.width)} ${n(this.height)}] /Resources << ${resources} >> /Contents 4 0 R >>`]);
    obj(4, [`<< /Length ${content.length} >>\nstream\n`, content, '\nendstream']);
    obj(5, ['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>']);
    obj(6, ['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>']);
    let next = 7;
    if (this.image) {
      const im = this.image;
      obj(7, [`<< /Type /XObject /Subtype /Image /Width ${im.pxWidth} /Height ${im.pxHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.bytes.length} >>\nstream\n`, im.bytes, '\nendstream']);
      next = 8;
    }
    obj(next, [`<< /Title ${pdfInfoString(title)} /Author ${pdfInfoString(author)} /Creator ${pdfInfoString(creator)} /Producer ${pdfInfoString(creator)} >>`]);
    const xref = size;
    let table = `xref\n0 ${next + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= next; i++) table += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
    push(enc(table));
    push(enc(`trailer\n<< /Size ${next + 1} /Root 1 0 R /Info ${next} 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
    const out = new Uint8Array(size);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }
}

function n(v) { return Number(v).toFixed(2).replace(/\.?0+$/, '') || '0'; }
function rgb(c) { return c.map((v) => n(Math.max(0, Math.min(1, v)))).join(' '); }
