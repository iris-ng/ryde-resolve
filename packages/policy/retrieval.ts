import type { CasePacket } from '../agent-flow/contracts';
import { outcomeKey } from '../agent-flow/routing';
import { branches } from '../agent-flow/checklists';
import { campaignTermsStatus } from '../evidence-collection/campaign-terms';
import { isReviewerCard, precedentHidden } from './evaluation';
import { deriveFacts } from '../agent-flow/facts';
import { datasetBlock, isDatasetPacket, effectiveFactsVersion } from '../case-packet/dataset';
import { bindingStatuses, runLibrary, type FeatureValue, type Precedent } from './precedents';

// Policy and precedent retrieval. Deterministic and explainable, no vector store (27 September
// notes): filter by category, then rank by the case's material facts, the words of the
// complaint and the rules both share. Case features are computed from the packet's
// deterministic facts on the server, so no model can steer them.
export const featureKeys: Record<string, string[]> = {
  no_show: ['driver_at_pickup', 'wait_over_three_minutes', 'trip_started', 'cancelled_by', 'rider_cancel_within_grace', 'advance_booking', 'cancelled_more_than_15_min_before', 'driver_contacted_rider', 'rider_contacted_driver', 'rider_at_other_location', 'payment_method', 'driver_on_time', 'driver_heading_to_pickup', 'branch', 'service_class', 'rider_absent', 'pickup_point_changed'],
  route_deviation: ['fare_basis', 'route_deviated', 'toll_on_detour_only', 'toll_on_quoted_route', 'rider_consent', 'charged_above_quote', 'surge_applied', 'quote_changed_after_booking', 'promo_failed', 'promo_eligible', 'terms_in_evidence', 'destination_changed', 'edit_accepted', 'hold_mistaken_for_charge', 'trip_not_taken', 'service_class'],
  cleaning: ['claim_within_48h', 'cleaning_within_24h', 'receipt_complete', 'plate_visible', 'mess_tier', 'claimed_over_cap', 'branch', 'service_class', 'rider_caused_mess', 'professional_cleaning_needed'],
  safety: ['safety_report', 'immediate_danger', 'injury', 'counter_allegation', 'identity_mismatch', 'branch'],
};
// The facts that weigh most in the ranking. A precedent binds only when every fact it records matches, these included.
export const materialKeys: Record<string, string[]> = {
  no_show: ['driver_at_pickup', 'wait_over_three_minutes', 'trip_started', 'rider_cancel_within_grace', 'advance_booking', 'driver_on_time', 'driver_heading_to_pickup'],
  route_deviation: ['fare_basis', 'route_deviated', 'toll_on_detour_only', 'rider_consent', 'charged_above_quote', 'surge_applied', 'promo_failed', 'promo_eligible', 'terms_in_evidence', 'trip_not_taken', 'destination_changed', 'edit_accepted', 'quote_changed_after_booking'],
  cleaning: ['claim_within_48h', 'cleaning_within_24h', 'receipt_complete', 'mess_tier'],
  safety: ['immediate_danger', 'injury'],
};
/**
 * Values that leave a fact open: the record does not settle it. In a case they match only the same value in a past ruling,
 * and a binding ruling that matched on one sends the case to a person (precedent_on_open_fact). Every such value counts,
 * not only the two the dataset cases produce today.
 */
export const openValues = new Set<FeatureValue>(['unclear', 'disputed', 'unknown', 'not_recorded', null]);
const soft = openValues;
/**
 * The values each feature may take in a past ruling (library.ts refuses any other): the dataset schema's enums and the
 * caps' mess tiers. A feature not listed is yes or no. null always leaves the fact open.
 */
