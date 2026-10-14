// Facts 4 (rules rebuild): which promo campaign a fare dispute concerns and whether its terms are in the record, from structured fields
// only. The code is the fare's recorded promo, else the code on a promo app event. Terms count from a campaign-terms document for that
// code (kind campaign_terms with campaign_id, or the dataset's terms ID DOC-TERMS-<code>); a status of unavailable, missing or
// withdrawn means not in evidence (false); no such document leaves it unknown (null). A document's wording is never read.
export function campaignCode(fare: any, events: any[]): string | null {
  const recorded = fare?.promo?.code;
  if (typeof recorded === 'string' && recorded) return recorded;
  const event = events.find(e => typeof e?.event_type === 'string' && e.event_type.startsWith('promo_') && typeof e?.data?.code === 'string' && e.data.code);
  return event ? event.data.code : null;
}
export function campaignTermsStatus(docs: any[], code: string | null): boolean | null {
  if (!code) return null;
  const terms = docs.filter(d => (d?.kind === 'campaign_terms' && (d.campaign_id ?? d.code) === code) || d?.document_id === `DOC-TERMS-${code}`);
  return terms.length ? terms.some(d => !['unavailable', 'missing', 'withdrawn'].includes(String(d.status ?? ''))) : null;
}
