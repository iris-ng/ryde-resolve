// The learning loop (AGENT-DESIGN-TRACE 5.2): reviewer decision, correction reason, curated draft, approval, then the card
// joins the past rulings later runs pin. Pure and deterministic: no model call, no database. The person's reason and
// decision are the card's reasoning and remedy; everything else comes from the run's pinned packet and the Judge's
// recorded decision as structured values, never from parsing free text. The Judge's own output is never re-ingested.
import { outcomeKey } from '../agent-flow/routing';
import { rulesV4 } from '../case-packet/dataset';
import { z } from 'zod';
import { cardRefundRefusal, labelWords, moneyProblems, sampleRefundRefusal, type CasePacket } from '../agent-flow/contracts';
import { deriveFacts } from '../agent-flow/facts';
import { datasetBlock } from '../case-packet/dataset';
import { caseFeatures, currentPolicyRelease, materialKeys } from './retrieval';
import { bindingStatuses, precedents as fileCards, type Precedent } from './precedents';
import { ruleById, rulesetPolicyVersion, rulesetVersion } from './ruleset';
import { agreementDraft, criterionQuestion, outcomeWords, routedOpenQuestions } from './loop-words';
import { factGapKinds, policyGapKinds } from '../agent-flow/routing';
import { libraryProblems } from './library';
import { isScoredCase } from './evaluation';

/** The Judge's recorded decision (the decision_proposed event's data), as far as the loop reads it. */
export type JudgeDecision = { outcome: string; remedy: { medium: string; amountCents: number }; riderRecovery?: { amountCents: number }; policyIds?: string[]; criteria?: { condition: string; status: string }[]; reviewReasons?: { condition: string; kind?: string; otherReading?: { outcome: string; remedyCents: number } }[]; routing?: { route?: string; reasons?: { code: string }[] }; panel?: { seats?: unknown[] } };
/**
 * What the store hands the loop about one run: its pinned packet, the Judge's decision, the screen, the latest handoff and
 * the kind of every handoff the run ever opened (a safety upload during the run opens one before the Judge's merits
 * handoff, so the latest alone can hide it).
 */
export type LoopRun = { runId: string; packet: CasePacket; judge: JudgeDecision | null; screening?: { route?: string } | null; handoff: { kind?: string; status?: string; owner?: string | null } | null; handoffKinds: string[]; decided?: boolean };
export type Remedy = { medium: string; amountCents: number };
/** The final decision as the review_decided event records it. */
export type ReviewDecision = { decision: 'agree' | 'override'; owner: string; judge: { outcome: string; remedy: Remedy; riderRecovery?: { amountCents: number } }; final: { outcome: string; remedy: Remedy; riderRecovery?: { amountCents: number }; cleaningTier?: string }; reason: string; disagreedCriteria: string[]; addedRuleIds: string[] };

export const finalOutcomes = ['refund_recommendation', 'charge_recommendation', 'driver_payment_recommendation', 'no_action'] as const;
export const reviewDecisionSchema = z.object({
  owner: z.string().trim().min(1).max(100), decision: z.enum(['agree', 'override']),
  outcome: z.enum(finalOutcomes).optional(), medium: z.enum(['none', 'card', 'voucher', 'rider_charge', 'driver_payment']).optional(), amountCents: z.number().int().min(0).max(100000).optional(),
  recoveryCents: z.number().int().min(0).max(100000).optional(), cleaningTier: z.enum(['food_drink_crumbs_sand', 'bodily_fluids_or_stains', 'vomit']).optional(),
  reason: z.string().trim().min(10).max(3000), disagreedCriteria: z.array(z.string().max(60)).max(8).default([]), addedRuleIds: z.array(z.string().max(20)).max(12).default([]),
}).strict();

