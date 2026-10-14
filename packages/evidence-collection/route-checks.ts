import type { CasePacket } from '../agent-flow/contracts';
import type { Cite, Fact } from '../agent-flow/facts';
import { datasetBlock } from '../case-packet/dataset';
import { gpsStandard } from './cancellation-facts';
import { strictInstant } from './consistency';

// Facts 6 (MVP fixes, 10 October 2026): route checks worked out from the GPS points themselves (path lengths, how far the
// car strayed from the planned path, stops found in the trace, trip time against the first ETA, the saved best road route),
// beside, never instead of, the route summary typed into the record. Arithmetic on the record, not a finding of wrongdoing.
// `cite(block, needle)` cites the line of evidence/<block>.json that contains needle (or the whole source).

/**
 * Team route standard (owner's MVP fixes plan, 10 October 2026). A path length agrees with the typed distance within 10%; a
 * sample is off the planned path beyond 300 m; a stop is 2 minutes or more at 3 km/h or less with every position within 50 m
 * (the GPS standard's parked speed and cluster); the trace must meet the GPS standard (accuracy, at least 4 samples, gaps of
 * 60 s or less, a sample within 15 s of each end of the trip) before stops are looked for; late is more than 10 minutes after
 * the first destination ETA shown to the rider; a saved best road route is compared with a trip whose ends lie within 250 m of its own.
 */
export const routeStandard = { lengthTolerance: 0.1, offPathM: 300, stopMinS: 120, stopSpeedKmh: gpsStandard.parkedSpeedKmh, stopClusterM: gpsStandard.parkedClusterM, lateMin: 10, referenceEndsM: 250 } as const;

