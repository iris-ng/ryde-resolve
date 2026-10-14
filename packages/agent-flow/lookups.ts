import { z } from 'zod';
import type { CasePacket, Source } from './contracts';
import type { Fact, Facts } from './facts';
import { elementRanges } from './own-side';
import { normaliseQuoteText, normaliseWords } from './quotes';
import { strictInstant } from '../evidence-collection/consistency';
import { haversineMetres } from '../evidence-collection/observations';

// Evidence checks 2 (MVP fixes F2 and F3, second release, 10 October 2026). Until now an advocate opened whole files and never chose
// what to look at. These lookups query the record the way an investigator would: words, a time window, one sender, one kind of app
// event. Each one reads the pinned sources by place and structured fields only (own-side.ts elementRanges, the times route-checks.ts
// reads), never a model's reading. Every line a lookup returns counts as read, so it can be cited. request_record asks whether the case
// has a kind of record at all (on record, not on record, or can't be checked), and answers from the kind and the packet's own sources alone: what and why are never read for meaning.

export const lookupTools = ['find_in_record', 'gps_between', 'chat_messages', 'payment_records', 'app_events', 'party_history', 'route_checks'] as const;
export type LookupTool = typeof lookupTools[number];
export const recordKinds = ['gps', 'chat', 'call_log', 'payments', 'receipts', 'photos', 'app_events', 'eta', 'route', 'statements', 'documents', 'rainfall', 'traffic', 'cctv_or_dashcam', 'phone_records_outside_app', 'other'] as const;
export type RecordKind = typeof recordKinds[number];
// The owner's words (10 October 2026): on record (the case record has it, with the lines), not on record (no such record exists in the
// case), can't be checked (outside what the system can look up, such as rain or traffic on a past date).
export const recordAnswers = ['on_record', 'not_on_record', 'cannot_check'] as const;
/** The most record requests one task may make; a gap point rests on one of them (contracts.ts allows three gap points). */
export const maxRecordRequests = 3;
/** What the event trail shows for an advocate's free-text argument before the paired disclosure (citations.ts, rule 1). */
export const sealedText = '(sealed until disclosure)';
const maxMatches = 20, maxElements = 40, maxLines = 150;

type Range = { sourceId: string; startLine: number; endLine: number };
type Line = { line: number; text: string };
// A time with an explicit offset, read as route-checks.ts reads times (consistency.ts strictInstant): never the server's zone.
const time = z.string().max(40).refine(v => strictInstant(v) !== null, 'A time needs a date, a time and an explicit offset, such as 2026-09-13T08:40:00+08:00.');
const caseId = z.string();
export const lookupArgs = {
  find_in_record: z.object({ caseId, query: z.string().max(200).refine(v => normaliseWords(v).length > 0, 'Give at least one word or number.') }).strict(),
  // party rider (14 October 2026) reads the rider's app location (rider_location.readings) where the record carries one; driver by default.
  gps_between: z.object({ caseId, from: time, to: time, party: z.enum(['driver', 'rider']).optional() }).strict().refine(a => strictInstant(a.to)! >= strictInstant(a.from)!, 'to comes before from: give the earlier time in from.'),
  chat_messages: z.object({ caseId, sender: z.enum(['rider', 'driver', 'system']).optional(), from: time.optional(), to: time.optional() }).strict(),
  payment_records: z.object({ caseId }).strict(),
  app_events: z.object({ caseId, type: z.string().max(80).optional() }).strict(),
  party_history: z.object({ caseId, party: z.enum(['rider', 'driver']) }).strict(),
  route_checks: z.object({ caseId }).strict(),
} as const;
// what and why are recorded (and disclosed with the argument), never read; a long one is cut, not refused, so a request always answers.
export const requestArgs = z.object({ caseId, kind: z.enum(recordKinds), what: z.string().transform(v => v.slice(0, 600)), why: z.string().transform(v => v.slice(0, 600)) }).strict();