const words = outcomeWords;
/** Words about a person rather than the record, refused in a reviewer's reason on top of the Judge's label words (contracts.ts labelWords). */
const reasonLabelWords = /\b(dishonest|offender|criminal|cheat(?:er|ers|ing)?|thief|thieves|scammer|crook|con\s?artist)\b/i;
// A refused form says which field to fix in plain words, not the validator's report.
const fieldWords: Record<string, string> = { owner: 'your name', reason: 'the reason (at least 10 characters)', note: 'the note', outcome: 'the outcome', medium: 'how it is paid', amountCents: 'the amount', disagreedCriteria: 'the findings', addedRuleIds: 'the rules', decision: 'agree or decide differently', title: 'the title', reasoning: 'the reasoning (at least 10 characters)', issues: 'the questions', distinguishing_facts: 'what would change the answer', rule_ids: 'the rules', keepFeatures: 'the features', keepFacts: 'the facts', action: 'the action', edit: 'the changes', revision: 'the card version (reload the page)' };
function plainParse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  const issue = r.error.issues[0], field = String(issue?.path[0] ?? '');
  const what = issue?.code === 'too_small' ? 'it is missing or too short' : issue?.code === 'too_big' ? 'it is too long' : issue?.code === 'unrecognized_keys' ? 'the form sent a field it does not take' : 'it is not one of the choices';
  throw new Error(`Check ${fieldWords[field] ?? (field ? field.replaceAll('_', ' ') : 'the form')}: ${what}.`);
}
const sameRemedy = (a: { outcome: string; remedy: Remedy; riderRecovery?: { amountCents: number } }, b: { outcome: string; remedy: Remedy; riderRecovery?: { amountCents: number } }) => a.riderRecovery?.amountCents === b.riderRecovery?.amountCents && a.outcome === b.outcome && a.remedy.medium === b.remedy.medium && a.remedy.amountCents === b.remedy.amountCents;
// Scored cases only test the system and never teach it, so our accuracy numbers come from cases the system never learned from (user decision, 4 October 2026).
/**
 * Whether a person's override on a scored case (DISP-002 to DISP-018, evaluation.ts isScoredCase) drafts a card. The
 * person's decision is still recorded either way, and reviewer cards never reach a scored case (evaluation.ts precedentHidden).
 */
export const draftsFromScoredCases = false;
/** Why an override on this case drafts no card, in plain words, or null when it drafts one. */
export function draftWithheld(packet: Pick<CasePacket, 'caseId'>): string | null {
  return !draftsFromScoredCases && isScoredCase(packet.caseId) ? 'No past ruling was drafted, because this is a scored test case: scored cases only test the system and never teach it.' : null;
}
/** Demo and evaluation cases have their own ids; every custom case shares 'CUSTOM', so tagging it would hide the card from all of them. */
const ownCaseId = /^(DISP|ORG)-\d{3}$/;

/**
 * Why the loop refuses this run, in plain words, or null. Safety cases never get a merits decision through this form and
 * never become a past ruling: a safety handoff, a flag at the safety screen, a safety dispute or a decision routed to a
 * person for a safety reason all stop it.
 */
export function loopRefusal(run: Pick<LoopRun, 'packet' | 'judge' | 'screening' | 'handoff' | 'handoffKinds'>): string | null {
  if (run.handoff && run.handoff.kind !== 'merits_review') return 'This is a safety handoff. A safety case never takes a decision on the merits here; assign it, clear it or refer it on the safety screen.';
  // Any safety handoff at any point holds the run (gates.ts safetyHandoff, heldForNewEvidence), whatever came after it.
  if (run.handoffKinds.some(k => k !== 'merits_review')) return 'A safety handoff was opened on this run (for example new safety evidence during the run). A safety case never takes a decision on the merits here and never becomes a past ruling.';
  if (run.screening?.route && run.screening.route !== 'ordinary') return 'The safety screen flagged this case. A safety case never takes a decision on the merits here and never becomes a past ruling.';
  if (deriveFacts(run.packet).category === 'safety') return 'This is a safety dispute. A safety case never takes a decision on the merits here and never becomes a past ruling.';
  if (run.judge?.routing?.reasons?.some(r => r.code === 'safety')) return 'The release check sent this case to a person for a safety reason. A safety case never takes a decision on the merits here.';
  return null;
}


