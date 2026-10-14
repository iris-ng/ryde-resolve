'use client';
import type { ReactNode } from 'react';
import type { Cite } from '../fishbowl/live/workbench';
import type { CheckFact, EvidenceChecksView } from '../../../../packages/live-fishbowl/checks-view';
import { sgSeconds } from '../../../../packages/live-fishbowl/sg-time';
import { CiteList, Citations } from './evidence-checks';

// The second release made visible (MVP fixes, second release, 10 October 2026), each only when its data is there, so older
// runs look as before: an advocate's lookup trail inside its full response (the server's own record of what it looked up,
// disclosed with the argument as `lookups`; nothing from before disclosure is read), the gap points inside a challenge and the
// Arbitrator's answer to each one, and the Past behaviour card in the Evidence column (checks-view.ts history). Words are the
// page's own; record kinds, answers and field values never show as they are stored.

type Open = (c: Cite) => void;
type Sourced = { sources?: { id: string; text: string; lines: string[] }[] } | null | undefined;
const int = (v: unknown) => Number.isInteger(v) && (v as number) > 0;
const isCite = (c: any): c is Cite => !!c && typeof c.sourceId === 'string' && int(c.startLine) && int(c.endLine) && c.endLine >= c.startLine;
const cites = (v: unknown): Cite[] => (Array.isArray(v) ? v : []).filter(isCite).map(c => ({ sourceId: c.sourceId, startLine: c.startLine, endLine: c.endLine }));
const str = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : null;
const plural = (n: number, one: string, many = one + 's') => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const capital = (s: string) => s ? s[0].toUpperCase() + s.slice(1) : s;
const words = (s: string) => s.replaceAll('_', ' ').trim();
const money = (cents: number) => `S$${(cents / 100).toFixed(2)}`;
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Only a time with an explicit offset is shown (consistency.ts strictInstant); seconds only when the time has them.
const instant = (iso: unknown): iso is string => typeof iso === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)$/.test(iso) && Number.isFinite(Date.parse(iso));
const clock = (iso: unknown) => instant(iso) ? sgSeconds(iso).replace(/:00 SGT$/, ' SGT') : null;
const bare = (iso: unknown) => clock(iso)?.replace(/ SGT$/, '') ?? null;
const partyOf = (v: unknown) => v === 'driver' ? 'driver' : v === 'rider' ? 'rider' : null;

/** A source's top-level array entries with their exact lines, in the pinned two-space form the lookups read (own-side.ts); [] otherwise. */
function entries(packet: Sourced, block: string): { startLine: number; endLine: number; value: any }[] {
  const source = packet?.sources?.find(s => s.id === `evidence/${block}.json`);
  let value: unknown; try { value = source ? JSON.parse(source.text) : null; } catch { return []; }
  if (!source || !Array.isArray(value) || source.text !== JSON.stringify(value, null, 2)) return [];
  let line = 2;
  return value.map(v => { const span = JSON.stringify(v, null, 2).split('\n').length, e = { startLine: line, endLine: line + span - 1, value: v }; line += span; return e; });
}
/** The entries of a block that a lookup returned in full. */
const returnedEntries = (packet: Sourced, block: string, returned: Cite[]) => entries(packet, block).filter(e => returned.some(r => r.sourceId === `evidence/${block}.json` && r.startLine <= e.startLine && e.endLine <= r.endLine));
const lineCount = (returned: Cite[]) => returned.reduce((n, r) => n + r.endLine - r.startLine + 1, 0);

// ---- Record requests: what was asked for, and the record's answer. Both the stored names and the renamed ones (on_record,
// not_on_record, cannot_check) are read, so a run from either side of the rename shows the same words.
// The owner's words for a record request's answer (10 October 2026).
export const answerWords: Record<string, string> = { on_record: 'On record', not_on_record: 'Not on record', cannot_check: 'Can\'t be checked' };
const answerClass = (a: unknown) => a === 'on_record' ? 'on' : a === 'not_on_record' ? 'off' : 'unknown';
export const kindWords: Record<string, string> = {
  gps: 'the GPS', chat: 'the chat', call_log: 'the in-app call log', payments: 'the payments', receipts: 'a receipt', photos: 'photos', app_events: 'the app events', eta: 'the arrival estimates',
  route: 'the route record', statements: 'statements', documents: 'documents', rainfall: 'rain on the trip date', traffic: 'traffic on the trip date', cctv_or_dashcam: 'camera or dashcam footage',
  phone_records_outside_app: 'calls or messages outside the app', other: 'another kind of record',
};
// A word list is read only by its own keys (a value such as "__proto__" must fall back to plain words, never crash the card).
const own = (map: Record<string, string>, key: unknown): string | undefined => typeof key === 'string' && Object.hasOwn(map, key) ? map[key] : undefined;
const kindName = (k: unknown) => typeof k === 'string' ? own(kindWords, k) ?? 'another kind of record' : 'a record';
function Answer({ answer }: { answer: unknown }) {
  const word = own(answerWords, answer);
  return <span className={'lab-answer lab-record-answer answer-' + (word ? answerClass(answer) : 'unknown')}>{word ?? 'No answer'}</span>;
}

