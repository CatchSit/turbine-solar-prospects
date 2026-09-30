import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Server-side system checks for home.html's "System health" and "API usage"
// sections — things the browser can't do itself because of CORS (reading the
// WordPress site's HTML, calling Brevo) or shouldn't (knowing which secrets
// exist). Manager-only. Read-only: never writes anywhere, never returns a
// secret's value, only whether it's set.
// See docs/superpowers/specs/2026-09-30-manager-home-design.md.

const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')!
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error('Missing required secrets — check SUPABASE_URL, SUPABASE_ANON_KEY')
}

// Optional, human-registered — checked per request, never asserted at load
// (same reasoning as notify-assignment's BREVO_API_KEY).
const BREVO_API_KEY = Deno.env.get('BREVO_API_KEY')

// Secrets whose presence is reported (booleans only). Grouped by the feature
// they unlock so the page can say what's blocked, not just what's missing.
const SECRETS: Record<string, string[]> = {
  'Solar enrichment (Google Solar API)': ['GOOGLE_SOLAR_API_KEY'],
  'Companies House lookup':              ['COMPANIES_HOUSE_API_KEY'],
  'Send to install-hub':                 ['INSTALL_HUB_SHARED_SECRET'],
  'Lead assignment emails (Brevo)':      ['BREVO_API_KEY'],
  'SMS reminders (Twilio)':              ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER'],
  'Contact enrichment (Apollo)':         ['APOLLO_API_KEY'],
  'Contact enrichment (Hunter)':         ['HUNTER_API_KEY'],
}

const FUNCTIONS = [
  'solar-enrichment', 'company-lookup', 'send-to-install-hub', 'notify-assignment',
  'sms-scheduler', 'sms-inbound', 'contact-enrichment',
]

const SITE = 'https://www.turbineenergyuk.co.uk'
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
// The Brevo account that owns the authenticated turbineenergyuk.co.uk domain
// (turbine-homepage HANDOVER.md, 2026-09-21) — a key from any other account
// is the exact misconfiguration that sent enquiry emails to spam before.
const EXPECTED_BREVO_ACCOUNT = 11558688

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

async function timed(url: string, init: RequestInit = {}) {
  const started = Date.now()
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) })
    const text = await res.text()
    return { ok: true, status: res.status, ms: Date.now() - started, text }
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - started, text: '', error: String(e) }
  }
}

async function checkWebsite() {
  const home = await timed(SITE + '/', { headers: { 'User-Agent': BROWSER_UA } })
  // Rollback detection (turbine-homepage HANDOVER.md "Fast diagnosis"): page
  // 767 exists only in the live /wordpress/ install. Via the root dispatcher
  // it 404s when public_html/index.php has been flipped back to the old site.
  const rest = await timed(SITE + '/index.php?rest_route=/wp/v2/pages/767', { headers: { 'User-Agent': BROWSER_UA } })
  const html = home.text.toLowerCase()
  return {
    up: home.ok && home.status === 200,
    status: home.status,
    ms: home.ms,
    error: home.error ?? null,
    has_current_content: html.includes('vax ex'),
    has_old_2024_hero: html.includes('save up to 80'),
    rest_page_767_status: rest.status,
  }
}

async function brevo(path: string) {
  const r = await timed('https://api.brevo.com/v3' + path, {
    headers: { 'api-key': BREVO_API_KEY!, 'accept': 'application/json' },
  })
  let json: any = null
  try { json = JSON.parse(r.text) } catch { /* non-JSON error page */ }
  return { status: r.status, json }
}

async function checkBrevo() {
  if (!BREVO_API_KEY) return { configured: false }
  const [account, domains, stats] = await Promise.all([
    brevo('/account'),
    brevo('/senders/domains'),
    brevo('/smtp/statistics/aggregatedReport?days=30'),
  ])
  if (account.status !== 200) return { configured: true, key_valid: false, status: account.status }
  const a = account.json ?? {}
  const accountId = a.userId ?? a.user_id ?? a.organization?.userId ?? null
  const domain = (domains.json?.domains ?? []).find((d: any) => d.domain_name === 'turbineenergyuk.co.uk') ?? null
  const s = stats.status === 200 ? stats.json : null
  return {
    configured: true,
    key_valid: true,
    account_id: accountId,
    account_matches: accountId === null ? null : Number(accountId) === EXPECTED_BREVO_ACCOUNT,
    plan: (a.plan ?? []).map((p: any) => ({ type: p.type, credits: p.credits, credits_type: p.creditsType })),
    domain_authenticated: domain ? !!domain.authenticated : false,
    domain_verified: domain ? !!domain.verified : false,
    last_30_days: s ? {
      requests: s.requests ?? 0, delivered: s.delivered ?? 0, opens: s.uniqueOpens ?? s.opens ?? 0,
      hard_bounces: s.hardBounces ?? 0, soft_bounces: s.softBounces ?? 0, spam_reports: s.spamReports ?? 0,
      blocked: s.blocked ?? 0,
    } : null,
  }
}

async function checkFunctions() {
  // A CORS preflight is answered by any deployed function without running its
  // real logic; an undeployed name returns 404 from the platform.
  const results = await Promise.all(FUNCTIONS.map(async name => {
    const r = await timed(`${SUPABASE_URL}/functions/v1/${name}`, {
      method: 'OPTIONS',
      headers: { 'Origin': PROD_ORIGIN, 'Access-Control-Request-Method': 'POST' },
    })
    return [name, r.status !== 404 && r.status !== 0] as const
  }))
  return Object.fromEntries(results)
}

function checkSecrets() {
  return Object.fromEntries(Object.entries(SECRETS).map(([feature, names]) =>
    [feature, names.every(n => !!Deno.env.get(n))]))
}

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin')
  const CORS_HEADERS = corsHeadersFor(origin)
  const json = (body: unknown, status: number) => new Response(JSON.stringify(body), {
    status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })

  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS_HEADERS })

  // Manager check runs as the caller (is_manager() reads their own JWT), so
  // there's no client-supplied identity to trust.
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  })
  const { data: { user } } = await userClient.auth.getUser()
  if (!user) return json({ error: 'Forbidden' }, 403)
  const { data: isManager, error: rpcErr } = await userClient.rpc('is_manager')
  if (rpcErr || isManager !== true) return json({ error: 'Forbidden' }, 403)

  const [website, brevoResult, functions] = await Promise.all([checkWebsite(), checkBrevo(), checkFunctions()])
  return json({
    checked_at: new Date().toISOString(),
    website,
    brevo: brevoResult,
    functions,
    secrets: checkSecrets(),
  }, 200)
})