/** Checks a person's final decision against the run; throws a plain message, or returns what the event records. */
export function checkDecision(run: LoopRun, input: unknown): ReviewDecision {
  const d = plainParse(reviewDecisionSchema, input);
  // The reason stays internal (party notices use fixed wording) but becomes a draft's reasoning that agents may read once
  // approved: like the Judge's shared text, it labels no one.
  const label = (d.reason.match(labelWords) ?? d.reason.match(reasonLabelWords))?.[0];
  if (label) throw new Error(`Your reason must not label a person ("${label}"). Describe the record instead, for example "the receipt number matches an earlier claim".`);
  if (run.decided) throw new Error('A final decision is already recorded for this run.');
  if (!run.judge) throw new Error('The Arbitrator has not decided this run yet.');
  if (!run.handoff) throw new Error('This run was not sent to a person, so there is no review to decide.');
  const refusal = loopRefusal(run); if (refusal) throw new Error(refusal);
  if (run.handoff.status !== 'assigned') throw new Error('Assign the review to a person before recording a final decision.');
  if (d.owner !== run.handoff.owner) throw new Error(`The final decision comes from the person the review is assigned to (${run.handoff.owner}). Use that name, or assign the review again.`);
  const judge = { outcome: run.judge.outcome, remedy: { medium: run.judge.remedy.medium, amountCents: run.judge.remedy.amountCents }, ...(run.judge.riderRecovery ? { riderRecovery: { amountCents: run.judge.riderRecovery.amountCents } } : {}) };
  if (d.decision === 'agree') {
    if (judge.outcome === 'human_review') throw new Error('The Arbitrator made no recommendation to agree with. Choose "Decide differently" and give your decision.');
    if (d.outcome !== undefined || d.medium !== undefined || d.amountCents !== undefined || d.recoveryCents !== undefined || d.cleaningTier !== undefined || d.disagreedCriteria.length || d.addedRuleIds.length) throw new Error('Leave the outcome, amount, findings and rules empty when you agree with the Arbitrator.');
    return { decision: 'agree', owner: d.owner, judge, final: judge, reason: d.reason, disagreedCriteria: [], addedRuleIds: [] };
  }
  if (!d.outcome) throw new Error('Choose the outcome you decide.');
  const medium = d.outcome === 'no_action' ? 'none' : d.outcome === 'charge_recommendation' ? 'rider_charge' : d.outcome === 'driver_payment_recommendation' ? 'driver_payment' : d.medium;
  if (!medium) throw new Error('Choose how the refund is paid: to the card or as a voucher.');
  // Paying the driver and recovering from the rider are two decisions (owner decision, 6 October 2026): the recovery is given apart.
  const payment = d.outcome === 'driver_payment_recommendation';
  if (payment && d.recoveryCents === undefined) throw new Error('Give the amount Ryde recovers from the rider: from 0 up to the payment to the driver.');
  if (!payment && (d.recoveryCents !== undefined || d.cleaningTier !== undefined)) throw new Error('A recovery from the rider and a cleaning tier go only with a payment to the driver.');
  const final = { outcome: d.outcome, remedy: { medium, amountCents: d.outcome === 'no_action' ? 0 : d.amountCents ?? 0 }, ...(payment ? { riderRecovery: { amountCents: d.recoveryCents! }, ...(d.cleaningTier ? { cleaningTier: d.cleaningTier } : {}) } : {}) };
  // The same money checks the Judge's decision passes (contracts.ts moneyProblems), said in plain words where they are the Judge's terms.
  const facts = deriveFacts(run.packet), problems = moneyProblems(final, run.packet, facts);
  if (problems[0] === cardRefundRefusal) throw new Error(facts.cashCeiling === null
    ? 'A refund to the card is not possible here: a refund is still pending or the payments do not add up. Choose a voucher, or no action.'
    : `A refund to the card can be at most $${(facts.cashCeiling / 100).toFixed(2)}, what was collected and not refunded. Lower the amount or choose a voucher.`);
  if (problems[0] === sampleRefundRefusal) throw new Error('This sample case has no verified payment to refund. Choose no action.');
  if (problems.length) throw new Error('This decision cannot be recorded: ' + problems[0] + '.');
  if (sameRemedy(final, judge)) throw new Error('This is the Arbitrator\'s recommendation. Choose "Agree with the Arbitrator" instead.');
  const criteria = (run.judge.criteria ?? []).map(c => c.condition);
  for (const c of d.disagreedCriteria) if (!criteria.includes(c)) throw new Error(`Pick findings from the Arbitrator's list: ${c} is not one of them.`);
  const rules = run.packet.policies.map(p => p.rule_id);
  for (const id of d.addedRuleIds) if (!rules.includes(id)) throw new Error(`Pick rules from this case's rules: ${id} is not one of them.`);
  return { decision: 'override', owner: d.owner, judge, final, reason: d.reason, disagreedCriteria: [...new Set(d.disagreedCriteria)], addedRuleIds: [...new Set(d.addedRuleIds)] };
}