type Lookup = { tool: string; args: Record<string, unknown>; returned: Cite[]; request?: { requestId: string | null; answer: string | null; points: Cite[] } };
/** The trail on an artifact, its shape checked: it came from the server, but the page never trusts a shape it reads. */
function trailOf(item: any): Lookup[] {
  return (Array.isArray(item?.lookups) ? item.lookups : []).filter((l: any) => l && typeof l.tool === 'string').map((l: any) => ({
    tool: l.tool, args: l.args && typeof l.args === 'object' && !Array.isArray(l.args) ? l.args : {}, returned: cites(l.returned),
    ...(l.request && typeof l.request === 'object' ? { request: { requestId: str(l.request.requestId), answer: str(l.request.answer), points: cites(l.request.points) } } : {}),
  }));
}
const between = (from: unknown, to: unknown) => clock(from) && clock(to) ? ` between ${bare(from)} and ${clock(to)}` : clock(from) ? ` from ${clock(from)}` : clock(to) ? ` up to ${clock(to)}` : '';
/** One lookup in plain words, with the lines it returned. */
function lookupRow(l: Lookup, packet: Sourced): { text: ReactNode; answer?: unknown; said?: string | null; cites: Cite[] } {
  const a = l.args, none = !l.returned.length;
  switch (l.tool) {
    case 'find_in_record': { const n = lineCount(l.returned); return { text: <>Searched the record for “{str(a.query) ?? ''}”: {none ? 'nothing found' : plural(n, 'line')}</>, cites: l.returned }; }
    case 'gps_between': { const n = returnedEntries(packet, 'gps_telemetry', l.returned).length; return { text: `GPS${between(a.from, a.to)}: ${none ? 'no points' : plural(n, 'point')}`, cites: l.returned }; }
    case 'chat_messages': {
      const found = returnedEntries(packet, 'chat_logs', l.returned), calls = found.filter(e => e.value?.type === 'call').length, sender = a.sender === 'system' ? 'Ryde' : partyOf(a.sender) ? `the ${a.sender}` : null;
      const count = none ? 'none' : [found.length - calls && plural(found.length - calls, 'message'), calls && plural(calls, 'call')].filter(Boolean).join(' and ') || plural(lineCount(l.returned), 'line');
      return { text: `Chat${sender ? ` from ${sender}` : ''}${between(a.from, a.to)}: ${count}`, cites: l.returned };
    }
    case 'payment_records': return { text: `The payments and the fare: ${none ? 'none on record' : plural(lineCount(l.returned), 'line')}`, cites: l.returned };
    case 'app_events': { const n = returnedEntries(packet, 'app_events', l.returned).length, type = str(a.type); return { text: <>App events{type ? <> of the kind “{words(type)}”</> : null}: {none ? 'none' : plural(n, 'event')}</>, cites: l.returned }; }
    case 'party_history': return { text: `The ${partyOf(a.party) ?? 'party'}'s past behaviour${none ? ': no profile on record' : ''}`, cites: l.returned };
    case 'route_checks': return { text: 'The route checks worked out from the GPS', cites: l.returned };
    case 'request_record': return { text: `Asked for ${kindName(a.kind)}`, answer: !l.request ? undefined : l.request.requestId ? l.request.answer : null, said: str(a.what), cites: l.request?.points ?? [] };
    default: return { text: `Looked something up${none ? '' : `: ${plural(lineCount(l.returned), 'line')}`}`, cites: l.returned };
  }
}

