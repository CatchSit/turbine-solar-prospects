# Manager Home — design

**Date:** 2026-09-30 · **Status:** step 1 built, not yet deployed

## Goal

One desktop page (`home.html`) where managers (Greg, Tim) see the whole business
across every Turbine system: the sales pipeline, marketing/ad performance, API
quotas, and system health — behind Microsoft sign-in, with every visit recorded in
an audit log.

The underlying pain it serves is **re-entering the same enquiry in several
places** (website email → CRM → proposals app). The dashboard alone doesn't fix
that; the intake pipes in steps 2–3 do. The dashboard is where the joined-up
data becomes visible.

## Decisions (agreed with Greg, 2026-09-30)

| Question | Decision |
|---|---|
| Audience | Managers only: `greg@` and `tim@turbineenergyuk.co.uk` |
| Device | Desktop only for now |
| Location | New `home.html` in this repo — same Supabase project, same Azure AD login, same no-build static-HTML style. Not a new app, not the WordPress site. |
| Audit depth | General: sign-ins and which section was viewed. No per-record tracking. |
| Ad platforms | Meta, Google Ads, LinkedIn |
| Google Analytics | Approved for the public website |

## Sections

1. **Pipeline** — every lead that has entered the sales process (manual leads, plus any
   map prospect with a logged contact), staged by its latest contact outcome:
   New → Contacted → Meeting/Survey → Quote sent → Won → Scheduled → Completed (+ Lost).
   Value = selected quote option's `quote_price`, else the highest option.
   KPI tiles, stage funnel, conversion by source, and a "needs attention" list
   (no contact yet, overdue follow-up, quote sent 7+ days ago with nothing since).
2. **Marketing & analytics** — Google Analytics (website), Meta Ads, Google Ads,
   LinkedIn Ads, Brevo email. Step 1 shows connection status only; data arrives in step 4.
3. **API usage & quotas** — Solar API against its 9,500 cap with backlog/months-to-finish,
   Maps JS loads, SMS, Apollo/Hunter enrichment, Brevo sending credits.
4. **System health** — website up, rollback detection (REST page 767 via root dispatch,
   "Vax Ex" present, old "SAVE UP TO 80" hero absent), Brevo key/account/domain auth,
   Edge Function deployment check, which secrets are configured, data-pipeline coverage
   (geocoding, Companies House classification, solar enrichment).
5. **Audit log** — manager-only view of `manager_audit_log`.

## Architecture

- **`managers` table + `is_manager()` SQL function** (migration 043) — the database
  source of truth for manager rights. Replaces the three places Greg's email was
  hardcoded (`grant_areas` "Manager update", `quote_options` "Manager delete",
  `guard_quote_option_soft_delete()`), so Tim gets identical rights everywhere.
  Client-side, `shared/manager-config.js` replaces the three inline `ADMIN_EMAILS`
  copies for UX gating on the older pages; `home.html` itself asks the database
  (`rpc('is_manager')`). Adding a manager = one row in `managers` + one line in
  `shared/manager-config.js`.
- **`manager_audit_log`** — append-only (insert + manager select policies only, no
  update/delete). A row's `user_email` must equal the caller's JWT email.
- **`manager_system_stats()`** — security-definer RPC returning aggregate counts
  (solar backlog, classification/geocode coverage, API usage, enrichment usage) as one
  JSON object, so the page never runs the ~90s `fetchAllProspects()` load.
- **`manager-health` Edge Function** — server-side checks the browser can't do
  cross-origin: fetches the WordPress site, calls Brevo, probes each Edge Function's
  deployment, reports which secrets exist (booleans only, never values). Manager-only.
- Pipeline data comes from ordinary client queries under existing RLS (small tables:
  manual leads, `prospect_contacts`, `quote_options`).

## Build order

1. **Step 1 (this change):** page shell, sign-in, manager gate, audit log, pipeline from
   existing data, API usage, system health, marketing connection status.
2. **Step 2:** website enquiries → CRM leads (plugin posts to a new `ingest-enquiry`
   Edge Function, `source: 'website'`), website source in the pipeline.
3. **Step 3:** proposals app "Load from CRM lead" + "Publish to CRM".
4. **Step 4:** GA4 (tag on the site + Data API), Meta/Google Ads/LinkedIn reporting,
   install-hub status pulled back.

## Step 4 lead times (external approvals, start early)

- **GA4 Data API** — service account added to the GA4 property. Same-day.
- **Meta Marketing API** — Meta app + system-user token with `ads_read`. Days.
- **Google Ads API** — developer token application (basic access review) + OAuth. Days to ~2 weeks.
- **LinkedIn Marketing API** — Advertising API access request, manual review. Can take weeks.

## Open items

- GA4 on a UK site needs cookie consent before analytics cookies are set (PECR/UK GDPR).
  The old `cookie-law-info` plugin is disabled. Plan: Consent Mode v2, default denied,
  plus a lightweight consent banner — confirm with Greg before going live.
