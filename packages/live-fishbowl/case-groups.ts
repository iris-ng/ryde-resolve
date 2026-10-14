import { defaultPosture } from '../agent-flow/posture';

// The case picker lists cases, not workspaces (5 October 2026, user decision). Copies of one sample case that add no
// documents and use the same posture give an agent the same inputs, so they are one case to a reader: one picker row and
// one Run list across the copies. A custom case, or any workspace with added documents, stays its own row, since its
// inputs differ. Nothing in the database is merged; this is the grouping the picker and the workspace view share.

/** The fields the grouping reads from a catalog row or a workspace record. */
export type GroupInput = { id: string; case_id: string; documents?: number | null; posture?: unknown };
/** The fields the ordering reads from a catalog row (store.ts catalogQuery). */
export type ActivityInput = { created_at: string; status?: string | null; run_created_at?: string | null; run_finished_at?: string | null; starred_at?: string | null };

const activeStatuses = new Set(['queued', 'running', 'pausing', 'paused', 'stopping']);
// Postures compare by content: a workspace that never set one runs on the default, the same as one that set the default.
// Fields are read in a fixed order, since PostgreSQL's jsonb keeps keys in its own order, not the order they were written.
const postureKey = (posture: unknown) => {
  const p = (posture ?? defaultPosture) as { version?: unknown; mode?: unknown; preset?: unknown; allowedAssumptions?: unknown };
  return JSON.stringify([p.version ?? null, p.mode ?? null, p.preset ?? null, Array.isArray(p.allowedAssumptions) ? [...p.allowedAssumptions].map(String).sort() : null]);
};

/** Workspaces with equal keys are one case in the picker. */
export function groupKey(w: GroupInput): string {
  return w.case_id === 'CUSTOM' || (w.documents ?? 0) > 0 ? 'workspace:' + w.id : 'sample:' + w.case_id + ':' + postureKey(w.posture);
}

/** When a case last changed: its latest run's finish, or its start while the run is still going, else when the case was opened. */
export function lastActivity(r: ActivityInput): string {
  return r.run_finished_at ?? r.run_created_at ?? r.created_at;
}
const inProgress = (r: ActivityInput) => !!r.status && activeStatuses.has(r.status);
// Newest first, with runs still in progress above everything finished.
const byActivity = (a: ActivityInput, b: ActivityInput) =>
  Number(inProgress(b)) - Number(inProgress(a)) || Date.parse(lastActivity(b)) - Date.parse(lastActivity(a));

export type CaseGroup<T> = { key: string; lead: T; rows: T[]; starredAt: string | null };

/**
 * One group per case, ordered for the picker: starred cases first (the most recently starred on top), then the rest by
 * last activity. Within a group the copy with the latest activity leads: its run is the case's latest run and its status
 * is the case's status.
 */
export function groupCases<T extends GroupInput & ActivityInput>(rows: T[]): CaseGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const row of rows) { const key = groupKey(row); groups.set(key, [...(groups.get(key) ?? []), row]); }
  const list = [...groups].map(([key, members]) => {
    const sorted = [...members].sort(byActivity);
    const stars = members.flatMap(m => m.starred_at ? [m.starred_at] : []).sort((a, b) => Date.parse(b) - Date.parse(a));
    return { key, lead: sorted[0], rows: sorted, starredAt: stars[0] ?? null };
  });
  return list.sort((a, b) => !!b.starredAt === !!a.starredAt
    ? (a.starredAt && b.starredAt ? Date.parse(b.starredAt) - Date.parse(a.starredAt) : byActivity(a.lead, b.lead))
    : (b.starredAt ? 1 : -1));
}
