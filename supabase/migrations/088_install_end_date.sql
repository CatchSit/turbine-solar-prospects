-- 088: installs over more than one day (Greg, 2026-11-27).
--
-- "Scheduled for Install" keeps its first day in follow_up_date; the new
-- install_end_date is the last day (blank = a one-day install). The CRM
-- calendar shows the job on every weekday from the first day to the last
-- (Saturdays and Sundays skipped). Fuel in quotes is unchanged.

alter table prospect_contacts add column if not exists install_end_date date;

alter table prospect_contacts drop constraint if exists prospect_contacts_install_end_after_start;
alter table prospect_contacts add constraint prospect_contacts_install_end_after_start
  check (install_end_date is null or (follow_up_date is not null and install_end_date >= follow_up_date));

-- Check: the new column exists (should return one row)
select column_name, data_type from information_schema.columns
where table_name = 'prospect_contacts' and column_name = 'install_end_date';
