'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Entry } from '../../../../packages/policy/catalog';
import { disputeTypeNames, disputeTypeShortNames, disputeTypes, doorNames, isDisputeType, isDoor, libraryDoors, paneKey, type DisputeType, type Door } from '../../../../packages/policy/library-links';
import EntryView, { inPane, type Open } from './entry-view';
import PolicyNote from './policy-note';

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const keyOf = (e: Pick<Entry, 'shelf' | 'number'>) => paneKey(e.shelf, e.number);

// The front page below its title. The four case categories are folder tabs; the chosen one opens into a panel holding its
// two doors and their list. Policy says when the team read Ryde's pages, then lists Ryde's rules about the category; the
// rules only read alongside fold away. Team readings are not listed (user, 8 October): the Arbitrator names one in its
// analysis when a case rests on it. Precedents lists the past rulings. An entry opens in a side pane
// beside the list, so the categories, doors and list stay put (user, 8 October). Everything stays in the address
// (?type=&door=&open=): opening an entry adds a step to the browser's history, so Back closes it.
export default function Browser({ entries, asOf, initialType, initialDoor, initialOpen }: { entries: Entry[]; asOf: string; initialType: DisputeType | null; initialDoor: Door; initialOpen: string | null }) {
  const [type, setType] = useState(initialType), [door, setDoor] = useState<Door>(initialDoor), [opened, setOpened] = useState(initialOpen);
  const pane = useRef<HTMLElement>(null), from = useRef<HTMLElement | null>(null);
  const address = useCallback((next: { type: DisputeType | null; door: Door; open: string | null }) => {
    const url = new URL(location.href);
    for (const [k, v] of [['type', next.type], ['door', next.type && next.door !== 'policy' ? next.door : null], ['open', next.open]] as const) if (v) url.searchParams.set(k, v); else url.searchParams.delete(k);
    return url;
  }, []);
  useEffect(() => { history.replaceState(null, '', address({ type, door, open: opened })); }, [type, door]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const back = () => { const q = new URL(location.href).searchParams, t = q.get('type'), d = q.get('door'); setType(isDisputeType(t) ? t : disputeTypes[0]); setDoor(isDoor(d) ? d : 'policy'); setOpened(q.get('open')); };
    addEventListener('popstate', back); return () => removeEventListener('popstate', back);
  }, []);
  const open: Open = (to, clicked) => {
    const key = paneKey(to.shelf, to.number), at = clicked ?? document.activeElement as HTMLElement | null;
    // Focus returns to the row that opened the pane, not to a link inside the pane.
    if (!at || !pane.current?.contains(at)) from.current = at;
    if (key !== opened) history.pushState(null, '', address({ type, door, open: key }));
    setOpened(key);
    requestAnimationFrame(() => { pane.current?.scrollTo({ top: 0 }); pane.current?.querySelector<HTMLElement>('.lib-pane-close')?.focus({ preventScroll: true }); });
  };
  const close = () => { setOpened(null); history.pushState(null, '', address({ type, door, open: null })); };
  const shown = entries.find(e => keyOf(e) === opened);
  // However the pane closes (the button, Escape, or the browser's Back), focus goes back to the row that opened it, unless
  // the reader has already moved it somewhere else. If that row has gone (another category was
  // chosen meanwhile), focus goes to the closed entry's row if this list shows it, else to the chosen category's tab.
  const lastShown = useRef<string | null>(null);
  useEffect(() => {
    if (opened) { lastShown.current = entries.find(e => keyOf(e) === opened)?.href ?? null; return; }
    if (!from.current) return;
    const row = lastShown.current ? document.querySelector<HTMLElement>(`.lib-nav a.lib-row[href="${lastShown.current}"]`) : null;
    const target = from.current.isConnected ? from.current : row ?? document.querySelector<HTMLElement>('.lib-folders button[aria-pressed=true]');
    if (!document.activeElement || document.activeElement === document.body) target?.focus({ preventScroll: true });
    from.current = null;
  }, [opened]); // eslint-disable-line react-hooks/exhaustive-deps
  // On tablets and phones the pane covers the page, so everything behind it is out of reach (no Tab into hidden rows) until it closes.
  useEffect(() => {
    if (!shown) return;
    const narrow = matchMedia('(max-width: 900px)'), behind = () => [...document.querySelectorAll<HTMLElement>('.lib-bar, .lib-front > h1, .lib-note, .lib-nav, .lib-footnote')];
    const apply = () => behind().forEach(el => { el.inert = narrow.matches; });
    apply(); narrow.addEventListener('change', apply);
    return () => { narrow.removeEventListener('change', apply); behind().forEach(el => { el.inert = false; }); };
  }, [shown]);
  useEffect(() => {
    if (!shown) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); close(); } };
    addEventListener('keydown', key); return () => removeEventListener('keydown', key);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const of = (shelf: Entry['shelf']) => type ? entries.filter(r => r.shelf === shelf && r.types.includes(type)) : [];
  const rules = of('rules'), core = rules.filter(r => r.shelf === 'rules' && type && r.core.includes(type)), alongside = rules.filter(r => !core.includes(r));
  // Rules no category reads (lost items, fare evasion): listed under the categories so every rule can be found.
  const unfiled = entries.filter(r => r.shelf === 'rules' && !r.types.length);
  // A rule's row is its number and short name only (user, 8 October: no cut-off start of the rule's text); a past ruling's row
  // keeps its one-line outcome.
  const row = (r: Entry) => <a className={'lib-row shelf-' + r.shelf} href={r.href} aria-current={keyOf(r) === opened ? 'true' : undefined} onClick={inPane(open, r)}><span className="lib-tab">{r.number}</span><span className="lib-row-text"><b>{r.title}</b>{r.shelf !== 'rules' && <span>{r.summary}</span>}</span></a>;
  const list = (items: Entry[]) => <ul className="lib-list">{items.map(r => <li key={r.shelf + r.id}>{row(r)}</li>)}</ul>;
  return <>
  <PolicyNote entries={entries} />
  <div className={'lib-front-grid' + (shown ? ' has-pane' : '')}>
    <div className="lib-nav">
      <nav className="lib-folders" aria-label="Case category">
        {disputeTypes.map(t => <button key={t} type="button" aria-pressed={type === t} aria-controls={type === t ? 'lib-folder' : undefined} onClick={() => setType(t)} aria-label={disputeTypeNames[t]}><span className="lib-long">{disputeTypeNames[t]}</span><span className="lib-short" aria-hidden="true">{disputeTypeShortNames[t]}</span></button>)}
      </nav>
      {type && <section id="lib-folder" className={'lib-folder' + (type === disputeTypes[0] ? ' at-first' : type === disputeTypes.at(-1) ? ' at-last' : '')} aria-label={disputeTypeNames[type]}>
        <div className="lib-doors" role="tablist" aria-label="Policy or precedents">
          {libraryDoors.map(d => <button key={d} type="button" role="tab" id={'lib-door-' + d} aria-controls="lib-door-panel" aria-selected={door === d} className={'lib-door door-' + d} onClick={() => setDoor(d)}>{doorNames[d].name}</button>)}
        </div>
        <div id="lib-door-panel" role="tabpanel" aria-labelledby={'lib-door-' + door}>
          {door === 'policy' ? <>
            <p className="lib-asof">{asOf}</p>
            {list(core)}
            {alongside.length > 0 && <details className="lib-more"><summary>{plural(alongside.length, 'more rule')} read alongside these</summary>{list(alongside)}</details>}
          </> : of('rulings').length ? list(of('rulings')) : <p className="lib-placeholder">[Placeholders go here, see the live site for details.]</p>}
        </div>
      </section>}
      {unfiled.length > 0 && <p className="lib-also">Rules outside these categories: {unfiled.map((r, i) => <span key={r.id}>{i ? ', ' : ''}<a href={r.href} onClick={inPane(open, r)}>{r.number} {r.title}</a></span>)}.</p>}
    </div>
    {shown && <aside ref={pane} className={'lib-pane shelf-' + shown.shelf} aria-label={`${shown.number}: ${shown.title}`}>
      <div className="lib-pane-bar"><a href={shown.href} target="_blank" rel="noreferrer">Open as a page ↗</a><button type="button" className="lib-pane-close" onClick={close} aria-label="Close" title="Close">×</button></div>
      <EntryView entry={shown} level={2} open={open} />
    </aside>}
  </div>
  </>;
}
