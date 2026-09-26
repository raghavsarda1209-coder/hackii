import { BLOCKING_STATUSES, DAY_SHORT } from './config.js';
import { fmtDate, fmtRange, fmtDuration, timeToMin, overlaps, MIN } from './ui.js';

/**
 * ===========================================================================
 * Conflict / rule engine
 * ===========================================================================
 * Runs a full pre-flight check on a requested booking and returns a verdict
 * plus an itemised list of findings. `block` findings make submission
 * impossible, `warn` findings need an acknowledgement, `info` are FYI.
 *
 * Every blocking rule is re-evaluated server-side by sql/overlap_guard.sql
 * (an EXCLUDE constraint) so concurrent requests can never double book.
 */

export const LEVEL = { BLOCK: 'block', WARN: 'warn', INFO: 'info' };

function f(level, code, title, message, extra = {}) {
  return { level, code, title, message, ...extra };
}

/**
 * @param {import('./store.js').store} store
 * @param {object} req
 * @param {number[]} req.resourceIds
 * @param {Date} req.start
 * @param {Date} req.end
 * @param {number} [req.excludeBookingId]  ignore this booking (edit / re-check)
 * @param {number} [req.attendeeCount]
 * @param {boolean} [req.isOwnBookingRequesterCheck]
 */
export function evaluateBooking(store, req) {
  const {
    resourceIds = [], start, end, excludeBookingId = null,
    attendeeCount = null, title = '',
  } = req;

  const findings = [];
  const now = new Date();

  // ---------------------------------------------------------- 1. shape ---
  if (!title || !title.trim()) {
    findings.push(f(LEVEL.WARN, 'title', 'Missing title', 'Give the booking a recognisable title so others know what the slot is for.'));
  }
  if (!resourceIds.length) {
    findings.push(f(LEVEL.BLOCK, 'no_resource', 'No resource selected', 'Pick at least one room, lab or item to reserve.'));
  }
  if (!start || !end || Number.isNaN(+start) || Number.isNaN(+end)) {
    findings.push(f(LEVEL.BLOCK, 'bad_time', 'Invalid time', 'Both a start and an end time are required.'));
    return { ok: false, findings, verdict: verdictOf(findings), durationMs: 0 };
  }

  const durationMs = end - start;

  if (end <= start) {
    findings.push(f(LEVEL.BLOCK, 'inverted', 'End before start', 'The end time must be after the start time.'));
  }
  if (start.toDateString() !== end.toDateString()) {
    findings.push(f(LEVEL.BLOCK, 'multiday', 'Spans multiple days', 'Bookings are single-day. Split it into separate requests.'));
  }
  if (start < now) {
    findings.push(f(LEVEL.WARN, 'past', 'Start time is in the past', `${fmtRange(start, end)} has already begun. Only administrative corrections are allowed.`));
  }
  if (start.getTime() - now.getTime() < 15 * MIN) {
    findings.push(f(LEVEL.WARN, 'imminent', 'Starting within 15 minutes', 'Very short notice - an approver may not see this in time.'));
  }

  const resources = resourceIds.map((id) => store.resourceById(id)).filter(Boolean);
  const missing = resourceIds.length - resources.length;
  if (missing) findings.push(f(LEVEL.BLOCK, 'missing_resource', 'Unknown resource', `${missing} selected resource(s) no longer exist.`));

  if (!findings.some((x) => x.level === LEVEL.BLOCK && ['bad_time', 'inverted', 'multiday', 'no_resource'].includes(x.code))) {
    for (const r of resources) {
      findings.push(...checkResource(store, r, start, end, durationMs, excludeBookingId, attendeeCount));
    }
    findings.push(...checkRequester(store, start, end, excludeBookingId));
  }

  return {
    ok: !findings.some((x) => x.level === LEVEL.BLOCK),
    findings: findings.sort((a, b) => rank(a.level) - rank(b.level)),
    verdict: verdictOf(findings),
    durationMs,
    durationLabel: fmtDuration(durationMs),
  };
}

const rank = (l) => ({ block: 0, warn: 1, info: 2 })[l] ?? 3;

function verdictOf(findings) {
  const blocks = findings.filter((x) => x.level === LEVEL.BLOCK);
  const warns = findings.filter((x) => x.level === LEVEL.WARN);
  if (blocks.length) return { tone: 'block', label: `${blocks.length} blocking conflict${blocks.length > 1 ? 's' : ''} - this slot cannot be booked`, icon: '⛔' };
  if (warns.length) return { tone: 'warn', label: `Bookable with ${warns.length} caution${warns.length > 1 ? 's' : ''}`, icon: '⚠️' };
  return { tone: 'ok', label: 'No conflicts detected - slot is free', icon: '✅' };
}