export const featureVocabulary: Record<string, readonly FeatureValue[]> = {
  driver_at_pickup: ['yes', 'no', 'unclear'], cancelled_by: ['driver', 'rider', 'system'], payment_method: ['cash'],
  fare_basis: ['fixed_quote', 'metered', 'estimate'], rider_consent: ['yes', 'no', 'disputed'],
  mess_tier: ['food_drink_crumbs_sand', 'bodily_fluids_or_stains', 'vomit', 'pet_fur'],
  branch: branches, service_class: ['standard', 'taxi', 'send', 'pet', 'pool', 'hire', 'other'],
  // Findings a person records on a draft (loop.ts findingFeatures): unclear when nobody settled them.
  rider_absent: [true, false, 'unclear'], rider_caused_mess: [true, false, 'unclear'], professional_cleaning_needed: [true, false, 'unclear'],
};
export const allowedFeatureValues = (key: string): readonly FeatureValue[] => featureVocabulary[key] ?? [true, false];

export function caseFeatures(packet: CasePacket): { category: string; features: Record<string, FeatureValue> } {
  const facts = deriveFacts(packet), category = facts.category;
  const value = (id: string) => facts.facts.find(f => f.id === id)?.value as any;
  const features: Record<string, FeatureValue> = {};
  const set = (key: string, v: FeatureValue | undefined) => { if (v !== undefined) features[key] = v; };
  if (!isDatasetPacket(packet)) return { category, features };
  const v4 = effectiveFactsVersion(packet) >= 4;
  const trip = datasetBlock(packet, 'trip_data') ?? {}, ticket = datasetBlock(packet, 'dispute_ticket') ?? {};
  const events: any[] = datasetBlock(packet, 'app_events') ?? [], docs: any[] = datasetBlock(packet, 'documents') ?? [];
  // Facts 4 (rules rebuild Task 21): the branch and the service decide which past rulings can bind. Findings only the Judge can make
  // (whether the rider was absent, an agreed pickup change, spoken consent) are never set here, so a ruling that records one guides
  // the Judge but does not bind on its own.
  if (v4 && ['no_show', 'cleaning', 'safety'].includes(category)) set('branch', facts.branch);
  if (v4 && ['no_show', 'route_deviation', 'cleaning'].includes(category)) set('service_class', serviceClass(trip.service_type));
  if (category === 'no_show') {
    // Retrieval standard, not a policy radius (P06 publishes none): the distance at the declared arrival with its GPS accuracy
    // must sit wholly within 50 m for 'yes' or wholly beyond 150 m for 'no'; anything else, or an unstated accuracy, is 'unclear'.
    const d = value('distance_to_pickup_at_declared_arrival_m'), accuracy = nearestAccuracy(packet, trip.driver_arrival_time);
    set('driver_at_pickup', typeof d === 'number' ? accuracy === null ? 'unclear' : d + accuracy <= 50 ? 'yes' : d - accuracy >= 150 ? 'no' : 'unclear' : undefined);
    // An advance booking counts from the booked time, or the arrival if later (owner decision, 6 October 2026).
    // An unknown advance wait stays unknown here too, never the arrival-only clock.
    const advanceWait = v4 ? facts.facts.find(f => f.id === 'wait_exceeds_three_minutes_from_wait_start') : undefined;
    set('wait_over_three_minutes', advanceWait ? (typeof advanceWait.value === 'boolean' ? advanceWait.value : undefined) : value('wait_exceeds_three_minutes_from_declared_arrival'));
    set('trip_started', value('trip_not_started') === true ? false : trip.trip_start_time ? true : undefined);
    set('cancelled_by', trip.cancelled_by);
    const grace = value('grace_seconds_match_to_cancellation'), afterGrace = value('cancelled_after_grace');
    // Facts 4: the cancellation fact (an advance booking's P07 window included); older packets the match clock.
    if (v4 && trip.cancelled_by === 'rider') set('rider_cancel_within_grace', typeof afterGrace === 'boolean' ? !afterGrace : undefined);
    else if (trip.cancelled_by === 'rider' && typeof grace === 'number') set('rider_cancel_within_grace', grace <= 180);
    const ahead = value('minutes_before_scheduled_at_cancel');
    if (v4 && typeof ahead === 'number' && ahead !== 15) set('cancelled_more_than_15_min_before', ahead > 15);
    set('advance_booking', trip.booking_mode ? trip.booking_mode === 'advance' : undefined);
    const contact = value('contact_counts_declared_arrival_to_cancellation');
    if (contact) { set('driver_contacted_rider', contact.driver_messages + contact.driver_calls > 0); set('rider_contacted_driver', contact.rider_messages + contact.rider_calls > 0); }
    set('payment_method', trip.payment_method === 'cash' ? 'cash' : undefined);
    // Facts 4, a rider's own cancellation: whether the driver was on time (not more than 2 minutes past the pickup time shown at
    // matching) and heading to the pickup (arrived, or the GPS shows neither parked away nor moving away). Unknown stays unset, so
    // a past ruling that records either fact (PREC-D05) binds only when the record shows it.
    if (v4) {
      const late = value('driver_missed_eta_by_2_min'), arrived = value('driver_arrived_before_cancel'), parked = value('driver_parked_away_before_cancel'), moving = value('driver_moving_away_before_cancel');
      set('driver_on_time', typeof late === 'boolean' ? !late : undefined);
      set('driver_heading_to_pickup', parked === true || moving === true ? false : arrived === true || (parked === false && moving === false) ? true : undefined);
    }
  } else if (category === 'route_deviation') {
    set('fare_basis', trip.fare_basis);
    const extra = value('route_extra_distance_km');
    set('route_deviated', typeof extra === 'number' ? extra > 0.5 : undefined);
    const gantries = value('erp_gantries_planned_vs_actual');
    if (gantries) { const planned = gantries.planned as string[], actual = (gantries.actual as { name: string }[]).map(g => g.name); set('toll_on_quoted_route', planned.length > 0); set('toll_on_detour_only', actual.some(n => !planned.includes(n))); }
    const consent = value('route_consent_recorded');
    set('rider_consent', consent && consent !== 'not_applicable' ? consent : undefined);
    const diff = value('charged_minus_quoted_cents');
    set('charged_above_quote', typeof diff === 'number' ? diff > 0 : undefined);
    const surge = value('surge_multiplier');
    set('surge_applied', typeof surge === 'number' ? surge > 1 : undefined);
    const promo = value('promo_recorded');
    if (promo) {
      set('promo_failed', !promo.applied);
      const validated = events.find(e => e.event_type === 'promo_validated' && e.data?.code === promo.code && typeof e.data?.eligible === 'boolean');
      set('promo_eligible', validated ? validated.data.eligible : undefined);
      // Facts 4: only a campaign-terms document for this code counts, found by its structured fields (kind campaign_terms with
      // campaign_id, or the dataset's terms ID DOC-TERMS-<code>), never by its wording; a status of unavailable, missing or
      // withdrawn means not in evidence, and no such document leaves the feature unknown. Older packets keep the wording test.
      if (v4) { const status = campaignTermsStatus(docs, promo.code); set('terms_in_evidence', status === null ? undefined : status); }
      else set('terms_in_evidence', docs.some(d => { const t = `${d.filename ?? ''} ${d.text ?? ''}`; return t.includes(promo.code) && /\bterms\b/i.test(t) && !/\b(unavailable|not available|missing|not supplied)\b/i.test(t); }));
    }
    // Facts 4: the complaint's label is an allegation, not a finding (P29), so it never sets this fact; older packets did.
    if (!v4) set('trip_not_taken', ticket.dispute_type === 'trip_not_taken' ? true : undefined);
  } else if (category === 'cleaning') {
    const claim = value('hours_trip_end_to_claim'), cleaned = value('hours_trip_end_to_cleaning'), receipt = value('receipt_fields_present');
    // Facts 4: the exact-seconds facts; older packets the rounded hours.
    const exact = (id: string) => { const b = value(id); return typeof b === 'boolean' ? b : undefined; };
    set('claim_within_48h', v4 ? exact('claim_within_48h') : typeof claim === 'number' ? claim <= 48 : undefined);
    set('cleaning_within_24h', v4 ? exact('cleaning_within_24h') : typeof cleaned === 'number' ? cleaned <= 24 : undefined);
    set('receipt_complete', receipt ? Object.values(receipt).every(Boolean) : undefined);
    set('plate_visible', value('plate_visible_in_any_photo'));
  } else if (category === 'safety') {
    const report = value('safety_report');
    set('safety_report', report ? true : undefined);
    if (report) { set('immediate_danger', report.immediate_danger === true); set('injury', report.injury_reported === true); }
    const issues = value('safety_relevant_issues') as { alleged_by: string }[] | undefined;
    if (issues) set('counter_allegation', new Set(issues.map(i => i.alleged_by)).size > 1);
  }
  return { category, features };
}

