// The public copy's cases (owner, 12 October 2026). ryde-resolve.pages.dev reads only these, each run in full (every event,
// so a visitor can re-check the hash chain); every other case, run, photo and file answers as if it did not exist. Server
// only: no page imports this list. A case joins by a release (this list), by a star on the operator site, or by a past
// ruling the Library shows (store.ts publicScope). Custom uploads never show: they share one case ID and may hold real files.
export const shownCaseIds: readonly string[] = [
  'DISP-004', // a no-show fee
  'DISP-109', // a taxi route
  'DISP-127', // a cleaning claim with photos
];
/** Workspaces a public page links by ID, readable even if their picker rows are archived later. None in this copy. */
export const examWorkspaceIds: readonly string[] = [];

/** What a visitor may read: whole cases (their unarchived workspaces), plus workspaces a public page links by ID. */
export type PublicScope = { cases: ReadonlySet<string>; workspaces: ReadonlySet<string> };
export type ScopedWorkspace = { id: string; case_id: string; archived_at?: Date | string | null };
export function mayView(scope: PublicScope, w: ScopedWorkspace): boolean {
  if (w.case_id === 'CUSTOM') return false;
  return (!w.archived_at && scope.cases.has(w.case_id)) || scope.workspaces.has(w.id);
}
