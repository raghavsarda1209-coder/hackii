import { DAY_SHORT, STATUS } from './config.js';
import { HOUR, DAY, startOfDay, fmtHours, fmtDuration, fmtDate } from './ui.js';

/**
 * Resource-usage analytics.
 * Everything is derived from bookings / attendees / audit logs that are
 * already in memory, so the same code works live and in demo mode.
 */
export function usageReport(store, { days = 30 } = {}) {
  const now = Date.now();
  const from = now - days * DAY;
  const resources = store.resources({ includeInactive: true });
  const all = store.db.bookings || [];
  const countStatuses = new Set([STATUS.APPROVED, STATUS.COMPLETED, STATUS.PENDING]);

  const inWindow = all.filter((b) => {
    const t = new Date(b.start_time).getTime();
    return t >= from && t <= now + 45 * DAY;
  });
  const held = inWindow.filter((b) => countStatuses.has(b.status_code));

  // ------------------------------------------------- per-resource metrics
  const perResource = resources.map((r) => {
    const mine = store.bookingsFor(r.id).filter((b) => {
      const t = new Date(b.start_time).getTime();
      return t >= from - 45 * DAY;
    });
    const past = mine.filter((b) => new Date(b.start_time).getTime() < now);
    const bookedMs = past.reduce((s, b) => s + (new Date(b.end_time) - new Date(b.start_time)), 0);

    // available capacity in the window
    const windows = store.availabilityFor(r.id);
    let availableMs = 0;
    if (windows.length) {
      const firstDay = new Date(from);
      for (let d = 0; d < days; d++) {
        const day = startOfDay(new Date(firstDay.getTime() + d * DAY));
        const ws = windows.filter((w) => w.day_of_week === day.getDay() && w.is_available);
        for (const w of ws) availableMs += (timeMin(w.end_time) - timeMin(w.start_time)) * 60000;
      }
    } else {
      availableMs = 10 * HOUR * 5 * days;   // assumed 10h x 5d when unspecified
    }

    const pastBookings = mine.filter((b) => b.status_code === STATUS.COMPLETED);
    const attendeeIds = pastBookings.flatMap((b) => store.attendeesFor(b.id).map((a) => a.id));
    const attendees = attendeeIds.map((id) => (store.db.booking_attendees || []).find((a) => a.id === id)).filter(Boolean);
    const noShows = attendees.filter((a) => a.attendance_status === 'absent').length;

    const upcoming = mine.filter((b) => new Date(b.start_time).getTime() >= now);
    const cancelled = mine.filter((b) => b.status_code === STATUS.CANCELLED);

    return {
      resource: r,
      bookings: mine.length,
      pastBookings: past.length,
      upcoming: upcoming.length,
      cancelled: cancelled.length,
      bookedMs,
      availableMs,
      utilization: availableMs ? Math.min(100, (bookedMs / availableMs) * 100) : 0,
      avgDuration: past.length ? bookedMs / past.length : 0,
      lastBookedAt: past.length ? past.map((b) => b.start_time).sort().at(-1) : null,
      attendeeCount: attendees.length,
      noShowRate: attendees.length ? (noShows / attendees.length) * 100 : null,
      isBookable: r.is_bookable && r.is_active,
    };
  });

  perResource.sort((a, b) => b.utilization - a.utilization);

  const unused = perResource.filter((x) => x.isBookable && x.bookings === 0);
  const underused = perResource.filter((x) => x.isBookable && x.bookings > 0 && x.utilization < 10);
  const overused = perResource.filter((x) => x.utilization >= 70);
  const dormant = perResource.filter((x) => !x.isBookable);

  // ------------------------------------------------------------ summary
  const totalBookedMs = perResource.reduce((s, x) => s + x.bookedMs, 0);
  const totalAvailableMs = perResource.reduce((s, x) => s + x.availableMs, 0);
  const utilisation = totalAvailableMs ? (totalBookedMs / totalAvailableMs) * 100 : 0;

  const attendees = (store.db.booking_attendees || []).filter((a) => {
    const b = (store.db.bookings || []).find((x) => x.id === a.booking_id);
    return b && ['completed', 'approved'].includes(b.status_code);
  });
  const noShows = attendees.filter((a) => a.attendance_status === 'absent').length;
  const attended = attendees.filter((a) => a.attendance_status === 'attended').length;

  const cancelledCount = inWindow.filter((b) => b.status_code === STATUS.CANCELLED).length;
  const rejectedCount = inWindow.filter((b) => b.status_code === STATUS.REJECTED).length;

  // approval turnaround
  const decided = inWindow.filter((b) => b.approved_at);
  const turnarounds = decided.map((b) => new Date(b.approved_at) - new Date(b.created_at)).filter((n) => n >= 0);
  const avgTurnaround = turnarounds.length ? turnarounds.reduce((a, b) => a + b, 0) / turnarounds.length : 0;

  // conflicts prevented (from audit log)
  const conflictsPrevented = (store.db.audit_logs || []).filter((l) => l.action === 'booking.conflict_blocked').length;

  // ------------------------------------------------------- distributions
  const hourBuckets = Array.from({ length: 24 }, () => 0);
  for (const b of held) hourBuckets[new Date(b.start_time).getHours()] += 1;

  const dayBuckets = Array.from({ length: 7 }, () => 0);
  for (const b of held) dayBuckets[new Date(b.start_time).getDay()] += 1;

  const typeBuckets = new Map();
  for (const b of held) {
    for (const r of store.resourcesOfBooking(b.id)) {
      const t = store.resourceTypes().find((x) => x.id === r.resource_type_id)?.name || 'Other';
      typeBuckets.set(t, (typeBuckets.get(t) || 0) + 1);
    }
  }

  const statusBuckets = { pending: 0, approved: 0, rejected: 0, cancelled: 0, completed: 0 };
  for (const b of inWindow) if (statusBuckets[b.status_code] !== undefined) statusBuckets[b.status_code] += 1;

  // ------------------------------------------------------- today's board
  const today = startOfDay(new Date());
  const tomorrow = new Date(today.getTime() + DAY);
  const todayBookings = held
    .filter((b) => new Date(b.start_time) >= today && new Date(b.start_time) < tomorrow)
    .map((b) => store.decorate(b))
    .sort((a, b) => new Date(a.start_time) - new Date(b.start_time));

  return {
    windowDays: days,
    summary: {
      totalBookings: inWindow.length,
      heldBookings: held.length,
      utilisation,
      bookedHours: totalBookedMs / HOUR,
      capacityHours: totalAvailableMs / HOUR,
      unusedCount: unused.length,
      underusedCount: underused.length,
      overusedCount: overused.length,
      resourceCount: perResource.length,
      bookableCount: perResource.filter((x) => x.isBookable).length,
      noShowRate: attendees.length ? (noShows / attendees.length) * 100 : 0,
      attendanceRate: attendees.length ? (attended / attendees.length) * 100 : 0,
      cancellationRate: inWindow.length ? (cancelledCount / inWindow.length) * 100 : 0,
      rejectionRate: inWindow.length ? (rejectedCount / inWindow.length) * 100 : 0,
      avgTurnaround,
      avgDuration: held.length ? held.reduce((s, b) => s + (new Date(b.end_time) - new Date(b.start_time)), 0) / held.length : 0,
      conflictsPrevented,
      totalHeadcount: held.reduce((s, b) => s + (b.attendee_count || 0), 0),
    },
    perResource, unused, underused, overused, dormant,
    hourBuckets, dayBuckets,
    typeBuckets: [...typeBuckets.entries()].sort((a, b) => b[1] - a[1]),
    statusBuckets, todayBookings,
  };
}

