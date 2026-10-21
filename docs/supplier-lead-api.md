# Sending leads to Turbine Energy

**For:** Pockla's developer
**From:** Turbine Energy (contact: Greg)

Send each lead to us as one HTTPS request, at the moment you have it. It goes straight into our CRM. This link can only add leads; it can't read anything back.

## The request

```
POST https://gkvropheqktytghmiwgp.supabase.co/functions/v1/supplier-lead
Content-Type: application/json
x-api-key: <your API key>
```

We'll send you the API key separately. Keep it on your server: don't put it in a web page or app that customers can see. If it ever leaks, tell us and we'll issue a new one.

One lead per request:

```json
{
  "product": "solar",
  "name": "Jane Smith",
  "email": "jane.smith@example.com",
  "phone": "07700 900123",
  "address": "12 Station Road, Leeds",
  "postcode": "LS1 4AB",
  "property_type": "home",
  "notes": "3-bed semi, south-facing roof, interested in a battery too",
  "reference": "PK-10432",
  "consent_timestamp": "2026-10-21T14:05:00Z",
  "consent_wording": "I agree to my details being passed to an installer who will contact me about a quote.",
  "source_url": "https://www.example.com/solar-quote"
}
```

## Fields

| Field | Required | What to send |
|---|---|---|
| `product` | Yes | `solar` or `ashp` (air source heat pump) |
| `name` | Yes | The customer's full name |
| `email` | Email or phone | The customer's email address |
| `phone` | Email or phone | The customer's phone number, in any format |
| `postcode` | Yes | UK postcode |
| `address` | No | First line of the address and town |
| `property_type` | No | `home` (default) or `business` |
| `notes` | No | Anything the customer told you: property, current heating, timescale, questions |
| `reference` | Recommended | Your own ID for the lead. If you send the same reference twice (for example retrying after a timeout), we keep only the first. |
| `consent_timestamp` | Yes | When the customer agreed to be passed to us, in ISO 8601 (UTC) |
| `consent_wording` | Recommended | The exact consent text the customer agreed to |
| `source_url` | No | The page where the customer filled in your form |

Any other fields you send are kept with the lead.

## Responses

| Status | Body | Meaning |
|---|---|---|
| `201` | `{"ok": true, "status": "created", "crm_reference": "..."}` | New lead added |
| `200` | `{"ok": true, "status": "duplicate", "crm_reference": "..."}` | Received, but the customer is already in our CRM (same email or phone) |
| `200` | `{"ok": true, "status": "already_received"}` | We already have this `reference` |
| `400` | `{"error": "Lead not accepted", "problems": ["..."]}` | Something is missing or invalid. `problems` says what. |
| `401` | `{"error": "Missing or wrong x-api-key"}` | Check the key |
| `500` / `503` | `{"error": "..."}` | A problem on our side. Please retry later, with the same `reference`. |

Please keep the `crm_reference` against the lead on your side. It's how we'll both identify the lead if there's a query.

## Testing

Add `"test": true` to the body. We check the lead exactly as normal and reply with what would happen, but **nothing is saved**:

```json
{"ok": true, "test": true, "message": "This lead would be accepted. Nothing was saved."}
```

When your tests pass, send us one real test lead marked clearly (for example name `TEST - Pockla`) and tell us, so we can check it arrived and delete it.

## Example (curl)

```
curl -X POST https://gkvropheqktytghmiwgp.supabase.co/functions/v1/supplier-lead \
  -H "Content-Type: application/json" \
  -H "x-api-key: <your API key>" \
  -d '{"product":"solar","name":"Jane Smith","email":"jane.smith@example.com","phone":"07700 900123","postcode":"LS1 4AB","consent_timestamp":"2026-10-21T14:05:00Z","reference":"PK-10432","test":true}'
```
