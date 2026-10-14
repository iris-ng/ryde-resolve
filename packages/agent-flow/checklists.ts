import type { CasePacket } from './contracts';
import { effectiveFactsVersion } from '../case-packet/dataset';

// The situation a dispute is about (a branch) decides which questions the Judge answers. Each question has a role, and
// the decision checks (contracts.ts, contract 4) apply one rule per role. Older packets keep the category checklists.
export type CriterionRole = 'scope' | 'evidence' | 'fee_condition' | 'claim_condition' | 'concession' | 'amount' | 'payment';
export type CriterionSpec = { id: string; role: CriterionRole };
export const branches = ['rider_cancellation', 'driver_no_show', 'driver_cancellation', 'waiting_fee', 'late_pickup',
  'route_detour', 'erp_toll', 'destination_change', 'surge_pricing', 'promo_code', 'extra_charge', 'fare_overcharge', 'trip_not_taken',
  'cleaning_claim', 'cleaning_appeal', 'safety', 'unsupported'] as const;
export type Branch = typeof branches[number];
const head: CriterionSpec[] = [{ id: 'policy_applicability', role: 'scope' }, { id: 'evidence_readiness', role: 'evidence' }];
// The payment question's name depends on the packet: charge_reconciliation with a payment ledger, recorded_charge without.
const PAYMENT = '$payment';
const c = (id: string, role: CriterionRole): CriterionSpec => ({ id, role });
export const checklists: Record<Branch, readonly CriterionSpec[]> = {
  rider_cancellation: [...head, c('cancelled_after_grace', 'fee_condition'), c('late_driver_goodwill', 'concession'), c('driver_not_heading_waiver', 'concession'), c('trip_not_completed', 'scope'), c(PAYMENT, 'payment')],
  driver_no_show: [...head, c('arrival_at_pickup', 'fee_condition'), c('rider_absent', 'fee_condition'), c('wait_threshold', 'fee_condition'), c('trip_not_completed', 'scope'), c(PAYMENT, 'payment')],
  driver_cancellation: [...head, c('cancellation_fee_basis', 'fee_condition'), c('trip_not_completed', 'scope'), c(PAYMENT, 'payment')],
  waiting_fee: [...head, c('arrival_at_pickup', 'fee_condition'), c('wait_before_boarding', 'fee_condition'), c('trip_completed', 'scope'), c(PAYMENT, 'payment')],
  late_pickup: [...head, c('lateness_remedy_basis', 'concession'), c(PAYMENT, 'payment')],
  route_detour: [...head, c('fare_follows_fare_rule', 'fee_condition'), c(PAYMENT, 'payment')],
  erp_toll: [...head, c('toll_payable_by_rider', 'fee_condition'), c(PAYMENT, 'payment')],
  destination_change: [...head, c('edit_fee_supported', 'fee_condition'), c(PAYMENT, 'payment')],
  surge_pricing: [...head, c('fare_matches_accepted_quote', 'fee_condition'), c(PAYMENT, 'payment')],
  promo_code: [...head, c('charge_matches_campaign_terms', 'fee_condition'), c(PAYMENT, 'payment')],
  extra_charge: [...head, c('extra_charge_permitted', 'fee_condition'), c(PAYMENT, 'payment')],
  fare_overcharge: [...head, c('charge_matches_fare', 'fee_condition'), c(PAYMENT, 'payment')],
  trip_not_taken: [...head, c('rider_took_trip', 'fee_condition'), c(PAYMENT, 'payment')],
  cleaning_claim: [...head, c('rider_caused_mess', 'claim_condition'), c('professional_cleaning_needed', 'claim_condition'), c('mess_type_tier', 'claim_condition'), c('claim_procedure', 'claim_condition'), c('amount_within_cap', 'amount')],
  cleaning_appeal: [...head, c('cleaning_fee_due', 'fee_condition'), c('charged_within_cap', 'fee_condition'), c(PAYMENT, 'payment')],
  safety: [...head, c('safety_routing', 'scope'), c('fare_remedy_basis', 'fee_condition')],
  unsupported: [...head],
};
export function criteriaFor(branch: Branch, hasLedger: boolean): string[] {
  return checklists[branch].map(s => s.id === PAYMENT ? (hasLedger ? 'charge_reconciliation' : 'recorded_charge') : s.id);
}
export function roleOf(branch: Branch, criterion: string): CriterionRole | undefined {
  if (criterion === 'charge_reconciliation' || criterion === 'recorded_charge') return checklists[branch].some(s => s.id === PAYMENT) ? 'payment' : undefined;
  return checklists[branch].find(s => s.id === criterion)?.role;
}
/**
 * What each question asks and how to answer it, sent to the Judge with the case (facts 4). Short and plain; the rule IDs are the
 * pinned Ryde rules and the team readings (posture.ts). The decision checks apply one rule per role (contracts.ts roleProblems).
 */
