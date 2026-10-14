// Pure view model for the lab status column: the six phases, the roles each needs, and how far each got.
// Browser-safe: the phase order and role map come from roles.ts, shared with the worker and the store.
import type { Phase, Role } from '../agent-flow/contracts';
import { phaseOrder, phaseRoles } from './roles';
export { phaseRoles };
export const phases: Phase[] = phaseOrder.filter(p => p !== 'examine');
type Ev = { seq: number; actor: string; phase: string; kind: string };
export type RoleStatus = 'pending' | 'working' | 'sealed' | 'failed' | 'stopped' | 'skipped';
export type PhaseStatus = 'pending' | 'working' | 'done' | 'failed' | 'stopped' | 'skipped';
export type PhaseProgress = { phase: Phase; label: string; roles: { role: Role; status: RoleStatus }[]; status: PhaseStatus };
export const phaseLabels: Record<Phase, string> = { examine: 'Read the photos', collect: 'Gather the facts', apply: 'Check the rules', investigate: 'Craft arguments', challenge: 'Question the other side', respond: 'Answer the questions', decide: 'Decide' };
const activeStatuses = ['queued', 'running', 'pausing', 'paused', 'stopping'];
/** `seats` are the run's pinned decide seats (one Judge unless the run has a panel); `photos` adds the examine step. */
export function runProgress(events: Ev[], runStatus: string, seats: Role[] = ['judge'], photos = false): PhaseProgress[] {
  const ended = !activeStatuses.includes(runStatus) && runStatus !== 'not started';
  return (photos ? phaseOrder : phases).map(phase => {
    const roles = phaseRoles(phase, { panel: { seats } }).map(role => {
      let status: RoleStatus = 'pending';
      for (const e of events) {
        if (e.actor !== role || e.phase !== phase) continue;
        if (e.kind === 'handoff_accepted') status = 'working';
        else if (e.kind === 'submission_sealed' || e.kind === 'decision_proposed') status = 'sealed';
        else if (e.kind === 'role_failed') status = 'failed';
      }
      if (ended && status === 'pending') status = 'skipped';
      // A role at work when the run ended was stopped, unless the run failed: then it failed with it (a task timeout
      // records only the coordinator's failure).
      if (ended && status === 'working') status = runStatus === 'failed' ? 'failed' : 'stopped';
      return { role, status };
    });
    const all = (s: RoleStatus) => roles.every(r => r.status === s), any = (s: RoleStatus) => roles.some(r => r.status === s);
    // A panel seat B or C that fails is terminal, not a failed run: the decide phase fails only if seat A does.
    const failedPhase = phase === 'decide' && roles.length > 1 ? roles.find(r => r.role === 'judge')?.status === 'failed' : any('failed');
    if (phase === 'decide' && roles.length > 1 && !failedPhase && roles.every(r => r.status === 'sealed' || r.status === 'failed')) return { phase, label: phaseLabels[phase], roles, status: 'done' as PhaseStatus };
    const status: PhaseStatus = failedPhase ? 'failed' : any('stopped') ? 'stopped' : all('sealed') ? 'done' : any('working') || any('sealed') ? 'working' : all('skipped') ? 'skipped' : 'pending';
    return { phase, label: phaseLabels[phase], roles, status };
  });
}
/** A run's decide seats as its events show them: the panel's seats once any seat starts, else the single Judge. */
export function seatsFromEvents(events: { actor: string; phase: string; kind: string; data?: any; seq?: number }[]): Role[] {
  const panel = events.find(e => e.kind === 'decision_proposed')?.data?.panel?.seats?.map((s: { role: Role }) => s.role);
  if (panel?.length) return panel;
  const seen = [...new Set(events.filter(e => e.phase === 'decide' && ['judge', 'judge_b', 'judge_c'].includes(e.actor)).map(e => e.actor as Role))];
  return seen.some(r => r !== 'judge') ? (['judge', 'judge_b', 'judge_c'] as Role[]) : ['judge'];
}
