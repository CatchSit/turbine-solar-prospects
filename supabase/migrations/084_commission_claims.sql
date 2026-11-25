-- 084: commission claims, approval and payment (Greg, 2026-11-25).
--
-- Until now "commission paid" was an assumption: a job counted as paid out as
-- soon as "Paid, job closed" was logged. Greg's rules from here:
--   * commission is EARNED only when the customer has paid: "Paid, job closed"
--     (outcome 'Job Closed') is logged and no closing outcome such as
--     'Cancelled' is logged after it. A later harmless log changes nothing;
--   * the person ticks their own jobs and submits a form (commission_submit);
--   * a manager approves it, which gives it a number and makes the document:
--     an invoice for a self-employed person, a statement for payroll for an
--     employee. Type not set = approval refused;
--   * a manager marks it paid. Only that counts as "commission paid";
--   * a manager can send a form back, or void an approved one, with a reason.
--     That frees the jobs. A paid one cannot be voided;
--   * nobody approves, sends back, voids or marks paid their own, and nobody
--     sets their own type, managers included.
--
-- Nothing is written from the browser: RLS allows reading only (your own, or
-- everything for a manager) and every change goes through the functions
-- below. Amounts and people are read here from the selected quote option and
-- quote_option_commission (061), never sent by the page, and are frozen when
-- the form is submitted. No bank details are stored. Safe to run twice.

-- -- People ----------------------------------------------------------------
create table if not exists commission_people (
  email             text primary key check (email = lower(email)),
  pay_type          text check (pay_type in ('self_employed', 'employed')),   -- null = not set yet
  full_name         text check (length(full_name) <= 120),
  address           text check (length(address) <= 400),
  prefix            text not null unique check (prefix ~ '^[A-Z]{3,}[0-9]*$'),
  next_invoice_no   int not null default 1 check (next_invoice_no > 0),
  next_statement_no int not null default 1 check (next_statement_no > 0),
  type_set_by       text,
  type_set_at       timestamptz,
  details_saved_at  timestamptz
);

-- -- Forms (one row per submission) ----------------------------------------
create table if not exists commission_claims (
  id             uuid primary key default gen_random_uuid(),
  email          text not null references commission_people(email),
  status         text not null default 'submitted' check (status in ('submitted', 'approved', 'paid', 'sent_back', 'void')),
  total          numeric(10,2) not null check (total > 0),
  declaration    text not null,
  submitted_at   timestamptz not null default now(),
  approved_at    timestamptz,
  approved_by    text,
  doc_kind       text check (doc_kind in ('invoice', 'statement')),
  doc_no         text unique,
  doc_date       date,
  from_name      text,
  from_address   text,
  from_email     text,
  to_details     text,
  vat_note       text,
  payment_note   text,
  paid_on        date,
  paid_ref       text check (length(paid_ref) <= 100),
  paid_by        text,
  paid_at        timestamptz,
  closed_reason  text check (length(closed_reason) <= 1000),
  closed_by      text,
  closed_at      timestamptz,
  -- The rules above, held by the table itself.
  constraint commission_not_own check (
    (approved_by is null or approved_by <> email)
    and (paid_by is null or paid_by <> email)
    and (closed_by is null or closed_by <> email)),
  constraint commission_approved_complete check (
    status not in ('approved', 'paid', 'void')
    or (doc_no is not null and doc_kind is not null and doc_date is not null and approved_by is not null
        and approved_at is not null and from_name is not null and from_address is not null and to_details is not null)),
  constraint commission_paid_complete check (
    case when status = 'paid' then paid_on is not null and paid_by is not null and paid_at is not null
         else paid_on is null and paid_by is null and paid_at is null and paid_ref is null end),
  constraint commission_closed_has_reason check (
    status not in ('sent_back', 'void')
    or (length(trim(coalesce(closed_reason, ''))) > 0 and closed_by is not null and closed_at is not null))
);
create index if not exists commission_claims_email_idx on commission_claims (email, submitted_at desc);

-- -- Job references --------------------------------------------------------
-- TE- plus the first 8 characters of the lead's own id. If two claimed leads
-- ever shared them, the second would get 12, so a reference is never shared.
create table if not exists commission_job_refs (
  prospect_id uuid primary key references prospects(id),
  job_ref     text not null unique
);

