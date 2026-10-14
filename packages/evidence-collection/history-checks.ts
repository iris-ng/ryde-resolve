import type { CasePacket } from '../agent-flow/contracts';
import type { Cite, Fact } from '../agent-flow/facts';
import { datasetBlock } from '../case-packet/dataset';
import { earlierClaimsSourceId } from '../case-packet/earlier-claims';

// Facts 7 (MVP fixes F9, second release, 10 October 2026): past-behaviour patterns for each party (earlier claims by type in the
// last 90 days from the claims register, a rating trend over the recorded months, a new account), read from structured fields only and
// labelled "not proof about this trip". They inform the reviewer and the agents; no check, routing rule or money ceiling reads them.
// `cite(block, needle)` cites the line of evidence/<block>.json that contains needle (or the whole source); check the block exists first.
// Fraud flags never reach a profile source (dataset.ts) and no field of that name is read here.

/** Operator-only account history. Context, never a routing trigger. */
export type HistoryLine = { party: 'rider' | 'driver'; status: 'ok' | 'too_few_trips' | 'unknown'; trips: number | null; windowDays: number | null; perThousand: { upheld: number | null; rejected: number | null; pending: number | null }; text: string };
const perThousand = (count: unknown, trips: number) => typeof count === 'number' && Number.isFinite(count) && count >= 0 ? Math.round(count / trips * 10000) / 10 : null;
/**
 * Disputes per 1,000 trips by party (operator context, the record check's `history`; and the patterns below, so both show the same
 * numbers). Below 50 trips reads "too few trips"; missing data reads "unknown".
 */
export function historyContext(data: any): HistoryLine[] {
  return (['rider', 'driver'] as const).map(party => {
    const profile = data?.[party + '_profile'], history = profile?.dispute_history, trips = profile?.total_trips;
    const name = party === 'rider' ? 'Rider' : 'Driver', windowDays = typeof history?.window_days === 'number' ? history.window_days : null;
    if (typeof trips !== 'number' || !Number.isFinite(trips) || trips < 0 || !history || typeof history !== 'object')
      return { party, status: 'unknown', trips: null, windowDays, perThousand: { upheld: null, rejected: null, pending: null }, text: `${name}: unknown (the record has no trip count or dispute history).` };
    if (trips < 50) return { party, status: 'too_few_trips', trips, windowDays, perThousand: { upheld: null, rejected: null, pending: null }, text: `${name}: too few trips (${trips}) for a rate.` };
    const rates = { upheld: perThousand(history.upheld ?? history.upheld_against, trips), rejected: perThousand(history.rejected, trips), pending: perThousand(history.pending, trips) };
    const show = (v: number | null) => v === null ? 'unknown' : v.toFixed(1);
    return { party, status: 'ok', trips, windowDays, perThousand: rates, text: `${name}: ${trips.toLocaleString('en-US')} trips; per 1,000 trips, ${show(rates.upheld)} upheld, ${show(rates.rejected)} rejected and ${show(rates.pending)} pending disputes${windowDays ? ` (disputes counted over ${windowDays} days)` : ''}.` };
  });
}