function nearestAccuracy(packet: CasePacket, at: string | undefined): number | null {
  const rows: any[] = datasetBlock(packet, 'gps_telemetry') ?? [];
  if (!at || !rows.length) return null;
  const t = Date.parse(at), best = rows.reduce((a, r) => Math.abs(Date.parse(r.timestamp) - t) < Math.abs(Date.parse(a.timestamp) - t) ? r : a);
  return typeof best.accuracy_m === 'number' ? best.accuracy_m : null;
}
export const locationStandard = 'Retrieval standard, not a policy radius: driver_at_pickup is yes when the declared-arrival distance plus its GPS accuracy is within 50 m, no when the distance minus accuracy is beyond 150 m, otherwise unclear.';
const stop = new Set('the a an and or of to in on at for by with from was were is are be been this that it its as not no but if then than there their they them he she his her we our you your i my me any all has have had did does do into over after before about which who whom what when where while would could should can may also only one two per'.split(' '));
const tokens = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2 && !stop.has(t)).map(t => t.length > 4 && t.endsWith('s') ? t.slice(0, -1) : t);
/** The words of a ruling the keyword ranking reads (and the semantic chunk embeds, semantic.ts): title, facts, questions, reasoning, dispute types. */
export const precedentText = (p: Precedent) => [p.title, ...p.material_facts, ...p.issues, p.reasoning, ...p.dispute_types].join(' ');
function idf(docs: string[][]) {
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  return (t: string) => Math.log(1 + docs.length / (1 + (df.get(t) ?? 0)));
}
const complaintText = (packet: CasePacket) => {
  const ticket = datasetBlock<any>(packet, 'dispute_ticket');
  return ticket ? [ticket.description, ...(ticket.issues ?? []).map((i: any) => i.allegation)].join(' ') : packet.title;
};

