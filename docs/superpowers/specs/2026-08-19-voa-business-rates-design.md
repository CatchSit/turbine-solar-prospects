# VOA Business Rates Enrichment — Design

## Context

`prospects` currently carries no independent, government-sourced signal for a building's scale of commercial activity beyond the EPC floor-area proxy. The Valuation Office Agency (VOA) publishes a free, **public, unauthenticated** bulk dataset — the compiled non-domestic rating list — giving every England & Wales business property's rateable value (an assessed open-market rental value, used to calculate business rates bills). Verified directly against the real, current (2026) file: ~2 million records, asterisk-delimited CSV, positional fields (no header row), matching VOA's own published 82-page field specification exactly (spot-checked real rows field-by-field against the spec — confirmed correct).

This is the third of three free enrichment sub-projects raised together (Companies House fields — shipped; EPC recommendations — shipped; this one).

## Goals

- Surface rateable value as an additional, independent proxy for a building's scale of activity, alongside EPC floor area.
- Fully automate the ingest — unlike the EPC/Companies-House sources, VOA's data needs no login, no manual per-year download, and no API key. The pipeline should download, extract, and parse it itself.
- Show each hereditament (rated unit) at a prospect's postcode separately, not blended into one number — matching how Companies House already handles "more than one real thing can share a postcode."
- Add a rateable-value range filter alongside the existing floor-area filter.
- Be honest that rateable value is a valuation snapshot from VOA's own antecedent valuation date (normally ~2 years before the list's compile date), not a live or current-market figure — same "proxy, not measurement" caveat already applied to EPC data.

## Non-goals

