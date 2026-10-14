import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from './connection';
import type { Activity, Artifact, CasePacket, Phase, Role } from '../agent-flow/contracts';
import { decisionContractVersion, evidenceChecksPin, hasEvidenceChecks } from '../agent-flow/contracts';
import { startingPacket } from '../outside-data/records';
import { canonical, hash, phaseRoles, supplementPacket, uploadSource, type Checkpoint } from './model';
import { defaultPosture, parsePosture, type Posture } from '../agent-flow/posture';
import { liveCase } from './cases';
import { triage, reviewUpdateSchema } from './triage';
import { safetyForRouting } from '../agent-flow/safety';
import { chatReadingKind, chatSafetyHandoff, chatSafetyReadings, type ChatSafetyHandoff } from '../agent-flow/chat-checks';
import { routePanel, defaultPanel, assertPanel, type SeatResult } from '../agent-flow/panel';
import { panelRoutingContext } from '../agent-flow/panel-context';
import { scoreRun, scorePanelSeats } from '../agent-flow/confidence';
import { integrityContext, integrityPin } from '../evidence-collection/integrity';
import { cleaningIntake, intakeNotice } from '../evidence-collection/intake';
import { routingPrecedents } from '../policy/retrieval';
import { loopPinLimit, pinPrecedents, precedents, type Precedent } from '../policy/precedents';
import { agreementWithheld, applyCardEdit, cardProblems, checkDecision, checkReviewAction, conflictDetails, conflictingCards, draftFromDecision, draftsOnDecision, draftWithheld, loopStatuses, nextLoopStatus, type LoopRun, type LoopStatus, privacyProblems } from '../policy/loop';
import { detectCategory, type CategoryDetection } from './classify';
import { queueEventsFromRow, type QueueEvent } from './sla';
import { groupKey } from './case-groups';
import { queueEventPredicate } from './schema';
import { dailyLimitMessage, runMessages } from './messages';
import { shownRulings } from '../policy/catalog';
import { examWorkspaceIds, mayView, shownCaseIds, type PublicScope, type ScopedWorkspace } from './public-scope';

async function tx<T>(fn: (c: PoolClient) => Promise<T>) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const result = await fn(c); await c.query('COMMIT'); return result; }
  catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
