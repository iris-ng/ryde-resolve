import type { Cite, Fact } from '../agent-flow/facts';

// The two consistency facts (spec Part 3, revision 18). Each compares records with each other, reaches every agent
// through read_calculations and never routes. Each says "unavailable", with the reason, whenever the records cannot
// support the comparison: a false "true" here could bias agents against a party, so no value is ever guessed.

/** Nearest GPS sample at or before the declared arrival may be this old and still describe it. */
export const staleSampleSeconds = 60;
const isoParts = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d)(\.\d+)?)?(Z|([+-])(\d\d):(\d\d))$/;

/** An ISO timestamp with an explicit offset and a real calendar date, as ms; null otherwise (never the server's zone). */
export function strictInstant(value: unknown): number | null {
  const m = typeof value === 'string' ? isoParts.exec(value) : null;
  if (!m) return null;
  const [, y, mo, d, h, mi, s = '00', frac = '', zone, sign, oh, om] = m;
  if (+mo < 1 || +mo > 12 || +h > 23 || +mi > 59 || +s > 59 || (zone !== 'Z' && (+oh > 23 || +om > 59))) return null;
  const local = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, frac ? Math.round(Number(frac) * 1000) : 0);
  if (new Date(local).getUTCDate() !== +d) return null; // 30 February does not roll into March
  return zone === 'Z' ? local : local - (sign === '-' ? -1 : 1) * (+oh * 60 + +om) * 60000;
}

const offsetAt = (instant: number, zone: string) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(instant)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(instant / 1000) * 1000;
};
/**
 * A local date and time (no offset) in an IANA zone, as ms. Null when the date, time or zone cannot be read, when the
 * time does not exist in that zone (a spring-forward gap), or when it happens twice (a fall-back hour): in those
 * cases the instant is unknown, so the facts built on it say unavailable.
 */
export function zonedInstant(date: unknown, time: unknown, zone: unknown): number | null {
  if (typeof date !== 'string' || typeof time !== 'string' || typeof zone !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(date) || !/^\d\d:\d\d(:\d\d)?$/.test(time)) return null;
  const asUtc = strictInstant(`${date}T${time}Z`);
  if (asUtc === null) return null;
  try {
    // Offsets either side of the moment cover any change near it; keep each candidate that reads back as the same local time.
    const found = new Set([offsetAt(asUtc - 43200000, zone), offsetAt(asUtc + 43200000, zone)].map(offset => asUtc - offset).filter(t => t + offsetAt(t, zone) === asUtc));
    return found.size === 1 ? [...found][0] : null;
  } catch { return null; } // an unknown zone name
}

type CiteFn = (block: string, needle?: string) => Cite;
const finite = (v: unknown) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

type Metres = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => number;
/** The app-declared arrival while the driver was still far from the pin and moving. `metres` is observations.ts's haversine. */
export function arrivalWhileMovingFact(trip: any, gps: any[], cite: CiteFn, metres: Metres): Fact {
  const base = `True when the app-declared arrival came while the nearest GPS sample at or before it (no more than ${staleSampleSeconds} s earlier) put the driver at least 200 m from the pickup pin after subtracting its stated accuracy, and moving at 10 km/h or more. A consistency note for review, not a finding about intent: GPS error, a misplaced pin or a delayed tap can look the same.`;
  const declared = strictInstant(trip?.driver_arrival_time), pin = trip?.pickup_location;
  const unavailable = (why: string, extra: Cite[] = []): Fact => ({ id: 'arrival_declared_far_while_moving', value: 'unavailable', explanation: `Unavailable: ${why}. ${base}`, citations: [cite('trip_data', '"driver_arrival_time"'), ...extra] });
  if (declared === null) return unavailable('the declared arrival time cannot be read with its time zone');
  if (!pin || !finite(pin.lat) || !finite(pin.lng)) return unavailable('the pickup pin has no readable coordinates', [cite('trip_data', '"pickup_location"')]);
  if (!Array.isArray(gps) || !gps.length) return unavailable('the record has no GPS samples');
  const stamped = gps.map(g => ({ g, at: strictInstant(g?.timestamp) }));
  if (stamped.some(s => s.at === null)) return unavailable('a GPS sample\'s time cannot be read with its time zone', [cite('gps_telemetry')]);
  const earlier = stamped.filter(s => s.at! <= declared);
  if (!earlier.length) return unavailable('no GPS sample at or before the declared arrival', [cite('gps_telemetry')]);
  const last = Math.max(...earlier.map(s => s.at!)), nearest = earlier.filter(s => s.at === last).map(s => s.g);
  const age = (declared - last) / 1000, at = cite('gps_telemetry', nearest[0].timestamp);
  if (age > staleSampleSeconds) return unavailable(`the nearest earlier GPS sample is ${age} s old (more than ${staleSampleSeconds} s)`, [at]);
  const readings = nearest.map(g => ({ ok: finite(g.lat) && finite(g.lng) && finite(g.speed_kmh) && Number(g.speed_kmh) >= 0 && finite(g.accuracy_m) && Number(g.accuracy_m) >= 0, metres: metres(pin, g), speed: Number(g.speed_kmh), accuracy: Number(g.accuracy_m) }));
  if (readings.some(r => !r.ok)) return unavailable('that GPS sample lacks a readable position, speed or accuracy', [at]);
  if (new Set(readings.map(r => `${r.metres}|${r.speed}|${r.accuracy}`)).size > 1) return unavailable('two GPS samples at the same moment disagree', [cite('gps_telemetry')]);
  const r = readings[0];
  return { id: 'arrival_declared_far_while_moving', value: r.metres - r.accuracy >= 200 && r.speed >= 10, explanation: `${base} Sample ${nearest[0].timestamp}: ${r.metres} m from the pin (accuracy ${r.accuracy} m), ${r.speed} km/h.`, citations: [cite('trip_data', '"driver_arrival_time"'), at] };
}

/** A receipt's cleaning time before the recorded trip end, read in the dataset's own time zone. */
export function cleaningBeforeTripEndFact(fields: any, tripEnd: unknown, zone: string | undefined, cite: CiteFn): Fact {
  const base = 'True when the receipt\'s cleaning time, read in the dataset\'s own time zone, is before the recorded trip end. A consistency note for review, not a finding about anyone: a date or time typed wrongly on a receipt looks the same.';
  const citations = [cite('documents', fields?.cleaning_date ? '"cleaning_date"' : undefined), ...(tripEnd ? [cite('trip_data', '"trip_end_time"')] : [])];
  const end = strictInstant(tripEnd), cleaned = zone ? zonedInstant(fields?.cleaning_date, fields?.cleaning_time, zone) : null;
  const why = !zone ? 'the dataset states no time zone for the receipt\'s local time'
    : !fields?.cleaning_date || !fields?.cleaning_time ? 'the receipt has no cleaning date and time'
    : cleaned === null ? `the receipt's cleaning time cannot be placed in ${zone} (unreadable, or a time the clocks skip or repeat)`
    : end === null ? 'the trip end time is missing or has no readable time zone' : null;
  if (why) return { id: 'cleaning_time_before_trip_end', value: 'unavailable', explanation: `Unavailable: ${why}. ${base}`, citations };
  return { id: 'cleaning_time_before_trip_end', value: cleaned! < end!, explanation: `${base} Cleaning ${fields.cleaning_date} ${fields.cleaning_time} (${zone}); trip end ${tripEnd}.`, citations };
}
