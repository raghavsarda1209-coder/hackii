-- ===========================================================================
-- CampusBook · 02 double-booking guard   (RUN THIS - it is the hard guarantee)
-- ===========================================================================
-- The browser runs a rich conflict engine for good UX, but the browser cannot
-- be trusted: two people can click "Book" in the same millisecond. This script
-- closes that race in the database, so double booking is impossible for ANY
-- writer - the app, PostgREST, the SQL editor, a nightly import.
--
-- Why a join table
--   bookings is many-to-many with resources via booking_resources, and the
--   turnaround buffer lives on the RESOURCE. Postgres cannot reference another
--   table inside an EXCLUDE constraint expression, so we materialise one row
--   per (booking, resource) in booking_resource_slots, holding the already
--   buffered interval. The EXCLUDE constraint then does the rest, and it can
--   never be bypassed.
--
-- Everything is idempotent: safe to re-run.
-- ===========================================================================

create extension if not exists btree_gist;   -- needed for "resource_id WITH ="

-- =========================================================== 1. slot table
create table if not exists public.booking_resource_slots (
  booking_id   bigint      not null references public.bookings(id) on delete cascade,
  resource_id  bigint      not null references public.resources(id)  on delete cascade,
  range_start  timestamptz not null,
  range_end    timestamptz not null,
  slot_held    boolean     not null default true,
  status_code  text        not null default 'pending',
  updated_at   timestamptz not null default now(),
  constraint booking_resource_slots_pkey primary key (booking_id, resource_id),
  constraint booking_resource_slots_range_valid check (range_end > range_start)
);

-- The overlap index. GIST on (resource_id, tstzrange) answers "who else holds
-- this resource at this time" in one index scan.
create index if not exists booking_resource_slots_gix
  on public.booking_resource_slots
  using gist (resource_id, tstzrange(range_start, range_end, '[)'));

create index if not exists booking_resource_slots_resource_time
  on public.booking_resource_slots (resource_id, range_start, range_end);

-- ---------------------------------------------------------------- 2. the guard
-- Second held row for the same resource with an overlapping buffered interval
-- is rejected by Postgres itself.
alter table public.booking_resource_slots
  drop constraint if exists slots_no_overlap;
alter table public.booking_resource_slots
  add constraint slots_no_overlap
  exclude using gist (
    resource_id with =,
    tstzrange(range_start, range_end, '[)') with &&
  )
  where (slot_held);