-- -- Jobs on a form --------------------------------------------------------
create table if not exists commission_claim_lines (
  id              uuid primary key default gen_random_uuid(),
  claim_id        uuid not null references commission_claims(id),
  prospect_id     uuid not null references prospects(id),
  quote_option_id uuid not null references quote_options(id),
  job_ref         text not null,
  customer_name   text not null,
  outward_code    text,
  job_type        text,
  paid_logged_at  timestamptz not null,
  paid_logged_by  text,
  amount          numeric(10,2) not null check (amount > 0),
  live            boolean not null default true
);
create index if not exists commission_claim_lines_claim_idx on commission_claim_lines (claim_id);
-- One live claim per job, whatever any page does.
create unique index if not exists commission_claim_lines_one_live on commission_claim_lines (prospect_id) where live;

-- -- Audit trail -----------------------------------------------------------
create table if not exists commission_events (
  id        bigint generated always as identity primary key,
  at        timestamptz not null default now(),
  by_email  text,
  email     text not null,                                  -- whose commission it is
  claim_id  uuid references commission_claims(id),
  event     text not null,
  detail    jsonb not null default '{}'
);
create index if not exists commission_events_claim_idx on commission_events (claim_id);

-- -- Read access only ------------------------------------------------------
alter table commission_people      enable row level security;
alter table commission_claims      enable row level security;
alter table commission_claim_lines enable row level security;
alter table commission_job_refs    enable row level security;
alter table commission_events      enable row level security;

revoke all on commission_people, commission_claims, commission_claim_lines, commission_job_refs, commission_events from public, anon, authenticated;
grant select on commission_people, commission_claims, commission_claim_lines, commission_events to authenticated;

drop policy if exists "Own or manager read" on commission_people;
create policy "Own or manager read" on commission_people for select to authenticated
  using (is_manager() or email = lower(auth.jwt() ->> 'email'));

drop policy if exists "Own or manager read" on commission_claims;
create policy "Own or manager read" on commission_claims for select to authenticated
  using (is_manager() or email = lower(auth.jwt() ->> 'email'));

drop policy if exists "Own or manager read" on commission_claim_lines;
create policy "Own or manager read" on commission_claim_lines for select to authenticated
  using (is_manager() or exists (select 1 from commission_claims c
                                  where c.id = claim_id and c.email = lower(auth.jwt() ->> 'email')));

drop policy if exists "Own or manager read" on commission_events;
create policy "Own or manager read" on commission_events for select to authenticated
  using (is_manager() or email = lower(auth.jwt() ->> 'email'));

-- -- Guards: frozen figures, allowed steps, no deletes -----------------------
create or replace function commission_no_change()
returns trigger language plpgsql set search_path = public
as $$
begin
  raise exception 'Commission records can''t be changed or deleted';
end;
$$;
drop trigger if exists trg_commission_no_delete on commission_claims;
create trigger trg_commission_no_delete before delete on commission_claims for each row execute function commission_no_change();
drop trigger if exists trg_commission_no_delete on commission_claim_lines;
create trigger trg_commission_no_delete before delete on commission_claim_lines for each row execute function commission_no_change();
drop trigger if exists trg_commission_no_change on commission_events;
create trigger trg_commission_no_change before update or delete on commission_events for each row execute function commission_no_change();
drop trigger if exists trg_commission_no_change on commission_job_refs;
create trigger trg_commission_no_change before update or delete on commission_job_refs for each row execute function commission_no_change();

create or replace function commission_guard_claim()
returns trigger language plpgsql set search_path = public
as $$
begin
  if (old.status, new.status) not in (('submitted', 'approved'), ('submitted', 'sent_back'), ('approved', 'paid'), ('approved', 'void')) then
    raise exception 'A claim that is % can''t become %', old.status, new.status;
  end if;
  if (new.id, new.email, new.total, new.declaration, new.submitted_at)
     is distinct from (old.id, old.email, old.total, old.declaration, old.submitted_at) then
    raise exception 'A submitted claim can''t be changed';
  end if;
  if old.status <> 'submitted'
     and (new.approved_at, new.approved_by, new.doc_kind, new.doc_no, new.doc_date, new.from_name, new.from_address, new.from_email, new.to_details, new.vat_note, new.payment_note)
     is distinct from (old.approved_at, old.approved_by, old.doc_kind, old.doc_no, old.doc_date, old.from_name, old.from_address, old.from_email, old.to_details, old.vat_note, old.payment_note) then
    raise exception 'An approved document can''t be changed';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_commission_guard_claim on commission_claims;
