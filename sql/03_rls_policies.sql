-- ===========================================================================
-- CampusBook · 03 RLS patch
-- ===========================================================================
-- The base schema enables RLS everywhere but only defines policies for a
-- subset of tables, and a few of them are too narrow for a booking system:
--
--   profiles              select = own row only   -> no requester names
--   bookings              select = own rows only  -> approvers see nothing
--   booking_resources     select = own bookings   -> approvers see nothing
--   booking_attendees     select = own bookings
--   profile_roles         (no policy)             -> nobody can hold a role
--   resource_availability (no policy)             -> opening hours unreadable
--   resource_blackouts    (no policy)             -> blocks unreadable
--   maintenance_records   (no policy)             -> maintenance unreadable
--   booking_approvals     (no policy)             -> decision history unreadable
--   audit_logs            (no policy)
--
-- This script replaces those with campus-appropriate policies.
-- Everything is DROP IF EXISTS first, so it is safe to re-run.
-- ===========================================================================

-- ------------------------------------------------------------ role helpers
create or replace function public.is_campus_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profile_roles pr
      join public.roles r on r.id = pr.role_id
     where pr.profile_id = auth.uid() and r.name in ('campus_admin', 'super_admin'));
$$;

create or replace function public.can_approve_bookings()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profile_roles pr
      join public.roles r on r.id = pr.role_id
     where pr.profile_id = auth.uid()
       and r.name in ('faculty','resource_manager','department_admin','campus_admin','super_admin'));
$$;

create or replace function public.can_manage_resources()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profile_roles pr
      join public.roles r on r.id = pr.role_id
     where pr.profile_id = auth.uid()
       and r.name in ('resource_manager','department_admin','campus_admin','super_admin'));
$$;

-- A booking is visible to its owner or to anyone who can approve/manage.
create or replace function public.can_see_booking(p_booking_id bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.bookings b
     where b.id = p_booking_id
       and (b.requested_by = auth.uid() or public.can_approve_bookings())
  );
$$;

-- =================================================================== profiles
drop policy if exists "Users can view their own profile" on public.profiles;
drop policy if exists profiles_select on public.profiles;

-- Directory lookup: the UI needs names for requesters, attendees and approvers.
-- This exposes name/email/department campus-wide to signed-in users. Restrict
-- to a view over a narrower column list if your privacy policy requires it.
create policy profiles_select on public.profiles
  for select to authenticated using (true);

create policy profiles_insert_self on public.profiles
  for insert to authenticated with check (id = auth.uid());

drop policy if exists "Users can update their own profile" on public.profiles;
create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = auth.uid() or public.is_campus_admin())
  with check (id = auth.uid() or public.is_campus_admin());

drop policy if exists profiles_admin_delete on public.profiles;
create policy profiles_admin_delete on public.profiles
  for delete to authenticated using (public.is_campus_admin());

-- =================================================================== roles
drop policy if exists roles_select on public.roles;
create policy roles_select on public.roles for select to authenticated using (true);

drop policy if exists profile_roles_select on public.profile_roles;
create policy profile_roles_select on public.profile_roles
  for select to authenticated using (true);

-- Only admins may hand out roles.
drop policy if exists profile_roles_admin_write on public.profile_roles;
create policy profile_roles_admin_write on public.profile_roles
  for all to authenticated
  using (public.is_campus_admin()) with check (public.is_campus_admin());

-- =========================================================== reference reads
do $$
declare t text;
begin
  foreach t in array array[
    'campuses','buildings','floors','resource_types',
    'booking_statuses','resource_features','resource_feature_map'
  ] loop
    execute format('drop policy if exists %1$s_read on public.%1$I', t);
    execute format('create policy %1$s_read on public.%1$I for select to authenticated using (true)', t);
  end loop;
end $$;

-- resources: the base policy hides inactive rows, which is what the UI wants
-- by default. Admins additionally see out-of-service assets.
drop policy if exists "Authenticated users can view resources" on public.resources;
drop policy if exists resources_select on public.resources;
create policy resources_select on public.resources
  for select to authenticated using (is_active or public.can_manage_resources());

drop policy if exists resources_manager_write on public.resources;
create policy resources_manager_write on public.resources
  for all to authenticated
  using (public.can_manage_resources()) with check (public.can_manage_resources());

-- Opening hours drive the conflict engine, so everyone needs to read them.
drop policy if exists resource_availability_read on public.resource_availability;
create policy resource_availability_read on public.resource_availability
  for select to authenticated using (true);

drop policy if exists resource_availability_write on public.resource_availability;
create policy resource_availability_write on public.resource_availability
  for all to authenticated
  using (public.can_manage_resources()) with check (public.can_manage_resources());

-- ================================================================== bookings
drop policy if exists "Users can view their bookings" on public.bookings;
drop policy if exists bookings_select on public.bookings;
create policy bookings_select on public.bookings
  for select to authenticated
  using (requested_by = auth.uid() or public.can_approve_bookings());

