import type { CasePacket } from '../agent-flow/contracts';
import type { Cite, Fact } from '../agent-flow/facts';
import { datasetBlock } from '../case-packet/dataset';

// Facts version 4 (rules rebuild, October 2026) for a rider's own cancellation. Structured fields only: trip_data times,
// eta_history rows and the ticket's filing time. Nothing here reads chat, statements or event descriptions.
//
// Ryde P02: "All cancellations made within 3 minutes of matching are not chargeable"; P03: chargeable "after 3 minutes".
// So 180 seconds exactly is free, and only more than 180 seconds is after the grace.
export const GRACE_S = 180;
// Owner decision, 6 October 2026 (team reading A9): the driver is late when the rider cancels more than 2 minutes after the
// pickup time the app showed at matching and the driver had not arrived by then, even if the driver arrives later.
export const MARGIN_S = 120;
// The ETA shown at matching: revision 0, for the pickup, displayed to the rider, issued within this many seconds of matching.
export const ETA_ISSUE_WINDOW_S = 60;
const DAY_S = 86400;
/**
 * Team measurement standard for a driver not heading to the pickup (not a Ryde rule; approved by the owner on 6 October 2026).
 * A usable GPS sample has a finite position, accuracy of 20 m or better, a time at or before the cancellation and no duplicate
 * time. Enough GPS: at least 4 usable samples in the window, no gap over 60 s, the first and last within 15 s of the window's
 * ends. Parked away: over the last 180 s every sample is more than 150 m from the pin after subtracting its accuracy, at
 * 3 km/h or less, all within 50 m of each other. Moving away: over the last 120 s the distance grows by at least 200 m after
 * subtracting the end samples' accuracy, with at least 3 step-by-step increases larger than the two samples' accuracy combined.
 * Another road to the same place: when the app's pickup ETA was reissued in that window and the time remaining kept falling or
 * held steady, the driver counts as heading there. Not enough GPS gives no finding either way.
 */
export const gpsStandard = { accuracyM: 20, minSamples: 4, maxGapS: 60, edgeS: 15, parkedWindowS: 180, parkedAwayM: 150, parkedSpeedKmh: 3, parkedClusterM: 50, movingWindowS: 120, movingAwayM: 200, movingSteps: 3 } as const;
const metres = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const rad = (d: number) => d * Math.PI / 180, dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
};
type Sample = { t: number; lat: number; lng: number; d: number; acc: number; speed: number | null; at: string };
/** The GPS findings before a rider's cancellation, by the standard above. Each is null when the GPS cannot support it. */
export function movementFindings(packet: Pick<CasePacket, 'sources'>, trip: any) {
  const cancel = ms(trip.cancellation_time), pin = trip.pickup_location, S = gpsStandard;
  const none = { parked: null as boolean | null, moving: null as boolean | null, etaFalling: null as boolean | null, support: false, samples: [] as Sample[] };
  if (cancel === null || !pin || !Number.isFinite(pin.lat) || !Number.isFinite(pin.lng)) return none;
  const rows: any[] = datasetBlock(packet, 'gps_telemetry') ?? [];
  // A time shared by two rows (whatever their accuracy) makes both unusable; a position must be a recorded number.
  const allTimes = rows.map(r => ms(r?.timestamp)).filter((t): t is number => t !== null);
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null;
  const parsed = rows.map(r => ({ t: ms(r?.timestamp), lat: num(r?.lat), lng: num(r?.lng), acc: num(r?.accuracy_m), speed: num(r?.speed_kmh), at: r?.timestamp }))
    .filter(r => r.t !== null && r.t <= cancel && r.lat !== null && r.lng !== null && r.acc !== null && r.acc >= 0 && r.acc <= S.accuracyM && allTimes.filter(t => t === r.t).length === 1);
  const usable: Sample[] = parsed.map(r => ({ t: r.t!, lat: r.lat!, lng: r.lng!, acc: r.acc!, speed: r.speed, at: r.at, d: metres(pin, { lat: r.lat!, lng: r.lng! }) })).sort((a, b) => a.t - b.t);
  const inWindow = (seconds: number) => {
    const start = cancel - seconds * 1000, w = usable.filter(s => s.t >= start);
    const gaps = w.slice(1).map((s, i) => (s.t - w[i].t) / 1000);
    const enough = w.length >= S.minSamples && (w[0].t - start) / 1000 <= S.edgeS && (cancel - w.at(-1)!.t) / 1000 <= S.edgeS && gaps.every(g => g <= S.maxGapS);
    return enough ? w : null;
  };
  const p = inWindow(S.parkedWindowS), m = inWindow(S.movingWindowS);
  const parked = !p ? null : p.some(s => s.speed === null) ? null
    : p.every(s => s.d - s.acc > S.parkedAwayM && s.speed! <= S.parkedSpeedKmh) && p.every(a => p.every(b => metres(a, b) <= S.parkedClusterM));
  // The app's own pickup ETA in the moving window: rows reissued in it, time remaining falling or steady from one to the next.
  // Only estimates shown to the rider count. The series is every reissue in the window; a single reissue is compared with the last
  // estimate shown before the window, however long before.
  const shownRows = ((datasetBlock(packet, 'eta_history') ?? []) as any[]).filter(r => r?.target === 'pickup' && r?.displayed_to_rider === true && ms(r?.issued_at) !== null && ms(r?.estimated_arrival_at) !== null)
    .map(r => ({ issued: ms(r.issued_at)!, remaining: ms(r.estimated_arrival_at)! - ms(r.issued_at)! })).filter(r => r.issued <= cancel).sort((a, b) => a.issued - b.issued);
  const windowStart = cancel - S.movingWindowS * 1000, inside = shownRows.filter(r => r.issued >= windowStart), before = shownRows.filter(r => r.issued < windowStart).at(-1);
  const etaRows = inside.length === 1 && before ? [before, ...inside] : inside;
  const etaFalling = etaRows.length < 2 ? null : etaRows.slice(1).every((r, i) => r.remaining <= etaRows[i].remaining);
  const grows = !m ? null : (m.at(-1)!.d - m.at(-1)!.acc) - (m[0].d + m[0].acc) >= S.movingAwayM && m.slice(1).filter((s, i) => s.d - m[i].d > s.acc + m[i].acc).length >= S.movingSteps;
  const moving = grows === null ? null : grows && etaFalling !== true;
  return { parked, moving, etaFalling, support: (parked !== null && moving !== null) || parked === true || moving === true, samples: usable };
}

