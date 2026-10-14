'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { isFileAnswer, reach } from './answer';
import type { Cite } from '../fishbowl/live/workbench';
import type { CheckFact, EvidenceChecksView } from '../../../../packages/live-fishbowl/checks-view';
import { sgClock, sgDate } from '../../../../packages/live-fishbowl/sg-time';
import { CiteChip, CiteList, chatEntries } from './evidence-checks';
import { outsideAskedLine, outsideHeading, outsideSummary } from '../../../../packages/outside-data/summary';
import { semanticCallLines } from '../../../../packages/live-fishbowl/precedents-view';

// What each Evidence tab has on record (evidence tabs, user, 10 October 2026): the record in readable form where that is
// short (the route figures and app events, the payments, the outside notes) and the records of that type this case lacks.
// No list of links to the files (user, 10 October 2026: the visual and the record come first; the files are in Files). All of it shows before a run, since it only reads the case file. The
// payment checks are the server's arithmetic on the run's locked case file (checks-view.ts) and show once a run has them.
// Words are the page's own; field values never show as they are stored.

type Open = (c: Cite) => void;
type Source = { id: string; text: string; lines: string[] };
type Packet = { sources: Source[] } | null | undefined;
const sourceOf = (packet: Packet, block: string) => packet?.sources.find(s => s.id === `evidence/${block}.json`);
const valueOf = (packet: Packet, block: string): any => { try { const s = sourceOf(packet, block); return s ? JSON.parse(s.text) : null; } catch { return null; } };
/** A block's top-level array entries with their exact lines, in the pinned two-space form the case file is written in; [] otherwise. */
function entries(packet: Packet, block: string): { startLine: number; endLine: number; value: any }[] {
  const source = sourceOf(packet, block);
  let value: unknown; try { value = source ? JSON.parse(source.text) : null; } catch { return []; }
  if (!source || !Array.isArray(value) || source.text !== JSON.stringify(value, null, 2)) return [];
  let line = 2;
  return value.map(v => { const span = JSON.stringify(v, null, 2).split('\n').length, e = { startLine: line, endLine: line + span - 1, value: v }; line += span; return e; });
}
const whole = (s: Source): Cite => ({ sourceId: s.id, startLine: 1, endLine: s.lines.length });
/**
 * What a list record holds when it has no rows to show: nothing when the case lacks it (the "Not in this case" line says so),
 * a plain line when it is empty, and a way to open it when it cannot be read row by row.
 */
function NoRows({ packet, block, none, openSource }: { packet: Packet; block: string; none: string; openSource: Open }) {
  const source = sourceOf(packet, block);
  if (!source) return null;
  if (Array.isArray(valueOf(packet, block)) && !(valueOf(packet, block) as unknown[]).length) return <p className="lab-check-note">{none}</p>;
  return <p className="lab-check-note">This record could not be read row by row. <button type="button" className="quiet" onClick={() => openSource(whole(source))}>Open it</button></p>;
}
/** A row's chip: its lines only, since the section names the file; the file is in its accessible name. Opens the lines. */
function LineChip({ c, openSource }: { c: Cite; openSource: Open }) {
  const at = c.startLine === c.endLine ? `L${c.startLine}` : `L${c.startLine}–${c.endLine}`;
  return <button type="button" className="citation" aria-label={`${c.sourceId.split('/').at(-1)} · ${at}`} onClick={() => openSource(c)}>{at}</button>;
}
const plural = (n: number, one: string, many = one + 's') => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const capital = (s: string) => s ? s[0].toUpperCase() + s.slice(1) : s;
const words = (v: unknown) => typeof v === 'string' ? v.replaceAll('_', ' ').trim() : '';
const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
const money = (cents: number) => `S$${(Math.abs(cents) / 100).toFixed(2)}`;
/** A record's own amount, its sign kept: a negative total or payment never reads as a positive one. */
const signed = (cents: number) => `${cents < 0 ? '-' : ''}${money(cents)}`;
const instant = (iso: unknown): iso is string => typeof iso === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)$/.test(iso) && Number.isFinite(Date.parse(iso));
const clock = (iso: unknown) => instant(iso) ? sgClock(iso) : '';
const party = (v: unknown) => v === 'rider' ? 'Rider' : v === 'driver' ? 'Driver' : v === 'system' ? 'Ryde' : '';

