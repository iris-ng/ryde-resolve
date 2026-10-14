// Pure view model for the live room strip: who is working, on what, in run order.
import { deskFor } from './roles';
export const desks = ['evidence', 'policy', 'rider', 'driver', 'judge'] as const;
export type Desk = typeof desks[number];
/** `line` says what a working desk is doing; `detail` names the source it last opened, if any. */
export type DeskState = { role: Desk; title: string; status: 'waiting' | 'working' | 'sealed' | 'ready' | 'attention' | 'stopped'; line: string; detail: string; reads: number };
type Ev = { seq: number; actor: string; phase: string; kind: string; sources?: string[]; message?: string };
const titles: Record<Desk, string> = { evidence: 'Evidence', policy: 'Policy', rider: 'Rider', driver: 'Driver', judge: 'Arbitrator' };
// What a working desk is doing, by role and phase, in words a first-time viewer can follow.
const other = (role: string) => role === 'rider' ? 'driver' : 'rider';
function phaseLine(role: string, phase: string, seats: number) {
  if (phase === 'examine') return 'reading the photos';
  if (phase === 'collect') return 'noting what each source shows';
  if (phase === 'apply') return 'checking which rules apply';
  if (phase === 'investigate') return `building the ${role}'s case`;
  if (phase === 'challenge') return `questioning the ${other(role)}'s case`;
  if (phase === 'respond') return `answering the ${other(role)}'s questions`;
  if (phase === 'decide') return seats > 1 ? `${seats} arbitrators weighing both sides` : 'weighing both sides';
  return 'working';
}
const activeStatuses = ['queued', 'running', 'pausing', 'paused', 'stopping'];
export function deskStates(events: Ev[], runStatus: string): DeskState[] {
  const ended = !activeStatuses.includes(runStatus) && runStatus !== 'not started';
  return desks.map(role => {
    let last: Ev | undefined, lastRead: Ev | undefined, reads = 0;
    const seats = new Set<string>();
    for (const e of events) {
      if (deskFor(e.actor) !== role) continue;
      if (e.kind === 'source_read') { reads++; lastRead = e; }
      if (e.kind === 'handoff_accepted' && e.phase === 'decide') seats.add(e.actor);
      if (['handoff_accepted', 'submission_sealed', 'decision_proposed', 'role_failed'].includes(e.kind)) last = e;
    }
    if (!last) return { role, title: titles[role], status: 'waiting', line: 'waiting', detail: '', reads };
    if (last.kind === 'handoff_accepted') {
      if (ended) return { role, title: titles[role], status: 'stopped', line: 'stopped', detail: '', reads };
      // A read from an earlier phase is not what the desk is doing now.
      const doc = lastRead && lastRead.seq > last.seq && lastRead.phase === last.phase ? lastRead.sources?.[0]?.split('/').at(-1) ?? '' : '';
      return { role, title: titles[role], status: 'working', line: phaseLine(last.actor, last.phase, seats.size), detail: doc ? `reading ${doc}` : '', reads };
    }
    if (last.kind === 'submission_sealed') return { role, title: titles[role], status: 'sealed', line: 'sealed', detail: '', reads };
    if (last.kind === 'role_failed') return { role, title: titles[role], status: 'attention', line: 'needs attention', detail: '', reads };
    return { role, title: titles[role], status: 'ready', line: 'ready', detail: '', reads };
  });
}
/** True when two strips would render identically; lets the page skip a re-render. */
export const sameDesks = (a: DeskState[], b: DeskState[]) => a.length === b.length && a.every((d, i) => d.status === b[i].status && d.line === b[i].line && d.detail === b[i].detail);
