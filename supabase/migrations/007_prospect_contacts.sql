create table if not exists prospect_contacts (
  id             uuid primary key default gen_random_uuid(),
  prospect_id    uuid not null references prospects(id),
  employee       text not null,
  employee_email text,
  outcome        text not null,
  -- outcome must be one of: No Answer, Follow Up, Meeting Booked, Survey Booked,
  -- Quote Sent, Converted, Scheduled for Install, Completed, Not Interested,
  -- Already Has Solar (see shared/contact-outcome-config.js for the live list)
  -- (no DB-level CHECK constraint — enforced by the UI only, matching mcs-map's contacts table)
  notes          text,
  next_action    text,
  follow_up_date date,
  contacted_at   timestamptz not null default now(),
  updated_at     timestamptz,
  updated_by     text,
  deleted_at     timestamptz,
  deleted_by     text
);

create index if not exists prospect_contacts_prospect_id_idx on prospect_contacts (prospect_id);
create index if not exists prospect_contacts_contacted_at_idx on prospect_contacts (contacted_at);

alter table prospect_contacts enable row level security;

-- Any authenticated rep can log a new contact.
create policy "Authenticated insert"
  on prospect_contacts for insert
  to authenticated
  with check (true);

-- Only the manager can read — the one deliberate deviation from mcs-map's
-- contacts table (which allows any authenticated read).
create policy "Admin read"
  on prospect_contacts for select
  to authenticated
  using (auth.jwt() ->> 'email' = 'greg@turbineenergyuk.co.uk');