/** One record a tab looks for: its block, its name, and an optional count read from it. */
type Item = { block: string; label: string; count?: (packet: Packet) => string | null };
const arrayCount = (block: string, one: string, many?: string) => (packet: Packet) => { const v = valueOf(packet, block); return Array.isArray(v) ? plural(v.length, one, many) : null; };
const chatCount = (packet: Packet) => {
  const v = valueOf(packet, 'chat_logs');
  if (!Array.isArray(v)) return null;
  const calls = v.filter(e => e?.type === 'call').length;
  return [plural(v.length - calls, 'message'), calls ? plural(calls, 'call') : ''].filter(Boolean).join(', ');
};
export const recordItems: Record<'gps' | 'chat' | 'fare' | 'history' | 'external', Item[]> = {
  gps: [{ block: 'trip_data', label: 'Trip record' }, { block: 'gps_telemetry', label: 'GPS points', count: arrayCount('gps_telemetry', 'point') }, { block: 'route_data', label: 'Planned and actual route' },
    { block: 'eta_history', label: 'Arrival estimates', count: arrayCount('eta_history', 'estimate') }, { block: 'app_events', label: 'App events', count: arrayCount('app_events', 'event') }],
  chat: [{ block: 'chat_logs', label: 'Chat and call log', count: chatCount }],
  fare: [{ block: 'fare_breakdown', label: 'Fare breakdown' }, { block: 'payment_events', label: 'Payments', count: arrayCount('payment_events', 'payment') }],
  history: [{ block: 'rider_profile', label: 'Rider profile' }, { block: 'driver_profile', label: 'Driver profile' }, { block: 'earlier_claims', label: 'Earlier claims (Ryde\'s claims register)' }],
  external: [{ block: 'external_context', label: 'Outside notes', count: arrayCount('external_context', 'note') }, { block: 'route_reference', label: 'Best road route (saved by the team)' }],
};

/** The records a tab looks for that this case lacks, named in one line; nothing when it has them all. */
export function OnRecord({ packet, items }: { packet: Packet; items: Item[] }) {
  const found = items.filter(i => sourceOf(packet, i.block)), absent = items.filter(i => !sourceOf(packet, i.block));
  if (!absent.length) return null;
  return <p className="lab-check-note lab-on-record">{found.length ? 'Not in this case' : 'None of these is in this case'}: {absent.map(i => i.label.replace(/ \(.*\)$/, '').toLowerCase()).join(', ')}.</p>;
}

/** A card for one tab's record: its title, what is on record, then the readable parts. */
function RecordCard({ title, label, children }: { title: string; label?: string; children: ReactNode }) {
  return <section className="lab-check-card lab-record-card" aria-label={label ?? title}><h2>{title}</h2>{children}</section>;
}

