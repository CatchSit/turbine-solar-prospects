-- 065: wholesaler quotes and invoices read from email (Greg, 2026-11-08).
--
-- supplier-mail-prices (every 10 minutes, migration 066) reads PDF
-- attachments from wholesaler emails with Claude and saves the prices
-- straight to price_lines (Greg's choice). price_documents logs every PDF it
-- has seen, once each (content_hash), so prices.html can list them and a
-- manager can undo a whole document.
--
-- The first run looks back 6 months (Greg's choice) in every mailbox the
-- email sync already uses.

create table if not exists price_documents (
  id             uuid primary key default gen_random_uuid(),
  content_hash   text not null unique,
  source         text not null default 'email',
  mailbox        text,
  sender         text,
  subject        text,
  file_name      text,
  received_at    timestamptz,
  supplier       text,
  document_type  text,
  document_ref   text,
  document_date  date,
  line_count     integer,
  status         text not null,   -- reading | saved | no lines | not a price document | failed | undone
  error          text,
  created_at     timestamptz not null default now()
);
create index if not exists price_documents_received_idx on price_documents (received_at desc);

alter table price_documents enable row level security;
drop policy if exists "Manager read" on price_documents;
create policy "Manager read" on price_documents for select to authenticated using (is_manager());
drop policy if exists "Manager update" on price_documents;
create policy "Manager update" on price_documents for update to authenticated using (is_manager()) with check (is_manager());

alter table price_lines add column if not exists document_id uuid references price_documents(id) on delete set null;
create index if not exists price_lines_document_idx on price_lines (document_id);

create table if not exists price_mail_mailboxes (
  mailbox        text primary key,
  enabled        boolean not null default true,
  synced_through timestamptz not null,
  last_run_at    timestamptz,
  last_error     text
);
alter table price_mail_mailboxes enable row level security;
drop policy if exists "Manager read" on price_mail_mailboxes;
create policy "Manager read" on price_mail_mailboxes for select to authenticated using (is_manager());

insert into price_mail_mailboxes (mailbox, synced_through)
select mailbox, now() - interval '6 months' from mail_sync_mailboxes where enabled
on conflict (mailbox) do nothing;
