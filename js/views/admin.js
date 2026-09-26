import { store } from '../store.js';
import { usageReport } from '../analytics.js';
import { auditData, evaluateBooking } from '../conflicts.js';
import {
  esc, toast, confirmDialog, openModal, fmtDate, fmtDateTime, fmtAgo, fmtRange, emptyState,
  downloadCsv, promptDialog, openModal as modal2, dateToDtLocal, startOfDay, DAY,
} from '../ui.js';
import { pageHead, statTile, dayTimeline } from './common.js';
import { openResourceDetail } from './resource-detail.js';
import { go, refresh } from '../router.js';

export function render() {
  const isAdmin = store.isAdmin();
  const report = usageReport(store, { days: 30 });
  const integrity = auditData(store, { days: 90 });
  const logs = store.auditLogs(150);
  const blocked = logs.filter((l) => l.action.includes('conflict') || l.action.includes('blocked'));
  const people = store.profiles().map((p) => ({ ...p, roles: store.rolesOf(p.id) }));

  return `
    ${pageHead('Administration', 'Audit trail, data integrity and people', `
      <button class="btn btn-ghost btn-sm" id="csv">⤓ Export audit</button>
      ${isAdmin ? '<button class="btn btn-amber btn-sm" id="repair">Repair double bookings</button>' : ''}`)}

    <div class="grid g4 mb">
      ${statTile('', 'Audit events', String(logs.length), 'most recent 150')}
      ${statTile('c', 'Conflicts blocked', String(blocked.length), 'automatically prevented')}
      ${statTile('a', 'Overlapping pairs', String(integrity.duplicates.length), 'last 90 days')}
      ${statTile('g', 'Campus members', String(people.length), `${people.filter((p) => p.is_active).length} active`)}
    </div>

    <div class="card mb pad-0">
      <div class="card-head" style="padding:16px 16px 0"><h2>Audit log</h2><div class="spacer"></div>
        <span class="small muted">newest first</span></div>
      <div class="table-wrap" style="max-height:420px;overflow:auto">
        <table class="tbl">
          <thead><tr><th>When</th><th>Action</th><th>Actor</th><th>Entity</th><th>Detail</th></tr></thead>
          <tbody>${logs.map((l) => `<tr>
            <td class="small nowrap" title="${esc(fmtDateTime(l.created_at))}">${esc(fmtAgo(l.created_at))}</td>
            <td><span class="pill ${l.action.includes('block') ? 'coral' : l.action.includes('approved') ? 'green' : l.action.includes('request') ? 'amber' : 'grey'}">${esc(l.action)}</span></td>
            <td class="small">${esc(l.actor_name)}</td>
            <td class="small mono">${esc(l.entity_type)}${l.entity_id ? `#${esc(l.entity_id)}` : ''}</td>
            <td class="small muted">${esc(l.new_data ? JSON.stringify(l.new_data) : '—')}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
    </div>

    <div class="grid g2 mb">
      <div class="card">
        <h2 class="mb">Maintenance &amp; blackouts (all resources)</h2>
        ${maintList()}
      </div>
      <div class="card">
        <h2 class="mb">People &amp; roles</h2>
        <div class="table-wrap" style="max-height:420px;overflow:auto">
          <table class="tbl">
            <thead><tr><th>Name</th><th>Department</th><th>Role</th><th>Bookings</th><th>Status</th></tr></thead>
            <tbody>${people.map((p) => `<tr>
              <td><b>${esc(store.displayName(p))}</b><div class="small muted">${esc(p.email || '')}</div></td>
              <td class="small">${esc(p.department || '—')}</td>
              <td>${(p.roles || []).map((r) => `<span class="pill ${r === 'admin' ? 'coral' : r === 'student' ? 'teal' : 'amber'}">${esc(r)}</span>`).join(' ') || '<span class="muted small">none</span>'}</td>
              <td class="num">${store.db.bookings.filter((b) => b.requested_by === p.id).length}</td>
              <td><span class="pill ${p.is_active ? 'green' : 'grey'}">${p.is_active ? 'active' : 'disabled'}</span></td>
            </tr>`).join('')}</tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="card">
      <h2 class="mb">Reference data</h2>
      <div class="grid g3">
        <div><div class="lbl">Campuses</div><b>${store.db.campuses.length}</b></div>
        <div><div class="lbl">Buildings</div><b>${store.buildings().length}</b></div>
        <div><div class="lbl">Floors</div><b>${store.floors().length}</b></div>
        <div><div class="lbl">Resource types</div><b>${store.resourceTypes().length}</b></div>
        <div><div class="lbl">Resources</div><b>${store.db.resources.length}</b></div>
        <div><div class="lbl">Features</div><b>${store.db.resource_features.length}</b></div>
        <div><div class="lbl">Bookings</div><b>${store.db.bookings.length}</b></div>
        <div><div class="lbl">Availability rules</div><b>${store.db.resource_availability.length}</b></div>
        <div><div class="lbl">Booking statuses</div><b>${store.db.booking_statuses.length}</b></div>
      </div>
      <div class="sep"></div>
      <div class="flex">
        <span class="pill ${store.mode === 'live' ? 'green' : 'amber'}">${store.mode === 'live' ? 'Connected to Supabase' : 'Local demo data'}</span>
        ${store.mode === 'demo' ? '<button class="btn btn-ghost btn-sm" id="reset">Reset demo dataset</button>' : ''}
      </div>
    </div>`;
}

function maintList() {
  const m = (store.db.maintenance_records || []).slice().sort((a, b) => new Date(b.start_time) - new Date(a.start_time)).slice(0, 12);
  const b = (store.db.resource_blackouts || []).slice().sort((x, y) => new Date(y.start_time) - new Date(x.start_time)).slice(0, 12);
  if (!m.length && !b.length) return '<p class="small muted">Nothing scheduled.</p>';
  return `
    ${m.length ? `<div class="lbl">Maintenance</div><div class="table-wrap"><table class="tbl">
      <thead><tr><th>Resource</th><th>Work</th><th>When</th><th>Status</th></tr></thead>
      <tbody>${m.map((x) => `<tr>
        <td class="small">${esc(store.resourceName(x.resource_id))}</td>
        <td class="small">${esc(x.title)}</td>
        <td class="small nowrap">${esc(fmtRange(x.start_time, x.end_time || x.start_time))}</td>
        <td><span class="pill ${x.status === 'completed' ? 'green' : x.status === 'in_progress' ? 'amber' : 'coral'}">${esc(x.status.replace('_', ' '))}</span></td>
      </tr>`).join('')}</tbody></table></div>` : ''}
    ${b.length ? `<div class="lbl mt">Blackouts</div><div class="table-wrap"><table class="tbl">
      <thead><tr><th>Resource</th><th>Reason</th><th>When</th></tr></thead>
      <tbody>${b.map((x) => `<tr>
        <td class="small">${esc(store.resourceName(x.resource_id))}</td>
        <td class="small">${esc(x.reason)}</td>
        <td class="small nowrap">${esc(fmtRange(x.start_time, x.end_time))}</td>
      </tr>`).join('')}</tbody></table></div>` : ''}`;
}

export function after(root) {
  root.querySelector('#csv')?.addEventListener('click', () => {
    const logs = store.auditLogs(2000);
    downloadCsv(`audit-log-${new Date().toISOString().slice(0, 10)}.csv`, [
      ['Timestamp', 'Action', 'Actor', 'Entity type', 'Entity id', 'New data'],
      ...logs.map((l) => [l.created_at, l.action, l.actor_name, l.entity_type, l.entity_id, JSON.stringify(l.new_data)]),
    ]);
    toast('Audit log exported');
  });

  root.querySelector('#repair')?.addEventListener('click', async () => {
    const issues = auditData(store, { days: 90 });
    if (!issues.duplicates.length) { toast('Nothing to repair', 'ok', 'No overlapping bookings found.'); return; }
    const body = `<p>${issues.duplicates.length} overlapping pair(s) will be resolved by <b>cancelling the later booking</b> and logging the repair.</p>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Resource</th><th>Kept</th><th>Cancelled</th></tr></thead>
        <tbody>${issues.duplicates.slice(0, 15).map((d) => `<tr>
          <td class="small">${esc(d.resource)}</td>
          <td class="small">${esc(d.a.booking_reference)}</td>
          <td class="small">${esc(d.b.booking_reference)}</td></tr>`).join('')}</tbody></table></div>`;
    const m = openModal({ title: 'Repair double bookings', body, footer: '<button class="btn btn-ghost" data-x>Cancel</button><button class="btn btn-coral" data-ok>Repair</button>' });
    m.footer.querySelector('[data-x]').onclick = m.close;
    m.footer.querySelector('[data-ok]').onclick = async () => {
      m.close();
      let n = 0;
      for (const d of issues.duplicates) {
        try { await store.cancelBooking(d.b.id, 'Auto-resolved: overlapping booking detected by the integrity audit.'); n++; } catch { /* ignore */ }
      }
      toast(`Repaired ${n} booking(s)`, 'ok', 'Later bookings were cancelled and logged.');
      refresh();
    };
  });

  root.querySelector('#reset')?.addEventListener('click', async () => {
    if (await confirmDialog('Reset demo data', 'Regenerate the sample campus dataset? Local changes will be lost.', 'Reset', 'coral')) {
      store.resetDemo();
      toast('Demo dataset regenerated');
      refresh();
    }
  });
}
