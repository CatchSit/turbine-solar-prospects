# Popup Company Relevance + Tabbed Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rank (never hide) Companies House matches by building relevance in the prospect popup, and restructure the popup into a tabbed layout to cut its vertical footprint.

**Architecture:** A pure, dependency-free ranking helper added to `supabase/functions/company-lookup/index.ts` reorders postcode-matched companies so building-number matches surface first, before the existing 5-item cap (now 8) is applied. `index.html`'s popup gains a `Business rates` / `Companies` tab pair below an untabbed, tightened "generic info" block; the badge for a building match renders inside the existing company-card markup.

**Tech Stack:** Deno (Supabase Edge Function), plain HTML/CSS/JS (no framework, no build step) — matches the rest of this repo exactly.

## Global Constraints

- No new dependencies, no new build tooling, no test framework introduction — this repo has none today (confirmed: no `deno test` files anywhere, no JS test runner in `package.json`) and nothing in this change needs one badly enough to justify adding it.
- No filtering/hiding of Companies House matches — every company that passes today's postcode+active filter must still appear after this change (spec: `docs/superpowers/specs/2026-08-20-popup-relevance-and-tabs-design.md`, Goals).
- `address_match` is additive to the existing `company_lookups.companies` jsonb — no migration.
- Badge label: exactly `"Likely this building"`. Tab labels: exactly `"Business rates"` and `"Companies"`. Business rates empty-state text: exactly `"No business rates data for this postcode."`.
- Default active tab: Business rates.
- `MAX_ACTIVE_COMPANIES`: 5 → 8.

---

### Task 1: Address-aware ranking in `company-lookup`

**Files:**
- Modify: `supabase/functions/company-lookup/index.ts:55` (cap), `:59-69` (type), `:71-73` (add helpers after `normalizePostcode`), `:208-221` (select + address var), `:244-273` (rank-before-slice)

**Interfaces:**
- Produces: `leadingNumber(text: any): number | null`, `isAddressMatch(prospectAddress: string, candidate: any): boolean`, `rankByAddressMatch(prospectAddress: string, candidates: any[]): any[]` (each candidate spread with an added `address_match: boolean`, order changed so `address_match: true` entries sort first, stable otherwise). `CompanyMatch` gains `address_match: boolean`. These are consumed only within this file — no other task calls them directly, but Task 3's live-verification checklist depends on this behavior being correct.

- [ ] **Step 1: Raise the cap**

In `supabase/functions/company-lookup/index.ts:55`, change:
```ts
const MAX_ACTIVE_COMPANIES = 5
```
to:
```ts
const MAX_ACTIVE_COMPANIES = 8
```

- [ ] **Step 2: Add `address_match` to the `CompanyMatch` type**

In `supabase/functions/company-lookup/index.ts:61-69`, change:
```ts
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
  address_match: boolean
}
```

- [ ] **Step 3: Add the ranking helpers**

In `supabase/functions/company-lookup/index.ts`, immediately after `normalizePostcode` (currently ending at line 73), insert:
```ts
// deno-lint-ignore no-explicit-any
function leadingNumber(text: any): number | null {
  const m = typeof text === 'string' ? text.match(/\d+/) : null
  return m ? parseInt(m[0], 10) : null
}

// A building-number match is the only signal trusted here — it's discrete
// and unambiguous, unlike word-overlap on shared site/street names (see
// docs/superpowers/specs/2026-08-20-popup-relevance-and-tabs-design.md,
// "Non-goals", for why fuzzy full-text similarity was rejected).
// deno-lint-ignore no-explicit-any
function isAddressMatch(prospectAddress: string, candidate: any): boolean {
  const prospectToken = prospectAddress.split(',')[0]
  const chToken = candidate.address?.premises || candidate.address?.address_line_1
  const prospectNumber = leadingNumber(prospectToken)
  const chNumber = leadingNumber(chToken)
  return prospectNumber !== null && chNumber !== null && prospectNumber === chNumber
}

// Reorders candidates so likely building matches sort first. Never drops a
// candidate — every item passed in comes back out, just reordered, so a
// caller applying a cap afterwards keeps every match it would have kept
// before, plus promotes real matches ahead of the cap.
// deno-lint-ignore no-explicit-any
function rankByAddressMatch(prospectAddress: string, candidates: any[]): any[] {
  return candidates
    .map(c => ({ ...c, address_match: isAddressMatch(prospectAddress, c) }))
    .sort((a, b) => Number(b.address_match) - Number(a.address_match))
}
```

