import type { CasePacket } from '../agent-flow/contracts';
import { datasetBlock, rulesV4 } from '../case-packet/dataset';
import { selectBranch } from './branches';
import { datasetFacts } from './observations';

// The cleaning-claim intake check (owner decision, 8 October 2026). Before any agent runs, a driver's cleaning claim that
// fails a requirement code can count goes back to the driver, saying what is wrong: filed more than 48 hours after the trip
// (Ryde's page, rule P20), no photo, or no cleaning receipt. It is not a ruling on the mess: whether the photos convince,
// whether the receipt has every detail and whether this rider caused it stay with the Arbitrator. Only a definite failure
// counts: a time without its zone, a missing photo or document register, or a document whose
// kind could be a receipt returns nothing, and the agents look. A rider's appeal against a cleaning fee is never returned,
// since the driver's missing evidence is not the rider's to supply.
export type IntakeReason = { code: 'claim_late' | 'no_photo' | 'no_receipt'; text: string };
/** A time that names its zone (Z or +08:00): an unzoned one reads differently on servers in different zones. */
const zoned = (t: unknown) => typeof t === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(t);
/** A cleaning receipt or invoice under any kind that says so (not the trip's fare receipt, integrity.ts reads invoices too). */
const receiptLike = (kind: unknown) => typeof kind === 'string' && (kind === 'invoice' || (/receipt/.test(kind) && kind !== 'trip_receipt'));
/** Document kinds that are certainly not a cleaning receipt; any other kind (for example "other") might be one. */
const notReceipts = new Set(['trip_receipt', 'screenshot']);

/** Why a driver's cleaning claim goes back before review; empty when it goes on. `uploads`: documents added before the run. */
export function cleaningIntake(packet: CasePacket, uploads = 0): IntakeReason[] {
  if (!rulesV4(packet) || selectBranch(packet).branch !== 'cleaning_claim') return [];
  const reasons: IntakeReason[] = [], facts = datasetFacts(packet).facts, fact = (id: string) => facts.find(f => f.id === id)?.value;
  // The same exact 48-hour comparison the Arbitrator is given (observations.ts): 48 hours 10 seconds is late. Both times must
  // name their zone.
  const hours = fact('hours_trip_end_to_claim'), trip = datasetBlock<{ trip_end_time?: unknown }>(packet, 'trip_data');
  const claim = (datasetBlock<{ event_type?: string; timestamp?: unknown }[]>(packet, 'app_events') ?? []).find(e => e?.event_type === 'cleaning_claim_submitted');
  if (fact('claim_within_48h') === false && zoned(trip?.trip_end_time) && zoned(claim?.timestamp)) reasons.push({ code: 'claim_late', text: `The claim came ${typeof hours === 'number' && hours >= 48.1 ? `${hours.toFixed(1)} hours` : 'just over 48 hours'} after the trip ended. Ryde's page asks for it within 48 hours.` });
  // A document added before the run may hold the photos or the receipt, and code cannot read it, so these two are checked
  // only when nothing was added. Each needs its register present and plainly without one: an empty photo list and no pinned
  // photo; documents that are all of a kind that is not a receipt.
  if (!uploads) {
    const photos = datasetBlock<unknown[]>(packet, 'photos'), docs = datasetBlock<{ kind?: unknown }[]>(packet, 'documents');
    if (Array.isArray(photos) && !photos.length && !packet.photos?.length) reasons.push({ code: 'no_photo', text: 'The claim has no photo.' });
    if (Array.isArray(docs) && !docs.some(d => receiptLike(d?.kind)) && docs.every(d => notReceipts.has(String(d?.kind)))) reasons.push({ code: 'no_receipt', text: 'The claim has no cleaning receipt.' });
  }
  return reasons;
}

/** The notice for a returned claim, as the run's event and the case page say it. */
export const intakeNotice = (reasons: Pick<IntakeReason, 'text'>[]) =>
  `This claim went back to the driver before review. ${reasons.map(r => r.text).join(' ')} No agent ran and no money moves.`;
