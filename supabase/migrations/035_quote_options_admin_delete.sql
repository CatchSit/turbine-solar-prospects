-- Deleting a quote option is now manager-only — same admin email
-- dashboard.html/index.html/crm.html already gate on client-side
-- (ADMIN_EMAILS), enforced here at the database level so it can't be hit
-- directly via the anon key by any other authenticated rep. Mirrors
-- grant_areas' "Manager update" policy (016).
drop policy if exists "Turbine Energy delete" on quote_options;
drop policy if exists "Manager delete" on quote_options;
create policy "Manager delete"
  on quote_options for delete to authenticated
  using (lower(auth.jwt() ->> 'email') = 'greg@turbineenergyuk.co.uk');
