// Wholesaler emails -> price list (Greg, 2026-11-08, migration 065).
//
// Run every 10 minutes by pg_cron (migration 066), which sends the
// MAIL_SYNC_SECRET in x-sync-secret (verify_jwt is off for this function).
// Uses the same Microsoft Graph app as mail-sync, so it can only reach the
// mailboxes Exchange allows that app (info, greg, tim, jackie).
//
// For each mailbox in price_mail_mailboxes it lists messages with
// attachments since synced_through, keeps those from a wholesaler domain,
// and has Claude read every PDF attachment (_shared/price-extract.ts).
// Prices are saved straight to price_lines (Greg's choice), linked to a
// price_documents row so a manager can undo the whole document on
// prices.html. A PDF is read once: its SHA-256 is unique in price_documents,
// so the same quote sent to two mailboxes is skipped the second time.
//
// Keep this file ASCII-only (HANDOVER: deploying from Windows turns
// non-ASCII characters in string literals into U+FFFD).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Anthropic from 'npm:@anthropic-ai/sdk@0.132.1'
import { readPriceDocument, PriceReadError } from '../_shared/price-extract.ts'

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const SYNC_SECRET      = Deno.env.get('MAIL_SYNC_SECRET')
const MS_TENANT_ID     = Deno.env.get('MS_TENANT_ID')
const MS_CLIENT_ID     = Deno.env.get('MS_CLIENT_ID')
const MS_CLIENT_SECRET = Deno.env.get('MS_CLIENT_SECRET')
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// Sender domain -> the wholesaler name saved on the prices. Add SIG Roofing
// here once its email domain is known.
const WHOLESALERS: Record<string, string> = {
  'ukgreentech.co.uk': 'UK Greentech',
  'yesss.co.uk': 'YESSS',
}
const PAGE_SIZE = 50
const MAX_PDF_BYTES = 15 * 1024 * 1024
const STOP_STARTING_AFTER_MS = 100000   // no new Claude call after this; keeps a run inside the Edge Function time limit
const STUCK_AFTER_MINUTES = 15          // a document left "reading" by a run that was cut off is retried

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b)
  if (ea.length !== eb.length) return false
  let diff = 0
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i]
  return diff === 0
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// -- Microsoft Graph (same app and pattern as mail-sync) ---------------
async function graphToken(): Promise<string> {
  const r = await fetch(`https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: MS_CLIENT_ID!, client_secret: MS_CLIENT_SECRET!,
      scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials',
    }),
  })
  const j = await r.json()
  if (!r.ok || !j.access_token) throw new Error(`Microsoft sign-in failed: ${j.error || r.status} ${j.error_description || ''}`.slice(0, 400))
  return j.access_token
}

async function graphGet(token: string, url: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) })
    if (r.status === 429 || r.status >= 500) {
      const wait = Number(r.headers.get('Retry-After')) || 2 ** attempt * 2
      await new Promise(res => setTimeout(res, wait * 1000))
      continue
    }
    const j = await r.json()
    if (!r.ok) throw new Error(`Graph ${r.status}: ${j?.error?.code || ''} ${j?.error?.message || ''}`.slice(0, 400))
    return j
  }
  throw new Error('Graph: too many retries')
}

type GraphMessage = {
  id: string; subject?: string; receivedDateTime: string
  from?: { emailAddress?: { address?: string } }
}
type GraphAttachment = { id: string; name?: string; contentType?: string; size?: number; isInline?: boolean; '@odata.type'?: string }

function wholesalerFor(address: string): string | null {
  const a = address.toLowerCase()
  for (const [domain, name] of Object.entries(WHOLESALERS)) {
    if (a.endsWith('@' + domain) || a.endsWith('.' + domain)) return name
  }
  return null
}

async function sha256Hex(base64: string): Promise<string> {
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('')
}

// Claims the document for this run. Returns the price_documents id, or null
// when it has already been read (or another run is reading it right now).
async function claimDocument(row: Record<string, unknown>): Promise<string | null> {
  const { data, error } = await db.from('price_documents').insert({ ...row, status: 'reading' }).select('id').single()
  if (!error) return data.id
  if (error.code !== '23505') throw new Error(`Saving the document log failed: ${error.message}`)
  const stuckBefore = new Date(Date.now() - STUCK_AFTER_MINUTES * 60000).toISOString()
  const { data: retaken } = await db.from('price_documents')
    .update({ created_at: new Date().toISOString(), error: null })
    .eq('content_hash', row.content_hash as string).eq('status', 'reading').lt('created_at', stuckBefore)
    .select('id')
  return retaken?.[0]?.id ?? null
}

type Run = { started: number; documents: number; lines: number; anthropic: Anthropic; known: string[] }

async function readAttachment(token: string, run: Run, mailbox: string, msg: GraphMessage, att: GraphAttachment, supplier: string) {
  const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(msg.id)}`
  const full = await graphGet(token, `${base}/attachments/${encodeURIComponent(att.id)}`)
  const content = String(full.contentBytes || '')
  if (!content) return
  const docId = await claimDocument({
    content_hash: await sha256Hex(content),
    source: 'email', mailbox, sender: msg.from?.emailAddress?.address || null,
    subject: (msg.subject || '').slice(0, 300), file_name: att.name || null,
    received_at: msg.receivedDateTime, supplier,
  })
  if (!docId) return
  run.documents++
  try {
    const doc = await readPriceDocument(run.anthropic, content, att.name || '', run.known)
    if (doc.document_type === 'other' || !doc.lines.length) {
      await db.from('price_documents').update({
        status: doc.document_type === 'other' ? 'not a price document' : 'no lines',
        document_type: doc.document_type, document_ref: doc.document_ref || null,
        document_date: doc.document_date || null, line_count: 0,
      }).eq('id', docId)
      return
    }
    const priceDate = doc.document_date || msg.receivedDateTime.slice(0, 10)
    const rows = doc.lines.map(l => ({
      supplier, product_code: l.product_code || null, description: l.description,
      unit_price: l.unit_price, quantity: l.quantity, price_date: priceDate,
      source_type: doc.document_type, document_ref: doc.document_ref || null,
      import_batch: docId, document_id: docId, created_by_email: `email:${mailbox}`,
    }))
    const { error } = await db.from('price_lines').insert(rows)
    if (error) throw new Error(`Saving the prices failed: ${error.message}`)
    run.lines += rows.length
    await db.from('price_documents').update({
      status: 'saved', document_type: doc.document_type, document_ref: doc.document_ref || null,
      document_date: priceDate, line_count: rows.length,
    }).eq('id', docId)
  } catch (e) {
    const message = e instanceof PriceReadError ? e.message
      : e instanceof Anthropic.APIError ? `Claude error ${e.status}` : (e as Error).message
    await db.from('price_documents').update({ status: 'failed', error: String(message).slice(0, 500) }).eq('id', docId)
    // A busy or failing Claude API would fail every document, so stop this run and retry next time.
    if (e instanceof Anthropic.RateLimitError || (e instanceof Anthropic.APIError && (e.status ?? 0) >= 500)) {
      await db.from('price_documents').delete().eq('id', docId)
      throw e
    }
  }
}

// Returns the receivedDateTime it got through (the next run starts there).
async function syncMailbox(token: string, run: Run, mailbox: string, since: string): Promise<{ through: string; done: boolean }> {
  let through = since
  let url: string | null = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages` +
    `?$filter=${encodeURIComponent(`receivedDateTime ge ${since} and hasAttachments eq true`)}` +
    `&$orderby=receivedDateTime asc&$top=${PAGE_SIZE}&$select=id,subject,from,receivedDateTime`
  while (url) {
    const page = await graphGet(token, url)
    for (const msg of (page.value || []) as GraphMessage[]) {
      const supplier = wholesalerFor(msg.from?.emailAddress?.address || '')
      if (supplier) {
        const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(msg.id)}`
        const atts = await graphGet(token, `${base}/attachments?$select=id,name,contentType,size,isInline`)
        const pdfs = ((atts.value || []) as GraphAttachment[]).filter(a =>
          !a.isInline && (a['@odata.type'] || '').endsWith('fileAttachment') && (a.size || 0) <= MAX_PDF_BYTES &&
          ((a.contentType || '').toLowerCase().includes('pdf') || /\.pdf$/i.test(a.name || '')))
        for (const att of pdfs) {
          // Out of time: stop before this message, so the next run starts with it.
          if (Date.now() - run.started > STOP_STARTING_AFTER_MS) return { through, done: false }
          await readAttachment(token, run, mailbox, msg, att, supplier)
        }
      }
      through = msg.receivedDateTime
    }
    url = page['@odata.nextLink'] || null
    if (url && Date.now() - run.started > STOP_STARTING_AFTER_MS) return { through, done: false }
  }
  return { through, done: true }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)
  if (!SYNC_SECRET) return json({ error: 'Unavailable - MAIL_SYNC_SECRET not configured' }, 503)
  if (!timingSafeEqual(req.headers.get('x-sync-secret') || '', SYNC_SECRET)) return json({ error: 'Forbidden' }, 403)
  if (!MS_TENANT_ID || !MS_CLIENT_ID || !MS_CLIENT_SECRET) return json({ error: 'Unavailable - Microsoft secrets not configured' }, 503)
  if (!ANTHROPIC_API_KEY) return json({ error: 'Unavailable - ANTHROPIC_API_KEY not configured' }, 503)

  const { data: mailboxes, error } = await db.from('price_mail_mailboxes').select('*').eq('enabled', true).order('mailbox')
  if (error) return json({ error: `Loading mailboxes failed: ${error.message}` }, 500)
  const { data: suppliers } = await db.from('price_suppliers').select('supplier')

  let token: string
  try { token = await graphToken() } catch (e) { return json({ error: (e as Error).message }, 502) }
  const run: Run = {
    started: Date.now(), documents: 0, lines: 0,
    anthropic: new Anthropic({ apiKey: ANTHROPIC_API_KEY, timeout: 120000, maxRetries: 1 }),
    known: (suppliers || []).map(s => s.supplier),
  }
  const results: Record<string, unknown>[] = []
  for (const mb of mailboxes || []) {
    if (Date.now() - run.started > STOP_STARTING_AFTER_MS) break
    let lastError: string | null = null
    let through = mb.synced_through
    try {
      const r = await syncMailbox(token, run, mb.mailbox, mb.synced_through)
      through = r.through
      results.push({ mailbox: mb.mailbox, through, caught_up: r.done })
    } catch (e) {
      lastError = String((e as Error).message || e).slice(0, 500)
      results.push({ mailbox: mb.mailbox, error: lastError })
    }
    await db.from('price_mail_mailboxes').update({
      synced_through: through, last_run_at: new Date().toISOString(), last_error: lastError,
    }).eq('mailbox', mb.mailbox)
  }
  return json({ ok: true, documents: run.documents, lines: run.lines, mailboxes: results })
})
