// Diagnostic: boot the page and dump every console message / exception.
const BASE = process.argv[2] || 'http://127.0.0.1:8777/';
const CDP = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const r = await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: 'PUT' });
const t = await r.json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0; const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled') {
    console.log(`[console.${m.params.type}]`, (m.params.args || []).map((a) => a.value ?? a.description ?? JSON.stringify(a.preview || '')).join(' '));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    console.log('[exception]', d.exception?.description || d.text, '\n   at', d.url, d.lineNumber);
  }
  if (m.method === 'Log.entryAdded') console.log(`[log.${m.params.entry.level}]`, m.params.entry.text, m.params.entry.url || '');
  if (m.method === 'Network.loadingFailed') console.log('[net fail]', m.params.errorText, m.params.type);
};
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

await send('Runtime.enable');
await send('Log.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.enable');
await sleep(8000);

const res2 = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    title: document.title,
    authHidden: document.getElementById('auth').hidden,
    authHTML: document.getElementById('auth').innerHTML.length,
    appClass: document.getElementById('app').className,
    viewLen: document.getElementById('view').innerHTML.length,
    navLen: document.getElementById('nav').innerHTML.length,
    mode: localStorage.getItem('campusbook.state.v1'),
    scripts: [...document.scripts].map(s => s.src || 'inline'),
  }, null, 1)`,
  returnByValue: true,
});
console.log('\nDOM:', res2.result?.result?.value || JSON.stringify(res2));
ws.close();
process.exit(0);
