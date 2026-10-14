'use client';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { buildFeed, feedId, newestFirst, stepTargets, type FeedBubble } from '../../../../packages/live-fishbowl/feed';
import { Avatar } from '../fishbowl/live/strip';
import { ArtifactView, type Cite } from '../fishbowl/live/workbench';
import type { Event } from './use-lab';
import { routingLabel } from '../../../../packages/agent-flow/routing';
import { panelSplitText } from '../../../../packages/agent-flow/panel';
import { ConfidenceNotUsed, ConfidenceScoreView, SeatOutputs, withoutConfidence } from './panel-seats';
import { confidenceFor, panelWithScores } from '../../../../packages/agent-flow/confidence';
import { actorNames, phaseName } from '../../../../packages/live-fishbowl/plain';
import { outcomeLabels, paymentWords, remedyText, type GateTone } from '../../../../packages/live-fishbowl/gates';
import PrecedentsConsidered from './precedents-considered';
import { sgClock, sgDate, sgSeconds } from '../../../../packages/live-fishbowl/sg-time';
import type { EvidenceChecksView } from '../../../../packages/live-fishbowl/checks-view';
import { OwnSideList } from './evidence-checks';
import { LookupTrail } from './record-checks';

const names = actorNames;
// Singapore times (sg-time.ts). Bubble headers show hours and minutes; the date and seconds are in the tooltip, and the
// seconds in the full response.
const clock = sgSeconds, shortClock = sgClock;

/** A click on a timeline line in the Status column: which line, and a counter so the same line can be clicked again. */
export type ChatJump = { key: string; label: string; n: number };
const reducedMotion = () => { const m = document.documentElement.dataset.motion; return m === 'reduce' || (m !== 'full' && matchMedia('(prefers-reduced-motion: reduce)').matches); };
// The conversation scrolls in its own column on a laptop, and with the page on a phone or tablet (lab.css), where the
// pane tabs stay at the top of the screen.
const scroller = (el: HTMLElement) => { const body = el.closest<HTMLElement>('.lab-pane-body'); return body && getComputedStyle(body).overflowY !== 'visible' ? body : null; };
const stickyTop = () => { const tabs = document.querySelector<HTMLElement>('.lab-tabs'); return tabs?.offsetParent ? tabs.offsetHeight : 0; };
// The newest message is in view: the column is at its top, or on a phone the conversation starts below the tabs.
const atTop = (el: HTMLElement) => { const column = scroller(el); return column ? column.scrollTop <= 8 : el.getBoundingClientRect().top >= stickyTop() - 8; };
// Whether the browser keeps a reader's place itself when content arrives above it (CSS scroll anchoring).
const anchors = () => typeof CSS !== 'undefined' && CSS.supports('overflow-anchor', 'auto');