const ms = (iso: unknown) => typeof iso === 'string' && Number.isFinite(Date.parse(iso)) ? Date.parse(iso) : null;

/** The pickup ETA the rider saw at matching, or null with the reason. */
export function etaAtMatch(packet: Pick<CasePacket, 'sources'>, matchTime: unknown): { eta: string | null; why: string; row?: any } {
  const rows: any[] | null = datasetBlock(packet, 'eta_history'), match = ms(matchTime);
  if (!Array.isArray(rows) || !rows.length) return { eta: null, why: 'No ETA history is recorded.' };
  if (match === null) return { eta: null, why: 'No match time is recorded, so the ETA shown at matching cannot be identified.' };
  const original = rows.filter(r => r?.revision === 0 && r?.target === 'pickup' && r?.displayed_to_rider === true && ms(r?.issued_at) !== null && Math.abs(ms(r.issued_at)! - match) <= ETA_ISSUE_WINDOW_S * 1000 && ms(r?.estimated_arrival_at) !== null);
  if (!original.length) return { eta: null, why: 'No ETA row is the original pickup estimate shown to the rider at matching (revision 0, target pickup, displayed to the rider, issued within 60 seconds of matching).' };
  if (new Set(original.map(r => ms(r.estimated_arrival_at))).size > 1) return { eta: null, why: 'Two original pickup estimates disagree, so the time shown at matching is unclear.' };
  return { eta: original[0].estimated_arrival_at, why: '', row: original[0] };
}

