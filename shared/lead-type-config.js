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

// What the job is (prospects.product, migration 068). Every lead has one;
// existing leads were set to solar. With lead_type it makes the four job
// types the CRM offers.
const PRODUCT = {
  "solar": { label: "Solar" },
  "ashp":  { label: "ASHP" },
};
const JOB_TYPES = [
  { product: "solar", lead_type: "domestic" },
  { product: "solar", lead_type: "commercial" },
  { product: "ashp",  lead_type: "domestic" },
  { product: "ashp",  lead_type: "commercial" },
].map(t => ({ ...t, key: `${t.product}-${t.lead_type}`,
  label: `${PRODUCT[t.product].label} - ${LEAD_TYPE[t.lead_type].label}`, color: LEAD_TYPE[t.lead_type].color }));
function leadJobLabel(lead) {
  const type = LEAD_TYPE[lead?.lead_type];
  if (!type) return "";
  return `${(PRODUCT[lead.product] || PRODUCT.solar).label} - ${type.label}`;
}
