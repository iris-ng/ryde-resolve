import { panelAgreement, seatOf, type PanelSummary } from './panel';
import { assumptionById } from './posture';
import { factGapKinds, policyGapKinds, questionFor, sameEitherWay, type Seat } from './routing';

// The confidence score (1 October 2026). The Judge's own 0-1 number said
// 0.82 to 0.94 on every pilot case, right or wrong, and stays in the record unused. This score is computed by the server
// from fields every decision already has: 5 when nothing open could change the outcome, one point off for each open
// question that could, 0 when there is no recommendation. It counts open questions; it is not a probability, and nothing
// has yet checked it against answer keys. It is shown to reviewers and recorded; routing does not read it, and party
// notices never carry it (notice.ts holds score-like prose for a person).
/** Bump with any change to what counts: recorded scores stop being comparable. */
export const confidenceScoreVersion = '2026-10-07.0-5';
const MAX = 5;
export type OpenQuestion = { condition: string; kind: string; text: string };
export type ConfidenceScore = { version: string; score: number; max: 5; recommendation: boolean; open: OpenQuestion[]; notes: string[];
  /** 'panel': the lowest finished seat, with a split on the outcome counted as one more open question. */
  basis: 'judge' | 'panel'; seat?: Seat; seats?: number; split?: boolean;
  /** Set only on a display copy worked out for a run recorded before the score existed (confidenceFor). Never stored. */
  recomputed?: true };
type Question = { condition: string; kind?: string; otherReading?: { outcome: string; remedyCents: number } };
export type ScoredDecision = { outcome?: string; remedy?: { amountCents: number }; reviewReasons?: Question[]; assumptions?: { id: string; criterion: string }[] };
const kindText: Record<string, string> = { missing_fact: 'missing fact', evidence_gap: 'evidence gap', safety: 'safety', no_rule: 'no rule', page_conflict: 'pages disagree', scope_extension: 'beyond the rule\'s scope' };
// The question in words, not its code name (owner, 11 October 2026): "Which rules apply to this trip? (no rule)".
const label = (q: Question) => `${questionFor(q.condition)} (${kindText[q.kind ?? ''] ?? q.kind ?? 'open'})`;

export function scoreDecision(decision: ScoredDecision): ConfidenceScore {
  const recommendation = !!decision.outcome && decision.outcome !== 'human_review';
  const open: OpenQuestion[] = [], notes: string[] = [], groups = new Map<string, Question[]>();
  for (const q of decision.reviewReasons ?? []) {
    const kind = q.kind ?? '';
    // Routing counts only these kinds; a question with none exists only in older records (the schema requires one).
    if (![...factGapKinds, ...policyGapKinds, 'safety'].includes(kind)) { notes.push(`${q.condition}: open question with no recorded kind (older record); routing does not count it either.`); continue; }
    const key = q.condition + '|' + kind; groups.set(key, [...(groups.get(key) ?? []), q]);
  }
  // The same question on one criterion counts once, and counts if any copy could change the outcome.
  // A policy question, a missing fact or an evidence gap changes nothing only when the Judge stated the same outcome and amount
  // under the other reading (7 October 2026: missing facts too, as routing does). A safety question always could. A rule question
  // released under the S$10 limit still counts here: it could change the outcome, only by little.
  for (const copies of groups.values()) {
    const q = copies[0], harmless = recommendation && ([...policyGapKinds, ...factGapKinds] as readonly string[]).includes(q.kind!) && copies.every(c => sameEitherWay(c, decision));
    if (harmless) notes.push(`${label(q)}: the Arbitrator states the outcome is the same either way.`);
    else open.push({ condition: q.condition, kind: q.kind!, text: label(q) });
  }
  for (const id of [...new Set((decision.assumptions ?? []).map(a => a.id))]) {
    const title = (assumptionById(id) as { title?: string } | undefined)?.title;
    notes.push(`Team reading ${id}${title ? ` (${title})` : ''} settles part of the decision.`);
  }
  return { version: confidenceScoreVersion, score: recommendation ? Math.max(1, MAX - open.length) : 0, max: MAX, recommendation, open, notes, basis: 'judge' };
}

