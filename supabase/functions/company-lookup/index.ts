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
