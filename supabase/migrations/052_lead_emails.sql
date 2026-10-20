-- Outlook emails on CRM leads (2026-10-20).
-- See docs/superpowers/specs/2026-10-20-outlook-email-sync-design.md.
--
-- The mail-sync Edge Function reads info@ and every rep's Microsoft 365
-- mailbox (Microsoft Graph, app-only, limited by Exchange to those
-- mailboxes), keeps only messages to/from a lead's contact_email, and has
-- Claude summarise each one and suggest a stage change. Decisions (Greg):
--   - the email body is NEVER stored: only who/when/subject, a short AI
--     summary and the suggestion. The body is read in memory and dropped;
--   - visible only to managers and the lead's assigned rep;
--   - backfill the last 2 months;
--   - a suggested stage change is applied by a person (Apply opens the Log
--     contact form pre-filled), not automatically, until Greg is happy.

-- ── Which mailboxes are synced, and how far each has got ─────────────
create table if not exists mail_sync_mailboxes (
  mailbox         text primary key check (mailbox = lower(mailbox)),
  enabled         boolean not null default true,
  synced_through  timestamptz,           -- receivedDateTime of the last message processed
  run_started_at  timestamptz,           -- set while a run holds this mailbox (overlap guard)
  last_run_at     timestamptz,
  last_error      text,
  added_at        timestamptz not null default now()
);
alter table mail_sync_mailboxes enable row level security;

insert into mail_sync_mailboxes (mailbox) values
  ('info@turbineenergyuk.co.uk'),
  ('greg@turbineenergyuk.co.uk'),
  ('tim@turbineenergyuk.co.uk'),
  ('chris@turbineenergyuk.co.uk'),
  ('jackie@turbineenergyuk.co.uk')
on conflict (mailbox) do nothing;

-- Managers can see sync status; only the Edge Function (service role)
-- writes. Add or remove a mailbox here in the SQL editor, and in Exchange.
drop policy if exists "Manager read" on mail_sync_mailboxes;
create policy "Manager read"
  on mail_sync_mailboxes for select to authenticated
  using (is_manager());

-- ── One row per email per lead ───────────────────────────────────────
create table if not exists lead_emails (
  id                  uuid primary key default gen_random_uuid(),
  prospect_id         uuid not null references prospects(id),
  internet_message_id text not null,       -- same across mailboxes, so a CC'd copy isn't counted twice
  conversation_id     text,
  mailboxes           text[] not null default '{}',  -- which synced mailboxes hold a copy
  web_link            text,                -- opens the copy in the first mailbox it was found in
  direction           text not null check (direction in ('in', 'out')),  -- in = from the customer
  from_email          text,
  from_name           text,
  to_emails           text[] not null default '{}',
  subject             text,
  sent_at             timestamptz not null,
  -- Claude's reading of the email (no body stored)
  summary             text,
  ai_status           text not null default 'pending' check (ai_status in ('pending', 'done', 'skipped', 'failed')),
  ai_outcome          text,                -- a CONTACT_OUTCOME key, or null for "no change"
  ai_follow_up_date   date,
  ai_reason           text,
  -- What a person did with the suggestion
  suggestion_status   text not null default 'none' check (suggestion_status in ('none', 'open', 'applied', 'dismissed')),
  resolved_by_email   text,
  resolved_at         timestamptz,
  applied_contact_id  uuid references prospect_contacts(id),
  created_at          timestamptz not null default now(),
  unique (prospect_id, internet_message_id)
);
create index if not exists lead_emails_prospect_sent_idx on lead_emails (prospect_id, sent_at desc);
create index if not exists lead_emails_open_idx on lead_emails (prospect_id) where suggestion_status = 'open';
alter table lead_emails enable row level security;

-- Managers, plus the rep the lead is assigned to.
create or replace function can_see_lead_emails(p_prospect_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk'
     and (is_manager() or exists (
           select 1 from prospects p
           where p.id = p_prospect_id
             and lower(p.assigned_to_email) = lower(auth.jwt() ->> 'email')));
$$;
grant execute on function can_see_lead_emails(uuid) to authenticated;

drop policy if exists "Manager or assigned rep read" on lead_emails;
create policy "Manager or assigned rep read"
  on lead_emails for select to authenticated
  using (can_see_lead_emails(prospect_id));

drop policy if exists "Manager or assigned rep resolve" on lead_emails;
create policy "Manager or assigned rep resolve"
  on lead_emails for update to authenticated
  using (can_see_lead_emails(prospect_id))
  with check (can_see_lead_emails(prospect_id));
-- No insert/delete policies: only the Edge Function (service role) adds rows.

-- A person may only resolve an open suggestion (Apply / Dismiss); every
-- other column is the Edge Function's. RLS can't scope to columns, so a
-- trigger does (same approach as 048/049).
create or replace function guard_lead_email_update()
returns trigger
language plpgsql
as $$
begin
  if auth.role() = 'service_role' then
    return new;
  end if;
  if (new.prospect_id, new.internet_message_id, new.conversation_id, new.mailboxes, new.web_link,
      new.direction, new.from_email, new.from_name, new.to_emails, new.subject, new.sent_at,
      new.summary, new.ai_status, new.ai_outcome, new.ai_follow_up_date, new.ai_reason, new.created_at)
     is distinct from
     (old.prospect_id, old.internet_message_id, old.conversation_id, old.mailboxes, old.web_link,
      old.direction, old.from_email, old.from_name, old.to_emails, old.subject, old.sent_at,
      old.summary, old.ai_status, old.ai_outcome, old.ai_follow_up_date, old.ai_reason, old.created_at) then
    raise exception 'Only the email sync can change an email''s details';
  end if;
  if old.suggestion_status <> 'open' or new.suggestion_status not in ('applied', 'dismissed') then
    raise exception 'This suggestion has already been dealt with';
  end if;
  new.resolved_by_email := lower(auth.jwt() ->> 'email');
  new.resolved_at := now();
  if new.suggestion_status = 'dismissed' then
    new.applied_contact_id := null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_lead_email_update on lead_emails;
create trigger trg_guard_lead_email_update
  before update on lead_emails
  for each row execute function guard_lead_email_update();

-- Live updates on the lead page (051's publication).
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'lead_emails') then
    alter publication supabase_realtime add table lead_emails;
  end if;
end $$;
