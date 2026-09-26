import { loadSupabase, isConfigured } from './supabase-client.js';
import { BLOCKING_STATUSES, STATUS, STORAGE_KEY, APPROVER_ROLES, ADMIN_ROLES, MANAGER_ROLES } from './config.js';
import { buildDemoDb, loadLocalDb, saveLocalDb, clearLocalDb, STATUS_ROWS, ROLE_NAMES } from './seed.js';
import { genRef } from './ui.js';

/**
 * Single data-access layer.
 *
 * Strategy: load the whole (small) campus dataset into memory once, render
 * from memory, and write-through to Supabase on every mutation. That keeps one
 * rendering code path for both "live" and "demo" mode.
 *
 * If Supabase is unreachable or RLS denies reads, we fall back to a fully
 * functional local dataset so the product is still demonstrable.
 */
class Store {
  constructor() {
    this.mode = 'loading';        // 'live' | 'demo' | 'anon' | 'loading'
    this.modeReason = '';
    this.session = null;
    this.user = null;             // auth user or demo user
    this.profile = null;
    this.roles = [];
    this.db = null;
    this.sb = null;               // Supabase client, once loaded
    this.listeners = new Set();
  }

  // ----------------------------------------------------- lazy Supabase ---
  /** Resolve the SDK + client. Returns null when it cannot be loaded. */
  async ensureClient() {
    if (this.sb) return this.sb;
    if (!isConfigured) {
      this.clientError = 'Supabase is not configured (missing URL or publishable key).';
      return null;
    }
    const { client, error } = await loadSupabase();
    if (!client) { this.clientError = error; return null; }
    this.sb = client;
    this.clientError = null;
    return this.sb;
  }

  get auth() {
    if (!this.sb) throw new Error('Supabase client is not available.');
    return this.sb.auth;
  }
  from(table) {
    if (!this.sb) throw new Error('Supabase client is not available.');
    return this.sb.from(table);
  }
  rpc(name, args) {
    if (!this.sb) throw new Error('Supabase client is not available.');
    return this.sb.rpc(name, args);
  }
  get hasClient() { return Boolean(this.sb); }

  // ------------------------------------------------------------- events --
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(evt = {}) { this.listeners.forEach((f) => { try { f(evt); } catch (e) { console.error(e); } }); }

  // --------------------------------------------------------------- auth --
  async init() {
    const client = await this.ensureClient();
    if (!client) {
      return this._enterDemo(`${this.clientError} The app is running on local demo data.`);
    }

    try {
      const { data, error } = await this.auth.getSession();
      if (error) throw error;
      this.session = data.session;
      if (!this.session) { this.mode = 'anon'; return; }
      this.user = this.session.user;
      await this.refreshFromSupabase();
      if (this.db.booking_statuses.length === 0) await this.seedReferenceData();
      this.mode = 'live';
    } catch (err) {
      await this._enterDemo(`Supabase unreachable (${err.message || err}). Running on local demo data.`);
    }
  }

  async signIn(email, password) {
    const client = await this.ensureClient();
    if (!client) throw new Error(this.clientError || 'Supabase is unavailable. Use demo mode instead.');
    const { data, error } = await this.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
    this.session = data.session;
    this.user = data.session.user;
    await this.refreshFromSupabase();
    if (this.db.booking_statuses.length === 0) await this.seedReferenceData();
    this.mode = 'live';
    localStorage.setItem(STORAGE_KEY, 'live');
    this.emit({ type: 'auth' });
    return this.user;
  }

  async signUp(email, password, meta = {}) {
    const client = await this.ensureClient();
    if (!client) throw new Error(this.clientError || 'Supabase is unavailable. Use demo mode instead.');
    const { data, error } = await this.auth.signUp({
      email, password,
      options: { data: { first_name: meta.first_name || '', last_name: meta.last_name || '', department: meta.department || '' } },
    });
    if (error) throw new Error(error.message);
    if (!data.session) {
      // confirm-email flow
      return { needsConfirmation: true, user: data.user };
    }
    this.session = data.session;
    this.user = data.session.user;
    await this.refreshFromSupabase();
    if (this.db.booking_statuses.length === 0) await this.seedReferenceData();
    this.mode = 'live';
    this.emit({ type: 'auth' });
    return { needsConfirmation: false, user: this.user };
  }

