-- Add the customer-facing quote price to lead_quotes (019), separate from
-- the four internal cost fields (kit/scaffold/electrical/roofer). The four
-- costs are what Turbine pays out; quote_price is what the customer is
-- charged — margin = quote_price - sum(costs), computed client-side in
-- crm.html same as the cost total, not stored.
alter table lead_quotes add column if not exists quote_price numeric;
