# Decision-Maker Contact Enablement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give reps, for any prospect they open on the map, a free Companies House company/director match and an honest "why this building" talking-points summary — both usable without any new billing.

**Architecture:** A new on-demand Supabase Edge Function (`company-lookup`) calls Companies House's free API, caches results in a new `company_lookups` table, and is invoked from the frontend when a prospect's popup opens. A separate, pure client-side module (`shared/talking-points.js`) builds the talking points from data already fetched. Both slot into the existing `buildPopup()` function in `index.html`.

**Tech Stack:** Same as the rest of the repo — plain HTML/CSS/JS (no build tool), Deno Edge Functions, Postgres/Supabase, Leaflet.

## Global Constraints

- This repo has **no automated test framework** (`package.json` has no `test` script, no `*.test.*` files exist). Every task's verification step is a **live check** (curl against the deployed function, or a real browser check), matching how `solar-enrichment` and the Azure AD work were verified elsewhere in this project — do not invent a test runner or fabricate a testing library that isn't already part of this codebase.
- No £/financial estimates anywhere in this feature — only real data already stored on the `prospects` row (EPC rating/efficiency, floor area, actual `solar_max_panels`/`solar_yearly_energy_kwh`). This was an explicit decision during design (see `docs/superpowers/specs/2026-08-17-decision-maker-contact-design.md`, "Non-goals").
- Never scrape or link to automated LinkedIn data extraction — the LinkedIn link added in this plan is a **manual search link for a human to click**, not an API call.
- Follow existing code conventions exactly: `escapeHtml()` from `shared/escape-html.js` wraps every piece of dynamic text injected into HTML (existing precedent: `buildPopup()` escapes even enum-like values such as the building-type bucket — match that same defensive style, don't selectively skip escaping because a value "looks safe").
- Match existing CSS custom properties already defined in `index.html`'s `:root` block — do not invent new ones. Relevant ones: `--text`, `--text2`, `--text3`, `--border`, `--accent`, `--accentDim`, `--accentDk`, `--surface2`.

---

### Task 1: `company-lookup` Edge Function + `company_lookups` table

**Files:**
- Create: `supabase/migrations/006_company_lookups.sql`
- Create: `supabase/functions/company-lookup/index.ts`

**Interfaces:**
- Produces: an HTTP POST endpoint (deployed as a Supabase Edge Function named `company-lookup`) accepting JSON body `{ prospect_id: string, postcode: string }` and returning JSON `{ companies: CompanyMatch[], no_match: boolean, cached: boolean }` on success (HTTP 200), or `{ error: string }` on failure (HTTP 400/429/500/502), where:
  ```ts
  type Officer = { name: string; role: string }
  type CompanyMatch = { company_name: string; company_number: string; status: string; officers: Officer[] }
  ```
  Task 3 (frontend integration) consumes this exact shape via `window.db.functions.invoke('company-lookup', { body: { prospect_id, postcode } })`.
- Produces: a new Postgres table `company_lookups`, written only by this function via the service-role key (no client access, matching the `api_usage` table pattern from migration `005`).
- Consumes: a new secret `COMPANIES_HOUSE_API_KEY` (must be set on the Supabase project before this function will work — free registration at `developer.company-information.service.gov.uk`, no billing required, unlike the Google keys).

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/006_company_lookups.sql`:

```sql
-- Free, on-demand Companies House lookup per prospect, cached so repeat
-- opens of the same prospect don't re-hit the external API. Written only
-- by the company-lookup Edge Function via the service-role key.
create table if not exists company_lookups (
  prospect_id uuid primary key references prospects(id) on delete cascade,
  fetched_at timestamptz not null default now(),
  source text not null default 'companies_house', -- 'companies_house' | 'ai_agent' (future, deferred)
  companies jsonb not null default '[]'::jsonb,
  -- companies: [{ company_name, company_number, status, officers: [{ name, role }] }]
  no_match boolean not null default false
);

alter table company_lookups enable row level security;
-- No policies: only the service-role key (used by company-lookup) reads/writes this table.
```

- [ ] **Step 2: Push the migration**

Run:
```
supabase db push
```
Confirm the prompt lists `006_company_lookups.sql` and accept it.

- [ ] **Step 3: Verify the table exists**

Run (replace `<service-role-key>` with the project's real key, available via `supabase projects api-keys --project-ref gkvropheqktytghmiwgp`):
```
curl -s "https://gkvropheqktytghmiwgp.supabase.co/rest/v1/company_lookups?limit=1" \
  -H "apikey: <service-role-key>" -H "Authorization: Bearer <service-role-key>"
```
Expected: `[]` (empty array, not a "relation does not exist" error).

- [ ] **Step 4: Write the Edge Function**

Create `supabase/functions/company-lookup/index.ts`:

```ts
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const COMPANIES_HOUSE_API_KEY   = Deno.env.get('COMPANIES_HOUSE_API_KEY')!

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !COMPANIES_HOUSE_API_KEY) {
  throw new Error('Missing required secrets — check SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, COMPANIES_HOUSE_API_KEY')
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// Companies House allows this to be re-checked periodically without ever
// exceeding the free rate limit (600 req/5 min) in an on-demand,
// per-prospect-click usage pattern — no monthly cap needed, unlike Solar API.
const CACHE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000 // 90 days
const MAX_ACTIVE_COMPANIES = 5

type Officer = { name: string; role: string }
type CompanyMatch = { company_name: string; company_number: string; status: string; officers: Officer[] }

function normalizePostcode(pc: string): string {
  return pc.trim().toUpperCase().replace(/\s+/g, '')
}

function authHeader(): HeadersInit {
  return { Authorization: 'Basic ' + btoa(COMPANIES_HOUSE_API_KEY + ':') }
}

// deno-lint-ignore no-explicit-any
async function searchCompaniesHouse(postcode: string): Promise<any[]> {
  const url = new URL('https://api.company-information.service.gov.uk/search/companies')
  url.searchParams.set('q', postcode)
  url.searchParams.set('items_per_page', '20')

  const resp = await fetch(url, { headers: authHeader() })
  if (resp.status === 429) throw new Error('RATE_LIMITED')
  if (!resp.ok) throw new Error(`Companies House search failed: ${resp.status}`)

  const json = await resp.json()
  return json.items ?? []
}

async function fetchOfficers(companyNumber: string): Promise<Officer[]> {
  const resp = await fetch(
    `https://api.company-information.service.gov.uk/company/${companyNumber}/officers`,
    { headers: authHeader() },
  )
  // Don't fail the whole lookup if one company's officers can't be fetched —
  // an empty officers list is still a useful company-name match.
  if (!resp.ok) return []
  const json = await resp.json()
  // deno-lint-ignore no-explicit-any
  return (json.items ?? [])
    .filter((o: any) => !o.resigned_on)
    // deno-lint-ignore no-explicit-any
    .map((o: any) => ({ name: o.name as string, role: o.officer_role as string }))
}

Deno.serve(async (req) => {
  let body: { prospect_id?: string; postcode?: string }
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400 })
  }

  const { prospect_id, postcode } = body
  if (!prospect_id || !postcode) {
    return new Response(JSON.stringify({ error: 'prospect_id and postcode are required' }), { status: 400 })
  }

  const { data: cached, error: cacheErr } = await db
    .from('company_lookups')
    .select('companies, no_match, fetched_at')
    .eq('prospect_id', prospect_id)
    .maybeSingle()

  if (cacheErr) {
    console.error('Cache read failed:', JSON.stringify(cacheErr))
    return new Response(JSON.stringify({ error: 'Cache read failed' }), { status: 500 })
  }

  if (cached && Date.now() - new Date(cached.fetched_at).getTime() < CACHE_MAX_AGE_MS) {
    return new Response(JSON.stringify({ companies: cached.companies, no_match: cached.no_match, cached: true }), { status: 200 })
  }

  const matches: CompanyMatch[] = []
  try {
    const normalizedTarget = normalizePostcode(postcode)
    const results = await searchCompaniesHouse(postcode)
    // deno-lint-ignore no-explicit-any
    const activeMatches = results.filter((r: any) =>
      r.address?.postal_code &&
      normalizePostcode(r.address.postal_code) === normalizedTarget &&
      r.company_status === 'active'
    ).slice(0, MAX_ACTIVE_COMPANIES)

    for (const r of activeMatches) {
      const officers = await fetchOfficers(r.company_number)
      matches.push({ company_name: r.title, company_number: r.company_number, status: r.company_status, officers })
    }
  } catch (e) {
    if (e instanceof Error && e.message === 'RATE_LIMITED') {
      return new Response(JSON.stringify({ error: 'Companies House rate limited — try again shortly' }), { status: 429 })
    }
    console.error('Companies House lookup failed:', e)
    return new Response(JSON.stringify({ error: 'Lookup failed' }), { status: 502 })
  }

  const noMatch = matches.length === 0

  const { error: upsertErr } = await db
    .from('company_lookups')
    .upsert(
      { prospect_id, companies: matches, no_match: noMatch, fetched_at: new Date().toISOString() },
      { onConflict: 'prospect_id' },
    )
  if (upsertErr) console.error('Cache write failed:', JSON.stringify(upsertErr))

  return new Response(JSON.stringify({ companies: matches, no_match: noMatch, cached: false }), { status: 200 })
})
```

- [ ] **Step 5: Deploy**

Run:
```
supabase functions deploy company-lookup
```

- [ ] **Step 6: Set the Companies House secret**

Register a free key at `https://developer.company-information.service.gov.uk/` (create an application → REST API key), then:
```
supabase secrets set COMPANIES_HOUSE_API_KEY=<the key>
```
If the key isn't available yet, note this blocker and continue to Step 7's negative-path check (missing-key behavior is still verifiable).

