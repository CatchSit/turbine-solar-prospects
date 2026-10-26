-- 056: reps are read-only except on the leads assigned to them (Greg, 2026-10-26).
--
-- Everyone signed in with a @turbineenergyuk.co.uk account still READS every
-- lead (no select policy changes). Writing is now limited to:
--   * managers (is_manager(), the `managers` table): any lead, as before;
--   * everyone else: only leads whose assigned_to_email is their own address.
-- Unassigned leads (website / Pockla / Sofar arrive unassigned) are therefore
-- manager-only until a manager assigns them. A rep may add a new lead, but it
-- must be assigned to themselves (crm.html fills that in). Only managers can
-- change who a lead is assigned to (a rep's update must leave it assigned to
-- them). Cost and margin stay visible to all (Greg's decision).
--
-- Service-role writers (ingest-enquiry, supplier-lead, mail-sync, etc.) bypass
-- RLS and are unaffected. Delete/restore rules (manager-only, 048/037/043) are
-- unchanged. lead_emails resolve already uses can_see_lead_emails (052), which
-- is the same manager-or-assigned test.

create or replace function can_edit_lead(p_prospect_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select lower(coalesce(auth.jwt() ->> 'email', '')) like '%@turbineenergyuk.co.uk'
     and (is_manager() or exists (
           select 1 from prospects p
           where p.id = p_prospect_id
             and lower(p.assigned_to_email) = lower(auth.jwt() ->> 'email')));
$$;
grant execute on function can_edit_lead(uuid) to authenticated;

-- Storage paths are "<prospect_id>/<timestamp>-<file>" (crm.html and the
-- proposals app). Anything else is refused rather than erroring.
create or replace function can_edit_lead_path(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return can_edit_lead(split_part(p_name, '/', 1)::uuid);
exception when invalid_text_representation then
  return false;
end;
$$;
grant execute on function can_edit_lead_path(text) to authenticated;

-- ── prospects ──────────────────────────────────────────────────────────────
drop policy if exists "Turbine Energy insert manual lead" on prospects;
create policy "Turbine Energy insert manual lead"
  on prospects for insert to authenticated
  with check (
    source = 'manual'
    and lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk'
    and created_by_email = (auth.jwt() ->> 'email')
    and (is_manager() or lower(assigned_to_email) = lower(auth.jwt() ->> 'email'))
  );

drop policy if exists "Turbine Energy update manual lead" on prospects;
create policy "Turbine Energy update manual lead"
  on prospects for update to authenticated
  using (
    source = 'manual'
    and lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk'
    and (is_manager() or lower(assigned_to_email) = lower(auth.jwt() ->> 'email'))
  )
  with check (
    source = 'manual'
    and lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk'
    and (is_manager() or lower(assigned_to_email) = lower(auth.jwt() ->> 'email'))
  );

-- ── contact log ────────────────────────────────────────────────────────────
drop policy if exists "Authenticated insert" on prospect_contacts;
create policy "Authenticated insert"
  on prospect_contacts for insert to authenticated
  with check (
    lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk'
    and employee_email = (auth.jwt() ->> 'email')
    and can_edit_lead(prospect_id)
  );

-- ── documents ──────────────────────────────────────────────────────────────
drop policy if exists "Turbine Energy insert" on lead_documents;
create policy "Turbine Energy insert"
  on lead_documents for insert to authenticated
  with check (
    lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk'
    and uploaded_by_email = (auth.jwt() ->> 'email')
    and can_edit_lead(prospect_id)
  );

drop policy if exists "Turbine Energy update" on lead_documents;
create policy "Turbine Energy update"
  on lead_documents for update to authenticated
  using (can_edit_lead(prospect_id))
  with check (can_edit_lead(prospect_id));

drop policy if exists "Turbine Energy delete" on lead_documents;
create policy "Turbine Energy delete"
  on lead_documents for delete to authenticated
  using (can_edit_lead(prospect_id));

drop policy if exists "Turbine Energy upload to proposals" on storage.objects;
create policy "Turbine Energy upload to proposals"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'proposals'
    and lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk'
    and can_edit_lead_path(name)
  );

-- ── quotes ─────────────────────────────────────────────────────────────────
drop policy if exists "Turbine Energy insert" on lead_quotes;
create policy "Turbine Energy insert"
  on lead_quotes for insert to authenticated
  with check (can_edit_lead(prospect_id));

drop policy if exists "Turbine Energy update" on lead_quotes;
create policy "Turbine Energy update"
  on lead_quotes for update to authenticated
  using (can_edit_lead(prospect_id))
  with check (can_edit_lead(prospect_id));

drop policy if exists "Turbine Energy insert" on quote_options;
create policy "Turbine Energy insert"
  on quote_options for insert to authenticated
  with check (can_edit_lead(prospect_id));

drop policy if exists "Turbine Energy update" on quote_options;
create policy "Turbine Energy update"
  on quote_options for update to authenticated
  using (can_edit_lead(prospect_id))
  with check (can_edit_lead(prospect_id));

create or replace function select_quote_option(p_option_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prospect_id uuid;
begin
  if lower(auth.jwt() ->> 'email') not like '%@turbineenergyuk.co.uk' then
    raise exception 'Forbidden';
  end if;

  select prospect_id into v_prospect_id from quote_options where id = p_option_id;
  if v_prospect_id is null then
    raise exception 'Quote option not found';
  end if;

  if not can_edit_lead(v_prospect_id) then
    raise exception 'Only a manager or the assigned rep can change this lead';
  end if;

  update quote_options set is_selected = false
    where prospect_id = v_prospect_id and is_selected and id != p_option_id;
  update quote_options set is_selected = true
    where id = p_option_id;
end;
$$;

-- ── install checklist ──────────────────────────────────────────────────────
drop policy if exists "Turbine Energy insert" on install_checklists;
create policy "Turbine Energy insert"
  on install_checklists for insert to authenticated
  with check (can_edit_lead(prospect_id));

drop policy if exists "Turbine Energy update" on install_checklists;
create policy "Turbine Energy update"
  on install_checklists for update to authenticated
  using (can_edit_lead(prospect_id))
  with check (can_edit_lead(prospect_id));

-- ── customer email log (Mark as sent / Skip) ───────────────────────────────
drop policy if exists "Turbine Energy insert email log" on email_log;
create policy "Turbine Energy insert email log"
  on email_log for insert to authenticated
  with check (
    lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk'
    and created_by_email = lower(auth.jwt() ->> 'email')
    and can_edit_lead(prospect_id)
  );
