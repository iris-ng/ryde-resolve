// Pure view model for the checks either side of the agents: the safety screen and the record check before any model
// work, and the release check after the Judge. The agent row, the progress list, the case summary and the case picker all read
// these, so they cannot disagree. Browser-safe: no server imports.
import type { Triage } from './triage';
import { displayReasons, type RoutingReason } from '../agent-flow/routing';
import { panelSplitText, type PanelSummary } from '../agent-flow/panel';
import { decisionLabels } from '../policy/loop-words';

type Ev = { seq: number; actor: string; phase: string; kind: string; data?: any };
/** clear: green. review: amber, a person looks. urgent: red. waiting: a run is on its way here. idle: nothing to show. */
export type GateTone = 'clear' | 'review' | 'urgent' | 'waiting' | 'idle';
export type Flag = Triage['flags'][number];
/** A handoff (review_requested, then each review_updated, which carries the earlier fields forward). */
export type Handoff = { status: string; owner: string | null; note?: string; kind?: string; screening?: Triage };
export type ScreenGate = { tone: GateTone; word: string; note: string; triage: Triage | null; recorded: boolean; flags: Flag[]; handoff: Handoff | null };
export type ReleaseGate = { tone: GateTone; word: string; note: string; reasons: RoutingReason[]; notes: string[]; held: boolean };
/** `integrity` is the pinned event's data as recorded (older events lack some fields), for the operator's dialog. */
export type RecordGate = { tone: GateTone; word: string; note: string; integrity: any };

const activeStatuses = ['queued', 'running', 'pausing', 'paused', 'stopping'];
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const screenWords: Record<Triage['route'], [GateTone, string]> = { ordinary: ['clear', 'Clear'], safety_review: ['review', 'Safety review'], urgent_safety: ['urgent', 'Urgent'] };
const severity: GateTone[] = ['clear', 'review', 'urgent'];
const toneOf = (t?: Triage | null): GateTone => (t?.route && screenWords[t.route]?.[0]) || 'review';
const reviews = (events: Ev[]) => events.filter(e => e.kind === 'review_requested' || e.kind === 'review_updated');
/** The latest handoff of any kind: the one the store's review update acts on (store.ts updateReview). */
export const latestHandoff = (events: Ev[]) => (reviews(events).at(-1)?.data ?? null) as Handoff | null;
/** The latest safety handoff. A merits handoff (store.ts, when the Judge's proposal is routed to a person) is not one. */
export const safetyHandoff = (events: Ev[]) => (reviews(events).filter(e => e.data?.kind !== 'merits_review').at(-1)?.data ?? null) as Handoff | null;
/**
 * Safety documents uploaded after the run started (store.ts addDocument). Each pauses the run and none can join it: the
 * store refuses to resume, a new run must include them. So every one stays open for this run, whatever came after.
 */
const lateScreens = (events: Ev[]) => events.filter(e => e.kind === 'review_requested' && e.data?.kind === 'new_safety_evidence').map(e => (e.data.screening ?? null) as Triage | null);
export const heldForNewEvidence = (events: Ev[]) => lateScreens(events).length > 0;
/** The screen's own hold: the safety handoff opened before any agent task (store.ts startRun, flow.ts). */
const screenHold = (events: Ev[]) => events.some(e => e.kind === 'review_requested' && e.phase === 'triage' && e.data?.kind !== 'new_safety_evidence' && e.data?.kind !== 'merits_review');
/** Cleared for fare review, and whether a resume followed the clearance. */
function clearance(events: Ev[]) {
  let cleared: Ev | undefined;
  for (const e of events) if (e.kind === 'review_updated' && e.data?.kind !== 'merits_review' && e.data?.kind !== 'new_safety_evidence' && e.data?.status === 'cleared_for_fare_review') cleared = e;
  return { cleared: !!cleared, resumed: !!cleared && events.some(e => e.seq > cleared!.seq && e.kind === 'control_requested' && e.data?.command === 'resume') };
}
/**
 * A run held at the screen before any agent task. A person can clear it for fare review; it stays held until someone
 * resumes it, and from the resume on it is waiting for a worker, not stopped.
 */
