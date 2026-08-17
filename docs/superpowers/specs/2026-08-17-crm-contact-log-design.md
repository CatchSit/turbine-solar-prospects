# CRM Contact Log + Manager Dashboard — Design

## Context

`turbine-solar-prospects` ships the prospect map only — HANDOVER.md Section 8 has long flagged a `prospect_contacts` table + Log Contact modal + dashboard as deferred future work, mirroring mcs-map's (Amco Renewables' sibling installer-map project) proven CRM layer. `001_prospects_schema.sql` already carries a commented-out draft of this table, sketched by an earlier session specifically so it could be added later without a schema rewrite (`prospects.id` is a real uuid PK, unlike mcs-map's soft `installer_id text`).

This design activates that deferred work: reps log what happened when they contact a prospect (outcome, notes, follow-up date), and the aggregated view of that activity — the actual "what is my team doing" picture — is visible only to management, not to reps themselves. That read restriction is the one real deviation from mcs-map's pattern (mcs-map lets any authenticated rep read the whole contact log); everything else mirrors mcs-map's proven, already-working code as closely as possible.

The Companies House "run a check" trigger-mechanism change (auto-fire → explicit button) and its own lighter activity log are explicitly **out of scope here** — noted as a fast-follow once this lands (see "Deferred" below).

## Goals

- Any authenticated rep can log a contact attempt against any prospect from the map itself — outcome, optional notes, optional next action, and (for date-bearing outcomes) a required date.
- Only the manager (`greg@turbineenergyuk.co.uk`, via the existing `ADMIN_EMAILS`/`isAdmin()` stub already sitting unwired in `index.html`) can read the log or view the dashboard — enforced by RLS, not just hidden in the UI, matching this project's established "access control must be real" ethic (see the Azure AD auth design).
- A dashboard (`dashboard.html`, mirroring mcs-map's) gives the manager: daily activity over time, a per-employee breakdown, and a filterable/sortable/exportable contact log.
- Outcome options fit Turbine's actual sales process for cold-calling a business about solar (not mcs-map's installer-pipeline stages, which don't apply here).

## Non-goals

- No rep-facing read access to the contact log (a deliberate scope reduction from mcs-map — reps only ever insert, never browse). This means no duplicate-contact collision warning ("Sarah already called this prospect") in this iteration; that would need rep-facing read access, which is explicitly not wanted right now.
- No change to the Companies House `company-lookup` trigger mechanism or its own activity logging — deferred, see below.
- No edit/soft-delete UI in this iteration (mcs-map has one, gated to record-owner-or-admin) — logging is append-only for now. The schema still carries `updated_at`/`updated_by`/`deleted_at`/`deleted_by` columns (matching mcs-map exactly) so this can be added later without a migration.

## Outcome enum

```
No Answer, Follow Up, Meeting Booked, Survey Booked, Quote Sent, Converted, Not Interested, Already Has Solar
```

No separate "Interested" — `Follow Up` doubles as the interested-and-needs-a-callback signal, per explicit direction during brainstorming. `Follow Up`, `Meeting Booked`, and `Survey Booked` all require a date; all three share the same `follow_up_date` column (matching mcs-map's field name) rather than three separate date columns — semantically it's just "the next important date tied to this contact," whatever kind of date that is. Not DB-enforced (mcs-map's own outcome enum isn't either — "no DB-level CHECK constraint exists — enforced by the UI only," per that migration's own comment) — enforced client-side in the modal, mirroring the proven pattern exactly.

## Database changes

New migration `supabase/migrations/007_prospect_contacts.sql`:

```sql
create table if not exists prospect_contacts (
  id             uuid primary key default gen_random_uuid(),
  prospect_id    uuid not null references prospects(id),
  employee       text not null,
  employee_email text,
  outcome        text not null,
  -- outcome must be one of: No Answer, Follow Up, Meeting Booked, Survey Booked,
  -- Quote Sent, Converted, Not Interested, Already Has Solar
  -- (no DB-level CHECK constraint — enforced by the UI only, matching mcs-map's contacts table)
  notes          text,
  next_action    text,
  follow_up_date date,
  contacted_at   timestamptz not null default now(),
  updated_at     timestamptz,
  updated_by     text,
  deleted_at     timestamptz,
  deleted_by     text
);

create index if not exists prospect_contacts_prospect_id_idx on prospect_contacts (prospect_id);
create index if not exists prospect_contacts_contacted_at_idx on prospect_contacts (contacted_at);

alter table prospect_contacts enable row level security;

-- Any authenticated rep can log a new contact.
create policy "Authenticated insert"
  on prospect_contacts for insert
  to authenticated
  with check (true);

-- Only the manager can read. This is the one deliberate deviation from
-- mcs-map's contacts table (which allows any authenticated read) — reps
-- here only ever write, never browse the log or see each other's activity.
create policy "Admin read"
  on prospect_contacts for select
  to authenticated
  using (auth.jwt() ->> 'email' = 'greg@turbineenergyuk.co.uk');
```

No update/delete policies in this iteration (matches "Non-goals" — append-only for now; mcs-map's equivalent update/delete policies can be added later exactly as drafted there, once edit/soft-delete UI is actually built).

## Frontend changes

### Log Contact modal (`index.html`)

Ported from mcs-map's `#modal-overlay`/`#modal` almost verbatim (same CSS classes, same keyboard shortcuts — Esc to cancel, ⌘/Ctrl+Enter to save), with these changes:
- `modal-installer-id` / `modal-installer-name` → `modal-prospect-id` / `modal-prospect-name` (renamed for this domain, values populated from the clicked prospect's `id` and address, same as the existing popup does).
- Outcome chips + hidden `<select id="modal-outcome">` populated with this project's 8-value enum instead of mcs-map's 6, each still colour-coded (new CSS custom properties needed per outcome, following the existing `--status-*-c` naming convention already used in mcs-map — e.g. `--status-followup-c`, `--status-meeting-c`, `--status-survey-c`, etc., defined against this project's existing Turbine brand palette rather than mcs-map's).
- The `change` handler on `#modal-outcome` shows `#followup-date-group` (with the same min-today / default-tomorrow prefill behavior) when the value is `Follow Up`, `Meeting Booked`, **or** `Survey Booked` — mcs-map's equivalent only checks `=== 'Follow Up'`.
- Submit validation adds the same date-required check for all three outcomes: `['Follow Up', 'Meeting Booked', 'Survey Booked'].includes(outcome) && !followUpDateValue` blocks submission with an alert, mirroring mcs-map's exact pattern (`alert('Please set a follow-up date.'); return;`) just widened to three outcomes.
- Insert targets `prospect_contacts` with `prospect_id` instead of `installer_id`/`installer_name`; `employee` pre-filled via the existing `getUserName(currentUser)` helper already in this file (from the Azure AD auth work); `employee_email` from `currentUser.email`.
- A "Log contact" button is added to the existing prospect popup (`buildPopup()` in `index.html`) that opens this modal pre-filled with that prospect's id/address, same trigger pattern as mcs-map's marker-click-opens-modal flow.

No confirmation/read-back of past contacts is shown in the modal or popup (Non-goals — reps have no read access, so there's nothing to show).

### Dashboard (`dashboard.html`)

New page, structurally mirroring mcs-map's `dashboard.html` (daily activity chart, "by employee" chart, filterable/sortable contact log table, CSV export) but querying `prospect_contacts`/`prospects` instead of `contacts`/`installers`, and with no "pipeline composition" chart equivalent needed (that chart visualizes mcs-map's own installer-status field, which has no equivalent here). Gated two ways, matching this project's defense-in-depth pattern elsewhere (Azure tenant restriction + frontend domain check):
- **Real gate:** RLS itself — a non-admin session's queries against `prospect_contacts` return zero rows regardless of what the page tries to render.
- **UX gate:** the page checks `isAdmin(currentUser)` on load (same helper as `index.html`) and redirects non-admins back to `index.html` immediately, so a rep who finds the URL doesn't see a broken, empty-looking dashboard.

## Testing & verification

No automated test framework in this repo (matches the earlier Companies House plan's Global Constraints) — verification is live, matching this project's established pattern:
- Insert a contact as a regular authenticated test account, confirm it succeeds (insert policy).
- Attempt to `select` from `prospect_contacts` as that same non-admin account (e.g. via the browser console while signed in as a test user, or a scoped curl call using a non-admin session's JWT) — confirm it returns zero rows, not an error, proving RLS actually blocks it rather than just the UI hiding a button.
- Confirm the same `select` succeeds and returns real data when signed in as `greg@turbineenergyuk.co.uk`.
- Log a `Follow Up`, a `Meeting Booked`, and a `Survey Booked` contact live and confirm the date field is genuinely required for all three (submission blocked without one) and genuinely optional for the other five outcomes.
- Confirm `dashboard.html` redirects a non-admin session back to `index.html`, and renders real charts/table data for the admin session.

## Deferred

- The Companies House `company-lookup` trigger mechanism (auto-fire on popup open → an explicit "Run check" button) and its own lighter activity log (who ran a check, on which prospect, when) — noted as a fast-follow once this CRM layer lands, since the same `prospect_contacts`-adjacent infrastructure (manager-only RLS pattern, dashboard page) is now in place to extend.
- Edit/soft-delete UI for logged contacts (schema already supports it, per mcs-map's proven columns).
- Rep-facing read access / duplicate-contact warnings — would need a real decision to widen the RLS read policy beyond the manager, not something to default into silently later.
