# VOA as a Primary Prospect Source — Design

## Context

`prospects` currently has exactly one entry point: the non-domestic EPC register (`scripts/ingest-epc.mjs`). EPC certificates are only lodged when a building is sold, let, or substantially refurbished — a building that's been owner-occupied for years without one of those trigger events simply has no EPC certificate at all, and therefore isn't in the pilot's 22,016 prospects no matter how good a solar candidate it is. This is a real, structural gap in the current sourcing, not a data-quality issue with what's already there.

The VOA compiled non-domestic rating list — already downloaded and parsed by `scripts/ingest-business-rates.mjs` for enrichment — is a near-complete, independent register of every rated commercial property in England & Wales, regardless of EPC history. This design turns it into a *second entry point* for `prospects`, not just an enrichment source for prospects that arrived via EPC.

Verified directly against a real downloaded row (2026-08-20, sampled via `unzipper.Open.file` against the live current baseline, not assumed from the spec) before writing this design:

- The file has a genuine **combined street address field** (position 7, e.g. `"UNIT 3 KNOLLS FARM, SHEFFORD ROAD, CLIFTON, SHEFFORD, BEDS"`), plus decomposed line components (positions 9-13) — `ingest-business-rates.mjs` currently only extracts postcode (position 14), leaving this real address data unused.
- Position 3 (**BA reference number**, e.g. `"38040/006283"`) is a stable, unique per-hereditament identifier — a ready-made key, no synthetic key needed.
- Position 5 (primary description text, already extracted for the existing hereditament display) is the only building-type-equivalent signal available — coarser than EPC's Use Class labels but bucketable the same way.

Rateable-value calibration, queried directly against the live data (2026-08-20): among the 19,050 existing prospects that already qualify today (floor area ≥ 500m², per `MIN_FLOOR_AREA_M2`) and have a matched hereditament, the real rateable-value distribution is: p05 = £11,750, p10 = £19,750, p25 = £42,750, median = £110,000. A floor around £15,000 sits between the 5th and 10th percentile of what already qualifies — a defensible, data-grounded starting threshold rather than a guess.

## Goals

- Seed new `prospects` rows from VOA hereditaments whose postcode has no existing prospect, above a rateable-value floor (`MIN_VOA_RATEABLE_VALUE`, initial value £15,000, tunable — same convention as `MIN_FLOOR_AREA_M2`), reusing the download/parse pass `ingest-business-rates.mjs` already does rather than a second one.
- New prospects get a real street address (from the VOA address field, not just a postcode-level pin), a building-type-equivalent from the VOA description text (fed through the existing `bucketPropertyType()`), and their rateable value as the primary size proxy in place of floor area.
- One new prospect row **per postcode**, not per hereditament — consistent with how every existing prospect represents one building/postcode, and it means the existing `business_rates_matches` hereditament-list popup section works on these new rows for free, no new UI needed for that part.
- A dry-run count (no writes) before any real seeding, so the actual yield is known before committing — this was deliberately left unmeasured in brainstorming rather than guessed.
- Fix a filter bug this creates: `ratingOk`'s existing null-passthrough (`!d.epc_rating || activeRatings.has(...)`) is currently a dead edge case (virtually every EPC-sourced prospect has a rating), but VOA-sourced prospects will have no EPC rating at all — at the pilot's current scale this would silently recreate the exact "filter looks broken" bug just fixed for Business Sector/Company Maturity (`docs/superpowers/specs/2026-08-20-company-sector-maturity-classification-design.md` follow-up, chat 2026-08-20). Apply the same "strict once touched" fix to EPC Rating in this same change, before it ships alongside null-heavy VOA rows.

## Non-goals

- No hereditament-level granularity for new prospects (one row per postcode, highest-value hereditament as the representative address/rateable-value) — matches the existing building-level model everywhere else in this app.
- No perfect building-level dedup against existing prospects — postcode-level matching, same precision already accepted for Companies House and VOA enrichment matching throughout this project.
- No billing-authority-code-to-name lookup table for VOA-only prospects' `local_authority` field — cheaper to backfill it from postcodes.io's `admin_district` field (already fetched by `geocode-postcodes.mjs`, just not currently stored) than to build and maintain a VOA billing-authority-code reference table.
- No solar enrichment changes — new VOA-sourced prospects enter with `solar_status = 'pending'` exactly like any other new prospect and get picked up by the next `solar-enrichment` run, no special-casing needed there.
- No processing of VOA's weekly change-update delta files — same "current baseline epoch only" scope already established in the original VOA enrichment design.

## Architecture

### Schema changes

New migration `supabase/migrations/013_voa_prospect_source.sql`:

```sql
alter table prospects alter column epc_lmk_key drop not null;
alter table prospects add column if not exists voa_ba_reference text unique;
alter table prospects add column if not exists source text not null default 'epc';
```

`epc_lmk_key` stays `UNIQUE` (Postgres allows multiple `NULL`s under a unique constraint, so existing EPC rows are unaffected) — VOA-only rows leave it `null` and use the new `voa_ba_reference` as their own unique upsert-conflict target instead. `source` (`'epc'` | `'voa'`) makes provenance explicit everywhere without needing to infer it from which key column is populated.