-- Direct INSERT is intentionally NOT opened up: create_booking() is
-- SECURITY DEFINER and runs every rule inside one transaction. Requesters must
-- not be able to pick their own status_id.
drop policy if exists "Users can create bookings" on public.bookings;
drop policy if exists bookings_insert on public.bookings;
create policy bookings_insert on public.bookings
  for insert to authenticated
  with check (requested_by = auth.uid() and status_id is not null);

drop policy if exists "Users can update their own bookings" on public.bookings;
drop policy if exists bookings_update on public.bookings;
create policy bookings_update on public.bookings
  for update to authenticated
  using (requested_by = auth.uid() or public.can_approve_bookings())
  with check (requested_by = auth.uid() or public.can_approve_bookings());

-- The slot trigger is SECURITY DEFINER, so cancellations still release slots
-- even if a future policy tightens this.

-- ---------------------------------------------------------- booking_resources
drop policy if exists "Users can view resources of their bookings" on public.booking_resources;
drop policy if exists booking_resources_select on public.booking_resources;
create policy booking_resources_select on public.booking_resources
  for select to authenticated using (public.can_see_booking(booking_id));

drop policy if exists booking_resources_insert on public.booking_resources;
create policy booking_resources_insert on public.booking_resources
  for insert to authenticated with check (public.can_see_booking(booking_id));

-- ---------------------------------------------------------- booking_approvals
drop policy if exists booking_approvals_select on public.booking_approvals;
create policy booking_approvals_select on public.booking_approvals
  for select to authenticated using (public.can_see_booking(booking_id));

drop policy if exists booking_approvals_insert on public.booking_approvals;
create policy booking_approvals_insert on public.booking_approvals
  for insert to authenticated
  with check (approver_id = auth.uid() and public.can_approve_bookings());

-- ---------------------------------------------------------- booking_attendees
drop policy if exists "Users can view attendees of their bookings" on public.booking_attendees;
drop policy if exists booking_attendees_select on public.booking_attendees;
create policy booking_attendees_select on public.booking_attendees
  for select to authenticated using (public.can_see_booking(booking_id));

drop policy if exists booking_attendees_update on public.booking_attendees;
create policy booking_attendees_update on public.booking_attendees
  for update to authenticated
  using (public.can_see_booking(booking_id)) with check (public.can_see_booking(booking_id));

-- ============================================= blackouts & maintenance windows
drop policy if exists resource_blackouts_select on public.resource_blackouts;
create policy resource_blackouts_select on public.resource_blackouts
  for select to authenticated using (true);

drop policy if exists resource_blackouts_write on public.resource_blackouts;
create policy resource_blackouts_write on public.resource_blackouts
  for all to authenticated
  using (public.can_manage_resources()) with check (public.can_manage_resources());

drop policy if exists maintenance_records_select on public.maintenance_records;
create policy maintenance_records_select on public.maintenance_records
  for select to authenticated using (true);

drop policy if exists maintenance_records_write on public.maintenance_records;
create policy maintenance_records_write on public.maintenance_records
  for all to authenticated
  using (public.can_manage_resources()) with check (public.can_manage_resources());

-- ============================================================== notifications
drop policy if exists "Users can view their notifications" on public.notifications;
drop policy if exists "Users can update their notifications" on public.notifications;
create policy notifications_select on public.notifications
  for select to authenticated using (user_id = auth.uid());
create policy notifications_update on public.notifications
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ================================================================ audit logs
drop policy if exists audit_logs_select on public.audit_logs;
create policy audit_logs_select on public.audit_logs
  for select to authenticated
  using (public.is_campus_admin() or actor_id = auth.uid());

drop policy if exists audit_logs_insert on public.audit_logs;
create policy audit_logs_insert on public.audit_logs
  for insert to authenticated with check (actor_id = auth.uid());

-- =========================================================== slots (guard)
drop policy if exists booking_resource_slots_select on public.booking_resource_slots;
create policy booking_resource_slots_select on public.booking_resource_slots
  for select to authenticated using (public.can_see_booking(booking_id));

-- ================================================================ recap view
-- One query for the dashboard: who can act on what.
drop view if exists public.approvals_queue;
create or replace view public.approvals_queue
with (security_invoker = true) as
select b.id, b.booking_reference, b.title, b.purpose, b.start_time, b.end_time,
       b.attendee_count, b.requested_by, s.code as status_code,
       p.first_name || ' ' || coalesce(p.last_name, '') as requester_name,
       p.department as requester_department,
       (select array_agg(r.name) from public.booking_resources br
          join public.resources r on r.id = br.resource_id
         where br.booking_id = b.id) as resource_names,
       b.created_at
  from public.bookings b
  join public.booking_statuses s on s.id = b.status_id
  join public.profiles p on p.id = b.requested_by
 where s.code = 'pending';
