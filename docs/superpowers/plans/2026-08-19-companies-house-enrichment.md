# Companies House Enrichment (PSC, SIC, Incorporation Date) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing `company-lookup` Edge Function and prospect popup with three free Companies House fields — Persons with Significant Control (PSC), SIC industry codes, and incorporation date — so reps get a stronger "who to ask for" and "what do they do" signal than the officers list alone.

**Architecture:** `company-lookup/index.ts` gains two more Companies House API calls per matched company (profile, PSC), extending the existing `CompanyMatch` shape stored in the already-`jsonb` `company_lookups.companies` column — no migration needed. A new static `shared/sic-codes.js` (generated once from Companies House/ONS's real published SIC 2007 condensed list) maps raw SIC codes to descriptions client-side. `index.html`'s popup rendering gets a new "Significant control" sub-section and two new lines (SIC description, "Trading since `<year>`") on each company card.

**Tech Stack:** Deno (Supabase Edge Function), vanilla JS (frontend), Node one-off script for the SIC data generation step only (not shipped).

## Global Constraints

- No database migration — `company_lookups.companies` is already `jsonb`; the new fields (`psc`, `sic_codes`, `incorporated_on`) are additive to the existing per-company object shape.
- No new npm dependency beyond `csv-parse`, already in `package.json`, used only for the one-off SIC data generation (not runtime code).
- SIC code descriptions and PSC nature-of-control labels must come from Companies House's/ONS's real published data — never invented or approximated. Sources are pinned below in Task 2 and Task 3.
- Every new Companies House call must reuse the existing `authHeader()` helper and the existing 150ms courtesy-pacing pattern (`sleep(150)`) between external calls — do not introduce a second pacing convention.
- A failed profile or PSC call for one company must not fail that company's match or the whole lookup — mirrors the existing `fetchOfficers` behavior of returning `[]` on a non-OK response rather than throwing.
- Cached `company_lookups` rows written before this change lack the new fields. Frontend rendering must treat a missing `psc`/`sic_codes`/`incorporated_on` as "nothing to show" for that piece, not an error.
- This project has no automated test suite (confirmed: no test framework in `package.json`, no `*.test.*` files). Verification steps in this plan are manual (`curl`/`node -e`/live browser), matching the existing pattern used for `solar-enrichment` and the original `company-lookup` build.

---

### Task 1: Extend `company-lookup` with PSC and company-profile data

**Files:**
- Modify: `supabase/functions/company-lookup/index.ts`

**Interfaces:**
- Produces: `CompanyMatch` (returned by the function, stored in `company_lookups.companies`) grows three fields consumed by Task 3's frontend rendering:
  ```ts
  type Psc = { name: string; natures_of_control: string[]; is_corporate: boolean }
  // CompanyMatch also gains:
  //   psc: Psc[]
  //   sic_codes: string[]              // raw codes, zero-padded to 5 digits, e.g. "01110"
  //   incorporated_on: string | null   // ISO date, e.g. "2014-03-12"
  ```

- [ ] **Step 1: Add the `Psc` type and extend `CompanyMatch`**

In `supabase/functions/company-lookup/index.ts`, find:
```ts
type Officer = { name: string; role: string }
type CompanyMatch = { company_name: string; company_number: string; status: string; officers: Officer[] }
```
Replace with:
```ts
type Officer = { name: string; role: string }
type Psc = { name: string; natures_of_control: string[]; is_corporate: boolean }
type CompanyMatch = {
  company_name: string
  company_number: string
  status: string
  officers: Officer[]
  psc: Psc[]
  sic_codes: string[]
  incorporated_on: string | null
}
```

- [ ] **Step 2: Add `fetchProfile()` and `fetchPsc()` next to the existing `fetchOfficers()`**

Directly after the existing `fetchOfficers` function (ends with its closing `}` before `Deno.serve`), add:
```ts
async function fetchProfile(companyNumber: string): Promise<{ sic_codes: string[]; incorporated_on: string | null }> {
  const resp = await fetch(
    `https://api.company-information.service.gov.uk/company/${companyNumber}`,
    { headers: authHeader() },
  )
  if (!resp.ok) return { sic_codes: [], incorporated_on: null }
  const json = await resp.json()
  return {
    sic_codes: json.sic_codes ?? [],
    incorporated_on: json.date_of_creation ?? null,
  }
}

