'use client';
import type { ReactNode } from 'react';
import type { Cite } from '../fishbowl/live/workbench';
import type { CheckFact, EvidenceChecksView } from '../../../../packages/live-fishbowl/checks-view';
import type { OwnSide } from '../../../../packages/agent-flow/own-side';
import { sgClock, sgDate, sgDateTime, sgSeconds } from '../../../../packages/live-fishbowl/sg-time';
import { TILE, drawingWidth, latitudeAt, mapHolds, metresPerPixel, routeMapFrame, savedMap, tilePath, worldX, worldY, type RouteMap } from '../../../../packages/live-fishbowl/route-map';

// The MVP checks made visible (fix F10, 10 October 2026), each only when its data is there, so older runs look as before:
// quoted citations and the chat marks wherever an agent's submission shows (workbench.tsx, the Evidence column), the
// advocates' own-side lists (chat.tsx), and in the Evidence column the route drawing and route checks, the promo and fare
// checks, and the chat as the Evidence Collector read it. The checks are the server's arithmetic on the locked case file
// (checks-view.ts); the chat marks and points of disagreement are a model's reading, and say so. Words are the page's own.

type Open = (c: Cite) => void;
type Sourced = WithMap & { caseId?: string; sources: { id: string; text: string; lines: string[] }[] };
const file = (id: string) => id.split('/').at(-1);
const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
const int = (v: unknown) => Number.isInteger(v) && (v as number) > 0;
const isCite = (c: any): c is Cite => !!c && typeof c.sourceId === 'string' && int(c.startLine) && int(c.endLine);
const json = (packet: Sourced | undefined, block: string): any => { try { const s = packet?.sources.find(x => x.id === `evidence/${block}.json`); return s ? JSON.parse(s.text) : null; } catch { return null; } };
// Only a time with an explicit offset is shown: one without would be read in the viewer's own zone (consistency.ts strictInstant).
const instant = (iso: unknown): iso is string => typeof iso === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)$/.test(iso) && Number.isFinite(Date.parse(iso));
const clock = (iso: unknown) => instant(iso) ? sgClock(iso) : '';
// To the second where the seconds are not :00 (as record-checks.tsx), so a reading just before a whole minute never reads as that minute.
const seconds = (iso: unknown) => instant(iso) ? sgSeconds(iso).replace(/:00 SGT$/, ' SGT') : '';
const km = (v: number) => `${(Math.round(v * 10) / 10).toLocaleString('en-US')} km`;
const distance = (m: number) => m >= 1000 ? km(m / 1000) : `${Math.round(m).toLocaleString('en-US')} m`;
const minutes = (n: number) => { const r = Math.round(n); return `${r} minute${r === 1 ? '' : 's'}`; };
const money = (cents: number) => `S$${(cents / 100).toFixed(2)}`;
const capital = (s: string) => s ? s[0].toUpperCase() + s.slice(1) : s;

/** A citation chip, as everywhere on the page: the file and its lines, opening the original with the lines lit. */
export function CiteChip({ c, openSource }: { c: Cite; openSource: Open }) {
  return <button type="button" className="citation" onClick={() => openSource({ sourceId: c.sourceId, startLine: c.startLine, endLine: c.endLine })}>{file(c.sourceId)} · L{c.startLine}–{c.endLine}</button>;
}
/**
 * The lines a check rests on, grouped by file so a check citing five lines of three files stays short: the file's name,
 * then one chip for each range, each opening the original with those lines lit.
 */
export function CiteList({ items, openSource }: { items: Cite[]; openSource: Open }) {
  const files: { id: string; cites: Cite[] }[] = [];
  for (const c of items) { const f = files.find(x => x.id === c.sourceId); if (f) { if (!f.cites.some(x => x.startLine === c.startLine && x.endLine === c.endLine)) f.cites.push(c); } else files.push({ id: c.sourceId, cites: [c] }); }
  if (!files.length) return null;
  return <span className="lab-cite-list">{files.map(f => <span key={f.id} className="lab-cite-file"><span>{file(f.id)}</span>{f.cites.map((c, i) => { const at = c.startLine === c.endLine ? `L${c.startLine}` : `L${c.startLine}–${c.endLine}`; return <button key={i} type="button" className="citation" aria-label={`${file(f.id)} · ${at}`} onClick={() => openSource({ sourceId: c.sourceId, startLine: c.startLine, endLine: c.endLine })}>{at}</button>; })}</span>)}</span>;
}
/** A quoted citation: the words the agent quoted, in quotation marks, and the chip that opens the lines they come from. */
export function QuotedCite({ c, openSource, who }: { c: Cite & { quote: string }; openSource: Open; who?: ReactNode }) {
  return <blockquote className="lab-quote"><p>“{c.quote}”</p>{who && <span className="lab-quote-who">{who}</span>}<CiteChip c={c} openSource={openSource} /></blockquote>;
}
/** Citations as an agent submitted them: quoted ones with their words, the rest as chips. */
export function Citations({ items, openSource }: { items?: unknown; openSource: Open }) {
  const list = (Array.isArray(items) ? items : []).filter(isCite) as (Cite & { quote?: unknown })[];
  const quoted = list.filter(c => typeof c.quote === 'string' && c.quote.trim()), plain = list.filter(c => !quoted.includes(c));
  return <>{quoted.map((c, i) => <QuotedCite key={'q' + i} c={c as Cite & { quote: string }} openSource={openSource} />)}{plain.map((c, i) => <CiteChip key={'c' + i} c={c} openSource={openSource} />)}</>;
}