function timeMin(t) {
  const [h, m] = String(t).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Insight lines the dashboard surfaces, derived from the report. */
export function insights(report) {
  const s = report.summary;
  const out = [];
  if (s.utilisation < 30) {
    out.push({ tone: 'warn', icon: '📉', text: `Campus utilisation is only ${s.utilisation.toFixed(1)}% over ${report.windowDays} days. ${report.unusedCount} resource(s) had zero bookings.` });
  }
  const peakIdx = report.hourBuckets.indexOf(Math.max(...report.hourBuckets));
  if (report.hourBuckets.some(Boolean)) {
    out.push({ tone: 'info', icon: '⏰', text: `Busiest start time is ${String(peakIdx).padStart(2, '0')}:00 with ${report.hourBuckets[peakIdx]} booking(s).` });
  }
  if (s.noShowRate > 15) {
    out.push({ tone: 'warn', icon: '👤', text: `No-show rate is ${s.noShowRate.toFixed(0)}%. Reminders before start are recommended.` });
  }
  if (s.avgTurnaround) {
    out.push({ tone: 'ok', icon: '⚡', text: `Average approval turnaround is ${fmtDuration(s.avgTurnaround)}.` });
  }
  if (report.overused.length) {
    out.push({ tone: 'warn', icon: '🔥', text: `${report.overused.length} resource(s) above 70% utilisation - consider adding capacity or time slots.` });
  }
  if (s.conflictsPrevented) {
    out.push({ tone: 'ok', icon: '🛡️', text: `${s.conflictsPrevented} double-booking attempt(s) blocked automatically by the conflict engine.` });
  }
  return out;
}

/** Flat rows for CSV export of a usage report. */
export function usageCsvRows(report) {
  return [
    ['Resource', 'Code', 'Type', 'Building', 'Capacity', 'Bookable', 'Bookings', 'Booked hours', 'Available hours', 'Utilisation %', 'No-show %', 'Last booked'],
    ...report.perResource.map((x) => [
      x.resource.name, x.resource.code, x.resource.type_name, x.resource.building_name || '',
      x.resource.capacity ?? '', x.resource.is_bookable && x.resource.is_active ? 'yes' : 'no',
      x.bookings, (x.bookedMs / HOUR).toFixed(2), (x.availableMs / HOUR).toFixed(2),
      x.utilization.toFixed(1), x.noShowRate === null ? '' : x.noShowRate.toFixed(1),
      x.lastBookedAt ? fmtDate(x.lastBookedAt) : 'never',
    ]),
  ];
}

export { fmtHours, DAY_SHORT };
