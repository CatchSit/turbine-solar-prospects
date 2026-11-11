// Shared by extract-price-lines (PDF uploaded on prices.html) and
// supplier-mail-prices (PDF attached to a wholesaler email): Claude reads the
// product lines from a wholesaler quote, invoice or price list.
//
// Keep this file ASCII-only (HANDOVER: deploying from Windows turns
// non-ASCII characters in string literals into U+FFFD).

import Anthropic from 'npm:@anthropic-ai/sdk@0.132.1'

export const PRICE_MODEL = 'claude-opus-5-5'

export type PriceLine = { product_code: string; description: string; quantity: number | null; unit_price: number }
export type PriceDocument = {
  supplier: string
  document_type: 'quote' | 'invoice' | 'price list' | 'other'
  document_ref: string
  document_date: string
  lines: PriceLine[]
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['supplier', 'document_type', 'document_ref', 'document_date', 'lines'],
  properties: {
    supplier: { type: 'string' },
    document_type: { type: 'string', enum: ['quote', 'invoice', 'price list', 'other'] },
    document_ref: { type: 'string' },
    document_date: { type: 'string' },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['product_code', 'description', 'quantity', 'unit_price'],
        properties: {
          product_code: { type: 'string' },
          description: { type: 'string' },
          quantity: { type: 'number' },
          unit_price: { type: 'number' },
        },
      },
    },
  },
}

const SYSTEM_PROMPT = `You read UK electrical and roofing wholesaler documents (quotes, invoices and price lists) for Turbine Energy, a solar, battery and heat pump installer, and return each product line as data.

For every product line:
- unit_price: the net price for ONE unit, ex VAT, after any discount. Never use the line total. If there is a "Per" column (price per N units), divide the price by N. If a discount percentage applies and only the pre-discount price is shown, apply it. If a "Unit" or "Net" column already shows the discounted price each, use that. If the only price on the line is the amount for the whole line (such as a "Net Amount" or "Total" column with a quantity above 1), divide it by the quantity.
- quantity: the quantity on the line, or 0 if none is shown.
- description: the full product description as printed, joined into one line if it wraps across lines. Keep the wording and capitals.
- product_code: the supplier's part number or product code when there is a code column. When there is no code column but the description contains a manufacturer part number (a run of mostly digits, such as 5024801001 or 11040005), copy that number here and leave it in the description too. Otherwise use an empty string. Never invent a code. When a line shows both the wholesaler's own item number and a manufacturer part number (such as Rexel's "Item No" 2501580100 next to "ER-R-PRO3600B CLENERGY"), use the manufacturer part number without the brand name (ER-R-PRO3600B) and keep the wholesaler's item number at the end of the description.

Leave out anything that is not a product: section headings (such as "ACCESSORIES" or "THREE PHASE DUE END OF OCTOBER"), notes, carriage or delivery charges, totals, VAT lines and terms.

Document fields:
- supplier: the wholesaler's trading name, not the customer (the customer is Turbine Energy / Turbine Marketing Ltd). If the name matches one of the known supplier names given, use that exact spelling.
- document_type: "quote", "invoice" or "price list". Use "other" for anything that does not list product prices for Turbine to buy at: statements of account, remittances, credit notes, delivery notes, order confirmations without prices, brochures, datasheets or terms and conditions. For "other", return no lines.
- document_ref: the quotation, invoice or document number, or an empty string.
- document_date: the document date as YYYY-MM-DD. Dates are UK format (day first), so 02/09/2026 is 2026-09-02 and 29/10/26 is 2026-10-29. Use an empty string if there is no date.`

export class PriceReadError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

export async function readPriceDocument(
  anthropic: Anthropic, pdfBase64: string, fileName: string, knownSuppliers: string[],
): Promise<PriceDocument> {
  // Passed untyped because the pinned SDK's types may not include
  // output_config or fallbacks. fallbacks "default" re-runs a refused request
  // on a fallback model inside the same call.
  const params = {
    model: PRICE_MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
        { type: 'text', text: `File name: ${fileName || 'unknown'}\nKnown supplier names: ${knownSuppliers.length ? knownSuppliers.join(', ') : '(none yet)'}` },
      ],
    }],
  }
  // deno-lint-ignore no-explicit-any
  const res = await anthropic.beta.messages.create(params as any) as Anthropic.Beta.BetaMessage
  if (res.stop_reason === 'refusal') throw new PriceReadError('Claude declined to read this document', 422)
  if (res.stop_reason === 'max_tokens') throw new PriceReadError('The document has too many lines to read in one go. Split it and try again.', 422)
  const text = res.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('')
  const out = JSON.parse(text)
  const type = ['quote', 'invoice', 'price list', 'other'].includes(out.document_type) ? out.document_type : 'quote'
  const lines: PriceLine[] = type === 'other' ? [] : (out.lines || [])
    .filter((l: { description?: string; unit_price?: number }) => l.description && Number.isFinite(l.unit_price) && (l.unit_price as number) >= 0)
    .map((l: { product_code: string; description: string; quantity: number; unit_price: number }) => ({
      product_code: (l.product_code || '').trim(),
      description: l.description.trim(),
      quantity: l.quantity > 0 ? l.quantity : null,
      unit_price: Math.round(l.unit_price * 10000) / 10000,
    }))
  return {
    supplier: String(out.supplier || '').trim(),
    document_type: type,
    document_ref: String(out.document_ref || '').trim(),
    document_date: /^\d{4}-\d{2}-\d{2}$/.test(out.document_date) ? out.document_date : '',
    lines,
  }
}