  async signOut() {
    try { if (this.sb) await this.auth.signOut(); } catch { /* offline */ }
    this.session = null; this.user = null; this.profile = null; this.roles = [];
    this.mode = 'anon';
    localStorage.removeItem(STORAGE_KEY);
    this.emit({ type: 'auth' });
  }

  /** Try the live path first; on any failure fall back permanently to demo. */
  async _enterDemo(reason) {
    this.mode = 'demo';
    this.modeReason = reason || 'Demo mode.';
    this.db = loadLocalDb() || buildDemoDb();
    saveLocalDb(this.db);
    this.user = this.user || this.db.profiles[0];
    this.session = { user: { id: this.user.id, email: this.user.email } };
    this.profile = this.user;
    this.roles = this.rolesOf(this.user.id);
    localStorage.setItem(STORAGE_KEY, 'demo');
    this.emit({ type: 'mode' });
  }

  async enterDemoAs(profileId) {
    if (this.mode !== 'demo') return;
    const p = this.db.profiles.find((x) => x.id === profileId) || this.db.profiles[0];
    this.user = p; this.profile = p; this.roles = this.rolesOf(p.id);
    this.emit({ type: 'auth' });
  }

  async leaveDemo() {
    this.mode = 'anon'; this.user = null; this.profile = null;
    this.emit({ type: 'auth' });
  }

  // ---------------------------------------------------------- load data --
  async refreshFromSupabase() {
    const TABLES = [
      'booking_statuses', 'roles', 'profiles', 'profile_roles', 'campuses', 'buildings', 'floors',
      'resource_types', 'resources', 'resource_features', 'resource_feature_map',
      'resource_availability', 'bookings', 'booking_resources', 'booking_approvals',
      'booking_attendees', 'resource_blackouts', 'maintenance_records', 'notifications', 'audit_logs',
    ];
    const out = {};
    const results = await Promise.all(TABLES.map(async (t) => {
      const { data, error } = await this.from(t).select('*');
      if (error) throw new Error(`${t}: ${error.message}`);
      out[t] = data || [];
    }));
    // demo-only convenience field
    const statusById = new Map(out.booking_statuses.map((s) => [s.id, s.code]));
    out.bookings = out.bookings.map((b) => ({ ...b, status_code: statusById.get(b.status_id) || 'pending' }));
    this.db = out;
    this.profile = this.db.profiles.find((p) => p.id === this.user?.id) || null;
    this.roles = this.rolesOf(this.user?.id);
  }

  /** Insert the reference rows the app depends on, when the project is empty. */
  async seedReferenceData() {
    const ins = async (table, rows) => {
      if (!rows.length) return;
      const { error } = await this.from(table).insert(rows);
      if (error) console.warn(`seed ${table}:`, error.message);
    };
    await ins('booking_statuses', STATUS_ROWS.map((s) => ({
      code: s.code, name: s.name, description: s.description, is_final: s.is_final,
    })));
    await ins('roles', ROLE_NAMES.map((r) => ({ name: r.name, description: r.description })));
    await this.refreshFromSupabase();
  }

  // ------------------------------------------------------------ helpers --
  rolesOf(profileId) {
    if (!profileId || !this.db) return [];
    return this.db.profile_roles
      .filter((pr) => pr.profile_id === profileId)
      .map((pr) => this.db.roles.find((r) => r.id === pr.role_id)?.name)
      .filter(Boolean);
  }

  isApprover() { return this.roles.some((r) => APPROVER_ROLES.includes(r)); }
  isAdmin() { return this.roles.some((r) => ADMIN_ROLES.includes(r)); }
  isManager() { return this.roles.some((r) => MANAGER_ROLES.includes(r)); }

  statusIdFor(code) {
    return this.db.booking_statuses.find((s) => s.code === code)?.id ?? null;
  }
  statusCodeFor(id) {
    return this.db.booking_statuses.find((s) => s.id === id)?.code ?? null;
  }

