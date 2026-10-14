// The checks every past ruling passes, file card or reviewer card: the card library test (tests/retrieval.test.ts) runs
// them over policies/precedents, and approving a reviewer card runs them on the past rulings page (loop.ts cardProblems).
// One function, so the two can never drift. Plain messages: the review page shows them as they are.
import { allowedFeatureValues, featureKeys } from './retrieval';
import { ruleById } from './ruleset';
import { isReviewerCard } from './evaluation';
import type { FeatureValue, Precedent } from './precedents';

/** A file card's overlap tags name scored cases; a reviewer card's names the demo or test case it came from. */
const scoredTag = /^(DISP-0(0[2-9]|1[0-8])|ORG-\d{3})$/, ownCaseTag = /^(DISP|ORG)-\d{3}$/;
const isFeatureValue = (v: unknown): v is FeatureValue => v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length > 0 && v.length <= 60);
/** Empty: the card passes. */
export function libraryProblems(card: Precedent): string[] {
  const problems: string[] = [], keys = featureKeys[card.category], reviewer = isReviewerCard(card);
  if (!keys) problems.push(`Past rulings cover no-show, route and fare, cleaning and safety disputes; this past ruling's type of dispute (${card.category}) has no list to join.`);
  if (!card.rule_ids.length) problems.push('Name at least one Ryde rule.');
  for (const id of card.rule_ids) if (!ruleById(id)) problems.push(`Rule ${id} is not one of the Ryde rules (P01 to P40). Remove it or pick a rule from the list.`);
  // S$6.61 is the published no-show fee; its footnote (P40) says what the fee includes, so a card with that amount cites it.
  if (card.remedy.amount_cents === 661 && !card.rule_ids.includes('P40')) problems.push('The amount is S$6.61, the published no-show fee, so the past ruling must also cite Ryde rule P40, the footnote that says what that fee includes.');
  for (const [key, value] of Object.entries(card.features)) {
    if (keys && !keys.includes(key)) problems.push(`Feature ${key} is not one that retrieval matches on for this type of dispute.`);
    if (!isFeatureValue(value)) problems.push(`Feature ${key} must be yes or no, a number, or a short word.`);
    // A value outside the fact's own words (rider consent "unknown") would match a case the record does not settle.
    else if (keys?.includes(key) && value !== null && !allowedFeatureValues(key).includes(value)) problems.push(`Fact ${key.replaceAll('_', ' ')} cannot be ${JSON.stringify(value)}: a past ruling records it as ${allowedFeatureValues(key).map(v => JSON.stringify(v)).join(', ')}, or leaves it open.`);
  }
  for (const id of card.evaluation_overlap ?? []) if (!(reviewer ? ownCaseTag : scoredTag).test(id)) problems.push(`Hidden-case tag ${id} is not ${reviewer ? 'a case id' : 'a scored case'}.`);
  // No card's text names a test case.
  const { evaluation_overlap: _tags, ...text } = card, named = JSON.stringify(text).match(/(DISP|ORG)-\d{3}/)?.[0];
  if (named) problems.push(`The past ruling's text names case ${named}. Remove the case id: a past ruling must not point at a test case.`);
  return problems;
}