create trigger trg_commission_guard_claim before update on commission_claims for each row execute function commission_guard_claim();

create or replace function commission_guard_line()
returns trigger language plpgsql set search_path = public
as $$
begin
  if (to_jsonb(new) - 'live') is distinct from (to_jsonb(old) - 'live') or (new.live and not old.live) then
    raise exception 'A submitted claim can''t be changed';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_commission_guard_line on commission_claim_lines;
create trigger trg_commission_guard_line before update on commission_claim_lines for each row execute function commission_guard_line();

create or replace function commission_log_claim()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into commission_events (by_email, email, claim_id, event, detail)
  values (lower(auth.jwt() ->> 'email'), new.email, new.id, new.status,
          jsonb_strip_nulls(jsonb_build_object('total', new.total, 'doc_no', new.doc_no, 'reason', new.closed_reason,
                                               'paid_on', new.paid_on, 'paid_ref', new.paid_ref)));
  return null;
end;
$$;
drop trigger if exists trg_commission_log_claim on commission_claims;
create trigger trg_commission_log_claim after insert or update on commission_claims for each row execute function commission_log_claim();

-- -- Internal helpers (not callable from the browser) ------------------------
-- The signed-in Turbine address, or an error.
create or replace function commission_caller()
returns text language plpgsql stable security definer set search_path = public
as $$
declare
  v text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if v not like '%_@turbineenergyuk.co.uk' then
    raise exception 'Sign in with your Turbine account';
  end if;
  return v;
end;
$$;

create or replace function commission_require_manager()
returns text language plpgsql stable security definer set search_path = public
as $$
declare
  v text := commission_caller();
begin
  if is_manager() is not true then
    raise exception 'Only a manager can do that';
  end if;
  return v;
end;
$$;

-- Outcomes that close a lead as not going ahead: the 'lost' and 'bad' groups
-- in shared/contact-outcome-config.js. Keep the two in step.
create or replace function commission_is_lost(p_outcome text)
returns boolean language sql immutable set search_path = public
as $$
  select p_outcome in ('Not Interested', 'Already Has Solar', 'Enquiring Only', 'Not Suitable', 'Lost On Price',
                       'Lost To Competitor', 'Cancelled', 'Invalid Details', 'Duplicate', 'Never Enquired', 'Unreachable');
$$;

create or replace function commission_job_type(p_product text, p_lead_type text)
returns text language sql immutable set search_path = public
as $$
  select (case when p_product = 'ashp' then 'Heat pump' else 'Solar and battery' end)
      || (case p_lead_type when 'commercial' then ', commercial' when 'domestic' then ', domestic' else '' end);
$$;

-- Where one job stands. reason null = its commission can be claimed.
-- The earning option is the selected one; nothing else is ever guessed.
-- A "Paid, job closed" dated in the future doesn't count until that time.
create or replace function commission_job_state(p_prospect uuid)
returns table (quote_option_id uuid, person text, amount numeric, paid_at timestamptz, paid_by text, reason text)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
declare
  v_option uuid; v_person text; v_amount numeric; v_paid timestamptz; v_by text;
  v_lost timestamptz; v_deleted boolean;
begin
  select o.id, lower(trim(q.assigned_to_email)), o.commission_cost
    into v_option, v_person, v_amount
    from quote_options o left join quote_option_commission q on q.quote_option_id = o.id
   where o.prospect_id = p_prospect and o.is_selected and o.deleted_at is null;

  select c.contacted_at, coalesce(nullif(c.employee_email, ''), c.employee)
    into v_paid, v_by
    from prospect_contacts c
   where c.prospect_id = p_prospect and c.outcome = 'Job Closed' and c.deleted_at is null and c.contacted_at <= now()
   order by c.contacted_at desc limit 1;
  select max(c.contacted_at) into v_lost from prospect_contacts c
   where c.prospect_id = p_prospect and commission_is_lost(c.outcome) and c.deleted_at is null;
  select p.deleted_at is not null into v_deleted from prospects p where p.id = p_prospect;

  return query select v_option, v_person, v_amount, v_paid, v_by,
    case when v_deleted is distinct from false then 'deleted'
         when v_paid is null then 'not_paid'
         when v_lost >= v_paid then 'cancelled'
         when v_option is null then 'no_option'
         when v_person is null then 'no_person'
         when v_amount is null or not (v_amount >= 0.01 and v_amount < 1000000) then 'no_amount'
    end;
