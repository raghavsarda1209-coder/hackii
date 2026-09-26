import { store } from '../store.js';
import { esc, fmtDate, fmtDay, startOfDay, addDays, DAY, emptyState, fmtRange } from '../ui.js';
import { pageHead, dayTimeline } from './common.js';
import { openResourceDetail } from './resource-detail.js';

const state = { day: dateOnly(new Date()), building: 'all', type: 'all', onlyBookable: true };

function dateOnly(d) { return new Date(d).toLocaleDateString('sv-SE'); }   // yyyy-mm-dd

export function render() {
  const buildings = store.buildings();
  const types = store.resourceTypes();
  return `
    ${pageHead('Campus timeline', 'Every bookable asset on one day, with buffers, blackouts and maintenance in place', `
      <button class="btn btn-ghost btn-sm" id="prev">← Previous</button>
      <input id="day" type="date" value="${esc(state.day)}" style="width:auto">
      <button class="btn btn-ghost btn-sm" id="next">Next →</button>
      <button class="btn btn-teal btn-sm" id="today">Today</button>`)}

    <div class="card mb">
      <div class="row">
        <div><label class="lbl">Building</label>
          <select id="building"><option value="all">All buildings</option>
            ${buildings.map((b) => `<option value="${b.id}" ${String(state.building) === String(b.id) ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></div>
        <div><label class="lbl">Type</label>
          <select id="type"><option value="all">All types</option>
            ${types.map((t) => `<option value="${t.id}" ${String(state.type) === String(t.id) ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div>
        <div style="flex:0 0 auto;align-self:flex-end">
          <span class="inline-check"><input type="checkbox" id="onlyBookable" ${state.onlyBookable ? 'checked' : ''}> Bookable only</span></div>
      </div>
    </div>

    <div id="body"></div>`;
}

export function after(root) {
  const body = root.querySelector('#body');
  const dstate = { ...state };

  function paint() {
    const when = new Date(`${dstate.day}T00:00:00`);
    let list = store.resources({ includeInactive: !dstate.onlyBookable });
    if (dstate.building !== 'all') list = list.filter((r) => r.building_id === Number(dstate.building));
    if (dstate.type !== 'all') list = list.filter((r) => r.resource_type_id === Number(dstate.type));

    const dayBookings = (store.db.bookings || []).filter((b) =>
      ['pending', 'approved', 'completed'].includes(b.status_code) &&
      new Date(b.start_time).toDateString() === when.toDateString());
    const busyMinutes = dayBookings.reduce((sum, b) => {
      const r0 = store.resourcesOfBooking(b.id)[0];
      return sum + (new Date(b.end_time) - new Date(b.start_time)) / 60000 * (1 + (r0?.buffer_before_minutes || 0) / 60);
    }, 0);

    body.innerHTML = `
      <div class="grid g4 mb">
        <div class="stat"><div class="k">Date</div><div class="v" style="font-size:1.1rem">${esc(fmtDay(when))}</div><div class="s">${esc(fmtDate(when))}</div></div>
        <div class="stat g"><div class="k">Bookings</div><div class="v">${dayBookings.length}</div><div class="s">held or completed</div></div>
        <div class="stat t"><div class="k">Resources shown</div><div class="v">${list.length}</div><div class="s">of ${store.resources().length} active</div></div>
        <div class="stat a"><div class="k">Booked time</div><div class="v">${(busyMinutes / 60).toFixed(1)}h</div><div class="s">across all assets</div></div>
      </div>
      <div class="card mb">
        <div class="card-head"><h2>${list.length} resource${list.length === 1 ? '' : 's'}</h2><div class="spacer"></div>
          <span class="small muted">06:00 – 23:00 · amber = pending, striped = turnaround buffer</span></div>
        ${list.length ? dayTimeline(list.map((r) => r.id), when) : emptyState('📭', 'No resources match the filters')}
      </div>
      <div class="card">
        <div class="card-head"><h2>Bookings on this day</h2></div>
        ${dayBookings.length ? `<div class="table-wrap"><table class="tbl">
          <thead><tr><th>Time</th><th>Booking</th><th>Resource</th><th>Requester</th><th>Status</th></tr></thead>
          <tbody>${dayBookings.sort((a, b) => new Date(a.start_time) - new Date(b.start_time)).map((b) => {
            const dec = store.decorate(b);
            return `<tr data-res="${dec.resources[0]?.id || ''}" style="cursor:pointer">
              <td class="small nowrap">${esc(new Date(b.start_time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }))}–${esc(new Date(b.end_time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }))}</td>
              <td><b>${esc(dec.title)}</b><div class="small muted mono">${esc(dec.booking_reference)}</div></td>
              <td class="small">${esc(dec.resources.map((r) => r.name).join(', '))}</td>
              <td class="small">${esc(dec.requester_name)}</td>
              <td class="small">${esc(dec.status_code)}</td></tr>`;
          }).join('')}</tbody></table></div>` : emptyState('🌤️', 'Nothing booked on this day')}
      </div>`;

    body.querySelectorAll('tr[data-res]').forEach((tr) => {
      tr.onclick = () => { if (tr.dataset.res) openResourceDetail(Number(tr.dataset.res)); };
    });
  }

  const shift = (days) => {
    const d = new Date(`${dstate.day}T00:00:00`);
    d.setDate(d.getDate() + days);
    dstate.day = dateOnly(d);
    root.querySelector('#day').value = dstate.day;
    paint();
  };
  root.querySelector('#prev').onclick = () => shift(-1);
  root.querySelector('#next').onclick = () => shift(1);
  root.querySelector('#today').onclick = () => { dstate.day = dateOnly(new Date()); root.querySelector('#day').value = dstate.day; paint(); };
  root.querySelector('#day').onchange = (e) => { dstate.day = e.target.value; paint(); };
  root.querySelector('#building').onchange = (e) => { dstate.building = e.target.value; paint(); };
  root.querySelector('#type').onchange = (e) => { dstate.type = e.target.value; paint(); };
  root.querySelector('#onlyBookable').onchange = (e) => { dstate.onlyBookable = e.target.checked; paint(); };

  paint();
}
