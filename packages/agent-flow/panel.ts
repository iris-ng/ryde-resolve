// The Judge panel: three separately run, sealed Judge sessions on the same record (spec 2026-09-30, revisions 1, 2, 15).
// Seat A (`judge`) is the anchor whose explanation parties receive; seats B and C differ only in model and evidence order (no lean: user decision, 1 October).
// One contract for both orchestration paths (runFlow and the live store): routing runs on every seat that finished and
// the reasons are united, each marked with its seat. Release needs every seat to finish, agree and list no reason.
import type { Artifact, CasePacket, PanelConfig, Role } from './contracts';
import type { IntegrityContext } from './routing';
import { routeDecision, routingVersion, type Routing, type RoutingContext, type RoutingReason, type Seat } from './routing';
import { decideRoles } from '../live-fishbowl/roles';
import type { ConfidenceScore } from './confidence';

export const defaultPanel: PanelConfig = { version: 1, seats: ['judge', 'judge_b', 'judge_c'] };
export const seatOf: Record<string, Seat> = { judge: 'A', judge_b: 'B', judge_c: 'C' };
/** Evidence order per seat (spec Part 2, revision 20): seat B reads the driver side first, seats A and C the rider side first. */
export const seatMeta: Record<'judge' | 'judge_b' | 'judge_c', { seat: Seat; order: 'rider_first' | 'driver_first' }> = {
  judge: { seat: 'A', order: 'rider_first' },
  judge_b: { seat: 'B', order: 'driver_first' },
  judge_c: { seat: 'C', order: 'rider_first' },
};
/** Version 1 panels are exactly seats A, B and C in that order. An absent panel is the single Judge of older runs. */
export const validPanel = (panel: unknown): panel is PanelConfig => !!panel && typeof panel === 'object' && (panel as PanelConfig).version === 1
  && JSON.stringify((panel as PanelConfig).seats) === JSON.stringify(defaultPanel.seats);
export function assertPanel(packet: Pick<CasePacket, 'panel'>) { if (packet.panel !== undefined && !validPanel(packet.panel)) throw new Error('A run panel must be exactly seats judge, judge_b and judge_c (version 1)'); }
export const panelSeats = (packet: Pick<CasePacket, 'panel'>) => decideRoles(packet);
type CompletedResult = { arguments: Record<string, Artifact>; challenges: Record<string, Artifact>; responses: Record<string, Artifact>; decision: (Artifact & { panel?: PanelSummary }) | null };
/**
 * What the offline audit expects of a completed run: the six advocate submissions plus one decision per seat that
 * finished. The seats come from the pinned packet, and the decision must carry exactly those seats.
 */
export function completedArtifacts(packet: Pick<CasePacket, 'panel'>, result: CompletedResult): Record<string, Artifact | null> {
  const pinned = decideRoles(packet), seats = result.decision?.panel?.seats;
  if (packet.panel ? JSON.stringify(seats?.map(s => s.role)) !== JSON.stringify(pinned) : seats !== undefined) throw new Error('The decision does not carry the seats pinned for this run');
  const advocates: Record<string, Artifact> = { ...result.arguments, ...result.challenges, ...result.responses };
  const required = ['investigate', 'challenge', 'respond'].flatMap(phase => [`rider_${phase}`, `driver_${phase}`]);
  if (Object.keys(advocates).length !== required.length || required.some(key => !advocates[key])) throw new Error('A completed run carries the six advocate submissions');
  return { ...advocates, judge_decide: result.decision,
    ...Object.fromEntries((seats ?? []).filter(s => s.role !== 'judge' && !s.failed).map(s => [`${s.role}_decide`, s.artifact as Artifact])) };
}
export type SeatResult = { role: Role; artifact?: Artifact; failed?: string; model?: string | null };
type Decision = { outcome?: string; remedy?: { medium: string; amountCents: number }; riderRecovery?: { amountCents: number }; summary?: string; criteria?: { condition: string; status: string }[] };
export type PanelSeatSummary = { seat: Seat; role: Role; order: 'rider_first' | 'driver_first'; model: string | null; outcome: string | null; remedy: { medium: string; amountCents: number } | null; riderRecovery?: { amountCents: number }; summary: string | null; artifactId: string | null; failed?: string; artifact?: Artifact; confidenceScore?: ConfidenceScore };
/** routingVersion is stamped by routePanel; panels recorded before it existed have none and never match measured metrics. */
export type PanelSummary = { version: 1; agree: boolean; routingVersion?: string; seats: PanelSeatSummary[] };

