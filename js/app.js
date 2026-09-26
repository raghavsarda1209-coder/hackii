import { store } from './store.js';
import { buildDemoDb } from './seed.js';
import { STATUS, APPROVER_ROLES, STORAGE_KEY } from './config.js';
import { $, $$, esc, toast, initials, closeModal } from './ui.js';
import { register, startRouter, go, refresh } from './router.js';

import * as dashboard from './views/dashboard.js';
import * as resources from './views/resources.js';
import * as booking from './views/booking.js';
import * as bookings from './views/bookings.js';
import * as analytics from './views/analytics-view.js';
import * as timeline from './views/timeline.js';
import * as findSlot from './views/find-slot.js';
import * as admin from './views/admin.js';
import * as notifications from './views/notifications.js';

const ROUTES = {
  dashboard: dashboard, resources, 'new-booking': booking,
  'my-bookings': bookings, approvals: bookings, 'all-bookings': bookings,
  analytics, timeline, 'find-slot': findSlot, admin, notifications,
};
Object.entries(ROUTES).forEach(([name, mod]) => register(name, { name, render: mod.render, after: mod.after }));

const app = $('#app');
const auth = $('#auth');
const mount = $('#view');

// ------------------------------------------------------------------ boot --
(async function boot() {
  wireStaticHandlers();
  await store.init();
  if (store.mode === 'anon') showAuth();
  else showApp();
})();

// -------------------------------------------------------------- chrome ----
function showApp() {
  auth.hidden = true;
  app.classList.add('ready');
  renderShell();
  if (!location.hash || location.hash === '#') go('dashboard');
  startRouter(mount, () => { renderTopbar(); });
}

function renderShell() {
  const approver = store.isApprover();
  const nav = [
    ['group', 'Workspace'],
    ['dashboard', '🏠', 'Dashboard'],
    ['resources', '🏛', 'Resources'],
    ['find-slot', '🔍', 'Find a free slot'],
    ['timeline', '🗓', 'Campus timeline'],
    ['group', 'My activity'],
    ['new-booking', '➕', 'New booking'],
    ['my-bookings', '📋', 'My bookings'],
    ['notifications', '🔔', 'Notifications'],
  ];
  if (approver) nav.push(['group', 'Approver'], ['approvals', '✅', 'Approval queue'], ['all-bookings', '🌐', 'All bookings']);
  nav.push(['group', 'Insight']);
  nav.push(['analytics', '📈', 'Usage & analytics']);
  if (approver) nav.push(['admin', '🛠', 'Administration']);

  $('#nav').innerHTML = nav.map(([k, label, badge]) => {
    if (k === 'group') return `<div class="group-label">${esc(label)}</div>`;
    const n = k === 'approvals' ? store.pendingApprovalCount() : k === 'notifications' ? store.unreadCount() : 0;
    return `<a href="#/${k}" data-nav="${k}"><span class="ico">${label}</span><span>${esc(badge)}</span>${n ? `<span class="badge">${n}</span>` : ''}</a>`;
  }).join('');

  $('#sidefoot').innerHTML = `
    <div class="flex" style="gap:9px">
      <span class="avatar g">${esc(initials(store.myName()))}</span>
      <div style="min-width:0">
        <b class="small" style="display:block">${esc(store.myName())}</b>
        <span class="small muted">${esc(store.roles.join(', ') || 'member')}</span>
      </div>
    </div>
    <div class="flex" style="margin-top:9px">
      <button class="btn btn-ghost btn-sm" id="btnSwitch" style="flex:1">${store.mode === 'demo' ? 'Switch user' : 'Account'}</button>
      <button class="btn btn-ghost btn-sm" id="btnSignOut">Sign out</button>
    </div>`;

  $('#btnSignOut').onclick = async () => {
    if (store.mode === 'demo') { store.leaveDemo(); location.hash = ''; }
    else await store.signOut();
    showAuth();
  };
  $('#btnSwitch').onclick = () => { if (store.mode === 'demo') showAuth(); else accountModal(); };
  renderTopbar();
}

