import type { CasePacket } from '../agent-flow/contracts';
import { datasetBlock } from '../case-packet/dataset';
import { strictInstant } from '../evidence-collection/consistency';

// Outside lookups (AD-12, owner, 11 October 2026): the Evidence Collector names a place or a time window, and the server reads its
// position or times from the record. Free coordinates are never accepted, so every lookup is about this trip and can be repeated.
export const placeNames = ['pickup', 'driver_at_arrival', 'driver_at_cancellation', 'dropoff', 'trip_start', 'trip_end'] as const;
export type PlaceName = typeof placeNames[number];
export const windowNames = ['before_booking', 'pickup_wait', 'trip'] as const;
export type WindowName = typeof windowNames[number];
export type RecordPlace = { name: PlaceName; lat: number; lng: number; from: string };
export type RecordWindow = { name: WindowName; from: string; to: string; capped: boolean };

type Packet = Pick<CasePacket, 'sources'>;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const point = (p: any) => { const q = Array.isArray(p) ? { lat: p[0], lng: p[1] } : p; return finite(q?.lat) && finite(q?.lng) && Math.abs(q.lat) <= 90 && Math.abs(q.lng) <= 180 ? { lat: q.lat as number, lng: q.lng as number } : null; };
const rows = (v: unknown): any[] => Array.isArray(v) ? v : [];
const objectOf = (v: unknown): any => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
/** A Singapore time with its offset, from epoch milliseconds. */
export const sgIso = (ms: number) => new Date(ms + 8 * 3600000).toISOString().slice(0, 19) + '+08:00';
/** When the driver declared arrival: the trip's own field, else the app's driver_marked_arrived event. */
function arrival(packet: Packet): unknown {
  const trip = objectOf(datasetBlock(packet, 'trip_data'));
  return trip.driver_arrival_time ?? rows(datasetBlock(packet, 'app_events')).find(e => e?.event_type === 'driver_marked_arrived')?.timestamp ?? null;
}
/** The GPS sample nearest in time to an instant, if one is within two minutes of it. */
function gpsNear(packet: Packet, when: unknown) {
  const t = strictInstant(when); if (t === null) return null;
  let best: { lat: number; lng: number; gap: number } | null = null;
  for (const r of rows(datasetBlock(packet, 'gps_telemetry'))) {
    const p = point(r), s = strictInstant(r?.timestamp); if (!p || s === null) continue;
    const gap = Math.abs(s - t); if (gap <= 120000 && (!best || gap < best.gap)) best = { ...p, gap };
  }
  return best && { lat: best.lat, lng: best.lng };
}
export function recordPlace(packet: Packet, name: PlaceName): RecordPlace | null {
  const trip = objectOf(datasetBlock(packet, 'trip_data')), planned = rows(objectOf(objectOf(datasetBlock(packet, 'route_data')).planned_route).points);
  const make = (p: { lat: number; lng: number } | null, from: string): RecordPlace | null => p && { name, lat: p.lat, lng: p.lng, from };
  if (name === 'pickup') return make(point(trip.pickup_location), 'trip_data.pickup_location');
  if (name === 'dropoff') return make(point(trip.dropoff_location), 'trip_data.dropoff_location');
  if (name === 'driver_at_arrival') return make(gpsNear(packet, arrival(packet)), 'the GPS sample nearest the driver\'s arrival declaration');
  if (name === 'driver_at_cancellation') return make(gpsNear(packet, trip.cancellation_time), 'the GPS sample nearest the cancellation');
  const start = name === 'trip_start', end = point(start ? planned[0] : planned.at(-1));
  return planned.length >= 2 && end ? make(end, `route_data.planned_route ${start ? 'first' : 'last'} point`) : make(point(start ? trip.pickup_location : trip.dropoff_location), `trip_data.${start ? 'pickup' : 'dropoff'}_location`);
}
export function recordWindow(packet: Packet, name: WindowName): RecordWindow | null {
  const trip = objectOf(datasetBlock(packet, 'trip_data')), at = (v: unknown) => strictInstant(v);
  let a: number | null = null, b: number | null = null;
  if (name === 'before_booking') { b = at(trip.booking_time); a = b === null ? null : b - 30 * 60000; }
  if (name === 'pickup_wait') { a = at(arrival(packet)) ?? at(trip.match_time) ?? at(trip.booking_time); b = at(trip.cancellation_time) ?? at(trip.trip_start_time); }
  if (name === 'trip') { a = at(trip.trip_start_time); b = at(trip.trip_end_time); }
  if (a === null || b === null || b < a) return null;
  const capped = b - a > 3600000;
  return { name, from: sgIso(a), to: sgIso(capped ? a + 3600000 : b), capped };
}
/** The 5-minute reading times covering a window, in Singapore local time without an offset (as data.gov.sg takes them); at most 13. */
export function readingTimes(w: RecordWindow): string[] {
  const a = strictInstant(w.from), b = strictInstant(w.to), step = 300000, out: string[] = [];
  if (a === null || b === null) return out;
  for (let t = Math.floor(a / step) * step; t <= b && out.length < 13; t += step) out.push(sgIso(t).slice(0, 19));
  return out;
}
