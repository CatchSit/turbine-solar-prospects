# Turbine Energy — Solar Prospect Map — Handover

## 1. Project Overview

A prospecting tool for **Turbine Energy**, a UK commercial solar installer. It visualises commercial/industrial buildings in a pilot region (Yorkshire & Humber) that plausibly have moderate-to-high electricity usage and do **not** already have rooftop solar, so the sales team has a warm lead list instead of cold-calling blind.

This is a sibling project to `mcs-map` (Amco Renewables' installer map/CRM at `C:\Users\GregRoy\mcs-map`) — it reuses the same architecture philosophy (static HTML, Supabase backend, GitHub Pages hosting, no build tool) but is a **separate client, separate repo, separate Supabase project**.

**Repo:** https://github.com/CatchSit/turbine-solar-prospects — **public** (made public 2026-08-12 so GitHub Pages could run on the free plan, matching `mcs-map`'s own setup; no secrets are in the source, the anon key is meant to be public, and RLS + login is the real gate)
**Supabase project:** `turbine-solar-prospects` (created — confirm migrations have been run before assuming the schema exists, see Section 4)
**GitHub Pages:** **live** at `https://catchsit.github.io/turbine-solar-prospects/`, enabled 2026-08-12. **This is for Greg's own testing only — it has not been rolled out or announced to Turbine Energy staff.** Microsoft sign-in still doesn't work (Azure AD provider isn't enabled in Supabase yet) — the only way in right now is a temporary email/password test account. **Do not tell staff about this URL or treat it as "launched" until the Azure AD provider is confirmed enabled and a real `@turbineenergyuk.co.uk` account has completed the OAuth login end-to-end.** See Section 9, step 5.
**Local folder:** `C:\Users\GregRoy\Projects\turbine-solar-prospects` — already renamed from the original `commercial-map` scaffold name.

**Status: v1 pilot build, real data loaded, two external dependencies pending.** Data pipeline code, the map frontend, Turbine Energy's real branding, and an Azure AD login gate are all built and pushed. The `prospects` table holds **21,808 real Yorkshire & Humber buildings**, ingested from the full 2011–2026 non-domestic EPC bulk export (`data/` — see Section 4); **21,265 of those (96.6%) are geocoded** (lat/lng filled via postcodes.io). `index.html` queries Supabase live (not a static file) and shows "Failed to load prospect data" only if that live query fails (see Section 6). **No CRM/contact-logging layer yet** — this build ships the prospect map only, unlike mcs-map's full map+CRM+dashboard. Authentication is live (Microsoft/Azure AD via Supabase, restricted to `@turbineenergyuk.co.uk` both client-side and via RLS — see Section 5 and migrations 003/004), but see the GitHub Pages note in Section 1 above before going live.

**Two things block the pilot from being fully populated and truly usable end-to-end:**
1. **Solar enrichment hasn't run yet** — both API keys arrived from Turbine IT 2026-08-17 and are wired in (`GOOGLE_SOLAR_API_KEY` set as a Supabase secret; Maps key still to be embedded, see item 3 below), but **billing is not enabled on the Google Cloud project** (project #380039802064) — every real API call currently fails with `PERMISSION_DENIED: This API method requires billing to be enabled`. This blocks both the Solar API and, almost certainly, the Maps JavaScript API (Google Maps Platform has required a billing account on every key, including free-tier usage, since 2018). **Get Turbine IT to enable billing on that project before invoking `solar-enrichment` again or testing the satellite toggle** — a wasted invocation while billing is off just burns real (non-refundable) calls against the self-imposed monthly cap in item 1a below for zero result.
   - **1a. Self-imposed usage cap added 2026-08-17** (migration `005_api_usage_tracking.sql` + `supabase/functions/solar-enrichment/index.ts`): the function now tracks its own call count in a `api_usage` table and refuses to call the Solar API past **9,500 requests/month**, independent of whatever quota is set in the Google Cloud console — a defense-in-depth measure, not a replacement for also capping the console quota. Note the arithmetic: there are **21,265 geocoded rows** to check against a **10,000/month free tier**, so a full first pass will span at least 3 calendar months by design, even once billing is enabled.
   - Until enrichment actually runs, every row's `solar_status` is `pending`, and since the map defaults to showing only `prospect` rows, **the map will currently appear empty** even though the data is loaded.
2. **Turbine IT hasn't completed the Azure App Registration yet** — until they do and it's wired into Supabase (Section 1's GitHub Pages warning), the only way to get a session is the email/password signup path, which works for testing but isn't the intended login method for staff.
3. **Google Maps JavaScript API key not yet embedded** — key received 2026-08-17, restricted to `https://catchsit.github.io/*` and Maps JavaScript API only, but the satellite-imagery toggle hasn't been rebuilt to use it yet (Section 6), and testing is blocked on the same billing issue as item 1. Non-blocking for launch — the map works fine without it.

**Gotcha hit while wiring these up:** both API keys were originally pasted with a casing typo (`Aiza...` instead of the correct `AIza...` — every real Google API key starts `AIza`, capital I). Google's error messages for a malformed key ("API key not valid") look identical to a genuinely wrong key, so if a freshly-issued key gets rejected, check the casing before assuming IT sent a bad key.

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
| Node.js scripts (`scripts/`) | EPC ingestion, geocoding — run manually, not in-browser |
| Supabase (Postgres) | Stores the enriched `prospects` table |
| Supabase Edge Function (Deno) | `solar-enrichment` — batched Google Solar API calls |
| Google Solar API | Roof solar potential + existing-array detection |
| postcodes.io | Free bulk UK postcode → lat/lng geocoding |
| GitHub Pages | Hosts the static `index.html` |

```
turbine-solar-prospects/
├── index.html                        # Only page — prospect map, gated by Azure AD login
├── HANDOVER.md                       # This file
├── package.json
├── .gitignore
├── shared/
│   ├── escape-html.js                # Copied verbatim from mcs-map
│   ├── solar-status-config.js        # solar_status -> {color, label}
│   └── epc-rating-config.js          # EPC A-G -> {color, label}
├── data/                             # gitignored — raw EPC CSV downloads go here
├── docs/superpowers/
│   ├── specs/2026-08-12-azure-ad-auth-design.md
│   └── plans/2026-08-12-azure-ad-auth.md
├── scripts/                          # Manually-run Node pipeline tooling
│   ├── ingest-epc.mjs                # CSV -> region+floor-area filter -> dedupe -> upsert `prospects`
│   └── geocode-postcodes.mjs         # postcodes.io bulk lookup -> fills lat/lng
└── supabase/
    ├── migrations/
    │   ├── 001_prospects_schema.sql
    │   ├── 002_prospects_rls.sql
    │   ├── 003_prospects_auth_rls.sql  # Drops public read, requires authenticated (superseded by 004)
    │   └── 004_prospects_domain_rls.sql # Narrows read further to @turbineenergyuk.co.uk (RLS-enforced)
    └── functions/
        └── solar-enrichment/
            └── index.ts               # Batched, resumable Google Solar API enrichment
```

As of the Azure AD login work, `index.html` **does** talk to Supabase directly, matching mcs-map: the anon key is embedded client-side (safe — RLS is the real gate) and the frontend queries `prospects` live, behind a required Microsoft/Azure AD sign-in (`@turbineenergyuk.co.uk` only). See `docs/superpowers/specs/2026-08-12-azure-ad-auth-design.md` for the full design. The pipeline scripts (ingest, geocode, solar-enrichment) still write server-side using the service-role key, unaffected by this change.

---

## 4. Data Pipeline — how to (re)run it

Every step is idempotent (upserts on `epc_lmk_key`, `solar-enrichment` only touches `pending` rows), so re-running is always safe.

### Step 0 — one-time setup
1. Supabase project `turbine-solar-prospects` is already created. Confirm migrations `001_prospects_schema.sql` through `004_prospects_domain_rls.sql` (all four, in order) have been run in its SQL editor — run any that haven't (check with `SELECT * FROM prospects LIMIT 1;`; a "relation does not exist" error means `001`/`002` haven't been run yet). `004` is the one that actually enforces the `@turbineenergyuk.co.uk` restriction at the database level — don't treat `003` alone as sufficient, see Section 5.
2. Register a GOV.UK One Login account (needed to download EPC bulk data — see Section 7).
3. Get a Google Cloud API key with the Solar API enabled, and set it as the `GOOGLE_SOLAR_API_KEY` secret on the Supabase project (`supabase secrets set GOOGLE_SOLAR_API_KEY=...`).
4. `npm install` in the repo root.

### Step 1 — download EPC data (manual, human-gated)
Go to https://get-energy-performance-data.communities.gov.uk/, sign in, download the **non-domestic certificates** bulk CSV per year (England & Wales) — not "recommendations", that's a different, unused dataset (see Section 7, risk 1). Save into `data/` (gitignored).

`scripts/ingest-epc.mjs`'s `COLUMN_CANDIDATES` map has been verified against a real 2011–2026 export (Section 7, risk 2) — a first run shouldn't need any changes. If the portal changes its schema again in the future, the script still fails loudly and lists the actual headers found, rather than silently mis-mapping columns.

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

There is no separate export step — `index.html` queries the `prospects` table live (Section 6), gated by the Azure AD login and RLS, so once Steps 1–4 have run, the data is already visible in the map on next load. (The old `npm run export` script that pushed a static `prospects.json` to GitHub was retired when live Supabase queries replaced it — see `docs/superpowers/specs/2026-08-12-azure-ad-auth-design.md`.)

Repeat steps 1–4 (or just 3–4 if only re-checking solar status) whenever the pilot needs refreshing — no cron is set up yet (see Section 8).

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

RLS: authenticated `SELECT` only, further restricted to `@turbineenergyuk.co.uk` accounts at the database level (migration `004_prospects_domain_rls.sql` supersedes `003_prospects_auth_rls.sql`'s "any authenticated session" policy — `003` alone was found in review to be bypassable by anyone who self-registers via the exposed anon key, since public email signup is enabled on the project; `004` closes that by checking `auth.jwt() ->> 'email'` in the policy itself). No client insert/update/delete policies — all writes are server-side via the service-role key.

**Future extension point (not built):** a `prospect_contacts` table, FK'd to `prospects.id`, mirroring mcs-map's `contacts` table — see the commented-out DDL at the bottom of `001_prospects_schema.sql`.

### `api_usage` table (migration `005`)
`(api_name, period)` → `request_count`, where `period` is a UTC `YYYY-MM` string. Written only by `solar-enrichment` via the service-role key (RLS enabled, no policies — no client can read or write it). Exists purely so the Edge Function can self-enforce the 9,500/month Solar API cap (Section 1, item 1a) without trusting the Google Cloud console quota alone.

---

## 6. Frontend (`index.html`)

Single page, no CRM. Gated by a Microsoft/Azure AD login screen (`@turbineenergyuk.co.uk` only) — see Section 1 and `docs/superpowers/specs/2026-08-12-azure-ad-auth-design.md`. Once signed in, loads prospect data via a live, paginated Supabase query (`fetchAllProspects()` in `index.html`), not a static file.

- Sidebar filters: search (address/postcode), floor-area min/max, building-type chips, EPC rating chips (A–G, using the standard UK EPC colour band, kept distinct from the app's own Turbine Energy brand palette), solar-status chips.
- **Solar-status defaults to showing only `prospect`** — that's the point of the tool. A "show all" link reveals `has_solar`/`no_coverage`/etc. for spot-checking.
- Marker pin colour = `solar_status` (via `shared/solar-status-config.js`), following mcs-map's `makeMarkerIcon`/teardrop-pin pattern.
- Popup shows address, floor area, property type, local authority, EPC rating, solar status, and (for prospects with data) an estimated panel count / yearly kWh potential pulled from the Solar API response.
- `BUILDING_TYPE_BUCKETS` (inline in `index.html`) groups EPC's `property_type` (UK planning Use Classes Order labels, not free text) into ~6 buckets via word-boundary keyword matching — spot-checked against real ingested data, see Section 7 risk 3 for the one known ambiguous case.

No radius circle (no obvious Turbine Energy depot location yet — ask the client), no Log Contact modal, no dashboard.

**Satellite imagery — in progress, not yet live.** Three free/no-key options were tried and rejected on 2026-08-12 by comparing real tiles over the same Leeds location: Esri World Imagery (too low-resolution to judge a rooftop) and MapTiler (added, then also reverted — see commits `9b389e1` → `019edc2` → `0cd1196`). The map currently reverted to plain OpenStreetMap streets only, no toggle. Google Maps satellite tiles looked the best of the options compared (Bing, Google, MapTiler, Esri) but need the Google Maps JavaScript SDK bridged into Leaflet rather than a simple tile-URL swap, and a browser-exposed, domain-restricted API key. That key was requested from Turbine IT on 2026-08-17: **Application restrictions → Websites → `https://catchsit.github.io/*`** only (no localhost entry — it wasn't accepted in the console, so testing is being done directly against the live Pages URL instead of locally), **API restrictions → Maps JavaScript API** only. Once the key arrives, wire up the Leaflet-Google bridge and re-add the toggle — do not reuse the Solar API key, which is a separate, server-side-only credential (Section 1).

---

## 7. Known Risks / Open Items

1. **EPC portal — resolved.** `epc.opendatacommunities.org` redirects to `get-energy-performance-data.communities.gov.uk`, which requires a GOV.UK One Login account. Confirmed via a real walkthrough: the portal offers separate **certificates** and **recommendations** downloads per year — only **certificates** is needed (recommendations is retrofit-suggestion data, unused by this pipeline). Certificates are available per-year back to 2011; header schema is identical across all years 2011–2026.
2. **EPC CSV column names — verified against a real export, and fixed.** `scripts/ingest-epc.mjs`'s `COLUMN_CANDIDATES` map was a guess based on the historical (`opendatacommunities`) schema; the real bulk export uses different names for two fields the script needs: `LMK_KEY` → `certificate_number`, and `TOTAL_FLOOR_AREA` → `floor_area`. Both are now in `COLUMN_CANDIDATES` alongside the original guesses, and a full 2011–2026 ingest (1,059,502 raw rows) ran clean. The script still fails loudly and lists real headers if a future export changes again.
3. **`BUILDING_TYPE_BUCKETS` bucketing — spot-checked against real data, works for observed categories.** Real `property_type` values follow the UK planning Use Classes Order format (e.g. `"A1/A2 Retail and Financial/Professional services"`, `"B1 Offices and Workshop businesses"`, `"B2 to B7 General Industrial and Special Industrial Groups"`, `"B8 Storage or Distribution"`, `"C2 Residential Institutions - Hospitals and Care Homes"`), not free-text descriptions. The keyword matching correctly buckets all of these seen so far. One ambiguous case worth knowing: `"B1 Offices and Workshop businesses"` matches Warehouse/Industrial (via `"workshop"`) rather than Office, because Warehouse/Industrial is checked first and B1 is a genuinely mixed-use category — this is an order-dependent judgment call, not a bug, but worth revisiting if the sales team finds B1 buildings miscategorized. C1 (Hotels) and D1/D2 (Institutions/Assembly and Leisure) categories haven't been directly observed yet.
4. **Google Solar API `detectionStatus` field path is unverified.** `supabase/functions/solar-enrichment/index.ts`'s `classifyDetection()` checks a few plausible JSON paths and always stores the raw response in `solar_raw` specifically so this can be corrected by reprocessing stored data, without a second paid API call, once a real response is seen. **Do this check early in the pilot**, before trusting the `prospect`/`has_solar` split at any scale.
5. **Google Solar API coverage won't be uniform** across Yorkshire & Humber — expect a real `no_coverage` rate, especially for large sheds/industrial buildings on urban outskirts.
6. **EPC data is a proxy, not a measurement.** Self-declared at assessment time, buildings get renovated afterward. Keep the UI caveat in `index.html`'s footer.
7. **postcodes.io has no formal SLA.** Fine for a pilot; switch `scripts/geocode-postcodes.mjs` to a local ONSPD CSV join before any national-scale expansion — both for reliability and to avoid overloading a free public service.
8. **Auth is now live** (Azure AD via Supabase, matching mcs-map) — see `docs/superpowers/specs/2026-08-12-azure-ad-auth-design.md`. An `ADMIN_EMAILS` stub exists in `index.html` but doesn't gate anything yet; wire it up when the `prospect_contacts` CRM table lands.

---

## 8. Not Yet Built (future work)

- Automated refresh (pg_cron) — v1 is a manually-run pipeline. EPC re-ingestion should be at most monthly once the portal's automation story is confirmed; solar re-checks should be far less frequent (6–12 months, and only for `has_solar` rows, to catch removed panels) since Google's own aerial imagery doesn't refresh often.
- `prospect_contacts` table + Log Contact modal + dashboard, mirroring mcs-map's CRM layer — schema is designed to support this (see Section 5) but nothing is built.
- Region expansion beyond Yorkshire & Humber — the `region` column and `scripts/ingest-epc.mjs`'s local-authority filter are the two places to widen.

---

## 9. How to Continue Development

**Already done:**
- Repo created and pushed to `main` (https://github.com/CatchSit/turbine-solar-prospects); Supabase project `turbine-solar-prospects` created, migrations 001–004 applied.
- `npm install`, GOV.UK One Login registered, full 2011–2026 non-domestic EPC bulk certificates downloaded and ingested (Section 4, Steps 1–2) — **21,808 Yorkshire & Humber prospects** in the table.
- Geocoding run (Section 4, Step 3) — **21,265 of those (96.6%) have lat/lng**; the remaining ~750 failed to match in postcodes.io (expected background noise, Section 7 risk 7).
- Turbine Energy's real brand palette applied (pulled from the `turbine-homepage` marketing site build) and the `BUILDING_TYPE_BUCKETS` keyword matching spot-checked against the real ingested data (Section 7, risk 3).
- Azure AD login gate built: Microsoft/Azure AD sign-in via Supabase Auth, restricted to `@turbineenergyuk.co.uk` both client-side and via RLS (migrations 003–004, live-verified against the real project — see `docs/superpowers/specs/2026-08-12-azure-ad-auth-design.md`).

**Next steps:**
1. **Get billing enabled on the Google Cloud project** (#380039802064) that both API keys belong to — this is the main blocker right now (Section 1, item 1). `GOOGLE_SOLAR_API_KEY` is already set as a Supabase secret and `solar-enrichment` is deployed with the 9,500/month self-cap (migration `005`); it's ready to run the moment billing is on. Don't invoke it again before then — a call while billing is off still counts against the self-imposed cap for a guaranteed failure.
2. Run solar enrichment (Section 4, Step 4) — repeat the invoke command until the processed count is 0 or the response reports `budgetExhausted: true` (expected partway through, given 21,265 rows vs the 9,500/month cap — see Section 1, item 1a). Spot-check ~15–20 known buildings (some with visible rooftop solar, some without) before trusting the `prospect`/`has_solar` funnel at scale, and verify `classifyDetection()`'s field-path guess against a real response early (Section 7, risk 4).
3. **Get the Azure App Registration back from Turbine Energy's IT team** (Tenant ID, Client ID, Client secret) and wire it into Supabase (Authentication → Providers → Azure) — see Section 1's GitHub Pages warning for why this has to happen before going live.
4. Test at the live URL (`https://catchsit.github.io/turbine-solar-prospects/`) or locally (`npx serve .`) — sign in with a temporary email/password test account (create one via the Supabase Auth Admin API, since Azure AD isn't wired up yet) and exercise every filter against the real live data. Note the map will look empty until Step 2 above populates `solar_status` beyond `pending`.
5. **Confirm the Azure AD provider is enabled and working end-to-end (a real `@turbineenergyuk.co.uk` account completing sign-in) before telling Turbine Energy staff about the live URL or treating this as launched** — see the warning in Section 1. GitHub Pages is already on; what's missing is the intended login method.
6. Once billing is confirmed on, embed the Google Maps JavaScript API key (already received, restricted to `https://catchsit.github.io/*` and Maps JavaScript API only — Section 1 item 3, Section 6) and wire up the satellite-imagery toggle via a Leaflet-Google bridge. Test against the live Pages URL, not localhost (the key has no localhost origin). Non-blocking for launch — the map works without it.
