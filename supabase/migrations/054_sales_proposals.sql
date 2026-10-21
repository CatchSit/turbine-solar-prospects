-- 054: Sales proposal links + view tracking (Greg, 2026-10-21)
--
-- Managers create a personalised proposal link in Manager Home ("Proposals"
-- tab). The proposal itself is served by the website plugin at
-- https://www.turbineenergyuk.co.uk/proposal/<code> (not a WordPress page, so
-- it is in no menu, search or sitemap). The page is anonymous, so it can only
-- reach this data through two narrow security-definer functions:
--   proposal_public(code)            -> the recipient name + starting figures
--   proposal_track(code, session, p) -> upsert one row per visit
-- Nothing else is readable or writable without a manager session.

create table if not exists sales_proposals (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique check (code ~ '^[A-Za-z0-9]{10,16}$'),
  template         text not null default 'care-home' check (template in ('care-home')),
  recipient_name   text not null check (char_length(recipient_name) between 1 and 80),
  contact_name     text check (char_length(contact_name) <= 80),
  contact_email    text check (char_length(contact_email) <= 120),
  notes            text check (char_length(notes) <= 1000),
  annual_spend     integer not null default 45000 check (annual_spend between 10000 and 120000),
  unit_rate_p      integer not null default 26 check (unit_rate_p between 18 and 40),
  roof_m2          integer not null default 600 check (roof_m2 between 50 and 2000),
  created_by_email text not null default lower(auth.jwt() ->> 'email'),
  created_at       timestamptz not null default now(),
  revoked_at       timestamptz
);

create table if not exists proposal_visits (
  id             bigserial primary key,
  proposal_id    uuid not null references sales_proposals(id),
  session_id     text not null check (session_id ~ '^[A-Za-z0-9]{8,32}$'),
  started_at     timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  active_seconds integer not null default 0,
  pages          jsonb not null default '{}'::jsonb,   -- {"1": seconds on page 1, ...}
  inputs         jsonb not null default '{}'::jsonb,   -- last slider values + whether they moved them
  clicks         jsonb not null default '[]'::jsonb,   -- [{"what": "book_survey", "at": "..."}]
  user_agent     text,
  viewport       text,
  referrer       text,
  unique (proposal_id, session_id)
);
create index if not exists proposal_visits_proposal_idx on proposal_visits (proposal_id, last_seen_at desc);

alter table sales_proposals enable row level security;
alter table proposal_visits enable row level security;

drop policy if exists "Manager read" on sales_proposals;
create policy "Manager read" on sales_proposals for select to authenticated using (is_manager());
drop policy if exists "Manager insert" on sales_proposals;
create policy "Manager insert" on sales_proposals for insert to authenticated
  with check (is_manager() and created_by_email = lower(auth.jwt() ->> 'email'));
drop policy if exists "Manager update" on sales_proposals;
create policy "Manager update" on sales_proposals for update to authenticated
  using (is_manager()) with check (is_manager());
-- No delete policy: revoke a link with revoked_at instead.

drop policy if exists "Manager read" on proposal_visits;
create policy "Manager read" on proposal_visits for select to authenticated using (is_manager());
-- No client write policies: visits are only written by proposal_track().

-- What the public proposal page is allowed to know: nothing unless the code
-- is live, and then only the name and starting figures.
create or replace function proposal_public(p_code text)
returns json
language sql
stable
security definer
set search_path = public
as $$
  select json_build_object(
    'name', recipient_name, 'template', template,
    'spend', annual_spend, 'rate', unit_rate_p, 'roof', roof_m2)
  from sales_proposals
  where code = p_code and revoked_at is null;
$$;
revoke all on function proposal_public(text) from public;
grant execute on function proposal_public(text) to anon, authenticated;

-- One row per visit (browser tab), updated every few seconds while it is open.
-- Everything from the browser is sanitised and capped here.
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
      if k ~ '^[1-9]$' and jsonb_typeof(v) = 'number' then
        v_pages := v_pages || jsonb_build_object(k, least(greatest((v #>> '{}')::numeric, 0), 86400)::int);
      end if;
    end loop;
  end if;
  if jsonb_typeof(p_payload -> 'inputs') = 'object' then
    v_inputs := jsonb_build_object(
      'spend',   case when jsonb_typeof(p_payload #> '{inputs,spend}') = 'number' then p_payload #> '{inputs,spend}' end,
      'rate',    case when jsonb_typeof(p_payload #> '{inputs,rate}')  = 'number' then p_payload #> '{inputs,rate}'  end,
      'roof',    case when jsonb_typeof(p_payload #> '{inputs,roof}')  = 'number' then p_payload #> '{inputs,roof}'  end,
      'changed', coalesce(p_payload #> '{inputs,changed}' = 'true'::jsonb, false));
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
