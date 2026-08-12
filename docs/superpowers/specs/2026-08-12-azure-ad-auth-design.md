# Azure AD Login + Real Access Control — Design

## Context

`turbine-solar-prospects` currently ships with no authentication. `index.html` fetches a static `prospects.json` file (built by `scripts/export-prospects-json.mjs` and pushed to GitHub), and `prospects` table reads are open to the `anon` Supabase role. This was a deliberate v1 choice (HANDOVER.md Section 7, risk 8) made when there was no CRM data worth protecting.

That's no longer true: the pipeline now holds ~21,800 real Yorkshire & Humber sales-prospect records (addresses, floor areas, EPC ratings, solar status). Publishing this anywhere public (e.g. GitHub Pages) would make Turbine Energy's curated sales-lead list world-readable with no login. This design closes that gap by replicating the authentication architecture already proven in the sibling project `mcs-map` (Amco Renewables' installer map): Microsoft/Azure AD login via Supabase Auth, enforced by Postgres Row Level Security.

## Goals

- Only authenticated Turbine Energy staff (`@turbineenergyuk.co.uk`, Microsoft 365 accounts) can read prospect data.
- The access control must be real (enforced by the database), not cosmetic (a UI screen in front of a still-public file).
- Match mcs-map's proven pattern exactly, so there's one authentication approach across both sibling projects.

## Non-goals

- No CRM/contact-logging layer (still deferred, per HANDOVER.md Section 8).
- No admin-gated *functionality* yet — the admin allowlist is a stub for future use (see "Admin stub" below), not a working permission boundary in this iteration.
- No change to the server-side pipeline scripts' auth (`ingest-epc.mjs`, `geocode-postcodes.mjs`, `solar-enrichment`) — they keep using the service-role key, which bypasses RLS regardless of this change.

## Architecture

**Before:** `index.html` --fetch--> `prospects.json` (static file, pushed by `export-prospects-json.mjs`). No auth possible on a static file once published.

**After:** `index.html` --live query (Supabase JS SDK, anon key)--> Postgres `prospects` table, gated by RLS requiring an authenticated session. Session established via Supabase Auth's Azure OAuth provider (Microsoft login).

The anon key is safe to embed in the published HTML (same as mcs-map) — it identifies the project, not a user; RLS is what actually decides who sees data.

## Identity setup (Azure AD + Supabase)

Human-gated, done by Turbine Energy's IT team + project owner:

1. **Azure App Registration**, in Turbine Energy's own Microsoft 365 tenant:
   - Single-tenant ("Accounts in this organizational directory only") — restricts sign-in attempts to Turbine Energy accounts at the Azure level.
   - Redirect URI: `https://gkvropheqktytghmiwgp.supabase.co/auth/v1/callback` (Supabase's fixed OAuth callback — not the site URL).
   - Default `User.Read` (delegated) Graph permission is sufficient; no extra API permissions needed.
2. IT provides back: **Tenant ID**, **Client ID**, **Client secret value**.
3. **Supabase dashboard → Authentication → Providers → Azure**: enter those three values, enable the provider.
4. **Supabase dashboard → Authentication → URL Configuration**: set Site URL / Redirect URLs to wherever `index.html` is actually served from (localhost during dev; the eventual hosting URL once decided).

## Frontend changes (`index.html`)

- Add the Supabase JS SDK (UMD `<script>` tag, matching mcs-map) and initialize a client with the project URL + anon key.
- **Login screen**: full-screen overlay shown pre-auth, hidden post-auth (mcs-map's `#login-screen` pattern), restyled with the Turbine Energy palette already applied to this app. A "Sign in with Microsoft" button calls:
  ```js
  supabase.auth.signInWithOAuth({
    provider: 'azure',
    options: { scopes: 'email profile openid', redirectTo: window.location.href.split('#')[0] }
  });
  ```
- **Domain check** (defense-in-depth on top of the tenant restriction): on `onAuthStateChange`, if `session.user.email` doesn't end with `@turbineenergyuk.co.uk`, immediately sign out, show an error, and re-show the login screen — mirrors mcs-map's `onAuthenticated()` check.
- **Data fetch**: replace `fetch("prospects.json")` with a live, paginated query:
  ```js
  supabase.from('prospects')
    .select('id, address, postcode, lat, lng, property_type, floor_area:total_floor_area, epc_rating:current_energy_rating, local_authority, solar_status, solar_max_panels, solar_yearly_energy_kwh')
    .not('lat', 'is', null)
    .range(from, from + PAGE - 1)  // looped past Supabase's 1000-row default cap
  ```
  The `alias:column` select syntax keeps every existing field name (`d.floor_area`, `d.epc_rating`, etc.) unchanged elsewhere in the frontend — only the fetch call changes.
- **Admin stub**: `const ADMIN_EMAILS = ['greg@turbineenergyuk.co.uk']; function isAdmin(user) { return ADMIN_EMAILS.includes((user?.email || '').toLowerCase()); }` — present, mirroring mcs-map's pattern, but not wired to any UI behavior yet. Future CRM work gates against it.

## Database changes

New migration `supabase/migrations/003_prospects_auth_rls.sql`:

```sql
DROP POLICY "Public read" ON prospects;

CREATE POLICY "Authenticated read"
  ON prospects FOR SELECT
  TO authenticated
  USING (true);
```

Drops `anon` role read access entirely. No per-row domain check at the RLS level — the domain restriction is enforced at sign-in time in the frontend, matching mcs-map's actual implementation (not duplicated in SQL).

## Retired

- `scripts/export-prospects-json.mjs` — deleted. Its job (get data to the frontend) is now done by live queries.
- `prospects.json` — no longer generated or referenced.
- The `GITHUB_PAT` credential prep (done earlier for the export script) is no longer needed — nothing pushes to GitHub programmatically anymore.
- `HANDOVER.md` gets updated to describe the new architecture as part of implementation (not this design doc).

## Testing & verification

Verifiable by automated/manual testing without a live Azure app:
- RLS behavior: anonymous query → expect empty/blocked; authenticated-session query → expect data.
- Pagination logic past 1000 rows.
- Column aliasing correctness.
- Login screen rendering and the domain-check logic, using a mocked/faked session object.

**Not verifiable without a human:** the actual Microsoft OAuth round-trip (real login page, redirect, session establishment, possible MFA) requires a real `@turbineenergyuk.co.uk` account completing the flow in a browser. This is the final manual check once Supabase's Azure provider is configured with IT's values — same category of human-gated step as the GOV.UK EPC login and Google Solar API key earlier in this project.

## Open dependency

Blocked on Turbine Energy IT completing the Azure App Registration and returning the Tenant ID / Client ID / Client secret. Everything else in this design (RLS migration, frontend code, retiring the export script) can be built and verified independently of that; only the final "paste these three values into Supabase" step and the live login test are gated on it.