/** The rules release the run pinned. Only a packet pinned under the current public ruleset gets the 'policies/ryde/ruleset.json' prefix that lets a card bind (retrieval.ts currentPolicyRelease). */
export function runPolicyRelease(packet: CasePacket) {
  const version = `run policy version ${packet.policyVersion.slice(0, 12)}`;
  // Only a run pinned under the FULL cards (whatever this process's RYDE_RULE_NOTES setting) is a run under the public
  // release; a run made with the note lists off carries a marked version and compares only.
  if (packet.policyBasis === 'reviewed-public' && !packet.policyReference && packet.policySelection && packet.policyVersion === rulesetPolicyVersion(packet.policySelection.selectedIds, false)) return `policies/ryde/ruleset.json ${rulesetVersion}, ${version}`;
  return (packet.policyReference ? `Archived policy reference ${packet.policyReference.releaseId}, ${version}` : `Case rules, ${version}`) + '; not the public ruleset release, so this card is for comparison only';
}

/** The run's deterministic calculations as "id: value" lines, small values only. Never a statement or any other free text. */
export function materialFacts(packet: CasePacket): string[] {
  return deriveFacts(packet).facts.filter(f => f.id !== 'dispute_category').flatMap(f => {
    const v = typeof f.value === 'string' ? f.value : JSON.stringify(f.value);
    return v !== undefined && v.length <= 160 ? [`${f.id}: ${v}`] : [];
  }).slice(0, 24);
}

/**
 * Whether this final decision drafts a past ruling: always for an override; for an agreement only when the case went to a
 * person for an open question on the record that would change the outcome, on a single-judge run (loop-words.ts
 * agreementDraft). Safety runs never decide (loopRefusal); scored cases record but draft nothing (draftWithheld).
 */
const panelSeats = (run: Pick<LoopRun, 'packet'>) => run.packet.panel?.seats?.length ?? 1;
export const draftsOnDecision = (run: Pick<LoopRun, 'judge' | 'packet'>, decision: Pick<ReviewDecision, 'decision'>) => decision.decision === 'override' || agreementDraft(run.judge, panelSeats(run)).drafts;
/** Why an agreement on an open question drafts nothing (a panel, no question that would change the outcome), or null. */
export const agreementWithheld = (run: Pick<LoopRun, 'judge' | 'packet'>, decision: Pick<ReviewDecision, 'decision'>) => decision.decision === 'agree' ? agreementDraft(run.judge, panelSeats(run)).reason : null;
/** The questions that routed the case and would change the outcome, in plain words, and whether any is about the rules. Never every criterion. */
function openQuestionsOf(judge: JudgeDecision | null) {
  const open = routedOpenQuestions(judge);
  const conditions = [...new Set(open.map(r => r.condition))], rules = open.some(r => (policyGapKinds as readonly string[]).includes(r.kind ?? '')), record = open.some(r => (factGapKinds as readonly string[]).includes(r.kind ?? ''));
  const what = conditions.map(c => c.replaceAll('_', ' ')).join(' and ') || 'a question';
  return { conditions, phrase: `where ${rules && record ? 'the rules and the record leave' : rules ? 'the rules leave' : 'the record leaves'} ${what} open` };
}
/**
 * The draft past ruling for an override, or for an agreement that settles an open question. Deterministic: the same run and
 * decision give the same card. Features are the case features retrieval computes (retrieval.ts caseFeatures); rules are the
 * Judge's cited rules plus the ones the person added from the case's list; facts are calculation values; reasoning is the
 * person's and the remedy is the person's decision (for an agreement, the Judge's recommendation they confirmed). An
 * evaluation or demo case tags itself in evaluation_overlap, so the card is never shown for the case it came from.
 */
/**
 * Facts 4: the findings only the Judge (and the person) make, which the deciding questions turn on, recorded on the draft so a later
 * case never binds it on its computed facts alone: a driver no-show's rider absence; a cleaning claim's
 * cause and need for professional cleaning. Only the Judge's settled answer that the person did not dispute is recorded as found;
 * an open answer, or one the person disagreed with, is unclear (red team, round 1): a disagreement says the answer is wrong, not
 * what the record shows, and the outcome alone does not settle a finding. An unclear finding never binds a later case.
 */
