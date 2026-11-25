-- Vicky only uses her Turbine account now (Greg, 2026-11-25), and Vicky and
-- Tim can claim commission as employees. Run after 084. Safe to run twice.
--
-- Moves what she is currently responsible for (leads and commission) from her
-- old AOL address. History (who logged, edited or uploaded something, and
-- emails already sent) is left as it happened.
do $$
begin
  if to_regclass('public.commission_people') is null then
    raise exception 'Run 084 first';
  end if;
end;
$$;

update prospects set assigned_to_email = 'vicky@turbineenergyuk.co.uk'
where lower(trim(assigned_to_email)) = 'vickyturbinemarketingltd@aol.com';

update quote_option_commission set assigned_to_email = 'vicky@turbineenergyuk.co.uk'
where lower(trim(assigned_to_email)) = 'vickyturbinemarketingltd@aol.com';

-- Employed = a statement for payroll, never an invoice. A type a manager has
-- already chosen is kept.
insert into commission_people (email, prefix, pay_type, type_set_at) values
  ('vicky@turbineenergyuk.co.uk', 'VIC', 'employed', now()),
  ('tim@turbineenergyuk.co.uk',   'TIM', 'employed', now())
on conflict (email) do update set pay_type = excluded.pay_type, type_set_at = excluded.type_set_at
  where commission_people.pay_type is null;

-- Check: should show 0, 0, then four people with their types.
select 'leads still on AOL' as what, count(*)::text as value from prospects where lower(assigned_to_email) like '%@aol.com'
union all
select 'commission still on AOL', count(*)::text from quote_option_commission where lower(assigned_to_email) like '%@aol.com'
union all
select email, coalesce(pay_type, 'not set') from commission_people;