-- ------------------------------------------------------- 3. sync machinery
-- Recompute the slot rows for one booking from bookings + resources.
-- Deletes first, then re-inserts: if the new interval clashes, the whole
-- statement (and therefore the whole booking update) is rolled back.
create or replace function public.sync_booking_slots(p_booking_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  b       public.bookings%ROWTYPE;
  held    boolean;
  code    text;
begin
  select * into b from public.bookings where id = p_booking_id;
  if b.id is null then return; end if;   -- booking gone, cascade handled it

  select s.code, (s.code in ('pending', 'approved', 'completed'))
    into code, held
  from public.booking_statuses s
  where s.id = b.status_id;

  code := coalesce(code, 'pending');
  held := coalesce(held, false);

  delete from public.booking_resource_slots where booking_id = p_booking_id;

  insert into public.booking_resource_slots
    (booking_id, resource_id, range_start, range_end, slot_held, status_code)
  select p_booking_id,
         br.resource_id,
         b.start_time - make_interval(mins => coalesce(r.buffer_before_minutes, 0)),
         b.end_time   + make_interval(mins => coalesce(r.buffer_after_minutes,  0)),
         held,
         code
  from public.booking_resources br
  join public.resources r on r.id = br.resource_id
  where br.booking_id = p_booking_id;
end $$;

-- booking_resources inserted -> materialise the slot
create or replace function public.trg_booking_resources_ai()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  perform public.sync_booking_slots(new.booking_id);
  return new;
end $$;

drop trigger if exists booking_resources_slot_sync on public.booking_resources;
create trigger booking_resources_slot_sync
  after insert or update of booking_id, resource_id
  on public.booking_resources
  for each row execute function public.trg_booking_resources_ai();

-- booking resources removed -> drop the slot
create or replace function public.trg_booking_resources_ad()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  perform public.sync_booking_slots(old.booking_id);
  return old;
end $$;

drop trigger if exists booking_resources_slot_drop on public.booking_resources;
create trigger booking_resources_slot_drop
  after delete on public.booking_resources
  for each row execute function public.trg_booking_resources_ad();

-- booking times / status changed -> re-derive every slot for that booking.
-- This is what makes approving, cancelling or rescheduling safe.
create or replace function public.trg_bookings_slot_sync()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  perform public.sync_booking_slots(new.id);
  return new;
end $$;

drop trigger if exists bookings_slot_sync on public.bookings;
create trigger bookings_slot_sync
  after update of start_time, end_time, status_id
  on public.bookings
  for each row execute function public.trg_bookings_slot_sync();

-- ------------------------------------------------------------ 4. backfill
do $$
declare r record;
begin
  for r in select distinct booking_id from public.booking_resources loop
    perform public.sync_booking_slots(r.booking_id);
  end loop;
end $$;

-- If historical data already contains overlaps the constraint will fail here.
-- Find them first with:
--   select resource_id, count(*) from public.booking_resource_slots
--    where slot_held group by 1;

-- ================================================== 5. read helpers for the UI
-- Buffer-aware conflict probe. Mirrors js/conflicts.js exactly.
create or replace function public.check_slot_conflict(
  p_resource_id        bigint,
  p_start_time         timestamptz,
  p_end_time           timestamptz,
  p_exclude_booking_id bigint default null
)
returns table (
  conflict      boolean,
  booking_id    bigint,
  reference     text,
  title         text,
  start_time    timestamptz,
  end_time      timestamptz,
  status_code   text
)
language sql
stable
security definer
set search_path = public
as $$
  with probe as (
    select p_resource_id as rid,
           p_start_time - make_interval(mins => coalesce(r.buffer_before_minutes, 0)) as s,
           p_end_time   + make_interval(mins => coalesce(r.buffer_after_minutes,  0)) as e
    from public.resources r where r.id = p_resource_id
  )
  select (count(*) > 0),
         min(b.id), min(b.booking_reference)::text, min(b.title)::text,
         min(b.start_time), min(b.end_time), min(sl.status_code)::text
  from probe p
  join public.booking_resource_slots sl
    on sl.resource_id = p.rid
   and sl.slot_held
   and tstzrange(sl.range_start, sl.range_end, '[)') && tstzrange(p.s, p.e, '[)')
  left join public.bookings b on b.id = sl.booking_id
  where p_exclude_booking_id is null or sl.booking_id <> p_exclude_booking_id;
$$;

-- Everything that must be re-checked inside the write transaction.
create or replace function public.slot_blocked_reasons(
  p_resource_id bigint,
  p_start_time  timestamptz,
  p_end_time    timestamptz,
  p_headcount   integer default null,
  p_exclude     bigint default null
)
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  r       public.resources%ROWTYPE;
  reasons text[] := '{}';
  s       timestamptz;
  e       timestamptz;
  local_s time;
  local_e time;
  dow     int;
  c       record;
begin
  select * into r from public.resources where id = p_resource_id;
  if r.id is null then return array['Unknown resource']; end if;

  s := p_start_time - make_interval(mins => coalesce(r.buffer_before_minutes, 0));
  e := p_end_time   + make_interval(mins => coalesce(r.buffer_after_minutes, 0));

  if not r.is_active   then reasons := reasons || format('%s is out of service', r.name); end if;
  if not r.is_bookable then reasons := reasons || format('%s is not bookable', r.name); end if;
  if p_end_time <= p_start_time then reasons := reasons || 'End time is not after the start time'; end if;

  -- duration limits
  if (p_end_time - p_start_time) < make_interval(mins => r.minimum_booking_minutes) then
    reasons := reasons || format('%s has a %s minute minimum booking', r.name, r.minimum_booking_minutes);
  end if;
  if r.maximum_booking_minutes is not null
     and (p_end_time - p_start_time) > make_interval(mins => r.maximum_booking_minutes) then
    reasons := reasons || format('%s has a %s minute maximum booking', r.name, r.maximum_booking_minutes);
  end if;

  -- published opening hours
  if exists (select 1 from public.resource_availability a where a.resource_id = r.id) then
    local_s := (p_start_time at time zone current_setting('TimeZone'))::time;
    local_e := (p_end_time   at time zone current_setting('TimeZone'))::time;
    dow := extract(dow from p_start_time at time zone current_setting('TimeZone'))::int;
    if not exists (
      select 1 from public.resource_availability a
       where a.resource_id = r.id and a.is_available and a.day_of_week = dow
         and local_s >= a.start_time and local_e <= a.end_time
    ) then
      reasons := reasons || format('%s is closed or outside its published hours at that time', r.name);
    end if;
  end if;

  -- hard overlaps (uses the same index as the constraint)
  for c in
    select b.booking_reference, b.title, b.start_time, b.end_time
    from public.booking_resource_slots sl
    join public.bookings b on b.id = sl.booking_id
    where sl.resource_id = r.id and sl.slot_held
      and tstzrange(sl.range_start, sl.range_end, '[)') && tstzrange(s, e, '[)')
      and (p_exclude is null or sl.booking_id <> p_exclude)
  loop
    reasons := reasons || format('Double booking: %s ("%s") already holds %s to %s',
      c.booking_reference, c.title, c.start_time, c.end_time);
  end loop;

  -- blackouts
  if exists (
    select 1 from public.resource_blackouts b
     where b.resource_id = r.id and b.start_time < p_end_time and b.end_time > p_start_time
  ) then
    reasons := reasons || format('%s is blocked during that window', r.name);
  end if;

  -- maintenance
  if exists (
    select 1 from public.maintenance_records m
     where m.resource_id = r.id and m.status in ('scheduled', 'in_progress')
       and m.start_time < p_end_time and (m.end_time is null or m.end_time > p_start_time)
  ) then
    reasons := reasons || format('%s is under maintenance during that window', r.name);
  end if;

  -- capacity
  if p_headcount is not null and r.capacity is not null and p_headcount > r.capacity then
    reasons := reasons || format('%s seats only %s people', r.name, r.capacity);
  end if;

  return reasons;
end $$;

-- ================================================== 6. atomic create_booking
create or replace function public.create_booking(
  p_title             text,
  p_description       text default null,
  p_purpose           text default null,
  p_start             timestamptz,
  p_end               timestamptz,
  p_resource_ids      bigint[],
  p_attendee_count    integer default null,
  p_requirements      text default null,
  p_attendee_profiles uuid[] default null,
  p_external_attendees text[] default null,          -- 'Name <email>' per entry
  p_series_id         bigint  default null,
  p_occurrence        integer default null
)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user    uuid := auth.uid();
  v_booking public.bookings%ROWTYPE;
  v_pending smallint;
  v_auto    smallint;
  v_ref     text;
  v_rid     bigint;
  v_reasons text[];
  v_att     text;
  v_name    text;
  v_email   text;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_title, ''))) = 0 then
    raise exception 'A title is required' using errcode = '22007';
  end if;
  if coalesce(array_length(p_resource_ids, 1), 0) = 0 then
    raise exception 'No resource selected' using errcode = '22007';
  end if;
  if not exists (select 1 from public.profiles where id = v_user) then
    raise exception 'No profile row for the signed-in user' using errcode = '42501';
  end if;

  -- every rule, for every selected resource, before anything is written
  foreach v_rid in array p_resource_ids loop
    v_reasons := public.slot_blocked_reasons(v_rid, p_start, p_end, p_attendee_count, null);
    if coalesce(array_length(v_reasons, 1), 0) > 0 then
      raise exception '%', array_to_string(v_reasons, E'\n') using errcode = '23P01';
    end if;
  end loop;

  -- the requester is not already booked then (no person double booking)
  if exists (
    select 1
    from public.booking_resource_slots sl
    join public.bookings b on b.id = sl.booking_id
    join public.booking_resources br on br.booking_id = b.id
    where b.requested_by = v_user
      and sl.slot_held
      and tstzrange(sl.range_start, sl.range_end, '[)')
          && tstzrange(p_start, p_end, '[)')
  ) then
    raise exception 'You already have a booking that overlaps this time' using errcode = '22007';
  end if;

  -- pending if any selected resource needs approval, otherwise instant
  select id into v_pending from public.booking_statuses where code = 'pending';
  select id into v_auto   from public.booking_statuses where code = 'approved';
  if exists (
    select 1 from public.resources
     where id = any(p_resource_ids) and (requires_approval or not is_active or not is_bookable)
  ) then
    v_auto := v_pending;
  end if;

  v_ref := 'BK-' || to_char(now(), 'YYYYMMDD') || '-' ||
           upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));

  insert into public.bookings
    (booking_reference, requested_by, booking_series_id, title, description, purpose,
     status_id, start_time, end_time, attendee_count, special_requirements,
     approved_at, updated_at)
  values
    (v_ref, v_user, p_series_id, trim(p_title), p_description, p_purpose,
     v_auto, p_start, p_end, p_attendee_count, p_requirements,
     case when v_auto is distinct from v_pending then now() else null end, now())
  returning * into v_booking;

  insert into public.booking_resources (booking_id, resource_id)
  select v_booking.id, unnest(p_resource_ids);

  -- campus members
  if p_attendee_profiles is not null and array_length(p_attendee_profiles, 1) > 0 then
    insert into public.booking_attendees (booking_id, profile_id, attendance_status)
    select v_booking.id, unnest(p_attendee_profiles), 'invited';
  end if;

  -- externals: booking_attendees requires profile_id OR external_email
  if p_external_attendees is not null then
    foreach v_att in array p_external_attendees loop
      v_name  := trim(split_part(v_att, '<', 1));
      v_email := trim(coalesce(split_part(v_att, '>', 1), ''));
      if v_email <> '' then
        insert into public.booking_attendees
          (booking_id, profile_id, external_name, external_email, attendance_status)
        values (v_booking.id, null, v_name, v_email, 'invited');
      end if;
    end loop;
  end if;

  if v_auto is distinct from v_pending then
    insert into public.booking_approvals (booking_id, approver_id, action, comments)
    values (v_booking.id, v_user, 'approved',
            'Auto-approved: no resource in this request requires approval.');
  end if;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, new_data)
  values (v_user, 'booking.requested', 'booking', v_booking.id,
          jsonb_build_object('reference', v_ref, 'resources', p_resource_ids,
                             'status', case when v_auto = v_pending then 'pending' else 'approved' end));

  return v_booking;
