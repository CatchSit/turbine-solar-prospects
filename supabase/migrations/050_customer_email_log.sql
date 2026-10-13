-- Customer emails, v1 (agreed with the user 2026-10-12, design in
-- docs/superpowers/specs/2026-10-12-stage-customer-emails-design.md):
-- nothing is sent by the system. The CRM works out which customer email is
-- due at each stage (DNO submitted / keep-in-touch / DNO approved /
-- welcome / install booked / installed), opens it pre-filled in the rep's
-- own Outlook (mailto:), and the rep reviews and clicks Send there. This
-- table only records what the rep then confirmed: "sent" (they clicked
-- Mark as sent) or "skipped". It's what stops a due email reappearing and
-- what counts the keep-in-touch emails (max 3).
create table if not exists email_log (
  id                 uuid primary key default gen_random_uuid(),
  prospect_id        uuid not null references prospects(id),
  -- The contact log row that triggered it (for the keep-in-touch series,
  -- the DNO Submitted row; sequence_no = 1, 2, 3).
  related_contact_id uuid references prospect_contacts(id),
  email_type         text not null check (email_type in
                       ('dno_submitted', 'dno_keep_in_touch', 'dno_approved', 'welcome', 'install_confirm', 'handover')),
  sequence_no        int not null default 1 check (sequence_no between 1 and 10),
  status             text not null check (status in ('sent', 'skipped')),
  to_email           text,
  subject            text,
  created_by_email   text not null default lower(auth.jwt() ->> 'email'),
  created_at         timestamptz not null default now()
);

-- One decision per email: a second "Mark as sent" (double click, two reps
-- on the same lead) fails here instead of logging twice.
create unique index if not exists email_log_once_key
  on email_log (prospect_id, email_type, related_contact_id, sequence_no);
create index if not exists email_log_prospect_idx on email_log (prospect_id);

alter table email_log enable row level security;

drop policy if exists "Turbine Energy read email log" on email_log;
create policy "Turbine Energy read email log"
  on email_log for select to authenticated
  using (lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk');

-- Insert only under your own identity (same rule as prospect_contacts, 008).
-- No update/delete: the log is append-only.
drop policy if exists "Turbine Energy insert email log" on email_log;
create policy "Turbine Energy insert email log"
  on email_log for insert to authenticated
  with check (
    lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk'
    and created_by_email = lower(auth.jwt() ->> 'email')
  );
