// @ts-check
// Small canvas charts: terrain profile, wind rose, monthly climate bars and
// a Pareto scatter. Drawn at device resolution; colours follow the CSS theme.

function setup(canvas, height) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth || 300;
  canvas.width = w * dpr;
  canvas.height = height * dpr;
  canvas.style.height = `${height}px`;
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, height);
  ctx.font = '11px system-ui, sans-serif';
  return { ctx, w, h: height };
}

function niceStep(span, target = 5) {
  const raw = span / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}

/**
 * Terrain profile with building silhouettes and an optional water level.
 * data: { points: [{ d, z, top? }], water?: number, vertical?: number }
 */
export function drawProfile(canvas, data, height = 190) {
  const { ctx, w, h } = setup(canvas, height);
  const pts = data.points;
  if (!pts.length) return;
  const pad = { l: 46, r: 10, t: 10, b: 24 };
  const dMax = pts[pts.length - 1].d || 1;
  let zMin = Infinity, zMax = -Infinity;
  for (const p of pts) { zMin = Math.min(zMin, p.z); zMax = Math.max(zMax, Number.isFinite(p.top) ? p.top : p.z); }
  if (Number.isFinite(data.water)) { zMin = Math.min(zMin, data.water); zMax = Math.max(zMax, data.water); }
  const span = Math.max(2, zMax - zMin);
  zMin -= span * 0.08; zMax += span * 0.08;
  const X = (d) => pad.l + ((w - pad.l - pad.r) * d) / dMax;
  const Y = (z) => pad.t + ((h - pad.t - pad.b) * (zMax - z)) / (zMax - zMin);
  ctx.strokeStyle = 'rgba(120,130,140,0.25)';
  ctx.fillStyle = '#6b7380';
  const zs = niceStep(zMax - zMin, 4);
  for (let z = Math.ceil(zMin / zs) * zs; z <= zMax; z += zs) {
    ctx.beginPath(); ctx.moveTo(pad.l, Y(z)); ctx.lineTo(w - pad.r, Y(z)); ctx.stroke();
    ctx.fillText(`${Math.round(z)} m`, 4, Y(z) + 4);
  }
  const ds = niceStep(dMax, 6);
  for (let d = 0; d <= dMax + 1e-6; d += ds) ctx.fillText(`${Math.round(d)}`, X(d) - 8, h - 6);
  // Buildings.
  ctx.fillStyle = 'rgba(150,140,128,0.9)';
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i];
    if (!Number.isFinite(p.top) || p.top <= p.z + 0.2) continue;
    ctx.fillRect(X(p.d), Y(p.top), Math.max(1, X(pts[i + 1].d) - X(p.d)) + 0.5, Y(p.z) - Y(p.top));
  }
  // Ground.
  ctx.beginPath();
  ctx.moveTo(X(0), h - pad.b);
  for (const p of pts) ctx.lineTo(X(p.d), Y(p.z));
  ctx.lineTo(X(dMax), h - pad.b);
  ctx.closePath();
  ctx.fillStyle = 'rgba(122,154,96,0.55)';
  ctx.fill();
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(X(p.d), Y(p.z)) : ctx.moveTo(X(p.d), Y(p.z))));
  ctx.strokeStyle = '#3f5e2a';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  if (Number.isFinite(data.water)) {
    ctx.strokeStyle = '#2f7fc1';
    ctx.setLineDash([5, 3]);
    ctx.beginPath(); ctx.moveTo(pad.l, Y(data.water)); ctx.lineTo(w - pad.r, Y(data.water)); ctx.stroke();
    ctx.setLineDash([]);
  }
}

/** Wind rose from weather.windRose(). */
export function drawWindRose(canvas, rose, height = 220) {
  const { ctx, w, h } = setup(canvas, height);
  const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 22;
  const colors = ['#c6dbef', '#9ecae1', '#6baed6', '#3182bd', '#08519c', '#08306b'];
  const maxF = Math.max(...rose.sectorFreq, 0.01);
  ctx.strokeStyle = 'rgba(120,130,140,0.3)';
  for (const f of [0.25, 0.5, 0.75, 1]) { ctx.beginPath(); ctx.arc(cx, cy, R * f, 0, 2 * Math.PI); ctx.stroke(); }
  const width = (2 * Math.PI) / rose.sectors;
  for (let s = 0; s < rose.sectors; s++) {
    let acc = 0;
    const bearing = (s * 360) / rose.sectors;
    const a0 = ((bearing - 90) * Math.PI) / 180 - width / 2 + 0.02;
    const a1 = a0 + width - 0.04;
    for (let c = 0; c < rose.classes.length; c++) {
      const f = rose.freq[s][c];
      if (!f) continue;
      const r0 = (R * acc) / maxF;
      acc += f;
      const r1 = (R * acc) / maxF;
      ctx.beginPath();
      ctx.arc(cx, cy, r1, a0, a1);
      ctx.arc(cx, cy, r0, a1, a0, true);
      ctx.closePath();
      ctx.fillStyle = colors[c % colors.length];
      ctx.fill();
    }
  }
  ctx.fillStyle = '#4a5260';
  for (const [t, a] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]]) {
    const r = R + 12;
    const ang = ((a - 90) * Math.PI) / 180;
    ctx.fillText(t, cx + Math.cos(ang) * r - 4, cy + Math.sin(ang) * r + 4);
  }
  ctx.fillText(`${(maxF * 100).toFixed(0)} %`, cx + 3, cy - R + 11);
}

