import { store } from './store.js';
import { toast } from './ui.js';

/** Minimal hash router. */
const routes = new Map();
let current = null;
let mount = null;
let onRender = null;

export function register(name, def) { routes.set(name, def); }
export function go(name, params = {}) {
  const q = new URLSearchParams(params).toString();
  location.hash = `#/${name}${q ? `?${q}` : ''}`;
}
export function currentRoute() { return current; }

export function startRouter(el, afterRender) {
  mount = el;
  onRender = afterRender;
  window.addEventListener('hashchange', route);
  route();
}

function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [name, qs] = h.split('?');
  return { name: name || 'dashboard', params: Object.fromEntries(new URLSearchParams(qs || '')) };
}

async function route() {
  if (!mount) return;
  const { name, params } = parseHash();
  const def = routes.get(name) || routes.get('dashboard');
  current = { name: def.name, params };
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === def.name));
  mount.scrollTop = 0;
  window.scrollTo(0, 0);
  try {
    const html = await def.render(params);
    mount.innerHTML = html;
    if (def.after) def.after(mount, params);
    if (onRender) onRender(def.name);
  } catch (err) {
    console.error(err);
    mount.innerHTML = `<div class="banner err"><span>💥</span><span><b>Something broke rendering this view.</b><br>${err.message}</span></div>`;
    toast('View failed to render', 'err', err.message);
  }
}

export function refresh() { route(); }