// ---- GPS and telemetry.
/** The planned and actual route's distance and time as the record types them, each with the lines it rests on. */
function routeFigures(packet: Packet) {
  const source = sourceOf(packet, 'route_data'), route = valueOf(packet, 'route_data');
  if (!source || !route || typeof route !== 'object') return null;
  const part = (key: 'planned_route' | 'actual_route') => {
    const v = route[key], km = num(v?.distance_km), min = num(v?.duration_min);
    if (!v || (km === null && min === null)) return null;
    // The lines inside this part's own object, in the pinned two-space form: from its key to its closing brace.
    const start = source.lines.findIndex(l => l.startsWith(`  ${JSON.stringify(key)}: {`)), end = start < 0 ? -1 : source.lines.findIndex((l, i) => i > start && l.startsWith('  }'));
    const at = (field: string) => start < 0 || end < 0 ? -1 : source.lines.findIndex((l, i) => i > start && i < end && l.startsWith(`    ${JSON.stringify(field)}:`));
    const lines = [at('distance_km'), at('duration_min')].filter(i => i >= 0);
    return { km, min, cite: lines.length ? { sourceId: source.id, startLine: Math.min(...lines) + 1, endLine: Math.max(...lines) + 1 } : null };
  };
  const planned = part('planned_route'), actual = part('actual_route');
  return planned || actual ? { planned, actual } : null;
}
const figure = (f: { km: number | null; min: number | null }) => [f.km !== null && `${Math.round(f.km * 10) / 10} km`, f.min !== null && plural(Math.round(f.min), 'minute')].filter(Boolean).join(', ');
function RouteFigures({ packet, openSource }: { packet: Packet; openSource: Open }) {
  const f = routeFigures(packet);
  if (!f) return null;
  const { planned, actual } = f;
  const longer = planned && actual ? [
    planned.km !== null && actual.km !== null && Math.abs(actual.km - planned.km) >= 0.05 && `${Math.round(Math.abs(actual.km - planned.km) * 10) / 10} km ${actual.km > planned.km ? 'longer' : 'shorter'}`,
    planned.min !== null && actual.min !== null && Math.round(actual.min - planned.min) !== 0 && `${plural(Math.abs(Math.round(actual.min - planned.min)), 'minute')} ${actual.min > planned.min ? 'longer' : 'shorter'}`,
  ].filter(Boolean) : [];
  return <div className="lab-record-block">
    <h3>Distance and time</h3>
    <ul className="lab-check-list">
      {planned && <li><p>Planned: {figure(planned)}.</p>{planned.cite && <CiteList items={[planned.cite]} openSource={openSource} />}</li>}
      {actual && <li><p>Actual: {figure(actual)}.{longer.length > 0 && ` The actual trip was ${longer.join(' and ')}.`}{planned && actual && !longer.length && planned.km !== null && actual.km !== null ? ' The same as planned.' : ''}</p>{actual.cite && <CiteList items={[actual.cite]} openSource={openSource} />}</li>}
    </ul>
    <p className="lab-check-note">As the record states them: the planned figures are the app&apos;s at booking, the actual ones its record of the trip.</p>
  </div>;
}
function AppEvents({ packet, openSource }: { packet: Packet; openSource: Open }) {
  const list = entries(packet, 'app_events');
  if (!list.length) return <NoRows packet={packet} block="app_events" none="No app events are recorded." openSource={openSource} />;
  // Open when there is no route to show: then the app's events are this tab's main record (a no-show, a cancellation).
  return <details className="lab-record-block lab-record-fold" open={!sourceOf(packet, 'route_data')}><summary>Trip events from the app ({list.length})</summary>
    <ol className="lab-record-rows">{list.map(e => <li key={e.startLine}><span className="lab-record-time">{clock(e.value?.timestamp)}</span><span>{capital(words(e.value?.event_type)) || 'Event'}{party(e.value?.actor) && <span className="lab-record-who"> · {party(e.value?.actor)}</span>}</span>
      <LineChip c={{ sourceId: 'evidence/app_events.json', startLine: e.startLine, endLine: e.endLine }} openSource={openSource} /></li>)}</ol>
  </details>;
}
export function GpsRecord({ packet, openSource }: { packet: Packet; openSource: Open }) {
  return <RecordCard title="Trip record">
    <OnRecord packet={packet} items={recordItems.gps} />
    <RouteFigures packet={packet} openSource={openSource} />
    <AppEvents packet={packet} openSource={openSource} />
  </RecordCard>;
}

