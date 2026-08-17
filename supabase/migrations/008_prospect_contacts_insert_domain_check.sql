-- 007's "Authenticated insert" policy on prospect_contacts was `with check (true)`
-- — any self-registered account (public email signup is enabled on this Supabase
-- project) could insert arbitrary rows with a fake `employee` name. Same bug class
-- already fixed twice on this project: 003 -> 004 for `prospects` reads, and the
-- company-lookup Edge Function's postcode/domain fix (HANDOVER.md Section 7, risk 9)
-- — "any authenticated session" isn't a real access boundary here.
--
-- Migration 007 is already applied to the live project, so it is not edited in
-- place; this supersedes its insert policy the same way 004 superseded 003.
drop policy if exists "Authenticated insert" on prospect_contacts;

create policy "Authenticated insert"
  on prospect_contacts for insert
  to authenticated
  with check (
    lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk'
    and employee_email = auth.jwt() ->> 'email'
  );

-- Also fix "Admin read"'s case-sensitivity while touching this table: the 007
-- version compares the JWT email to a lowercase literal without lowercasing the
-- JWT side. A case-mismatched email would silently fail closed (empty dashboard,
-- no error) rather than fail loudly.
drop policy if exists "Admin read" on prospect_contacts;

create policy "Admin read"
  on prospect_contacts for select
  to authenticated
  using (lower(auth.jwt() ->> 'email') = 'greg@turbineenergyuk.co.uk');
