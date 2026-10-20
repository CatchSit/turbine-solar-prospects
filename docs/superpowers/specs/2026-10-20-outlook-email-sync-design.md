# Outlook emails on CRM leads: design

**Status:** built 2026-10-20, **not switched on yet**. It's waiting on IT (Microsoft 365 consent) and the switch-on steps below.

## What Greg asked for

"Integrate Outlook to the CRM so it can read the emails sent to the email linked to the CRM lead."

Decisions (2026-10-20):

1. **Mailboxes:** info@ plus every rep's mailbox.
2. **Storage:** "I don't need the body of the email to be stored. But I need the CRM to read and understand the context to summarise and apply any movement in stage."
3. **Who sees it:** managers and the assigned rep. Greg named Tim, Vic and himself as managers; see "Vic" below.
4. **Backfill:** the last 2 months.
5. **Consent:** Greg will sort it with IT, using `docs/it-setup-outlook-mail-sync.md`.

## How it works

```
pg_cron (every 10 min, migration 053)
  -> mail-sync Edge Function (x-sync-secret)
       -> Microsoft Graph, app-only token. Exchange RBAC for Applications limits it to the six mailboxes.
            list messages since mail_sync_mailboxes.synced_through (first run: 60 days back)
       -> keep messages whose from/to/cc matches a lead's contact_email (manual, not deleted)
       -> read uniqueBody (just the new text, not the quoted thread), in memory only
       -> emails under 14 days old only: Claude (claude-haiku-5-5, effort low, JSON schema output): summary + suggested outcome + date + reason
       -> older (backfilled) emails: listed with no Claude call
       -> insert lead_emails row (no body), body discarded
crm.html lead page
  -> Activity timeline shows each email (direction, subject, summary, "Open in Outlook")
  -> open suggestion = card above the timeline: Apply... opens Log contact pre-filled -> rep saves -> marked applied
                                                Dismiss -> marked dismissed
  -> list Status column and Stages cards: "Email suggests a change"
```

## Choices made, and why

- **Suggestions are applied by a person, not automatically.** This matches Greg's rule for customer emails: review everything until he's happy, then automate. An email could be misread, for example a sarcastic "great, cancel it then", and a customer email could even try to instruct the AI. A person always saves the stage change, and the Log contact form shows exactly what will be logged. To automate later, the function could insert the `prospect_contacts` row itself when it's confident. Nothing else in the design would need to change.
- **Claude only reads recent emails:** under 14 days old. Older backfilled emails appear on the timeline (who, when, subject, Outlook link) with no summary and no suggestion. This keeps the cost down (Greg asked for the cheapest option, 2026-10-20), and means two months of old emails don't flood the leads with out-of-date suggestions. A suggestion is also only made when the email is newer than the lead's latest logged contact.
- **No body is stored anywhere.** Not in the table, and not in the logs: errors log the message ID and the error, never the content. What is stored is the sender, recipients, subject, time, Outlook link, summary and suggestion.
- **One row per email per lead.** A message CC'd to info@ and a rep is stored once, using `internet_message_id`, with both mailboxes listed.
- **Visibility:** `can_see_lead_emails()` allows managers (`is_manager()`) and the lead's `assigned_to_email`. Other reps see nothing, including the list markers. People can only change `suggestion_status` (open → applied or dismissed); a trigger enforces this.
- **Cost:** the smallest model (Claude Haiku 5.5, changed from Opus 5.5 on 2026-10-20 when Greg asked for the cheapest option), only on matched emails under 14 days old, at most 20 per run (which also keeps each run inside the Edge Function time limit). Estimated at pennies to a pound or two a month; not yet measured. Set a monthly spend limit in the Anthropic console.
- **Data protection:** customer email text is sent to the Anthropic API for the summary. Anthropic doesn't use commercial API data for training by default. Worth adding to the privacy notice: "we use AI services to summarise correspondence".

## Vic

Vic's address in `shared/rep-config.js` is `vickyturbinemarketingltd@aol.com`. That's not a Turbine Microsoft 365 account, so:

- Vic can't sign in to the CRM at all, because sign-in is limited to the `@turbineenergyuk.co.uk` domain.
- Vic's mailbox can't be synced.

Once Vic has a `@turbineenergyuk.co.uk` mailbox:

1. `insert into managers (email, name) values ('vic@turbineenergyuk.co.uk', 'Vic');`
2. Add the address to `ADMIN_EMAILS` (`shared/manager-config.js`) and `REP` (`shared/rep-config.js`).
3. Add the mailbox to the IT group and to `mail_sync_mailboxes`.

**Note:** being a manager also gives Manager Home access and the other manager rights.

## Switching it on

1. **IT:** completes `docs/it-setup-outlook-mail-sync.md` and sends Greg the tenant ID, client ID and secret.
2. **Anthropic API key:** create one at console.anthropic.com, with billing set up.
3. **Database:** run `supabase/migrations/052_lead_emails.sql` in the SQL editor.
4. **Secrets and deploy.** Run from the repo folder after `npx supabase login`:

   ```
   npx supabase secrets set MS_TENANT_ID=... MS_CLIENT_ID=... MS_CLIENT_SECRET=... ANTHROPIC_API_KEY=... MAIL_SYNC_SECRET=<long random string>
   npx supabase functions deploy mail-sync
   ```

5. **First manual run.** It should return `ok: true` and per-mailbox counts. A `last_error` on a mailbox usually means Exchange hasn't finished applying the change yet.

   ```
   curl -X POST https://gkvropheqktytghmiwgp.supabase.co/functions/v1/mail-sync -H "x-sync-secret: <MAIL_SYNC_SECRET>"
   ```

6. **Schedule it.** In the SQL editor, run `select vault.create_secret('<MAIL_SYNC_SECRET>', 'mail_sync_secret');`, then run `053_mail_sync_schedule.sql`.
7. **Check progress:** `select * from mail_sync_mailboxes;` shows `synced_through`, `last_run_at` and `last_error` for each mailbox.

## Not built yet (natural next steps)

- Detecting the stage emails a rep sends from Outlook, and marking them sent automatically (replacing "Mark as sent").
- A "Customer replied, not answered" flag on leads.
- Matching emails from a customer's second address. Today only the lead's `contact_email` is matched.
- A mail-sync status panel in Manager Home → Tools.
- Applying suggestions automatically, once Greg trusts them.