end;
$$;

create or replace function commission_job_ref(p_prospect uuid)
returns text language plpgsql volatile security definer set search_path = public
as $$
declare
  v text;
begin
  select job_ref into v from commission_job_refs where prospect_id = p_prospect;
  if v is not null then return v; end if;
  insert into commission_job_refs (prospect_id, job_ref)
    values (p_prospect, 'TE-' || upper(left(p_prospect::text, 8)))
    on conflict do nothing returning job_ref into v;
  if v is null then
    select job_ref into v from commission_job_refs where prospect_id = p_prospect;
  end if;
  if v is null then   -- another lead already has those 8 characters
    insert into commission_job_refs (prospect_id, job_ref)
      values (p_prospect, 'TE-' || upper(left(replace(p_prospect::text, '-', ''), 12))) returning job_ref into v;
  end if;
  return v;
end;
$$;

-- The person's row, made the first time it's needed and locked for this
-- transaction. The prefix is the first letters of their address (CHR, GRE),
-- longer or numbered if someone already has it.
create or replace function commission_person(p_email text)
returns commission_people language plpgsql volatile security definer set search_path = public
as $$
declare
  r commission_people;
  v_word text := upper(regexp_replace(split_part(p_email, '@', 1), '[^A-Za-z]', '', 'g'));
  v_letters text := rpad(v_word, greatest(3, length(v_word)), 'X');
  v_prefix text;
  i int := 0;
begin
  loop
    select * into r from commission_people where email = p_email for update;
    if found then return r; end if;
    v_prefix := case when 3 + i <= length(v_letters) then left(v_letters, 3 + i) else left(v_letters, 3) || (i + 1)::text end;
    insert into commission_people (email, prefix) values (p_email, v_prefix) on conflict do nothing;
    i := i + 1;
  end loop;
end;
$$;

-- Who is self-employed and who is employed (Greg, 2026-11-25). Everyone else
-- is set by a manager on Manager Home > Commission. Re-running changes nothing.
insert into commission_people (email, prefix, pay_type, type_set_at) values
  ('chris@turbineenergyuk.co.uk', 'CHR', 'self_employed', now()),
  ('greg@turbineenergyuk.co.uk',  'GRE', 'employed', now())
on conflict do nothing;

-- -- What the page shows a person --------------------------------------------
-- Their own jobs only: won jobs whose selected option names them (or, if no
-- option is selected, any option that does, so the page can say why).
create or replace function commission_my_jobs()
returns table (prospect_id uuid, job_ref text, customer_name text, outward_code text, job_type text,
               paid_logged_at timestamptz, amount numeric, state text, reason text, claim_id uuid, doc_no text)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
declare
  v_me text := commission_caller();
begin
  return query
  with mine as (
    select o.prospect_id as pid
      from quote_options o join quote_option_commission q on q.quote_option_id = o.id
     where lower(trim(q.assigned_to_email)) = v_me and o.deleted_at is null
       and (o.is_selected or not exists (select 1 from quote_options s
             where s.prospect_id = o.prospect_id and s.is_selected and s.deleted_at is null))
    union
    select l.prospect_id from commission_claim_lines l join commission_claims c on c.id = l.claim_id
     where l.live and c.email = v_me
  ), ml as (   -- my live claim on each job
    select l.*, c.status, c.doc_no
      from commission_claim_lines l join commission_claims c on c.id = l.claim_id
     where l.live and c.email = v_me
  )
  select p.id,
         coalesce(ml.job_ref, r.job_ref, 'TE-' || upper(left(p.id::text, 8))),
         coalesce(ml.customer_name, nullif(trim(p.customer_name), ''), 'Customer not named'),
         coalesce(ml.outward_code, upper(nullif(regexp_replace(coalesce(p.postcode, ''), '\s*[0-9][A-Za-z]{2}\s*$', ''), ''))),
         coalesce(ml.job_type, commission_job_type(p.product, p.lead_type)),
         coalesce(ml.paid_logged_at, s.paid_at),
         case when ml.id is not null then ml.amount when s.person = v_me then s.amount end,
         case when ml.id is not null then ml.status
              when s.reason = 'not_paid' then 'not_earned'
              when s.reason is not null or taken.yes then 'blocked'
              else 'ready' end,
         case when ml.id is not null then null when s.reason is not null then s.reason when taken.yes then 'claimed' end,
         ml.claim_id, ml.doc_no
    from mine m
    join prospects p on p.id = m.pid
    cross join lateral commission_job_state(p.id) s
    cross join lateral (select exists (select 1 from commission_claim_lines x where x.prospect_id = p.id and x.live) as yes) taken
    left join commission_job_refs r on r.prospect_id = p.id
    left join ml on ml.prospect_id = p.id
   where ml.id is not null
      or (p.deleted_at is null and (s.paid_at is not null or exists (
            select 1 from prospect_contacts w
             where w.prospect_id = p.id and w.deleted_at is null
               and w.outcome in ('Converted', 'Contract Signed', 'DNO Submitted', 'DNO Approved', 'Scheduled for Install', 'Completed')
               and not exists (select 1 from prospect_contacts x
                    where x.prospect_id = p.id and x.deleted_at is null and commission_is_lost(x.outcome) and x.contacted_at >= w.contacted_at))))
   order by 6 desc nulls last, 3;
