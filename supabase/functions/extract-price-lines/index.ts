// Reads the product lines from a wholesaler quote or invoice PDF uploaded on
// prices.html (Greg, 2026-11-08). Managers only. Nothing is saved here: the
// page shows the lines for checking, then saves them to price_lines itself.
//
// Request:  POST { pdf_base64, file_name, known_suppliers: string[] }
// Response: { supplier, document_type, document_ref, document_date, lines: [...] }
//
// Keep this file ASCII-only (HANDOVER: deploying from Windows turns
// non-ASCII characters in string literals into U+FFFD).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Anthropic from 'npm:@anthropic-ai/sdk@0.132.1'
import { readPriceDocument, PriceReadError } from '../_shared/price-extract.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')

const MAX_PDF_BYTES = 15 * 1024 * 1024

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

Deno.serve(async (req) => {
  const cors = corsHeadersFor(req.headers.get('origin'))
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  if (!ANTHROPIC_API_KEY) return json({ error: 'Claude is not set up (ANTHROPIC_API_KEY missing)' }, 500)

  // Managers only, checked with the caller's own login.
  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  })
  const { data: { user }, error: authErr } = await authClient.auth.getUser()
  if (authErr || !user) return json({ error: 'Not signed in' }, 401)
  const { data: isManager, error: managerErr } = await authClient.rpc('is_manager')
  if (managerErr || !isManager) return json({ error: 'Only a manager can read price PDFs' }, 403)

  let body: { pdf_base64?: string; file_name?: string; known_suppliers?: string[] }
  try { body = await req.json() } catch { return json({ error: 'Bad request' }, 400) }
  const pdf = (body.pdf_base64 || '').replace(/\s/g, '')
  if (!pdf) return json({ error: 'No PDF sent' }, 400)
  if (pdf.length * 0.75 > MAX_PDF_BYTES) return json({ error: 'That PDF is too large (15 MB maximum)' }, 413)
  const known = (body.known_suppliers || []).filter(s => typeof s === 'string').slice(0, 200)

  try {
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY })
    const doc = await readPriceDocument(anthropic, pdf, body.file_name || '', known)
    return json(doc)
  } catch (e) {
    if (e instanceof PriceReadError) return json({ error: e.message }, e.status)
    if (e instanceof Anthropic.RateLimitError) return json({ error: 'Claude is busy, try again in a minute' }, 429)
    if (e instanceof Anthropic.BadRequestError) return json({ error: 'Claude couldn\'t read that file: ' + e.message }, 400)
    if (e instanceof Anthropic.APIError) return json({ error: `Claude error ${e.status}` }, 502)
    console.error('extract-price-lines failed:', e)
    return json({ error: 'Couldn\'t read the document' }, 500)
  }
})
