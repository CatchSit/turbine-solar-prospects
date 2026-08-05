// Single source of truth for prospects.solar_status colours/labels,
// mirrored from mcs-map's shared/status-config.js STATUS pattern.
const SOLAR_STATUS = {
  "prospect":    { color: "#5d8a64", soft: "#dde9da", label: "Prospect — no solar detected" },
  "has_solar":   { color: "#6f5b94", soft: "#e2dcec", label: "Already has solar" },
  "no_coverage": { color: "#b9b9a9", soft: "#f0f0e6", label: "No imagery coverage" },
  "pending":     { color: "#d8d5c5", soft: "#f4f4ee", label: "Not yet checked" },
  "error":       { color: "#b85544", soft: "#f0d3ce", label: "Check failed" },
};
