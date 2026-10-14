import { createHash } from 'node:crypto';
import type { Source } from '../agent-flow/contracts';

// Facts 7 (MVP fixes F9, second release, 10 October 2026): each party's own earlier claims from Ryde's claims register
// (evidence/registers/claims-register.json, synthetic), found by the party's ID on the trip record. The facts must depend on the
// pinned packet alone, so the loader copies them into one more source, evidence/earlier_claims.json, labelled as past behaviour;
// dataset.json is never changed. Only each claim's type, status, amount and entry date are copied. No claim or trip ID: the record
// check's matches name earlier claims to a person only (DISP-105's photo match must not be guessable from the case file), and its
// receipt keys, file hashes and photo fingerprints stay on the server (integrity.ts). No register row is a finding about anyone.
export const earlierClaimsSourceId = 'evidence/earlier_claims.json';
/** The look-back: whole days before the trip's date, the trip's own day not included (so a claim entered after the trip on the same day never counts). */
export const earlierClaimsWindowDays = 90;
export const earlierClaimsLabel = 'Past behaviour, not part of this trip\'s record: each party\'s own claims entered in Ryde\'s claims register (synthetic) in the 90 days before this trip\'s date, found by the party\'s ID on the trip record, other trips only. A past claim is context about a person, not proof about this trip, and it never decides a question, a route or an amount.';
export type EarlierClaim = { type: string; status: string; amount_cents: number; entered_on: string };
type Part = { claims: EarlierClaim[] | null } & Record<string, unknown>;
export type EarlierClaimsExtract = { label: string; register: 'read' | 'unavailable'; reason?: string; window: { days: number; first_day: string; last_day: string; trip_date: string } | null; rider: Part; driver: Part };

const zoned = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const day = 86400000;
/** The local date of a time in its own offset, as YYYY-MM-DD. */
const localDate = (ms: number, offsetMs: number) => new Date(ms + offsetMs).toISOString().slice(0, 10);
const str = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : null;

/** The source text: pretty JSON with the window and each claim on one line. */
export function earlierClaimsText(extract: unknown): string {
  const pretty = (v: unknown, pad: string, key?: string): string => {
    if (v === null || typeof v !== 'object' || key === 'window' || key === 'claim') return JSON.stringify(v ?? null);
    if (Array.isArray(v)) return v.length ? `[\n${v.map(x => `${pad}  ${pretty(x, pad + '  ', key === 'claims' ? 'claim' : undefined)}`).join(',\n')}\n${pad}]` : '[]';
    const entries = Object.entries(v).filter(([, x]) => x !== undefined);
    return entries.length ? `{\n${entries.map(([k, x]) => `${pad}  ${JSON.stringify(k)}: ${pretty(x, pad + '  ', k)}`).join(',\n')}\n${pad}}` : '{}';
  };
  return pretty(extract, '');
}

/**
 * The extract for one raw dataset. A register that is missing, malformed, or does not name the rider, the driver and the claim
 * type on every row, or a trip with no readable time, reads `unavailable` with a reason: the earlier claims are then unknown,
 * never "none". The register is validated by the record check's own parser (integrity.ts), imported when called because that
 * module imports the dataset loader.
 */
export async function earlierClaims(data: any): Promise<EarlierClaimsExtract> {
  const { loadRegister, zonedTime } = await import('../evidence-collection/integrity');
  const trip = data?.trip_data ?? {}, tripId = str(trip.trip_id), ownId = str(data?.dispute_ticket?.dispute_id);
  const ids = { rider: str(trip.rider_id), driver: str(trip.driver_id) };
  const part = (party: 'rider' | 'driver', claims: EarlierClaim[] | null): Part => ({ [`${party}_id`]: ids[party], claims });
  const unavailable = (reason: string): EarlierClaimsExtract => ({ label: earlierClaimsLabel, register: 'unavailable', reason, window: null, rider: part('rider', null), driver: part('driver', null) });
  // The trip's date: its start, or its scheduled time when it never started, in the time's own offset.
  const at = [trip.trip_start_time, trip.scheduled_time].find(t => zonedTime(t) !== null) as string | undefined, m = at ? zoned.exec(at) : null;
  if (!m) return unavailable('the trip record has no start or scheduled time with a time zone');
  const end = zonedTime(`${m[1]}T00:00:00${m[2]}`)!, start = end - earlierClaimsWindowDays * day, offset = Date.parse(`${m[1]}T00:00:00Z`) - end;
  const window = { days: earlierClaimsWindowDays, first_day: localDate(start, offset), last_day: localDate(end - day, offset), trip_date: m[1]! };
  let entries: Awaited<ReturnType<typeof loadRegister>>['register']['entries'];
  try { entries = (await loadRegister()).register.entries; } catch (e) { return { ...unavailable(e instanceof Error ? e.message : 'the claims register could not be read'), window }; }
  if (entries.some(e => !str(e.riderId) || !str(e.driverId) || !str(e.type))) return { ...unavailable('the claims register does not name the rider, the driver and the claim type on every claim'), window };
  const claims = (party: 'rider' | 'driver') => ids[party] === null ? null : entries
    .filter(e => e.recipient === party && (party === 'rider' ? e.riderId : e.driverId) === ids[party] && e.tripId !== tripId && e.claimId !== ownId)
    .map(e => ({ e, t: zonedTime(e.createdAt)! })).filter(({ t }) => t >= start && t < end)
    .sort((a, b) => a.t - b.t || a.e.claimId.localeCompare(b.e.claimId))
    .map(({ e, t }) => ({ type: e.type!, status: e.status, amount_cents: e.amountCents, entered_on: localDate(t, offset) }));
  return { label: earlierClaimsLabel, register: 'read', window, rider: part('rider', claims('rider')), driver: part('driver', claims('driver')) };
}
export async function earlierClaimsSource(data: unknown): Promise<Source> {
  const text = earlierClaimsText(await earlierClaims(data));
  return { id: earlierClaimsSourceId, text, lines: text.split('\n'), sha256: createHash('sha256').update(text).digest('hex') };
}
