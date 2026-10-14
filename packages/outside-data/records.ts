import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { hasOutsideLookups, outsideSourceId, type CasePacket, type OutsideCall, type OutsideKind } from '../agent-flow/contracts';
import { datasetBlock, isDatasetPacket } from '../case-packet/dataset';
import { evidenceVersionOf } from '../case-packet/photos';
import { referenceText, routeReferenceSourceId } from '../case-packet/route-reference';
import { placeNames, recordPlace, recordWindow, type PlaceName, type WindowName } from './places';
import { metres, type OnemapPlace, type Pt } from './providers';

const sha = (v: string) => createHash('sha256').update(v).digest('hex');
export const providerNames: Record<OutsideKind, { provider: string; credit: string }> = {
  rainfall: { provider: 'data.gov.sg rainfall (National Environment Agency)', credit: 'Contains information from data.gov.sg, made available under the Singapore Open Data Licence.' },
  place: { provider: 'OneMap (Singapore Land Authority)', credit: 'OneMap, Singapore Land Authority.' },
  transport: { provider: 'LTA DataMall bus stops and taxi stands (Land Transport Authority)', credit: 'Contains information from LTA DataMall, made available under the Singapore Open Data Licence.' },
  street_picture: { provider: 'Mapillary street-level pictures, read by our photo reader', credit: 'Picture from Mapillary contributors, CC BY-SA 4.0.' },
  road_route: { provider: 'OSRM demo server on OpenStreetMap roads', credit: '© OpenStreetMap contributors, ODbL.' },
};
export type RecordInput = { asked: Record<string, unknown>; fetchedAt: string; status: string; reason?: string; via: 'live' | 'saved_copy'; savedAt?: string; answer: unknown; endpoint: string; rawSha256: string | null };
/** The text a lookup saves (AD-13). Its first field is a label, so no one reads it as Ryde's case file. */
export function outsideRecordText(kind: OutsideKind, n: number, r: RecordInput): string {
  const { provider, credit } = providerNames[kind];
  const label = `Looked up by the Evidence Collector during this run from ${provider}${r.via === 'saved_copy' ? `, answered from the team's saved copy fetched ${r.savedAt}` : ''}. What the provider returned at ${r.fetchedAt}; not part of Ryde's case file.`;
  const head = { label, lookup: kind, number: n, provider, credit, via: r.via, status: r.status, ...(r.reason ? { reason: r.reason } : {}), asked: r.asked, fetched_at: r.fetchedAt, endpoint: r.endpoint, raw_sha256: r.rawSha256 };
  if (kind !== 'road_route') return JSON.stringify({ ...head, answer: r.answer }, null, 2);
  // The road route keeps the saved reference's fields (from, to, distance_km, duration_min, points), which the route checks and the
  // drawing read; an unavailable route has none, and the checks say no best road route is on record.
  const a = r.answer as { from: Pt; to: Pt; distance_km: number; duration_min: number; points: [number, number][] } | null;
  return referenceText({ ...head, ...(a ? { from: a.from, to: a.to, distance_km: a.distance_km, duration_min: a.duration_min, points: a.points } : {}) });
}
export const outsideCall = (kind: OutsideKind, n: number, place: string | null, window: string | null, text: string): OutsideCall => ({ kind, n, sourceId: outsideSourceId(kind, n), place, window, text, sha256: sha(text) });

export type OutsideNeed = { kind: OutsideKind; place?: PlaceName; window?: WindowName };
const noShow = new Set(['no_show_charge', 'cancellation_fee', 'waiting_fee', 'driver_cancellation', 'late_pickup']);
const routeTypes = new Set(['route_deviation', 'erp_toll', 'late_arrival', 'destination_change']);
const fareTypes = new Set(['surge_pricing', 'fare_overcharge', 'extra_charge']);
/** AD-13: the lookups the server requires before it accepts the Collector's report, only for places and times the record has. */
export function requiredOutsideCalls(packet: Pick<CasePacket, 'sources'>): OutsideNeed[] {
  const type = datasetBlock(packet, 'dispute_ticket')?.dispute_type, has = (p: PlaceName) => !!recordPlace(packet, p), span = (w: WindowName) => !!recordWindow(packet, w);
  const route: OutsideNeed[] = has('trip_start') && has('trip_end') ? [{ kind: 'road_route' }] : [];
  if (noShow.has(type)) return ([
    { kind: 'place', place: 'pickup' }, { kind: 'place', place: 'driver_at_arrival' }, { kind: 'transport', place: 'pickup' }, { kind: 'transport', place: 'driver_at_arrival' },
    { kind: 'street_picture', place: 'pickup' }, ...(span('pickup_wait') ? [{ kind: 'rainfall', place: 'pickup', window: 'pickup_wait' }] : []),
  ] as OutsideNeed[]).filter(n => !n.place || has(n.place));
  if (routeTypes.has(type)) return [...route, ...(span('trip') && has('trip_start') ? [{ kind: 'rainfall', place: 'trip_start', window: 'trip' } as OutsideNeed] : [])];
  if (fareTypes.has(type)) return [...(span('before_booking') && has('pickup') ? [{ kind: 'rainfall', place: 'pickup', window: 'before_booking' } as OutsideNeed] : []), ...(datasetBlock(packet, 'route_data') ? route : [])];
  return [];
}
export function missingOutsideCalls(packet: Pick<CasePacket, 'sources'>, made: Pick<OutsideCall, 'kind' | 'place' | 'window'>[]): OutsideNeed[] {
  return requiredOutsideCalls(packet).filter(n => !made.some(m => m.kind === n.kind && (n.place === undefined || m.place === n.place) && (n.window === undefined || m.window === n.window)));
}
export const needText = (n: OutsideNeed) => `source ${n.kind}${n.place ? `, place ${n.place}` : ''}${n.window ? `, window ${n.window}` : ''}`;

/**
 * Evidence checks 4 (AD-11): nothing outside is fed to a run in advance. At run start the saved best road route, the team-written outside
 * notes and the pre-written evidence requests are left out of the packet; dataset.json files are unchanged (exam records pin their
 * hashes). Ryde's own logs in external_context (kind "other", a source starting "Ryde ") stay: they are Ryde's records, not the outside world.
 * So do records the organisers wrote into one of their own case files (an ORG- case, a source starting "Organiser file "; owner,
 * 13 October 2026, for ORG-001's traffic): they are part of the case as supplied, and the Evidence Collector cannot look up traffic
 * on a past day.
 */
export function withoutAdvanceOutsideData(packet: CasePacket): CasePacket {
  const drop = new Set([routeReferenceSourceId, 'evidence/evidence_requests.json']);
  const sources = packet.sources.flatMap(s => {
    if (drop.has(s.id)) return [];
    if (s.id !== 'evidence/external_context.json') return [s];
    let rows: unknown; try { rows = JSON.parse(s.text); } catch { return []; }
    const organiser = /^ORG-\d{3}$/.test(packet.caseId ?? '');
    const own = Array.isArray(rows) ? rows.filter((r: any) => typeof r?.source === 'string' && ((r?.kind === 'other' && r.source.startsWith('Ryde ')) || (organiser && r.source.startsWith('Organiser file ')))) : [];
    if (!own.length) return [];
    const text = JSON.stringify(own, null, 2);
    return [{ id: s.id, text, lines: text.split('\n'), sha256: sha(text) }];
  });
  return { ...packet, sources, evidenceVersion: evidenceVersionOf(sources, packet.photos) };
}

/** Whether the Evidence Collector looks outside data up for this packet at this pin: a dataset case at evidence checks 4 or later (the
 * cases that get outside_lookup; a legacy sample or an uploaded case does not). The page shows the External tab by it. */
export const looksUpOutside = (packet: CasePacket, evidenceChecks: CasePacket['evidenceChecks']) => isDatasetPacket(packet) && hasOutsideLookups({ ...packet, evidenceChecks });
/** For the page: the Evidence Collector can look something up here, as looksUpOutside and the record names at
 * least one place, since every lookup is for a place the record gives (an uploaded case's files name none). */
export const canLookUpOutside = (packet: CasePacket, evidenceChecks: CasePacket['evidenceChecks']) => looksUpOutside(packet, evidenceChecks) && placeNames.some(n => !!recordPlace(packet, n));
/** A run's packet as it starts: without advance outside data when it is a dataset case pinned at evidence checks 4 or later (the web's
 * run creation, the CLI and the local runner; a Judge-only retry passes its parent's pin, so it gets its parent's packet). */
export function startingPacket<P extends CasePacket>(packet: P, evidenceChecks: CasePacket['evidenceChecks']): P {
  return looksUpOutside(packet, evidenceChecks) ? withoutAdvanceOutsideData(packet) as P : packet;
}

/** AD-14: the team's saved copy of OneMap answers (evidence/tools/save-onemap-copy.mjs), used only when OneMap refuses the live call. */
const registersRoot = () => process.env.EVIDENCE_REGISTERS_ROOT ?? path.join(process.cwd(), 'evidence/registers');
export function savedOnemapPlace(caseId: string, place: PlaceName, at: Pt): { fetchedAt: string; answer: OnemapPlace } | null {
  let register: any; try { register = JSON.parse(readFileSync(/*turbopackIgnore: true*/ path.join(registersRoot(), 'onemap-places.json'), 'utf8')); } catch { return null; }
  const entry = register?.version === 1 ? register.entries?.[caseId]?.[place] : null;
  // A copy saved for a position the case no longer has is not this place: no stale answer.
  if (!entry || !(metres(at, entry.at) <= 1) || !Array.isArray(entry.answer?.buildings) || typeof register.fetched_at !== 'string') return null;
  return { fetchedAt: register.fetched_at, answer: entry.answer };
}
