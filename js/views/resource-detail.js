import { store } from '../store.js';
import { usageReport } from '../analytics.js';
import {
  esc, openModal, toast, fmtRange, fmtDate, fmtTime, fmtDuration, fmtAgo,
  dateToDtLocal, confirmDialog, promptDialog, emptyState, startOfDay, addDays, DAY,
} from '../ui.js';
import { dayTimeline, availabilitySummary, initials } from './common.js';
import { suggestSlots, evaluateBooking, renderFindings } from '../conflicts.js';
import { go } from '../router.js';

/** Full resource detail: live timeline, rules, bookings, maintenance. */
export function openResourceDetail(resourceId, opts = {}) {
  const r = store.resourceById(resourceId);
  if (!r) return;
  const decorated = store.resources().find((x) => x.id === r.id) || r;
  const report = usageReport(store, { days: 30 });
  const m = report.perResource.find((x) => x.resource.id === r.id);
  const history = store.bookingsFor(r.id).slice().reverse();
  const blackouts = store.blackoutsFor(r.id).slice().sort((a, b) => new Date(b.start_time) - new Date(a.start_time));
  const maint = store.maintenanceFor(r.id).slice().sort((a, b) => new Date(b.start_time) - new Date(a.start_time));
  const canAdmin = store.isManager();

  const body = `
    <div class="grid g3 mb">
      <div><div class="lbl">Type</div><b>${esc(decorated.type_name)}</b></div>
      <div><div class="lbl">Location</div><b>${esc(decorated.building_name || '—')}${decorated.floor_label ? ` · ${esc(decorated.floor_label)}` : ''}</b></div>
      <div><div class="lbl">Capacity</div><b>${r.capacity ? `${r.capacity} people` : '—'}</b></div>
      <div><div class="lbl">Min / max duration</div><b>${r.minimum_booking_minutes}m${r.maximum_booking_minutes ? ` / ${r.maximum_booking_minutes}m` : ' / —'}</b></div>
      <div><div class="lbl">Turnaround buffer</div><b>${r.buffer_before_minutes}m before · ${r.buffer_after_minutes}m after</b></div>
      <div><div class="lbl">Approval</div><b>${r.requires_approval ? 'Approver required' : 'Instant confirmation'}</b></div>
    </div>

    <div class="banner info"><span>🕒</span><span><b>Published hours:</b> ${esc(availabilitySummary(r.id))}</span></div>

    ${decorated.features.length ? `<div class="chips mb">${decorated.features.map((f) => `<span class="pill">${esc(f)}</span>`).join('')}</div>` : ''}

    ${m ? `<div class="mb">
      <div class="flex between small"><b>30-day utilisation ${m.utilization.toFixed(1)}%</b><span class="muted">${m.bookings} bookings · ${m.upcoming} upcoming</span></div>
      <div class="util-bar mt"><i style="width:${Math.max(2, m.utilization).toFixed(1)}%"></i></div>
    </div>` : ''}

    <h3 class="mb">Today</h3>
    ${dayTimeline([r.id], new Date())}

    <h3 class="mt mb">Next 7 days</h3>
    <div class="scroll-x">
      <table class="tbl">
        <thead><tr><th>Date</th><th class="num">Bookings</th><th>Quietest window</th><th>Notes</th></tr></thead>
        <tbody>${next7(r).map((d) => `<tr>
          <td class="nowrap"><b>${esc(fmtDate(d.date))}</b></td>
          <td class="num">${d.count}</td>
          <td class="small">${d.quiet || '—'}</td>
          <td class="small muted">${esc(d.notes)}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>

    <h3 class="mt mb">Recent bookings on this resource</h3>
    ${history.length ? `<div class="table-wrap"><table class="tbl">
      <thead><tr><th>Booking</th><th>When</th><th>Requester</th><th>Status</th></tr></thead>
      <tbody>${history.slice(0, 8).map((b) => {
        const d = store.decorate(b);
        return `<tr><td><b>${esc(d.title)}</b><div class="small muted mono">${esc(d.booking_reference)}</div></td>
          <td class="small nowrap">${esc(fmtRange(b.start_time, b.end_time))}</td>
          <td class="small">${esc(d.requester_name)}</td><td class="small">${esc(d.status_code)}</td></tr>`;
      }).join('')}</tbody></table></div>` : '<p class="muted small">No bookings on record — this asset is idle.</p>'}

    ${maint.length ? `<h3 class="mt mb">Maintenance</h3>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Work</th><th>When</th><th>Status</th><th></th></tr></thead>
        <tbody>${maint.slice(0, 6).map((x) => `<tr>
          <td><b>${esc(x.title)}</b></td>
          <td class="small nowrap">${esc(fmtRange(x.start_time, x.end_time || x.start_time))}</td>
          <td><span class="pill ${x.status === 'completed' ? 'green' : x.status === 'in_progress' ? 'amber' : 'coral'}">${esc(x.status.replace('_', ' '))}</span></td>
          <td>${canAdmin ? `<div class="rowacts">
            ${x.status !== 'completed' ? `<button class="btn btn-ghost btn-sm" data-maint-done="${x.id}">Mark done</button>` : ''}
            ${x.status !== 'cancelled' ? `<button class="btn btn-ghost btn-sm" data-maint-cancel="${x.id}">Cancel</button>` : ''}
          </div>` : ''}</td></tr>`).join('')}</tbody></table></div>` : ''}

    ${canAdmin ? `<h3 class="mt mb">Blackouts</h3>
      ${blackouts.length ? `<div class="table-wrap"><table class="tbl">
        <thead><tr><th>Reason</th><th>When</th><th></th></tr></thead>
        <tbody>${blackouts.slice(0, 6).map((b) => `<tr>
          <td>${esc(b.reason)}</td>
          <td class="small nowrap">${esc(fmtRange(b.start_time, b.end_time))}</td>
          <td><button class="btn btn-ghost btn-sm" data-blackout-del="${b.id}">Remove</button></td>
        </tr>`).join('')}</tbody></table></div>` : '<p class="muted small">No blackouts recorded.</p>'}
      <div class="flex mt">
        <button class="btn btn-amber btn-sm" data-add-blackout="${r.id}">+ Add blackout</button>
        <button class="btn btn-amber btn-sm" data-add-maint="${r.id}">+ Schedule maintenance</button>
      </div>` : ''}
  `;

  const footer = `<button class="btn btn-ghost" data-x>Close</button>
    <button class="btn btn-teal" data-suggest>Suggest free slots</button>
    <button class="btn btn-primary" data-book>Book this resource</button>`;

  const modal = openModal({ title: `${r.name}`, body, footer, wide: true });

  modal.footer.querySelector('[data-x]').onclick = modal.close;
  modal.footer.querySelector('[data-book]').onclick = () => { modal.close(); go('new-booking', { resource: r.id }); };
  modal.footer.querySelector('[data-suggest]').onclick = () => { modal.close(); suggestOpen(r); };

  modal.modal.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    try {
      if (t.dataset.addBlackout) await addBlackout(Number(t.dataset.addBlackout));
      if (t.dataset.addMaint) await addMaintenance(Number(t.dataset.addMaint));
      if (t.dataset.blackoutDel) {
        if (await confirmDialog('Remove blackout', 'This frees the blocked window for bookings.', 'Remove', 'coral')) {
          await store.removeBlackout(Number(t.dataset.blackoutDel)); toast('Blackout removed'); modal.close(); openResourceDetail(r.id, opts);
        }
      }
      if (t.dataset.maintDone) { await store.updateMaintenanceStatus(Number(t.dataset.maintDone), 'completed'); toast('Marked complete'); modal.close(); openResourceDetail(r.id, opts); }
      if (t.dataset.maintCancel) { await store.updateMaintenanceStatus(Number(t.dataset.maintCancel), 'cancelled'); toast('Maintenance cancelled'); modal.close(); openResourceDetail(r.id, opts); }
    } catch (err) { toast('Action failed', 'err', err.message); }
  });
}

function next7(r) {
  const out = [];
  const start = startOfDay(new Date());
  for (let i = 0; i < 7; i++) {
    const date = new Date(start.getTime() + i * DAY);
    const wins = store.availabilityFor(r.id).filter((w) => w.day_of_week === date.getDay() && w.is_available);
    const dayBookings = store.bookingsFor(r.id).filter((b) => new Date(b.start_time).toDateString() === date.toDateString());
    const blocked = dayBookings.reduce((s, b) => s + (new Date(b.end_time) - new Date(b.start_time)), 0);
    const open = wins.reduce((s, w) => s + 60 * (Number(w.end_time.slice(0, 2)) - Number(w.start_time.slice(0, 2))), 0);
    const free = open - blocked / 3600000;
    const notes = [];
    if (!wins.length) notes.push('closed');
    const m = store.maintenanceFor(r.id).filter((x) => x.status !== 'cancelled' && new Date(x.start_time).toDateString() === date.toDateString());
    if (m.length) notes.push(`maintenance: ${m.map((x) => x.title).join(', ')}`);
    const bl = store.blackoutsFor(r.id).filter((x) => new Date(x.start_time).toDateString() === date.toDateString());
    if (bl.length) notes.push(`blackout: ${bl.map((x) => x.reason).join(', ')}`);
    out.push({ date, count: dayBookings.length, quiet: free > 0 ? `${free.toFixed(1)}h free` : 'fully booked', notes: notes.join(' · ') || '—' });
  }
  return out;
}

async function addBlackout(resourceId) {
  const start = promptDialog('Add blackout', 'Start (YYYY-MM-DDTHH:MM)', dateToDtLocal(new Date(startOfDay(new Date()).getTime() + 12 * 3600000)));
  if (!start) return;
  const end = promptDialog('Add blackout', 'End', dateToDtLocal(new Date(new Date(start).getTime() + 3 * 3600000)));
  if (!end) return;
  const reason = promptDialog('Add blackout', 'Reason', 'Reserved for campus operations');
  if (!reason) return;
  await store.addBlackout({ resourceId, start, end, reason });
  toast('Blackout added', 'warn', 'Bookings in that window are now blocked.');
}

async function addMaintenance(resourceId) {
  const title = promptDialog('Schedule maintenance', 'Title', 'Preventive service');
  if (!title) return;
  const start = promptDialog('Schedule maintenance', 'Start', dateToDtLocal(new Date(startOfDay(addDays(new Date(), 1)).getTime() + 9 * 3600000)));
  if (!start) return;
  const end = promptDialog('Schedule maintenance', 'End', dateToDtLocal(new Date(new Date(start).getTime() + 3 * 3600000)));
  await store.addMaintenance({ resourceId, start, end, title });
  toast('Maintenance scheduled', 'warn', 'No bookings can overlap this window.');
}

/** Modal listing nearest free windows + a live conflict verdict for each. */
export function suggestOpen(resource) {
  const now = new Date();
  const base = new Date(startOfDay(now).getTime() + 13 * 3600000);
  if (base < now) base.setTime(now.getTime() + 30 * 60000);
  const dur = 60 * 60000;
  const slots = suggestSlots(store, resource, base, new Date(base.getTime() + dur), 8);
  const body = slots.length ? `<p class="small muted mb">Nearest windows of ${fmtDuration(dur)} that are free for <b>${esc(resource.name)}</b>, including its turnaround buffer:</p>
    ${slots.map((s) => {
      const res = evaluateBooking(store, { resourceIds: [resource.id], start: s.start, end: s.end });
      const ok = res.ok;
      return `<div class="flex between" style="padding:7px 0;border-bottom:1px solid var(--line)">
        <div><b>${esc(fmtRange(s.start, s.end))}</b>
          <div class="small muted">${ok ? '<span class="pill green">No conflicts</span>' : esc(res.findings.filter((f) => f.level === 'block')[0]?.title || '')}</div></div>
        <div class="rowacts">
          <button class="btn btn-ghost btn-sm" data-copy="${s.start.toISOString()}|${s.end.toISOString()}">Copy</button>
          <button class="btn btn-primary btn-sm" data-use="${s.start.toISOString()}|${s.end.toISOString()}" ${ok ? '' : 'disabled'}>Use</button>
        </div></div>`;
    }).join('')}` : emptyState('🚫', 'No free window found', 'This resource is fully booked for the next 14 days.');

  const modal = openModal({ title: `Free slots · ${resource.name}`, body, footer: '<button class="btn btn-ghost" data-x>Close</button>' });
  modal.footer.querySelector('[data-x]').onclick = modal.close;
  modal.modal.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.copy || t.dataset.use) {
      const [s, en] = t.dataset.copy.split('|');
      sessionStorage.setItem('campusbook.suggested', JSON.stringify({ resourceId: resource.id, start: s, end: en }));
      modal.close();
      if (t.dataset.use) go('new-booking', { resource: resource.id, start: s, end: en });
      else { toast('Slot copied', 'info', 'Stored for the booking form'); }
    }
  });
}
