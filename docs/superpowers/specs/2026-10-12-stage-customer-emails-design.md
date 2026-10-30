# Stage-triggered customer emails: design

**Date:** 2026-10-12 · **Status:** v1 BUILT 2026-10-12 as "open in Outlook" (mailto) with Mark as sent / Skip; see HANDOVER.md. Emails on: welcome, DNO submitted, keep-in-touch x3, DNO approved, install confirmed, installed. Brevo/automatic sending not built. Decisions below supersede section 6 wherever they differ.

## User decisions, 2026-10-12 (these override the proposals below)
- **Nothing sends automatically, for now.** The CRM prepares a ready-to-send email in **Outlook** (To, CC, subject, body filled in). The rep reviews it and clicks Send themselves. This means section 3's Brevo `customer-emails` function, `pg_cron` and the "send scheduled messages" button are **not** used in v1. Automatic sending is a later step, only once the user says they're happy with the drafts.
- **The rep approves every email's wording**, each time, in Outlook before sending.
- **The "still being processed" email (E2):** due every 14 days after DNO Submitted, max 3. **It stops once DNO Approved is logged** (or any later or closing outcome). Since nothing sends itself, a due E2 appears in the CRM as a to-do ("Email due: DNO update") with an "Open in Outlook" button.
- **Replies go to the assigned rep, with info@turbineenergyuk.co.uk CC'd.**
- DNO placement is done: `DNO Submitted` / `DNO Approved` are live in `shared/contact-outcome-config.js` (stage 6, Install).
- **Decided: `mailto:`** (opens a pre-filled email in the rep's Outlook; the rep clicks Mark as sent). Considered alternative: Either a `mailto:` link that opens the rep's Outlook with everything filled in (no setup; the CRM can't tell whether it was actually sent, so the rep clicks "Mark as sent"), or a Microsoft Graph draft saved into the rep's own Outlook Drafts folder (needs the `Mail.ReadWrite` permission added to the Azure AD sign-in; can set Reply-To properly).
**Asked for (verbatim):** "i need to include certain emails within each stages, for exmaple when we send a DNO approval, i want to send an email to the customer letting them know that it has been sent for approval and we will be in touch shortly. Then even if the DNO is back or not, i would like to send another after X amount of days just to keep in touch and let them know its still being processed"

Builds on the new 7-stage outcome flow (the `shared/contact-outcome-config.js` rework and migration `049`, in progress in parallel). This doc changes nothing in that work. It only proposes two new outcome keys (section 1) for that config to add.

---

## 1. Where DNO fits: new outcomes, not a checklist item

**Recommendation:** add two outcomes to **stage 6 Install**, placed before Scheduled for Install:

| Key (stored) | Label | Needs a date? |
|---|---|---|
| `DNO Submitted` | "DNO application submitted" | Optional: expected response date as `follow_up_date` |
| `DNO Approved` | "DNO approved" | No |

Why outcomes and not an `install_checklists` item:
- **Timing.** A G99 application has to be approved *before* the install is booked. The checklist card only shows once the lead is at Scheduled for Install (044), which is too late. The checklist items (scaffold, electrician, roofer, kit) are also trade bookings, not customer milestones.
- **One trigger mechanism.** Every email in this spec fires from a `prospect_contacts` row. If DNO lived on the checklist, we would need a second trigger path (checklist upsert) just for this one feature.
- **Visibility.** As an outcome, DNO shows up in the lead status, the activity timeline, and the Manager Home funnel ("3 jobs waiting on DNO") without extra work.
- **Stop rule.** The keep-in-touch email needs a clear "approval is back" event to stop on, and `DNO Approved` is that event.

**G98 jobs** (small systems, where you notify the DNO after the install rather than waiting for approval) skip both outcomes. Reps only log `DNO Submitted` when there is an approval to wait for. A "DNO rejected / more info needed" outcome is left out for now. Reps can log a note and the keep-in-touch emails keep going.

---

## 2. Which events send an email

**R** = required (what was asked for). **S** = suggested. Every **S** email can be switched on or off on its own (decision D6).

| # | Stage | Trigger | When | Email | R/S |
|---|---|---|---|---|---|
| E1 | 6 Install | `DNO Submitted` logged | Immediately | "We've applied to the network operator" | **R** |
| E2 | 6 Install | E1 was sent and no stop event yet | Day X after submission, repeating every X days, up to N times | "Still being processed, keeping you posted" | **R** |
| E3 | 6 Install | `DNO Approved` logged | Immediately | "Good news, approved, next we book your install" | S (strongly: it is the natural follow-on to E2) |
| E4 | 1 Contacting | `Left Message` logged, lead has an email | Immediately | "Sorry we missed you" | S (low priority) |
| E5 | 2 / 3 | `Meeting Booked` or `Survey Booked` logged | Immediately | Booking confirmation with date | S |
| E6 | 4 Quote | `Quote Sent` logged | Day before the chase date | "Any questions about your quote?" | S (clashes with the existing 3-day quote SMS, see D7) |
| E7 | 5 Won | `Contract Signed` logged | Immediately | Welcome and "what happens next" | S |
| E8 | 6 Install | `Scheduled for Install` logged | Immediately | Install date confirmation | S |
| E9 | 6 Install | `Completed` ("Installed") logged | Immediately | Thank you and handover (documents to follow) | S |
| E10 | 7 Complete | `Job Closed` logged | 7 days later | Review request | S |

No emails for: exit outcomes, bad-lead outcomes, `No Answer`, `Follow Up`, `Info Sent` (the rep's own email *is* the info), `Survey Completed`, `Negotiating`, `Converted`, or `Recontact Later`.

### The E2 keep-in-touch rule

The request says "even if the DNO is back or not", which can be read two ways, so this is **D2**. Recommendation:
- Send on **day 14** after the E1 email, then every 14 days, **up to 3 times** (about 6 weeks, which roughly matches typical G99 turnaround).
- **Stop** as soon as any of these is logged on the lead: `DNO Approved`, any later-stage outcome (Scheduled for Install, Completed, Job Closed), any exit or bad-lead outcome, or an email opt-out.
- If approval comes back before day 14, the customer gets **E3 instead**. A "still being processed" email after approval would be wrong.
- Rule: "the last `DNO Submitted` row has no stop event logged after it." This is deliberately *not* "latest outcome = DNO Submitted", so a rep logging a call in the middle doesn't cancel or restart the sequence.

---

## 3. Trigger mechanics

**One new Edge Function, `customer-emails`, with two modes.** It sends through Brevo's transactional API (account 11558688, sender `info@turbineenergyuk.co.uk`, already domain-authenticated), the same as `notify-assignment`. It does **not** reuse or touch that uncommitted function.

1. **`mode: 'outcome'`, for immediate emails.** The CRM calls this right after it inserts a contact row, sending `{ contact_id }`. This follows the established client-calls-after-its-own-write pattern; there is no `pg_net`/webhook precedent here. The function reads the contact and the lead **server-side**, decides whether an email applies, and writes an `email_log` row. For E1 it also writes the first `scheduled` E2 row (due day 14).
2. **`mode: 'run'`, for scheduled emails (E2, E10, E6).** It scans `email_log` for `status='scheduled' and due_date <= today`, re-checks the stop rule and opt-out at send time, then sends. After an E2 sends, it schedules the next one until the cap is reached.

**Running the scheduled sends:**
- **v1:** reuse the sms-scheduler pattern. A manager clicks a button on `dashboard.html`. Rename the existing one to **"Send scheduled messages now"** so a single click runs both texts and emails.
- **Recommended fast-follow (D4):** enable `pg_cron` + `pg_net`. Supabase offers both on all plans; check under Dashboard → Database → Extensions. Run `mode:'run'` daily at 09:00 with a `CRON_SECRET` header in place of a user JWT. The cost of a missed manual click is that a customer goes quiet for days. That is exactly what this feature exists to prevent, so the manual button is a weak fit for E2.

**Duplicate protection.** This is stronger than `sms_log`, which checks first and inserts after the send. Each email gets a row, claimed **before** sending:
- unique index on `(prospect_id, email_type, related_contact_id, sequence_no)`
- insert `status='sending'`, call Brevo, then update the row to `sent` or `failed`.

If two runs overlap, the second insert fails on the unique index and that email is skipped. A `failed` row can only be retried by hand ("Retry" on the timeline), never automatically.

**New table `email_log`** (migration `050`, or whatever number is next): `id`, `prospect_id`, `related_contact_id`, `email_type` (`dno_submitted`, `dno_keep_in_touch`, `dno_approved`, `missed_call`, `booking_confirm`, `quote_chase`, `welcome`, `install_confirm`, `handover`, `review_request`), `sequence_no`, `status` (`scheduled`, `pending_approval`, `sending`, `sent`, `failed`, `cancelled`, `skipped_opted_out`, `skipped_no_email`), `due_date`, `to_email`, `subject`, `body_html`, `brevo_message_id`, `error_message`, `created_by_email`, `sent_at`, `cancelled_by_email`, `created_at`. RLS follows `sms_log`: domain users can read, and only the service role writes. Cancel, approve and retry go through the function so they are stamped and audited.

**Opt-out.**
- New column `prospects.email_opt_out` (separate from `sms_opt_out`). A rep can tick "No automated emails" on the lead, and the function checks the flag before every send.
- Every email footer says: *"Don't want these updates? Just reply and let us know."*
- A one-click unsubscribe link (a signed token handled by a tiny function) can come later.
- Most of these emails are service messages about a contract the customer already has, which PECR doesn't treat as marketing. E10 (review request) and E4 are closer to marketing, so they must respect the opt-out with no exceptions.

**Rep control (D3).** Recommendation is a hybrid:
- **Immediate emails:** the log-outcome form shows a ticked **"Email the customer"** box with a "Preview" link whenever the chosen outcome has an email. Untick it and nothing is sent. The rep effectively approves by saving.
- **Scheduled emails:** these send automatically. Each one sits on the timeline as "Scheduled for 26 Oct" with **Send now / Skip** buttons, so a rep can stop one before it goes out.
- No approval queue. At this lead volume a queue would just go stale.

**Other details:**
- **Reply-To:** the assigned rep's address, falling back to `info@turbineenergyuk.co.uk`. Replies then reach a person.
- **No email address:** log the row as `skipped_no_email` so it is visible on the timeline.
- **Templates:** keep them in function code for v1, like the SMS copy (D8). Use ASCII-only source with escapes; see the HANDOVER gotcha about deploy turning "—" into U+FFFD.

---

## 4. Draft wording

UK English, plain and friendly. The final copy must be signed off by Turbine before go-live; these are first drafts, the same caveat as the SMS copy.

**Merge fields:**
- `{{first_name}}`: first word of `customer_name`, falling back to "there"
- `{{system}}`: from the lead type or quote, e.g. "solar PV system", "heat pump", falling back to "new system"
- `{{site_address}}`
- `{{date}}`: the contact's `follow_up_date`, formatted "Tuesday 4 November"
- `{{rep_name}}`: the assigned rep, falling back to "the Turbine Energy team"
- `{{office_phone}}`
- `{{dno_name}}`: defaults to "your local network operator"; Northern Powergrid for most Yorkshire jobs
- `{{review_link}}`

Every email ends with:
> Thanks, {{rep_name}}, Turbine Energy · {{office_phone}} · turbineenergyuk.co.uk
> Don't want these updates? Just reply and let us know.

**E1 DNO submitted.** Subject: *Your {{system}}: we've applied to the network operator*
> Hi {{first_name}}, a quick update. We've submitted the application to connect your {{system}} at {{site_address}} to {{dno_name}}. They have to approve it before we can fit the system. It usually takes a few weeks and we don't need anything from you in the meantime. We'll be in touch as soon as we hear back.

**E2 Keep in touch.** Subject: *Your {{system}}: still with the network operator*
> Hi {{first_name}}, just keeping you posted. Your connection application is still with {{dno_name}}. That's completely normal, as these can take several weeks. Nothing is needed from you, and we'll let you know the moment it's approved. If you have any questions in the meantime, just reply to this email.

**E3 DNO approved.** Subject: *Good news: your {{system}} has been approved*
> Hi {{first_name}}, good news. {{dno_name}} has approved the connection for your {{system}}. The next step is booking your installation, and we'll be in touch shortly to agree a date that suits you.

**E4 Missed you.** Subject: *Sorry we missed you, Turbine Energy*
> Hi {{first_name}}, we tried to call about your enquiry but couldn't get through. We'll try again soon, or you can reply with a good time to call or ring us on {{office_phone}}.

**E5 Booking confirmed.** Subject: *Your {{appointment}} is booked for {{date}}*. `{{appointment}}` is "appointment" or "site survey".
> Hi {{first_name}}, thanks for booking. This confirms your {{appointment}} at {{site_address}} on {{date}}. If that no longer works, just reply and we'll rearrange.

**E6 Quote chase.** Subject: *Any questions about your quote?*
> Hi {{first_name}}, just checking you've had a chance to look over your quote for a {{system}}. If anything's unclear, or you'd like to talk through options, reply here or call {{office_phone}}.

**E7 Welcome.** Subject: *Welcome to Turbine Energy: what happens next*
> Hi {{first_name}}, thank you for choosing Turbine Energy, and we've received your signed contract and £200 deposit. Here's what happens next: (1) we handle any network operator paperwork, (2) we book your installation date with you, (3) we fit and commission your {{system}} and hand over all the paperwork. We'll keep you updated at each step.

**E8 Install booked.** Subject: *Your installation is booked for {{date}}*
> Hi {{first_name}}, your {{system}} installation at {{site_address}} is booked for {{date}}. Our team will confirm arrival times nearer the day. Please make sure we can get to the roof area and your fuse board.

**E9 Installed.** Subject: *Your {{system}} is installed*
> Hi {{first_name}}, thank you for having us. Your {{system}} is now installed. Your certificates and warranty documents will follow by email shortly. If you notice anything at all, just reply and we'll sort it.

**E10 Review.** Subject: *How did we do?*
> Hi {{first_name}}, we hope you're enjoying your new {{system}}. If you have a minute, a quick review really helps a local business like ours: {{review_link}}. Thank you!

---

## 5. Where reps see this in the new lead layout

All of this goes in the lead page's **activity timeline**, alongside contact rows, sorted by date:
- **Sent:** shown with an envelope icon, e.g. "Email sent: DNO submitted · to j.smith@... · 12 Oct 10:14". Clicking it expands the exact body that was sent.
- **Scheduled:** shown as a muted or dashed entry pinned at the top, e.g. "Scheduled: keep-in-touch email (1 of 3) · 26 Oct". It has **Send now** and **Skip** buttons.
- **Skipped or failed:** shown with a short reason, e.g. "Not sent: no email address" or "Failed: Brevo rejected · Retry".
- **Lead header:** a small "Emails on/off" indicator that reflects `email_opt_out`.
- **Manager Home:** "Needs attention" counts failed emails and leads with no email address that are in stages 5–6.

---

## 6. Decisions needed

| # | Decision | Recommendation |
|---|---|---|
| D1 | DNO as outcomes or as a checklist item | **Two new outcomes in stage 6, `DNO Submitted` and `DNO Approved`** (section 1) |
| D2 | Does the keep-in-touch email still send once DNO is approved? | **No.** Stop when approval is logged and send E3 instead. |
| D3 | How many keep-in-touch emails, and how far apart | **Day 14, then every 14 days, maximum 3** |
| D4 | Manual send button or automatic daily send | **Manual for the first 2 weeks to check the copy, then pg_cron daily at 09:00** |
| D5 | Rep approval before sending | **Immediate emails: a ticked "Email the customer" box with preview on the log form. Scheduled emails: send automatically, with Skip on the timeline.** |
| D6 | Which suggested emails to switch on at launch | **E1, E2, E3, E7, E8, E9.** Leave E4, E5, E6 and E10 off for now. |
| D7 | Email or text for events the SMS feature already covers (quote chase, booking reminder, install day) | **Keep those as texts once Twilio is live and don't email the same event.** E5/E8 *confirmations* (sent when the outcome is logged) are fine alongside the SMS *reminders* (sent the day before). |
| D8 | Where the email wording lives | **In code for v1.** Make it editable in the app later only if the wording changes often. |
| D9 | Who replies go to | **The assigned rep, falling back to info@** |
| D10 | Copy sign-off | Greg (or whoever is named) approves the final wording in section 4 before go-live |
| D11 | Review link (needed for E10) | Supply the Google Business review URL, or leave E10 off |