function renderTopbar() {
  const unread = store.unreadCount();
  const pending = store.pendingApprovalCount();
  $('#crumbs').innerHTML = `
    <span class="pill ${store.mode === 'live' ? 'green' : 'amber'}">${store.mode === 'live' ? '● Supabase live' : '● Demo data'}</span>
    <span class="pill grey">${esc((store.db.buildings || []).length)} buildings</span>
    <span class="pill grey">${esc((store.db.resources || []).length)} resources</span>
    <span class="pill teal">${esc(store.db.bookings.length)} bookings</span>`;
  $('#topacts').innerHTML = `
    <button class="btn btn-ghost btn-sm" data-nav="notifications">🔔${unread ? ` <span class="pill coral">${unread}</span>` : ''}</button>
    ${store.isApprover() ? `<button class="btn btn-green btn-sm" data-nav="approvals">Approvals${pending ? ` (${pending})` : ''}</button>` : ''}
    <button class="btn btn-primary btn-sm" data-nav="new-booking">+ Book</button>`;
  // refresh nav badges
  const approvLink = $('#nav [data-nav="approvals"] .badge');
  if (approvLink) approvLink.textContent = pending;
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === (location.hash.replace(/^#\/?/, '').split('?')[0] || 'dashboard')));
}

function accountModal() {
  const p = store.profile;
  const mine = store.db.bookings.filter((b) => b.requested_by === store.user?.id);
  import('./ui.js').then(({ openModal }) => {
    const m = openModal({
      title: 'My account',
      body: `<div class="grid g2">
        <div><div class="lbl">Name</div><b>${esc(store.displayName(p))}</b></div>
        <div><div class="lbl">Email</div><b>${esc(p?.email || '—')}</b></div>
        <div><div class="lbl">Department</div><b>${esc(p?.department || '—')}</b></div>
        <div><div class="lbl">Roles</div><b>${esc(store.roles.join(', ') || '—')}</b></div>
        <div><div class="lbl">Employee / Student ID</div><b>${esc(p?.student_employee_id || '—')}</b></div>
        <div><div class="lbl">Bookings raised</div><b>${mine.length}</b></div>
      </div>
      <div class="sep"></div>
      <div class="small muted">Signed in with the Supabase publishable key. Privileged operations are enforced by Postgres row-level security and the overlap guard constraint.</div>`,
      footer: '<button class="btn btn-primary" data-x>Close</button>',
    });
    m.footer.querySelector('[data-x]').onclick = m.close;
  });
}

// ---------------------------------------------------------------- auth ----
function showAuth() {
  app.classList.remove('ready');
  auth.hidden = false;
  // Always offer the local dataset: it is the only way to explore the product
  // when the live database is empty, still being seeded, or RLS-blocked.
  const liveDb = store.db && store.mode === 'live' ? store.db : null;
  const people = (liveDb && liveDb.profiles.length ? liveDb.profiles : buildDemoDb().profiles);
  const liveButEmpty = store.mode === 'live' && (!store.db || !store.db.resources || store.db.resources.length === 0);

  auth.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="auth-head">
          <div class="mark-lg">CB</div>
          <h1>CampusBook</h1>
          <p>Smart campus resource booking with automatic double-booking prevention</p>
        </div>
        <div class="auth-body">
          ${store.mode === 'demo'
            ? `<div class="banner warn"><span>⚠️</span><span>${esc(store.modeReason || 'Demo mode: the live database is not reachable.')}
                Nothing you do here writes to the live database.</span></div>`
            : liveButEmpty
              ? `<div class="banner info"><span>ℹ️</span><span>Connected to Supabase, but the catalogue is empty or hidden by RLS.
                  Run the <b>sql/</b> migrations, or explore with the fully populated demo campus below.</span></div>`
              : ''}
          <div class="tabs">
            <button class="on" data-tab="signin">Sign in</button>
            <button data-tab="signup">Create account</button>
          </div>

          <form id="formSignin">
            <div class="field"><label class="lbl">Email</label><input id="siEmail" type="email" required placeholder="you@campus.edu"></div>
            <div class="field"><label class="lbl">Password</label><input id="siPass" type="password" required placeholder="••••••••"></div>
            <button class="btn btn-primary btn-block btn-lg" type="submit">Sign in</button>
          </form>

          <form id="formSignup" hidden>
            <div class="row">
              <div class="field"><label class="lbl">First name</label><input id="suFirst" required></div>
              <div class="field"><label class="lbl">Last name</label><input id="suLast"></div>
            </div>
            <div class="field"><label class="lbl">Email</label><input id="suEmail" type="email" required></div>
            <div class="field"><label class="lbl">Password</label><input id="suPass" type="password" required minlength="6" placeholder="min 6 characters"></div>
            <div class="field"><label class="lbl">Department</label><input id="suDept" placeholder="e.g. Computer Science"></div>
            <button class="btn btn-green btn-block btn-lg" type="submit">Create account</button>
            <p class="help">A profile row is created automatically on first sign-in; request an approver role from campus administration.</p>
          </form>

          ${people.length ? `<div class="sep"></div>
            <div class="lbl mb">Explore the campus as</div>
            <div class="demo-users">${people.map((p, i) => `<div class="demo-user" data-demo="${p.id}">
              <span class="avatar ${i % 3 === 1 ? 'g' : i % 3 === 2 ? 'c' : ''}">${esc(initials(store.displayName(p)))}</span>
              <div><div class="t">${esc(store.displayName(p))}</div>
              <div class="s">${esc(store.rolesOf(p.id).join(', ') || 'member')} · ${esc(p.department || '')}</div></div>
            </div>`).join('')}</div>` : ''}
        </div>
      </div>
    </div>`;

  $$('[data-tab]', auth).forEach((b) => {
    b.onclick = () => {
      $$('[data-tab]', auth).forEach((x) => x.classList.toggle('on', x === b));
      $('#formSignin').hidden = b.dataset.tab !== 'signin';
      $('#formSignup').hidden = b.dataset.tab !== 'signup';
    };
  });

  $('#formSignin').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true; btn.textContent = 'Signing in…';
    try {
      await store.signIn($('#siEmail').value.trim(), $('#siPass').value);
      toast('Welcome back', 'ok', store.myName());
      showApp();
    } catch (err) {
      toast('Sign in failed', 'err', err.message);
      if (!store.db) await store._enterDemo('Supabase unreachable while signing in.');
      btn.disabled = false; btn.textContent = 'Sign in';
    }
  };

  $('#formSignup').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true; btn.textContent = 'Creating…';
    try {
      const res = await store.signUp($('#suEmail').value.trim(), $('#suPass').value, {
        first_name: $('#suFirst').value.trim(), last_name: $('#suLast').value.trim(), department: $('#suDept').value.trim(),
      });
      if (res.needsConfirmation) toast('Check your inbox', 'info', 'Confirm the email, then sign in.');
      else { toast('Account created', 'ok', 'Welcome to CampusBook.'); showApp(); }
    } catch (err) {
      toast('Could not create the account', 'err', err.message);
    }
    btn.disabled = false; btn.textContent = 'Create account';
  };

  $$('[data-demo]', auth).forEach((row) => {
    row.onclick = async () => {
      if (store.mode !== 'demo') await store._enterDemo('Exploring with the local demo campus.');
      await store.enterDemoAs(row.dataset.demo);
      toast('Signed in (demo)', 'ok', `${store.myName()} · ${store.roles.join(', ') || 'member'}`);
      showApp();
    };
  });
}

// ------------------------------------------------------- global handlers --
function wireStaticHandlers() {
  document.addEventListener('click', (e) => {
    const nav = e.target.closest('[data-nav]');
    if (nav && !nav.closest('.overlay')) { e.preventDefault(); go(nav.dataset.nav); }
  });

  store.subscribe((evt) => {
    if (evt.type === 'notifications' || evt.type === 'bookings' || evt.type === 'mode' || evt.type === 'reset') {
      const nav = $('#nav');
      if (nav && app.classList.contains('ready')) {
        const badge = nav.querySelector('[data-nav="approvals"] .badge');
        const p = store.pendingApprovalCount();
        if (p && badge) badge.textContent = p;
        renderTopbar();
      }
    }
  });

  window.addEventListener('hashchange', () => {
    if (!app.classList.contains('ready') && store.mode !== 'anon') showApp();
  });
}