// The middle column: one summary bubble per agent output, newest first like an inbox (4 October, user request). The
// smaller steps between them (reads, hand-offs, checks) are only in the downloadable audit log (user, 7 October: the
// "Show steps" toggle went), so the column reads as the agents' exchange. A bubble's header gives the agent, the step
// and the time, no event number (user, 7 October). "Show full response" opens the whole output in a dialog over the
// page; bubbles never expand in place. A click on a timeline line brings its messages into view and marks them for a
// moment (feed.ts stepTargets); the gates' lines open their own dialogs instead (lab.tsx), since their messages are
// steps. The Judge's decision takes the release check's colour, like the recommendation card (4 October, user request).
export default function Chat({ events, actor, running, hasRun, loading = false, notice, openSource, jump, packet, tone, checks, viewOnly = false }: { events: Event[]; actor: string; running: boolean; hasRun: boolean; loading?: boolean; notice?: string | null; viewOnly?: boolean; openSource: (c: Cite) => void; jump?: ChatJump | null; packet?: Packet; tone?: GateTone; checks?: EvidenceChecksView | null }) {
  const feed = useMemo(() => buildFeed(events, actor), [events, actor]);
  // Every argument shared so far, by its key (rider_investigate, driver_challenge and so on): what a gap point is against.
  const disclosed = useMemo(() => Object.assign({}, ...events.filter(e => e.kind === 'disclosed' && e.data && typeof e.data === 'object').map(e => e.data)) as Record<string, any>, [events]);
  const [full, setFull] = useState<FeedBubble | null>(null);
  const [marked, setMarked] = useState<{ ids: Set<string>; n: number } | null>(null), [jumpNote, setJumpNote] = useState('');
  const list = useRef<HTMLDivElement>(null), opener = useRef<HTMLElement | null>(null), feedRef = useRef(feed);
  feedRef.current = feed;
  // Newest first, so a live run's new messages arrive above everything else. A reader at the top sees them arrive. A
  // reader further down keeps their place and a button says how many messages arrived (4 October UI audit: the column
  // used to jump to the top on every event, and on a phone it pulled the whole page up). The browser's scroll anchoring
  // keeps that place where it can; elsewhere the column (or the page, on a phone) moves by what arrived above.
  const [fresh, setFresh] = useState(0), seen = useRef({ events: 0, bubbles: 0, height: 0 }), wasTop = useRef(true);
  const bubbleCount = useMemo(() => feed.filter(item => item.type === 'bubble').length, [feed]);
  // Where the reader is, kept as they scroll: by the time a new message is drawn, anchoring may have moved the column.
  useEffect(() => {
    const update = () => { const el = list.current; if (!el) return; wasTop.current = atTop(el); if (wasTop.current) setFresh(0); };
    document.addEventListener('scroll', update, { capture: true, passive: true });
    return () => document.removeEventListener('scroll', update, { capture: true });
  }, []);
  useLayoutEffect(() => {
    const el = list.current, before = { ...seen.current };
    seen.current.events = events.length; seen.current.bubbles = bubbleCount;
    if (!el || events.length <= before.events || !before.height) return;
    if (!el.offsetParent) { setFresh(0); return; }
    const column = scroller(el), under = el.getBoundingClientRect().top - stickyTop();
    // A tab switch on a phone moves the conversation without a scroll, so where it is now counts too.
    if (wasTop.current || atTop(el)) { if (column) column.scrollTop = 0; else if (under < 0) scrollBy(0, under); return; }
    const delta = el.offsetHeight - before.height;
    if (!anchors() && delta > 0) { if (column) column.scrollTop += delta; else scrollBy(0, delta); }
    if (bubbleCount > before.bubbles) setFresh(n => n + bubbleCount - before.bubbles);
  }, [events.length, bubbleCount]);
  // The height after every render, so the next live message measures only itself.
  useLayoutEffect(() => { seen.current.height = list.current?.offsetHeight ?? 0; });
  const toNewest = useCallback(() => { const el = list.current; if (el) { const column = scroller(el); if (column) column.scrollTop = 0; else scrollTo(0, scrollY + el.getBoundingClientRect().top - stickyTop()); } setFresh(0); }, []);
  useEffect(() => {
    if (!jump) return;
    // Only the bubbles show, so a line whose messages are all steps has nothing to point at.
    const bubbles = new Set(feedRef.current.flatMap(item => item.type === 'bubble' ? [feedId(item)] : []));
    const ids = stepTargets(feedRef.current, jump.key).ids.filter(id => bubbles.has(id));
    if (!ids.length) { setMarked(null); setJumpNote(`Nothing in the conversation for ${jump.label} yet.`); return; }
    setJumpNote('');
    setMarked({ ids: new Set(ids), n: jump.n });
  }, [jump]);
  // After the marked messages render, bring the first one on the page into view.
  useEffect(() => {
    if (!marked) return;
    const first = [...(list.current?.querySelectorAll<HTMLElement>('[data-feed-id]') ?? [])].find(el => marked.ids.has(el.dataset.feedId!));
    first?.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
    const clear = setTimeout(() => setMarked(m => m?.n === marked.n ? null : m), 2600);
    return () => clearTimeout(clear);
  }, [marked]);
  useEffect(() => { if (!jumpNote) return; const t = setTimeout(() => setJumpNote(''), 4000); return () => clearTimeout(t); }, [jumpNote]);
  const showFull = useCallback((item: FeedBubble, from: HTMLElement) => { opener.current = from; setFull(item); }, []);
  const closeFull = useCallback(() => setFull(null), []);
  // A citation in the dialog closes it and opens the original in the tray.
  const cite = useCallback((c: Cite) => { setFull(null); openSource(c); }, [openSource]);
  // A run that will not get an agent's answer soon (no server, safety stop, failed, not found) says why instead of waiting (run-notice.ts).
  if (notice && !feed.some(item => item.type === 'bubble')) return <div className="lab-empty" role="status">{notice}</div>;
  if (loading) return <div className="lab-empty" role="status">Loading the run…</div>;
  // The public copy cannot start a run (owner, 11 October 2026): it says only that this case has none yet.
  if (!hasRun) return <div className="lab-empty">{viewOnly ? 'No run yet for this case. Pick another case from the list to watch one.' : 'No run yet. Add documents on the left, then start a run from the status column.'}</div>;
  const shown = newestFirst(feed.filter(item => item.type === 'bubble'));
  if (!shown.length) return <div className="lab-empty">{running ? 'Waiting for the first agent to answer…' : actor === 'all' ? 'No agent output yet.' : 'No output from this agent yet.'}</div>;
  const isMarked = (id: string) => !!marked?.ids.has(id);
  return <div className="lab-chat" ref={list}>
    {fresh > 0 && <div className="lab-fresh"><button type="button" onClick={toNewest}>{fresh} new message{fresh === 1 ? '' : 's'} ↑</button></div>}
    {jumpNote && <p className="lab-jump-note" role="status">{jumpNote}</p>}
    {shown.map(item => item.type === 'bubble' && <Bubble key={feedId(item)} item={item} tone={tone} marked={isMarked(feedId(item))} onFull={showFull} />)}
    {full && <FullResponse item={full} opener={opener} onClose={closeFull} openSource={cite} packet={packet} checks={checks} disclosed={disclosed} events={events} />}
  </div>;
}
// The run's packet: its past rulings for the decision, and its sources for the lookup trail's counts (second release).
type Packet = Parameters<typeof PrecedentsConsidered>[0]['packet'] & { sources?: { id: string; text: string; lines: string[] }[] };
// The first line of an agent's output: its summary, or the first prose field it wrote.
const gist = (a: any) => ['summary', 'position', 'reasoning', 'question', 'answer', 'revisedPosition', 'explanationToBothParties'].map(k => a[k]).find(v => typeof v === 'string' && v.trim()) ?? '';
const Verdict = ({ a }: { a: any }) => <div className="lab-verdict"><h3>{outcomeLabels[a.outcome] ?? (a.outcome ? String(a.outcome).replaceAll('_', ' ') : 'Recommendation')}</h3>{a.remedy?.amountCents > 0 && <p>{paymentWords(a) ? paymentWords(a) + ' Nothing has been paid.' : `Recommended: ${remedyText(a.remedy)}. Nothing has been paid.`}</p>}<p className="lab-approval">{a.routing ? routingLabel(a.routing) + '.' : 'A person must approve this.'}</p>{a.panel && <p className="lab-panel-verdict">Three arbitrators: {panelSplitText(a.panel)}.</p>}</div>;
function Bubble({ item, tone, marked, onFull }: { item: FeedBubble; tone?: GateTone; marked: boolean; onFull: (item: FeedBubble, from: HTMLElement) => void }) {
  const a = item.artifact ?? {};
  return <article data-feed-id={feedId(item)} className={'lab-bubble ' + item.role + (item.decision ? ' decision' + (tone ? ' tone-' + tone : '') : '') + (marked ? ' lab-marked' : '')}>
    <header className="lab-bubble-tag"><Avatar role={item.role} /><b>{names[item.role] ?? item.role}</b><span>{phaseName(item.phase)}</span><time dateTime={item.at} title={sgDate(item.at) + ', ' + clock(item.at)}>{shortClock(item.at)}</time></header>
    <div className="lab-bubble-body">
      {item.decision && <Verdict a={a} />}
      <p className="lab-bubble-summary">{gist(a) || 'No summary written.'}</p>
      <button type="button" className="lab-expand" aria-haspopup="dialog" onClick={e => onFull(item, e.currentTarget)}>Show full response</button>
    </div>
  </article>;
}
// A modal over the page: X, Escape or a backdrop click close it and focus returns to the button that opened it.
// Its body scrolls; the page and the conversation behind keep their place. It is the audit view: the model's confidence
// shows here labelled "not used", and a panel decision shows seats B and C in full for a reviewer. On a run that pins the
// evidence checks, an advocate's opening argument starts with what it started from: its party's own items (MVP fixes, 10 October 2026).
// Second release: then what it looked up (its disclosed lookup trail); a challenge shows its gap points, the decision its answers.
function FullResponse({ item, opener, onClose, openSource, packet, checks, disclosed, events }: { item: FeedBubble; opener: RefObject<HTMLElement | null>; onClose: () => void; openSource: (c: Cite) => void; packet?: Packet; checks?: EvidenceChecksView | null; disclosed?: Record<string, any>; events?: Event[] }) {
  const box = useRef<HTMLDialogElement>(null), down = useRef(false), id = useId();
  useEffect(() => { const d = box.current!, back = opener.current; if (!d.open) d.showModal(); d.querySelector<HTMLElement>('.lab-full-close')?.focus(); return () => { d.close(); back?.focus({ preventScroll: true }); }; }, [opener]);
  const a = item.artifact ?? {};
  return <dialog ref={box} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1} className={'lab-dialog lab-full ' + item.role}
    onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } }} onCancel={e => { e.preventDefault(); onClose(); }} onClose={e => { if (!e.currentTarget.open) onClose(); }}
    onPointerDown={e => { down.current = e.target === e.currentTarget; }} onClick={e => { if (down.current && e.target === e.currentTarget) onClose(); }}>
    <header className="lab-full-head"><Avatar role={item.role} /><div><h2 id={id}><b>{names[item.role] ?? item.role}</b> · <span>{phaseName(item.phase)}</span></h2><small>{clock(item.at)}</small></div><button type="button" className="quiet lab-full-close" onClick={onClose} aria-label="Close full response" title="Close">×</button></header>
    <div className="lab-full-body">{item.decision && <Verdict a={a} />}{(item.role === 'rider' || item.role === 'driver') && item.step === 'investigate' && <OwnSideList side={checks?.ownSide?.[item.role]} openSource={openSource} />}{(item.role === 'rider' || item.role === 'driver') && <LookupTrail item={a} packet={packet} openSource={openSource} />}{item.decision && <PrecedentsConsidered decision={a} packet={packet} events={events} openSource={openSource} />}{item.decision && <ConfidenceScoreView score={confidenceFor(a)} />}<ArtifactView item={withoutConfidence(a)} openSource={openSource} disclosed={disclosed} /><ConfidenceNotUsed item={a} />{item.decision && <SeatOutputs panel={panelWithScores(a)} openSource={openSource} disclosed={disclosed} />}</div>
  </dialog>;
}
