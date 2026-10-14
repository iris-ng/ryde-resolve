import type { CasePacket } from '../agent-flow/contracts';
import type { Cite, Fact, Facts } from '../agent-flow/facts';
import { datasetBlock, datasetCategory, effectiveFactsVersion } from '../case-packet/dataset';
import { photoCheckFacts } from './photo-checks';
import { arrivalWhileMovingFact, cleaningBeforeTripEndFact, zonedInstant } from './consistency';
import { photoReadingFacts, photoSurfaceFact } from './photo-reading-facts';
import { selectBranch } from './branches';
import { criteriaFor } from '../agent-flow/checklists';
import { cancellationFacts } from './cancellation-facts';
import { campaignCode, campaignTermsStatus } from './campaign-terms';
import { meteredDetourEstimateCents } from '../agent-flow/posture';
import { routeCheckFacts } from './route-checks';
import { fareCheckFacts } from './fare-checks';
import { historyCheckFacts } from './history-checks';
import { earlierClaimsSourceId } from '../case-packet/earlier-claims';

// Deterministic evidence layer for dataset packets. Every observation records
// what a source contains, with a line citation into the pinned JSON source.
// Nothing here decides admissibility, credibility, applicability or remedy.
const R = 6371000;
export function haversineMetres(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const toRad = (d: number) => d * Math.PI / 180, dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}
const seconds = (a?: string, b?: string) => a && b && Number.isFinite(Date.parse(a)) && Number.isFinite(Date.parse(b)) ? (Date.parse(b) - Date.parse(a)) / 1000 : null;
const hours = (a?: string, b?: string) => { const s = seconds(a, b); return s === null ? null : Math.round(s / 36) / 100; };

const collectionTypes = ['capture', 'wallet_debit', 'cash_collected'], returnTypes = ['refund', 'reversal', 'wallet_credit', 'voucher_issued'], driverDebitTypes = ['wallet_debit', 'debit', 'clawback', 'reversal'];
const cancellationBranches = new Set(['rider_cancellation', 'driver_no_show', 'driver_cancellation']);
/** The waiting-fee line of a fare, in cents, from its structured code (WAITING_FEE, WAIT_FEE ...), or null. */
const waitingLine = (fare: any): number | null => { const l = (fare?.line_items ?? []).find((x: any) => /WAIT/i.test(String(x?.code ?? '')) && Number(x.amount) > 0); return l ? Math.round(Number(l.amount) * 100) : null; };
/**
 * Facts 4 (rules rebuild): what is still held of the disputed charge, from the ledger's structured fields only. The disputed item
 * is the collection the ticket names by reference; else, for a cancellation with a recorded fee, the collection of that fee; else
 * the latest collection. A cancellation fee with no collection of its own is never matched to another charge (unknown), and a
 * ledger with no settled collection holds nothing (0: a released hold is not a charge, P17). A settled return belongs to the
 * charge its explicit link names (refund_of, original_reference, linked_reference); without one, to the charge whose reference
 * it equals or extends (REF-...), the longest such reference. A return that belongs to no charge leaves the amount unknown.
 * Notes are prose and are never read.
 */
export function outstandingFor(payments: any[] | null, ticket: any, trip: any, branch: string, at: Cite | null, fare: any = null): Fact[] {
  const cents = (n: unknown) => Math.round(Number(n) * 100), out: Fact[] = [], cites = at ? [at] : [];
  const riderSettled = (p: any) => (p.counterparty ?? 'rider') === 'rider' && p.status === 'settled' && Number.isFinite(Number(p.amount));
  const rows = Array.isArray(payments) ? payments : [];
  const collections = rows.filter(p => riderSettled(p) && collectionTypes.includes(p.type)).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const returns = rows.filter(p => riderSettled(p) && returnTypes.includes(p.type));
  const refs = collections.map(c => c.reference).filter((r): r is string => typeof r === 'string' && !!r);
  const ownerOf = (r: any): string | null => {
    const explicit = [r.refund_of, r.original_reference, r.linked_reference].find(x => typeof x === 'string' && x);
    if (explicit) return refs.includes(explicit) ? explicit : null; // a link to a charge the ledger lacks belongs to none
    const ref = typeof r.reference === 'string' ? r.reference : '';
    return refs.filter(c => ref === c || ref.startsWith(c + '-')).sort((a, b) => b.length - a.length)[0] ?? null;
  };
  const named = [ticket?.charge_reference, ticket?.payment_reference, ticket?.reference].find(r => typeof r === 'string' && r);
  const fee = typeof trip?.cancellation_fee === 'number' ? cents(trip.cancellation_fee) : null, feeBranch = cancellationBranches.has(branch) && fee !== null;
  // A cancellation is matched only to the collection of its recorded fee; with no fee amount recorded, to none.
  const item = named ? collections.find(c => c.reference === named) : cancellationBranches.has(branch) ? (fee === null ? undefined : collections.filter(c => cents(c.amount) === fee).at(-1)) : collections.at(-1);
  const add = (value: number | null, explanation: string) => out.push({ id: 'disputed_charge_outstanding_cents', value, explanation, citations: cites });
  const orphans = returns.filter(r => ownerOf(r) === null);
  if (!rows.length) add(null, 'No payment ledger: no settled charge can be linked to this dispute, so no refund amount can be checked. Mark the payment question unresolved.');
  else if (!collections.length) add(0, 'The ledger has no settled collection from the rider (an authorisation hold is not a charge, P17), so nothing is held to return.');
  else if (!item) add(null, named ? `The ledger has no settled collection with the reference the ticket names (${named}). Mark the payment question unresolved.` : fee === null ? 'No cancellation fee amount is recorded, so no collection can be linked to it. Mark the payment question unresolved.' : `The ledger has no settled collection of the recorded cancellation fee (${fee} cents), and another charge is not the fee. Mark the payment question unresolved.`);
  else if (orphans.length) add(null, `A settled return (${orphans.map(r => r.reference ?? r.type).join(', ')}) is not linked to any charge in the ledger, so what is still held of the disputed charge is unknown. Mark the payment question unresolved; the record may show which charge it returned.`);
  else if (branch === 'waiting_fee' && !waitingLine(fare)) add(null, 'No waiting-fee line is in the fare record, so the waiting fee within the charge cannot be found. Mark the payment question unresolved.');
  else {
    const ref = typeof item.reference === 'string' ? item.reference : '', linked = returns.filter(r => !!ref && ownerOf(r) === ref);
    const returned = linked.reduce((a, r) => a + cents(r.amount), 0);
    // A waiting fee is one line of the fare: only that line is in dispute.
    // An earlier return on the fare may have been for another item (a toll, the platform fee): unless it returned the whole collection,
    // what is left of the waiting fee is unknown and a person decides (red team, round 3).
    if (branch === 'waiting_fee' && returned > 0 && returned < cents(item.amount)) add(null, `A settled return of ${returned} cents is linked to ${ref || 'the fare collection'}, but the record does not say which part of the fare it returned, so what is left of the waiting fee is unknown. Mark the payment question unresolved.`);
    else if (branch === 'waiting_fee') { const line = waitingLine(fare)!; add(Math.max(0, Math.min(line, cents(item.amount)) - returned), `The disputed charge is the waiting-fee line (${line} cents) within ${ref || 'the fare collection'}, less settled returns linked to that collection (${returned} cents). No refund may exceed it.`); }
    else add(Math.max(0, cents(item.amount) - returned), `The disputed charge is ${ref || 'an unreferenced collection'} (${item.type}, ${cents(item.amount)} cents, chosen ${named ? 'by the reference the ticket names' : feeBranch ? 'as the collection of the recorded cancellation fee' : 'as the latest settled collection'}), less ${returned} cents of settled returns linked to it${linked.length ? ` (${linked.map(r => r.reference ?? r.type).join(', ')})` : ''}. No refund, by card or voucher, may exceed it. Arithmetic on the ledger, not entitlement.`);
  }
  if (rows.length) {
    const by = (method: RegExp) => collections.filter(c => method.test(String(c.method ?? '')) || (method.source === 'cash' && c.type === 'cash_collected')).reduce((a, c) => a + cents(c.amount), 0);
    const total = collections.reduce((a, c) => a + cents(c.amount), 0) - returns.reduce((a, r) => a + cents(r.amount), 0);
    out.push({ id: 'rider_refund_ceiling_cents', value: Math.max(0, total), explanation: `Every settled collection from the rider less every settled return to the rider, across the whole ledger (wallet collections ${by(/wallet|rydecoins/i)} cents, cash ${by(/cash/)} cents, the rest by card or other methods). The disputed charge (disputed_charge_outstanding_cents) is the limit that applies to a refund.`, citations: cites });
  }
  return out;
}

