import { TrustedRejection } from '../agent-flow/citations';
import type { CasePacket, OutsideCall, OutsideKind } from '../agent-flow/contracts';
import { placeNames, readingTimes, recordPlace, recordWindow, windowNames, type PlaceName, type WindowName } from './places';
import { heldKeys, ltaNearby, mapillaryNearest, onemapPlace, osrmRoute, outsideKeys, rainfall, type Fetch, type Fetched, type Status } from './providers';
import { outsideCall, outsideRecordText, savedOnemapPlace } from './records';
import { readStreetPicture } from './street-reading';

export type LookupArgs = { source: OutsideKind; place?: PlaceName; window?: WindowName };
/** What the tool server calls: in a live run the bridge to the worker, which holds the keys; elsewhere a keyless local lookup. */
export type LookupOutside = (args: LookupArgs, n: number, requestId: string) => Promise<{ call: OutsideCall; status: Status }>;

/** One outside_lookup (AD-11 to AD-14): from the named place and time in the record to a saved, citable record. Refusals say what to ask instead. */
/**
 * Whether a record carries a key: the key, or any 12-character run of it, in the text as written, URL-decoded or
 * with JSON escapes undone. A key cut into pieces shorter than 12 characters is not caught; no provider here returns our keys at all,
 * so this is a second line behind keys travelling in headers only.
 */
export function carriesKey(text: string, keys: string[]): boolean {
  // Every string in the record (names and values), each on its own: as written, with %XX sequences decoded one by one (a stray % elsewhere
  // cannot stop it), with \\uXXXX escapes undone, and both; plus the record text itself.
  const strings: string[] = [text];
  const walk = (v: unknown): void => { if (typeof v === 'string') strings.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { strings.push(k); walk(x); } };
  try { walk(JSON.parse(text)); } catch { /* the text alone */ }
  const percent = (s: string) => s.replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  const unicode = (s: string) => s.replace(/\\u([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  const forms = strings.flatMap(s => [s, percent(s), unicode(s), unicode(percent(s)), percent(unicode(s))]);
  return keys.some(k => { const runs = k.length <= 12 ? [k] : Array.from({ length: k.length - 11 }, (_, i) => k.slice(i, i + 12)); return runs.some(r => forms.some(f => f.includes(r))); });
}
/** Every lookup finishes within this budget, under the bridge's own wait (outside-bridge.ts), so a slow source becomes an unavailable record. */
export const lookupBudgetMs = 90000;
/** The largest record a lookup saves; a larger answer is recorded as unavailable, so it can never block the Collector's submission. */
export const maxRecordChars = 40000;
export async function outsideLookup(packet: Pick<CasePacket, 'caseId' | 'sources'>, args: LookupArgs, opts: { fetch: Fetch; env: Record<string, string | undefined>; n: number; requestId: string; signal?: AbortSignal; budgetMs?: number }): Promise<{ call: OutsideCall; status: Status }> {
  const keys = outsideKeys(opts.env), f = opts.fetch, signal = AbortSignal.any([opts.signal ?? new AbortController().signal, AbortSignal.timeout(opts.budgetMs ?? lookupBudgetMs)]), onRecord = () => placeNames.filter(p => recordPlace(packet, p)).join(', ') || 'none';
  const needsPlace = args.source !== 'road_route';
  if (needsPlace && !args.place) throw new TrustedRejection(`source ${args.source} needs a place: one of ${onRecord()}`);
  const place = needsPlace ? recordPlace(packet, args.place!) : null;
  if (needsPlace && !place) throw new TrustedRejection(`The record has no ${args.place} position. Places on record: ${onRecord()}`);
  if (args.source === 'rainfall' && !args.window) throw new TrustedRejection(`source rainfall needs a window: one of ${windowNames.filter(w => recordWindow(packet, w)).join(', ') || 'none on record'}`);
  const window = args.source === 'rainfall' ? recordWindow(packet, args.window!) : null;
  if (args.source === 'rainfall' && !window) throw new TrustedRejection(`The record has no ${args.window} window. Windows on record: ${windowNames.filter(w => recordWindow(packet, w)).join(', ') || 'none'}`);
  let fetched: Fetched<unknown>, via: 'live' | 'saved_copy' = 'live', savedAt: string | undefined;
  if (args.source === 'rainfall') fetched = await rainfall(f, keys, place!, readingTimes(window!), signal);
  else if (args.source === 'place') {
    fetched = await onemapPlace(f, keys, place!, signal);
    // AD-14: when OneMap refuses the live call, the team's saved copy answers, labelled; a copy for a moved place is never used.
    if (fetched.status === 'unavailable' && !signal.aborted) { const saved = savedOnemapPlace(packet.caseId, args.place!, place!); if (saved) { fetched = { ...fetched, status: 'received', answer: saved.answer, reason: `OneMap refused the live lookup (${fetched.reason})` }; via = 'saved_copy'; savedAt = saved.fetchedAt; } }
  } else if (args.source === 'transport') fetched = await ltaNearby(f, keys, place!, 250, signal);
  else if (args.source === 'street_picture') {
    const { image, ...pic } = await mapillaryNearest(f, keys, place!, 40, signal);
    if (pic.status === 'received' && image && pic.answer) { const read = await readStreetPicture(f, opts.env, image, opts.requestId, signal); fetched = { ...pic, answer: { ...pic.answer, reader: { model: read.model, status: read.status, ...(read.reason ? { reason: read.reason } : {}) }, reading: read.reading } }; }
    else fetched = pic;
  } else {
    const from = recordPlace(packet, 'trip_start'), to = recordPlace(packet, 'trip_end');
    if (!from || !to) throw new TrustedRejection('The record has no trip start and end, so there is no road route to look up');
    fetched = await osrmRoute(f, { lat: from.lat, lng: from.lng }, { lat: to.lat, lng: to.lng }, signal);
  }
  const asked = { source: args.source, place: args.place ?? null, ...(place ? { lat: place.lat, lng: place.lng, from_record: place.from } : {}), window: window ? { name: window.name, from: window.from, to: window.to, capped_at_60_minutes: window.capped } : null };
  const record = (r: Fetched<unknown>) => outsideRecordText(args.source, opts.n, { asked, fetchedAt: r.fetchedAt, status: r.status, ...(r.reason ? { reason: r.reason } : {}), via, ...(savedAt ? { savedAt } : {}), answer: r.answer, endpoint: r.endpoint, rawSha256: r.rawSha256 });
  let text = record(fetched);
  // Two last guards before anything leaves the worker: a reply that carries one of our keys, or one too large to
  // record, is saved as unavailable with a fixed reason, so a key never reaches an agent and no record can block a submission.
  const leak = carriesKey(text, heldKeys(opts.env));
  if (leak || text.length > maxRecordChars) { fetched = { ...fetched, status: 'unavailable', answer: null, rawSha256: null, reason: leak ? 'the reply could not be recorded safely' : 'the reply was too large to record' }; via = 'live'; savedAt = undefined; text = record(fetched); }
  return { call: outsideCall(args.source, opts.n, args.place ?? null, args.window ?? null, text), status: fetched.status };
}
