// Single source of truth for grant_areas.status colours/labels, shared
// between index.html (sidebar filter + boundary shading) and
// dashboard.html (manager status toggle).
const GRANT_STATUS = {
  "available": { color: "#2ba45e", soft: "#e6f4ec", label: "Funding available" },
  "limited":   { color: "#c08438", soft: "#f3e3cb", label: "Funding limited" },
  "exhausted": { color: "#b85544", soft: "#f0d3ce", label: "Funding exhausted" },
};
const GRANT_STATUS_ORDER = ["available", "limited", "exhausted"];

// The four South Yorkshire local authorities grant funding is tracked for
// (matches supabase/migrations/016_grant_areas.sql's seed rows and each
// area's `name` property in shared/south-yorkshire-boundaries.geojson).
// Fixed, not data-driven — unlike the pilot's other chip filters, this list
// intentionally doesn't grow/shrink with whatever local authorities happen
// to appear in `prospects`.
const GRANT_AREA_ORDER = ["Barnsley", "Doncaster", "Rotherham", "Sheffield"];