/** `similarity` (semantic.ts, 11 October 2026): set only on a hit the embedding search and reranker found; comparison only, never part of the binding test. */
export type PrecedentHit = { precedentId: string; title: string; category: string; outcome: string; remedy: Precedent['remedy']; reviewStatus: Precedent['review_status']; weight: string; score: number; materiallyMatches: boolean; binding: boolean; matchingFeatures: string[]; differingFeatures: string[]; unknownFeatures: string[]; sharedRules: string[]; matchedTerms: string[]; similarity?: { cosine: number; rerank: number; rank: number } };
/** Decided under the current public ruleset; precedents from labelled fictional demo rules never bind. */
export const currentPolicyRelease = (p: Precedent) => p.policy_release.startsWith('policies/ryde/ruleset.json');
export type SearchOptions = { query?: string; limit?: number; library?: Precedent[]; includeDrafts?: boolean; quarantine?: boolean };
/**
 * Agents see reviewed or approved precedents only (includeDrafts false). A precedent tagged as overlapping an
 * evaluation case is never shown for that case (quarantine true), so retrieval cannot leak its answer. The
 * team review view turns both off. Without a library, the run's pinned cards (precedents.ts runLibrary).
 */
export function searchPrecedents(packet: CasePacket, options: SearchOptions = {}): PrecedentHit[] {
  const { hits, selected } = rankPrecedents(packet, options), limit = options.limit ?? 5;
  // The list always shows every binding precedent, whatever the agent's query, then the best of the rest up to the limit.
  const rest = hits.filter(h => !h.binding).slice(0, Math.max(0, limit - selected.length)), shown = new Set([...hits.filter(h => h.binding), ...rest]);
  return hits.filter(h => shown.has(h));
}
/** How many precedents may bind one case: fewer than the six precedentNotes a decision may carry (contracts.ts). */
export const bindingLimit = 5;
/**
 * Every hit, best first, with the binding set applied. A candidate matches every fact it records, is reviewed or approved
 * and was decided under the public ruleset. At most bindingLimit bind in all, file cards included, so the Judge can always
 * write a note for each: bundled file cards fill the set first (a reviewer card never pushes one out), then reviewer cards
 * take the room left, each group the most specific first (most matching facts, then shared rules), then by id. More than
 * bindingLimit full matches of any kind leave some out, and routing sends the case to a person (precedent_overflow). The agent's query plays no part, so the search
 * tool, the binding check, the precedentNotes guard and routing all see the same set. A candidate left out says why;
 * routing sends the case to a person when any are left out or the candidates disagree (precedentReview).
 */
