# Turbine Energy — Solar Prospect Map — Handover

## 1. Project Overview

A prospecting tool for **Turbine Energy**, a UK commercial solar installer. It visualises commercial/industrial buildings in a pilot region (Yorkshire & Humber) that plausibly have moderate-to-high electricity usage and do **not** already have rooftop solar, so the sales team has a warm lead list instead of cold-calling blind.

This is a sibling project to `mcs-map` (Amco Renewables' installer map/CRM at `C:\Users\GregRoy\mcs-map`) — it reuses the same architecture philosophy (static HTML, Supabase backend, GitHub Pages hosting, no build tool) but is a **separate client, separate repo, separate Supabase project**.

**Repo:** https://github.com/CatchSit/turbine-solar-prospects (created, initial scaffold pushed to `main`)
**Supabase project:** `turbine-solar-prospects` (created — confirm migrations have been run before assuming the schema exists, see Section 4)
**GitHub Pages:** not yet enabled
**Local folder:** as of this writing, still `C:\Users\GregRoy\Projects\commercial-map` on this machine — cosmetic only, nothing in the code depends on the local path. Safe to rename to `turbine-solar-prospects` once closed in your editor.

**Status: v1 pilot build, scaffold only.** Data pipeline code and map frontend are built and pushed; **no real data has been ingested yet** — the map will show "Failed to load prospect data" until `prospects.json` exists (see Section 4 to run the pipeline). The EPC download step requires a human to register a GOV.UK One Login account (Section 7, risk 1). **No CRM/contact-logging layer and no authentication** — this build ships the prospect map only, unlike mcs-map's full map+CRM+dashboard.

---

## 2. Why This Exists (read before changing the filtering logic)

Two hard problems had to be solved before any of this could be built, and the design only makes sense in light of them:

1. **There is no public per-building electricity-consumption dataset in the UK.** Smart meter and DNO data isn't open. The proxy used here is the **non-domestic EPC register** (property type + floor area + energy rating) — it correlates with usage, it does not measure it. Say so in any UI copy; don't let "prospect" read as a guarantee.
2. **"Does this roof already have solar" needs aerial-imagery analysis.** After comparing a custom computer-vision build, licensing an existing UK solar-panel database (Geospatial Insight's LOCATE PV — enterprise sales process, unknown pricing), and Google's Solar API, this project uses the **Google Solar API**'s `buildingInsights` endpoint with `additionalInsights=DETECTED_ARRAYS`, which returns both roof solar potential and an existing-array detection status in one self-serve, pay-as-you-go call (10,000 free requests/month).

---

## 3. Tech Stack & Architecture

| Library | Purpose |
|---|---|
| Leaflet.js 1.9.4 + MarkerCluster 1.5.3 | Interactive map rendering |
| Plain HTML/CSS/JS | No framework, no build toolchain — same as mcs-map |
| Node.js scripts (`scripts/`) | EPC ingestion, geocoding, JSON export — run manually, not in-browser |
| Supabase (Postgres) | Stores the enriched `prospects` table |
| Supabase Edge Function (Deno) | `solar-enrichment` — batched Google Solar API calls |
| Google Solar API | Roof solar potential + existing-array detection |
| postcodes.io | Free bulk UK postcode → lat/lng geocoding |
| GitHub Pages | Hosts the static `index.html` |

```
turbine-solar-prospects/
├── index.html                        # Only page — prospect map (no login, no CRM)
├── prospects.json                    # Static export consumed by index.html
├── HANDOVER.md                       # This file
├── package.json
├── .gitignore
├── shared/
│   ├── escape-html.js                # Copied verbatim from mcs-map
│   ├── solar-status-config.js        # solar_status -> {color, label}
│   └── epc-rating-config.js          # EPC A-G -> {color, label}
├── data/                             # gitignored — raw EPC CSV downloads go here
├── scripts/                          # Manually-run Node pipeline tooling
│   ├── ingest-epc.mjs                # CSV -> region+floor-area filter -> dedupe -> upsert `prospects`
│   ├── geocode-postcodes.mjs         # postcodes.io bulk lookup -> fills lat/lng
│   └── export-prospects-json.mjs     # Supabase -> prospects.json -> push via GitHub Git Data API
└── supabase/
    ├── migrations/
    │   ├── 001_prospects_schema.sql
    │   └── 002_prospects_rls.sql
    └── functions/
        └── solar-enrichment/
            └── index.ts               # Batched, resumable Google Solar API enrichment
```

Unlike mcs-map, **the browser never talks to Supabase directly** — there's no CRM data yet to justify shipping an anon key + live queries. `index.html` only fetches the static `prospects.json`. All Supabase access happens server-side (scripts + Edge Function) using the service-role key.

---

## 4. Data Pipeline — how to (re)run it

Every step is idempotent (upserts on `epc_lmk_key`, `solar-enrichment` only touches `pending` rows), so re-running is always safe.

### Step 0 — one-time setup
1. Supabase project `turbine-solar-prospects` is already created. Confirm `supabase/migrations/001_prospects_schema.sql` then `002_prospects_rls.sql` have been run in its SQL editor — run them if not (check with `SELECT * FROM prospects LIMIT 1;`; a "relation does not exist" error means they haven't been run yet).
2. Register a GOV.UK One Login account (needed to download EPC bulk data — see Section 7).
3. Get a Google Cloud API key with the Solar API enabled, and set it as the `GOOGLE_SOLAR_API_KEY` secret on the Supabase project (`supabase secrets set GOOGLE_SOLAR_API_KEY=...`).
4. `npm install` in the repo root.

### Step 1 — download EPC data (manual, human-gated)
Go to https://get-energy-performance-data.communities.gov.uk/, sign in, download the **non-domestic** EPC bulk CSV (England & Wales). Save into `data/` (gitignored).

**Before running the ingest script**, open the CSV and check its header row against `COLUMN_CANDIDATES` in `scripts/ingest-epc.mjs` — the column names in that script are a best guess based on the historical schema and have not been verified against a live export. The script fails loudly (lists the actual headers it found) if it can't match what it needs, rather than silently mis-mapping columns.

### Step 2 — ingest
```
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run ingest -- data/your-export.csv
```
Filters to Yorkshire & Humber (by local authority name, cross-checked against postcode outcode prefix) and floor area > `MIN_FLOOR_AREA_M2` (500, tune the constant at the top of the script), dedupes by UPRN keeping the most recent certificate, upserts into `prospects`.

### Step 3 — geocode
```
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run geocode
```
Fills `lat`/`lng` via postcodes.io's bulk endpoint for any row missing them.

### Step 4 — solar enrichment
Deploy and invoke the Edge Function repeatedly until no `pending` rows remain (each invocation processes a bounded batch, ~300 rows, to stay inside the function timeout):
```
supabase functions deploy solar-enrichment
supabase functions invoke solar-enrichment   # repeat until processed count is 0
```
Requires the `GOOGLE_SOLAR_API_KEY` secret set on the Supabase project. Watch the invocation logs for the `prospect / has_solar / no_coverage / error` funnel counts before this scales past the pilot — `buildingInsights` free tier is 10,000 requests/month.

### Step 5 — export to the map
```
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... GITHUB_PAT=... GITHUB_REPO=CatchSit/turbine-solar-prospects npm run export
```
Re-exports the **full current** `prospects` table (not incremental) to `prospects.json` and pushes it via the GitHub Git Data API, same blob/tree/commit/ref-update flow as mcs-map's `mcs-scraper`. Only rows with a resolved `lat`/`lng` are included.

Repeat steps 1–5 (or just 3–5 if only re-checking solar status) whenever the pilot needs refreshing — no cron is set up yet (see Section 8).

---

## 5. Database Schema

### `prospects` table
| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key (a real FK target, unlike mcs-map's soft `installer_id text` convention) |
| `epc_lmk_key` | text | Unique — EPC certificate key, upsert conflict target |
| `uprn` | text | Nullable — not all EPC rows carry one |
| `address`, `postcode`, `local_authority` | text | From EPC |
| `region` | text | Pilot tag, default `'yorkshire-humber'` |
| `property_type`, `total_floor_area` | text, numeric | From EPC — the usage proxy |
| `current_energy_rating`, `current_energy_efficiency` | text, int | EPC A–G band + score |
| `lodgement_date` | date | Used for dedupe (keep most recent per building) |
| `lat`, `lng`, `geocode_source` | numeric, numeric, text | Filled by `geocode-postcodes.mjs` |
| `solar_status` | text | `pending` \| `prospect` \| `has_solar` \| `no_coverage` \| `error` |
| `solar_checked_at`, `solar_detection_status`, `solar_max_panels`, `solar_yearly_energy_kwh`, `solar_raw` | — | Filled by `solar-enrichment`; `solar_raw` keeps the full API response so reclassification doesn't need a second paid call |

RLS: public `SELECT` only. No client insert/update/delete policies — all writes are server-side via the service-role key.

**Future extension point (not built):** a `prospect_contacts` table, FK'd to `prospects.id`, mirroring mcs-map's `contacts` table — see the commented-out DDL at the bottom of `001_prospects_schema.sql`.

---

## 6. Frontend (`index.html`)

Single page, no login, no CRM. Loads `prospects.json` on page load.

- Sidebar filters: search (address/postcode), floor-area min/max, building-type chips, EPC rating chips (A–G, using the standard UK EPC colour band, not the Daylight palette), solar-status chips.
- **Solar-status defaults to showing only `prospect`** — that's the point of the tool. A "show all" link reveals `has_solar`/`no_coverage`/etc. for spot-checking.
- Marker pin colour = `solar_status` (via `shared/solar-status-config.js`), following mcs-map's `makeMarkerIcon`/teardrop-pin pattern.
- Popup shows address, floor area, property type, local authority, EPC rating, solar status, and (for prospects with data) an estimated panel count / yearly kWh potential pulled from the Solar API response.
- `BUILDING_TYPE_BUCKETS` (inline in `index.html`) groups EPC's free-text `property_type` into ~6 buckets via keyword matching — **not verified against real EPC data yet**, tune once real values are seen.

No radius circle (no obvious Turbine Energy depot location yet — ask the client), no Log Contact modal, no dashboard, no auth.

---

## 7. Known Risks / Open Items

1. **EPC portal moved.** `epc.opendatacommunities.org` now redirects to `get-energy-performance-data.communities.gov.uk`, which requires a GOV.UK One Login account for bulk downloads (confirmed via live fetch). Not confirmed whether the new portal still supports region-filtered downloads or a non-interactive API — do a manual walkthrough before assuming either.
2. **EPC CSV column names are unverified.** `scripts/ingest-epc.mjs`'s `COLUMN_CANDIDATES` map is a best guess from the historical schema. The script fails loudly with the real header list if it can't match — don't silently trust a first run.
3. **`BUILDING_TYPE_BUCKETS` bucketing is unverified** against real `property_type` values — same caveat.
4. **Google Solar API `detectionStatus` field path is unverified.** `supabase/functions/solar-enrichment/index.ts`'s `classifyDetection()` checks a few plausible JSON paths and always stores the raw response in `solar_raw` specifically so this can be corrected by reprocessing stored data, without a second paid API call, once a real response is seen. **Do this check early in the pilot**, before trusting the `prospect`/`has_solar` split at any scale.
5. **Google Solar API coverage won't be uniform** across Yorkshire & Humber — expect a real `no_coverage` rate, especially for large sheds/industrial buildings on urban outskirts.
6. **EPC data is a proxy, not a measurement.** Self-declared at assessment time, buildings get renovated afterward. Keep the UI caveat in `index.html`'s footer.
7. **postcodes.io has no formal SLA.** Fine for a pilot; switch `scripts/geocode-postcodes.mjs` to a local ONSPD CSV join before any national-scale expansion — both for reliability and to avoid overloading a free public service.
8. **Auth is deliberately absent in v1**, unlike mcs-map's Azure AD gate — there's no CRM data yet to protect. Revisit when a `prospect_contacts` table lands.

---

## 8. Not Yet Built (future work)

- Automated refresh (pg_cron) — v1 is a manually-run pipeline. EPC re-ingestion should be at most monthly once the portal's automation story is confirmed; solar re-checks should be far less frequent (6–12 months, and only for `has_solar` rows, to catch removed panels) since Google's own aerial imagery doesn't refresh often.
- `prospect_contacts` table + Log Contact modal + dashboard, mirroring mcs-map's CRM layer — schema is designed to support this (see Section 5) but nothing is built.
- Authentication, once there's CRM data worth protecting.
- Region expansion beyond Yorkshire & Humber — the `region` column and `scripts/ingest-epc.mjs`'s local-authority filter are the two places to widen.
- Branding — currently reuses mcs-map's "Daylight" placeholder palette; Turbine Energy may want their own.

---

## 9. How to Continue Development

**Already done:** repo created and scaffold pushed to `main` (https://github.com/CatchSit/turbine-solar-prospects), Supabase project `turbine-solar-prospects` created.

**Next steps:**
1. `npm install`.
2. Confirm the two migrations have been run against the Supabase project (Section 4, Step 0) — run them if not.
3. Register GOV.UK One Login, download the non-domestic EPC bulk CSV, and **check its header row against `scripts/ingest-epc.mjs`'s column mapping before trusting a run**.
4. Get a Google Cloud API key with the Solar API enabled and set `GOOGLE_SOLAR_API_KEY` as a Supabase secret.
5. Run the pipeline (Section 4, Steps 2–5) for a small sample first — spot-check ~15–20 known buildings (some with visible rooftop solar, some without) before trusting the funnel at scale. Step 5 pushes `prospects.json` straight to the live repo, so this is a real, visible update once run.
6. Serve `index.html` locally (`npx serve .`) and exercise every filter against the real `prospects.json`.
7. Enable GitHub Pages on the repo (Settings → Pages → deploy from `main`) once there's real data worth publishing.
8. Optionally rename the local folder from `commercial-map` to `turbine-solar-prospects` (close it in your editor first — see Section 1).
