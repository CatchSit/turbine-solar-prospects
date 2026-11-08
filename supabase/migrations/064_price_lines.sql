-- 064: wholesaler price list (Greg, 2026-11-08).
--
-- One row per price Turbine was given: a line from a wholesaler quote, an
-- invoice or a price list. prices.html searches them by code, description or
-- supplier and lists every match, newest first. Prices are ex VAT as entered.
--
--   * everyone with a Turbine login: read;
--   * managers: add, change and delete.
--
-- import_batch groups the lines from one Excel import, so a bad import can be
-- removed in one go.

create extension if not exists pg_trgm;

create table if not exists price_lines (
  id               uuid primary key default gen_random_uuid(),
  supplier         text not null,
  product_code     text,
  description      text not null,
  unit_price       numeric not null check (unit_price >= 0),
  quantity         numeric,
  price_date       date not null,
  source_type      text not null check (source_type in ('quote', 'invoice', 'price list')),
  document_ref     text,
  import_batch     uuid,
  created_at       timestamptz not null default now(),
  created_by_email text,
  search_text      text generated always as (
    lower(coalesce(product_code, '') || ' ' || description || ' ' || supplier)
  ) stored
);
create index if not exists price_lines_search_idx on price_lines using gin (search_text gin_trgm_ops);
create index if not exists price_lines_date_idx on price_lines (price_date desc, created_at desc);
create index if not exists price_lines_batch_idx on price_lines (import_batch);

alter table price_lines enable row level security;

drop policy if exists "Turbine Energy read" on price_lines;
create policy "Turbine Energy read"
  on price_lines for select to authenticated
  using (lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk');

drop policy if exists "Manager insert" on price_lines;
create policy "Manager insert"
  on price_lines for insert to authenticated
  with check (is_manager());

drop policy if exists "Manager update" on price_lines;
create policy "Manager update"
  on price_lines for update to authenticated
  using (is_manager())
  with check (is_manager());

drop policy if exists "Manager delete" on price_lines;
create policy "Manager delete"
  on price_lines for delete to authenticated
  using (is_manager());

-- Supplier names already used, for the supplier box's suggestions.
create or replace view price_suppliers with (security_invoker = true) as
  select supplier, count(*) as lines, max(price_date) as latest
  from price_lines
  group by supplier;
grant select on price_suppliers to authenticated;
