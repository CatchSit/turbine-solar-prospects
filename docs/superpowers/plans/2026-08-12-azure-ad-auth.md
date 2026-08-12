# Azure AD Login + RLS-Enforced Access Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the static `prospects.json` export with live, RLS-gated Supabase queries, fronted by a Microsoft/Azure AD login screen, so only authenticated `@turbineenergyuk.co.uk` accounts can read prospect data — matching the sibling `mcs-map` project's proven auth pattern.

**Architecture:** `index.html` embeds the Supabase JS SDK (anon key, safe to expose) and queries `prospects` directly instead of fetching a static file. A new RLS policy requires an authenticated session, so an unauthenticated request gets zero rows from Postgres itself. Sign-in uses Supabase Auth's Azure OAuth provider; a frontend domain check is defense-in-depth on top of the Azure App Registration's tenant restriction.

**Tech Stack:** Supabase JS SDK v2 (UMD), Supabase Auth (Azure provider), Postgres RLS, vanilla JS (no build tool, no test framework — matches the existing codebase). Verification uses `curl` against the Supabase REST/Auth APIs and Playwright browser automation against the running static page, mirroring how this project has been verified throughout its build so far (no unit-test framework exists in this repo and none is being introduced).

## Global Constraints

- No build tool, no bundler, no test framework — `index.html` stays a single static file (per HANDOVER.md Section 3's existing architecture philosophy).
- Domain restriction: `@turbineenergyuk.co.uk` (exact, case-insensitive) — from `docs/superpowers/specs/2026-08-12-azure-ad-auth-design.md`.
- Admin stub email: `greg@turbineenergyuk.co.uk` — not wired to any behavior yet, per spec's Non-goals.
- Supabase project: URL `https://gkvropheqktytghmiwgp.supabase.co`. The anon key is safe to hardcode in `index.html` (same practice as mcs-map); the service-role key must never be committed to any file — pass it via environment variable in every verification command.
- The Azure App Registration itself (Turbine IT's task) is out of scope for this plan — it's tracked as an external dependency. Everything here works and is independently verifiable without it, except the final live "click Sign In with a real Microsoft account" check, which needs a human with Azure IT's completed setup.

---

### Task 1: RLS migration — require authenticated reads

**Files:**
- Create: `supabase/migrations/003_prospects_auth_rls.sql`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: nothing other tasks call directly — this is a database-only change. Task 3's live queries rely on this policy existing, but don't reference it by name.

- [ ] **Step 1: Write the migration file**

```sql
-- Replace public read access with authenticated-only read access.
-- The prospects table now holds real Turbine Energy sales-lead data
-- (~21,800 rows as of this migration) — see docs/superpowers/specs/
-- 2026-08-12-azure-ad-auth-design.md for the full rationale. Frontend
-- access now requires a signed-in @turbineenergyuk.co.uk Microsoft
-- account (Azure AD via Supabase Auth), enforced here at the database
-- level, not just in the UI.

DROP POLICY "Public read" ON prospects;

CREATE POLICY "Authenticated read"
  ON prospects FOR SELECT
  TO authenticated
  USING (true);
```

- [ ] **Step 2: Apply the migration (human-gated — same as migrations 001/002)**

This project's earlier migrations were applied by pasting into the Supabase dashboard's SQL Editor (Project → SQL Editor), not via `supabase db push` — the CLI's migration-history tracking doesn't know about those manual applies, so pushing now would try to re-run 001/002 and fail on `CREATE POLICY "Public read"` already existing. Paste the Step 1 SQL into the SQL Editor and run it there.

If you're an agent executing this plan and don't have dashboard access, stop here and ask the user to run it, then continue once confirmed.

- [ ] **Step 3: Verify anonymous access is now blocked**

```bash
curl -s "https://gkvropheqktytghmiwgp.supabase.co/rest/v1/prospects?select=id&limit=1" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY"
```

Expected: `[]` (RLS silently filters all rows for a role with no matching policy — not an error). Before this migration, this same request returned real rows.

- [ ] **Step 4: Verify authenticated access works, using a throwaway test user**

Create a temporary user via the Auth Admin API (this doesn't require a real Azure login — it tests the `authenticated` role grant itself, which RLS checks regardless of which OAuth provider established the session):

```bash
# Create
curl -s -X POST "https://gkvropheqktytghmiwgp.supabase.co/auth/v1/admin/users" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"rls-test@turbineenergyuk.co.uk","password":"Rls-Test-Temp-Pw-2026!","email_confirm":true}'
# Note the returned "id" as $TEST_USER_ID

# Sign in
curl -s -X POST "https://gkvropheqktytghmiwgp.supabase.co/auth/v1/token?grant_type=password" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"rls-test@turbineenergyuk.co.uk","password":"Rls-Test-Temp-Pw-2026!"}'
# Note the returned "access_token" as $TEST_ACCESS_TOKEN

# Query as that authenticated user
curl -s "https://gkvropheqktytghmiwgp.supabase.co/rest/v1/prospects?select=id&limit=1" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $TEST_ACCESS_TOKEN"
```

Expected: a real row comes back (`[{"id":"..."}]`), proving the `authenticated` policy grants access.

- [ ] **Step 5: Delete the throwaway test user**

```bash
curl -s -X DELETE "https://gkvropheqktytghmiwgp.supabase.co/auth/v1/admin/users/$TEST_USER_ID" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/003_prospects_auth_rls.sql
git commit -m "Require authenticated reads on prospects, dropping public access"
```

---

### Task 2: Retire the static export pipeline

**Files:**
- Delete: `scripts/export-prospects-json.mjs`
- Modify: `package.json:6-10`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing — this is pure removal. Task 3 replaces what this script used to feed (`prospects.json`).

- [ ] **Step 1: Delete the export script**

```bash
git rm scripts/export-prospects-json.mjs
```

- [ ] **Step 2: Remove the "export" npm script**

In `package.json`, change:

```json
  "scripts": {
    "ingest": "node scripts/ingest-epc.mjs",
    "geocode": "node scripts/geocode-postcodes.mjs",
    "export": "node scripts/export-prospects-json.mjs"
  },
```

to:

```json
  "scripts": {
    "ingest": "node scripts/ingest-epc.mjs",
    "geocode": "node scripts/geocode-postcodes.mjs"
  },
```

- [ ] **Step 3: Verify no remaining references**

```bash
grep -rn "export-prospects-json\|prospects\.json" --include="*.js" --include="*.mjs" --include="*.json" --include="*.html" .
```

Expected: no output (the only remaining textual mentions should be in `HANDOVER.md` and the design/plan docs, which Task 4 updates — none of those match the file globs above).

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "Retire the static prospects.json export pipeline"
```

---

### Task 3: Supabase SDK, login screen, and live authenticated data loading

**Files:**
- Modify: `index.html`

**Interfaces:**
- Consumes: the RLS policy from Task 1 (queries will return empty for unauthenticated sessions once that's applied — this task's own verification uses a mocked client, so it doesn't require Task 1 to be live first, but the two combine to form the real end-to-end gate).
- Produces: global functions reachable via `window` (plain `<script>`, not a module): `db` (Supabase client), `onAuthenticated(user): boolean`, `showLoginScreen()`, `hideLoginScreen()`, `bootstrapData()`, `fetchAllProspects(): Promise<Array>`, `isAdmin(user): boolean`. No later task in this plan consumes these, but they're the public surface future work (e.g. the CRM layer) would hook into.

- [ ] **Step 1: Add the Supabase SDK script tag**

In `index.html`, change:

```html
<script src="shared/escape-html.js"></script>
<script>
```

to:

```html
<script src="shared/escape-html.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
<script>
```

- [ ] **Step 2: Add login-screen and nav-user CSS**

In `index.html`, find the closing of the loading-spinner CSS block:

```css
    .spinner { width: 32px; height: 32px; border: 3px solid var(--accentDim); border-top-color: var(--accent); border-radius: 50%; animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
```

Replace with (adds the new rules before `</style>`):

```css
    .spinner { width: 32px; height: 32px; border: 3px solid var(--accentDim); border-top-color: var(--accent); border-radius: 50%; animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ── Nav user controls ───────────────────────────────── */
    .nav-right { margin-left: auto; display: flex; align-items: center; gap: 10px; }
    .nav-user-name { font-size: 12.5px; color: var(--text2); }
    .nav-avatar {
      width: 28px; height: 28px; border-radius: 50%;
      background: var(--accentDk); color: #fff;
      font-size: 11px; font-weight: 600;
      display: flex; align-items: center; justify-content: center;
      letter-spacing: 0.02em; flex-shrink: 0;
    }
    .nav-signout-btn {
      background: transparent; color: var(--text2);
      border: 1px solid var(--border); border-radius: 8px;
      padding: 7px 13px; font-size: 12.5px; cursor: pointer;
      font-family: inherit; transition: background .12s, color .12s;
    }
    .nav-signout-btn:hover { background: var(--surface2); color: var(--text); }

    /* ── Login screen ────────────────────────────────────── */
    #login-screen {
      display: none; position: fixed; inset: 0;
      background: var(--bg);
      z-index: 10000;
      align-items: center; justify-content: center;
      padding: 24px;
    }
    #login-screen.visible { display: flex; }
    #login-card {
      position: relative;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 48px 44px;
      width: 460px; max-width: 100%;
      box-shadow: 0 24px 64px rgba(0,0,0,.08);
    }
    #login-card .login-brand { display: flex; align-items: center; gap: 12px; margin-bottom: 36px; }
    #login-card h1 {
      font-size: 26px; font-weight: 600; letter-spacing: -0.02em;
      color: var(--text); margin-top: 6px;
    }
    #login-card .eyebrow {
      font-size: 11px; color: var(--text3);
      text-transform: uppercase; letter-spacing: .08em;
    }
    #login-card p.intro {
      font-size: 14px; color: var(--text2);
      margin-top: 8px; line-height: 1.55;
    }
    #ms-btn {
      margin-top: 32px; width: 100%;
      padding: 14px 0;
      background: var(--text); color: #fff;
      border: 0; border-radius: 12px;
      font-size: 14px; font-weight: 500;
      cursor: pointer; font-family: inherit;
      display: flex; align-items: center; justify-content: center; gap: 12px;
      transition: filter .12s;
    }
    #ms-btn:hover { filter: brightness(1.1); }
    #ms-btn svg { flex-shrink: 0; }
    #login-note {
      margin-top: 20px;
      padding: 12px 14px;
      background: var(--accentDim); color: var(--accentDk);
      border-radius: 10px; font-size: 12px; line-height: 1.55;
      display: flex; gap: 10px;
    }
    #login-error {
      margin-top: 14px; font-size: 12.5px;
      color: var(--alert);
      padding: 10px 12px;
      background: var(--alertSoft);
      border-radius: 8px;
      display: none;
    }
  </style>
