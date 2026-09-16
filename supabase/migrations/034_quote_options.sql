-- Multi-quote-options: a lead can now have several quote options (e.g.
-- different panel counts, with/without battery), each with its own cost
-- breakdown, its own documents, and its own edit history — replacing
-- lead_quotes' one-row-per-lead model. Brainstormed + decided 2026-09-16:
-- documents support both general (lead-level) and per-option attachment,
-- options have a free-text rep-entered label, and one option per lead can
-- be marked as the customer's selected/winning one.

create table if not exists quote_options (
  id                uuid primary key default gen_random_uuid(),
  prospect_id       uuid not null references prospects(id) on delete cascade,
  label             text,
  position          integer not null default 0,
  kit_price         numeric,
  scaffold_price    numeric,
  electrical_cost   numeric,
  roofer_cost       numeric,
  mcs_cost          numeric,
  fuel_cost         numeric,
  commission_cost   numeric,
  quote_price       numeric,
  is_selected       boolean not null default false,
  created_at        timestamptz not null default now(),
  created_by_email  text,
  updated_at        timestamptz not null default now(),
  updated_by_email  text
);
create index if not exists quote_options_prospect_id_idx on quote_options (prospect_id);
-- At most one selected ("winning") option per lead — a partial unique
-- index rather than a check constraint, since uniqueness needs to span
-- rows, not just validate one row in isolation.
create unique index if not exists quote_options_one_selected_per_prospect
  on quote_options (prospect_id) where is_selected;

alter table quote_options enable row level security;
drop policy if exists "Turbine Energy read" on quote_options;
create policy "Turbine Energy read"
  on quote_options for select to authenticated
  using (lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk');
drop policy if exists "Turbine Energy insert" on quote_options;
create policy "Turbine Energy insert"
  on quote_options for insert to authenticated
  with check (lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk');
drop policy if exists "Turbine Energy update" on quote_options;
create policy "Turbine Energy update"
  on quote_options for update to authenticated
  using (lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk')
  with check (lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk');
-- Delete is new — lead_quotes never needed it (always exactly one row,
-- upserted in place), but removing a mistaken option is a real need now.
drop policy if exists "Turbine Energy delete" on quote_options;
create policy "Turbine Energy delete"
  on quote_options for delete to authenticated
  using (lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk');

-- Migrate each lead's existing single quote into its first option. Marked
-- is_selected — it's the only quote that existed, so it's the operative
-- one until a rep says otherwise. created_at has no better source than
-- updated_at (lead_quotes never tracked a separate creation time).
insert into quote_options (
  prospect_id, label, position, kit_price, scaffold_price, electrical_cost, roofer_cost,
  mcs_cost, fuel_cost, commission_cost, quote_price, is_selected, created_at, updated_at, updated_by_email
)
select prospect_id, 'Option 1', 0, kit_price, scaffold_price, electrical_cost, roofer_cost,
  mcs_cost, fuel_cost, commission_cost, quote_price, true, updated_at, updated_at, updated_by_email
from lead_quotes;

-- Atomic "mark this option selected, unmark every other option for the
-- same lead" — must be one transaction, not two sequential client-side
-- updates, or a crash/race between them could leave a lead with zero or
-- two selected options despite the partial unique index (which only
-- catches the second case, mid-transaction, not the gap between two
-- separate round trips).
create or replace function select_quote_option(p_option_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prospect_id uuid;
begin
  if lower(auth.jwt() ->> 'email') not like '%@turbineenergyuk.co.uk' then
    raise exception 'Forbidden';
  end if;

  select prospect_id into v_prospect_id from quote_options where id = p_option_id;
  if v_prospect_id is null then
    raise exception 'Quote option not found';
  end if;

  update quote_options set is_selected = false
    where prospect_id = v_prospect_id and is_selected and id != p_option_id;
  update quote_options set is_selected = true
    where id = p_option_id;
end;
$$;
grant execute on function select_quote_option(uuid) to authenticated;

-- Extend lead_quote_audit (023) in place rather than starting a fresh
-- table — same "keep one continuous history" choice as 031's extension of
-- prospect_name_audit. quote_option_id is nullable only because pre-034
-- rows predate the concept; backfilled below via each row's prospect_id,
-- which was unambiguous back when a lead had exactly one quote.
alter table lead_quote_audit add column if not exists quote_option_id uuid references quote_options(id) on delete cascade;
alter table lead_quote_audit add column if not exists label text;

update lead_quote_audit a
set quote_option_id = qo.id, label = qo.label
from quote_options qo
where a.prospect_id = qo.prospect_id and a.quote_option_id is null;

create or replace function log_quote_option_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into lead_quote_audit (
    prospect_id, quote_option_id, label, kit_price, scaffold_price, electrical_cost, roofer_cost,
    mcs_cost, fuel_cost, commission_cost, quote_price, edited_by_email
  ) values (
    new.prospect_id, new.id, new.label, new.kit_price, new.scaffold_price, new.electrical_cost, new.roofer_cost,
    new.mcs_cost, new.fuel_cost, new.commission_cost, new.quote_price, lower(auth.jwt() ->> 'email')
  );
  return new;
end;
$$;

-- lead_quotes itself is left in place, untouched, as an inert historical
-- record — the app stops reading/writing it as of this migration, but
-- nothing here drops it or its data.
drop trigger if exists trg_log_lead_quote_change on lead_quotes;
drop trigger if exists trg_log_quote_option_change on quote_options;
create trigger trg_log_quote_option_change
  after insert or update on quote_options
  for each row execute function log_quote_option_change();

-- Documents can now optionally belong to a specific quote option instead
-- of (or as well as) being general to the lead — nullable, so every
-- existing document and every future "general" upload (e.g. a site survey
-- photo) still works with no option attached.
alter table lead_documents add column if not exists quote_option_id uuid references quote_options(id) on delete cascade;
create index if not exists lead_documents_quote_option_id_idx on lead_documents (quote_option_id);

-- Existing documents predate this concept but were, in practice, always
-- about "the" quote for their lead (there was only ever one) — attach them
-- to that lead's migrated option rather than leaving them stranded as
-- "general" by default by an accident of timing.
update lead_documents d
set quote_option_id = qo.id
from quote_options qo
where d.prospect_id = qo.prospect_id and d.quote_option_id is null;
