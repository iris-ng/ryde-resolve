// The reference library's catalog (apps/web/app/library): Ryde's rules, the places Ryde's pages disagree, and the approved
// past rulings, built from the same files the agents read, with the links between them. Team readings are not in it (user,
// 8 October): they are the team's, not Ryde's, so the Arbitrator names one in its analysis when a case rests on it, and the
// case page shows it there. Everyone with the site login reads the library: the team, the person deciding a case and the
// hackathon judges. So it leaves out whatever points at a test case or its answer: a ruling's hidden-case tags, a rule's
// "why it matters" note (it names test cases), the exam manifest, drafts and withdrawn rulings, and the two
// comparison-only demo rulings decided under invented rules. Learned rulings (from a person's decision) join only after a
// privacy check folded into approval (11 October 2026): shownRulings.
import ruleset from '../../policies/ryde/ruleset.json';
import { categoryTags, selectRules, type Rule } from './ruleset';
import { assumptionRegistry } from '../agent-flow/posture';
import { bindingStatuses, precedents, type FeatureValue, type Precedent } from './precedents';
import { currentPolicyRelease, materialKeys, v4RequiredFeatures } from './retrieval';
import { disputeTypes, libraryHref, longDate, rulingNumber, type DisputeType, type Shelf } from './library-links';

export type Link = { shelf: Shelf; id: string; number: string; title: string; href: string };
export type Quote = { url: string; archived: string; text: string };
type Base = { shelf: Shelf; id: string; number: string; title: string; summary: string; types: DisputeType[]; href: string };
/** `readOn`: the day the team read the Ryde pages an entry quotes (its archive date). */
export type RuleEntry = Base & { shelf: 'rules'; readOn: string; core: DisputeType[]; conditions: string[]; quotes: Quote[]; related: Link[]; conflicts: Link[]; rulings: Link[] };
/** `readingRules`: the Ryde rules the team's reading of a disagreement rests on (user, 8 October: name them, not the reading). */
export type ConflictEntry = Base & { shelf: 'conflicts'; readOn: string; standing: string; quotes: Quote[]; rules: Link[]; readingRules: Link[] };
export type RulingEntry = Base & { shelf: 'rulings'; outcome: string; authoritative: boolean; standing: string; trip: string; facts: string[]; questions: string[]; reasoning: string; changes: string[]; matchesOn: { fact: string; value: string }[]; origin: string; rules: Link[]; conflicts: Link[] };
export type Entry = RuleEntry | ConflictEntry | RulingEntry;

type RawConflict = { id: string; title: string; status: string; description: string; resolution?: string; what_would_reopen?: string; sources?: { canonical_url: string; snapshot_date: string; exact_text: string }[] };
const rules = ruleset.rules as unknown as Rule[], conflicts = ruleset.conflicts as unknown as RawConflict[];

const latest = (sources: { snapshot_date: string }[] = []) => sources.map(s => s.snapshot_date).sort().at(-1) ?? '';
/**
 * When the team read Ryde's public pages (user, 8 October: the policy side says as of when): the archive date every quote
 * carries, and the later check that found the help pages unchanged (policies/ryde/2026-09-27-verification).
 */
export const policyAsOf = {
  readOn: [...new Set([...rules, ...conflicts].flatMap(r => (r.sources ?? []).map(s => s.snapshot_date)))].sort(),
  checkedOn: (ruleset.policy_snapshot as string).match(/re-verified unchanged on (\d{4}-\d{2}-\d{2})/)?.[1] ?? null,
};
/** The policy side's one line: "Read from Ryde's public pages on 23 September 2026. ..." */
export function policyAsOfLine(asOf = policyAsOf): string {
  const read = asOf.readOn.length > 1 ? `between ${longDate(asOf.readOn[0])} and ${longDate(asOf.readOn.at(-1)!)}` : `on ${longDate(asOf.readOn[0])}`;
  return `Read from Ryde's public pages ${read}.` + (asOf.checkedOn ? ` Ryde's help pages were checked again on ${longDate(asOf.checkedOn)} and had not changed.` : '');
}

/**
 * Facts the case-fact code (retrieval.ts caseFeatures) never reads from the record: only a person, or the Arbitrator, can
 * find them. A ruling that records one is there for comparison and is never binding (tests/library-catalog
 * checks this list against caseFeatures).
 */