/** Inside an advocate's full response: what it looked up and asked for, in order, each with the lines it got back. */
export function LookupTrail({ item, packet, openSource }: { item: any; packet: Sourced; openSource: Open }) {
  const trail = trailOf(item), party = partyOf(item?.author);
  if (!trail.length || !party) return null;
  return <section className="lab-lookups" aria-label={`What the ${party} looked up`}>
    <h4>What the {party} looked up</h4>
    <ol>{trail.map((l, i) => { const row = lookupRow(l, packet); return <li key={i}>
      <p><span>{row.text}</span>{row.answer !== undefined && <> <Answer answer={row.answer} /></>}</p>
      {row.said && <p className="lab-lookup-said">Its words: “{row.said}”</p>}
      {row.answer === null && <p className="lab-lookup-said">No answer: an advocate can ask for at most three records at each step.</p>}
      <CiteList items={row.cites} openSource={openSource} />
    </li>; })}</ol>
    {/* Record requests are the second release's only (evidence checks 2): a later advocate cannot ask, so the note says so only where one did. */}
    <p className="lab-check-note">The searches this advocate ran while preparing its argument, shown once the argument is shared.{trail.some(l => l.tool === 'request_record') && ' Where it asked whether a record exists, the system checked the case file and answered, up to three requests at each step.'}</p>
  </section>;
}

// ---- Gap points: a record the case does not hold, filed against an opposing point, and the Arbitrator's answer.
type Gap = { gapPointId: string | null; targetClaimId: string; requestId: string; why: string; citations: unknown };
const gapsOf = (item: any): Gap[] => (Array.isArray(item?.gapPoints) ? item.gapPoints : []).filter((g: any) => g && typeof g.targetClaimId === 'string' && typeof g.why === 'string')
  .map((g: any) => ({ gapPointId: str(g.gapPointId), targetClaimId: g.targetClaimId, requestId: String(g.requestId ?? ''), why: g.why, citations: g.citations }));
/** The disclosed claim a gap point weakens, found by its ID in the disclosed arguments: its words and whose it is. */
function claimFor(disclosed: Record<string, any> | undefined, claimId: string) {
  for (const [key, a] of Object.entries(disclosed ?? {})) {
    const claim = (Array.isArray(a?.claims) ? a.claims : []).find((c: any) => c?.claimId === claimId && typeof c.statement === 'string');
    if (claim) return { statement: claim.statement as string, party: partyOf(a?.author) ?? partyOf(key.split('_')[0]) };
  }
  return null;
}
/** What the advocate asked for (its own trail, by request ID) and the answer. */
const requestFor = (item: any, requestId: string) => trailOf(item).find(l => l.tool === 'request_record' && l.request?.requestId === requestId);
/** "Asked for: camera or dashcam footage [Not on record]", and the advocate's own words for what it asked: when wanted, and
 *  always for "another kind of record", which says nothing by itself. */
function Asked({ asked, said = true }: { asked: Lookup | undefined | null; said?: boolean }) {
  if (!asked) return null;
  const what = said || !(typeof asked.args.kind === 'string' && asked.args.kind in kindWords) || asked.args.kind === 'other' ? str(asked.args.what) : null;
  return <><p><span className="lab-gap-label">Asked for:</span> {kindName(asked.args.kind)} <Answer answer={asked.request?.answer} /></p>{what && <p className="lab-lookup-said">Its words: “{what}”</p>}</>;
}

/** Inside a challenge's full response: each gap it filed, the point it weakens, what was asked and the answer, and why. */
export function GapPointsView({ item, disclosed, openSource }: { item: any; disclosed?: Record<string, any>; openSource: Open }) {
  const gaps = gapsOf(item);
  if (!gaps.length) return null;
  return <section className="lab-gaps" aria-label="Missing records">
    <h4>Missing records</h4>
    <ol>{gaps.map((g, i) => { const claim = claimFor(disclosed, g.targetClaimId), asked = requestFor(item, g.requestId); return <li key={i}>
      <b>Missing record {i + 1}</b>
      <p className="lab-gap-label">Weakens the {claim?.party ?? 'other side'}&apos;s point:</p>
      {claim ? <blockquote className="lab-quote"><p>“{claim.statement}”</p></blockquote> : <p>A point in the other side&apos;s argument.</p>}
      <Asked asked={asked} />
      <p><span className="lab-gap-label">Why it matters:</span> {g.why}</p>
      <Citations items={g.citations} openSource={openSource} />
    </li>; })}</ol>
    <p className="lab-check-note">A missing record can reduce the weight of a point. It never stops the run or sends the case to a person by itself. The Arbitrator answers each one.</p>
  </section>;
}