export const stoppedAtScreen = (events: Ev[]) => screenHold(events) && !events.some(e => e.kind === 'handoff_accepted') && !clearance(events).resumed;
/** One chat message the Evidence Collector read as a possible threat or abuse, as the chat reading's handoff records it (chat-checks.ts chatSafetyHandoff). */
export type ChatHoldReading = { sender: string; tone: string; act: string; quote: string; sourceId: string; startLine: number; endLine: number };
/**
 * The chat reading's hold (MVP fixes, 10 October 2026): the Evidence Collector read a chat message as a possible threat or
 * abuse, so the run waits for a person before the Policy Analyst and the advocates (worker.ts, store.ts holdForChatReading).
 * `handoff` is its latest state; `cleared`, cleared for the fare review; `going`, the run has gone on since (a resume after
 * the clearance, or an agent started after the hold, as on a run the operator cleared in advance). null on every other run.
 */
export type ChatHold = { handoff: Handoff; readings: ChatHoldReading[]; cleared: boolean; going: boolean };
const chatKind = 'chat_reading';
export function chatHold(events: Ev[]): ChatHold | null {
  // The latest hold cycle: a clearance taken back after the run went on opens a new one (store.ts chatHold).
  const asked = events.filter(e => e.kind === 'review_requested' && e.data?.kind === chatKind).at(-1);
  if (!asked) return null;
  const latest = reviews(events).filter(e => e.data?.kind === chatKind).at(-1)!, handoff = latest.data as Handoff;
  const raw: unknown = (handoff as { readings?: unknown }).readings;
  const readings = (Array.isArray(raw) ? raw : []).filter((r): r is ChatHoldReading => !!r && typeof r.quote === 'string' && typeof r.sourceId === 'string' && Number.isInteger(r.startLine) && Number.isInteger(r.endLine))
    .map(r => ({ sender: String(r.sender ?? ''), tone: String(r.tone ?? ''), act: String(r.act ?? ''), quote: r.quote, sourceId: r.sourceId, startLine: r.startLine, endLine: r.endLine }));
  const cleared = handoff.status === 'cleared_for_fare_review';
  const going = events.some(e => e.seq > asked.seq && e.kind === 'handoff_accepted') || (cleared && events.some(e => e.seq > latest.seq && e.kind === 'control_requested' && e.data?.command === 'resume'));
  return { handoff, readings, cleared, going };
}
/** A run the chat reading holds for a person: no decision, and it has not gone on since. */
const chatHeld = (events: Ev[]) => { const hold = chatHold(events); return !!hold && !hold.going && !events.some(e => e.kind === 'decision_proposed'); };
/** A driver's cleaning claim returned at intake (store.ts startRun, owner decision 8 October 2026): the run ended before any agent. */
export function intakeReturned(events: Ev[]): { reasons: { code: string; text: string }[] } | null {
  const e = events.find(x => x.kind === 'intake_returned');
  return e ? { reasons: Array.isArray(e.data?.reasons) ? e.data.reasons : [] } : null;
}

/**
 * The run's recorded screen when a run is open; otherwise the workspace's screen of its current documents, marked as a
 * preview because a new upload can change it. A run that recorded no screen (very old recordings) says so. Safety
 * uploads during the run show on top of the recorded screen, every one with its flagged lines, at the worst severity.
 */
