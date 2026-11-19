-- 076: Custom proposal pages on the tracked /proposal/<code> links (Greg, 2026-11-19)
--
-- 054 only served the care home pitch. Greg wants a customer's own proposal
-- (first one: Andrea Lloyd, a solar proposal with removable options) sent as a
-- tracked link too. A link can now be template 'custom': a manager uploads the
-- finished proposal page (one self-contained .html file) in Manager Home and it
-- is stored in page_html. The website's proposal page asks proposal_public()
-- for the template, and for 'custom' fetches the page with proposal_page() and
-- shows it in place. Switching the link off (revoked_at) stops both.
--
-- proposal_track() now also keeps:
--   * page numbers up to 99 (custom proposals have more than 9 pages);
--   * inputs.summary: a short text of what the reader chose (e.g. "2 of 3
--     batteries, EV charger removed, £19,355"), shown in Manager Home.
-- Everything else is unchanged from 054.

alter table sales_proposals drop constraint if exists sales_proposals_template_check;
alter table sales_proposals add constraint sales_proposals_template_check
  check (template in ('care-home', 'custom'));

alter table sales_proposals add column if not exists page_html text;
alter table sales_proposals drop constraint if exists sales_proposals_page_html_check;
alter table sales_proposals add constraint sales_proposals_page_html_check
  check (page_html is null or octet_length(page_html) <= 8000000);
alter table sales_proposals drop constraint if exists sales_proposals_custom_page_check;
alter table sales_proposals add constraint sales_proposals_custom_page_check
  check (template <> 'custom' or page_html is not null);

-- The page itself, only for a live custom link.
create or replace function proposal_page(p_code text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select page_html from sales_proposals
  where code = p_code and revoked_at is null and template = 'custom';
$$;
revoke all on function proposal_page(text) from public;
grant execute on function proposal_page(text) to anon, authenticated;

create or replace function proposal_track(p_code text, p_session text, p_payload jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id     uuid;
  v_pages  jsonb := '{}'::jsonb;
  v_inputs jsonb := '{}'::jsonb;
  v_clicks jsonb := '[]'::jsonb;
  v_active integer;
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
    select coalesce(jsonb_agg(jsonb_build_object('what', left(e ->> 'what', 40), 'at', left(e ->> 'at', 40))), '[]'::jsonb)
      into v_clicks
      from (select e from jsonb_array_elements(p_payload -> 'clicks') e limit 50) s
      where jsonb_typeof(e) = 'object';
  end if;
  v_active := case when jsonb_typeof(p_payload -> 'active') = 'number'
                   then least(greatest((p_payload ->> 'active')::numeric, 0), 86400)::int else 0 end;

  insert into proposal_visits (proposal_id, session_id, active_seconds, pages, inputs, clicks, user_agent, viewport, referrer)
  values (v_id, p_session, v_active, v_pages, v_inputs, v_clicks,
          left(p_payload ->> 'ua', 300), left(p_payload ->> 'viewport', 20), left(p_payload ->> 'referrer', 300))
  on conflict (proposal_id, session_id) do update set
    last_seen_at   = now(),
    active_seconds = greatest(proposal_visits.active_seconds, excluded.active_seconds),
    pages          = excluded.pages,
    inputs         = excluded.inputs,
    clicks         = excluded.clicks;
end;
$$;
revoke all on function proposal_track(text, text, jsonb) from public;
grant execute on function proposal_track(text, text, jsonb) to anon, authenticated;