// The chat reading's words. Tone and act are a model's labelled reading (contracts.ts chatTones, chatActs).
export const toneWords: Record<string, string> = { calm: 'calm', polite: 'polite', frustrated: 'frustrated', angry: 'angry', abusive: 'abusive' };
export const actWords: Record<string, string> = { agreement: 'agrees', refusal: 'refuses', request: 'asks', proposal: 'proposes', threat: 'threatens', apology: 'apologises', complaint: 'complains', accusation: 'accuses', information: 'informs' };
export const senderName = (s: unknown) => s === 'rider' ? 'Rider' : s === 'driver' ? 'Driver' : s === 'system' ? 'Ryde' : capital(String(s ?? ''));
/** The tone mark and act label on one message the Evidence Collector read. */
export function ChatMarks({ tone, act }: { tone: unknown; act: unknown }) {
  const t = String(tone ?? ''), a = String(act ?? '');
  return <span className="lab-chat-marks"><span className="lab-sr">Read as </span><span className={'lab-tone tone-' + (t in toneWords ? t : 'other')}><i aria-hidden="true" />{toneWords[t] ?? t.replaceAll('_', ' ')}</span><span className={'lab-act act-' + (a in actWords ? a : 'other')}>{actWords[a] ?? a.replaceAll('_', ' ')}</span></span>;
}
type Disagreement = { topic: string; riderSays: string; driverSays: string; citations: unknown };
const disagreementsOf = (v: unknown): Disagreement[] => (Array.isArray(v) ? v : []).filter((d): d is Disagreement => !!d && typeof d.topic === 'string' && typeof d.riderSays === 'string' && typeof d.driverSays === 'string');
/** The points the rider and driver disagree on, as the Evidence Collector listed them: both sides, cited, not resolved. */
export function Disagreements({ items, openSource }: { items: unknown; openSource: Open }) {
  const list = disagreementsOf(items);
  if (!list.length) return null;
  // The quoted evidence stays folded until asked for (owner, 10 October 2026): the two sides read first, the lines on a click.
  return <ul className="lab-disagreements">{list.map((d, i) => { const n = Array.isArray(d.citations) ? d.citations.length : 0; return <li key={i}><b>{d.topic}</b><p><span>Rider says:</span> {d.riderSays}</p><p><span>Driver says:</span> {d.driverSays}</p>{n > 0 && <details className="lab-disagree-evidence"><summary>Show the evidence ({n === 1 ? '1 quote' : `${n} quotes`})</summary><Citations items={d.citations} openSource={openSource} /></details>}</li>; })}</ul>;
}
type Reading = { citation: Cite & { quote: string }; sender: string; tone: string; act: string };
const readingsOf = (v: unknown): Reading[] | null => Array.isArray(v) ? v.filter((r): r is Reading => !!r && isCite(r.citation) && typeof r.citation.quote === 'string') : null;
/** The chat reading inside the Evidence Collector's full response: each message it read, quoted, with its marks. */
export function ChatReadingView({ item, openSource }: { item: any; openSource: Open }) {
  const readings = readingsOf(item?.chatReadings), points = disagreementsOf(item?.disagreements);
  return <>
    {readings && readings.length > 0 && <section className="lab-chat-read"><h4>The chat, message by message</h4>{readings.map((r, i) => <QuotedCite key={i} c={r.citation} openSource={openSource} who={<><b>{senderName(r.sender)}</b> <ChatMarks tone={r.tone} act={r.act} /></>} />)}</section>}
    {points.length > 0 && <section><h4>Points they disagree on</h4><Disagreements items={points} openSource={openSource} /></section>}
  </>;
}

/** The chat's entries with their exact lines (the pinned two-space JSON form, as own-side.ts elementRanges reads it); [] otherwise. */
export function chatEntries(packet: Sourced | undefined) {
  const source = packet?.sources.find(s => s.id === 'evidence/chat_logs.json');
  let value: unknown; try { value = source ? JSON.parse(source.text) : null; } catch { return []; }
  if (!source || !Array.isArray(value) || source.text !== JSON.stringify(value, null, 2)) return [];
  let line = 2;
  return value.map((e: any) => { const span = JSON.stringify(e, null, 2).split('\n').length, entry = { startLine: line, endLine: line + span - 1, sender: String(e?.sender ?? ''), type: String(e?.type ?? 'message'), content: typeof e?.content === 'string' ? e.content : '', at: e?.timestamp }; line += span; return entry; });
}
/**
 * The Chat tab's card: every message and call in the chat log, and once a run has read them, the Evidence Collector's marks on
 * each one it read and the points the two sides disagree on (evidence tabs, 10 October 2026: before a run, the record alone).
 */