// ------------------------------------------------------------ per-resource
function checkResource(store, r, start, end, durationMs, excludeBookingId, attendeeCount) {
  const out = [];
  if (!r) return out;
  const tag = r.name;

  if (!r.is_active) {
    out.push(f(LEVEL.BLOCK, 'inactive', `${tag} is out of service`, 'This resource has been deactivated. Book an alternative or ask facilities to reactivate it.', { resourceId: r.id }));
    return out;
  }
  if (!r.is_bookable) {
    out.push(f(LEVEL.BLOCK, 'not_bookable', `${tag} is not bookable`, 'It is reserved for internal operations.', { resourceId: r.id }));
    return out;
  }

  // -- duration limits
  const mins = durationMs / MIN;
  if (mins < r.minimum_booking_minutes) {
    out.push(f(LEVEL.BLOCK, 'too_short', `Too short for ${tag}`,
      `Minimum booking length here is ${r.minimum_booking_minutes} minutes (you asked for ${Math.round(mins)}).`, { resourceId: r.id }));
  }
  if (r.maximum_booking_minutes && mins > r.maximum_booking_minutes) {
    out.push(f(LEVEL.BLOCK, 'too_long', `Too long for ${tag}`,
      `Maximum booking length here is ${r.maximum_booking_minutes} minutes (you asked for ${Math.round(mins)}). Split it into consecutive sessions.`, { resourceId: r.id }));
  }

  // -- weekly availability window (day_of_week 0 = Sunday)
  const windows = store.availabilityFor(r.id);
  if (windows.length) {
    const dow = start.getDay();
    const todays = windows.filter((w) => w.day_of_week === dow && w.is_available);
    if (!todays.length) {
      out.push(f(LEVEL.BLOCK, 'closed', `${tag} is closed on ${DAY_SHORT[dow]}`,
        `Its published hours are ${windows.map((w) => DAY_SHORT[w.day_of_week]).join(', ')}.`, { resourceId: r.id }));
    } else {
      const sMin = start.getHours() * 60 + start.getMinutes();
      const eMin = end.getHours() * 60 + end.getMinutes();
      const inside = todays.some((w) => sMin >= timeToMin(w.start_time) && eMin <= timeToMin(w.end_time));
      if (!inside) {
        const hours = todays.map((w) => `${String(w.start_time).slice(0, 5)}-${String(w.end_time).slice(0, 5)}`).join(', ');
        out.push(f(LEVEL.BLOCK, 'outside_hours', `Outside opening hours for ${tag}`,
          `On ${DAY_SHORT[dow]} this resource is open ${hours}.`, { resourceId: r.id }));
      }
    }
  }

  // -- overlapping bookings, with turnaround buffers on BOTH sides
  const bb = r.buffer_before_minutes || 0;
  const ba = r.buffer_after_minutes || 0;
  const reqStart = start.getTime() - bb * MIN;
  const reqEnd = end.getTime() + ba * MIN;

  for (const b of store.bookingsFor(r.id)) {
    if (excludeBookingId && b.id === Number(excludeBookingId)) continue;
    if (!BLOCKING_STATUSES.includes(b.status_code)) continue;
    const bStart = new Date(b.start_time).getTime() - (b.buffer_before_minutes || 0) * MIN;
    const bEnd = new Date(b.end_time).getTime() + (b.buffer_after_minutes || 0) * MIN;
    if (overlaps(reqStart, reqEnd, bStart, bEnd)) {
      const pending = b.status_code === 'pending';
      const requester = store.decorate(b).requester_name;
      const buffNote = (bb || ba) ? ` Including the ${[bb ? `${bb}m setup before` : null, ba ? `${ba}m reset after` : null].filter(Boolean).join(' and ')} this resource needs.` : '';
      out.push(f(LEVEL.BLOCK, 'overlap', `Double booking: ${tag}`,
        `${b.booking_reference} (${requester}) already holds ${fmtRange(b.start_time, b.end_time)} - status ${b.status_code}.${buffNote}`,
        {
          resourceId: r.id, bookingId: b.id, status: b.status_code,
          suggest: suggestSlots(store, r, start, end, 1),
        }));
      if (pending) {
        out.push(f(LEVEL.INFO, 'pending_hold', `${b.booking_reference} is still awaiting approval`,
          'Pending requests hold the slot so nobody else can take it. The approver can free it if this request is more important.', { resourceId: r.id }));
      }
    }
  }

  // -- blackouts
  for (const bl of store.blackoutsFor(r.id)) {
    if (overlaps(reqStart, reqEnd, new Date(bl.start_time).getTime(), new Date(bl.end_time).getTime())) {
      out.push(f(LEVEL.BLOCK, 'blackout', `${tag} is blocked`,
        `${fmtRange(bl.start_time, bl.end_time)} - ${bl.reason}.`, { resourceId: r.id }));
    }
  }

  // -- maintenance
  for (const m of store.maintenanceFor(r.id)) {
    if (m.status === 'cancelled') continue;
    const mEnd = m.end_time ? new Date(m.end_time).getTime() : Number.POSITIVE_INFINITY;
    if (overlaps(reqStart, reqEnd, new Date(m.start_time).getTime(), mEnd)) {
      out.push(f(LEVEL.BLOCK, 'maintenance', `Maintenance on ${tag}`,
        `${m.title} (${m.status.replace('_', ' ')}) ${fmtRange(m.start_time, m.end_time || start)}.`, { resourceId: r.id }));
    }
  }

  // -- capacity
  if (attendeeCount && r.capacity) {
    if (attendeeCount > r.capacity) {
      out.push(f(LEVEL.BLOCK, 'over_capacity', `Over capacity for ${tag}`,
        `This resource seats ${r.capacity}; you entered ${attendeeCount}. Reduce the headcount or pick a larger space.`, { resourceId: r.id }));
    } else if (attendeeCount > r.capacity * 0.9) {
      out.push(f(LEVEL.WARN, 'near_capacity', `Close to capacity for ${tag}`,
        `${attendeeCount} of ${r.capacity} seats - check the layout suits the activity.`, { resourceId: r.id }));
    }
  }

  // -- approval requirement
  if (r.requires_approval) {
    out.push(f(LEVEL.INFO, 'needs_approval', `${tag} needs approval`,
      'The request will be created as Pending and routed to an approver. The slot is held meanwhile so it cannot be taken.', { resourceId: r.id }));
  }

  // -- soft signal: this slot is the tail end of the day / odd hours
  const h = start.getHours();
  if (h < 7) out.push(f(LEVEL.WARN, 'early', 'Very early start', 'Bookings before 07:00 are outside normal campus hours.', { resourceId: r.id }));
  if (h >= 19) out.push(f(LEVEL.WARN, 'late', 'Late evening slot', 'Bookings after 19:00 need extended-hours approval.', { resourceId: r.id }));

  return out;
}