/** Case facts computed only from facts version 4 (rules rebuild); a past ruling's record of them is ignored for older packets. */
export const v4OnlyFeatures = new Set(['driver_on_time', 'driver_heading_to_pickup', 'branch', 'service_class', 'rider_absent', 'pickup_point_changed', 'rider_caused_mess', 'professional_cleaning_needed']);
/** Under facts 4 a card binds only if it records these facts for its category; an older card (pinned before, or drafted before) guides only. */
export const v4RequiredFeatures: Record<string, string[]> = { no_show: ['branch', 'service_class'], route_deviation: ['service_class'], cleaning: ['branch'], safety: ['branch'] };
/** The services the published rules treat alike: RydeTAXI is outside the cancellation policy (P01), RydeSEND's fare includes ERP (P13), pet fur on RydePET (P21). */
export const serviceClass = (service: unknown): string | undefined => typeof service !== 'string' || !service ? undefined
  : ({ RydeX: 'standard', RydeXL: 'standard', RydeLUXE: 'standard', RydeFLASH: 'standard', RydeTAXI: 'taxi', RydeSEND: 'send', RydePET: 'pet', RydePOOL: 'pool', RydeHIRE: 'hire' } as Record<string, string>)[service] ?? 'other';
function rankPrecedents(packet: CasePacket, options: SearchOptions) {
  const { category, features } = caseFeatures(packet), library = options.library ?? runLibrary(packet), v4 = effectiveFactsVersion(packet) >= 4;
  const pool = library.filter(p => p.category === category && p.review_status !== 'overturned'
    && (options.includeDrafts || (bindingStatuses as readonly string[]).includes(p.review_status))
    && (options.quarantine === false || !precedentHidden(p, packet.caseId)));
  const docs = pool.map(p => tokens(precedentText(p))), weight = idf(docs);
  const query = [...new Set(tokens(`${complaintText(packet)} ${options.query ?? ''}`))];
  const pinned = new Set(packet.policies.map(p => p.rule_id)), material = materialKeys[category] ?? [], ranks: number[] = [];
  // The dispute type the rider filed, and the situation the record shows (deriveFacts' branch; route_detour is filed as route_deviation).
  const filed = datasetBlock<any>(packet, 'dispute_ticket')?.dispute_type, situation = v4 ? deriveFacts(packet).branch : undefined;
  const disputeTypes = [filed, situation === 'route_detour' ? 'route_deviation' : situation].filter(Boolean);
  const hits = pool.map((p, i) => {
    let featureScore = 0, compared = 0, differs = false;
    const matching: string[] = [], differing: string[] = [], unknown: string[] = [];
    // Facts 4: a card that does not record the facts 4 needs (an older copy, pinned or drafted before the rebuild) guides only.
    if (v4) for (const key of v4RequiredFeatures[category] ?? []) if (!(key in p.features)) unknown.push(key);
    // Facts 4 (red team, round 1): fare rulings span several branches (tolls, extra charges, surge, promos), so one binds only a
    // case whose filed type or situation it lists; a toll ruling never decides an extra-charge dispute that shares its fare facts.
    if (v4 && category === 'route_deviation' && !disputeTypes.some(t => p.dispute_types.includes(t))) { differing.push(`dispute type: this case ${disputeTypes.join(' / ')}, precedent ${p.dispute_types.join(', ')}`); differs = true; }
    for (const key of Object.keys(p.features)) {
      // Facts computed only from version 4 (rules rebuild) do not exist for an older packet: its matching is exactly as before.
      if (!v4 && v4OnlyFeatures.has(key)) continue;
      const isMaterial = material.includes(key), recorded = p.features[key];
      if (recorded === null) continue; // the precedent leaves this fact open
      // Every fact a precedent records decides whether it binds (its own distinguishing fact, such as a cash payment or a
      // gantry on the quoted route, is often outside the category's material keys). One this case does not settle is
      // insufficient information, not a match. An unclear or disputed fact in the precedent (sparse GPS) matches only the
      // same here, so it never binds a case whose record settles that fact. Only material keys move the ranking this much.
      if (!(key in features) || (soft.has(features[key]) && features[key] !== recorded)) { unknown.push(key); if (isMaterial) featureScore -= 1; continue; }
      if (features[key] === p.features[key]) { featureScore += isMaterial ? 3 : 2; matching.push(`${key}=${String(p.features[key])}`); if (isMaterial) compared++; }
      else { featureScore -= isMaterial ? 4 : 1; differing.push(`${key}: this case ${String(features[key])}, precedent ${String(p.features[key])}`); differs = true; if (isMaterial) compared++; }
    }
    const doc = new Set(docs[i]), matchedTerms = query.filter(t => doc.has(t));
    const textScore = Math.min(3, matchedTerms.reduce((a, t) => a + weight(t), 0) / 4);
    const sharedRules = p.rule_ids.filter(id => pinned.has(id)), ruleScore = p.rule_ids.length ? 2 * sharedRules.length / p.rule_ids.length : 0;
    const reviewed = (bindingStatuses as readonly string[]).includes(p.review_status);
    // Every fact the precedent records must be known and equal here, at least two of them material, and it must share this rule release.
    const materiallyMatches = !differs && !unknown.length && compared >= 2;
    const binding = reviewed && materiallyMatches && currentPolicyRelease(p);
    ranks[i] = featureScore + ruleScore;
    return { precedentId: p.precedent_id, title: p.title, category: p.category, outcome: p.remedy.outcome, remedy: p.remedy, reviewStatus: p.review_status,
      weight: binding ? 'binding: follow it, or distinguish it with cited evidence (a person then checks the distinction)' : reviewed ? 'reviewed, comparison only: ' + (currentPolicyRelease(p) ? 'not every decisive fact matches' : 'decided under different rules') : 'draft: carries no weight until a person approves it',
      score: Math.round((featureScore + textScore + ruleScore) * 10) / 10, materiallyMatches, binding,
      matchingFeatures: matching, differingFeatures: differing, unknownFeatures: unknown, sharedRules, matchedTerms: matchedTerms.slice(0, 12) };
  });
  const candidates = hits.map((h, i) => ({ h, rank: ranks[i], reviewer: isReviewerCard(pool[i]) })).filter(x => x.h.binding)
    .sort((a, b) => Number(a.reviewer) - Number(b.reviewer) || b.rank - a.rank || a.h.precedentId.localeCompare(b.h.precedentId));
  const selected = candidates.slice(0, bindingLimit).map(x => x.h), all = candidates.map(x => ({ precedentId: x.h.precedentId, outcome: x.h.outcome, reviewer: x.reviewer }));
  for (const x of candidates.slice(bindingLimit)) { x.h.binding = false; x.h.weight = `reviewed, comparison only: it matches every fact, but at most ${bindingLimit} precedents bind one case (bundled ones first) and ${bindingLimit} others already do, so a person checks this case`; }
  return { hits: hits.sort((a, b) => b.score - a.score || a.precedentId.localeCompare(b.precedentId)), selected, candidates: all };
}
/** Binding precedents: reviewed or approved, current rule release, every recorded fact known and equal, at most bindingLimit (rankPrecedents). The Judge must follow or distinguish each. */
export function materialMatches(packet: CasePacket, library: Precedent[] = runLibrary(packet), options: Pick<SearchOptions, 'quarantine'> = {}) {
  return precedentReview(packet, library, options).binding;
}
/**
 * The binding set for the Judge and what routing needs beyond it: every candidate (matching every fact, reviewed, public
 * ruleset), whether some were left out of the binding set, and whether the candidates disagree on the outcome. Either
 * sends the case to a person (routing.ts), whatever notes the Judge wrote.
 */
