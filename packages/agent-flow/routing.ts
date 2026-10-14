import type { ProtocolFields } from './contracts';
import { assumptionById } from './posture';
import { criterionLabels } from './reader-guides';

// Deterministic routing of a Judge proposal. The Judge always writes a recommendation; this
// step, not the model, decides whether a person must look before it is released. Every rule
// is a fact about the case that can be printed. The model's confidence number is never used:
// nothing has measured whether it predicts a correct answer. Routing is server-owned; a
// `routing` object written by the model is stripped before validation (contracts.ts).
export type Seat = 'A' | 'B' | 'C';
export type RoutingReason = { code: 'safety' | 'no_recommendation' | 'amount_over_threshold' | 'claimed_loss' | 'fact_gap' | 'policy_gap' | 'precedent_departure' | 'many_assumptions' | 'charge_review' | 'integrity_check' | 'photos_unexamined' | 'judges_disagree' | 'panel_incomplete' | 'criteria_conflict' | 'precedent_overflow' | 'precedents_disagree' | 'precedent_on_open_fact' | 'unsupported_dispute' | 'service_scope' | 'partial_refund' | 'refund_beyond_record'; text: string; seats?: Seat[] };
export type Routing = { route: 'release_with_review_option' | 'human_review'; reasons: RoutingReason[]; notes: string[]; thresholdCents: number; checkedAt: string };
/** Pinned at run start as an `integrity_checked` event; never on the packet or in a task (spec revision 6). */
export type IntegrityContext = { status: 'not_configured' | 'checked' | 'unavailable'; version: number; registerSha256: string | null; matches: { check: string; text: string; innocentReading: string }[]; error?: string };
/** `precedentCandidates`: every past ruling that matches every fact of the case (retrieval.ts precedentReview); `bindingPrecedents` is the capped set the Judge must note. */
/** concessionQuestions and heldCents: the rules rebuild's goodwill questions for this case and what is still held of the disputed charge (panel.ts). */
/** unsupportedDispute: under the rules rebuild, why this dispute has no supported branch (panel.ts). */
/** serviceOutOfScope: a cancellation or waiting dispute on a service the cancellation rules do not cover (RydeTAXI, P01 and C02). */
/** unknownFeeFacts: fee facts the record leaves unknown, with why (the exact 15-minute advance boundary, missing times). */
/** fareExcessCents: on a fare dispute, how much the charge still exceeds the quote (fare_excess_cents). claimPaidCents: a cleaning claim's settled payments to the driver. */
/** readingSettles: whether an enabled team reading could settle an open question on this case (contracts.ts settledByReading, panel-context.ts). */
export type RoutingContext = { safetyInvolved: boolean; fareExcessCents?: number | null; claimPaidCents?: number; unsupportedDispute?: string; serviceOutOfScope?: string; unknownFeeFacts?: { fact: string; why: string }[]; concessionQuestions?: string[]; feeConditions?: string[]; heldCents?: number | null; exposure?: Exposure; bindingPrecedents?: string[]; precedentCandidates?: { precedentId: string; outcome: string }[]; precedentOpenFacts?: { precedentId: string; fact: string; value: string }[]; thresholdCents?: number; now?: string; integrity?: IntegrityContext; readingSettles?: (q: { condition: string; kind?: string; conflictIds?: string[] }) => boolean; photoExamination?: 'none' | 'examined' | 'unavailable' };
export type Exposure = { fare_cents: number | null; disputed_charge_cents: number | null; claimed_additional_cents: number | null; additional_loss_cents?: number; unquantified_loss: boolean };
export const factGapKinds = ['missing_fact', 'evidence_gap'] as const;
// Absent or conflicting rules, and readings beyond a rule's scope. The Judge's own stated reading does not decide these; only an approved assumption does.
export const policyGapKinds = ['no_rule', 'page_conflict', 'scope_extension'] as const;
// Owner decision, 7 October 2026 (routing rules page): S$50, for the remedy and for extra loss a party claims. S$20 before.
export const DEFAULT_RELEASE_THRESHOLD_CENTS = 5000;
/** Owner decision, 7 October 2026: one limit for every open question. A rule question the pinned rules leave open, or a fee fact the record cannot settle, releases when no more than this depends on it. */
export const OPEN_QUESTION_LIMIT_CENTS = 1000;
/** An open question the Arbitrator lists (contract 3): the condition it is about, why it is open, and what changes under the other reading. */
export type OpenQuestion = { condition: string; kind?: string; reason?: string; decisionImpact?: string; otherReading?: { outcome: string; remedyCents: number } };
/** The question a condition stands for, in the words the reader guides use. A code name such as arrival_at_pickup told no one why a
 * case went to a person (owner, 11 October 2026, DISP-110); the page and the record now say the question itself. */