### `ingest-business-rates.mjs` gains a second output from the same pass

Deliberately **not** a separate script — the expensive part of this pipeline is downloading (~93MB) and streaming-parsing (~511MB, ~2M rows) the VOA file once; duplicating that into a second script would double real network/CPU cost for no benefit, unlike the earlier `company-lookup`/`classify-companies.mjs` split (there, the duplicated logic was a ~20-line pure function, not a multi-hundred-MB parse).

During the existing single streaming pass, for each Yorkshire & Humber row (same outcode filter already in place):

1. **Existing behavior, unchanged:** postcode matches an existing prospect → collect into the hereditament-enrichment map (`business_rates_matches`), exactly as today.
2. **New:** postcode matches *no* existing prospect, and the row's `rateable_value >= MIN_VOA_RATEABLE_VALUE` → collect as a new-prospect candidate.
3. Group new-prospect candidates by postcode; for each postcode, the hereditament with the highest rateable value becomes that prospect's representative record (address, description, rateable value). Insert one `prospects` row per postcode: `source: 'voa'`, `voa_ba_reference` from that top hereditament, `address` from the VOA combined address field, `postcode`, `property_type` set to the raw VOA description text (fed through the same `bucketPropertyType()` keyword matcher the frontend already uses — no frontend change needed for this part), `epc_lmk_key: null`, `total_floor_area: null`, `current_energy_rating: null`, `current_energy_efficiency: null`, `region: 'yorkshire-humber'` (default), `solar_status: 'pending'` (default).
4. **Still runs exactly as today, now covering more rows:** the existing hereditament-upsert step (`business_rates_matches`) runs *after* the new prospects are inserted, using the same postcode-grouped data — so newly-seeded prospects automatically get their full hereditament list in the popup's Business Rates tab, no additional matching pass required.
5. New prospects need geocoding (lat/lng) before they'll render — running `npm run geocode` afterward picks them up automatically, since it already processes "any row missing lat/lng" with no changes needed there.

### `geocode-postcodes.mjs` backfills `local_authority` when missing

postcodes.io's bulk lookup response already includes `admin_district` (local authority name) — currently fetched but not stored, since every EPC-sourced row already has `local_authority` from EPC data directly. Extend the script: when a row's `local_authority` is null and the postcode lookup succeeds, store `admin_district` as `local_authority`. This is what gives VOA-only prospects a readable local authority name instead of a blank field, at no extra API cost (same lookup call already being made for lat/lng).

### Dry-run count before any real seeding

Before wiring up the actual insert, run the same discovery/download/parse/filter logic with the insert step replaced by a plain count — report how many *new, distinct postcodes* would qualify at the initial £15,000 floor. This number was deliberately left unmeasured during brainstorming rather than guessed; if it's surprisingly large or small, the floor is a one-line constant to retune before committing to a real run.

## Frontend changes (`index.html`)

- **Fix `ratingOk`** to match the same "strict once touched" pattern already applied to Business Sector/Company Maturity: full `EPC_RATING_ORDER` selected (untouched default) passes everything through, including prospects with no rating; deselecting even one rating chip excludes unrated prospects too.
  ```js
  const ratingOk = activeRatings.size === EPC_RATING_ORDER.length || activeRatings.has(d.epc_rating);
  ```
- No other frontend change is required — `d.property_type` (used by `bucketPropertyType()` for the Building Type chips and popup tag) and `d.floor_area`/`d.epc_rating` (used by the floor-area range filter and EPC Rating chips, both already null-safe for the floor-area/rateable-value range filters) all already degrade correctly for a row that simply has fewer fields populated, since that discipline was already established building the rest of this app.
- Popup: no changes needed. `buildPopup()` already falls back gracefully wherever a field is absent (e.g. the consolidated facts line already `filter(Boolean)`s out empty parts) — a VOA-sourced prospect's popup will just show fewer facts and no solar-estimate block until solar enrichment runs, same as any other prospect currently mid-pipeline.

## Testing & verification

- Run the dry-run count first; sanity-check the reported number is plausible (not zero, not absurdly larger than the existing 22,016) before enabling real inserts.
- After a real (even partial) run, spot-check 5-10 new VOA-sourced prospects: real address renders correctly in the popup, building-type bucket looks sensible for the VOA description text, local authority backfilled correctly via the geocode step, and the Business Rates tab shows the full hereditament list exactly as it does for EPC-sourced prospects.
- Confirm the EPC Rating filter fix: with a mix of EPC-sourced (rated) and VOA-sourced (unrated) prospects loaded, deselecting all-but-one rating chip should hide VOA-sourced prospects, matching how the Business Sector fix already behaves.
- Confirm no duplicate prospects were created for postcodes that already had an EPC-sourced prospect — the existing-postcode prefilter should make this structurally impossible, but worth a direct count check (`select postcode, count(*) from prospects group by postcode having count(*) > 1` should return only postcodes that legitimately had multiple *EPC* prospects before this change, never a new EPC+VOA pair at the same postcode).
