# Decision-Maker Contact Enablement — Design

## Context

The map currently shows reps *which buildings* plausibly need solar, but nothing about *who runs the business there* or *what to say* if they reached them. EPC data (the only dataset the pipeline ingests) has zero business-identity fields — no company name, no occupier, nothing to contact (verified directly against a real 2024 EPC export's column headers). Closing that gap is what actually lets a rep get in front of a decision-maker, which is the whole point of the tool.

This design covers the part of that gap buildable today, for free, with no new billing: a free Companies House lookup for "who might run this business," and a client-side "what to say" summary built from data already in hand. A more capable AI research agent (for cases Companies House can't resolve, e.g. sole traders or a stale registered address) is designed conceptually here but **deferred** — it needs an Anthropic Console API key with billing, which isn't available until the project owner has billing access at Turbine Energy (see "Deferred: AI research agent" below).

## Goals

- For any prospect a rep opens, surface a plausible company name + current director names registered at that postcode, using Companies House's free API — with zero risk of the map appearing to guarantee accuracy (registered office ≠ trading address is a real, common mismatch).
- Give the rep a ready-made, honest "why this building" summary built only from real data already on the row (EPC rating/efficiency, floor area, and — once solar enrichment has run — actual panel count/kWh generation potential). No invented £ savings figures.
- Never block or break the existing prospect popup if Companies House is down, rate-limited, or simply has no match — always degrade to a manual-search fallback.
- Keep this on-demand per-prospect, not a batch job over all ~21,800 rows — mirrors the cost-conscious, budget-capped design already used for `solar-enrichment` (HANDOVER.md Section 1).

## Non-goals

- No AI-driven research agent in this iteration — deferred, see below.
- No outreach/CRM tracking (logging calls, follow-ups, pipeline status) — that's the separate, already-deferred `prospect_contacts` work in HANDOVER.md Section 8. This design doesn't touch it.
- No LinkedIn scraping, ever — against LinkedIn's ToS and a real legal risk. The design only touches Companies House and (in the deferred AI piece) general public web search/company websites.
- No invented financial estimates (£ savings) — flagged explicitly during brainstorming and decided against, to stay consistent with the site's existing "EPC is a proxy, not a measurement" honesty (HANDOVER.md Section 2 and footer copy).

## Architecture

New Supabase Edge Function `company-lookup`, matching the existing `solar-enrichment` pattern (external API called server-side, secret key never reaches the browser):

1. Frontend calls it automatically when a rep opens a prospect's detail popup, passing `{ prospect_id, postcode }`.
2. The function first checks the new `company_lookups` cache table for a non-stale result (fetched within the last 90 days) for that `prospect_id`. If found, return immediately — no external call.
3. Otherwise, call Companies House's free `GET /search/companies?q=<postcode>` (Basic Auth: API key as username, blank password).
4. Keep only results whose `registered_office_address.postal_code` matches the prospect's postcode exactly (case-insensitive).
5. For up to 5 matches with `company_status = 'active'`, call `GET /company/{company_number}/officers` and keep officers with no `resigned_on` date (name + role only — Companies House does not expose phone/email).
6. Upsert the combined result into `company_lookups` and return it to the frontend.

The "talking points" half needs no backend at all — pure frontend logic.

## Database changes

New migration `supabase/migrations/006_company_lookups.sql`:

```sql
create table if not exists company_lookups (
  prospect_id uuid primary key references prospects(id) on delete cascade,
  fetched_at timestamptz not null default now(),
  source text not null default 'companies_house', -- 'companies_house' | 'ai_agent' (future)
  companies jsonb not null default '[]'::jsonb,
  -- companies: [{ company_name, company_number, status, officers: [{ name, role }] }]
  no_match boolean not null default false
);

alter table company_lookups enable row level security;
-- No policies: only the service-role key (used by company-lookup) reads/writes this table,
-- same pattern as api_usage (migration 005).
```

`no_match` distinguishes "we checked and found nothing" from "never checked yet," so the cache correctly avoids re-querying Companies House for buildings with genuinely no registered company at that postcode.

New secret: `COMPANIES_HOUSE_API_KEY` (free — register at `developer.company-information.service.gov.uk`, no billing/payment method required, unlike the Google keys).

## Frontend changes (`index.html`)

- On opening a prospect's popup, fire the `company-lookup` call (fire-and-forget with a loading state in that section only — never blocks the rest of the popup from rendering).
- New **"Company match"** section in the popup:
  - Match(es) found: company name, a status badge (active vs. dissolved — dissolved shown visually de-emphasized with a "likely not trading" note, so a rep can skip a bad lead instantly), and current director names.
  - No match, or the lookup itself failed/errored: fall back to one-click manual search links (Google, Companies House, LinkedIn — all pre-filled with the prospect's address/postcode) so the rep always has *something* actionable, never a dead end.
- New **"Talking points"** section, generated client-side from data already on the row via a new `shared/talking-points.js` (same pattern as `shared/solar-status-config.js`):
  - EPC rating/efficiency score framed in plain language (e.g. "D-rated, efficiency score 62 — below-average performing buildings this size often have real headroom for savings").
  - Floor area + building-type bucket context.
  - Once `solar_status` has real data: actual `solar_max_panels` / `solar_yearly_energy_kwh` from the Solar API — real numbers, no derived £ estimate.
  - A caveat line matching the site's existing tone: results are a starting point for a conversation, not a guarantee.

## Error handling

- Companies House down, rate-limited, or erroring → "Company match" section shows the manual-search-links fallback, not an error state that breaks the popup.
- `COMPANIES_HOUSE_API_KEY` not yet configured (e.g. mid-rollout) → function returns a clear error; frontend treats it identically to "no match."
- Prospect has no postcode or a malformed one → skip the lookup entirely, same fallback UI, no wasted API call.

## Testing & verification

- Spot-check ~10–15 real prospects against businesses that can be independently verified (a locally-known company) before trusting the postcode-matching logic broadly — same discipline already used for solar enrichment funnel counts and `BUILDING_TYPE_BUCKETS` (HANDOVER.md Section 7, risks 3–4).
- Confirm the cache actually prevents a second API call when the same prospect is opened twice.
- Confirm dissolved-company de-emphasis renders correctly against a real dissolved company (Companies House has plenty of easily-findable examples).
- Live-test the empty-state fallback against a prospect address with no registered company.

## Deferred: AI research agent

For prospects where Companies House comes up empty (sole traders, stale registered addresses) or a rep wants to go further, an LLM-driven research agent was designed conceptually during brainstorming:

- A `company-lookup` extension (or a second function) calls Claude's Messages API with its built-in web search tool, given the company name + address, prompted to find a plausible decision-maker's name/role and any *publicly listed* contact detail — restricted to the company's own website, Companies House, and general web search results. **Never LinkedIn profile scraping** (ToS/legal risk).
- Every claim must carry a source URL, and the frontend must clearly label results as "AI-assisted — verify before use," consistent with how the rest of the site already caveats EPC/solar data rather than presenting inference as fact.
- Cost-controlled and on-demand only (a rep-triggered "Research further" action, not automatic), mirroring the `api_usage` budget-cap pattern from `solar-enrichment` (migration 005).

**Blocked on:** an Anthropic Console API key with billing enabled — not available until the project owner has billing access at Turbine Energy. Nothing above depends on this; it's a clean follow-up once that access exists.
