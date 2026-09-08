-- prospect_contacts' read was manager-only since 008 — a deliberate choice
-- at the time (reps could log a contact but never read any back, matching
-- neither installer app's own mcs-map exactly; see 008's comment and
-- docs/superpowers/specs/2026-08-17-crm-contact-log-design.md's
-- "Non-goals"). The new crm.html page is open to every rep, not
-- manager-only, and showing a lead's contact history there was requested
-- 2026-09-08 — doing that means opening this read up too, decided with the
-- client rather than assumed. Supersedes 008's "Admin read" policy the same
-- way 004 superseded 003 (already-applied migrations aren't edited in
-- place).
drop policy if exists "Admin read" on prospect_contacts;

create policy "Turbine Energy read"
  on prospect_contacts for select
  to authenticated
  using (lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk');