```

- [ ] **Step 3: Add nav-right markup and the login-screen markup**

In `index.html`, change:

```html
<nav id="top-nav">
  <div class="brand-mark"></div>
  <span class="nav-brand-name">Turbine Energy</span>
  <span class="nav-brand-sub">Solar Prospects — Yorkshire &amp; Humber pilot</span>
</nav>

<!-- ── Mobile controls ──────────────────────────────────── -->
```

to:

```html
<nav id="top-nav">
  <div class="brand-mark"></div>
  <span class="nav-brand-name">Turbine Energy</span>
  <span class="nav-brand-sub">Solar Prospects — Yorkshire &amp; Humber pilot</span>
  <div class="nav-right">
    <span class="nav-user-name" id="nav-user-name"></span>
    <div class="nav-avatar" id="nav-avatar"></div>
    <button class="nav-signout-btn" id="sign-out-btn">Sign out</button>
  </div>
</nav>

<!-- ── Login screen ──────────────────────────────────────── -->
<div id="login-screen">
  <div id="login-card">
    <div class="login-brand">
      <div class="brand-mark"></div>
      <div>
        <div class="nav-brand-name">Turbine Energy</div>
        <div class="nav-brand-sub">Solar Prospects</div>
      </div>
    </div>
    <div class="eyebrow">Sign in</div>
    <h1>Welcome back.</h1>
    <p class="intro">Sign in with your Microsoft work account to view the prospect map.</p>
    <button id="ms-btn">
      <svg width="18" height="18" viewBox="0 0 21 21" xmlns="http://www.w3.org/2000/svg">
        <rect x="1" y="1" width="9" height="9" fill="#f25022"/>
        <rect x="11" y="1" width="9" height="9" fill="#7fba00"/>
        <rect x="1" y="11" width="9" height="9" fill="#00a4ef"/>
        <rect x="11" y="11" width="9" height="9" fill="#ffb900"/>
      </svg>
      Continue with Microsoft
    </button>
    <div id="login-note">
      <span style="font-size:14px">ⓘ</span>
      <span>Access restricted to <strong>@turbineenergyuk.co.uk</strong>. Contact IT for access requests.</span>
    </div>
    <div id="login-error">Sign-in failed. Please try again.</div>
  </div>
