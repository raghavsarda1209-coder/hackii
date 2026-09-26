// Minimal Chrome DevTools Protocol driver - no external packages.
// Usage: node tests/browser.test.mjs http://127.0.0.1:8777/
const BASE = process.argv[2] || 'http://127.0.0.1:8777/';
const CDP = 'http://127.0.0.1:9222';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: 'PUT' });
      if (r.ok) return await r.json();
    } catch { /* retry */ }
    await sleep(500);
  }
  throw new Error('Could not reach Edge on 9222');
}

class Session {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.logs = []; this.errors = []; }
  static async open(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const s = new Session(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && s.pending.has(m.id)) {
        const { resolve, reject } = s.pending.get(m.id);
        s.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.method === 'Runtime.consoleAPICalled') {
        const text = (m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
        s.logs.push(`[${m.params.type}] ${text}`);
        if (m.params.type === 'error') s.errors.push(text);
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        s.errors.push(d.exception?.description || d.text);
      } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
        s.errors.push(`${m.params.entry.source}: ${m.params.entry.text} ${m.params.entry.url || ''}`);
      }
    };
    return s;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method} timed out`)); } }, 30000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async()=>{ ${expr} })()`,
      awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log(`  ✗ ${msg}`); } else console.log(`  ✓ ${msg}`); };

const t = await target();
const s = await Session.open(t.webSocketDebuggerUrl);
await s.send('Runtime.enable');
await s.send('Page.enable');
await s.send('Log.enable');
await s.send('Network.enable');
await s.send('Network.setCacheDisabled', { cacheDisabled: true });

console.log('\n0. Boot (offline -> demo mode fallback)');
await sleep(6000);
let state = await s.eval(`
  return {
    authVisible: !document.getElementById('auth').hidden,
    appReady: document.getElementById('app').classList.contains('ready'),
    demoUsers: document.querySelectorAll('[data-demo]').length,
    banner: document.querySelector('#auth .banner')?.innerText.slice(0, 120) || '',
  };
`);
console.log('   state:', JSON.stringify(state));
ok(state.authVisible, 'auth screen rendered (no white page)');
ok(state.demoUsers === 10, `demo user picker shows ${state.demoUsers} people`);

console.log('\n1. Sign in as the admin');
await s.eval(`document.querySelector('[data-demo]').click(); return 1;`);
await sleep(2500);
state = await s.eval(`
  return {
    appReady: document.getElementById('app').classList.contains('ready'),
    navLinks: document.querySelectorAll('#nav a').length,
    title: document.querySelector('#view h1')?.innerText || '',
    statTiles: document.querySelectorAll('#view .stat').length,
    hash: location.hash,
  };
`);
console.log('   state:', JSON.stringify(state));
ok(state.appReady, 'app shell is visible');
ok(state.navLinks >= 8, `${state.navLinks} nav links rendered`);
ok(/Hello/i.test(state.title), `dashboard heading: "${state.title}"`);
ok(state.statTiles >= 8, `${state.statTiles} KPI tiles on the dashboard`);

const routes = ['resources', 'find-slot', 'timeline', 'new-booking', 'my-bookings', 'notifications', 'approvals', 'all-bookings', 'analytics', 'admin', 'dashboard'];
console.log('\n2. Every route renders without errors');
for (const r of routes) {
  const before = s.errors.length;
  await s.eval(`location.hash = '#/${r}'; return 1;`);
  await sleep(1400);
  const info = await s.eval(`
    const v = document.getElementById('view');
    return { len: v.innerHTML.length, h1: v.querySelector('h1')?.innerText || '', hasErr: !!v.querySelector('.banner.err') };
  `);
  const newErrs = s.errors.slice(before);
  const good = info.len > 400 && !info.hasErr && newErrs.length === 0;
  ok(good, `#/${r} -> "${info.h1}" (${info.len} chars)${newErrs.length ? ` ERRORS: ${newErrs.join(' | ')}` : ''}`);
}

console.log('\n3. Resources: filter + search');
await s.eval(`location.hash = '#/resources'; return 1;`);
await sleep(1400);
const res1 = await s.eval(`
  const before = document.querySelectorAll('#results .res-card').length;
  const q = document.getElementById('q'); q.value = 'seminar'; q.dispatchEvent(new Event('input'));
  await new Promise(r=>setTimeout(r,500));
  const after = document.querySelectorAll('#results .res-card').length;
  const names = [...document.querySelectorAll('#results .res-card .name')].map(n=>n.innerText);
  q.value=''; q.dispatchEvent(new Event('input')); await new Promise(r=>setTimeout(r,500));
  const reset = document.querySelectorAll('#results .res-card').length;
  const timeline = !!document.querySelector('#daytl .tl-track');
  return { before, after, reset, names, timeline };
`);
ok(res1.before > 10, `all resources listed (${res1.before})`);
ok(res1.after > 0 && res1.after < res1.before, `search "seminar" narrows to ${res1.after}: ${res1.names.join(', ')}`);
ok(res1.reset === res1.before, 'clearing search restores the list');
ok(res1.timeline, 'day schedule strip rendered under the grid');