// ---- Chat and calls: the chat card shows the messages (evidence-checks.tsx); this says so when there are none to show.
export function ChatRecord({ packet, openSource }: { packet: Packet; openSource: Open }) {
  if (chatEntries(packet ?? undefined).length) return null;
  const log = sourceOf(packet, 'chat_logs');
  return <RecordCard title="Chat and calls">{log ? <p className="lab-check-note">The chat log could not be read message by message. <button type="button" className="quiet" onClick={() => openSource(whole(log))}>Open it</button></p> : <OnRecord packet={packet} items={recordItems.chat} />}</RecordCard>;
}

// ---- Payment and fare.
const paymentWords: Record<string, string> = { capture: 'Charge', authorization: 'Hold', wallet_credit: 'Wallet credit', wallet_debit: 'Wallet debit', refund: 'Refund', reversal: 'Reversal', cash_collected: 'Cash collected', voucher: 'Voucher' };
const statusWords: Record<string, string> = { settled: 'settled', voided: 'released', pending: 'pending', failed: 'failed' };
const own = (map: Record<string, string>, key: unknown) => typeof key === 'string' && Object.hasOwn(map, key) ? map[key] : undefined;
function Payments({ packet, openSource }: { packet: Packet; openSource: Open }) {
  const list = entries(packet, 'payment_events');
  if (!list.length) return <NoRows packet={packet} block="payment_events" none="No payments are recorded." openSource={openSource} />;
  return <div className="lab-record-block"><h3>Payments</h3>
    <ol className="lab-record-rows">{list.map(e => { const v = e.value ?? {}, amount = num(v.amount); return <li key={e.startLine}><span className="lab-record-time">{clock(v.timestamp)}</span>
      <span>{own(paymentWords, v.type) ?? (capital(words(v.type)) || 'Payment')}{amount !== null && <> <b>{signed(Math.round(amount * 100))}</b></>}{v.counterparty === 'driver' ? ' to the driver' : ''}{own(statusWords, v.status) ? <span className="lab-record-who"> · {own(statusWords, v.status)}</span> : null}</span>
      <LineChip c={{ sourceId: 'evidence/payment_events.json', startLine: e.startLine, endLine: e.endLine }} openSource={openSource} /></li>; })}</ol>
  </div>;
}
const fact = (facts: CheckFact[], id: string) => facts.find(f => f?.id === id);
const isCite = (c: any): c is Cite => !!c && typeof c.sourceId === 'string' && Number.isInteger(c.startLine) && Number.isInteger(c.endLine) && c.startLine > 0 && c.endLine >= c.startLine;
const cites = (f?: CheckFact) => (Array.isArray(f?.citations) ? f!.citations : []).filter(isCite);
/** The payment checks in plain words: collected and returned, the charge against them and the quote, any return still pending. */
export function PaymentChecks({ checks, openSource }: { checks: EvidenceChecksView | null | undefined; openSource: Open }) {
  const facts = Array.isArray(checks?.payment?.facts) ? checks!.payment!.facts : [];
  if (!facts.length) return null;
  const collected = fact(facts, 'collected_from_rider_cents'), refunded = fact(facts, 'refunded_to_rider_cents'), settled = fact(facts, 'payment_reconciled');
  const lines = fact(facts, 'fare_line_items_match_charged'), overQuote = fact(facts, 'charged_minus_quoted_cents');
  const c = num(collected?.value), r = num(refunded?.value), charged = num(checks?.payment?.chargedCents), over = num(overQuote?.value);
  const rows: { key: string; text: string; cites: Cite[] }[] = [];
  if (c !== null) rows.push({ key: 'collected', text: `Collected from the rider: ${money(c)}. Returned to the rider: ${r ? money(r) : 'nothing'}. Holds are left out.`, cites: [...cites(collected), ...cites(refunded)] });
  if (c !== null && charged !== null) rows.push({ key: 'charge', text: `The fare's charged total, ${money(charged)}, ${charged === c ? 'matches what was collected' : `is ${money(charged - c)} ${charged > c ? 'more' : 'less'} than what was collected`}.`, cites: [...cites(collected), ...cites(lines)] });
  if (lines && typeof lines.value === 'boolean') rows.push({ key: 'lines', text: lines.value ? 'The fare\'s lines add up to its charged total.' : 'The fare\'s lines do not add up to its charged total.', cites: cites(lines) });
  if (over !== null) rows.push({ key: 'quote', text: over === 0 ? 'The charged total is the same as the quote.' : `The charged total is ${money(over)} ${over > 0 ? 'more' : 'less'} than the quote.`, cites: cites(overQuote) });
  // payment_reconciled is false both for a pending return and for a case with no payment record; only the first is a finding.
  if (settled && c !== null) rows.push({ key: 'pending', text: settled.value === true ? 'No return to the rider is pending.' : 'A return to the rider is still pending.', cites: cites(settled) });
  if (!rows.length) return null;
  return <div className="lab-record-block"><h3>What the payments show</h3>
    <ul className="lab-check-list">{rows.map(row => <li key={row.key}><p>{row.text}</p><CiteList items={row.cites} openSource={openSource} /></li>)}</ul>
    <p className="lab-check-note">Worked out by plain code from the payment and fare records, not by an AI. Arithmetic on the record, not a finding.</p>
  </div>;
}
/** The fare's quoted and charged totals as the record states them, until the fare checks rebuild the quote from its parts. */
function FareTotals({ packet, openSource }: { packet: Packet; openSource: Open }) {
  const source = sourceOf(packet, 'fare_breakdown'), fare = valueOf(packet, 'fare_breakdown');
  const quoted = num(fare?.quoted_total), charged = num(fare?.charged_total);
  if (!source || (quoted === null && charged === null)) return null;
  const line = (key: string) => { const i = source.lines.findIndex(l => l.startsWith(`  ${JSON.stringify(key)}:`)); return i < 0 ? null : { sourceId: source.id, startLine: i + 1, endLine: i + 1 }; };
  const cites = [quoted !== null && line('quoted_total'), charged !== null && line('charged_total')].filter((c): c is Cite => !!c);
  return <div className="lab-record-block"><h3>The fare</h3>
    <ul className="lab-check-list"><li><p>{[quoted !== null && `Quoted ${signed(Math.round(quoted * 100))}`, charged !== null && `charged ${signed(Math.round(charged * 100))}`].filter(Boolean).join(', ').replace(/^c/, 'C')}.</p><CiteList items={cites} openSource={openSource} /></li></ul>
  </div>;
}
export function FareRecord({ packet, checks, openSource }: { packet: Packet; checks: EvidenceChecksView | null | undefined; openSource: Open }) {
  return <RecordCard title="Payment and fare">
    <OnRecord packet={packet} items={recordItems.fare} />
    {!checks?.fare && <FareTotals packet={packet} openSource={openSource} />}
    <Payments packet={packet} openSource={openSource} />
    <PaymentChecks checks={checks} openSource={openSource} />
  </RecordCard>;
}