// deno-lint-ignore no-explicit-any
async function fetchPsc(companyNumber: string): Promise<Psc[]> {
  const resp = await fetch(
    `https://api.company-information.service.gov.uk/company/${companyNumber}/persons-with-significant-control`,
    { headers: authHeader() },
  )
  // Don't fail the whole lookup if PSC can't be fetched — mirrors fetchOfficers.
  if (!resp.ok) return []
  const json = await resp.json()
  // "Statement" items (e.g. "no individual or entity with significant
  // control") carry a `statement` field instead of `name` — filtering on
  // `name` presence excludes those without hardcoding Companies House's
  // exact statement `kind` strings, which aren't stable enough to trust
  // blindly. Spot-check this filter against a few real responses during
  // Task 1's verification step below (same caution this project already
  // applies to solar-enrichment's classifyDetection(), HANDOVER.md
  // Section 7 risk 4 — an unverified field-path guess that stores the raw
  // response so it can be corrected later without a second paid call).
  return (json.items ?? [])
    .filter((p: any) => typeof p.name === 'string' && !p.ceased_on)
    .map((p: any) => ({
      name: p.name as string,
      natures_of_control: (p.natures_of_control ?? []) as string[],
      is_corporate: typeof p.kind === 'string' && p.kind !== 'individual-person-with-significant-control',
    }))
}
```

- [ ] **Step 3: Wire the two new calls into the matches loop**

Find:
```ts
    for (let i = 0; i < activeMatches.length; i++) {
      const r = activeMatches[i]
      const officers = await fetchOfficers(r.company_number)
      matches.push({ company_name: r.title, company_number: r.company_number, status: r.company_status, officers })
      // Courtesy pacing between sequential external API calls, mirrors
      // solar-enrichment's sleep(150) between Google Solar API calls.
      if (i < activeMatches.length - 1) await sleep(150)
    }
```
Replace with:
```ts
    for (let i = 0; i < activeMatches.length; i++) {
      const r = activeMatches[i]
      const officers = await fetchOfficers(r.company_number)
      await sleep(150)
      const profile = await fetchProfile(r.company_number)
      await sleep(150)
      const psc = await fetchPsc(r.company_number)
      matches.push({
        company_name: r.title,
        company_number: r.company_number,
        status: r.company_status,
        officers,
        psc,
        sic_codes: profile.sic_codes,
        incorporated_on: profile.incorporated_on,
      })
      // Courtesy pacing between sequential external API calls, mirrors
      // solar-enrichment's sleep(150) between Google Solar API calls.
      if (i < activeMatches.length - 1) await sleep(150)
    }
```

- [ ] **Step 4: Deploy and verify against a real company**

```
supabase functions deploy company-lookup --project-ref gkvropheqktytghmiwgp
```

Then invoke it for a real prospect that's known to have an active company match (use one already spot-checked during the original `company-lookup` build, or pick any prospect and check the response). From the repo root:
```
curl -s -X POST "https://gkvropheqktytghmiwgp.supabase.co/functions/v1/company-lookup" \
  -H "Authorization: Bearer <a real signed-in user's JWT>" \
  -H "Content-Type: application/json" \
  -d '{"prospect_id": "<a real prospect uuid with a known active company match>"}'
```
Confirm the response's `companies[]` entries now include non-empty `sic_codes`, a plausible `incorporated_on` date, and (for at least one company known to have a real PSC on the public Companies House website) a non-empty `psc` array with a real name. Cross-check that name against the same company's public Companies House page to confirm the `name`-presence filter in Step 2 is excluding statement-only entries correctly, not real PSCs.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/company-lookup/index.ts
git commit -m "Add PSC, SIC codes, and incorporation date to company-lookup"
```

---

### Task 2: Generate `shared/sic-codes.js` from the real Companies House/ONS SIC 2007 list

**Files:**
- Create: `shared/sic-codes.js` (committed — generated once, not regenerated at runtime)

**Interfaces:**
- Produces: a global `const SIC_CODES = { "<5-digit zero-padded code>": "<description>", ... }`, consumed by Task 3's popup rendering (`SIC_CODES[code]`).

- [ ] **Step 1: Generate the file from the real, verified data source**

