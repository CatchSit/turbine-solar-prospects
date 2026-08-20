# Company Sector & Maturity Classification — Design

## Context

Reps currently have to open every popup one at a time to see anything about the business at a prospect — Companies House data (`company-lookup`, `docs/superpowers/specs/2026-08-17-decision-maker-contact-design.md`) is fetched on-demand per click and cached 90 days, but nothing about it is available to filter or sort the whole 21,808-prospect list. Two signals discussed as promising additions:

- **Business sector, derived from SIC codes** — some sectors (food/drink processing, cold storage, data hosting, healthcare, hospitality, laundries) are much more plausibly high-energy-consumption than a typical office or retail unit, complementing the existing EPC-floor-area proxy with an independent, free signal.
- **Company maturity** — an established, actively-filing company is a safer sales target than a dormant or newly-incorporated one; Companies House's company profile (already fetched for the popup) carries both incorporation date and accounts-filing status.

Both need to work like Building Type and EPC Rating already do: instant sidebar filter chips across the whole list, not just a per-click popup enhancement. That requires the underlying data to exist for every prospect up front, not just ones a rep has clicked — which is a materially bigger scope than the on-demand popup work (see the scope discussion in this same conversation, confirmed with the project owner before writing this spec).

## Goals

- A one-time (occasionally re-run) classification pass over all prospects that determines each one's most-relevant matched company's SIC codes, incorporation date, and accounts-filing status, stored so the frontend can filter on it instantly, same as Building Type/EPC Rating.
- Two new sidebar filter chip groups — sector and maturity — built with the exact same chip pattern (counts, colored dot, instant client-side filtering, "Other"/unclassified handling) already used for Building Type and EPC Rating.
- Both signals also shown on the popup: a building-level tag in the header (sourced from the new precomputed data) and, for each individual company already shown in the existing Companies tab, its own sector/maturity badge (sourced from the richer on-demand lookup).
- Reuse the building-relevance ranking already built into `company-lookup` (`docs/superpowers/specs/2026-08-20-popup-relevance-and-tabs-design.md`) so the "representative" company for a building-level tag is the same one already flagged "Likely this building" in the popup, not an arbitrary pick.

## Non-goals

- No monthly API budget/cap table (`api_usage`-style) — Companies House has no billing or monthly quota, only a 5-request/second rate window (600/5 min), so there's nothing to budget against across months the way `solar-enrichment` has to. See Architecture below for why this changes the pipeline shape versus solar.
- No cross-runtime shared module between the Deno edge function (`company-lookup`) and the new classification script — they run in different runtimes (Deno vs Node) and, after the architecture decision below, only one of them needs the address-ranking helpers duplicated at all. A ~20-line verbatim copy (same tolerance already established in this repo for `shared/escape-html.js`, "copied verbatim from mcs-map") is simpler and less fragile than forcing a cross-runtime import.
- No re-derivation of sector/maturity bucket *logic* server-side — like `bucketPropertyType()`, both are plain client-side functions over raw stored data (SIC codes, incorporation date, accounts type), so the bucket definitions can be retuned later without touching the pipeline or re-running anything.
- No changes to `company_lookups`' 90-day on-demand cache semantics or its RLS (still service-role-only) — the new table is a separate, additive concern with its own (necessary) read policy.

## Architecture

### Why a script, not an edge function

`solar-enrichment` and the earlier idea of a "batch edge function" for this are both shaped around a hard *monthly* cap forcing work to spread across weeks — that's why they're structured as small resumable batches invoked repeatedly over time. Companies House has no such cap, only a *rate* limit (600 requests/5 min, i.e. ~2/sec sustained). That means the entire 21,808-prospect classification can run to completion in one long-running process, self-paced with a sleep between calls — the same shape as `scripts/ingest-business-rates.mjs`, not `solar-enrichment`. A batch edge function here would just mean ~220 manual `supabase functions invoke` calls for no benefit; a script that loops internally and paces itself is simpler and matches how every other bulk pipeline step in this repo already works (`npm run ingest`, `npm run geocode`, `npm run ingest-business-rates`).

