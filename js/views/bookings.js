import { store } from '../store.js';
import { usageReport } from '../analytics.js';
import {
  esc, toast, openModal, confirmDialog, promptDialog, fmtRange, fmtDate, fmtTime,
  fmtDuration, statusPill, emptyState, debounce, downloadCsv, fmtAgo,
} from '../ui.js';
import { pageHead, bookingRow, initials } from './common.js';
import { evaluateBooking, renderFindings } from '../conflicts.js';
import { go, refresh } from '../router.js';
import { STATUS } from '../config.js';

const ui = { scope: 'mine', status: 'all', q: '', from: '', to: '' };

export function render(params) {
  if (params.scope) ui.scope = params.scope;
  if (!['mine', 'approvals', 'all'].includes(ui.scope)) ui.scope = 'mine';
  const title = ui.scope === 'mine' ? 'My bookings'
    : ui.scope === 'approvals' ? 'Approval queue' : 'All campus bookings';
  const sub = ui.scope === 'mine'
    ? 'Everything you have requested, including history'
    : ui.scope === 'approvals' ? 'Pending requests that hold a slot until decided'
      : 'System-wide view for approvers and administrators';

  const counts = {
    all: store.db.bookings.length,
    pending: store.db.bookings.filter((b) => b.status_code === 'pending').length,
    approved: store.db.bookings.filter((b) => b.status_code === 'approved').length,
    completed: store.db.bookings.filter((b) => b.status_code === 'completed').length,
    rejected: store.db.bookings.filter((b) => b.status_code === 'rejected').length,
    cancelled: store.db.bookings.filter((b) => b.status_code === 'cancelled').length,
  };

  return `
    ${pageHead(title, sub, `
      <button class="btn btn-ghost btn-sm" id="csv">⤓ Export CSV</button>
      <button class="btn btn-primary btn-sm" data-nav="new-booking">+ New booking</button>`)}

    <div class="card mb">
      <div class="flex mb">
        ${[['mine', 'Mine'], ['approvals', 'Needs approval'], ['all', 'Everything']].map(([k, l]) =>
          `<button class="chip ${ui.scope === k ? 'on' : ''}" data-scope="${k}">${l}</button>`).join('')}
      </div>
      <div class="row">
        <div><label class="lbl">Status</label>
          <select id="fStatus">
            <option value="all">All statuses</option>
            ${['pending', 'approved', 'completed', 'rejected', 'cancelled'].map((s) =>
              `<option value="${s}" ${ui.status === s ? 'selected' : ''}>${s} (${counts[s]})</option>`).join('')}
          </select></div>
        <div><label class="lbl">From</label><input id="fFrom" type="date" value="${esc(ui.from)}"></div>
        <div><label class="lbl">To</label><input id="fTo" type="date" value="${esc(ui.to)}"></div>
        <div><label class="lbl">Search</label><input id="fQ" value="${esc(ui.q)}" placeholder="reference, title, person, resource"></div>
      </div>
      <div class="flex between">
        <span class="small muted" id="count"></span>
        <button class="btn btn-ghost btn-sm" id="reset">Reset</button>
      </div>
    </div>

    <div class="card pad-0"><div class="table-wrap" id="tbl"></div></div>`;
}

