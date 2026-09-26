import { store } from '../store.js';
import { evaluateBooking, suggestSlots } from '../conflicts.js';
import {
  esc, toast, fmtRange, fmtDate, fmtTime, fmtDuration, dateToDtLocal, startOfDay, addDays,
  debounce, emptyState, DAY, MIN,
} from '../ui.js';
import { pageHead, dayTimeline, miniTrack } from './common.js';
import { go } from '../router.js';

const q = { type: '', building: '', from: dateToDtLocal(new Date()).slice(0, 10), to: dateToDtLocal(addDays(new Date(), 7)).slice(0, 10), duration: 60, minCap: 0 };

/** "Find a free slot" — the anti-double-booking discovery tool. */
export function render() {
  return `
    ${pageHead('Find a free slot', 'Search every resource at once and get conflict-free windows that respect buffers, opening hours and blackouts', `
      <button class="btn btn-primary btn-sm" data-nav="new-booking">+ New booking</button>`)}

    <div class="card mb">
      <div class="row">
        <div><label class="lbl">From</label><input id="from" type="date" value="${esc(q.from)}"></div>
        <div><label class="lbl">To</label><input id="to" type="date" value="${esc(q.to)}"></div>
        <div><label class="lbl">Duration (min)</label>
          <select id="dur">${[30, 45, 60, 90, 120, 180, 240, 360, 480].map((d) => `<option ${q.duration === d ? 'selected' : ''}>${d}</option>`).join('')}</select></div>
        <div><label class="lbl">Type</label>
          <select id="type"><option value="">All types</option>
            ${store.resourceTypes().map((t) => `<option value="${t.id}" ${String(q.type) === String(t.id) ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div>
        <div><label class="lbl">Building</label>
          <select id="building"><option value="">All buildings</option>
            ${store.buildings().map((b) => `<option value="${b.id}" ${String(q.building) === String(b.id) ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></div>
        <div><label class="lbl">Min seats</label><input id="cap" type="number" min="0" value="${q.minCap || ''}" placeholder="0"></div>
      </div>
      <div class="flex">
        <button class="btn btn-primary" id="search">🔍 Search free windows</button>
        <span class="small muted" id="status"></span>
      </div>
    </div>

    <div id="results"></div>`;
}

export function after(root) {
  const results = root.querySelector('#results');
  const status = root.querySelector('#status');

  const bind = (sel, key, isNum = false) => {
    const n = root.querySelector(sel);
    n.addEventListener('change', () => { q[key] = isNum ? (Number(n.value) || 0) : n.value; });
  };
  bind('#from', 'from'); bind('#to', 'to'); bind('#dur', 'duration', true);
  bind('#type', 'type'); bind('#building', 'building'); bind('#cap', 'minCap', true);

  async function search() {
    status.textContent = 'Scanning the full timetable…';
    const from = new Date(`${q.from}T00:00:00`);
    const to = new Date(`${q.to}T23:59:59`);
    const dur = Number(q.duration) * MIN;
    if (Number.isNaN(+from) || Number.isNaN(+to) || to < from) { toast('Invalid date range', 'err'); return; }
    const days = Math.min(60, Math.round((to - from) / DAY) + 1);

    let pool = store.resources().filter((r) => r.is_bookable && r.is_active);
    if (q.type) pool = pool.filter((r) => r.resource_type_id === Number(q.type));
    if (q.building) pool = pool.filter((r) => r.building_id === Number(q.building));
    if (q.minCap) pool = pool.filter((r) => (r.capacity || 0) >= q.minCap);

    const out = [];
    for (let d = 0; d < days; d++) {
      const day = startOfDay(new Date(from.getTime() + d * DAY));
      if (day < startOfDay(new Date())) continue;
      for (const r of pool) {
        const slots = suggestSlots(store, r, day, new Date(day.getTime() + dur), 1)
          .filter((s) => s.start >= from && s.end <= to);
        if (!slots.length) continue;
        const s = slots[0];
        const check = evaluateBooking(store, { resourceIds: [r.id], start: s.start, end: s.end });
        if (check.ok) out.push({ r, start: s.start, end: s.end });
      }
      if (out.length > 400) break;
    }

    out.sort((a, b) => new Date(a.start) - new Date(b.start));
    status.textContent = `${out.length} conflict-free option(s) found`;

    if (!out.length) {
      results.innerHTML = `<div class="card">${emptyState('🧱', 'Nothing free in that window', 'Every matching resource is booked, in maintenance or blacked out. Widen the range or lower the capacity requirement.')}</div>`;
      return;
    }

    const byDay = new Map();
    out.forEach((o) => {
      const k = o.start.toDateString();
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(o);
    });

    results.innerHTML = [...byDay.entries()].slice(0, 10).map(([day, slots]) => `
      <div class="card mb">
        <div class="card-head"><h2>${esc(day)}</h2><div class="spacer"></div>
          <span class="small muted">${slots.length} free · ${fmtDate(slots[0].start)}</span></div>
        <div class="scroll-x"><table class="tbl">
          <thead><tr><th>Time</th><th>Resource</th><th>Type</th><th class="num">Cap.</th><th>Window</th><th></th></tr></thead>
          <tbody>${slots.slice(0, 20).map((o) => `<tr>
            <td class="small nowrap"><b>${esc(fmtTime(o.start))}–${esc(fmtTime(o.end))}</b></td>
            <td class="small">${esc(o.r.name)}</td>
            <td class="small">${esc(o.r.type_name)}</td>
            <td class="num">${o.r.capacity ?? '—'}</td>
            <td>${miniTrack(o.r.id, o.start)}</td>
            <td><button class="btn btn-primary btn-sm" data-use="${o.r.id}|${o.start.toISOString()}|${o.end.toISOString()}">Book</button></td>
          </tr>`).join('')}</tbody>
        </table></div>
      </div>`).join('');

    results.querySelectorAll('[data-use]').forEach((b) => {
      b.onclick = () => {
        const [rid, s, e] = b.dataset.use.split('|');
        sessionStorage.setItem('campusbook.suggested', JSON.stringify({ resourceId: Number(rid), start: s, end: e }));
        go('new-booking', { resource: rid, start: s, end: e });
      };
    });
  }

  root.querySelector('#search').onclick = search;
  root.querySelector('#search').dataset.ready = '1';
  setTimeout(search, 0);
}
