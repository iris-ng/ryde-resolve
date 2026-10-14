import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { CasePacket, Source } from '../agent-flow/contracts';
import { agentRule, rulesetPolicyVersion, rulesetProfile, selectRules } from '../policy/ruleset';
import { evidenceVersionOf, loadDatasetPhotos } from './photos';
import { routeReferenceSource, routeReferenceSourceId } from './route-reference';
import { earlierClaimsSource, earlierClaimsSourceId } from './earlier-claims';

export const datasetVersion = 'dispute-dataset-1.0';
/**
 * The newest facts version this code computes (observations.ts), pinned into every new dataset packet. 2: the consistency
 * facts; 3: the photo-reading facts (photos_show_only_dry_debris, photos_show_no_mess); 4: branch checklists, cancellation
 * and GPS movement facts, structured call outcomes (rules rebuild, October 2026); 5: photos_show_seat_surface (7 October 2026);
 * 6: route checks from the GPS points (route-checks.ts) and promo and fare checks (fare-checks.ts) (MVP fixes, 10 October 2026);
 * 7: past-behaviour patterns, shown and never deciding (history-checks.ts) (MVP fixes, second release, 10 October 2026).
 * The live worker refuses a run pinned above it (worker.ts).
 */
// 8 (14 October 2026): the rider's app location (rider_location) and its facts; older packets compute what they did before.
export const currentFactsVersion = 8;
/** The facts version a packet computes: its pinned version, but at most 3 when it pins contract 3 or lower, so a packet with either version at 3 or lower computes exactly its old facts (rules rebuild). */
export function effectiveFactsVersion(packet: Pick<CasePacket, 'factsVersion' | 'contractVersion'>): number {
  const pinned = packet.factsVersion ?? 1;
  return typeof packet.contractVersion === 'number' && packet.contractVersion < 4 ? Math.min(pinned, 3) : pinned;
}
/** The rules rebuild is in force for this packet: contract 4 and facts 4 both pinned. Otherwise checks and routing are as before. */
export const rulesV4 = (packet: Pick<CasePacket, 'factsVersion' | 'contractVersion'>) => (packet.contractVersion ?? 0) >= 4 && effectiveFactsVersion(packet) >= 4;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const requiredBlocks = ['dispute_ticket', 'rider_profile', 'driver_profile', 'trip_data', 'gps_telemetry', 'chat_logs', 'app_events'];
// Dataset dispute types collapse to the four ruleset categories.
const categoryOf: Record<string, string> = {
  no_show_charge: 'no_show', cancellation_fee: 'no_show', waiting_fee: 'no_show', driver_cancellation: 'no_show', late_pickup: 'no_show',
  route_deviation: 'route_deviation', fare_overcharge: 'route_deviation', surge_pricing: 'route_deviation', promo_code: 'route_deviation', destination_change: 'route_deviation', erp_toll: 'route_deviation', extra_charge: 'route_deviation', late_arrival: 'route_deviation', trip_not_taken: 'route_deviation', fare_evasion: 'route_deviation',
  property_damage: 'cleaning', cleaning_fee: 'cleaning',
  safety_incident: 'safety', dangerous_driving: 'safety', harassment: 'safety', threat: 'safety', accident_injury: 'safety', identity_mismatch: 'safety', vehicle_breakdown: 'safety',
};
export function datasetCategory(dispute: any) { return categoryOf[dispute?.dispute_ticket?.dispute_type] ?? 'other'; }
export function isDatasetPacket(packet: Pick<CasePacket, 'datasetVersion'>) { return packet.datasetVersion === datasetVersion; }
export function datasetBlock<T = any>(packet: Pick<CasePacket, 'sources'>, block: string): T | null {
  const source = packet.sources.find(s => s.id === `evidence/${block}.json`);
  try { return source ? JSON.parse(source.text) : null; } catch { return null; }
}
// Fraud flags are reputation, not evidence about this trip: they never enter an agent-visible source.
// The raw dataset keeps them for the server-side integrity check.
const reputationKeys = new Set(['rider_profile', 'driver_profile']);
export function withoutReputationFlags(profile: Record<string, unknown>) {
  const { fraud_flags: _flags, fraud_flag_details: _details, ...rest } = profile ?? {};
  return rest;
}
/** Build a pinned packet from one evidence/disputes/<id>/dataset.json. Never reads expected/ or original/. */
/**
 * A Judge-only retry keeps its parent's facts version and time zone, absent ones included, so it recomputes exactly the
 * parent's facts and judgeRetry sees the identical packet. A fresh run keeps today's pins. A parent pinned without the saved
 * route reference (MVP fixes, 10 October 2026) or the earlier-claims extract (facts 7, second release) gets neither, and its
 * evidence version back. A parent that pinned the extract keeps its own copy, as it keeps its record check: the claims
 * register may have changed since, and the retry must see the parent's packet.
 */
