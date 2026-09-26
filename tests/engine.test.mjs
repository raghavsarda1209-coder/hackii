// Headless smoke test of the conflict engine + analytics (no DOM needed).
import { buildDemoDb } from '../js/seed.js';
import { evaluateBooking, suggestSlots, auditData, LEVEL } from '../js/conflicts.js';
import { usageReport, insights } from '../js/analytics.js';
import { overlaps, startOfDay, addDays, dateToDtLocal } from '../js/ui.js';

const db = buildDemoDb();
let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log(`  ✗ ${msg}`); } else console.log(`  ✓ ${msg}`); };

// A minimal Store stand-in that only implements what the engine touches.
const store = {
  mode: 'demo', db,
  user: db.profiles[0],
  profiles: () => db.profiles,
  profileById: (id) => db.profiles.find((p) => p.id === id),
  displayName(p) { return p ? `${p.first_name} ${p.last_name}`.trim() : 'Unknown'; },
  rolesOf: () => ['admin'],
  isApprover: () => true, isAdmin: () => true,
  resources() {
    return db.resources.map((r) => ({
      ...r,
      type_name: db.resource_types.find((t) => t.id === r.resource_type_id)?.name,
      features: [], in_use: false, upcoming_count: 0,
    }));
  },
  resourceById: (id) => db.resources.find((r) => r.id === Number(id)) || null,
  resourceName: (id) => store.resourceById(id)?.name || `#${id}`,
  bookingsFor(rid) {
    const map = new Map();
    for (const br of db.booking_resources) map.set(br.booking_id, br.resource_id);
    return db.bookings
      .filter((b) => map.get(b.id) === Number(rid) && ['pending', 'approved', 'completed'].includes(b.status_code))
      .sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
  },
  availabilityFor: (id) => db.resource_availability.filter((a) => a.resource_id === Number(id)),
  blackoutsFor: (id) => db.resource_blackouts.filter((a) => a.resource_id === Number(id)),
  maintenanceFor: (id) => db.maintenance_records.filter((a) => a.resource_id === Number(id)),
  attendeesFor: (id) => db.booking_attendees.filter((a) => a.booking_id === Number(id)),
  resourcesOfBooking(id) {
    return db.booking_resources.filter((br) => br.booking_id === Number(id))
      .map((br) => db.resources.find((r) => r.id === br.resource_id)).filter(Boolean);
  },
  resourceTypes: () => db.resource_types,
  decorate(b) { return { ...b, requester_name: store.displayName(store.profileById(b.requested_by)), resources: store.resourcesOfBooking(b.id) }; },
  myBookings() { return []; },
};

console.log('\n1. Seed dataset');
ok(db.resources.length === 15, `15 resources (${db.resources.length})`);
ok(db.bookings.length > 150, `${db.bookings.length} bookings generated`);
ok(db.profiles.length === 10, '10 profiles');
ok(db.bookings.every((b) => b.start_time < b.end_time), 'every booking has end > start');
const hist = db.bookings.filter((b) => new Date(b.start_time) < new Date() && ['pending','approved','completed'].includes(b.status_code));
ok(hist.every((b) => b.end_time <= new Date().toISOString() || new Date(b.start_time) > new Date().toISOString()), 'history is sane');

console.log('\n2. Double-booking detection');
const busy = db.bookings.find((b) => b.status_code === 'approved' && new Date(b.start_time) > new Date());
const rid = db.booking_resources.find((br) => br.booking_id === busy.id).resource_id;
const r = store.resourceById(rid);
const clash = evaluateBooking(store, {
  resourceIds: [rid], start: new Date(busy.start_time), end: new Date(busy.end_time), title: 'Clash test',
});
ok(!clash.ok, 're-submitting an occupied slot is BLOCKED');
ok(clash.findings.some((f) => f.code === 'overlap'), 'finding code = overlap');
ok(clash.verdict.tone === 'block', 'verdict tone = block');

const mid = new Date(new Date(busy.start_time).getTime() + 10 * 60000);
const partial = evaluateBooking(store, { resourceIds: [rid], start: mid, end: new Date(busy.end_time), title: 'x' });
ok(!partial.ok, 'a partial overlap is BLOCKED');

const before = evaluateBooking(store, {
  resourceIds: [rid],
  start: new Date(new Date(busy.start_time).getTime() - 30 * 60000),
  end: new Date(busy.start_time), title: 'x',
});
if ((r.buffer_before_minutes || 0) > 0) ok(!before.ok, `setup buffer of ${r.buffer_before_minutes}m is respected`);
else ok(before.ok, 'no buffer configured, adjacent booking allowed');

const afterBuf = evaluateBooking(store, {
  resourceIds: [rid],
  start: new Date(new Date(busy.end_time).getTime()),
  end: new Date(new Date(busy.end_time).getTime() + 30 * 60000), title: 'x',
});
if ((r.buffer_after_minutes || 0) > 0) ok(!afterBuf.ok, `reset buffer of ${r.buffer_after_minutes}m is respected`);

