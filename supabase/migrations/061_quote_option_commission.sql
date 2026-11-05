-- 061: who earns the commission on a quote option (Greg, 2026-11-05).
--
-- One person per option. The amount stays in quote_options.commission_cost, so
-- total cost, margin and the edit history keep working as they do today. The
-- person lives in this separate table because a row's columns can't be hidden
-- from a signed-in rep, and reps may see only their own commission.
--
--   * managers: read and change everything;
--   * everyone else: read only the rows that name them, change nothing.
--
-- Reps can still edit the other figures on their own leads (056), so a trigger
-- stops them changing commission_cost. Service-role and SQL editor writes have
-- no JWT email and are unaffected, same as the other guards here.

create table if not exists quote_option_commission (
  quote_option_id   uuid primary key references quote_options(id) on delete cascade,
  assigned_to_email text not null,
  updated_at        timestamptz not null default now(),
  updated_by_email  text
);
create index if not exists quote_option_commission_assigned_idx on quote_option_commission (lower(assigned_to_email));

alter table quote_option_commission enable row level security;

drop policy if exists "Manager or own read" on quote_option_commission;
create policy "Manager or own read"
  on quote_option_commission for select to authenticated
  using (is_manager() or lower(assigned_to_email) = lower(auth.jwt() ->> 'email'));

drop policy if exists "Manager insert" on quote_option_commission;
create policy "Manager insert"
  on quote_option_commission for insert to authenticated
  with check (is_manager());

drop policy if exists "Manager update" on quote_option_commission;
create policy "Manager update"
  on quote_option_commission for update to authenticated
  using (is_manager())
  with check (is_manager());

drop policy if exists "Manager delete" on quote_option_commission;
create policy "Manager delete"
  on quote_option_commission for delete to authenticated
  using (is_manager());

create or replace function guard_quote_option_commission_cost()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.jwt() ->> 'email' is not null and not is_manager() then
    if (tg_op = 'INSERT' and new.commission_cost is not null)
       or (tg_op = 'UPDATE' and new.commission_cost is distinct from old.commission_cost) then
      raise exception 'Only a manager can change commission';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_guard_quote_option_commission_cost on quote_options;
create trigger trg_guard_quote_option_commission_cost
  before insert or update on quote_options
  for each row execute function guard_quote_option_commission_cost();