export function screenGate(events: Ev[], hasRun: boolean, preview?: Triage | null): ScreenGate {
  const recorded = events.find(e => e.kind === 'triage_completed')?.data as Triage | undefined;
  const handoff = safetyHandoff(events), late = hasRun ? lateScreens(events) : [];
  const triage = recorded ?? (hasRun ? null : preview ?? null);
  if (late.length) {
    const seen = new Set<string>(), flags = [...(triage?.flags ?? []), ...late.flatMap(t => t?.flags ?? [])].filter(f => { const key = f.sourceId + ':' + f.startLine; return !seen.has(key) && !!seen.add(key); });
    const tone = severity[Math.max(1, ...[triage ? toneOf(triage) : 'review', ...late.map(toneOf)].map(t => severity.indexOf(t)))];
    return { tone, word: 'New safety evidence', note: `${plural(late.length, 'safety document')} arrived after this run started. Start a new run to include ${late.length === 1 ? 'it' : 'them'}`, triage, recorded: !!recorded, flags, handoff };
  }
  if (!triage?.route || !screenWords[triage.route]) return { tone: hasRun ? 'idle' : 'waiting', word: hasRun ? 'Not recorded' : 'Not screened', note: hasRun ? 'This run has no recorded screen' : 'Add documents to screen this case', triage: null, recorded: false, flags: [], handoff };
  const [tone, word] = screenWords[triage.route], flags = triage.flags ?? [];
  // The chat reading's hold is the second safety opinion (MVP fixes, 10 October 2026): it holds the run at this gate too, with its own words.
  const chat = hasRun && recorded ? chatHold(events) : null;
  if (chat) {
    const who = chat.handoff.owner ?? 'a reviewer';
    const state = chat.cleared ? `cleared for the fare review by ${who}` : chat.handoff.status === 'referred_to_specialist' ? 'referred to a specialist' : chat.handoff.status === 'assigned' ? `assigned to ${who}` : 'a person looks first';
    const found = `The chat reading found a possible threat or abuse: ${state}`;
    return triage.route === 'ordinary' ? { tone: 'review', word: 'Safety review', note: found, triage, recorded: true, flags, handoff }
      : { tone, word, note: `${plural(flags.length, 'line')} flagged for a person. ${found}`, triage, recorded: true, flags, handoff };
  }
  const cleared = recorded && handoff?.status === 'cleared_for_fare_review' ? `, cleared for the fare review by ${handoff.owner ?? 'a reviewer'}` : recorded && handoff?.status === 'referred_to_specialist' ? ', referred to a specialist' : '';
  const note = !recorded ? 'Preview of the current documents. A run records its own screen' : flags.length ? `${plural(flags.length, 'line')} flagged for a person${cleared}` : 'No line flagged';
  return { tone, word, note, triage, recorded: !!recorded, flags, handoff };
}

/**
 * The record check (evidence-collection/integrity.ts) as a gate. The web server runs it when a run starts, before any
 * agent, and pins it as an `integrity_checked` event; dataset cases only. A match sends the case to a person at the
 * release check; it never changes the outcome and parties are never told. No event means the run has no record check.
 */
export function recordGate(events: Ev[], hasRun: boolean): RecordGate {
  const integrity = (events.find(e => e.kind === 'integrity_checked')?.data ?? null) as { status?: string; matches?: unknown[] } | null;
  const gate = (tone: GateTone, word: string, note: string): RecordGate => ({ tone, word, note, integrity });
  if (!hasRun) return gate('idle', 'No run yet', 'Compares the case with earlier claims when a run starts');
  if (!integrity) return gate('idle', 'Not used', 'This run has no record check (dataset cases only)');
  if (integrity.status === 'unavailable') return gate('review', 'Could not run', 'A person checks the case first');
  if (integrity.status !== 'checked') return gate('idle', 'Not set up', 'No claims register on this server');
  const found = integrity.matches?.length ?? 0;
  return found ? gate('review', plural(found, 'match', 'matches'), 'A person checks first. Not a finding about anyone') : gate('clear', 'No match', 'Nothing matches an earlier claim');
}