export function precedentReview(packet: CasePacket, library: Precedent[] = runLibrary(packet), options: Pick<SearchOptions, 'quarantine'> = {}) {
  const { selected, candidates } = rankPrecedents(packet, { library, quarantine: options.quarantine }), { features } = caseFeatures(packet);
  // A binding card that matched on a fact the record leaves open (unclear or disputed in both): option B, a followed ruling never
  // settles that fact, so routing sends the case to a person whatever the Judge reports.
  const openFacts = selected.flatMap(h => Object.entries(library.find(p => p.precedent_id === h.precedentId)?.features ?? {})
    .filter(([key, value]) => value !== null && soft.has(value) && features[key] === value).map(([fact, value]) => ({ precedentId: h.precedentId, fact, value: String(value) })));
  return { binding: selected, candidates, overflow: candidates.length > selected.length, disagree: new Set(candidates.map(c => outcomeKey(c.outcome))).size > 1, openFacts };
}
/** What routing reads of the run's past rulings (store.ts, flow.ts): the binding set, every candidate, and the open facts a binding card matched on. */
export function routingPrecedents(packet: CasePacket, library: Precedent[] = runLibrary(packet)) {
  const review = precedentReview(packet, library);
  return { bindingPrecedents: review.binding.map(m => m.precedentId), precedentCandidates: review.candidates.map(c => ({ precedentId: c.precedentId, outcome: c.outcome })), precedentOpenFacts: review.openFacts };
}
/** What the precedent tool cannot do for this case, stated to the agent. */
export function retrievalLimits(packet: CasePacket): string[] {
  const { features } = caseFeatures(packet), limits: string[] = [];
  if (!Object.keys(features).length) limits.push('This case has no structured fact layer (for example an upload-only case), so no precedent can bind and ranking uses wording and shared rules only.');
  if ('driver_at_pickup' in features) limits.push(locationStandard);
  return limits;
}

