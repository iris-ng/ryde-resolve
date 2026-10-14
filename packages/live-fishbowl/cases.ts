import path from 'node:path';
import { loadDatasetPacket, datasetVersion, currentFactsVersion } from '../case-packet/dataset';
import { createHash } from 'node:crypto';
import { agentRule, rulesetPolicyVersion, rulesetProfile, selectRules } from '../policy/ruleset';
import { evaluationCases, type EvaluationCase } from '../policy/evaluation';

export const liveCases = [
  // The sample cases in this copy: three synthetic disputes, one no-show fee, one route and one cleaning claim with photos.
  // No answer keys ship with them. More cases join by adding a folder under evidence/disputes and a row here.
  { id: 'DISP-004', title: 'No-show fee · driver waited away from the pickup point', folder: 'DISP-004-no-show-wrong-location' },
  { id: 'DISP-109', title: 'Taxi route · Ang Mo Kio to Novena', folder: 'DISP-109-taxi-detour-unlisted-stop' },
  { id: 'DISP-127', title: 'Cleaning claim, two photos', folder: 'DISP-127-unseen-cleaning' },
  { id: 'CUSTOM', title: 'Custom case from uploaded documents' },
] as const;
export const customCategories = ['no_show', 'route_deviation', 'cleaning', 'safety', 'other'] as const;
export type CustomCategory = typeof customCategories[number];
export type LiveCaseId = typeof liveCases[number]['id'];
// Held-out cases join the catalogue from the evaluation manifest (static JSON, so the web build still traces only known files).
// Their manifest titles are bare ("Case 46 (promo)": the stories were sealed); the picker leads with the kind of dispute instead
// (owner, 14 October 2026: "label the case type rather than starting with e.g. case 56"), without touching the frozen manifest.
const examKinds: Record<string, string> = { promo: 'Promo', 'no-show': 'No-show fee', route: 'Route and toll', fare: 'Fare', cleaning: 'Cleaning claim', 'cancellation fee': 'Cancellation fee' };
export const pickerTitle = (title: string) => { const m = /^Case (\d+) \(([^)]+)\)$/.exec(title); return m ? `${examKinds[m[2]] ?? m[2]} · exam case ${m[1]}` : title; };
export const catalogueWith = (cases: readonly EvaluationCase[]): readonly { id: string; title: string; folder?: string }[] => [...liveCases.slice(0, -1), ...cases.map(c => ({ id: c.id, title: pickerTitle(c.title), folder: c.folder })), liveCases.at(-1)!];
export const catalogue = catalogueWith(evaluationCases);
export function liveCase(id: unknown) {
  const selected = catalogue.find(c => c.id === id);
  if (!selected) throw new Error('Unknown sample case');
  return selected;
}
export const isDisputeCase = (id: string) => /^(DISP|ORG)-\d{3}$/.test(id);
/** ORG-002 replaces DISP-002 in the operator's picker. DISP-002 stays in the catalogue so its earlier runs, the tests and the
 * practice and exam cases built from it still load. */
export const retiredFromPicker: ReadonlySet<string> = new Set(['DISP-002']);
export const disputesRoot = () => process.env.EVIDENCE_DISPUTES_ROOT ?? path.join(process.cwd(), 'evidence/disputes');
// Static folder map: no directory scanning, so the web build traces only these files.
export async function disputeFolder(id: string) {
  const selected = liveCase(id) as { folder?: string };
  if (!selected.folder) throw new Error('Not a dataset case: ' + id);
  return path.join(process.env.EVIDENCE_DISPUTES_ROOT ?? path.join(process.cwd(), 'evidence/disputes'), selected.folder);
}
/** A blank case: no base evidence, public rules pinned for the chosen dispute type; the operator uploads every document. Facts 4
 * (rules rebuild): with no structured ticket it has no branch, so a person decides it and no money is recommended (Task 20). */
export function customPacket(category: CustomCategory = 'other', title = 'Custom case'): CasePacketLike {
  const sha = (t: string) => createHash('sha256').update(t).digest('hex');
  const selection = selectRules({ category });
  const policies = selection.rules.map(rule => ({ rule_id: rule.id, ...agentRule(rule) }));
  const sources = selection.rules.map(rule => { const text = JSON.stringify(agentRule(rule), null, 2); return { id: `policy/public/${rule.id}.json`, text, lines: text.split('\n'), sha256: sha(text) }; });
  return { caseId: 'CUSTOM', title, sources, policies, policyProfile: rulesetProfile + ' This case has no dataset blocks: every fact must come from the uploaded documents (uploads/*), which remain untrusted content.', policyBasis: 'reviewed-public', datasetVersion,
    evidenceVersion: sha(JSON.stringify(sources.map(s => [s.id, s.sha256]))), factsVersion: currentFactsVersion, policyVersion: rulesetPolicyVersion(selection.selectedIds),
    policySelection: { category, tags: selection.tags, selectedIds: selection.selectedIds, conflictIds: selection.conflicts.map(c => c.id), unknownHints: [] } };
}
type CasePacketLike = Awaited<ReturnType<typeof loadDatasetPacket>>;
export async function loadLiveCase(id: string, options: { category?: string; title?: string } = {}) {
  if (id === 'CUSTOM') return customPacket((customCategories as readonly string[]).includes(options.category ?? '') ? options.category as CustomCategory : 'other', options.title || 'Custom case');
  if (isDisputeCase(id)) {
    const packet = await loadDatasetPacket(path.join(await disputeFolder(id), 'dataset.json'));
    if (packet.caseId !== id) throw new Error('Dataset case identity mismatch');
    return packet;
  }
  throw new Error('Unknown sample case');
}
