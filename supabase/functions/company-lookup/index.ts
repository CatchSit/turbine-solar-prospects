import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const SUPABASE_ANON_KEY         = Deno.env.get('SUPABASE_ANON_KEY')!

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY) {
  throw new Error('Missing required secrets — check SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY')
}

// COMPANIES_HOUSE_API_KEY is deliberately NOT asserted at module load — unlike
// the three secrets above (platform-injected, always present), this one is a
// human-registered secret that may genuinely be unset mid-rollout. Throwing
// here would crash the whole Deno worker before Deno.serve ever registers a
// handler, so even the CORS OPTIONS preflight would get an opaque 500 (which
// browsers report as a misleading "blocked by CORS policy" error). Instead,
// checked inside the handler and returned as a clean 503 JSON error — see
// Deno.serve below.
const COMPANIES_HOUSE_API_KEY = Deno.env.get('COMPANIES_HOUSE_API_KEY')

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// This function is called cross-origin from the browser (window.db.functions.invoke),
// which sends a custom Authorization header + Content-Type: application/json and
// therefore triggers a CORS preflight OPTIONS request. Every response — including
// error paths — must carry these headers or the browser blocks the request before
// the frontend ever sees it.
//
// Access-Control-Allow-Origin is computed per-request (origin-echo against an
// allowlist) rather than '*', so it's built fresh for every request rather than
// being a module-level constant — see corsHeadersFor() and Deno.serve below.
const PROD_ORIGIN = 'https://catchsit.github.io'

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false
  if (origin === PROD_ORIGIN) return true
  // Local dev testing via `npx serve .` — any localhost port.
  return /^http:\/\/localhost(:\d+)?$/.test(origin)
}

function corsHeadersFor(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
  if (isAllowedOrigin(origin)) headers['Access-Control-Allow-Origin'] = origin as string
  return headers
}

// Companies House allows this to be re-checked periodically without ever
// exceeding the free rate limit (600 req/5 min) in an on-demand,
// per-prospect-click usage pattern — no monthly cap needed, unlike Solar API.
const CACHE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000 // 90 days
const MAX_ACTIVE_COMPANIES = 5

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

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

async function fetchOfficers(companyNumber: string): Promise<{ items: Officer[]; ok: boolean }> {
  const resp = await fetch(
    `https://api.company-information.service.gov.uk/company/${companyNumber}/officers`,
    { headers: authHeader() },
  )
  // Don't fail the whole lookup if one company's officers can't be fetched —
  // an empty officers list is still a useful company-name match. The `ok`
  // flag lets the caller distinguish "genuinely no officers" from "this
  // particular call degraded", so a transient failure doesn't get cached as
  // if it were a complete result — see the matches-building loop below.
  if (!resp.ok) return { items: [], ok: false }
  const json = await resp.json()
  return {
    // deno-lint-ignore no-explicit-any
    items: (json.items ?? [])
      .filter((o: any) => !o.resigned_on)
      // deno-lint-ignore no-explicit-any
      .map((o: any) => ({ name: o.name as string, role: o.officer_role as string })),
    ok: true,
  }
}

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

