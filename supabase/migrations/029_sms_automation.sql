-- Automated customer-facing SMS (appointment reminders, quote follow-up
-- nudges, install-day confirmation) — dashboard.html's "Send scheduled
-- texts now" button, triggering supabase/functions/sms-scheduler.
-- 2026-09-15.

-- install-hub's own scheduled_date is the source of truth for the install
-- job, but sms-scheduler needs it locally to find leads due an install-day
-- text without querying install-hub's separate Supabase project — captured
-- at send-to-install-hub time (see that function's update call).
alter table prospects add column if not exists install_scheduled_date date;

-- Checked before every send, everywhere a text would go out — set true only
-- by sms-inbound's Twilio webhook handler (a customer replying STOP/etc.),
-- never client-writable. Required for PECR: a customer must be able to opt
-- out, and once they have, no further automated text may reach them.
alter table prospects add column if not exists sms_opt_out boolean not null default false;

create table if not exists sms_log (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid references prospects(id) on delete cascade,
  message_type text not null check (message_type in (
    'appointment_reminder', 'quote_followup', 'install_confirmation', 'opt_out_received'
  )),
  -- The appointment/install date being reminded about (appointment_reminder,
  -- install_confirmation), or the date of the Quote Sent contact being
  -- followed up on (quote_followup) — null for opt_out_received.
  target_date date,
  -- The prospect_contacts row that triggered this send (appointment_reminder,
  -- quote_followup) — the dedup key so the same booking/quote is never
  -- texted about twice. Null for install_confirmation (driven by
  -- prospects.install_scheduled_date, not a contact log row) and for
  -- opt_out_received.
  related_contact_id uuid references prospect_contacts(id) on delete set null,
  to_phone text,
  body text,
  status text not null check (status in ('sent', 'failed', 'skipped_opted_out', 'skipped_no_phone')),
  twilio_sid text,
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists sms_log_prospect_id_idx on sms_log (prospect_id);
create index if not exists sms_log_dedup_idx on sms_log (prospect_id, message_type, related_contact_id, target_date);

-- Written only by sms-scheduler/sms-inbound's service-role client (bypasses
-- RLS) — this policy is read-only visibility for reps, same pattern as
-- api_usage/contact_enrichment_log.
alter table sms_log enable row level security;
drop policy if exists "Turbine Energy read" on sms_log;
create policy "Turbine Energy read"
  on sms_log for select
  to authenticated
  using (lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk');