New script: `scripts/classify-companies.mjs`, run via `npm run classify-companies`. Needs `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and — new for this script, since it runs locally rather than as a Supabase-secret-backed edge function — `COMPANIES_HOUSE_API_KEY` passed as a local environment variable.

For each prospect missing a `company_classifications` row (paginated, same 1000-row PostgREST page pattern as `fetchAllProspects()`, filtered to `postcode is not null` — a prospect with no postcode never gets a row at all, same "absent, not `no_match`" convention already established for `business_rates_matches`, `HANDOVER.md` Section 5):

1. Search Companies House by postcode (same endpoint `company-lookup` already uses).
2. Filter to active companies at that exact postcode (same filter as `company-lookup`).
3. Rank by building-number address match — a verbatim copy of `leadingNumber`/`isAddressMatch`/`rankByAddressMatch` from `supabase/functions/company-lookup/index.ts` (small, stable, pure functions — see Non-goals on why this isn't shared cross-runtime).
4. Take the top-ranked candidate (if any) and fetch its profile (SIC codes, incorporation date, accounts type — same `fetchProfile`-shaped call `company-lookup` already makes, but this is the *only* extra call needed per prospect; no officers/PSC calls, since those aren't used for classification).
5. Upsert one row into `company_classifications`: matched company's data, or `no_match: true` if no active company was found at that postcode at all.
6. Sleep between calls to stay safely under the rate limit (target ~2 requests/sec including margin).

At ~2 calls per prospect (search + profile) × 21,808 prospects ≈ 43,600 calls, paced at ~1.5–2/sec, a full first run takes roughly 6–8 hours — run once in the background, not something anyone waits on. Idempotent and resumable for free: re-running the script just re-queries for prospects still missing a row, so an interrupted run picks up where it left off with no special resume logic.

### `company-lookup` gets one small addition

`fetchProfile()` (`supabase/functions/company-lookup/index.ts`) already calls the endpoint that carries accounts-filing status — it just doesn't parse it today. Add `accounts_type` (from `json.accounts?.last_accounts?.type` — **an unverified field path**, same caution already applied to `classifyDetection()` and the PSC `statement`-filtering logic elsewhere in this file: store it, verify against a real response early, don't trust the guess blindly) to `CompanyMatch` and `fetchProfile()`'s return value. This is what lets the existing Companies tab show a maturity badge per individual company, not just the one building-level tag.

## Database changes

New migration `supabase/migrations/012_company_classifications.sql` — table **and** its real SELECT policy in one migration this time, applying the lesson from `HANDOVER.md` Section 7 risk 13 (the `003`→`004`/`007`→`008`/`010`→`011` pattern) proactively instead of discovering the gap in a follow-up fix:

```sql
create table if not exists company_classifications (
  prospect_id uuid primary key references prospects(id) on delete cascade,
  fetched_at timestamptz not null default now(),
  no_match boolean not null default false,
  company_name text,
  company_number text,
  sic_codes text[],
  incorporated_on date,
  accounts_type text
);

alter table company_classifications enable row level security;

create policy "Authenticated Turbine Energy users can read company classifications"
  on company_classifications for select
  to authenticated
  using (lower(auth.jwt() ->> 'email') like '%@turbineenergyuk.co.uk');