end;
$$;

-- -- Actions: the person -----------------------------------------------------
create or replace function commission_save_details(p_name text, p_address text)
returns void language plpgsql volatile security definer set search_path = public
as $$
declare
  v_me text := commission_caller();
  v_name text := trim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  v_address text := trim(coalesce(p_address, ''));
begin
  if length(v_name) < 3 or length(v_name) > 120 then raise exception 'Enter your full name'; end if;
  if length(v_address) < 8 or length(v_address) > 400 then raise exception 'Enter your full address'; end if;
  perform commission_person(v_me);
  update commission_people set full_name = v_name, address = v_address, details_saved_at = now() where email = v_me;
  insert into commission_events (by_email, email, event) values (v_me, v_me, 'details_saved');
end;
$$;

-- p_expected_total only ever refuses: if the figures moved since the page was
-- loaded, nothing is submitted.
create or replace function commission_submit(p_prospect_ids uuid[], p_confirmed boolean, p_expected_total numeric)
returns uuid language plpgsql volatile security definer set search_path = public
as $$
declare
  v_me text := commission_caller();
  v_ids uuid[];
  v_id uuid;
  v_claim uuid;
  v_total numeric := 0;
  s record;
  p record;
begin
  if p_confirmed is not true then raise exception 'Tick the box to confirm this is your claim'; end if;
  select array_agg(distinct x order by x) into v_ids from unnest(p_prospect_ids) x where x is not null;
  if v_ids is null then raise exception 'Choose at least one job'; end if;
  if cardinality(v_ids) > 50 then raise exception 'Choose 50 jobs or fewer'; end if;

  perform commission_person(v_me);

  foreach v_id in array v_ids loop
    select * into s from commission_job_state(v_id);
    if s.person is distinct from v_me then raise exception 'One of these jobs isn''t yours to claim'; end if;
    if s.reason is not null then raise exception 'One of these jobs can''t be claimed. Refresh the page'; end if;
    v_total := v_total + round(s.amount, 2);
  end loop;
  if p_expected_total is null or round(p_expected_total, 2) <> v_total then
    raise exception 'The amounts have changed since you opened the page. Refresh and check them';
  end if;

  insert into commission_claims (email, total, declaration)
    values (v_me, v_total, 'This is my claim. I''ve checked the jobs and amounts.') returning id into v_claim;

  foreach v_id in array v_ids loop
    -- Read again and written in one go, so what is frozen is what was checked.
    select * into s from commission_job_state(v_id);
    if s.person is distinct from v_me or s.reason is not null then
      raise exception 'One of these jobs has just changed. Refresh the page';
    end if;
    select * into p from prospects where id = v_id;
    begin
      insert into commission_claim_lines (claim_id, prospect_id, quote_option_id, job_ref, customer_name, outward_code, job_type, paid_logged_at, paid_logged_by, amount)
      values (v_claim, v_id, s.quote_option_id, commission_job_ref(v_id),
              coalesce(nullif(trim(p.customer_name), ''), 'Customer not named'),
              upper(nullif(regexp_replace(coalesce(p.postcode, ''), '\s*[0-9][A-Za-z]{2}\s*$', ''), '')),
              commission_job_type(p.product, p.lead_type), s.paid_at, s.paid_by, round(s.amount, 2));
    exception when unique_violation then
      raise exception 'One of these jobs is already on a claim. Refresh the page';
    end;
  end loop;
  if (select sum(l.amount) from commission_claim_lines l where l.claim_id = v_claim) <> v_total then
    raise exception 'The amounts have changed since you opened the page. Refresh and check them';
  end if;
  return v_claim;
