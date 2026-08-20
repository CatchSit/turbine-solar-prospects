# Popup Company Relevance + Tabbed Layout — Design

## Context

The prospect popup's "Companies matched to postcode" section (built in `docs/superpowers/specs/2026-08-17-decision-maker-contact-design.md`) searches Companies House by postcode and shows every active company whose registered-office postcode matches exactly. That's inherently postcode-level, not building-level: a shared postcode (an industrial estate, a retail park, a multi-tenant site) returns companies from other units too, and a rep has no way to tell which one is actually plausible for the building they clicked.

Separately, the popup has grown tall — header, solar estimate, four stacked fact lines (address, floor area, property type, local authority), a business-rates section, and the company-match section, all stacked vertically with no way to collapse anything. On smaller screens this pushes the "Log contact" button (the primary action) below the fold.

This design covers both, since the fix for the second naturally provides the layout the first needs (a dedicated "Companies" tab to badge relevant matches within).

## Goals

- Within the existing postcode-matched company list, surface companies plausibly *in the clicked building* first, without ever hiding a company that's currently shown — a fuzzy-matching false negative (wrongly hiding a real lead) is worse than a false positive (an extra company shown unbadged).
- Fix an existing ordering issue: Companies House's default result order — not building relevance — currently decides which 5 active companies survive the cap, so a real match ranked 6th-or-lower is silently dropped today regardless of this change.
- Restructure the popup so business rates and company-match content live in switchable tabs instead of an unbroken vertical stack, and tighten the always-visible "generic info" block, so the popup takes less vertical space and the primary "Log contact" action sits closer to the top.

## Non-goals

- No fuzzy/full-text address similarity scoring (Levenshtein, token-set ratio, etc.) — considered and rejected. Common words shared across every company at a site ("Industrial Estate", "Business Park") would inflate similarity scores for unrelated companies, risking a confidently-wrong badge. A plain number/unit match is noisier in coverage (buildings named rather than numbered get no signal) but never wrong when it fires.
- No switch to Companies House's `advanced-search/companies?location=` endpoint (flagged as a possible follow-up in `HANDOVER.md` Section 6) — investigated conceptually; it's still a postcode/outcode-level query, not building-level, so it wouldn't solve "different unit, same postcode" on its own.
- No new database migration — the one new field (`address_match`) lives inside the existing `company_lookups.companies` jsonb column, which is schemaless by design.
- No change to the "Companies matched to postcode" honesty framing (registered office ≠ trading address) — only where/how it's presented and ordered.

## Architecture

### 1. Address-aware ranking (`supabase/functions/company-lookup/index.ts`)

- The prospect lookup query currently selects only `postcode`; it now also selects `address`.
- New helper:
  ```ts
  function leadingNumber(text: string | undefined | null): number | null {
    const m = text?.match(/\d+/)
    return m ? parseInt(m[0], 10) : null
  }
  ```
