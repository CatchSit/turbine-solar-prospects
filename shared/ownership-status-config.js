// prospects.ownership_status (migration 024) — computed offline by
// scripts/match-ownership.mjs against HM Land Registry's CCOD dataset.
// 'unknown' is the majority bucket (most commercial postcodes cover a
// multi-tenant building CCOD can't disambiguate) — it means "couldn't
// confirm", never treat it as "confirmed leased".
const OWNERSHIP_STATUS = {
  freehold_confirmed:  { color: "#2ba45e", label: "Freehold confirmed" },
  leasehold_confirmed: { color: "#b85544", label: "Leasehold confirmed" },
  unknown:             { color: "#9a9a9a", label: "Ownership unknown" },
};
const OWNERSHIP_STATUS_ORDER = ["freehold_confirmed", "leasehold_confirmed", "unknown"];