export function ChatReadingCard({ packet, reading, openSource }: { packet: Sourced | undefined; reading: any; openSource: Open }) {
  const readings = readingsOf(reading?.chatReadings);
  const entries = chatEntries(packet).map(e => ({ ...e, reading: readings?.find(r => r.citation.sourceId === 'evidence/chat_logs.json' && r.citation.startLine >= e.startLine && r.citation.endLine <= e.endLine) }));
  const points = readings ? disagreementsOf(reading?.disagreements) : [];
  if (!entries.length && !points.length) return null;
  return <section className="lab-check-card lab-chat-card" aria-label="Chat and calls">
    <h2>Chat and calls</h2>
    <p className="lab-check-note">{readings ? <>The tone of each message and what it does are the Evidence Collector&apos;s reading (AI), not a finding.</> : 'The chat and calls as recorded. Once a run reads them, each message shows its tone and what it does, marked as an AI reading.'}</p>
    {entries.length > 0 && <ol className="lab-chat-lines">{entries.map(e => <li key={e.startLine} className={'from-' + (['rider', 'driver'].includes(e.sender) ? e.sender : 'ryde') + (readings && !e.reading ? ' unread' : '')}>
      <div className="lab-chat-line-head"><b>{senderName(e.sender)}{e.type === 'call' ? ' · call' : ''}</b>{clock(e.at) && <time dateTime={e.at}>{clock(e.at)}</time>}<CiteChip c={{ sourceId: 'evidence/chat_logs.json', startLine: e.startLine, endLine: e.endLine }} openSource={openSource} /></div>
      <p>{e.content}</p>
      {e.reading && <ChatMarks tone={e.reading.tone} act={e.reading.act} />}
    </li>)}</ol>}
    {points.length > 0 && <><h3>Points they disagree on</h3><Disagreements items={points} openSource={openSource} /></>}
  </section>;
}

