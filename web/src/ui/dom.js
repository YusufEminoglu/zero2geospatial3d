// @ts-check
// Tiny DOM helpers: no framework, just elements and form rows.

/**
 * Create an element. attrs: class, text, html, style (object), on* handlers,
 * any other attribute or property.
 * @returns {any}
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/** A labelled row. */
export function row(label, control, hint = '') {
  return h('label', { class: 'row', title: hint || undefined }, h('span', { class: 'row-label', text: label }), control);
}

export function select(options, value, onChange) {
  const el = h('select', { onchange: () => onChange?.(el.value) });
  for (const o of options) {
    const [v, label] = Array.isArray(o) ? o : [o, o];
    el.appendChild(h('option', { value: String(v), text: String(label), selected: String(v) === String(value) }));
  }
  return el;
}

export function number(value, { min, max, step = 'any', onChange, width } = {}) {
  const el = h('input', { type: 'number', value: String(value), min, max, step, style: width ? { width } : undefined,
    onchange: () => onChange?.(Number(el.value)) });
  return el;
}

export function slider(value, { min, max, step = 1, format = (v) => String(v), onInput, onChange } = {}) {
  const out = h('span', { class: 'slider-value', text: format(value) });
  const el = h('input', { type: 'range', min, max, step, value: String(value),
    oninput: () => { out.textContent = format(Number(el.value)); onInput?.(Number(el.value)); },
    onchange: () => onChange?.(Number(el.value)) });
  const wrap = h('span', { class: 'slider' }, el, out);
  wrap.input = el;
  wrap.set = (v) => { el.value = String(v); out.textContent = format(Number(v)); };
  return wrap;
}

export function toggle(checked, onChange, label = '') {
  const input = h('input', { type: 'checkbox', checked, onchange: () => onChange?.(input.checked) });
  return h('label', { class: 'toggle' }, input, label ? h('span', { text: label }) : null);
}

export function button(text, onClick, { kind = '', title = '', icon = '' } = {}) {
  return h('button', { class: `btn ${kind}`, title: title || undefined, onclick: onClick }, icon ? h('span', { class: 'icon', text: icon }) : null, text);
}

/** Collapsible card. */
export function card(title, body, { open = false, subtitle = '', badge = '' } = {}) {
  const el = h('details', { class: 'card', open },
    h('summary', {}, h('span', { class: 'card-title', text: title }), badge ? h('span', { class: 'badge', text: badge }) : null,
      subtitle ? h('span', { class: 'card-sub', text: subtitle }) : null),
    h('div', { class: 'card-body' }, body));
  return el;
}

export function stats(pairs) {
  return h('table', { class: 'stats' }, ...pairs.map(([k, v]) => h('tr', {}, h('td', { text: k }), h('td', { text: v }))));
}

/** Save a Blob or data URL as a download. */
export function download(name, data, type = 'text/plain') {
  const url = typeof data === 'string' && data.startsWith('data:') ? data : URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  const a = h('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (!url.startsWith('data:')) setTimeout(() => URL.revokeObjectURL(url), 4000);
}

let toastTimer = 0;
export function toast(text, kind = '') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = text;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { el.className = 'toast'; }, 4200);
}
