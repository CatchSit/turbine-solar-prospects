-- Manager Home (home.html) — see docs/superpowers/specs/2026-09-30-manager-home-design.md.
--
-- 1. A real `managers` table + is_manager(), replacing the three places
--    'greg@turbineenergyuk.co.uk' was hardcoded as the only manager
--    (016 grant_areas "Manager update", 035 quote_options "Manager delete",
--    037 guard_quote_option_soft_delete()). Tim becomes a manager with
--    identical rights. Adding a manager later = one insert here, plus one
--    line in shared/manager-config.js (client-side UX gating only).
-- 2. manager_audit_log — append-only record of manager sign-ins and which
--    home.html section was viewed.
-- 3. manager_system_stats() — aggregate counts for home.html in one call,
--    so the page never needs index.html's ~90s fetchAllProspects() load.

-- ── managers ─────────────────────────────────────────────────────────
create table if not exists managers (
  email     text primary key check (email = lower(email)),
  name      text not null,
  added_at  timestamptz not null default now()
);
alter table managers enable row level security;

insert into managers (email, name) values
  ('greg@turbineenergyuk.co.uk', 'Greg'),
  ('tim@turbineenergyuk.co.uk',  'Tim')
on conflict (email) do nothing;

-- Readable by any Turbine Energy account (it's just a roster); no client
-- write policies — managers are added/removed via the SQL editor.
drop policy if exists "Turbine Energy read" on managers;
create policy "Turbine Energy read"
  on managers for select to authenticated
  using (lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk');

create or replace function is_manager()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from managers where email = lower(auth.jwt() ->> 'email'));
$$;
grant execute on function is_manager() to authenticated;

-- ── Replace the hardcoded-email manager checks ───────────────────────
drop policy if exists "Manager update" on grant_areas;
create policy "Manager update"
  on grant_areas for update to authenticated
  using (is_manager())
  with check (is_manager());

drop policy if exists "Manager delete" on quote_options;
create policy "Manager delete"
  on quote_options for delete to authenticated
  using (is_manager());

-- Identical to the live 037 definition except the manager check.
create or replace function guard_quote_option_soft_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.deleted_at is distinct from old.deleted_at then
    if not is_manager() then
      raise exception 'Only a manager can delete or restore a quote option';
    end if;
    if new.deleted_at is not null then
      insert into quote_option_deletion_log (
        prospect_id, quote_option_id, label, kit_price, scaffold_price, electrical_cost, roofer_cost,
        mcs_cost, fuel_cost, commission_cost, quote_price, was_selected, deleted_by_email
      ) values (
        old.prospect_id, old.id, old.label, old.kit_price, old.scaffold_price, old.electrical_cost, old.roofer_cost,
        old.mcs_cost, old.fuel_cost, old.commission_cost, old.quote_price, old.is_selected, new.deleted_by_email
      );
    end if;
  end if;
  return new;
end;
$$;

-- ── manager_audit_log ────────────────────────────────────────────────
create table if not exists manager_audit_log (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  user_email  text not null,
  user_name   text,
  action      text not null check (action in ('sign_in', 'view_section')),
  section     text,
  user_agent  text
);
create index if not exists manager_audit_log_created_at_idx on manager_audit_log (created_at desc);
alter table manager_audit_log enable row level security;

-- Append-only: insert + select policies only, no update/delete. A row's
-- user_email must be the caller's own (same identity check as 008).
drop policy if exists "Manager insert own" on manager_audit_log;
create policy "Manager insert own"
  on manager_audit_log for insert to authenticated
  with check (is_manager() and user_email = lower(auth.jwt() ->> 'email'));

drop policy if exists "Manager read" on manager_audit_log;
create policy "Manager read"
  on manager_audit_log for select to authenticated
  using (is_manager());

-- ── manager_system_stats() ───────────────────────────────────────────
create or replace function manager_system_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_period text := to_char(now() at time zone 'utc', 'YYYY-MM');
  month_start timestamptz := date_trunc('month', now());
  result jsonb;
begin
  if not is_manager() then
    raise exception 'Managers only';
  end if;

  select jsonb_build_object(
    'period', v_period,
    'prospects_total', (select count(*) from prospects),
    'by_source', (select coalesce(jsonb_object_agg(source, n), '{}') from
                   (select coalesce(source, 'epc') source, count(*) n from prospects group by 1) s),
    'geocoded', (select count(*) from prospects where lat is not null),
    'solar_status', (select coalesce(jsonb_object_agg(solar_status, n), '{}') from
                      (select solar_status, count(*) n from prospects
                        where source in ('epc', 'voa') group by 1) s),
    'solar_pending_by_area', (select coalesce(jsonb_object_agg(area, n), '{}') from
                      (select case when local_authority in ('Doncaster', 'Sheffield', 'Barnsley', 'Rotherham')
                                   then local_authority else 'Other' end area,
                              count(*) n
                         from prospects
                        where solar_status = 'pending' and lat is not null and source in ('epc', 'voa')
                        group by 1) s),
    'classifiable', (select count(*) from prospects where source in ('epc', 'voa') and postcode is not null),
    'classified', (select count(*) from company_classifications),
    'api_usage', (select coalesce(jsonb_object_agg(api_name, request_count), '{}')
                    from api_usage where api_usage.period = v_period),
    'enrichment_this_month', (select coalesce(jsonb_object_agg(provider, n), '{}') from
                      (select provider, count(*) n from contact_enrichment_log
                        where requested_at >= month_start group by 1) s),
    'sms_this_month', (select coalesce(jsonb_object_agg(status, n), '{}') from
                      (select status, count(*) n from sms_log
                        where created_at >= month_start group by 1) s)
  ) into result;

  return result;
end;
$$;
grant execute on function manager_system_stats() to authenticated;
