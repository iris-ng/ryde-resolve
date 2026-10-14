import type { CasePacket } from '../agent-flow/contracts';
import type { Branch } from '../agent-flow/checklists';
import { datasetBlock } from '../case-packet/dataset';
import { recordedSafetyCase } from '../agent-flow/safety';

// Facts version 4 (rules rebuild, 6 October 2026): the situation a dispute is about, picked from structured fields only, never
// from the ticket's wording. The branch decides the Judge's questions (checklists.ts). `undetermined` names the field whose
// absence left the dispute without a branch; such a dispute goes to a person.
export type BranchChoice = { branch: Branch; basis: string; undetermined?: string };
const sameName = new Set<string>(['waiting_fee', 'driver_cancellation', 'late_pickup', 'erp_toll', 'destination_change', 'surge_pricing', 'promo_code', 'extra_charge', 'fare_overcharge', 'trip_not_taken']);
export function selectBranch(packet: Pick<CasePacket, 'sources'> & Partial<Pick<CasePacket, 'policySelection'>>): BranchChoice {
  const ticket = datasetBlock(packet, 'dispute_ticket'), trip = datasetBlock(packet, 'trip_data') ?? {};
  // An upload has no structured ticket, so no branch, whatever its category (a safety upload still reaches a person through routing).
  if (!ticket) return { branch: 'unsupported', basis: 'no dispute ticket: an uploaded case has no structured dispute type', undetermined: 'dispute_type' };
  // Recorded signs only; the wording screen sends a case to a person through routing, without changing its questions.
  if (recordedSafetyCase(packet)) return { branch: 'safety', basis: 'A safety case: the dispute type, a safety report or an issue marked safety-relevant.' };
  const type = String(ticket.dispute_type ?? '');
  if (type === 'cancellation_fee' || type === 'no_show_charge') {
    const reason = typeof trip.cancellation_reason === 'string' ? trip.cancellation_reason : '';
    // Who cancelled comes from cancelled_by alone: a reason code does not establish the actor (an imported or system record can
    // carry one), so a record without it (DISP-002) has no branch and goes to a person.
    const by = trip.cancelled_by;
    const basis = `dispute_type ${type}; ${trip.cancelled_by === undefined ? 'cancelled_by absent' : `cancelled_by ${trip.cancelled_by}`}; cancellation_reason ${reason || 'absent'}`;
    if (by === 'rider') return { branch: 'rider_cancellation', basis };
    if (by === 'driver') return { branch: /no_show/.test(reason) ? 'driver_no_show' : 'driver_cancellation', basis };
    return { branch: 'unsupported', basis, undetermined: 'cancelled_by' };
  }
  if (sameName.has(type)) return { branch: type as Branch, basis: `dispute_type ${type}` };
  if (type === 'route_deviation' || type === 'late_arrival') return { branch: 'route_detour', basis: `dispute_type ${type}` };
  if (type === 'cleaning_fee') {
    const basis = `dispute_type cleaning_fee; filed_by ${ticket.filed_by ?? 'absent'}`;
    if (ticket.filed_by === 'driver') return { branch: 'cleaning_claim', basis };
    if (ticket.filed_by === 'rider') return { branch: 'cleaning_appeal', basis };
    return { branch: 'unsupported', basis, undetermined: 'filed_by' };
  }
  // property_damage, fare_evasion and any other type: no published remedy the Judge can recommend.
  return { branch: 'unsupported', basis: `dispute_type ${type || 'absent'} has no supported branch` };
}