- [ ] **Step 7: Verify live**

Pick a real prospect's postcode from the `prospects` table (e.g. via the Supabase SQL editor: `select id, postcode from prospects where postcode is not null limit 1;`), then:
```
curl -s -X POST "https://gkvropheqktytghmiwgp.supabase.co/functions/v1/company-lookup" \
  -H "Authorization: Bearer <service-role-key>" -H "Content-Type: application/json" \
  -d '{"prospect_id":"<real-id>","postcode":"<real-postcode>"}'
```
Expected: HTTP 200 with `{ companies: [...], no_match: <bool>, cached: false }`. Run the exact same command again — expected: `cached: true` this time, confirming the cache path works. Cross-check one returned company name manually at `find-and-update.company-information.service.gov.uk` to confirm the postcode-matching logic is picking real, correct companies (not false positives from loose text matching).

- [ ] **Step 8: Commit**

```
git add supabase/migrations/006_company_lookups.sql supabase/functions/company-lookup/index.ts
git commit -m "Add company-lookup Edge Function with Companies House integration"
```

---

### Task 2: `shared/talking-points.js`

**Files:**
- Create: `shared/talking-points.js`

**Interfaces:**
- Consumes: a prospect row `d` with the same shape already used by `buildPopup()` in `index.html` — specifically `d.epc_rating`, `d.current_energy_efficiency` (not yet fetched by the frontend; added in Task 3), `d.floor_area`, `d.property_type`, `d.solar_status`, `d.solar_max_panels`, `d.solar_yearly_energy_kwh`. Also calls the existing global functions `bucketPropertyType(pt)` and `escapeHtml(s)`, both already defined elsewhere in `index.html`/`shared/escape-html.js` — safe to call at runtime since `buildTalkingPoints` is only ever invoked from within `buildPopup()`, long after those are defined, even though this file's `<script>` tag loads earlier in the document.
- Produces: `function buildTalkingPoints(d)` returning `string[]` — each string is **already HTML-safe** (any dynamic value inside has been escaped internally). Task 3 consumes this directly: `buildTalkingPoints(d).map(p => \`<li>${p}</li>\`).join('')` — no additional escaping needed by the caller.

