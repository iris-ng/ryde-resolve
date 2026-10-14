import { runMessages } from '../../../../packages/live-fishbowl/messages';
import { chatHold, heldForNewEvidence } from '../../../../packages/live-fishbowl/gates';
import type { Event, Run } from './use-lab';

/** A run the chat reading holds (MVP fixes, 10 October 2026). New wording, for the owner to approve; no full stop, like the run messages. */
export const chatHoldMessages = {
  held: 'Held for a safety check. The Evidence Collector read a chat message as a possible threat or abuse, so a person must look before the other agents run',
  cleared: 'Cleared for the fare review after the chat reading. Resume the run to start the other agents',
  /** A safety document uploaded during the run: it can never resume, whatever was cleared since (store.ts controlRun). */
  newEvidence: 'New safety evidence arrived during this run, so it cannot go on. Stop it and start a new run to include the new document',
} as const;

/**
 * The public copy's words for the same notes (owner, 11 October 2026): a visitor there cannot resume, stop or start a run, so the
 * steps the team takes are said as the team's, not asked of the reader. The operator site keeps the owner's approved wording.
 */
const viewerSteps: [string | RegExp, string][] = [
  [/Resume the run (below |from the Status column )?to start the other agents/g, 'The team resumes the run to start the other agents'],
  ['Assign a reviewer and read the original chat. Once the reviewer clears it for the fare review, resume the run from the Status column', 'A reviewer reads the original chat. Once they clear it for the fare review, the team resumes the run'],
  [/; resume the run to (go on|start them)/g, '; the team resumes the run to $1'],
  [/\. Stop it and start a new run to include the new document/g, '. A new run would include the new document'],
  [/(^|\. )Start a new run to include/g, '$1A new run would include'],
  [/: start a new run to include it/g, ': a new run would include it'],
  [/, so it is on hold\. Start a new run to include the new evidence/g, ', so it is on hold. A new run would include the new evidence'],
  [/\. Please start a new run/g, '. The team can start a new run'],
  [/; (stop this run and )?start a new run to include/g, '; a new run would include'],
  [/\. Please try (this run )?again( later| in a few minutes)?/g, ''],
  [/^Start a run\. /, 'No run yet. '],
  [/: withdraw it if it turns out wrong/g, ': the team withdraws it if it turns out wrong'],
  [/\. If it has not started in 5 minutes, stop it and try again later/g, ''],
  [/ to start a new run$/g, ''],
];
export const forViewers = (text: string) => viewerSteps.reduce<string>((t, [from, to]) => t.replace(from, to), text);

/** A queued run with no server for a minute waits for one; a server whose hold ran out 90 seconds ago (about two minutes after its last sign of life) has stopped. */
export const noServerAfterSeconds = 60, serverGoneAfterSeconds = 90;
/** Stopped at the safety screen: paused before any agent started, with the screen's handoff open and never resumed (store.ts startRun). */
export const safetyStopped = (events: Event[], status: string) => status === 'paused' && !events.some(e => e.kind === 'handoff_accepted' || (e.kind === 'control_requested' && e.data?.command === 'resume'))
  && events.some(e => e.kind === 'review_requested' && e.phase === 'triage' && e.data?.kind !== 'merits_review');
/** A failed run's message. Runs that failed before 8 October 2026 stored the operator's wording; they read as the new messages. */
export function failureText(error?: string | null) {
  if (!error) return runMessages.agentProblem;
  if (error.startsWith('A model task failed validation')) return runMessages.agentProblem;
  if (error.startsWith('Worker disconnected') || error.startsWith('Run interrupted')) return runMessages.serverStopped;
  if (error.startsWith('This run pins ')) return runMessages.updating;
  return error;
}
/**
 * What the page says about a run that has no recommendation and will not get one soon (owner review, 8 October 2026): one
 * place, so the conversation and the status card never disagree and no screen waits forever.
 */
export function runNotice({ run, events, status, missing }: { run: Run | null; events: Event[]; status: string; missing?: boolean }): string | null {
  if (missing) return runMessages.runNotFound;
  if (!run) return null;
  // New safety evidence comes first: the run can never resume, so no other hold's "resume" may show.
  if (heldForNewEvidence(events) && !events.some(e => e.kind === 'decision_proposed')) return chatHoldMessages.newEvidence;
  if (safetyStopped(events, status)) return runMessages.safetyStop;
  // Held by the chat reading (MVP fixes, 10 October 2026): the Evidence Collector ran, and the rest waits for a person.
  const hold = chatHold(events);
  if (hold && !hold.going && !events.some(e => e.kind === 'decision_proposed')) return hold.cleared ? chatHoldMessages.cleared : chatHoldMessages.held;
  // A cleaning claim returned at intake: the run ended before any agent, and the notice says why (owner decision, 8 October 2026).
  const returned = events.find(e => e.kind === 'intake_returned');
  if (returned) return returned.message;
  if (status === 'failed') return failureText(run.error);
  if (status === 'queued' && run.held === false && (run.age_seconds ?? 0) >= noServerAfterSeconds) return runMessages.noServer;
  if (['running', 'pausing', 'stopping'].includes(status) && run.held === false && (run.lease_expired_seconds ?? 0) >= serverGoneAfterSeconds) return runMessages.serverStopped;
  return null;
}
