import { esc, fmtTime, fmtRange, fmtDuration, statusPill, timeToMin, fmtDate } from '../ui.js';
import { store } from '../store.js';

export function pageHead(title, sub, actionsHtml = '') {
  return `<div class="card-head">
    <div><h1>${esc(title)}</h1>${sub ? `<div class="small muted">${esc(sub)}</div>` : ''}</div>
    <div class="spacer"></div>
    <div class="rowacts">${actionsHtml}</div>
  </div>`;
}

export function statTile(kind, k, v, s = '') {
  return `<div class="stat ${kind}"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>${s ? `<div class="s">${esc(s)}</div>` : ''}</div>`;
}

export function utilClass(pct) { return pct >= 70 ? '' : pct >= 30 ? 'warn' : 'bad'; }

/** Card used in the resource grid. */
export function resourceCard(r, report) {
  const m = report?.perResource.find((x) => x.resource.id === r.id);
  const pct = m ? m.utilization : 0;
  const state = !r.is_active ? ['grey', 'Out of service']
    : !r.is_bookable ? ['grey', 'Internal only']
    : r.in_use ? ['coral', 'Occupied now']
    : ['green', 'Free now'];
  return `<div class="res-card" data-resource="${r.id}">
    <div class="thumb t${r.type_index}">
      <span class="cap">${r.capacity ? `👥 ${r.capacity}` : '—'}</span>
      <span class="code">${esc(r.code)}</span>
    </div>
    <div class="body">
      <div class="name">${esc(r.name)}</div>
      <div class="meta">
        <span>${esc(r.type_name)}</span>
        <span>${esc(r.building_name || '')}${r.floor_label ? ' · ' + esc(r.floor_label) : ''}</span>
      </div>
      <div class="flex">
        <span class="pill ${state[0]}">${esc(state[1])}</span>
        ${r.requires_approval ? '<span class="pill amber">Approval</span>' : '<span class="pill teal">Instant</span>'}
        ${m && m.bookings === 0 ? '<span class="pill pink">Unused</span>' : ''}
      </div>
      ${r.features.length ? `<div class="chips">${r.features.slice(0, 3).map((f) => `<span class="pill grey">${esc(f)}</span>`).join('')}${r.features.length > 3 ? `<span class="pill grey">+${r.features.length - 3}</span>` : ''}</div>` : ''}
      ${m ? `<div>
        <div class="flex between small muted"><span>${pct.toFixed(0)}% used (30d)</span><span>${m.bookings} booking${m.bookings === 1 ? '' : 's'}</span></div>
        <div class="util-bar ${utilClass(pct)}"><i style="width:${Math.max(2, pct).toFixed(1)}%"></i></div>
      </div>` : ''}
      <div class="foot">
        <button class="btn btn-primary btn-sm" data-book="${r.id}">Book</button>
        <button class="btn btn-ghost btn-sm" data-availability="${r.id}">Availability</button>
      </div>
    </div>
  </div>`;
}

/** A day at a glance for one or more resources, 06:00-23:00. */
export function dayTimeline(resourceIds, date) {
  const dayStart = startOfDayLocal(date);
  const H_FROM = 6, H_TO = 23;
  const span = (H_TO - H_FROM) * 60;
  const toPct = (d) => {
    const t = new Date(d);
    const mins = (t.getHours() - H_FROM) * 60 + t.getMinutes();
    return Math.max(0, Math.min(100, (mins / span) * 100));
  };
  const now = new Date();
  const showNow = now >= dayStart && now < new Date(dayStart.getTime() + 86400000);

  const hours = Array.from({ length: H_TO - H_FROM }, (_, i) => `<span>${String(H_FROM + i).padStart(2, '0')}</span>`).join('');

  const rows = resourceIds.map((rid) => {
    const r = store.resourceById(rid);
    if (!r) return '';
    const blocks = [];
    for (const b of store.bookingsFor(rid)) {
      const t = new Date(b.start_time);
      if (t.toDateString() !== dayStart.toDateString()) continue;
      const a = toPct(t), c = toPct(b.end_time);
      if (a < 100 && c > 0) {
        blocks.push(`<div class="tl-blk ${b.status_code}" style="left:${a}%;width:${Math.max(1.2, c - a)}%" title="${esc(b.booking_reference)} · ${esc(b.title)} · ${fmtTime(b.start_time)}-${fmtTime(b.end_time)}">${esc(short(b.title))}</div>`);
      }
      if (b.buffer_after_minutes) {
        const w = (b.buffer_after_minutes / span) * 100;
        blocks.push(`<div class="tl-blk buff" style="left:${c}%;width:${w}%" title="Reset buffer ${b.buffer_after_minutes}m"></div>`);
      }
    }
    for (const m of store.maintenanceFor(rid)) {
      if (m.status === 'cancelled') continue;
      if (new Date(m.start_time).toDateString() !== dayStart.toDateString()) continue;
      const a = toPct(m.start_time);
      const c = m.end_time ? toPct(m.end_time) : 100;
      blocks.push(`<div class="tl-blk maintenance" style="left:${a}%;width:${Math.max(1.2, c - a)}%" title="${esc(m.title)}">🔧 ${esc(m.title)}</div>`);
    }
    for (const bl of store.blackoutsFor(rid)) {
      if (new Date(bl.start_time).toDateString() !== dayStart.toDateString()) continue;
      const a = toPct(bl.start_time), c = toPct(bl.end_time);
      blocks.push(`<div class="tl-blk cancelled" style="left:${a}%;width:${Math.max(1.2, c - a)}%" title="${esc(bl.reason)}">⛔ ${esc(bl.reason)}</div>`);
    }
    const nowPct = showNow ? `<div class="tl-now" style="left:${toPct(now)}%"></div>` : '';
    return `<div class="tl-row">
      <div class="lbl" title="${esc(r.name)}">${esc(r.code)} · ${esc(r.name)}</div>
      <div class="tl-track">${blocks.join('')}${nowPct}</div>
    </div>`;
  }).join('');

  return `<div class="tl">
    <div class="tl-row" style="background:var(--cream)">
      <div class="lbl small muted">Campus local time</div>
      <div class="tl-hours" style="width:100%">${hours}</div>
    </div>
    ${rows}
  </div>
  <div class="flex small muted mt" style="gap:14px">
    <span><span class="pill green">Approved</span></span>
    <span><span class="pill amber">Pending</span></span>
    <span><span class="pill coral">Maintenance</span></span>
    <span><span class="pill grey">Blackout / reset</span></span>
  </div>`;
}