// ---- The advocates' own-side lists.
/** "The rider's statement (2026-09-15T19:10:00+08:00)" reads "Statement, 15 Sep 2026, 19:10 SGT". */
const itemLabel = (what: string) => capital(what.replace(/^The (rider|driver)'s /, '').replace(/ \((\d{4}-\d\d-\d\dT[^)]+)\)/, (m, iso: string) => instant(iso) ? `, ${sgDateTime(iso)}` : m));
/** What an advocate started from: its own party's items on the record, grouped, each opening its lines. */
export function OwnSideList({ side, openSource }: { side: OwnSide | undefined; openSource: Open }) {
  const items = Array.isArray(side?.items) ? side!.items.filter(i => isCite(i) && typeof i.what === 'string') : [];
  if (!side || !items.length) return null;
  const groups: { label: string; cites: Cite[] }[] = [];
  for (const i of items) { const label = itemLabel(i.what), g = groups.find(x => x.label === label); if (g) g.cites.push(i); else groups.push({ label, cites: [i] }); }
  const party = side.party === 'driver' ? 'driver' : 'rider';
  return <section className="lab-own-side" aria-label={`What the ${party} put on the record`}>
    <h4>What the {party} put on the record</h4>
    <ul>{groups.map(g => <li key={g.label}><span>{g.label}</span>{g.cites.map((c, i) => <CiteChip key={i} c={c} openSource={openSource} />)}</li>)}</ul>
    <p className="lab-check-note">The advocate began here, then checked it against Ryde&apos;s own records; it could read every document.</p>
  </section>;
}

// ---- The route card.
type Pt = { lat: number; lng: number };
const pt = (p: any): Pt | null => { const lat = num(Array.isArray(p) ? p[0] : p?.lat), lng = num(Array.isArray(p) ? p[1] : p?.lng); return lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null; };
const path = (points: unknown) => Array.isArray(points) ? points.map(pt).filter((p): p is Pt => !!p) : [];
/** The server's points and, for each one kept, whether it records no accuracy figure (owner, 13 October 2026: drawn, marked "accuracy not recorded"). */
const pathWithUnrated = (points: unknown, unrated: unknown) => {
  const marks = new Set(Array.isArray(unrated) ? unrated.filter(i => Number.isInteger(i)) : []), pts: Pt[] = [], flags: boolean[] = [];
  if (Array.isArray(points)) points.forEach((p, i) => { const q = pt(p); if (q) { pts.push(q); flags.push(marks.has(i)); } });
  return { pts, unrated: flags, count: flags.filter(Boolean).length };
};
const unratedNote = 'Readings with an accuracy figure of 20 m or better are drawn as the GPS standard uses them. Hollow dots are readings with no accuracy figure: drawn for display only, and no check uses them.';
const unratedDot = <svg viewBox="0 0 28 14" aria-hidden="true"><circle className="route-sample unrated" cx={14} cy={7} r={3.4} /></svg>;
const fact = (checks: EvidenceChecksView | null | undefined, id: string): CheckFact | undefined => (Array.isArray(checks?.facts) ? checks!.facts : []).find(f => f?.id === id);
const cites = (f?: CheckFact) => (Array.isArray(f?.citations) ? f!.citations : []).filter(isCite);

// The saved street map (route-map.ts), one per route case, comes with the case file: the server adds only the open case's
// entry (saved-route-map.ts), so the page never holds the whole register. The page draws only this site's own tiles.
type WithMap = { routeMap?: { map?: unknown; savedAt?: unknown } | null };
/** The saved street map that came with this case file, its shape checked; null for a case with none. */
export const savedRouteMap = (packet: WithMap | null | undefined): RouteMap | null => packet?.routeMap ? savedMap(packet.routeMap.map) : null;
const mapSavedOn = (packet: WithMap | null | undefined) => instant(packet?.routeMap?.savedAt) ? sgDate(packet!.routeMap!.savedAt as string) : null;

/**
 * The trip's route to scale: planned path, GPS trace during the trip, stops found, and the saved best road route. With a
 * saved street map that holds every point, the drawing shows the map's own area over its tiles (evidence tabs, user, 10
 * October 2026); otherwise the same framing on a plain background. Lines join the recorded points straight either way.
 */
// Map labels: each tries its usual side, then the other, then a line further out on each,
// and so on to the drawing's edges, and takes the first place clear of the labels already placed, so none sits on another.
// Boxes are estimated from 12 px type (checks.css .route-label): about 6.8 drawing units a character, 11 above the baseline and 3
// below. The first places are kept at the edge, as before; places further out are used only inside the drawing.
type MapLabel = { x: number; y: number; text: string };
const labelAnchor = (x: number, W: number) => x > W - 44 ? 'end' as const : x < 44 ? 'start' as const : 'middle' as const;
export function labelBox(l: MapLabel, W: number) {
  const w = l.text.length * 6.8 + 4, a = labelAnchor(l.x, W), x0 = a === 'end' ? l.x - w : a === 'start' ? l.x : l.x - w / 2;
  return { x0, x1: x0 + w, y0: l.y - 11, y1: l.y + 3 };
}
/** Labels in order of priority, each at a point (x, y) with its usual side; returns each with the baseline it is drawn at. */
export function placeLabels(items: (MapLabel & { below: boolean })[], W: number, H: number): MapLabel[] {
  const placed: ReturnType<typeof labelBox>[] = [], hits = (a: ReturnType<typeof labelBox>, b: ReturnType<typeof labelBox>) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  return items.map(({ below, ...l }) => {
    const first = below ? [Math.min(H - 4, l.y + 16), Math.max(11, l.y - 8)] : [Math.max(11, l.y - 8), Math.min(H - 4, l.y + 16)], tries = [...first];
    for (let k = 1; k * 15 < H; k++) for (const y of below ? [l.y + 16 + 15 * k, l.y - 8 - 15 * k] : [l.y - 8 - 15 * k, l.y + 16 + 15 * k]) if (y >= 11 && y <= H - 4) tries.push(y);
    const y = tries.find(y => !placed.some(b => hits(labelBox({ ...l, y }, W), b))) ?? tries[0];
    placed.push(labelBox({ ...l, y }, W));
    return { ...l, y };
  });
}

function RouteDrawing({ planned, trace, best, stops, map, pin = null, traceName = 'GPS trace during the trip', endLabels = ['Start', 'End'], traceUnrated = [], rider = [], riderUnrated = [] }: { planned: Pt[]; trace: Pt[]; best: Pt[]; stops: { at: Pt; label: string }[]; map: RouteMap | null; pin?: Pt | null; traceName?: string; endLabels?: [string, string]; traceUnrated?: boolean[]; rider?: Pt[]; riderUnrated?: boolean[] }) {
  const all = [...planned, ...trace, ...best, ...stops.map(s => s.at), ...rider, ...(pin ? [pin] : [])];
  if (all.length < 2) return null;
  const saved = map && mapHolds(map, all) ? map : null;
  // With no map the zoom only sets the units: the frame's proportions are the same at any zoom.
  const framed = saved ?? routeMapFrame(all, 16);
  if (!framed) return null;
  const { zoom, frame } = framed, fw = frame.x1 - frame.x0, fh = frame.y1 - frame.y0, W = drawingWidth, s = W / fw, H = Math.round(fh * s);
  const X = (p: Pt) => Math.round((worldX(p.lng, zoom) - frame.x0) * s * 10) / 10, Y = (p: Pt) => Math.round((worldY(p.lat, zoom) - frame.y0) * s * 10) / 10;
  const points = (ps: Pt[]) => ps.map(p => `${X(p)},${Y(p)}`).join(' ');
  // A scale bar of a round length, at most about a third of the width; drawing units per kilometre at the frame's middle.
  const perKm = s * 1000 / metresPerPixel(latitudeAt((frame.y0 + frame.y1) / 2, zoom), zoom);
  const bar = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50].filter(k => k * perKm <= W * 0.34).at(-1) ?? 0.1;
  const ends = planned.length >= 2 ? planned : trace.length >= 2 ? trace : best;
  // With a pin, the pin's label and the last point's go on opposite sides, so they never sit on each other when the two are close.
  const end = ends.at(-1), pinBelow = !!pin && !!end && Y(pin) > Y(end), endBelow = pin && end ? !pinBelow : ends.length >= 2 && Y(ends.at(-1)!) < Y(ends[0]);
  // The pin's label first, then the last point's, then the first point's: the first gives way when the ends are close.
  const labels = placeLabels([
    ...(pin && ends.length >= 2 ? [{ x: X(pin), y: Y(pin), text: 'Pickup pin', below: pinBelow }] : pin ? [{ x: X(pin), y: Y(pin), text: 'Pickup pin', below: false }] : []),
    ...(ends.length >= 2 ? [{ x: X(ends.at(-1)!), y: Y(ends.at(-1)!), text: endLabels[1], below: !!endBelow }, { x: X(ends[0]), y: Y(ends[0]), text: endLabels[0], below: false }] : []),
  ], W, H);
  const named = [planned.length >= 2 && 'the planned route', trace.length >= 2 && `the ${traceName}`, rider.length > 0 && `the rider's app location (${rider.length} reading${rider.length === 1 ? '' : 's'})`, pin && 'the pickup pin', stops.length > 0 && `${stops.length === 1 ? 'one stop' : stops.length + ' stops'} found`, best.length >= 2 && 'the best road route'].filter(Boolean).join(', ');
  const tiles: { key: string; src: string; left: number; top: number; width: number; height: number }[] = [];
  if (saved) for (let x = saved.tiles.x0; x <= saved.tiles.x1; x++) for (let y = saved.tiles.y0; y <= saved.tiles.y1; y++)
    tiles.push({ key: `${x}/${y}`, src: tilePath(zoom, x, y), left: (x * TILE - frame.x0) / fw * 100, top: (y * TILE - frame.y0) / fh * 100, width: TILE / fw * 100, height: TILE / fh * 100 });
  return <div className={'lab-route-frame' + (saved ? ' with-map' : '')} style={{ aspectRatio: `${W} / ${H}` }}>
    {/* Half a pixel more each way, so no seam shows between tiles at a fractional size. */}
    {saved && <div className="route-tiles" aria-hidden="true">{tiles.map(t => <img key={t.key} src={t.src} alt="" decoding="async" draggable={false} style={{ left: `${t.left}%`, top: `${t.top}%`, width: `calc(${t.width}% + 0.5px)`, height: `calc(${t.height}% + 0.5px)` }} />)}</div>}
    <svg className="lab-route-map" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Drawing to scale of ${named}${saved ? ', on a street map' : ''}. The scale bar is ${bar} km.`}>
      {best.length >= 2 && <polyline className="route-best" points={points(best)}><title>Best road route (OpenStreetMap reference, not Ryde&apos;s record)</title></polyline>}
      {planned.length >= 2 && <polyline className="route-planned" points={points(planned)}><title>Planned route</title></polyline>}
      {trace.length >= 2 && <polyline className="route-trace" points={points(trace)}><title>{traceName}</title></polyline>}
      {trace.map((p, i) => traceUnrated[i] ? null : <circle key={i} className="route-sample" cx={X(p)} cy={Y(p)} r={2.6} />)}
      {stops.map((st, i) => <circle key={'s' + i} className="route-stop" cx={X(st.at)} cy={Y(st.at)} r={6}><title>{st.label}</title></circle>)}
      {ends.length >= 2 && <><circle className="route-end" cx={X(ends[0])} cy={Y(ends[0])} r={4} /><circle className="route-end" cx={X(ends.at(-1)!)} cy={Y(ends.at(-1)!)} r={4} />
      </>}
      {pin && <circle className="route-pin" cx={X(pin)} cy={Y(pin)} r={6}><title>Pickup pin</title></circle>}
      {/* The rider's app readings (14 October 2026): dots in the rider's colour, drawn after the pin so a rider at the pin stays visible. */}
      {rider.map((p, i) => riderUnrated[i] ? null : <circle key={'r' + i} className="route-sample rider" cx={X(p)} cy={Y(p)} r={3.2}><title>Rider&apos;s app location</title></circle>)}
      {/* Readings with no accuracy figure: rings drawn last, so an end marker or the pickup pin never hides one. */}
      {trace.map((p, i) => traceUnrated[i] ? <circle key={'u' + i} className="route-sample unrated" cx={X(p)} cy={Y(p)} r={3.4}><title>Accuracy not recorded</title></circle> : null)}
      {rider.map((p, i) => riderUnrated[i] ? <circle key={'ru' + i} className="route-sample unrated rider" cx={X(p)} cy={Y(p)} r={3.4}><title>Rider&apos;s app location, accuracy not recorded</title></circle> : null)}
      {labels.map(l => <text key={l.text} className="route-label" x={l.x} y={l.y} textAnchor={labelAnchor(l.x, W)}>{l.text}</text>)}
      <g className="route-scale"><line x1={10} y1={H - 10} x2={10 + bar * perKm} y2={H - 10} /><line x1={10} y1={H - 14} x2={10} y2={H - 6} /><line x1={10 + bar * perKm} y1={H - 14} x2={10 + bar * perKm} y2={H - 6} /><text x={10} y={H - 18}>{bar} km</text></g>
    </svg>
  </div>;
}
const legendLine = (kind: string) => <svg viewBox="0 0 28 10" aria-hidden="true"><line className={'route-' + kind} x1={2} y1={5} x2={26} y2={5} /></svg>;
/** Under a drawing: the street map's credit when it is shown, or why it is not. */
function MapCredit({ map, onMap, savedOn }: { map: RouteMap | null; onMap: boolean; savedOn: string | null }) {
  return <p className="lab-check-note lab-map-credit">{onMap ? <>Street map <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>{savedOn ? `, saved by the team on ${savedOn}` : ''}.</> : map ? 'The street map saved for this case does not cover these points, so none is shown.' : 'No street map is saved for this case.'}</p>;
}

/**
 * AD-9 (owner decision, 10 October 2026): a trip that never started (a no-show or a cancellation) has no route to draw, so this
 * shows where the car was from the match to the cancellation, beside the pickup pin. The points are the server's (checks-view.ts,
 * route-checks.ts waitSamples), never re-read here. Display only: no check reads this window.
 */
export function WaitMapCard({ packet, checks }: { packet: Sourced | undefined; checks: EvidenceChecksView | null | undefined; openSource: Open }) {
  const wait = checks?.wait;
  if (!wait) return null;
  const { pts: points, unrated, count } = pathWithUnrated(wait.points, wait.unrated), pin = wait.pin && Number.isFinite(wait.pin[0]) && Number.isFinite(wait.pin[1]) ? { lat: wait.pin[0], lng: wait.pin[1] } : null;
  if (points.length < 2) return null;
  // The rider's app readings in the same window (14 October 2026), when the record carries a rider location block.
  const riderDrawn = wait.rider ? pathWithUnrated(wait.rider.points, wait.rider.unrated) : null, riderPts = riderDrawn?.pts ?? [];
  const map = savedRouteMap(packet), drawn = [...points, ...riderPts, ...(pin ? [pin] : [])], onMap = !!map && mapHolds(map, drawn);
  const arrival = wait.arrival && num(wait.arrival.metres) !== null && instant(wait.arrival.at) && instant(wait.arrival.declared) ? wait.arrival : null;
  // A record with no match or booking time (an organiser sample) starts at its first GPS reading, and says so.
  const from = wait.fromEvent === 'booking' ? 'booking' : wait.fromEvent === 'first_reading' ? 'first reading' : 'match';
  return <section className="lab-check-card lab-route-card" aria-label="Where the car waited">
    <h2>{riderPts.length ? 'Where the car and the rider\'s phone waited' : 'Where the car waited'}</h2>
    {/* The ends are the first and last readings drawn, which need not be at the match or the cancellation. */}
    <RouteDrawing planned={[]} trace={points} best={[]} stops={[]} map={map} pin={pin} traceName={`GPS from the ${from} to the cancellation`} endLabels={['First reading', 'Last reading']} traceUnrated={unrated} rider={riderPts} riderUnrated={riderDrawn?.unrated ?? []} />
    <ul className="lab-route-legend">
      <li>{legendLine('trace')}GPS from the {from} ({clock(wait.from)}) to the cancellation ({clock(wait.to)}){wait.fromEvent === 'first_reading' ? ': the record gives no match or booking time' : ''}</li>
      {count > 0 && <li>{unratedDot}Accuracy not recorded ({count === points.length ? `all ${count} readings` : `${count} of ${points.length} readings`})</li>}
      {riderPts.length > 0 && <li><svg viewBox="0 0 28 14" aria-hidden="true"><circle className="route-sample rider" cx={14} cy={7} r={3.2} /></svg>Rider&apos;s app location in the same window ({riderPts.length} reading{riderPts.length === 1 ? '' : 's'})</li>}
      {wait.rider?.sharing === 'shared' && riderPts.length === 0 && <li>Rider&apos;s app shared its location, but none of its readings is drawn: none in this window with an accuracy of 20 m or better</li>}
      {wait.rider?.sharing === 'not_shared' && <li>Rider&apos;s app shared no location: not itself absence</li>}
      {pin && <li><svg viewBox="0 0 28 14" aria-hidden="true"><circle className="route-pin" cx={14} cy={7} r={5} /></svg>Pickup pin</li>}
    </ul>
    <MapCredit map={map} onMap={onMap} savedOn={mapSavedOn(packet)} />
    {arrival && <p className="lab-check-note">{Date.parse(arrival.at) === Date.parse(arrival.declared)
      ? <>At the declared arrival ({seconds(arrival.declared)}), the car was {distance(arrival.metres)} from the pickup pin.</>
      : <>No usable reading at the declared arrival ({seconds(arrival.declared)}). The last usable one before it, at {seconds(arrival.at)}, put the car {distance(arrival.metres)} from the pickup pin.</>}{arrival.rated === false ? ' That reading records no accuracy figure.' : ''}</p>}
    <p className="lab-check-note lab-route-method">Worked out by plain code from the GPS points in the case file, not by an AI. {count > 0 || (riderDrawn?.count ?? 0) > 0 ? unratedNote : 'Only the readings accurate to 20 m are drawn, as the GPS standard uses them.'}</p>
  </section>;
}

/** The route card: the drawing and the route checks in plain words, each with the lines it rests on. */
export function RouteCard({ packet, checks, openSource }: { packet: Sourced | undefined; checks: EvidenceChecksView | null | undefined; openSource: Open }) {
  const lengths = fact(checks, 'route_path_length_km'), offset = fact(checks, 'route_offset_from_planned_path_m'), stopsFact = fact(checks, 'route_stops_in_gps_trace'), eta = fact(checks, 'trip_end_vs_first_destination_eta_min'), bestFact = fact(checks, 'best_road_route_km');
  if (!lengths && !offset && !stopsFact && !eta && !bestFact) return null;
  const route = json(packet, 'route_data'), reference = json(packet, 'route_reference');
  const planned = path(route?.planned_route?.points);
  // The GPS trace is the server's: the samples the route checks used (route-checks.ts tripSamples), plus readings with no accuracy
  // figure, marked unrated (route-checks.ts tripDisplaySamples), never re-read here.
  const window = checks?.trace?.window === true, drawnTrace = window ? pathWithUnrated(checks?.trace?.points, checks?.trace?.unrated) : { pts: [] as Pt[], unrated: [] as boolean[], count: 0 }, trace = drawnTrace.pts;
  const best = bestFact?.value ? path(reference?.points) : [];
  const stopValue = stopsFact?.value as { check?: string; found?: { from: string; minutes: number; lat: number; lng: number }[] | null; typed_stops?: number | null; max_gap_s?: number | null } | null | undefined;
  const found = Array.isArray(stopValue?.found) ? stopValue!.found.filter(f => pt(f) && num(f.minutes) !== null) : [];
  const stops = found.map(f => ({ at: pt(f)!, label: `Stopped ${minutes(f.minutes)} from ${clock(f.from)}` }));
  const map = savedRouteMap(packet), drawn = [...planned, ...trace, ...best, ...stops.map(st => st.at)], onMap = !!map && drawn.length >= 2 && mapHolds(map, drawn);

  const rows: { key: string; text: ReactNode; cites: Cite[] }[] = [];
  const lv = lengths?.value as Record<'planned' | 'actual', { path_km: number | null; typed_km: number | null; points: number; check: string }> | null | undefined;
  if (lv) {
    const one = (name: string, l?: { path_km: number | null; typed_km: number | null; points: number; check: string }) => !l ? null
      : l.path_km === null ? `${name}: its points cannot be read reliably enough to measure.` : l.typed_km === null ? `${name}: its ${l.points} points joined up make ${km(l.path_km)}; the record types no distance.`
      : `${name}: its ${l.points} points joined up make ${km(l.path_km)}; the record says ${km(l.typed_km)}${l.check === 'agrees' ? ', which agrees' : ''}.`;
    const short = [lv.planned, lv.actual].some(l => l?.check === 'differs' && l.path_km !== null && l.typed_km !== null && l.path_km < l.typed_km);
    rows.push({ key: 'length', text: <>{one('Planned route', lv.planned)} {one('Actual route', lv.actual)}{short ? ' Straight lines between a few points cut the corners, so they come out shorter than the roads.' : ''}</>, cites: cites(lengths) });
  }
  if (offset) {
    const v = offset.value as { furthest_gps_sample_m: number | null; furthest_gps_sample_at: string | null; furthest_actual_route_point_m: number | null; sampled_minutes_over_300m: number | null } | null;
    const far = v ? v.furthest_gps_sample_m ?? v.furthest_actual_route_point_m : null;
    rows.push({ key: 'offset', text: !v ? 'How far the car went from the planned route is unknown: the planned route has too few points.'
      : far === null ? 'No GPS point during the trip to compare with the planned route.'
      : <>Furthest from the planned route: {distance(far)}{v.furthest_gps_sample_m !== null && v.furthest_gps_sample_at ? `, at ${clock(v.furthest_gps_sample_at)}` : ''}. {num(v.sampled_minutes_over_300m) ? `The GPS points were more than 300 m off it for about ${minutes(v.sampled_minutes_over_300m!)}.` : 'No two GPS points in a row were more than 300 m off it.'}</>, cites: cites(offset) });
  }
  if (stopValue) {
    const typed = num(stopValue.typed_stops), listed = typed === null ? '' : ` The record lists ${typed === 0 ? 'no stop' : typed === 1 ? '1 stop' : typed + ' stops'}.`;
    const gap = num(stopValue.max_gap_s);
    const text = stopValue.check === 'too_sparse' ? `Stops: too sparse to tell. The GPS points are too few or too far apart${gap !== null && gap > 60 ? ` (up to ${minutes(gap / 60)})` : ''} to show whether the car stopped.${listed}`
      : stopValue.check === 'unknown' && !Array.isArray(stopValue.found) ? 'Stops: unknown, because the trip start or end time is missing.'
      : `${found.length ? `Stops found in the GPS: ${found.map(f => `${minutes(f.minutes)} from ${clock(f.from)}`).join('; ')}.` : 'No stop found in the GPS.'}${listed}${stopValue.check === 'agrees' ? ' They match.' : stopValue.check === 'disagrees' ? ' They do not match.' : ''}`;
    rows.push({ key: 'stops', text, cites: cites(stopsFact) });
  }
  if (eta) {
    const v = eta.value as { first_eta_arrival_at: string; trip_end_at: string; minutes_after_eta: number; late: boolean } | null;
    rows.push({ key: 'eta', text: !v ? 'Arrival: unknown, because no arrival time shown to the rider, or no trip end, is recorded.'
      : `Arrived ${v.minutes_after_eta === 0 ? 'right at' : `${minutes(Math.abs(v.minutes_after_eta))} ${v.minutes_after_eta < 0 ? 'before' : 'after'}`} the first arrival time the app showed the rider (${clock(v.first_eta_arrival_at)}). ${v.late ? 'That counts as late (more than 10 minutes after it).' : 'That is not late (late is more than 10 minutes after it).'}`, cites: cites(eta) });
  }
  if (bestFact) {
    const v = bestFact.value as { best_road_km: number; best_road_min: number | null; actual_typed_minus_best_km: number | null; planned_typed_minus_best_km: number | null; actual_ends_match_reference?: boolean | null } | null;
    const diff = v ? v.actual_typed_minus_best_km : null;
    // Only the check's own reason for a missing comparison is given: the trip ended elsewhere, the actual route has too few
    // points, or the record types no actual distance. Anything else stays neutral.
    const missing = !v || diff !== null ? '' : v.actual_ends_match_reference === false ? 'The recorded trip did not start and end where this route does, so they are not compared.'
      : v.actual_ends_match_reference === null ? 'The recorded actual route cannot be read reliably enough to compare with it.'
      : v.actual_ends_match_reference === true ? 'The record gives no actual distance to compare with it.' : 'The actual distance in the record is not compared with it.';
    rows.push({ key: 'best', text: !v ? 'No best road route is saved for this case.'
      : <>Best road route: {km(v.best_road_km)}{num(v.best_road_min) !== null ? `, about ${minutes(v.best_road_min!)} without traffic` : ''}. This is a reference the team saved from OpenStreetMap, not Ryde&apos;s record. {diff === null ? missing : Math.abs(diff) < 0.05 ? 'The actual distance in the record is the same.' : `The actual distance in the record is ${km(Math.abs(diff))} ${diff > 0 ? 'longer' : 'shorter'}.`}</>, cites: cites(bestFact) });
  }
  // The drawing first, then its key and what the checks found (user, 10 October 2026: image first, explanation below).
  return <section className="lab-check-card lab-route-card" aria-label="Route">
    <h2>Route</h2>
    <RouteDrawing planned={planned} trace={trace} best={best} stops={stops} map={map} traceUnrated={drawnTrace.unrated} />
    <ul className="lab-route-legend">
      {planned.length >= 2 && <li>{legendLine('planned')}Planned route</li>}
      {trace.length >= 2 && <li>{legendLine('trace')}GPS trace during the trip</li>}
      {trace.length >= 2 && drawnTrace.count > 0 && <li>{unratedDot}Accuracy not recorded ({drawnTrace.count === trace.length ? `all ${drawnTrace.count} readings` : `${drawnTrace.count} of ${trace.length} readings`})</li>}
      {stops.length > 0 && <li><svg viewBox="0 0 28 14" aria-hidden="true"><circle className="route-stop" cx={14} cy={7} r={5} /></svg>Stop found</li>}
      {best.length >= 2 && <li>{legendLine('best')}Best road route (OpenStreetMap reference, not Ryde&apos;s record)</li>}
    </ul>
    {drawn.length >= 2 && <MapCredit map={map} onMap={onMap} savedOn={mapSavedOn(packet)} />}
    {trace.length < 2 && <p className="lab-check-note">No GPS trace is drawn: {window ? 'fewer than two usable GPS points fall within the trip' : 'the trip\'s start or end time is missing or unreadable, so which GPS points belong to the trip is unknown'}.</p>}
    <p className="lab-check-note lab-route-method">Worked out by plain code from the GPS points in the case file, not by an AI. Arithmetic on the record, not a finding.{trace.length >= 2 && drawnTrace.count > 0 ? ' ' + unratedNote : ''}</p>
    <ul className="lab-check-list">{rows.map(r => <li key={r.key}><p>{r.text}</p><CiteList items={r.cites} openSource={openSource} /></li>)}</ul>
  </section>;
}

// ---- The promo and fare checks.
const questions: Record<string, string> = {
  promo_booked_within_campaign_dates: 'Booked within the promo\'s dates', promo_booked_within_campaign_hours: 'Booked within the promo\'s hours', promo_booked_on_campaign_day: 'Booked on a promo day',
  promo_service_eligible: 'The ride type is covered by the promo', promo_trip_fare_meets_minimum: 'The trip fare meets the promo\'s minimum', promo_daily_limit_reached: 'The promo\'s daily limit was already used up',
  promo_campaign_limit_reached: 'The promo\'s total limit was already used up', promo_codes_stacked: 'More than one promo is on this trip', fare_parts_match_quote: 'The fare\'s parts add up to the quote',
  fare_surge_matches_booked_quote: 'The surge on the fare matches the quote booked', surge_accepted_before_booking: 'The rider accepted the surge before booking',
};
const answer = (v: unknown) => v === true ? 'Yes' : v === false ? 'No' : 'Unknown';
const partName = (l: { part: string; code: string; label: string }) => l.part === 'trip' ? 'Trip fare' : l.part === 'promo' ? 'Promo discount' : l.part === 'fee' ? (l.code.toUpperCase() === 'BOOKING_FEE' ? 'Booking fee' : 'Platform fee') : l.label;
/** The promo and fare checks: the quote rebuilt from its parts, naming any line outside them, and a table of yes, no or unknown. */
export function FareCard({ checks, openSource }: { checks: EvidenceChecksView | null | undefined; openSource: Open }) {
  const rows = Object.keys(questions).map(id => fact(checks, id)).filter((f): f is CheckFact => !!f);
  if (!rows.length) return null;
  const fare = checks?.fare && Array.isArray(checks.fare.lines) ? checks.fare : null, rebuild = fact(checks, 'fare_parts_match_quote');
  const lines = (fare?.lines ?? []).filter(l => typeof l?.code === 'string' && num(l.cents) !== null), parts = lines.filter(l => l.part !== 'other'), others = lines.filter(l => l.part === 'other');
  const sum = parts.reduce((a, l) => a + l.cents, 0), quoted = num(fare?.quotedCents), charged = num(fare?.chargedCents);
  const lineCite = (l: { line: number | null }): Cite | null => l.line ? { sourceId: 'evidence/fare_breakdown.json', startLine: l.line, endLine: l.line } : null;
  return <section className="lab-check-card lab-fare-card" aria-label="Fare checks">
    <h2>Fare checks</h2>
    <p className="lab-check-note">Worked out by plain code from the fare and promo records, not by an AI. Each answer is what the record shows; the Arbitrator decides what it means.</p>
    {rebuild && fare && quoted !== null && parts.length > 0 && <div className="lab-fare-rebuild">
      <h3>The quote, rebuilt from its parts</h3>
      <dl className="lab-fare-parts">{parts.map((l, i) => <div key={i}><dt>{partName(l)}</dt><dd>{money(l.cents)}</dd></div>)}<div className="lab-fare-sum"><dt>Adds up to</dt><dd>{money(sum)}</dd></div><div><dt>The quote</dt><dd>{money(quoted)}</dd></div></dl>
      <p>{rebuild.value === true ? 'The parts add up to the quote.' : rebuild.value === false ? `The parts are ${money(Math.abs(sum - quoted))} ${sum > quoted ? 'above' : 'below'} the quote.` : 'The quote could not be rebuilt from the fare\'s lines.'}</p>
      {others.length > 0 ? <div className="lab-fare-extra"><p><b>Not in the quote:</b></p><ul>{others.map((l, i) => { const c = lineCite(l); return <li key={i}><span>{l.label} <b>{money(l.cents)}</b></span>{c && <CiteChip c={c} openSource={openSource} />}</li>; })}</ul>{charged !== null && <p>Charged in all: {money(charged)}.</p>}</div>
        : <p>Every line on the fare is part of the quote.</p>}
    </div>}
    <table className="lab-check-table"><thead><tr><th scope="col">Check</th><th scope="col">Answer</th></tr></thead>
      <tbody>{rows.map(f => <tr key={f.id}><td><span>{questions[f.id]}</span><CiteList items={cites(f)} openSource={openSource} /></td><td><span className={'lab-answer answer-' + answer(f.value).toLowerCase()}>{answer(f.value)}</span></td></tr>)}</tbody>
    </table>
  </section>;
}
