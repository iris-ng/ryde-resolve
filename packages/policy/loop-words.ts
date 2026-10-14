// Plain words for the learning loop, shared by the draft builder (loop.ts) and the pages that show it. Browser-safe: no
// server imports.
import { factGapKinds, policyGapKinds, sameEitherWay } from '../agent-flow/routing';

/** Each decision criterion as the question a person answers. Unknown ones read as their own words. */
const questions: Record<string, string> = {
  policy_applicability: 'Which rules apply to this trip?', evidence_readiness: 'Is the record complete enough to decide?', arrival_at_pickup: 'Was the driver at the pickup?',
  wait_threshold: 'Did the driver wait long enough?', trip_not_completed: 'Did the trip stay unstarted?', charge_reconciliation: 'Do the payment records agree?', recorded_charge: 'Is the recorded charge supported?',
  // The branch questions (rules rebuild, October 2026; plan Task 22).
  cancelled_after_grace: 'Did the rider cancel after the free cancellation period?', late_driver_goodwill: 'Was the driver more than 2 minutes late when the rider cancelled?', driver_not_heading_waiver: 'Was the driver not making their way to the pickup?', rider_absent: 'Was the rider absent when the driver cancelled?', wait_before_boarding: 'Did the driver wait more than 3 minutes before the rider got in?', trip_completed: 'Was the trip completed?', cancellation_fee_basis: 'Does any rule let the rider be charged for this cancellation?', lateness_remedy_basis: 'Is there an approved basis for paying anything for the late pickup?', fare_follows_fare_rule: 'Was the rider charged only what the fare rule allows?', toll_payable_by_rider: 'Is this toll the rider\'s to pay?', edit_fee_supported: 'Is the destination-change fee supported?', fare_matches_accepted_quote: 'Does the fare match the quote the rider accepted?', charge_matches_campaign_terms: 'Was the rider charged correctly under the campaign terms?', extra_charge_permitted: 'Is the extra charge allowed?', charge_matches_fare: 'Does the charge match the fare?', rider_took_trip: 'Did the rider take the trip?', rider_caused_mess: 'Did this rider cause the mess?', professional_cleaning_needed: 'Did the mess need professional cleaning?', cleaning_fee_due: 'Was a cleaning fee due at all?', charged_within_cap: 'Was the amount charged within the cap?', safety_routing: 'Does a person need to review this for safety?', fare_remedy_basis: 'Is there a published basis for a fare remedy alongside the safety review?',
  route_entitlement: 'Does the route evidence justify the charge?', mess_type_tier: 'Which mess tier applies?', claim_procedure: 'Was the claim made on time and in order?', amount_within_cap: 'Is the amount within the cap?',
};
export const criterionQuestion = (condition: string) => questions[condition] ?? condition.replaceAll('_', ' ') + '?';
/** An outcome inside a sentence: "a person decided no action where the Judge recommended a refund". */
const outcomes: Record<string, string> = { refund_recommendation: 'a refund', charge_recommendation: 'a cleaning fee charged to the rider', driver_payment_recommendation: 'a cleaning payment to the driver, recovered from the rider separately', no_action: 'no action', human_review: 'no recommendation' };
export const outcomeWords = (outcome: string) => outcomes[outcome] ?? outcome.replaceAll('_', ' ');
/** A person's final outcome, as a choice and in a sentence: "Dana decided differently: refund, $6.61 to the card." */
export const decisionLabels: Record<string, string> = { refund_recommendation: 'refund', charge_recommendation: 'cleaning fee', driver_payment_recommendation: 'pay the driver', no_action: 'no action' };
/**
 * Routing reasons for a question the record or the rules leave open (routing.ts): fact_gap, a missing fact that could change
 * the answer; policy_gap, a rule question whose other reading would change it. A person who agrees with the Judge's
 * reading of such a question settles it, so the agreement drafts a past ruling and the system can stop asking. Every
 * other reason is a routine check (a charge, an amount over the threshold, the record check, photos, the panel) or a
 * question about past rulings themselves (departure, overflow, disagreement), and agreeing with those teaches nothing new.
 */
export const openQuestionCodes = ['fact_gap', 'policy_gap'] as const;
export const settlesOpenQuestion = (reasons: { code?: unknown }[] | undefined) => (reasons ?? []).some(r => (openQuestionCodes as readonly unknown[]).includes(r?.code));
/** What the loop reads of the Judge's recorded decision to judge an agreement. */
export type AgreedDecision = { outcome?: string; remedy?: { amountCents: number }; reviewReasons?: { condition: string; kind?: string; otherReading?: { outcome: string; remedyCents: number } }[]; routing?: { reasons?: { code?: unknown }[] }; panel?: { seats?: unknown[] } } | null | undefined;
/**
 * The open questions an agreement can teach: a missing-fact or rule question whose explicit other reading gives another
 * outcome or amount than the recommendation. A question with no other reading (including older no_rule questions) or the
 * same one is not drafted and not named on a card: nothing on the record shows the person's agreement decided anything.
 */
export function routedOpenQuestions(judge: AgreedDecision) {
  return (judge?.reviewReasons ?? []).filter(r => [...factGapKinds, ...policyGapKinds].includes(r.kind as never)
    && !!r.otherReading && !sameEitherWay(r, { outcome: judge?.outcome, remedy: judge?.remedy }));
}
/**
 * Whether a person's agreement drafts a past ruling, and when it does not although the case went to a person for an open
 * question, why, in plain words. A routine routing (no open question) drafts nothing and needs no explanation. On a panel
 * (more than one judge) an agreement never drafts: no one reading is confirmed. Otherwise the agreement drafts only for a
 * question whose explicit other reading gives another outcome or amount (routedOpenQuestions); a recorded fact_gap or
 * policy_gap code alone, from an older routing version, is not enough.
 */
export function agreementDraft(judge: AgreedDecision, panelSeats = 1): { drafts: boolean; reason: string | null } {
  if (!settlesOpenQuestion(judge?.routing?.reasons as { code?: unknown }[] | undefined)) return { drafts: false, reason: null };
  if (Math.max(panelSeats, judge?.panel?.seats?.length ?? 1) > 1) return { drafts: false, reason: 'No past ruling was drafted: more than one judge decided this case, so one agreement does not confirm a single reading.' };
  if (!routedOpenQuestions(judge).length) return { drafts: false, reason: 'No past ruling was drafted: no open question on the record states another outcome or amount under its other reading.' };
  return { drafts: true, reason: null };
}
/** Said on the decision form before a person agrees, when agreeing will draft a past ruling. */
export const agreeDraftNotice = 'Your agreement settles a question the rules leave open, so a draft past ruling is made from this case. It reaches no agent until approved.';
/** Said wherever past rulings are shown to a person: under "Past rulings considered" and in the /precedents page lead. */
export const pastRulingsNotPolicy = "Past rulings are example decisions our team approved under Ryde's rules. They are not Ryde policy and add no rule.";
/** A card's state in the loop's table. */
export const loopStatusWords: Record<string, string> = { draft_pending_review: 'Waiting for a person', approved: 'Approved', rejected: 'Rejected', overturned: 'Withdrawn' };