function findingFeatures(packet: CasePacket, judge: LoopRun['judge'], decision: ReviewDecision): Record<string, boolean | 'unclear'> {
  if (!rulesV4(packet)) return {};
  const branch = deriveFacts(packet).branch, out: Record<string, boolean | 'unclear'> = {};
  const answer = (id: string) => {
    const status = judge?.criteria?.find(c => c.condition === id)?.status;
    return decision.disagreedCriteria.includes(id) ? 'unclear' : status === 'met' ? true : status === 'not_met' ? false : 'unclear';
  };
  if (branch === 'driver_no_show') out.rider_absent = answer('rider_absent');
  if (branch === 'cleaning_claim') for (const id of ['rider_caused_mess', 'professional_cleaning_needed']) out[id] = answer(id);
  return out;
}
export function draftFromDecision(run: Pick<LoopRun, 'runId' | 'packet' | 'judge' | 'screening' | 'handoff' | 'handoffKinds'>, decision: ReviewDecision, at = new Date().toISOString()): Precedent {
  if (!draftsOnDecision(run, decision)) throw new Error(agreementWithheld(run, decision) ?? 'Agreeing with the Arbitrator drafts a past ruling only when the case went to a person for a question the record or the rules leave open.');
  const refusal = loopRefusal(run) ?? draftWithheld(run.packet); if (refusal) throw new Error(refusal);
  const { packet } = run, { category, features } = caseFeatures(packet), agreed = decision.decision === 'agree';
  const ticket = datasetBlock<any>(packet, 'dispute_ticket'), trip = datasetBlock<any>(packet, 'trip_data');
  const type = typeof ticket?.dispute_type === 'string' ? ticket.dispute_type : category;
  const label = type.replaceAll('_', ' '), open = openQuestionsOf(run.judge);
  // An agreement names only the questions that routed the case (there is at least one, or nothing is drafted).
  const criteria = agreed ? open.conditions : (decision.disagreedCriteria.length ? decision.disagreedCriteria : (run.judge?.criteria ?? []).map(c => c.condition));
  const text = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim().slice(0, 40) : undefined;
  const judgeSaid = decision.judge.outcome === 'human_review' ? 'where the Arbitrator made no recommendation' : `where the Arbitrator recommended ${words(decision.judge.outcome)}`;
  const headline = agreed ? `a person confirmed ${words(decision.final.outcome)} ${open.phrase}` : `a person decided ${words(decision.final.outcome)} ${judgeSaid}`;
  return {
    precedent_id: `PREC-L-${run.runId}`,
    title: `${label[0].toUpperCase() + label.slice(1)}: ${headline}`,
    category, dispute_types: [type],
    provenance: agreed
      ? `Reviewer confirmation on live run ${run.runId} (${at.slice(0, 10)}): a person confirmed the Arbitrator's recommendation of ${words(decision.final.outcome)} ${open.phrase}, recorded by the shared demo operator (identity not verified). Drafted by code with no model call. Synthetic; not a real case; not Ryde-approved.`
      : `Reviewer override on live run ${run.runId} (${at.slice(0, 10)}): ${headline}, recorded by the shared demo operator (identity not verified). Drafted by code with no model call. Synthetic; not a real case; not Ryde-approved.`,
    policy_release: runPolicyRelease(packet),
    rule_ids: [...new Set([...(run.judge?.policyIds ?? []), ...decision.addedRuleIds])],
    ...(text(trip?.service_type) ? { service_type: text(trip.service_type) } : {}), ...(text(trip?.booking_mode) ? { booking_mode: text(trip.booking_mode) } : {}),
    ...(typeof trip?.booking_time === 'string' && /^\d{4}-\d{2}-\d{2}/.test(trip.booking_time) ? { trip_date: trip.booking_time.slice(0, 10) } : {}),
    features: { ...features, ...findingFeatures(packet, run.judge, decision) }, material_facts: materialFacts(packet),
    issues: criteria.map(criterionQuestion),
    reasoning: decision.reason,
    remedy: { outcome: decision.final.outcome, medium: decision.final.remedy.medium, amount_cents: decision.final.remedy.amountCents, ...(decision.final.riderRecovery ? { recovery_cents: decision.final.riderRecovery.amountCents } : {}) },
    authority: agreed ? 'A person\'s final decision confirming the Arbitrator\'s reading of a question the record or the rules leave open. Draft: it carries no weight until a person approves it.'
      : 'A person\'s final decision that overrides the Arbitrator. Draft: it carries no weight until a person approves it.',
    distinguishing_facts: [],
    evaluation_overlap: ownCaseId.test(packet.caseId) ? [packet.caseId] : [],
    review_status: 'draft_pending_review', synthetic: true, origin: agreed ? 'reviewer_confirmation' : 'reviewer_override',
  };
}

