'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CaseRow } from './use-lab';
import ThemeChip, { MotionChip } from './theme-chip';
import { useNow } from './sla-line';
import { searchCases } from '../../../../packages/live-fishbowl/case-search';
import { groupCases, type CaseGroup } from '../../../../packages/live-fishbowl/case-groups';
import { runDot, type RunDot } from '../../../../packages/live-fishbowl/gates';
import { demoReviewNote, queueOrder, responseTarget, targetView } from '../../../../packages/live-fishbowl/sla';
import QueueDialog, { type QueueRow } from './queue-dialog';
import { sgDateTime } from '../../../../packages/live-fishbowl/sg-time';

const kinds: Record<string, string> = { no_show: 'No-show or cancellation fee', route_deviation: 'Route, fare or toll', cleaning: 'Cleaning or damage', safety: 'Safety incident', other: 'Other dispute' };
export const caseKind = (r: CaseRow) => r.case_id === 'CUSTOM' ? (r.category ? kinds[r.category] ?? 'Custom case' : r.documents ? 'Type not detected yet' : 'Awaiting documents') : r.case_id;
const state = (r: CaseRow) => (r.status ?? 'no run yet').replaceAll('_', ' ');
// What the row's time means: the latest run's finish, its start while it runs, or when the case was opened.
const when = (r: CaseRow) => r.run_finished_at ? `finished ${sgDateTime(r.run_finished_at)}` : r.run_created_at ? `started ${sgDateTime(r.run_created_at)}` : `opened ${sgDateTime(r.created_at)}`;
// One dot per case from its latest run: green done, yellow in progress, red needs attention. The words beside it say the same.
/**
 * Summary, Library and Walkthrough (user, 8 October): words on wide screens, icons under 1280px (tour.css). Each shows a
 * tooltip under it on mouseover or keyboard focus: what it does, and its name too when only the icon shows. The note is
 * also the button's description for screen readers.
 */
function Tip({ id, name, note }: { id: string; name: string; note: string }) {
  // The pointer may rest on the tooltip (it sits inside its button), but a click there neither presses nor focuses the button.
  return <span className="lab-tip" aria-hidden="true" onMouseDown={e => e.preventDefault()} onClick={e => { e.preventDefault(); e.stopPropagation(); }}><b>{name}</b><span id={id}>{note}</span></span>;
}
/** Escape hid this button's tooltip; it shows again once the pointer leaves or focus moves (tour.css). */
const tipBack = { onMouseLeave: (e: { currentTarget: HTMLElement }) => e.currentTarget.removeAttribute('data-tip-off'), onBlur: (e: { currentTarget: HTMLElement }) => e.currentTarget.removeAttribute('data-tip-off') };
const icons = {
  summary: <svg className="lab-bar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.5h7l4 4v13H7z" /><path d="M14 3.5v4h4M9.5 12h6M9.5 15.5h6" /></svg>,
  library: <svg className="lab-bar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 4.5h4v15h-4zM9.5 4.5h4v15h-4zM14.8 5.6l3.7-.9 3.3 14.2-3.7.9z" /></svg>,
  queue: <svg className="lab-bar-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="6.5" r="1.3" /><circle cx="5" cy="12" r="1.3" /><circle cx="5" cy="17.5" r="1.3" /><path d="M9 6.5h11M9 12h9M9 17.5h7" /></svg>,
  tour: <svg className="lab-bar-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M9.6 9.4a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1.1.8-1.1 1.5v.5M12 16.9v.1" /></svg>,
};
// The dot says what happened, not only that the run ended (owner, 14 October 2026: "released has no meaning to someone without
// context"): green when the system decided and released its recommendation, amber when the decision went to a person, red when a
// run needs attention, blue while it runs, grey when it stopped. The latest decision's route travels in the row's queue events.
const decisionRoute = (r: CaseRow) => { const d = [...(r.queue_events ?? [])].reverse().find(e => e.kind === 'decision_proposed'); return typeof d?.data?.routing?.route === 'string' ? d.data.routing.route as string : null; };
const rowDot = (r: CaseRow): RunDot => { const d = runDot(r.status); if (d.tone !== 'done') return d; const route = decisionRoute(r); return route === 'human_review' ? { tone: 'review', label: 'Sent to a person' } : route ? { tone: 'done', label: 'Decided by the system' } : d; };
// The words beside the dot: nothing when the system decided (the dot says it), "to a person" when it did not, else the run's state.
const stateWords = (r: CaseRow) => r.status === 'completed' ? (decisionRoute(r) === 'human_review' ? ' · to a person' : '') : ` · ${state(r)}`;
const Dot = ({ row }: { row: CaseRow }) => { const d = rowDot(row); return <><i className={'lab-dot dot-' + d.tone} title={d.label} aria-hidden="true" /><span className="lab-sr">{d.label}. </span></>; };