export function after(root) {
  const tbl = root.querySelector('#tbl');
  const count = root.querySelector('#count');

  function list() {
    let out = store.myBookings({ scope: ui.scope === 'approvals' ? 'approvals' : ui.scope });
    if (ui.status !== 'all') out = out.filter((b) => b.status_code === ui.status);
    if (ui.from) out = out.filter((b) => new Date(b.start_time) >= new Date(`${ui.from}T00:00:00`));
    if (ui.to) out = out.filter((b) => new Date(b.start_time) <= new Date(`${ui.to}T23:59:59`));
    if (ui.q) {
      const q = ui.q.toLowerCase();
      out = out.filter((b) => `${b.booking_reference} ${b.title} ${b.requester_name} ${b.purpose} ${b.resources.map((r) => r.name).join(' ')}`
        .toLowerCase().includes(q));
    }
    return out.sort((a, b) => {
      const ka = ['pending', 'approved', 'completed', 'rejected', 'cancelled'].indexOf(a.status_code);
      const kb = ['pending', 'approved', 'completed', 'rejected', 'cancelled'].indexOf(b.status_code);
      if (ka !== kb) return ka - kb;
      return new Date(a.start_time) - new Date(b.start_time);
    });
  }

  function paint() {
    const rows = list();
    count.textContent = `${rows.length} booking${rows.length === 1 ? '' : 's'}`;
    if (!rows.length) {
      tbl.innerHTML = emptyState('🗂', 'No bookings match', 'Adjust the filters or raise a new request.');
      return;
    }
    tbl.innerHTML = `<table class="tbl">
      <thead><tr>
        <th>Request</th><th>Resource</th><th>When</th><th>Requester</th>
        <th class="num">#</th><th>Status</th><th></th>
      </tr></thead>
      <tbody>${rows.map((b) => bookingRow(b, { approve: store.isApprover() })).join('')}</tbody>
    </table>`;
    tbl.querySelectorAll('tr[data-booking]').forEach((tr) => {
      tr.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        openDetail(Number(tr.dataset.booking));
      });
    });
    tbl.querySelectorAll('[data-approve]').forEach((btn) => { btn.onclick = () => decide(Number(btn.dataset.approve), 'approved'); });
    tbl.querySelectorAll('[data-reject]').forEach((btn) => { btn.onclick = () => decide(Number(btn.dataset.reject), 'rejected'); });
    tbl.querySelectorAll('[data-cancel]').forEach((btn) => { btn.onclick = () => cancel(Number(btn.dataset.cancel)); });
    tbl.querySelectorAll('[data-view]').forEach((btn) => { btn.onclick = () => openDetail(Number(btn.dataset.view)); });
  }

  root.querySelectorAll('[data-scope]').forEach((c) => {
    c.onclick = () => { ui.scope = c.dataset.scope; go(c.dataset.scope === 'mine' ? 'my-bookings' : c.dataset.scope === 'approvals' ? 'approvals' : 'all-bookings'); };
  });
  const bindFilter = (sel, key, evt = 'change') => {
    const n = root.querySelector(sel);
    n.addEventListener(evt, () => { ui[key] = n.value; paint(); });
  };
  bindFilter('#fStatus', 'status');
  bindFilter('#fFrom', 'from');
  bindFilter('#fTo', 'to');
  root.querySelector('#fQ').addEventListener('input', debounce((e) => { ui.q = e.target.value; paint(); }, 200));
  root.querySelector('#reset').onclick = () => { Object.assign(ui, { status: 'all', from: '', to: '', q: '' }); refresh(); };
  root.querySelector('#csv').onclick = () => {
    const rows = list();
    if (!rows.length) { toast('Nothing to export', 'warn'); return; }
    downloadCsv(`bookings-${new Date().toISOString().slice(0, 10)}.csv`, [
      ['Reference', 'Title', 'Purpose', 'Resource(s)', 'Start', 'End', 'Duration (min)', 'Requester', 'Department', 'Attendees', 'Status', 'Created', 'Approved at', 'Rejection / cancellation'],
      ...rows.map((b) => [b.booking_reference, b.title, b.purpose || '', b.resources.map((r) => r.name).join(' | '),
        b.start_time, b.end_time, Math.round(b.duration_ms / 60000), b.requester_name, b.department || '',
        b.attendee_count || '', b.status_code, b.created_at, b.approved_at || '', b.rejection_reason || b.cancellation_reason || '']),
    ]);
    toast('CSV downloaded');
  };

  paint();
}

