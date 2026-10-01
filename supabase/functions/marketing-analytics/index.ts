import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Google Analytics 4 reporting for home.html's "Marketing & analytics"
// section. Manager-only, read-only. Authenticates to the GA4 Data API with a
// service account (JWT bearer grant) — the service account's email must be
// added as a Viewer on the GA4 property.
// See docs/superpowers/specs/2026-09-30-manager-home-design.md.
//
// Secrets (both optional — the page shows setup steps until they exist):
//   GA4_PROPERTY_ID            numeric property ID (Admin → Property details)
//   GA4_SERVICE_ACCOUNT_JSON   the service account's full JSON key file

const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')!
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error('Missing required secrets — check SUPABASE_URL, SUPABASE_ANON_KEY')
}
const GA4_PROPERTY_ID = Deno.env.get('GA4_PROPERTY_ID')
const GA4_SERVICE_ACCOUNT_JSON = Deno.env.get('GA4_SERVICE_ACCOUNT_JSON')

// The website plugin (te-estimate-handler v2.0) fires this event on every
// successful enquiry form submission.
const LEAD_EVENT = 'generate_lead'

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

/* ── Google service-account auth ─────────────────────────── */
function b64url(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  let bin = ''
  bytes.forEach(b => { bin += String.fromCharCode(b) })
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function googleAccessToken(sa: { client_email: string; private_key: string }): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }))
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0))
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claims}`)))
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${b64url(sig)}`,
    }),
  })
  const json = await res.json()
  if (!res.ok || !json.access_token) throw new Error(`Google sign-in failed: ${json.error_description || json.error || res.status}`)
  return json.access_token
}

/* ── GA4 Data API ────────────────────────────────────────── */
type Row = { d: string[]; m: number[] }

async function batch(token: string, requests: unknown[]): Promise<Row[][]> {
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${GA4_PROPERTY_ID}:batchRunReports`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
  })
  const json = await res.json()
  if (!res.ok) {
    const msg = json.error?.message || `HTTP ${res.status}`
    // The most common setup mistake, worded so the page can say what to fix.
    if (res.status === 403) throw new Error(`No access to GA4 property ${GA4_PROPERTY_ID} — add the service account as a Viewer in GA4 (Admin → Property access management). (${msg})`)
    throw new Error(msg)
  }
  return (json.reports || []).map((r: any) => (r.rows || []).map((row: any) => ({
    d: (row.dimensionValues || []).map((v: any) => v.value),
    m: (row.metricValues || []).map((v: any) => Number(v.value)),
  })))
}

const leadFilter = { filter: { fieldName: 'eventName', stringFilter: { value: LEAD_EVENT } } }

async function gaReport(days: number) {
  const sa = JSON.parse(GA4_SERVICE_ACCOUNT_JSON!)
  const token = await googleAccessToken(sa)
  const cur = { startDate: `${days}daysAgo`, endDate: 'today' }
  const prev = { startDate: `${days * 2}daysAgo`, endDate: `${days + 1}daysAgo` }

  const [daily, channels, pages, leadsByPage, leadsByChannel] = await batch(token, [
    { dateRanges: [cur], dimensions: [{ name: 'date' }], metrics: [{ name: 'sessions' }, { name: 'activeUsers' }],
      orderBys: [{ dimension: { dimensionName: 'date' } }] },
    { dateRanges: [cur], dimensions: [{ name: 'sessionDefaultChannelGroup' }], metrics: [{ name: 'sessions' }, { name: 'activeUsers' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 10 },
    { dateRanges: [cur], dimensions: [{ name: 'pageTitle' }], metrics: [{ name: 'screenPageViews' }, { name: 'activeUsers' }],
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }], limit: 10 },
    { dateRanges: [cur], dimensions: [{ name: 'pageTitle' }], metrics: [{ name: 'eventCount' }], dimensionFilter: leadFilter,
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }], limit: 20 },
    { dateRanges: [cur], dimensions: [{ name: 'sessionDefaultChannelGroup' }], metrics: [{ name: 'eventCount' }], dimensionFilter: leadFilter },
  ])
  const [totals, leadTotals, dailyLeads] = await batch(token, [
    { dateRanges: [cur, prev], metrics: [{ name: 'activeUsers' }, { name: 'sessions' }, { name: 'engagedSessions' }] },
    { dateRanges: [cur, prev], metrics: [{ name: 'eventCount' }], dimensionFilter: leadFilter },
    { dateRanges: [cur], dimensions: [{ name: 'date' }], metrics: [{ name: 'eventCount' }], dimensionFilter: leadFilter },
  ])

  // With two date ranges and no dimensions, GA adds a dateRange dimension
  // ("date_range_0" = current, "date_range_1" = previous).
  const byRange = (rows: Row[], idx: number) => rows.find(r => r.d[r.d.length - 1] === `date_range_${idx}`)?.m ?? []
  const t = (idx: number) => {
    const m = byRange(totals, idx)
    return { users: m[0] ?? 0, sessions: m[1] ?? 0, engaged_sessions: m[2] ?? 0, leads: byRange(leadTotals, idx)[0] ?? 0 }
  }
  const leadsOnDay = Object.fromEntries(dailyLeads.map(r => [r.d[0], r.m[0]]))
  const leadsInChannel = Object.fromEntries(leadsByChannel.map(r => [r.d[0], r.m[0]]))

  return {
    configured: true,
    days,
    totals: { current: t(0), previous: t(1) },
    daily: daily.map(r => ({ date: r.d[0], sessions: r.m[0], users: r.m[1], leads: leadsOnDay[r.d[0]] ?? 0 })),
    channels: channels.map(r => ({ name: r.d[0], sessions: r.m[0], users: r.m[1], leads: leadsInChannel[r.d[0]] ?? 0 })),
    pages: pages.map(r => ({ title: r.d[0], views: r.m[0], users: r.m[1] })),
    leads_by_page: leadsByPage.map(r => ({ title: r.d[0], leads: r.m[0] })),
  }
}

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin')
  const CORS_HEADERS = corsHeadersFor(origin)
  const json = (body: unknown, status: number) => new Response(JSON.stringify(body), {
    status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS_HEADERS })

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  })
  const { data: { user } } = await userClient.auth.getUser()
  if (!user) return json({ error: 'Forbidden' }, 403)
  const { data: isManager, error: rpcErr } = await userClient.rpc('is_manager')
  if (rpcErr || isManager !== true) return json({ error: 'Forbidden' }, 403)

  let days = 28
  try { const body = await req.json(); if ([7, 28, 90].includes(body?.days)) days = body.days } catch { /* default */ }

  if (!GA4_PROPERTY_ID || !GA4_SERVICE_ACCOUNT_JSON) {
    return json({ ga: { configured: false, has_property_id: !!GA4_PROPERTY_ID, has_service_account: !!GA4_SERVICE_ACCOUNT_JSON } }, 200)
  }
  try {
    return json({ ga: await gaReport(days) }, 200)
  } catch (e) {
    return json({ ga: { configured: true, error: String((e as Error).message || e) } }, 200)
  }
})
