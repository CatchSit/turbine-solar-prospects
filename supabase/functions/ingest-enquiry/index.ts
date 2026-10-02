import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Website enquiry -> CRM lead (2026-10-02). Called server-to-server by the
// turbineenergyuk.co.uk WordPress plugin (te-estimate-handler v2.1) after
// every enquiry form submission. No user session exists, so instead of a JWT
// the caller must send the shared secret WEBSITE_INGEST_SECRET in the
// x-ingest-secret header (verify_jwt is off for this function in
// config.toml). The website's own info@ email still sends regardless - this
// is in addition to it, never instead.
//
// Decisions (Greg, 2026-10-02): quote wizards always create leads; Contact
// messages only for sales topics; a repeat enquirer (same email or phone as
// an existing CRM lead) is added to that lead, not duplicated; new website
// leads are assigned to Greg.
// See migration 045 and docs/superpowers/specs/2026-09-30-manager-home-design.md.

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing required secrets \u2014 check SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY')
}
const INGEST_SECRET = Deno.env.get('WEBSITE_INGEST_SECRET')
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const ASSIGN_TO = 'greg@turbineenergyuk.co.uk'

// Contact page <select id="tc-subject"> option values.
const CONTACT_TOPICS: Record<string, { label: string; leadType: string | null } | null> = {
  quote:      { label: 'Request a quote',              leadType: 'domestic' },  // most enquiries are domestic; a rep can change it
  domestic:   { label: 'Domestic solar installation',  leadType: 'domestic' },
  commercial: { label: 'Commercial solar installation', leadType: 'commercial' },
  battery:    { label: 'Battery storage',              leadType: 'domestic' },
  heatpump:   { label: 'Air source heat pump',         leadType: 'domestic' },
  aftersales: null,   // email only \u2014 not a sales lead
  other:      null,
  '':         null,
}

type Attribution = {
  landing_page?: string; referrer?: string; utm_source?: string; utm_medium?: string
  utm_campaign?: string; utm_term?: string; utm_content?: string; gclid?: string; fbclid?: string
}

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b)
  if (ea.length !== eb.length) return false
  let diff = 0
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i]
  return diff === 0
}

const clip = (v: unknown, n = 500) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null)
const digits = (p: string | null) => (p || '').replace(/\D/g, '').slice(-10)

function classify(action: string, subject: string) {
  if (action === 'te_estimate_enquiry') return { form: 'Solar estimate', leadType: 'domestic', company: null as string | null }
  if (subject === 'Air Source Heat Pump Quote') return { form: subject, leadType: 'domestic', company: null }
  if (subject === 'Air to Air Heat Pump Quote') return { form: subject, leadType: 'domestic', company: null }
  if (subject.startsWith('Commercial Solar Quote')) {
    // Everything after the prefix, minus whatever dash/separator follows it.
    const company = subject.slice('Commercial Solar Quote'.length).replace(/^[\s\u2013\u2014:|-]+/, '').trim() || null
    return { form: 'Commercial Solar Quote', leadType: 'commercial', company }
  }
  const topic = CONTACT_TOPICS[subject]
  if (topic === undefined) return { form: `Contact \u2014 ${subject}`, leadType: 'domestic', company: null }  // unknown topic: keep it
  if (topic === null) return null                                                                   // non-sales: skip
  return { form: `Contact \u2014 ${topic.label}`, leadType: topic.leadType, company: null }
}

function lineValue(text: string, label: string): string | null {
  const m = text.match(new RegExp(`${label}:\\s*([^\\n]+)`, 'i'))
  const v = m?.[1]?.trim()
  return v && !/^not provided$/i.test(v) ? v : null
}

function paramsOf(url: string | null): URLSearchParams {
  try { return url ? new URL(url).searchParams : new URLSearchParams() } catch { return new URLSearchParams() }
}

// Where the visitor came from, in plain words for the dashboard.
function deriveChannel(a: Attribution, consented: boolean): string {
  const src = (a.utm_source || '').toLowerCase()
  const med = (a.utm_medium || '').toLowerCase()
  const paid = /cpc|ppc|paid|display|cpm/.test(med)
  if (a.gclid || (paid && /google/.test(src))) return 'Google Ads'
  if (a.fbclid || /facebook|instagram|^fb$|^ig$|meta/.test(src)) return paid || a.fbclid ? 'Meta Ads' : 'Facebook / Instagram'
  if (/linkedin/.test(src)) return paid ? 'LinkedIn Ads' : 'LinkedIn'
  if (paid) return `Paid \u2014 ${a.utm_source || 'other'}`
  if (med === 'email' || /newsletter|brevo|mailchimp/.test(src)) return 'Email'
  if (src) return `Campaign \u2014 ${a.utm_source}`
  if (!consented) return 'Not tracked (no cookie consent)'
  let host = ''
  try { host = a.referrer ? new URL(a.referrer).hostname.replace(/^www\./, '') : '' } catch { /* bad referrer */ }
  if (!host || host.endsWith('turbineenergyuk.co.uk')) return 'Direct'
  if (/google\.|bing\.|duckduckgo\.|yahoo\.|ecosia\./.test(host)) return 'Organic search'
  if (/facebook\.|instagram\.|linkedin\.|t\.co$|x\.com|twitter\.|tiktok\./.test(host)) return 'Social'
  if (/chatgpt\.|openai\.|perplexity\.|claude\.ai|gemini\.google|copilot\./.test(host)) return 'AI assistant'
  return `Referral \u2014 ${host}`
}

