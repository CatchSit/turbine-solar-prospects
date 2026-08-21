# Solar Recommendation Recency Visual Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prospects with `epc_recommends_solar === true` render on a green→red marker-color gradient by recency of `lodgement_date` (dynamic range, real data only), and a new "Solar recommendation year" sidebar chip filter lets a rep narrow the map to specific recommendation year(s).

**Architecture:** Everything lives in `index.html`, alongside the existing marker-icon/chip-filter code it extends. No database or backend changes — `epc_recommends_solar` and `lodgement_date` already exist and are already fetched by `fetchAllProspects()`.

**Tech Stack:** Plain HTML/CSS/JS — no new dependencies.

## Global Constraints

- The gradient color **replaces** `solar_status`'s color only for prospects where `epc_recommends_solar === true` and `lodgement_date` is non-null. Every other prospect's marker color is completely unchanged.
- The gradient scale is **dynamic**: bright green (`#22c55e`) = the newest `lodgement_date` actually present among solar-recommended prospects, red (`#c0392b`, this app's existing alert-red) = the oldest actually present — never a hardcoded calendar range.
- The year chip list shows only years **actually present** in the loaded data — never a hardcoded 2011–2026 range.
- The new filter follows the exact "strict once touched" pattern already used by every other sidebar filter in this file (e.g. `sectorOk`/`maturityOk` in `applyFilters()`): untouched (all chips checked) passes everyone through, including prospects with no recommendation at all; touching even one chip makes it strict, and a prospect with `_recommendationYear === null` never passes a touched filter.
- No new npm dependency.

---

### Task 1: Marker recency gradient + sidebar year filter

**Files:**
- Modify: `index.html` (marker icon section ~`index.html:767-778`, sidebar HTML ~`index.html:500-508`, filter-state declarations ~`index.html:756-757`, `initMap` ~`index.html:1212-1237`, chip-builder section ~`index.html:1290-1330`, `applyFilters` ~`index.html:1383-1421`, reset handler ~`index.html:1446-1474`)

**Interfaces:**
- Produces: `recencyColor(d)`, `interpolateColor(hexA, hexB, t)`, `d._recommendationYear`, `activeRecommendationYears` (Set), `recommendationYearOrder` (array), `buildRecommendationYearChips(data)`. Nothing later in the plan depends on these (this is the only task) — but keep the names exact since they're what verification (Step 6 below) exercises.

- [ ] **Step 1: Add the gradient helpers and date-bounds tracking above `makeMarkerIcon`**

In `index.html`, immediately before `function makeMarkerIcon(d) {` (currently `index.html:768`), add:

```js
// Real spread of solar-recommendation dates in the loaded data, computed
// once in initMap() before markers are created — bright green = newest,
// red = oldest, scaled to what's actually present, never a fixed calendar
// range (2026-08-21, docs/superpowers/specs/2026-08-21-solar-recommendation-recency-design.md).
let recDateMin = null, recDateMax = null;

const RECENCY_COLOR_OLD = '#c0392b'; // this app's existing alert/error red
const RECENCY_COLOR_NEW = '#22c55e'; // bright green

function interpolateColor(hexA, hexB, t) {
  const a = [1, 3, 5].map(i => parseInt(hexA.slice(i, i + 2), 16));
  const b = [1, 3, 5].map(i => parseInt(hexB.slice(i, i + 2), 16));
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return `#${c.map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

// Returns a gradient color for a solar-recommended prospect with a real
// date, or null to signal "use the normal solar_status color" — every
// other prospect (no recommendation, or missing date) falls through to
// today's existing behavior unchanged.
function recencyColor(d) {
  if (!d.epc_recommends_solar || !d.lodgement_date) return null;
  const t = new Date(d.lodgement_date).getTime();
  if (recDateMin === null || recDateMax === null || recDateMin === recDateMax) return RECENCY_COLOR_NEW;
  const ratio = (t - recDateMin) / (recDateMax - recDateMin);
  return interpolateColor(RECENCY_COLOR_OLD, RECENCY_COLOR_NEW, ratio);
}
```

- [ ] **Step 2: Use `recencyColor` in `makeMarkerIcon`**

Change (`index.html:769-770`):

```js
  const cfg = SOLAR_STATUS[d.solar_status];
  const color = cfg ? cfg.color : '#000000';
```

to:

```js
  const cfg = SOLAR_STATUS[d.solar_status];
  const color = recencyColor(d) || (cfg ? cfg.color : '#000000');
```

- [ ] **Step 3: Verify marker coloring against fixture data**

Using the local dev server (`npx serve . -l 5001` or another free port) and Playwright's `browser_evaluate`:
- Call `interpolateColor('#c0392b', '#22c55e', 0)` — expect exactly `'#c0392b'`.
- Call `interpolateColor('#c0392b', '#22c55e', 1)` — expect exactly `'#22c55e'`.
- Call `interpolateColor('#c0392b', '#22c55e', 0.5)` — expect a color that is neither endpoint (a real blend).
- Set `recDateMin`/`recDateMax` to two known timestamps (e.g. `Date.parse('2020-01-01')` and `Date.parse('2026-01-01')`), then call `recencyColor({ epc_recommends_solar: true, lodgement_date: '2026-01-01' })` — expect exactly `RECENCY_COLOR_NEW` (`'#22c55e'`) — and `recencyColor({ epc_recommends_solar: true, lodgement_date: '2020-01-01' })` — expect exactly `RECENCY_COLOR_OLD` (`'#c0392b'`).
- Call `recencyColor({ epc_recommends_solar: false, lodgement_date: '2026-01-01' })` — expect `null` (falls through to `solar_status` color, unaffected).
- Call `recencyColor({ epc_recommends_solar: true, lodgement_date: null })` — expect `null` (missing-date edge case, falls through safely).
- Call `makeMarkerIcon({ solar_status: 'prospect', epc_recommends_solar: false })` and confirm the rendered `html` still contains `#2ba45e` (today's existing `SOLAR_STATUS.prospect` color, unchanged) — proves non-recommended prospects are untouched by this change.

- [ ] **Step 4: Add the sidebar section**

In `index.html`, after the existing "Company maturity" section (`index.html:505-508`), add a new section (before "Solar status", `index.html:510`):

```html
  <div class="section">
    <h3>Solar recommendation year</h3>
    <div id="recommendation-year-list" class="chip-list"></div>
  </div>
```

- [ ] **Step 5: Add filter-state and precomputed field**

Next to `activeMaturities` (`index.html:757`), add:

```js
let activeRecommendationYears = new Set(); // populated once buildRecommendationYearChips runs (years are data-driven, not a fixed enum)
let recommendationYearOrder = []; // set alongside activeRecommendationYears
```

In `initMap(data)` (`index.html:1212`), inside the existing `data.forEach(d => { ... })` loop that already sets `d._bucket`/`d._maxRateable`/`d._sicSector`/`d._maturity` (`index.html:1216-1219`), add one more line:

```js
    d._recommendationYear = (d.epc_recommends_solar && d.lodgement_date) ? new Date(d.lodgement_date).getFullYear() : null;
```

Also in `initMap`, immediately before that same `data.forEach` loop, add the date-bounds pre-pass (this is what Step 1's `recDateMin`/`recDateMax` need populated from):

```js
  data.forEach(d => {
    if (d.epc_recommends_solar && d.lodgement_date) {
      const t = new Date(d.lodgement_date).getTime();
      if (recDateMin === null || t < recDateMin) recDateMin = t;
      if (recDateMax === null || t > recDateMax) recDateMax = t;
    }
  });
```

(Two separate `data.forEach` passes over the same array — one to compute the date bounds before any marker is created, one for the existing per-marker work. Markers are created in the second pass via `L.marker(..., { icon: makeMarkerIcon(d) })`, so the bounds must exist before that call.)

Near the end of `initMap`, alongside the existing `buildSicSectorChips(data); buildMaturityChips(data);` calls (`index.html:1232-1233`), add:

```js
  buildRecommendationYearChips(data);
```

- [ ] **Step 6: Write `buildRecommendationYearChips`**

Next to `buildMaturityChips` (`index.html:1309-1327`), add:

```js
function buildRecommendationYearChips(data) {
  const counts = {};
  data.forEach(d => { if (d._recommendationYear) counts[d._recommendationYear] = (counts[d._recommendationYear] || 0) + 1; });
  recommendationYearOrder = Object.keys(counts).map(Number).sort((a, b) => b - a); // newest first
  activeRecommendationYears = new Set(recommendationYearOrder);
  const el = document.getElementById("recommendation-year-list");
  el.innerHTML = '';
  recommendationYearOrder.forEach(year => {
    const row = document.createElement("label");
    row.className = "chip on";
    row.innerHTML = `<input type="checkbox" checked data-year="${year}"/>
      <span class="dot" style="background:${RECENCY_COLOR_NEW}"></span>
      ${year}<span class="chip-n">${counts[year].toLocaleString()}</span>`;
    row.querySelector("input").addEventListener("change", e => {
      e.target.checked ? activeRecommendationYears.add(year) : activeRecommendationYears.delete(year);
      row.classList.toggle('on', e.target.checked);
      applyFilters();
    });
    el.appendChild(row);
  });
}
```

(`el.innerHTML = ''` guards against a second `bootstrapData()` call re-appending duplicate chips — the other chip builders don't need this because they iterate a fixed `_ORDER` constant rather than being called with a rebuilt dynamic list, but this one's list itself changes per-call.)

- [ ] **Step 7: Wire the filter into `applyFilters`**

In `applyFilters()`, next to the existing `sectorOk`/`maturityOk` lines (`index.html:1403-1404`), add:

```js
    const recommendationYearOk = activeRecommendationYears.size === recommendationYearOrder.length
      || (d._recommendationYear !== null && activeRecommendationYears.has(d._recommendationYear));
```

And add `recommendationYearOk` to the big `if` condition a few lines below (`index.html:1415`) alongside the other `*Ok` variables:

```js
    if (typeOk && ratingOk && sectorOk && maturityOk && recommendationYearOk && statusOk && epcSolarOk && epcEfficiencyOk && searchOk && minOk && maxOk && rateableMinOk && rateableMaxOk) {
```

- [ ] **Step 8: Wire the reset handler**

In the `#reset` click handler (`index.html:1446-1474`), add alongside `activeMaturities = new Set(MATURITY_ORDER);` (`index.html:1450`):

```js
  activeRecommendationYears = new Set(recommendationYearOrder);
```

And add `#recommendation-year-list` to the existing `querySelectorAll` selector list (`index.html:1460`):

```js
  document.querySelectorAll("#building-type-list input, #epc-rating-list input, #sic-sector-list input, #maturity-list input, #recommendation-year-list input").forEach(cb => {
```

- [ ] **Step 9: Verify the filter against fixture data**

Using Playwright against the local dev server: build a small fixture array of prospect-like objects covering a mix of `epc_recommends_solar` true/false and a spread of `lodgement_date` years, call `initMap(fixture)` (or directly exercise `buildRecommendationYearChips`/`applyFilters` with `allMarkers` populated as done earlier this session for the marker-cluster and prospect-fetch verifications), and confirm:
- The year chip list contains exactly the distinct years present in the fixture, sorted newest-first — no chip for a year that isn't in the data.
- With all chips left checked (untouched default), every marker passes `recommendationYearOk` — including ones where `epc_recommends_solar` is false/`_recommendationYear` is null.
- After unchecking all years except the newest one, only prospects with that exact `_recommendationYear` pass — both non-recommended prospects (null year) and other-year recommended prospects are excluded.
- Clicking "reset" restores all year chips to checked and shows everyone again.

- [ ] **Step 10: Commit**

```bash
git add index.html
git commit -m "$(cat <<'EOF'
Add solar-recommendation recency gradient and year filter

Solar-recommended prospects now render on a green (newest)-to-red
(oldest) marker gradient scaled to the real spread of lodgement_date
values present, replacing solar_status color only for that subset.
New "Solar recommendation year" sidebar chip filter follows the same
strict-once-touched pattern as sector/maturity.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