// ------------------------------------------------------------- actions ----
async function decide(bookingId, action) {
  const b = store.decorate(store.db.bookings.find((x) => x.id === bookingId));
  if (!b) return;
  if (action === 'approved') {
    // Approving must not create a double booking: re-verify against every resource.
    const check = evaluateBooking(store, {
      resourceIds: b.resources.map((r) => r.id), start: b.start_time, end: b.end_time,
      excludeBookingId: b.id, attendeeCount: b.attendee_count, title: b.title,
    });
    if (!check.ok) {
      const blocks = check.findings.filter((f) => f.level === 'block');
      openModal({
        title: 'Cannot approve — conflict detected',
        body: `<div class="banner err"><span>⛔</span><span>Approving would create a double booking. The request must be rescheduled or rejected.</span></div>${renderFindings(blocks)}`,
        footer: '<button class="btn btn-ghost" data-x>Close</button>',
      }).footer.querySelector('[data-x]').onclick = () => document.querySelector('.overlay').remove();
      await store.log('booking.approval_blocked', 'booking', String(bookingId), null, { reason: blocks[0]?.code });
      return;
    }
    const ok = await confirmDialog('Approve booking',
      `${b.booking_reference} · "${b.title}"\n${b.resources.map((r) => r.name).join(', ')}\n${fmtRange(b.start_time, b.end_time)}`,
      'Approve', 'green');
    if (!ok) return;
    try {
      await store.decideBooking(b.id, 'approved', 'Approved after conflict screening.');
      toast('Booking approved', 'ok', `${b.booking_reference} is now reserved.`);
      refresh();
    } catch (e) { toast('Could not approve', 'err', e.message); }
  } else {
    const reason = await promptDialog('Reject booking', 'Reason shown to the requester', 'Not available for this activity.', { placeholder: 'Why is this rejected?' });
    if (!reason) return;
    try {
      await store.decideBooking(b.id, 'rejected', reason);
      toast('Booking rejected', 'info', 'The slot is released back to the pool.');
      refresh();
    } catch (e) { toast('Could not reject', 'err', e.message); }
  }
}

async function cancel(bookingId) {
  const b = store.decorate(store.db.bookings.find((x) => x.id === bookingId));
  if (!b) return;
  const reason = await promptDialog('Cancel booking', 'Reason', 'No longer required.', { placeholder: 'Cancellation reason' });
  if (reason === null) return;
  try {
    await store.cancelBooking(b.id, reason);
    toast('Booking cancelled', 'info', 'The slot is available again.');
    refresh();
  } catch (e) { toast('Could not cancel', 'err', e.message); }
}