async function event(c: PoolClient, run: any, actor: string, phase: string, activity: Activity) {
  const prior = (await c.query('SELECT seq,hash FROM live_events WHERE run_id=$1 ORDER BY seq DESC LIMIT 1', [run.id])).rows[0];
  const value = { ...activity, seq: (prior?.seq ?? 0) + 1, at: new Date().toISOString(), runId: run.id, caseId: run.packet.caseId, actor, phase, parent: null, evidenceVersion: run.packet.evidenceVersion, policyVersion: run.packet.policyVersion };
  const previous = prior?.hash ?? run.packet_hash;
  await c.query('INSERT INTO live_events VALUES($1,$2,$3,$4,$5)', [run.id, value.seq, value, previous, hash(previous + canonical(value))]);
}
async function locked(c: PoolClient, id: string, token?: string) {
  const run = (await c.query('SELECT *,lease_until > now() AS valid_lease FROM live_runs WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!run) throw new Error('Run not found');
  if (token && (run.lease_token !== token || !run.valid_lease)) throw new Error('Worker lease lost');
  return run;
}
export async function workspace(id?: string, caseId = 'DISP-004', extra: { title?: string; category?: string } = {}) {
  if (!id) { liveCase(caseId); id = randomUUID(); await pool.query("INSERT INTO live_workspaces(id,case_id,policy_basis,title,category) VALUES($1,$2,'reviewed-public',$3,$4)", [id, caseId, extra.title?.trim().slice(0, 120) || null, extra.category ?? null]); }
  const record = (await pool.query('SELECT id,case_id,title,category,posture FROM live_workspaces WHERE id=$1', [id])).rows[0];
  if (!record) throw new Error('Workspace not found');
  const documents = (await pool.query('SELECT id,filename,sha256,octet_length(bytes) AS size,created_at FROM live_documents WHERE workspace_id=$1 ORDER BY created_at,id', [id])).rows;
  const runs = (await pool.query('SELECT id,status,requested,created_at,error FROM live_runs WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 30', [id])).rows;
  return { id, caseId: record.case_id as string, customTitle: record.title as string | null, category: record.category as string | null, posture: (record.posture as Posture | null) ?? defaultPosture, documents, runs };
}
/**
 * The runs of every copy of this workspace's case (case-groups.ts), newest first, each with the workspace it ran in: the
 * Run list of one picker row. The workspace's own runs are always included, even when it is archived or alone.
 */
export async function groupRuns(id: string) {
  const own = (await pool.query("SELECT w.id,w.case_id,w.posture,(SELECT count(*)::int FROM live_documents d WHERE d.workspace_id=w.id) AS documents FROM live_workspaces w WHERE w.id=$1", [id])).rows[0];
  if (!own) throw new Error('Workspace not found');
  const key = groupKey(own);
  const copies = key.startsWith('workspace:') ? [] : (await pool.query("SELECT w.id,w.case_id,w.posture,(SELECT count(*)::int FROM live_documents d WHERE d.workspace_id=w.id) AS documents FROM live_workspaces w WHERE w.case_id=$1 AND w.id<>$2 AND w.policy_basis='reviewed-public' AND w.archived_at IS NULL", [own.case_id, id])).rows.filter(w => groupKey(w) === key);
  const ids = [id, ...copies.map(w => w.id as string)];
  type GroupRun = { id: string; status: string; created_at: string; workspace_id: string };
  const newest = (await pool.query('SELECT id,status,created_at,workspace_id FROM live_runs WHERE workspace_id = ANY($1::uuid[]) ORDER BY created_at DESC LIMIT 30', [ids])).rows as GroupRun[];
  // Each copy's latest run too, however old: it is the run a waiting priority on the picker row points to.
  const latest = (await pool.query('SELECT DISTINCT ON (workspace_id) id,status,created_at,workspace_id FROM live_runs WHERE workspace_id = ANY($1::uuid[]) ORDER BY workspace_id, created_at DESC', [ids])).rows as GroupRun[];
  return [...newest, ...latest.filter(r => !newest.some(n => n.id === r.id))].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}
export async function addDocument(workspaceId: string, filename: string, bytes: Buffer, externalResponse = false) {
  const id = randomUUID(), source = uploadSource(id, filename, bytes, externalResponse ? 262144 : 65536);
  return tx(async c => {
    if (!(await c.query('SELECT id FROM live_workspaces WHERE id=$1 FOR UPDATE', [workspaceId])).rowCount) throw new Error('Workspace not found');
    if (Number((await c.query('SELECT count(*) FROM live_documents WHERE workspace_id=$1', [workspaceId])).rows[0].count) >= 8) throw new Error('This workspace already has eight supplemental documents.');
    await c.query('INSERT INTO live_documents(id,workspace_id,filename,sha256,bytes,source) VALUES($1,$2,$3,$4,$5,$6)', [id, workspaceId, filename, source.sha256, bytes, source]);
    const detection = await refreshCategory(c, workspaceId);
    const screening = triage({ sources: [source] });
    if (screening.route !== 'ordinary') {
      const active = (await c.query("SELECT *,lease_until > now() AS valid_lease FROM live_runs WHERE workspace_id=$1 AND status IN ('queued','running','pausing','paused') FOR UPDATE", [workspaceId])).rows;
      for (const run of active) {
        await c.query("UPDATE live_runs SET requested='pause',status=$2 WHERE id=$1", [run.id, run.valid_lease ? 'pausing' : 'paused']);
        await event(c, run, 'coordinator', 'triage', { kind: 'review_requested', message: 'New safety evidence paused this run. Current tasks may finish; start a new run to include the new original.', data: { status: 'unassigned', owner: null, kind: 'new_safety_evidence', note: 'New evidence is outside this pinned packet. Stop this run and start a new run after reviewing the updated workspace.', sourceId: source.id, sha256: source.sha256, screening } });
      }
    }
    return { id, sourceId: source.id, sha256: source.sha256, category: detection?.category ?? null };
  });
}
/** Custom cases take their dispute type from the uploaded documents, never from an operator choice; re-run after every upload and at run start. */
async function refreshCategory(c: PoolClient, workspaceId: string): Promise<CategoryDetection | null> {
  const record = (await c.query('SELECT case_id FROM live_workspaces WHERE id=$1', [workspaceId])).rows[0];
  if (!record || record.case_id !== 'CUSTOM') return null;
  const docs = (await c.query('SELECT source FROM live_documents WHERE workspace_id=$1 ORDER BY created_at,id', [workspaceId])).rows;
  const detection = detectCategory(docs.map(d => d.source));
  await c.query('UPDATE live_workspaces SET category=$2 WHERE id=$1', [workspaceId, docs.length ? detection.category : null]);
  return detection;
}
export async function detectWorkspaceCategory(workspaceId: string) { return tx(c => refreshCategory(c, workspaceId)); }
/** Operator sets the ambiguity posture before a run; runs already started keep their pinned copy. */
export async function setPosture(workspaceId: string, input: unknown) {
  const posture = parsePosture(input);
  return tx(async c => {
    if (!(await c.query('SELECT id FROM live_workspaces WHERE id=$1 FOR UPDATE', [workspaceId])).rowCount) throw new Error('Workspace not found');
    const active = Number((await c.query("SELECT count(*) FROM live_runs WHERE workspace_id=$1 AND status IN ('queued','running','pausing','paused','stopping')", [workspaceId])).rows[0].count);
    if (active) throw new Error('Stop the active run before changing the posture; a run keeps the posture it started with.');
    const previous = (await c.query('SELECT posture FROM live_workspaces WHERE id=$1', [workspaceId])).rows[0]?.posture ?? null;
    await c.query('UPDATE live_workspaces SET posture=$2 WHERE id=$1', [workspaceId, posture]);
    return { id: workspaceId, posture, previous };
  });
}
export async function workspacePacket(workspaceId: string, base: CasePacket) {
  const w = await workspace(workspaceId);
  if (w.caseId !== base.caseId) throw new Error('Case packet does not match workspace');
  const docs = (await pool.query('SELECT source FROM live_documents WHERE workspace_id=$1 ORDER BY created_at,id', [workspaceId])).rows;
  return supplementPacket(base, docs.map(d => d.source));
}
/**
 * The cap on new runs in any 24 hours, a spending guard: 30 unless the operator sets FISHBOWL_DAILY_RUN_LIMIT (a whole number from 1 to
 * 200) on the web service for a planned batch (owner decision, 7 October 2026, for the exam). Anything else falls back to 30.
 */
export const dailyRunLimit = (env: Record<string, string | undefined> = process.env) => {
  const value = env.FISHBOWL_DAILY_RUN_LIMIT?.trim(), n = value && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 200 ? n : 30;
};
/**
 * The runs that hold one of the three run slots (owner review, 8 October 2026): a run stopped at the safety screen before any
 * agent ran waits for a person, not a server, and a run whose server died two minutes ago or more holds nothing. So does a run
 * paused by its chat reading (MVP fixes, 10 October 2026) until someone resumes it after that hold: its latest hold, since a
 * clearance taken back opens a new one (chatHold).
 */
export const activeRunsQuery = `SELECT count(*) FROM live_runs r WHERE r.status IN ('queued','running','pausing','paused','stopping')
    AND NOT (r.status IN ('running','pausing','stopping') AND r.lease_until < now()-interval '2 minutes')
    AND NOT (r.status='paused' AND NOT EXISTS (SELECT 1 FROM live_tasks t WHERE t.run_id=r.id)
      AND EXISTS (SELECT 1 FROM live_events e WHERE e.run_id=r.id AND e.event->>'kind'='review_requested' AND e.event->>'phase'='triage' AND coalesce(e.event->'data'->>'kind','')<>'merits_review')
      AND NOT EXISTS (SELECT 1 FROM live_events e WHERE e.run_id=r.id AND e.event->>'kind'='control_requested' AND e.event->'data'->>'command'='resume'))
    AND NOT (r.status='paused' AND EXISTS (SELECT 1 FROM live_events h WHERE h.run_id=r.id AND h.event->>'kind'='review_requested' AND h.event->'data'->>'kind'='${chatReadingKind}'
      AND NOT EXISTS (SELECT 1 FROM live_events n WHERE n.run_id=r.id AND n.seq>h.seq AND n.event->>'kind'='review_requested' AND n.event->'data'->>'kind'='${chatReadingKind}')
      AND NOT EXISTS (SELECT 1 FROM live_events e WHERE e.run_id=r.id AND e.seq>h.seq AND e.event->>'kind'='control_requested' AND e.event->'data'->>'command'='resume')))`;
/** The run-start lock: every way a run takes a slot (a start, a resume, a recovery) holds it, so three can never become four. */
const slotLock = (c: PoolClient) => c.query('SELECT pg_advisory_xact_lock(1042042)');
/** Whether the other runs leave a slot for this one (a run resumed or recovered is not counted against itself). */
const slotFree = async (c: PoolClient, id: string) => Number((await c.query(activeRunsQuery + ' AND r.id<>$1', [id])).rows[0].count) < 3;
/** Whether this run holds a slot now (a dead run or one stopped at the safety screen holds none). */
const holdsSlot = async (c: PoolClient, id: string) => Number((await c.query(activeRunsQuery + ' AND r.id=$1', [id])).rows[0].count) > 0;
/**
 * The runs the daily limit counts, oldest first: every run of the last 24 hours except one that ended before any agent ran
 * (refused during a release, or a cleaning claim returned at intake).
 */
export const dailyRunsQuery = `SELECT r.created_at FROM live_runs r WHERE r.created_at > now()-interval '1 day'
    AND NOT (r.status IN ('failed','completed') AND NOT EXISTS (SELECT 1 FROM live_tasks t WHERE t.run_id=r.id)) ORDER BY r.created_at`;
export async function startRun(workspaceId: string, base: CasePacket) {
  return tx(async c => {
    await slotLock(c);
    const workspace = (await c.query('SELECT case_id FROM live_workspaces WHERE id=$1 FOR UPDATE', [workspaceId])).rows[0];
    if (!workspace) throw new Error('Workspace not found');
    if (workspace.case_id !== base.caseId) throw new Error('Case packet does not match this workspace');
    const active = Number((await c.query(activeRunsQuery)).rows[0].count);
    if (active >= 3) throw new Error(runMessages.threeRuns);
    const limit = dailyRunLimit(), counted = (await c.query(dailyRunsQuery)).rows as { created_at: Date }[];
    if (counted.length >= limit) throw new Error(dailyLimitMessage(limit, new Date(new Date(counted[counted.length - limit].created_at).getTime() + 24 * 3600 * 1000)));
    const docs = (await c.query('SELECT source FROM live_documents WHERE workspace_id=$1 ORDER BY created_at,id', [workspaceId])).rows;
    if (!base.sources.some(s => s.id.startsWith('evidence/')) && !docs.length) throw new Error('Upload at least one document before starting a run on a custom case.');
    const postureRow = (await c.query('SELECT posture FROM live_workspaces WHERE id=$1', [workspaceId])).rows[0];
    const posture = postureRow?.posture ? parsePosture(postureRow.posture) : defaultPosture;
    // The panel is pinned per run and is opt-in until the seat tryout picks seats B and C (spec Part 2).
    const panel = process.env.RYDE_JUDGE_PANEL === '1' ? { panel: defaultPanel } : {};
    // The past rulings this run may see: the file cards plus the reviewer cards approved by now, copied in whole (learning loop).
    const loop = await approvedLoopCards(c), precedentSet = pinPrecedents(loop.cards, precedents, loop.approved);
    // Evidence checks 4 (AD-11): a dataset run starts without advance outside data; the Evidence Collector looks it up itself.
    const packet = { ...startingPacket(supplementPacket(base, docs.map(d => d.source)), evidenceChecksPin), contractVersion: decisionContractVersion, evidenceChecks: evidenceChecksPin, posture, ...panel, ...integrityPin(base), precedentSet }, id = randomUUID(), packetHash = hash(canonical(packet));
    assertPanel(packet);
    await c.query('INSERT INTO live_runs(id,workspace_id,packet,packet_hash) VALUES($1,$2,$3,$4)', [id, workspaceId, packet, packetHash]);
    const run = { id, packet, packet_hash: packetHash };
    await event(c, run, 'coordinator', 'prepare', { kind: 'prepared', message: 'Immutable synthetic case and supplemental evidence pinned. Protocol 2; live model proposals require human review.', data: { posture, precedents: { sha256: precedentSet.sha256, files: precedentSet.files, loop: precedentSet.loop, loopLimit: precedentSet.loopLimit, loopApproved: precedentSet.loopApproved } } });
    for (const d of docs) await event(c, run, 'coordinator', 'prepare', { kind: 'document_received', message: 'Supplemental document admitted before the run', sources: [d.source.id], data: { sha256: d.source.sha256 } });
    const integrity = await integrityContext(packet);
    if (integrity) await event(c, run, 'coordinator', 'triage', { kind: 'integrity_checked', message: integrity.status === 'checked' ? `Record check: ${integrity.matches.length} match(es) for review.` : `Record check ${integrity.status.replace('_', ' ')}.`, data: integrity });
    const screening = triage(packet);
    await event(c, run, 'coordinator', 'triage', { kind: 'triage_completed', message: screening.route === 'ordinary' ? 'No safety screening flag. This is not a finding that the trip was safe.' : 'Safety screening requires human attention before model work.', data: screening });
    if (screening.route !== 'ordinary') {
      await c.query("UPDATE live_runs SET status='paused',requested='pause' WHERE id=$1", [id]);
      await event(c, run, 'coordinator', 'triage', { kind: 'review_requested', message: 'Safety handoff opened. No model task started; no account action executed.', data: { status: 'unassigned', owner: null, kind: screening.route, note: 'Review the original statements and assign a responsible reviewer.', sources: screening.flags } });
    } else {
      // The cleaning-claim intake check (owner decision, 8 October 2026), after the safety screen: a driver's claim filed
      // late, or with no photo or no receipt, goes back to the driver and the run ends here, before any agent.
      const returned = cleaningIntake(packet, docs.length);
      if (returned.length) {
        await c.query("UPDATE live_runs SET status='completed',finished_at=now() WHERE id=$1", [id]);
        await event(c, run, 'coordinator', 'triage', { kind: 'intake_returned', message: intakeNotice(returned), data: { reasons: returned } });
      }
    }
    return { id };
  });
}
export async function controlRun(id: string, command: 'pause' | 'resume' | 'stop') {
  return tx(async c => {
    // A pause or a resume can bring back a run that holds no slot (its server died, or it waited at the safety screen): it
    // takes a slot like a start, under the same lock, and may find all three taken.
    if (command !== 'stop') await slotLock(c);
    const run = await locked(c, id);
    if (command !== 'stop' && !['completed', 'failed', 'stopped'].includes(run.status) && !await holdsSlot(c, id) && !await slotFree(c, id)) {
      // A pause or resume request alone, on a run another person's runs have since replaced, is refused before anything changes.
      if (command === 'resume' || run.status !== 'paused') throw new Error(runMessages.threeRuns);
    }
    if (['completed', 'failed', 'stopped'].includes(run.status)) throw new Error('This run has ended. Start a new run to try again.');
    if (command === 'resume' && run.requested === 'stop') throw new Error('A stopping run cannot resume.');
    if (command === 'resume') {
      const review = await latestReview(c, id);
      // Any safety upload during the run blocks it for good, whatever handoff came after (a chat reading's, cleared): the later
      // steps would run on a packet without that document.
      const late = (await c.query("SELECT 1 FROM live_events WHERE run_id=$1 AND event->>'kind'='review_requested' AND event->'data'->>'kind'='new_safety_evidence' LIMIT 1", [id])).rowCount;
      if (late || review?.kind === 'new_safety_evidence') throw new Error('New safety evidence requires a new run with an updated packet. Stop this run first.');
      if (review && review.status !== 'cleared_for_fare_review') throw new Error('Safety review must be assigned and explicitly cleared for fare review before resuming.');
    }
    const active = run.valid_lease;
    const status = command === 'pause' ? (active ? 'pausing' : 'paused') : command === 'stop' ? (active ? 'stopping' : 'stopped') : (active ? 'running' : 'queued');
    // A run no server holds stops at once, so it finishes here; a held one finishes when its server lets go (releaseRun).
    await c.query("UPDATE live_runs SET requested=$2,status=$3,finished_at=CASE WHEN $3='stopped' THEN now() ELSE finished_at END WHERE id=$1",
      [id, command === 'resume' ? 'run' : command, status]);
    await event(c, run, 'operator', 'control', { kind: 'control_requested', message: command === 'pause' ? 'Pause requested. Current tasks may finish; no new task will start.' : `${command} requested`, data: { command } });
    return { status };
  });
}
async function latestReview(c: PoolClient, id: string) {
  return (await c.query("SELECT event->'data' AS review FROM live_events WHERE run_id=$1 AND event->>'kind' IN ('review_requested','review_updated') ORDER BY seq DESC LIMIT 1", [id])).rows[0]?.review;
}
export async function updateReview(id: string, input: unknown) {
  const update = reviewUpdateSchema.parse(input);
  return tx(async c => {
    const run = await locked(c, id), prior = await latestReview(c, id);
    if (!prior) throw new Error('No review handoff exists for this run.');
    if (await decidedSinceHandoff(c, id)) throw new Error('A final decision is already recorded for this review, so it is closed.');
    if (update.status === 'cleared_for_fare_review' && prior.status !== 'assigned') throw new Error('Assign the handoff before clearing it.');
    if (update.status === 'cleared_for_fare_review' && update.owner !== prior.owner) throw new Error('Clearance must name the assigned owner.');
    const review = { ...prior, ...update, actor: 'shared_operator', identityVerified: false, updatedAt: new Date().toISOString() };
    await event(c, run, 'operator', 'triage', { kind: 'review_updated', message: 'Human handoff updated by the shared demo operator. No external action executed.', data: review });
    // A chat-reading clearance taken back on a run that went on since: the new hold cycle and the pause request commit with the
    // update, so no later step can start in between (beginTask) and an operator's pause cannot skip the cycle.
    if (prior.kind === chatReadingKind && prior.status === 'cleared_for_fare_review' && review.status !== 'cleared_for_fare_review' && !['completed', 'failed', 'stopped'].includes(run.status) && (await chatCycle(c, id)).wentOn) await chatHoldAgain(c, run, review);
    return review;
  });
}
async function decidedSinceHandoff(c: PoolClient, id: string) {
  return (await c.query("SELECT event->>'kind' AS kind FROM live_events WHERE run_id=$1 AND event->>'kind' IN ('review_requested','review_decided') ORDER BY seq DESC LIMIT 1", [id])).rows[0]?.kind === 'review_decided';
}
/** What the learning loop reads about a run (policy/loop.ts): its pinned packet and its own trail, never anything newer. */
async function loopRun(c: PoolClient, run: any): Promise<LoopRun> {
  const trail = (await c.query("SELECT event FROM live_events WHERE run_id=$1 AND event->>'kind' IN ('triage_completed','decision_proposed','review_requested','review_updated','review_decided') ORDER BY seq", [run.id])).rows.map(r => r.event);
  return { runId: run.id, packet: run.packet, judge: trail.find(e => e.kind === 'decision_proposed')?.data ?? null, screening: trail.find(e => e.kind === 'triage_completed')?.data ?? null,
    handoff: trail.filter(e => e.kind === 'review_requested' || e.kind === 'review_updated').at(-1)?.data ?? null,
    handoffKinds: trail.filter(e => e.kind === 'review_requested').map(e => String(e.data?.kind ?? 'unknown')), decided: trail.some(e => e.kind === 'review_decided') };
}
/**
 * A person's final decision on a decision the release check sent to them: agree with the Judge, or override it. Same actor
 * conventions as updateReview. An override, or an agreement that settles a question the record or the rules leave open,
 * also files a draft past ruling (policy/loop.ts draftFromDecision) in the same transaction; it reaches no agent until a
 * person approves it on the past rulings page.
 */
export async function recordDecision(id: string, input: unknown) {
  return tx(async c => {
    const run = await locked(c, id), loop = await loopRun(c, run);
    const decision = checkDecision(loop, input), decidedAt = new Date().toISOString();
    // A scored test case records the decision but drafts nothing (loop.ts draftsFromScoredCases).
    // Withheld, in plain words: a scored test case; or an agreement on a panel run, or with no question that changes the outcome.
    const drafts = draftsOnDecision(loop, decision), withheld = drafts ? draftWithheld(run.packet) : agreementWithheld(loop, decision);
    const draft = drafts && !withheld ? draftFromDecision(loop, decision, decidedAt) : null;
    if (draft) await c.query('INSERT INTO live_precedents(id,run_id,card,judge,decision) VALUES($1,$2,$3,$4,$5)', [draft.precedent_id, id, draft, decision.judge, { ...decision, decidedAt }]);
    const data = { ...decision, actor: 'shared_operator', identityVerified: false, decidedAt, draftId: draft?.precedent_id ?? null, draftWithheld: withheld };
    await event(c, run, 'operator', 'review', { kind: 'review_decided', message: (decision.decision === 'agree' ? 'Final decision recorded by the shared demo operator: a person agreed with the Arbitrator.' + (drafts ? ' ' + (withheld ?? 'The agreement settles a question the record or the rules leave open, so a draft past ruling waits for a person to approve it.') : withheld ? ' ' + withheld : '') : 'Final decision recorded by the shared demo operator: a person decided differently from the Arbitrator. ' + (withheld ?? 'A draft past ruling waits for a person to approve it.')) + ' No external action executed.', data });
    return data;
  });
}
/** A loop card as agents and the review page read it: the stored card with the state its row holds. */
const loopCard = (card: Precedent, status: LoopStatus): Precedent => ({ ...card, review_status: status === 'approved' ? 'approved' : status === 'overturned' ? 'overturned' : 'draft_pending_review' });
/** The privacy mark lives on the row (schema.ts); the card the pages and the Library read carries it as `privacy_check`. */
const withMark = (card: Precedent, r: { privacy_checked_by?: string | null; privacy_checked_at?: Date | string | null }): Precedent =>
  r.privacy_checked_at ? { ...card, privacy_check: { confirmed_by: r.privacy_checked_by ?? '', at: new Date(r.privacy_checked_at).toISOString() } } : card;  // a mark still inside an older card stays as it is
/**
 * One row of live_precedents for the review page: what still blocks approval, and which cards an agent can see (the file
 * cards and the approved loop cards in `approved`) record the same decisive facts with a different outcome. Pure, so it is
 * tested without a database.
 */
/** A card's revision: its stored text and state. An action names the revision the person saw, so a changed card is never approved unseen. */
export const loopRevision = (r: { status: string; card: unknown }) => hash(canonical({ status: r.status, card: r.card }));
export function loopRow(r: Record<string, any>, approved: Precedent[] = []) {
  const card = withMark(loopCard(r.card, r.status), r), open = r.status === 'draft_pending_review' || r.status === 'approved';
  return { id: r.id as string, revision: loopRevision({ status: r.status, card: r.card }), runId: r.run_id as string, workspaceId: r.workspace_id as string | null, caseId: r.case_id as string | null, status: r.status as LoopStatus, card, judge: r.judge, decision: r.decision,
    createdAt: r.created_at, updatedAt: r.updated_at, reviewedBy: r.reviewed_by ?? null, reviewNote: r.review_note ?? null, problems: r.status === 'draft_pending_review' ? cardProblems(card) : [],
    conflicts: open ? conflictingCards(card, [...precedents, ...approved]) : [], conflictDetails: open ? conflictDetails(card, [...precedents, ...approved]) : [] };
}
const loopColumns = "p.id,p.run_id,p.status,p.card,p.judge,p.decision,p.created_at,p.updated_at,p.reviewed_by,p.review_note,p.privacy_checked_by,p.privacy_checked_at,r.workspace_id,r.packet->>'caseId' AS case_id";
/** The approved loop cards a run started now would pin: the newest approved first, at most loopPinLimit, and how many are approved in all. */
async function approvedLoopCards(c: Pick<PoolClient, 'query'>) {
  const rows = (await c.query(`SELECT card, privacy_checked_by, privacy_checked_at, count(*) OVER () AS approved FROM live_precedents WHERE status='approved' ORDER BY updated_at DESC, id LIMIT ${loopPinLimit}`)).rows;
  return { cards: rows.map(r => withMark(loopCard(r.card, 'approved'), r)), approved: Number(rows[0]?.approved ?? 0) };
}
/** Every approved learned ruling a run started now would pin, for the worker's semantic index at start (semantic-index.ts ensureIndex). */
export async function approvedPrecedentCards(): Promise<Precedent[]> { return (await approvedLoopCards(pool)).cards; }
/**
 * The learned rulings the Library page shows: approved, with the privacy mark (11 October 2026). Read at request time, so an
 * approval reaches the page with no release. Null when the database cannot answer (a build, a browser check with no database):
 * the page then shows the file rulings alone.
 */
export async function libraryLoopCards(): Promise<Precedent[] | null> {
  try {
    // Every marked card: the Library lists them all and each has its own page (a limit would drop older ones).
    // The row's mark, or one an earlier build left inside the card before the migration moved it (never both missing).
    const rows = (await pool.query("SELECT card, privacy_checked_by, privacy_checked_at FROM live_precedents WHERE status='approved' AND (privacy_checked_at IS NOT NULL OR card ? 'privacy_check') ORDER BY updated_at DESC, id")).rows;
    return rows.map(r => withMark(loopCard(r.card, 'approved'), r));
  } catch { return null; }
}
export const loopPageSize = 25;
/**
 * One page of the past rulings page, filtered on the server so no state's cards can fall off the list: one state (or all),
 * newest first, `loopPageSize` a page; or one card by id. Pure, so it is tested without a database.
 */
export function loopListQuery(options: { status?: string; page?: number; id?: string } = {}) {
  const status: LoopStatus | 'all' = options.status === 'all' || (loopStatuses as readonly string[]).includes(options.status ?? '') ? options.status as LoopStatus | 'all' : 'draft_pending_review';
  // One card by id is always the first page: a page number there would skip it.
  const page = !options.id && Number.isInteger(options.page) && options.page! >= 1 ? options.page! : 1;
  const where = options.id ? 'p.id=$1' : status === 'all' ? 'true' : 'p.status=$1', params = options.id ? [options.id] : status === 'all' ? [] : [status];
  return { status, page, params, sql: `SELECT ${loopColumns} FROM live_precedents p JOIN live_runs r ON r.id=p.run_id WHERE ${where} ORDER BY p.created_at DESC, p.id LIMIT ${loopPageSize} OFFSET ${(page - 1) * loopPageSize}` };
}
/** A page of cards, with the full count in every state so each tab shows its real size. */
export async function listLoopPrecedents(options: { status?: string; page?: number; id?: string } = {}) {
  const query = loopListQuery(options), approved = (await approvedLoopCards(pool)).cards;
  const counts: Record<LoopStatus | 'all', number> = { draft_pending_review: 0, approved: 0, rejected: 0, overturned: 0, all: 0 };
  for (const r of (await pool.query('SELECT status, count(*)::int AS n FROM live_precedents GROUP BY status')).rows) { counts[r.status as LoopStatus] = r.n; counts.all += r.n; }
  const total = options.id ? 1 : counts[query.status];
  return { precedents: (await pool.query(query.sql, query.params)).rows.map(r => loopRow(r, approved)), counts, status: query.status, page: query.page, pages: Math.max(1, Math.ceil(total / loopPageSize)) };
}
/**
 * The learned rulings the Library shows, with where each came from: approved, with the privacy mark, and kept by the
 * Library's own filter (catalog.ts shownRulings: current policy release). Newest first, as the review page lists them.
 */
async function libraryRulingRows() {
  const rows = (await pool.query(`SELECT ${loopColumns}, w.case_id AS workspace_case_id, w.archived_at AS workspace_archived_at FROM live_precedents p JOIN live_runs r ON r.id=p.run_id LEFT JOIN live_workspaces w ON w.id=r.workspace_id WHERE p.status='approved' AND (p.privacy_checked_at IS NOT NULL OR p.card ? 'privacy_check') ORDER BY p.created_at DESC, p.id`)).rows;
  return rows.filter(r => shownRulings([withMark(loopCard(r.card, 'approved'), r)]).length === 1);
}
const rulingSource = (r: Record<string, any>): ScopedWorkspace | null => r.workspace_id ? { id: r.workspace_id, case_id: r.workspace_case_id, archived_at: r.workspace_archived_at } : null;
/**
 * The public copy's reach (owner, 12 October 2026, public-scope.ts): the listed cases, every starred case, and the case behind
 * each ruling the Library shows; plus the workspaces the exam page and the Library link by ID. Read on every request, so a
 * star or a newly published ruling shows at once and an unstarred case leaves at once.
 */
export async function publicScope(): Promise<PublicScope> {
  const starred = (await pool.query("SELECT DISTINCT case_id FROM live_workspaces WHERE starred_at IS NOT NULL AND archived_at IS NULL AND case_id<>'CUSTOM'")).rows.map(r => r.case_id as string);
  const library = (await libraryRulingRows()).map(rulingSource).filter((s): s is ScopedWorkspace => !!s);
  return {
    cases: new Set([...shownCaseIds, ...starred, ...library.filter(s => s.case_id !== 'CUSTOM').map(s => s.case_id)]),
    workspaces: new Set([...examWorkspaceIds, ...library.map(s => s.id)]),
  };
}
/** A workspace as the public copy's check reads it; null when there is none. */
export async function workspaceScope(id: string): Promise<ScopedWorkspace | null> {
  return (await pool.query('SELECT id,case_id,archived_at FROM live_workspaces WHERE id=$1', [id])).rows[0] ?? null;
}
/** The workspace a run belongs to, as the public copy's check reads it; null when the run does not exist. */
export async function runScope(id: string): Promise<ScopedWorkspace | null> {
  return (await pool.query('SELECT w.id,w.case_id,w.archived_at FROM live_runs r JOIN live_workspaces w ON w.id=r.workspace_id WHERE r.id=$1', [id])).rows[0] ?? null;
}
/**
 * One past ruling as the public copy shows it: no reviewer's notes, reason or name of who ticked the privacy check, the
 * Arbitrator's outcome and remedy only, and no case tag, conflict or "Open the case" link pointing outside the public copy.
 * Pure, so it is tested without a database.
 */
export function publicRulingRow(row: ReturnType<typeof loopRow>, scope: PublicScope, shown: ReadonlySet<string>, source: ScopedWorkspace | null) {
  const { privacy_check, evaluation_overlap, ...card } = row.card, decision = (row.decision ?? {}) as Record<string, unknown>;
  return { ...row,
    workspaceId: source && mayView(scope, source) ? row.workspaceId : null,
    card: { ...card, ...(privacy_check ? { privacy_check: { confirmed_by: '', at: privacy_check.at } } : {}), ...(evaluation_overlap ? { evaluation_overlap: evaluation_overlap.filter(id => scope.cases.has(id)) } : {}) } as Precedent,
    judge: row.judge ? { outcome: row.judge.outcome, remedy: row.judge.remedy } : row.judge,
    decision: { owner: decision.owner, disagreedCriteria: decision.disagreedCriteria, decidedAt: decision.decidedAt, final: decision.final },
    reviewedBy: null, reviewNote: null, problems: [],
    conflicts: row.conflicts.filter(id => shown.has(id)), conflictDetails: row.conflictDetails.filter(c => shown.has(c.id)) };
}
/**
 * The past rulings page on the public copy: the Library's rulings only, in any tab or by ID, counted over that set. A ruling
 * whose source the public copy cannot open (a custom upload) is left out whole: its ID and fields name that run.
 */
export async function listLibraryPrecedents(options: { page?: number; id?: string }, scope: PublicScope) {
  const rows = (await libraryRulingRows()).filter(r => { const source = rulingSource(r); return !!source && mayView(scope, source); }), approved = (await approvedLoopCards(pool)).cards;
  const shown = new Set([...shownRulings(precedents), ...rows.map(r => withMark(loopCard(r.card, 'approved'), r))].map(p => p.precedent_id));
  const all = rows.map(r => publicRulingRow(loopRow(r, approved), scope, shown, rulingSource(r)));
  const picked = options.id ? all.filter(r => r.id === options.id) : all;
  const page = !options.id && Number.isInteger(options.page) && options.page! >= 1 ? options.page! : 1;
  return { precedents: picked.slice((page - 1) * loopPageSize, page * loopPageSize), counts: { draft_pending_review: 0, approved: all.length, rejected: 0, overturned: 0, all: all.length },
    status: 'approved' as const, page, pages: Math.max(1, Math.ceil(picked.length / loopPageSize)) };
}
/** Approve, edit, reject or withdraw one loop card. Approval runs the card library's checks and refuses with their messages. */
export async function reviewLoopPrecedent(precedentId: string, input: unknown) {
  const action = checkReviewAction(input);
  return tx(async c => {
    const source = (await c.query('SELECT run_id FROM live_precedents WHERE id=$1', [precedentId])).rows[0];
    if (!source) throw new Error('Past ruling not found');
    const run = await locked(c, source.run_id), row = (await c.query('SELECT * FROM live_precedents WHERE id=$1 FOR UPDATE', [precedentId])).rows[0];
    if (loopRevision(row) !== action.revision) throw new Error('This past ruling changed since you opened it (someone edited, approved or withdrew it). Reload the page, read it again, then try once more.');
    const status = nextLoopStatus(row.status, action.action);
    const card: Precedent = action.action === 'edit' ? applyCardEdit(row.card, action.edit) : row.card;
    if (action.action === 'approve') { const problems = cardProblems(loopCard(card, 'approved')); if (problems.length) throw new Error('This past ruling cannot be approved yet. ' + problems.join(' ')); }
    // Approving or publishing puts the card on the Library page, so its text must name no person's details (owner, 11 October 2026):
    // the person ticked it (checkReviewAction) and the pattern check agrees. The mark (who, when) goes on the row, since the guard
    // lets only a draft's card change and an already-approved ruling is published later.
    const marks = action.action === 'approve' || action.action === 'publish';
    if (marks) { const personal = privacyProblems(card); if (personal.length) throw new Error('This past ruling cannot go on the Library page yet. ' + personal.join(' ')); }
    await c.query('UPDATE live_precedents SET status=$2,card=$3,updated_at=now(),reviewed_by=$4,review_note=$5,privacy_checked_by=CASE WHEN $6 THEN $4 ELSE privacy_checked_by END,privacy_checked_at=CASE WHEN $6 THEN now() ELSE privacy_checked_at END WHERE id=$1', [precedentId, status, card, action.owner, action.note || null, marks]);
    const done = { approve: 'approved', edit: 'edited', reject: 'rejected', overturn: 'withdrew', publish: 'published to the Library' }[action.action];
    await event(c, run, 'operator', 'review', { kind: 'precedent_reviewed', message: `The shared demo operator ${done} the past ruling drafted from this run. No external action executed.`, data: { precedentId, action: action.action, status, owner: action.owner, note: action.note, cardSha256: hash(canonical(card)), actor: 'shared_operator', identityVerified: false } });
    return loopRow((await c.query(`SELECT ${loopColumns} FROM live_precedents p JOIN live_runs r ON r.id=p.run_id WHERE p.id=$1`, [precedentId])).rows[0], (await approvedLoopCards(c)).cards);
  });
}
export async function claimRun(onlyRunId?: string) {
  return tx(async c => {
    // Ambiguous provider calls are never retried automatically after a worker crash.
    // The slot lock comes before any run row, in the same order as a start or a resume, so the two never wait on each other.
    if ((await c.query("SELECT 1 FROM live_runs WHERE lease_token IS NOT NULL AND lease_until < now() AND ($1::uuid IS NULL OR id=$1) LIMIT 1", [onlyRunId ?? null])).rowCount) await slotLock(c);
    const expired = (await c.query("SELECT * FROM live_runs WHERE lease_token IS NOT NULL AND lease_until < now() AND ($1::uuid IS NULL OR id=$1) FOR UPDATE SKIP LOCKED", [onlyRunId ?? null])).rows;
    for (const run of expired) {
      const pending = await c.query("UPDATE live_tasks SET status='interrupted' WHERE run_id=$1 AND status='running' RETURNING role", [run.id]);
      // A run whose server died two minutes ago held no slot since; if it would take one back and the others have filled all three
      // meanwhile, it does not come back. A run its chat reading paused for a person takes none (activeRunsQuery), so it pauses
      // whatever the others hold (MVP fixes, 10 October 2026): asked here under the lock, with the status it would come back in.
      let full = false;
      if (!pending.rowCount && run.requested !== 'stop') {
        await c.query('UPDATE live_runs SET status=$2 WHERE id=$1', [run.id, run.requested === 'pause' ? 'paused' : 'queued']);
        full = await holdsSlot(c, run.id) && !await slotFree(c, run.id);
      }
      const status = pending.rowCount || full ? 'failed' : run.requested === 'stop' ? 'stopped' : run.requested === 'pause' ? 'paused' : 'queued';
      await c.query("UPDATE live_runs SET status=$2,lease_token=NULL,lease_until=NULL,error=$3,finished_at=CASE WHEN $2 IN ('failed','stopped') THEN now() ELSE finished_at END WHERE id=$1",
        [run.id, status, pending.rowCount || full ? runMessages.serverStopped : null]);
      await event(c, run, 'coordinator', 'recovery', { kind: 'worker_recovered', message: pending.rowCount ? 'Worker disconnected during a model call; call outcome is unknown. No automatic retry. Interrupted model call requires a new run. Accepted submissions remain available in the audit.' : 'Recovered from saved submissions without repeating completed tasks.' });
    }
    const run = (await c.query("SELECT * FROM live_runs WHERE status='queued' AND requested='run' AND lease_token IS NULL AND ($1::uuid IS NULL OR id=$1) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1", [onlyRunId ?? null])).rows[0];
    if (!run) return null;
    const token = randomUUID();
    await c.query("UPDATE live_runs SET status='running',lease_token=$2,lease_until=now()+interval '30 seconds' WHERE id=$1", [run.id, token]);
    await event(c, run, 'coordinator', 'control', { kind: 'worker_claimed', message: 'Server worker attached. This run continues when the browser disconnects.' });
    return { id: run.id as string, packet: run.packet as CasePacket, token };
  });
}
export async function heartbeat(id: string, token: string) {
  const result = await pool.query("UPDATE live_runs SET lease_until=now()+interval '30 seconds' WHERE id=$1 AND lease_token=$2 AND lease_until > now() RETURNING requested", [id, token]);
  if (!result.rowCount) throw new Error('Worker lease lost');
  return result.rows[0].requested as string;
}
export async function checkpoints(id: string): Promise<Checkpoint[]> {
  return (await pool.query("SELECT role,phase,artifact FROM live_tasks WHERE run_id=$1 AND status='sealed'", [id])).rows;
}
/** Decide seats B or C that ended without a submission. They are terminal and never re-run (spec revision 2). */
export async function failedSeats(id: string): Promise<Role[]> {
  return (await pool.query("SELECT role FROM live_tasks WHERE run_id=$1 AND phase='decide' AND status='failed' AND role IN ('judge_b','judge_c')", [id])).rows.map(r => r.role);
}
/** Record a panel seat B or C failure; the run goes on and the panel routes the case to a person. */
export async function failTask(id: string, token: string, role: Role, phase: Phase, reason: string, interrupted?: () => boolean) {
  if (phase !== 'decide' || !['judge_b', 'judge_c'].includes(role)) throw new Error('Only panel seats B and C may fail without failing the run');
  return tx(async c => {
    const run = await locked(c, id, token);
    const result = await c.query("UPDATE live_tasks SET status='failed',artifact=$4 WHERE run_id=$1 AND role=$2 AND phase=$3 AND status='running'", [id, role, phase, { failed: reason.slice(0, 300) }]);
    if (!result.rowCount) throw new Error('Task is no longer active');
    await event(c, run, role, phase, { kind: 'role_failed', message: `${role} did not finish: ${reason.slice(0, 300)}. The panel sends the case to a person.` });
    await disclose(c, run, phase, interrupted);
    // An interruption that lands while the decision is being written rolls the whole step back.
    if (phase === 'decide' && interrupted?.()) throw new Error('Run interrupted before the decision was saved');
  });
}
export async function beginTask(id: string, token: string, role: Role, phase: Phase, sessionId: string) {
  return tx(async c => {
    const run = await locked(c, id, token);
    if (run.requested !== 'run') return false;
    // No step starts while the chat reading's latest handoff is not cleared for fare review.
    const chat = (await chatCycle(c, id)).prior;
    if (chat && chat.status !== 'cleared_for_fare_review') return false;
    await c.query("INSERT INTO live_tasks VALUES($1,$2,$3,$4,'running',NULL)", [id, role, phase, sessionId]);
    await event(c, run, role, phase, { kind: 'handoff_accepted', message: `${role} started ${phase}`, data: { sessionId } });
    return true;
  });
}
export async function appendActivity(id: string, token: string, actor: string, phase: string, activity: Activity) {
  return tx(async c => event(c, await locked(c, id, token), actor, phase, activity));
}
export async function sealTask(id: string, token: string, role: Role, phase: Phase, artifact: Artifact, interrupted?: () => boolean) {
  return tx(async c => {
    const run = await locked(c, id, token);
    const result = await c.query("UPDATE live_tasks SET status='sealed',artifact=$4 WHERE run_id=$1 AND role=$2 AND phase=$3 AND status='running'", [id, role, phase, artifact]);
    if (!result.rowCount) throw new Error('Task is no longer active');
    await event(c, run, role, phase, { kind: 'submission_sealed', message: `${role} submission saved; awaiting paired disclosure` });
    await disclose(c, run, phase, interrupted);
    // The chat reading's hold commits with the reading itself (MVP fixes, 10 October 2026), so no worker loss between the two
    // can leave a sealed threat reading without its safety handoff.
    const flagged = phase === 'collect' && role === 'evidence' && hasEvidenceChecks(run.packet) ? chatSafetyReadings(artifact) : [];
    if (flagged.length) await chatHold(c, run, chatSafetyHandoff(flagged));
    // An interruption that lands while the decision is being written rolls the whole step back.
    if (phase === 'decide' && interrupted?.()) throw new Error('Run interrupted before the decision was saved');
  });
}
/**
 * The second safety opinion (MVP fixes, 10 October 2026; owner decision D5, stop early), the worker's call before each phase
 * after the Evidence Collector when its sealed chat reading found a possible threat or abusive wording. The first call opens
 * the safety handoff, with the same meaning as the safety screen's and its own kind; while the latest chat-reading handoff is
 * not cleared for fare review, every call asks the run to pause (a stop stays a stop) and returns true, so the worker lets go
 * at this boundary. Cleared, it returns false and the run goes on; resuming needs that clearance too (controlRun).
 */
export async function holdForChatReading(id: string, token: string, handoff: ChatSafetyHandoff) {
  return tx(async c => chatHold(c, await locked(c, id, token), handoff));
}
/**
 * The hold itself, inside the caller's transaction on a locked, leased run: sealTask opens it with the reading, the worker asks
 * again. A clearance taken back after the run went on (a person changed the cleared handoff to assigned or referred while the
 * next step ran) opens a new hold cycle, carrying that handoff's state: the slot rule and the page measure a resume or a
 * started step against the latest cycle, so the paused run holds no slot and shows as held again.
 */
async function chatHold(c: PoolClient, run: any, handoff: ChatSafetyHandoff) {
  const { prior, wentOn } = await chatCycle(c, run.id);
  if (prior?.status === 'cleared_for_fare_review') return false;
  if (!prior) {
    await pauseFor(c, run);
    await event(c, run, 'coordinator', 'triage', { kind: 'review_requested', message: 'Safety handoff opened: the chat reading found a possible threat or abusive wording. No later model task started; no account action executed.', data: handoff });
  } else if (wentOn) await chatHoldAgain(c, run, { ...handoff, status: prior.status ?? 'unassigned', owner: prior.owner ?? null });
  else await pauseFor(c, run);
  return true;
}
/** The chat reading's latest handoff state (`prior`), and whether the run went on (a resume, a started step) since its latest hold cycle. */
async function chatCycle(c: PoolClient, id: string) {
  const prior = (await c.query("SELECT event->'data' AS review FROM live_events WHERE run_id=$1 AND event->>'kind' IN ('review_requested','review_updated') AND event->'data'->>'kind'=$2 ORDER BY seq DESC LIMIT 1", [id, chatReadingKind])).rows[0]?.review;
  const asked = prior ? (await c.query("SELECT seq FROM live_events WHERE run_id=$1 AND event->>'kind'='review_requested' AND event->'data'->>'kind'=$2 ORDER BY seq DESC LIMIT 1", [id, chatReadingKind])).rows[0]?.seq : null;
  const wentOn = asked != null && !!(await c.query("SELECT 1 FROM live_events WHERE run_id=$1 AND seq>$2 AND (event->>'kind'='handoff_accepted' OR (event->>'kind'='control_requested' AND event->'data'->>'command'='resume')) LIMIT 1", [id, asked])).rowCount;
  return { prior, wentOn };
}
/** Ask the run to pause at its next boundary, as controlRun does; a stop stays a stop. */
async function pauseFor(c: PoolClient, run: any) {
  if (run.requested !== 'stop') await c.query("UPDATE live_runs SET requested='pause',status=$2 WHERE id=$1", [run.id, run.valid_lease ? 'pausing' : 'paused']);
}
/** A new hold cycle, carrying the handoff as it stands: the run went on after a clearance that has since been taken back. */
async function chatHoldAgain(c: PoolClient, run: any, data: Record<string, unknown>) {
  await pauseFor(c, run);
  await event(c, run, 'coordinator', 'triage', { kind: 'review_requested', message: 'The chat reading\'s handoff is no longer cleared for the fare review, so the run is held again before its next step. No account action executed.', data: { ...data, kind: chatReadingKind } });
}
async function disclose(c: PoolClient, run: any, phase: Phase, interrupted?: () => boolean) {
  const expected = phaseRoles(phase, run.packet);
  const rows = (await c.query("SELECT role,artifact,status FROM live_tasks WHERE run_id=$1 AND phase=$2 AND status IN ('sealed','failed')", [run.id, phase])).rows;
  const sealed = rows.filter(r => r.status === 'sealed');
  // Other phases disclose when every role is sealed. The decide phase aggregates once every seat is terminal and seat A is sealed.
  if (phase !== 'decide' ? sealed.length !== expected.length : expected.some(role => !rows.some(r => r.role === role)) || !sealed.some(r => r.role === 'judge')) return;
  if ((await c.query("SELECT 1 FROM live_events WHERE run_id=$1 AND event->>'phase'=$2 AND event->>'kind' IN ('disclosed','decision_proposed')", [run.id, phase])).rowCount) return;
  // A stop committed before this transaction publishes no decision; sealed and failed seats stay in the audit.
  // The same holds for a worker interrupted (shutdown, lost lease, seat A failing) before this point.
  if (phase === 'decide' && (run.requested === 'stop' || interrupted?.())) return;
  if (phase !== 'decide') {
    await event(c, run, 'coordinator', phase, { kind: 'disclosed', message: 'Both sealed submissions released together', data: Object.fromEntries(sealed.map(s => [`${s.role}_${phase}`, s.artifact])) });
    return;
  }
  const screening = triage(run.packet);
  const integrity = (await c.query("SELECT event->'data' AS data FROM live_events WHERE run_id=$1 AND event->>'kind'='integrity_checked' ORDER BY seq DESC LIMIT 1", [run.id])).rows[0]?.data;
  const photo = (await c.query("SELECT artifact FROM live_tasks WHERE run_id=$1 AND phase='examine' AND role='photo' AND status='sealed'", [run.id])).rows[0]?.artifact;
  const observations = (await c.query("SELECT artifact FROM live_tasks WHERE run_id=$1 AND phase='collect' AND role='evidence' AND status='sealed'", [run.id])).rows[0]?.artifact;
  const models = Object.fromEntries((await c.query("SELECT DISTINCT ON (event->>'actor') event->>'actor' AS actor, event->'data'->>'model' AS model FROM live_events WHERE run_id=$1 AND event->>'kind'='model_reported' AND event->'data'->>'model' NOT IN ('default-model','unknown') ORDER BY event->>'actor', seq", [run.id])).rows.map(r => [r.actor, r.model]));
  const results: SeatResult[] = expected.map(role => { const row = rows.find(r => r.role === role)!; return row.status === 'sealed' ? { role, artifact: row.artifact, model: models[role] ?? null } : { role, failed: row.artifact?.failed ?? 'did not finish', model: models[role] ?? null }; });
  const { panel, ...routing } = routePanel(results, panelRoutingContext(run.packet, { safetyInvolved: safetyForRouting(run.packet, screening, observations), exposure: screening.exposure, ...routingPrecedents(run.packet) }, { integrity, photo }));
  const anchor = results.find(r => r.role === 'judge')!.artifact as any;
  await event(c, run, 'judge', phase, { kind: 'decision_proposed', message: routing.route === 'human_review' ? 'Proposal routed to a person before release. No payment executed.' : 'Recommendation released for review or appeal. No payment executed.', data: { ...anchor, routing, confidenceScore: scoreRun(anchor, panel), ...(panel ? { panel: scorePanelSeats(panel, anchor) } : {}) } });
  if (routing.route === 'human_review') await event(c, run, 'coordinator', 'triage', { kind: 'review_requested', message: 'Routed to a person before release: ' + routing.reasons.map(r => r.code).join(', ') + '. No reviewer has been assigned.', data: { status: 'unassigned', owner: null, kind: 'merits_review', note: anchor.reasoning, reviewReasons: anchor.reviewReasons, routing } });
}
/** `detail`: what the operator reads in the trail beside the person's message (the step's failure labels, an unsupported run's reason). */
export async function releaseRun(id: string, token: string, completed = false, error?: string, detail?: Record<string, unknown>) {
  return tx(async c => {
    const run = await locked(c, id, token);
    const status = run.requested === 'stop' ? 'stopped' : error ? 'failed' : completed ? 'completed' : run.requested === 'pause' ? 'paused' : 'queued';
    await c.query("UPDATE live_tasks SET status='failed' WHERE run_id=$1 AND status='running'", [id]);
    await c.query('UPDATE live_runs SET status=$2,lease_token=NULL,lease_until=NULL,error=$3,finished_at=CASE WHEN $2 IN (\'failed\',\'stopped\',\'completed\') THEN now() ELSE NULL END WHERE id=$1', [id, status, error ?? null]);
    await event(c, run, 'coordinator', 'control', { kind: status, message: error ?? (status === 'paused' ? 'Paused at a saved task boundary. Resume continues from saved submissions.' : `Run ${status}.`), ...(detail ? { data: detail } : {}) });
  });
}
/**
 * A run as the page reads it. `held`: a server holds the run now; `age_seconds` and `lease_expired_seconds` are counted on the
 * database's clock, so the page can say a run waits for a server, or that its server stopped, without trusting the browser's
 * clock (owner review, 8 October 2026).
 */
export const runQuery = `SELECT id,workspace_id,packet,packet_hash,status,requested,created_at,finished_at,error,
    (lease_token IS NOT NULL AND lease_until > now()) AS held, floor(extract(epoch FROM now()-created_at))::int AS age_seconds,
    CASE WHEN lease_until IS NOT NULL AND lease_until <= now() THEN floor(extract(epoch FROM now()-lease_until))::int END AS lease_expired_seconds
    FROM live_runs WHERE id=$1`;
/** Full read verifies the whole chain. With `since`, the caller already holds events up to that seq and gets only the tail plus run status; the chain is still verified server-side. */
export async function readLiveRun(id: string, since = 0) {
  const run = (await pool.query(runQuery, [id])).rows[0];
  if (!run) throw new Error('Run not found');
  const rows = (await pool.query('SELECT * FROM live_events WHERE run_id=$1 ORDER BY seq', [id])).rows;
  let previous = hash(canonical(run.packet));
  if (previous !== run.packet_hash) throw new Error('Packet integrity check failed');
  const events = rows.map((row, index) => {
    if (row.seq !== index + 1 || row.event.seq !== row.seq || row.previous_hash !== previous || row.hash !== hash(previous + canonical(row.event))) throw new Error('Event integrity check failed');
    previous = row.hash; return { ...row.event, hash: row.hash, previousHash: row.previous_hash };
  });
  if (since > 0) {
    const { packet: _packet, ...status } = run;
    return { mode: 'live' as const, protocolVersion: 2, run: status, events: events.filter(e => e.seq > since), total: events.length, integrity: 'verified' as const };
  }
  const tasks = (await pool.query('SELECT role,phase,session_id,status FROM live_tasks WHERE run_id=$1 ORDER BY phase,role', [id])).rows;
  const savedSubmissions = ['failed', 'stopped', 'completed'].includes(run.status) ? await checkpoints(id) : undefined;
  return { mode: 'live' as const, protocolVersion: 2, run, events, tasks, savedSubmissions, total: events.length, integrity: 'verified' as const };
}

/** Remove a case from the operator's list. Audit rows are immutable by trigger, so this archives; nothing is destroyed and no active run may exist. */
export async function archiveWorkspace(id: string) {
  return tx(async c => {
    const w = (await c.query('SELECT id,archived_at FROM live_workspaces WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!w) throw new Error('Workspace not found');
    const active = Number((await c.query("SELECT count(*) FROM live_runs WHERE workspace_id=$1 AND status IN ('queued','running','pausing','paused','stopping')", [id])).rows[0].count);
    if (active) throw new Error('Stop the active run before deleting this case.');
    await c.query('UPDATE live_workspaces SET archived_at=now() WHERE id=$1 AND archived_at IS NULL', [id]);
    return { id, archived: true };
  });
}
/** Star or unstar a case (4 October, user request): starred cases come first in the case picker for everyone on the
 *  shared login. Only the time is stored; nothing about a run changes. */
export async function starWorkspace(id: string, starred: boolean) {
  const row = (await pool.query('UPDATE live_workspaces SET starred_at=CASE WHEN $2 THEN now() END WHERE id=$1 AND archived_at IS NULL RETURNING id,starred_at', [id, starred])).rows[0];
  if (!row) throw new Error('Workspace not found');
  return { id: row.id as string, starred_at: row.starred_at ? new Date(row.starred_at).toISOString() : null };
}
// A field of an event only when it is a JSON string, else NULL: #>> alone turns a number into text and an object into
// its JSON, which the catalog would then read as a status or an owner that the run's own trail does not have.
const jsonText = (path: string, from = 'event') => `CASE WHEN jsonb_typeof(${from}#>'{${path}}')='string' THEN ${from}#>>'{${path}}' END`;
/** A field of an event only when it is a JSON number, kept as JSON (no text cast), else NULL. */
const jsonNumber = (path: string, from = 'event') => `CASE WHEN jsonb_typeof(${from}#>'{${path}}')='number' THEN ${from}#>'{${path}}' END`;
/**
 * The case picker's rows. `queue_events` (added 3 October, optional for older clients) is the latest run's decision and
 * handoff events, trimmed to what the response-time targets read (sla.ts): time, kind, route, reason codes, handoff kind,
 * status and owner, each only when it is a string; for a decision also its outcome, recommended amount and the amount under
 * each open question's other reading, each only when it is a number (the money at stake, sla.ts stakeCents; owner, 11 October
 * 2026), and on a panel run each finished seat's recommended amount. Never reason texts, notes or the decision itself. The events are found by the same predicate as the partial index
 * live_events_queue (schema.ts), written identically so it is used. `exposure` is the intake screen's disputed charge and
 * extra loss (triage.ts), from the run's first `triage_completed` event, looked for among its first 20 events only so the
 * primary key's order finds it without reading the whole trail (it is the third event of a run today).
 */
export const catalogQuery = `SELECT w.id,w.case_id,w.created_at,w.starred_at,w.title AS custom_title,w.category,w.posture,
    (SELECT count(*)::int FROM live_documents d WHERE d.workspace_id=w.id) AS documents,
    (SELECT count(*)::int FROM live_runs n WHERE n.workspace_id=w.id) AS runs,
    r.id AS run_id,r.status,r.created_at AS run_created_at,r.finished_at AS run_finished_at,
    (SELECT json_agg(json_build_object('seq',seq,'at',${jsonText('at')},'kind',event->>'kind','route',${jsonText('data,routing,route')},
      'reasons',CASE WHEN jsonb_typeof(event#>'{data,routing,reasons}')='array' THEN (SELECT json_agg(${jsonText('code', 'x')}) FROM jsonb_array_elements(event#>'{data,routing,reasons}') x) END,
      'handoff',${jsonText('data,kind')},'status',${jsonText('data,status')},'owner',${jsonText('data,owner')},
      'outcome',${jsonText('data,outcome')},'amount',${jsonNumber('data,remedy,amountCents')},
      'others',CASE WHEN jsonb_typeof(event#>'{data,reviewReasons}')='array' THEN (SELECT json_agg(${jsonNumber('otherReading,remedyCents', 'y')}) FROM jsonb_array_elements(event#>'{data,reviewReasons}') y) END,
      'seats',CASE WHEN jsonb_typeof(event#>'{data,panel,seats}')='array' THEN (SELECT json_agg(${jsonNumber('remedy,amountCents', 'z')}) FROM jsonb_array_elements(event#>'{data,panel,seats}') z
        WHERE jsonb_typeof(z#>'{outcome}')='string' AND z#>'{outcome}'<>to_jsonb('human_review'::text) AND z->'failed' IS NULL) END) ORDER BY seq)
     FROM live_events WHERE run_id=r.id AND ${queueEventPredicate}) AS queue_events,
    (SELECT json_build_object('kind','triage_completed','disputed',${jsonNumber('data,exposure,disputed_charge_cents')},'additional',${jsonNumber('data,exposure,additional_loss_cents')})
     FROM live_events WHERE run_id=r.id AND seq<=20 AND event->>'kind'='triage_completed' ORDER BY seq LIMIT 1) AS exposure
    FROM live_workspaces w LEFT JOIN LATERAL
    (SELECT id,status,created_at,finished_at FROM live_runs WHERE workspace_id=w.id ORDER BY created_at DESC LIMIT 1) r ON true
    WHERE w.policy_basis='reviewed-public' AND w.archived_at IS NULL ORDER BY w.starred_at IS NULL, w.created_at DESC LIMIT 100`;
/**
 * The other copies of the sample cases the catalog lists (case-groups.ts), whatever their age: a picker row must hold every
 * copy, or an older copy's run and its delete would be missed. Same projection; only the filter differs.
 */
export const catalogCopiesQuery = catalogQuery.replace(/WHERE w\.policy_basis='reviewed-public' AND w\.archived_at IS NULL ORDER BY [^`]*$/,
  "WHERE w.policy_basis='reviewed-public' AND w.archived_at IS NULL AND w.case_id<>'CUSTOM' AND w.case_id = ANY($1::text[]) AND NOT (w.id = ANY($2::uuid[]))");
/**
 * The public copy's list (owner, 12 October 2026): the same rows, only for the cases in its reach (public-scope.ts), chosen
 * inside the query so the 100-row limit never pushes a shown case off. Custom uploads never show.
 */
export const publicCatalogQuery = catalogQuery.replace("WHERE w.policy_basis='reviewed-public' AND w.archived_at IS NULL ORDER BY",
  "WHERE w.policy_basis='reviewed-public' AND w.archived_at IS NULL AND w.case_id<>'CUSTOM' AND w.case_id = ANY($1::text[]) ORDER BY");
if (publicCatalogQuery === catalogQuery) throw new Error('The public catalog filter no longer matches the catalog query');
export async function listWorkspaces(scope?: PublicScope) {
  const rows = (await (scope ? pool.query(publicCatalogQuery, [[...scope.cases]]) : pool.query(catalogQuery))).rows;
  const keys = new Set(rows.map(groupKey)), cases = [...new Set(rows.filter(r => groupKey(r).startsWith('sample:')).map(r => r.case_id as string))];
  const copies = cases.length ? (await pool.query(catalogCopiesQuery, [cases, rows.map(r => r.id)])).rows.filter(r => keys.has(groupKey(r))) : [];
  return [...rows, ...copies].map(catalogRow);
}
/** One SQL row of listWorkspaces as the API returns it. Pure, so the mapping is tested without a database. */
export const catalogRow = <W extends Record<string, any>>(w: W): Omit<W, 'title' | 'queue_events' | 'exposure'> & { title: string; queue_events: QueueEvent[] } => {
  // The intake screen's amounts travel as one more trimmed event (sla.ts queueEventsFromRow), so the picker's money at stake
  // comes from the same reader as the case summary's.
  const { exposure, ...row } = w, events = Array.isArray(w.queue_events) ? w.queue_events : [];
  return { ...row, title: w.custom_title || liveCase(w.case_id).title, queue_events: queueEventsFromRow(exposure ? [exposure, ...events] : events) } as Omit<W, 'title' | 'queue_events' | 'exposure'> & { title: string; queue_events: QueueEvent[] };
};