- No processing of VOA's weekly "change update" delta files — v1 uses the current baseline epoch only, consistent with this project's existing "manually re-run, no cron yet" pattern for every other pipeline stage.
- No summary-valuation data (VOA's separate, more granular per-line-item breakdown of how a rateable value was calculated) — rateable value alone is sufficient for a proxy signal; the summary data is a much larger, more complex format not needed here.
- No UI treatment beyond a popup section + range filter — no scoring/ranking logic that combines rateable value with other signals.

## Architecture

New script `scripts/ingest-business-rates.mjs`, structurally different from the EPC/Companies-House scripts in one deliberate way: it downloads its own source data, since VOA's is genuinely public.

1. **Discover the current file.** `GET https://voaratinglists.blob.core.windows.net/downloads?restype=container&comp=list` (confirmed real, unauthenticated, returns an XML blob listing). Parse it for blobs matching `uk-englandwales-ndr-<LIST_YEAR>-listentries-compiled-epoch-*-baseline-csv.zip`, pick the highest epoch number. `LIST_YEAR` is a constant (`'2026'`, the current live list, compiled 1 April 2026 — the next list compiles 1 April 2029, at which point this constant needs updating; comment this clearly in the script).
2. **Download.** Stream the zip (~93MB currently) to `data/business-rates/` (gitignored, new subdirectory — needs its own `.gitignore` entry, same lesson learned in the EPC recommendations final review about `data/**/*.csv` not `data/*.csv`).
3. **Extract — current entries only, not historic.** Verified directly: the zip contains exactly two files, e.g. `uk-englandwales-ndr-2026-listentries-compiled-epoch-0003-baseline-csv.csv` (~511MB uncompressed, the current entries) and `...-baseline-historic-csv.csv` (~4MB, superseded/removed entries). The script must extract and parse **only** the file whose name does NOT contain `historic` — parsing both would mix stale, superseded rateable values into the data. New dependency: `unzipper` (streaming extraction — Node has no built-in ZIP support, and at ~511MB uncompressed this cannot be buffered in memory, the same memory lesson already learned from the EPC recommendations final review).
4. **Parse.** Asterisk-delimited (`csv-parse` with `delimiter: '*'`, no `columns: true` since there's no header row — fields are positional per VOA's spec). Confirmed-real fields used: field 2 (Billing Authority Code), field 6 (Primary Description Text), field 15 (Postcode), field 18 (Rateable Value). All 28 fields are documented in VOA's own spec; only these four are needed here.
5. **Filter to Yorkshire & Humber** by postcode outcode, reusing the same allowlist already established in `scripts/ingest-epc.mjs` (duplicated locally, matching this project's existing per-script convention rather than factoring out a shared module).
6. **Prefilter to existing prospects.** Applying the lesson from the EPC recommendations final review directly: fetch the full set of real `prospects.postcode` values (paginated) *before* building any match data, and only keep VOA rows whose postcode is in that set. A 2-million-row national file must never generate work for postcodes outside the ~21,800-prospect pilot.
7. **Group and upsert.** Group matched rows by normalized postcode; for each `prospects` row sharing that postcode, upsert a `business_rates_matches` row listing every hereditament at that postcode as `{ description, rateable_value, billing_authority_code }`.

## Database changes

New migration `supabase/migrations/010_business_rates.sql`:

```sql
create table if not exists business_rates_matches (
  prospect_id uuid primary key references prospects(id) on delete cascade,
  hereditaments jsonb not null default '[]'::jsonb,
  -- hereditaments: [{ description, rateable_value, billing_authority_code }]
  no_match boolean not null default false,
  fetched_at timestamptz not null default now()
);

alter table business_rates_matches enable row level security;
-- No policies — service-role only, same pattern as company_lookups/api_usage.
```

`no_match = true` means "this postcode was checked against the VOA list and nothing matched." A prospect entirely absent from this table means the ingest simply hasn't run yet — the same three-state convention (absent / no_match / matched) already established for `company_lookups`.

## Frontend changes (`index.html`)

Deliberately **not** the Companies-House on-demand-fetch-per-popup pattern — this is pre-ingested batch data, not a rate-limited live API, so it can ride along with the existing bulk prospect fetch:

- `fetchAllProspects()`'s query embeds the related table directly: `business_rates_matches(hereditaments, no_match)` (a native Supabase/PostgREST foreign-table select, since `business_rates_matches.prospect_id` is a real FK to `prospects.id`) — no second network round-trip per popup open.
- New popup section, **"Business rates"**, styled like the existing Companies-House card list: each hereditament shown separately as `<description> — £<rateable_value formatted with commas>`. No match → section simply absent, no fallback links (unlike Companies House, there's no equivalent quick manual lookup worth surfacing here).
- New sidebar range filter, **"Rateable value (£)"**, mirroring the existing floor-area min/max exactly in UI and behavior. A prospect passes the filter if its **highest-value hereditament** at that postcode falls in range (not the sum, and not "any hereditament in range") — consistent with showing them separately, and avoiding one large tenant plus several small ones averaging into something misleading. (Decided during implementation, Task 2 Step 6 — see the plan — in preference to this design's original "any hereditament in range" wording: max-hereditament semantics are simpler to reason about and to explain in the UI, and behave the same as "any" for the common single-hereditament-postcode case.)
- New footer caveat sentence, matching the existing block's tone: rateable value is a VOA valuation as of its antecedent valuation date (normally ~2 years before the current list's 1 April 2026 compile date), not a live or current-market figure — same "proxy, not measurement" honesty already applied to EPC data.

## Testing & verification

- Confirm the script correctly rejects/skips the `-historic-` file — this was a real gap caught before implementation (not initially in the first draft of this design) and deserves an explicit test, e.g. asserting the script only ever opens the non-historic filename.
- Verify field parsing against real rows: spot-check 5-10 real Yorkshire & Humber matches' `rateable_value`/`description`/`postcode` against VOA's own live "Find a business rates valuation" public lookup for the same address, to confirm the positional field mapping holds at real scale (already spot-checked once manually during design, but worth re-confirming after the real ingest runs against the full file).
- Confirm the prefilter-to-existing-prospects step actually bounds the update volume to roughly the prospect count, not the national row count (same verification discipline as the EPC recommendations fix).
- Confirm a prospect with multiple hereditaments renders each one separately in the popup, and that the range filter's max-hereditament semantics (see Frontend changes above) work correctly against a multi-hereditament prospect.
