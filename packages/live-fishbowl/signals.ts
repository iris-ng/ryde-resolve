import type { EvidenceChecksView } from './checks-view';

// Bad-faith signals (the handbook's fraud and bad-faith stretch goal; owner, 11 October 2026): the checks that already look
// for a claim made in bad faith, gathered in one place for the case summary, each with its innocent reading. Plain code over
// what the run recorded: the record check's matches (integrity.ts), the two consistency facts (consistency.ts) and each
// party's past behaviour (history-checks.ts). No model reads or writes any of it here. Display only: it adds nothing an agent
// reads and changes no routing; a record match sends a case to a person, as it did before. The disputes-per-1,000-trips
// rate is left out: it divides a one-year count by all-time trips, so it reads low for older accounts.

/** `sentToPerson`: this run's release check did send the case to a person for it (a record match can be recorded on a run
 *  that ended before any decision, such as a cleaning claim returned at intake). */
export type Signal = { key: string; text: string; innocent: string; sentToPerson: boolean };
/** `available`: at least one check ran or was recorded as unable to run, so the section has something true to say. `notes`:
 *  checks that could not run, so "none found" is never read as covering them. */
export type Signals = { available: boolean; ran: boolean; signals: Signal[]; notes: string[] };
type Event = { kind: string; data?: any };

const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
const text = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : null;
const whole = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
const rating = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null;

export function badFaithSignals(events: Event[], checks: EvidenceChecksView | null | undefined): Signals {
  const signals: Signal[] = [], notes: string[] = [];
  let ran = false;
  // 1. The record check: each match, in the check's own words (it already says why it may be innocent).
  const integrity = events.find(e => e.kind === 'integrity_checked')?.data;
  const routedForMatch = events.some(e => e.kind === 'decision_proposed' && Array.isArray(e.data?.routing?.reasons) && e.data.routing.reasons.some((r: any) => r?.code === 'integrity_check'));
  if (integrity?.status === 'checked') {
    ran = true;
    (Array.isArray(integrity.matches) ? integrity.matches : []).forEach((m: any, i: number) => {
      const said = text(m?.text), innocent = text(m?.innocentReading);
      if (said && innocent) signals.push({ key: `record-${i}`, text: said, innocent, sentToPerson: routedForMatch });
    });
  } else if (integrity?.status === 'unavailable') notes.push('The record check could not run, so this case was not compared with earlier claims.');
  // 2. The consistency facts: only a definite true is a signal; a definite false is a check that ran; unavailable says nothing.
  const fact = (id: string) => (checks?.signals ?? []).find(f => f?.id === id)?.value;
  if (['arrival_declared_far_while_moving', 'cleaning_time_before_trip_end'].some(id => typeof fact(id) === 'boolean')) ran = true;
  if (fact('arrival_declared_far_while_moving') === true) signals.push({ key: 'arrival', sentToPerson: false,
    text: 'The driver\'s app said "arrived" while the car was still far from the pickup point and moving.',
    innocent: 'A late GPS reading, or the button pressed early by mistake.' });
  if (fact('cleaning_time_before_trip_end') === true) signals.push({ key: 'receipt', sentToPerson: false,
    text: 'The cleaning receipt is timed before the trip ended.',
    innocent: 'A wrong clock on the receipt, or a time typed in wrongly.' });
  // 3. Past behaviour, by the team's own standards (history-checks.ts): a new account, a falling rating, earlier claims.
  for (const f of checks?.history ?? []) {
    const party = f?.id === 'rider_history_patterns' ? 'rider' : f?.id === 'driver_history_patterns' ? 'driver' : null, v = f?.value as any;
    if (!party || !v || typeof v !== 'object') continue;
    if (v.account || v.ratings || v.earlier_claims) ran = true;
    const age = whole(v.account?.account_age_days), first = rating(v.ratings?.first), last = rating(v.ratings?.last), claims = whole(v.earlier_claims?.total), days = whole(v.earlier_claims?.window_days);
    if (v.account?.new_account === true && age !== null) signals.push({ key: `${party}-new`, sentToPerson: false,
      text: `The ${party}'s account is ${plural(age, 'day')} old, under 30 days.`, innocent: 'Every account starts new.' });
    if (v.ratings?.falling === true && first !== null && last !== null) signals.push({ key: `${party}-rating`, sentToPerson: false,
      text: `The ${party}'s monthly rating fell from ${first} to ${last}.`, innocent: 'Ratings move for many reasons, most of them unrelated to claims.' });
    if (claims && days) signals.push({ key: `${party}-claims`, sentToPerson: false,
      text: `The ${party} made ${plural(claims, 'earlier claim')} in the ${days} days before this trip.`, innocent: 'Earlier claims can all be fair; a count says nothing about this trip.' });
  }
  return { available: ran || notes.length > 0, ran, signals, notes };
}