// The bar across the top: brand, the case picker, the summary button, the library link, the walkthrough button,
// the theme and animations chips. No release tag: it cluttered the bar (owner, 11 October); /api/health still reports it.
// The picker lists cases, not workspaces (5 October, user decision): copies of a sample case are one row (case-groups.ts),
// and the Status column's Run list spans them. Starred cases come first, the most recently starred on top; the rest are
// newest activity first (a run in progress, then the latest finish). A case waiting for a person still shows its
// priority and pick-up time, but no longer jumps the list. Typing in the box filters the rows.
// Once a case is open the picker shows only its title (user, 7 October): its colour dot, type and status are in the list.
// On the public copy (owner, 11 October 2026) the rows keep their order and stars but cannot be starred or deleted: a starred row shows
// its star, and no Delete.
// The Queue button after Walkthrough (owner, 11 October 2026) opens the cases waiting for a person in the order a person
// should take them (queue-dialog.tsx), with the count waiting on the button. Opening it reloads the list, as opening the
// picker does, so a case another operator picked up meanwhile is not still shown as waiting.
export default function TopBar({ cases, selected, loading, busy, summaryReady, viewOnly = false, onSummary, onSelect, onDelete, onOpen, onStar, onTour }: { cases: CaseRow[]; selected: string; loading: boolean; busy: boolean; summaryReady: boolean; viewOnly?: boolean; onSummary: () => void; onTour: () => void; onSelect: (id: string, latestRun?: string | null) => void; onDelete: (id: string, keepError?: boolean) => Promise<boolean>; onOpen?: () => void; onStar: (id: string, starred: boolean) => void }) {
  const [open, setOpen] = useState(false), [confirm, setConfirm] = useState(''), [query, setQuery] = useState(''), [queueOpen, setQueueOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null), search = useRef<HTMLInputElement>(null), queueButton = useRef<HTMLButtonElement>(null);
  const current = cases.find(c => c.id === selected);
  // A case's priority: the most urgent copy still waiting for a person, else its latest run's (a newer released copy must not hide an older one that waits). The wording counts down, so it refreshes while the
  // list is open; the order does not depend on the time.
  const targets = useMemo(() => new Map(cases.map(r => [r.id, responseTarget(r.queue_events ?? [], r.status)])), [cases]), now = useNow(open || queueOpen ? 30000 : 0);
  const slas = new Map(cases.map(r => { const t = targets.get(r.id); return [r.id, t ? targetView(t, now) : null]; }));
  const groups = useMemo(() => groupCases(cases), [cases]);
  const waitingCopy = (g: CaseGroup<CaseRow>) => queueOrder(g.rows, r => targets.get(r.id) ?? null).find(r => { const t = targets.get(r.id); return !!t && !t.pickedUp; });
  const priorityRow = (g: CaseGroup<CaseRow>) => waitingCopy(g) ?? g.lead;
  const shown = searchCases(groups, query, g => { const r = g.lead; return [r.title, r.case_id, caseKind(r), r.category ? kinds[r.category] ?? '' : '', state(r), slas.get(priorityRow(g).id)?.short ?? ''].join(' '); });
  // The list in the order it is shown: Featured (starred), then the rest; flat while a filter is typed.
  // Enter in the filter opens the first row the reader sees, so the two must agree.
  const ordered = useMemo(() => query.trim() ? { flat: shown, featured: [] as CaseGroup<CaseRow>[], rest: [] as CaseGroup<CaseRow>[] } : (() => {
    const featured = shown.filter(g => g.starredAt), rest = shown.filter(g => !g.starredAt);
    return { flat: [...featured, ...rest], featured, rest }; })(), [shown, query]);
  // Opening a case opens its latest run, in whichever copy that run is.
  const pick = (g: CaseGroup<CaseRow>) => { onSelect(g.lead.id, g.lead.run_id); setOpen(false); };
  const waiting = groups.some(g => !!waitingCopy(g));
  // The live queue: each case's waiting copy, in queue order. The order reads the clock (a case near its target moves up).
  const queue: QueueRow[] = queueOrder(groups.flatMap(g => { const r = waitingCopy(g), t = r && targets.get(r.id);
    return r && t ? [{ id: r.id, runId: r.run_id ?? null, title: r.title, caseId: r.case_id === 'CUSTOM' ? 'custom case' : r.case_id, target: t, events: r.queue_events ?? [] }] : []; }), q => q.target, now);
  const runCount = (g: CaseGroup<CaseRow>) => g.rows.reduce((n, r) => n + (r.runs ?? 0), 0);
  // A showing tooltip stays while the pointer moves onto it, and Escape hides it without moving focus or the pointer (content
  // on hover or focus, WCAG 1.4.13). Escape still reaches anything else that listens for it.
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') document.querySelectorAll<HTMLElement>('.lab-tipped').forEach(el => { if (el.matches(':hover, :focus-visible')) el.setAttribute('data-tip-off', ''); }); };
    addEventListener('keydown', key); return () => removeEventListener('keydown', key);
  }, []);
  // A focus tooltip is for the keyboard. Focus handed back by a dialog closed with the pointer (the walkthrough, the summary or
  // the queue) counts as keyboard focus in Safari, which then left a tooltip over the page after the first visit's opening
  // (pre-release check, 11 October 2026): focus that arrives after a pointer press, or before any key, starts with it hidden.
  useEffect(() => {
    let keyed = false;
    const key = () => { keyed = true; }, point = () => { keyed = false; };
    const focus = (e: FocusEvent) => { const el = e.target instanceof Element ? e.target.closest('.lab-tipped') : null; if (el && !keyed) el.setAttribute('data-tip-off', ''); };
    addEventListener('keydown', key, true); addEventListener('pointerdown', point, true); addEventListener('focusin', focus);
    return () => { removeEventListener('keydown', key, true); removeEventListener('pointerdown', point, true); removeEventListener('focusin', focus); };
  }, []);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(false); button.current?.focus(); } };
    document.addEventListener('pointerdown', away); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', key); };
  }, [open]);
  useEffect(() => { if (open) search.current?.focus(); else { setConfirm(''); setQuery(''); } }, [open]);
  // Opening the list reloads it, so a case another operator picked up meanwhile is not still shown as waiting.
  const opened = useRef(onOpen); opened.current = onOpen;
  useEffect(() => { if (open) opened.current?.(); }, [open]);
  return <header className="lab-bar">
    {/* The name is the way home (owner, 11 October 2026): the site's front, the case list with no case open. */}
    <a className="lab-brand" href="/" aria-label="Ryde Resolve, back to the case list"><span className="lab-brand-name">Ryde Resolve</span></a>
    <div className="lab-picker">
      <button ref={button} type="button" className="lab-picker-button" aria-haspopup="listbox" aria-expanded={open} disabled={loading} onClick={() => setOpen(o => !o)}>
        <svg className="lab-pin" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a7.5 7.5 0 0 0-7.5 7.5C4.5 15 12 22 12 22s7.5-7 7.5-12.5A7.5 7.5 0 0 0 12 2zm0 10.2a2.7 2.7 0 1 1 0-5.4 2.7 2.7 0 0 1 0 5.4z" /></svg>
        <span className="lab-picker-title">{loading ? 'Loading cases…' : current ? current.title : cases.length ? 'Choose a case' : 'No cases yet'}</span>
        <span className="lab-chevron" aria-hidden="true">⌄</span>
      </button>
      {open && <div ref={menu} className="lab-menu">
        {cases.length > 0 && <input ref={search} className="lab-menu-search" type="search" placeholder="Filter: name, number (e.g. 014), type or status" aria-label="Filter cases" value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && ordered.flat[0]) { e.preventDefault(); pick(ordered.flat[0]); }
            if (e.key === 'ArrowDown') { e.preventDefault(); menu.current?.querySelector<HTMLButtonElement>('[role=option]')?.focus(); }
          }} />}
        {waiting && <p className="lab-menu-note">{demoReviewNote}</p>}
        {cases.length > 0 && <p className="lab-menu-legend"><span><i className="lab-dot dot-done" aria-hidden="true" />decided by the system</span><span><i className="lab-dot dot-review" aria-hidden="true" />sent to a person</span><span><i className="lab-dot dot-stopped" aria-hidden="true" />stopped</span></p>}
        {/* Two groups: Featured (the starred cases), then More cases. While a filter is typed the matches come as one flat list;
            the headings are presentation only. */}
        {(() => {
          const head = (key: string, text: string) => <div key={'head-' + key} className="lab-menu-head" role="presentation">{text}</div>;
          const row = (g: CaseGroup<CaseRow>) => { const r = g.lead, waits = priorityRow(g), sla = slas.get(waits.id), earlier = waits.id !== r.id, here = g.rows.some(m => m.id === selected), runs = runCount(g), copies = g.rows.length;
            // Unstarring clears every copy's star; starring marks the lead. Deleting removes every copy from the list and
            // stops at the first copy that cannot go (a run still in progress), leaving its error on the page.
            const star = () => g.starredAt ? g.rows.filter(m => m.starred_at).forEach(m => onStar(m.id, false)) : onStar(r.id, true);
            const remove = async () => { for (const [i, m] of g.rows.entries()) if (!await onDelete(m.id, i > 0)) break; setConfirm(''); };
            return <div key={g.key} className={'lab-menu-row' + (here ? ' selected' : '')}>
            {viewOnly ? <span className="lab-pin-star" title={g.starredAt ? 'Starred: kept at the top' : undefined} aria-hidden="true">{g.starredAt ? '★' : ''}</span>
              : <button type="button" className={'quiet lab-star' + (g.starredAt ? ' on' : '')} aria-pressed={!!g.starredAt} aria-label={`${g.starredAt ? 'Unstar' : 'Star'} case ${r.title}`} title={g.starredAt ? 'Starred: kept at the top. Click to unstar.' : 'Star to keep this case at the top'} onClick={star}><span aria-hidden="true">{g.starredAt ? '★' : '☆'}</span></button>}
            <button type="button" role="option" aria-selected={here} onClick={() => pick(g)}><strong>{r.title}</strong><span><Dot row={r} />{caseKind(r)}{stateWords(r)} · {when(r)}{runs > 1 ? ` · ${runs} runs` : ''}{r.documents ? ` · ${r.documents} document${r.documents === 1 ? '' : 's'}` : ''}</span>
              {sla && <span className={`lab-menu-sla tone-${sla.tone} sla-${sla.state}`} title={earlier ? `${sla.rule} An earlier run of this case waits: pick it in the Run list.` : sla.rule}><b>{sla.label}</b>{sla.stake && <> · {sla.stake}</>}{sla.when && <> · {sla.when}</>}{earlier && <> · earlier run</>}</span>}</button>
            {viewOnly ? null : confirm === g.key
              ? <span className="lab-menu-confirm"><span>{copies > 1 ? `Remove this case and its ${copies - 1} other ${copies === 2 ? 'copy' : 'copies'} from the list?` : 'Remove from the list?'} Audits are kept.</span><button type="button" className="danger" disabled={busy} onClick={() => { void remove(); }}>{busy ? 'Deleting…' : 'Delete'}</button><button type="button" className="quiet" onClick={() => setConfirm('')}>Keep</button></span>
              : <button type="button" className="quiet danger-text" aria-label={`Delete case ${r.title}`} onClick={() => setConfirm(g.key)}>Delete</button>}
          </div>; };
          if (query.trim()) return <div role="listbox" aria-label="Cases">{ordered.flat.map(row)}</div>;
          const { featured, rest } = ordered;
          return <div role="listbox" aria-label="Cases">
            {featured.length > 0 && head('featured', 'Featured')}{featured.map(row)}
            {rest.length > 0 && head('more', 'More cases')}{rest.map(row)}
          </div>; })()}
        {!cases.length && <p className="lab-menu-empty">No cases yet.</p>}
        {cases.length > 0 && !shown.length && <p className="lab-menu-empty">No cases match “{query.trim()}”.</p>}
        <a className="lab-menu-link" href="/precedents">Past rulings drafted from reviewers&apos; decisions</a>
      </div>}
    </div>
    {queueOpen && <QueueDialog rows={queue} now={now} opener={queueButton} onPick={(id, runId) => { setQueueOpen(false); onSelect(id, runId); }} onClose={() => setQueueOpen(false)} />}
    {/* Not ready yet: marked unavailable but still reachable by keyboard, so its tooltip can say why. */}
    <button type="button" className="lab-summary-button lab-tipped" aria-disabled={!summaryReady || undefined} onClick={() => { if (summaryReady) onSummary(); }} aria-describedby="lab-tip-summary" {...tipBack}>{icons.summary}<span className="lab-bar-word">Summary</span><Tip id="lab-tip-summary" name="Summary" note={summaryReady ? 'Open the case summary' : 'Ready once the run decides or stops at the safety screen'} /></button>
    <a className="lab-library-link lab-tipped" href="/library" aria-describedby="lab-tip-library" {...tipBack}>{icons.library}<span className="lab-bar-word">Library</span><Tip id="lab-tip-library" name="Library" note="Ryde's rules and past rulings" /></a>
    <button type="button" className="lab-tour-button lab-tipped" disabled={loading} onClick={onTour} aria-describedby="lab-tip-tour" {...tipBack}>{icons.tour}<span className="lab-bar-word">Walkthrough</span><Tip id="lab-tip-tour" name="Walkthrough" note="A short walk through the page" /></button>
    {/* The live queue (owner, 11 October 2026): a pill like Summary, Library and Walkthrough, last of them so the keyboard order
        before it is unchanged, with the count waiting. */}
    <button ref={queueButton} type="button" className="lab-queue-button lab-tipped" disabled={loading} onClick={() => { opened.current?.(); setQueueOpen(true); }} aria-describedby="lab-tip-queue" {...tipBack}>{icons.queue}<span className="lab-bar-word">Queue</span>{queue.length > 0 && <span className="lab-queue-count" aria-label={`${queue.length} waiting for a person`}>{queue.length}</span>}<Tip id="lab-tip-queue" name="Queue" note={queue.length ? `${queue.length} case${queue.length === 1 ? '' : 's'} waiting for a person, in the order to take them` : 'Nobody is waiting for a person'} /></button>
    <ThemeChip />
    <MotionChip />
  </header>;
}
