import { STATUS, STORAGE_KEY } from './config.js';
import { addDays, startOfDay, timeToMin } from './ui.js';

// ---------------------------------------------------------------------------
// Reference catalogue. Used to (a) seed an empty Supabase project and
// (b) power the fully-functional offline "demo" mode when RLS/network blocks
// reads. Same shapes as the SQL schema, so the UI code path is identical.
// ---------------------------------------------------------------------------

export const ROLE_NAMES = [
  { name: 'campus_admin',   description: 'Campus administrator: full access' },
  { name: 'faculty',        description: 'Faculty member; can approve bookings' },
  { name: 'resource_manager', description: 'Manages campus resources' },
  { name: 'staff',          description: 'Staff member; can request resources' },
  { name: 'student',        description: 'Student; can request shared spaces' },
];

export const STATUS_ROWS = [
  { code: STATUS.PENDING,   name: 'Pending Approval', description: 'Waiting for an approver decision', is_final: false },
  { code: STATUS.APPROVED,  name: 'Approved',          description: 'Slot is reserved',                  is_final: false },
  { code: STATUS.REJECTED,  name: 'Rejected',          description: 'Request declined',                 is_final: true  },
  { code: STATUS.CANCELLED, name: 'Cancelled',         description: 'Slot released back to the pool',   is_final: true  },
  { code: STATUS.COMPLETED, name: 'Completed',         description: 'Booking finished',                 is_final: true  },
];

export const FEATURES = [
  { name: 'Projector',           description: 'Ceiling or portable projector' },
  { name: 'Whiteboard',          description: 'Writable board with markers' },
  { name: 'Video Conferencing',  description: 'Camera, mic and display for online classes' },
  { name: 'Air Conditioned',     description: 'Climate controlled' },
  { name: 'Lab Benches',         description: 'Stainless work benches with sinks' },
  { name: 'Fume Hood',           description: 'Certified fume extraction' },
  { name: 'Podcast Kit',         description: 'Multi-mic audio recorder' },
  { name: 'Football Turf',       description: 'Full pitch with lighting' },
  { name: 'Chairs (stackable)',  description: 'Stackable seating' },
  { name: 'Smart Board',         description: 'Interactive touch display' },
  { name: 'PA System',           description: 'Public address microphones' },
  { name: '3D Printer',          description: 'FDM / SLA additive manufacturing' },
];

export const RESOURCE_TYPES = [
  { name: 'Lecture Hall',        description: 'Tiered classrooms for scheduled teaching' },
  { name: 'Seminar Room',        description: 'Small group discussion rooms' },
  { name: 'Computer Lab',        description: 'Workstations for practical sessions' },
  { name: 'Science Lab',         description: 'Wet/dry laboratories' },
  { name: 'Library',             description: 'Reading and study halls' },
  { name: 'Sports Facility',     description: 'Indoor and outdoor sports' },
  { name: 'Meeting / Seminar',   description: 'Boardrooms and auditoria' },
  { name: 'Equipment / Studio',  description: 'AV studios and specialised gear' },
];

const CAMPUS = { name: 'Northfield Institute of Technology', code: 'NIT', address: '14 Innovation Ridge Road, Northfield' };

const BUILDINGS = [
  { code: 'MAIN', name: 'Main Academic Block',   description: 'Teaching spaces and admin offices' },
  { code: 'SCI',  name: 'Science & Engineering Tower', description: 'Laboratories and workshops' },
  { code: 'LRC',  name: 'Learning Resource Centre',    description: 'Library, study halls, media studio' },
  { code: 'REC',  name: 'Recreation Pavilion',          description: 'Sports facilities and auditorium' },
];

const FLOORS = [
  [0, 0, 'Ground Floor'], [0, 1, 'First Floor'], [0, 2, 'Second Floor'],
  [1, 0, 'Ground Floor (Lab Wing)'], [1, 3, 'Third Floor (Research)'],
  [2, 0, 'Ground Floor'], [2, 1, 'First Floor'],
  [3, 0, 'Ground Floor'], [3, 1, 'First Floor'],
];