// ---- Past behaviour: which records there are; the patterns are the Past behaviour card's (record-checks.tsx).
/** Before the Past behaviour card exists: what it will show, and any record it will lack. */
export function HistoryRecord({ packet }: { packet: Packet }) {
  return <RecordCard title="Past behaviour">
    <p className="lab-check-note">Each person&apos;s account age, ratings, dispute rates and earlier claims show here once a run has worked them out.</p>
    <OnRecord packet={packet} items={recordItems.history} />
  </RecordCard>;
}

// ---- External data.
function OutsideNotes({ packet, heading, openSource }: { packet: Packet; heading: string; openSource: Open }) {
  const list = entries(packet, 'external_context');
  if (!list.length) return <NoRows packet={packet} block="external_context" none="No outside notes are recorded." openSource={openSource} />;
  return <div className="lab-record-block"><h3>{heading}</h3>
    <ul className="lab-check-list">{list.map(e => { const v = e.value ?? {}; return <li key={e.startLine}>
      <p><b>{typeof v.source === 'string' ? v.source : 'Outside source'}</b>{v.simulated === true && <span className="lab-tag">Simulated</span>}{instant(v.observed_at) && <span className="lab-record-who"> · {sgDate(v.observed_at)}, {sgClock(v.observed_at)}</span>}</p>
      {typeof v.summary === 'string' && <p>{v.summary}</p>}
      <CiteList items={[{ sourceId: 'evidence/external_context.json', startLine: e.startLine, endLine: e.endLine }]} openSource={openSource} /></li>; })}</ul>
  </div>;
}
function BestRoute({ packet, openSource }: { packet: Packet; openSource: Open }) {
  const source = sourceOf(packet, 'route_reference'), v = valueOf(packet, 'route_reference');
  const km = num(v?.distance_km), min = num(v?.duration_min);
  // A road route the Evidence Collector looked up during the run shows in its list instead (LookedUp).
  if (!source || km === null || v?.lookup === 'road_route') return null;
  return <div className="lab-record-block"><h3>Saved by the team</h3>
    <ul className="lab-check-list"><li><p>Best road route: {Math.round(km * 10) / 10} km{min !== null ? `, about ${plural(Math.round(min), 'minute')} without traffic` : ''}. From OpenStreetMap{instant(v?.fetched_at) ? `, saved ${sgDate(v.fetched_at)}` : ''}. A reference, not Ryde&apos;s record.</p><CiteChip c={whole(source)} openSource={openSource} /></li></ul>
  </div>;
}
// ---- Outside lookups (AD-13, owner, 11 October 2026): each record the Evidence Collector saved during the run, with where and when it
// asked, what the source returned and the source's credit. A run before evidence checks 4 has none.
const lookedUp = (packet: Packet) => (packet?.sources ?? []).filter(s => s.id.startsWith('evidence/outside_') || s.id === 'evidence/route_reference.json')
  .map(s => { try { const r = JSON.parse(s.text); return r && typeof r.lookup === 'string' ? { s, r } : null; } catch { return null; } })
  .filter((x): x is { s: Source; r: any } => !!x);