// A driver payment's recovery from the rider is part of the decision (contract 4); older decisions have none, so their keys are unchanged.
const key = (d: Decision) => `${d.outcome}|${d.remedy?.medium}|${d.remedy?.amountCents}` + (d.riderRecovery ? `|recover ${d.riderRecovery.amountCents}` : '');
/** Seats agree when outcome, remedy medium and amount in cents (and any recovery from the rider) are identical. No tolerance. */
export const panelAgreement = (decisions: Decision[]) => decisions.length > 0 && decisions.every(d => key(d) === key(decisions[0]));
/** The harness reports placeholders ("default-model", "unknown") before the served model; those are not a seat's model. */
export const servedModel = (model: unknown): string | null => typeof model === 'string' && model && !['default-model', 'unknown'].includes(model) ? model : null;
const seatList = (seats: Seat[]) => seats.length > 1 ? `Arbitrators ${seats.slice(0, -1).join(', ')} and ${seats.at(-1)}` : `Arbitrator ${seats[0]}`;
/** The Judge card's headline: "3 of 3 agree", or the split, naming any seat that differs or failed. */
export function panelSplitText(panel: PanelSummary) {
  const n = panel.seats.length, done = panel.seats.filter(s => !s.failed), failed = panel.seats.filter(s => s.failed).map(s => s.seat);
  const groups = new Map<string, Seat[]>();
  for (const s of done) groups.set(key(s as Decision), [...(groups.get(key(s as Decision)) ?? []), s.seat]);
  const largest = [...groups.values()].sort((a, b) => b.length - a.length)[0] ?? [];
  const parts = [largest.length >= 2 ? `${largest.length} of ${n} agree` : done.length >= 2 ? 'No two arbitrators agree' : `${done.length} of ${n} finished`];
  const differ = largest.length >= 2 ? done.map(s => s.seat).filter(s => !largest.includes(s)) : [];
  if (differ.length) parts.push(`${seatList(differ)} ${differ.length > 1 ? 'differ' : 'differs'}`);
  if (failed.length) parts.push(`${seatList(failed)} failed`);
  return parts.join('; ');
}
/**
 * What a panel run's numbers depend on, per seat: the requested model, the models the
 * harness reported serving (placeholders removed), the agent file hash, the hash of the instructions the seat received with
 * the case left out (it covers the decision schema's shape), the posture's identifier (the hash leaves the posture notice
 * out, so its wording is not covered, only which posture and readings), the turn and thinking budgets and effort, and the
 * evidence order; plus the routing rules, the record check (its predicate version and the register's hash, from
 * the run's integrity_checked event) and, for a run with photos, the photo examiner (its model and case-independent
 * instructions hash, from photo_examiner_called). "none" is a state: the run had no record check, or no photos.
 */
export type IntegrityConfig = 'none' | { predicateVersion: string; registerSha256: string | null };
export type ExaminerConfig = 'none' | { model: string; instructionsSha256: string };
export type PanelConfiguration = { routingVersion: string; integrity: IntegrityConfig; photoExaminer: ExaminerConfig; seats: { seat: Seat; model: string; servedModels: string[]; agentSha256: string; instructionsHash: string; posture: string; maxTurns: number; maxThinkingTokens: number; effort: string; order: 'rider_first' | 'driver_first' }[] };
/** A posture's identifier: preset, version, mode and the enabled readings. No posture reads as "none". */
const postureId = (p: { preset?: unknown; version?: unknown; mode?: unknown; allowedAssumptions?: unknown } | null) => !p ? 'none' : JSON.stringify([p.preset, p.version, p.mode, Array.isArray(p.allowedAssumptions) ? [...p.allowedAssumptions].sort() : null]);
type ConfigEvent = { actor: string; phase: string; kind: string; data?: any };
/**
 * A panel run's configuration, read from what the run recorded: its decision's panel, each seat's session record
 * (runtime_configured: requestedModel, agentDefinition.sha256, instructionsHash, taskInput.posture, settings.maxTurns,
 * maxThinkingTokens and effort) and the harness's model reports. Null when any part is missing: no configuration, no numbers.
 * The full system text is recorded too but carries the case (ID, policy profile, posture notice, schema), so it cannot identify
 * a configuration across cases; instructionsHash (prompt.ts) leaves the case out. Sessions recorded before it have none.
 * The events come from our own hash-chained store, so they are trusted here; someone who can write them could forge a match.
 */
