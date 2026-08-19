# EPC Recommendations Enrichment — Design

## Context

The `prospects` table is built from the non-domestic EPC bulk **certificates** export only — floor area, property type, and EPC rating are all proxies for "this building might be a good solar lead," never a direct signal. The same GOV.UK portal also publishes a separate **recommendations** export per certificate: the specific improvement measures (solar PV, insulation, lighting, etc.) a real accredited assessor actually recommended for that building at assessment time. Where present, "the assessor explicitly recommended solar PV" is a materially stronger signal than the floor-area proxy alone — this design adds it.

This is the second of three independent, free enrichment sub-projects raised together (Companies House fields — shipped; this one; VOA business rates — still to come). Each gets its own spec.

## Goals

- Detect, per prospect, whether its EPC assessment explicitly recommended solar PV or solar water heating, and surface that as a distinct, higher-confidence signal in the UI (badge + filter).
- Also detect a secondary, less-solar-specific signal — insulation/heating-control recommendations — since it was included in scope, but keep it visually and functionally secondary to the solar signal.
- No new cost, no new external service — reuses the same GOV.UK EPC portal, GOV.UK One Login, and CSV-ingest pattern already built for certificates.
- Defensive against schema uncertainty — the recommendations CSV's exact column set isn't publicly documented (unlike certificates, which were already verified against a real 2011–2026 export). Follow the same "fail loudly, verify against a real download" discipline already established in this codebase (`scripts/ingest-epc.mjs`'s `COLUMN_CANDIDATES`).

## Non-goals

- No LED lighting recommendation tracking — explicitly excluded by request; out of scope for a solar-focused tool.
- No monetary savings estimates from the recommendations data — consistent with this project's existing "no invented £ figures" rule (HANDOVER.md Section 2, the Companies House talking-points design). Non-domestic EPC recommendations don't carry the same indicative-cost/typical-saving fields domestic EPCs do in any case.
- No per-recommendation detail UI (e.g. listing every individual measure) — only the two boolean signals defined below. A future sub-project could expand this if real demand shows up.
- "Solar gain limit exceeded" is explicitly NOT treated as a solar-recommendation signal — it's a warning about excess unshaded-glazing heat gain, the opposite meaning of "install solar generation." The classifier must not match on the bare word "solar."

## Architecture

New pipeline script `scripts/ingest-epc-recommendations.mjs`, structurally mirroring the existing `scripts/ingest-epc.mjs`:

1. Reads recommendations CSV file(s) from `data/` (same gitignored location as certificate CSVs), via the same `csv-parse` streaming approach.
2. Defensive column resolution (`COLUMN_CANDIDATES`-style map) for the two confirmed-real columns — `LMK_KEY` and `IMPROVEMENT_SUMMARY_TEXT` — plus best-guess candidates for likely-present but unconfirmed columns (e.g. `IMPROVEMENT_ID`, `IMPROVEMENT_ID_TEXT`), since the full schema isn't publicly documented. Fails loudly and lists real headers found if the two required columns can't be resolved, exactly like the certificates script already does.
3. Groups recommendation rows by `LMK_KEY` (a building can have multiple recommendation rows — one per suggested measure).
4. For each `LMK_KEY` group, classifies whether any row's `IMPROVEMENT_SUMMARY_TEXT` matches the solar bucket, the efficiency bucket, both, or neither (see Classification below).
5. Upserts `epc_recommends_solar` / `epc_recommends_efficiency` onto the `prospects` row matching that `epc_lmk_key` — only for `LMK_KEY`s that already exist in `prospects` (a recommendations row for a certificate outside the Yorkshire & Humber / floor-area filter is simply skipped, matching how `ingest-epc.mjs` already filters).
6. Logs a summary: total recommendation rows read, rows matched to an existing prospect, count flagged solar, count flagged efficiency, and count of `IMPROVEMENT_SUMMARY_TEXT` values that matched neither bucket (an "unclassified — verify these aren't real solar/efficiency mentions worded differently" list, capped at showing the first ~20 distinct unmatched strings) — this is the mechanism for catching schema drift or a keyword-matching gap without silently losing signal.

## Classification

Case-insensitive substring matching against `IMPROVEMENT_SUMMARY_TEXT`:

```js
const SOLAR_PATTERNS = [/solar\s+photovoltaic/i, /solar\s+water\s+heating/i, /\bsolar\s+pv\b/i];
const EFFICIENCY_PATTERNS = [
  /loft\s+insulation/i, /cavity\s+wall\s+insulation/i,
  /optimum\s+start\s*\/?\s*stop/i, /weather\s+compensation/i,
];

function classify(summaryText) {
  const solar = SOLAR_PATTERNS.some(p => p.test(summaryText));
  const efficiency = EFFICIENCY_PATTERNS.some(p => p.test(summaryText));
  return { solar, efficiency };
}
```

A row matching neither pattern set (LED lighting, "solar gain limit exceeded," or anything unrecognized) contributes to neither flag and is counted in the "unclassified" log output. A `LMK_KEY` group where any row matches solar sets `epc_recommends_solar = true` for that prospect; same independently for efficiency — the two flags are not mutually exclusive.

## Database changes

New migration `supabase/migrations/009_epc_recommendations.sql`:

```sql
alter table prospects
  add column if not exists epc_recommends_solar boolean,
  add column if not exists epc_recommends_efficiency boolean;
```

No new table — these are simple per-building flags, directly analogous to the existing `solar_status` column's role. `null` (the default) means "no recommendations data available for this building" — distinct from `false`, which this design never actually sets (a `LMK_KEY` with no matching recommendation row, or one whose rows all fall outside both buckets, is left `null`, not written as `false`, since "assessor didn't mention solar" and "we have no recommendations data for this building at all" are different claims and the pipeline shouldn't overstate certainty — matching this project's established "EPC is a proxy, not a measurement" honesty).

RLS: no new policy needed — these are plain columns on the existing `prospects` table, covered by the existing row-level policy (migration `004`).

## Frontend changes (`index.html`)

- Two new sidebar filter chips, alongside the existing EPC-rating/building-type/solar-status chip groups: **"EPC recommends solar"** and **"EPC recommends efficiency improvements"** — each a simple boolean toggle (shows only prospects where the corresponding flag is `true`), not a full chip-group like EPC rating's A–G bands.
- Two new popup badges (`shared/epc-recommendation-config.js`-style config: color + label per flag, following the same pattern as `shared/solar-status-config.js`), shown only when the corresponding flag is `true`:
  - "☀ EPC recommends solar" — a distinct, high-visibility color (this is the headline new signal).
  - "EPC recommends efficiency improvements" — a muted/secondary style, visually subordinate to the solar badge.
- Badges are additive to the existing tag row in `buildPopup()`; absent (both flags `null`/`false`) means no badge shown, not an empty placeholder.

## Testing & verification

- Verify `COLUMN_CANDIDATES` against a real downloaded recommendations CSV before trusting a full ingest — same discipline as `ingest-epc.mjs`'s own history (HANDOVER.md Section 7, risk 2). Expect to need to adjust guessed column names for `IMPROVEMENT_ID`/`IMPROVEMENT_ID_TEXT` once real headers are seen, since only `LMK_KEY` and `IMPROVEMENT_SUMMARY_TEXT` are confirmed from public sources.
- After the first real ingest, manually cross-check ~10 prospects flagged `epc_recommends_solar = true` against their actual EPC certificate/recommendation report (available via the same GOV.UK portal's per-building lookup) to confirm the classifier isn't over- or under-matching.
- Confirm the "solar gain limit exceeded" exclusion works correctly — deliberately find or construct a test row with that exact text and confirm it does NOT set `epc_recommends_solar`.
- Review the ingest run's "unclassified" log output at least once against real data — if a meaningful volume of real solar-related text doesn't match `SOLAR_PATTERNS`, the patterns need broadening.
