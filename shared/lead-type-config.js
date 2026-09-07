// Single source of truth for prospects.lead_type colours/labels — only
// populated on manually-added leads (source:'manual', migration 017).
// Colours deliberately don't reuse anything from SOLAR_STATUS's
// green/purple/grey/beige/red palette, so a manual lead's marker reads as
// its own visual family, not a mis-scored pipeline prospect.
const LEAD_TYPE = {
  "commercial": { color: "#2563eb", label: "Commercial" },
  "domestic":   { color: "#d6336c", label: "Domestic" },
};
const LEAD_TYPE_ORDER = ["commercial", "domestic"];