export type RuleHit = { ruleId: string; title: string; statement: string; score: number; matchedTerms: string[] };
/** Keyword search over the rules pinned in this packet only; it can never surface a rule outside the pinned set. */
export function searchRules(packet: CasePacket, query: string, limit = 6): RuleHit[] {
  const rules = packet.policies as unknown as { rule_id: string; title: string; statement: string; conditions?: string[]; limits?: string[]; why_relevant?: string; categories?: string[] }[];
  const docs = rules.map(r => tokens([r.title, r.statement, ...(r.conditions ?? []), ...(r.limits ?? []), r.why_relevant ?? '', ...(r.categories ?? [])].join(' '))), weight = idf(docs);
  const q = [...new Set(tokens(query))];
  const ticket = datasetBlock<any>(packet, 'dispute_ticket'), types = new Set([ticket?.dispute_type, ...(ticket?.issues ?? []).map((i: any) => i.category)].filter(Boolean));
  return rules.map((r, i) => {
    const doc = new Set(docs[i]), matchedTerms = q.filter(t => doc.has(t));
    const score = matchedTerms.reduce((a, t) => a + weight(t), 0) + ((r.categories ?? []).some(c => types.has(c)) ? 0.5 : 0);
    return { ruleId: r.rule_id, title: r.title, statement: r.statement.slice(0, 240), score: Math.round(score * 10) / 10, matchedTerms };
  }).filter(h => h.matchedTerms.length).sort((a, b) => b.score - a.score || a.ruleId.localeCompare(b.ruleId)).slice(0, limit);
}

