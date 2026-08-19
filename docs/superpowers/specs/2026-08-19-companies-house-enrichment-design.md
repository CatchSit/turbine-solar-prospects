# Companies House Enrichment (PSC, SIC, Incorporation Date) — Design

## Context

The `company-lookup` Edge Function (shipped 2026-08-17, see `docs/superpowers/specs/2026-08-17-decision-maker-contact-design.md`) already surfaces a matched company's name, status, and active officers per prospect. Officers alone can be a weak signal for "who to actually ask for" — the list can include a company secretary or formation agent rather than the person who owns/controls the business. Companies House's free API exposes richer data already reachable with the same registered API key: Persons with Significant Control (PSC), SIC industry codes, and incorporation date. This design adds those three fields, all free, no new billing, no new external dependency.

This is one of three independent, free enrichment ideas raised together (Companies House fields, an EPC "recommendations" dataset, VOA business rates) — see the parent brainstorm. Each gets its own spec; this one covers Companies House only.

## Goals

- Surface a more reliable "who's actually in charge" signal via PSC, shown separately from the existing officers list.
- Give reps sector context (SIC) and a quick trading-history signal (incorporation date) without adding invented or approximated data.
- No new cost, no new billing, no new external service — extend the existing Companies House integration only.
- Never regress the existing officers/company-match behavior — this is additive.

## Non-goals

- No change to which companies match a prospect (the existing postcode-matching logic in `searchCompaniesHouse` is untouched).
- No filtering of the existing officers list (decided during brainstorming — PSC is additive, not a replacement).
- No SIC/PSC data for dissolved companies beyond what's already fetched (dissolved companies are already de-emphasized in the UI; this doesn't change that).

## Architecture

For each matched company (already capped at 5 per prospect via `MAX_ACTIVE_COMPANIES`), `company-lookup/index.ts` currently makes one Companies House call (`GET /company/{number}/officers`). This adds two more calls per matched company, using the same sequential-with-150ms-sleep courtesy pacing already used between companies:

1. `GET /company/{number}` (company profile) — read `sic_codes: string[]` and `date_of_creation: string`.
2. `GET /company/{number}/persons-with-significant-control` — read `items[]`, keep entries where:
   - `ceased_on` is absent (mirrors the existing `resigned_on` filter on officers), and
   - `kind` is not one of the "statement" kinds (e.g. `psc-exempt-as-trading-on-regulated-market`, `no-individual-or-entity-with-signficant-control`) — those represent "nothing to report," not a real PSC.
   - For each kept entry, record `name`, `natures_of_control: string[]`, and `is_corporate` (true when `kind` starts with `corporate-entity-` or `legal-person-`, false for `individual-person-with-significant-control`).

Worst case this raises Companies House calls per prospect lookup from ~6 to ~16 (1 search + 5 companies × 3 calls). Still far under the 600-requests/5-minute free-tier limit, and the existing 90-day cache means a given prospect only triggers this once per quarter.

Each of the three per-company calls fails independently without failing the whole match — mirrors the existing `fetchOfficers` precedent (a failed profile or PSC call just means that company's card shows less detail, not an error).

## Data & cache changes

No migration needed — `company_lookups.companies` is already `jsonb`. The `CompanyMatch` shape (both the Edge Function's TypeScript type and what's stored/returned) grows:

```ts
type Psc = { name: string; natures_of_control: string[]; is_corporate: boolean }
type CompanyMatch = {
  company_name: string
  company_number: string
  status: string
  officers: Officer[]
  psc: Psc[]                       // new
  sic_codes: string[]              // new — raw codes only, e.g. ["25110"]
  incorporated_on: string | null   // new — ISO date, e.g. "2014-03-12"
}
```

Cached rows written before this change lack `psc`/`sic_codes`/`incorporated_on`. The frontend must treat their absence as "unknown" (render nothing for that sub-section) rather than throwing — these rows will self-heal once their 90-day cache expires and they're re-fetched.

## New static data (client-side, not cached server-side)

Following this project's established pattern of small `shared/*-config.js` code→label maps (`solar-status-config.js`, `epc-rating-config.js`, `contact-outcome-config.js`):

- **`shared/sic-codes.js`** — the real UK SIC 2007 code→description table (~730 entries), sourced from the authoritative ONS/Companies House published list. This must be the real published table, not an approximation — a wrong sector label shown as fact to a rep is worse than no label at all. Only the raw code is cached server-side; the description lookup happens client-side, so the same code doesn't get its description duplicated across every prospect that shares it.
- **A small nature-of-control code→plain-English map** (~20 known values, e.g. `ownership-of-shares-75-to-100-percent` → "75-100% shares") — small enough to live inline in `index.html` alongside the popup-rendering code, or its own tiny shared file if that reads cleaner during implementation.

## Frontend changes (`index.html`)

- Company header area gets two new lines: SIC description(s) (joined if more than one) and "Trading since `<year>`" (computed from `incorporated_on`), styled with the existing `popup-section-label` pattern.
- A new **"Significant control"** sub-section beneath the existing officers list, listing each PSC's name + nature(s) of control in plain English; corporate PSCs are suffixed `(company)` so a rep doesn't try to phone an organization as if it were a person.
- If a company has no PSC data (common for smaller/exempt companies) or no SIC codes, that sub-section/line is simply omitted — no empty placeholder, no error styling.

## Testing & verification

- Spot-check the same ~10-15 real prospects already planned for the original Companies House verification (2026-08-17 design, "Testing & verification"), now also confirming PSC/SIC/incorporation date render correctly against real, independently-checkable companies.
- Confirm a company with a corporate (non-individual) PSC renders the `(company)` label correctly.
- Confirm a company with no PSC data (statement-only response) renders with the section simply absent, not broken.
- Confirm an old cached row (pre-dating this change) still renders without error — missing new fields treated as "unknown."