const parse = (source: Source | undefined): unknown => { try { return source ? JSON.parse(source.text) : null; } catch { return null; } };
const sourceOf = (packet: Pick<CasePacket, 'sources'>, block: string) => packet.sources.find(s => s.id === `evidence/${block}.json`);
const linesOf = (source: Source, startLine: number, endLine: number): Line[] => source.lines.slice(startLine - 1, endLine).map((text, i) => ({ line: startLine + i, text }));
/** A top-level array source's elements with their exact lines (own-side.ts elementRanges), or none when it is not in the pinned form. */
function elements(packet: Pick<CasePacket, 'sources'>, block: string): { source: Source; items: { value: any; startLine: number; endLine: number }[] } | null {
  const source = sourceOf(packet, block), value = parse(source), ranges = source ? elementRanges(source) : null;
  if (!source || !Array.isArray(value) || !ranges) return null;
  return { source, items: value.map((v, i) => ({ value: v, ...ranges[i] })) };
}
/**
 * The rider's readings (evidence/rider_location.json, `readings`) with their exact lines. The block is an object, so elementRanges
 * does not apply directly: its readings array is laid out exactly as a top-level array would be, two spaces deeper, so each reading
 * spans the same lines as in JSON.stringify(readings, null, 2), offset to the line that opens `"readings": [`.
 */
function riderReadings(packet: Pick<CasePacket, 'sources'>): { source: Source; items: { value: any; startLine: number; endLine: number }[] } | null {
  const source = sourceOf(packet, 'rider_location'), value = parse(source) as any;
  if (!source || !value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.readings)) return null;
  if (source.text !== JSON.stringify(value, null, 2)) return null;
  const opens = source.lines.findIndex(l => l === '  "readings": [');
  if (opens < 0) return { source, items: [] };
  const synthetic = JSON.stringify(value.readings, null, 2), ranges = elementRanges({ ...source, text: synthetic, lines: synthetic.split('\n') });
  if (!ranges) return null;
  // In the synthetic array the first element starts at line 2; in the source, at the line after the opener (opens is 0-based).
  return { source, items: value.readings.map((v: any, i: number) => ({ value: v, startLine: opens + ranges[i].startLine, endLine: opens + ranges[i].endLine })) };
}
/** Line ranges joined where they touch, per source, in order: the trail and the read coverage. */
export function mergedRanges(ranges: Range[]): Range[] {
  const out: Range[] = [];
  for (const r of [...ranges].sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.startLine - b.startLine)) {
    const last = out.at(-1);
    if (last && last.sourceId === r.sourceId && r.startLine <= last.endLine + 1) last.endLine = Math.max(last.endLine, r.endLine);
    else out.push({ ...r });
  }
  return out;
}
const capped = <T>(items: T[], max: number, what: string) => ({ shown: items.slice(0, max), ...(items.length > max ? { more: `${items.length - max} more ${what} not shown; narrow the lookup.` } : {}) });
const whole = (source: Source | undefined) => source ? { sourceId: source.id, lines: linesOf(source, 1, Math.min(source.lines.length, maxLines)), ...(source.lines.length > maxLines ? { nextStartLine: maxLines + 1 } : {}) } : null;
const inWindow = (at: unknown, from?: string, to?: string) => { if (from === undefined && to === undefined) return true; const t = strictInstant(at); return t !== null && (from === undefined || t >= strictInstant(from)!) && (to === undefined || t <= strictInstant(to)!); };
const pinOf = (packet: Pick<CasePacket, 'sources'>) => { const p = (parse(sourceOf(packet, 'trip_data')) as any)?.pickup_location; return p && Number.isFinite(p.lat) && Number.isFinite(p.lng) ? { lat: p.lat as number, lng: p.lng as number } : null; };
const factOut = (f: Fact) => ({ id: f.id, value: f.value, explanation: f.explanation, citations: f.citations });
/** The route facts: the route record's summary (facts 1 to 5) and the route checks worked out from the GPS (route-checks.ts, facts 6). */
export const routeFactIds = ['route_extra_distance_km', 'route_extra_duration_min', 'erp_gantries_planned_vs_actual', 'route_consent_recorded', 'unexpected_stops', 'route_path_length_km', 'route_offset_from_planned_path_m', 'route_stops_in_gps_trace', 'trip_end_vs_first_destination_eta_min', 'best_road_route_km'];