- The prospect's building-level token is `prospect.address.split(',')[0]` — the same "most specific line" convention `index.html`'s popup title already uses (`buildPopup()`, `d.address.split(',')[0]`).
- For each Companies House candidate, the comparable token is `r.address?.premises`, falling back to `r.address?.address_line_1` if `premises` is blank (both are structured fields Companies House's search response already provides — no extra API call).
- A candidate gets `address_match: true` when both `leadingNumber(prospectToken)` and `leadingNumber(chToken)` are non-null and equal.
- **Sort before slicing, not after.** Today: `results.filter(postcode+active).slice(0, MAX_ACTIVE_COMPANIES)`. New: filter (postcode+active) → compute `address_match` for the *entire* filtered set → stable-sort matches first → slice to `MAX_ACTIVE_COMPANIES`. This guarantees a real building match surfaces within the cap even if Companies House's own result ordering placed it lower.
- `CompanyMatch` type gains `address_match: boolean`. It's included in both the API response and the `company_lookups` cache write — no schema change needed since `companies` is jsonb. Cache rows written before this change simply lack the field; they render unbadged until their normal 90-day refresh, same graceful-absence pattern already used for `epc_recommends_solar`/`epc_recommends_efficiency` (`HANDOVER.md` Section 5).

### 2. Cap increase

- `MAX_ACTIVE_COMPANIES`: 5 → 8.
- Rationale: each company costs 3 sequential Companies House calls (officers, profile, PSC) plus deliberate 150ms pacing sleeps between calls (existing courtesy-pacing pattern, mirrors `solar-enrichment`). The frontend enforces a hard `COMPANY_LOOKUP_TIMEOUT_MS = 20000` (`index.html`). At 5 companies, the sequential chain runs comfortably inside that budget (~6-7s estimated); at 8, there's still meaningful headroom (~10-11s estimated) without approaching the timeout the way a larger jump (e.g. 15-20) would risk under real-world latency variance. Now that non-matches are visually de-prioritized rather than competing equally for a scarce 5 slots, showing more of them is safe rather than noisy.

### 3. Popup restructure (`index.html`)

Current structure (all vertically stacked, no way to collapse):
```
popup-header → solar-est → popup-facts (4 lines) → business-rates → company-match → log-contact-btn
```

New structure:
```
popup-header → solar-est → popup-facts (consolidated) → popup-tabs → popup-tab-panel(s) → log-contact-btn
```

- **Generic info (untabbed, always visible):** header, solar estimate, and address keep their current form. Floor area, property type, and local authority — currently three separate `<p>` lines — consolidate into one line joined with " · ", the same subline-joining convention already used for `company-subline` (SIC description · trading-since year). Example: `500 m² · Offices and Workshop businesses · Leeds City Council`. Address stays on its own line since it's a clickable Google Maps link with its own icon.
- **Tabs:** two buttons, `Business rates` and `Companies` (shortened from "Companies matched to postcode" — the fuller phrase doesn't fit a tab label at the popup's fixed 320px width; the honest "matched to postcode, not confirmed occupant" framing stays in the panel content itself, not the tab label). `Business rates` is the default active tab (synchronous data, already available; also listed first per the earlier layout approval).
- **Tab panels drop their own `popup-section-label` header** — the active tab button already serves as that heading, so `"Business rates at this postcode"` / `"Companies matched to postcode"` labels are removed from inside the panels (further height reduction beyond the tabbing itself).
- **Empty-state handling stays visible, not hidden.** ~13% of prospects have no business-rates match today (19,050/21,808 matched per `HANDOVER.md`). Rather than an empty-feeling tab, the Business Rates panel shows "No business rates data for this postcode" when `businessRatesHtml()` would otherwise return nothing — mirrors the Companies tab's existing fallback-links pattern (never a silent dead end).
- **Tab switching:** plain inline `onclick` on each tab button (e.g. `onclick="switchPopupTab(this, 'rates')"`), consistent with how `Log contact` is already wired in this same popup — no new event-binding pattern. Implementation:
  ```js
  function switchPopupTab(btn, tab) {
    const popup = btn.closest('.popup');
    popup.querySelectorAll('.popup-tab').forEach(t => t.classList.toggle('active', t === btn));
    popup.querySelectorAll('.popup-tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === tab));
  }
  ```
  CSS: `.popup-tab-panel { display: none; }` / `.popup-tab-panel.active { display: block; }`.
- **No change to the async company-lookup trigger.** `loadCompanyMatch(d)` still fires immediately on marker click (`initMap()`'s `marker.on('click', ...)`), regardless of which tab is active — by the time a rep switches to the Companies tab, the fetch is typically already in flight or resolved. The `Companies` tab panel's loading/result/fallback states render exactly as they do today, just inside a panel that starts hidden if Business Rates is the active tab.
- **`Log contact` button stays outside the tabs, always visible** — it's the primary action, not something that should be one click further away behind a tab.

### 4. Company card badge

- Each `company-card` with `c.address_match === true` gets a small inline badge — proposed label **"Likely this building"** (reuses the "likely" honesty-framing convention already established by the existing dissolved-company badge, "likely not trading").
- Companies already arrive pre-sorted (matches first) from the edge function, so no client-side re-sort is needed — the frontend renders `data.companies` in the order received.
- Non-matches render exactly as they do today: unbadged, no claim made either way.

## Data flow summary

1. Rep clicks a marker → popup opens with generic info + tabs (Business Rates active by default) → `loadCompanyMatch(d)` fires in parallel.
2. `company-lookup` function: checks 90-day cache → on miss, searches Companies House by postcode → filters to active + postcode-matching → computes `address_match` per candidate using the leading-number heuristic → stable-sorts matches first → slices to 8 → fetches officers/profile/PSC per surviving candidate → caches and returns.
3. Frontend renders the returned list into the (possibly still-hidden) Companies tab panel, badging `address_match: true` cards.
4. Rep can switch tabs at any point; content underneath doesn't re-fetch or re-render on tab switch, only visibility toggles.

## Testing & verification

- Extend the spot-check already planned in the original Company-match design (`docs/superpowers/specs/2026-08-17-decision-maker-contact-design.md`, "Testing & verification": 10-15 real prospects) to specifically include a couple of known shared-postcode/multi-tenant sites from the ingested Yorkshire & Humber data, confirming:
  - The correct occupant(s) get the "Likely this building" badge.
  - Nothing that renders today (under the 5-cap) goes missing under the 8-cap.
  - End-to-end lookup time for an 8-company postcode stays clearly inside the 20s client timeout in practice, not just in the ~10-11s estimate above.
- Confirm the tab UI: default tab is Business Rates, switching tabs doesn't re-trigger the company lookup or lose already-loaded content, and the empty-state message renders correctly for a prospect with no business-rates match.
- Confirm the consolidated fact line renders sensibly when one of its three parts is missing (e.g. a prospect with no `local_authority` value) — no dangling " · " separator.
- Visual check at the popup's fixed 320px width: tab labels, consolidated fact line, and badge text all fit without wrapping awkwardly.
