import { randomUUID } from 'node:crypto';
import { hasEvidenceChecks, validateArtifact, type Executor, type Task } from '../agent-flow/contracts';
import { chatSafetyHandoff, chatSafetyReadings } from '../agent-flow/chat-checks';
import { currentFactsVersion } from '../case-packet/dataset';
import { precedentSetVersion } from '../policy/precedents';
import { disclosedBefore, nextStage, phaseRoles, withDerivedSources } from './model';
import { reportedFailure, type FailureCategory } from '../agent-flow/failure';
import { runMessages, stoppedRunMessage } from './messages';
import * as store from './store';

/** The store calls the worker makes. Tests pass an in-memory store; the service uses the database (store.ts). */
export type WorkerStore = Pick<typeof store, 'claimRun' | 'heartbeat' | 'checkpoints' | 'failedSeats' | 'beginTask' | 'appendActivity' | 'sealTask' | 'failTask' | 'releaseRun' | 'holdForChatReading'>;
/** Why this worker cannot work a run, or null. A run pinned with a newer facts version than this code computes would show its agents fewer facts than it pins, and a newer worker resuming it would add them between phases. */
export function unsupportedRun(packet: { factsVersion?: unknown; precedentSet?: { version?: unknown } }): string | null {
  const pinned = packet.factsVersion ?? 0;
  if (!(typeof pinned === 'number' && Number.isInteger(pinned) && pinned >= 0 && pinned <= currentFactsVersion)) return `This run pins facts version ${String(pinned)}, and this worker computes facts up to version ${currentFactsVersion}. No task was started. Release the worker together with the web service, then start a new run.`;
  // The past rulings a run sees are copied into its packet (precedents.ts pinPrecedents); a format this worker does not know is refused the same way.
  if (packet.precedentSet !== undefined && packet.precedentSet?.version !== precedentSetVersion) return `This run pins past rulings in format ${String(packet.precedentSet?.version)}, and this worker reads format ${precedentSetVersion}. No task was started. Release the worker together with the web service, then start a new run.`;
  return null;
}

/**
 * Per-task time limits. Run 830b3fe4 (DISP-013, 1 October) failed because seat A's third submission was accepted at 4 min 52 s
 * and the fixed five-minute limit fired while the session was closing: an accepted answer was thrown away and the run failed.
 * The decide step now has ten minutes (a Judge that is rejected twice regenerates a long decision each time), and a task
 * whose submission the tool has already accepted gets a short grace period to hand it back instead of being cut off.
 * Every other step has ten minutes too since 4 October (it had five): in run e761c1e9 (DISP-010) one long deepseek turn on a
 * slow OpenRouter host took 111 s and the next hung until the five-minute limit failed the rider's challenge step and the run.
 */
export type TaskLimits = { taskMs?: number; decideMs?: number; graceMs?: number;
  /** Awaited after each phase, outside every task deadline: the live worker drains role-child cleanup here so a closing child never overlaps the next phase. */
  afterPhase?: () => Promise<void> };