export const questionFor = (condition: string) => criterionLabels[condition] ?? `The question of ${condition.replace(/_/g, ' ')}.`;
export const FACT_GAP_LEAD = 'The record does not settle it, and the answer could change.';
/** One plain line for an open question: the question, why it is open (the Arbitrator's own words), and what the other reading would change. */
export const openQuestionText = (q: OpenQuestion, lead: string) => [questionFor(q.condition), lead, q.reason, q.decisionImpact].map(t => (t ?? '').trim()).filter(Boolean).join(' ');
/**
 * The version of the release rules (routeDecision here, routePanel in panel.ts). It is part of the panel's configuration
 * fingerprint, so measured metrics stop describing the rules once they change: bump it with any change to a routing rule.
 */
export const routingVersion = '2026-10-11.1';
/** Ryde's cap for a vomit cleaning claim (P19), as cleaningCaps.vomit in contracts.ts (a test keeps the two equal). */
export const vomitCapCents = 20000;
type Decision = ProtocolFields & { outcome?: string; remedy?: { medium: string; amountCents: number } };
/** The Judge stated the same outcome and amount under the other reading of this question (contract 3). Shared with confidence.ts. */
export const sameEitherWay = (q: { otherReading?: { outcome: string; remedyCents: number } }, decision: { outcome?: string; remedy?: { amountCents: number } }) =>
  !!q.otherReading && q.otherReading.outcome === decision.outcome && q.otherReading.remedyCents === (decision.remedy?.amountCents ?? 0);
const sgd = (cents: number) => `SGD ${(cents / 100).toFixed(2)}`;
// Money towards the rider (a refund) is positive and money from the rider's side (a cleaning payment or charge) negative; no action is
// zero. Any other outcome (a person's decision, or one this code does not know) names no amount to compare.
const towardRider = (outcome: string | undefined, cents: number): number | null =>
  outcome === 'refund_recommendation' ? cents : outcome === 'no_action' ? 0 : outcome === 'driver_payment_recommendation' || outcome === 'charge_recommendation' ? -cents : null;
/** How much money turns on an open question: the gap between the recommendation and the Judge's stated other reading (contract 3). Null when the two cannot be compared. */
export const moneyAtStake = (q: { otherReading?: { outcome: string; remedyCents: number } }, decision: { outcome?: string; remedy?: { amountCents: number } }): number | null => {
  if (!q.otherReading) return null;
  const recommended = towardRider(decision.outcome, decision.remedy?.amountCents ?? 0), other = towardRider(q.otherReading.outcome, q.otherReading.remedyCents);
  return recommended === null || other === null ? null : Math.abs(recommended - other);
};
/** Why an open rule question sends the case to a person (or would): the money that turns on it against the open-question limit. */
export const policyWhy = (q: OpenQuestion, decision: { outcome?: string; remedy?: { amountCents: number } }) => { const s = moneyAtStake(q, decision);
  return s !== null && s > 0 && s <= OPEN_QUESTION_LIMIT_CENTS ? 'a team reading that fits the recorded facts may settle this, but the Arbitrator left it open'
    : s !== null ? `${sgd(s)} depends on it, more than the ${sgd(OPEN_QUESTION_LIMIT_CENTS)} limit for open questions`
    : !q.otherReading ? 'no other reading is stated' : 'under the other reading a person decides, so no amount can be compared'; };
