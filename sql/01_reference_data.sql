-- ===========================================================================
-- CampusBook · 01 catalogue data
-- ===========================================================================
-- The base schema already seeds roles, booking_statuses and resource_types,
-- so this file only adds what is missing:
--   * the amenity/feature catalogue used by the resource filters
--   * an optional demo campus with a handful of resources and opening hours
--
-- Roles seeded by the schema: student, faculty, staff, resource_manager,
-- department_admin, campus_admin, super_admin.
-- Resource types seeded: Classroom, Laboratory, Seminar Hall, Auditorium,
-- Conference Room, Computer Lab, Sports Facility, Equipment.
--
-- Idempotent: safe to re-run. The demo campus block is skipped once any
-- campus exists.
-- ===========================================================================

-- ================================================================== features
insert into public.resource_features (name, description) values
  ('Projector',          'Ceiling mounted or portable projector'),
  ('Whiteboard',         'Writable board with markers'),
  ('Smart Board',        'Interactive touch display'),
  ('Video Conferencing', 'Camera, microphone and display for online classes'),
  ('Air Conditioned',    'Climate controlled'),
  ('PA System',          'Public address microphones and speakers'),
  ('Lab Benches',        'Stainless work benches with sinks'),
  ('Fume Hood',          'Certified fume extraction'),
  ('Podcast Kit',        'Multi microphone audio recorder'),
  ('Football Turf',      'Full pitch with flood lighting'),
  ('Chairs (Stackable)', 'Stackable seating'),
  ('3D Printer',         'FDM / SLA additive manufacturing')
on conflict (name) do nothing;

-- Safety + access features: the booking wizard shows them as requirements.
insert into public.resource_features (name, description) values
  ('Step Free Access',   'Accessible without stairs'),
  ('Secure Storage',     'Lockable equipment cabinet'),
  ('Ventilated',         'Mechanical ventilation')
on conflict (name) do nothing;

-- ================================================================ demo campus
do $$
declare
  v_campus  bigint;
  v_main    bigint;
  v_sci     bigint;
  v_rec     bigint;
  v_f0      bigint;
  v_f1      bigint;
  v_f3      bigint;
  v_class   bigint;
  v_semi    bigint;
  v_lab     bigint;
  v_conf    bigint;
  v_aud     bigint;
  v_sports  bigint;
  v_equip   bigint;
  r         record;
  created   int := 0;