async function geocode(postcode: string | null) {
  if (!postcode) return null
  try {
    const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`, { signal: AbortSignal.timeout(6000) })
    const j = await r.json()
    return j.status === 200 ? j.result : null
  } catch { return null }
}

async function findExistingLead(email: string | null, phone: string | null): Promise<string | null> {
  if (email) {
    const { data } = await db.from('prospects').select('id').eq('source', 'manual').ilike('contact_email', email).limit(1)
    if (data?.length) return data[0].id
  }
  const want = digits(phone)
  if (want.length >= 9) {
    const { data } = await db.from('prospects').select('id, contact_phone').eq('source', 'manual').not('contact_phone', 'is', null)
    const hit = (data || []).find(p => digits(p.contact_phone) === want)
    if (hit) return hit.id
  }
  return null
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)
  if (!INGEST_SECRET) return json({ error: 'Unavailable \u2014 WEBSITE_INGEST_SECRET not configured' }, 503)
  if (!timingSafeEqual(req.headers.get('x-ingest-secret') || '', INGEST_SECRET)) return json({ error: 'Forbidden' }, 403)

  let b: Record<string, unknown>
  try { b = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }

  const action = clip(b.action, 60) || ''
  const subject = clip(b.subject, 200) || ''
  const kind = classify(action, subject)
  if (!kind) return json({ skipped: true, reason: 'non-sales contact topic' }, 200)

  const name = clip(b.name, 200)
  const email = clip(b.email, 200)?.toLowerCase() ?? null
  const phone = clip(b.phone, 60)
  const message = clip(b.message, 5000)
  if (!name || (!email && !phone)) return json({ error: 'name and email or phone required' }, 400)

  const postcode = lineValue(message || '', 'Postcode')?.toUpperCase() ?? null
  const address = lineValue(message || '', 'Address')
  const pageUrl = clip(b.page_url, 1000)
  const consented = !!b.attribution && typeof b.attribution === 'object'
  const a: Attribution = consented ? b.attribution as Attribution : {}
  // Without consent there's no stored first-touch data, but campaign tags on
  // the page the form was sent from can still be read.
  const pageParams = paramsOf(pageUrl)
  const pick = (k: keyof Attribution) => clip(a[k], 1000) ?? clip(pageParams.get(k), 1000)
  const attrib: Attribution = {
    landing_page: clip(a.landing_page, 1000) ?? undefined, referrer: clip(a.referrer, 1000) ?? undefined,
    utm_source: pick('utm_source') ?? undefined, utm_medium: pick('utm_medium') ?? undefined,
    utm_campaign: pick('utm_campaign') ?? undefined, utm_term: pick('utm_term') ?? undefined,
    utm_content: pick('utm_content') ?? undefined, gclid: pick('gclid') ?? undefined, fbclid: pick('fbclid') ?? undefined,
  }
  const channel = deriveChannel(attrib, consented)

  let prospectId = await findExistingLead(email, phone)
  const isNew = !prospectId
  if (isNew) {
    const geo = await geocode(postcode)
    const { data, error } = await db.from('prospects').insert({
      source: 'manual',
      lead_channel: 'website',
      region: 'yorkshire-humber',
      customer_name: kind.company ? `${name} \u2014 ${kind.company}` : name,
      lead_type: kind.leadType,
      contact_phone: phone,
      contact_email: email,
      address,
      postcode: geo?.postcode ?? postcode,
      local_authority: geo?.admin_district ?? null,
      lat: geo?.latitude ?? null,
      lng: geo?.longitude ?? null,
      geocode_source: geo ? 'postcodes.io' : null,
      assigned_to_email: ASSIGN_TO,
    }).select('id').single()
    if (error) { console.error('ingest-enquiry: prospect insert failed', error); return json({ error: 'Lead insert failed' }, 500) }
    prospectId = data.id
  }

  const { error: logErr } = await db.from('website_enquiries').insert({
    prospect_id: prospectId, form: kind.form, name, email, phone, postcode, message,
    is_new_lead: isNew, page_url: pageUrl, channel,
    landing_page: attrib.landing_page ?? null, referrer: attrib.referrer ?? null,
    utm_source: attrib.utm_source ?? null, utm_medium: attrib.utm_medium ?? null, utm_campaign: attrib.utm_campaign ?? null,
    utm_term: attrib.utm_term ?? null, utm_content: attrib.utm_content ?? null, gclid: attrib.gclid ?? null, fbclid: attrib.fbclid ?? null,
  })
  if (logErr) console.error('ingest-enquiry: website_enquiries insert failed', logErr)

  return json({ ok: true, prospect_id: prospectId, new_lead: isNew, form: kind.form, channel }, 200)
})