export function panelConfiguration(panel: PanelSummary, events: ConfigEvent[]): PanelConfiguration | null {
  if (!panel.routingVersion) return null;
  const text0 = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  // The record check: none when the run recorded no check; a check recorded before its predicate version existed is a missing part.
  const check = [...events].reverse().find(e => e.kind === 'integrity_checked')?.data;
  const integrity: IntegrityConfig | undefined = check === undefined ? 'none' : text0(check?.predicateVersion) ? { predicateVersion: check.predicateVersion, registerSha256: text0(check.registerSha256) ? check.registerSha256 : null } : undefined;
  // The photo examiner: none when the run had no examine step; a photo run needs the examiner's model and instructions hash.
  const examiner = [...events].reverse().find(e => e.kind === 'photo_examiner_called')?.data, photoRun = events.some(e => e.phase === 'examine');
  const photoExaminer: ExaminerConfig | undefined = !photoRun && examiner === undefined ? 'none' : text0(examiner?.model) && text0(examiner?.instructionsSha256) ? { model: examiner.model, instructionsSha256: examiner.instructionsSha256 } : undefined;
  if (!integrity || !photoExaminer) return null;
  const seats = panel.seats.map(s => {
    const mine = events.filter(e => e.actor === s.role && e.phase === 'decide'), c = mine.find(e => e.kind === 'runtime_configured')?.data;
    const servedModels = [...new Set(mine.filter(e => e.kind === 'model_reported').map(e => servedModel(e.data?.model)).filter((m): m is string => !!m))].sort();
    const posture = c?.taskInput && typeof c.taskInput === 'object' && 'posture' in c.taskInput ? postureId(c.taskInput.posture) : undefined;
    return { seat: s.seat, model: c?.requestedModel, servedModels, agentSha256: c?.agentDefinition?.sha256, instructionsHash: c?.instructionsHash, posture, maxTurns: c?.settings?.maxTurns, maxThinkingTokens: c?.settings?.maxThinkingTokens, effort: c?.settings?.effort, order: s.order };
  });
  const text = (v: unknown) => typeof v === 'string' && v.length > 0;
  return seats.every(s => text(s.model) && s.servedModels.length > 0 && text(s.agentSha256) && text(s.instructionsHash) && text(s.posture) && Number.isInteger(s.maxTurns) && Number.isInteger(s.maxThinkingTokens) && text(s.effort))
    ? { routingVersion: panel.routingVersion, integrity, photoExaminer, seats: seats as PanelConfiguration['seats'] } : null;
}
/**
 * The configuration fingerprint. The Judge card and the scorer (score-live.ts) must both use this function, the scorer on
 * the batch it measured: panelFingerprint(panelConfiguration(decision.panel, runEvents)). Plain text, not a hash, so the
 * browser can compute it; equal strings mean the same configuration in every part listed on PanelConfiguration.
 */
export function panelFingerprint(config: PanelConfiguration): string {
  const seats = [...config.seats].sort((a, b) => a.seat.localeCompare(b.seat));
  if (seats.map(s => s.seat).join() !== 'A,B,C') throw new Error('A panel fingerprint needs exactly three seats, A, B and C');
  const integrityOk = config.integrity === 'none' || (!!config.integrity?.predicateVersion && (config.integrity.registerSha256 === null || !!config.integrity.registerSha256));
  const examinerOk = config.photoExaminer === 'none' || (!!config.photoExaminer?.model && !!config.photoExaminer.instructionsSha256);
  if (!config.routingVersion || !integrityOk || !examinerOk || seats.some(s => !s.model || !s.servedModels?.length || !s.agentSha256 || !s.instructionsHash || !s.posture || !Number.isInteger(s.maxTurns) || !Number.isInteger(s.maxThinkingTokens) || !s.effort || !s.order)) throw new Error('The panel configuration is incomplete');
  const integrity = config.integrity === 'none' ? 'none' : [config.integrity.predicateVersion, config.integrity.registerSha256];
  const photos = config.photoExaminer === 'none' ? 'none' : [config.photoExaminer.model, config.photoExaminer.instructionsSha256];
  return 'panel-v4 ' + JSON.stringify({ routing: config.routingVersion, integrity, photos, seats: seats.map(s => [s.seat, s.model, [...s.servedModels].sort(), s.agentSha256, s.instructionsHash, s.posture, s.maxTurns, s.maxThinkingTokens, s.effort, s.order]) });
}
/**
 * The error rate among released cases, written by the scorer to panel-metrics.json after the held-out batch (spec Part 2,
 * revision 14). Only counts and metadata are stored; the range is computed here from the counts.
 * Anything incomplete or malformed reads "not yet measured".
 */