Companies House's own SIC lookup page (`resources.companieshouse.gov.uk/sic/`) has no CSV export — it's a JS search widget. The condensed SIC 2007 list Companies House actually uses (matching exactly what the API's `sic_codes` field returns) is mirrored as a real, verified-live CSV at `https://datahub.io/core/uk-sic-2007-condensed/_r/-/data/uk-sic-2007-condensed.csv` (confirmed 2026-08-19: 731 real data rows, columns `sic_code,sic_description,section,section_description,sic_version`).

Create a throwaway script (not committed) at the repo root, `generate-sic-codes.mjs`:
```js
import { parse } from 'csv-parse/sync';

const resp = await fetch('https://datahub.io/core/uk-sic-2007-condensed/_r/-/data/uk-sic-2007-condensed.csv');
const csvText = await resp.text();
const rows = parse(csvText, { columns: true, skip_empty_lines: true });

const entries = rows.map(r => {
  const code = String(r.sic_code).padStart(5, '0');
  return '  "' + code + '": ' + JSON.stringify(r.sic_description);
});

// Built with string concatenation, not a template literal, so the header
// comment below can safely mention `sic_codes` without a stray backtick
// prematurely closing the surrounding string.
const header = [
  '// UK SIC 2007 condensed code list — the same condensed subset of the ONS',
  '// standard that Companies House\'s own API returns in sic_codes. Source:',
  '// https://datahub.io/core/uk-sic-2007-condensed (Companies House/ONS data,',
  '// fetched 2026-08-19). Codes are zero-padded to 5 digits to match the API\'s',
  '// format exactly — the source CSV omits the leading zero.',
  'const SIC_CODES = {',
].join('\n');

console.log(header + '\n' + entries.join(',\n') + '\n};\n');
```

Run it and write the result directly to the shared file:
```bash
node generate-sic-codes.mjs > shared/sic-codes.js
```

- [ ] **Step 2: Verify the generated file**

```bash
node -e "
const fs = require('fs');
const src = fs.readFileSync('shared/sic-codes.js', 'utf8');
const match = src.match(/const SIC_CODES = ({[\s\S]*});/);
const codes = eval('(' + match[1] + ')');
console.log('Total codes:', Object.keys(codes).length);
console.log('01110:', codes['01110']);
console.log('62012:', codes['62012']);
console.log('99999:', codes['99999']);
"
```
Expected: `Total codes: 731` (or close — confirm it's not 0 or suspiciously small), `01110` reads "Growing of cereals (except rice), leguminous crops and oil seeds", `62012` reads a computer-programming-related description, `99999` reads "Dormant Company". If any of these look wrong, the CSV source or padding logic has a bug — fix before proceeding.

- [ ] **Step 3: Delete the throwaway generator script and commit only the output**

```bash
rm generate-sic-codes.mjs
git add shared/sic-codes.js
git commit -m "Add shared/sic-codes.js from the real Companies House/ONS SIC 2007 list"
```

---

### Task 3: Render PSC, SIC description, and incorporation date in the popup

**Files:**
- Modify: `index.html`

**Interfaces:**
- Consumes: `CompanyMatch.psc`, `CompanyMatch.sic_codes`, `CompanyMatch.incorporated_on` (Task 1); `SIC_CODES` global (Task 2).

- [ ] **Step 1: Load `shared/sic-codes.js`**

Find:
```html
<script src="shared/building-types.js"></script>
<script src="shared/contact-outcome-config.js"></script>
```
Replace with:
```html
<script src="shared/building-types.js"></script>
<script src="shared/sic-codes.js"></script>
<script src="shared/contact-outcome-config.js"></script>
```

- [ ] **Step 2: Add the nature-of-control label map**

Add this near the top of the main `<script>` block, close to the other lookup-style constants (e.g. right after `SOLAR_STATUS_ORDER`). Values are Companies House's own real enum keys (verified 2026-08-19 against `github.com/companieshouse/api-enumerations`'s `psc_descriptions.yml`); labels are this project's own short paraphrase for popup display, not Companies House's full legal wording (which runs several sentences per entry and isn't fit for a popup). Any real key not in this map — the rarer trust/firm/LLP/overseas-entity variants — falls back to a prettified version of the raw value rather than being dropped silently.

```js
const NATURE_OF_CONTROL_LABELS = {
  'ownership-of-shares-25-to-50-percent': '25-50% shares',
  'ownership-of-shares-50-to-75-percent': '50-75% shares',
  'ownership-of-shares-75-to-100-percent': '75-100% shares',
  'voting-rights-25-to-50-percent': '25-50% voting rights',
  'voting-rights-50-to-75-percent': '50-75% voting rights',
  'voting-rights-75-to-100-percent': '75-100% voting rights',
  'right-to-appoint-and-remove-directors': 'can appoint/remove directors',
  'significant-influence-or-control': 'significant influence or control',
};
function natureOfControlLabel(value) {
  return NATURE_OF_CONTROL_LABELS[value] || value.replace(/-/g, ' ');
}
```

- [ ] **Step 3: Render SIC description + incorporation date on the company card header**

Find (in the `loadCompanyMatch` company-card template):
```js
    el.querySelector('.company-match-body').innerHTML = data.companies.map(c => `
      <div class="company-card ${c.status !== 'active' ? 'dissolved' : ''}">
        <div class="company-name">${escapeHtml(c.company_name)}${c.status !== 'active' ? ` <span class="company-status">· ${escapeHtml(c.status)} — likely not trading</span>` : ''}</div>
        ${c.officers?.length ? `<div class="company-officers">${c.officers.map(o => escapeHtml(o.name) + (o.role ? ` (${escapeHtml(o.role)})` : '')).join(', ')}</div>` : ''}
      </div>`).join('');
```
Replace with:
```js
    el.querySelector('.company-match-body').innerHTML = data.companies.map(c => {
      const sicDesc = (c.sic_codes || []).map(code => SIC_CODES[code]).filter(Boolean).join(', ');
      const tradingSince = c.incorporated_on ? `Trading since ${new Date(c.incorporated_on).getFullYear()}` : '';
      const subline = [sicDesc, tradingSince].filter(Boolean).join(' · ');
      const pscHtml = (c.psc || []).length
        ? `<div class="company-psc"><span class="popup-section-label" style="margin:6px 0 2px">Significant control</span>${c.psc.map(p =>
            `${escapeHtml(p.name)}${p.is_corporate ? ' (company)' : ''}${p.natures_of_control?.length ? ` — ${p.natures_of_control.map(n => escapeHtml(natureOfControlLabel(n))).join(', ')}` : ''}`
          ).join('<br>')}</div>`
        : '';
      return `
      <div class="company-card ${c.status !== 'active' ? 'dissolved' : ''}">
        <div class="company-name">${escapeHtml(c.company_name)}${c.status !== 'active' ? ` <span class="company-status">· ${escapeHtml(c.status)} — likely not trading</span>` : ''}</div>
        ${subline ? `<div class="company-subline">${escapeHtml(subline)}</div>` : ''}
        ${c.officers?.length ? `<div class="company-officers">${c.officers.map(o => escapeHtml(o.name) + (o.role ? ` (${escapeHtml(o.role)})` : '')).join(', ')}</div>` : ''}
        ${pscHtml}
      </div>`;
    }).join('');
```

- [ ] **Step 4: Add CSS for the new elements**

Find:
```css
    .company-officers { margin-top: 2px; color: var(--text2); }
```
Replace with:
```css
    .company-officers { margin-top: 2px; color: var(--text2); }
    .company-subline { margin-top: 1px; color: var(--text3); font-size: 11.5px; }
    .company-psc { margin-top: 4px; color: var(--text2); }
```

- [ ] **Step 5: Live-test in the browser**

Serve locally (`npx serve .` or open directly) and open a prospect popup for a company known from Task 1's verification to have real PSC/SIC/incorporation data. Confirm:
- SIC description and "Trading since `<year>`" appear under the company name.
- The "Significant control" section appears with a real name and a readable nature-of-control label.
- A company with a corporate PSC (if available in your test data — otherwise skip) shows "(company)" appended.
- A company with no PSC data renders with the section simply absent — no empty box, no console error.
- Open a prospect whose `company_lookups` cache was written before this change (any prospect checked before Task 1 shipped) — confirm it still renders without a JS error (missing new fields treated as absent, not thrown). It will show the old shape until its 90-day cache expires and gets re-fetched — that's expected, not a bug.

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "Render PSC, SIC description, and incorporation date in the popup"
```

---

## Self-review notes

- Spec coverage: all three fields from the design spec (PSC, SIC, incorporation date) have a task; error handling (per-call failure isolation, old-cache-row tolerance) is covered in Task 1/Task 3 respectively.
- No placeholders: all code blocks are complete, real, copy-pasteable; the SIC data source and PSC nature-of-control labels are pinned to real, verified sources (URLs and fetch dates given) rather than invented.
- Type consistency: `Psc`/`CompanyMatch` field names match exactly between Task 1 (producer) and Task 3 (consumer) — `psc`, `sic_codes`, `incorporated_on`.