```

Same three-state convention as `company_lookups`/`business_rates_matches`: no row = never checked (or no postcode to check), `no_match: true` = checked, nothing found, a populated row = matched.

## Frontend changes

### New shared config files

- `shared/sic-sector-config.js` — `SIC_SECTOR_BUCKETS` (bucket name → array of SIC code prefixes, matched via `startsWith`, same shape as `BUILDING_TYPE_BUCKETS` but on codes instead of keywords), `SIC_SECTOR_ORDER` (bucket names + `"Other"`), `bucketSicSector(sicCodes)` (returns `null` if no SIC data at all — distinct from `"Other"`, which means "classified, not an energy-relevant sector"), and `SIC_SECTOR_COLORS`.

  | Bucket | SIC divisions/codes |
  |---|---|
  | Food & Drink Production | 10, 11 |
  | Manufacturing (Materials & Chemicals) | 13–17, 19–25 |
  | Cold Storage, Warehousing & Waste | 38, 52 |
  | Data, IT & Telecoms | 61, 63 |
  | Healthcare | 86, 87 |
  | Hospitality & Leisure | 55, 56, 93 |
  | Laundries & Industrial Cleaning | 96010, 8122x |

- `shared/company-maturity-config.js` — `bucketCompanyMaturity({ incorporated_on, accounts_type })`: returns `null` if `incorporated_on` is missing; `"Dormant/Minimal"` if `accounts_type` is `dormant` or `micro-entity`; else `"Established"` if incorporated 5+ years ago (tunable constant), otherwise `"Newer"`. Plus `MATURITY_ORDER` and `MATURITY_COLORS`.

Both files load alongside `shared/building-types.js` in `index.html`'s shared-script block.

### Query

`fetchAllProspects()` gains `company_classifications(company_name, sic_codes, incorporated_on, accounts_type, no_match)` in its `select`, same embedded-join style already used for `business_rates_matches`. `initMap()` precomputes `d._sicSector = bucketSicSector(...)` and `d._maturity = bucketCompanyMaturity(...)` per row, same pattern as `d._bucket`/`d._maxRateable`.

### Sidebar

Two new sections, "Business sector" and "Company maturity", built by `buildSicSectorChips(data)`/`buildMaturityChips(data)` — copies of `buildBuildingTypeChips`/`buildEpcRatingChips` targeting the new order/color constants. `applyFilters()` gains `sectorOk`/`maturityOk` conditions using the same null-passthrough convention already used for EPC rating (`!d.epc_rating || activeRatings.has(...)`) — a prospect with no classification data isn't hidden by an active filter selection, only prospects with a *known, deselected* bucket are. `Reset filters` re-selects both new chip groups to full membership, same as the existing ones.

### Popup

- Header tags row gains two more conditional tags (same `<span class="tag">` pattern as EPC/type/recommendation tags), shown only when `d._sicSector` is a real bucket (not `null`, not `"Other"`) and when `d._maturity` is non-null respectively — an unclassified building shows neither tag, exactly like the EPC recommendation tags today.
- The existing Companies tab (`loadCompanyMatch` in `index.html`) gets the same two badges per individual company card, computed from that company's own `c.sic_codes`/`c.incorporated_on`/`c.accounts_type` (the last of which requires the `company-lookup` change above) — reusing the same `bucketSicSector`/`bucketCompanyMaturity` functions client-side, just fed per-company data instead of the one building-level record.

## Error handling

- `classify-companies.mjs` treats a missing/malformed Companies House response the same way `company-lookup` does elsewhere in this codebase — log and skip that one prospect (leaving it "missing" so a re-run retries it), never abort the whole run over one bad row.
- Rate-limit (`429`) responses: back off and retry with a longer pause, same `RATE_LIMITED` handling already present in `company-lookup`'s `searchCompaniesHouse`, adapted to keep the overall run going rather than failing the whole script.
- Frontend: absent classification data renders no tags and passes through both new filters untouched — never a broken or blocked popup, consistent with every other optional enrichment already on this site (business rates, EPC recommendations, company match).

## Testing & verification

- Verify the `accounts_type` field path (`json.accounts?.last_accounts?.type`) against a handful of real Companies House profile responses early in implementation, before trusting the maturity bucketing broadly — same discipline already applied to `classifyDetection()` (Solar API) and the PSC `statement`-filtering logic in `company-lookup`.
- Spot-check the SIC sector buckets against ~10-15 real matched companies spanning a few different buckets, confirming the groupings make sense in practice — same spot-check discipline already used for `BUILDING_TYPE_BUCKETS` and the original Companies House postcode-matching work.
- After `classify-companies.mjs` completes a real (even partial) run, confirm in the live site: new sidebar chip counts look plausible, popup tags render for classified prospects and stay absent for unclassified ones, and the Companies tab's per-company badges match what the building-level tag shows for the same top-ranked company.
- Confirm re-running the script after a partial/interrupted run only processes prospects still missing a row, not the whole list again.