/** Monthly bars (e.g. radiation) with a line (e.g. temperature). */
export function drawMonthly(canvas, months, height = 160) {
  const { ctx, w, h } = setup(canvas, height);
  const pad = { l: 34, r: 34, t: 10, b: 20 };
  const bw = (w - pad.l - pad.r) / 12;
  const gMax = Math.max(...months.map((m) => m.ghiKwh), 1);
  const tMin = Math.min(...months.map((m) => m.tMin), 0);
  const tMax = Math.max(...months.map((m) => m.tMax), 1);
  const Yg = (v) => h - pad.b - ((h - pad.t - pad.b) * v) / gMax;
  const Yt = (v) => h - pad.b - ((h - pad.t - pad.b) * (v - tMin)) / (tMax - tMin || 1);
  months.forEach((m, i) => {
    ctx.fillStyle = '#f2b134';
    ctx.fillRect(pad.l + i * bw + 3, Yg(m.ghiKwh), bw - 6, h - pad.b - Yg(m.ghiKwh));
    ctx.fillStyle = '#6b7380';
    ctx.fillText(m.name[0], pad.l + i * bw + bw / 2 - 3, h - 6);
  });
  ctx.strokeStyle = '#d6452e';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  months.forEach((m, i) => { const x = pad.l + i * bw + bw / 2; if (i) ctx.lineTo(x, Yt(m.tMean)); else ctx.moveTo(x, Yt(m.tMean)); });
  ctx.stroke();
  ctx.fillStyle = '#b07a12';
  ctx.fillText(`${Math.round(gMax)}`, 2, pad.t + 8);
  ctx.fillText('kWh', 2, pad.t + 20);
  ctx.fillStyle = '#d6452e';
  ctx.fillText(`${Math.round(tMax)}°`, w - pad.r + 4, pad.t + 8);
  ctx.fillText(`${Math.round(tMin)}°`, w - pad.r + 4, h - pad.b);
}

/**
 * Scatter with clickable points. points: [{ x, y, front, id }]; returns a
 * function that maps a click to the nearest point id.
 */
export function drawScatter(canvas, points, { xLabel = '', yLabel = '', selected = null } = {}, height = 200) {
  const { ctx, w, h } = setup(canvas, height);
  const pad = { l: 46, r: 10, t: 10, b: 30 };
  if (!points.length) return () => null;
  let x0 = Math.min(...points.map((p) => p.x)), x1 = Math.max(...points.map((p) => p.x));
  let y0 = Math.min(...points.map((p) => p.y)), y1 = Math.max(...points.map((p) => p.y));
  if (x1 - x0 < 1e-9) { x0 -= 1; x1 += 1; }
  if (y1 - y0 < 1e-9) { y0 -= 1; y1 += 1; }
  const X = (v) => pad.l + ((w - pad.l - pad.r) * (v - x0)) / (x1 - x0);
  const Y = (v) => h - pad.b - ((h - pad.t - pad.b) * (v - y0)) / (y1 - y0);
  ctx.strokeStyle = 'rgba(120,130,140,0.35)';
  ctx.strokeRect(pad.l, pad.t, w - pad.l - pad.r, h - pad.t - pad.b);
  ctx.fillStyle = '#6b7380';
  ctx.fillText(xLabel, pad.l, h - 6);
  ctx.save(); ctx.translate(10, h - pad.b); ctx.rotate(-Math.PI / 2); ctx.fillText(yLabel, 0, 0); ctx.restore();
  ctx.fillText(x0.toPrecision(3), pad.l, h - pad.b + 12);
  ctx.fillText(x1.toPrecision(3), w - pad.r - 30, h - pad.b + 12);
  ctx.fillText(y1.toPrecision(3), 14, pad.t + 9);
  for (const p of points) {
    ctx.beginPath();
    if (p.current) {
      ctx.arc(X(p.x), Y(p.y), 6, 0, 2 * Math.PI);
      ctx.strokeStyle = '#1d2430';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = '#1d2430';
      ctx.fillText('now', X(p.x) + 8, Y(p.y) + 4);
      continue;
    }
    ctx.arc(X(p.x), Y(p.y), p.front ? 4.5 : p.infeasible ? 3 : 2.5, 0, 2 * Math.PI);
    if (p.infeasible && p.id !== selected) {
      // Breaks a constraint: an open ring.
      ctx.strokeStyle = 'rgba(200,120,40,0.75)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      continue;
    }
    ctx.fillStyle = p.id === selected ? '#ff4f2e' : p.front ? '#1f6feb' : 'rgba(120,130,140,0.45)';
    ctx.fill();
  }
  return (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    let best = null, bd = 144;
    for (const p of points) {
      const d = (X(p.x) - mx) ** 2 + (Y(p.y) - my) ** 2;
      if (d < bd) { bd = d; best = p.id; }
    }
    return best;
  };
}
