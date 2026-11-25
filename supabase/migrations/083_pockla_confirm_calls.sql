-- A manager confirms each Pockla call before the customer is emailed
-- (Greg, 2026-11-25). Safe to run twice. Run before the CRM page is pushed
-- and before pockla-mail / pockla-confirm are deployed.

alter table pockla_imports
  add column if not exists outside_hours      boolean not null default false,
  add column if not exists confirmed_by_email text,
  add column if not exists confirmed_at       timestamptz;

-- Anything already imported while confirmations were off joins the list.
update pockla_imports i set
  outside_hours = exists (select 1 from prospect_contacts c where c.id = i.contact_id and c.notes like 'OUTSIDE SURVEY HOURS%')
where i.contact_id is not null and i.email_status = 'off';

update pockla_imports set email_status = 'awaiting', updated_at = now()
where email_status = 'off' and status = 'done' and contact_id is not null;

create index if not exists pockla_imports_awaiting_idx on pockla_imports (received_at) where email_status = 'awaiting';