/** A single compact track showing one resource's whole day. */
export function miniTrack(resourceId, when) {
  const H_FROM = 6, H_TO = 23;
  const span = (H_TO - H_FROM) * 60;
  const dayStart = startOfDayLocal(when);
  const toPct = (d) => {
    const t = new Date(d);
    const mins = (t.getHours() - H_FROM) * 60 + t.getMinutes();
    return Math.max(0, Math.min(100, (mins / span) * 100));
  };
  const blocks = [];
  for (const b of store.bookingsFor(resourceId)) {
    if (new Date(b.start_time).toDateString() !== dayStart.toDateString()) continue;
    const a = toPct(b.start_time), c = toPct(b.end_time);
    if (a < 100 && c > 0) {
      blocks.push(`<div class="tl-blk ${b.status_code}" style="left:${a}%;width:${Math.max(1.2, c - a)}%" title="${esc(b.booking_reference)} · ${esc(b.title)}"></div>`);
    }
  }
  return `<div class="tl-track" style="min-width:180px">${blocks.join('')}</div>`;
}

function short(s) { return String(s).length > 18 ? `${String(s).slice(0, 17)}…` : String(s); }
function startOfDayLocal(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }

/** Window labels for a resource, e.g. "Mon-Fri 07:30-19:00". */
export function availabilitySummary(resourceId) {
  const rows = store.availabilityFor(resourceId);
  if (!rows.length) return 'No published hours (treated as 08:00-18:00)';
  const byDow = new Map();
  rows.forEach((r) => {
    const k = `${r.start_time.slice(0, 5)}-${r.end_time.slice(0, 5)}`;
    if (!byDow.has(k)) byDow.set(k, []);
    byDow.get(k).push(r.day_of_week);
  });
  return [...byDow.entries()].map(([k, days]) => {
    const sorted = [...new Set(days)].sort();
    const contiguous = sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1);
    const label = contiguous && sorted.length > 2
      ? `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][sorted[0]]}-${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][sorted.at(-1)]}`
      : sorted.map((d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join(',');
    return `${label} ${k}`;
  }).join(' · ');
}

export function bookingRow(b, { showActions = true, approve = false } = {}) {
  const res = b.resources.map((r) => r.name).join(', ') || '-';
  const when = `${fmtRange(b.start_time, b.end_time)}`;
  const past = new Date(b.end_time) < new Date();
  return `<tr data-booking="${b.id}">
    <td>
      <div class="flex">
        <span class="avatar ${b.status_code === 'pending' ? 'c' : 'g'}">${esc(initials(b.requester_name))}</span>
        <div>
          <b>${esc(b.title)}</b>
          <div class="small muted mono">${esc(b.booking_reference)}</div>
        </div>
      </div>
    </td>
    <td class="small">${esc(res)}</td>
    <td class="small nowrap">${esc(when)}<div class="small muted">${esc(fmtDuration(b.duration_ms))}</div></td>
    <td class="small">${esc(b.requester_name)}${b.department ? `<div class="small muted">${esc(b.department)}</div>` : ''}</td>
    <td class="small">${b.attendee_count ? esc(b.attendee_count) : '-'}</td>
    <td>${statusPill(b.status_code)}</td>
    <td>${showActions ? actionsFor(b, { approve, past }) : ''}</td>
  </tr>`;
}

function actionsFor(b, { approve, past }) {
  const own = b.requested_by === store.user?.id;
  const btns = [];
  if (approve && b.status_code === 'pending') {
    btns.push(`<button class="btn btn-green btn-sm" data-approve="${b.id}">Approve</button>`);
    btns.push(`<button class="btn btn-coral btn-sm" data-reject="${b.id}">Reject</button>`);
  }
  if (['pending', 'approved'].includes(b.status_code) && (own || store.isAdmin()) && !past) {
    btns.push(`<button class="btn btn-ghost btn-sm" data-cancel="${b.id}">Cancel</button>`);
  }
  btns.push(`<button class="btn btn-ghost btn-sm" data-view="${b.id}">Details</button>`);
  return `<div class="rowacts">${btns.join('')}</div>`;
}

function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0] || '').join('').toUpperCase();
}

export { initials };