/**
 * The checks the card library test runs (tests/retrieval.test.ts), as plain messages: known dispute type, rules that exist
 * in the public ruleset, feature keys retrieval matches on with simple values, case tags that are case ids, and no case id
 * in the card's text. Also refuses an id a file card already has. Empty: the card can be approved.
 */
export function cardProblems(card: Precedent, files: Precedent[] = fileCards): string[] {
  const problems = libraryProblems(card);
  if (files.some(p => p.precedent_id === card.precedent_id)) problems.push(`A past ruling in the team's files already uses the id ${card.precedent_id}.`);
  return problems;
}
/**
 * Cards an agent can see that one case could match together with this card while they disagree on the outcome. A card
 * binds a case only when every fact it records (null leaves a fact open) is equal there and two of them are material
 * (retrieval.ts searchPrecedents), so two cards that agree on every fact both record, each with two material facts and both
 * under the public ruleset, bind the same cases. Approving both breaks nothing: such a case must follow one and distinguish
 * the other, so it goes to a person every time. The review page warns before approval. Each card is compared on its own
 * fields; no card is followed to another.
 */
export function conflictingCards(card: Precedent, library: Precedent[]): string[] {
  const material = materialKeys[card.category] ?? [], recorded = (p: Precedent) => Object.entries(p.features).filter(([, v]) => v !== null);
  const binds = (p: Precedent) => currentPolicyRelease(p) && recorded(p).filter(([k]) => material.includes(k)).length >= 2;
  if (!binds(card)) return [];
  return library.filter(p => p.precedent_id !== card.precedent_id && p.category === card.category && outcomeKey(p.remedy.outcome) !== outcomeKey(card.remedy.outcome) && (bindingStatuses as readonly string[]).includes(p.review_status) && binds(p)
    && recorded(p).every(([k, v]) => card.features[k] === undefined || card.features[k] === null || card.features[k] === v)).map(p => p.precedent_id);
}

// Plain words for a recorded fact, for the past rulings page ("a destination change", "no promo terms in evidence").
const factPhrases: Record<string, Record<string, string>> = {
  driver_at_pickup: { yes: 'the driver at the pickup', no: 'the driver away from the pickup', unclear: 'an unclear arrival' },
  wait_over_three_minutes: { true: 'a wait over three minutes', false: 'a wait of three minutes or less' }, trip_started: { true: 'a trip that started', false: 'a trip that never started' },
  cancelled_by: { rider: 'a cancellation by the rider', driver: 'a cancellation by the driver' }, rider_cancel_within_grace: { true: 'a rider cancellation within the grace period', false: 'a rider cancellation after the grace period' },
  advance_booking: { true: 'an advance booking', false: 'an on-demand booking' }, cancelled_more_than_15_min_before: { true: 'a cancellation more than 15 minutes ahead', false: 'a cancellation 15 minutes or less ahead' },
  driver_contacted_rider: { true: 'the driver contacting the rider', false: 'no contact from the driver' }, rider_contacted_driver: { true: 'the rider contacting the driver', false: 'no contact from the rider' },
  rider_at_other_location: { true: 'the rider waiting somewhere else' }, payment_method: { cash: 'a cash payment' },
  driver_on_time: { true: 'the driver on time', false: 'the driver more than 2 minutes late' }, rider_absent: { true: 'the rider absent', false: 'the rider at the pickup' },
  pickup_point_changed: { true: 'a pickup point both agreed to change', false: 'the booked pickup point kept' }, service_class: { standard: 'a standard ride service', taxi: 'a RydeTAXI trip', send: 'a RydeSEND delivery', pet: 'a RydePET trip', pool: 'a RydePOOL trip', hire: 'a RydeHIRE trip', other: 'another service' },
  rider_caused_mess: { true: 'a mess this rider caused', false: 'a mess this rider did not cause' }, professional_cleaning_needed: { true: 'a mess that needed professional cleaning', false: 'a mess that could be cleaned at once' }, driver_heading_to_pickup: { true: 'the driver heading to the pickup', false: 'the driver not heading to the pickup' },
  fare_basis: { fixed_quote: 'a fixed fare', metered: 'a metered fare' }, route_deviated: { true: 'a detour', false: 'no detour' },
  toll_on_detour_only: { true: 'a toll on the detour only', false: 'no toll on the detour alone' }, toll_on_quoted_route: { true: 'a toll on the quoted route', false: 'no toll on the quoted route' },
  rider_consent: { yes: 'the rider agreeing to the route', no: 'the rider not agreeing to the route', disputed: "the rider's agreement disputed" },
  charged_above_quote: { true: 'a charge above the quote', false: 'no charge above the quote' }, surge_applied: { true: 'surge pricing', false: 'no surge pricing' },
  quote_changed_after_booking: { true: 'a price change after booking' }, promo_failed: { true: 'a failed promo', false: 'a promo that applied' }, promo_eligible: { true: 'a promo the rider qualified for', false: 'a promo the rider did not qualify for' },
  terms_in_evidence: { true: 'promo terms in evidence', false: 'no promo terms in evidence' }, destination_changed: { true: 'a destination change', false: 'no destination change' },
  edit_accepted: { true: 'the rider accepting the change', false: 'the rider declining the change' }, hold_mistaken_for_charge: { true: 'a card hold taken for a charge' }, trip_not_taken: { true: 'a trip never taken' },
};
export const factPhrase = (key: string, value: unknown) => factPhrases[key]?.[String(value)] ?? `${key.replaceAll('_', ' ')}: ${value === true ? 'yes' : value === false ? 'no' : String(value).replaceAll('_', ' ')}`;
/**
 * The page's wording for each ruling conflictingCards returns: `extra` lists the facts that ruling records and this one
 * does not, in plain words. None: the same deciding facts reach a different outcome (a true conflict, withdraw one). Some:
 * the two only overlap on a case that also has those facts; such a case goes to a person (precedents_disagree), which is safe.
 */