end;
$$;

-- -- Actions: managers -------------------------------------------------------
create or replace function commission_set_type(p_email text, p_type text)
returns void language plpgsql volatile security definer set search_path = public
as $$
declare
  v_me text := commission_require_manager();
  v_email text := lower(trim(coalesce(p_email, '')));
  r commission_people;
begin
  if v_email not like '%_@turbineenergyuk.co.uk' then raise exception 'That isn''t a Turbine account'; end if;
  if v_email = v_me then raise exception 'You can''t set your own type. Ask another manager'; end if;
  if p_type is not null and p_type not in ('self_employed', 'employed') then raise exception 'Choose self-employed or employed'; end if;
  r := commission_person(v_email);
  if r.pay_type is not distinct from p_type then return; end if;
  update commission_people set pay_type = p_type, type_set_by = v_me, type_set_at = now() where email = v_email;
  insert into commission_events (by_email, email, event, detail)
    values (v_me, v_email, 'type_set', jsonb_build_object('from', r.pay_type, 'to', p_type));
end;
$$;

-- What has changed since each open form was sent in, for the approval screen.
create or replace function commission_review()
returns table (line_id uuid, now_option uuid, now_amount numeric, now_person text, now_reason text)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
begin
  perform commission_require_manager();
  return query
    select l.id, s.quote_option_id, s.amount, s.person, s.reason
      from commission_claim_lines l
      join commission_claims c on c.id = l.claim_id and c.status in ('submitted', 'approved')
      cross join lateral commission_job_state(l.prospect_id) s
     where l.live;
end;
$$;

create or replace function commission_approve(p_claim uuid, p_accept_changes boolean default false)
returns text language plpgsql volatile security definer set search_path = public
as $$
declare
  v_me text := commission_require_manager();
  c commission_claims;
  r commission_people;
  l record;
  v_no text;
  v_n int;
  v_changed boolean := false;
begin
  select * into c from commission_claims where id = p_claim for update;
  if not found then raise exception 'Claim not found'; end if;
  if c.email = v_me then raise exception 'You can''t approve your own commission. Ask another manager'; end if;
  if c.status <> 'submitted' then raise exception 'This claim isn''t waiting for approval'; end if;

  r := commission_person(c.email);   -- locks the person, so numbers can't clash or skip
  if r.pay_type is null then raise exception 'Set whether this person is self-employed or employed first'; end if;
  if coalesce(r.full_name, '') = '' or coalesce(r.address, '') = '' then
    raise exception 'They need to fill in their name and address first';
  end if;

  for l in select x.job_ref, x.amount, x.quote_option_id, s.amount as now_amount, s.person as now_person,
                  s.reason as now_reason, s.quote_option_id as now_option
             from commission_claim_lines x cross join lateral commission_job_state(x.prospect_id) s
            where x.claim_id = p_claim loop
    if l.now_reason in ('deleted', 'not_paid', 'cancelled') then
      raise exception '% no longer qualifies: the customer isn''t logged as paid, or the job has since been cancelled. Send the form back', l.job_ref;
    end if;
    if l.now_reason is not null or l.now_person is distinct from c.email
       or round(l.now_amount, 2) is distinct from l.amount or l.now_option is distinct from l.quote_option_id then
      v_changed := true;
    end if;
  end loop;
  if v_changed and p_accept_changes is not true then
    raise exception 'The quote has changed since this form was sent in. Check it, then approve or send it back';
  end if;

  if r.pay_type = 'self_employed' then
    v_n := r.next_invoice_no;
    update commission_people set next_invoice_no = v_n + 1 where email = c.email;
    v_no := r.prefix || '-' || lpad(v_n::text, greatest(4, length(v_n::text)), '0');
  else
    v_n := r.next_statement_no;
    update commission_people set next_statement_no = v_n + 1 where email = c.email;
    v_no := r.prefix || '-S' || lpad(v_n::text, greatest(4, length(v_n::text)), '0');
  end if;

  update commission_claims set status = 'approved', approved_at = now(), approved_by = v_me,
    doc_kind = case when r.pay_type = 'self_employed' then 'invoice' else 'statement' end,
    doc_no = v_no, doc_date = (now() at time zone 'Europe/London')::date,
    from_name = r.full_name, from_address = r.address, from_email = c.email,
    to_details = E'Turbine Marketing Ltd\ntrading as Turbine Energy\nWader Lodge, Back Lane\nCusworth, Doncaster\nDN5 7TR',
    vat_note = case when r.pay_type = 'self_employed' then 'Not VAT registered. No VAT charged.' end,
    payment_note = case when r.pay_type = 'self_employed' then 'By bank transfer to the account held by Turbine''s accounts.' else 'To be paid through payroll.' end
   where id = p_claim;
  return v_no;