</div>

<!-- ── Mobile controls ──────────────────────────────────── -->
```

- [ ] **Step 4: Replace the static bootstrap with Supabase client init, auth logic, and a live paginated query**

In `index.html`, change:

```html
<script>

/* ── Building-type bucketing ─────────────────────────────────
```

to:

```html
<script>

/* ── Supabase ────────────────────────────────────────────── */
const { createClient } = supabase;
const db = createClient(
  'https://gkvropheqktytghmiwgp.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdrdnJvcGhlcWt0eXRnaG1pd2dwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU5Mjg2NjAsImV4cCI6MjEwMTUwNDY2MH0.swu4sPPi2X9fS-DQEh-cW-ypWZqbWNHXLnGHaKWMxI8'
);

/* ── Auth ────────────────────────────────────────────────── */
let currentUser = null;

const ADMIN_EMAILS = ['greg@turbineenergyuk.co.uk'];
function isAdmin(user) { return ADMIN_EMAILS.includes((user?.email || '').toLowerCase()); }

function getUserName(user) {
  return user.user_metadata?.full_name
    || user.user_metadata?.name
    || user.email?.split('@')[0]
    || 'User';
}

function getInitials(name) {
  const parts = name.trim().split(/\s+/);
  return parts.length >= 2 ? (parts[0][0] + parts[1][0]).toUpperCase() : name.slice(0,2).toUpperCase();
}