function LookedUp({ packet, runId, openSource }: { packet: Packet; runId?: string; openSource: Open }) {
  const records = lookedUp(packet);
  if (!records.length) return null;
  return <div className="lab-record-block"><h3>Looked up by the Evidence Collector</h3>
    <ul className="lab-check-list">{records.map(({ s, r }) => <li key={s.id}>
      <p><b>{outsideHeading(r.lookup)}</b><span className="lab-record-who"> · {String(r.provider ?? '')}</span>{r.status !== 'received' && <span className="lab-tag">{r.status === 'none_found' ? 'Nothing found' : 'Not available'}</span>}</p>
      <p className="lab-record-asked">{outsideAskedLine(r)}</p>
      {r.lookup === 'street_picture' && typeof r.answer?.imageId === 'string' && runId && <StreetPicture runId={runId} imageId={r.answer.imageId} />}
      {outsideSummary(r).map((line, i) => <p key={i}>{line}</p>)}
      <p className="lab-record-credit">{String(r.credit ?? '')}{r.lookup === 'street_picture' && typeof r.answer?.imageId === 'string' && /^\d{1,30}$/.test(r.answer.imageId) && <PictureCredit imageId={r.answer.imageId} />}</p>
      <CiteChip c={whole(s)} openSource={openSource} />
    </li>)}</ul>
  </div>;
}
// The attribution CC BY-SA asks for (owner, 13 October 2026): the picture's own page on Mapillary, which names who took
// it, and the licence. The site shows Mapillary's own file, saved once, unchanged.
const PictureCredit = ({ imageId }: { imageId: string }) => <> <a href={`https://www.mapillary.com/app/?pKey=${imageId}`} target="_blank" rel="noreferrer">The picture and who took it, on Mapillary</a>. <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noreferrer">Licence</a>.</>;
// Loaded like the case photos (photo-evidence.tsx): with the operator token when the lab has one, as a file, and afresh whenever the run
// or the picture changes; bytes that do not display read as not available.
const TOKEN_KEY = 'live-fishbowl-token';
function StreetPicture({ runId, imageId }: { runId: string; imageId: string }) {
  const [state, setState] = useState<{ src: string | null; failed: boolean }>({ src: null, failed: false }), [broken, setBroken] = useState('');
  useEffect(() => {
    let alive = true, url = '', token = '';
    try { token = sessionStorage.getItem(TOKEN_KEY) ?? ''; } catch { /* storage blocked: rely on the site session */ }
    setState({ src: null, failed: false });
    reach(`/api/live-fishbowl?run=${encodeURIComponent(runId)}&street=${encodeURIComponent(imageId)}`, { cache: 'no-store', headers: token ? { Authorization: 'Bearer ' + token } : {} })
      .then(r => isFileAnswer(r) ? r.blob() : Promise.reject(new Error('HTTP ' + r.status)))
      .then(blob => { if (!alive) return; url = URL.createObjectURL(blob); setState({ src: url, failed: false }); })
      .catch(() => { if (alive) setState({ src: null, failed: true }); });
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [runId, imageId]);
  if (state.failed || (state.src && broken === state.src)) return <p className="lab-record-asked">Picture not available now. Its description below was recorded during the run.</p>;
  if (!state.src) return <p className="lab-record-asked">Loading the picture…</p>;
  return <img className="lab-street-picture" src={state.src} alt="Street-level picture of the place, from Mapillary" onError={() => setBroken(state.src!)} />;
}
/**
 * `lookups`: the Evidence Collector looks outside data up itself, as in a run at evidence checks 4 and in the case before a run, which
 * the server sends as a new run starts with it (AD-11, owner, 11 October 2026). Nothing outside was given in advance then, so the tab
 * says what will be looked up instead of listing the outside notes and saved route the case lacks; what is left in the file is Ryde's own.
 */
// Semantic index (11 October 2026): one line per Voyage call the Policy Analyst and the Arbitrator made through the worker, from the
// run's semantic_searched events, so the outside-call trail is complete. The case text sent is code-written facts, never a name.
function SemanticCalls({ events }: { events?: Parameters<typeof semanticCallLines>[0] }) {
  const lines = semanticCallLines(events);
  if (!lines.length) return null;
  // The credit line is true only of a call that was made: a facts-only search with no attempt sent nothing.
  const called = lines.some(l => l.called);
  return <div className="lab-record-block"><h3>Past rulings searched by meaning</h3>
    <ul className="lab-check-list">{lines.map((l, i) => <li key={i}><p><b>{l.who}</b><span className="lab-record-who"> · {l.called ? 'Voyage AI, from the worker' : 'no call made'}</span></p><p>{l.text}</p></li>)}</ul>
    {called && <p className="lab-record-credit">For each call the worker sent a code-written summary of the case facts (no names, no statements) and the past rulings' text; the scores are comparison only.</p>}
  </div>;
}
export function ExternalRecord({ packet, runId, lookups = false, events, openSource }: { packet: Packet; runId?: string; lookups?: boolean; events?: Parameters<typeof semanticCallLines>[0]; openSource: Open }) {
  return <RecordCard title="External data">
    {!lookups ? <OnRecord packet={packet} items={recordItems.external} />
      : !lookedUp(packet).length && <p className="lab-check-note">Nothing outside is given to the agents in advance. During a run the Evidence Collector looks up what this dispute needs, from rainfall, place names, bus stops and taxi stands, street pictures and the best road route. Its answers show here.</p>}
    <LookedUp packet={packet} runId={runId} openSource={openSource} />
    <SemanticCalls events={events} />
    <OutsideNotes packet={packet} heading={lookups ? 'Ryde\'s own logs in the case file' : 'Outside notes in the case file'} openSource={openSource} />
    <BestRoute packet={packet} openSource={openSource} />
  </RecordCard>;
}
