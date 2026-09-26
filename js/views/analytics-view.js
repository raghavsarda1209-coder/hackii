import { store } from '../store.js';
import { usageReport, insights, usageCsvRows } from '../analytics.js';
import { auditData } from '../conflicts.js';
import { esc, fmtHours, fmtDuration, fmtDate, fmtAgo, downloadCsv, emptyState, statusPill } from '../ui.js';
import { DAY_SHORT } from '../config.js';
import { pageHead, statTile, utilClass } from './common.js';
import { openResourceDetail } from './resource-detail.js';
import { go } from '../router.js';

let windowDays = 30;

export function render(params) {
  if (params.days) windowDays = Number(params.days) || 30;
  const r = usageReport(store, { days: windowDays });
  const s = r.summary;
  const notes = insights(r);
  const integrity = auditData(store, { days: 90 });
  const maxHour = Math.max(1, ...r.hourBuckets);
  const maxDay = Math.max(1, ...r.dayBuckets);
  const maxType = Math.max(1, ...r.typeBuckets.map((t) => t[1]));
  const totalIntegrity = integrity.duplicates.length + integrity.outOfHours.length + integrity.overCapacity.length;

  return `
    ${pageHead('Usage & utilisation', 'How well the campus estate is actually being used — and what is being wasted', `
      <select id="win" style="width:auto">
        ${[7, 14, 30, 90].map((d) => `<option value="${d}" ${windowDays === d ? 'selected' : ''}>last ${d} days</option>`).join('')}
      </select>
      <button class="btn btn-ghost btn-sm" id="csv">⤓ Export report</button>`)}

    <div class="grid g4 mb">
      ${statTile('g', 'Utilisation', `${s.utilisation.toFixed(1)}%`, `${fmtHours(s.bookedHours * 3600000)} of ${fmtHours(s.capacityHours * 3600000)} open hours`)}
      ${statTile('', 'Bookings', String(s.totalBookings), `${s.heldBookings} currently holding a slot`)}
      ${statTile('t', 'Headcount served', String(s.totalHeadcount), 'expected attendees in window')}
      ${statTile('a', 'Avg session', fmtDuration(s.avgDuration), 'across all held bookings')}
      ${statTile('c', 'Unused assets', String(s.unusedCount), `of ${s.bookableCount} bookable (${s.unusedCount ? ((s.unusedCount / Math.max(1, s.bookableCount)) * 100).toFixed(0) : 0}%)`)}
      ${statTile('p', 'Under-used (<10%)', String(s.underusedCount), 'booked but barely loaded')}
      ${statTile('', 'Over-used (>70%)', String(s.overusedCount), 'consider extra capacity')}
      ${statTile('c', 'Conflicts prevented', String(s.conflictsPrevented), 'from the audit log')}
      ${statTile('g', 'No-show rate', `${s.noShowRate.toFixed(0)}%`, `${s.attendanceRate.toFixed(0)}% turn-up recorded`)}
      ${statTile('a', 'Cancellation rate', `${s.cancellationRate.toFixed(0)}%`, `${s.rejectionRate.toFixed(0)}% rejected`)}
      ${statTile('t', 'Approval turnaround', fmtDuration(s.avgTurnaround), 'raise → decision')}
      ${statTile('p', 'Integrity issues', String(totalIntegrity), 'over the last 90 days')}
    </div>

    ${notes.length ? `<div class="card mb">${notes.map((n) => `<div class="banner ${n.tone}"><span>${n.icon}</span><span>${esc(n.text)}</span></div>`).join('')}</div>` : ''}

    <div class="grid g2 mb">
      <div class="card">
        <h2 class="mb">Busiest start times</h2>
        <div class="hbars">${r.hourBuckets.map((v, h) => `<div class="b" title="${String(h).padStart(2, '0')}:00 · ${v} booking(s)"><i style="height:${(v / maxHour) * 100}%"></i></div>`).join('')}</div>
        <div class="hbars-x">${r.hourBuckets.map((v, h) => `<span>${h % 3 === 0 ? h : ''}</span>`).join('')}</div>
        <p class="small muted mt">Peak demand lands at ${esc(String(r.hourBuckets.indexOf(maxHour)).padStart(2, '0'))}:00. Consider shifting optional bookings to the quiet tail hours.</p>
      </div>
      <div class="card">
        <h2 class="mb">Demand by weekday</h2>
        ${r.dayBuckets.map((v, d) => `<div class="bar-row">
          <div class="n">${DAY_SHORT[d]}</div>
          <div class="bar-track ${d >= 5 ? 'c' : 'g'}"><i style="width:${(v / maxDay) * 100}%"></i></div>
          <div class="v">${v}</div></div>`).join('')}
        <h2 class="mt mb">Bookings by resource type</h2>
        ${r.typeBuckets.slice(0, 6).map(([t, v]) => `<div class="bar-row">
          <div class="n" title="${esc(t)}">${esc(t)}</div>
          <div class="bar-track t"><i style="width:${(v / maxType) * 100}%"></i></div>
          <div class="v">${v}</div></div>`).join('')}
      </div>
    </div>

    <div class="card mb pad-0">
      <div class="card-head" style="padding:16px 16px 0"><h2>Resource utilisation detail</h2><div class="spacer"></div>
        <span class="small muted">click a row to open the resource</span></div>
      <div class="table-wrap">
        <table class="tbl">
          <thead><tr>
            <th>Resource</th><th>Type</th><th class="num">Capacity</th>
            <th style="width:190px">Utilisation</th><th class="num">Bookings</th>
            <th class="num">Booked h</th><th class="num">No-show</th><th>Last booked</th><th>Flag</th>
          </tr></thead>
          <tbody>${r.perResource.map((x) => `
            <tr data-res="${x.resource.id}" style="cursor:pointer">
              <td><b>${esc(x.resource.name)}</b><div class="small muted mono">${esc(x.resource.code)}</div></td>
              <td class="small">${esc(x.resource.type_name)}</td>
              <td class="num">${x.resource.capacity ?? '—'}</td>
              <td>
                <div class="flex between small"><span>${x.utilization.toFixed(1)}%</span><span class="muted">${(x.bookedMs / 3600000).toFixed(1)}h</span></div>
                <div class="util-bar ${utilClass(x.utilization)}"><i style="width:${Math.max(1.5, x.utilization).toFixed(1)}%"></i></div>
              </td>
              <td class="num">${x.bookings}</td>
              <td class="num">${(x.bookedMs / 3600000).toFixed(1)}</td>
              <td class="num">${x.noShowRate === null ? '—' : `${x.noShowRate.toFixed(0)}%`}</td>
              <td class="small nowrap">${x.lastBookedAt ? esc(fmtDate(x.lastBookedAt)) : '<span class="muted">never</span>'}</td>
              <td>${flagFor(x)}</td>
            </tr>`).join('')}</tbody>
        </table>
      </div>
    </div>

    <div class="grid g2 mb">
      <div class="card">
        <h2>Wasted capacity — act on these</h2>
        ${r.unused.length ? `<p class="small muted mb">${r.unused.length} bookable resource(s) received <b>zero</b> bookings in ${windowDays} days.</p>
          <div class="table-wrap"><table class="tbl">
            <thead><tr><th>Resource</th><th>Type</th><th>Cap.</th><th>Published hours</th><th>Suggestion</th></tr></thead>
            <tbody>${r.unused.map((x) => `<tr data-res="${x.resource.id}" style="cursor:pointer">
              <td><b>${esc(x.resource.name)}</b></td>
              <td class="small">${esc(x.resource.type_name)}</td>
              <td class="num">${x.resource.capacity ?? '—'}</td>
              <td class="small">${esc(fmtHours(x.availableMs))}</td>
              <td class="small">${esc(suggestionFor(x))}</td></tr>`).join('')}</tbody></table></div>`
          : '<div class="banner ok"><span>✅</span><span>Every bookable resource was used at least once. Good coverage.</span></div>'}
      </div>
      <div class="card">
        <h2>Data integrity — existing double bookings</h2>
        <p class="small muted">Scans every booking in the last 90 days for overlaps, out-of-hours bookings and over-capacity requests.</p>
        ${totalIntegrity ? `
          <div class="banner err"><span>⛔</span><span><b>${integrity.duplicates.length} overlapping booking pair(s)</b> found. Run the repair tool to resolve.</span></div>
          <div class="table-wrap"><table class="tbl">
            <thead><tr><th>Resource</th><th>Booking A</th><th>Booking B</th></tr></thead>
            <tbody>${integrity.duplicates.slice(0, 10).map((d) => `<tr>
              <td class="small">${esc(d.resource)}</td>
              <td class="small">${esc(d.a.booking_reference)}<div class="muted">${esc(fmtDate(d.a.start_time))} · ${esc(d.a.requester_name)}</div></td>
              <td class="small">${esc(d.b.booking_reference)}<div class="muted">${esc(fmtDate(d.b.start_time))} · ${esc(d.b.requester_name)}</div></td>
            </tr>`).join('')}</tbody></table></div>
          <div class="flex mt small muted">
            <span>${integrity.outOfHours.length} outside published hours</span>·
            <span>${integrity.overCapacity.length} over capacity</span>·
            <span>${integrity.orphanBookings.length} with no resource</span>
          </div>`
          : '<div class="banner ok"><span>✅</span><span>No double bookings, out-of-hours or over-capacity bookings in the last 90 days.</span></div>'}
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Attendance (no-show tracking)</h2><div class="spacer"></div>
        <span class="small muted">${s.noShowRate.toFixed(0)}% no-show of ${r.perResource.reduce((n, x) => n + x.attendeeCount, 0)} recorded invitations</span></div>
      ${r.perResource.filter((x) => x.attendeeCount > 0).sort((a, b) => (b.noShowRate || 0) - (a.noShowRate || 0)).slice(0, 8).map((x) => `
        <div class="bar-row">
          <div class="n" title="${esc(x.resource.name)}">${esc(x.resource.name)}</div>
          <div class="bar-track c"><i style="width:${x.noShowRate || 0}%"></i></div>
          <div class="v">${(x.noShowRate || 0).toFixed(0)}%</div>
        </div>`).join('') || '<p class="small muted">No attendance captured yet.</p>'}
    </div>`;
}

