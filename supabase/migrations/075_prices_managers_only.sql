-- 075: supplier cost prices are managers only (Greg, 2026-11-19).
--
-- 064 let every Turbine account read price_lines (and the price_suppliers
-- view, which is security_invoker so it follows the same rule). Greg: only
-- managers can see cost prices. price_documents and price_mail_mailboxes
-- were already manager-only (065). The Edge Functions use the service role
-- and are not affected. crm.html hides the Prices link from non-managers and
-- prices.html shows "Managers only" to anyone else who opens it.

drop policy if exists "Turbine Energy read" on price_lines;
drop policy if exists "Manager read" on price_lines;
create policy "Manager read"
  on price_lines for select to authenticated
  using (is_manager());