/** Each finished seat gets its own score; a failed seat has none. Seat A's summary carries no artifact (it is the decision), so the anchor is passed in. */
export function scorePanelSeats(panel: PanelSummary | undefined, anchor: ScoredDecision): PanelSummary | undefined {
  if (!panel) return panel;
  return { ...panel, seats: panel.seats.map(s => s.failed ? s : s.role === 'judge' ? { ...s, confidenceScore: scoreDecision(anchor) } : s.artifact ? { ...s, confidenceScore: scoreDecision(s.artifact as ScoredDecision) } : s) };
}

/** The run's headline. One Judge: its own score. A panel: the lowest finished seat, minus one more point when the seats split on the outcome. */
export function scoreRun(anchor: ScoredDecision, panel?: PanelSummary): ConfidenceScore {
  if (!panel) return scoreDecision(anchor);
  const finished = (scorePanelSeats(panel, anchor)?.seats ?? []).filter(s => !s.failed && s.confidenceScore);
  const lowest = finished.reduce((a, b) => b.confidenceScore!.score < a.confidenceScore!.score ? b : a, finished[0]);
  const base = lowest?.confidenceScore ?? scoreDecision(anchor);
  // Agreement among the seats that finished; a seat that failed is shown by routing (panel_incomplete), not here.
  const split = finished.length > 1 && !panelAgreement(finished.map(s => ({ outcome: s.outcome ?? undefined, remedy: s.remedy ?? undefined })));
  const open = split ? [...base.open, { condition: 'outcome', kind: 'panel_split', text: 'The seats disagree on the outcome' }] : base.open;
  const score = !base.recommendation ? 0 : Math.max(1, base.score - (split ? 1 : 0));
  return { ...base, score, open, basis: 'panel', seat: lowest ? seatOf[lowest.role] : 'A', seats: finished.length, split };
}

type Recorded = ScoredDecision & { confidenceScore?: ConfidenceScore; panel?: PanelSummary };
/** For the reviewer views: the stored score, or for a run recorded before the score existed, the same function worked out now and marked. */
export function confidenceFor(decision: Recorded | undefined): ConfidenceScore | undefined {
  if (!decision) return undefined;
  return decision.confidenceScore ?? { ...scoreRun(decision, decision.panel), recomputed: true };
}
/** The panel with each finished seat's score: as stored, or worked out now for an older panel run. */
export function panelWithScores(decision: Recorded | undefined): PanelSummary | undefined {
  const panel = decision?.panel;
  if (!panel || panel.seats.some(s => s.confidenceScore)) return panel;
  return scorePanelSeats(panel, decision);
}

/** Reviewer-facing text. The headline says what was counted, so the compact view never shows a bare number. */
export function confidenceSummary(s: ConfidenceScore) {
  const n = s.open.filter(q => q.kind !== 'panel_split').length, questions = `${n} open question${n === 1 ? '' : 's'} could change the outcome`;
  const what = !s.recommendation ? (s.basis === 'panel' && s.seat && s.seat !== 'A' ? `Arbitrator ${s.seat} made no recommendation` : 'no recommendation')
    : n === 0 ? (s.split ? 'the arbitrators split on the outcome' : 'nothing open could change the outcome')
    : questions + (s.split ? ', and the arbitrators split on the outcome' : '');
  const detail = [s.seats! > 1 && s.seat !== 'A' ? `: Arbitrator ${s.seat}` : '', s.split ? ', minus 1 for the split' : ''].join('');
  const scope = s.basis === 'panel' && s.recommendation ? ` (lowest of the ${s.seats} ${s.seats === 3 ? '' : 'finished '}arbitrators${detail})` : '';
  const headline = `Confidence ${s.score}/${s.max}: ${what}${scope}`;
  // Stored text from panel runs says "seats"; the page says "judges" (plain.ts does the same for every stored line).
  const lines = [...s.open.map(q => q.kind === 'panel_split' ? q.text.replace(/\bseats\b/, 'arbitrators') : `Open, could change the outcome: ${q.text}`), ...s.notes.map(n => `Note: ${n}`)];
  const note = 'Starts at 5, one point off for each open question that could change the outcome; 0 means no recommendation. It counts the open questions the Arbitrator reports: not a probability, and not yet checked against answer keys.';
  return { headline, lines, note: note + (s.recomputed ? ' Worked out now from the recorded decision; not stored with this run.' : '') };
}
