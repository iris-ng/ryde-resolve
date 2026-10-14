// Held-out evaluation manifest (spec revision 13). One helper decides whether a precedent is hidden from a case, used
// by precedent search, direct reads and binding checks alike. A precedent's own `evaluation_overlap` still counts.
import manifest from '../../evidence/evaluation-manifest.json';

export type EvaluationCase = { id: string; title: string; folder: string; base: string; set: string; excludedPrecedents: string[] };
export const evaluationCases = manifest.cases as EvaluationCase[];
/**
 * The organiser's own samples, relabelled ORG-xxx (owner, 13 October 2026), each with the team case it replaces in the picker, or
 * null when none stands behind it. An organiser sample is a scored case; one that replaces a team case also sees exactly the past
 * rulings that case sees.
 */
export const organiserCases: Record<string, string | null> = { 'ORG-001': null, 'ORG-002': 'DISP-002', 'ORG-003': null };
/** The scored cases: the evaluation set DISP-002 to DISP-008, the held-out calibration set DISP-009 to DISP-018, any held-out case the manifest adds, and the organiser samples. */
export const isScoredCase = (caseId: string) => /^DISP-0(0[2-9]|1[0-8])$/.test(caseId) || evaluationCases.some(c => c.id === caseId) || Object.hasOwn(organiserCases, caseId);
/** A card drafted from a person's override or confirmation (policy/loop.ts), stored in the live database rather than in policies/precedents. */
export const isReviewerCard = (precedent: { precedent_id: string; origin?: string }) => precedent.origin === 'reviewer_override' || precedent.origin === 'reviewer_confirmation' || precedent.precedent_id.startsWith('PREC-L-');
/**
 * Hidden from this case: a card tagged as overlapping it, one the manifest excludes for it, and every reviewer card on a
 * scored case, whatever case the card came from (a card from a demo or custom case must not steer a test case either).
 */
export function precedentHidden(precedent: { precedent_id: string; evaluation_overlap?: string[]; origin?: string }, caseId: string) {
  const hiddenFrom = (id: string) => (precedent.evaluation_overlap ?? []).includes(id) || !!evaluationCases.find(c => c.id === id)?.excludedPrecedents.includes(precedent.precedent_id)
    || (isReviewerCard(precedent) && isScoredCase(id));
  return hiddenFrom(caseId) || (Object.hasOwn(storyCopies, caseId) && hiddenFrom(storyCopies[caseId]))
    || (Object.hasOwn(organiserCases, caseId) && organiserCases[caseId] !== null && hiddenFrom(organiserCases[caseId]!));
}
/**
 * AD-8 (owner decision, 10 October 2026, docs/ARCHITECTURE-DECISIONS.md): a case built from another case's story, with its GPS laid on
 * real roads (evidence/tools/gps-stories/), sees exactly the past rulings its source sees. It is not itself a scored case, so a
 * person's decision on it can still draft a ruling.
 */
export const storyCopies: Record<string, string> = { 'DISP-114': 'DISP-003', 'DISP-115': 'DISP-004', 'DISP-116': 'DISP-012' };