// P07 (advance bookings): "All cancellations made > 15 minutes before the scheduled trip time are not chargeable. (eg: Scheduled
// trip: 6 PM, any cancellation made before 5:45 PM is not chargeable. If the advanced trip request is accepted only after 5:45 PM,
// riders will have a 3 minute grace period)". Exactly 15 minutes is conflict C04 ("do not invent inclusive boundaries"): unknown.
export const ADVANCE_WINDOW_S = 15 * 60;
function advanceFacts(trip: any, grace: number | null, cite: (block: string, needle?: string) => Cite): Fact[] {
  const out: Fact[] = [], add = (id: string, value: unknown, explanation: string, citations: Cite[]) => out.push({ id, value, explanation, citations });
  const scheduled = ms(trip.scheduled_time), cancel = ms(trip.cancellation_time), match = ms(trip.match_time);
  const ahead = scheduled !== null && cancel !== null ? (scheduled - cancel) / 1000 : null;
  const late = scheduled !== null && match !== null ? match > scheduled - ADVANCE_WINDOW_S * 1000 : null;
  const cites = [cite('trip_data', '"scheduled_time"'), cite('trip_data', '"cancellation_time"')];
  add('minutes_before_scheduled_at_cancel', ahead === null ? null : ahead / 60, ahead === null ? 'The scheduled time or the cancellation time is missing.' : 'Minutes from the cancellation to the scheduled trip time, exact (negative: after it). P07: more than 15 minutes ahead is not chargeable.', cites);
  add('accepted_late_for_advance', late, late === null ? 'The scheduled time or the match time is missing.' : late ? 'The booking was accepted less than 15 minutes before the scheduled time, so P07 gives the rider 3 minutes of grace from matching.' : 'The booking was accepted more than 15 minutes ahead, so the 15-minute window applies.', [cite('trip_data', '"scheduled_time"'), cite('trip_data', '"match_time"')]);
  const outOfOrder = grace !== null && grace < 0;
  const value = ahead === null || outOfOrder ? null : ahead > ADVANCE_WINDOW_S ? false : ahead === ADVANCE_WINDOW_S ? null : late === true && grace !== null && grace <= GRACE_S ? false : late === null ? null : true;
  add('cancelled_after_grace', value,
    ahead === null ? 'The scheduled time or the cancellation time is missing, so the advance window cannot be checked.'
      : outOfOrder ? 'The recorded times are out of order (the cancellation is before the match), so the advance window cannot be checked.'
      : ahead === ADVANCE_WINDOW_S ? 'The rider cancelled exactly 15 minutes before the scheduled time. Whether that is inside the free window is the open page conflict C04, so it is unknown: a person decides.'
        : ahead > ADVANCE_WINDOW_S ? 'The rider cancelled more than 15 minutes before the scheduled time, which P07 makes free.'
          : value === false ? 'The booking was accepted late and the rider cancelled within 3 minutes of matching, inside P07\'s late-acceptance grace.'
            : value === null ? 'The match time is missing, so whether a late acceptance gave a grace period cannot be checked.'
              : 'The rider cancelled less than 15 minutes before the scheduled time and outside any late-acceptance grace, so the fee is chargeable under P07.', cites);
  return out;
}