export type LookupOutcome = { result: unknown; returned: Range[]; args: Record<string, unknown> };
/** Runs one lookup. `returned` is every line range whose text the result carries: those lines count as read. Errors name no model text. */
export function runLookup(packet: CasePacket, facts: Facts, name: LookupTool, input: unknown): LookupOutcome {
  const { caseId: _case, ...args } = lookupArgs[name].parse(input) as Record<string, any>;
  const returned: Range[] = [], take = (source: Source, lines: Line[]) => { if (lines.length) returned.push({ sourceId: source.id, startLine: lines[0].line, endLine: lines.at(-1)!.line }); return lines; };
  const element = (source: Source, e: { startLine: number; endLine: number }) => ({ startLine: e.startLine, endLine: e.endLine, lines: take(source, linesOf(source, e.startLine, e.endLine)) });
  let result: unknown;
  if (name === 'find_in_record') {
    // Every word of the query on one line, after the quote normalisation (case, quotes, dashes, spacing, JSON escapes).
    const words = normaliseWords(args.query).split(' '), hits: { sourceId: string; line: number; text: string }[] = [];
    for (const source of packet.sources.filter(s => s.id.startsWith('evidence/') && s.id.endsWith('.json')))
      source.lines.forEach((text, i) => { const line = normaliseQuoteText(text); if (words.every(w => line.includes(w))) hits.push({ sourceId: source.id, line: i + 1, text }); });
    const { shown, more } = capped(hits, maxMatches, 'matching lines');
    for (const h of shown) returned.push({ sourceId: h.sourceId, startLine: h.line, endLine: h.line });
    result = { notice: 'Lines of the case record (evidence/*.json) holding every word or number you gave, ignoring case. A match is a place to look, not a finding. Each line shown counts as read.', total: hits.length, matches: shown, ...(more ? { more } : {}) };
  } else if (name === 'gps_between' && args.party === 'rider') {
    const rider = riderReadings(packet), pin = pinOf(packet), block = parse(sourceOf(packet, 'rider_location')) as any;
    const items = (rider?.items ?? []).filter(e => inWindow(e.value?.timestamp, args.from, args.to)), { shown, more } = capped(items, maxElements, 'readings');
    for (const e of shown) returned.push({ sourceId: rider!.source.id, startLine: e.startLine, endLine: e.endLine });
    const sharing = block && typeof block === 'object' && !Array.isArray(block) ? block.sharing : undefined;
    result = { notice: `The rider's app location readings recorded from ${args.from} to ${args.to}, inclusive (evidence/rider_location.json). metresToPickup is the straight-line distance from the reading to the pickup pin (trip_data pickup_location), rounded to the metre; null when either position cannot be read. A phone reports when the app has permission and is running: sparse readings are the norm, and a reading is a position at one moment, within its accuracy. Lines returned count as read.`,
      ...(sharing !== undefined ? { sharing } : {}), ...(sharing === 'not_shared' ? { note: `The rider's app shared no location${typeof block.reason === 'string' ? ': ' + block.reason : '.'} Not sharing is not itself absence.` } : {}),
      readings: rider ? shown.map(e => { const v = e.value ?? {}, at = Number.isFinite(v.lat) && Number.isFinite(v.lng) ? { lat: v.lat, lng: v.lng } : null;
        return { timestamp: v.timestamp ?? null, ...(v.accuracy_m !== undefined ? { accuracy_m: v.accuracy_m } : {}), ...(v.app_state !== undefined ? { app_state: v.app_state } : {}), metresToPickup: at && pin ? haversineMetres(at, pin) : null, ...element(rider.source, e) }; }) : [],
      ...(more ? { more } : {}), ...(!rider && sharing === undefined ? { note: 'The record carries no rider location (no evidence/rider_location.json): a different state from a rider whose app shared none.' } : {}) };
  } else if (name === 'gps_between') {
    const gps = elements(packet, 'gps_telemetry'), pin = pinOf(packet);
    const items = (gps?.items ?? []).filter(e => inWindow(e.value?.timestamp, args.from, args.to)), { shown, more } = capped(items, maxElements, 'samples');
    const unreadable = (gps?.items ?? []).filter(e => strictInstant(e.value?.timestamp) === null).length;
    result = { notice: `GPS samples recorded from ${args.from} to ${args.to}, inclusive. metresToPickup is the straight-line distance from the sample to the pickup pin (trip_data pickup_location), rounded to the metre; null when either position cannot be read. A sample is a position and a speed at one moment, not where the car was between samples, and not a speed finding.`,
      samples: gps ? shown.map(e => { const v = e.value ?? {}, at = Number.isFinite(v.lat) && Number.isFinite(v.lng) ? { lat: v.lat, lng: v.lng } : null;
        return { timestamp: v.timestamp ?? null, speed_kmh: Number.isFinite(v.speed_kmh) ? v.speed_kmh : null, ...(v.accuracy_m !== undefined ? { accuracy_m: v.accuracy_m } : {}), metresToPickup: at && pin ? haversineMetres(at, pin) : null, ...element(gps.source, e) }; }) : [],
      ...(more ? { more } : {}), ...(!gps ? { note: 'The record has no GPS samples (evidence/gps_telemetry.json) in a form this lookup reads.' } : unreadable ? { note: `${unreadable} sample${unreadable === 1 ? ' has' : 's have'} no time with an offset, so ${unreadable === 1 ? 'it is' : 'they are'} left out of every window.` } : {}) };
  } else if (name === 'chat_messages') {
    const chat = elements(packet, 'chat_logs'), items = (chat?.items ?? []).filter(e => (args.sender === undefined || e.value?.sender === args.sender) && inWindow(e.value?.timestamp, args.from, args.to));
    const { shown, more } = capped(items, maxElements, 'entries');
    result = { notice: 'Chat entries as recorded, with their exact lines in evidence/chat_logs.json. A call entry is the app\'s log of a call and a system entry is Ryde\'s; a message sent is not a message read.', entries: chat ? shown.map(e => ({ timestamp: e.value?.timestamp ?? null, sender: e.value?.sender ?? null, type: e.value?.type ?? null, ...element(chat.source, e) })) : [],
      ...(more ? { more } : {}), ...(!chat ? { note: 'The record has no chat log (evidence/chat_logs.json) in a form this lookup reads.' } : {}) };
  } else if (name === 'payment_records') {
    const payments = whole(sourceOf(packet, 'payment_events')), fare = whole(sourceOf(packet, 'fare_breakdown'));
    for (const [block, part] of [['payment_events', payments], ['fare_breakdown', fare]] as const) if (part) take(sourceOf(packet, block)!, part.lines);
    result = { notice: 'The payment events and the fare lines as recorded. A recorded fee is not a settled payment, and an authorisation hold is not a charge; read_calculations reconciles them.', payments: payments ?? { note: 'The record has no payment events (evidence/payment_events.json).' }, fare: fare ?? { note: 'The record has no fare breakdown (evidence/fare_breakdown.json).' } };
  } else if (name === 'app_events') {
    const events = elements(packet, 'app_events'), types = [...new Set((events?.items ?? []).map(e => e.value?.event_type).filter((t): t is string => typeof t === 'string'))];
    const items = (events?.items ?? []).filter(e => args.type === undefined || e.value?.event_type === args.type), { shown, more } = capped(items, maxElements, 'events');
    result = { notice: 'App events as recorded, with their exact lines in evidence/app_events.json.', types, events: events ? shown.map(e => ({ timestamp: e.value?.timestamp ?? null, event_type: e.value?.event_type ?? null, ...element(events.source, e) })) : [],
      ...(more ? { more } : {}), ...(!events ? { note: 'The record has no app events (evidence/app_events.json) in a form this lookup reads.' } : args.type !== undefined && !items.length ? { note: 'No event of that type is recorded; types lists the ones that are.' } : {}) };
  } else if (name === 'party_history') {
    // The other helper's past-behaviour facts (history-checks.ts) start with the party's name and "_history"; read whatever facts 7 gives.
    const profile = whole(sourceOf(packet, `${args.party}_profile`));
    if (profile) take(sourceOf(packet, `${args.party}_profile`)!, profile.lines);
    result = { notice: `Past behaviour is not proof about this trip: a rating, a count of earlier disputes or an earlier claim says nothing by itself about what happened on this trip. Shown so you can answer it, never to label the ${args.party}.`, profile: profile ?? { note: `The record has no ${args.party} profile.` }, facts: facts.facts.filter(f => f.id.startsWith(`${args.party}_history`)).map(factOut) };
  } else {
    const found = facts.facts.filter(f => routeFactIds.includes(f.id)).map(factOut);
    result = { notice: 'The route facts worked out from the route record and the GPS, each with the lines it rests on. They are arithmetic on the record, not findings; read the cited lines before citing them.', facts: found, ...(found.length ? {} : { note: 'This case has no route record (evidence/route_data.json), so there are no route facts.' }) };
  }
  return { result: { untrustedEvidence: true, ...(result as object) }, returned: mergedRanges(returned), args };
}

