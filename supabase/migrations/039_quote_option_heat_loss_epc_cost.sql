-- Heat loss and EPC — an eighth internal cost line on quote_options
-- (034), alongside kit/scaffold/electrical/roofer/mcs/fuel/commission
-- (019/022/026/032/033). Nullable, same as every other cost field — not
-- every quote will have one.
alter table quote_options add column if not exists heat_loss_epc_cost numeric;
alter table lead_quote_audit add column if not exists heat_loss_epc_cost numeric;

-- log_quote_option_change() (034) inserts an explicit column list, so it
-- needs re-defining to also carry heat_loss_epc_cost through into the
-- audit row.
create or replace function log_quote_option_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into lead_quote_audit (
    prospect_id, quote_option_id, label, kit_price, scaffold_price, electrical_cost, roofer_cost,
    mcs_cost, fuel_cost, commission_cost, heat_loss_epc_cost, quote_price, edited_by_email
  ) values (
    new.prospect_id, new.id, new.label, new.kit_price, new.scaffold_price, new.electrical_cost, new.roofer_cost,
    new.mcs_cost, new.fuel_cost, new.commission_cost, new.heat_loss_epc_cost, new.quote_price, lower(auth.jwt() ->> 'email')
  );
  return new;
end;
$$;