  // ------------------------------------------------------ lookups / maps --
  buildings() { return this.db.buildings || []; }
  floors() { return this.db.floors || []; }
  resourceTypes() { return this.db.resource_types || []; }

  profiles() { return this.db.profiles || []; }
  profileById(id) { return this.db.profiles.find((p) => p.id === id) || null; }
  displayName(p) {
    if (!p) return 'Unknown';
    return [p.first_name, p.last_name].filter(Boolean).join(' ') || p.email || 'Unknown';
  }
  me() { return this.profile; }
  myName() { return this.displayName(this.profile); }

  featuresOf(resourceId) {
    const map = this.db.resource_feature_map || [];
    const feats = this.db.resource_features || [];
    return map.filter((m) => m.resource_id === resourceId)
      .map((m) => feats.find((f) => f.id === m.feature_id)?.name).filter(Boolean);
  }

  /** Decorated resource list: joins type/building/floor + features + live status. */
  resources({ includeInactive = false } = {}) {
    const list = (this.db.resources || []).filter((r) => includeInactive || r.is_active);
    const now = Date.now();
    return list.map((r) => {
      const type = this.db.resource_types.find((t) => t.id === r.resource_type_id);
      const building = this.db.buildings.find((b) => b.id === r.building_id);
      const floor = this.db.floors.find((f) => f.id === r.floor_id);
      const live = this.bookingsFor(r.id).filter((b) => b.end_time && new Date(b.end_time).getTime() > now);
      const inUse = live.some((b) => new Date(b.start_time).getTime() <= now && new Date(b.end_time).getTime() > now);
      const next = live.filter((b) => new Date(b.start_time).getTime() > now)
        .sort((a, b) => new Date(a.start_time) - new Date(b.start_time))[0] || null;
      return {
        ...r,
        type_name: type?.name || 'Uncategorised',
        type_index: (this.db.resource_types.findIndex((t) => t.id === r.resource_type_id) + 6) % 6,
        building_name: building?.name || null,
        building_code: building?.code || null,
        floor_label: floor ? `Floor ${floor.floor_number}${floor.name && !floor.name.toLowerCase().includes('floor') ? ` · ${floor.name}` : ''}` : null,
        features: this.featuresOf(r.id),
        in_use: inUse,
        next_booking: next,
        upcoming_count: live.length,
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  resourceById(id) { return (this.db.resources || []).find((r) => r.id === Number(id)) || null; }
  resourceName(id) { return this.resourceById(id)?.name || `Resource #${id}`; }

  /** All bookings that hold a slot on a resource (pending/approved/completed). */
  bookingsFor(resourceId) {
    const map = new Map();
    for (const br of this.db.booking_resources || []) map.set(br.booking_id, br.resource_id);
    return (this.db.bookings || [])
      .filter((b) => map.get(b.id) === resourceId && BLOCKING_STATUSES.includes(b.status_code))
      .sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
  }

  bookingsForMany(resourceIds) {
    const ids = new Set(resourceIds.map(Number));
    const map = new Map();
    for (const br of this.db.booking_resources || []) {
      if (ids.has(br.resource_id)) map.set(br.booking_id, br.resource_id);
    }
    return (this.db.bookings || []).filter((b) => map.has(b.id));
  }

  resourcesOfBooking(bookingId) {
    const ids = (this.db.booking_resources || []).filter((br) => br.booking_id === bookingId).map((br) => br.resource_id);
    return ids.map((id) => this.resourceById(id)).filter(Boolean);
  }

  availabilityFor(resourceId) { return (this.db.resource_availability || []).filter((a) => a.resource_id === resourceId); }
  blackoutsFor(resourceId) { return (this.db.resource_blackouts || []).filter((a) => a.resource_id === resourceId); }
  maintenanceFor(resourceId) { return (this.db.maintenance_records || []).filter((a) => a.resource_id === resourceId); }
  attendeesFor(bookingId) { return (this.db.booking_attendees || []).filter((a) => a.booking_id === bookingId); }
  approvalsFor(bookingId) { return (this.db.booking_approvals || []).filter((a) => a.booking_id === bookingId); }

  /** Decorated booking: requester name, resources, status, duration. */
  decorate(b) {
    const req = this.profileById(b.requested_by);
    return {
      ...b,
      status_code: b.status_code || this.statusCodeFor(b.status_id),
      requester_name: this.displayName(req),
      requester_email: req?.email,
      department: req?.department,
      resources: this.resourcesOfBooking(b.id),
      duration_ms: new Date(b.end_time) - new Date(b.start_time),
      approvals: this.approvalsFor(b.id),
    };
  }

  /** Booking list for the signed-in user, or all bookings for approvers. */
  myBookings({ scope = 'mine', status = 'all' } = {}) {
    let list = this.db.bookings || [];
    if (scope === 'mine') list = list.filter((b) => b.requested_by === this.user?.id);
    if (scope === 'approvals') list = list.filter((b) => b.status_code === STATUS.PENDING);
    if (status !== 'all') list = list.filter((b) => b.status_code === status);
    return list.map((b) => this.decorate(b))
      .sort((a, b) => new Date(b.start_time) - new Date(a.start_time));
  }

  notifications() {
    return (this.db.notifications || [])
      .filter((n) => n.user_id === this.user?.id)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }
  unreadCount() { return this.notifications().filter((n) => !n.is_read).length; }

  pendingApprovalCount() {
    if (!this.isApprover()) return 0;
    return (this.db.bookings || []).filter((b) => b.status_code === STATUS.PENDING).length;
  }

  // ------------------------------------------------------------- writes --
  async createBooking({ title, description, purpose, start, end, resourceIds, attendeeCount, requirements, attendees = [] }) {
    const now = new Date().toISOString();
    const requiresApproval = resourceIds.some((id) => this.resourceById(id)?.requires_approval);
    const code = requiresApproval ? STATUS.PENDING : STATUS.APPROVED;
    const code0 = code;
    const ref = genRef('CBR');
    const statusId = this.statusIdFor(code);

    const record = {
      booking_reference: ref,
      requested_by: this.user.id,
      title: title.trim(),
      description: description?.trim() || null,
      purpose: purpose || null,
      status_id: statusId,
      start_time: new Date(start).toISOString(),
      end_time: new Date(end).toISOString(),
      attendee_count: attendeeCount || null,
      special_requirements: requirements?.trim() || null,
      approved_at: code === STATUS.APPROVED ? now : null,
      updated_at: now,
    };

    if (this.mode === 'live') {
      // Preferred path: the atomic SQL function (sql/02_overlap_guard.sql).
      // It validates every rule and relies on an EXCLUDE constraint, so two
      // simultaneous requests can never double book.
      if (this.rpcAvailable !== false) {
        const { data, error } = await this.rpc('create_booking_safe', {
          p_title: record.title,
          p_description: record.description,
          p_purpose: record.purpose,
          p_start: record.start_time,
          p_end: record.end_time,
          p_resource_ids: resourceIds.map(Number),
          p_attendee_count: attendeeCount || null,
          p_requirements: record.special_requirements,
          p_attendee_profiles: attendees.map((a) => a.profile_id).filter(Boolean),
          p_external_attendees: attendees.filter((a) => !a.profile_id)
            .map((a) => `${a.external_name} <${a.external_email}>`),
        });
        if (!error && Array.isArray(data) && data.length) {
          const row = data[0];
          if (!row.ok) {
            await this.from('audit_logs').insert({
              actor_id: this.user.id, action: 'booking.conflict_blocked', entity_type: 'booking',
              new_data: { reason: row.error, resources: resourceIds },
            });
            throw new Error(row.error || 'The booking was rejected by the conflict guard.');
          }
          await this.refreshFromSupabase();
          this.emit({ type: 'bookings' });
          const created = (this.db.bookings || []).find((b) => b.id === row.booking_id);
          const code = created ? created.status_code : code0;
          return { booking: created ? this.decorate(created) : null, status: code };
        }
        // Function not deployed -> fall through to the client-side insert path.
        if (error) {
          const missing = /does not exist|not found|PGRST202|404/i.test(error.message);
          if (!missing) throw new Error(error.message);
          this.rpcAvailable = false;
        }
      }

      const { data: booking, error } = await this.from('bookings').insert(record).select().single();
      if (error) throw new Error(error.message);
      const rows = resourceIds.map((rid) => ({ booking_id: booking.id, resource_id: Number(rid) }));
      const { error: e2 } = await this.from('booking_resources').insert(rows);
      if (e2) throw new Error(e2.message);

      if (code === STATUS.APPROVED) {
        await this.from('booking_approvals').insert({
          booking_id: booking.id, approver_id: this.user.id, action: 'approved',
          comments: 'Auto-approved: resource does not require approval.',
        });
      }
      if (attendees.length) {
        await this.from('booking_attendees').insert(attendees.map((a) => ({
          booking_id: booking.id, profile_id: a.profile_id || null,
          external_name: a.external_name || null, external_email: a.external_email || null,
          attendance_status: 'invited',
        })));
      }
      await this.refreshFromSupabase();
      await this.log('booking.requested', 'booking', String(booking.id), null, { reference: ref, resources: resourceIds, status: code });
      this.emit({ type: 'bookings' });
      return { booking: this.decorate(booking), status: code };
    }

    // ---- demo mode
    const id = (this.db.bookings.reduce((m, b) => Math.max(m, b.id), 0) || 0) + 1;
    const booking = { id, ...record, status_code: code, created_at: now };
    this.db.bookings.push(booking);
    resourceIds.forEach((rid) => this.db.booking_resources.push({ booking_id: id, resource_id: Number(rid) }));
    if (code === STATUS.APPROVED) {
      this.db.booking_approvals.push({
        id: this.db.booking_approvals.length + 1, booking_id: id, approver_id: this.user.id,
        action: 'approved', comments: 'Auto-approved: resource does not require approval.', created_at: now,
      });
    }
    attendees.forEach((a, i) => this.db.booking_attendees.push({
      id: this.db.booking_attendees.length + 1, booking_id: id, profile_id: a.profile_id || null,
      external_name: a.external_name || null, external_email: a.external_email || null,
      attendance_status: 'invited', created_at: now,
    }));
    this.pushAudit('booking.requested', 'booking', String(id), { reference: ref, resources: resourceIds, status: code });
    saveLocalDb(this.db);
    this.emit({ type: 'bookings' });
    return { booking: this.decorate(booking), status: code };
  }

  async decideBooking(bookingId, action, comments = '') {
    const b = (this.db.bookings || []).find((x) => x.id === Number(bookingId));
    if (!b) throw new Error('Booking not found');
    const now = new Date().toISOString();
    const code = action === 'approved' ? STATUS.APPROVED : STATUS.REJECTED;
    const patch = {
      status_id: this.statusIdFor(code),
      rejection_reason: action === 'rejected' ? (comments || 'No reason given.') : null,
      approved_at: action === 'approved' ? now : null,
      updated_at: now,
    };
    if (this.mode === 'live') {
      // Preferred: decide_booking() re-verifies conflicts and appends history
      // in one transaction, so approving can never create a double booking.
      if (this.decideRpc !== false) {
        const { data, error } = await this.rpc('decide_booking', {
          p_booking_id: Number(bookingId), p_action: action, p_comments: comments || null,
        });
        if (!error && Array.isArray(data) && data.length) {
          if (!data[0].ok) {
            await this.log('booking.approval_blocked', 'booking', String(bookingId), null, { reason: data[0].error });
            throw new Error(data[0].error);
          }
          await this.refreshFromSupabase();
          this.emit({ type: 'bookings' });
          return;
        }
        if (error) {
          if (!/does not exist|not found|PGRST202|404/i.test(error.message)) throw new Error(error.message);
          this.decideRpc = false;
        }
      }
      const { error } = await this.from('bookings').update(patch).eq('id', b.id);
      if (error) throw new Error(error.message);
      const { error: e2 } = await this.from('booking_approvals').insert({
        booking_id: b.id, approver_id: this.user.id, action, comments: comments || null,
      });
      if (e2) throw new Error(e2.message);
      await this.refreshFromSupabase();
    } else {
      Object.assign(b, patch, { status_code: code });
      this.db.booking_approvals.push({
        id: this.db.booking_approvals.length + 1, booking_id: b.id, approver_id: this.user.id,
        action, comments: comments || null, created_at: now,
      });
      saveLocalDb(this.db);
    }
    await this.log(`booking.${code}`, 'booking', String(b.id), { status: b.status_code }, { status: code });
    this.emit({ type: 'bookings' });
  }

  async cancelBooking(bookingId, reason = '') {
    const b = (this.db.bookings || []).find((x) => x.id === Number(bookingId));
    if (!b) throw new Error('Booking not found');
    const now = new Date().toISOString();
    const patch = {
      status_id: this.statusIdFor(STATUS.CANCELLED),
      cancellation_reason: reason || 'Cancelled by requester.',
      cancelled_at: now, updated_at: now,
    };
    if (this.mode === 'live') {
      if (this.decideRpc !== false) {
        const { data, error } = await this.rpc('decide_booking', {
          p_booking_id: Number(bookingId), p_action: 'cancelled', p_comments: reason || null,
        });
        if (!error && Array.isArray(data) && data.length) {
          if (!data[0].ok) throw new Error(data[0].error);
          await this.refreshFromSupabase();
          this.emit({ type: 'bookings' });
          return;
        }
        if (error) {
          if (!/does not exist|not found|PGRST202|404/i.test(error.message)) throw new Error(error.message);
          this.decideRpc = false;
        }
      }
      const { error } = await this.from('bookings').update(patch).eq('id', b.id);
      if (error) throw new Error(error.message);
      const { error: e2 } = await this.from('booking_approvals').insert({
        booking_id: b.id, approver_id: this.user.id, action: 'cancelled', comments: reason || null,
      });
      if (e2) throw new Error(e2.message);
      await this.refreshFromSupabase();
    } else {
      Object.assign(b, patch, { status_code: STATUS.CANCELLED });
      this.db.booking_approvals.push({
        id: this.db.booking_approvals.length + 1, booking_id: b.id, approver_id: this.user.id,
        action: 'cancelled', comments: reason || null, created_at: now,
      });
      saveLocalDb(this.db);
    }
    await this.log('booking.cancelled', 'booking', String(b.id), { status: b.status_code }, { status: STATUS.CANCELLED, reason });
    this.emit({ type: 'bookings' });
  }

  async setAttendeeStatus(attendeeId, status) {
    if (this.mode === 'live') {
      const { error } = await this.from('booking_attendees').update({ attendance_status: status }).eq('id', attendeeId);
      if (error) throw new Error(error.message);
      await this.refreshFromSupabase();
    } else {
      const a = this.db.booking_attendees.find((x) => x.id === attendeeId);
      if (a) a.attendance_status = status;
      saveLocalDb(this.db);
    }
    this.emit({ type: 'attendees' });
  }

  async addBlackout({ resourceId, start, end, reason }) {
    const now = new Date().toISOString();
    const row = {
      resource_id: Number(resourceId), start_time: new Date(start).toISOString(),
      end_time: new Date(end).toISOString(), reason, created_by: this.user.id, created_at: now,
    };
    if (this.mode === 'live') {
      const { error } = await this.from('resource_blackouts').insert(row);
      if (error) throw new Error(error.message);
      await this.refreshFromSupabase();
    } else {
      this.db.resource_blackouts.push({ id: this.db.resource_blackouts.length + 1, ...row });
      saveLocalDb(this.db);
    }
    await this.log('resource.blackout_added', 'resource', String(resourceId), null, { reason });
    this.emit({ type: 'resources' });
  }

  async removeBlackout(id) {
    if (this.mode === 'live') {
      const { error } = await this.from('resource_blackouts').delete().eq('id', id);
      if (error) throw new Error(error.message);
      await this.refreshFromSupabase();
    } else {
      this.db.resource_blackouts = this.db.resource_blackouts.filter((b) => b.id !== id);
      saveLocalDb(this.db);
    }
    this.emit({ type: 'resources' });
  }

  async addMaintenance({ resourceId, start, end, title, description, status = 'scheduled' }) {
    const now = new Date().toISOString();
    const row = {
      resource_id: Number(resourceId), start_time: new Date(start).toISOString(),
      end_time: end ? new Date(end).toISOString() : null, title, description: description || null,
      status, created_by: this.user.id, completed_at: null, created_at: now, updated_at: now,
    };
    if (this.mode === 'live') {
      const { error } = await this.from('maintenance_records').insert(row);
      if (error) throw new Error(error.message);
      await this.refreshFromSupabase();
    } else {
      this.db.maintenance_records.push({ id: this.db.maintenance_records.length + 1, ...row });
      saveLocalDb(this.db);
    }
    await this.log('resource.maintenance_added', 'resource', String(resourceId), null, { title, status });
    this.emit({ type: 'resources' });
  }

  async updateMaintenanceStatus(id, status) {
    const now = new Date().toISOString();
    const patch = { status, updated_at: now, completed_at: status === 'completed' ? now : null };
    if (this.mode === 'live') {
      const { error } = await this.from('maintenance_records').update(patch).eq('id', id);
      if (error) throw new Error(error.message);
      await this.refreshFromSupabase();
    } else {
      Object.assign(this.db.maintenance_records.find((m) => m.id === id) || {}, patch);
      saveLocalDb(this.db);
    }
    this.emit({ type: 'resources' });
  }

  async markNotificationRead(id) {
    if (this.mode === 'live') {
      const { error } = await this.from('notifications').update({ is_read: true, read_at: new Date().toISOString() }).eq('id', id);
      if (error) console.warn(error.message);
      await this.refreshFromSupabase();
    } else {
      const n = this.db.notifications.find((x) => x.id === id);
      if (n) { n.is_read = true; n.read_at = new Date().toISOString(); }
      saveLocalDb(this.db);
    }
    this.emit({ type: 'notifications' });
  }

  async markAllNotificationsRead() {
    if (this.mode === 'live') {
      const { error } = await this.from('notifications')
        .update({ is_read: true, read_at: new Date().toISOString() })
        .eq('user_id', this.user.id).eq('is_read', false);
      if (error) console.warn(error.message);
      await this.refreshFromSupabase();
    } else {
      this.db.notifications.forEach((n) => { if (n.user_id === this.user.id) { n.is_read = true; n.read_at = new Date().toISOString(); } });
      saveLocalDb(this.db);
    }
    this.emit({ type: 'notifications' });
  }

  async log(action, entityType, entityId, oldData, newData) {
    if (this.mode === 'live') {
      const { error } = await this.from('audit_logs').insert({
        actor_id: this.user?.id || null, action, entity_type: entityType,
        entity_id: entityId, old_data: oldData, new_data: newData,
      });
      if (error) console.warn('audit:', error.message);
    } else {
      this.pushAudit(action, entityType, entityId, newData);
      saveLocalDb(this.db);
    }
  }

  pushAudit(action, entityType, entityId, newData) {
    this.db.audit_logs = this.db.audit_logs || [];
    this.db.audit_logs.push({
      id: this.db.audit_logs.length + 1, actor_id: this.user?.id || null, action,
      entity_type: entityType, entity_id: entityId, old_data: null,
      new_data: newData, ip_address: null, created_at: new Date().toISOString(),
    });
  }

  auditLogs(limit = 200) {
    return (this.db.audit_logs || [])
      .slice()
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, limit)
      .map((a) => ({ ...a, actor_name: this.displayName(this.profileById(a.actor_id)) }));
  }

  resetDemo() {
    clearLocalDb();
    this.db = buildDemoDb();
    saveLocalDb(this.db);
    this.profile = this.db.profiles.find((p) => p.id === this.user?.id) || this.db.profiles[0];
    this.emit({ type: 'reset' });
  }
}

export const store = new Store();