type Pt = { lat: number; lng: number };
type Sample = Pt & { t: number; at: string; speed: number | null };
/** A sample for the lab's maps: `rated` false when the reading has no accuracy figure (drawn, marked "accuracy not recorded"; never checked). */
export type DisplaySample = Sample & { rated: boolean };
const R = 6371000, rad = (d: number) => d * Math.PI / 180;
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null;
// A block or field that should be a list but is not reads as no rows, and one that should be an object as no fields: a malformed
// record gives unknown results, never an error.
const rowsOf = (v: unknown): any[] => Array.isArray(v) ? v : [];
const objectOf = (v: unknown): any => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
// Every time needs an explicit offset (consistency.ts): an offset-free or impossible time is unknown, never read in the server's zone.
const ms = strictInstant;
// Unrounded great-circle metres (observations.ts haversineMetres rounds each leg, and importing it would loop the modules).
const metres = (a: Pt, b: Pt) => { const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
/** A recorded point, as [lat, lng] (route_data) or { lat, lng }; null unless both are numbers in range. */
const point = (p: any): Pt | null => { const lat = num(Array.isArray(p) ? p[0] : p?.lat), lng = num(Array.isArray(p) ? p[1] : p?.lng); return lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null; };
/** A route's points, or null when there are fewer than two or any is unreadable (no guessed path). */
const line = (points: unknown): Pt[] | null => { if (!Array.isArray(points)) return null; const pts = points.map(point); return pts.length >= 2 && pts.every(Boolean) ? pts as Pt[] : null; };
const lengthM = (pts: Pt[]) => pts.slice(1).reduce((sum, p, i) => sum + metres(pts[i], p), 0);
/** Metres from p to segment a-b, on a flat projection centred on p (exact enough over a city). */
function toSegment(p: Pt, a: Pt, b: Pt) {
  const k = rad(1) * R, c = Math.cos(rad(p.lat)), ax = (a.lng - p.lng) * k * c, ay = (a.lat - p.lat) * k, dx = (b.lng - a.lng) * k * c, dy = (b.lat - a.lat) * k;
  const len = dx * dx + dy * dy, t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}
const offPath = (p: Pt, path: Pt[]) => Math.min(...path.slice(1).map((b, i) => toSegment(p, path[i], b)));
const km = (m: number) => Math.round(m / 10) / 100, tenth = (x: number) => Math.round(x * 10) / 10;

/**
 * The GPS samples that belong to the trip, by the GPS standard: a readable position, a time with an explicit offset inside the
 * trip's start and end, accuracy 20 m or better, and a time no other row shares; in time order. `window` is false when the trip
 * start or end time is missing or unreadable, and then no sample is eligible. The route checks below and the lab's route
 * drawing (live-fishbowl/checks-view.ts) both read the trace from here, so the page never draws a point the checks left out.
 */
export function tripSamples(packet: CasePacket): { window: boolean; samples: Sample[] } {
  const trip = objectOf(datasetBlock(packet, 'trip_data'));
  const start = ms(trip.trip_start_time), end = ms(trip.trip_end_time), window = start !== null && end !== null && end >= start;
  return { window, samples: window ? samplesBetween(packet, start!, end!) : [] };
}
/** The usable GPS samples between two instants, by the GPS standard (see tripSamples), in time order. */
function samplesBetween(packet: CasePacket, start: number, end: number): Sample[] {
  const rows = rowsOf(datasetBlock(packet, 'gps_telemetry')), times = rows.map(r => ms(r?.timestamp));
  return rows.flatMap((r, i) => {
    const p = point(r), t = times[i], acc = num(r?.accuracy_m);
    return p && t !== null && t >= start && t <= end && acc !== null && acc >= 0 && acc <= gpsStandard.accuracyM && times.filter(x => x === t).length === 1 ? [{ ...p, t, at: String(r.timestamp), speed: num(r?.speed_kmh) }] : [];
  }).sort((a, b) => a.t - b.t);
}
/**
 * The GPS samples the lab's maps draw between two instants (owner, 13 October 2026): every sample the GPS standard accepts, and
 * also a reading that records no accuracy figure at all, marked `rated: false` so the map shows it as "accuracy not recorded".
 * A reading whose accuracy is recorded and worse than 20 m stays out, as does one sharing its time with another. Display only:
 * no check, fact or route reads these; the checks keep samplesBetween.
 */
function displaySamplesBetween(packet: CasePacket, start: number, end: number): DisplaySample[] {
  const rows = rowsOf(datasetBlock(packet, 'gps_telemetry')), times = rows.map(r => ms(r?.timestamp));
  return rows.flatMap((r, i) => {
    const p = point(r), t = times[i], recorded = r?.accuracy_m !== undefined && r?.accuracy_m !== null, acc = num(r?.accuracy_m);
    const rated = acc !== null && acc >= 0 && acc <= gpsStandard.accuracyM;
    return p && t !== null && t >= start && t <= end && (rated || !recorded) && times.filter(x => x === t).length === 1 ? [{ ...p, t, at: String(r.timestamp), speed: num(r?.speed_kmh), rated }] : [];
  }).sort((a, b) => a.t - b.t);
}
/**
 * The rider's app readings the lab's waiting map draws between two instants (owner, 14 October 2026), by the same display rule as the
 * driver's: a reading the GPS standard accepts, or one with no accuracy figure marked unrated; one sharing its time with another stays
 * out. Display only. Empty when the record carries no rider location or the rider's app shared none.
 */
export function riderDisplaySamplesBetween(packet: CasePacket, start: number, end: number): DisplaySample[] {
  const block = objectOf(datasetBlock(packet, 'rider_location')), rows = block.sharing === 'shared' ? rowsOf(block.readings) : [], times = rows.map(r => ms(r?.timestamp));
  return rows.flatMap((r, i) => {
    const p = point(r), t = times[i], recorded = r?.accuracy_m !== undefined && r?.accuracy_m !== null, acc = num(r?.accuracy_m);
    const rated = acc !== null && acc >= 0 && acc <= gpsStandard.accuracyM;
    return p && t !== null && t >= start && t <= end && (rated || !recorded) && times.filter(x => x === t).length === 1 ? [{ ...p, t, at: String(r.timestamp), speed: null, rated }] : [];
  }).sort((a, b) => a.t - b.t);
}
/** The trip's samples as the route drawing shows them: tripSamples' window, with readings that record no accuracy marked unrated. */
export function tripDisplaySamples(packet: CasePacket): { window: boolean; samples: DisplaySample[] } {
  const trip = objectOf(datasetBlock(packet, 'trip_data'));
  const start = ms(trip.trip_start_time), end = ms(trip.trip_end_time), window = start !== null && end !== null && end >= start;
  return { window, samples: window ? displaySamplesBetween(packet, start!, end!) : [] };
}
/**
 * AD-9 (owner decision, 10 October 2026, docs/ARCHITECTURE-DECISIONS.md): what the lab's map draws for a trip that never started
 * (cancelled, with no trip start in the trip or in the app's events): the samples from the match (or the booking, when no match
 * time is recorded; fromEvent says which) to the cancellation, as displaySamplesBetween gives them. A record with neither time
 * (an organiser sample, 13 October 2026) starts at its first GPS reading, and fromEvent says so; a cancellation time with no trip
 * start or end counts as cancelled when the record has no trip status. Display only: no check, fact or route reads it. Null for a
 * started trip or a window the record cannot give.
 */
export function waitSamples(packet: CasePacket): { from: string; fromEvent: 'match' | 'booking' | 'first_reading'; to: string; samples: DisplaySample[] } | null {
  const trip = objectOf(datasetBlock(packet, 'trip_data'));
  const cancelled = trip.trip_status === 'cancelled' || (trip.trip_status === undefined && typeof trip.cancellation_time === 'string' && !trip.trip_end_time);
  if (trip.trip_start_time || !cancelled) return null;
  if (rowsOf(datasetBlock(packet, 'app_events')).some(e => e?.event_type === 'trip_started' || e?.type === 'trip_started')) return null;
  const end = ms(trip.cancellation_time);
  if (end === null) return null;
  if (typeof trip.match_time === 'string' || typeof trip.booking_time === 'string') {
    const fromEvent = typeof trip.match_time === 'string' ? 'match' as const : 'booking' as const, from = fromEvent === 'match' ? trip.match_time : trip.booking_time, start = ms(from);
    if (start === null || end < start) return null;
    return { from: String(from), fromEvent, to: String(trip.cancellation_time), samples: displaySamplesBetween(packet, start, end) };
  }
  const first = displaySamplesBetween(packet, -Infinity, end)[0];
  return first ? { from: first.at, fromEvent: 'first_reading', to: String(trip.cancellation_time), samples: displaySamplesBetween(packet, first.t, end) } : null;
}

export function routeCheckFacts(packet: CasePacket, cite: (block: string, needle?: string) => Cite): Fact[] {
  const block = datasetBlock(packet, 'route_data');
  if (block === null || block === undefined) return [];
  const route = objectOf(block);
  const facts: Fact[] = [], add = (id: string, value: unknown, explanation: string, citations: Cite[]) => facts.push({ id, value, explanation, citations });
  const has = (block: string) => packet.sources.some(s => s.id === `evidence/${block}.json`);
  const at = (block: string, needle?: string) => has(block) ? [cite(block, needle)] : [];
  const trip = objectOf(datasetBlock(packet, 'trip_data')), S = routeStandard, G = gpsStandard;
  const plannedRoute = objectOf(route.planned_route), actualRoute = objectOf(route.actual_route);
  const planned = line(plannedRoute.points), actual = line(actualRoute.points);
  const routeCites = [...at('route_data', '"planned_route"'), ...at('route_data', '"actual_route"')];

  // 1. Path lengths: the record's own points joined by straight lines, beside the typed distances.
  const length = (r: any, pts: Pt[] | null) => {
    const typed = num(r?.distance_km), m = pts ? lengthM(pts) : null;
    return { path_km: m === null ? null : km(m), typed_km: typed, points: Array.isArray(r?.points) ? r.points.length : 0, check: m === null || typed === null || typed <= 0 ? 'unknown' : Math.abs(m / 1000 - typed) <= S.lengthTolerance * typed ? 'agrees' : 'differs' };
  };
  const lengths = { planned: length(plannedRoute, planned), actual: length(actualRoute, actual) };
  const say = (name: string, l: ReturnType<typeof length>) => l.check === 'unknown' ? `${name}: unknown (${l.path_km === null ? 'its points cannot all be read, or there are fewer than two' : 'no typed distance'}).` : `${name}: ${l.points} points, ${l.path_km} km against ${l.typed_km} km typed (${l.check}).`;
  add('route_path_length_km', lengths, `Each route's recorded points joined by straight lines, beside the distance typed into the record: agrees within 10%, differs beyond it. ${say('Planned', lengths.planned)} ${say('Actual', lengths.actual)} A straight line is never longer than the road between the same two points, so with few points the path comes out shorter than the road and "differs" says the points are too few to measure it; a typed distance more than 10% below its own path would be too short. Arithmetic on the record, not a measurement of the road or a finding of wrongdoing.`, routeCites);

  // GPS during the trip: usable samples by the GPS standard (a position, accuracy 20 m or better, a time no other row shares).
  const start = ms(trip.trip_start_time), end = ms(trip.trip_end_time), { window, samples } = tripSamples(packet);
  const gpsCites = [...at('gps_telemetry'), ...at('trip_data', '"trip_start_time"'), ...at('trip_data', '"trip_end_time"')];
  const noWindow = 'The trip start or end time is missing or unreadable, so which GPS samples belong to the trip is unknown.';

  // 2. How far off the planned path: the furthest trip sample and actual-route point, and the sampled time more than 300 m off.
  if (!planned) add('route_offset_from_planned_path_m', null, 'The planned route\'s points cannot all be read, or there are fewer than two, so distance from the planned path is unknown.', [...routeCites, ...gpsCites]);
  else {
    const off = samples.map(s => ({ s, d: offPath(s, planned) })), far = off.reduce<typeof off[number] | null>((m, o) => !m || o.d > m.d ? o : m, null);
    const overS = off.slice(1).reduce((sum, o, i) => sum + (o.d > S.offPathM && off[i].d > S.offPathM ? (o.s.t - off[i].s.t) / 1000 : 0), 0);
    const furthestActual = actual ? Math.round(Math.max(...actual.map(p => offPath(p, planned)))) : null;
    add('route_offset_from_planned_path_m', { furthest_gps_sample_m: far ? Math.round(far.d) : null, furthest_gps_sample_at: far?.s.at ?? null, furthest_actual_route_point_m: furthestActual, sampled_minutes_over_300m: window ? tenth(overS / 60) : null, trip_gps_samples: window ? samples.length : null },
      `Straight-line metres from the planned path (the planned points joined by straight lines) to the furthest usable GPS sample between trip start and end${far ? ` (${Math.round(far.d)} m at ${far.s.at})` : ''} and to the furthest point of the actual route${furthestActual === null ? '' : ` (${furthestActual} m)`}. ${!window ? noWindow : !samples.length ? 'No usable GPS sample falls within the trip.' : `The sampled time more than 300 m off the path (${tenth(overS / 60)} minutes) counts only the time between consecutive samples that were both more than 300 m off; where the car was between samples is not recorded, so the real time off the path may be longer or shorter.`} The planned path is the record's points, not the roads, so a car on the planned roads can sit some way from a straight line between distant points. Distance from a path is not evidence of why the car was there.`,
      [...routeCites, ...gpsCites]);
  }

  // 3. Stops in the trace, against the typed list. Only a trace that meets the GPS standard over the whole trip can show them.
  const listed = objectOf(route.deviation_summary).unexpected_stops, typed: any[] | null = Array.isArray(listed) ? listed : null;
  const stopCites = [...at('gps_telemetry'), ...at('route_data', typed ? '"unexpected_stops"' : undefined), ...at('trip_data', '"trip_start_time"')];
  // A stop needs a speed, so a sample with none is left out here (the gap rule then decides whether enough remain).
  const moving = samples.filter(s => s.speed !== null), gaps = moving.slice(1).map((s, i) => (s.t - moving[i].t) / 1000), maxGap = gaps.length ? Math.max(...gaps) : null;
  const base = { typed_stops: typed?.length ?? null, trip_gps_samples: window ? moving.length : null, max_gap_s: maxGap };
  const dense = window && moving.length >= G.minSamples && (moving[0].t - start!) / 1000 <= G.edgeS && (end! - moving.at(-1)!.t) / 1000 <= G.edgeS && gaps.every(g => g <= G.maxGapS);
  if (!window) add('route_stops_in_gps_trace', { check: 'unknown', found: null, ...base }, noWindow, stopCites);
  else if (!dense) add('route_stops_in_gps_trace', { check: 'too_sparse', found: null, ...base }, `The GPS during the trip is too sparse to find stops (${moving.length} usable samples with a speed${maxGap === null ? '' : `, largest gap ${maxGap} s`}): the team's GPS standard needs at least 4 samples of 20 m accuracy or better, no gap over 60 s and a sample within 15 s of the trip's start and end. So whether the car stopped is unknown from the trace, not "no stop"; the typed stop list${typed ? ` (${typed.length})` : ''} is the record author's and is not checked here.`, stopCites);
  else {
    const found: { from: string; to: string; minutes: number; lat: number; lng: number; t0: number; t1: number }[] = [];
    let run: Sample[] = [];
    // A window that overlaps the stop before it (it shares samples) extends that stop, so one stop is never listed twice.
    const close = () => {
      if (run.length < 2 || (run.at(-1)!.t - run[0].t) / 1000 < S.stopMinS) return;
      const last = found.at(-1), endT = run.at(-1)!.t, endAt = run.at(-1)!.at;
      if (last && run[0].t <= last.t1) Object.assign(last, { to: endAt, t1: endT, minutes: tenth((endT - last.t0) / 60000) });
      else found.push({ from: run[0].at, to: endAt, minutes: tenth((endT - run[0].t) / 60000), lat: run[0].lat, lng: run[0].lng, t0: run[0].t, t1: endT });
    };
    for (const s of moving) {
      if (s.speed! > S.stopSpeedKmh) { close(); run = []; continue; }
      if (run.every(r => metres(r, s) <= S.stopClusterM)) { run.push(s); continue; }
      // A slow sample outside the window keeps the longest tail of the window it still fits with, so a stop that began
      // inside the window is not lost.
      close();
      let k = run.length;
      while (k > 0 && metres(run[k - 1], s) <= S.stopClusterM) k--;
      run = [...run.slice(k), s];
    }
    close();
    // A typed stop and a found one are the same when their times overlap, give or take one allowed gap (60 s) at each end.
    const spans = typed?.map(x => { const t0 = ms(x?.at), d = num(x?.duration_min) ?? 0; return t0 === null ? null : { t0, t1: t0 + Math.max(0, d) * 60000 }; }) ?? null;
    const meets = (a: { t0: number; t1: number }, b: { t0: number; t1: number }) => a.t0 <= b.t1 + G.maxGapS * 1000 && b.t0 <= a.t1 + G.maxGapS * 1000;
    const check = !spans || spans.some(s => s === null) ? 'unknown' : spans.every(s => found.some(f => meets(f, s!))) && found.every(f => spans.some(s => meets(f, s!))) ? 'agrees' : 'disagrees';
    const list = found.map(({ t0: _a, t1: _b, ...f }) => f);
    add('route_stops_in_gps_trace', { check, found: list, ...base },
      `Stops found in the GPS during the trip: ${list.length ? list.map(f => `${f.minutes} minutes from ${f.from}`).join('; ') : 'none'}. A stop here is 2 minutes or more at 3 km/h or less with every position within 50 m (overlapping windows joined into one), traffic queues included. ${check === 'unknown' ? 'The typed stop list is missing or has a stop with no readable time, so the two cannot be compared.' : `Compared with the record's typed list of unexpected stops (${typed!.length}), matching by time: ${check}.`} A stop is not evidence of its cause.`,
      stopCites);
  }

  // 4. Trip end against the first destination arrival time the app showed the rider.
  // Only an estimate issued in the trip's own chronology counts: from the booking (the pickup leg) or, failing that, the trip start,
  // to before the trip end. An estimate from another day or after the trip is not this trip's.
  const from = [trip.booking_time, trip.match_time, trip.trip_start_time].map(ms).filter((t): t is number => t !== null).reduce<number | null>((a, t) => a === null || t < a ? t : a, null);
  // The earliest issuance is picked first and only then its arrival read: an unreadable or conflicting arrival there is unknown,
  // never replaced by a later revision; nor is a shown estimate whose issue time cannot be read.
  const destination = rowsOf(datasetBlock(packet, 'eta_history')).filter(r => r?.target === 'destination' && r?.displayed_to_rider === true);
  const undated = destination.some(r => ms(r?.issued_at) === null);
  const shown = from === null || end === null || undated ? [] : destination.filter(r => ms(r.issued_at)! >= from && ms(r.issued_at)! < end);
  const firstIssued = shown.length ? Math.min(...shown.map(r => ms(r.issued_at)!)) : null, firsts = shown.filter(r => ms(r.issued_at) === firstIssued);
  const unreadable = firsts.some(r => ms(r?.estimated_arrival_at) === null);
  const first = firsts.length && !unreadable && new Set(firsts.map(r => ms(r.estimated_arrival_at))).size === 1 ? firsts[0] : null;
  const etaCites = [...at('eta_history', first ? String(first.estimated_arrival_at) : undefined), ...at('trip_data', '"trip_end_time"')];
  if (!first || end === null) add('trip_end_vs_first_destination_eta_min', null, end === null ? 'No trip end time with a time zone is recorded, so the trip cannot be compared with an estimate.' : from === null ? 'No booking, match or trip start time with a time zone is recorded, so which estimates belong to this trip is unknown.' : undated ? 'A destination estimate shown to the rider has no readable issue time with a time zone, so which estimate came first is unknown.' : unreadable ? `The first destination estimate shown to the rider (issued ${firsts[0].issued_at}) has no readable arrival time with a time zone, so the first estimate is unknown; a later revision does not replace it.` : !shown.length ? 'No destination arrival time shown to the rider is recorded between the booking and the trip end (eta_history: target destination, displayed to the rider, times with a time zone), so the trip cannot be compared with one: unknown, not on time.' : 'Two first destination estimates shown to the rider at the same moment disagree, so the first estimate is unclear.', etaCites.length ? etaCites : routeCites);
  else {
    const late = end - ms(first.estimated_arrival_at)!, minutes = tenth(late / 60000);
    add('trip_end_vs_first_destination_eta_min', { first_eta_issued_at: first.issued_at, first_eta_arrival_at: first.estimated_arrival_at, trip_end_at: trip.trip_end_time, minutes_after_eta: minutes, late: late > S.lateMin * 60000 },
      `The trip ended ${minutes < 0 ? `${-minutes} minutes before` : `${minutes} minutes after`} the first arrival time the app showed the rider for the destination (${first.estimated_arrival_at}, issued ${first.issued_at}); late means more than 10 minutes after it, compared exactly. The estimate is the app's, made before the trip was driven; traffic, a changed destination or a stop the rider asked for can each make a trip late. Arithmetic on the record, not a finding of wrongdoing.`, etaCites);
  }

  // 5. The best road route saved for this case (route-reference.ts), if any.
  const ref = objectOf(datasetBlock(packet, 'route_reference')), refFrom = point(ref?.from), refTo = point(ref?.to), best = num(ref?.distance_km);
  // Outside lookups (AD-11, 11 October 2026): a road route the Evidence Collector looked up during the run says so; a saved reference
  // keeps its words, so earlier runs read exactly as before.
  const looked = ref?.lookup === 'road_route';
  if (!refFrom || !refTo || best === null || best <= 0) add('best_road_route_km', null, looked ? `The Evidence Collector's road route lookup came back without a route (${typeof ref.reason === 'string' ? ref.reason : ref.status ?? 'no answer'}), so the trip cannot be compared with one.` : 'No best road route is saved for this case (evidence/registers/route-references.json), so the trip cannot be compared with one.', looked ? at('route_reference') : routeCites);
  else {
    // Compare only a route between the same places: a changed destination ends elsewhere.
    const ends = (pts: Pt[] | null) => !!pts && metres(pts[0], refFrom) <= S.referenceEndsM && metres(pts.at(-1)!, refTo) <= S.referenceEndsM;
    const less = (x: number | null, ok: boolean) => ok && x !== null ? Math.round((x - best) * 100) / 100 : null;
    const typedPlanned = num(plannedRoute.distance_km), typedActual = num(actualRoute.distance_km), sameAsActual = ends(actual);
    // Why an actual comparison is missing, stated rather than guessed from a null: the trip's ends (null when the actual route
    // cannot be read: fewer than two points, or one that cannot be read), apart from a typed distance that is simply absent (rounds 6 and 7).
    const actualEnds = actual ? sameAsActual : null;
    add('best_road_route_km', { best_road_km: best, best_road_min: num(ref.duration_min), planned_typed_minus_best_km: less(typedPlanned, ends(planned)), actual_typed_minus_best_km: less(typedActual, sameAsActual), actual_path_minus_best_km: less(actual ? lengthM(actual) / 1000 : null, sameAsActual), actual_ends_match_reference: actualEnds },
      `The shortest-time driving route between the trip's planned start and end on OpenStreetMap roads is ${best} km${num(ref.duration_min) === null ? '' : ` (${num(ref.duration_min)} minutes without traffic)`}: ${looked ? `looked up by the Evidence Collector during this run from the OSRM demo server (${ref.fetched_at})` : `a reference saved once from the OSRM demo server (${ref.fetched_at ?? 'date unstated'}) and never fetched during a run`}, not the app's navigation and not what traffic or closures allowed that day. Beside it: the typed planned and actual distances and the actual path from route_path_length_km, each less the best road distance${actualEnds === null ? '; the recorded actual route cannot be read reliably enough to compare, so it is not compared' : actualEnds ? '' : '; the recorded trip does not start and end within 250 m of the reference\'s ends, so it is not compared'}${actualEnds && typedActual === null ? '; the record types no actual distance, so only the actual path is compared' : ''}. The actual path is straight lines between the recorded points, shorter than any road when the points are few, so a negative figure there says the points are few, not that the car beat the best route. A longer route than the best one is not by itself wrongdoing.`,
      [...at('route_reference'), ...routeCites]);
  }
  return facts;
}