export function cancellationFacts(packet: Pick<CasePacket, 'sources'>, trip: any, cite: (block: string, needle?: string) => Cite): Fact[] {
  const facts: Fact[] = [], add = (id: string, value: unknown, explanation: string, citations: Cite[]) => facts.push({ id, value, explanation, citations });
  const has = (block: string) => packet.sources.some(s => s.id === `evidence/${block}.json`);
  const match = ms(trip.match_time), cancel = ms(trip.cancellation_time), arrival = ms(trip.driver_arrival_time);
  const tripCite = (field: string) => cite('trip_data', `"${field}"`);

  // The free 3 minutes from matching; for an advance booking, P07's window.
  const grace = match !== null && cancel !== null ? (cancel - match) / 1000 : null;
  if (trip.booking_mode === 'advance') facts.push(...advanceFacts(trip, grace, cite));
  else add('cancelled_after_grace', grace === null || grace < 0 ? null : grace > GRACE_S,
    grace === null ? 'The match time or the cancellation time is missing, so the free 3 minutes cannot be checked.'
      : grace < 0 ? 'The recorded times are out of order (the cancellation is before the match), so the free 3 minutes cannot be checked.'
        : `The rider cancelled ${grace} seconds after matching. Ryde's grace is "within 3 minutes" of matching (P02), so 180 seconds or less is free and more is chargeable (P03).`,
    [tripCite('match_time'), tripCite('cancellation_time')]);

  // Whether the driver had arrived when the rider cancelled.
  add('driver_arrived_before_cancel', cancel === null ? null : arrival !== null && arrival <= cancel,
    cancel === null ? 'No cancellation time is recorded.' : arrival === null ? 'No driver arrival is recorded before the cancellation.' : arrival <= cancel ? 'The driver\'s arrival is recorded before the cancellation. It is the app declaration, not proof of the driver\'s position.' : 'The driver\'s arrival is recorded after the cancellation.',
    trip.driver_arrival_time ? [tripCite('driver_arrival_time'), tripCite('cancellation_time')] : [tripCite('cancellation_time')]);

  // The pickup ETA shown at matching, and the 2-minute margin (team reading A9).
  const shown = etaAtMatch(packet, trip.match_time), etaCite = has('eta_history') ? [cite('eta_history', shown.row ? String(shown.row.estimated_arrival_at) : undefined)] : [];
  add('pickup_eta_at_match', shown.eta,
    shown.eta ? 'The pickup time the app showed the rider at matching (the original estimate, not a later revision).'
      : `${shown.why} The Arbitrator may still establish the pickup time shown at matching from a cited message (for example "Pickup ETA 4 min" at matching), and otherwise leaves the lateness question unresolved.`,
    [...etaCite, tripCite('match_time')]);
  const eta = ms(shown.eta), deadline = eta === null ? null : eta + MARGIN_S * 1000;
  add('driver_missed_eta_by_2_min', deadline === null || cancel === null ? null : cancel > deadline && (arrival === null || arrival > deadline),
    deadline === null ? 'No pickup time shown at matching is recorded, so lateness is unknown, not false.'
      : cancel === null ? 'No cancellation time is recorded.'
        : `The deadline is 2 minutes after the pickup time shown at matching. The driver counts as late when the rider cancelled after the deadline and the driver had not arrived by it, even if the driver arrived later (owner decision, 6 October 2026). Cancelling exactly at the deadline is not late.`,
    [...etaCite, tripCite('cancellation_time'), ...(trip.driver_arrival_time ? [tripCite('driver_arrival_time')] : [])]);

  // Not heading to the pickup (team reading A10): GPS findings by the team's standard (gpsStandard).
  const found = movementFindings(packet, trip), gpsCite = has('gps_telemetry') ? [cite('gps_telemetry')] : [];
  const unsupported = 'The GPS before the cancellation is too sparse or too inaccurate for this finding (fewer than 4 samples of 20 m accuracy or better in the window, a gap over 60 s, or no sample within 15 s of either end), so it is unknown, not false.';
  add('driver_parked_away_before_cancel', found.parked, found.parked === null ? unsupported : `Over the last 3 minutes before the cancellation, every GPS sample ${found.parked ? 'was' : 'was not all'} more than 150 m from the pickup pin after subtracting its accuracy, at 3 km/h or less, within 50 m of one another. A team measurement standard, not a Ryde rule; it shows where the car was, not why.`, [...gpsCite, tripCite('pickup_location')]);
  add('driver_moving_away_before_cancel', found.moving, found.moving === null ? unsupported : found.etaFalling === true ? 'The app\'s own pickup ETA kept falling or held steady in the last 2 minutes, so the driver counts as heading to the pickup by another road, whatever the straight-line distance did.' : `Over the last 2 minutes before the cancellation the distance to the pickup pin ${found.moving ? 'grew' : 'did not grow'} by at least 200 m after subtracting the end samples' accuracy with at least 3 clear step-by-step increases. A team measurement standard, not a Ryde rule; it shows movement, not its cause.`, [...gpsCite, tripCite('pickup_location')]);
  add('app_eta_falling_before_cancel', found.etaFalling, found.etaFalling === null ? 'The app did not reissue the pickup ETA at least twice in the last 2 minutes, so its trend is unknown.' : found.etaFalling ? 'The app\'s pickup ETA was reissued in the last 2 minutes and the time remaining kept falling or held steady.' : 'The app\'s pickup ETA was reissued in the last 2 minutes and the time remaining rose.', has('eta_history') ? [cite('eta_history')] : []);
  add('gps_supports_movement_finding', found.support, found.support ? 'The GPS before the cancellation supports a finding on whether the driver was heading to the pickup.' : 'The GPS before the cancellation does not support a finding either way; the waiver question stays unresolved unless the record shows the movement another way.', gpsCite.length ? gpsCite : [tripCite('cancellation_time')]);

  // Days from the trip to the dispute: P08 waivers are not considered for requests after 30 days of the trip.
  const ticket = datasetBlock(packet, 'dispute_ticket'), filed = ms(ticket?.filed_at), tripAt = match ?? ms(trip.booking_time) ?? cancel;
  if (filed !== null && tripAt !== null) add('days_trip_to_dispute', filed >= tripAt ? (filed - tripAt) / 1000 / DAY_S : null,
    filed >= tripAt ? 'Days from the trip (matching) to the dispute, exact. P08: "Requests submitted after 30 days of the trip will not be considered for waivers."' : 'The dispute is recorded before the trip, so the days cannot be counted.',
    [cite('dispute_ticket', '"filed_at"'), tripCite(trip.match_time ? 'match_time' : trip.booking_time ? 'booking_time' : 'cancellation_time')]);
  return facts;
}
