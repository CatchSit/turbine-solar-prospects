# Company Sector & Maturity Classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Classify every prospect's most-relevant matched company by SIC-derived energy-relevant sector and by company maturity, storing it so both become instant, whole-list sidebar filters and popup tags — matching how Building Type and EPC Rating already work.

**Architecture:** A new table (`company_classifications`) holds one row per prospect with its top address-ranked Companies House match's raw SIC codes, incorporation date, and accounts-filing status. A new standalone Node script (not an edge function — see spec's Architecture section for why) populates it by calling Companies House directly, self-paced under its rate limit, over one long-running run. Two new client-side config files bucket that raw data into sector/maturity categories, mirroring `shared/building-types.js` exactly. The existing on-demand `company-lookup` function gains the one field (`accounts_type`) it was missing so the popup's already-open Companies tab can show the same badges per individual company.

**Tech Stack:** Deno (existing edge function), Node (new script, matching `scripts/ingest-business-rates.mjs`), plain HTML/CSS/JS frontend — no new dependencies.

## Global Constraints

- No new npm dependency — the new script uses only `@supabase/supabase-js` (already a dependency) and the built-in `fetch`/`btoa`.
- `company_classifications` gets its real SELECT policy in the same migration that creates the table (not split across two migrations) — `HANDOVER.md` Section 7 risk 13.
- A prospect with no postcode never gets a `company_classifications` row at all (not even `no_match: true`) — same convention as `business_rates_matches`.
- Sector bucket "Established" maturity threshold: **3 years** (per the approved spec — note this supersedes an earlier 5-year draft).
- Sector/maturity bucket functions are pure client-side functions over raw stored data (`shared/sic-sector-config.js`, `shared/company-maturity-config.js`) — never computed server-side, so they can be retuned later without re-running the pipeline.
- `null` (no classification data at all) is distinct from `"Other"` (classified, not an energy-relevant sector) — filters must pass `null` through untouched (same convention as EPC rating's `!d.epc_rating || activeRatings.has(...)`), and popups must show no tag for either `null` or `"Other"`.

---

### Task 1: Database migration

**Files:**
- Create: `supabase/migrations/012_company_classifications.sql`

**Interfaces:**
- Produces: `company_classifications` table (`prospect_id` PK → `company_name`, `company_number`, `sic_codes text[]`, `incorporated_on date`, `accounts_type text`, `no_match boolean`, `fetched_at timestamptz`), readable by any `@turbineenergyuk.co.uk` authenticated session. Consumed by Task 4 (writes) and Task 5 (reads via `fetchAllProspects()`).

- [ ] **Step 1: Write the migration**

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

- [ ] **Step 2: Run it against the linked project**

Run: `supabase db push` (or paste into the Supabase SQL editor, matching how prior migrations in this repo were applied — check `supabase migration list` first to confirm it hasn't already been applied by another process).

Expected: `company_classifications` exists. Verify with a quick `select count(*) from company_classifications;` via `supabase db execute` or the SQL editor — expect `0`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/012_company_classifications.sql
git commit -m "$(cat <<'EOF'
Add company_classifications table for sector/maturity enrichment

New table for the bulk Companies House classification pass — table
and its real SELECT policy in one migration, applying the lesson from
the 003->004/007->008/010->011 RLS-gap history documented in
HANDOVER.md Section 7 risk 13 proactively this time.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Shared sector/maturity bucketing config files

**Files:**
- Create: `shared/sic-sector-config.js`
- Create: `shared/company-maturity-config.js`
- Modify: `index.html` (shared-script `<script>` block, currently lines 585-591)

**Interfaces:**
- Produces: `SIC_SECTOR_BUCKETS`, `SIC_SECTOR_ORDER`, `SIC_SECTOR_COLORS`, `bucketSicSector(sicCodes)` (returns bucket name string, `"Other"`, or `null`). `bucketCompanyMaturity({ incorporated_on, accounts_type })` (returns `"Established"` / `"Newer"` / `"Dormant/Minimal"` / `null`), `MATURITY_ORDER`, `MATURITY_COLORS`. Both consumed by Task 5 (sidebar/filters) and Task 6 (popup tags/badges).

- [ ] **Step 1: Write `shared/sic-sector-config.js`**

```js
// SIC-derived business sector bucketing — groups a company's SIC 2007 codes
// (shared/sic-codes.js has the full code->description table) into a small
// set of sectors plausibly more energy-intensive than a typical office or
// retail unit, complementing the EPC-floor-area proxy with an independent
// signal. See docs/superpowers/specs/2026-08-20-company-sector-maturity-classification-design.md
// for the reasoning behind each grouping — spot-check against real matched
// companies before trusting broadly (same discipline as BUILDING_TYPE_BUCKETS,
// HANDOVER.md Section 7 risk 3).
const SIC_SECTOR_BUCKETS = {
  "Food & Drink Production":                  ["10", "11"],
  "Manufacturing (Materials & Chemicals)":     ["13", "14", "15", "16", "17", "19", "20", "21", "22", "23", "24", "25"],
  "Cold Storage, Warehousing & Waste":         ["38", "52"],
  "Data, IT & Telecoms":                       ["61", "63"],
  "Healthcare":                                ["86", "87"],
  "Hospitality & Leisure":                     ["55", "56", "93"],
  "Laundries & Industrial Cleaning":           ["96010", "8122"],
};
const SIC_SECTOR_ORDER = [...Object.keys(SIC_SECTOR_BUCKETS), "Other"];

// Prefix match on the raw 5-digit SIC code string — covers both 2-digit
// division-level entries (e.g. "10" matches "10110") and the two specific
// codes above that need finer granularity than their division.
function bucketSicSector(sicCodes) {
  if (!sicCodes || !sicCodes.length) return null; // no company/SIC data at all
  for (const [bucket, prefixes] of Object.entries(SIC_SECTOR_BUCKETS)) {
    if (sicCodes.some(code => prefixes.some(p => String(code).startsWith(p)))) return bucket;
  }
  return "Other";
}

const SIC_SECTOR_COLORS = {
  "Food & Drink Production":               "#c08438",
  "Manufacturing (Materials & Chemicals)":  "#5d8a64",
  "Cold Storage, Warehousing & Waste":     "#6f5b94",
  "Data, IT & Telecoms":                   "#3c6e91",
  "Healthcare":                            "#b85544",
  "Hospitality & Leisure":                 "#2f5a3d",
  "Laundries & Industrial Cleaning":       "#8e6b3f",
  "Other":                                 "#b9b9a9",
};
```

- [ ] **Step 2: Write `shared/company-maturity-config.js`**

```js
// Company maturity bucketing from Companies House data already fetched by
// company-lookup / classify-companies.mjs — an established, actively-filing
// company is a safer sales target than a dormant or newly-incorporated one.
// Threshold is a plain tunable constant, same convention as MIN_FLOOR_AREA_M2
// (scripts/ingest-epc.mjs) and MAX_ACTIVE_COMPANIES (company-lookup).
const MATURITY_ESTABLISHED_YEARS = 3;
const MATURITY_DORMANT_ACCOUNTS_TYPES = ["dormant", "micro-entity"];

function bucketCompanyMaturity(company) {
  const incorporatedOn = company && company.incorporated_on;
  if (!incorporatedOn) return null; // no company match / no incorporation data at all
  const accountsType = company.accounts_type;
  if (accountsType && MATURITY_DORMANT_ACCOUNTS_TYPES.includes(accountsType)) return "Dormant/Minimal";
  const years = (Date.now() - new Date(incorporatedOn).getTime()) / (365.25 * 24 * 60 * 60 * 1000);
  return years >= MATURITY_ESTABLISHED_YEARS ? "Established" : "Newer";
}

const MATURITY_ORDER = ["Established", "Newer", "Dormant/Minimal"];
const MATURITY_COLORS = {
  "Established":     "#5d8a64",
  "Newer":           "#c08438",
  "Dormant/Minimal": "#9a9a9a",
};
```

- [ ] **Step 3: Load both files in `index.html`**

In `index.html`, change:
```html
<script src="shared/solar-status-config.js"></script>
<script src="shared/epc-rating-config.js"></script>
<script src="shared/escape-html.js"></script>
<script src="shared/building-types.js"></script>
<script src="shared/sic-codes.js"></script>
<script src="shared/epc-recommendation-config.js"></script>
<script src="shared/contact-outcome-config.js"></script>
```
to:
```html
<script src="shared/solar-status-config.js"></script>
<script src="shared/epc-rating-config.js"></script>
<script src="shared/escape-html.js"></script>
<script src="shared/building-types.js"></script>
<script src="shared/sic-codes.js"></script>
<script src="shared/sic-sector-config.js"></script>
<script src="shared/company-maturity-config.js"></script>
<script src="shared/epc-recommendation-config.js"></script>
<script src="shared/contact-outcome-config.js"></script>
```

- [ ] **Step 4: Verify the bucket functions in a real browser**

Serve the repo locally (`npx serve . -l 5001`, background) and use the Playwright MCP tools to navigate to `http://localhost:5001/index.html`, then `browser_evaluate`:

```js
() => {
  const results = {};
  results.foodDrink = bucketSicSector(['10850']); // Manufacture of prepared meals
  results.dataCentre = bucketSicSector(['63110']); // Data processing, hosting
  results.laundry = bucketSicSector(['96010']);
  results.industrialCleaning = bucketSicSector(['81222']); // 8122x prefix
  results.office = bucketSicSector(['70229']); // Management consultancy -> Other
  results.noData = bucketSicSector([]);
  results.noDataNull = bucketSicSector(null);

  results.established = bucketCompanyMaturity({ incorporated_on: '2015-01-01', accounts_type: 'full' });
  results.newer = bucketCompanyMaturity({ incorporated_on: new Date().toISOString(), accounts_type: 'full' });
  results.dormant = bucketCompanyMaturity({ incorporated_on: '2015-01-01', accounts_type: 'dormant' });
  results.microEntity = bucketCompanyMaturity({ incorporated_on: new Date().toISOString(), accounts_type: 'micro-entity' });
  results.noIncorporationDate = bucketCompanyMaturity({ incorporated_on: null, accounts_type: 'full' });
  return results;
}
```

Expected: `foodDrink: "Food & Drink Production"`, `dataCentre: "Data, IT & Telecoms"`, `laundry: "Laundries & Industrial Cleaning"`, `industrialCleaning: "Laundries & Industrial Cleaning"`, `office: "Other"`, `noData: null`, `noDataNull: null`, `established: "Established"`, `newer: "Newer"`, `dormant: "Dormant/Minimal"`, `microEntity: "Dormant/Minimal"`, `noIncorporationDate: null`. Fix and re-run if any value doesn't match before continuing. Stop the local server and close the browser afterward.

- [ ] **Step 5: Commit**

```bash
git add shared/sic-sector-config.js shared/company-maturity-config.js index.html
git commit -m "$(cat <<'EOF'
Add SIC sector and company maturity bucketing config files

Client-side-only bucketing (same pattern as BUILDING_TYPE_BUCKETS) so
the sector/maturity groupings can be retuned later without touching
the classification pipeline or re-running anything. Verified against
fixture data in a real browser before wiring into any UI.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Extend `company-lookup` with `accounts_type`

**Files:**
- Modify: `supabase/functions/company-lookup/index.ts` (`CompanyMatch` type, `fetchProfile()`, the `matches.push({...})` call)

**Interfaces:**
- Produces: `CompanyMatch.accounts_type: string | null`, so the frontend's Companies tab (Task 6) can bucket maturity per individual company, not just the one building-level record.

- [ ] **Step 1: Add `accounts_type` to the `CompanyMatch` type**

Change:
```ts
type CompanyMatch = {
  company_name: string
  company_number: string
  status: string
  officers: Officer[]
  psc: Psc[]
  sic_codes: string[]
  incorporated_on: string | null
  address_match: boolean
}
```
to:
```ts
type CompanyMatch = {
  company_name: string
  company_number: string
  status: string
  officers: Officer[]
  psc: Psc[]
  sic_codes: string[]
  incorporated_on: string | null
  accounts_type: string | null
  address_match: boolean
}
```

- [ ] **Step 2: Parse `accounts_type` in `fetchProfile()`**

Change:
```ts
async function fetchProfile(companyNumber: string): Promise<{ sic_codes: string[]; incorporated_on: string | null; ok: boolean }> {
  const resp = await fetch(
    `https://api.company-information.service.gov.uk/company/${companyNumber}`,
    { headers: authHeader() },
  )
  if (!resp.ok) return { sic_codes: [], incorporated_on: null, ok: false }
  const json = await resp.json()
  return {
    sic_codes: json.sic_codes ?? [],
    incorporated_on: json.date_of_creation ?? null,
    ok: true,
  }
}
```
to:
```ts
async function fetchProfile(companyNumber: string): Promise<{ sic_codes: string[]; incorporated_on: string | null; accounts_type: string | null; ok: boolean }> {
  const resp = await fetch(
    `https://api.company-information.service.gov.uk/company/${companyNumber}`,
    { headers: authHeader() },
  )
  if (!resp.ok) return { sic_codes: [], incorporated_on: null, accounts_type: null, ok: false }
  const json = await resp.json()
  return {
    sic_codes: json.sic_codes ?? [],
    incorporated_on: json.date_of_creation ?? null,
    // Unverified field path — Companies House's own docs describe this shape,
    // but confirm against a real profile response early (Task 7 of this plan)
    // before trusting it broadly. Same caution already applied to
    // classifyDetection() (solar-enrichment) and the PSC statement-filtering
    // logic just below in this same file.
    accounts_type: json.accounts?.last_accounts?.type ?? null,
    ok: true,
  }
}
```

- [ ] **Step 3: Include it in the pushed match**

Change:
```ts
      matches.push({
        company_name: r.title,
        company_number: r.company_number,
        status: r.company_status,
        officers: officers.items,
        psc: psc.items,
        sic_codes: profile.sic_codes,
        incorporated_on: profile.incorporated_on,
        address_match: r.address_match,
      })
```
to:
```ts
      matches.push({
        company_name: r.title,
        company_number: r.company_number,
        status: r.company_status,
        officers: officers.items,
        psc: psc.items,
        sic_codes: profile.sic_codes,
        incorporated_on: profile.incorporated_on,
        accounts_type: profile.accounts_type,
        address_match: r.address_match,
      })
```

- [ ] **Step 4: Deploy**

Run: `supabase functions deploy company-lookup`

Expected: deploy succeeds (this is a strictly additive field — existing frontend code ignores it until Task 6, so it's safe to deploy independently of frontend changes).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/company-lookup/index.ts
git commit -m "$(cat <<'EOF'
Add accounts_type to company-lookup's CompanyMatch

Companies House's own profile response (already fetched for every
match) carries accounts-filing status; company-lookup just wasn't
parsing it. Needed so the popup's Companies tab can badge maturity
per individual company, not only the one building-level classification
from the new bulk pipeline (see Task 6).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Bulk classification script

**Files:**
- Create: `scripts/classify-companies.mjs`
- Modify: `package.json` (`scripts`)

**Interfaces:**
- Produces: rows in `company_classifications` (Task 1's table). Standalone script, no other file imports from it.
- Consumes: `COMPANIES_HOUSE_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` env vars.

- [ ] **Step 1: Write `scripts/classify-companies.mjs`**

```js
#!/usr/bin/env node
// Bulk-classify every prospect's most-relevant matched company by SIC codes,
// incorporation date, and accounts-filing status — powers the sector/maturity
// sidebar filters and popup tags (shared/sic-sector-config.js,
// shared/company-maturity-config.js). See
// docs/superpowers/specs/2026-08-20-company-sector-maturity-classification-design.md
// for why this is a plain script (Companies House has no monthly cap, only a
// rate limit, so unlike solar-enrichment this can run to completion in one
// long sitting instead of needing repeated manual invocations over months).
//
// Usage:
//   COMPANIES_HOUSE_API_KEY=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/classify-companies.mjs
//
// Idempotent: only processes prospects with no existing company_classifications
// row, so an interrupted run can just be re-started with no special resume logic.

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const COMPANIES_HOUSE_API_KEY   = process.env.COMPANIES_HOUSE_API_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !COMPANIES_HOUSE_API_KEY) {
  throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / COMPANIES_HOUSE_API_KEY env vars');
}
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ─── Tunables ──────────────────────────────────────────────────────────────

// Companies House free tier: 600 requests/5 min (~2/sec sustained). 600ms
// between calls targets ~1.67/sec — comfortable margin, not the ceiling.
const SLEEP_MS = 600;
const MAX_RATE_LIMIT_RETRIES = 5;
const RATE_LIMIT_BACKOFF_MS = 30_000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Companies House helpers (verbatim port of company-lookup/index.ts's
// pure ranking logic — already exercised by that function; not shared
// cross-runtime between Deno and Node, see the design spec's Non-goals) ────

function normalizePostcode(pc) {
  return pc.trim().toUpperCase().replace(/\s+/g, '');
}

function leadingNumber(text) {
  const m = typeof text === 'string' ? text.match(/\d+/) : null;
  return m ? parseInt(m[0], 10) : null;
}

function isAddressMatch(prospectAddress, candidate) {
  const prospectToken = prospectAddress.split(',')[0];
  const chToken = candidate.address?.premises || candidate.address?.address_line_1;
  const prospectNumber = leadingNumber(prospectToken);
  const chNumber = leadingNumber(chToken);
  return prospectNumber !== null && chNumber !== null && prospectNumber === chNumber;
}

function rankByAddressMatch(prospectAddress, candidates) {
  return candidates
    .map(c => ({ ...c, address_match: isAddressMatch(prospectAddress, c) }))
    .sort((a, b) => Number(b.address_match) - Number(a.address_match));
}

function authHeader() {
  return { Authorization: 'Basic ' + btoa(COMPANIES_HOUSE_API_KEY + ':') };
}

async function fetchWithRateLimitRetry(url, options) {
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    const resp = await fetch(url, options);
    if (resp.status !== 429) return resp;
    console.warn(`  rate limited, backing off ${RATE_LIMIT_BACKOFF_MS}ms (attempt ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES})`);
    await sleep(RATE_LIMIT_BACKOFF_MS);
  }
  throw new Error('RATE_LIMITED_RETRIES_EXHAUSTED');
}

async function searchCompaniesHouse(postcode) {
  const url = new URL('https://api.company-information.service.gov.uk/search/companies');
  url.searchParams.set('q', postcode);
  url.searchParams.set('items_per_page', '20');
  const resp = await fetchWithRateLimitRetry(url, { headers: authHeader() });
  await sleep(SLEEP_MS);
  if (!resp.ok) throw new Error(`Companies House search failed: ${resp.status}`);
  const json = await resp.json();
  return json.items ?? [];
}

async function fetchProfile(companyNumber) {
  const resp = await fetchWithRateLimitRetry(
    `https://api.company-information.service.gov.uk/company/${companyNumber}`,
    { headers: authHeader() },
  );
  await sleep(SLEEP_MS);
  if (!resp.ok) return null;
  const json = await resp.json();
  return {
    sic_codes: json.sic_codes ?? [],
    incorporated_on: json.date_of_creation ?? null,
    accounts_type: json.accounts?.last_accounts?.type ?? null, // unverified path, see Task 3
  };
}

// ─── Step 1: find prospects still needing classification ──────────────────

async function fetchPendingProspects() {
  const PAGE = 1000;
  const prospects = [];
  let from = 0;
  while (true) {
    const { data, error } = await db.from('prospects')
      .select('id, address, postcode')
      .not('postcode', 'is', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(JSON.stringify(error));
    prospects.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }

  const classified = new Set();
  from = 0;
  while (true) {
    const { data, error } = await db.from('company_classifications')
      .select('prospect_id')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(JSON.stringify(error));
    data.forEach(row => classified.add(row.prospect_id));
    if (data.length < PAGE) break;
    from += PAGE;
  }

  const pending = prospects.filter(p => !classified.has(p.id));
  console.log(`${prospects.length} prospects with a postcode, ${classified.size} already classified, ${pending.length} pending`);
  return pending;
}

// ─── Step 2: classify one prospect ─────────────────────────────────────────

async function classifyOne(prospect) {
  const normalizedTarget = normalizePostcode(prospect.postcode);
  let results;
  try {
    results = await searchCompaniesHouse(prospect.postcode);
  } catch (e) {
    console.error(`  ${prospect.id}: search failed, skipping (will retry on next run) — ${e.message}`);
    return;
  }

  const activeMatches = results.filter(r =>
    r.address?.postal_code &&
    normalizePostcode(r.address.postal_code) === normalizedTarget &&
    r.company_status === 'active'
  );

  if (activeMatches.length === 0) {
    const { error } = await db.from('company_classifications')
      .upsert({ prospect_id: prospect.id, no_match: true }, { onConflict: 'prospect_id' });
    if (error) console.error(`  ${prospect.id}: no-match upsert failed — ${JSON.stringify(error)}`);
    return;
  }

  const top = rankByAddressMatch(prospect.address || '', activeMatches)[0];
  const profile = await fetchProfile(top.company_number);
  if (!profile) {
    console.error(`  ${prospect.id}: profile fetch failed, skipping (will retry on next run)`);
    return;
  }

  const { error } = await db.from('company_classifications').upsert({
    prospect_id: prospect.id,
    no_match: false,
    company_name: top.title,
    company_number: top.company_number,
    sic_codes: profile.sic_codes,
    incorporated_on: profile.incorporated_on,
    accounts_type: profile.accounts_type,
  }, { onConflict: 'prospect_id' });
  if (error) console.error(`  ${prospect.id}: upsert failed — ${JSON.stringify(error)}`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const pending = await fetchPendingProspects();
  for (let i = 0; i < pending.length; i++) {
    await classifyOne(pending[i]);
    if ((i + 1) % 100 === 0) console.log(`  ${i + 1}/${pending.length} processed`);
  }
  console.log('Done.');
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Add the npm script**

In `package.json`, change:
```json
  "scripts": {
    "ingest": "node scripts/ingest-epc.mjs",
    "geocode": "node scripts/geocode-postcodes.mjs",
    "ingest-recommendations": "node scripts/ingest-epc-recommendations.mjs",
    "ingest-business-rates": "node scripts/ingest-business-rates.mjs"
  },
```
to:
```json
  "scripts": {
    "ingest": "node scripts/ingest-epc.mjs",
    "geocode": "node scripts/geocode-postcodes.mjs",
    "ingest-recommendations": "node scripts/ingest-epc-recommendations.mjs",
    "ingest-business-rates": "node scripts/ingest-business-rates.mjs",
    "classify-companies": "node scripts/classify-companies.mjs"
  },
```

- [ ] **Step 3: Commit**

Don't run it yet — Task 7 does a controlled first run as part of end-to-end verification.

```bash
git add scripts/classify-companies.mjs package.json
git commit -m "$(cat <<'EOF'
Add classify-companies.mjs bulk classification script

Standalone script (not an edge function — Companies House has no
monthly cap unlike Solar API, so this runs to completion in one long
sitting instead of needing repeated manual invocations). Ports the
same building-relevance ranking already proven in company-lookup.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Frontend — sidebar filters

**Files:**
- Modify: `index.html` (`fetchAllProspects()`, `initMap()`, state variables, new chip builders, `applyFilters()`, `reset` handler, sidebar HTML)

**Interfaces:**
- Consumes: `bucketSicSector`, `SIC_SECTOR_ORDER`, `SIC_SECTOR_COLORS`, `bucketCompanyMaturity`, `MATURITY_ORDER`, `MATURITY_COLORS` (Task 2).
- Produces: `d._sicSector`, `d._maturity` precomputed per prospect (consumed by Task 6's popup tags too).

- [ ] **Step 1: Extend the query**

In `fetchAllProspects()`, change the `.select(...)` string to add `company_classifications(company_name, sic_codes, incorporated_on, accounts_type, no_match)` alongside the existing `business_rates_matches(hereditaments, no_match)` embed.

- [ ] **Step 2: Precompute buckets in `initMap()`**

Where `d._bucket = bucketPropertyType(d.property_type);` and `d._maxRateable = maxHereditamentValue(d);` are set, add:
```js
    d._sicSector = bucketSicSector(d.company_classifications?.sic_codes);
    d._maturity = bucketCompanyMaturity(d.company_classifications || {});
```

- [ ] **Step 3: Add sidebar HTML sections**

After the existing "EPC rating" section and before "Solar status" (or another sensible spot near the other categorical chip filters), add:
```html
  <div class="section">
    <h3>Business sector</h3>
    <div id="sic-sector-list" class="chip-list"></div>
  </div>

  <div class="section">
    <h3>Company maturity</h3>
    <div id="maturity-list" class="chip-list"></div>
  </div>
```

- [ ] **Step 4: Add state variables**

Alongside `let activeRatings = new Set(EPC_RATING_ORDER);`, add:
```js
let activeSicSectors = new Set(SIC_SECTOR_ORDER);
let activeMaturities = new Set(MATURITY_ORDER);
```

- [ ] **Step 5: Add chip builders**

Modeled directly on `buildEpcRatingChips`:
```js
function buildSicSectorChips(data) {
  const counts = {};
  data.forEach(d => { if (d._sicSector) counts[d._sicSector] = (counts[d._sicSector] || 0) + 1; });
  const el = document.getElementById("sic-sector-list");
  SIC_SECTOR_ORDER.filter(s => counts[s]).forEach(sector => {
    const row = document.createElement("label");
    row.className = "chip on";
    row.innerHTML = `<input type="checkbox" checked data-sector="${sector}"/>
      <span class="dot" style="background:${SIC_SECTOR_COLORS[sector]}"></span>
      ${escapeHtml(sector)}<span class="chip-n">${counts[sector].toLocaleString()}</span>`;
    row.querySelector("input").addEventListener("change", e => {
      e.target.checked ? activeSicSectors.add(sector) : activeSicSectors.delete(sector);
      row.classList.toggle('on', e.target.checked);
      applyFilters();
    });
    el.appendChild(row);
  });
}

function buildMaturityChips(data) {
  const counts = {};
  data.forEach(d => { if (d._maturity) counts[d._maturity] = (counts[d._maturity] || 0) + 1; });
  const el = document.getElementById("maturity-list");
  MATURITY_ORDER.filter(m => counts[m]).forEach(maturity => {
    const row = document.createElement("label");
    row.className = "chip on";
    row.innerHTML = `<input type="checkbox" checked data-maturity="${maturity}"/>
      <span class="dot" style="background:${MATURITY_COLORS[maturity]}"></span>
      ${escapeHtml(maturity)}<span class="chip-n">${counts[maturity].toLocaleString()}</span>`;
    row.querySelector("input").addEventListener("change", e => {
      e.target.checked ? activeMaturities.add(maturity) : activeMaturities.delete(maturity);
      row.classList.toggle('on', e.target.checked);
      applyFilters();
    });
    el.appendChild(row);
  });
}
```

- [ ] **Step 6: Call the new builders in `initMap()`**

Alongside the existing `buildBuildingTypeChips(data); buildEpcRatingChips(data); buildSolarStatusChips(data);`, add:
```js
  buildSicSectorChips(data);
  buildMaturityChips(data);
```

- [ ] **Step 7: Add filter conditions in `applyFilters()`**

Alongside `const ratingOk = !d.epc_rating || activeRatings.has(d.epc_rating);`, add:
```js
    const sectorOk = !d._sicSector || activeSicSectors.has(d._sicSector);
    const maturityOk = !d._maturity || activeMaturities.has(d._maturity);
```
and add `sectorOk && maturityOk` to the big `if (...)` condition that gates `cluster.addLayer(m)`.

- [ ] **Step 8: Handle in the `reset` button**

In the `reset` click handler, alongside `activeBuildingTypes = new Set(BUILDING_TYPE_ORDER); activeRatings = new Set(EPC_RATING_ORDER);`, add:
```js
  activeSicSectors = new Set(SIC_SECTOR_ORDER);
  activeMaturities = new Set(MATURITY_ORDER);
```
and extend the `document.querySelectorAll("#building-type-list input, #epc-rating-list input")` selector to also include `#sic-sector-list input, #maturity-list input`.

- [ ] **Step 9: Verify in a real browser**

Serve locally (`npx serve . -l 5001`) and, via Playwright `browser_evaluate`, construct a small fixture array of prospect-like objects with varying `company_classifications` values (matched/energy-sector, matched/other-sector, no_match, absent), call `initMap`-equivalent precompute logic directly (or just call `bucketSicSector`/`bucketCompanyMaturity` on the fixtures and assert the same expected values as Task 2's check), then confirm `buildSicSectorChips`/`buildMaturityChips` populate `#sic-sector-list`/`#maturity-list` with the right counts and that toggling a chip's checkbox updates `activeSicSectors`/`activeMaturities` as expected. Stop the server and close the browser afterward.

- [ ] **Step 10: Commit**

```bash
git add index.html
git commit -m "$(cat <<'EOF'
Add sector/maturity sidebar filters

Same chip-list pattern as Building Type/EPC Rating — instant
client-side filtering once company_classifications data exists for a
prospect, with null (no data) passing through untouched rather than
being hidden by an active filter selection.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Frontend — popup tags and Companies tab badges

**Files:**
- Modify: `index.html` (`buildPopup()`, `loadCompanyMatch()`)

**Interfaces:**
- Consumes: `d._sicSector`/`d._maturity` (Task 5), `c.sic_codes`/`c.incorporated_on`/`c.accounts_type` from the `company-lookup` response (Task 3).

- [ ] **Step 1: Add building-level tags to the popup header**

In `buildPopup()`, alongside the existing `solarRecTag`/`efficiencyRecTag` construction, add:
```js
  const sectorTag = (d._sicSector && d._sicSector !== 'Other')
    ? `<span class="tag"><span class="tag-dot" style="background:${SIC_SECTOR_COLORS[d._sicSector]}"></span>${escapeHtml(d._sicSector)}</span>`
    : '';
  const maturityTag = d._maturity
    ? `<span class="tag"><span class="tag-dot" style="background:${MATURITY_COLORS[d._maturity]}"></span>${escapeHtml(d._maturity)}</span>`
    : '';
```
and add `${sectorTag}${maturityTag}` to the `<div class="tags">...</div>` line, after the existing tags.

- [ ] **Step 2: Add per-company badges in the Companies tab**

In `loadCompanyMatch()`'s `data.companies.map(c => {...})` block, alongside the existing `sicDesc`/`tradingSince`/`subline` computation, add:
```js
      const companySector = bucketSicSector(c.sic_codes);
      const companyMaturity = bucketCompanyMaturity(c);
      const sectorBadge = (companySector && companySector !== 'Other')
        ? `<span class="company-match-badge" style="color:${SIC_SECTOR_COLORS[companySector]};background:transparent;border:1px solid ${SIC_SECTOR_COLORS[companySector]}">${escapeHtml(companySector)}</span>`
        : '';
      const maturityBadge = companyMaturity
        ? `<span class="company-match-badge" style="color:${MATURITY_COLORS[companyMaturity]};background:transparent;border:1px solid ${MATURITY_COLORS[companyMaturity]}">${escapeHtml(companyMaturity)}</span>`
        : '';
```
and append `${sectorBadge}${maturityBadge}` after the existing `address_match` badge in the `company-name` div.

- [ ] **Step 3: Verify in a real browser**

Serve locally and, via Playwright `browser_evaluate`, call `buildPopup(fixture)` with a fixture carrying `company_classifications` data that resolves to a real (non-"Other") sector and a real maturity bucket, inject the result, and confirm both tags render in `.tags` with the expected text/color. Separately render a fake company card through the same badge-construction logic used in `loadCompanyMatch` (as done for the `address_match` badge check in the earlier popup-tabs work) and confirm both badges appear. Also confirm a fixture with `d._sicSector = 'Other'` and `d._maturity = null` renders **no** sector/maturity tags. Stop the server and close the browser afterward.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "$(cat <<'EOF'
Show sector/maturity on the popup — building-level tag and per-company badges

Header tags row shows the building-level classification (from the
bulk pipeline); the existing Companies tab now also badges sector and
maturity per individual company, using the same bucket functions fed
per-company data from company-lookup's on-demand response.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Deploy, run, and verify end-to-end

**Files:** none (deploy + run + verification only)

- [ ] **Step 1: Push all frontend/migration commits**

```bash
git push origin main
```

(`company-lookup` was already deployed in Task 3.)

- [ ] **Step 2: Verify the `accounts_type` field path against real data**

Before running the full classification pass, run `classify-companies.mjs` against a tiny slice to confirm `json.accounts?.last_accounts?.type` is really what Companies House returns — e.g., temporarily point it at a handful of known real companies (or just let it run for ~30-60 seconds and inspect the first several rows written to `company_classifications` via the Supabase SQL editor: `select company_name, accounts_type, incorporated_on from company_classifications order by fetched_at desc limit 20;`). Confirm `accounts_type` values look like real Companies House filing categories (`full`, `small`, `micro-entity`, `dormant`, etc.), not all-null. If they're all null, the field path is wrong — fix `fetchProfile()` in both `company-lookup/index.ts` (Task 3) and `classify-companies.mjs` (Task 4) against a real response body before continuing.

- [ ] **Step 3: Start the full run in the background**

```bash
COMPANIES_HOUSE_API_KEY=<key> SUPABASE_URL=<url> SUPABASE_SERVICE_ROLE_KEY=<key> npm run classify-companies
```

Run this in the background (`run_in_background: true` if launched via the agent's Bash tool) — expect ~6-8 hours for the full 21,808-prospect pass. It's safe to let it keep running unattended; progress logs every 100 prospects, and re-running the same command later (if interrupted) picks up where it left off.

- [ ] **Step 4: Spot-check the SIC sector buckets against real data**

Once a meaningful number of rows exist (a few hundred is enough), query 10-15 real classified companies spanning a few different buckets (`select company_name, sic_codes from company_classifications where sic_codes is not null order by random() limit 15;`) and manually sanity-check that `bucketSicSector` on those real SIC code arrays lands in a sensible bucket. Adjust `shared/sic-sector-config.js`'s groupings if something looks clearly wrong — this is a pure client-side config change, no re-run of the pipeline needed.

- [ ] **Step 5: Live-verify the frontend once real data exists**

Report back to the user with this checklist to run against the live site once the background run has produced enough real data (doesn't need to be 100% complete):
- Sidebar "Business sector" and "Company maturity" chip counts look plausible and non-zero.
- Opening a prospect popup with a classified match shows the expected header tags.
- The Companies tab's per-company badges are consistent with the building-level tag for whichever company is flagged "Likely this building".
- A prospect with `no_match: true` or no classification row yet shows no sector/maturity tags and isn't hidden by either filter's default (all-selected) state.

- [ ] **Step 6: Update `HANDOVER.md`**

Add a short entry (matching the style of the existing Companies House / popup-tabs entries in Section 6, plus a `## Data Pipeline` Step 7 note in Section 4 alongside the existing Steps 1-6) documenting: the new `company_classifications` table and `classify-companies.mjs` script, that it's a long-running one-time-ish pass (not a monthly-capped batch like solar), the 3-year "Established" threshold, and — until the background run finishes — that most prospects will show no sector/maturity tags yet, same "expected, not a bug" framing already used for the EPC recommendations rollout. Commit and push.

```bash
git add HANDOVER.md
git commit -m "$(cat <<'EOF'
Document company sector/maturity classification in HANDOVER.md

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
git push origin main
```

---

## Self-Review Notes

- **Spec coverage:** every Goal in the design spec maps to a task — classification pipeline (Tasks 1, 4), sidebar filters (Task 5), popup tags + per-company badges (Task 6), reuse of the existing address-ranking (Task 4 ports it verbatim, Task 3 keeps `company-lookup`'s own copy as the source of truth for the popup path). Non-goals are respected: no `api_usage`-style table, no cross-runtime shared module, no server-side bucket logic, no changes to `company_lookups`' own RLS.
- **Placeholder scan:** no TBD/TODO; every step has literal, complete code.
- **Type consistency:** `sic_codes`/`incorporated_on`/`accounts_type`/`company_name`/`company_number`/`no_match` field names are identical across the migration (Task 1), `classify-companies.mjs`'s upsert (Task 4), `company-lookup`'s `CompanyMatch` (Task 3), and the frontend's reads (Tasks 5-6). `bucketSicSector`/`bucketCompanyMaturity` signatures match between their definition (Task 2) and every call site (Tasks 5-6).
- **Operational note carried into Task 7:** unlike every other task in this plan, Task 7's Step 3 is intentionally long-running (hours) and not something to wait on synchronously — the plan's execution should treat it as a background process and move on to reporting/wrap-up rather than blocking.
