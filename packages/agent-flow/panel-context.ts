// The routing context both orchestration paths build from the pinned packet and the saved results (moved out of panel.ts:
// it reads the rules and the computed facts, which load files, and panel.ts is also bundled for the browser).
import { settledByReading, type CasePacket } from './contracts';
import type { IntegrityContext, RoutingContext } from './routing';
import { rulesV4 } from '../case-packet/dataset';
import { deriveFacts } from './facts';
import { roleOf } from './checklists';
import { selectBranch } from '../evidence-collection/branches';

type PhotoReading = { photos: { photoId: string; status: string }[] };
/**
 * The routing context both orchestration paths build from the pinned packet and the saved results (spec revision 6).
 * A pinned record-check result always reaches routing; a configured check with no pinned result reads unavailable.
 * Photos read examined only when every pinned photo has a reading with status `examined`: unclear or unavailable sends the photos to a person.
 */
/** Under the rules rebuild: the case's goodwill questions and what is still held of the disputed charge, for routing's moot-question rule. */
function rulesRouting(packet: Partial<CasePacket>): Pick<RoutingContext, 'concessionQuestions' | 'feeConditions' | 'heldCents' | 'unsupportedDispute' | 'serviceOutOfScope' | 'unknownFeeFacts' | 'fareExcessCents' | 'claimPaidCents'> {
  if (!packet.sources || !rulesV4(packet)) return {};
  const facts = deriveFacts(packet as CasePacket), branch = facts.branch;
  if (!branch) return {};
  const held = facts.facts.find(f => f.id === 'disputed_charge_outstanding_cents')?.value, excess = facts.facts.find(f => f.id === 'fare_excess_cents')?.value, paid = facts.facts.find(f => f.id === 'driver_paid_for_claim_cents')?.value;
  const basis = selectBranch(packet as CasePacket).basis, service = facts.facts.find(f => f.id === 'service_type')?.value;
  const taxi = service === 'RydeTAXI' && ['rider_cancellation', 'driver_no_show', 'driver_cancellation', 'waiting_fee'].includes(branch);
  const grace = branch === 'rider_cancellation' ? facts.facts.find(f => f.id === 'cancelled_after_grace') : undefined;
  return { ...(branch === 'unsupported' ? { unsupportedDispute: basis } : {}), ...(taxi ? { serviceOutOfScope: 'RydeTAXI' } : {}),
    // A fare refund that differs from what the record shows above the quote goes to a person (red team, rounds 1 and 2).
    ...(typeof excess === 'number' ? { fareExcessCents: excess } : {}),
    ...(branch === 'cleaning_claim' && typeof paid === 'number' && paid > 0 ? { claimPaidCents: paid } : {}),
    ...(grace && grace.value === null ? { unknownFeeFacts: [{ fact: grace.id, why: grace.explanation }] } : {}), concessionQuestions: facts.requiredCriteria.filter(c => roleOf(branch, c) === 'concession'), feeConditions: facts.requiredCriteria.filter(c => roleOf(branch, c) === 'fee_condition'), heldCents: typeof held === 'number' ? held : null };
}
export function panelRoutingContext(packet: Pick<CasePacket, 'integrity' | 'photos'> & Partial<CasePacket>, base: RoutingContext, saved: { integrity?: IntegrityContext; photo?: PhotoReading }): RoutingContext {
  const integrity = saved.integrity ?? (packet.integrity ? { status: 'unavailable' as const, version: packet.integrity.version, registerSha256: null, matches: [], error: 'no record-check result was pinned for this run' } : undefined);
  const photoExamination = !packet.photos?.length ? 'none' as const : !saved.photo || packet.photos.some(p => saved.photo!.photos.find(r => r.photoId === p.photoId)?.status !== 'examined') ? 'unavailable' as const : 'examined' as const;
  // Whether a team reading that fits this case answers an open question on the situation's own question (7 October 2026): routing does
  // not release such a question under the S$10 limit.
  // Only on a current packet (contract 4, the rules rebuild's facts); older or partial packets keep the routing they had.
  const current = !!packet.sources && !!packet.posture && Array.isArray(packet.policies) && (packet.contractVersion ?? 0) >= 4 && rulesV4(packet);
  const facts = current ? deriveFacts(packet as CasePacket) : null;
  const readingSettles = facts?.branch ? settledByReading(packet as CasePacket, facts.category, true, true) : undefined;
  return { ...base, ...rulesRouting(packet), ...(integrity ? { integrity } : {}), photoExamination, ...(readingSettles ? { readingSettles } : {}) };
}
