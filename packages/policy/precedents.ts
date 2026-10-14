import { createHash } from 'node:crypto';

// File cards: the past rulings bundled with the code. This copy ships none (placeholders go here, see the live site for details);
// the learning loop's reviewer cards live in the database. An overturned precedent is never retrieved.
export type FeatureValue = string | number | boolean | null;
export type Precedent = {
  precedent_id: string; title: string; category: string; dispute_types: string[]; provenance: string; policy_release: string;
  rule_ids: string[]; service_type?: string; booking_mode?: string; trip_date?: string; features: Record<string, FeatureValue>;
  material_facts: string[]; issues: string[]; reasoning: string; remedy: { outcome: string; medium: string; amount_cents: number; recovery_cents?: number };
  authority: string; distinguishing_facts: string[]; evaluation_overlap?: string[]; review_status: 'team_reviewed_synthetic' | 'approved' | 'draft_pending_review' | 'overturned'; synthetic: boolean;
  /** 'reviewer_override': drafted from a person's final decision (policy/loop.ts), never shown to a scored case (evaluation.ts). Absent: a file card. */
  origin?: 'reviewer_override' | 'reviewer_confirmation';
  /** A person confirmed, on approving or publishing, that the text names no person, plate, address, phone number or email (owner, 11 October 2026):
   * only then does a learned ruling appear on the Library page. Absent on file cards, which the team wrote. */
  privacy_check?: { confirmed_by: string; at: string };
};
export const bindingStatuses = ['team_reviewed_synthetic', 'approved'] as const;
export const precedents: Precedent[] = [];
export const readPrecedent = (id: string, library: Precedent[] = precedents) => library.find(p => p.precedent_id === id && p.review_status !== 'overturned');
export const precedentNotice = 'Precedents are synthetic decisions with their own rule releases. Compare material facts, rule version, exceptions and remedy authority; a matching precedent cannot supply authority the pinned rules lack. Only reviewed or approved precedents are shown to agents; drafts wait for a person to approve them.';

/**
 * The cards a live run may see, copied whole into its packet at run start (store.ts startRun), as the run pins its facts
 * version: the file cards agents can see plus the reviewer cards a person approved (learning loop, stored in the
 * database). Approving, overturning or releasing cards later never changes a run that has started. Cards are a flat list:
 * no card refers to another, so nothing here follows references and no cycle can form.
 */
export type PrecedentSet = { version: 1; sha256: string; files: number; loop: string[]; loopLimit: number; loopApproved: number; cards: Precedent[] };
export const precedentSetVersion = 1;
/** At most this many reviewer cards join one run, the newest approved first, so a packet cannot grow without limit. The pin records the cap and how many were approved. */
export const loopPinLimit = 30;
const canonicalJson = (v: unknown): string => Array.isArray(v) ? '[' + v.map(canonicalJson).join(',') + ']'
  : v && typeof v === 'object' ? '{' + Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => JSON.stringify(k) + ':' + canonicalJson(x)).join(',') + '}'
  : JSON.stringify(v ?? null);
/**
 * Only cards an agent can see are pinned; a loop card whose id any file card already has (a draft too) is refused, never
 * merged. `loop` comes newest approved first; the first loopPinLimit are kept. `approved` is how many were approved in all.
 */
export function pinPrecedents(loop: Precedent[], files: Precedent[] = precedents, approved = loop.length): PrecedentSet {
  const visible = (p: Precedent) => (bindingStatuses as readonly string[]).includes(p.review_status);
  const fileCards = files.filter(visible), ids = new Set(files.map(p => p.precedent_id));
  const loopCards = loop.filter(visible).filter(p => !ids.has(p.precedent_id) && !!ids.add(p.precedent_id)).slice(0, loopPinLimit).sort((a, b) => a.precedent_id.localeCompare(b.precedent_id));
  const cards = structuredClone([...fileCards, ...loopCards]); // a copy: nothing done to a card later reaches a pinned run
  return { version: precedentSetVersion, sha256: createHash('sha256').update(canonicalJson(cards)).digest('hex'), files: fileCards.length, loop: loopCards.map(p => p.precedent_id), loopLimit: loopPinLimit, loopApproved: approved, cards };
}
/** The run's pinned cards; a packet pinned before the learning loop (or built outside the live store) reads the bundled files. */
export const runLibrary = (packet: { precedentSet?: PrecedentSet }): Precedent[] => packet.precedentSet?.cards ?? precedents;