export const personFindings = ['rider_absent', 'pickup_point_changed', 'rider_at_other_location', 'destination_changed', 'edit_accepted', 'quote_changed_after_booking', 'hold_mistaken_for_charge', 'mess_tier', 'claimed_over_cap', 'rider_caused_mess', 'professional_cleaning_needed', 'identity_mismatch'];

/** Each fact a ruling matches on, in plain words. */
export const factNames: Record<string, string> = {
  driver_at_pickup: 'Driver at the pickup point by GPS', wait_over_three_minutes: 'Driver waited more than 3 minutes', trip_started: 'Trip started',
  cancelled_by: 'Who cancelled', rider_cancel_within_grace: 'Rider cancelled within the free 3 minutes', advance_booking: 'Booked in advance',
  cancelled_more_than_15_min_before: 'Cancelled more than 15 minutes before the booked time', driver_contacted_rider: 'Driver messaged or called the rider',
  rider_contacted_driver: 'Rider messaged or called the driver', rider_at_other_location: 'Rider waiting somewhere other than the pin', payment_method: 'Payment',
  driver_on_time: 'Driver on time (within 2 minutes of the time shown)', driver_heading_to_pickup: 'Driver making their way to the pickup', branch: 'Situation',
  service_class: 'Service', rider_absent: 'Rider absent when the driver cancelled', pickup_point_changed: 'Pickup point changed by agreement',
  fare_basis: 'How the fare was set', route_deviated: 'Driver left the quoted route', toll_on_detour_only: 'Toll only on the detour',
  toll_on_quoted_route: 'Toll on the quoted route', rider_consent: 'Rider agreed to the route', charged_above_quote: 'Charged more than the quote',
  surge_applied: 'Surge pricing applied', quote_changed_after_booking: 'Quote changed after booking', promo_failed: 'Promo code failed to apply',
  promo_eligible: 'Rider eligible for the promo', terms_in_evidence: 'Campaign terms in the evidence', destination_changed: 'Destination changed',
  edit_accepted: 'Driver accepted the destination change', hold_mistaken_for_charge: 'A card hold mistaken for a charge', trip_not_taken: 'Rider did not take the trip',
  claim_within_48h: 'Claim made within 48 hours', cleaning_within_24h: 'Car cleaned within 24 hours', receipt_complete: 'Cleaning receipt complete',
  plate_visible: 'Number plate visible in a photo', mess_tier: 'Kind of mess', claimed_over_cap: 'Amount claimed above the cap',
  rider_caused_mess: 'This rider caused the mess', professional_cleaning_needed: 'Professional cleaning needed', safety_report: 'Safety report filed',
  immediate_danger: 'Immediate danger', injury: 'Injury reported', counter_allegation: 'Both sides make allegations', identity_mismatch: 'Driver or car did not match the app',
};
const valueWords: Record<string, string> = {
  unclear: 'Unclear', disputed: 'Disputed', yes: 'Yes', no: 'No', driver: 'The driver', rider: 'The rider', system: 'The app', cash: 'Cash',
  fixed_quote: 'Fixed quote', metered: 'Meter', estimate: 'Estimate', standard: 'Standard car (RydeX and similar)', taxi: 'RydeTAXI', send: 'RydeSEND', pet: 'RydePET', pool: 'RydePOOL', hire: 'RydeHIRE', other: 'Another service',
  food_drink_crumbs_sand: 'Food, drink, crumbs or sand', bodily_fluids_or_stains: 'Bodily fluids or stains', vomit: 'Vomit', pet_fur: 'Pet fur',
  rider_cancellation: 'The rider cancelled', driver_no_show: 'The driver cancelled for a no-show', cleaning_claim: 'A driver claims a cleaning fee', safety: 'A safety report',
};
export const factValue = (v: FeatureValue) => v === true ? 'Yes' : v === false ? 'No' : v === null ? 'Left open' : valueWords[String(v)] ?? String(v).replaceAll('_', ' ');
const money = (cents: number) => `S$${(cents / 100).toFixed(2)}`;
/** A ruling's outcome as one line: "S$2.00 back to the card". */
export function outcomeLine(remedy: Precedent['remedy']): string {
  if (remedy.outcome === 'refund_recommendation') return `${money(remedy.amount_cents)} back ${remedy.medium === 'voucher' ? 'as a voucher' : 'to the card'}`;
  if (remedy.outcome === 'charge_recommendation') return `Cleaning fee of ${money(remedy.amount_cents)} charged to the rider`;
  if (remedy.outcome === 'driver_payment_recommendation') return `${money(remedy.amount_cents)} paid to the driver`;
  if (remedy.outcome === 'human_review') return 'Sent to a person';
  return 'No change';
}