/** name, type, building, floor, capacity, opts */
const RESOURCES = [
  ['LH-101 Orion Lecture Hall',      0, 0, 0, 120, { features: ['Projector', 'Air Conditioned', 'PA System', 'Chairs (stackable)'], min: 60, bb: 10, ba: 10 }],
  ['LH-204 Vega Lecture Hall',       0, 0, 1, 80,  { features: ['Projector', 'Whiteboard', 'Air Conditioned'], min: 60, bb: 10, ba: 10 }],
  ['SR-310 Cedar Seminar Room',      1, 0, 2, 16,  { features: ['Whiteboard', 'Video Conferencing', 'Air Conditioned'], min: 30, bb: 5, ba: 5 }],
  ['SR-311 Teak Seminar Room',       1, 0, 2, 16,  { features: ['Whiteboard', 'Air Conditioned'], min: 30, bb: 5, ba: 5 }],
  ['CL-G04 Computer Lab',           2, 1, 0, 60,  { features: ['Projector', 'Air Conditioned'], min: 60, max: 240, bb: 15, ba: 15 }],
  ['CL-G05 Computer Lab',           2, 1, 0, 60,  { features: ['Projector', 'Air Conditioned'], min: 60, max: 240, bb: 15, ba: 15 }],
  ['PH-201 Physics Laboratory',     3, 1, 0, 32,  { features: ['Lab Benches', 'Fume Hood', 'Projector'], min: 90, bb: 20, ba: 20, approval: true }],
  ['CH-105 Chemistry Laboratory',   3, 1, 0, 32,  { features: ['Lab Benches', 'Fume Hood'], min: 90, bb: 20, ba: 20, approval: true }],
  ['MED-A1 Media / Podcast Studio', 7, 2, 1, 8,  { features: ['Podcast Kit', 'Air Conditioned'], min: 30, max: 360, bb: 10, ba: 10, approval: true }],
  ['HALL-A Auditorium',            0, 3, 0, 400, { features: ['Projector', 'PA System', 'Air Conditioned'], min: 120, bb: 30, ba: 30 }],
  ['STU-A Study Podium',           4, 2, 0, 90,  { features: ['Chairs (stackable)', 'Air Conditioned'], min: 30, bb: 0, ba: 0 }],
  ['TURF-1 Football Turf',         5, 3, 0, 22,  { features: ['Football Turf'], min: 60, max: 240, bb: 15, ba: 15 }],
  ['GYM-1 Multipurpose Gym',       5, 3, 0, 60,  { features: ['PA System'], min: 60, max: 300, bb: 15, ba: 15 }],
  ['BR-12 Boardroom',              6, 0, 2, 14,  { features: ['Video Conferencing', 'Smart Board', 'Air Conditioned'], min: 30, max: 480, bb: 10, ba: 10 }],
  ['MKR-1 Maker Space (3D Print)', 7, 1, 3, 20, { features: ['3D Printer', 'Whiteboard'], min: 30, max: 360, bb: 10, ba: 10, approval: true }],
];

const USERS = [
  ['Amara',  'Osei',      'amara.osei@nit.edu',      'campus_admin',        'Administration'],
  ['Rohit',  'Menon',     'rohit.menon@nit.edu',     'faculty',      'Computer Science'],
  ['Sofia',  'Duarte',    'sofia.duarte@nit.edu',    'faculty',      'Physics'],
  ['Liang',  'Wen',       'liang.wen@nit.edu',       'resource_manager', 'Chemistry'],
  ['Grace',  'Okonkwo',   'grace.okonkwo@nit.edu',   'staff',        'Administration'],
  ['Ivan',   'Petrov',    'ivan.petrov@nit.edu',     'staff',        'Facilities'],
  ['Nadia',  'Haddad',    'nadia.haddad@nit.edu',    'student',      'Computer Science'],
  ['Tomas',  'Rivera',    'tomas.rivera@nit.edu',    'student',      'Mechanical'],
  ['Mei',    'Tanaka',    'mei.tanaka@nit.edu',      'student',      'Physics'],
  ['Obi',    'Adeyemi',   'obi.adeyemi@nit.edu',     'student',      'Business'],
];