// -------------------------------------------------------- detail modal ----
export function openDetail(bookingId) {
  const b = store.decorate((store.db.bookings || []).find((x) => x.id === Number(bookingId)));
  if (!b) return;
  const attendees = store.attendeesFor(b.id);
  const mine = b.requested_by === store.user?.id;
  const past = new Date(b.end_time) < new Date();

  const body = `
    <div class="flex between mb">
      <div class="flex">
        <span class="avatar ${b.status_code === 'pending' ? 'c' : 'g'}">${esc(initials(b.requester_name))}</span>
        <div>
          <b style="font-size:1.05rem">${esc(b.title)}</b>
          <div class="small muted mono">${esc(b.booking_reference)} · raised ${esc(fmtAgo(b.created_at))}</div>
        </div>
      </div>
      ${statusPill(b.status_code)}
    </div>

    <div class="grid g2 mb">
      <div><div class="lbl">When</div><b>${esc(fmtDate(b.start_time))}</b><div class="small">${esc(fmtTime(b.start_time))} – ${esc(fmtTime(b.end_time))} (${esc(fmtDuration(b.duration_ms))})</div></div>
      <div><div class="lbl">Requester</div><b>${esc(b.requester_name)}</b><div class="small muted">${esc(b.department || '')}${b.requester_email ? ` · ${esc(b.requester_email)}` : ''}</div></div>
    </div>

    <div class="lbl">Resources</div>
    ${b.resources.map((r) => `<div class="flex between" style="padding:6px 0;border-bottom:1px solid var(--line)">
      <div><b>${esc(r.name)}</b><div class="small muted">${esc(r.code)} · ${r.capacity ? `${r.capacity} seats` : 'no cap'} · ${r.requires_approval ? 'approval required' : 'instant'}</div></div>
      <span class="pill ${r.in_use ? 'coral' : 'green'}">${r.in_use ? 'in use' : 'not in use'}</span>
    </div>`).join('')}

    <div class="grid g2 mt">
      <div><div class="lbl">Purpose</div><div>${esc(b.purpose || '—')}</div></div>
      <div><div class="lbl">Expected attendees</div><div>${b.attendee_count || '—'}</div></div>
    </div>
    ${b.description ? `<div class="mt"><div class="lbl">Notes for approver</div><div class="small">${esc(b.description)}</div></div>` : ''}
    ${b.special_requirements ? `<div class="mt"><div class="lbl">Special requirements</div><div class="small">${esc(b.special_requirements)}</div></div>` : ''}
    ${b.rejection_reason ? `<div class="banner err mt"><span>✖</span><span>${esc(b.rejection_reason)}</span></div>` : ''}
    ${b.cancellation_reason ? `<div class="banner warn mt"><span>⊘</span><span>${esc(b.cancellation_reason)}</span></div>` : ''}

    <h3 class="mt mb">Decision history</h3>
    ${b.approvals.length ? `<div class="table-wrap"><table class="tbl">
      <thead><tr><th>Action</th><th>Approver</th><th>When</th><th>Comment</th></tr></thead>
      <tbody>${b.approvals.map((a) => `<tr>
        <td><span class="pill ${a.action === 'approved' ? 'green' : a.action === 'rejected' ? 'coral' : 'grey'}">${esc(a.action)}</span></td>
        <td class="small">${esc(store.displayName(store.profileById(a.approver_id)))}</td>
        <td class="small nowrap">${esc(fmtAgo(a.created_at))}</td>
        <td class="small muted">${esc(a.comments || '—')}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="small muted">No decisions recorded.</p>'}

    <h3 class="mt mb">Attendees (${attendees.length})</h3>
    ${attendees.length ? `<div class="chips">${attendees.map((a) => {
      const p = a.profile_id ? store.profileById(a.profile_id) : null;
      const cls = { attended: 'green', absent: 'coral', declined: 'grey', accepted: 'teal', invited: 'amber' }[a.attendance_status] || 'grey';
      return `<span class="pill ${cls}" data-att="${a.id}" ${a.attendance_status !== 'attended' ? 'style="cursor:pointer"' : ''}>
        ${esc(p ? store.displayName(p) : a.external_name || a.external_email)}${a.attendance_status !== 'invited' ? ` · ${a.attendance_status}` : ''}</span>`;
    }).join('')}</div>` : '<p class="small muted">No attendee list captured.</p>'}`;

  const acts = [];
  if (store.isApprover() && b.status_code === 'pending') {
    acts.push('<button class="btn btn-coral" data-a="reject">Reject</button>');
    acts.push('<button class="btn btn-green" data-a="approve">Approve</button>');
  }
  if (['pending', 'approved'].includes(b.status_code) && (mine || store.isAdmin()) && !past) {
    acts.push('<button class="btn btn-ghost" data-a="cancel">Cancel</button>');
  }
  const modal = openModal({
    title: `Booking ${b.booking_reference}`,
    body, wide: true,
    footer: `<button class="btn btn-ghost" data-x>Close</button>${acts.join('')}`,
  });
  modal.footer.querySelector('[data-x]').onclick = modal.close;
  modal.footer.querySelectorAll('[data-a]').forEach((btn) => {
    btn.onclick = () => { modal.close(); decide(b.id, btn.dataset.a); };
  });
  modal.modal.querySelectorAll('[data-att]').forEach((p) => {
    p.onclick = async () => {
      const id = Number(p.dataset.att);
      const a = store.db.booking_attendees.find((x) => x.id === id);
      const next = a.attendance_status === 'attended' ? 'absent' : 'attended';
      await store.setAttendeeStatus(id, next);
      toast(`Marked ${next}`);
      modal.close();
      openDetail(b.id);
    };
  });
}
