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
      : 'below-average performing buildings this size often have real headroom for savings';
    const effPart = d.current_energy_efficiency
      ? ` (efficiency score ${escapeHtml(String(d.current_energy_efficiency))})`
      : '';
    points.push(`EPC rated ${escapeHtml(d.epc_rating)}${effPart} — ${tone}.`);
  }

  if (d.floor_area) {
    const bucket = bucketPropertyType(d.property_type);
    points.push(`${Math.round(d.floor_area).toLocaleString()} m² of ${escapeHtml(bucket.toLowerCase())} floor area — a proxy for electricity usage, not a measurement, but a useful opener on energy spend.`);
  }

  if (d.solar_status === 'prospect' && (d.solar_max_panels || d.solar_yearly_energy_kwh)) {
    const parts = [];
    if (d.solar_max_panels) parts.push(`up to ${escapeHtml(String(d.solar_max_panels))} panels`);
    if (d.solar_yearly_energy_kwh) parts.push(`~${Math.round(d.solar_yearly_energy_kwh).toLocaleString()} kWh/year generation potential`);
    points.push(`Google's aerial analysis estimates ${parts.join(' and ')} on this roof, with no existing solar detected.`);
  }

  points.push('Starting points for a conversation, not guarantees — worth confirming actual usage and roof condition directly.');

  return points;
}