const link = (shelf: Shelf, id: string, number: string, title: string): Link => ({ shelf, id, number, title, href: libraryHref(shelf, id) });
const ruleLink = (id: string) => { const r = rules.find(x => x.id === id); return r ? [link('rules', r.id, r.id, r.title)] : []; };
const conflictLink = (id: string) => { const c = conflicts.find(x => x.id === id); return c ? [link('conflicts', c.id, c.id, c.title)] : []; };
const rulingLink = (p: Precedent) => link('rulings', p.precedent_id, rulingNumber(p.precedent_id), p.title);
const byNumber = (a: string, b: string) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, ''));

/**
 * A ruling's weight, in plain words (the binding test in retrieval.ts rankPrecedents). A ruling never decides a case: the
 * Arbitrator makes the call (user, 8 October). It is authoritative when every fact it records matches the case: the
 * Arbitrator then follows it or explains with evidence why the case differs. Otherwise it is there for comparison.
 */
export function rulingStanding(p: Precedent): { authoritative: boolean; standing: string } {
  const recorded = Object.entries(p.features).filter(([, v]) => v !== null).map(([k]) => k);
  const findings = recorded.filter(k => personFindings.includes(k));
  if (findings.length) return { authoritative: false, standing: `For comparison. It turns on what a person finds (${findings.map(k => (factNames[k] ?? k).toLowerCase()).join('; ')}), which the record alone does not show, so it is never binding. The Arbitrator weighs it with the record and makes the call.` };
  const missing = (v4RequiredFeatures[p.category] ?? []).filter(k => !(k in p.features));
  const deciding = recorded.filter(k => (materialKeys[p.category] ?? []).includes(k)).length;
  if (missing.length || deciding < 2) return { authoritative: false, standing: 'For comparison. It records too few of the facts a case is matched on to be binding. The Arbitrator weighs it with the record and makes the call.' };
  return { authoritative: true, standing: 'Authoritative when every fact below matches the case. The Arbitrator follows it or explains, with evidence, why the case is different, and makes the call. If the Arbitrator departs from it, a person checks the case.' };
}

/** Rulings the library shows: approved, decided under the public rules. A learned ruling (drafted from a person's decision) joins only
 * with its privacy mark, set when a person approved or published it confirming the text names no person's details (11 October 2026). */
export const shownRulings = (cards: Precedent[] = precedents) => cards.filter(p => (bindingStatuses as readonly string[]).includes(p.review_status) && currentPolicyRelease(p) && (!p.origin || !!p.privacy_check));