function showLoginScreen() {
  document.getElementById('login-screen').classList.add('visible');
}
function hideLoginScreen() {
  document.getElementById('login-screen').classList.remove('visible');
}

// Returns true if the session is accepted, false if it was rejected
// (and already signed back out) for being outside the allowed domain.
function onAuthenticated(user) {
  if (!user.email?.toLowerCase().endsWith('@turbineenergyuk.co.uk')) {
    db.auth.signOut();
    const err = document.getElementById('login-error');
    err.textContent = 'Access restricted to @turbineenergyuk.co.uk accounts.';
    err.style.display = 'block';
    showLoginScreen();
    return false;
  }
  currentUser = user;
  hideLoginScreen();
  const name = getUserName(user);
  document.getElementById('nav-user-name').textContent = name;
  document.getElementById('nav-avatar').textContent = getInitials(name);
  return true;
}

document.getElementById('ms-btn').addEventListener('click', async () => {
  document.getElementById('login-error').style.display = 'none';
  const { error } = await db.auth.signInWithOAuth({
    provider: 'azure',
    options: {
      scopes: 'email profile openid',
      redirectTo: window.location.href.split('#')[0],
    }
  });
  if (error) {
    document.getElementById('login-error').style.display = 'block';
  }
});

document.getElementById('sign-out-btn').addEventListener('click', async () => {
  await db.auth.signOut();
  showLoginScreen();
});

db.auth.getSession().then(({ data: { session } }) => {
  if (session?.user && onAuthenticated(session.user)) {
    bootstrapData();
  } else if (!session?.user) {
    document.getElementById('loading').style.display = 'none';
    showLoginScreen();
  }
});

db.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_IN' && session?.user && onAuthenticated(session.user)) {
    bootstrapData();
  }
});

/* ── Building-type bucketing ─────────────────────────────────
```

- [ ] **Step 5: Replace the old static-file bootstrap with a live, paginated, column-aliased query**

In `index.html`, change:

```html
/* ── Bootstrap ───────────────────────────────────────────── */
fetch("prospects.json")
  .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
  .then(data => {
    document.getElementById("loading").style.display = "none";
    initMap(data);
    applyFilters();
  })
  .catch(() => {
    document.getElementById("loading").innerHTML =
      "<p style='color:var(--alert)'>Failed to load prospect data.<br>Please try refreshing.</p>";
  });

