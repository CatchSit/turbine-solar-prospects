-- Per-local-authority grant funding status, shown as shaded boundary
-- overlays on the map and used to power the sidebar area filter
-- (index.html). Grant pots are allocated by local authority and can run
-- out mid-year independently of one another (e.g. Sheffield exhausted
-- while Barnsley/Doncaster/Rotherham still have funding), so this is a
-- small mutable "current status" table, not an append-only log like
-- prospect_contacts/prospect_proposals — a manager updates a row in
-- place when a council's funding position changes, there's no history
-- to preserve.
create table if not exists grant_areas (
  local_authority  text primary key,
  status           text not null default 'available' check (status in ('available', 'limited', 'exhausted')),
  updated_at       timestamptz not null default now(),
  updated_by_email text
);

-- Pilot region's four South Yorkshire authorities. `on conflict do nothing`
-- so a re-run of this migration never clobbers a status a manager has
-- since changed.
insert into grant_areas (local_authority, status) values
  ('Barnsley', 'available'),
  ('Doncaster', 'available'),
  ('Rotherham', 'available'),
  ('Sheffield', 'available')
on conflict (local_authority) do nothing;

alter table grant_areas enable row level security;

-- Any Turbine Energy rep can read — every rep needs to see area status to
-- use the map's area filter/shading, not just managers (contrast
-- prospect_contacts' manager-only read).
drop policy if exists "Turbine Energy read" on grant_areas;
create policy "Turbine Energy read"
  on grant_areas for select
  to authenticated
  using (lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk');

-- Manager-only write — same manager email dashboard.html/index.html
-- already gate on client-side (ADMIN_EMAILS), enforced here at the
-- database level so the toggle can't be hit directly via the anon key.
drop policy if exists "Manager update" on grant_areas;
create policy "Manager update"
  on grant_areas for update
  to authenticated
  using (lower(auth.jwt() ->> 'email') = 'greg@turbineenergyuk.co.uk')
  with check (lower(auth.jwt() ->> 'email') = 'greg@turbineenergyuk.co.uk');
