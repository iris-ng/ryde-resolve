// The Evidence column's tabs, one per type of evidence (evidence tabs, user, 10 October 2026): each holds that type's record
// and any analysis of it, so nothing hides under one long Documents scroll. The Ryde rules are not evidence: they open from
// the decision (rules-dialog.tsx). The old Timeline tab, every timestamped line in date order, is gone.

export const evidenceTabs = [
  { key: 'gps', label: 'GPS', title: 'GPS and telemetry' },
  { key: 'chat', label: 'Chat', title: 'Chat and calls' },
  { key: 'fare', label: 'Fare', title: 'Payment and fare' },
  { key: 'history', label: 'History', title: 'Past behaviour' },
  { key: 'external', label: 'External', title: 'External data' },
  { key: 'files', label: 'Files', title: 'Files' },
] as const;
export type EvidenceTab = typeof evidenceTabs[number]['key'];

// The tab a case opens on: the one that best fits its dispute (user, 10 October 2026). The dispute ticket's own type first,
// then the dispute's category; anything else (a case built from uploaded files) opens on its files.
const byType: Record<string, EvidenceTab> = {
  no_show_charge: 'gps', cancellation_fee: 'gps', route_deviation: 'gps', erp_toll: 'gps',
  promo_code: 'fare', surge_pricing: 'fare', fare_overcharge: 'fare', extra_charge: 'fare',
  cleaning_fee: 'files', safety_incident: 'chat',
};
const byCategory: Record<string, EvidenceTab> = { no_show: 'gps', route_deviation: 'gps', cleaning: 'files', safety: 'chat' };
type Packet = { sources?: { id: string; text: string }[]; policySelection?: { category?: string }; policyReference?: { selection?: { category?: string } } } | null | undefined;

export function openingTab(packet: Packet): EvidenceTab {
  let type: unknown;
  try { const ticket = packet?.sources?.find(s => s.id === 'evidence/dispute_ticket.json'); type = ticket ? JSON.parse(ticket.text)?.dispute_type : undefined; } catch { type = undefined; }
  // Older sample cases keep their category on the reviewed public pages they pinned.
  const category = packet?.policySelection?.category ?? packet?.policyReference?.selection?.category;
  return (typeof type === 'string' && Object.hasOwn(byType, type) ? byType[type] : undefined)
    ?? (typeof category === 'string' && Object.hasOwn(byCategory, category) ? byCategory[category] : undefined)
    ?? 'files';
}