export type RecordAnswer = { answer: typeof recordAnswers[number]; points: Range[]; note: string };
/**
 * Whether the case has a record of this kind, from the kind and the packet's own sources only: on_record (with the lines that have it),
 * not_on_record, or cannot_check. A dispute is always about a past trip, so rainfall and traffic the case record does not have cannot be
 * checked: Ryde keeps neither, and the feeds report the time they are asked. CCTV or dashcam footage, calls outside the app and any
 * other kind are never part of a case record. The saved best road route is the team's reference, not a Ryde record.
 */
export function recordAnswer(packet: Pick<CasePacket, 'sources'>, kind: RecordKind): RecordAnswer {
  // A real entry of the kind, never mere presence: an empty object, a null or a malformed entry is not
  // a record, so a gap point on a record the case lacks is not refused because of it. Points are the real entries' own lines.
  const words = (v: unknown) => typeof v === 'string' && v.trim().length > 0, at = (v: unknown) => strictInstant(v) !== null, num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  const party = (v: unknown) => v === 'rider' || v === 'driver', thing = (e: any) => !!e && typeof e === 'object' && !Array.isArray(e);
  const some = (block: string, keep: (e: any) => boolean): Range[] => { const e = elements(packet, block); return e ? mergedRanges(e.items.filter(x => thing(x.value) && keep(x.value)).map(x => ({ sourceId: e.source.id, startLine: x.startLine, endLine: x.endLine }))) : []; };
  // A document is present with its document ID (the schema requires one) and either a file reference or its content, whatever was
  // extracted from it.
  const document = (e: any) => words(e.document_id) && (words(e.filename) || words(e.text) || (thing(e.extracted_fields) && Object.keys(e.extracted_fields).length > 0));
  // The statement authors the dataset schema allows (evidence/schema/dispute-dataset.schema.json): the parties, a witness, support.
  const author = (v: unknown) => party(v) || v === 'witness' || v === 'support';
  const external = (test: RegExp) => some('external_context', e => typeof e.kind === 'string' && test.test(e.kind) && words(e.summary));
  // A route leg is a record when it has a finite distance, or at least two points that are each a valid [lat, lng] pair (the schema's form).
  const pair = (p: unknown) => Array.isArray(p) && p.length === 2 && num(p[0]) && num(p[1]) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180;
  const route = (): Range[] => { const s = sourceOf(packet, 'route_data'), v = parse(s) as any, leg = (r: any) => thing(r) && ((Array.isArray(r.points) && r.points.length >= 2 && r.points.every(pair)) || num(r.distance_km));
    return s && thing(v) && (leg(v.planned_route) || leg(v.actual_route)) ? [{ sourceId: s.id, startLine: 1, endLine: s.lines.length }] : []; };
  const answered = (points: Range[], none: string, missing: RecordAnswer['answer'] = 'not_on_record'): RecordAnswer => points.length
    ? { answer: 'on_record', points, note: `On record: ${points.slice(0, 4).map(p => `${p.sourceId} lines ${p.startLine}-${p.endLine}`).join('; ')}${points.length > 4 ? ` and ${points.length - 4} more` : ''}. Read those lines (or use a lookup) and cite what they show; a record that is on record is not a gap.` }
    : { answer: missing, points: [], note: none };
  switch (kind) {
    case 'gps': return answered(some('gps_telemetry', e => at(e.timestamp) && num(e.lat) && num(e.lng)), 'Not on record: the case record has no GPS samples for this trip.');
    case 'chat': return answered(some('chat_logs', e => party(e.sender) && e.type !== 'call' && e.type !== 'system' && words(e.content)), 'Not on record: the case record has no chat messages between the rider and the driver.');
    case 'call_log': return answered(mergedRanges([...some('chat_logs', e => e.type === 'call' && party(e.sender) && at(e.timestamp)), ...some('app_events', e => typeof e.event_type === 'string' && /call/i.test(e.event_type) && at(e.timestamp))]), 'Not on record: the case record has no in-app call between the rider and the driver.');
    case 'payments': return answered(some('payment_events', e => words(e.type) && num(e.amount)), 'Not on record: the case record has no payment events for this trip.');
    case 'receipts': return answered(some('documents', e => typeof e.kind === 'string' && /receipt/i.test(e.kind) && document(e)), 'Not on record: the case record has no receipt.');
    case 'photos': return answered(some('photos', e => words(e.photo_id) || words(e.filename)), 'Not on record: the case record has no photos.');
    case 'app_events': return answered(some('app_events', e => words(e.event_type) && at(e.timestamp)), 'Not on record: the case record has no app events.');
    case 'eta': return answered(some('eta_history', e => words(e.target) && at(e.estimated_arrival_at)), 'Not on record: the case record has no arrival estimates (eta_history).');
    case 'route': return answered(route(), 'Not on record: the case record has no route record (route_data); the saved best road route is the team\'s reference, not a Ryde record.');
    case 'statements': return answered(some('statements', e => author(e.party) && words(e.text)), 'Not on record: the case record has no statements.');
    // A document the operator added to the case (uploads/*) is part of its record too.
    case 'documents': return answered([...some('documents', document), ...packet.sources.filter(s => s.id.startsWith('uploads/') && s.text.trim()).map(s => ({ sourceId: s.id, startLine: 1, endLine: s.lines.length }))], 'Not on record: the case record has no documents.');
    case 'rainfall': return answered(external(/weather|rain/i), 'Can\'t be checked: Ryde keeps no rainfall record for a trip and the case record has none, and the rainfall at a past trip\'s place and time is outside what the system can look up.', 'cannot_check');
    case 'traffic': return answered(external(/traffic/i), 'Can\'t be checked: Ryde keeps no traffic record for a trip and the case record has none, and the traffic feed reports only incidents at the time it is asked, never a past trip\'s.', 'cannot_check');
    case 'cctv_or_dashcam': return answered([], 'Not on record: Ryde has no CCTV or dashcam footage, and none is part of a case record.');
    case 'phone_records_outside_app': return answered([], 'Not on record: Ryde has only the calls and messages made in the app; calls, texts or messages outside it are not part of the record.');
    default: return answered([], 'Not on record: only the kinds in the list can be looked up, and a record of another kind is not part of this case record.');
  }
}