end $$;

-- Non-throwing wrapper: the UI shows the message verbatim instead of a 500.
create or replace function public.create_booking_safe(
  p_title text, p_description text default null, p_purpose text default null,
  p_start timestamptz, p_end timestamptz, p_resource_ids bigint[],
  p_attendee_count integer default null, p_requirements text default null,
  p_attendee_profiles uuid[] default null, p_external_attendees text[] default null,
  p_series_id bigint default null, p_occurrence integer default null
)
returns table (ok boolean, booking_id bigint, reference text, status text, error text)
language plpgsql
security definer
set search_path = public
as $$
declare b public.bookings%ROWTYPE;
begin
  begin
    b := public.create_booking(
      p_title, p_description, p_purpose, p_start, p_end, p_resource_ids,
      p_attendee_count, p_requirements, p_attendee_profiles, p_external_attendees,
      p_series_id, p_occurrence);

    return query
      select true, b.id, b.booking_reference, s.code, null::text
      from public.booking_statuses s where s.id = b.status_id;
  exception
    when exclusion_violation then
      return query select false, null::bigint, null::text, null::text,
        'Double booking prevented - another request already holds that slot. Pick a different time.';
    when others then
      return query select false, null::bigint, null::text, null::text, sqlerrm;
  end;
end $$;