export type PanelMetrics = { version: 1; status: 'not_measured' } | { version: 1; status: 'measured'; measured: { measuredAt: string; caseSet: string; fingerprint: string; releasedCases: number; errorsAmongReleased: number } };
export function parsePanelMetrics(raw: unknown): PanelMetrics {
  const x = raw as { version?: unknown; status?: unknown; measured?: Record<string, unknown> } | null, m = x?.measured;
  const valid = x?.version === 1 && x.status === 'measured' && !!m && typeof m === 'object'
    && typeof m.measuredAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(m.measuredAt) && Number.isFinite(Date.parse(m.measuredAt))
    && typeof m.caseSet === 'string' && m.caseSet.trim().length > 0 && typeof m.fingerprint === 'string' && m.fingerprint.startsWith('panel-v4 {')
    && Number.isInteger(m.releasedCases) && (m.releasedCases as number) > 0 && Number.isInteger(m.errorsAmongReleased) && (m.errorsAmongReleased as number) >= 0 && (m.errorsAmongReleased as number) <= (m.releasedCases as number);
  return valid ? { version: 1, status: 'measured', measured: { measuredAt: m.measuredAt as string, caseSet: (m.caseSet as string).trim(), fingerprint: m.fingerprint as string, releasedCases: m.releasedCases as number, errorsAmongReleased: m.errorsAmongReleased as number } } : { version: 1, status: 'not_measured' };
}
const percent = (fraction: number) => `${Math.round(fraction * 1000) / 10}%`;
// Wilson score interval, 95%: the honest range for a rate on few cases.
const wilson95 = (k: number, n: number) => { const z = 1.96, p = k / n, d = 1 + z * z / n, mid = p + z * z / (2 * n), half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return { low: Math.max(0, (mid - half) / d), high: Math.min(1, (mid + half) / d) }; };
/** Numbers show only for the exact configuration they were measured on; `fingerprint` is the run's, or null when it has none. */
export function panelMetricsText(metrics: PanelMetrics, fingerprint: string | null) {
  const lead = 'How often released answers were wrong: ';
  if (metrics.status !== 'measured') return lead + 'not measured yet.';
  const m = metrics.measured;
  if (fingerprint !== m.fingerprint) return lead + 'not measured for this setup (its arbitrators, release rules, record check or photo reader differ from the measured one).';
  const w = wilson95(m.errorsAmongReleased, m.releasedCases);
  const range = m.errorsAmongReleased === 0 ? `below ${percent(Math.min(1, 3 / m.releasedCases))}, a rough upper bound` : `likely between ${percent(w.low)} and ${percent(w.high)}`;
  return lead + `${m.errorsAmongReleased} of ${m.releasedCases} (${range}), measured ${m.measuredAt} on ${m.caseSet}.`;
}
const outcomeText = (d: Decision) => d.outcome === 'refund_recommendation' ? `refund SGD ${((d.remedy?.amountCents ?? 0) / 100).toFixed(2)} (${d.remedy?.medium})`
  : d.outcome === 'charge_recommendation' ? `charge the rider SGD ${((d.remedy?.amountCents ?? 0) / 100).toFixed(2)}`
  : d.outcome === 'driver_payment_recommendation' ? `pay the driver SGD ${((d.remedy?.amountCents ?? 0) / 100).toFixed(2)}, recover SGD ${(((d as { riderRecovery?: { amountCents: number } }).riderRecovery?.amountCents ?? 0) / 100).toFixed(2)} from the rider`
  : d.outcome === 'no_action' ? 'no action' : 'no recommendation';
