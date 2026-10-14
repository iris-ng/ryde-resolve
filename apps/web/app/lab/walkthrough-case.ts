import type { CaseRow } from './use-lab';
import { groupCases } from '../../../../packages/live-fishbowl/case-groups';

// The case the walkthrough opens when none is open: the demo case, DISP-018 (a promo code and a pending card entry; user,
// 7 October), at its newest finished run, else its newest run. "Newest" is by start time throughout, the one time both
// the case list and a case's run list carry. If the site has no run of it (deleted, or never
// run there), the first case in the case dropdown instead (user, 6 October), in the dropdown's own order
// (case-groups.ts: starred cases first, then the latest activity), at its newest run. The list knows only each copy's
// latest run, so once the demo case loads, lab.tsx moves to the newest finished run of any copy (demoRun below).
// 11 October 2026 (owner): Amirah's case, DISP-004, the one the demo film follows; DISP-018 before.
export const DEMO_CASE = 'DISP-004';
const started = (r: CaseRow) => r.run_created_at ?? r.created_at ?? '';
export function tourCase(cases: CaseRow[]): CaseRow | null {
  const demo = cases.filter(r => r.case_id === DEMO_CASE && r.run_id);
  const newest = [...demo].sort((a, b) => started(b).localeCompare(started(a)));
  return newest.find(r => r.status === 'completed') ?? newest[0] ?? groupCases(cases)[0]?.lead ?? null;
}
// The newest finished run among the open case's runs (every copy's, when the server lists them), if any.
export function demoRun(runs: { id: string; status: string; created_at: string; workspace_id: string }[]) {
  return runs.filter(r => r.status === 'completed').sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
}
