-- 089: "Paid, job closed" logged by mistake can be undone (Greg, 2026-11-27).
--
-- Until now, once "Paid, job closed" had been logged the job counted as paid
-- for good, even if "Installed" (or another earlier won/install stage) was
-- logged after it to put it right. Now any of these logged after the latest
-- "Paid, job closed" makes the job not paid again:
--   Quote accepted, Contract signed, DNO submitted, DNO approved,
--   Scheduled for install, Installed.
-- Other later logs (call back, info sent, ...) still change nothing.
-- Same rule as isCommissionEarned in shared/commission-config.js (Manager
-- Home pipeline). A claim already submitted for such a job shows the existing
-- "Paid, job closed is no longer logged" warning.
-- Only commission_job_state changes; everything else in 084 is untouched.

create or replace function commission_job_state(p_prospect uuid)
returns table (quote_option_id uuid, person text, amount numeric, paid_at timestamptz, paid_by text, reason text)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
declare
  v_option uuid; v_person text; v_amount numeric; v_paid timestamptz; v_by text;
  v_lost timestamptz; v_deleted boolean; v_undone timestamptz;
begin
  select o.id, lower(trim(q.assigned_to_email)), o.commission_cost
    into v_option, v_person, v_amount
    from quote_options o left join quote_option_commission q on q.quote_option_id = o.id
   where o.prospect_id = p_prospect and o.is_selected and o.deleted_at is null;

  select c.contacted_at, coalesce(nullif(c.employee_email, ''), c.employee)
    into v_paid, v_by
    from prospect_contacts c
   where c.prospect_id = p_prospect and c.outcome = 'Job Closed' and c.deleted_at is null and c.contacted_at <= now()
   order by c.contacted_at desc limit 1;
  select max(c.contacted_at) into v_lost from prospect_contacts c
   where c.prospect_id = p_prospect and commission_is_lost(c.outcome) and c.deleted_at is null;
  -- 089: an earlier won/install stage logged after "Paid, job closed" undoes it
  -- (paid logged by mistake, then put back to e.g. "Installed").
  select max(c.contacted_at) into v_undone from prospect_contacts c
   where c.prospect_id = p_prospect and c.deleted_at is null
     and c.outcome in ('Converted', 'Contract Signed', 'DNO Submitted', 'DNO Approved', 'Scheduled for Install', 'Completed');
  if v_paid is not null and v_undone >= v_paid then
    v_paid := null; v_by := null;
  end if;
  select p.deleted_at is not null into v_deleted from prospects p where p.id = p_prospect;

  return query select v_option, v_person, v_amount, v_paid, v_by,
    case when v_deleted is distinct from false then 'deleted'
         when v_paid is null then 'not_paid'
         when v_lost >= v_paid then 'cancelled'
         when v_option is null then 'no_option'
         when v_person is null then 'no_person'
         when v_amount is null or not (v_amount >= 0.01 and v_amount < 1000000) then 'no_amount'
    end;
end;
$$;

-- Check: jobs where "Paid, job closed" was later undone (now count as not paid)
select p.customer_name, s.reason
from prospects p cross join lateral commission_job_state(p.id) s
where exists (select 1 from prospect_contacts c where c.prospect_id = p.id and c.outcome = 'Job Closed' and c.deleted_at is null)
  and s.reason = 'not_paid';