-- Approve / reject / cancel, each re-verifying before it commits.
create or replace function public.decide_booking(
  p_booking_id bigint,
  p_action     text,
  p_comments   text default null
)
returns table (ok boolean, error text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  b      public.bookings%ROWTYPE;
  v_code text;
  v_id   smallint;
  v_rid  bigint;
  v_reasons text[];
  v_banned boolean;
begin
  if v_user is null then raise exception 'Not authenticated' using errcode = '42501'; end if;

  if not exists (
    select 1 from public.profile_roles pr
      join public.roles r on r.id = pr.role_id
     where pr.profile_id = v_user
       and r.name in ('faculty','resource_manager','department_admin','campus_admin','super_admin')
  ) then
    raise exception 'You are not allowed to decide bookings' using errcode = '42501';
  end if;

  select * into b from public.bookings where id = p_booking_id;
  if b.id is null then raise exception 'Booking not found' using errcode = 'P0002'; end if;
  if p_action not in ('approved','rejected','cancelled','requested_changes') then
    raise exception 'Unknown action %', p_action using errcode = '22023';
  end if;

  -- approving must not create a double booking
  if p_action = 'approved' then
    foreach v_rid in
      select br.resource_id from public.booking_resources br where br.booking_id = p_booking_id
    loop
      v_reasons := public.slot_blocked_reasons(v_rid, b.start_time, b.end_time, b.attendee_count, p_booking_id);
      if coalesce(array_length(v_reasons, 1), 0) > 0 then
        return query select false,
          format('Cannot approve - %s', array_to_string(v_reasons, '; '));
        return;
      end if;
    end loop;
  end if;

  select id, code into v_id, v_code
  from public.booking_statuses
  where code = case p_action
                  when 'approved'  then 'approved'
                  when 'rejected'  then 'rejected'
                  when 'cancelled' then 'cancelled'
                  else 'pending' end;

  update public.bookings
     set status_id = v_id,
         approved_at = case when p_action = 'approved' then now() else approved_at end,
         cancelled_at = case when p_action = 'cancelled' then now() else cancelled_at end,
         rejection_reason    = case when p_action = 'rejected'  then p_comments else rejection_reason end,
         cancellation_reason = case when p_action = 'cancelled' then p_comments else cancellation_reason end,
         updated_at = now()
   where id = p_booking_id;

  insert into public.booking_approvals (booking_id, approver_id, action, comments)
  values (p_booking_id, v_user, p_action, p_comments);

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, new_data)
  values (v_user, 'booking.' || v_code, 'booking', p_booking_id,
          jsonb_build_object('action', p_action, 'comments', p_comments));

  return query select true, null::text;