- [ ] **Step 4: Sanity-check the helpers with a disposable Node script (no `deno` CLI is available in this environment — this is plain JS with no Deno-specific APIs, so Node is a valid stand-in for a quick logic check)**

Write `C:\Users\GregRoy\AppData\Local\Temp\claude\c--Users-GregRoy-Projects-turbine-solar-prospects\de8dc1dd-cd16-468f-818a-894202d0520f\scratchpad\check-address-match.mjs`:
```js
function leadingNumber(text) {
  const m = typeof text === 'string' ? text.match(/\d+/) : null
  return m ? parseInt(m[0], 10) : null
}
function isAddressMatch(prospectAddress, candidate) {
  const prospectToken = prospectAddress.split(',')[0]
  const chToken = candidate.address?.premises || candidate.address?.address_line_1
  const prospectNumber = leadingNumber(prospectToken)
  const chNumber = leadingNumber(chToken)
  return prospectNumber !== null && chNumber !== null && prospectNumber === chNumber
}
function rankByAddressMatch(prospectAddress, candidates) {
  return candidates
    .map(c => ({ ...c, address_match: isAddressMatch(prospectAddress, c) }))
    .sort((a, b) => Number(b.address_match) - Number(a.address_match))
}

const assertEq = (actual, expected, label) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}` + (ok ? '' : ` — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`))
}

assertEq(leadingNumber('Unit 5, Foo Business Park'), 5, 'leadingNumber: "Unit 5, Foo Business Park" -> 5')
assertEq(leadingNumber('12 Bridge Street'), 12, 'leadingNumber: "12 Bridge Street" -> 12')
assertEq(leadingNumber('Foo House'), null, 'leadingNumber: "Foo House" -> null')
assertEq(leadingNumber(undefined), null, 'leadingNumber: undefined -> null')

assertEq(
  isAddressMatch('Unit 5, Foo Business Park, Leeds', { address: { premises: '5' } }),
  true,
  'isAddressMatch: premises "5" matches "Unit 5, ..."'
)
assertEq(
  isAddressMatch('Unit 5, Foo Business Park, Leeds', { address: { address_line_1: '5 Foo Business Park' } }),
  true,
  'isAddressMatch: falls back to address_line_1 when premises is blank'
)
assertEq(
  isAddressMatch('Unit 5, Foo Business Park, Leeds', { address: { premises: '7' } }),
  false,
  'isAddressMatch: "7" does not match "Unit 5, ..."'
)
assertEq(
  isAddressMatch('Foo House, Leeds', { address: { premises: 'Ground Floor' } }),
  false,
  'isAddressMatch: no number on either side -> false'
)

const candidates = [
  { company_number: '1', title: 'No Match Co', address: { premises: '99' } },
  { company_number: '2', title: 'Match Co', address: { premises: '5' } },
  { company_number: '3', title: 'Also No Match', address: {} },
]
const ranked = rankByAddressMatch('Unit 5, Foo Business Park, Leeds', candidates)
assertEq(ranked.length, 3, 'rankByAddressMatch: keeps every candidate')
assertEq(ranked[0].company_number, '2', 'rankByAddressMatch: match sorts first')
assertEq(ranked[0].address_match, true, 'rankByAddressMatch: matched candidate flagged true')
assertEq(ranked.map(c => c.company_number).sort(), ['1', '2', '3'], 'rankByAddressMatch: no candidate dropped')
```

Run: `node "C:\Users\GregRoy\AppData\Local\Temp\claude\c--Users-GregRoy-Projects-turbine-solar-prospects\de8dc1dd-cd16-468f-818a-894202d0520f\scratchpad\check-address-match.mjs"`

Expected: every line prints `PASS`. If anything prints `FAIL`, fix the helper in `index.ts` (the scratch script is a byte-for-byte copy of the new logic — keep them in sync while debugging) and rerun before continuing.

- [ ] **Step 5: Wire `address` into the prospect lookup**

In `supabase/functions/company-lookup/index.ts:208-212`, change:
```ts
  const { data: prospect, error: prospectErr } = await db
    .from('prospects')
    .select('postcode')
    .eq('id', prospect_id)
    .maybeSingle()