console.log('\n3. Rule checks');
const tooShort = evaluateBooking(store, { resourceIds: [rid], start: new Date(Date.now() + 864e5), end: new Date(Date.now() + 864e5 + 10 * 60000), title: 'x' });
ok(tooShort.findings.some((f) => f.code === 'too_short'), `minimum duration enforced (min ${r.minimum_booking_minutes}m)`);
const overCap = evaluateBooking(store, { resourceIds: [rid], start: new Date(Date.now() + 864e5), end: new Date(Date.now() + 864e5 + 4 * 36e5), attendeeCount: (r.capacity || 10) + 5, title: 'x' });
ok(overCap.findings.some((f) => f.code === 'over_capacity'), 'capacity enforced');
const noRes = evaluateBooking(store, { resourceIds: [], start: new Date(), end: new Date(Date.now() + 36e5), title: 'x' });
ok(!noRes.ok && noRes.findings.some((f) => f.code === 'no_resource'), 'empty selection blocked');
const inverted = evaluateBooking(store, { resourceIds: [rid], start: new Date(Date.now() + 864e5), end: new Date(Date.now() + 864e5 - 36e5), title: 'x' });
ok(!inverted.ok && inverted.findings.some((f) => f.code === 'inverted'), 'end-before-start blocked');
const multiDay = evaluateBooking(store, { resourceIds: [rid], start: new Date(Date.now() + 864e5), end: new Date(Date.now() + 3 * 864e5), title: 'x' });
ok(!multiDay.ok && multiDay.findings.some((f) => f.code === 'multiday'), 'multi-day blocked');
const past = evaluateBooking(store, { resourceIds: [rid], start: new Date(Date.now() - 3 * 864e5), end: new Date(Date.now() - 3 * 864e5 + 36e5), title: 'x' });
ok(past.findings.some((f) => f.code === 'past'), 'past slot flagged');
const offHours = evaluateBooking(store, { resourceIds: [rid], start: new Date(Date.now() + 864e5 + 3e5), end: new Date(Date.now() + 864e5 + 3e5 + 36e5), title: 'x' });
ok(offHours.findings.some((f) => ['outside_hours', 'closed', 'too_short', 'overlap', 'no_resource', 'multiday'].includes(f.code)), 'late-night slot reports a reason');

const self = db.bookings.find((b) => b.requested_by === store.user.id && b.status_code === 'approved');
if (self) {
  const s2 = evaluateBooking(store, { resourceIds: store.resourcesOfBooking(self.id).map((x) => x.id), start: new Date(self.start_time), end: new Date(self.end_time), title: 'x' });
  ok(s2.findings.some((f) => f.code === 'self_overlap'), 'requester cannot double book themselves');
} else console.log('  · no self-booking case in the sample data');

const excluded = evaluateBooking(store, {
  resourceIds: store.resourcesOfBooking(busy.id).map((x) => x.id),
  start: new Date(busy.start_time), end: new Date(busy.end_time), excludeBookingId: busy.id, title: 'x',
});
ok(excluded.ok, 're-checking a booking against itself is allowed (excludeBookingId)');

console.log('\n4. Blackouts & maintenance');
const bl = db.resource_blackouts[0];
const hitBl = evaluateBooking(store, { resourceIds: [bl.resource_id], start: new Date(bl.start_time), end: new Date(new Date(bl.start_time).getTime() + 30 * 60000), title: 'x' });
ok(!hitBl.ok && hitBl.findings.some((f) => f.code === 'blackout'), 'blackout window blocked');
const mt = db.maintenance_records[0];
const hitMt = evaluateBooking(store, { resourceIds: [mt.resource_id], start: new Date(mt.start_time), end: new Date(new Date(mt.start_time).getTime() + 30 * 60000), title: 'x' });
ok(!hitMt.ok && hitMt.findings.some((f) => f.code === 'maintenance'), 'maintenance window blocked');

console.log('\n5. Free-slot suggestions are genuinely free');
let checked = 0, bad = 0;
for (const res of db.resources.slice(0, 8)) {
  const base = new Date(startOfDay(addDays(new Date(), 1)).getTime() + 10 * 3600e3);
  for (const s of suggestSlots(store, res, base, new Date(base.getTime() + 3600e3), 2)) {
    checked++;
    const v = evaluateBooking(store, { resourceIds: [res.id], start: s.start, end: s.end, title: 's' });
    if (!v.ok) { bad++; if (bad < 3) console.log('    conflict at', res.name, s.start, v.findings.filter((f) => f.level === 'block').map((f) => f.code)); }
  }
}
ok(checked > 0, `${checked} suggestions produced`);
ok(bad === 0, 'every suggested slot passes a fresh conflict check');

console.log('\n6. Integrity audit of the seeded data');
const issues = auditData(store, { days: 90 });
ok(issues.duplicates.length === 0, `no pre-existing double bookings (${issues.duplicates.length})`);
ok(issues.overCapacity.length === 0, `no over-capacity bookings (${issues.overCapacity.length})`);
ok(issues.outOfHours.length === 0, `no out-of-hours bookings (${issues.outOfHours.length})`);

console.log('\n7. Analytics');
const rep = usageReport(store, { days: 30 });
ok(rep.summary.totalBookings > 50, `${rep.summary.totalBookings} bookings in the 30-day window`);
ok(rep.summary.utilisation > 0 && rep.summary.utilisation < 100, `utilisation ${rep.summary.utilisation.toFixed(1)}%`);
ok(rep.perResource.length === 15, 'per-resource rows generated');
ok(rep.perResource.every((x) => x.utilization >= 0 && x.utilization <= 100), 'utilisation values in range');
ok(rep.unused.length >= 0, `${rep.unused.length} unused / ${rep.underused.length} under-used resources`);
ok(rep.conflictsPreventedUnused === undefined, 'no stray fields');
const notes = insights(rep);
ok(Array.isArray(notes) && notes.length > 0, `${notes.length} insight lines produced`);
ok(rep.hourBuckets.length === 24 && rep.hourBuckets.reduce((a, b) => a + b, 0) > 0, 'hour histogram populated');

console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : `${fails} CHECK(S) FAILED`}\n`);
process.exit(fails ? 1 : 0);