end $$;

-- ============================================ 7. approver notifications
create or replace function public.notify_approvers()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_approver uuid;
  v_res      text;
begin
  if new.status_id in (select id from public.booking_statuses where code = 'pending') then
    select string_agg(r.name, ', ') into v_res
      from public.booking_resources br
      join public.resources r on r.id = br.resource_id
     where br.booking_id = new.id;

    for v_approver in
      select pr.profile_id
        from public.profile_roles pr
        join public.roles r on r.id = pr.role_id
       where r.name in ('faculty','resource_manager','department_admin','campus_admin','super_admin')
    loop
      insert into public.notifications (user_id, booking_id, type, title, message)
      values (v_approver, new.id, 'approval_request',
              'Approval needed: ' || new.title,
              new.booking_reference || ' requested ' || coalesce(v_res, 'a resource') || '.');
    end loop;
  end if;
  return new;
end $$;

drop trigger if exists bookings_notify_approvers on public.bookings;
create trigger bookings_notify_approvers
  after insert on public.bookings
  for each row execute function public.notify_approvers();

-- Tell the requester about the outcome.
create or replace function public.notify_requester()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status_id is distinct from old.status_id then
    insert into public.notifications (user_id, booking_id, type, title, message)
    select new.requested_by, new.id, 'booking.' || s.code,
           'Booking ' || initcap(s.code) || ': ' || new.title,
           coalesce(new.rejection_reason, new.cancellation_reason,
                    'Your booking ' || new.booking_reference || ' is now ' || s.code)
      from public.booking_statuses s where s.id = new.status_id;
  end if;
  return new;