// Deterministic PRNG so the demo dataset is stable across reloads.
function mulberry(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function uuidFor(n) {
  const hex = (v) => v.toString(16).padStart(2, '0');
  let s = '';
  for (let i = 0; i < 16; i++) s += hex((n * 2654435761 + i * 40503) % 256);
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-a${s.slice(17, 20)}-${s.slice(20, 32)}`;
}

const TITLE_A = ['Data Structures', 'Quantum Mechanics', 'Thermodynamics Lab', 'Design Thinking', 'Financial Modelling',
  'Machine Learning', 'Organic Chemistry', 'Robotics Practicum', 'Microeconomics', 'Environmental Policy',
  'Thesis Supervision', 'Capstone Review', 'Guest Lecture', 'Student Council', 'Faculty Research Slot',
  'Career Workshop', 'Hackathon Build', 'Language Lab', 'Safety Induction', 'Sports Trials'];
const PURPOSES = ['Scheduled teaching', 'Extra tutorial', 'Research work', 'Student activity', 'Department meeting',
  'External workshop', 'Assessment', 'Maintenance review', 'Personal study'];

/** Build a complete in-memory database that mirrors the SQL schema. */
export function buildDemoDb() {
  const rnd = mulberry(20260926);
  const now = new Date();

  const db = {
    profiles: [], roles: [], profile_roles: [], campuses: [], buildings: [], floors: [],
    resource_types: [], resources: [], resource_features: [], resource_feature_map: [],
    booking_statuses: [], booking_series: [], bookings: [], booking_resources: [],
    booking_approvals: [], booking_attendees: [], resource_availability: [],
    resource_blackouts: [], maintenance_records: [], notifications: [], audit_logs: [],
  };

  // --- reference tables ---------------------------------------------------
  db.booking_statuses = STATUS_ROWS.map((s, i) => ({ id: i + 1, ...s }));
  const statusId = (code) => db.booking_statuses.find((s) => s.code === code).id;

  db.roles = ROLE_NAMES.map((r, i) => ({ id: i + 1, ...r }));
  db.resource_types = RESOURCE_TYPES.map((t, i) => ({ id: i + 1, ...t }));
  db.resource_features = FEATURES.map((f, i) => ({ id: i + 1, ...f }));
  const featId = (n) => db.resource_features.find((f) => f.name === n)?.id;

  db.campuses.push({ id: 1, ...CAMPUS, latitude: 51.5072, longitude: -0.1276, is_active: true, created_at: now.toISOString(), updated_at: now.toISOString() });

  BUILDINGS.forEach((b, i) => db.buildings.push({ id: i + 1, campus_id: 1, ...b, is_active: true, created_at: now.toISOString(), updated_at: now.toISOString() }));
  FLOORS.forEach(([bi, num, nm], i) => db.floors.push({ id: i + 1, building_id: bi + 1, floor_number: num, name: nm, created_at: now.toISOString() }));

  RESOURCES.forEach((r, i) => {
    const [name, ti, bi, fi, cap, o] = r;
    db.resources.push({
      id: i + 1,
      resource_type_id: ti + 1,
      building_id: bi + 1,
      floor_id: (bi * 3 + fi) + 1,
      name, code: r.code || name.split(' ')[0],
      description: null,
      capacity: cap,
      location_description: `${BUILDINGS[bi].name} · ${FLOORS.find(f => f.building_id === bi + 1 && f.floor_number === fi)?.name || ''}`,
      is_bookable: true,
      is_active: i !== 12,          // one resource deliberately deactivated
      requires_approval: o.approval ?? i < 8,
      minimum_booking_minutes: o.min ?? 30,
      maximum_booking_minutes: o.max ?? 480,
      buffer_before_minutes: o.bb ?? 0,
      buffer_after_minutes: o.ba ?? 0,
      created_by: uuidFor(1),
      updated_by: uuidFor(1),
      created_at: now.toISOString(), updated_at: now.toISOString(),
    });
    (o.features || []).forEach((fname) => {
      const fid = featId(fname);
      if (fid) db.resource_feature_map.push({ resource_id: i + 1, feature_id: fid, quantity: 1, notes: null });
    });
  });
  // friendly unique codes
  db.resources.forEach((r) => { r.code = r.name.split(' ')[0]; });

  // --- people -------------------------------------------------------------
  USERS.forEach(([fn, ln, email, role, dept], i) => {
    const id = uuidFor(100 + i);
    db.profiles.push({
      id, first_name: fn, last_name: ln, email, phone: null,
      student_employee_id: `NIT-${1000 + i * 7}`, department: dept,
      designation: role === 'student' ? 'Student' : role === 'campus_admin' ? 'Registrar' : 'Faculty',
      avatar_url: null, is_active: true,
      created_at: now.toISOString(), updated_at: now.toISOString(),
    });
    db.profile_roles.push({ profile_id: id, role_id: db.roles.find((r) => r.name === role).id, assigned_by: uuidFor(100), assigned_at: now.toISOString() });
  });

  // --- weekly availability -------------------------------------------------
  db.resources.forEach((r) => {
    if (!r.is_bookable) return;
    const type = db.resource_types.find((t) => t.id === r.resource_type_id);
    const sporty = type.name === 'Sports Facility';
    const openFrom = sporty ? '06:00' : (r.name.startsWith('SR-') ? '08:00' : '07:30');
    const openTo = sporty ? '22:00' : (r.name.startsWith('SR-') ? '18:00' : '19:00');
    const days = sporty ? [0, 1, 2, 3, 4, 5, 6] : [0, 1, 2, 3, 4, 5];
    days.forEach((d) => db.resource_availability.push({
      id: db.resource_availability.length + 1, resource_id: r.id, day_of_week: d,
      start_time: `${openFrom}:00`, end_time: `${openTo}:00`, is_available: true, created_at: now.toISOString(),
    }));
  });

  // --- maintenance + blackouts -------------------------------------------
  const admin = db.profiles[0].id;
  [[2, 1, 'Node A7 workstation failure', 'in_progress'], [7, 2, 'Fume hood certification', 'scheduled'], [10, -3, 'Turf aeration', 'scheduled']]
    .forEach(([rid, offset, title, status]) => {
      const s = new Date(startOfDay(addDays(now, offset)).getTime() + (rid === 10 ? 6 : 9) * 3600000);
      const e = new Date(s.getTime() + (rid === 10 ? 4 : 6) * 3600000);
      db.maintenance_records.push({
        id: db.maintenance_records.length + 1, resource_id: rid,
        start_time: s.toISOString(), end_time: e.toISOString(), title, description: null,
        status, created_by: admin, completed_at: null,
        created_at: now.toISOString(), updated_at: now.toISOString(),
      });
    });
  [[4, 2, 'Carpet deep clean'], [12, 1, 'Annual electrical inspection']]
    .forEach(([rid, offset, reason]) => {
      const s = new Date(startOfDay(addDays(now, offset)).getTime() + 8 * 3600000);
      db.resource_blackouts.push({
        id: db.resource_blackouts.length + 1, resource_id: rid,
        start_time: s.toISOString(), end_time: new Date(s.getTime() + 5 * 3600000).toISOString(),
        reason, created_by: admin, created_at: now.toISOString(),
      });
    });

  // --- bookings -----------------------------------------------------------
  let bid = 0;
  let refSeq = 0;
  const bookable = db.resources.filter((r) => r.is_bookable);

  // Occupancy ledger, keyed by resource. Stores the *buffered* interval so the
  // generated dataset is guaranteed conflict-free - the demo data must never
  // contain a double booking, or the conflict engine would look broken.
  const occupied = new Map();
  const windowsOf = (r) => db.resource_availability
    .filter((a) => a.resource_id === r.id && a.is_available)
    .map((a) => [a.day_of_week, timeToMin(a.start_time), timeToMin(a.end_time)]);

  function intervalFree(r, start, end) {
    const bb = (r.buffer_before_minutes || 0) * 60000;
    const ba = (r.buffer_after_minutes || 0) * 60000;
    const s = start.getTime() - bb;
    const e = end.getTime() + ba;
    // inside a published opening window for that weekday?
    const w = windowsOf(r);
    if (w.length) {
      const mins = start.getHours() * 60 + start.getMinutes();
      const em = end.getHours() * 60 + end.getMinutes();
      if (!w.some(([d, o, c]) => d === start.getDay() && mins >= o && em <= c)) return false;
    }
    // clear of other bookings AND of blackouts / maintenance?
    const clashes = (occupied.get(r.id) || []).some(([a, b]) => s < b && a < e);
    if (clashes) return false;
    const blocked = [
      ...db.resource_blackouts.filter((x) => x.resource_id === r.id).map((x) => [+new Date(x.start_time), +new Date(x.end_time)]),
      ...db.maintenance_records.filter((x) => x.resource_id === r.id && x.status !== 'cancelled')
        .map((x) => [+new Date(x.start_time), x.end_time ? +new Date(x.end_time) : Infinity]),
    ];
    return !blocked.some(([a, b]) => s < b && a < e);
  }

  function occupy(r, start, end) {
    const bb = (r.buffer_before_minutes || 0) * 60000;
    const ba = (r.buffer_after_minutes || 0) * 60000;
    if (!occupied.has(r.id)) occupied.set(r.id, []);
    occupied.get(r.id).push([start.getTime() - bb, end.getTime() + ba]);
  }

  const makeBooking = (resource, start, end, opts = {}) => {
    bid += 1; refSeq += 1;
    const requester = opts.requester || db.profiles[Math.floor(rnd() * db.profiles.length)].id;
    let status = opts.status;
    if (!status) {
      const past = end < now;
      const roll = rnd();
      status = past ? (roll < 0.72 ? STATUS.COMPLETED : roll < 0.86 ? STATUS.CANCELLED : STATUS.REJECTED)
                     : (roll < 0.78 ? STATUS.APPROVED : STATUS.PENDING);
    }
    const createdAt = new Date(start.getTime() - (1 + Math.floor(rnd() * 10)) * 86400000);
    const b = {
      id: bid,
      booking_reference: `CBR-2026-${String(1000 + refSeq)}`,
      requested_by: requester,
      booking_series_id: null,
      title: opts.title || `${TITLE_A[Math.floor(rnd() * TITLE_A.length)]} - ${db.profiles.find(p => p.id === requester).first_name}`,
      description: null,
      purpose: opts.purpose || PURPOSES[Math.floor(rnd() * PURPOSES.length)],
      status_id: statusId(status),
      status_code: status,
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      attendee_count: Math.max(1, Math.min(resource.capacity || 1, Math.floor(rnd() * (resource.capacity || 10)) + 1)),
      special_requirements: null,
      rejection_reason: status === STATUS.REJECTED ? 'Resource not available for the intended activity.' : null,
      cancellation_reason: status === STATUS.CANCELLED ? 'Cancelled by requester.' : null,
      approved_at: ['approved', 'completed'].includes(status) ? new Date(createdAt.getTime() + 3600000).toISOString() : null,
      cancelled_at: status === STATUS.CANCELLED ? createdAt.toISOString() : null,
      created_at: createdAt.toISOString(), updated_at: createdAt.toISOString(),
    };
    db.bookings.push(b);
    db.booking_resources.push({ booking_id: bid, resource_id: resource.id });
    occupy(resource, start, end);

    if (['approved', 'completed'].includes(status)) {
      const approver = db.profiles.find((p) => ['campus_admin', 'faculty', 'resource_manager'].includes(
        db.roles.find((r) => r.id === db.profile_roles.find(pr => pr.profile_id === p.id)?.role_id)?.name));
      db.booking_approvals.push({
        id: db.booking_approvals.length + 1, booking_id: bid,
        approver_id: approver?.id || admin, action: 'approved',
        comments: 'Approved. Please leave the room in the configured state.',
        created_at: b.approved_at,
      });
    }
    if (status === STATUS.REJECTED) {
      db.booking_approvals.push({
        id: db.booking_approvals.length + 1, booking_id: bid, approver_id: admin,
        action: 'rejected', comments: b.rejection_reason, created_at: createdAt.toISOString(),
      });
    }

    // attendance, only for past completed bookings
    if (status === STATUS.COMPLETED) {
      const n = 2 + Math.floor(rnd() * 4);
      for (let i = 0; i < n; i++) {
        const roll = rnd();
        const st = roll < 0.62 ? 'attended' : roll < 0.78 ? 'absent' : roll < 0.9 ? 'accepted' : 'declined';
        db.booking_attendees.push({
          id: db.booking_attendees.length + 1, booking_id: bid,
          profile_id: db.profiles[Math.floor(rnd() * db.profiles.length)].id,
          external_name: null, external_email: null, attendance_status: st,
          created_at: createdAt.toISOString(),
        });
      }
    }
    return b;
  };

  /** Try n random windows on a day; place the first one that is actually free. */
  function place(resource, day, { minSlot = 8, maxSlot = 17, attempts = 6, status, seedStep = 0 } = {}) {
    for (let i = 0; i < attempts; i++) {
      const h = minSlot + Math.floor(rnd() * (maxSlot - minSlot + 1));
      const start = new Date(day.getTime() + h * 3600000 + Math.floor(rnd() * 4) * 900000 + seedStep * 60000);
      let dur = (resource.minimum_booking_minutes + Math.floor(rnd() * 4) * 30) * 60000;
      if (resource.maximum_booking_minutes) dur = Math.min(dur, resource.maximum_booking_minutes * 60000);
      const end = new Date(start.getTime() + dur);
      if (end <= start) continue;
      if (!intervalFree(resource, start, end)) continue;
      return makeBooking(resource, start, end, { status });
    }
    return null;
  }

  // history: 45 days back
  for (let d = 45; d >= 1; d--) {
    const day = startOfDay(addDays(now, -d));
    if (day.getDay() === 0 && rnd() < 0.6) continue;
    for (const r of bookable) {
      if (rnd() < 0.16) continue;
      place(r, day, { minSlot: 8, maxSlot: 16 });
    }
  }
  // upcoming: 14 days forward
  for (let d = 0; d <= 14; d++) {
    const day = startOfDay(addDays(now, d));
    if (day.getDay() === 0) continue;
    for (const r of bookable) {
      if (r.id === 1 && d < 5) continue;
      if (rnd() < 0.42) continue;
      place(r, day, {
        minSlot: 9, maxSlot: 16,
        status: rnd() < 0.8 ? STATUS.APPROVED : STATUS.PENDING,
      });
    }
  }

  // A deliberate "tight" case: two back-to-back bookings on a seminar room
  // separated only by its 5 minute turnaround buffer, so the buffer engine has
  // something real to demonstrate without ever actually colliding.
  const sr = db.resources[2];
  const tight = new Date(startOfDay(addDays(now, 3)).getTime() + 10 * 3600000);
  if (intervalFree(sr, tight, new Date(tight.getTime() + 60 * 60000))) {
    makeBooking(sr, tight, new Date(tight.getTime() + 60 * 60000), { status: STATUS.APPROVED, title: 'Capstone Review' });
  }
  const t2 = new Date(tight.getTime() + 70 * 60000);
  if (intervalFree(sr, t2, new Date(t2.getTime() + 60 * 60000))) {
    makeBooking(sr, t2, new Date(t2.getTime() + 60 * 60000), { status: STATUS.APPROVED, title: 'Thesis Supervision' });
  }

  // notifications for the demo admin
  const pending = db.bookings.filter((b) => b.status_code === STATUS.PENDING).slice(0, 4);
  pending.forEach((b, i) => db.notifications.push({
    id: i + 1, user_id: admin, booking_id: b.id, type: 'approval_request',
    title: `Approval needed: ${b.title}`,
    message: `${b.booking_reference} is waiting for a decision.`, is_read: false,
    read_at: null, created_at: b.created_at,
  }));

  // audit log
  db.bookings.slice(-40).forEach((b, i) => db.audit_logs.push({
    id: i + 1, actor_id: b.requested_by, action: b.status_code === STATUS.PENDING ? 'booking.requested' : `booking.${b.status_code}`,
    entity_type: 'booking', entity_id: String(b.id),
    old_data: null, new_data: { reference: b.booking_reference },
    ip_address: null, created_at: b.created_at,
  }));
  // count of conflicts previously prevented
  for (let i = 0; i < 23; i++) {
    db.audit_logs.push({
      id: db.audit_logs.length + 1, actor_id: db.profiles[Math.floor(rnd() * 5)].id,
      action: 'booking.conflict_blocked', entity_type: 'booking', entity_id: null,
      old_data: null, new_data: { reason: 'slot_overlap' }, ip_address: null,
      created_at: new Date(now.getTime() - Math.floor(rnd() * 30 * 86400000)).toISOString(),
    });
  }

  return db;
}

// --------------------------------------------------------- persistence ----
const LS_KEY = `${STORAGE_KEY}.demo`;

export function loadLocalDb() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return null;
}
export function saveLocalDb(db) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(db)); } catch { /* quota */ }
}
export function clearLocalDb() {
  try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
}
export { LS_KEY as LOCAL_DB_KEY, timeToMin };
