import { hasEvidenceChecks, hasEvidenceChecks2, type CasePacket } from '../agent-flow/contracts';
import { deriveFacts, type Cite } from '../agent-flow/facts';
import { ownSideIndex, type OwnSide } from '../agent-flow/own-side';
import { datasetBlock } from '../case-packet/dataset';
import { fareLinePart } from '../evidence-collection/fare-checks';
import { riderDisplaySamplesBetween, tripDisplaySamples, waitSamples } from '../evidence-collection/route-checks';
import { haversineMetres } from '../evidence-collection/observations';

// What the lab shows of the MVP checks (fix F10, 10 October 2026): the route, promo and fare checks the server worked out
// for the run's own locked case file (facts 6), the fare's lines sorted into the quote's parts, and on a run that pins the
// evidence checks each advocate's own-side list, exactly as the advocates were given it (prompt.ts). Computed on the server
// from the pinned packet when the page loads a run (the facts read node-only modules); a run from before facts 6 or before
// the pin gets nothing, so its page looks as it did. The page writes its own plain words from these values.
// Second release (10 October 2026): on a run pinned at evidence checks 2 with facts 7, also each party's past-behaviour
// patterns (history-checks.ts), for the Past behaviour card. Context only: no check, route or amount reads them.

/** The route checks (route-checks.ts) and the promo and fare checks (fare-checks.ts), in the order the page shows them. */
export const routeCheckIds = ['route_path_length_km', 'route_offset_from_planned_path_m', 'route_stops_in_gps_trace', 'trip_end_vs_first_destination_eta_min', 'best_road_route_km'] as const;
export const fareCheckIds = ['promo_booked_within_campaign_dates', 'promo_booked_within_campaign_hours', 'promo_booked_on_campaign_day', 'promo_service_eligible', 'promo_trip_fare_meets_minimum', 'promo_daily_limit_reached', 'promo_campaign_limit_reached', 'promo_codes_stacked', 'fare_parts_match_quote', 'fare_surge_matches_booked_quote', 'surge_accepted_before_booking'] as const;
const shown = new Set<string>([...routeCheckIds, ...fareCheckIds]);
/** The past-behaviour patterns (history-checks.ts), rider's first. */
export const historyFactIds = ['rider_history_patterns', 'driver_history_patterns'] as const;
/**
 * The payment checks (observations.ts) the Fare tab shows beside the fare checks (evidence tabs, 10 October 2026): what was
 * collected from and returned to the rider, whether a return is still pending, whether the fare's lines add up to the charged
 * total, and the charged total against the quote. The agents had them from the first facts version; the page did not show them.
 */
/**
 * The two consistency facts (consistency.ts) for the case summary's bad-faith signals (signals.ts, owner, 11 October 2026):
 * the app's arrival declared while the car was still far away and moving, and a cleaning receipt timed before the trip ended.
 * The agents always had them through the calculations; the page only shows them.
 */
export const signalFactIds = ['arrival_declared_far_while_moving', 'cleaning_time_before_trip_end'] as const;
export const paymentFactIds = ['collected_from_rider_cents', 'refunded_to_rider_cents', 'payment_reconciled', 'fare_line_items_match_charged', 'charged_minus_quoted_cents'] as const;

export type CheckFact = { id: string; value: unknown; citations: Cite[] };
/** One fare line: its code and the record's own label, in cents, which part of the quote it is, and its line in the fare source. */
export type FareLine = { code: string; label: string; cents: number; part: ReturnType<typeof fareLinePart>; line: number | null };
export type FareView = { quotedCents: number | null; chargedCents: number | null; lines: FareLine[] };
/**
 * The GPS trace the route drawing may show: the samples the route checks used (route-checks.ts tripSamples), plus readings that
 * record no accuracy figure (owner, 13 October 2026), as [lat, lng] in time order. `unrated` lists the indexes of those readings,
 * drawn marked "accuracy not recorded"; no check used them. `window` false: the trip's start or end time is missing or unreadable,
 * so no point is eligible.
 */
export type TraceView = { window: boolean; points: [number, number][]; unrated?: number[] };
/** The payment checks, and the fare's charged total from its record when it has one. */
export type PaymentView = { facts: CheckFact[]; chargedCents: number | null };
/**
 * `history`: the past-behaviour patterns, only on a run pinned at evidence checks 2 (facts 7); null on every earlier run.
 * `payment`: the payment checks, sent only with a view that has something else, so a run from before facts 6 still gets nothing.
 */
/** AD-9: a trip that never started, as the map draws it: the pickup pin and the usable GPS from the match to the cancellation. */
/** AD-9. arrival: the drawn reading at the declared arrival, or the last drawn one before it (at says which), straight-line metres to the pin;
 * `rated` false when that reading records no accuracy figure. `unrated`: the indexes of the drawn readings with no accuracy figure. */
/** `rider` (14 October 2026): the rider's app readings in the same window, drawn in the rider's colour; `sharing` says whether the app shared any; null when the record carries no rider location. */
export type WaitView = { from: string; fromEvent: 'match' | 'booking' | 'first_reading'; to: string; pin: [number, number] | null; points: [number, number][]; unrated?: number[]; arrival: { declared: string; at: string; metres: number; rated?: boolean } | null; rider?: { sharing: 'shared' | 'not_shared' | 'unreadable'; points: [number, number][]; unrated?: number[] } | null };
export type EvidenceChecksView = { facts: CheckFact[]; fare: FareView | null; trace: TraceView | null; ownSide: { rider: OwnSide; driver: OwnSide } | null; history?: CheckFact[] | null; payment?: PaymentView | null; wait?: WaitView | null; signals?: CheckFact[] };

