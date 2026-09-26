import { store } from '../store.js';
import { usageReport } from '../analytics.js';
import { esc, debounce, emptyState, dateToDtLocal, startOfDay, addDays, fmtRange, DAY, fmtDuration } from '../ui.js';
import { pageHead, resourceCard, dayTimeline } from './common.js';
import { openResourceDetail, suggestOpen } from './resource-detail.js';
import { evaluateBooking } from '../conflicts.js';
import { go } from '../router.js';

const state = { q: '', type: 'all', building: 'all', floor: 'all', feature: 'all', capacity: 0, onlyFree: false, day: dateToDtLocal(new Date()).slice(0, 10) };

export function render() {
  const types = store.resourceTypes();
  const buildings = store.buildings();
  const features = [...new Set((store.db.resource_features || []).map((f) => f.name))].sort();
  const all = store.resources({ includeInactive: true });

  return `
    ${pageHead('Resources', `${all.length} bookable assets across ${buildings.length} buildings`, `
      <button class="btn btn-teal btn-sm" data-nav="find-slot">🔍 Find a free slot</button>
      <button class="btn btn-primary btn-sm" data-nav="new-booking">+ New booking</button>`)}

    <div class="card mb">
      <div class="row">
        <div>
          <label class="lbl">Search</label>
          <input id="q" placeholder="Name, code, feature…" value="${esc(state.q)}">
        </div>
        <div>
          <label class="lbl">Type</label>
          <select id="type">
            <option value="all">All types</option>
            ${types.map((t) => `<option value="${t.id}" ${String(state.type) === String(t.id) ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
          </select>
        </div>
        <div>
          <label class="lbl">Building</label>
          <select id="building">
            <option value="all">All buildings</option>
            ${buildings.map((b) => `<option value="${b.id}" ${String(state.building) === String(b.id) ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}
          </select>
        </div>
        <div>
          <label class="lbl">Feature</label>
          <select id="feature">
            <option value="all">Any feature</option>
            ${features.map((f) => `<option value="${esc(f)}" ${state.feature === f ? 'selected' : ''}>${esc(f)}</option>`).join('')}
          </select>
        </div>
        <div>
          <label class="lbl">Min seats</label>
          <input id="capacity" type="number" min="0" step="1" value="${state.capacity || ''}" placeholder="e.g. 30">
        </div>
        <div>
          <label class="lbl">Check day</label>
          <input id="day" type="date" value="${esc(state.day)}">
        </div>
      </div>
      <div class="flex between mt">
        <div class="flex">
          <span class="inline-check"><input type="checkbox" id="onlyFree" ${state.onlyFree ? 'checked' : ''}> Free on the selected day</span>
          <span class="inline-check"><input type="checkbox" id="onlyActive" ${state.onlyActive ? 'checked' : ''}> Hide out-of-service</span>
        </div>
        <div class="flex">
          <span class="small muted" id="count"></span>
          <button class="btn btn-ghost btn-sm" id="reset">Reset filters</button>
        </div>
      </div>
    </div>

    <div id="results" class="grid g-auto"></div>
    <div id="daytl" class="mt"></div>`;
}

export function after(root) {
  const results = root.querySelector('#results');
  const daytl = root.querySelector('#daytl');
  const countEl = root.querySelector('#count');

  const paint = () => {
    const report = usageReport(store, { days: 30 });
    let list = store.resources({ includeInactive: !state.onlyActive });

    if (state.q) {
      const q = state.q.toLowerCase();
      list = list.filter((r) => [r.name, r.code, r.type_name, r.building_name, r.location_description, ...r.features]
        .filter(Boolean).join(' ').toLowerCase().includes(q));
    }
    if (state.type !== 'all') list = list.filter((r) => r.resource_type_id === Number(state.type));
    if (state.building !== 'all') list = list.filter((r) => r.building_id === Number(state.building));
    if (state.feature !== 'all') list = list.filter((r) => r.features.includes(state.feature));
    if (state.capacity) list = list.filter((r) => (r.capacity || 0) >= state.capacity);

    // "Free on <day>" = a trial booking for a 1h block at midday has no blocking conflict
    if (state.day) {
      const dayStart = startOfDay(new Date(`${state.day}T00:00:00`));
      const probeStart = new Date(dayStart.getTime() + 13 * 3600000);
      const probeEnd = new Date(probeStart.getTime() + 60 * 60000);
      list = list.filter((r) => evaluateBooking(store, { resourceIds: [r.id], start: probeStart, end: probeEnd }).ok);
      if (state.onlyFree) list = list.filter((r) => r.is_bookable && r.is_active);
    }

    countEl.textContent = `${list.length} resource${list.length === 1 ? '' : 's'} match`;
    results.innerHTML = list.length
      ? list.map((r) => resourceCard(r, report)).join('')
      : `<div style="grid-column:1/-1">${emptyState('🔍', 'Nothing matches those filters', 'Try widening the search or clearing the "free on" day.')}</div>`;

    if (state.day && list.length) {
      const dayStart = startOfDay(new Date(`${state.day}T00:00:00`));
      const shown = list.slice(0, 10).map((r) => r.id);
      daytl.innerHTML = `<div class="card">
        <div class="card-head"><h2>Schedule on ${esc(new Date(`${state.day}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }))}</h2>
          <div class="spacer"></div><span class="small muted">top ${shown.length} of ${list.length}</span></div>
        ${dayTimeline(shown, dayStart)}
      </div>`;
    } else daytl.innerHTML = '';
  };

  const onInput = debounce(paint, 200);
  root.querySelector('#q').oninput = (e) => { state.q = e.target.value; onInput(); };
  root.querySelector('#type').onchange = (e) => { state.type = e.target.value; paint(); };
  root.querySelector('#building').onchange = (e) => { state.building = e.target.value; paint(); };
  root.querySelector('#feature').onchange = (e) => { state.feature = e.target.value; paint(); };
  root.querySelector('#capacity').oninput = (e) => { state.capacity = Number(e.target.value) || 0; onInput(); };
  root.querySelector('#day').onchange = (e) => { state.day = e.target.value; paint(); };
  root.querySelector('#onlyFree').onchange = (e) => { state.onlyFree = e.target.checked; paint(); };
  root.querySelector('#onlyActive').onchange = (e) => { state.onlyActive = e.target.checked; paint(); };
  root.querySelector('#reset').onclick = () => {
    Object.assign(state, { q: '', type: 'all', building: 'all', feature: 'all', capacity: 0, onlyFree: false, day: dateToDtLocal(new Date()).slice(0, 10) });
    go('resources');
  };

  root.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.book) { e.stopPropagation(); go('new-booking', { resource: t.dataset.book }); }
    if (t.dataset.availability) { e.stopPropagation(); openResourceDetail(t.dataset.availability); }
  });
  root.querySelector('#results').addEventListener('click', (e) => {
    const card = e.target.closest('.res-card');
    if (card && !e.target.closest('button')) openResourceDetail(card.dataset.resource);
  });

  paint();
}