export function conflictDetails(card: Precedent, library: Precedent[]): { id: string; extra: string[] }[] {
  return conflictingCards(card, library).map(id => {
    const other = library.find(p => p.precedent_id === id)!;
    const extra = Object.entries(other.features).filter(([k, v]) => v !== null && (card.features[k] === undefined || card.features[k] === null)).map(([k, v]) => factPhrase(k, v));
    return { id, extra };
  });
}
/** What a person may change on a draft: its words and rules; features and facts can only be removed, never added or changed. */
export const cardEditSchema = z.object({
  title: z.string().trim().min(5).max(200).optional(), reasoning: z.string().trim().min(10).max(3000).optional(),
  issues: z.array(z.string().trim().min(1).max(300)).max(8).optional(), distinguishing_facts: z.array(z.string().trim().min(1).max(300)).max(8).optional(),
  rule_ids: z.array(z.string().max(20)).min(1).max(12).optional(), keepFeatures: z.array(z.string().max(60)).max(20).optional(), keepFacts: z.array(z.number().int().min(0).max(40)).max(40).optional(),
}).strict();
export function applyCardEdit(card: Precedent, input: unknown): Precedent {
  const e = plainParse(cardEditSchema, input), next = { ...card };
  if (e.title !== undefined) next.title = e.title;
  if (e.reasoning !== undefined) next.reasoning = e.reasoning;
  if (e.issues) next.issues = e.issues;
  if (e.distinguishing_facts) next.distinguishing_facts = e.distinguishing_facts;
  if (e.rule_ids) { for (const id of e.rule_ids) if (!ruleById(id)) throw new Error(`Rule ${id} is not one of the Ryde rules (P01 to P40).`); next.rule_ids = [...new Set(e.rule_ids)]; }
  if (e.keepFeatures) { for (const k of e.keepFeatures) if (!(k in card.features)) throw new Error(`Fact ${k} is not on this past ruling; facts can be removed, not added.`); next.features = Object.fromEntries(Object.entries(card.features).filter(([k]) => e.keepFeatures!.includes(k))); }
  if (e.keepFacts) { for (const i of e.keepFacts) if (i >= card.material_facts.length) throw new Error('Facts can be removed, not added.'); next.material_facts = card.material_facts.filter((_, i) => e.keepFacts!.includes(i)); }
  return next;
}

/** Card states in the loop's table. A rejected draft stays out; an approved card can only be overturned; nothing is deleted. */
export const loopStatuses = ['draft_pending_review', 'approved', 'rejected', 'overturned'] as const;
export type LoopStatus = typeof loopStatuses[number];
/**
 * Text that looks like it names a person's details: a Singapore phone number, an email address, a car plate, an NRIC or FIN,
 * a six-digit postal code. A learned ruling carries a reviewer's own words, so the check runs on approval and on publishing
 * (owner, 11 October 2026: the privacy check is folded into approval, with this simple pattern check as a safety net). Names
 * cannot be found by pattern; the person approving confirms those by hand.
 */