- [ ] **Step 1: Write the file**

Create `shared/talking-points.js`:

```js
// Builds "why this building" talking points from real data already on the
// row — no invented figures (e.g. no £ savings estimate). Each returned
// string is already HTML-safe; callers should not re-escape it.
// See docs/superpowers/specs/2026-08-17-decision-maker-contact-design.md.
function buildTalkingPoints(d) {
  const points = [];

  if (d.epc_rating) {
    const goodBand = ['A', 'B', 'C'].includes(d.epc_rating);
    const tone = goodBand
      ? 'a relatively efficient building, but solar can still meaningfully offset ongoing energy spend'
      : 'below-average performing buildings this size often have real headroom for savings';
    const effPart = d.current_energy_efficiency
      ? ` (efficiency score ${escapeHtml(String(d.current_energy_efficiency))})`
      : '';
    points.push(`EPC rated ${escapeHtml(d.epc_rating)}${effPart} — ${tone}.`);
  }

  if (d.floor_area) {
    const bucket = bucketPropertyType(d.property_type);
    points.push(`${Math.round(d.floor_area).toLocaleString()} m² of ${escapeHtml(bucket.toLowerCase())} floor area — a proxy for electricity usage, not a measurement, but a useful opener on energy spend.`);
  }

  if (d.solar_status === 'prospect' && (d.solar_max_panels || d.solar_yearly_energy_kwh)) {
    const parts = [];
    if (d.solar_max_panels) parts.push(`up to ${escapeHtml(String(d.solar_max_panels))} panels`);
    if (d.solar_yearly_energy_kwh) parts.push(`~${Math.round(d.solar_yearly_energy_kwh).toLocaleString()} kWh/year generation potential`);
    points.push(`Google's aerial analysis estimates ${parts.join(' and ')} on this roof, with no existing solar detected.`);
  }

  points.push('Starting points for a conversation, not guarantees — worth confirming actual usage and roof condition directly.');

  return points;
}
```

- [ ] **Step 2: Verify in isolation**

There's no test framework in this repo, so verify by loading the function directly in a browser console. Run `npx serve .` (or open `index.html` directly), open the browser console, and paste:
```js
buildTalkingPoints({ epc_rating: 'D', current_energy_efficiency: 62, floor_area: 850, property_type: 'B1 Offices and Workshop businesses', solar_status: 'prospect', solar_max_panels: 40, solar_yearly_energy_kwh: 18500 })
```
Expected: an array of 4 strings, each free of unescaped `<`/`>`/`&` from the input, ending with the "Starting points for a conversation..." caveat line.

- [ ] **Step 3: Commit**

```
git add shared/talking-points.js
git commit -m "Add client-side talking-points generator"
```

---

### Task 3: Wire both into `index.html`

**Files:**
- Modify: `index.html`

**Interfaces:**
- Consumes: `company-lookup` Edge Function (Task 1) via `window.db.functions.invoke('company-lookup', { body: { prospect_id, postcode } })`, and `buildTalkingPoints(d)` (Task 2).

- [ ] **Step 1: Load the new script**

In `index.html`, find the existing shared-script block:
```html
<script src="shared/solar-status-config.js"></script>
<script src="shared/epc-rating-config.js"></script>
<script src="shared/escape-html.js"></script>
```
Add a new line immediately after `escape-html.js`:
```html
<script src="shared/talking-points.js"></script>
```

- [ ] **Step 2: Fetch the extra EPC field**

Find the `fetchAllProspects()` select call:
```js
.select('id, address, postcode, lat, lng, property_type, floor_area:total_floor_area, epc_rating:current_energy_rating, local_authority, solar_status, solar_max_panels, solar_yearly_energy_kwh')
```
Add `current_energy_efficiency` to the column list (no alias needed — the talking-points generator reads it under its real column name):
```js
.select('id, address, postcode, lat, lng, property_type, floor_area:total_floor_area, epc_rating:current_energy_rating, local_authority, solar_status, solar_max_panels, solar_yearly_energy_kwh, current_energy_efficiency')
```

- [ ] **Step 3: Add CSS for the new popup sections**

Find the existing popup CSS block ending with `.solar-est { ... }` (around the `.popup-facts p a { color: var(--accent); }` rule). Add immediately after the `.solar-est` block:
```css
.popup-section-label { font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--text3); margin: 0 20px 6px; }
.talking-points { margin: 4px 0; padding: 0 20px 14px; }
.talking-points ul { margin: 0; padding-left: 16px; font-size: 12px; color: var(--text2); line-height: 1.55; }
.talking-points li { padding: 2px 0; }
.company-match { margin: 4px 0 18px; padding: 0 20px; }
.company-match-body { font-size: 12px; color: var(--text2); }
.company-card { padding: 8px 0; border-top: 1px solid var(--border); }
.company-card:first-child { border-top: none; }
.company-card.dissolved { opacity: .55; }
.company-name { font-weight: 500; color: var(--text); }
.company-status { font-weight: 400; color: var(--text3); }
.company-officers { margin-top: 2px; color: var(--text2); }
.company-match-fallback { color: var(--text3); }
.company-match-links { display: flex; gap: 10px; margin-top: 6px; }
.company-match-links a { color: var(--accent); }
```

- [ ] **Step 4: Extend `buildPopup()`**

Find the end of `buildPopup()`:
```js
  return `
    <div class="popup">
      <div class="popup-header">
        <div class="popup-eyebrow">Commercial prospect</div>
        <div class="popup-name">${escapeHtml(d.address ? d.address.split(',')[0] : (d.postcode || 'Unnamed building'))}</div>
        ${d.postcode ? `<div class="popup-meta">${escapeHtml(d.postcode)}</div>` : ''}
        <div class="tags">${statusPill}${epcTag}${typeTag}</div>
      </div>
      ${solarEst}
      <div class="popup-facts">${addr}${area}${type}${la}</div>
    </div>`;
}
```
Replace it with:
```js
  const talkingPointsHtml = buildTalkingPoints(d).map(p => `<li>${p}</li>`).join('');

  return `
    <div class="popup">
      <div class="popup-header">
        <div class="popup-eyebrow">Commercial prospect</div>
        <div class="popup-name">${escapeHtml(d.address ? d.address.split(',')[0] : (d.postcode || 'Unnamed building'))}</div>
        ${d.postcode ? `<div class="popup-meta">${escapeHtml(d.postcode)}</div>` : ''}
        <div class="tags">${statusPill}${epcTag}${typeTag}</div>
      </div>
      ${solarEst}
      <div class="popup-facts">${addr}${area}${type}${la}</div>
      <div class="talking-points">
        <div class="popup-section-label">Talking points</div>
        <ul>${talkingPointsHtml}</ul>
      </div>
      <div class="company-match" id="company-match-${d.id}">
        <div class="popup-section-label">Company match</div>
        <div class="company-match-body">Looking up company registered at this address…</div>
      </div>
    </div>`;
}
```

- [ ] **Step 5: Add the company-lookup call and fallback renderer**

Find the marker click handler:
```js
marker.on('click', () => marker.bindPopup(buildPopup(d), { maxWidth: 320, autoPan: true }).openPopup());
```
Replace it with:
```js
marker.on('click', () => {
  marker.bindPopup(buildPopup(d), { maxWidth: 320, autoPan: true }).openPopup();
  loadCompanyMatch(d);
});
```
Immediately after the `buildPopup()` function (before `/* ── Init ── */`), add:
```js
/* ── Company lookup ──────────────────────────────────────── */
function companyMatchFallbackHtml(d) {
  const q = encodeURIComponent(d.postcode || d.address || '');
  return `
    <div class="company-match-fallback">
      No registered company match found. Try:
      <div class="company-match-links">
        <a href="https://www.google.com/search?q=${q}" target="_blank" rel="noopener">Google</a>
        <a href="https://find-and-update.company-information.service.gov.uk/search?q=${q}" target="_blank" rel="noopener">Companies House</a>
        <a href="https://www.linkedin.com/search/results/companies/?keywords=${q}" target="_blank" rel="noopener">LinkedIn</a>
      </div>
    </div>`;
}