export const defaultTaskLimits = { taskMs: 600000, decideMs: 600000, graceMs: 60000 } as const;
/** A phase in which a step failed. The run then stops with the message for its steps' failure labels (messages.ts). */
class StepsFailed extends Error { constructor(readonly causes: FailureCategory[]) { super('A model task failed validation, timed out or disconnected. Accepted submissions were preserved; inspect the event trail.'); } }
export async function workOnce(execute: Executor, shutdown?: AbortSignal, onlyRunId?: string, limits: TaskLimits = {}, db: WorkerStore = store) {
  const run = await db.claimRun(onlyRunId);
  if (!run) return false;
  // Refused before any task, so no step of the run is worked on facts it does not pin.
  // The person sees that the site is being updated; the operator's reason stays in the run's trail (owner review, 8 October 2026).
  const unsupported = unsupportedRun(run.packet);
  if (unsupported) { await db.releaseRun(run.id, run.token, false, runMessages.updating, { reason: 'unsupported_run', detail: unsupported }); return true; }
  const control = new AbortController();
  const abort = () => control.abort();
  // A shutdown (a restart or a release) stops the run: the person is told the server stopped, not that an agent failed.
  let shutDown = false;
  const onShutdown = () => { shutDown = true; abort(); };
  shutdown?.addEventListener('abort', onShutdown, { once: true });
  if (shutdown?.aborted) onShutdown();
  // The fixed failure labels the steps reported (failure.ts), never their text: what the person is told depends on them.
  const causes: FailureCategory[] = [];
  const interrupted = () => control.signal.aborted;
  let requested = 'run', leaseLost = false, beating = false;
  const timer = setInterval(() => {
    if (beating) return;
    beating = true;
    void db.heartbeat(run.id, run.token).then(value => { requested = value; if (value === 'stop') abort(); })
      .catch(() => { leaseLost = true; abort(); }).finally(() => { beating = false; });
  }, 3000);
  try {
    for (;;) {
      const saved = await db.checkpoints(run.id), failed = await db.failedSeats(run.id), phase = nextStage(saved, run.packet, failed);
      // Nothing left to run: the last step committed before any interruption, so the run ends as completed (or stopped), not failed.
      if (!phase) { await db.releaseRun(run.id, run.token, true); break; }
      if (control.signal.aborted) throw new Error('Run interrupted');
      requested = await db.heartbeat(run.id, run.token);
      if (requested !== 'run') { await db.releaseRun(run.id, run.token); break; }
      // The second safety opinion (MVP fixes, 10 October 2026; owner decision D5, stop early): a pinned run whose sealed chat
      // reading found a possible threat or abusive wording goes to a person before the Policy Analyst and the advocates, as at the
      // safety screen. The store opens the hold in the transaction that seals the reading (sealTask); asked again before every
      // later phase, so nothing that requeues the run can skip it. Only the handoff cleared for fare review (then a resume) lets
      // the run go on (store.ts holdForChatReading, controlRun).
      const flagged = hasEvidenceChecks(run.packet) ? chatSafetyReadings(saved.find(s => s.role === 'evidence' && s.phase === 'collect')?.artifact) : [];
      if (flagged.length && await db.holdForChatReading(run.id, run.token, chatSafetyHandoff(flagged))) { await db.releaseRun(run.id, run.token); break; }
      const results = await Promise.allSettled(phaseRoles(phase, run.packet).filter(role => !saved.some(s => s.role === role && s.phase === phase) && !failed.includes(role)).map(async role => {
        const sessionId = randomUUID();
        if (!await db.beginTask(run.id, run.token, role, phase, sessionId)) return;
        const task: Task = { packet: structuredClone(withDerivedSources(run.packet, saved)), caseId: run.packet.caseId, runId: run.id, sessionId, role, phase, disclosed: structuredClone(disclosedBefore(phase, saved)), protocolVersion: 2, timeoutMs: phase === 'decide' ? (limits.decideMs ?? defaultTaskLimits.decideMs) : (limits.taskMs ?? defaultTaskLimits.taskMs) };
        const local = new AbortController();
        const stop = () => local.abort();
        control.signal.addEventListener('abort', stop, { once: true });
        if (control.signal.aborted) stop();
        // An accepted submission (the submit tool completed without an error) earns one grace period at the deadline.
        let accepted = false, graced = false;
        const onDeadline = () => { if (accepted && !graced) { graced = true; timeout = setTimeout(stop, limits.graceMs ?? defaultTaskLimits.graceMs); return; } stop(); };
        let timeout = setTimeout(onDeadline, task.timeoutMs);
        let writes = Promise.resolve(), writeError: unknown;
        let rejectAbort: () => void = () => {};
        const cancelled = new Promise<never>((_, reject) => { rejectAbort = () => reject(new Error('Model task stopped or timed out')); local.signal.addEventListener('abort', rejectAbort, { once: true }); if (local.signal.aborted) rejectAbort(); });
        try {
          const result = await Promise.race([execute(task, activity => {
            if (local.signal.aborted) return;
            if (activity.kind === 'tool_completed' && activity.message === 'submit_artifact') accepted = true;
            if (activity.kind === 'role_failed') causes.push(reportedFailure(activity.message));
            writes = writes.then(() => db.appendActivity(run.id, run.token, role, phase, activity)).catch(e => { writeError = e; stop(); });
          }, local.signal), cancelled]);
          await writes;
          if (writeError) throw writeError;
          // A shutdown, stop or lost lease can land while the activity writes drain. It seals no decide seat, so no decision is published.
          if (phase === 'decide' && control.signal.aborted) throw new Error('Run interrupted before the decision was saved');
          await db.sealTask(run.id, run.token, role, phase, validateArtifact(task, result), interrupted);
        } catch (error) {
          // A panel seat B or C that fails is recorded and the run goes on; the panel then routes the case to a person.
          // A stop, a lost lease or a shutdown is not a seat failure.
          if (phase === 'decide' && (role === 'judge_b' || role === 'judge_c') && !control.signal.aborted) { await db.failTask(run.id, run.token, role, phase, error instanceof Error ? error.message : 'failed', interrupted); return; }
          // This step's own time limit, not a stop of the whole run: the provider did not answer in time.
          if (local.signal.aborted && !control.signal.aborted) causes.push('timeout');
          // Seat A failing fails the run: stop the other seats now rather than waiting out their timeouts.
          if (phase === 'decide' && role === 'judge') control.abort();
          throw error;
        } finally {
          stop(); clearTimeout(timeout); control.signal.removeEventListener('abort', stop); local.signal.removeEventListener('abort', rejectAbort); await writes;
        }
      }));
      await limits.afterPhase?.().catch(() => {});
      if (results.some(r => r.status === 'rejected')) throw new StepsFailed(causes);
    }
  } catch (error) {
    if (!leaseLost) {
      const failed = error instanceof StepsFailed, interruptedRun = shutDown || (error instanceof Error && error.message.startsWith('Run interrupted'));
      const message = interruptedRun ? runMessages.serverStopped : failed ? stoppedRunMessage(error.causes) : runMessages.agentProblem;
      const detail = { reason: interruptedRun ? 'worker_stopped' : failed ? 'step_failed' : 'run_error', causes: [...new Set(causes)] };
      await db.releaseRun(run.id, run.token, false, requested === 'stop' ? undefined : message, requested === 'stop' ? undefined : detail).catch(() => {});
    }
  } finally {
    clearInterval(timer); shutdown?.removeEventListener('abort', onShutdown); control.abort();
  }
  return true;
}