export const riderLocationSourceId = 'evidence/rider_location.json';
export function withParentFactPins<T extends Pick<CasePacket, 'factsVersion' | 'timezone'>>(packet: T, parent: (Pick<CasePacket, 'factsVersion' | 'timezone'> & { sources?: (Pick<Source, 'id'> & Partial<Source>)[] }) | undefined): T {
  if (!parent) return packet;
  const { factsVersion: _version, timezone: _zone, ...rest } = packet;
  const pinned = { ...rest, ...(parent.factsVersion === undefined ? {} : { factsVersion: parent.factsVersion }), ...(parent.timezone === undefined ? {} : { timezone: parent.timezone }) } as T;
  const own = pinned as T & Partial<Pick<CasePacket, 'sources' | 'photos' | 'evidenceVersion'>>, parentSources = parent.sources;
  if (!Array.isArray(parentSources) || !own.sources) return pinned;
  // The rider's app location (14 October 2026) is a later-added source too: a retry of a run from before it gets the parent's packet.
  const later = [routeReferenceSourceId, earlierClaimsSourceId, riderLocationSourceId].filter(id => !parentSources.some(s => s.id === id) && own.sources!.some(s => s.id === id));
  const kept = parentSources.find(s => s.id === earlierClaimsSourceId), copy = kept && typeof kept.text === 'string' && Array.isArray(kept.lines) && typeof kept.sha256 === 'string' ? kept as Source : null;
  const ownCopy = own.sources.find(s => s.id === earlierClaimsSourceId);
  if (!later.length && (!copy || !ownCopy || isDeepStrictEqual(copy, ownCopy))) return pinned;
  const sources = own.sources.filter(s => !later.includes(s.id)).map(s => s.id === earlierClaimsSourceId && copy ? { id: copy.id, text: copy.text, lines: copy.lines, sha256: copy.sha256 } : s);
  return { ...pinned, sources, evidenceVersion: evidenceVersionOf(sources, own.photos) };
}
export async function loadDatasetPacket(file: string): Promise<CasePacket> {
  const resolved = await realpath(file);
  if (path.basename(resolved) !== 'dataset.json' || (await stat(resolved)).size > 1048576) throw new Error('Expected a dataset.json under 1 MiB');
  const data = JSON.parse(await readFile(resolved, 'utf8'));
  for (const block of requiredBlocks) if (!(block in data)) throw new Error('Dataset missing required block ' + block);
  const sources: CasePacket['sources'] = Object.keys(data).filter(k => k !== 'dataset_meta' && k !== 'policy_snapshot').map(key => {
    const text = JSON.stringify(reputationKeys.has(key) ? withoutReputationFlags(data[key]) : data[key], null, 2);
    return { id: `evidence/${key}.json`, text, lines: text.split('\n'), sha256: sha(text) };
  });
  const category = datasetCategory(data);
  const ticket = data.dispute_ticket;
  // The dispute's own type is a tag too (rules rebuild Task 17): fare_evasion selects P36 though its category's tags omit it.
  const extraTags = [ticket.dispute_type, ...(data.dataset_meta?.secondary_issues ?? []), ...(ticket.issues ?? []).map((i: any) => i.category)].filter((t: unknown) => typeof t === 'string');
  // The case author's policy_snapshot.applicable_rule_ids is an answer hint and is not used: rules are
  // selected from the dispute's own categories (on 29 September this found every hinted rule for all
  // seven disputes), and agents search the pinned set with search_rules.
  const selection = selectRules({ category, extraTags });
  const policies = selection.rules.map(rule => ({ rule_id: rule.id, ...agentRule(rule) }));
  const policySources = selection.rules.map(rule => { const text = JSON.stringify(agentRule(rule), null, 2); return { id: `policy/public/${rule.id}.json`, text, lines: text.split('\n'), sha256: sha(text) }; });
  const organiserNote = data.cancellation_policy ? ' This dataset also carries the organiser sample\'s own policy block (evidence/cancellation_policy.json) with different figures; this run applies the public ruleset, and any comparison must say which figures it used.' : '';
  // Facts 6 (MVP fixes, 10 October 2026): a route case listed in the route-reference register gets its saved best road route as a
  // labelled source after the dataset blocks; dataset.json itself is never changed (route-reference.ts).
  const reference = data.route_data ? await routeReferenceSource(ticket.dispute_id) : null;
  // Facts 7 (MVP fixes F9, second release, 10 October 2026): each party's own earlier claims from the claims register, as one more
  // labelled source after the dataset blocks (earlier-claims.ts). The raw data is read for the trip's people and date only; fraud flags
  // and the record check's keys never reach it.
  const earlier = await earlierClaimsSource(data);
  const all = [...sources, ...(reference ? [reference] : []), earlier, ...policySources];
  // Photo files beside dataset.json are verified and pinned by hash for the examine step; their bytes never become text sources.
  const photos = await loadDatasetPhotos(path.dirname(resolved), data.photos);
  return {
    caseId: ticket.dispute_id, title: `${ticket.dispute_id}: ${ticket.dispute_type.replace(/_/g, ' ')} filed by ${ticket.filed_by}`,
    sources: all, policies, policyProfile: rulesetProfile + organiserNote, policyBasis: 'reviewed-public', datasetVersion,
    evidenceVersion: evidenceVersionOf(all, photos), ...(photos ? { photos } : {}),
    // The dataset's stated time zone, for local times with no offset (a receipt's cleaning time). Never defaulted: unknown stays unknown.
    ...(typeof data.dataset_meta?.timezone === 'string' && data.dataset_meta.timezone ? { timezone: data.dataset_meta.timezone } : {}),
    factsVersion: currentFactsVersion,
    policyVersion: rulesetPolicyVersion(selection.selectedIds),
    policySelection: { category, tags: selection.tags, selectedIds: selection.selectedIds, conflictIds: selection.conflicts.map(c => c.id), unknownHints: selection.unknownHints },
  };
}