```
to:
```ts
  const { data: prospect, error: prospectErr } = await db
    .from('prospects')
    .select('address, postcode')
    .eq('id', prospect_id)
    .maybeSingle()
```

Then at line 221, right after `const postcode = prospect.postcode as string`, add:
```ts
  const address = (prospect.address as string) || ''
```

- [ ] **Step 6: Rank before slicing**

In `supabase/functions/company-lookup/index.ts:244-251`, change:
```ts
    const normalizedTarget = normalizePostcode(postcode)
    const results = await searchCompaniesHouse(postcode)
    // deno-lint-ignore no-explicit-any
    const activeMatches = results.filter((r: any) =>
      r.address?.postal_code &&
      normalizePostcode(r.address.postal_code) === normalizedTarget &&
      r.company_status === 'active'
    ).slice(0, MAX_ACTIVE_COMPANIES)
```
to:
```ts
    const normalizedTarget = normalizePostcode(postcode)
    const results = await searchCompaniesHouse(postcode)
    // deno-lint-ignore no-explicit-any
    const postcodeMatches = results.filter((r: any) =>
      r.address?.postal_code &&
      normalizePostcode(r.address.postal_code) === normalizedTarget &&
      r.company_status === 'active'
    )
    // Rank before slicing — a real building match must not lose its spot to
    // an unrelated company that Companies House's own search happened to
    // rank higher. See rankByAddressMatch above.
    const activeMatches = rankByAddressMatch(address, postcodeMatches).slice(0, MAX_ACTIVE_COMPANIES)
```

Then in the `matches.push({...})` block a few lines below (currently `:261-269`), add the new field:
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

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/company-lookup/index.ts
git commit -m "$(cat <<'EOF'
Rank Companies House matches by building relevance in company-lookup

Postcode-only matching currently can't distinguish which company is
plausibly in the clicked building vs. elsewhere at a shared postcode.
Add a building-number heuristic (never hides a result, only reorders),
fix an existing bug where the 5-item cap applied before any relevance
signal existed, and raise the cap to 8 now that lower-relevance matches
are visually de-prioritized instead of competing for a scarce slot.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Popup restructure — badge, consolidated facts, tabs

**Files:**
- Modify: `index.html:230-253` (CSS), `:753-768` (`businessRatesHtml`), `:769-815` (`buildPopup`), `:873-889` (company card rendering in `loadCompanyMatch`)
- Add: a new `switchPopupTab` function near `loadCompanyMatch`

**Interfaces:**
- Consumes: `c.address_match` from Task 1's edge function response (`data.companies[].address_match`).
- Produces: `switchPopupTab(btn, tab)` — called via inline `onclick` from the tab buttons rendered in `buildPopup()`'s output, same wiring convention as the existing `onclick="openContactModal(...)"` on the Log Contact button.

- [ ] **Step 1: Add tab and badge CSS**

In `index.html`, immediately after the existing rule at line 253 (`.company-match-links a { color: var(--accent); }`), insert:
```css
    .popup-tabs { display: flex; gap: 4px; padding: 0 20px; border-bottom: 1px solid var(--border); margin-bottom: 12px; }
    .popup-tab { background: none; border: none; font: inherit; font-size: 12px; font-weight: 500; color: var(--text3); padding: 8px 4px; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; }
    .popup-tab.active { color: var(--text); border-bottom-color: var(--accent); }
    .popup-tab-panel { display: none; }
    .popup-tab-panel.active { display: block; }
    .company-match-badge { display: inline-block; font-size: 10.5px; font-weight: 500; color: var(--accentDk); background: var(--accentDim); padding: 1px 7px; border-radius: 100px; margin-left: 6px; vertical-align: middle; }
```

- [ ] **Step 2: Tighten `.popup-facts` padding**

In `index.html:230`, change:
```css
    .popup-facts { padding: 4px 20px 18px; font-size: 12.5px; color: var(--text2); }