/** Team standard (owner's plan, second release): an account under 30 days old is new; a monthly average down 0.2 or more from the first recorded month to the last is falling. */
export const historyStandard = { newAccountDays: 30, fallingDrop: 0.2 } as const;
const statuses = ['settled', 'partial', 'pending', 'rejected'];
const objectOf = (v: unknown): any => v && typeof v === 'object' && !Array.isArray(v) ? v : null;
const sgd = (cents: number) => `S$${(cents / 100).toFixed(2)}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const yesNo = (v: boolean | null) => v === null ? 'unknown' : v ? 'yes' : 'no';
/** The lines of one party's part of the extract: from `  "rider": {` to its closing brace (earlier-claims.ts writes it so). */
function partLines(packet: CasePacket, party: 'rider' | 'driver'): Cite | null {
  const lines = packet.sources.find(s => s.id === earlierClaimsSourceId)?.lines ?? [], start = lines.findIndex(l => l.startsWith(`  "${party}": {`));
  const end = start < 0 ? -1 : lines.findIndex((l, i) => i > start && /^ {2}\}/.test(l));
  return start < 0 || end < 0 ? null : { sourceId: earlierClaimsSourceId, startLine: start + 1, endLine: end + 1 };
}

export function historyCheckFacts(packet: CasePacket, cite: (block: string, needle?: string) => Cite): Fact[] {
  const has = (block: string) => packet.sources.some(s => s.id === `evidence/${block}.json`);
  const extract = has('earlier_claims') ? objectOf(datasetBlock(packet, 'earlier_claims')) : null;
  const profiles = { rider_profile: has('rider_profile') ? objectOf(datasetBlock(packet, 'rider_profile')) : null, driver_profile: has('driver_profile') ? objectOf(datasetBlock(packet, 'driver_profile')) : null };
  const rates = historyContext(profiles);
  return (['rider', 'driver'] as const).flatMap((party, index): Fact[] => {
    const block = `${party}_profile`, profile = profiles[block as keyof typeof profiles];
    if (!has(block) && !has('earlier_claims')) return [];
    const at = (needle: string) => has(block) ? [cite(block, needle)] : [], citations: Cite[] = [], said: string[] = [];
    const who = `the ${party}`, Who = party === 'rider' ? 'The rider' : 'The driver';

    // 1. Account age: a whole number of days, 0 or more.
    const age = profile?.account_age_days, ageOk = Number.isInteger(age) && age >= 0;
    const account = ageOk ? { account_age_days: age as number, new_account: age < historyStandard.newAccountDays } : null;
    if (profile && 'account_age_days' in profile) citations.push(...at('"account_age_days"'));
    said.push(account ? `Account: ${(age as number).toLocaleString('en-US')} days old (new_account, under ${historyStandard.newAccountDays} days: ${yesNo(account.new_account)}).`
      : profile && 'account_age_days' in profile ? 'Account: the account age is unreadable, so it is not used.' : 'Account: no account age is recorded.');

    // 2. Ratings: every recorded month readable (YYYY-MM, once each) with an average from 0 to 5; put in month order.
    const history = profile?.rating_history;
    const rows = Array.isArray(history) ? history.map((r: any) => ({ month: r?.month, avg_rating: r?.avg_rating })) : null;
    const readable = !!rows?.length && rows.every(r => typeof r.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(r.month) && typeof r.avg_rating === 'number' && Number.isFinite(r.avg_rating) && r.avg_rating >= 0 && r.avg_rating <= 5)
      && new Set(rows.map(r => r.month)).size === rows.length;
    let ratings: { months: { month: string; avg_rating: number }[]; first: number; last: number; change: number | null; falling: boolean | null } | null = null;
    if (readable) {
      const months = [...rows!].sort((a, b) => a.month.localeCompare(b.month)), first = months[0]!.avg_rating, last = months.at(-1)!.avg_rating;
      // Rounded to two decimals, so 4.55 - 4.75 reads -0.2 and not a float's -0.20000000000000018.
      const change = months.length >= 2 ? Math.round((last - first) * 100) / 100 : null;
      ratings = { months, first, last, change, falling: change === null ? null : change <= -historyStandard.fallingDrop };
    }
    if (history !== undefined && history !== null) citations.push(...at('"rating_history"'));
    said.push(ratings ? `Ratings: the monthly average went from ${ratings.first} in ${ratings.months[0]!.month} to ${ratings.last} in ${ratings.months.at(-1)!.month}${ratings.change === null ? ' (one month only, so no change)' : `, a change of ${ratings.change}`} (falling, a drop of ${historyStandard.fallingDrop} or more: ${yesNo(ratings.falling)}).`
      : history === undefined || history === null || (Array.isArray(history) && !history.length) ? 'Ratings: no monthly ratings are recorded.' : 'Ratings: a recorded month or rating is unreadable, so the trend is not used.');

    // 3. Earlier claims: the extract the loader copied from the claims register (case-packet/earlier-claims.ts), read as it is.
    const section = objectOf(extract?.[party]), window = objectOf(extract?.window), claims: any[] | null = Array.isArray(section?.claims) ? section.claims : null;
    const claimsOk = extract?.register === 'read' && Number.isInteger(window?.days) && typeof window?.first_day === 'string' && typeof window?.last_day === 'string' && claims !== null
      && claims.every(c => typeof c?.type === 'string' && statuses.includes(c?.status) && Number.isInteger(c?.amount_cents) && c.amount_cents >= 0 && typeof c?.entered_on === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c.entered_on));
    let earlier: { window_days: number; first_day: string; last_day: string; total: number; groups: { type: string; status: string; claims: number; amount_cents: number }[]; entered_on: string[] } | null = null;
    if (claimsOk) {
      const groups = new Map<string, { type: string; status: string; claims: number; amount_cents: number }>();
      for (const c of claims!) { const key = `${c.type}\u0000${c.status}`, g = groups.get(key) ?? { type: c.type, status: c.status, claims: 0, amount_cents: 0 }; g.claims++; g.amount_cents += c.amount_cents; groups.set(key, g); }
      earlier = { window_days: window.days, first_day: window.first_day, last_day: window.last_day, total: claims!.length, groups: [...groups.values()].sort((a, b) => a.type.localeCompare(b.type) || statuses.indexOf(a.status) - statuses.indexOf(b.status)), entered_on: claims!.map(c => c.entered_on) };
    }
    // Cited: the window (or why the register was not read) and this party's whole part of the extract, its claims included.
    if (extract) citations.push(cite('earlier_claims', extract.register === 'read' ? '"window"' : '"register"'), partLines(packet, party) ?? cite('earlier_claims'));
    said.push(earlier ? `Earlier claims: ${earlier.total ? plural(earlier.total, 'claim') : 'no claim'} by ${who} ${earlier.total > 1 ? 'were' : 'was'} entered in Ryde's claims register in the ${earlier.window_days} days before this trip's date (${earlier.first_day} to ${earlier.last_day}), found by ${who}'s ID${earlier.total ? `: ${earlier.groups.map(g => `${g.type}, ${g.status}: ${plural(g.claims, 'claim')}, ${sgd(g.amount_cents)}`).join('; ')}. A claim's status is how Ryde settled it, not what happened on this trip` : ''}.`
      : !extract ? 'Earlier claims: unknown (no register extract is on this packet).'
        : extract.register !== 'read' ? `Earlier claims: unknown (${typeof extract.reason === 'string' ? extract.reason : 'the claims register could not be read'}).`
          : claims === null ? `Earlier claims: unknown (the trip record names no ${party}).` : 'Earlier claims: unknown (a claim in the register extract is unreadable).');

    // 4. Disputes per 1,000 trips, as the operator view computes them (historyContext above).
    const rate = rates[index]!, disputes = rate.status === 'unknown' ? null : { status: rate.status, trips: rate.trips, window_days: rate.windowDays, ...rate.perThousand };
    if (profile && ('total_trips' in profile || 'dispute_history' in profile)) citations.push(...at('"total_trips"'), ...at('"dispute_history"'));
    const show = (v: number | null) => v === null ? 'unknown' : v.toFixed(1);
    said.push(rate.status === 'ok' ? `Disputes per 1,000 trips: ${show(rate.perThousand.upheld)} upheld, ${show(rate.perThousand.rejected)} rejected and ${show(rate.perThousand.pending)} pending, from ${rate.trips!.toLocaleString('en-US')} trips${rate.windowDays ? ` (disputes counted over ${rate.windowDays} days)` : ''}.`
      : rate.status === 'too_few_trips' ? `Disputes per 1,000 trips: too few trips (${rate.trips}) for a rate.` : 'Disputes per 1,000 trips: unknown (the record has no readable trip count or dispute history).');

    const unique = citations.filter((c, i) => citations.findIndex(x => x.sourceId === c.sourceId && x.startLine === c.startLine && x.endLine === c.endLine) === i);
    return [{ id: `${party}_history_patterns`, value: { account, ratings, earlier_claims: earlier, disputes_per_1000_trips: disputes },
      explanation: `${Who}'s past behaviour on record, from structured fields only. ${said.join(' ')} A part is null when its field is missing or unreadable. This is context about a person, not proof about this trip: a past claim, a rating or an account's age does not show what happened on this trip, and it never decides a question, a route or an amount.`,
      citations: unique.length ? unique : [cite(has(block) ? block : 'earlier_claims')] }];
  });
}