export type PrecedentNote = { precedentId: string; relation: 'followed' | 'distinguished'; reason: string; citations?: { sourceId: string; startLine: number; endLine: number }[] };
const decisionOutcomes = ['refund_recommendation', 'charge_recommendation', 'driver_payment_recommendation', 'no_action', 'human_review'];
// A past ruling that charged the rider for cleaning is followed, under contract 4, by paying the driver (the same money decision split in two).
const sameOutcome = (a: string, b: string) => outcomeKey(a) === outcomeKey(b);
/** Consistency guard for the Judge: every binding material match needs a note; a followed precedent cannot reach a different outcome. */
export function precedentNoteProblems(packet: CasePacket, decision: { outcome?: string; precedentNotes?: PrecedentNote[] }, library: Precedent[] = runLibrary(packet), options: Pick<SearchOptions, 'quarantine'> = {}): string[] {
  const problems: string[] = [], notes = decision.precedentNotes ?? [];
  // A note names a ruling that applies to this case: one an agent can see for it (same dispute type, reviewed, not hidden).
  // "Followed" can then never claim a ruling the case was not compared with.
  const applicable = new Set(rankPrecedents(packet, { library, quarantine: options.quarantine }).hits.map(h => h.precedentId));
  // A precedentId the library does not hold is model-written: it is named by its place, never repeated (citations.ts, rule 1).
  const known = (id: string) => library.some(p => p.precedent_id === id);
  notes.forEach((n, i) => {
    if (!library.some(p => p.precedent_id === n.precedentId && p.review_status !== 'overturned')) problems.push(`Unknown precedent in precedentNotes: entry ${i + 1} names no past ruling this run can use${known(n.precedentId) ? ` (${n.precedentId} was overturned)` : ''}.`);
    else if (!applicable.has(n.precedentId)) problems.push(`precedentNotes names ${n.precedentId}, which is not a past ruling for this case (another type of dispute, hidden from this case, or not one agents may use). Remove it, or name a ruling search_precedents returns for this case.`);
  });
  notes.forEach((n, i) => { if (n.relation === 'distinguished' && !(n.citations ?? []).length) problems.push(`precedentNotes distinguishes ${known(n.precedentId) ? n.precedentId : `entry ${i + 1}`} without citing the case evidence that makes this case different.`); });
  for (const m of materialMatches(packet, library, options)) {
    const note = notes.find(n => n.precedentId === m.precedentId);
    if (!note) { problems.push(`Binding precedent ${m.precedentId} (${m.outcome}) matches this case on every decisive fact (${m.matchingFeatures.join(', ')}). Add a precedentNotes entry: followed, or distinguished with cited evidence; a distinction goes to a person.`); continue; }
    // Following a precedent while sending the case to a person (for example for a separate evidence gap) is consistent.
    if (note.relation === 'followed' && decisionOutcomes.includes(m.outcome) && decision.outcome && decision.outcome !== 'human_review' && !sameOutcome(decision.outcome, m.outcome)) problems.push(`precedentNotes says ${m.precedentId} is followed, but its outcome is ${m.outcome} and this decision is ${decision.outcome}. Follow it, or mark it distinguished with cited evidence.`);
  }
  return problems;
}
