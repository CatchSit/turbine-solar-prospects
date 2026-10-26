-- Roof checks (solar-enrichment) spend a 9,500/month Google Solar budget.
-- Before 2026-10-26 a batch took whatever 'pending' rows Postgres returned
-- first. With the West Midlands added (~20k new leads) Greg asked for the
-- most promising buildings to be checked first, so each pending EPC/VOA lead
-- gets a 0-100 score and solar-enrichment works down it, highest first:
--   40  the EPC assessor recommended solar
--   30  freehold confirmed (owner can say yes); leasehold confirmed scores 0,
--       unknown 15
--   30  size: floor area (capped at 5,000 m2), or for a VOA-only lead with
--       no floor area, its top rateable value (capped at GBP 150,000)
-- Recompute after any import/enrichment run that changes those inputs:
--   npx supabase db query --linked "select refresh_roof_check_priority()"

alter table prospects add column if not exists roof_check_priority smallint;

create index if not exists prospects_pending_roof_priority_idx
  on prospects (roof_check_priority desc nulls last, id)
  where solar_status = 'pending';

create or replace function refresh_roof_check_priority() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update prospects p set roof_check_priority = s.score
  from (
    select p2.id,
      (case when p2.epc_recommends_solar then 40 else 0 end
       + case p2.ownership_status when 'freehold_confirmed' then 30 when 'leasehold_confirmed' then 0 else 15 end
       + case
           when p2.total_floor_area is not null then round(least(p2.total_floor_area, 5000) / 5000.0 * 30)
           when rv.top_rv is not null then round(least(rv.top_rv, 150000) / 150000.0 * 30)
           else 0
         end)::smallint as score
    from prospects p2
    left join lateral (
      select max((h ->> 'rateable_value')::numeric) as top_rv
      from business_rates_matches b, jsonb_array_elements(b.hereditaments) h
      where b.prospect_id = p2.id and p2.total_floor_area is null
    ) rv on true
    where p2.solar_status = 'pending' and coalesce(p2.source, 'epc') in ('epc', 'voa')
  ) s
  where p.id = s.id and p.roof_check_priority is distinct from s.score;
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function refresh_roof_check_priority() from public, anon, authenticated;

-- Manager Home's "buildings waiting for a roof check" line: name the West
-- Midlands councils instead of lumping them into 'Other'. Otherwise the same
-- as the live definition (043) at 2026-10-26.
CREATE OR REPLACE FUNCTION public.manager_system_stats()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
                      (select case when local_authority in ('Doncaster', 'Sheffield', 'Barnsley', 'Rotherham',
                                                           'Birmingham', 'Coventry', 'Dudley', 'Sandwell', 'Solihull', 'Walsall', 'Wolverhampton')
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
$function$;

select refresh_roof_check_priority();