```
to:
```css
    .popup-facts { padding: 4px 20px 14px; font-size: 12.5px; color: var(--text2); }
```

- [ ] **Step 3: Rewrite `businessRatesHtml` — drop the internal heading, add an empty-state fallback**

In `index.html:753-768`, change:
```js
function businessRatesHtml(d) {
  const hereditaments = d.business_rates_matches?.hereditaments;
  if (!hereditaments || !hereditaments.length) return '';
  const sorted = [...hereditaments].sort((a, b) => Number(b.rateable_value ?? 0) - Number(a.rateable_value ?? 0));
  const shown = sorted.slice(0, BUSINESS_RATES_DISPLAY_LIMIT);
  const remaining = sorted.length - shown.length;
  const rows = shown.map(h =>
    `<div>${escapeHtml(h.description || 'Unspecified')} — £${Number(h.rateable_value ?? 0).toLocaleString()}</div>`
  ).join('');
  const more = remaining > 0 ? `<div>+ ${remaining.toLocaleString()} more</div>` : '';
  return `
      <div class="business-rates">
        <div class="popup-section-label">Business rates at this postcode</div>
        ${rows}${more}
      </div>`;
}
```
to:
```js
function businessRatesHtml(d) {
  const hereditaments = d.business_rates_matches?.hereditaments;
  if (!hereditaments || !hereditaments.length) {
    return `<div class="company-match-fallback">No business rates data for this postcode.</div>`;
  }
  const sorted = [...hereditaments].sort((a, b) => Number(b.rateable_value ?? 0) - Number(a.rateable_value ?? 0));
  const shown = sorted.slice(0, BUSINESS_RATES_DISPLAY_LIMIT);
  const remaining = sorted.length - shown.length;
  const rows = shown.map(h =>
    `<div>${escapeHtml(h.description || 'Unspecified')} — £${Number(h.rateable_value ?? 0).toLocaleString()}</div>`
  ).join('');
  const more = remaining > 0 ? `<div>+ ${remaining.toLocaleString()} more</div>` : '';
  return `${rows}${more}`;
}
```

- [ ] **Step 4: Consolidate the fact lines and restructure `buildPopup`'s return value**

In `index.html:789-792`, change:
```js
  const addr = `<p>📍 <a href="${maps}" target="_blank" rel="noopener">${escapeHtml(d.address || d.postcode || 'Address not listed')}</a></p>`;
  const area = d.floor_area ? `<p>📐 ${Math.round(d.floor_area).toLocaleString()} m² floor area</p>` : '';
  const type = d.property_type ? `<p>🏢 ${escapeHtml(d.property_type)}</p>` : '';
  const la = d.local_authority ? `<p>📍 ${escapeHtml(d.local_authority)}</p>` : '';
```
to:
```js
  const addr = `<p>📍 <a href="${maps}" target="_blank" rel="noopener">${escapeHtml(d.address || d.postcode || 'Address not listed')}</a></p>`;
  const factParts = [
    d.floor_area ? `${Math.round(d.floor_area).toLocaleString()} m²` : '',
    d.property_type ? escapeHtml(d.property_type) : '',
    d.local_authority ? escapeHtml(d.local_authority) : '',
  ].filter(Boolean);
  const facts = factParts.length ? `<p>${factParts.join(' · ')}</p>` : '';
