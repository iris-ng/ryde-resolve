import type { CasePacket } from '../agent-flow/contracts';
import type { Cite, Fact } from '../agent-flow/facts';
import { haversineMetres } from './observations';

// Code checks on the photo register (spec Part 4). Arithmetic on what the register and the loader record; nothing here
// reads pixels, judges a photo or compares it with other claims. Reported metadata is the uploader's claim: a missing
// or zoneless value reads "not available", which is never a flag.
const NA = 'not available';
// A time with its zone: calendar parts are checked (no 30 February, no 25:00), never rolled over. Offsets are real ones:
// -12:00 to +14:00 in quarter hours.
const zonedParts = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(Z|[+-]\d\d:\d\d)$/;
function instant(y: string, mo: string, d: string, h: string, mi: string, sec: string, zone: string): number | null {
  const [Y, M, D, H, N, S] = [y, mo, d, h, mi, sec].map(Number), z = zone === 'Z' ? [0, 0] : zone.slice(1).split(':').map(Number);
  const offset = (zone.startsWith('-') ? -1 : 1) * (z[0] * 60 + z[1]);
  if (offset < -720 || offset > 840 || ![0, 15, 30, 45].includes(z[1]) || H > 23 || N > 59 || S > 59) return null;
  const local = Date.UTC(Y, M - 1, D, H, N, S), date = new Date(local);
  if (!Number.isFinite(local) || date.getUTCFullYear() !== Y || date.getUTCMonth() !== M - 1 || date.getUTCDate() !== D) return null;
  const at = local - offset * 60000;
  return Number.isFinite(at) ? at : null;
}
const zonedInstant = (value: unknown) => { const m = typeof value === 'string' ? value.trim().match(zonedParts) : null; return m ? instant(m[1], m[2], m[3], m[4], m[5], m[6], m[7]) : null; };
/** The reported capture time as an instant: an ISO time with its zone, or an EXIF local time with an explicit offset. */
function reportedInstant(exif: any): number | null {
  const at = typeof exif?.captured_at === 'string' ? exif.captured_at.trim() : '';
  if (zonedParts.test(at)) return zonedInstant(at);
  const local = at.match(/^(\d{4})[:-](\d\d)[:-](\d\d)[ T](\d\d):(\d\d):(\d\d)$/), offset = typeof exif?.offset === 'string' && /^[+-]\d\d:\d\d$/.test(exif.offset) ? exif.offset : null;
  return local && offset ? instant(local[1], local[2], local[3], local[4], local[5], local[6], offset) : null;
}
const coordinate = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null;
export function photoCheckFacts(packet: Pick<CasePacket, 'photos'>, register: any[], trip: any, cite: (block: string, needle?: string) => Cite): Fact[] {
  // A fact only when the packet pins photos: a text-only photo register (every packet recorded before photo files existed)
  // computes exactly the facts it always did, so its recorded decisions and Judge retries still validate.
  if (!packet.photos?.length || !Array.isArray(register) || !register.length) return [];
  const verified = new Set((packet.photos ?? []).map(p => p.photoId + ':' + p.sha256)), end = zonedInstant(trip?.trip_end_time);
  const drop = trip?.dropoff_location && coordinate(trip.dropoff_location.lat) !== null && coordinate(trip.dropoff_location.lng) !== null ? trip.dropoff_location : null;
  const value = register.map(p => {
    const at = reportedInstant(p?.reported_exif), lat = coordinate(p?.reported_exif?.gps_lat), lng = coordinate(p?.reported_exif?.gps_lng);
    return {
      photo_id: String(p?.photo_id ?? ''),
      bytes: verified.has(p?.photo_id + ':' + p?.sha256) ? 'verified against the recorded sha256' : NA,
      minutes_trip_end_to_reported_capture: at !== null && end !== null ? Math.round((at - end) / 6000) / 10 : NA,
      metres_reported_capture_to_dropoff: lat !== null && lng !== null && drop ? haversineMetres({ lat, lng }, drop) : NA,
    };
  });
  return [{ id: 'photo_checks', value, explanation: 'Per registered photo: whether its bytes were checked against the recorded sha256 when the case loaded; minutes from trip end to the reported (EXIF) capture time, negative when before trip end; straight-line metres from the reported capture place to the drop-off. Reported metadata is the uploader\'s claim, not verification. A missing value, or a reported time without a time zone, reads "not available"; that is not a flag.', citations: [cite('photos'), cite('trip_data', '"trip_end_time"'), cite('trip_data', '"dropoff_location"')] }];
}
