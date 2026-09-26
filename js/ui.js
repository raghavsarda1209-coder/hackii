// Small DOM / formatting helpers shared across views.

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Escape untrusted text before putting it in innerHTML. */
export function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

// ---------------------------------------------------------------- dates ----
export const MIN = 60000;
export const HOUR = 3600000;
export const DAY = 86400000;

export function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
export function addDays(d, n) { return new Date(new Date(d).getTime() + n * DAY); }

export function fmtDate(d) {
  if (!d) return '-';
  return new Date(d).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}
export function fmtDay(d) {
  if (!d) return '-';
  return new Date(d).toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short' });
}
export function fmtTime(d) {
  if (!d) return '-';
  return new Date(d).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
export function fmtRange(a, b) { return `${fmtDay(a)} · ${fmtTime(a)} – ${fmtTime(b)}`; }
export function fmtDateTime(d) { return `${fmtDate(d)} ${fmtTime(d)}`; }

export function fmtDuration(ms) {
  if (ms === null || ms === undefined) return '-';
  const mins = Math.round(ms / MIN);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
export function fmtHours(ms) { return `${(ms / HOUR).toFixed(1)}h`; }

export function fmtAgo(iso) {
  if (!iso) return '-';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return 'in the future';
  const m = Math.floor(diff / MIN);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return fmtDate(iso);
}

/** value of a <input type="datetime-local"> -> Date (local) */
export function dtLocalToDate(value) { return value ? new Date(value) : null; }
/** Date -> value for <input type="datetime-local"> */
export function dateToDtLocal(d) {
  if (!d) return '';
  const x = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}T${p(x.getHours())}:${p(x.getMinutes())}`;
}
export function toDateInput(d) { return dtLocalToDate(dateToDtLocal(d)) ? dateToDtLocal(d).slice(0, 10) : ''; }

/** minutes-from-midnight for a time-only "HH:MM:SS" string */
export function timeToMin(t) {
  if (!t) return 0;
  const [h, m] = String(t).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
export function minToTime(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
}
export function fmtTimeOfDay(t) {
  if (!t) return '-';
  const [h, m] = String(t).split(':');
  return `${String(h).padStart(2, '0')}:${String(m || '00')}`;
}

/** Half-open overlap test: [aStart, aEnd) vs [bStart, bEnd) */
export function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

export function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0] || '').join('').toUpperCase();
}

// ------------------------------------------------------------ feedback ----
let toastHost = null;
export function toast(msg, kind = 'ok', sub = '') {
  if (!toastHost) {
    toastHost = el('div', { class: 'toasts' });
    document.body.append(toastHost);
  }
  const t = el('div', { class: `toast ${kind}`, html: `${esc(msg)}${sub ? `<small>${esc(sub)}</small>` : ''}` });
  toastHost.append(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 3600);
  setTimeout(() => t.remove(), 4000);
}

let openModalEl = null;
export function openModal({ title, body, footer = '', wide = false, onClose }) {
  closeModal();
  const overlay = el('div', { class: 'overlay open' });
  const modal = el('div', { class: `modal${wide ? ' wide' : ''}` });
  const close = () => { overlay.remove(); openModalEl = null; document.removeEventListener('keydown', onKey); onClose && onClose(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  modal.append(
    el('div', { class: 'modal-head' }, el('h2', { text: title }), el('button', { class: 'x', title: 'Close', onclick: close, text: '×' })),
    el('div', { class: 'modal-body' }, typeof body === 'string' ? el('div', { html: body }) : body),
  );
  if (footer) modal.append(el('div', { class: 'modal-foot', html: footer }));
  overlay.append(modal);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  openModalEl = overlay;
  const focusable = modal.querySelector('input,select,textarea,button.btn');
  if (focusable) setTimeout(() => focusable.focus(), 30);
  return { close, modal, footer: modal.querySelector('.modal-foot') };
}
export function closeModal() {
  if (openModalEl) { openModalEl.remove(); openModalEl = null; }
}

export function confirmDialog(title, message, confirmLabel = 'Confirm', kind = 'primary') {
  return new Promise((resolve) => {
    const m = openModal({
      title,
      body: `<p>${esc(message)}</p>`,
      footer: `<button class="btn btn-ghost" data-x>Cancel</button><button class="btn btn-${kind}" data-ok>${esc(confirmLabel)}</button>`,
    });
    m.footer.querySelector('[data-x]').onclick = () => { m.close(); resolve(false); };
    m.footer.querySelector('[data-ok]').onclick = () => { m.close(); resolve(true); };
  });
}

export function promptDialog(title, label, value = '', { placeholder = '', type = 'text' } = {}) {
  return new Promise((resolve) => {
    const m = openModal({
      title,
      body: `<div class="field"><label class="lbl">${esc(label)}</label><input id="__pv" type="${esc(type)}" value="${esc(value)}" placeholder="${esc(placeholder)}"></div>`,
      footer: `<button class="btn btn-ghost" data-x>Cancel</button><button class="btn btn-primary" data-ok>Save</button>`,
    });
    const input = m.modal.querySelector('#__pv');
    const done = (v) => { m.close(); resolve(v); };
    m.footer.querySelector('[data-x]').onclick = () => done(null);
    m.footer.querySelector('[data-ok]').onclick = () => done(input.value.trim());
    input.onkeydown = (e) => { if (e.key === 'Enter') done(input.value.trim()); };
  });
}

export function emptyState(icon, text, sub = '') {
  return `<div class="empty"><span class="em">${esc(icon)}</span><b>${esc(text)}</b>${sub ? `<div class="small">${esc(sub)}</div>` : ''}</div>`;
}

export function statusPill(statusCode) {
  const map = {
    pending:   ['amber', '⏳ Pending approval'],
    approved:  ['green', '✔ Approved'],
    rejected:  ['coral', '✖ Rejected'],
    cancelled: ['grey',  '⊘ Cancelled'],
    completed: ['teal',  '★ Completed'],
  };
  const [cls, label] = map[statusCode] || ['grey', statusCode || 'unknown'];
  return `<span class="pill ${cls}">${label}</span>`;
}

export function downloadCsv(filename, rows) {
  const csv = rows.map((r) => r.map((c) => {
    const s = c === null || c === undefined ? '' : String(c);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = el('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a); a.click(); a.remove();
}

export function debounce(fn, ms = 250) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function genRef(prefix = 'CBR') {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${prefix}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}