console.log('\n4. Booking wizard: conflict detection is live');
await s.eval(`location.hash = '#/new-booking'; return 1;`);
await sleep(1500);
const wiz = await s.eval(`
  // pick the first resource in the picker
  const cb = document.querySelector('#resPick input[data-res]');
  cb.checked = true; cb.dispatchEvent(new Event('change'));
  await new Promise(r=>setTimeout(r,400));
  const noVerdict = document.querySelector('#verdict')?.innerText.trim();
  document.getElementById('title').value = 'Automated test booking';
  document.getElementById('title').dispatchEvent(new Event('input'));
  // find a slot that is definitely taken: use the first timeline block time
  const d = new Date(Date.now() + 3*864e5);
  const dd = d.toLocaleDateString('sv-SE');
  document.getElementById('date').value = dd;
  document.getElementById('start').value = '11:00';
  document.getElementById('end').value = '12:00';
  document.getElementById('start').dispatchEvent(new Event('input'));
  document.getElementById('end').dispatchEvent(new Event('input'));
  await new Promise(r=>setTimeout(r,700));
  return {
    picked: document.getElementById('selCount').innerText.slice(0,80),
    verdict: document.querySelector('#verdict')?.innerText.trim(),
    verdictClass: document.querySelector('#verdict')?.className,
    findings: document.querySelectorAll('#findings .conflict').length,
    submitDisabled: document.getElementById('submit').disabled,
    summary: document.querySelector('#summary')?.innerText.replace(/\\n+/g,' | ').slice(0,180),
  };
`);
console.log('  ', JSON.stringify(wiz, null, 1).replace(/\n/g, '\n  '));
ok(wiz.picked.includes('selected'), 'resource selection reflected in the UI');
ok(wiz.verdict && wiz.verdict.length > 5, `verdict shown: "${wiz.verdict}"`);
ok(wiz.findings > 0, `${wiz.findings} finding(s) itemised`);
ok(wiz.summary.includes('Route'), 'summary panel shows the approval route');

console.log('\n5. Submitting a genuinely conflicting booking must be refused');
const blocked = await s.eval(`
  // force a known conflict: take a slot from an existing booking
  const db = JSON.parse(localStorage.getItem('campusbook.state.v1.demo'));
  const held = db.bookings.filter(b => b.status_code==='approved' && new Date(b.start_time) > new Date());
  const target = held[0];
  const link = db.booking_resources.find(br => br.booking_id === target.id);
  document.getElementById('date').value = new Date(target.start_time).toLocaleDateString('sv-SE');
  const p = t => String(t).padStart(2,'0');
  const st = new Date(target.start_time), en = new Date(target.end_time);
  document.getElementById('start').value = p(st.getHours())+':'+p(st.getMinutes());
  document.getElementById('end').value = p(en.getHours())+':'+p(en.getMinutes());
  const cbs = [...document.querySelectorAll('#resPick input[data-res]')];
  cbs.forEach(c => { if (Number(c.dataset.res) === link.resource_id) { c.checked = true; } else { c.checked = false; } });
  cbs.find(c => Number(c.dataset.res) === link.resource_id).dispatchEvent(new Event('change'));
  document.getElementById('start').dispatchEvent(new Event('input'));
  document.getElementById('end').dispatchEvent(new Event('input'));
  await new Promise(r=>setTimeout(r,800));
  return {
    ref: target.booking_reference,
    verdictClass: document.querySelector('#verdict').className,
    verdict: document.querySelector('#verdict').innerText.trim(),
    blocks: [...document.querySelectorAll('#findings .conflict.block b')].map(b=>b.innerText),
    submitDisabled: document.getElementById('submit').disabled,
    hint: document.getElementById('submitHint').innerText,
  };
`);
console.log('  ', JSON.stringify(blocked, null, 1).replace(/\n/g, '\n  '));
ok(blocked.verdictClass.includes('block'), 'verdict is a BLOCK');
ok(blocked.blocks.some((b) => /Double booking/i.test(b)), `double booking reported: ${blocked.blocks.find((b) => /Double booking/i.test(b))}`);
ok(blocked.submitDisabled, 'submit button is disabled - double booking is impossible');