</script>
```

to:

```html
/* ── Bootstrap ───────────────────────────────────────────── */
async function fetchAllProspects() {
  const rows = [];
  const PAGE = 1000; // PostgREST's default max-rows cap — must page past it explicitly
  let from = 0;
  while (true) {
    const { data, error } = await db
      .from('prospects')
      .select('id, address, postcode, lat, lng, property_type, floor_area:total_floor_area, epc_rating:current_energy_rating, local_authority, solar_status, solar_max_panels, solar_yearly_energy_kwh')
      .not('lat', 'is', null)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(JSON.stringify(error));
    rows.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

function bootstrapData() {
  fetchAllProspects()
    .then(data => {
      document.getElementById("loading").style.display = "none";
      initMap(data);
      applyFilters();
    })
    .catch(() => {
      document.getElementById("loading").innerHTML =
        "<p style='color:var(--alert)'>Failed to load prospect data.<br>Please try refreshing.</p>";
    });
}

</script>
```

- [ ] **Step 6: Verify the login gate renders and blocks by default (no mocking needed)**

```bash
cd "c:/Users/GregRoy/Projects/turbine-solar-prospects"
npx --yes serve . -p 5060 &
```

Use Playwright (`browser_navigate` to `http://localhost:5060/`, then `browser_snapshot` or `browser_evaluate`) to confirm:
- `document.getElementById('login-screen').classList.contains('visible')` is `true`
- `document.getElementById('loading').style.display` is `'none'`
- No map markers are present (data was never fetched)

This works against the real (anon, session-less) Supabase client — no mocking required, since there's genuinely no session yet.

- [ ] **Step 7: Verify a valid-domain login unlocks the app, using a mocked Supabase client**

Via `browser_evaluate` on the already-loaded page:

```js
window.db.from = () => ({
  select: () => ({
    not: () => ({
      range: (from) => Promise.resolve({
        data: from === 0 ? [{
          id: '1', address: 'Test Building, Leeds', postcode: 'LS1 1AA',
          lat: 53.8, lng: -1.5, property_type: 'Offices', floor_area: 1000,
          epc_rating: 'C', local_authority: 'Leeds', solar_status: 'prospect',
          solar_max_panels: 100, solar_yearly_energy_kwh: 40000,
        }] : [],
        error: null,
      }),
    }),
  }),
});
window.onAuthenticated({ email: 'greg@turbineenergyuk.co.uk', user_metadata: { full_name: 'Greg Roy' } });
window.bootstrapData();
```

Then confirm:
- `document.getElementById('login-screen').classList.contains('visible')` is `false`
- `document.getElementById('nav-user-name').textContent` is `'Greg Roy'`
- `document.getElementById('shown').textContent` / `document.getElementById('total').textContent` reflect 1 building (confirms `bootstrapData` → `initMap` wiring works end-to-end with the new query shape)

This also proves the pagination loop terminates correctly (the mock returns data only on the `from === 0` page, empty after) and that the column aliases (`floor_area`, `epc_rating`) land on the fields the existing render code already expects.

- [ ] **Step 8: Verify a wrong-domain login is rejected**

Reload the page fresh (to reset state), then via `browser_evaluate`:

```js
window.onAuthenticated({ email: 'someone@gmail.com', user_metadata: {} });
```

Confirm:
- Returns `false`
- `document.getElementById('login-screen').classList.contains('visible')` is `true`
- `document.getElementById('login-error').style.display` is `'block'`
- `document.getElementById('login-error').textContent` includes `'@turbineenergyuk.co.uk'`
- `document.getElementById('nav-user-name').textContent` is still empty (never got set)

- [ ] **Step 9: Stop the local server**

```bash
# find and kill the process bound to port 5060, e.g.:
netstat -ano | grep ':5060' | grep LISTENING
# then stop that PID
```

- [ ] **Step 10: Commit**

```bash
git add index.html
git commit -m "Add Azure AD login gate and replace static export with live, paginated Supabase queries"
```

---

### Task 4: Update HANDOVER.md

**Files:**
- Modify: `HANDOVER.md`

**Interfaces:**
- Consumes: nothing (documentation only).
- Produces: nothing.

- [ ] **Step 1: Update the Section 3 architecture claim**

Change:

```
Unlike mcs-map, **the browser never talks to Supabase directly** — there's no CRM data yet to justify shipping an anon key + live queries. `index.html` only fetches the static `prospects.json`. All Supabase access happens server-side (scripts + Edge Function) using the service-role key.
```

to:

```
As of the Azure AD login work, `index.html` **does** talk to Supabase directly, matching mcs-map: the anon key is embedded client-side (safe — RLS is the real gate) and the frontend queries `prospects` live, behind a required Microsoft/Azure AD sign-in (`@turbineenergyuk.co.uk` only). See `docs/superpowers/specs/2026-08-12-azure-ad-auth-design.md` for the full design. The pipeline scripts (ingest, geocode, solar-enrichment) still write server-side using the service-role key, unaffected by this change.
```

- [ ] **Step 2: Update the file tree in Section 3**

Change:

```
turbine-solar-prospects/
├── index.html                        # Only page — prospect map (no login, no CRM)
├── prospects.json                    # Static export consumed by index.html
├── HANDOVER.md                       # This file
├── package.json
├── .gitignore
├── shared/
│   ├── escape-html.js                # Copied verbatim from mcs-map
│   ├── solar-status-config.js        # solar_status -> {color, label}
│   └── epc-rating-config.js          # EPC A-G -> {color, label}
├── data/                             # gitignored — raw EPC CSV downloads go here
├── scripts/                          # Manually-run Node pipeline tooling
│   ├── ingest-epc.mjs                # CSV -> region+floor-area filter -> dedupe -> upsert `prospects`
│   ├── geocode-postcodes.mjs         # postcodes.io bulk lookup -> fills lat/lng
│   └── export-prospects-json.mjs     # Supabase -> prospects.json -> push via GitHub Git Data API
└── supabase/
    ├── migrations/
    │   ├── 001_prospects_schema.sql
    │   └── 002_prospects_rls.sql
    └── functions/
        └── solar-enrichment/
            └── index.ts               # Batched, resumable Google Solar API enrichment
```

to:

```
turbine-solar-prospects/
├── index.html                        # Only page — prospect map, gated by Azure AD login
├── HANDOVER.md                       # This file
├── package.json
├── .gitignore
├── shared/
│   ├── escape-html.js                # Copied verbatim from mcs-map
│   ├── solar-status-config.js        # solar_status -> {color, label}
│   └── epc-rating-config.js          # EPC A-G -> {color, label}
├── data/                             # gitignored — raw EPC CSV downloads go here
├── docs/superpowers/
│   ├── specs/2026-08-12-azure-ad-auth-design.md
│   └── plans/2026-08-12-azure-ad-auth.md
├── scripts/                          # Manually-run Node pipeline tooling
│   ├── ingest-epc.mjs                # CSV -> region+floor-area filter -> dedupe -> upsert `prospects`
│   └── geocode-postcodes.mjs         # postcodes.io bulk lookup -> fills lat/lng
└── supabase/
    ├── migrations/
    │   ├── 001_prospects_schema.sql
    │   ├── 002_prospects_rls.sql
    │   └── 003_prospects_auth_rls.sql  # Drops public read, requires authenticated
    └── functions/
        └── solar-enrichment/
            └── index.ts               # Batched, resumable Google Solar API enrichment
```

- [ ] **Step 3: Update Section 7, risk 8 (auth)**

Change:

```
8. **Auth is deliberately absent in v1**, unlike mcs-map's Azure AD gate — there's no CRM data yet to protect. Revisit when a `prospect_contacts` table lands.
```

to:

```
8. **Auth is now live** (Azure AD via Supabase, matching mcs-map) — see `docs/superpowers/specs/2026-08-12-azure-ad-auth-design.md`. An `ADMIN_EMAILS` stub exists in `index.html` but doesn't gate anything yet; wire it up when the `prospect_contacts` CRM table lands.
```

- [ ] **Step 4: Update Section 8 ("Not Yet Built")**

Remove the line:

```
- Authentication, once there's CRM data worth protecting.
```

- [ ] **Step 5: Commit**

```bash
git add HANDOVER.md
git commit -m "Update HANDOVER.md for the Azure AD login architecture"
```

---

## Self-Review Notes

- **Spec coverage:** Architecture (Task 3), Identity setup (external dependency, explicitly called out in Global Constraints and Task 1 Step 2), Frontend changes (Task 3), Database changes (Task 1), Retired pieces (Task 2), Testing (Tasks 1 & 3 verification steps), Admin stub (Task 3 Step 4). All spec sections have a corresponding task.
- **Placeholder scan:** no TBD/TODO; every step has real, complete code or a real, complete command.
- **Type/name consistency:** `bootstrapData`, `fetchAllProspects`, `onAuthenticated`, `db`, `showLoginScreen`/`hideLoginScreen`, `isAdmin` are named identically everywhere they're defined and referenced across Task 3's steps.
