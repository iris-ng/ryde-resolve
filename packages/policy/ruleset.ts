import { createHash } from 'node:crypto';
import ruleset from '../../policies/ryde/ruleset.json';

// The 40-rule research ruleset built from the archived public Ryde pages. Not
// Ryde-approved; no rule is active. Retrieval is deterministic: category tags,
// dataset hints, dependency closure and both sides of every recorded conflict.
export type RuleSource = { source_id: string; canonical_url: string; snapshot_date: string; archive_path: string; sha256: string; line_start: number; line_end: number; exact_text: string };
export type Rule = { id: string; title: string; kind: string; categories: string[]; statement: string; origin: string; sources: RuleSource[]; conditions: string[]; limits: string[]; conflict_ids: string[]; why_relevant: string; status: string; dependencies?: string[]; required_evidence_proposed?: string[]; interpretation_proposed?: string | null; unresolved_questions?: string[] };
export type Conflict = { id: string; title?: string; description?: string; [key: string]: unknown };
const rules = ruleset.rules as unknown as Rule[];
/** Every rule of the release, for the semantic index the worker builds at start (semantic-index.ts). */
export const allRules: readonly Rule[] = rules;
const conflicts = ruleset.conflicts as unknown as Conflict[];
export const rulesetVersion = `${ruleset.ruleset_version} (${ruleset.built_at})`;
export const rulesetSha256 = createHash('sha256').update(JSON.stringify(ruleset)).digest('hex');
/**
 * Experiment (owner, 14 October 2026): RYDE_RULE_NOTES=off gives the agents each rule without the team's two note lists, `limits`
 * ("Limits and exceptions") and `unresolved_questions` ("What the pages leave open"). The statement, conditions, proposed
 * interpretation and Ryde's quoted words stay. Read once at start, in the web (which pins a run's cards) and the worker (which
 * embeds the rules). The Library and every other reader of the ruleset see the full rule.
 */
export const ruleNotesOff = process.env.RYDE_RULE_NOTES === 'off';
/** The rule as an agent is given it: whole, or without the two note lists when RYDE_RULE_NOTES=off. */
export type AgentRule = Omit<Rule, 'limits' | 'unresolved_questions'> & { limits?: string[]; unresolved_questions?: string[] };
export function agentRule(rule: Rule): AgentRule { if (!ruleNotesOff) return rule; const { limits: _l, unresolved_questions: _q, ...rest } = rule; return rest; }
/** The policy version a packet pins for these selected rules under this ruleset release, as case-packet/dataset.ts and live-fishbowl/cases.ts compute it.
 * With the note lists off the version is marked, so such a run never passes for one under the full cards (a freeze, a past ruling's release). */
export const rulesetPolicyVersion = (selectedIds: string[], notesOff = ruleNotesOff) => createHash('sha256').update(JSON.stringify({ ruleset: rulesetSha256, version: rulesetVersion, selected: selectedIds, ...(notesOff ? { notes: 'off' } : {}) })).digest('hex');
// Governance, payment-state and refund-discretion rules apply to every category.
const alwaysIds = ['P16', 'P17', 'P18'];
// Dataset dispute types map onto the ruleset's category tags.
export const categoryTags: Record<string, string[]> = {
  no_show: ['no_show_charge', 'cancellation_fee', 'waiting_fee'],
  route_deviation: ['route_deviation', 'fare_overcharge', 'erp_toll', 'destination_change', 'surge_pricing', 'promo_code', 'extra_charge'],
  cleaning: ['cleaning_fee', 'property_damage'],
  safety: ['safety_incident', 'dangerous_driving', 'harassment', 'threat', 'accident_injury', 'identity_mismatch', 'vehicle_breakdown'],
};
export function ruleById(id: string) { return rules.find(r => r.id === id); }
/** Every rule's id, title and categories: the fixed list a person picks a past ruling's rules from (learning loop). */
export const ruleSummaries = rules.map(r => ({ id: r.id, title: r.title, categories: r.categories }));
// Each recorded page conflict can only keep unresolved the decision criteria it
// actually bears on. A disagreement about the fee amount or the remedy mechanism
// says nothing about whether the driver reached the pickup or how long he waited.
export const conflictCriteria: Record<string, readonly string[]> = {
  C01: ['recorded_charge', 'charge_reconciliation'],               // waiting fee amount ($5 versus $6.61)
  C02: ['policy_applicability'],                                   // which services the cancellation policy covers
  C03: ['recorded_charge', 'charge_reconciliation'],               // rider charge versus driver payout labels
  C04: ['policy_applicability', 'wait_threshold', 'cancelled_after_grace'], // advance-booking timing boundaries
  C05: ['recorded_charge', 'charge_reconciliation'],               // refund versus voucher waiver mechanism
  C06: ['route_entitlement', 'edit_fee_supported'],                // add-a-stop versus change-multistop procedure
  C07: ['route_entitlement', 'charge_reconciliation', 'toll_payable_by_rider', 'fare_follows_fare_rule'], // ERP inclusion and allocation
};
export const conflictAffects = (id: string) => conflictCriteria[id] ?? [];
// A conflict the team has explained (ruleset-additions.json conflict_resolutions) carries its reading; it is settled on that reading.
export const conflictExplanation = (id: string): string | null => { const c = conflicts.find(x => x.id === id); return c?.status === 'explained' && typeof c.resolution === 'string' ? c.resolution : null; };
export function conflictsFor(ids: string[]) { return conflicts.filter(c => ids.includes(c.id)).map(c => ({ ...c, affectsCriteria: conflictAffects(c.id) })); }
export function selectRules(input: { category: string; extraTags?: string[]; hintIds?: string[] }) {
  const tags = new Set([...(categoryTags[input.category] ?? []), ...(input.extraTags ?? [])]);
  const selected = new Set<string>();
  const visit = (id: string) => { const rule = ruleById(id); if (!rule || selected.has(id)) return; selected.add(id); (rule.dependencies ?? []).forEach(visit); };
  for (const rule of rules) if (rule.categories.some(c => tags.has(c))) visit(rule.id);
  for (const id of [...(input.hintIds ?? []), ...alwaysIds]) visit(id);
  // Include the other side of every conflict touched by a selected rule.
  let size = -1;
  while (size !== selected.size) {
    size = selected.size;
    const touched = new Set(rules.filter(r => selected.has(r.id)).flatMap(r => r.conflict_ids));
    rules.filter(r => r.conflict_ids.some(c => touched.has(c))).forEach(r => visit(r.id));
  }
  const selectedIds = [...selected].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const unknownHints = (input.hintIds ?? []).filter(id => !ruleById(id));
  return { selectedIds, rules: selectedIds.map(id => ruleById(id)!), conflicts: conflicts.filter(c => rules.some(r => selected.has(r.id) && r.conflict_ids.includes(c.id))), unknownHints, tags: [...tags] };
}
export const rulesetProfile = `Reviewed public Ryde sources archived 21 and 23 September 2026 and re-verified unchanged on 27 September 2026, compiled as ruleset ${rulesetVersion}. These are research references, not Ryde-approved rules, and none is active in any product. Read each cited rule with read_policy before citing it. Determine the service, booking type, trip date, conditions, exceptions and conflicting pages yourself. Do not invent effective dates, refund instruments, fee amounts, pickup radii or rule precedence; a CMS date is not an effective date. Where two pages disagree (conflicts C01 to C07) or no rule answers an issue, say so as a policy gap under the policy_applicability criterion. Accounting ceilings are mechanical limits, not entitlement or authority to move money. No payment, voucher, suspension or reviewer assignment executes.`;
