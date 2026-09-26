import { store } from '../store.js';
import { evaluateBooking, renderFindings, suggestSlots, LEVEL } from '../conflicts.js';
import {
  esc, toast, fmtDate, fmtRange, fmtDuration, dateToDtLocal, dtLocalToDate,
  startOfDay, addDays, debounce, confirmDialog, openModal, emptyState, initials, DAY, MIN,
} from '../ui.js';
import { pageHead, dayTimeline, availabilitySummary } from './common.js';
import { suggestOpen } from './resource-detail.js';
import { go } from '../router.js';

const draft = {
  resourceIds: [],
  title: '', purpose: 'Scheduled teaching', description: '',
  attendeeCount: '', requirements: '', attendees: [],
  start: '', end: '',
};

export function render(params) {
  hydrate(params);
  const types = store.resourceTypes();
  const buildings = store.buildings();
  const resources = store.resources({ includeInactive: true });

  return `
    ${pageHead('New booking', 'Every selection is validated live against the whole campus timetable', '')}

    <div class="split">
      <div>
        <div class="stepper">
          <div class="st on"><i>1</i> What &amp; where</div>
          <div class="st on"><i>2</i> When</div>
          <div class="st on"><i>3</i> Review</div>
        </div>

        <div class="card mb">
          <h2 class="mb">1 · Resources</h2>
          <div class="row mb">
            <div>
              <label class="lbl">Type</label>
              <select id="pickType"><option value="">All types</option>
                ${types.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select>
            </div>
            <div>
              <label class="lbl">Building</label>
              <select id="pickBuilding"><option value="">All buildings</option>
                ${buildings.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select>
            </div>
            <div>
              <label class="lbl">Search</label>
              <input id="pickQ" placeholder="name or code">
            </div>
          </div>
          <div id="resPick" class="grid" style="grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:8px;max-height:290px;overflow:auto"></div>
          <div class="flex between mt">
            <span class="small muted" id="selCount"></span>
            <button class="btn btn-ghost btn-sm" id="selClear">Clear selection</button>
          </div>
        </div>

        <div class="card mb">
          <h2 class="mb">2 · When</h2>
          <div class="row">
            <div><label class="lbl">Date</label><input id="date" type="date" value="${draft.start ? draft.start.slice(0, 10) : dateToDtLocal(new Date()).slice(0, 10)}"></div>
            <div><label class="lbl">Start</label><input id="start" type="time" value="${draft.start ? draft.start.slice(11, 16) : '10:00'}"></div>
            <div><label class="lbl">End</label><input id="end" type="time" value="${draft.end ? draft.end.slice(11, 16) : '11:00'}"></div>
            <div><label class="lbl">Headcount</label><input id="head" type="number" min="1" value="${esc(draft.attendeeCount)}" placeholder="optional"></div>
          </div>
          <div class="flex">
            <button class="btn btn-ghost btn-sm" data-quick="60">+30m</button>
            <button class="btn btn-ghost btn-sm" data-quick="90">+1h</button>
            <button class="btn btn-ghost btn-sm" data-quick="120">+2h</button>
            <button class="btn btn-ghost btn-sm" data-quick="180">+3h</button>
            <button class="btn btn-ghost btn-sm" data-next-day>Next weekday</button>
            <button class="btn btn-teal btn-sm" id="btnFind">Find next free slot</button>
          </div>
          <div class="mt" id="dayPreview"></div>
        </div>

        <div class="card mb">
          <h2 class="mb">3 · Details</h2>
          <div class="field">
            <label class="lbl">Title *</label>
            <input id="title" value="${esc(draft.title)}" placeholder="e.g. Data Structures - Lecture 14">
          </div>
          <div class="row">
            <div class="field"><label class="lbl">Purpose</label>
              <select id="purpose">
                ${['Scheduled teaching', 'Extra tutorial', 'Research work', 'Student activity', 'Department meeting', 'External workshop', 'Assessment', 'Personal study']
                  .map((p) => `<option ${draft.purpose === p ? 'selected' : ''}>${p}</option>`).join('')}
              </select></div>
            <div class="field"><label class="lbl">Special requirements</label>
              <input id="req" value="${esc(draft.requirements)}" placeholder="e.g. projector + extra chairs"></div>
          </div>
          <div class="field"><label class="lbl">Notes for the approver</label>
            <textarea id="desc" placeholder="Anything the approver should know">${esc(draft.description)}</textarea></div>

          <div class="field">
            <label class="lbl">Attendees</label>
            <div class="flex">
              <select id="attProfile" style="max-width:260px">
                <option value="">Add campus member…</option>
                ${store.profiles().map((p) => `<option value="${p.id}">${esc(store.displayName(p))} (${esc(p.department || '—')})</option>`).join('')}
              </select>
              <input id="attName" placeholder="External name" style="max-width:190px">
              <input id="attEmail" placeholder="external@email" style="max-width:190px">
              <button class="btn btn-ghost btn-sm" id="addAtt">Add</button>
            </div>
            <div class="chips mt" id="attList"></div>
          </div>
        </div>
      </div>

      <div>
        <div class="card" style="position:sticky;top:78px">
          <h2 class="mb">Conflict check</h2>
          <div id="verdict"></div>
          <div id="findings" class="mt"></div>
          <div class="sep"></div>
          <div id="summary"></div>
          <label class="inline-check mt mb" id="ackWrap" style="display:none">
            <input type="checkbox" id="ack"> I understand the cautions above and still want to request this slot
          </label>
          <button class="btn btn-primary btn-block btn-lg" id="submit" disabled>Submit booking</button>
          <div class="small muted mt" id="submitHint"></div>
        </div>
      </div>
    </div>`;
}

