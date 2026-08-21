# Solar Recommendation Recency Visual — Design

## Context

Earlier today, `lodgement_date` (the EPC assessment date — effectively "when this solar recommendation was made") was added to the popup, shown inline on the existing "EPC recommends solar" / "EPC recommends efficiency improvements" tags (e.g. "EPC recommends solar · Mar 2019"). This design surfaces that same date more prominently: on the map itself, and as a new sidebar filter, so a rep can visually spot the freshest solar-recommended leads without opening every popup.

## Goals

- Prospects where `epc_recommends_solar === true` render with a marker color on a green→red gradient: bright green for the most recently recommended, red for the oldest — computed from the real spread of `lodgement_date` values actually present, not a fixed calendar range.
- Every other prospect (no recommendation, or the flag is false/null) keeps its current `solar_status`-based marker color, completely unchanged.
- A new sidebar filter, "Solar recommendation year," with one chip per year actually present among solar-recommended prospects — same Set-based multi-select and "strict once touched" behavior as every other filter in this app (untouched = everyone passes; touch even one chip and only solar-recommended prospects in the selected year(s) pass, same as the sector/maturity filters).

## Non-goals

- No change to the existing "EPC recommends solar" checkbox filter — it stays a simple show/hide toggle, independent of the new year chips.
- No change to the popup — the date is already shown there (today's earlier work).
- No color-scale legend/key on the map — not requested; a future addition if it turns out to be needed.
- No change to cluster-icon styling (the grouped-count bubbles Leaflet.markercluster shows when zoomed out) — only individual marker color.

## Marker coloring

In `initMap(data)`, before the marker-creation loop, compute the real date bounds once:

```js
let recDateMin = null, recDateMax = null;
data.forEach(d => {
  if (d.epc_recommends_solar && d.lodgement_date) {
    const t = new Date(d.lodgement_date).getTime();
    if (recDateMin === null || t < recDateMin) recDateMin = t;
    if (recDateMax === null || t > recDateMax) recDateMax = t;
  }
});
```

`makeMarkerIcon(d)` picks up these bounds (module-level, set once per load) and, for a solar-recommended prospect with a real `lodgement_date`, replaces its normal `solar_status` color with an interpolated one:

```js
const RECENCY_COLOR_OLD = '#c0392b';   // this app's existing alert/error red
const RECENCY_COLOR_NEW = '#22c55e';   // bright green

function interpolateColor(hexA, hexB, t) {
  const a = [1, 3, 5].map(i => parseInt(hexA.slice(i, i + 2), 16));
  const b = [1, 3, 5].map(i => parseInt(hexB.slice(i, i + 2), 16));
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return `#${c.map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

function recencyColor(d) {
  if (!d.epc_recommends_solar || !d.lodgement_date) return null;
  const t = new Date(d.lodgement_date).getTime();
  if (recDateMin === null || recDateMax === null || recDateMin === recDateMax) return RECENCY_COLOR_NEW;
  const ratio = (t - recDateMin) / (recDateMax - recDateMin);
  return interpolateColor(RECENCY_COLOR_OLD, RECENCY_COLOR_NEW, ratio);
}
```

`makeMarkerIcon` uses `recencyColor(d) || SOLAR_STATUS[d.solar_status]?.color || '#000000'` in place of its current plain `SOLAR_STATUS[d.solar_status]` lookup — a solar-recommended prospect with a real date always gets the gradient color; everything else falls through to today's existing behavior unchanged.

## Sidebar filter: "Solar recommendation year"

New precomputed field alongside the existing `d._bucket`/`d._sicSector`/`d._maturity` in `initMap`:

```js
d._recommendationYear = (d.epc_recommends_solar && d.lodgement_date)
  ? new Date(d.lodgement_date).getFullYear()
  : null;
```

A new chip-builder, `buildRecommendationYearChips(data)`, mirroring `buildBuildingTypeChips` but with a dynamically-discovered order (years aren't a fixed enum like building types) — collect the distinct `_recommendationYear` values present, sort descending (newest first), one chip per year with its count, all checked by default. New `activeRecommendationYears` Set, and in `applyFilters()`:

```js
const recommendationYearOk = activeRecommendationYears.size === recommendationYearOrder.length
  || (d._recommendationYear !== null && activeRecommendationYears.has(d._recommendationYear));
```

— same "strict once touched" shape as `sectorOk`/`maturityOk`: untouched passes everyone (including prospects with no recommendation at all, `_recommendationYear === null`), but touching even one chip makes it strict, dropping non-recommended prospects out along with any recommended-but-wrong-year ones.

## Testing & verification

No automated test framework in this repo — live-verified the same way as today's earlier fixes:
- `interpolateColor`/`recencyColor` checked against fixture data spanning a real date range, confirming the newest date renders the exact bright-green endpoint, the oldest renders the exact red endpoint, and a midpoint date renders a real blend (not one of the two endpoints).
- Confirm a prospect with `epc_recommends_solar: false` (or `null`) keeps its ordinary `solar_status` color unchanged.
- Confirm the year chips list only shows years actually present in the loaded data (not a hardcoded 2011–2026 range that might include empty years).
- Confirm the "strict once touched" behavior: selecting only the most recent year filters out both older-recommended and never-recommended prospects; leaving all chips checked shows everyone, same as today.