export function datasetFacts(packet: CasePacket): Facts {
  const source = (block: string) => packet.sources.find(s => s.id === `evidence/${block}.json`);
  const cite = (block: string, needle?: string): Cite => { const s = source(block)!; const i = needle ? s.lines.findIndex(l => l.includes(needle)) : -1; return { sourceId: s.id, startLine: i < 0 ? 1 : i + 1, endLine: i < 0 ? s.lines.length : i + 1 }; };
  const facts: Fact[] = [];
  const add = (id: string, value: unknown, explanation: string, citations: Cite[]) => facts.push({ id, value, explanation, citations });
  // Packets pinned before 3 October compute exactly their old facts, so recorded decisions still acknowledge every one.
  // Version 2 adds the two consistency facts; version 3 the two photo-reading facts.
  // Version 4 (rules rebuild): the dispute's branch decides the Judge's questions, plus the cancellation, GPS and money facts.
  // Version 8 (14 October 2026): the rider's app location (rider_location) and its distances to the pickup.
  const version = effectiveFactsVersion(packet), consistency = version >= 2, readingFacts = version >= 3, v4 = version >= 4, v5 = version >= 5, v6 = version >= 6, v7 = version >= 7, v8 = version >= 8;
  const ticket = datasetBlock(packet, 'dispute_ticket'), trip = datasetBlock(packet, 'trip_data') ?? {}, gps: any[] = datasetBlock(packet, 'gps_telemetry') ?? [], chat: any[] = datasetBlock(packet, 'chat_logs') ?? [], events: any[] = datasetBlock(packet, 'app_events') ?? [];
  const payments: any[] | null = datasetBlock(packet, 'payment_events'), fare = datasetBlock(packet, 'fare_breakdown'), route = datasetBlock(packet, 'route_data'), docs: any[] = datasetBlock(packet, 'documents') ?? [], photos: any[] = datasetBlock(packet, 'photos') ?? [], safety = datasetBlock(packet, 'safety_report');
  const category = ticket ? datasetCategory({ dispute_ticket: ticket }) : (packet.policySelection?.category ?? 'other');
  if (ticket) add('dispute_category', category, 'Derived from dispute_ticket.dispute_type; issues inside the ticket may belong to other categories.', [cite('dispute_ticket', '"dispute_type"')]);
  else { const first = packet.sources[0]; if (first) add('dispute_category', category, 'Custom case: category detected from the uploaded documents\' own wording to select the pinned rules; it is a routing choice, not a finding, and every fact must come from the documents.', [{ sourceId: first.id, startLine: 1, endLine: 1 }]); }
  const choice = v4 ? selectBranch(packet) : null;
  if (choice) add('dispute_branch', choice.branch, `The situation this dispute is about, picked from structured fields (${choice.basis}). It decides which questions the Arbitrator answers.${choice.undetermined ? ` The record does not say ${choice.undetermined}, so no supported branch applies and a person decides.` : ''}`, ticket ? [cite('dispute_ticket', '"dispute_type"')] : packet.sources[0] ? [{ sourceId: packet.sources[0].id, startLine: 1, endLine: 1 }] : []);

  // Clocks. Every interval names its origin; none is "the" wait time. Facts 4: an interval that should run forward but runs
  // backwards (the recorded times are out of order) is null, never a negative wait.
  const declared = trip.driver_arrival_time, cancel = trip.cancellation_time, match = trip.match_time, scheduled = trip.scheduled_time;
  const span = (a?: string, b?: string) => { const s = seconds(a, b); return v4 && s !== null && s < 0 ? null : s; };
  const order = (a?: string, b?: string) => v4 && (seconds(a, b) ?? 0) < 0 ? ' The recorded times are out of order, so no interval is computed.' : '';
  if (declared && cancel) add('wait_seconds_declared_arrival_to_cancellation', span(declared, cancel), 'Cancellation minus the app-declared arrival. Duration only; it does not show where the driver was.' + order(declared, cancel), [cite('trip_data', '"driver_arrival_time"'), cite('trip_data', '"cancellation_time"')]);
  if (scheduled && cancel) add('wait_seconds_scheduled_to_cancellation', seconds(scheduled, cancel), 'Cancellation minus the scheduled pickup time.', [cite('trip_data', '"scheduled_time"'), cite('trip_data', '"cancellation_time"')]);
  if (match && cancel) add('grace_seconds_match_to_cancellation', span(match, cancel), 'Cancellation minus match time. The public rider grace period runs from matching.' + order(match, cancel), [cite('trip_data', '"match_time"'), cite('trip_data', '"cancellation_time"')]);
  const timers = events.filter(e => e.event_type === 'wait_timer_started');
  if (timers.length === 1 && cancel) add('wait_seconds_timer_start_to_cancellation', span(timers[0].timestamp, cancel), 'Cancellation minus the single recorded timer start.' + order(timers[0].timestamp, cancel), [cite('app_events', timers[0].timestamp), cite('trip_data', '"cancellation_time"')]);
  const waitDeclared = seconds(declared, cancel);
  if (waitDeclared !== null) add('wait_exceeds_three_minutes_from_declared_arrival', v4 && waitDeclared < 0 ? null : waitDeclared > 180, 'Compares the declared-arrival interval with the public wording "more than 3 minutes". It says nothing about physical presence at the pickup point.' + order(declared, cancel), [cite('trip_data', '"driver_arrival_time"'), cite('trip_data', '"cancellation_time"')]);
  // Facts 4, owner decision of 6 October 2026: on an advance booking the no-show wait counts from the booked time, or from the
  // driver's arrival if that is later. An early arrival does not start the clock (Ryde's pages leave it open: conflict C04).
  if (v4 && choice?.branch === 'driver_no_show' && trip.booking_mode === 'advance' && cancel) {
    // A missing or unreadable time never falls back to the arrival clock: cancelling within 3 minutes of the
    // booked time is never a 3-minute wait; otherwise, without the arrival, when the wait started is unknown.
    const at = (x: unknown) => typeof x === 'string' && Number.isFinite(Date.parse(x)) ? x : null;
    const booked = at(scheduled), arrived = at(declared), cancelled = at(cancel);
    const start = booked && arrived ? (Date.parse(arrived) > Date.parse(booked) ? arrived : booked) : null;
    const wait = start && cancelled ? seconds(start, cancelled) : null, fromBooked = booked && cancelled ? seconds(booked, cancelled) : null;
    const value = wait !== null ? wait > 180 : fromBooked !== null && fromBooked <= 180 ? false : null;
    const cites = [cite('trip_data', '"scheduled_time"'), ...(declared ? [cite('trip_data', '"driver_arrival_time"')] : []), cite('trip_data', '"cancellation_time"')];
    add('no_show_wait_start', start, start ? 'When the no-show wait starts on this advance booking: the booked time, or the driver\'s arrival if later (owner decision, 6 October 2026). A driver who arrives early does not start the clock.' : 'The booked time or the driver\'s arrival is missing or unreadable, so when the wait started is unknown.', cites);
    add('wait_exceeds_three_minutes_from_wait_start', value,
      wait !== null ? `The driver cancelled ${wait} seconds after the wait started (no_show_wait_start). The fee needs more than 3 minutes (180 seconds); cancelling before the booked time, or at exactly 180 seconds, is not more than 3 minutes.`
        : value === false ? 'The driver cancelled within 3 minutes of the booked time (or before it), so the wait cannot have passed 3 minutes, whenever the driver arrived.'
          : 'The booked time, the arrival or the cancellation time is missing or unreadable, so whether the driver waited more than 3 minutes is unknown: leave the question open.', cites);
  }
  if (trip.trip_status === 'cancelled' && !trip.trip_start_time) add('trip_not_started', true, 'Trip status is cancelled and no trip start is recorded; completed-trip fees cannot apply.', [cite('trip_data', '"trip_status"')]);
  // Facts 4: a waiting-fee dispute gets the wait before boarding (P05: more than 3 minutes before the rider boards).
  if (choice?.branch === 'waiting_fee' && declared && trip.trip_start_time) add('wait_seconds_arrival_to_boarding', span(declared, trip.trip_start_time), 'Trip start minus the app-declared arrival: how long the driver waited before the rider got in (P05: more than 3 minutes). Duration only; it does not show where the driver was.' + order(declared, trip.trip_start_time), [cite('trip_data', '"driver_arrival_time"'), cite('trip_data', '"trip_start_time"')]);
  // Facts 4: a rider's own cancellation gets the grace, pickup-time and lateness facts (cancellation-facts.ts).
  if (choice?.branch === 'rider_cancellation') facts.push(...cancellationFacts(packet, trip, cite));

  // Position. Distances are straight-line metres from the pickup pin; no published radius exists.
  const pin = trip.pickup_location;
  if (pin && gps.length) {
    const rows = gps.map(g => ({ ...g, metres: haversineMetres(pin, g) }));
    const atDeclared = declared ? rows.find(r => r.timestamp === declared) ?? rows.filter(r => Date.parse(r.timestamp) <= Date.parse(declared)).at(-1) : undefined;
    if (atDeclared) add('distance_to_pickup_at_declared_arrival_m', atDeclared.metres, `Straight-line distance from the pickup pin at the GPS sample nearest the declared arrival (accuracy ${atDeclared.accuracy_m ?? 'unstated'} m). No official radius exists; compare with accuracy and the rider's stated position.`, [cite('gps_telemetry', atDeclared.timestamp), cite('trip_data', '"pickup_location"')]);
    const stationary = rows.filter(r => ['arrived', 'waiting', 'cancelled'].includes(r.status));
    if (stationary.length) add('min_distance_to_pickup_while_arrived_or_waiting_m', Math.min(...stationary.map(r => r.metres)), 'Smallest distance from the pickup pin over samples marked arrived, waiting or cancelled.', [cite('gps_telemetry', stationary[0].timestamp)]);
    add('gps_sample_count', rows.length, 'Number of GPS samples supplied. Sparse samples cannot establish speed, braking or continuous presence.', [cite('gps_telemetry')]);
    const stamps = rows.map(r => Date.parse(r.timestamp)).sort((a, b) => a - b), gaps = stamps.slice(1).map((t, i) => (t - stamps[i]) / 1000);
    if (gaps.length) add('gps_max_gap_seconds', Math.max(...gaps), 'Largest interval between consecutive samples.', [cite('gps_telemetry')]);
    add('gps_max_speed_kmh_sample', Math.max(...rows.map(r => Number(r.speed_kmh) || 0)), 'Highest single speed sample. A sample is not a validated speeding record.', [cite('gps_telemetry')]);
  }
  // Consistency fact (consistency.ts): emitted whenever an arrival is declared, unavailable when the GPS cannot support it.
  if (consistency && declared) facts.push(arrivalWhileMovingFact(trip, gps, cite, haversineMetres));

  // Facts 8 (owner, 14 October 2026): the rider's app location, where the record carries it (rider_location). A real platform reads the
  // rider's phone while the app has permission and is running, so a case may say "not shared"; a record with no block carries no rider
  // location at all, which is a different state. Distances are to the booked pin, as the driver's are; where the parties agreed another
  // point, the Judge compares the readings' positions with that point. The facts never decide absence: the Judge weighs them.
  const riderLocation: any = v8 ? datasetBlock(packet, 'rider_location') : null;
  if (riderLocation && typeof riderLocation === 'object' && !Array.isArray(riderLocation)) {
    const sharing = riderLocation.sharing === 'shared' || riderLocation.sharing === 'not_shared' ? riderLocation.sharing : 'unreadable';
    add('rider_location_sharing', sharing, sharing === 'not_shared' ? `The rider's app shared no location${typeof riderLocation.reason === 'string' && riderLocation.reason ? ': ' + riderLocation.reason : '.'} Not sharing a location is not itself absence; statements and messages decide.`
      : sharing === 'shared' ? 'The rider\'s app shared its location during this booking (rider_location.readings). Each reading carries an accuracy figure to weigh; a phone reports when the app has permission and is running, so readings are sparse and a gap is a gap.'
      : 'The rider location block is not in a form this check reads.', [cite('rider_location', '"sharing"')]);
    // Readings count only under "shared": a block that says not_shared supplies no position, whatever else it holds.
    const readings: any[] = sharing === 'shared' && Array.isArray(riderLocation.readings) ? riderLocation.readings.filter((r: any) => Number.isFinite(r?.lat) && Number.isFinite(r?.lng) && typeof r?.timestamp === 'string' && Number.isFinite(Date.parse(r.timestamp))) : [];
    if (pin && readings.length) {
      const rows = readings.map(r => ({ ...r, metres: haversineMetres(pin, r), t: Date.parse(r.timestamp) })).sort((a, b) => a.t - b.t);
      add('rider_location_sample_count', rows.length, 'Number of rider app readings supplied with a readable time and position.', [cite('rider_location', '"readings"')]);
      if (cancel) {
        const atCancel = rows.filter(r => r.t <= Date.parse(cancel)).at(-1), ties = atCancel ? rows.filter(r => r.t === atCancel.t) : [];
        // Two readings at one time that disagree on position leave the distance unknown: input order must not decide it.
        if (atCancel && ties.some(r => Math.abs(r.metres - atCancel.metres) > 1)) add('rider_distance_to_pickup_at_cancellation_m', null, `The rider's app holds ${ties.length} readings at the same time (${atCancel.timestamp}) that disagree on position, so the distance at the cancellation is not computed.`, [cite('rider_location', atCancel.timestamp)]);
        else if (atCancel) add('rider_distance_to_pickup_at_cancellation_m', Math.round(atCancel.metres), `Straight-line distance from the pickup pin at the rider's last reading at or before the cancellation (${Math.round((Date.parse(cancel) - atCancel.t) / 1000)} s before it; accuracy ${Number.isFinite(atCancel.accuracy_m) ? atCancel.accuracy_m + ' m' : 'unstated'}; app ${typeof atCancel.app_state === 'string' ? 'in the ' + atCancel.app_state : 'state unstated'}). A reading is where the phone was at that moment: weigh its age against the cancellation and its accuracy with the statements and messages. Measured to the booked pin: where the parties agreed another pickup point, compare the reading's position with that point. No official radius exists.`, [cite('rider_location', atCancel.timestamp)]);
        else add('rider_distance_to_pickup_at_cancellation_m', null, 'The rider\'s app shared readings, but none at or before the cancellation.', [cite('rider_location', '"readings"')]);
      }
      const from = declared ? Date.parse(declared) : -Infinity, to = cancel ? Date.parse(cancel) : Infinity, during = rows.filter(r => r.t >= from && r.t <= to);
      if (during.length) { const nearest = [...during].sort((a, b) => a.metres - b.metres)[0]; add('rider_min_distance_to_pickup_during_wait_m', Math.round(nearest.metres), `Smallest straight-line distance from the pickup pin over the rider's ${during.length} reading${during.length === 1 ? '' : 's'} between the driver's declared arrival${declared ? '' : ' (none declared: from the first reading)'} and the cancellation (that reading's accuracy ${Number.isFinite(nearest.accuracy_m) ? nearest.accuracy_m + ' m' : 'unstated'}).`, [cite('rider_location', nearest.timestamp)]); }
    }
  }

  // Contact in the wait window.
  if (declared && cancel) {
    const inWindow = chat.filter(c => Date.parse(c.timestamp) >= Date.parse(declared) && Date.parse(c.timestamp) <= Date.parse(cancel));
    const count = (sender: string, type: string) => inWindow.filter(c => c.sender === sender && c.type === type).length;
    const calls = inWindow.filter(c => c.type === 'call');
    // Facts 4: a call is unanswered only by its recorded outcome (call_outcome), never by its wording; facts 3 read the wording.
    if (v4) add('contact_counts_declared_arrival_to_cancellation', { driver_messages: count('driver', 'message'), driver_calls: count('driver', 'call'), rider_messages: count('rider', 'message'), rider_calls: count('rider', 'call'), unanswered_calls: calls.filter(c => c.call_outcome === 'not_answered').length, calls_without_recorded_outcome: calls.filter(c => typeof c.call_outcome !== 'string').length }, 'Recorded in-app contacts between declared arrival and cancellation. A call is counted unanswered only when its record says so (call_outcome); a call with no recorded outcome is counted apart, whatever its text says. A call record shows an attempt; absence of a record is not proof of no contact.', [cite('chat_logs')]);
    else add('contact_counts_declared_arrival_to_cancellation', { driver_messages: count('driver', 'message'), driver_calls: count('driver', 'call'), rider_messages: count('rider', 'message'), rider_calls: count('rider', 'call'), unanswered_calls: calls.filter(c => /not answered|no answer|no response/i.test(c.content)).length }, 'Recorded in-app contacts between declared arrival and cancellation. A call record shows an attempt, not an answered call; absence of a record is not proof of no contact.', [cite('chat_logs')]);
  }

  // Money. Holds are not charges; wallet debits count as collected from the rider.
  let cashCeiling: number | null = null, pendingRefund = false;
  if (Array.isArray(payments) && payments.length) {
    const cents = (n: number) => Math.round(Number(n) * 100);
    const settled = (types: string[]) => payments.filter(p => types.includes(p.type) && p.status === 'settled' && (p.counterparty ?? 'rider') === 'rider').reduce((a, p) => a + cents(p.amount), 0);
    // Facts 4: a voucher already issued is a return too (the record check counts it so); older packets keep their sum.
    const collected = settled(['capture', 'wallet_debit', 'cash_collected']), refunded = settled(v4 ? returnTypes : ['refund', 'reversal', 'wallet_credit']);
    // Facts 4: any pending return to the rider (a wallet credit too) blocks a refund; older packets counted refunds and reversals.
    pendingRefund = payments.some(p => (v4 ? returnTypes.includes(p.type) && (p.counterparty ?? 'rider') === 'rider' : ['refund', 'reversal'].includes(p.type)) && p.status === 'pending');
    cashCeiling = pendingRefund ? null : Math.max(0, collected - refunded);
    add('collected_from_rider_cents', collected, 'Settled captures, wallet debits and cash marked collected. Authorisation holds are excluded.', [cite('payment_events')]);
    add('refunded_to_rider_cents', refunded, 'Settled refunds, reversals and wallet credits to the rider.', [cite('payment_events')]);
    add('payment_reconciled', !pendingRefund, 'True when no refund is pending. This is arithmetic on supplied records, not entitlement.', [cite('payment_events')]);
    add('cash_refund_ceiling_cents', cashCeiling, 'Collected minus refunded; the most any cash recommendation could return. Not an entitlement.', [cite('payment_events')]);
    // Facts 4: a driver debit (a reversed compensation) counts against what the driver was credited; older packets summed every row.
    const driverCredit = payments.filter(p => p.counterparty === 'driver' && p.status === 'settled').reduce((a, p) => a + (v4 && driverDebitTypes.includes(p.type) ? -1 : 1) * cents(p.amount), 0);
    if (driverCredit) add('credited_to_driver_cents', driverCredit, 'Amount credited to the driver. The rider charge and the driver payout are different quantities.', [cite('payment_events')]);
  } else if (source('trip_data')) {
    const fee = trip.cancellation_fee ?? trip.final_fare;
    if (fee !== undefined) add('recorded_charge_cents', Math.round(Number(fee) * 100), 'Fee or fare recorded in trip data. No payment ledger is supplied, so settlement is unverified and no refund ceiling can be computed.', [cite('trip_data', trip.cancellation_fee !== undefined ? '"cancellation_fee"' : '"final_fare"')]);
    add('payment_reconciled', false, 'No payment_events block; settlement cannot be reconciled from this dataset.', [cite('trip_data')]);
  }
  if (v4) facts.push(...outstandingFor(payments, ticket, trip, choice!.branch, source('payment_events') ? cite('payment_events') : source('trip_data') ? cite('trip_data') : null, fare));
  if (fare?.line_items?.length) {
    const sum = Math.round(fare.line_items.reduce((a: number, li: any) => a + Number(li.amount) * 100, 0));
    add('fare_line_items_sum_cents', sum, 'Sum of receipt line items.', [cite('fare_breakdown', '"line_items"')]);
    add('fare_line_items_match_charged', sum === Math.round(Number(fare.charged_total) * 100), 'Line items add up to the charged total.', [cite('fare_breakdown', '"charged_total"')]);
    if (fare.quoted_total !== undefined) add('charged_minus_quoted_cents', Math.round((Number(fare.charged_total) - Number(fare.quoted_total)) * 100), 'Difference between charged and quoted totals. Explains what was added, not whether it was owed.', [cite('fare_breakdown', '"quoted_total"'), cite('fare_breakdown', '"charged_total"')]);
    if (fare.surge_multiplier !== undefined) add('surge_multiplier', fare.surge_multiplier, 'Surge factor recorded at booking.', [cite('fare_breakdown', '"surge_multiplier"')]);
    if (fare.promo?.code) add('promo_recorded', { code: fare.promo.code, discount_cents: Math.round(Number(fare.promo.discount ?? 0) * 100), applied: fare.promo.applied === true }, 'Promo code recorded on the fare and whether the fare applied it. Eligibility turns on the campaign terms in evidence, not on this record.', [cite('fare_breakdown', '"promo"')]);
  }
  // The charge against the quote is arithmetic on the two recorded totals, so it needs no fare lines: ORG-003 (imported 13 October 2026)
  // records both totals and no lines. Every team case with a quote has lines, so its facts are as before.
  else if (fare && fare.quoted_total !== undefined) add('charged_minus_quoted_cents', Math.round((Number(fare.charged_total) - Number(fare.quoted_total)) * 100), 'Difference between charged and quoted totals. Explains what was added, not whether it was owed.', [cite('fare_breakdown', '"quoted_total"'), cite('fare_breakdown', '"charged_total"')]);
  // Facts 4, fare disputes: the most a refund can return, and for a promo dispute whether the campaign's terms are in the record.
  const fareBranches = ['route_detour', 'erp_toll', 'destination_change', 'surge_pricing', 'promo_code', 'extra_charge', 'fare_overcharge'];
  // A quote and a charge must be recorded numbers: an empty quote is no quote, never a quote of zero.
  if (v4 && choice && fareBranches.includes(choice.branch) && fare && typeof fare.charged_total === 'number' && Number.isFinite(fare.charged_total) && typeof fare.quoted_total === 'number' && Number.isFinite(fare.quoted_total)) {
    const c = (n: unknown) => Math.round(Number(n) * 100), charged = c(fare.charged_total), quoted = c(fare.quoted_total);
    const rider = (p: any) => p.status === 'settled' && (p.counterparty ?? 'rider') === 'rider';
    const collected = (payments ?? []).filter(p => rider(p) && ['capture', 'wallet_debit', 'cash_collected'].includes(p.type)).reduce((a, p) => a + c(p.amount), 0);
    const returned = (payments ?? []).filter(p => rider(p) && returnTypes.includes(p.type)).reduce((a, p) => a + c(p.amount), 0);
    // A promo: an accepted quote may itself be wrong, so the ceiling is the recorded unapplied discount when that is larger; with no
    // discount recorded and no charge above the quote, no fare ceiling can be computed (only what is still held limits a refund).
    // A promo: the lawful fare is the quote, less an unapplied discount when the quote did not already net it (the quote equals the
    // fare lines less the discount when it did). An unapplied promo with no recorded discount, and nothing above the quote, has no ceiling.
    const promo = fare.promo, discountKnown = !!promo && promo.applied !== true && typeof promo.discount === 'number' && Number.isFinite(promo.discount), discount = discountKnown ? c(promo.discount) : 0;
    const gross = Array.isArray(fare.line_items) && fare.line_items.length ? fare.line_items.filter((l: any) => Number(l.amount) > 0).reduce((a: number, l: any) => a + c(l.amount), 0) : null;
    const quoteNetsDiscount = discountKnown && gross !== null && gross - discount === quoted;
    const overQuote = Math.max(0, charged - quoted);
    const base = choice.branch !== 'promo_code' ? overQuote : discountKnown ? Math.max(0, charged - (quoteNetsDiscount ? quoted : quoted - discount)) : promo?.applied !== true && overQuote === 0 ? null : overQuote;
    add('fare_excess_cents', base === null ? null : Math.max(0, base + (payments?.length ? Math.max(0, collected - charged) : 0) - returned), base === null ? 'No discount is recorded and nothing was charged above the quote, so no fare ceiling can be computed; only what is still held of the charge limits a refund.' : 'The most a fare refund can return: the charge above the quoted total (for a promo, the recorded unapplied discount if larger), plus anything collected above the charged fare (a duplicate collection), less settled returns to the rider. Arithmetic on the record, not entitlement.', [cite('fare_breakdown', '"charged_total"'), ...(payments?.length ? [cite('payment_events')] : [])]);
  }
  // Owner decision, 7 October 2026 (team reading A12): a metered fare has no quote, so on a detour the app's estimate recorded on the fare
  // stands in for it. The most a fare refund can return is the meter fare above the top of the estimate, plus anything collected above
  // the fare, less what was already returned. Only where A12 can apply (posture.ts meteredDetourEstimateCents: the departure is recorded too).
  const metered = v4 && choice?.branch === 'route_detour' && fare && (fare.quoted_total === undefined || fare.quoted_total === null) && typeof fare.charged_total === 'number' && Number.isFinite(fare.charged_total) && fare.charged_total >= 0
    ? meteredDetourEstimateCents(trip, fare, route) : null;
  if (metered !== null) {
    const c = (n: unknown) => Math.round(Number(n) * 100), charged = c(fare.charged_total), top = metered;
    const rider = (p: any) => p.status === 'settled' && (p.counterparty ?? 'rider') === 'rider';
    const collected = (payments ?? []).filter(p => rider(p) && collectionTypes.includes(p.type)).reduce((a, p) => a + c(p.amount), 0);
    const returned = (payments ?? []).filter(p => rider(p) && returnTypes.includes(p.type)).reduce((a, p) => a + c(p.amount), 0);
    add('fare_excess_cents', Math.max(0, Math.max(0, charged - top) + (payments?.length ? Math.max(0, collected - charged) : 0) - returned), 'The most a fare refund can return on a metered trip: the meter fare above the top of the app\'s estimate, plus anything collected above the fare, less refunds already made.', [cite('fare_breakdown', '"estimated_total"'), cite('fare_breakdown', '"charged_total"')]);
  }
  if (v4 && choice?.branch === 'promo_code') {
    const code = campaignCode(fare, events), status = campaignTermsStatus(docs, code);
    add('campaign_terms_in_evidence', status, !code ? 'No promo code is recorded on the fare or a promo app event, so no campaign terms can be identified.' : status === null ? `No campaign-terms document for ${code} is in the record (kind campaign_terms, or DOC-TERMS-${code}); the question stays open.` : status ? `A campaign-terms document for ${code} is in the record.` : `The campaign-terms document for ${code} is marked unavailable.`, [source('documents') ? cite('documents') : cite('dispute_ticket', '"dispute_type"')]);
  }
  if (trip.fare_basis) add('fare_basis', trip.fare_basis, 'Whether the quote was fixed, metered or an estimate. A fixed quote does not change with route length.', [cite('trip_data', '"fare_basis"')]);
  if (trip.service_type) add('service_type', trip.service_type, 'Booked service. Several rules exclude RydeTAXI or particular services.', [cite('trip_data', '"service_type"')]);

  // Route.
  if (route?.planned_route && route?.actual_route) {
    add('route_extra_distance_km', Math.round((route.actual_route.distance_km - route.planned_route.distance_km) * 10) / 10, 'Actual minus planned route distance from the supplied geometry. A longer route is not by itself wrongdoing.', [cite('route_data', '"actual_route"'), cite('route_data', '"planned_route"')]);
    add('route_extra_duration_min', route.actual_route.duration_min - route.planned_route.duration_min, 'Actual minus planned duration.', [cite('route_data', '"duration_min"')]);
    add('erp_gantries_planned_vs_actual', { planned: (route.planned_route.erp_gantries ?? []).map((g: any) => g.name), actual: (route.actual_route.erp_gantries ?? []).map((g: any) => ({ name: g.name, charge: g.charge })) }, 'Gantries on each route as recorded. Who bears a toll on a driver-chosen detour is a policy question (see conflict C07).', [cite('route_data', '"erp_gantries"')]);
    if (route.deviation_summary) add('route_consent_recorded', route.deviation_summary.rider_consent_recorded, 'Consent status as recorded by the dataset author; the chat and statements are the evidence.', [cite('route_data', '"rider_consent_recorded"')]);
    if (route.deviation_summary?.unexpected_stops?.length) add('unexpected_stops', route.deviation_summary.unexpected_stops.map((s: any) => ({ at: s.at, duration_min: s.duration_min })), 'Stationary periods off the planned route as recorded. A stop is not evidence of its cause.', [cite('route_data', '"unexpected_stops"')]);
  }

  // Cleaning claims.
  if (category === 'cleaning' && ticket) {
    const claim = events.find(e => e.event_type === 'cleaning_claim_submitted'), receipt = docs.find(d => d.kind === 'receipt');
    const end = trip.trip_end_time;
    const outOfOrder = ' The recorded times are out of order, so no interval is computed.';
    if (claim && end) {
      const s = seconds(end, claim.timestamp), bad = v4 && s !== null && s < 0;
      add('hours_trip_end_to_claim', bad ? null : hours(end, claim.timestamp), 'Hours between trip end and claim submission. The public page requires the claim within 48 hours.' + (bad ? outOfOrder : ''), [cite('app_events', claim.timestamp), cite('trip_data', '"trip_end_time"')]);
      // Facts 4: the window is compared in exact seconds (48 hours 10 seconds is late), never in rounded hours.
      if (v4) add('claim_within_48h', s === null || s < 0 ? null : s <= 48 * 3600, 'Whether the claim was submitted within 48 hours (172,800 seconds) of the trip end, compared exactly.' + (bad ? outOfOrder : ''), [cite('app_events', claim.timestamp), cite('trip_data', '"trip_end_time"')]);
    }
    const fields = receipt?.extracted_fields ?? {}, zoned = packet.timezone ? zonedInstant(fields.cleaning_date, fields.cleaning_time, packet.timezone) : null;
    // Older packets pinned no time zone; they keep the Singapore offset this fact always assumed.
    const cleaned = zoned !== null ? new Date(zoned).toISOString() : fields.cleaning_date && fields.cleaning_time && !packet.timezone ? `${fields.cleaning_date}T${fields.cleaning_time}:00+08:00` : undefined;
    // Facts 4: P20 counts the 24 hours "from the incident". A structured incident time (trip_data.incident_time, or an app event's
    // data.incident_at) starts the clock; otherwise the trip end does, which is after the incident, so the true time is at least that long.
    const incident = v4 ? [trip.incident_time, ...events.map(e => e?.data?.incident_at)].find(x => typeof x === 'string' && Number.isFinite(Date.parse(x))) : undefined;
    if (cleaned && incident) {
      const s = seconds(incident, cleaned), bad = s !== null && s < 0;
      add('hours_incident_to_cleaning', bad ? null : hours(incident, cleaned), 'Hours from the recorded incident to the receipt\'s cleaning time. The public page requires professional cleaning within 24 hours of the incident.' + (bad ? outOfOrder : ''), [cite('documents', '"cleaning_date"'), trip.incident_time ? cite('trip_data', '"incident_time"') : cite('app_events', '"incident_at"')]);
      add('cleaning_within_24h', s === null || s < 0 ? null : s <= 24 * 3600, 'Whether the receipt\'s cleaning time is within 24 hours (86,400 seconds) of the recorded incident, compared exactly (P20).' + (bad ? outOfOrder : ''), [cite('documents', '"cleaning_date"'), trip.incident_time ? cite('trip_data', '"incident_time"') : cite('app_events', '"incident_at"')]);
    }
    if (cleaned && end) {
      const s = seconds(end, cleaned), bad = v4 && s !== null && s < 0;
      add('hours_trip_end_to_cleaning', bad ? null : hours(end, cleaned), 'Hours between trip end and the receipt\'s cleaning time. The public page requires professional cleaning within 24 hours.' + (bad ? outOfOrder : ''), [cite('documents', '"cleaning_date"'), cite('trip_data', '"trip_end_time"')]);
      if (v4 && !incident) add('cleaning_within_24h', s === null || s < 0 ? null : s <= 24 * 3600, 'Whether the receipt\'s cleaning time is within 24 hours (86,400 seconds) of the trip end, compared exactly. The public page counts from the incident; the trip end is after the incident, so the true time is at least this long.' + (bad ? outOfOrder : ''), [cite('documents', '"cleaning_date"'), cite('trip_data', '"trip_end_time"')]);
    }
    // Consistency fact (consistency.ts): a cleaning recorded before the trip ended.
    if (receipt && consistency) facts.push(cleaningBeforeTripEndFact(fields, end, packet.timezone, cite));
    // Facts 4: money already moved for this claim, linked by its structured claim ID (a payment row's claim_id, or a reference that
    // extends the claim ID): what the driver was paid, whether a payment is pending, and what was recovered from the rider.
    if (v4 && choice?.branch === 'cleaning_claim' && Array.isArray(payments) && payments.length) {
      const claimId = typeof claim?.data?.claim_id === 'string' ? claim.data.claim_id : null, c = (n: unknown) => Math.round(Number(n) * 100);
      const forClaim = (p: any) => !!claimId && (p.claim_id === claimId || (typeof p.reference === 'string' && (p.reference === claimId || p.reference.startsWith(claimId + '-'))));
      const toDriver = payments.filter(p => p.counterparty === 'driver' && forClaim(p));
      const paid = toDriver.filter(p => p.status === 'settled').reduce((a, p) => a + (driverDebitTypes.includes(p.type) ? -1 : 1) * c(p.amount), 0);
      const recovered = payments.filter(p => (p.counterparty ?? 'rider') === 'rider' && p.status === 'settled' && collectionTypes.includes(p.type) && forClaim(p)).reduce((a, p) => a + c(p.amount), 0);
      const why = claimId ? `linked to claim ${claimId} by its claim_id or reference` : 'no claim ID is recorded, so nothing can be linked to the claim';
      add('driver_paid_for_claim_cents', Math.max(0, paid), `Settled payments to the driver for this claim, net of reversals (${why}). A new payment adds to these.`, [cite('payment_events')]);
      add('driver_payment_pending_for_claim', toDriver.some(p => p.status === 'pending'), `Whether a payment to the driver for this claim is still pending (${why}).`, [cite('payment_events')]);
      add('rider_recovery_pending_for_claim', payments.some(p => (p.counterparty ?? 'rider') === 'rider' && p.status === 'pending' && collectionTypes.includes(p.type) && forClaim(p)), `Whether a collection from the rider for this claim is still pending (${why}).`, [cite('payment_events')]);
      add('rider_recovered_for_claim_cents', recovered, `Settled collections from the rider for this claim (${why}).`, [cite('payment_events')]);
    }
    // What the pinned photo reading shows (photo-reading-facts.ts), never the claim's words. Emitted for every cleaning
    // claim whatever the reading, so the fact IDs depend on the pinned packet alone; the values read derived/photos.json.
    if (readingFacts) facts.push(...photoReadingFacts(packet, photos, cite));
    // Facts 5 (7 October 2026): how the seat upholstery looks in the photos, for the spill rule.
    if (v5) facts.push(photoSurfaceFact(packet, photos, cite));
    if (receipt) { const f = receipt.extracted_fields ?? {}; add('receipt_fields_present', { company: !!f.company, contact: !!f.contact, address: !!f.address, cleaning_date: !!f.cleaning_date, car_plate: !!f.car_plate, signature: f.signature === 'present', company_stamp: f.company_stamp === 'present', amount: f.amount ?? null }, 'Which receipt details the public cleaning page asks for are present in the transcript. Presence is not authenticity.', [cite('documents', '"extracted_fields"')]); }
    // Facts 4: with no photo record at all, whether a photo shows the plate is unknown (older packets assumed the block).
    if (v4 && !source('photos')) add('plate_visible_in_any_photo', null, 'No photo record is supplied, so whether any photo shows the plate is unknown.', [cite('dispute_ticket', '"dispute_type"')]);
    else add('plate_visible_in_any_photo', photos.some(p => p.shows_vehicle_plate === true), packet.photos?.length ? 'Whether the uploader recorded any photo as showing the plate (the upload record only). What the pixels show is in the photo reading, derived/photos.json.' : 'Whether any registered photo is recorded as showing the plate. Photo bytes are not analysed.', [cite('photos')]);
    // Facts 4: a rider's appeal asks money back; the label says so (older packets kept the driver's label).
    if (ticket?.requested_remedy?.amount !== undefined) add('claimed_cleaning_cents', Math.round(Number(ticket.requested_remedy.amount) * 100), v4 && ticket.filed_by === 'rider' ? 'Amount the rider asks back.' : 'Amount claimed by the driver.', [cite('dispute_ticket', '"requested_remedy"')]);
    add('public_cleaning_caps_cents', { food_drink_crumbs_sand: 4000, bodily_fluids_or_stains: 12000, vomit: 20000 }, 'Caps from the archived public cleaning pages (rule P19). Which tier applies is a judgement about the mess type; the cap is a maximum, not an award.', [cite('dispute_ticket', '"dispute_type"')]);
  }

  // Photos: code checks on the register (photo-checks.ts).
  facts.push(...photoCheckFacts(packet, photos, trip, cite));

  // Facts 6 (MVP fixes, 10 October 2026): route checks from the GPS points and promo and fare checks from structured fields.
  if (v6) facts.push(...routeCheckFacts(packet, cite), ...fareCheckFacts(packet, cite));
  // Facts 7 (MVP fixes, second release): past-behaviour patterns, shown and never deciding.
  if (v7) facts.push(...historyCheckFacts(packet, cite));

  // Safety.
  if (safety) add('safety_report', { category: safety.category, immediate_danger: safety.immediate_danger, injury_reported: safety.injury_reported ?? null, police_report_filed: safety.police_report_filed ?? null, reported_by: safety.reported_by }, 'A safety report exists. It justifies routing to a human safety reviewer; it is not a finding about either party.', [cite('safety_report')]);
  const safetyIssues = (ticket?.issues ?? []).filter((i: any) => i.safety_relevant);
  if (safetyIssues.length) add('safety_relevant_issues', safetyIssues.map((i: any) => ({ issue_id: i.issue_id, alleged_by: i.alleged_by, against: i.against })), 'Issues marked safety-relevant, in both directions.', [cite('dispute_ticket', '"safety_relevant"')]);

  const requiredCriteria = {
    no_show: ['policy_applicability', 'evidence_readiness', 'arrival_at_pickup', 'wait_threshold', 'trip_not_completed', payments?.length ? 'charge_reconciliation' : 'recorded_charge'],
    route_deviation: ['policy_applicability', 'evidence_readiness', 'route_entitlement', payments?.length ? 'charge_reconciliation' : 'recorded_charge'],
    cleaning: ['policy_applicability', 'evidence_readiness', 'mess_type_tier', 'claim_procedure', 'amount_within_cap'],
    safety: ['policy_applicability', 'evidence_readiness', 'safety_routing', 'fare_remedy_basis'],
  }[category] ?? ['policy_applicability', 'evidence_readiness', 'recorded_charge'];
  // Facts 7: the earlier-claims extract is reading for the Arbitrator like the profiles; a packet below 7 never asks for it, so it lists exactly its old sources.
  const base = { category, facts, allowedPolicyIds: packet.policies.map(p => p.rule_id), requiredSourceIds: packet.sources.filter(s => s.id.startsWith('evidence/') && (v7 || s.id !== earlierClaimsSourceId)).map(s => s.id), cashCeiling, pendingRefund };
  if (choice) return { ...base, requiredCriteria: criteriaFor(choice.branch, !!payments?.length), branch: choice.branch };
  return { ...base, requiredCriteria };
}