console.log('\n6. A free slot is accepted and saved');
const saved = await s.eval(`
  const db = JSON.parse(localStorage.getItem('campusbook.state.v1.demo'));
  const r = db.resources[3];
  const res = db.booking_resources.map(x=>x.resource_id);
  // ask the engine for a free slot via the app's own UI: press "Find next free slot"
  document.getElementById('btnFind').click();
  await new Promise(x=>setTimeout(x,1200));
  return {
    date: document.getElementById('date').value,
    start: document.getElementById('start').value,
    end: document.getElementById('end').value,
    verdictClass: document.querySelector('#verdict').className,
    submitDisabled: document.getElementById('submit').disabled,
    hint: document.getElementById('submitHint').innerText,
  };
`);
console.log('  ', JSON.stringify(saved));
ok(saved.verdictClass.includes('ok') || saved.verdictClass.includes('warn'), `"Find next free slot" landed on a valid window (${saved.date} ${saved.start}-${saved.end})`);
ok(!saved.submitDisabled, 'submit is enabled on a free slot');

const created = await s.eval(`
  const before = JSON.parse(localStorage.getItem('campusbook.state.v1.demo')).bookings.length;
  document.getElementById('submit').click();
  await new Promise(x=>setTimeout(x,1800));
  const after = JSON.parse(localStorage.getItem('campusbook.state.v1.demo')).bookings.length;
  return { before, after, hash: location.hash, toast: document.querySelector('.toast')?.innerText || '' };
`);
console.log('  ', JSON.stringify(created));
ok(created.after === created.before + 1, `booking persisted (${created.before} -> ${created.after})`);
ok(created.toast.length > 0, `toast: "${created.toast.replace(/\\n/g,' ')}"`);

console.log('\n7. Approvals and analytics');
const appr = await s.eval(`
  location.hash = '#/approvals'; await new Promise(r=>setTimeout(r,1500));
  const rows = document.querySelectorAll('tr[data-booking]').length;
  const approveBtn = document.querySelector('[data-approve]');
  return { rows, hasApprove: !!approveBtn, first: document.querySelector('tr[data-booking]')?.innerText.replace(/\\s+/g,' ').slice(0,120) };
`);
console.log('  ', JSON.stringify(appr));
ok(appr.rows > 0, `${appr.rows} pending approvals listed`);
ok(appr.hasApprove, 'approve/reject actions available to the admin role');

const analytics = await s.eval(`
  location.hash = '#/analytics'; await new Promise(r=>setTimeout(r,2000));
  const v = document.getElementById('view');
  return {
    tiles: v.querySelectorAll('.stat').length,
    rows: v.querySelectorAll('tr[data-res]').length,
    bars: v.querySelectorAll('.bar-row').length,
    hb: v.querySelectorAll('.hbars .b').length,
    integrityOk: !!v.querySelector('.banner.ok'),
    text: v.querySelector('.banner.ok')?.innerText.replace(/\\s+/g,' ').slice(0,110) || v.innerText.slice(0,110),
  };
`);
console.log('  ', JSON.stringify(analytics));
ok(analytics.tiles >= 12, `${analytics.tiles} analytics tiles`);
ok(analytics.rows >= 15, `${analytics.rows} per-resource rows`);
ok(analytics.hb === 24, `24 hour buckets in the peak-time chart`);
ok(analytics.bars > 8, `${analytics.bars} bar rows across the distributions`);
ok(analytics.integrityOk, `integrity audit is clean: "${analytics.text}"`);

console.log('\n8. Timeline + detail modal');
const tl = await s.eval(`
  location.hash = '#/timeline'; await new Promise(r=>setTimeout(r,1800));
  const tracks = document.querySelectorAll('.tl-track').length;
  const blocks = document.querySelectorAll('.tl-blk').length;
  document.querySelector('#daytl, .card .tl-blk');
  return { tracks, blocks, head: document.querySelector('#view h1')?.innerText };
`);
console.log('  ', JSON.stringify(tl));
ok(tl.tracks > 10, `${tl.tracks} resource tracks on the timeline`);
ok(tl.blocks > 0, `${tl.blocks} booking blocks drawn`);

const modal = await s.eval(`
  location.hash = '#/resources'; await new Promise(r=>setTimeout(r,1500));
  document.querySelector('#results .res-card').click();
  await new Promise(r=>setTimeout(r,900));
  const m = document.querySelector('.overlay.open .modal');
  return { open: !!m, title: m?.querySelector('.modal-head h2')?.innerText || '', len: m?.innerHTML.length || 0 };
`);
console.log('  ', JSON.stringify(modal));
ok(modal.open && modal.len > 2000, `resource detail modal opens ("${modal.title}")`);

console.log('\n9. No console errors overall');
const realErrors = s.errors.filter((e) => !/favicon|net::ERR|Failed to load resource/i.test(e));
ok(realErrors.length === 0, realErrors.length ? `errors: ${realErrors.slice(0, 5).join(' || ')}` : 'clean console');
if (s.logs.length) console.log('\n   browser logs:', s.logs.slice(0, 6).join('\n   '));

s.close();
console.log(`\n${fails === 0 ? 'ALL BROWSER CHECKS PASSED' : `${fails} BROWSER CHECK(S) FAILED`}\n`);
process.exit(fails ? 1 : 0);
