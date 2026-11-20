-- 078: more detail on proposal link visits (Greg, 2026-11-20).
--
-- Greg picked, from the brainstorm: every click that matters, every option
-- change (not just where they ended up), how far down each page they
-- scrolled, a "probably shared" flag and a rough location. Manager Home >
-- Proposals shows them.
--
-- New columns on proposal_visits:
--   changes  every time the reader's options/figures changed during the
--            visit: [{"at": ..., "inputs": {...}}], oldest first, max 100.
--            Worked out here from what the page sends, so it also works for
--            the care home page without changing it.
--   scroll   furthest the reader scrolled on each page, 0-100 (%):
--            {"1": 100, "2": 45}. Sent by pages that measure it.
--   net      the network the visit came from, cut down to the first part of
--            the address (IPv4 /24, IPv6 /48), never the full IP. Only used
--            to tell "a different device on a different network", i.e.
--            probably someone else (Manager Home's "Probably shared").
--   geo      rough location from the request headers our hosting adds, if
--            any (city/region/country). Not GPS: phones on mobile data often
--            show the wrong town. May turn out to be country only.
-- Clicks: 'what' may now be up to 80 characters (e.g. "datasheet:Sigenstor").
-- Everything else is unchanged from 076.

alter table proposal_visits add column if not exists changes jsonb not null default '[]'::jsonb;
alter table proposal_visits add column if not exists scroll  jsonb not null default '{}'::jsonb;
alter table proposal_visits add column if not exists net     text;
alter table proposal_visits add column if not exists geo     jsonb;

create or replace function proposal_track(p_code text, p_session text, p_payload jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id     uuid;
  v_pages  jsonb := '{}'::jsonb;
  v_scroll jsonb := '{}'::jsonb;
  v_inputs jsonb := '{}'::jsonb;
  v_clicks jsonb := '[]'::jsonb;
  v_active integer;
  v_hdr    json;
  v_ip     text;
  v_net    text;
  v_geo    jsonb;
  k text; v jsonb;
begin
  if p_session !~ '^[A-Za-z0-9]{8,32}$' or jsonb_typeof(p_payload) <> 'object' then return; end if;
  select id into v_id from sales_proposals where code = p_code and revoked_at is null;
  if v_id is null then return; end if;
  -- Cap visits per proposal so a leaked link can't fill the table.
  if (select count(*) from proposal_visits where proposal_id = v_id) >= 500
     and not exists (select 1 from proposal_visits where proposal_id = v_id and session_id = p_session) then
    return;
  end if;

  if jsonb_typeof(p_payload -> 'pages') = 'object' then
    for k, v in select * from jsonb_each(p_payload -> 'pages') loop
      if k ~ '^[1-9][0-9]?$' and jsonb_typeof(v) = 'number' then
        v_pages := v_pages || jsonb_build_object(k, least(greatest((v #>> '{}')::numeric, 0), 86400)::int);
      end if;
    end loop;
  end if;
  if jsonb_typeof(p_payload -> 'scroll') = 'object' then
    for k, v in select * from jsonb_each(p_payload -> 'scroll') loop
      if k ~ '^[1-9][0-9]?$' and jsonb_typeof(v) = 'number' then
        v_scroll := v_scroll || jsonb_build_object(k, least(greatest((v #>> '{}')::numeric, 0), 100)::int);
      end if;
    end loop;
  end if;
  if jsonb_typeof(p_payload -> 'inputs') = 'object' then
    v_inputs := jsonb_strip_nulls(jsonb_build_object(
      'spend',   case when jsonb_typeof(p_payload #> '{inputs,spend}') = 'number' then p_payload #> '{inputs,spend}' end,
      'rate',    case when jsonb_typeof(p_payload #> '{inputs,rate}')  = 'number' then p_payload #> '{inputs,rate}'  end,
      'roof',    case when jsonb_typeof(p_payload #> '{inputs,roof}')  = 'number' then p_payload #> '{inputs,roof}'  end,
      'summary', case when jsonb_typeof(p_payload #> '{inputs,summary}') = 'string'
                      then to_jsonb(left(p_payload #>> '{inputs,summary}', 200)) end,
      'changed', coalesce(p_payload #> '{inputs,changed}' = 'true'::jsonb, false)));
  end if;
  if jsonb_typeof(p_payload -> 'clicks') = 'array' then
    select coalesce(jsonb_agg(jsonb_build_object('what', left(e ->> 'what', 80), 'at', left(e ->> 'at', 40))), '[]'::jsonb)
      into v_clicks
      from (select e from jsonb_array_elements(p_payload -> 'clicks') e limit 50) s
      where jsonb_typeof(e) = 'object';
  end if;
  v_active := case when jsonb_typeof(p_payload -> 'active') = 'number'
                   then least(greatest((p_payload ->> 'active')::numeric, 0), 86400)::int else 0 end;

  -- Network and rough location, from the request headers (never stored whole).
  begin
    v_hdr := current_setting('request.headers', true)::json;
  exception when others then
    v_hdr := null;
  end;
  if v_hdr is not null then
    v_ip := trim(split_part(coalesce(v_hdr ->> 'x-forwarded-for', v_hdr ->> 'x-real-ip', ''), ',', 1));
    if v_ip ~ '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$' then
      v_net := regexp_replace(v_ip, '\.\d{1,3}$', '.0/24');
    elsif v_ip ~ ':' then
      v_net := lower(array_to_string((string_to_array(v_ip, ':'))[1:3], ':')) || '::/48';
    end if;
    v_geo := jsonb_strip_nulls(jsonb_build_object(
      'city',    nullif(left(v_hdr ->> 'cf-ipcity', 60), ''),
      'region',  nullif(left(v_hdr ->> 'cf-region', 60), ''),
      'country', nullif(left(v_hdr ->> 'cf-ipcountry', 2), '')));
    if v_geo = '{}'::jsonb then v_geo := null; end if;
  end if;

  insert into proposal_visits (proposal_id, session_id, active_seconds, pages, scroll, inputs, changes, clicks,
                               user_agent, viewport, referrer, net, geo)
  values (v_id, p_session, v_active, v_pages, v_scroll, v_inputs,
          case when v_inputs - 'changed' <> '{}'::jsonb
               then jsonb_build_array(jsonb_build_object('at', now(), 'inputs', v_inputs - 'changed'))
               else '[]'::jsonb end,
          v_clicks,
          left(p_payload ->> 'ua', 300), left(p_payload ->> 'viewport', 20), left(p_payload ->> 'referrer', 300),
          v_net, v_geo)
  on conflict (proposal_id, session_id) do update set
    last_seen_at   = now(),
    active_seconds = greatest(proposal_visits.active_seconds, excluded.active_seconds),
    pages          = excluded.pages,
    scroll         = case when excluded.scroll = '{}'::jsonb then proposal_visits.scroll else excluded.scroll end,
    inputs         = excluded.inputs,
    changes        = case
                       when excluded.inputs - 'changed' <> '{}'::jsonb
                        and excluded.inputs - 'changed' is distinct from proposal_visits.inputs - 'changed'
                        and jsonb_array_length(proposal_visits.changes) < 100
                       then proposal_visits.changes || jsonb_build_array(jsonb_build_object('at', now(), 'inputs', excluded.inputs - 'changed'))
                       else proposal_visits.changes end,
    clicks         = excluded.clicks,
    net            = coalesce(proposal_visits.net, excluded.net),
    geo            = coalesce(proposal_visits.geo, excluded.geo);
end;
$$;
revoke all on function proposal_track(text, text, jsonb) from public;
grant execute on function proposal_track(text, text, jsonb) to anon, authenticated;