begin
  if exists (select 1 from public.campuses) then
    raise notice 'Campus data already present - skipping demo campus block.';
    return;
  end if;

  insert into public.campuses (name, code, address, latitude, longitude)
  values ('Northfield Institute of Technology', 'NIT',
          '14 Innovation Ridge Road, Northfield', 51.5072, -0.1276)
  returning id into v_campus;

  insert into public.buildings (campus_id, name, code, description) values
    (v_campus, 'Main Academic Block',            'MAIN', 'Teaching spaces and administration'),
    (v_campus, 'Science &amp; Engineering Tower',  'SCI',  'Laboratories and workshops'),
    (v_campus, 'Recreation Pavilion',           'REC',  'Sports facilities and auditorium')
  returning id into v_main;
  v_sci  := v_main + 1;
  v_rec  := v_main + 2;

  insert into public.floors (building_id, floor_number, name) values
    (v_main, 0, 'Ground Floor'),
    (v_main, 2, 'Second Floor'),
    (v_sci,  0, 'Ground Floor - Lab Wing'),
    (v_sci,  3, 'Third Floor - Research'),
    (v_rec,  0, 'Ground Floor')
  returning id into v_f0;
  v_f1 := v_f0 + 1;
  v_f3 := v_f0 + 3;

  select id into v_class  from public.resource_types where name = 'Classroom';
  select id into v_semi   from public.resource_types where name = 'Seminar Hall';
  select id into v_lab    from public.resource_types where name = 'Laboratory';
  select id into v_conf   from public.resource_types where name = 'Conference Room';
  select id into v_aud    from public.resource_types where name = 'Auditorium';
  select id into v_sports from public.resource_types where name = 'Sports Facility';
  select id into v_equip  from public.resource_types where name = 'Equipment';

  -- name, type, building, floor, capacity, min, max, buf_before, buf_after, approval
  for r in
    select * from (values
      ('Classroom LH-101 Orion',        v_class, v_main, v_f0, 120, 60,  480, 10, 10, true),
      ('Classroom LH-204 Vega',         v_class, v_main, v_f1,  80, 60,  480, 10, 10, true),
      ('Seminar Hall SR-310 Cedar',     v_semi,  v_main, v_f1,  16, 30,  240,  5,  5, false),
      ('Seminar Hall SR-311 Teak',      v_semi,  v_main, v_f1,  16, 30,  240,  5,  5, false),
      ('Computer Lab CL-G04',           v_lab,   v_sci,  v_f0,  60, 60,  240, 15, 15, true),
      ('Laboratory PH-201 Physics',     v_lab,   v_sci,  v_f0,  32, 90,  360, 20, 20, true),
      ('Conference Room BR-12',         v_conf,  v_main, v_f1,  14, 30,  480, 10, 10, false),
      ('Auditorium Hall A',             v_aud,   v_rec,  v_f3, 400,120,  600, 30, 30, true),
      ('Sports Facility Turf 1',        v_sports,v_rec,  v_f3,  22, 60,  240, 15, 15, false),
      ('Equipment 3D Printer Bay',      v_equip, v_sci,  v_f3,  12, 30,  360, 10, 10, true)
    ) as t(name, rtype, bldg, flr, cap, mins, maxs, bb, ba, appr)
  loop
    insert into public.resources
      (resource_type_id, building_id, floor_id, name, code, capacity,
       location_description, is_bookable, is_active, requires_approval,
       minimum_booking_minutes, maximum_booking_minutes,
       buffer_before_minutes, buffer_after_minutes)
    values
      (r.rtype, r.bldg, r.flr, r.name,
       upper(split_part(r.name, ' ', 1) || '-' || lpad((abs(hashtext(r.name)) % 900) + 100::text, 3, '0')),
       r.cap, r.name, true, true, r.appr, r.mins, r.maxs, r.bb, r.ba);
    created := created + 1;
  end loop;

  -- Opening hours: labs and lecture rooms Sun-Sat, seminar rooms Sun-Fri,
  -- sports facilities 06:00-22:00 every day.
  insert into public.resource_availability
    (resource_id, day_of_week, start_time, end_time, is_available)
  select r.id, d,
         case when rt.name = 'Sports Facility' then time '06:00' else time '07:30' end,
         case when rt.name = 'Sports Facility' then time '22:00'
              when r.name like 'SR-%'               then time '18:00'
              else time '19:00' end,
         true
  from public.resources r
  join public.resource_types rt on rt.id = r.resource_type_id
  cross join generate_series(0, 5) as d
  where rt.name <> 'Sports Facility';

  insert into public.resource_availability
    (resource_id, day_of_week, start_time, end_time, is_available)
  select r.id, d, time '06:00', time '22:00', true
  from public.resources r
  join public.resource_types rt on rt.id = r.resource_type_id
  cross join generate_series(0, 6) as d
  where rt.name = 'Sports Facility';

  -- Amenities, so the feature filters return results immediately.
  insert into public.resource_feature_map (resource_id, feature_id, quantity)
  select r.id, f.id, 1
  from public.resources r
  join public.resource_features f on (
       (r.name like 'LH-%' and f.name in ('Projector','Whiteboard','Air Conditioned','PA System','Chairs (Stackable)'))
    or (r.name like 'SR-%' and f.name in ('Whiteboard','Air Conditioned','Smart Board','Video Conferencing'))
    or (r.name like 'CL-%' and f.name in ('Projector','Air Conditioned'))
    or (r.name like 'PH-%' and f.name in ('Lab Benches','Fume Hood','Ventilated'))
    or (r.name like 'BR-%' and f.name in ('Video Conferencing','Smart Board','Air Conditioned'))
    or (r.name like 'Hall%' and f.name in ('Projector','PA System','Air Conditioned'))
    or (r.name like 'Turf%' and f.name in ('Football Turf','Step Free Access'))
    or (r.name like '3D%' and f.name in ('3D Printer','Secure Storage','Whiteboard'))
  )
  on conflict do nothing;

  raise notice 'CampusBook: created % demo resources with opening hours.', created;
end $$;