const firstSentence = (text?: string) => (text ?? '').split(/(?<=[.!?])\s/)[0].slice(0, 200);

export function routePanel(results: SeatResult[], context: RoutingContext): Routing & { panel?: PanelSummary } {
  const anchor = results.find(r => r.role === 'judge');
  if (!anchor?.artifact) throw new Error('Seat A (the anchor Arbitrator) must finish before the panel is routed');
  if (results.length === 1) return routeDecision(anchor.artifact as any, context);
  const done = results.filter(r => r.artifact) as (SeatResult & { artifact: Artifact })[];
  // Every seat's reasons count; identical reasons from several seats are merged and marked with each seat.
  const reasons: RoutingReason[] = [], notes: string[] = [];
  for (const r of done) {
    const routed = routeDecision(r.artifact as any, context);
    for (const reason of routed.reasons) {
      const same = reasons.find(x => x.code === reason.code && x.text === reason.text);
      if (same) same.seats = [...(same.seats ?? []), seatOf[r.role]];
      else reasons.push({ ...reason, seats: [seatOf[r.role]] });
    }
    for (const note of routed.notes) if (!notes.includes(note)) notes.push(note);
  }
  for (const r of results.filter(r => !r.artifact)) reasons.push({ code: 'panel_incomplete', text: `Seat ${seatOf[r.role]} did not finish (${r.failed ?? 'no submission'}), so the panel cannot confirm the recommendation.`, seats: [seatOf[r.role]] });
  const decisions = done.map(r => r.artifact as Decision);
  const agree = results.length === done.length && panelAgreement(decisions);
  if (done.length > 1 && !panelAgreement(decisions)) {
    const counts = new Map<string, Seat[]>();
    for (const r of done) counts.set(key(r.artifact as Decision), [...(counts.get(key(r.artifact as Decision)) ?? []), seatOf[r.role]]);
    const [majorityKey, majority] = [...counts.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    const lead = done.find(r => key(r.artifact as Decision) === majorityKey)!.artifact as Decision;
    const others = done.filter(r => key(r.artifact as Decision) !== majorityKey).map(r => `seat ${seatOf[r.role]} recommended ${outcomeText(r.artifact as Decision)}: ${firstSentence((r.artifact as Decision).summary)}`);
    reasons.push({ code: 'judges_disagree', text: `${majority.length} of ${done.length} recommended ${outcomeText(lead)}; ${others.join('; ')}`, seats: done.map(r => seatOf[r.role]) });
  }
  // A criterion one seat finds met and another not met is a factual disagreement a person resolves.
  const conditions = new Set(decisions.flatMap(d => (d.criteria ?? []).map(c => c.condition)));
  for (const condition of conditions) {
    const statuses = done.map(r => ({ seat: seatOf[r.role], status: (r.artifact as Decision).criteria?.find(c => c.condition === condition)?.status }));
    if (statuses.some(s => s.status === 'met') && statuses.some(s => s.status === 'not_met')) reasons.push({ code: 'criteria_conflict', text: `The seats disagree on ${condition}: ` + statuses.filter(s => s.status).map(s => `seat ${s.seat} ${s.status === 'not_met' ? 'not met' : s.status}`).join(', ') + '.', seats: statuses.map(s => s.seat) });
  }
  const panel: PanelSummary = { version: 1, agree, routingVersion, seats: results.map(r => { const d = r.artifact as Decision | undefined; const meta = seatMeta[r.role as keyof typeof seatMeta]; return { seat: seatOf[r.role], role: r.role, order: meta.order, model: servedModel(r.model), outcome: d?.outcome ?? null, remedy: d?.remedy ?? null, ...(d?.riderRecovery ? { riderRecovery: d.riderRecovery } : {}), summary: d?.summary ?? null, artifactId: (r.artifact as { artifactId?: string } | undefined)?.artifactId ?? null, ...(r.failed ? { failed: r.failed } : {}), ...(r.artifact && r.role !== 'judge' ? { artifact: r.artifact } : {}) }; }) };
  const base = routeDecision(anchor.artifact as any, context);
  return { ...base, route: reasons.length ? 'human_review' : 'release_with_review_option', reasons, notes, panel };
}