export const questionGuide: Record<string, string> = {
  policy_applicability: 'Do the pinned rules cover this dispute: its service, booking type and situation? Unclear coverage is unresolved (a recorded page conflict is a page_conflict question). No means a person decides. A dispute with no supported branch (dispute_branch unsupported) leaves this unresolved (no_rule) and recommends human review.',
  evidence_readiness: 'Is the record complete enough to decide? A missing record is unresolved with a missing_fact question, never no. No means a person decides. Where payment records are supplied they are the full account of what was charged and given back, vouchers included: if they show no refund or voucher, none was given, and that is not a missing record (owner decision, 7 October 2026).',
  cancelled_after_grace: 'Did the rider cancel more than 3 minutes (180 seconds) after matching? Exactly 180 seconds is inside the free period (P02, P03); use the cancelled_after_grace fact. An advance booking uses its own window (P07).',
  late_driver_goodwill: 'Was the driver more than 2 minutes late when the rider cancelled? Yes when the rider cancelled more than 2 minutes after the pickup time shown at matching and the driver had not arrived by then, even if the driver arrived later (driver_missed_eta_by_2_min). With no ETA record, a cited message giving the pickup time at matching may establish it; otherwise unresolved (missing_fact). Yes only with team reading A9; the refund is then a voucher of the fee still held (S$6.61 unless part was already returned).',
  driver_not_heading_waiver: 'Was the driver not making their way to the pickup? Yes when the GPS facts show the car parked away or moving away (another road to the same place does not count) and nothing in the record explains it, such as a call or message about a roadblock. A driver who arrived was heading there. Thin GPS (gps_supports_movement_finding false) with no recorded arrival leaves it unresolved (missing_fact) unless a cited message (chat or app event) shows where the driver was. Yes only with team reading A10, within 30 days of the trip, and only when the GPS shows the car parked away or moving away; the refund is then a voucher of the fee still held (S$6.61 unless part was already returned).',
  trip_not_completed: 'Was the trip neither started nor completed? A trip that started belongs to another kind of dispute: answer no and a person decides.',
  rider_absent: 'Was the rider absent when the driver cancelled? Yes unless the record shows the rider at the pickup, or at a pickup point both agreed, when the driver cancelled. Agreement is often spoken in person: a statement can show it, and a missing chat line does not show there was none. A rider at the car whom the driver refused (for example over luggage) was not absent.',
  arrival_at_pickup: 'Did the driver reach the pickup, measured against the point both agreed if they agreed another one? Use the distance and accuracy facts; an arrival declared far from the point is not an arrival. If which point applies is unclear, unresolved (missing_fact).',
  wait_threshold: 'Did the driver wait more than 3 minutes at the pickup before cancelling (P04: more than 180 seconds)? Exactly 180 seconds is not more than 3 minutes. On an advance booking the wait counts from the booked time, or from the driver\'s arrival if later; a driver who arrives early does not start the clock (owner decision, 6 October 2026; wait_exceeds_three_minutes_from_wait_start).',
  cancellation_fee_basis: 'Does any rule let the rider be charged for this driver cancellation? A driver cancelling before pickup for the driver\'s own reasons has no charging rule: no.',
  wait_before_boarding: 'Did the driver wait more than 3 minutes at the pickup before the rider got in (P05)? Use wait_seconds_arrival_to_boarding.',
  trip_completed: 'Was the trip completed? The waiting fee applies to a completed trip (P05).',
  lateness_remedy_basis: 'Is there an approved basis for paying anything for a late pickup? Ryde publishes no lateness compensation and no team reading covers it, so ordinarily no.',
  fare_follows_fare_rule: 'Was the rider charged only what the fare rule allows? A fixed fare is charged as quoted whatever the route (P10, P33). A metered fare has no published detour formula: team reading A12 settles it when the app\'s estimate is in the record (the fare above the top of the estimate, fare_excess_cents, is not owed when the app recorded the driver leaving its route, nothing on record explains it, and the driver does not say the rider agreed; where an incident, closure or diversion on record explains the route, the meter fare stands: met, under A12). If the driver says the rider agreed and the rider denies it, whether the rider agreed is a missing fact (missing_fact): A12 does not apply and a person settles it. Otherwise unresolved (no_rule) if the amount turns on it.',
  toll_payable_by_rider: 'Is this toll the rider\'s to pay? Yes for an active gantry on the quoted route or on a route the rider agreed to (spoken agreement counts), on a service whose fare does not include ERP (RydeSEND includes it, P13). A toll on a detour the driver chose and the rider did not agree to is the driver\'s cost under team reading A5.',
  edit_fee_supported: 'Is the destination-change fee supported? Only for an eligible service and an edit the driver accepted (P11, P12).',
  fare_matches_accepted_quote: 'Does the fare match the quote the rider accepted? Demand changes after booking do not change an accepted fixed quote (team reading A7); a proven billing excess may be corrected (A8).',
  charge_matches_campaign_terms: 'Was the rider charged correctly under the campaign terms in evidence? Missing terms are unresolved (missing_fact).',
  extra_charge_permitted: 'Is the extra charge allowed? There is no surcharge for bulky items or wheelchairs (P34).',
  charge_matches_fare: 'Does the charge match the fare? The line items add up, a duplicate collection is not owed, and a released hold is not a charge (P17).',
  rider_took_trip: 'Did the rider take the trip? Trip events and GPS can show it; an allegation alone is unresolved (P29).',
  rider_caused_mess: 'Did this rider cause the mess? The photos and records must tie the mess to this trip.',
  professional_cleaning_needed: 'Did the mess need professional cleaning? Mess that can be cleaned immediately without professional cleaning is not reimbursed (P21), and pet fur is excluded. For a drink or food spill, the surface decides it (owner decision, 7 October 2026): on leather, vinyl or plastic, drops wiped away at once leave no lasting damage and could be cleaned at once, even if a damp spot still shows. Professional cleaning was needed only when a liquid soaked into a fabric seat, or the photos show a stain left after wiping. This does not apply to vomit or bodily fluids. Where the claim and statements do not say what the seat is made of, the photo reading\'s surface (photos_show_seat_surface: fabric or smooth) shows which applies; if neither shows it, the surface is a missing fact.',
  mess_type_tier: 'Which tier fits the mess, on the record: food, drink, crumbs or sand (cap S$40); bodily fluids or stains that cleaning cannot lift (S$120); vomit (S$200)? Milk tea on fabric is a drink. A charge names its tier (cleaningTier).',
  claim_procedure: 'Did the claim follow the procedure: cleaned within 24 hours of the incident, claimed within 48 hours, at least one photo showing the car plate, and a full receipt (P20)? A full receipt carries the details P20 lists (company name, contact and address, cleaning date, car plate, signature and stamp); it need not price each service separately (owner decision, 7 October 2026).',
  amount_within_cap: 'Is the claimed amount within the cap for the tier that fits? A charge may be lower than claimed; it may never exceed the cap or the amount claimed. Anything already paid to the driver for this claim (driver_paid_for_claim_cents) counts toward both, and a pending payment means no new one.',
  cleaning_fee_due: 'Was a cleaning fee due at all, on the conditions a driver\'s claim must meet? The receipt needs the details P20 lists; it need not price each service separately (owner decision, 7 October 2026).',
  charged_within_cap: 'Was the amount charged within the cap for the tier that fits? Any part above the cap goes back to the rider.',
  safety_routing: 'A safety matter goes to a person: leave this unresolved with a safety question.',
  fare_remedy_basis: 'Is there a published basis for a fare remedy alongside the safety referral?',
  charge_reconciliation: 'Do the payment records reconcile, with the disputed charge linked in the ledger? Pending or unknown records stay unresolved. What is left to return is computed (disputed_charge_outstanding_cents), not answered here. The records are the full account of refunds and vouchers: none shown means none given (owner decision, 7 October 2026).',
  recorded_charge: 'Was the charge recorded? Without a payment ledger, settlement is unverified.',
};
// Facts 6 (MVP fixes, 10 October 2026): the promo question names the promo checks only to a packet that computes them; a packet pinned
// to facts 5 or lower (a Judge-only retry of an older run too) gets the old text, byte for byte.
const promoChecksGuide = ' The promo checks (promo_*) compare the booking and the promo history with the terms\' own fields: dates, hours, days, service, minimum fare, use limits and more than one code. They are calculations, not answers: read them, say which ones your answer rests on, and keep any doubt about the record as an open question.';
// Facts 8 (14 October 2026): the rider's app location, named only to a packet that computes its facts; older packets and their Judge-only
// retries keep the old text. The readings are evidence to weigh, with their age and accuracy, not a finding.
export const riderLocationGuide = ' Where the rider\'s app shared its location (rider_location; the facts rider_distance_to_pickup_at_cancellation_m and rider_min_distance_to_pickup_during_wait_m), the readings near the cancellation are evidence of where the rider was: weigh each with its accuracy, its age against the cancellation time, and the statements and messages, and measure against the agreed point where one was agreed. A location not shared, or a record with no rider location, leaves it to statements and messages and is not itself absence.';
/** What a question asks, for this packet's facts version. */
export function questionAsks(id: string, packet: Pick<CasePacket, 'factsVersion' | 'contractVersion'>): string {
  const base = questionGuide[id] ?? '';
  if (id === 'charge_matches_campaign_terms' && effectiveFactsVersion(packet) >= 6) return base + promoChecksGuide;
  if (id === 'rider_absent' && effectiveFactsVersion(packet) >= 8) return base + riderLocationGuide;
  return base;
}