const personalPatterns: [string, RegExp][] = [
  // Not a ruling's own number (L-81736302) or a record id: no letter or hyphen right before the digits.
  ['a phone number', /(?<![A-Za-z-])(?:\+65[ -]?)?\b[3689]\d{3}[ -]?\d{4}\b/],
  ['an email address', /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/],
  // SBA1234K or sba1234k; SBA 1234 K only in capitals, so "min 30 s" and "the 50 m" stay measurements.
  ['a car plate', /\b[A-Z]{1,3}\d{1,4}[A-Z]\b/i],
  ['a car plate', /\b[A-Z]{2,3} \d{1,4} [A-Z]\b/],
  ['an NRIC or FIN', /\b[STFGM]\d{7}[A-Z]\b/],
  // Only a postal code written as one: a bare six-digit figure is an amount in cents or a count.
  ['a postal code', /\bSingapore \d{6}\b|\bS\(\d{6}\)|\bpostal code \d{6}\b/i],
];
export function personalDetails(text: string): string[] {
  return [...new Set(personalPatterns.filter(([, re]) => re.test(text)).map(([what]) => what))];
}
/** What stops a card from going public: each kind of personal detail its text appears to hold, with the field. */
export function privacyProblems(card: Pick<Precedent, 'title' | 'reasoning' | 'issues' | 'distinguishing_facts' | 'material_facts'>): string[] {
  const fields: [string, string][] = [['title', card.title], ['reasoning', card.reasoning], ['issues', card.issues.join(' ')], ['what would change the answer', card.distinguishing_facts.join(' ')], ['figures from the record', card.material_facts.join(' ')]];
  return fields.flatMap(([name, text]) => personalDetails(text).map(what => `The ${name} looks like it contains ${what}. Remove it: a past ruling on the Library page must name no person's details.`));
}
export const reviewActionSchema = z.object({
  // 'publish': an approved card gets its privacy mark and joins the Library page; approving a draft does both at once.
  action: z.enum(['approve', 'edit', 'reject', 'overturn', 'publish']), owner: z.string().trim().min(1).max(100), note: z.string().trim().max(3000).default(''), edit: cardEditSchema.optional(),
  /** The person ticks that the text names no person, plate, address, phone number or email (needed to approve or publish). */
  privacyConfirmed: z.boolean().optional(),
  // The card's revision as the person saw it (store.ts loopRow): an action on a card that changed since is refused.
  revision: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
/** A review action with its note: rejecting or withdrawing a card says why. */
export function checkReviewAction(input: unknown) {
  const a = plainParse(reviewActionSchema, input);
  if ((a.action === 'reject' || a.action === 'overturn') && a.note.length < 10) throw new Error('Say why in the note (at least 10 characters).');
  if (a.action === 'edit' && !a.edit) throw new Error('Nothing to change.');
  if (a.action !== 'edit' && a.edit) throw new Error('Save your changes first, then approve, reject or withdraw.');
  if ((a.action === 'approve' || a.action === 'publish') && a.privacyConfirmed !== true) throw new Error('Tick that the text names no person, car plate, address, phone number or email. A past ruling goes on the Library page once approved.');
  return a;
}
export function nextLoopStatus(status: LoopStatus, action: 'approve' | 'edit' | 'reject' | 'overturn' | 'publish'): LoopStatus {
  const next = status === 'draft_pending_review' ? ({ approve: 'approved', edit: 'draft_pending_review', reject: 'rejected' } as const)[action as 'approve' | 'edit' | 'reject']
    : status === 'approved' && action === 'overturn' ? 'overturned' : status === 'approved' && action === 'publish' ? 'approved' : undefined;
  if (!next) throw new Error(status === 'approved' ? 'An approved past ruling cannot be edited, rejected or approved again. Withdraw it if it is wrong, or publish it to the Library.' : `This past ruling is ${status === 'rejected' ? 'rejected' : status === 'overturned' ? 'withdrawn' : 'a draft'}, so it cannot be ${({ approve: 'approved', edit: 'edited', reject: 'rejected', overturn: 'withdrawn', publish: 'published to the Library' } as const)[action]}.`);
  return next;
}