export const effectWords: Record<string, string> = { reduces_weight: 'Reduces its weight', no_effect: 'No effect' };
/** "…/rider/challenge#G2" reads "Missing record 2, raised by the rider's advocate" when the challenge itself is not at hand. */
const fromId = (id: string) => { const m = /\/(rider|driver)\/challenge#G(\d+)$/.exec(id); return m ? { party: m[1] as 'rider' | 'driver', n: Number(m[2]) } : null; };
/** On the Arbitrator's decision: its answer to each gap point, with what the gap was and the point it was against. */
export function GapAnswersView({ item, disclosed }: { item: any; disclosed?: Record<string, any> }) {
  const answers = (Array.isArray(item?.gapPointResponses) ? item.gapPointResponses : []).filter((r: any) => r && typeof r.gapPointId === 'string' && typeof r.reason === 'string');
  if (!answers.length) return null;
  return <section className="lab-gap-answers" aria-label="Answers on the missing records">
    <h4>Answers on the missing records</h4>
    <ul>{answers.map((r: any, i: number) => {
      const at = fromId(r.gapPointId), challenge = at && disclosed?.[`${at.party}_challenge`], gaps = gapsOf(challenge), n = gaps.findIndex(g => g.gapPointId === r.gapPointId), gap = n >= 0 ? gaps[n] : null;
      const asked = gap && requestFor(challenge, gap.requestId), claim = gap && claimFor(disclosed, gap.targetClaimId);
      return <li key={i}>
        <b>{at ? `Missing record ${gap ? n + 1 : at.n}, raised by the ${at.party}'s advocate` : `Missing record ${i + 1}`}</b>
        <Asked asked={asked} said={false} />
        {claim && <><p className="lab-gap-label">Against the {claim.party ?? 'other side'}&apos;s point:</p><blockquote className="lab-quote"><p>“{claim.statement}”</p></blockquote></>}
        <p><span className={'lab-answer lab-gap-effect effect-' + (r.effect === 'reduces_weight' ? 'lowers' : 'none')}>{own(effectWords, r.effect) ?? words(String(r.effect ?? ''))}</span> {r.reason}</p>
      </li>;
    })}</ul>
  </section>;
}

// ---- The Past behaviour card.
type History = { account: { account_age_days: number; new_account: boolean } | null; ratings: { months: { month: string; avg_rating: number }[]; first: number; last: number; change: number | null; falling: boolean | null } | null;
  earlier_claims: { window_days: number; first_day: string; last_day: string; total: number; groups: { type: string; status: string; claims: number; amount_cents: number }[] } | null;
  disputes_per_1000_trips: { status: string; trips: number | null; window_days: number | null; upheld: number | null; rejected: number | null; pending: number | null } | null };
const monthName = (m: string) => { const [y, mm] = m.split('-'); return `${months[Number(mm) - 1] ?? mm} ${y}`; };
const day = (d: string, year = true) => { const [y, m, dd] = d.split('-'); return `${Number(dd)} ${months[Number(m) - 1] ?? m}${year ? ' ' + y : ''}`; };
/** "20 Jun to 17 Sep 2026", or with both years when they differ. */
const days = (a: string, b: string) => `${day(a, a.slice(0, 4) !== b.slice(0, 4))} to ${day(b)}`;
const claimType: Record<string, string> = { cleaning_fee: 'Cleaning fee', promo_code: 'Promo code' };
const claimStatus: Record<string, string> = { settled: 'settled', partial: 'partly settled', pending: 'pending', rejected: 'rejected' };
const rate = (v: number | null) => v === null ? 'unknown' : v.toFixed(1);
// A rating always shows a decimal, so a 5 never reads as a date ("Jun 5"): 5.0, 4.9, 4.75.
const stars = (v: number) => v.toFixed(Number.isInteger(Math.round(v * 1000) / 100) ? 1 : 2);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/**
 * Which part of a party's history each cited line backs, from the line's own text: the account age, the ratings, the trip
 * count and dispute history, or the earlier-claims extract. A line it cannot place goes with the rate.
 */
function partCites(packet: Sourced, f: CheckFact) {
  const parts: Record<'account' | 'ratings' | 'claims' | 'disputes', Cite[]> = { account: [], ratings: [], claims: [], disputes: [] };
  for (const c of cites(f.citations)) {
    const text = packet?.sources?.find(s => s.id === c.sourceId)?.lines[c.startLine - 1] ?? '';
    parts[c.sourceId === 'evidence/earlier_claims.json' ? 'claims' : /"account_age_days"/.test(text) ? 'account' : /"rating_history"/.test(text) ? 'ratings' : 'disputes'].push(c);
  }
  return parts;
}
function HistoryParty({ fact, packet, openSource }: { fact: CheckFact; packet: Sourced; openSource: Open }) {
  const v = (fact.value ?? {}) as Partial<History>, party = fact.id.startsWith('driver') ? 'driver' : 'rider', at = partCites(packet, fact);
  const account = v.account && num(v.account.account_age_days) ? v.account : null, ratings = v.ratings && Array.isArray(v.ratings.months) && v.ratings.months.length ? v.ratings : null;
  const claims = v.earlier_claims && Array.isArray(v.earlier_claims.groups) ? v.earlier_claims : null, disputes = v.disputes_per_1000_trips ?? null;
  const tag = (text: string, title: string) => <span className="lab-history-tag" title={title}>{text}</span>;
  const rows: { key: string; body: ReactNode; cites: Cite[] }[] = [
    { key: 'account', cites: at.account, body: <p>{account ? <>Account: {plural(account.account_age_days, 'day')} old.{account.new_account && <> {tag('New account', 'Under 30 days old')}</>}</> : 'Account age: not on record.'}</p> },
    { key: 'ratings', cites: at.ratings, body: ratings ? <>
      <p>{ratings.months.length === 1 ? <>Rating: {stars(ratings.first)} in {monthName(ratings.months[0].month)}, the only month on record.</>
        : <>Rating: {stars(ratings.first)} in {monthName(ratings.months[0].month)}, {stars(ratings.last)} in {monthName(ratings.months.at(-1)!.month)} ({ratings.change === null || ratings.change === 0 ? 'no change' : `${ratings.change < 0 ? 'down' : 'up'} ${Math.abs(ratings.change)}`}).{ratings.falling && <> {tag('Falling', 'Down 0.2 or more from the first month on record to the last')}</>}</>}</p>
      {ratings.months.length > 1 && <p className="lab-history-months" aria-label="Rating by month">{ratings.months.map(m => <span key={m.month}>{months[Number(m.month.slice(5)) - 1]} {typeof m.avg_rating === 'number' ? stars(m.avg_rating) : m.avg_rating}</span>)}</p>}
    </> : <p>Rating: no readable monthly ratings on record.</p> },
    { key: 'claims', cites: at.claims, body: claims ? <>
      <p>Earlier claims in the {claims.window_days} days before the trip ({days(claims.first_day, claims.last_day)}): {claims.total ? plural(claims.total, 'claim') + '.' : 'none.'}</p>
      {claims.groups.length > 0 && <ul className="lab-history-claims">{claims.groups.map((g, i) => <li key={i}><span>{own(claimType, g.type) ?? capital(words(String(g.type)))}, {own(claimStatus, g.status) ?? words(String(g.status))}</span><span>{plural(g.claims, 'claim')}, {money(g.amount_cents)}</span></li>)}</ul>}
    </> : <p>Earlier claims: unknown.</p> },
    { key: 'disputes', cites: at.disputes, body: <p>{!disputes ? 'Disputes per 1,000 trips: unknown.' : disputes.status === 'too_few_trips' ? `Disputes per 1,000 trips: too few trips (${disputes.trips ?? 0}) for a rate.`
      : `Disputes per 1,000 trips: ${rate(disputes.upheld)} upheld, ${rate(disputes.rejected)} rejected, ${rate(disputes.pending)} pending (${plural(disputes.trips ?? 0, 'trip')}${num(disputes.window_days) ? `; disputes from the last ${disputes.window_days} days` : ''}).`}</p> },
  ];
  return <div className={'lab-history-party ' + party}>
    <h3>{party === 'driver' ? 'Driver' : 'Rider'}</h3>
    <ul className="lab-check-list">{rows.map(r => <li key={r.key}>{r.body}<CiteList items={r.cites} openSource={openSource} /></li>)}</ul>
  </div>;
}
/** The Evidence column's Past behaviour card: each party's history from the two history facts, labelled as context only. */
export function HistoryCard({ packet, checks, openSource }: { packet: Sourced; checks: EvidenceChecksView | null | undefined; openSource: Open }) {
  const facts = (Array.isArray(checks?.history) ? checks!.history : []).filter(f => f && (f.id === 'rider_history_patterns' || f.id === 'driver_history_patterns') && f.value && typeof f.value === 'object');
  if (!facts.length) return null;
  return <section className="lab-check-card lab-history-card" aria-label="Past behaviour">
    <h2>Past behaviour</h2>
    <p className="lab-history-note">Context about each person, not proof about this trip. It never decides a question, a route or an amount.</p>
    <p className="lab-check-note">Worked out by plain code from each person&apos;s profile and Ryde&apos;s claims register, not by an AI.</p>
    {facts.map(f => <HistoryParty key={f.id} fact={f} packet={packet} openSource={openSource} />)}
  </section>;
}
