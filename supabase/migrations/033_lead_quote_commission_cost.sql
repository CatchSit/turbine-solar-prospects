-- Commission — a seventh internal cost line alongside
-- kit/scaffold/electrical/roofer/mcs/fuel (019/022/026/032). Nullable,
-- same as every other cost field — not every quote will have one.
alter table lead_quotes add column if not exists commission_cost numeric;
alter table lead_quote_audit add column if not exists commission_cost numeric;

-- log_lead_quote_change() (023, redefined by 026 and 032) inserts an
-- explicit column list, so it needs re-defining again to also carry
-- commission_cost through into the audit row.
create or replace function log_lead_quote_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into lead_quote_audit (
    prospect_id, kit_price, scaffold_price, electrical_cost, roofer_cost,
    mcs_cost, fuel_cost, commission_cost, quote_price, edited_by_email
  ) values (
    new.prospect_id, new.kit_price, new.scaffold_price, new.electrical_cost,
    new.roofer_cost, new.mcs_cost, new.fuel_cost, new.commission_cost, new.quote_price,
    lower(auth.jwt() ->> 'email')
  );
  return new;
end;
$$;