/** What the dispute is about, for the top of the case summary: the Evidence Collector's own one-paragraph summary, as it
 *  shared it at the collect step (user decision, 4 October). It is a model's reading of the case file, shown as such, never
 *  a finding. null until the Evidence Collector has finished, and on runs that stopped before it or never ran it. */
export function caseBrief(events: Ev[]): string | null {
  const shared = events.find(e => e.kind === 'disclosed' && e.data?.evidence_collect)?.data?.evidence_collect;
  const text = typeof shared?.summary === 'string' ? shared.summary.trim() : '';
  return text || null;
}

/** Safety anywhere on the run (a flag at the screen, any safety handoff, a safety routing reason): no merits decision is taken from a person here (policy/loop.ts loopRefusal says the same on the server). */
export const safetyOnRun = (events: Ev[]) => events.some(e => e.kind === 'review_requested' && e.data?.kind !== 'merits_review')
  || ((events.find(e => e.kind === 'triage_completed')?.data as Triage | undefined)?.route ?? 'ordinary') !== 'ordinary'
  || !!events.find(e => e.kind === 'decision_proposed')?.data?.routing?.reasons?.some((r: { code?: string }) => r?.code === 'safety');
/** A person's final decision on a decision sent to them (store.ts recordDecision, the learning loop), or null. */
export type FinalDecision = { decision: 'agree' | 'override'; owner: string; judge: { outcome: string; remedy: { medium: string; amountCents: number } }; final: { outcome: string; remedy: { medium: string; amountCents: number } }; reason: string; disagreedCriteria: string[]; addedRuleIds: string[]; draftId: string | null; draftWithheld?: string | null; decidedAt: string };
export const finalDecision = (events: Ev[]) => (events.find(e => e.kind === 'review_decided')?.data ?? null) as FinalDecision | null;

export function releaseGate(events: Ev[], runStatus: string): ReleaseGate {
  const decision = events.find(e => e.kind === 'decision_proposed')?.data;
  const routing = decision?.routing as { route?: string; reasons?: RoutingReason[]; notes?: string[] } | undefined;
  // The reasons as the page shows them: an older run's code names rebuilt from the Arbitrator's review reasons (routing.ts displayReasons).
  const reasons = decision ? displayReasons(decision) : [], notes = routing?.notes ?? [], gate = (tone: GateTone, word: string, note: string, held = false) => ({ tone, word, note, reasons, notes, held });
  // A Judge already at work may still publish after a safety upload pauses the run; its decision rests on the earlier documents.
  if (heldForNewEvidence(events)) return gate(decision ? 'review' : 'idle', 'On hold', decision ? 'New safety evidence arrived after this decision\'s documents were pinned' : 'New safety evidence: start a new run to include it', true);
  if (decision && routing?.route === 'human_review') return finalDecision(events) ? gate('clear', 'Decided', 'Sent to a person, who made the final decision') : gate('review', 'To a person', plural(reasons.length, 'reason'));
  if (decision && routing?.route === 'release_with_review_option') return gate('clear', 'Released', 'Open for review and appeal');
  if (decision) return gate('idle', 'Not routed', 'Recorded before the release check existed');
  if (runStatus === 'not started') return gate('idle', 'No run yet', 'Checked after the Arbitrator decides');
  if (stoppedAtScreen(events)) return gate('idle', 'Not reached', clearance(events).cleared ? 'Cleared at the safety screen; resume the run to go on' : 'Stopped at the safety screen');
  if (intakeReturned(events)) return gate('idle', 'Not reached', 'The claim went back to the driver before the Arbitrator');
  if (chatHeld(events)) return gate('idle', 'Not reached', chatHold(events)!.cleared ? 'Cleared after the chat reading; resume the run to go on' : 'Held for a person after the chat reading');
  if (activeStatuses.includes(runStatus)) return gate('waiting', 'Waiting', 'Checked after the Arbitrator decides');
  return gate('idle', 'Not reached', `The run ${runStatus.replaceAll('_', ' ')} before the Arbitrator decided`);
}

