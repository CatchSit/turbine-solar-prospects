-- 010 enabled RLS on business_rates_matches with zero SELECT policies,
-- following the company_lookups/api_usage pattern (service-role only).
-- That pattern is wrong here: unlike those two tables, index.html reads
-- business_rates_matches directly from the frontend's own window.db
-- client, which runs as the signed-in user's `authenticated`-role JWT,
-- not service-role. With no policy, PostgREST silently returns null for
-- that role instead of erroring, so the popup/filter feature built in
-- Task 2 was unreachable in production. Mirror the real, already-applied
-- domain-restriction policy from 004_prospects_domain_rls.sql instead of
-- editing 010 in place (this project's migrations are additive, never
-- edited after being applied — see how 004 superseded 003 and 008
-- superseded 007).

create policy "Turbine staff read"
  on business_rates_matches for select
  to authenticated
  using (lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk');