/** Does the requester already have a different booking at the same time? */
function checkRequester(store, start, end, excludeBookingId) {
  const out = [];
  const mine = (store.db.bookings || []).filter((b) =>
    b.requested_by === store.user?.id &&
    b.id !== Number(excludeBookingId || 0) &&
    BLOCKING_STATUSES.includes(b.status_code));
  for (const b of mine) {
    if (overlaps(+start, +end, new Date(b.start_time).getTime(), new Date(b.end_time).getTime())) {
      out.push(f(LEVEL.BLOCK, 'self_overlap', 'You are already booked then',
        `${b.booking_reference} - "${b.title}" runs ${fmtRange(b.start_time, b.end_time)}. Release it first or pick another time.`, { bookingId: b.id }));
    }
  }
  return out;
}

// ------------------------------------------------------------ suggestions
/**
 * Find the nearest free windows of the same length on the same day.
 * Powers "no double booking" recovery instead of just saying no.
 */
export function suggestSlots(store, resource, start, end, count = 3) {
  if (!resource) return [];

  // Clamp the requested length into what this resource actually accepts, so a
  // suggestion can never come back with a duration the engine would reject.
  let dur = end - start;
  const minMs = (resource.minimum_booking_minutes || 0) * MIN;
  const maxMs = resource.maximum_booking_minutes ? resource.maximum_booking_minutes * MIN : Infinity;
  if (dur < minMs) dur = minMs;
  if (dur > maxMs) dur = maxMs;

  const out = [];
  const windows = store.availabilityFor(resource.id);
  const busy = store.bookingsFor(resource.id)
    .map((b) => [new Date(b.start_time).getTime() - (b.buffer_before_minutes || 0) * MIN,
                  new Date(b.end_time).getTime() + (b.buffer_after_minutes || 0) * MIN]);
  const blocked = [
    ...store.blackoutsFor(resource.id).map((b) => [+new Date(b.start_time), +new Date(b.end_time)]),
    ...store.maintenanceFor(resource.id).filter((m) => m.status !== 'cancelled')
      .map((m) => [+new Date(m.start_time), m.end_time ? +new Date(m.end_time) : Number.POSITIVE_INFINITY]),
  ];
  const startMin = start.getHours() * 60 + start.getMinutes();
  const cand = [];
  for (let d = 0; d < 14; d++) {
    const day = new Date(start); day.setDate(day.getDate() + d);
    const dow = day.getDay();
    const todays = windows.length ? windows.filter((w) => w.day_of_week === dow && w.is_available) : [];
    if (windows.length && !todays.length) continue;
    const open = todays.length ? todays.map((w) => [timeToMin(w.start_time), timeToMin(w.end_time)]) : [[8 * 60, 18 * 60]];
    for (const [o, c] of open) {
      for (let m = o; m + Math.round(dur / MIN) <= c; m += 30) {
        const s = new Date(day); s.setHours(Math.floor(m / 60), m % 60, 0, 0);
        const e = new Date(s.getTime() + dur);
        if (s < new Date()) continue;
        const ss = s.getTime() - (resource.buffer_before_minutes || 0) * MIN;
        const se = e.getTime() + (resource.buffer_after_minutes || 0) * MIN;
        if (busy.some(([a, b]) => overlaps(ss, se, a, b))) continue;
        if (blocked.some(([a, b]) => overlaps(ss, se, a, b))) continue;
        const drift = Math.abs(m - startMin) + d * 24 * 20;   // prefer same time-of-day, then same day
        cand.push({ start: s, end: e, drift });
      }
    }
    if (cand.length > 400) break;
  }
  cand.sort((a, b) => a.drift - b.drift);
  for (const c of cand.slice(0, count)) out.push(c);
  return out;
}