export const outcomeLabels: Record<string, string> = { refund_recommendation: 'Refund recommended', charge_recommendation: 'Cleaning fee recommended', driver_payment_recommendation: 'Driver payment recommended', no_action: 'No action', human_review: 'No recommendation: human review' };
// SGD, as in the notices and the routing reasons (4 October UI audit: a bare "$" read as US dollars).
export const remedyText = (r?: { medium?: string; amountCents?: number }) => r?.amountCents ? `SGD ${(r.amountCents / 100).toFixed(2)}${r.medium === 'card' ? ' to the card' : r.medium === 'voucher' ? ' as a voucher' : r.medium === 'rider_charge' ? ' charged to the rider' : r.medium === 'driver_payment' ? ' paid to the driver' : ''}` : '';
/** A driver payment's two decisions in one line (owner decision, 6 October 2026); empty for any other outcome. */
export const paymentWords = (d?: { outcome?: string; remedy?: { medium?: string; amountCents?: number }; riderRecovery?: { amountCents?: number } }) => d?.outcome !== 'driver_payment_recommendation' ? ''
  : `Pay the driver SGD ${((d.remedy?.amountCents ?? 0) / 100).toFixed(2)}. Recover SGD ${((d.riderRecovery?.amountCents ?? 0) / 100).toFixed(2)} from the rider. Ryde pays the driver even if recovery fails.`;

export type SummaryLine = { label: string; tone: GateTone; text: string };
/** `stop`: why a run without a decision has a summary: held at the screen, paused for a safety upload during the run, held by the chat reading, or a cleaning claim returned at intake. */
/** `proposal`: after a person decided differently, the Judge's recommendation as labelled history (headline and remedy then follow the person). */
export type CaseSummary = { headline: string; remedy: string; proposal: string | null; decided: boolean; stop: 'screen' | 'new_evidence' | 'chat' | 'intake' | null; cleared: boolean; screen: ScreenGate; release: ReleaseGate; lines: SummaryLine[] };
/**
 * What the case summary shows for a run: null until there is something to summarise (a decision, a stop at the safety
 * screen, or a pause for a safety upload). Lines appear only for checks the run actually has.
 */
