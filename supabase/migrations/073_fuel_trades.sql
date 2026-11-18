-- 073: fuel lines are trades, not named installers (Greg, 2026-11-18).
-- At quote stage nobody knows exactly who will go, so the list in
-- Settings > Fuel becomes Electrician / Roofer / Plumber. The key name
-- (crm_fuel_installers) and the stored shape are unchanged; managers can
-- rename, add or retire trades in Settings afterwards.
update app_settings
set value = '[{"id":"electrician","name":"Electrician","active":true},{"id":"roofer","name":"Roofer","active":true},{"id":"plumber","name":"Plumber","active":true}]',
    updated_at = now()
where key = 'crm_fuel_installers';
