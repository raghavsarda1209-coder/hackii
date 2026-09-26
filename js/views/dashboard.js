import { store } from '../store.js';
import { usageReport, insights } from '../analytics.js';
import { esc, fmtHours, fmtDuration, fmtRange, fmtDay, statusPill, emptyState, toast, addDays, startOfDay } from '../ui.js';
import { pageHead, statTile, bookingRow, dayTimeline, resourceCard } from './common.js';
import { go } from '../router.js';

export function render(root) {
  const report = usageReport(store, { days: 30 });
  const s = report.summary;
  const notes = insights(report);
  const myUpcoming = store.myBookings({ scope: 'mine' })
    .filter((b) => b.end_time && new Date(b.end_time) > new Date() && ['pending', 'approved'].includes(b.status_code))
    .sort((a, b) => new Date(a.start_time) - new Date(b.start_time))
    .slice(0, 5);
  const needsMe = store.isApprover() ? store.myBookings({ scope: 'approvals' }).slice(0, 5) : [];

  root.innerHTML = `
    ${pageHead(`Hello, ${esc(store.myName().split(' ')[0])}`,
      `${new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · ${store.isApprover() ? 'Approver' : 'Requester'} view`,
      `<button class="btn btn-ghost btn-sm" data-nav="resources">Browse</button>
       <button class="btn btn-primary btn-sm" data-nav="new-booking">+ New booking</button>`)}

    <div class="grid g4 mb">
      ${statTile('', 'My active bookings', String(store.myBookings({ scope: 'mine' }).filter((b) => ['pending', 'approved'].includes(b.status_code)).length), 'pending + approved')}
      ${statTile('g', 'Campus utilisation', `${s.utilisation.toFixed(0)}%`, `${fmtHours(s.bookedHours * 3600000)} booked of ${fmtHours(s.capacityHours * 3600000)}`)}
      ${statTile('t', 'Bookings today', String(report.todayBookings.length), `${s.totalHeadcount} expected attendees`)}
      ${statTile('c', 'Conflicts prevented', String(s.conflictsPrevented), 'double-bookings blocked')}
      ${statTile('a', 'Unused resources', String(s.unusedCount), `of ${s.bookableCount} bookable`)}
      ${statTile('p', 'Pending approvals', String(store.pendingApprovalCount()), store.isApprover() ? 'waiting on you/others' : 'awaiting approver')}
      ${statTile('g', 'No-show rate', `${s.noShowRate.toFixed(0)}%`, `${s.attendanceRate.toFixed(0)}% attendance recorded`)}
      ${statTile('c', 'Avg approval time', fmtDuration(s.avgTurnaround), `${s.cancellationRate.toFixed(0)}% cancelled`)}
    </div>

    <div class="split">
      <div>
        <div class="card mb">
          <div class="card-head"><h2>Today across campus</h2><div class="spacer"></div>
            <button class="btn btn-ghost btn-sm" data-nav="resources">Find a free slot →</button></div>
          ${report.todayBookings.length ? dayTimeline(
            [...new Set(report.todayBookings.flatMap((b) => b.resources.map((r) => r.id)))].slice(0, 12),
            new Date(),
          ) : emptyState('🌤️', 'Nothing booked today', 'A rare quiet day on the campus.')}
        </div>

        ${needsMe.length ? `<div class="card mb">
          <div class="card-head"><h2>Waiting for your approval</h2><div class="spacer"></div>
            <button class="btn btn-green btn-sm" data-nav="approvals">Review all</button></div>
          <div class="table-wrap"><table class="tbl">
            <thead><tr><th>Request</th><th>Resource</th><th>When</th><th>Requester</th><th>#</th><th>Status</th><th></th></tr></thead>
            <tbody>${needsMe.map((b) => bookingRow(b, { approve: true })).join('')}</tbody>
          </table></div>
        </div>` : ''}

        <div class="card mb">
          <div class="card-head"><h2>My upcoming</h2><div class="spacer"></div>
            <button class="btn btn-ghost btn-sm" data-nav="my-bookings">All my bookings</button></div>
          ${myUpcoming.length ? `<div class="table-wrap"><table class="tbl">
            <thead><tr><th>Request</th><th>Resource</th><th>When</th><th>Requester</th><th>#</th><th>Status</th><th></th></tr></thead>
            <tbody>${myUpcoming.map((b) => bookingRow(b)).join('')}</tbody></table></div>`
            : emptyState('📭', 'No upcoming bookings', 'Reserve a room, lab or facility to get started.')}
        </div>

        <div class="card">
          <div class="card-head"><h2>Most used resources (30 days)</h2><div class="spacer"></div>
            <button class="btn btn-ghost btn-sm" data-nav="analytics">Full analytics →</button></div>
          ${report.perResource.slice(0, 6).map((x) => `
            <div class="bar-row">
              <div class="n" title="${esc(x.resource.name)}">${esc(x.resource.name)}</div>
              <div class="bar-track g"><i style="width:${Math.max(1.5, x.utilization).toFixed(1)}%"></i></div>
              <div class="v">${x.utilization.toFixed(0)}%</div>
            </div>`).join('')}
        </div>
      </div>

      <div>
        <div class="card mb">
          <h2 class="mb">Signals</h2>
          ${notes.map((n) => `<div class="banner ${n.tone}"><span>${n.icon}</span><span>${esc(n.text)}</span></div>`).join('')
            || '<div class="banner ok"><span>✅</span><span>Everything looks healthy.</span></div>'}
        </div>

        <div class="card mb">
          <h2 class="mb">Booking outcomes</h2>
          <div class="donut" style="background:conic-gradient(var(--green) 0 62%, var(--amber) 62% 82%, var(--coral) 82% 92%, #e6ddd3 92% 100%)">
            <div><div class="v">${s.totalBookings}</div><div class="k">requests</div></div>
          </div>
          <div class="mt">
            ${[['green', 'Approved / held', report.statusBuckets.approved + report.statusBuckets.completed + report.statusBuckets.pending],
               ['amber', 'Pending', report.statusBuckets.pending],
               ['coral', 'Rejected', report.statusBuckets.rejected],
               ['grey', 'Cancelled', report.statusBuckets.cancelled]].map(([c, l, v]) =>
              `<div class="flex between small" style="padding:2px 0"><span><span class="dot ${c === 'green' ? 'ok' : c === 'amber' ? 'mid' : 'no'}"></span> ${esc(l)}</span><b>${v}</b></div>`).join('')}
          </div>
        </div>

        <div class="card">
          <h2 class="mb">Quick actions</h2>
          <div class="grid" style="gap:7px">
            <button class="btn btn-primary btn-block" data-nav="new-booking">+ Book a resource</button>
            <button class="btn btn-teal btn-block" data-nav="find-slot">🔍 Find a free slot</button>
            <button class="btn btn-ghost btn-block" data-nav="timeline">🗓 Campus timeline</button>
            ${store.isApprover() ? '<button class="btn btn-ghost btn-block" data-nav="approvals">✅ Approval queue</button>' : ''}
            <button class="btn btn-ghost btn-block" data-nav="analytics">📈 Usage &amp; unused assets</button>
          </div>
        </div>
      </div>
    </div>`;
}