export function caseSummary(events: Ev[], runStatus: string, photosPinned = 0): CaseSummary | null {
  const decision = events.find(e => e.kind === 'decision_proposed')?.data;
  // New evidence comes first: a run held at the screen that then gets a safety upload can never resume either.
  const stop = decision ? null : heldForNewEvidence(events) ? 'new_evidence' : stoppedAtScreen(events) ? 'screen' : chatHeld(events) ? 'chat' : intakeReturned(events) ? 'intake' : null;
  const stopped = !!stop;
  if (!decision && !stopped) return null;
  const screen = screenGate(events, true), release = releaseGate(events, runStatus), lines: SummaryLine[] = [];
  lines.push({ label: 'Safety screen', tone: screen.tone, text: `${screen.word}. ${screen.note}.` });
  if (stop === 'intake') lines.push({ label: 'Claim check', tone: 'review', text: `Returned to the driver. ${(intakeReturned(events)?.reasons ?? []).map(r => r.text).join(' ')}`.trim() });
  if (stop === 'chat') { const n = chatHold(events)!.readings.length; lines.push({ label: 'Chat reading', tone: 'review', text: `The Evidence Collector read ${n === 1 ? 'a chat message' : `${n} chat messages`} as a possible threat or abuse. A person looks before the other agents run.` }); }
  const integrity = events.find(e => e.kind === 'integrity_checked')?.data as { status?: string; matches?: unknown[] } | undefined;
  if (integrity?.status === 'checked') lines.push(integrity.matches?.length ? { label: 'Record check', tone: 'review', text: `${plural(integrity.matches.length, 'record match', 'record matches')} for a person to review. Not a finding about anyone.` } : { label: 'Record check', tone: 'clear', text: 'No record match.' });
  else if (integrity?.status === 'unavailable') lines.push({ label: 'Record check', tone: 'review', text: 'Could not run, so a person checks first.' });
  if (photosPinned) {
    const reading = events.find(e => e.kind === 'disclosed' && e.data?.photo_examine)?.data?.photo_examine?.photos as { status: string }[] | undefined;
    const read = reading?.filter(p => p.status === 'examined').length ?? 0;
    lines.push(!reading ? { label: 'Photos', tone: stopped ? 'idle' : 'waiting', text: `${plural(photosPinned, 'photo')} not read.` }
      : { label: 'Photos', tone: read === reading.length ? 'clear' : 'review', text: `${read} of ${plural(reading.length, 'photo')} read clearly by the photo examiner.` });
  }
  const panel = decision?.panel as PanelSummary | undefined;
  if ((panel?.seats?.length ?? 0) > 1 && panel) lines.push({ label: 'Arbitrators', tone: panel.agree ? 'clear' : 'review', text: panelSplitText(panel) + '.' });
  const final = finalDecision(events);
  if (!stopped) lines.push({ label: 'Release check', tone: release.tone, text: release.reasons.length && !release.held && !final ? `${release.word}: ${plural(release.reasons.length, 'reason')}.` : `${release.word}. ${release.note}.` });
  if (final) lines.push({ label: 'Final decision', tone: 'clear', text: final.decision === 'agree' ? `${final.owner} agreed with the Arbitrator.${final.draftId ? ' The agreement settles an open question, so a draft past ruling was made.' : ''}${final.draftWithheld ? ' ' + final.draftWithheld : ''}` : `${final.owner} decided differently: ${decisionLabels[final.final.outcome] ?? final.final.outcome.replaceAll('_', ' ')}${remedyText(final.final.remedy) ? ', ' + remedyText(final.final.remedy) : ''}.${final.draftWithheld ? ' ' + final.draftWithheld : ''}` });
  // After a person's final decision the outcome is theirs; the Judge's recommendation stays as labelled history.
  const current = final?.decision === 'override' ? { outcome: final.final.outcome, remedy: final.final.remedy } : decision;
  const label = (d: { outcome?: string }) => outcomeLabels[d.outcome ?? ''] ?? (d.outcome ? String(d.outcome).replaceAll('_', ' ') : 'Proposal ready');
  const headline = stop === 'screen' ? 'Stopped at the safety screen' : stop === 'new_evidence' ? 'Held for new safety evidence' : stop === 'chat' ? 'Held for a safety review' : stop === 'intake' ? 'Returned to the driver' : label(current);
  const proposal = !stopped && final?.decision === 'override' ? `The Arbitrator recommended: ${label(decision)}${remedyText(decision.remedy) ? ' · ' + remedyText(decision.remedy) : ''}. ${final.owner} decided differently, so it was not used.` : null;
  const cleared = stop === 'screen' ? clearance(events).cleared : stop === 'chat' ? chatHold(events)!.cleared : false;
  return { headline, remedy: stopped ? '' : remedyText(current.remedy), proposal, decided: !!decision, stop, cleared, screen, release, lines };
}

/** One dot per case in the picker, from its latest run's status: done, in progress, or needs attention. */
export type RunDot = { tone: 'done' | 'review' | 'active' | 'attention' | 'stopped' | 'none'; label: string };
export function runDot(status: string | null | undefined): RunDot {
  if (!status) return { tone: 'none', label: 'No run yet' };
  if (status === 'completed') return { tone: 'done', label: 'Run completed' };
  if (status === 'paused') return { tone: 'attention', label: 'Needs attention: run paused' };
  if (status === 'failed') return { tone: 'attention', label: 'Needs attention: run failed' };
  if (activeStatuses.includes(status)) return { tone: 'active', label: 'Run in progress' };
  return { tone: 'stopped', label: 'Run stopped' };
}