```

Then in `index.html:798-814`, change:
```js
  return `
    <div class="popup">
      <div class="popup-header">
        <div class="popup-eyebrow">Commercial prospect</div>
        <div class="popup-name">${escapeHtml(d.address ? d.address.split(',')[0] : (d.postcode || 'Unnamed building'))}</div>
        ${d.postcode ? `<div class="popup-meta">${escapeHtml(d.postcode)}</div>` : ''}
        <div class="tags">${statusPill}${epcTag}${typeTag}${solarRecTag}${efficiencyRecTag}</div>
      </div>
      ${solarEst}
      <div class="popup-facts">${addr}${area}${type}${la}</div>
      ${businessRatesHtml(d)}
      <div class="company-match" id="company-match-${escapeHtml(d.id)}">
        <div class="popup-section-label">Companies matched to postcode</div>
        <div class="company-match-body">Looking up company registered at this address…</div>
      </div>
      <button class="log-contact-btn" onclick="openContactModal('${escapeHtml(d.id)}', ${escapeHtml(JSON.stringify(d.address || d.postcode || 'Unnamed building'))})">Log contact</button>
    </div>`;
}
```
to:
```js
  return `
    <div class="popup">
      <div class="popup-header">
        <div class="popup-eyebrow">Commercial prospect</div>
        <div class="popup-name">${escapeHtml(d.address ? d.address.split(',')[0] : (d.postcode || 'Unnamed building'))}</div>
        ${d.postcode ? `<div class="popup-meta">${escapeHtml(d.postcode)}</div>` : ''}
        <div class="tags">${statusPill}${epcTag}${typeTag}${solarRecTag}${efficiencyRecTag}</div>
      </div>
      ${solarEst}
      <div class="popup-facts">${addr}${facts}</div>
      <div class="popup-tabs">
        <button class="popup-tab active" type="button" onclick="switchPopupTab(this, 'rates')">Business rates</button>
        <button class="popup-tab" type="button" onclick="switchPopupTab(this, 'companies')">Companies</button>
      </div>
      <div class="business-rates popup-tab-panel active" data-panel="rates">${businessRatesHtml(d)}</div>
      <div class="company-match popup-tab-panel" data-panel="companies" id="company-match-${escapeHtml(d.id)}">
        <div class="company-match-body">Looking up company registered at this address…</div>
      </div>
      <button class="log-contact-btn" onclick="openContactModal('${escapeHtml(d.id)}', ${escapeHtml(JSON.stringify(d.address || d.postcode || 'Unnamed building'))})">Log contact</button>
    </div>`;
}
```

- [ ] **Step 5: Add `switchPopupTab`**

In `index.html`, immediately before the `/* ── Company lookup ─...` comment block (currently at line 817), insert:
```js
function switchPopupTab(btn, tab) {
  const popup = btn.closest('.popup');
  popup.querySelectorAll('.popup-tab').forEach(t => t.classList.toggle('active', t === btn));
  popup.querySelectorAll('.popup-tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === tab));
}
```

- [ ] **Step 6: Render the badge on address-matched company cards**

In `index.html:883-884`, change:
```js
      <div class="company-card ${c.status !== 'active' ? 'dissolved' : ''}">
        <div class="company-name">${escapeHtml(c.company_name)}${c.status !== 'active' ? ` <span class="company-status">· ${escapeHtml(c.status)} — likely not trading</span>` : ''}</div>
```
to:
```js
      <div class="company-card ${c.status !== 'active' ? 'dissolved' : ''}">
        <div class="company-name">${escapeHtml(c.company_name)}${c.address_match ? '<span class="company-match-badge">Likely this building</span>' : ''}${c.status !== 'active' ? ` <span class="company-status">· ${escapeHtml(c.status)} — likely not trading</span>` : ''}</div>
```

- [ ] **Step 7: Serve the file locally and load it in a browser**

Run in the repo root (background, since it stays running): `npx serve . -l 5001`

Then use the Playwright MCP tools to navigate to `http://localhost:5001/index.html` and pull `browser_console_messages` at level `error`.

Expected: page loads, no console errors (the Azure AD login gate rendering is expected and fine — real sign-in isn't available in this environment, but a script error would show here even before the gate).

- [ ] **Step 8: Exercise the new popup code directly via `browser_evaluate`, bypassing the login gate**

The functions changed above (`buildPopup`, `businessRatesHtml`, `switchPopupTab`) are plain global functions defined in the page's inline `<script>` — they don't require a signed-in session to call directly. Use `mcp__playwright__browser_evaluate` with a function that:
1. Builds a fixture prospect object covering the three cases that matter: has business-rates data, has no business-rates data, and a company match with `address_match: true`.
2. Calls `buildPopup(fixture)` and injects the returned HTML string into a detached container appended to `document.body`.
3. Asserts (via plain JS, returning a results array from the evaluate call) that:
   - The `.popup-tabs` block contains exactly two buttons reading `Business rates` and `Companies`.
   - `.popup-tab-panel[data-panel="rates"]` has class `active` and `.popup-tab-panel[data-panel="companies"]` does not, on initial render.
   - Calling `businessRatesHtml({ business_rates_matches: null })` returns the string `No business rates data for this postcode.` wrapped in `.company-match-fallback`.
   - Manually setting `.company-match-body` innerHTML to a rendered company card with `address_match: true` (reuse the exact template literal from Step 6) produces an element containing `.company-match-badge` with text `Likely this building`.
   - Calling `switchPopupTab(companiesButton, 'companies')` on the injected DOM toggles `.active` onto the Companies button/panel and off the Business Rates button/panel.
   - The consolidated facts line for a fixture with all three of `floor_area`, `property_type`, `local_authority` set renders as one `<p>` joined with ` · ` and no leading/trailing/doubled separator when one field is missing (test with `local_authority` unset).

Expected: all assertions return `true`. If any fails, fix the corresponding code from Steps 1-6 and rerun this step before continuing — do not proceed to commit on a failing check.

- [ ] **Step 9: Stop the local server and commit**

```bash
git add index.html
git commit -m "$(cat <<'EOF'
Restructure prospect popup into tabs, add building-match badge

The popup grew tall from unconditionally stacking business rates and
company-match sections under four separate fact lines. Consolidate
floor area/property type/local authority into one line, move business
rates and companies into switchable tabs (business rates default), and
badge companies flagged address_match by the company-lookup function.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Deploy and hand off live verification

**Files:** none (deploy + push only)

**Interfaces:** none — this task ships Tasks 1-2's already-committed code.

- [ ] **Step 1: Deploy the edge function**

Run: `supabase functions deploy company-lookup`

Expected: deploy succeeds (the project is already linked — confirmed via `supabase projects list` showing `turbine-solar-prospects` marked linked). This does not require local Docker; only `supabase start`/local dev does.

- [ ] **Step 2: Push to `main`**

```bash
git push origin main
```

GitHub Pages serves `index.html` directly from `main` with no build step (confirmed in `HANDOVER.md` Section 1 — Pages has been live since 2026-08-12), so this is the same deploy mechanism already used for every prior change to this file.

- [ ] **Step 3: Hand off a live-verification checklist**

This project's edge functions require a real `@turbineenergyuk.co.uk` Azure AD session to exercise end-to-end (`company-lookup` independently verifies the caller's JWT domain — `supabase/functions/company-lookup/index.ts:184-190`), which isn't available in this environment. Report back to the user with this checklist to run against the live site (`https://catchsit.github.io/turbine-solar-prospects/`):

- Open a prospect popup — confirm the facts block now shows one consolidated line (floor area · property type · local authority) instead of three, and that `Business rates` / `Companies` tabs appear below it with Business rates active by default.
- Switch to the `Companies` tab — confirm it shows the same content it did before this change (no regression), just relocated.
- Find a prospect on a postcode shared by multiple businesses (a retail park or industrial estate is most likely) and confirm at least one gets the "Likely this building" badge, and that switching tabs back and forth doesn't re-trigger the lookup or lose the rendered result.
- Open a prospect with no VOA business-rates match — confirm the Business Rates tab shows "No business rates data for this postcode." rather than a blank panel.
- At the popup's fixed 320px width, confirm tab labels, the consolidated fact line, and the badge text don't wrap awkwardly.

Report the outcome of this checklist back before considering the feature fully verified — this task's own execution only confirms the code deployed, not that it behaves correctly against real data and a real session.

---

## Self-Review Notes

- **Spec coverage:** every Goal in the design spec maps to a task — ranking-without-hiding and cap-order fix (Task 1), tab restructure + consolidated facts + empty-state fallback + badge (Task 2), deploy (Task 3). The spec's explicit Non-goals (no fuzzy similarity, no `advanced-search` endpoint switch, no migration) are respected — nothing in this plan does any of them.
- **Placeholder scan:** no TBD/TODO; every step has literal code, not a description of code.
- **Type consistency:** `address_match` named identically across the edge function type, the `matches.push` call, and the frontend's `c.address_match` read. `rankByAddressMatch`/`isAddressMatch`/`leadingNumber` names match between the real implementation (Task 1, Step 3) and the disposable verification script (Task 1, Step 4) — kept as literal copies specifically so a passing scratch-script run is real evidence about the shipped code, not just about a similar snippet.
