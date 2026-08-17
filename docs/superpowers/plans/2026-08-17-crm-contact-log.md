# CRM Contact Log + Manager Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any rep log a contact attempt against a prospect (outcome, notes, follow-up date), while only the manager can read that log or see the aggregated activity dashboard.

**Architecture:** A new `prospect_contacts` table (RLS: insert-only for reps, select restricted to the manager's email) is written to from a Log Contact modal added to the existing prospect popup in `index.html`, and read from a new, separately auth-gated `dashboard.html` page mirroring mcs-map's proven dashboard (daily activity chart, per-employee chart, filterable/sortable table, CSV export).

**Tech Stack:** Same as the rest of the repo — plain HTML/CSS/JS (no build tool), Postgres/Supabase RLS, Chart.js (loaded via CDN, same as mcs-map's dashboard) for the two charts.

## Global Constraints

- No automated test framework in this repo — every verification step is a live check (a real signed-in browser session, or a scoped curl call with a real JWT), matching how every other feature in this project has been verified.
- The outcome enum is exactly: `No Answer, Follow Up, Meeting Booked, Survey Booked, Quote Sent, Converted, Not Interested, Already Has Solar`. `Follow Up`, `Meeting Booked`, and `Survey Booked` require a `follow_up_date`; the other five do not. Not DB-enforced — enforced client-side only, matching this project's `docs/superpowers/specs/2026-08-17-crm-contact-log-design.md`.
- The manager's email is `greg@turbineenergyuk.co.uk` — hardcoded in both the RLS policy and reused from the existing `ADMIN_EMAILS`/`isAdmin()` helper already in `index.html`. If a second admin is ever added, both places need updating (same warning mcs-map's own RLS file carries).
- No edit/delete UI in this iteration (per the spec's Non-goals) — the dashboard is read/export only.
- Follow existing conventions: `escapeHtml()` wraps every dynamic value injected into HTML; new CSS custom properties are not invented — reuse `index.html`'s existing `:root` tokens (`--bg`, `--surface`, `--surface2`, `--border`, `--borderH`, `--text`, `--text2`, `--text3`, `--accent`, `--accentDim`, `--accentDk`, `--warn`, `--warnSoft`, `--alert`, `--alertSoft`) which `dashboard.html` will also define identically, matching mcs-map's own dashboard reusing its main page's token set.

---

### Task 1: `prospect_contacts` table + RLS

**Files:**
- Create: `supabase/migrations/007_prospect_contacts.sql`

**Interfaces:**
- Produces: table `prospect_contacts` with columns `id, prospect_id, employee, employee_email, outcome, notes, next_action, follow_up_date, contacted_at, updated_at, updated_by, deleted_at, deleted_by`. Task 3 inserts into it; Task 4 reads from it.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/007_prospect_contacts.sql`:

```sql
create table if not exists prospect_contacts (
  id             uuid primary key default gen_random_uuid(),
  prospect_id    uuid not null references prospects(id),
  employee       text not null,
  employee_email text,
  outcome        text not null,
  -- outcome must be one of: No Answer, Follow Up, Meeting Booked, Survey Booked,
  -- Quote Sent, Converted, Not Interested, Already Has Solar
  -- (no DB-level CHECK constraint — enforced by the UI only, matching mcs-map's contacts table)
  notes          text,
  next_action    text,
  follow_up_date date,
  contacted_at   timestamptz not null default now(),
  updated_at     timestamptz,
  updated_by     text,
  deleted_at     timestamptz,
  deleted_by     text
);

create index if not exists prospect_contacts_prospect_id_idx on prospect_contacts (prospect_id);
create index if not exists prospect_contacts_contacted_at_idx on prospect_contacts (contacted_at);

alter table prospect_contacts enable row level security;

-- Any authenticated rep can log a new contact.
create policy "Authenticated insert"
  on prospect_contacts for insert
  to authenticated
  with check (true);

-- Only the manager can read — the one deliberate deviation from mcs-map's
-- contacts table (which allows any authenticated read).
create policy "Admin read"
  on prospect_contacts for select
  to authenticated
  using (auth.jwt() ->> 'email' = 'greg@turbineenergyuk.co.uk');
```

- [ ] **Step 2: Push the migration**

Run:
```
supabase db push
```
Confirm the prompt lists `007_prospect_contacts.sql` and accept it.

- [ ] **Step 3: Verify the table + RLS live**

Get the service-role key and the anon key:
```
supabase projects api-keys --project-ref gkvropheqktytghmiwgp
```

Confirm the table exists (service-role bypasses RLS):
```
curl -s "https://gkvropheqktytghmiwgp.supabase.co/rest/v1/prospect_contacts?limit=1" \
  -H "apikey: <service-role-key>" -H "Authorization: Bearer <service-role-key>"
```
Expected: `[]`.

Insert a real test row as service-role (stand-in for "a rep logged something"), using a real `prospect_id` from the `prospects` table:
```
curl -s -X POST "https://gkvropheqktytghmiwgp.supabase.co/rest/v1/prospect_contacts" \
  -H "apikey: <service-role-key>" -H "Authorization: Bearer <service-role-key>" \
  -H "Content-Type: application/json" -H "Prefer: return=representation" \
  -d '{"prospect_id":"<real-prospect-id>","employee":"Test Rep","outcome":"No Answer"}'
```
Expected: HTTP 201 with the inserted row.

Confirm a **non-admin authenticated** session cannot read it back. This needs a real non-admin `@turbineenergyuk.co.uk` test account's JWT (create one via Supabase Auth if one doesn't already exist for testing, matching how earlier login testing in this project used a temporary email/password account) — then:
```
curl -s "https://gkvropheqktytghmiwgp.supabase.co/rest/v1/prospect_contacts?select=id" \
  -H "apikey: <anon-key>" -H "Authorization: Bearer <non-admin-user-jwt>"
```
Expected: `[]` — zero rows, not an error, proving RLS actually blocks read rather than just the UI hiding a button. Then confirm the manager's own session (`greg@turbineenergyuk.co.uk`) returns the real row.

- [ ] **Step 4: Commit**

```
git add supabase/migrations/007_prospect_contacts.sql
git commit -m "Add prospect_contacts table with manager-only read RLS"
```

---

### Task 2: `shared/contact-outcome-config.js`

**Files:**
- Create: `shared/contact-outcome-config.js`

**Interfaces:**
- Produces: `const CONTACT_OUTCOME = { [outcomeName]: { color, soft, label, requiresDate } }` and `const CONTACT_OUTCOME_ORDER = [...]` (insertion order of the 8 outcomes). Task 3 consumes both to render outcome chips dynamically (matching this project's existing `buildEpcRatingChips`/`buildBuildingTypeChips` dynamic-chip pattern, rather than mcs-map's hardcoded-per-outcome HTML buttons) and to look up `requiresDate` instead of hardcoding a check against a list of outcome names.

- [ ] **Step 1: Write the file**

Create `shared/contact-outcome-config.js`:

```js
// Single source of truth for prospect_contacts.outcome colours/labels/date
// requirement. requiresDate === true means the Log Contact modal must
// block submission without a follow_up_date for that outcome.
// See docs/superpowers/specs/2026-08-17-crm-contact-log-design.md.
const CONTACT_OUTCOME = {
  "No Answer":         { color: "#b9b9a9", soft: "#f0f0e6", label: "No answer",         requiresDate: false },
  "Follow Up":         { color: "#c08438", soft: "#f3e3cb", label: "Follow up",         requiresDate: true  },
  "Meeting Booked":    { color: "#3b7dd8", soft: "#dce7f7", label: "Meeting booked",    requiresDate: true  },
  "Survey Booked":     { color: "#2a9d9d", soft: "#d9f0ef", label: "Survey booked",     requiresDate: true  },
  "Quote Sent":        { color: "#8a6d3b", soft: "#ede2cf", label: "Quote sent",        requiresDate: false },
  "Converted":         { color: "#2ba45e", soft: "#e6f4ec", label: "Converted",         requiresDate: false },
  "Not Interested":    { color: "#8e9080", soft: "#ececdf", label: "Not interested",    requiresDate: false },
  "Already Has Solar": { color: "#6f5b94", soft: "#e2dcec", label: "Already has solar", requiresDate: false },
};
const CONTACT_OUTCOME_ORDER = Object.keys(CONTACT_OUTCOME);
```

- [ ] **Step 2: Verify in isolation**

Open the browser console (via `npx serve .` or the live site) after this file is loaded and run:
```js
CONTACT_OUTCOME_ORDER.length  // expect 8
CONTACT_OUTCOME["Follow Up"].requiresDate  // expect true
CONTACT_OUTCOME["Converted"].requiresDate  // expect false
```

- [ ] **Step 3: Commit**

```
git add shared/contact-outcome-config.js
git commit -m "Add contact outcome config (colours, labels, date requirement)"
```

---

### Task 3: Log Contact modal in `index.html`

**Files:**
- Modify: `index.html`

**Interfaces:**
- Consumes: `CONTACT_OUTCOME`/`CONTACT_OUTCOME_ORDER` (Task 2), the existing `getUserName(currentUser)` and `escapeHtml()` helpers, `window.db` (existing Supabase client), and the existing `buildPopup(d)` function this task extends.

- [ ] **Step 1: Load the new script**

Add after `<script src="shared/talking-points.js"></script>` (or after `escape-html.js` if the Companies House plan hasn't landed yet):
```html
<script src="shared/contact-outcome-config.js"></script>
```

- [ ] **Step 2: Add the modal markup**

Add just before the closing `</body>` tag:
```html
<div id="contact-modal-overlay">
  <div id="contact-modal">
    <div class="modal-header">
      <div class="modal-header-text">
        <div class="modal-eyebrow">Log contact</div>
        <h2 id="cm-prospect-name">—</h2>
        <div class="modal-sub" id="cm-prospect-meta"></div>
      </div>
      <button class="modal-close" id="cm-close-btn" aria-label="Close">✕</button>
    </div>

    <div class="modal-body">
      <input type="hidden" id="cm-prospect-id"/>

      <label>Your name</label>
      <input type="text" id="cm-employee" placeholder="Enter your name…"/>

      <label>Outcome <span class="required">*</span></label>
      <div class="outcome-chips" id="cm-outcome-chips"></div>
      <select id="cm-outcome" style="display:none"></select>

      <div id="cm-followup-date-group" style="display:none">
        <label>Date <span class="required">*</span></label>
        <input type="date" id="cm-followup-date"/>
      </div>

      <label>Notes <span class="optional-label">— optional</span></label>
      <textarea id="cm-notes" placeholder="What was said? Action items? Any sensitivities?"></textarea>

      <label>Next action <span class="optional-label">— optional</span></label>
      <textarea id="cm-next-action" placeholder="What needs to happen next…"></textarea>
    </div>

    <div class="modal-footer">
      <span class="modal-shortcuts">Esc to cancel · ⌘+↵ to save</span>
      <div class="modal-btns">
        <button class="btn-secondary" id="cm-cancel">Cancel</button>
        <button class="btn-primary" id="cm-submit">Save log</button>
      </div>
    </div>
  </div>
</div>
```

- [ ] **Step 3: Add the modal CSS**

Add to the `<style>` block (after the `.company-match-links a` rule if Task 3 of the Companies House plan already landed, otherwise after `.solar-est`):
```css
#contact-modal-overlay { display: none; position: fixed; inset: 0; background: rgba(17,24,39,0.4); z-index: 2000; align-items: center; justify-content: center; }
#contact-modal-overlay.open { display: flex; }
#contact-modal { width: 420px; max-width: 92vw; max-height: 88vh; overflow-y: auto; background: var(--surface); border-radius: 14px; box-shadow: 0 20px 60px rgba(0,0,0,.25); }
.modal-header { display: flex; align-items: flex-start; justify-content: space-between; padding: 20px 22px 14px; border-bottom: 1px solid var(--border); }
.modal-eyebrow { font-size: 11px; color: var(--text3); text-transform: uppercase; letter-spacing: .08em; }
.modal-header-text h2 { font-size: 17px; font-weight: 600; margin-top: 4px; }
.modal-sub { font-size: 12.5px; color: var(--text2); margin-top: 2px; }
.modal-close { background: none; border: none; font-size: 16px; color: var(--text3); cursor: pointer; padding: 4px 8px; border-radius: 6px; }
.modal-close:hover { background: var(--surface2); color: var(--text); }
.modal-body { padding: 18px 22px; }
.modal-body label { display: block; font-size: 12.5px; font-weight: 500; color: var(--text2); margin: 14px 0 6px; }
.modal-body label:first-child { margin-top: 0; }
.modal-body .required { color: var(--alert); margin-left: 3px; }
.optional-label { color: var(--text3); font-weight: 400; font-size: 11.5px; }
.modal-body input[type="text"], .modal-body input[type="date"], .modal-body textarea {
  width: 100%; padding: 9px 11px; border: 1px solid var(--border); border-radius: 8px;
  font-family: inherit; font-size: 13px; background: var(--surface2); color: var(--text);
}
.modal-body input:focus, .modal-body textarea:focus { outline: none; border-color: var(--accent); }
.modal-body textarea { resize: vertical; min-height: 70px; line-height: 1.5; }
.outcome-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.outcome-chip { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px 6px 9px; border-radius: 100px; border: 1px solid var(--border); background: var(--surface2); font-size: 12px; color: var(--text2); cursor: pointer; font-family: inherit; }
.outcome-chip .chip-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.outcome-chip.on { color: #fff; border-color: transparent; }
.modal-footer { display: flex; align-items: center; justify-content: space-between; padding: 14px 22px; border-top: 1px solid var(--border); }
.modal-shortcuts { font-size: 11px; color: var(--text3); font-family: monospace; }
.modal-btns { display: flex; gap: 8px; }
.btn-secondary, .btn-primary { padding: 8px 16px; border-radius: 8px; font-size: 13px; font-weight: 500; cursor: pointer; font-family: inherit; border: none; }
.btn-secondary { background: var(--surface2); color: var(--text2); }
.btn-primary { background: var(--accent); color: #fff; }
.btn-primary:disabled { opacity: .6; cursor: default; }
.log-contact-btn { margin: 0 20px 18px; padding: 9px 14px; width: calc(100% - 40px); background: var(--accentDim); color: var(--accentDk); border: none; border-radius: 8px; font-size: 12.5px; font-weight: 500; cursor: pointer; font-family: inherit; }
```

- [ ] **Step 4: Add a "Log contact" button to the popup**

In `buildPopup(d)`, find the closing of the popup div (the last `</div>` before the final backtick) and add a button just before it, after the `company-match` div (or after `popup-facts` if the Companies House plan hasn't landed):
```js
      <button class="log-contact-btn" onclick="openContactModal('${d.id}', ${JSON.stringify(d.address || d.postcode || 'Unnamed building')})">Log contact</button>
    </div>`;
```

- [ ] **Step 5: Build the outcome chips dynamically and wire the modal**

Add after the `buildPopup` function:
```js
/* ── Contact log modal ──────────────────────────────────────── */
(function initContactModal() {
  const chipsEl = document.getElementById('cm-outcome-chips');
  const selectEl = document.getElementById('cm-outcome');
  CONTACT_OUTCOME_ORDER.forEach(name => {
    const cfg = CONTACT_OUTCOME[name];
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'outcome-chip';
    chip.dataset.value = name;
    chip.innerHTML = `<span class="chip-dot" style="background:${cfg.color}"></span>${escapeHtml(cfg.label)}`;
    chip.addEventListener('click', () => {
      document.querySelectorAll('#cm-outcome-chips .outcome-chip').forEach(c => { c.classList.remove('on'); c.style.background = ''; c.style.borderColor = ''; });
      chip.classList.add('on');
      chip.style.background = cfg.color;
      chip.style.borderColor = cfg.color;
      selectEl.value = name;
      selectEl.dispatchEvent(new Event('change'));
    });
    chipsEl.appendChild(chip);

    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    selectEl.appendChild(opt);
  });
})();

document.getElementById('cm-outcome').addEventListener('change', e => {
  const group = document.getElementById('cm-followup-date-group');
  const cfg = CONTACT_OUTCOME[e.target.value];
  if (cfg && cfg.requiresDate) {
    group.style.display = 'block';
    const todayStr = new Date().toISOString().slice(0, 10);
    const input = document.getElementById('cm-followup-date');
    input.min = todayStr;
    if (!input.value) {
      const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
      input.value = tomorrow.toISOString().slice(0, 10);
    }
  } else {
    group.style.display = 'none';
  }
});

function openContactModal(prospectId, prospectName) {
  document.getElementById('cm-prospect-id').value = prospectId;
  document.getElementById('cm-prospect-name').textContent = prospectName;
  document.getElementById('cm-prospect-meta').textContent = '';
  document.getElementById('cm-employee').value = currentUser ? getUserName(currentUser) : '';
  document.querySelectorAll('#cm-outcome-chips .outcome-chip').forEach(c => { c.classList.remove('on'); c.style.background = ''; c.style.borderColor = ''; });
  document.getElementById('cm-outcome').value = '';
  document.getElementById('cm-followup-date-group').style.display = 'none';
  document.getElementById('cm-followup-date').value = '';
  document.getElementById('cm-notes').value = '';
  document.getElementById('cm-next-action').value = '';
  document.getElementById('contact-modal-overlay').classList.add('open');
}

function closeContactModal() {
  document.getElementById('contact-modal-overlay').classList.remove('open');
}

document.getElementById('cm-cancel').addEventListener('click', closeContactModal);
document.getElementById('cm-close-btn').addEventListener('click', closeContactModal);
document.getElementById('contact-modal-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('contact-modal-overlay')) closeContactModal();
});
document.addEventListener('keydown', e => {
  if (!document.getElementById('contact-modal-overlay').classList.contains('open')) return;
  if (e.key === 'Escape') closeContactModal();
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') document.getElementById('cm-submit').click();
});

document.getElementById('cm-submit').addEventListener('click', async () => {
  const prospectId = document.getElementById('cm-prospect-id').value;
  const employee = document.getElementById('cm-employee').value.trim();
  const outcome = document.getElementById('cm-outcome').value;
  const followUpDate = document.getElementById('cm-followup-date').value;
  const notes = document.getElementById('cm-notes').value.trim();
  const nextAction = document.getElementById('cm-next-action').value.trim();

  if (!employee) { alert('Please enter your name.'); return; }
  if (!outcome) { alert('Please pick an outcome.'); return; }
  if (CONTACT_OUTCOME[outcome].requiresDate && !followUpDate) { alert('Please set a date.'); return; }

  const btn = document.getElementById('cm-submit');
  btn.disabled = true; btn.textContent = 'Saving…';

  const { error } = await window.db.from('prospect_contacts').insert([{
    prospect_id: prospectId,
    employee,
    employee_email: currentUser?.email || null,
    outcome,
    notes: notes || null,
    next_action: nextAction || null,
    follow_up_date: CONTACT_OUTCOME[outcome].requiresDate ? (followUpDate || null) : null,
  }]);

  btn.disabled = false; btn.textContent = 'Save log';

  if (error) { alert('Failed to save: ' + error.message); return; }

  closeContactModal();
});
```

- [ ] **Step 6: Verify live**

Serve the site, sign in, open a prospect, click "Log contact." Confirm:
- The modal opens with the prospect's name shown and your own name pre-filled.
- Selecting `Follow Up`, `Meeting Booked`, or `Survey Booked` reveals the date field (pre-filled to tomorrow, can't pick a past date); selecting any other outcome hides it.
- Submitting without an outcome, without a name, or without a required date is blocked with the matching alert.
- Submitting a valid `No Answer` log succeeds (modal closes, no error) — confirm via Task 1's Step 3 curl check (as the manager) that the row landed in `prospect_contacts` with the right `prospect_id`, `employee`, and `outcome`.
- Submitting a `Follow Up` with a real date succeeds and the row's `follow_up_date` is set.

- [ ] **Step 7: Commit**

```
git add index.html
git commit -m "Add Log Contact modal to the prospect popup"
```

---

### Task 4: Manager dashboard (`dashboard.html`)

**Files:**
- Create: `dashboard.html`

**Interfaces:**
- Consumes: `prospect_contacts` (via `window.db`, RLS restricts real data to the manager's session), `CONTACT_OUTCOME`/`CONTACT_OUTCOME_ORDER` (Task 2), `escapeHtml()`, `isAdmin()`/`getUserName()` (same logic as `index.html`, duplicated here since this is a standalone page with its own `<script>` block, matching how mcs-map's `dashboard.html` and `index.html` each carry their own copy rather than sharing a module).

- [ ] **Step 1: Write the page**

Create `dashboard.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Turbine Energy — Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<style>
:root {
  --bg: #f8f9fa; --surface: #ffffff; --surface2: #eef1ec;
  --border: rgba(17,24,39,0.12); --borderH: rgba(17,24,39,0.18);
  --text: #111827; --text2: #6b7280; --text3: rgba(17,24,39,0.38);
  --accent: #2ba45e; --accentDim: rgba(43,164,94,0.12); --accentDk: #1f8a52;
  --warn: #c08438; --warnSoft: #f3e3cb; --alert: #b85544; --alertSoft: #f0d3ce;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; background: var(--bg); color: var(--text); font-size: 14px; line-height: 1.45; }
a { color: var(--accent); text-decoration: none; }
button { font-family: inherit; cursor: pointer; }
#top-nav { background: var(--surface); border-bottom: 1px solid var(--border); height: 56px; display: flex; align-items: center; justify-content: space-between; padding: 0 24px; position: sticky; top: 0; }
.nav-brand { font-weight: 600; font-size: 15px; }
.nav-brand-sub { font-size: 11.5px; color: var(--text3); margin-left: 6px; }
#sign-out-btn { background: none; border: 1px solid var(--border); border-radius: 8px; padding: 6px 12px; font-size: 12.5px; color: var(--text2); }
#wrap { max-width: 1100px; margin: 0 auto; padding: 24px; }
.period-row { display: flex; gap: 8px; margin-bottom: 18px; }
.period-btn { padding: 6px 14px; border-radius: 100px; border: 1px solid var(--border); background: var(--surface); font-size: 12.5px; color: var(--text2); }
.period-btn.active { background: var(--accent); color: #fff; border-color: var(--accent); }
.charts-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px; }
.chart-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px; }
.chart-card h3 { font-size: 13px; font-weight: 600; margin-bottom: 12px; }
.table-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
.table-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid var(--border); }
.table-header h2 { font-size: 14px; }
.filters { display: flex; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.filters select, .filters input { padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px; font-size: 12.5px; background: var(--surface2); }
#export-btn { background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; padding: 6px 12px; font-size: 12.5px; }
table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
th { text-align: left; padding: 10px 16px; color: var(--text3); font-weight: 500; border-bottom: 1px solid var(--border); cursor: pointer; white-space: nowrap; }
td { padding: 10px 16px; border-bottom: 1px solid var(--border); vertical-align: top; }
.outcome-tag { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px 3px 6px; border-radius: 100px; font-size: 11px; }
.outcome-tag .dot { width: 6px; height: 6px; border-radius: 50%; }
#empty-state, #denied-state { text-align: center; padding: 60px 20px; color: var(--text3); }
</style>
</head>
<body>

<div id="top-nav">
  <div><span class="nav-brand">Turbine Energy</span><span class="nav-brand-sub">Dashboard</span></div>
  <button id="sign-out-btn">Sign out</button>
</div>

<div id="wrap" style="display:none">
  <div class="period-row">
    <button class="period-btn active" data-period="week">7 days</button>
    <button class="period-btn" data-period="month">30 days</button>
    <button class="period-btn" data-period="all">All time</button>
  </div>

  <div class="charts-row">
    <div class="chart-card"><h3>Daily activity</h3><canvas id="chart-activity" style="max-height:220px"></canvas></div>
    <div class="chart-card"><h3>By employee</h3><canvas id="chart-employee" style="max-height:220px"></canvas></div>
  </div>

  <div class="table-card">
    <div class="table-header"><h2>Contact log</h2><button id="export-btn">Export CSV</button></div>
    <div class="filters">
      <select id="f-employee"><option value="">All employees</option></select>
      <select id="f-outcome"><option value="">All outcomes</option></select>
      <input type="text" id="f-search" placeholder="Search prospect address…"/>
    </div>
    <table>
      <thead><tr>
        <th data-col="contacted_at">Date</th>
        <th data-col="prospect_address">Prospect</th>
        <th data-col="employee">Employee</th>
        <th data-col="outcome">Outcome</th>
        <th data-col="follow_up_date">Follow-up</th>
        <th data-col="notes">Notes</th>
      </tr></thead>
      <tbody id="table-body"></tbody>
    </table>
    <div id="empty-state" style="display:none">No contacts logged yet.</div>
  </div>
</div>

<div id="denied-state" style="display:none">This page is restricted to managers.</div>

<script src="shared/escape-html.js"></script>
<script src="shared/contact-outcome-config.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
<script>
const { createClient } = supabase;
const db = createClient(
  'https://gkvropheqktytghmiwgp.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdrdnJvcGhlcWt0eXRnaG1pd2dwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU5Mjg2NjAsImV4cCI6MjEwMTUwNDY2MH0.swu4sPPi2X9fS-DQEh-cW-ypWZqbWNHXLnGHaKWMxI8'
);

const ADMIN_EMAILS = ['greg@turbineenergyuk.co.uk'];
function isAdmin(user) { return ADMIN_EMAILS.includes((user?.email || '').toLowerCase()); }

let allData = [];
let prospectNames = {};
let activePeriod = 'week';
let activeCharts = {};

async function boot(user) {
  if (!isAdmin(user)) {
    document.getElementById('denied-state').style.display = 'block';
    return;
  }
  document.getElementById('wrap').style.display = 'block';
  await loadData();
  populateFilters();
  buildCharts();
  renderTable();
}

document.getElementById('sign-out-btn').addEventListener('click', async () => { await db.auth.signOut(); location.href = 'index.html'; });

db.auth.getSession().then(({ data: { session } }) => {
  if (session?.user) boot(session.user);
  else location.href = 'index.html';
});

async function loadData() {
  const { data: contacts, error } = await db.from('prospect_contacts').select('*').order('contacted_at', { ascending: false });
  if (error) { console.error('Failed to load prospect_contacts:', error); allData = []; return; }
  allData = contacts || [];

  const ids = [...new Set(allData.map(c => c.prospect_id))];
  if (ids.length) {
    const { data: prospects } = await db.from('prospects').select('id, address, postcode').in('id', ids);
    (prospects || []).forEach(p => { prospectNames[p.id] = p.address || p.postcode || 'Unknown'; });
  }
}

function periodData() {
  if (activePeriod === 'all') return allData;
  const days = activePeriod === 'week' ? 7 : 30;
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - days);
  return allData.filter(c => new Date(c.contacted_at) >= cutoff);
}

function populateFilters() {
  const employees = [...new Set(allData.map(c => c.employee))].sort();
  const empSel = document.getElementById('f-employee');
  employees.forEach(e => { const opt = document.createElement('option'); opt.value = e; opt.textContent = e; empSel.appendChild(opt); });

  const outSel = document.getElementById('f-outcome');
  CONTACT_OUTCOME_ORDER.forEach(o => { const opt = document.createElement('option'); opt.value = o; opt.textContent = CONTACT_OUTCOME[o].label; outSel.appendChild(opt); });

  [empSel, outSel].forEach(el => el.addEventListener('change', renderTable));
  document.getElementById('f-search').addEventListener('input', renderTable);
  document.querySelectorAll('.period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activePeriod = btn.dataset.period;
      document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      buildCharts();
    });
  });
}

function buildCharts() {
  const pd = periodData();

  const dateKeys = [], labels = [], values = [];
  if (activePeriod === 'all') {
    const months = [...new Set(allData.map(c => c.contacted_at.slice(0,7)))].sort();
    months.forEach(m => { dateKeys.push(m); labels.push(new Date(m + '-02').toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })); values.push(0); });
    allData.forEach(c => { const i = dateKeys.indexOf(c.contacted_at.slice(0,7)); if (i >= 0) values[i]++; });
  } else {
    const days = activePeriod === 'week' ? 7 : 30;
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      dateKeys.push(d.toISOString().slice(0,10));
      labels.push(d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }));
      values.push(0);
    }
    allData.forEach(c => { const i = dateKeys.indexOf(c.contacted_at.slice(0,10)); if (i >= 0) values[i]++; });
  }

  if (activeCharts.activity) activeCharts.activity.destroy();
  activeCharts.activity = new Chart(document.getElementById('chart-activity'), {
    type: 'bar',
    data: { labels, datasets: [{ data: values, backgroundColor: '#2ba45e', borderRadius: 4, maxBarThickness: 22 }] },
    options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1, precision: 0 } } } }
  });

  const empCounts = {};
  pd.forEach(c => { empCounts[c.employee] = (empCounts[c.employee] || 0) + 1; });
  const sorted = Object.entries(empCounts).sort((a,b) => b[1] - a[1]);
  if (activeCharts.employee) activeCharts.employee.destroy();
  activeCharts.employee = new Chart(document.getElementById('chart-employee'), {
    type: 'bar',
    data: { labels: sorted.map(e => e[0]), datasets: [{ data: sorted.map(e => e[1]), backgroundColor: '#1f8a52', borderRadius: 6, maxBarThickness: 20 }] },
    options: { indexAxis: 'y', responsive: true, plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { stepSize: 1, precision: 0 } } } }
  });
}

function filteredRows() {
  const emp = document.getElementById('f-employee').value;
  const outcome = document.getElementById('f-outcome').value;
  const search = document.getElementById('f-search').value.trim().toLowerCase();
  return allData.filter(c => {
    if (emp && c.employee !== emp) return false;
    if (outcome && c.outcome !== outcome) return false;
    if (search && !(prospectNames[c.prospect_id] || '').toLowerCase().includes(search)) return false;
    return true;
  });
}

function renderTable() {
  const rows = filteredRows();
  const tbody = document.getElementById('table-body');
  tbody.innerHTML = '';
  document.getElementById('empty-state').style.display = rows.length ? 'none' : 'block';

  rows.forEach(c => {
    const cfg = CONTACT_OUTCOME[c.outcome] || { color: '#999', label: c.outcome };
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${new Date(c.contacted_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</td>
      <td>${escapeHtml(prospectNames[c.prospect_id] || 'Unknown')}</td>
      <td>${escapeHtml(c.employee)}</td>
      <td><span class="outcome-tag" style="background:${cfg.color}22;color:${cfg.color}"><span class="dot" style="background:${cfg.color}"></span>${escapeHtml(cfg.label)}</span></td>
      <td>${c.follow_up_date ? new Date(c.follow_up_date).toLocaleDateString('en-GB') : ''}</td>
      <td>${escapeHtml(c.notes || '')}</td>`;
    tbody.appendChild(tr);
  });
}

document.getElementById('export-btn').addEventListener('click', () => {
  const rows = filteredRows();
  const cols = ['contacted_at','prospect_id','employee','outcome','notes','next_action','follow_up_date'];
  const header = ['Date','Prospect ID','Employee','Outcome','Notes','Next Action','Follow-up Date'];
  const csvRows = rows.map(r => cols.map(c => `"${(r[c] || '').toString().replace(/"/g,'""')}"`).join(','));
  const csv = [header.join(','), ...csvRows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), { href: url, download: `turbine-contacts-${new Date().toISOString().slice(0,10)}.csv` }).click();
  URL.revokeObjectURL(url);
});
</script>
</body>
</html>
```

- [ ] **Step 2: Verify live**

Serve the site and sign in as a **non-admin** test account, then navigate directly to `dashboard.html` — confirm the "restricted to managers" state shows and no chart/table data is fetched (open dev tools Network tab to confirm the `prospect_contacts` request, if any, returns `[]`, not real data).

Then sign in as `greg@turbineenergyuk.co.uk` and navigate to `dashboard.html` — confirm real contact rows (logged during Task 3's verification) appear in the table, the "Daily activity" and "By employee" charts render with real bars, the employee/outcome filters and search work, switching between 7 days / 30 days / All time changes the charts, and clicking "Export CSV" downloads a real CSV with the logged rows.

- [ ] **Step 3: Commit**

```
git add dashboard.html
git commit -m "Add manager-only dashboard for the contact log"
```

---

### Task 5: Update `HANDOVER.md`

**Files:**
- Modify: `HANDOVER.md`

- [ ] **Step 1: Document the new feature**

Add a new Section 6a (or extend Section 6) describing the Log Contact modal and outcome enum; add `prospect_contacts` under Section 5 (Database Schema), noting the manager-only RLS read policy explicitly (since it deviates from `mcs-map`'s more permissive pattern — worth flagging for anyone comparing the two projects later); add `dashboard.html` as a new top-level file in the Section 3 file tree; and update Section 8 (Not Yet Built) to remove the now-built `prospect_contacts`/Log Contact/dashboard items, replacing them with the remaining deferred items (Companies House trigger-mechanism change + its own activity log, edit/soft-delete UI, rep-facing read access). Cross-reference `docs/superpowers/specs/2026-08-17-crm-contact-log-design.md` rather than duplicating detail.

- [ ] **Step 2: Commit**

```
git add HANDOVER.md
git commit -m "Document CRM contact log + manager dashboard in HANDOVER.md"
```
