import { store } from '../store.js';
import { esc, fmtAgo, fmtDateTime, emptyState, openModal, toast } from '../ui.js';
import { pageHead } from './common.js';
import { openDetail } from './bookings.js';
import { go } from '../router.js';

export function render() {
  const list = store.notifications();
  const unread = list.filter((n) => !n.is_read);
  return `
    ${pageHead('Notifications', `${unread.length} unread of ${list.length}`, `
      ${unread.length ? '<button class="btn btn-ghost btn-sm" id="readAll">Mark all read</button>' : ''}`)}
    <div class="card">
      ${list.length ? list.map((n) => `
        <div class="flex between" data-note="${n.id}" style="padding:11px 4px;border-bottom:1px solid var(--line);cursor:pointer;${n.is_read ? 'opacity:.62' : ''}">
          <div class="flex" style="align-items:flex-start">
            <span class="avatar ${iconTone(n.type)}">${icon(n.type)}</span>
            <div>
              <b>${esc(n.title)}</b>
              <div class="small">${esc(n.message)}</div>
              <div class="small muted" title="${esc(fmtDateTime(n.created_at))}">${esc(fmtAgo(n.created_at))}</div>
            </div>
          </div>
          <div class="rowacts">
            ${!n.is_read ? '<span class="pill coral">new</span>' : ''}
            ${n.booking_id ? `<button class="btn btn-ghost btn-sm" data-open="${n.booking_id}">Open</button>` : ''}
          </div>
        </div>`).join('')
        : emptyState('🔔', 'No notifications', 'Approval requests and booking updates will appear here.')}
    </div>`;
}

function icon(type) {
  if (type.includes('approv')) return '✅';
  if (type.includes('reject') || type.includes('cancel')) return '⛔';
  if (type.includes('book')) return '📅';
  if (type.includes('maint')) return '🔧';
  if (type.includes('conflict')) return '🛡️';
  return 'ℹ️';
}
function iconTone(type) {
  if (type.includes('approv')) return 'g';
  if (type.includes('reject') || type.includes('cancel') || type.includes('conflict')) return 'c';
  return '';
}

export function after(root) {
  root.querySelector('#readAll')?.addEventListener('click', async () => {
    await store.markAllNotificationsRead();
    toast('All notifications marked read');
  });
  root.querySelectorAll('[data-open]').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); openDetail(Number(b.dataset.open)); };
  });
  root.querySelectorAll('[data-note]').forEach((row) => {
    row.onclick = async () => {
      await store.markNotificationRead(Number(row.dataset.note));
      const id = Number(row.querySelector('[data-open]')?.dataset.open);
      if (id) openDetail(id);
    };
  });
}
