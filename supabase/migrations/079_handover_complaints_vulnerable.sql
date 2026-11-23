-- 079: Handover section, complaints log and vulnerable customer flag
-- (Greg, 2026-11-23, from the MCS compliance tracker items 18, 21 and 22).
--
-- 1. prospects.vulnerable / vulnerable_notes: a tick and notes on the lead
--    (Customer > Edit). Same update rule as the other lead details (056).
-- 2. Three more document types for the handover pack: 'manuals' (manuals
--    and guides), 'warranties' (warranty certificates and registrations),
--    'install_photos' (installation photos). Same list as 077 plus these.
-- 3. handovers: one row per job. The handover details (date, who, the
--    monitoring app and the customer's login EMAIL - never passwords,
--    Greg's choice), ticks for "customer has their login", "warranties
--    registered" and "DNO copy sent to customer", which documents to leave
--    out of the pack (pack_excluded = lead_documents ids), and when the
--    pack was marked as sent. The pack itself is a zip built in the
--    browser from the lead's documents; nothing new is stored for it.
--    Same edit rule as the install checklist: can_edit_lead (056).
-- 4. complaints: the complaints log (MCS Customer Commitment / HIES Code).
--    Anyone with a Turbine account can log one on any lead (a complaint can
--    reach whoever answers the phone); the person who logged it, anyone who
--    can edit the lead, or a manager can update it. No delete: a complaint
--    log must keep every entry. Manager Home > Complaints lists them all.

-- 1. Vulnerable customer
alter table prospects add column if not exists vulnerable boolean not null default false;
alter table prospects add column if not exists vulnerable_notes text;
alter table prospects drop constraint if exists prospects_vulnerable_notes_len;
alter table prospects add constraint prospects_vulnerable_notes_len
  check (vulnerable_notes is null or char_length(vulnerable_notes) <= 1000);

-- 2. Document types
alter table lead_documents drop constraint if exists lead_documents_category_check;
alter table lead_documents add constraint lead_documents_category_check check (
  category is null or category in (
    'survey', 'bills', 'design', 'contract', 'dno', 'building_control',
    'eic', 'commissioning', 'mcs_certificate', 'handover', 'hies', 'invoices',
    'manuals', 'warranties', 'install_photos', 'other'
  )
);

-- 3. Handover
create table if not exists handovers (
  prospect_id            uuid primary key references prospects(id) on delete cascade,
  handover_date          date,
  handed_over_by         text check (handed_over_by is null or char_length(handed_over_by) <= 80),
  monitoring_app         text check (monitoring_app is null or char_length(monitoring_app) <= 120),
  customer_login_email   text check (customer_login_email is null or char_length(customer_login_email) <= 160),
  login_given            boolean not null default false,
  warranties_registered  boolean not null default false,
  warranty_refs          text check (warranty_refs is null or char_length(warranty_refs) <= 1000),
  notes                  text check (notes is null or char_length(notes) <= 2000),
  dno_copy_sent          boolean not null default false,
  dno_copy_sent_at       timestamptz,
  dno_copy_sent_by       text,
  pack_excluded          uuid[] not null default '{}',
  pack_sent_at           timestamptz,
  pack_sent_by           text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  updated_by             text
);
alter table handovers enable row level security;

drop policy if exists "Turbine Energy read" on handovers;
create policy "Turbine Energy read"
  on handovers for select to authenticated
  using (lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk');
drop policy if exists "Can edit lead insert" on handovers;
create policy "Can edit lead insert"
  on handovers for insert to authenticated
  with check (can_edit_lead(prospect_id));
drop policy if exists "Can edit lead update" on handovers;
create policy "Can edit lead update"
  on handovers for update to authenticated
  using (can_edit_lead(prospect_id))
  with check (can_edit_lead(prospect_id));

-- Who/when comes from the caller's own sign-in, never from the page.
create or replace function stamp_handover()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_me text := auth.jwt() ->> 'email';
begin
  new.updated_at := now();
  new.updated_by := v_me;
  if tg_op = 'INSERT' then
    if new.dno_copy_sent then new.dno_copy_sent_at := now(); new.dno_copy_sent_by := v_me;
    else new.dno_copy_sent_at := null; new.dno_copy_sent_by := null; end if;
    if new.pack_sent_at is not null then new.pack_sent_at := now(); new.pack_sent_by := v_me; end if;
    return new;
  end if;
  if new.dno_copy_sent is distinct from old.dno_copy_sent then
    new.dno_copy_sent_at := case when new.dno_copy_sent then now() end;
    new.dno_copy_sent_by := case when new.dno_copy_sent then v_me end;
  else
    new.dno_copy_sent_at := old.dno_copy_sent_at;
    new.dno_copy_sent_by := old.dno_copy_sent_by;
  end if;
  if new.pack_sent_at is distinct from old.pack_sent_at then
    new.pack_sent_at := case when new.pack_sent_at is not null then now() end;
    new.pack_sent_by := case when new.pack_sent_at is not null then v_me end;
  else
    new.pack_sent_by := old.pack_sent_by;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_stamp_handover on handovers;
create trigger trg_stamp_handover before insert or update on handovers
  for each row execute function stamp_handover();

-- 4. Complaints log
create table if not exists complaints (
  id                uuid primary key default gen_random_uuid(),
  prospect_id       uuid not null references prospects(id) on delete cascade,
  received_on       date not null default current_date,
  received_via      text not null default 'phone' check (received_via in ('phone', 'email', 'letter', 'in_person', 'review', 'other')),
  details           text not null check (char_length(details) between 1 and 4000),
  action_taken      text check (action_taken is null or char_length(action_taken) <= 4000),
  outcome           text check (outcome is null or char_length(outcome) <= 2000),
  resolved_on       date,
  handled_by        text check (handled_by is null or char_length(handled_by) <= 80),
  created_by_email  text not null default lower(auth.jwt() ->> 'email'),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  updated_by        text
);
create index if not exists complaints_prospect_idx on complaints (prospect_id);
alter table complaints enable row level security;

drop policy if exists "Turbine Energy read" on complaints;
create policy "Turbine Energy read"
  on complaints for select to authenticated
  using (lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk');
drop policy if exists "Turbine Energy insert" on complaints;
create policy "Turbine Energy insert"
  on complaints for insert to authenticated
  with check (lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk'
              and created_by_email = lower(auth.jwt() ->> 'email'));
drop policy if exists "Logger, lead editor or manager update" on complaints;
create policy "Logger, lead editor or manager update"
  on complaints for update to authenticated
  using (is_manager() or created_by_email = lower(auth.jwt() ->> 'email') or can_edit_lead(prospect_id))
  with check (is_manager() or created_by_email = lower(auth.jwt() ->> 'email') or can_edit_lead(prospect_id));
-- No delete policy: entries stay in the log.

create or replace function stamp_complaint()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.jwt() ->> 'email';
  if tg_op = 'UPDATE' then
    new.created_by_email := old.created_by_email;   -- never rewritten
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_stamp_complaint on complaints;
create trigger trg_stamp_complaint before insert or update on complaints
  for each row execute function stamp_complaint();