export const policyGapLead = (why: string) => `No pinned rule settles it, and ${why}. A person checks the reading the recommendation rests on.`;
/**
 * The reasons a page shows for a decision. A run recorded before 11 October 2026 stored a code name for each open question
 * ("The record lacks a fact that could change the answer: arrival_at_pickup (missing_fact), ..." and "The pinned rules do not settle:
 * policy_applicability (no_rule): <why>; ..."); the Arbitrator's review reasons in the same decision carry the words, so the page rebuilds
 * exactly those two recorded shapes from them, one line per question, keeping the recorded justification of a rule question. Every
 * other reason stays as recorded (a panel's reasons name their arbitrators and rest on other artifacts; a new reason's
 * prose may quote a code name; an old rule question must not gain today's justification). Nothing in the record changes.
 */
const legacyShapes = {
  fact_gap: /^The record lacks a fact that could change the answer: (.+)\.$/,
  policy_gap: /^The pinned rules do not settle: (.+)\. A person checks the reading the recommendation rests on\.$/,
} as const;
export function displayReasons(decision: { routing?: { reasons?: RoutingReason[] }; reviewReasons?: OpenQuestion[]; outcome?: string; remedy?: { amountCents: number } }): RoutingReason[] {
  const stored = decision.routing?.reasons ?? [], questions = decision.reviewReasons ?? [];
  return stored.flatMap(r => {
    if (r.seats?.length || (r.code !== 'fact_gap' && r.code !== 'policy_gap')) return [r];
    const listed = legacyShapes[r.code].exec(r.text);
    if (!listed) return [r];
    // The recorded list kept the review reasons' order and named only the questions that routed, so each item takes the next
    // unused review reason on its condition and kind that would have routed: for a fact, one not the same either way; for a rule
    // question, one whose justification is the recorded one (two rule gaps on policy_applicability in DISP-114 each keep their words;
    // a same-either-way question before a decisive one is skipped).
    const used = new Set<OpenQuestion>();
    // Only a question that routed is a candidate, by the same rule routeDecision applies: a fact not the same either way; a rule
    // question with no comparable amount, or more than the limit at stake, or the recorded justification that a team reading may
    // settle it (the one case the record alone can tell).
    const pick = (condition: string, kind: string, why: string | undefined) => {
      const routed = (x: OpenQuestion) => { if (r.code === 'fact_gap') return !sameEitherWay(x, decision); const s = moneyAtStake(x, decision); return s === null || s > OPEN_QUESTION_LIMIT_CENTS || (s > 0 && policyWhy(x, decision) === why); };
      const open = questions.filter(x => !used.has(x) && x.condition === condition && x.kind === kind && routed(x));
      return (why && open.find(x => policyWhy(x, decision) === why)) || open[0];
    };
    const rebuilt = listed[1].split(r.code === 'fact_gap' ? ', ' : '; ').map(item => {
      const part = /^([a-z0-9_]+) \(([a-z_]+)\)(?:: (.+))?$/.exec(item), q = part && pick(part[1], part[2], part[3]);
      if (!part || !q || (r.code === 'policy_gap' && !part[3])) return null;
      used.add(q);
      return { ...r, text: openQuestionText(q, r.code === 'fact_gap' ? FACT_GAP_LEAD : policyGapLead(part[3]!)) };
    });
    return rebuilt.every(Boolean) ? (rebuilt as RoutingReason[]) : [r];
  });
}
export function routeDecision(decision: Decision, context: RoutingContext): Routing {
  const thresholdCents = context.thresholdCents ?? DEFAULT_RELEASE_THRESHOLD_CENTS, reasons: RoutingReason[] = [], notes: string[] = [];
  // Every gap the Judge still lists is open: an assumption settles only the gap it covers, which the Judge no longer lists.
  const amount = decision.remedy?.amountCents ?? 0;
  // Rules rebuild (6 October): a goodwill question left open cannot add to a recommendation that already returns all of the disputed
  // charge still held (or leaves the fee where nothing is held), so it stays a printed note and does not by itself send the case to a person.
  // The refund must rest on something other than the open question: a failed fee condition or a goodwill reason already met.
  const answered = decision.criteria ?? [], basis = answered.some(c => ((context.feeConditions ?? []).includes(c.condition) && c.status === 'not_met') || ((context.concessionQuestions ?? []).includes(c.condition) && c.status === 'met'));
  const held = context.heldCents, coversAll = typeof held === 'number' && ((decision.outcome === 'refund_recommendation' && amount > 0 && amount === held && basis) || (decision.outcome === 'no_action' && held === 0));
  const moot = coversAll ? (decision.reviewReasons ?? []).filter(r => (context.concessionQuestions ?? []).includes(r.condition) && ([...factGapKinds, ...policyGapKinds] as string[]).includes(r.kind ?? '')) : [];
  const open = (decision.reviewReasons ?? []).filter(r => !moot.includes(r));
  for (const q of moot) notes.push(`The recommendation already returns all of the disputed charge still held, so the open question “${questionFor(q.condition)}” cannot add to it and did not send the case to a person.`);
  const kinds = (list: readonly string[]) => open.filter(r => list.includes(r.kind ?? ''));
  if (context.safetyInvolved || kinds(['safety']).length) reasons.push({ code: 'safety', text: context.safetyInvolved ? 'A safety allegation is present; a person reviews before any merits proposal is released.' : 'The Arbitrator left a safety question open: ' + kinds(['safety']).map(r => r.condition).join(', ') + '.' });
  if (decision.outcome === 'human_review' || !decision.outcome) reasons.push({ code: 'no_recommendation', text: 'The Arbitrator did not recommend an outcome.' });
  // Rules rebuild (Task 20): a dispute with no supported branch (an unknown type, a missing actor, an upload) always goes to a person.
  if (context.unsupportedDispute) reasons.push({ code: 'unsupported_dispute', text: `This kind of dispute has no supported branch (${context.unsupportedDispute}), so a person decides it and no money is recommended.` });
  // Red team round 1: these reach a person whatever the Judge wrote, so a well-formed answer cannot release them.
  if (context.serviceOutOfScope) reasons.push({ code: 'service_scope', text: `The cancellation and waiting rules do not settle this service (${context.serviceOutOfScope}; P01, page conflict C02), so a person decides.` });
  // The free-period answer unknown (exactly 15 minutes ahead, missing times) went to a person even when goodwill returned the whole fee (red team,
  // round 2). Owner decision, 7 October 2026: a refund of the whole fee still held, when that fee is within the open-question limit, releases.
  const unknownFees = context.unknownFeeFacts ?? [];
  const wholeFee = decision.outcome === 'refund_recommendation' && typeof held === 'number' && held > 0 && amount === held && held <= OPEN_QUESTION_LIMIT_CENTS;
  const excess = context.fareExcessCents;
  if (decision.outcome === 'refund_recommendation' && typeof excess === 'number' && amount > 0 && amount < excess) reasons.push({ code: 'partial_refund', text: `The proposal returns ${sgd(amount)} of an overcharge the record computes at ${sgd(excess)}; a person checks why the rest is kept.` });
  if (decision.outcome === 'refund_recommendation' && typeof excess === 'number' && amount > excess) reasons.push({ code: 'refund_beyond_record', text: `The proposal returns ${sgd(amount)}, more than the ${sgd(excess)} the record shows above the quote (the quote may include the disputed item); a person checks the amount.` });
  if (decision.outcome === 'no_action' && (context.claimPaidCents ?? 0) > 0) reasons.push({ code: 'charge_review', text: `The driver was already paid ${sgd(context.claimPaidCents!)} for this claim; a person confirms nothing more is owed.` });
  if (unknownFees.length && !wholeFee) reasons.push({ code: 'fact_gap', text: 'The record cannot settle whether the fee was earned: ' + unknownFees.map(u => `${u.fact} (${u.why})`).join(' ') });
  if (unknownFees.length && wholeFee) notes.push(`The record cannot settle whether the fee was earned (${unknownFees.map(u => `${u.fact}: ${u.why}`).join('; ')}), but the recommendation returns the whole fee still held, ${sgd(held!)}, within the ${sgd(OPEN_QUESTION_LIMIT_CENTS)} limit for open questions (owner decision, 7 October 2026), so it did not send the case to a person. The reviewer can see the question.`);
  // Owner decision, 11 October 2026: a vomit cleaning payment releases up to Ryde's S$200 vomit cap (P19) instead of the money limit; every other
  // release condition for a cleaning payment (photos read clearly, record check clean, recovery not above the payment) still applies below.
  const vomitWithinCap = decision.outcome === 'driver_payment_recommendation' && decision.cleaningTier === 'vomit' && amount <= vomitCapCents;
  if (amount > thresholdCents && !vomitWithinCap) reasons.push({ code: 'amount_over_threshold', text: `The proposed remedy of ${sgd(amount)} is above the release threshold of ${sgd(thresholdCents)}.` });
  // Money at stake is what the parties claim, not only what the Judge proposes. Additional loss (triage.ts) is compared directly; the remedy is not subtracted.
  const exposure = context.exposure;
  if (exposure) {
    const extra = exposure.additional_loss_cents ?? 0;
    if (extra > thresholdCents) reasons.push({ code: 'claimed_loss', text: `A party claims ${sgd(extra)} of loss beyond the disputed charge, above the release threshold of ${sgd(thresholdCents)}.` });
    if (exposure.unquantified_loss) notes.push('A party claims an unquantified extra loss (for example a missed booking). The proposal must answer it; the claim alone is not a right to compensation.');
  }
  // A missing fact sends the case to a person unless the Judge states the same outcome and amount whichever way it turns out (owner
  // decision, 7 October 2026; contract 3 already requires the other reading). That is the Judge's assessment, printed for the reviewer.
  const factAll = kinds(factGapKinds), gaps = factAll.filter(r => !sameEitherWay(r, decision));
  for (const g of gaps) reasons.push({ code: 'fact_gap', text: openQuestionText(g, FACT_GAP_LEAD) });
  for (const q of factAll.filter(r => sameEitherWay(r, decision))) notes.push(`The Arbitrator states that its recommendation would be the same whichever way the open question “${questionFor(q.condition)}” turns out, so it did not send the case to a person. That is the Arbitrator's assessment, on the record for the reviewer: ${q.decisionImpact ?? ''}`.trim());
  // 1 October (routing 2026-10-01.1): an open policy question routed unless the Judge stated the outcome under the other reading
  // (contract 3, otherReading) and it equals the recommendation in outcome and amount. Owner decision, 7 October 2026: it routes only
  // when more than the open-question limit (S$10) depends on it. A question with no otherReading (older decisions), or an other reading
  // with no amount to compare, routes. A released question stays on the record as a printed note: the Judge's own assessment.
  // 7 October 2026 (A12 review): a question a team reading that fits the recorded facts may settle is not released under the limit either:
  // the Judge left open what the team may already have answered, so a person checks why (a same-either-way question still releases).
  // The fit is read from recorded fields only; a reading's own conditions found in text (A12: no incident explains the route, the driver
  // does not say the rider agreed) are the Judge's, so this errs towards a person (a recorded closure).
  const policyAll = kinds(policyGapKinds), stake = (q: typeof policyAll[number]) => moneyAtStake(q, decision);
  const settleable = (q: typeof policyAll[number]) => !!context.readingSettles?.(q);
  const policy = policyAll.filter(r => { const s = stake(r); return s === null || s > OPEN_QUESTION_LIMIT_CENTS || (s > 0 && settleable(r)); });
  const why = (q: typeof policyAll[number]) => policyWhy(q, decision);
  for (const g of policy) reasons.push({ code: 'policy_gap', text: openQuestionText(g, policyGapLead(why(g))) });
  for (const q of policyAll.filter(r => !policy.includes(r))) notes.push((stake(q) === 0
    ? `The Arbitrator states that its recommendation would be the same under the other reading of “${questionFor(q.condition)}”, so this question alone did not send the case to a person.`
    : `The pinned rules do not settle “${questionFor(q.condition)}”. Under the other reading the money changes by ${sgd(stake(q)!)}, within the ${sgd(OPEN_QUESTION_LIMIT_CENTS)} limit for open questions (owner decision, 7 October 2026), so this question alone did not send the case to a person.`)
    + ` That is the Arbitrator's assessment, on the record for the reviewer: ${q.decisionImpact ?? ''}`.trimEnd());
  // Distinguishing a reviewed precedent that matches on every material fact is never automatic: a person checks the distinction.
  const departures = (decision.precedentNotes ?? []).filter(n => n.relation === 'distinguished' && (context.bindingPrecedents ?? []).includes(n.precedentId));
  if (departures.length) reasons.push({ code: 'precedent_departure', text: 'The Arbitrator distinguishes past ruling ' + departures.map(d => d.precedentId).join(', ') + '; a person checks the fact that sets this case apart.' });
  // More matching precedents than one decision can note, or matching precedents that disagree: a person decides which apply,
  // whatever notes the Judge wrote.
  const candidates = context.precedentCandidates ?? [], bound = context.bindingPrecedents ?? [];
  if (candidates.length > bound.length) reasons.push({ code: 'precedent_overflow', text: `${candidates.length} past rulings match every fact of this case, more than one decision can address (${bound.length}), so a person checks which apply.` });
  // Option B (4 October): a past ruling guides and never settles a fact the record leaves open. AD-10 (owner decision, 10 October
  // 2026, docs/ARCHITECTURE-DECISIONS.md) brings it in line with the release rules of 7 October: a binding ruling that matched on an
  // unclear or disputed fact is an open question, whatever the Judge reports. It sends the case to a person when more than the
  // open-question limit depends on it, and is printed for the reviewer otherwise. What depends on it is the money the recommendation
  // moves (to the rider or from them); when it moves none (the charge stands), the disputed charge still held. Not the whole charge
  // held when the recommendation refunds part of it: DISP-108 holds the S$21.90 fare and refunds the S$2.30 toll.
  const openFacts = context.precedentOpenFacts ?? [];
  if (openFacts.length) {
    const rulings = [...new Set(openFacts.map(f => f.precedentId))].join(', '), facts = [...new Set(openFacts.map(f => `${f.fact.replaceAll('_', ' ')}: ${f.value}`))].join('; ');
    const moved = Math.max(amount, decision.riderRecovery?.amountCents ?? 0), stake = moved > 0 ? moved : typeof held === 'number' ? held : 0;
    if (stake > OPEN_QUESTION_LIMIT_CENTS) reasons.push({ code: 'precedent_on_open_fact', text: `A past ruling (${rulings}) matched on a fact the record leaves open (${facts}), and ${sgd(stake)} depends on it, more than the ${sgd(OPEN_QUESTION_LIMIT_CENTS)} limit for open questions; a person checks that this case matches the ruling.` });
    else notes.push(`A past ruling (${rulings}) fits this case on a fact the record leaves open (${facts}). It guides the recommendation but does not settle that fact. ${sgd(stake)} depends on it, within the ${sgd(OPEN_QUESTION_LIMIT_CENTS)} limit for open questions (owner decision, 10 October 2026), so it did not send the case to a person; the reviewer checks that this case matches the ruling.`);
  }
  if (new Set(candidates.map(c => outcomeKey(c.outcome))).size > 1) reasons.push({ code: 'precedents_disagree', text: 'Past rulings that match every fact of this case reach different outcomes (' + candidates.map(c => `${c.precedentId}: ${c.outcome.replaceAll('_', ' ')}`).join('; ') + '), so a person decides which applies.' });
  // Owner decision, 7 October 2026: no limit on how many team readings one decision rests on (more than two went to a person,
  // many_assumptions; older records keep that reason). Each reading is team-approved and shown to the reviewer.
  // Contract 4 (owner decision, 6 October 2026): pay the driver and recover from the rider are two decisions. Owner decision, 7 October 2026:
  // the owner reads Ryde's "our team will review the photos" (P19, P20) as allowing an automated review, so a payment within the money
  // limit releases when every photo was read clearly and the record check ran and found nothing. Those two are routed by their own reasons
  // when they fail (photos_unexamined, integrity_check); here only what no other reason reports. The older charge outcome still goes to a person.
  const integrity = context.integrity;
  if (decision.outcome === 'driver_payment_recommendation') {
    const recovery = decision.riderRecovery?.amountCents ?? 0;
    const why = [context.photoExamination !== 'examined' && context.photoExamination !== 'unavailable' ? 'no photo was read' : '',
      !integrity || integrity.status === 'not_configured' ? 'the record check did not run' : '',
      recovery > amount ? `it would recover more from the rider than it pays the driver` : ''].filter(Boolean);
    if (why.length) reasons.push({ code: 'charge_review', text: `The proposal would pay the driver ${sgd(amount)} for cleaning and recover ${sgd(recovery)} from the rider, but ${why.join(', and ')}; a person checks the payment before it is sent.` });
    else if ((amount <= thresholdCents || vomitWithinCap) && context.photoExamination === 'examined' && integrity?.status === 'checked' && !integrity.matches.length) notes.push(`A cleaning payment of ${sgd(amount)} to the driver, recovering ${sgd(recovery)} from the rider, is released when it is within ${amount > thresholdCents ? `Ryde's ${sgd(vomitCapCents)} cap for vomit (owner decision, 11 October 2026)` : `the ${sgd(thresholdCents)} money limit`}, every photo was read clearly and the record check found nothing (owner decision, 7 October 2026). Ryde pays the driver even if recovery fails.`);
  }
  if (decision.outcome === 'charge_recommendation') reasons.push({ code: 'charge_review', text: `The proposal charges the rider ${sgd(amount)} for the driver; a person checks every charge before it is sent.` });
  if (integrity?.status === 'unavailable') reasons.push({ code: 'integrity_check', text: 'The record check could not run' + (integrity.error ? ` (${integrity.error})` : '') + ', so a person checks the case first. This is not a finding about anyone.' });
  if (integrity?.status === 'checked' && integrity.matches.length) reasons.push({ code: 'integrity_check', text: integrity.matches.map(m => `${m.text} Possible innocent reading: ${m.innocentReading}`).join(' ') + ' A record match for review, not a finding about any person.' });
  if (context.photoExamination === 'unavailable') reasons.push({ code: 'photos_unexamined', text: 'One or more photos could not be examined or read clearly, so a person reviews them.' });
  return { route: reasons.length ? 'human_review' : 'release_with_review_option', reasons, notes, thresholdCents, checkedAt: context.now ?? new Date().toISOString() };
}
/** A cleaning charge (contract 3) and a driver payment (contract 4) are the same money decision when past rulings are compared. */
export const outcomeKey = (outcome: string) => outcome === 'charge_recommendation' ? 'driver_payment_recommendation' : outcome;
export const routingLabel = (r: Routing | undefined) => !r ? 'Not routed' : r.route === 'human_review' ? 'Sent to a person before release' : 'Released as a recommendation; open for review and appeal';
export const assumptionTitles = (ids: string[]) => ids.map(id => assumptionById(id)?.title ?? id);