export function buildCatalog(cards: Precedent[] = precedents) {
  const rulings = shownRulings(cards);
  const typesOf = new Map<string, DisputeType[]>();
  for (const t of disputeTypes) for (const id of selectRules({ category: t }).selectedIds) typesOf.set(id, [...typesOf.get(id) ?? [], t]);
  const quotes = (sources: { canonical_url: string; snapshot_date: string; exact_text: string }[] = []): Quote[] => sources.map(s => ({ url: s.canonical_url, archived: s.snapshot_date, text: s.exact_text }));

  const ruleEntries: RuleEntry[] = rules.map(r => ({
    shelf: 'rules', id: r.id, number: r.id, title: r.title, summary: r.statement, types: typesOf.get(r.id) ?? [], href: libraryHref('rules', r.id), readOn: latest(r.sources),
    // Core: the rule's own topic is this dispute type; the rest are read for it as dependencies, conflicts or always-read rules.
    core: disputeTypes.filter(t => r.categories.some(c => categoryTags[t].includes(c))),
    // Conditions that only repeat the summary are left out.
    // Neither team note list is on the page (owner, 14 October 2026): the agents read bare cards, without "Limits and exceptions"
    // or "What the pages leave open", so the Library shows the rule as they read it. Both lists stay in the ruleset file.
    conditions: r.conditions.every(c => r.statement.includes(c)) ? [] : r.conditions, quotes: quotes(r.sources),
    related: (r.dependencies ?? []).flatMap(ruleLink), conflicts: r.conflict_ids.flatMap(conflictLink),
    rulings: rulings.filter(p => p.rule_ids.includes(r.id)).map(rulingLink),
  }));
  const conflictEntries: ConflictEntry[] = conflicts.map(c => {
    const sides = rules.filter(r => r.conflict_ids.includes(c.id));
    // How the team settled a disagreement is a team reading (C01's explanation, A5 on C07), so the library names only the
    // rules that reading rests on: those C01's explanation cites, and those a team reading that resolves it reads.
    const readings = assumptionRegistry.filter(a => 'resolvesConflicts' in a && (a.resolvesConflicts as readonly string[]).includes(c.id));
    const readingRules = [...new Set([...(c.resolution?.match(/\bP\d{2}\b/g) ?? []), ...readings.flatMap(a => a.ruleIds)])].sort(byNumber).flatMap(ruleLink);
    const named = readingRules.map(l => `${l.number} (${l.title})`), ruleWords = named.length > 1 ? `rules ${named.slice(0, -1).join(', ')} and ${named.at(-1)}` : `rule ${named[0]}`;
    const read = c.status === 'explained' || readings.length > 0;
    if (read && !readingRules.length) throw new Error(`${c.id}: a team reading settles it but names no rule`);
    return {
      shelf: 'conflicts', id: c.id, number: c.id, title: c.title, summary: c.description, href: libraryHref('conflicts', c.id), readOn: latest(c.sources),
      types: disputeTypes.filter(t => sides.some(r => typesOf.get(r.id)?.includes(t))),
      standing: c.status === 'explained' ? `Settled by the team's reading of ${ruleWords}. That reading is the team's, not Ryde's words: the Arbitrator names it in its analysis when a case turns on it.`
        : read ? `Open. The team's reading of ${ruleWords} covers part of it. That reading is the team's, not Ryde's words: the Arbitrator names it in its analysis when a case turns on it.` : 'Open. The team has not settled it.',
      quotes: quotes(c.sources), rules: sides.map(r => link('rules', r.id, r.id, r.title)), readingRules,
    };
  });
  const rulingEntries: RulingEntry[] = rulings.map(p => {
    const named = [...new Set(JSON.stringify([p.reasoning, p.material_facts, p.issues, p.distinguishing_facts]).match(/\bC0[1-9]\b/g) ?? [])];
    const trip = [p.service_type, p.booking_mode === 'advance' ? 'booked in advance' : p.booking_mode === 'on_demand' ? 'on demand' : '', p.trip_date ? `trip on ${longDate(p.trip_date)}` : ''].filter(Boolean).join(', ');
    return {
      shelf: 'rulings', id: p.precedent_id, number: rulingNumber(p.precedent_id), title: p.title, summary: outcomeLine(p.remedy),
      types: disputeTypes.filter(t => t === p.category), href: libraryHref('rulings', p.precedent_id),
      outcome: outcomeLine(p.remedy), ...rulingStanding(p), trip, facts: p.material_facts, questions: p.issues, reasoning: p.reasoning, changes: p.distinguishing_facts,
      matchesOn: Object.entries(p.features).map(([k, v]) => ({ fact: factNames[k] ?? k.replaceAll('_', ' '), value: factValue(v) })),
      origin: p.provenance, rules: [...p.rule_ids].sort(byNumber).flatMap(ruleLink), conflicts: named.flatMap(conflictLink),
    };
  });
  const entries: Entry[] = [...ruleEntries, ...conflictEntries, ...rulingEntries];
  return {
    entries,
    find: (shelf: string, id: string) => entries.find(e => e.shelf === shelf && (e.id === id || e.number === id)),
    counts: Object.fromEntries(disputeTypes.map(t => [t, { rules: ruleEntries.filter(e => e.types.includes(t)).length, rulings: rulingEntries.filter(e => e.types.includes(t)).length }])) as Record<DisputeType, { rules: number; rulings: number }>,
  };
}
export type Catalog = ReturnType<typeof buildCatalog>;
/** One row of the front page's list: everything the browser needs to filter and search, nothing more. */
export type Row = Pick<Base, 'shelf' | 'id' | 'number' | 'title' | 'summary' | 'types' | 'href'> & { core?: DisputeType[] };
export const rowOf = (e: Entry): Row => ({ shelf: e.shelf, id: e.id, number: e.number, title: e.title, summary: e.summary, types: e.types, href: e.href, ...(e.shelf === 'rules' ? { core: e.core } : {}) });