end;
$$;

-- Submitted = sent back; approved = void. Either way the jobs are free again.
create or replace function commission_void(p_claim uuid, p_reason text)
returns text language plpgsql volatile security definer set search_path = public
as $$
declare
  v_me text := commission_require_manager();
  c commission_claims;
  v_reason text := trim(coalesce(p_reason, ''));
  v_status text;
begin
  select * into c from commission_claims where id = p_claim for update;
  if not found then raise exception 'Claim not found'; end if;
  if c.email = v_me then raise exception 'You can''t send back or void your own commission. Ask another manager'; end if;
  if c.status = 'paid' then raise exception 'This has been paid, so it can''t be voided. Use a correction instead'; end if;
  if c.status not in ('submitted', 'approved') then raise exception 'This claim is already closed'; end if;
  if length(v_reason) < 3 then raise exception 'Give a reason'; end if;
  if length(v_reason) > 1000 then raise exception 'Keep the reason under 1,000 characters'; end if;
  v_status := case when c.status = 'submitted' then 'sent_back' else 'void' end;
  update commission_claims set status = v_status, closed_reason = v_reason, closed_by = v_me, closed_at = now() where id = p_claim;
  update commission_claim_lines set live = false where claim_id = p_claim and live;
  return v_status;
end;
$$;

create or replace function commission_mark_paid(p_claim uuid, p_paid_on date, p_reference text default null)
returns void language plpgsql volatile security definer set search_path = public
as $$
declare
  v_me text := commission_require_manager();
  c commission_claims;
begin
  select * into c from commission_claims where id = p_claim for update;
  if not found then raise exception 'Claim not found'; end if;
  if c.email = v_me then raise exception 'You can''t mark your own commission as paid. Ask another manager'; end if;
  if c.status <> 'approved' then raise exception 'Only an approved claim can be marked paid'; end if;
  if p_paid_on is null then raise exception 'Enter the date it was paid'; end if;
  if p_paid_on > (now() at time zone 'Europe/London')::date then raise exception 'The paid date can''t be in the future'; end if;
  if p_paid_on < (c.submitted_at at time zone 'Europe/London')::date then raise exception 'The paid date can''t be before the claim was sent in'; end if;
  if length(trim(coalesce(p_reference, ''))) > 100 then raise exception 'Keep the reference under 100 characters'; end if;
  update commission_claims set status = 'paid', paid_on = p_paid_on, paid_ref = nullif(trim(coalesce(p_reference, '')), ''),
    paid_by = v_me, paid_at = now() where id = p_claim;
end;
$$;

-- -- Who may call what --------------------------------------------------------
-- Supabase grants new functions to anon and authenticated, so take that back.
revoke all on function commission_no_change(), commission_guard_claim(), commission_guard_line(), commission_log_claim(),
  commission_caller(), commission_require_manager(), commission_is_lost(text), commission_job_state(uuid), commission_job_ref(uuid),
  commission_person(text), commission_job_type(text, text), commission_my_jobs(), commission_save_details(text, text),
  commission_submit(uuid[], boolean, numeric), commission_set_type(text, text), commission_review(),
  commission_approve(uuid, boolean), commission_void(uuid, text), commission_mark_paid(uuid, date, text)
  from public, anon, authenticated;
grant execute on function commission_my_jobs(), commission_save_details(text, text), commission_submit(uuid[], boolean, numeric),
  commission_set_type(text, text), commission_review(), commission_approve(uuid, boolean), commission_void(uuid, text),
  commission_mark_paid(uuid, date, text)
  to authenticated;