const cents = (n: unknown) => typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) : null;

function fareView(packet: CasePacket): FareView | null {
  const fare = datasetBlock(packet, 'fare_breakdown'), source = packet.sources.find(s => s.id === 'evidence/fare_breakdown.json');
  if (!fare || !Array.isArray(fare.line_items)) return null;
  const lineOf = (code: string) => { const i = source?.lines.findIndex(l => l.includes(`"code": ${JSON.stringify(code)}`)) ?? -1; return i < 0 ? null : i + 1; };
  const lines = (fare.line_items as any[]).flatMap(l => typeof l?.code === 'string' && cents(l.amount) !== null
    ? [{ code: l.code, label: typeof l.label === 'string' && l.label.trim() ? l.label : l.code.replaceAll('_', ' ').toLowerCase(), cents: cents(l.amount)!, part: fareLinePart(l), line: lineOf(l.code) }] : []);
  return { quotedCents: cents(fare.quoted_total), chargedCents: cents(fare.charged_total), lines };
}

/** The checks view for one run's packet, or null when the run has none of them (every run before facts 6 and the pin). */
export function evidenceChecksView(packet: CasePacket): EvidenceChecksView | null {
  let facts: CheckFact[] = [], history: CheckFact[] | null = null, payments: CheckFact[] = [], signals: CheckFact[] = [];
  // A packet the facts cannot read (an old custom case) shows no checks rather than failing the page.
  try {
    const all = deriveFacts(packet).facts, pick = ({ id, value, citations }: CheckFact) => ({ id, value, citations });
    facts = all.filter(f => shown.has(f.id)).map(pick);
    if (hasEvidenceChecks2(packet)) { const found = historyFactIds.flatMap(id => all.filter(f => f.id === id).map(pick)); history = found.length ? found : null; }
    payments = paymentFactIds.flatMap(id => all.filter(f => f.id === id).slice(0, 1).map(pick));
    signals = signalFactIds.flatMap(id => all.filter(f => f.id === id).slice(0, 1).map(pick));
  } catch { facts = []; history = null; payments = []; signals = []; }
  const fare = facts.some(f => f.id === 'fare_parts_match_quote') ? fareView(packet) : null;
  const route = facts.some(f => f.id === 'route_path_length_km') ? tripDisplaySamples(packet) : null;
  const unratedOf = (samples: { rated: boolean }[]) => samples.flatMap((s, i) => s.rated ? [] : [i]);
  const trace = route && { window: route.window, points: route.samples.map(s => [s.lat, s.lng] as [number, number]), ...(unratedOf(route.samples).length ? { unrated: unratedOf(route.samples) } : {}) };
  // AD-9 (owner decision, 10 October 2026): a trip that never started shows where the car was from the match to the cancellation.
  // The arrival sentence rests on a drawn reading, with its own time: the distance fact may use an earlier or
  // less accurate reading, and is not changed.
  const waited = !route ? waitSamples(packet) : null, trip = datasetBlock(packet, 'trip_data'), pinAt = trip?.pickup_location;
  const pin = Number.isFinite(pinAt?.lat) && Number.isFinite(pinAt?.lng) ? { lat: pinAt.lat as number, lng: pinAt.lng as number } : null;
  const declared = typeof trip?.driver_arrival_time === 'string' && Number.isFinite(Date.parse(trip.driver_arrival_time)) ? trip.driver_arrival_time : null;
  const byArrival = waited && declared ? waited.samples.filter(s => s.t <= Date.parse(declared)).at(-1) : undefined;
  // The rider's app readings in the same window (14 October 2026), when the record carries a rider location block.
  const riderBlock = datasetBlock(packet, 'rider_location'), riderSamples = waited && riderBlock ? riderDisplaySamplesBetween(packet, Date.parse(waited.from), Date.parse(waited.to)) : [];
  const rider = waited && riderBlock && typeof riderBlock === 'object' && !Array.isArray(riderBlock)
    ? { sharing: (riderBlock.sharing === 'shared' || riderBlock.sharing === 'not_shared' ? riderBlock.sharing : 'unreadable') as 'shared' | 'not_shared' | 'unreadable', points: riderSamples.map(s => [s.lat, s.lng] as [number, number]), ...(unratedOf(riderSamples).length ? { unrated: unratedOf(riderSamples) } : {}) }
    : null;
  const wait = waited && waited.samples.length >= 2 ? { from: waited.from, fromEvent: waited.fromEvent, to: waited.to, pin: pin ? [pin.lat, pin.lng] as [number, number] : null,
    points: waited.samples.map(s => [s.lat, s.lng] as [number, number]), ...(unratedOf(waited.samples).length ? { unrated: unratedOf(waited.samples) } : {}),
    arrival: pin && declared && byArrival ? { declared, at: byArrival.at, metres: haversineMetres(pin, byArrival), ...(byArrival.rated ? {} : { rated: false }) } : null, rider } : null;
  const ownSide = hasEvidenceChecks(packet) ? { rider: ownSideIndex(packet, 'rider'), driver: ownSideIndex(packet, 'driver') } : null;
  const charged = datasetBlock(packet, 'fare_breakdown')?.charged_total;
  const payment = payments.length ? { facts: payments, chargedCents: cents(charged) } : null;
  return facts.length || ownSide || history ? { facts, fare, trace, ownSide, history, payment, wait, signals } : null;
}
