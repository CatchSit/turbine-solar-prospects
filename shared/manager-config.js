// Client-side manager list — UX gating only (nav links, manager-only
// buttons). The real gate is the database's `managers` table + is_manager()
// (migration 043), enforced by RLS; keep the two lists in sync.
const ADMIN_EMAILS = ['greg@turbineenergyuk.co.uk', 'tim@turbineenergyuk.co.uk'];
function isAdmin(user) { return ADMIN_EMAILS.includes((user?.email || '').toLowerCase()); }
