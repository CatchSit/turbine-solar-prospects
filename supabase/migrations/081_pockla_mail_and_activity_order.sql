-- Pockla appointment emails into the CRM, meeting times, and ordering leads
-- by latest activity (Greg, 2026-11-25). Safe to run twice.
-- Run BEFORE the CRM page is pushed. 082 (the 10-minute schedule) comes last.

-- 1. The time of a meeting or survey (the date is follow_up_date)
alter table prospect_contacts add column if not exists appointment_time time;

-- 2. The confirmation email shows on the lead's timeline
alter table email_log drop constraint if exists email_log_email_type_check;
alter table email_log add constraint email_log_email_type_check check (email_type in
  ('dno_submitted', 'dno_keep_in_touch', 'dno_approved', 'welcome', 'install_confirm', 'handover', 'meeting_confirm'));

-- 3. Settings and position. synced_through starts now, so older emails
--    (already added by hand) are never imported.
create table if not exists pockla_import_state (
  id              int primary key check (id = 1),
  enabled         boolean not null default true,
  email_enabled   boolean not null default false,   -- customer confirmations: off until Greg approves the wording
  synced_through  timestamptz not null default now(),
  last_run_at     timestamptz,
  last_error      text
);
insert into pockla_import_state (id) values (1) on conflict (id) do nothing;
alter table pockla_import_state enable row level security;
drop policy if exists "Manager read" on pockla_import_state;
create policy "Manager read" on pockla_import_state for select to authenticated using (is_manager());

-- 4. One row per Pockla email
create table if not exists pockla_imports (
  id                   uuid primary key default gen_random_uuid(),
  internet_message_id  text not null unique,
  received_at          timestamptz not null,
  status               text not null check (status in ('processing', 'done', 'repeat', 'failed', 'unverified', 'ignored')),
  reference            text,
  appointment_date     date,
  appointment_time     time,
  prospect_id          uuid references prospects(id) on delete set null,
  is_new_lead          boolean,
  contact_id           uuid references prospect_contacts(id) on delete set null,
  email_status         text,
  error                text,
  web_link             text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  dismissed_at         timestamptz
);
create index if not exists pockla_imports_reference_idx on pockla_imports (reference);
alter table pockla_imports enable row level security;
drop policy if exists "Manager read" on pockla_imports;
create policy "Manager read" on pockla_imports for select to authenticated using (is_manager());
-- Managers can only dismiss a warning; everything else is the Edge Function's.
drop policy if exists "Manager dismiss" on pockla_imports;
create policy "Manager dismiss" on pockla_imports for update to authenticated using (is_manager()) with check (is_manager());
revoke insert, update, delete on pockla_imports from authenticated, anon;
revoke insert, update, delete on pockla_import_state from authenticated, anon;
grant update (dismissed_at) on pockla_imports to authenticated;

-- 5. Price per Pockla solar appointment (Greg, 2026-11-25). Only affects
--    leads added from now on.
update lead_origins set cost_per_lead = 150.00 where lower(trim(name)) = 'pockla - solar';

-- 6. Latest activity per lead: logged contacts, emails in and out, website
--    enquiries, supplier deliveries, customer emails, or the day it was added.
--    security_invoker keeps each table's own access rules, so emails count
--    only for people who could already see them.
create or replace view lead_last_activity with (security_invoker = on) as
select p.id as prospect_id, greatest(
  p.created_at,
  (select max(contacted_at) from prospect_contacts c where c.prospect_id = p.id and c.deleted_at is null),
  (select max(sent_at)      from lead_emails e       where e.prospect_id = p.id),
  (select max(received_at)  from website_enquiries w where w.prospect_id = p.id),
  (select max(received_at)  from supplier_leads s    where s.prospect_id = p.id),
  (select max(created_at)   from email_log l         where l.prospect_id = p.id and l.status = 'sent')
) as last_activity_at
from prospects p
where p.source = 'manual' and p.deleted_at is null;
revoke all on lead_last_activity from anon;
grant select on lead_last_activity to authenticated;