/**
 * The arguments the event trail shows before disclosure: free text (find_in_record's query, request_record's what and why) sealed, and
 * a structured argument only when it is one (a time with an offset, a sender, a party, a record kind, an event type the record holds).
 * Anything else is hidden, so model-written text cannot reach the trail dressed as a time, a type or a field name (citations.ts, rule 1).
 */
export function shownLookupArgs(packet: Pick<CasePacket, 'caseId' | 'sources'>, args: Record<string, unknown>): Record<string, unknown> {
  const eventTypes = new Set<unknown>((elements(packet, 'app_events')?.items ?? []).map(e => e.value?.event_type).filter(t => typeof t === 'string'));
  const shown = (k: string, v: unknown): unknown => {
    if (k === 'query' || k === 'what' || k === 'why') return sealedText;
    if (k === 'caseId') return v === packet.caseId ? v : '(not this case)';
    if (k === 'from' || k === 'to') return typeof v === 'string' && strictInstant(v) !== null ? v : '(not a time with an offset)';
    if (k === 'sender') return ['rider', 'driver', 'system'].includes(v as string) ? v : '(not a sender)';
    if (k === 'party') return ['rider', 'driver'].includes(v as string) ? v : '(not a party)';
    if (k === 'kind') return (recordKinds as readonly unknown[]).includes(v) ? v : '(not a record kind)';
    return eventTypes.has(v) ? v : '(not an event type in this record)';
  };
  // A field the tool does not take is counted, not named: its name is model-written too.
  const known = ['query', 'what', 'why', 'caseId', 'from', 'to', 'sender', 'party', 'kind', 'type'], other = Object.keys(args).filter(k => !known.includes(k)).length;
  return { ...Object.fromEntries(Object.entries(args).filter(([k]) => known.includes(k)).map(([k, v]) => [k, shown(k, v)])), ...(other ? { otherFields: other } : {}) };
}
