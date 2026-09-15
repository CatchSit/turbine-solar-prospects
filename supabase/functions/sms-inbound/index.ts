import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing required secrets — check SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY')
}

// Not asserted at module load — same reasoning as every other
// human-registered secret in this project (company-lookup's
// COMPANIES_HOUSE_API_KEY, sms-scheduler's TWILIO_* secrets).
const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN')

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// This is Twilio's webhook, not a Turbine Energy user or the browser app —
// no Origin/CORS handling, no Supabase JWT (Twilio can't supply one). It's
// registered in config.toml with verify_jwt = false, and instead validated
// via Twilio's own request-signing scheme so an arbitrary POST to this URL
// can't flip a customer's sms_opt_out flag.
//
// Algorithm (https://www.twilio.com/docs/usage/security#validating-requests):
// HMAC-SHA1 of (webhook URL + all POST params, sorted by key, key+value
// concatenated with no separator) using the Auth Token as the HMAC key,
// base64-encoded, compared to the X-Twilio-Signature header.
async function validateTwilioSignature(url: string, params: URLSearchParams, signature: string | null): Promise<boolean> {
  if (!signature || !TWILIO_AUTH_TOKEN) return false
  const sortedKeys = [...params.keys()].sort()
  let data = url
  for (const key of sortedKeys) data += key + params.get(key)

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(TWILIO_AUTH_TOKEN),
    { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'],
  )
  const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))
  const computed = btoa(String.fromCharCode(...new Uint8Array(sigBuffer)))
  return computed === signature
}

// Twilio's own documented list of case-insensitive opt-out keywords
// (https://www.twilio.com/docs/messaging/compliance/opt-out-management) —
// matched on the whole trimmed message body, not a substring, so "stop by
// the office" doesn't false-positive.
const STOP_KEYWORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'])

function normalizeUkPhone(raw: string): string {
  // Last 10 digits as the matching key — collapses +447…/447…/07… down to
  // the same value regardless of which form was stored vs. which form
  // Twilio sends the inbound "From" as.
  const digits = raw.replace(/\D/g, '')
  return digits.slice(-10)
}

const TWIML_EMPTY = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(TWIML_EMPTY, { status: 200, headers: { 'Content-Type': 'text/xml' } })
  }

  const rawBody = await req.text()
  const params = new URLSearchParams(rawBody)

  // The URL Twilio actually signed against is this function's own public
  // URL (must match exactly what's configured in the Twilio console,
  // including https:// and no trailing slash) — SUPABASE_URL + the path,
  // not req.url, since Supabase's edge runtime may see a different internal
  // URL than the one Twilio called.
  const webhookUrl = `${SUPABASE_URL}/functions/v1/sms-inbound`
  const signature = req.headers.get('X-Twilio-Signature')
  const valid = await validateTwilioSignature(webhookUrl, params, signature)
  if (!valid) {
    console.warn('sms-inbound: rejected request with invalid/missing Twilio signature')
    return new Response('Forbidden', { status: 403 })
  }

  const from = params.get('From') || ''
  const body = (params.get('Body') || '').trim()
  const normalizedFrom = normalizeUkPhone(from)

  if (normalizedFrom && STOP_KEYWORDS.has(body.toUpperCase())) {
    // Linear scan + in-app normalization, not a query-level match — this
    // app's manual-lead volume (the only prospects with contact_phone at
    // all, pre-Apollo/Hunter) is small enough that this is fine for now; if
    // it ever becomes a real hot path, add a normalized-phone column with
    // an index instead of matching client-side per request.
    const { data: matches } = await db.from('prospects').select('id, contact_phone').not('contact_phone', 'is', null)
    const matchedIds = (matches ?? [])
      .filter(p => normalizeUkPhone(p.contact_phone as string) === normalizedFrom)
      .map(p => p.id)

    for (const id of matchedIds) {
      await db.from('prospects').update({ sms_opt_out: true }).eq('id', id)
      await db.from('sms_log').insert({
        prospect_id: id, message_type: 'opt_out_received', to_phone: from, body, status: 'received',
      })
    }
    console.log(`sms-inbound: opt-out from ${from}, matched ${matchedIds.length} prospect(s)`)
  }

  return new Response(TWIML_EMPTY, { status: 200, headers: { 'Content-Type': 'text/xml' } })
})
