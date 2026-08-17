// Builds "why this building" talking points from real data already on the
// row — no invented figures (e.g. no £ savings estimate). Each returned
// string is already HTML-safe; callers should not re-escape it.
// See docs/superpowers/specs/2026-08-17-decision-maker-contact-design.md.
function buildTalkingPoints(d) {
  const points = [];

  if (d.epc_rating) {
    const goodBand = ['A', 'B', 'C'].includes(d.epc_rating);
    const tone = goodBand
      ? 'a relatively efficient building, but solar can still meaningfully offset ongoing energy spend'
      : 'below-average performing buildings like this often have real headroom for savings';
    const effPart = d.current_energy_efficiency
      ? ` (efficiency score ${escapeHtml(String(d.current_energy_efficiency))})`
      : '';
    points.push(`EPC rated ${escapeHtml(d.epc_rating)}${effPart} — ${tone}.`);
  }

  if (d.floor_area) {
    // d._bucket is computed once per prospect in index.html's initMap(), via
    // shared/building-types.js's bucketPropertyType — reuse it rather than
    // recomputing. "Other" is omitted from the sentence since "of other
    // floor area" reads awkwardly; every other bucket name flows naturally.
    const bucket = d._bucket;
    const bucketPart = bucket && bucket !== 'Other' ? `${escapeHtml(bucket.toLowerCase())} ` : '';
    points.push(`${Math.round(d.floor_area).toLocaleString()} m² of ${bucketPart}floor area — a proxy for electricity usage, not a measurement, but a useful opener on energy spend.`);
  }

  // Note: no separate solar-potential bullet here — the popup's dedicated
  // solarEst block (index.html's buildPopup()) already shows panel count and
  // yearly kWh generation prominently when relevant, so repeating it here
  // would just duplicate the same facts.

  points.push('Starting points for a conversation, not guarantees — worth confirming actual usage and roof condition directly.');

  return points;
}
