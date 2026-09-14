import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const SUPABASE_ANON_KEY         = Deno.env.get('SUPABASE_ANON_KEY')!

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY) {
  throw new Error('Missing required secrets — check SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY')
}

// Human-registered, may genuinely be unset — not asserted at module load for
// the same reason as company-lookup's COMPANIES_HOUSE_API_KEY: throwing here
// would crash the worker before Deno.serve registers a handler, turning even
// the CORS preflight into an opaque 500. Checked per-provider inside the
// handler instead.
const APOLLO_API_KEY = Deno.env.get('APOLLO_API_KEY')
const HUNTER_API_KEY = Deno.env.get('HUNTER_API_KEY')

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// Same origin-echo CORS pattern as company-lookup/solar-enrichment — this is
// called directly from the browser (window.db.functions.invoke).
const PROD_ORIGIN = 'https://catchsit.github.io'

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false
  if (origin === PROD_ORIGIN) return true
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

// Self-imposed budgets, independent of whatever quota Apollo/Hunter show in
// their own dashboards — same reasoning as solar-enrichment's MONTHLY_CAP:
// the app must never rely solely on the provider's own account limits to
// avoid running up paid overages. These numbers are free-tier placeholders;
// update them to match whatever plan is actually purchased once the API
// keys are in hand (Hunter's free plan is a confirmed 50 credits/month;
// Apollo's free-tier credit count wasn't confirmed at build time — check
// the account's actual allowance and adjust APOLLO_CAP accordingly).
const MONTHLY_CAPS: Record<string, number> = {
  apollo: 50,
  hunter: 50,
}
const API_NAMES: Record<string, string> = {
  apollo: 'apollo_search',
  hunter: 'hunter_search',
}

function currentPeriod(): string {
  const now = new Date()
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

async function usedThisPeriod(apiName: string, period: string): Promise<number> {
  const { data, error } = await db
    .from('api_usage')
    .select('request_count')
    .eq('api_name', apiName)
    .eq('period', period)
    .maybeSingle()
  if (error) throw new Error(`Failed to read api_usage: ${JSON.stringify(error)}`)
  return data?.request_count ?? 0
}

async function recordUsage(apiName: string, period: string, newCount: number) {
  await db.from('api_usage').upsert(
    { api_name: apiName, period, request_count: newCount, updated_at: new Date().toISOString() },
    { onConflict: 'api_name,period' },
  )
}

// Crude first/last split — good enough for Companies House officer names
// and rep-entered customer names, neither of which carry titles/suffixes in
// practice. A single-token name (rare) is sent as both first and last, since
// both providers want some value in each field.
function splitName(fullName: string): { first: string; last: string } {
  const parts = fullName.trim().split(/\s+/)
  if (parts.length === 1) return { first: parts[0], last: parts[0] }
  return { first: parts[0], last: parts.slice(1).join(' ') }
}

type EnrichResult = { email: string | null; phone: string | null }

async function searchApollo(firstName: string, lastName: string, company: string | null): Promise<EnrichResult> {
  const resp = await fetch('https://api.apollo.io/api/v1/people/match', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': APOLLO_API_KEY! },
    body: JSON.stringify({
      first_name: firstName,
      last_name: lastName,
      ...(company ? { organization_name: company } : {}),
      reveal_personal_emails: true,
      // Apollo's phone reveal can run as an async carrier lookup on some
      // plans (webhook-delivered) rather than returning inline — if
      // person.phone_numbers comes back empty below, that means "not
      // available synchronously", not necessarily "no phone exists".
      reveal_phone_number: true,
    }),
  })
  if (!resp.ok) throw new Error(`Apollo request failed: ${resp.status} ${await resp.text()}`)
  const json = await resp.json()
  const person = json?.person ?? null
  const email = person?.email && !String(person.email).includes('not_unlocked') ? person.email : null
  const phone = person?.phone_numbers?.[0]?.sanitized_number ?? person?.phone_numbers?.[0]?.raw_number ?? null
  return { email, phone }
}

