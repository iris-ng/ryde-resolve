// Plain words for the lab page (2 October plain-language pass). The code, the agents' prompts and the run records keep
// their own terms; this module only changes what a reader sees. Browser-safe: no server imports.
import { phaseLabels } from './progress';
import { criterionLabels } from '../agent-flow/reader-guides';

// A condition's code name inside model-written text ("the same blocker as arrival_at_pickup") reads as words (owner, 11 October 2026).
const conditionNames = new RegExp('\\b(' + Object.keys(criterionLabels).join('|') + ')\\b', 'g');

/**
 * Text written into a run's record before this pass (routing reasons, confidence lines, handoff notes) said "seat A" for
 * the panel's judges and used a few system words. Shown text goes through here; the record itself is never changed.
 */
export function plainText(text: string): string {
  return text
    .replace(/\b[Ss]eat ([ABC]) \(the anchor Judge\)/g, 'Arbitrator $1 (the main Arbitrator)')
    .replace(/\b[Ss]eats ([ABC](?:, [ABC])*(?:,? and [ABC])?)\b/g, 'Arbitrators $1')
    .replace(/\b[Ss]eat ([ABC])\b/g, 'Arbitrator $1')
    .replace(/\bNo two seats\b/g, 'No two arbitrators')
    .replace(/\b([Tt])he seats\b/g, (_, t: string) => (t === 'T' ? 'The' : 'the') + ' arbitrators')
    .replace(/\b(\d+|finished) seats\b/g, '$1 arbitrators')
    .replace(/\banchor Judge\b/g, 'main Arbitrator')
    // The site says "Arbitrator" for the Judge since 8 October (user request); records written before say "Judge".
    .replace(/\ba Judge\b/g, 'an Arbitrator').replace(/\bA Judge\b/g, 'An Arbitrator').replace(/\bJudges\b/g, 'Arbitrators').replace(/\bJudge\b/g, 'Arbitrator')
    .replace(/\bpinned packet\b/g, 'locked case file')
    .replace(/\bpacket\b/g, 'case file')
    .replace(/\bProposal\b/g, 'Recommendation').replace(/\bproposal\b/g, 'recommendation')
    .replace(conditionNames, name => name.replace(/_/g, ' '));
}

export const actorNames: Record<string, string> = {
  coordinator: 'System', operator: 'Operator', evidence: 'Evidence', policy: 'Policy', rider: 'Rider advocate', driver: 'Driver advocate',
  judge: 'Arbitrator', judge_b: 'Arbitrator B', judge_c: 'Arbitrator C', photo: 'Photo reader',
};
export const actorName = (actor: string) => actorNames[actor] ?? actor.replaceAll('_', ' ');
/** The step each phase is, in the words of the progress list. The advocates' first cases are shared under the phase 'disclose'. */
export const phaseName = (phase: string) => (phaseLabels as Record<string, string>)[phase] ?? ({ prepare: 'Set up', triage: 'Safety screen', disclose: phaseLabels.investigate, complete: 'Finish', control: 'Operator', review: 'Review' } as Record<string, string>)[phase] ?? phase.replaceAll('_', ' ');

const labels: Record<string, string> = {
  prepared: 'locked the case files for this run', document_received: 'added a document', triage_completed: 'ran the safety screen',
  integrity_checked: 'ran the record check', review_requested: 'asked a person to review', review_updated: 'updated the review',
  control_requested: 'sent an operator request', handoff_requested: 'started the next step', handoff_accepted: 'started its step',
  runtime_configured: 'set up its session', session_started: 'opened its session', model_reported: 'confirmed its AI model',
  usage_reported: 'reported its usage', source_read: 'read a document', lookup_read: 'looked something up in the case record', precedent_read: 'read a past ruling',
  tool_requested: 'asked for a tool', tool_call_started: 'used a tool', tool_call_finished: 'finished with a tool', tool_completed: 'got a tool result',
  tool_error: 'had a tool error', tool_input_rejected: 'had an answer rejected by the checks', submission_rejected: 'had an answer rejected by the checks',
  submission_sealed: 'finished its step', submission_reused: 'reused an answer it already gave', disclosed: 'shared the work',
  readiness_assessed: 'counted the open questions', external_fetched: 'fetched outside data', decision_proposed: 'made its decision',
  role_failed: 'did not finish', completed: 'finished the run', failed: 'stopped the run', test_fixture: 'loaded test data',
  review_decided: 'recorded the final decision', precedent_reviewed: 'reviewed the drafted past ruling', intake_returned: 'returned the claim to the driver',
  semantic_searched: 'searched the past rulings by meaning',
};
export const eventLabel = (kind: string) => labels[kind] ?? kind.replaceAll('_', ' ');

type Ev = { actor: string; phase: string; kind: string; message: string; data?: any };
const shared: Record<string, string> = {
  examine: 'Shared the photo reading with every later step. It describes what the photos show; it is not a finding.',
  collect: 'Shared the evidence notes with every later step.', apply: 'Shared the rule check with every later step. It is not a ruling.',
};
/** A plain sentence for the commonest events; anything else shows its recorded message, in plain words where they differ. */
export function eventNote(e: Ev): string {
  if (e.kind === 'prepared') return 'This run uses a fixed copy of the case files and rules. Nothing it recommends is paid out.';
  if (e.kind === 'triage_completed') return e.data?.route && e.data.route !== 'ordinary' ? 'Lines were flagged, so a person reviews before any agent starts.' : 'No line flagged. This does not prove the trip was safe.';
  if (e.kind === 'handoff_requested') return `Asked ${actorName(String(e.message.match(/^Requested (\w+)/)?.[1] ?? ''))} to start.`.replace('Asked  to', 'Asked the next agent to');
  if (e.kind === 'submission_sealed') return ['investigate', 'challenge', 'respond'].includes(e.phase) ? 'Saved and kept private until both sides are shared at the same time.' : 'Saved.';
  if (e.kind === 'disclosed') return shared[e.phase] ?? 'Shared both sides\' work at the same time.';
  if (e.kind === 'readiness_assessed') return 'Counted unknown conditions, rule gaps and open evidence requests before the debate. Not a verdict.';
  if (e.kind === 'completed') return 'Every step and check finished. The result is a recommendation only.';
  if (e.kind === 'failed') return 'No ruling was made. The run status shows the step that failed.';
  if (e.kind === 'decision_proposed') return 'Recommendation ready. Nothing has been paid.';
  return plainText(e.message ?? '');
}

/** The two settings for unclear rules (posture.ts keeps its own words: they are part of the agents' instructions). */
export const postureText: Record<string, string> = {
  demo_decide_with_stated_assumptions: "Use the team's stated readings (not Ryde policy)",
  review_every_ambiguity: 'Send every unclear rule to a person',
};
/** The same reading as posture.ts postureLabel: no setting means review every ambiguity; any other preset decides with the readings. */
export const postureName = (p?: { preset?: string } | null) => !p || p.preset === 'review_every_ambiguity' ? postureText.review_every_ambiguity : postureText.demo_decide_with_stated_assumptions;
/** A handoff's state, and the button that moves it there. */
export const handoffState: Record<string, string> = { unassigned: 'not assigned yet', assigned: 'assigned', cleared_for_fare_review: 'cleared for the fare review', referred_to_specialist: 'referred to a specialist' };
export const handoffAction: Record<string, string> = { assigned: 'Assign', cleared_for_fare_review: 'Clear for the fare review', referred_to_specialist: 'Refer to a specialist' };
