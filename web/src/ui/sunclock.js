// @ts-check
// Top-bar sun clock: date, time of day, play through the day.
import { h, select, number } from './dom.js';
import { MONTH_NAMES, typicalDoy } from '../core/weather.js';
import { sunriseSunset } from '../core/solar.js';

export function buildSunClock(app, root) {
  const fmt = (t) => `${String(Math.floor(t)).padStart(2, '0')}:${String(Math.round((t % 1) * 60) % 60).padStart(2, '0')}`;
  const timeLabel = h('span', { class: 'clock-time', text: fmt(app.time) });
  const sunLabel = h('span', { class: 'clock-sun' });
  const range = h('input', { type: 'range', min: 0, max: 24, step: 0.05, value: String(app.time), class: 'clock-range',
    oninput: () => { app.time = Number(range.value); app.updateSun(); } });
  let playing = 0;
  const play = h('button', { class: 'btn icon-btn', title: 'Play the day', text: '▶', onclick: () => {
    if (playing) { cancelAnimationFrame(playing); playing = 0; play.textContent = '▶'; return; }
    const { sunrise, sunset } = sunriseSunset(typicalDoy(app.date.month, app.date.day), app.site.lat, app.site.lon, app.site.utcOffset);
    const start = sunrise ?? 5, end = sunset ?? 20;
    if (app.time < start || app.time >= end - 0.05) app.time = start;
    play.textContent = '❚❚';
    let last = performance.now();
    const step = (now) => {
      const dt = (now - last) / 1000;
      last = now;
      app.time += dt * ((end - start) / 18); // the whole day in about 18 s
      if (app.time >= end) { app.time = end; playing = 0; play.textContent = '▶'; app.updateSun(); return; }
      app.updateSun();
      playing = requestAnimationFrame(step);
    };
    playing = requestAnimationFrame(step);
  } });
  const month = select(MONTH_NAMES.map((m, i) => [i + 1, m]), app.date.month, (v) => { app.date.month = Number(v); app.updateSun(); });
  const day = number(app.date.day, { min: 1, max: 31, step: 1, width: '4.6em', onChange: (v) => { app.date.day = Math.max(1, Math.min(31, v)); app.updateSun(); } });
  app.on((what) => {
    if (what !== 'sun') return;
    range.value = String(app.time);
    month.value = String(app.date.month);
    day.value = String(app.date.day);
    timeLabel.textContent = fmt(app.time);
    const p = app.sunPosition();
    const el = (p.elevation * 180) / Math.PI;
    sunLabel.textContent = el > 0 ? `sun ${el.toFixed(0)}° high, ${((p.azimuth * 180) / Math.PI).toFixed(0)}°` : 'sun below the horizon';
  });
  root.append(h('span', { class: 'clock-icon', text: '☀' }), month, day, range, timeLabel, play, sunLabel);
  app.emit('sun');
}
