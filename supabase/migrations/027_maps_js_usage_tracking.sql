-- Lightweight usage tracking for the Maps JavaScript API's satellite
-- toggle (index.html, 2026-09-10), reusing the existing api_usage table
-- (005) under a new api_name rather than a new table. Not a hard cap like
-- the Solar API's — the free tier (10,000 map loads/month) is nowhere
-- near reachable at this app's usage pattern, so this is purely for
-- visibility (dashboard.html), not enforcement.
--
-- The client can't write api_usage directly (005 added no policies —
-- service-role only), so writes go through this SECURITY DEFINER function
-- instead of a direct table grant, atomically incrementing rather than a
-- client-side read-then-write (which would race under concurrent reps).
create or replace function increment_maps_js_load()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  current_period text := to_char(now() at time zone 'utc', 'YYYY-MM');
  new_count integer;
begin
  insert into api_usage (api_name, period, request_count)
  values ('maps_js_load', current_period, 1)
  on conflict (api_name, period)
  do update set request_count = api_usage.request_count + 1, updated_at = now()
  returning request_count into new_count;
  return new_count;
end;
$$;

grant execute on function increment_maps_js_load() to authenticated;

-- Read-only visibility for any Turbine Energy rep, same pattern as every
-- other "Turbine Energy read" policy in this project — usage counters
-- aren't sensitive, and dashboard.html wants to display them.
drop policy if exists "Turbine Energy read" on api_usage;
create policy "Turbine Energy read"
  on api_usage for select
  to authenticated
  using (lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk');