// deno-lint-ignore no-explicit-any
async function fetchPsc(companyNumber: string): Promise<{ items: Psc[]; ok: boolean }> {
  const resp = await fetch(
    `https://api.company-information.service.gov.uk/company/${companyNumber}/persons-with-significant-control`,
    { headers: authHeader() },
  )
  // Don't fail the whole lookup if PSC can't be fetched — mirrors fetchOfficers.
  if (!resp.ok) return { items: [], ok: false }
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
  return {
    items: (json.items ?? [])
      .filter((p: any) => typeof p.name === 'string' && !p.ceased_on)
      .map((p: any) => ({
        name: p.name as string,
        natures_of_control: (p.natures_of_control ?? []) as string[],
        is_corporate: typeof p.kind === 'string' && /^(corporate-entity|legal-person)/.test(p.kind),
      })),
    ok: true,
  }
}

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin')
  const CORS_HEADERS = corsHeadersFor(origin)

  function jsonResponse(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: CORS_HEADERS })
  }

  if (!COMPANIES_HOUSE_API_KEY) {
    return jsonResponse({ error: 'Lookup unavailable — COMPANIES_HOUSE_API_KEY not configured' }, 503)
  }

  // Caller-identity check: this function is invoked from the browser with the
  // signed-in user's own JWT (not the anon key alone), so verify it here with
  // an anon-key client scoped to the request's own Authorization header —
  // never trust "authenticated" as a sufficient boundary (public email signup
  // is enabled on this Supabase project; see HANDOVER.md's 003->004 RLS
  // history for the same bug class). Mirrors index.html's onAuthenticated().
  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  })
  const { data: { user }, error: authErr } = await authClient.auth.getUser()
  if (authErr || !user || !user.email?.toLowerCase().endsWith('@turbineenergyuk.co.uk')) {
    return jsonResponse({ error: 'Forbidden' }, 403)
  }

  let body: { prospect_id?: string }
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400)
  }

  const { prospect_id } = body
  if (!prospect_id) {
    return jsonResponse({ error: 'prospect_id is required' }, 400)
  }

  // The postcode is looked up server-side from the prospects table, never
  // taken from the request body — otherwise this function is an
  // authenticated-but-undomain-checked proxy for arbitrary Companies House
  // searches (any caller could pass any postcode, not just a real prospect's).
  const { data: prospect, error: prospectErr } = await db
    .from('prospects')
    .select('postcode')
    .eq('id', prospect_id)
    .maybeSingle()

  if (prospectErr) {
    console.error('Prospect lookup failed:', JSON.stringify(prospectErr))
    return jsonResponse({ error: 'Prospect lookup failed' }, 500)
  }
  if (!prospect || !prospect.postcode) {
    return jsonResponse({ error: 'Prospect not found or missing postcode' }, 404)
  }
  const postcode = prospect.postcode as string

  const { data: cached, error: cacheErr } = await db
    .from('company_lookups')
    .select('companies, no_match, fetched_at')
    .eq('prospect_id', prospect_id)
    .maybeSingle()

  if (cacheErr) {
    console.error('Cache read failed:', JSON.stringify(cacheErr))
    return jsonResponse({ error: 'Cache read failed' }, 500)
  }

  if (cached && Date.now() - new Date(cached.fetched_at).getTime() < CACHE_MAX_AGE_MS) {
    return jsonResponse({ companies: cached.companies, no_match: cached.no_match, cached: true }, 200)
  }

  const matches: CompanyMatch[] = []
  // Set true if any per-company call (officers/profile/psc) returns its
  // empty/default value because of a non-OK HTTP response rather than a
  // genuinely empty result — see the `if (!anyDegraded)` cache guard below.
  let anyDegraded = false
  try {
    const normalizedTarget = normalizePostcode(postcode)
    const results = await searchCompaniesHouse(postcode)
    // deno-lint-ignore no-explicit-any
    const activeMatches = results.filter((r: any) =>
      r.address?.postal_code &&
      normalizePostcode(r.address.postal_code) === normalizedTarget &&
      r.company_status === 'active'
    ).slice(0, MAX_ACTIVE_COMPANIES)

    for (let i = 0; i < activeMatches.length; i++) {
      const r = activeMatches[i]
      const officers = await fetchOfficers(r.company_number)
      await sleep(150)
      const profile = await fetchProfile(r.company_number)
      await sleep(150)
      const psc = await fetchPsc(r.company_number)
      if (!officers.ok || !profile.ok || !psc.ok) anyDegraded = true
      matches.push({
        company_name: r.title,
        company_number: r.company_number,
        status: r.company_status,
        officers: officers.items,
        psc: psc.items,
        sic_codes: profile.sic_codes,
        incorporated_on: profile.incorporated_on,
      })
      // Courtesy pacing between sequential external API calls, mirrors
      // solar-enrichment's sleep(150) between Google Solar API calls.
      if (i < activeMatches.length - 1) await sleep(150)
    }
  } catch (e) {
    if (e instanceof Error && e.message === 'RATE_LIMITED') {
      return jsonResponse({ error: 'Companies House rate limited — try again shortly' }, 429)
    }
    console.error('Companies House lookup failed:', e)
    return jsonResponse({ error: 'Lookup failed' }, 502)
  }

  const noMatch = matches.length === 0

  // Skip the cache write when any per-company call degraded — a transient
  // Companies House failure (429/5xx) must not get persisted for 90 days as
  // if it were a complete, genuine result. The (partial) data is still
  // returned to the frontend this one time; it just isn't cached, so the
  // next lookup re-fetches fresh instead of trusting the stale/incomplete
  // snapshot.
  if (!anyDegraded) {
    const { error: upsertErr } = await db
      .from('company_lookups')
      .upsert(
        { prospect_id, companies: matches, no_match: noMatch, fetched_at: new Date().toISOString() },
        { onConflict: 'prospect_id' },
      )
    if (upsertErr) console.error('Cache write failed:', JSON.stringify(upsertErr))
  }

  return jsonResponse({ companies: matches, no_match: noMatch, cached: false }, 200)
})