/**
 * Audit every (resource, date) pair against the catalogue and report
 * catalogue-level integrity problems: double bookings that already exist,
 * bookings outside opening hours, and over-capacity bookings.
 */
export function auditData(store, { days = 60 } = {}) {
  const since = Date.now() - days * 86400000;
  const issues = { duplicates: [], outOfHours: [], overCapacity: [], orphanBookings: [] };

  const byResDate = new Map();
  for (const b of store.db.bookings || []) {
    if (!BLOCKING_STATUSES.includes(b.status_code)) continue;
    const s = new Date(b.start_time);
    if (s.getTime() < since) continue;
    for (const r of store.resourcesOfBooking(b.id)) {
      const key = `${r.id}|${s.toDateString()}`;
      if (!byResDate.has(key)) byResDate.set(key, []);
      byResDate.get(key).push({ b, r });
    }
  }
  for (const [, list] of byResDate) {
    list.sort((a, b) => new Date(a.b.start_time) - new Date(b.b.start_time));
    for (let i = 0; i < list.length - 1; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (overlaps(+new Date(list[i].b.start_time), +new Date(list[i].b.end_time),
                     +new Date(list[j].b.start_time), +new Date(list[j].b.end_time))) {
          issues.duplicates.push({ resource: list[i].r.name, a: store.decorate(list[i].b), b: store.decorate(list[j].b) });
        }
      }
    }
  }
  for (const b of store.db.bookings || []) {
    if (!BLOCKING_STATUSES.includes(b.status_code)) continue;
    const s = new Date(b.start_time);
    if (s.getTime() < since) continue;
    for (const r of store.resourcesOfBooking(b.id)) {
      if (b.attendee_count && r.capacity && b.attendee_count > r.capacity) {
        issues.overCapacity.push({ resource: r.name, b: store.decorate(b) });
      }
      const wins = store.availabilityFor(r.id).filter((w) => w.day_of_week === s.getDay() && w.is_available);
      if (wins.length) {
        const sm = s.getHours() * 60 + s.getMinutes();
        const em = new Date(b.end_time).getHours() * 60 + new Date(b.end_time).getMinutes();
        if (!wins.some((w) => sm >= timeToMin(w.start_time) && em <= timeToMin(w.end_time))) {
          issues.outOfHours.push({ resource: r.name, b: store.decorate(b) });
        }
      }
    }
  }
  const ids = new Set((store.db.booking_resources || []).map((b) => b.booking_id));
  for (const b of store.db.bookings || []) if (!ids.has(b.id)) issues.orphanBookings.push(store.decorate(b));

  return issues;
}

/** Render findings as HTML (shared by the booking wizard and booking detail). */
export function renderFindings(findings) {
  if (!findings.length) return '';
  const icon = { block: '⛔', warn: '⚠️', info: 'ℹ️', ok: '✅' };
  return findings.map((x) => `
    <div class="conflict ${x.level}">
      <span class="ic">${icon[x.level] || '•'}</span>
      <div><b>${escapeHtml(x.title)}</b><p>${escapeHtml(x.message)}</p></div>
    </div>`).join('');
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