end $$;

drop trigger if exists bookings_notify_requester on public.bookings;
create trigger bookings_notify_requester
  after update of status_id on public.bookings
  for each row execute function public.notify_requester();

-- ================================================ 8. useful reporting views
drop view if exists public.resource_schedule;
create or replace view public.resource_schedule
with (security_invoker = true) as
select r.id as resource_id, r.code, r.name as resource_name, r.is_bookable, r.is_active,
       r.requires_approval, r.capacity,
       r.minimum_booking_minutes, r.maximum_booking_minutes,
       r.buffer_before_minutes, r.buffer_after_minutes,
       sl.booking_id, sl.range_start as block_start, sl.range_end as block_end,
       b.booking_reference, b.title, sl.status_code,
       b.start_time, b.end_time, b.requested_by
  from public.resources r
  left join public.booking_resource_slots sl on sl.resource_id = r.id and sl.slot_held
  left join public.bookings b on b.id = sl.booking_id;

-- Next 14 days: the fastest "what is free" query the app can run.
create or replace function public.free_slots(
  p_resource_id bigint,
  p_from        timestamptz,
  p_to          timestamptz,
  p_minutes     integer default 60
)
returns table (slot_start timestamptz, slot_end timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select gs, gs + make_interval(mins => p_minutes)
  from generate_series(
         date_trunc('hour', greatest(p_from, now())) ,
         p_to - make_interval(mins => p_minutes),
         interval '30 minutes'
       ) as gs
  where public.slot_blocked_reasons(p_resource_id, gs, gs + make_interval(mins => p_minutes))
        = '{}'
    and p_minutes >= (select minimum_booking_minutes from public.resources where id = p_resource_id)
    and (p_minutes <= (select maximum_booking_minutes from public.resources where id = p_resource_id)
         or (select maximum_booking_minutes from public.resources where id = p_resource_id) is null)
  order by gs
  limit 60;
$$;

-- ===================================================== 9. grants
grant usage on schema public to anon, authenticated;
grant select on public.booking_resource_slots to authenticated;
grant select on public.resource_schedule to authenticated;
grant execute on function public.check_slot_conflict(bigint, timestamptz, timestamptz, bigint) to authenticated;
grant execute on function public.slot_blocked_reasons(bigint, timestamptz, timestamptz, integer, bigint) to authenticated;
grant execute on function public.free_slots(bigint, timestamptz, timestamptz, integer) to authenticated;
grant execute on function public.sync_booking_slots(bigint) to authenticated;
grant execute on function public.create_booking(text, text, text, timestamptz, timestamptz, bigint[], integer, text, uuid[], text[], bigint, integer) to authenticated;
grant execute on function public.create_booking_safe(text, text, text, timestamptz, timestamptz, bigint[], integer, text, uuid[], text[], bigint, integer) to authenticated;
grant execute on function public.decide_booking(bigint, text, text) to authenticated;