function flagFor(x) {
  if (!x.resource.is_active) return '<span class="pill grey">out of service</span>';
  if (!x.resource.is_bookable) return '<span class="pill grey">internal</span>';
  if (x.bookings === 0) return '<span class="pill pink">unused</span>';
  if (x.utilization < 10) return '<span class="pill amber">under-used</span>';
  if (x.utilization >= 70) return '<span class="pill coral">over-used</span>';
  return '<span class="pill green">healthy</span>';
}

function suggestionFor(x) {
  const cap = x.resource.capacity || 0;
  if (cap >= 60) return 'Use for large lecture / exam overflow, or close the twin room';
  if (cap >= 20) return 'Promote to students; add to the booking portal featured list';
  if (x.resource.maximum_booking_minutes && x.resource.maximum_booking_minutes <= 240) return 'Offer as bookable-by-default; retire if still idle';
  return 'Merge or repurpose; check maintenance cost';
}

export function after(root) {
  root.querySelector('#win').onchange = (e) => go('analytics', { days: e.target.value });
  root.querySelector('#csv').onclick = () => {
    const r = usageReport(store, { days: windowDays });
    downloadCsv(`resource-usage-${new Date().toISOString().slice(0, 10)}.csv`, usageCsvRows(r));
  };
  root.querySelectorAll('tr[data-res]').forEach((tr) => {
    tr.onclick = () => openResourceDetail(Number(tr.dataset.res));
  });
}