async function searchHunter(firstName: string, lastName: string, company: string): Promise<EnrichResult> {
  const url = new URL('https://api.hunter.io/v2/email-finder')
  url.searchParams.set('first_name', firstName)
  url.searchParams.set('last_name', lastName)
  url.searchParams.set('company', company)
  url.searchParams.set('api_key', HUNTER_API_KEY!)

  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`Hunter request failed: ${resp.status} ${await resp.text()}`)
  const json = await resp.json()
  const data = json?.data ?? null
  // Hunter is email-only by design — phone_number is opportunistically
  // included on some records when a source happened to surface one, never
  // guaranteed the way the email result is.
  return { email: data?.email ?? null, phone: data?.phone_number ?? null }
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

  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  })
  const { data: { user }, error: authErr } = await authClient.auth.getUser()
  if (authErr || !user || !user.email?.toLowerCase().endsWith('@turbineenergyuk.co.uk')) {
    return jsonResponse({ error: 'Unauthorized' }, 401)
  }

  let body: { prospect_id?: string; provider?: string }
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400)
  }

  const { prospect_id, provider } = body
  if (!prospect_id || !provider || !(provider in API_NAMES)) {
    return jsonResponse({ error: 'prospect_id and a valid provider (apollo|hunter) are required' }, 400)
  }
  if (provider === 'apollo' && !APOLLO_API_KEY) {
    return jsonResponse({ error: 'Apollo lookup unavailable — APOLLO_API_KEY not configured' }, 503)
  }
  if (provider === 'hunter' && !HUNTER_API_KEY) {
    return jsonResponse({ error: 'Hunter lookup unavailable — HUNTER_API_KEY not configured' }, 503)
  }

  const { data: prospect, error: prospectErr } = await db
    .from('prospects')
    .select('id, source, customer_name, contact_email, contact_phone')
    .eq('id', prospect_id)
    .maybeSingle()
  if (prospectErr) {
    console.error('Prospect lookup failed:', JSON.stringify(prospectErr))
    return jsonResponse({ error: 'Prospect lookup failed' }, 500)
  }
  if (!prospect) {
    return jsonResponse({ error: 'Prospect not found' }, 404)
  }

  // Who to search for: a manual lead already has its own customer_name; a
  // scraped commercial prospect has no named person of its own, so reuse
  // whatever company-lookup already found and cached (company_lookups,
  // populated whenever the rep opened this prospect's card — see
  // loadCompanyMatch() in index.html) rather than re-querying Companies
  // House here and spending that budget twice.
  let targetName: string | null = null
  let targetCompany: string | null = null

  if (prospect.source === 'manual') {
    targetName = (prospect.customer_name as string) || null
  } else {
    const { data: cached } = await db
      .from('company_lookups')
      .select('companies')
      .eq('prospect_id', prospect_id)
      .maybeSingle()
    // deno-lint-ignore no-explicit-any
    const companies = (cached?.companies ?? []) as any[]
    const best = companies.find(c => c.address_match) ?? companies[0] ?? null
    if (best) {
      targetCompany = best.company_name ?? null
      targetName = best.officers?.[0]?.name ?? null
    }
  }

  if (!targetName && !targetCompany) {
    return jsonResponse({ error: 'No company or contact name known for this prospect yet — open its card so the company match runs first, then try again.' }, 422)
  }
  if (provider === 'hunter' && !targetCompany) {
    return jsonResponse({ error: 'Hunter needs a company name to search — not available for this lead.' }, 422)
  }
  if (!targetName) {
    return jsonResponse({ error: 'No named contact (director/officer) found for this company yet.' }, 422)
  }

  const apiName = API_NAMES[provider]
  const period = currentPeriod()
  let used: number
  try {
    used = await usedThisPeriod(apiName, period)
  } catch (e) {
    console.error(e)
    return jsonResponse({ error: 'Failed to read usage' }, 500)
  }
  const cap = MONTHLY_CAPS[provider]
  if (used >= cap) {
    return jsonResponse({ error: `Monthly ${provider} search budget (${cap}) used up for ${period}.`, budgetExhausted: true, used, cap }, 200)
  }

  const { first, last } = splitName(targetName)
  let result: EnrichResult
  let status: 'found' | 'not_found' | 'error' = 'not_found'
  let errorMessage: string | null = null

  try {
    result = provider === 'apollo'
      ? await searchApollo(first, last, targetCompany)
      : await searchHunter(first, last, targetCompany!)
    status = (result.email || result.phone) ? 'found' : 'not_found'
  } catch (e) {
    console.error(`${provider} search failed:`, e)
    result = { email: null, phone: null }
    status = 'error'
    errorMessage = String(e)
  }

  // Every attempt — found, not_found, or error — consumes real provider
  // budget the moment the request goes out, so this counts regardless of
  // outcome, same as solar-enrichment counting failed Solar API calls.
  await recordUsage(apiName, period, used + 1)

  await db.from('contact_enrichment_log').insert({
    prospect_id,
    provider,
    requested_by_email: user.email,
    target_name: targetName,
    target_company: targetCompany,
    found_email: result.email,
    found_phone: result.phone,
    status,
    error_message: errorMessage,
  })

  // Fill gaps only — never overwrite a phone/email a rep already entered or
  // a previous enrichment already found.
  const updates: Record<string, string> = {}
  if (result.email && !prospect.contact_email) updates.contact_email = result.email
  if (result.phone && !prospect.contact_phone) updates.contact_phone = result.phone
  if (Object.keys(updates).length) {
    await db.from('prospects').update(updates).eq('id', prospect_id)
  }

  return jsonResponse({
    provider,
    status,
    email: result.email,
    phone: result.phone,
    target_name: targetName,
    target_company: targetCompany,
    used: used + 1,
    cap,
    error: errorMessage,
  }, 200)
})