async function loadCompanyMatch(d) {
  const container = document.getElementById(`company-match-${d.id}`);
  if (!container) return;

  if (!d.postcode) {
    container.querySelector('.company-match-body').innerHTML = companyMatchFallbackHtml(d);
    return;
  }

  try {
    const { data, error } = await window.db.functions.invoke('company-lookup', {
      body: { prospect_id: d.id, postcode: d.postcode },
    });

    // The popup may have closed (or a different one opened) while this was in flight.
    const el = document.getElementById(`company-match-${d.id}`);
    if (!el) return;

    if (error || !data || data.no_match || !data.companies?.length) {
      el.querySelector('.company-match-body').innerHTML = companyMatchFallbackHtml(d);
      return;
    }

    el.querySelector('.company-match-body').innerHTML = data.companies.map(c => `
      <div class="company-card ${c.status !== 'active' ? 'dissolved' : ''}">
        <div class="company-name">${escapeHtml(c.company_name)}${c.status !== 'active' ? ` <span class="company-status">· ${escapeHtml(c.status)} — likely not trading</span>` : ''}</div>
        ${c.officers?.length ? `<div class="company-officers">${c.officers.map(o => escapeHtml(o.name) + (o.role ? ` (${escapeHtml(o.role)})` : '')).join(', ')}</div>` : ''}
      </div>`).join('');
  } catch (e) {
    const el = document.getElementById(`company-match-${d.id}`);
    if (el) el.querySelector('.company-match-body').innerHTML = companyMatchFallbackHtml(d);
  }
}
```

- [ ] **Step 6: Verify live**

Serve the site (`npx serve .` locally, or push and use the live Pages URL) and, signed in, click a real marker on the map:
- Confirm "Talking points" renders immediately with the popup (no flash of missing content), showing sensible bullets for that building's real EPC/floor-area/solar data.
- Confirm "Company match" initially shows "Looking up company registered at this address…", then updates within a second or two to either a real company match or the fallback search-links block.
- Click a prospect known to have **no** registered company at its postcode — confirm the fallback links appear and are correctly pre-filled/clickable.
- Open two different prospects in a row quickly — confirm no stale data from the first prospect ever appears in the second one's "Company match" section (the `getElementById` re-check after the async call guards against this).

- [ ] **Step 7: Commit**

```
git add index.html
git commit -m "Wire Companies House lookup and talking points into the prospect popup"
```

---

### Task 4: Update `HANDOVER.md`

**Files:**
- Modify: `HANDOVER.md`

- [ ] **Step 1: Document the new feature**

Add a new subsection under Section 6 (Frontend), after the existing "Satellite imagery" subsection, describing: the `company-lookup` Edge Function and its on-demand/cached design, the new `company_lookups` table (add a matching entry under Section 5, Database Schema, next to the `api_usage` table), the `COMPANIES_HOUSE_API_KEY` secret requirement, and the deferred AI research-agent noted as future work under Section 8 (Not Yet Built) — cross-reference `docs/superpowers/specs/2026-08-17-decision-maker-contact-design.md` for full detail rather than duplicating it.

- [ ] **Step 2: Commit**

```
git add HANDOVER.md
git commit -m "Document Companies House lookup + talking points in HANDOVER.md"
```