function hydrate(params) {
  if (params.resource && !draft.resourceIds.includes(Number(params.resource))) {
    draft.resourceIds = [Number(params.resource)];
  }
  if (params.start && params.end) {
    draft.start = params.start; draft.end = params.end;
  }
  const s = sessionStorage.getItem('campusbook.suggested');
  if (s) {
    try {
      const d = JSON.parse(s);
      if (d && d.resourceId && !draft.resourceIds.includes(d.resourceId)) draft.resourceIds.push(d.resourceId);
      if (d.start) { draft.start = d.start; draft.end = d.end; }
      sessionStorage.removeItem('campusbook.suggested');
    } catch { /* ignore */ }
  }
}

export function after(root) {
  const $ = (s) => root.querySelector(s);
  const verdict = $('#verdict'), findings = $('#findings'), summary = $('#summary');
  const submit = $('#submit'), hint = $('#submitHint'), ack = $('#ack'), ackWrap = $('#ackWrap');
  const resPick = $('#resPick'), selCount = $('#selCount');

  const dateStr = () => $('#date').value;
  const startDate = () => new Date(`${dateStr()}T${$('#start').value || '00:00'}`);
  const endDate = () => new Date(`${dateStr()}T${$('#end').value || '00:00'}`);

  // ---------------------------------------------------- resource picker --
  let filters = { type: '', building: '', q: '' };
  function paintPicker() {
    let list = store.resources({ includeInactive: false });
    if (filters.type) list = list.filter((r) => r.resource_type_id === Number(filters.type));
    if (filters.building) list = list.filter((r) => r.building_id === Number(filters.building));
    if (filters.q) {
      const q = filters.q.toLowerCase();
      list = list.filter((r) => `${r.name} ${r.code} ${r.type_name}`.toLowerCase().includes(q));
    }
    resPick.innerHTML = list.length ? list.map((r) => {
      const on = draft.resourceIds.includes(r.id);
      const capOk = !draft.attendeeCount || !r.capacity || Number(draft.attendeeCount) <= r.capacity;
      return `<label class="demo-user" style="cursor:pointer;${on ? 'border-color:var(--orange);background:var(--orange-l)' : ''}">
        <input type="checkbox" data-res="${r.id}" ${on ? 'checked' : ''} style="flex:0 0 auto">
        <div style="min-width:0">
          <div class="t">${esc(r.name)}</div>
          <div class="s">${esc(r.type_name)} · ${r.capacity ? `${r.capacity} seats` : 'no cap'} · ${r.requires_approval ? 'approval' : 'instant'}</div>
          ${!capOk ? '<div class="small" style="color:var(--coral);font-weight:800">Too small for your headcount</div>' : ''}
        </div></label>`;
    }).join('') : emptyState('🔍', 'No resources match');

    resPick.querySelectorAll('input[data-res]').forEach((cb) => {
      cb.onchange = () => {
        const id = Number(cb.dataset.res);
        if (cb.checked) draft.resourceIds.push(id);
        else draft.resourceIds = draft.resourceIds.filter((x) => x !== id);
        paintPicker();
        revalidate();
      };
    });
    selCount.textContent = draft.resourceIds.length
      ? `${draft.resourceIds.length} selected: ${draft.resourceIds.map((id) => esc(store.resourceName(id))).join(', ')}`
      : 'Nothing selected yet';
  }

  $('#pickType').onchange = (e) => { filters.type = e.target.value; paintPicker(); };
  $('#pickBuilding').onchange = (e) => { filters.building = e.target.value; paintPicker(); };
  $('#pickQ').oninput = debounce((e) => { filters.q = e.target.value; paintPicker(); }, 150);
  $('#selClear').onclick = () => { draft.resourceIds = []; paintPicker(); revalidate(); };

  // ------------------------------------------------------------- inputs --
  const bind = (sel, key, evt = 'input') => {
    const n = $(sel);
    n.addEventListener(evt, () => { draft[key] = n.value; revalidate(); });
  };
  bind('#title', 'title'); bind('#req', 'requirements'); bind('#desc', 'description'); bind('#head', 'attendeeCount');
  bind('#start', 'start'); bind('#end', 'end');
  $('#date').onchange = () => { revalidate(); paintPreview(); };
  $('#purpose').onchange = (e) => { draft.purpose = e.target.value; };

  root.querySelectorAll('[data-quick]').forEach((b) => {
    b.onclick = () => {
      const s = startDate();
      if (Number.isNaN(+s)) return;
      const e = new Date(endDate().getTime() + Number(b.dataset.quick) * MIN);
      $('#end').value = dateToDtLocal(e).slice(11, 16);
      draft.end = dateToDtLocal(e);
      revalidate();
    };
  });
  root.querySelector('[data-next-day]').onclick = () => {
    let d = addDays(startDate() || new Date(), 1);
    while (d.getDay() === 0 || d.getDay() === 6) d = addDays(d, 1);
    $('#date').value = dateToDtLocal(d).slice(0, 10);
    revalidate(); paintPreview();
  };
  $('#btnFind').onclick = () => {
    const s = startDate(), e = endDate();
    if (Number.isNaN(+s) || e <= s) { toast('Set a valid time first', 'warn'); return; }
    const set = new Set(draft.resourceIds);
    const options = [...set].map((id) => {
      const r = store.resourceById(id);
      const slots = suggestSlots(store, r, s, e, 1);
      return { r, slot: slots[0] };
    }).filter((x) => x.slot);
    if (!options.length) { toast('No free window in the next 14 days', 'err', 'Try a different time or fewer resources.'); return; }
    const best = options.sort((a, b) => a.slot.start - b.slot.start)[0];
    $('#date').value = dateToDtLocal(best.slot.start).slice(0, 10);
    $('#start').value = dateToDtLocal(best.slot.start).slice(11, 16);
    $('#end').value = dateToDtLocal(best.slot.end).slice(11, 16);
    revalidate(); paintPreview();
    toast('Shifted to the next free window', 'ok', `${fmtRange(best.slot.start, best.slot.end)} · ${best.r.name}`);
  };

  // ---------------------------------------------------------- attendees --
  $('#addAtt').onclick = () => {
    const pid = $('#attProfile').value, nm = $('#attName').value.trim(), em = $('#attEmail').value.trim();
    if (!pid && !em) { toast('Externals need a name AND an email', 'warn', 'booking_attendees requires profile_id or external_email.'); return; }
    if (pid) {
      if (draft.attendees.some((a) => a.profile_id === pid)) { toast('Already added', 'warn'); return; }
      draft.attendees.push({ profile_id: pid, external_name: null, external_email: null });
    } else {
      draft.attendees.push({ profile_id: null, external_name: nm, external_email: em || null });
    }
    $('#attProfile').value = ''; $('#attName').value = ''; $('#attEmail').value = '';
    paintAtt();
  };
  function paintAtt() {
    $('#attList').innerHTML = draft.attendees.map((a, i) => {
      const p = a.profile_id ? store.profileById(a.profile_id) : null;
      return `<span class="pill teal">${esc(p ? store.displayName(p) : a.external_name)}${a.external_email ? ` <${esc(a.external_email)}>` : ''}
        <b data-rm="${i}" style="cursor:pointer;margin-left:3px">×</b></span>`;
    }).join('') || '<span class="small muted">No attendees added</span>';
    $('#attList').querySelectorAll('[data-rm]').forEach((x) => {
      x.onclick = () => { draft.attendees.splice(Number(x.dataset.rm), 1); paintAtt(); };
    });
  }

  // ---------------------------------------------------------- day strip --
  function paintPreview() {
    const d = dateStr();
    const box = $('#dayPreview');
    if (!d) { box.innerHTML = ''; return; }
    const ids = draft.resourceIds.length ? draft.resourceIds : store.resources().filter((r) => r.is_bookable).slice(0, 8).map((r) => r.id);
    const when = startOfDay(new Date(`${d}T00:00:00`));
    box.innerHTML = `<div class="small muted mb">Selected resources on ${esc(fmtDate(when))} — hover a block for details</div>${dayTimeline(ids.slice(0, 10), when)}`;
  }

  // --------------------------------------------------------- validation --
  function revalidate() {
    draft.title = $('#title').value;
    const s = startDate(), e = endDate();
    const result = evaluateBooking(store, {
      resourceIds: draft.resourceIds,
      start: s, end: e,
      attendeeCount: Number(draft.attendeeCount) || null,
      title: draft.title,
    });

    verdict.className = `verdict ${result.verdict.tone}`;
    verdict.innerHTML = `<span>${result.verdict.icon}</span><span>${esc(result.verdict.label)}</span>`;

    const blocks = result.findings.filter((f) => f.level === LEVEL.BLOCK);
    const warns = result.findings.filter((f) => f.level === LEVEL.WARN);
    findings.innerHTML = renderFindings(result.findings) ||
      '<div class="conflict ok"><span class="ic">✅</span><div><b>All clear</b><p>No overlapping booking, blackout, maintenance or capacity problem detected.</p></div></div>';

    ackWrap.style.display = warns.length ? 'flex' : 'none';
    ack.checked = false;
    if (warns.length && !ack.dataset.kept) ack.checked = false;

    const needsApproval = draft.resourceIds.some((id) => store.resourceById(id)?.requires_approval);
    const caps = draft.resourceIds.map((id) => store.resourceById(id)?.capacity).filter(Boolean);
    const capNote = caps.length ? ` · smallest capacity ${Math.min(...caps)}` : '';

    summary.innerHTML = `
      <div class="small"><b>Resources</b><div>${draft.resourceIds.length ? draft.resourceIds.map((id) => esc(store.resourceName(id))).join('<br>') : '<span class="muted">none</span>'}</div></div>
      <div class="sep"></div>
      <div class="small"><b>When</b><div>${Number.isNaN(+s) ? '<span class="muted">—</span>' : esc(fmtRange(s, e))}<div class="muted">${Number.isNaN(+s) ? '' : fmtDuration(e - s)}</div></div></div>
      <div class="sep"></div>
      <div class="small"><b>Route</b><div>${needsApproval
        ? '<span class="pill amber">Pending approval</span> an approver must accept'
        : '<span class="pill green">Instant confirmation</span> no approval needed'}</div>
        <div class="muted mt">${draft.resourceIds.length} resource(s)${capNote}</div></div>`;

    const canSubmit = result.ok && (warns.length ? ack.checked : true) && draft.resourceIds.length > 0;
    submit.disabled = !canSubmit;
    hint.textContent = blocks.length
      ? `Fix ${blocks.length} blocking issue${blocks.length > 1 ? 's' : ''} to continue.`
      : warns.length
        ? 'Acknowledge the cautions to enable submission.'
        : draft.resourceIds.length ? 'Ready to submit.' : 'Select at least one resource.';
    draft.__result = result;
    paintPreview();
  }

  ack.onchange = () => revalidate();

  submit.onclick = async () => {
    const s = startDate(), e = endDate();
    // Re-check immediately before writing: guards against a slot taken while the form was open.
    const fresh = evaluateBooking(store, {
      resourceIds: draft.resourceIds, start: s, end: e,
      attendeeCount: Number(draft.attendeeCount) || null, title: $('#title').value,
    });
    if (!fresh.ok) {
      toast('Blocked: a conflict appeared', 'err', fresh.findings.find((f) => f.level === LEVEL.BLOCK)?.title);
      await store.log('booking.conflict_blocked', 'booking', null, null,
        { reason: fresh.findings.find((f) => f.level === LEVEL.BLOCK)?.code, resources: draft.resourceIds });
      revalidate();
      return;
    }
    submit.disabled = true;
    submit.textContent = 'Submitting…';
    try {
      const res = await store.createBooking({
        title: $('#title').value,
        description: $('#desc').value,
        purpose: $('#purpose').value,
        start: s, end: e,
        resourceIds: draft.resourceIds,
        attendeeCount: Number(draft.attendeeCount) || null,
        requirements: $('#req').value,
        attendees: draft.attendees,
      });
      resetDraft();
      toast(res.status === 'pending' ? 'Request sent for approval' : 'Booking confirmed',
        res.status === 'pending' ? 'warn' : 'ok',
        `${res.booking.booking_reference} · ${res.booking.resources.map((r) => r.name).join(', ')}`);
      go('my-bookings');
    } catch (err) {
      toast('Could not create the booking', 'err', err.message);
      submit.disabled = false;
      submit.textContent = 'Submit booking';
    }
  };

  paintPicker();
  paintAtt();
  revalidate();
}

function resetDraft() {
  draft.resourceIds = [];
  draft.title = ''; draft.description = ''; draft.requirements = '';
  draft.attendeeCount = ''; draft.attendees = [];
  draft.start = ''; draft.end = '';
}
