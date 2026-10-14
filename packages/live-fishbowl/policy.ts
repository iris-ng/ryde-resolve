import release from './policy-reference.json';
import { createHash } from 'node:crypto';
import type { CasePacket } from '../agent-flow/contracts';
import { ruleNotesOff } from '../policy/ruleset';

export type PolicyReference = Omit<typeof release, 'status'> & { status: string; sha256: string; selection: { category: string; selectedIds: string[]; applicability: string } };
export function referencePolicies(packet: CasePacket): PolicyReference {
  let category = 'no_show';
  try { category = JSON.parse(packet.sources.find(s => s.id === 'evidence/intake.json')?.text ?? '{}').category ?? category; } catch { /* Missing intake remains a scope uncertainty. */ }
  const roots = category === 'no_show' ? ['P01', 'P02', 'P03', 'P04', 'P06', 'P08', 'P15', 'P16', 'P17', 'P18'] : ['P10', 'P11', 'P12', 'P13', 'P15', 'P16', 'P17', 'P18'];
  const selected = new Set<string>();
  const visit = (id: string) => { if (selected.has(id)) return; selected.add(id); const card = release.cards.find(c => c.id === id); card?.dependencies.forEach(visit); };
  roots.forEach(visit);
  // Include the other sides of known conflicts, not only the initially matched card.
  let changed = true;
  while (changed) { const size = selected.size; const conflicts = new Set(release.cards.filter(c => selected.has(c.id)).flatMap(c => c.conflict_ids)); release.cards.filter(c => c.conflict_ids.some(id => conflicts.has(id))).forEach(c => visit(c.id)); changed = size !== selected.size; }
  return { ...release, sha256: createHash('sha256').update(JSON.stringify(release)).digest('hex'), selection: { category, selectedIds: [...selected].sort(), applicability: 'Category shortlist including dependencies and conflicts. Service, booking type and historical policy applicability still require review. Use the archived public sources as the policy basis. Establish service, booking type and date applicability; unresolved material conflicts require human review.' } };
}
export function pinPolicyReference(packet: CasePacket): CasePacket {
  const reference = referencePolicies(packet);
  // The sample cases' archived cards keep the team's note lists under their 23 September names; with RYDE_RULE_NOTES=off they go too
  // (ruleset.ts agentRule does the same for the ruleset's cards), and the version is marked.
  const bare = <T extends { exceptions_and_limits?: unknown; unresolved_questions?: unknown }>(card: T) => { if (!ruleNotesOff) return card; const { exceptions_and_limits: _l, unresolved_questions: _q, ...rest } = card; return rest as T; };
  const cards = reference.cards.filter(c => reference.selection.selectedIds.includes(c.id)).map(bare);
  const policies = cards.map(card => ({ rule_id: card.id, ...card }));
  const policyProfile = 'Reviewed public Ryde sources, archived 23 September 2026. These sources replace fictional laboratory rules for new live runs. They are not Ryde approval of this application. Determine service, booking type, trip date, conditions, exceptions and conflicting sources. Do not invent effective dates, refund instruments, fee amounts or policy precedence. Unknown material applicability must be an unresolved policy_applicability criterion with human review. Accounting ceilings are mechanical limits, not entitlement or authority to issue refunds.';
  const policySources = cards.map(card => { const text = JSON.stringify(card, null, 2); return { id: `policy/public/${card.id}.json`, text, lines: text.split('\n'), sha256: createHash('sha256').update(text).digest('hex') }; });
  const sources = [...packet.sources.filter(s => !/policy|rules/i.test(s.id)), ...policySources];
  return { ...packet, policyBasis: 'reviewed-public', policyProfile, policies, sources,
    evidenceVersion: createHash('sha256').update(JSON.stringify(sources.map(s => [s.id, s.sha256]))).digest('hex'),
    policyVersion: createHash('sha256').update(JSON.stringify({ reference: reference.sha256, policies, policyProfile, ...(ruleNotesOff ? { notes: 'off' } : {}) })).digest('hex'),
    policyReference: { ...reference, cards: reference.cards.map(bare), status: 'public_source_basis', notice: 'Archived public Ryde policies are the basis for this review. The application and its summaries are not Ryde-approved. Conditions, exceptions, conflicts and historical applicability remain explicit.' } };
}
