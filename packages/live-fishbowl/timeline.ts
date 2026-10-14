// The run timeline in the Status column (3 October, user request): one line per step, in run order, the safety screen
// and the record check first and the release check last. Pure, and built from the same gate views and progress the run
// row uses, so the two never disagree.
import type { GateTone } from './gates';
import type { PhaseProgress, RoleStatus } from './progress';
import { roleLabels } from './roles';

/** `state` is the short line shown; `detail`, when set, is the whole per-agent account (the row's tooltip). */
export type TimelineRow = { key: string; label: string; state: string; detail?: string; kind: 'gate' | 'step'; tone: string };
type Gate = { tone: GateTone; word: string };
const stepWords: Record<Exclude<PhaseProgress['status'], 'working'>, string> = { pending: 'Waiting', done: 'Done', failed: 'Failed', stopped: 'Stopped', skipped: 'Did not run' };
const roleWords: Record<RoleStatus, string> = { pending: 'waiting', working: 'working', sealed: 'done', failed: 'failed', stopped: 'stopped', skipped: 'did not run' };

const seatLetter: Record<string, string> = { judge: 'A', judge_b: 'B', judge_c: 'C' };
const names = (roles: PhaseProgress['roles']) => roles.length > 1 && roles.every(r => r.role in seatLetter)
  ? 'Arbitrators ' + roles.map(r => seatLetter[r.role]).join(' and ')
  : roles.map(r => roleLabels[r.role] ?? r.role).join(' and ');
/** The short state of a step with more than one agent, short enough for one line in the Status column. */
function shared(p: PhaseProgress) {
  const working = p.roles.filter(r => r.status === 'working'), failed = p.roles.filter(r => r.status === 'failed'), done = p.roles.filter(r => r.status === 'sealed');
  if (p.status === 'failed') return failed.length === p.roles.length ? (p.roles.length === 2 ? 'Both failed' : 'All failed') : `${names(failed)} failed`;
  if (working.length === p.roles.length) return p.roles.length === 2 ? 'Both working' : 'All working';
  if (working.length) return `${names(working)} working`;
  return `${done.length} of ${p.roles.length} done`;
}
/** One row per step, one short line each. A step with two agents says who is at work ("Driver working"), and its row
 *  carries the whole account ("Rider done, Driver working") as a tooltip. While the run loads, steps say so. */
export function timelineRows(progress: PhaseProgress[], gates: { screen: Gate; record?: Gate; release: Gate }, loading = false): TimelineRow[] {
  const gate = (key: string, label: string, g: Gate): TimelineRow => ({ key, label, state: g.word, kind: 'gate', tone: g.tone });
  const step = (p: PhaseProgress): TimelineRow => {
    if (loading) return { key: p.phase, label: p.label, state: 'Loading', kind: 'step', tone: 'pending' };
    const many = p.roles.length > 1 && (p.status === 'working' || p.status === 'failed');
    const state = many ? shared(p) : p.status === 'working' ? 'Working' : stepWords[p.status];
    return { key: p.phase, label: p.label, state, ...(many ? { detail: p.roles.map(r => `${roleLabels[r.role] ?? r.role} ${roleWords[r.status]}`).join(', ') } : {}), kind: 'step', tone: p.status };
  };
  return [gate('screen', 'Safety screen', gates.screen), ...(gates.record ? [gate('record', 'Record check', gates.record)] : []), ...progress.map(step), gate('release', 'Release check', gates.release)];
}
