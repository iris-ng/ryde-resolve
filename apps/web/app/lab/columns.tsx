'use client';
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

// Three side-by-side panes. The outer two have a set width, the middle takes the rest. Either
// handle resizes by dragging or with the arrow keys (Home resets, double click resets). Any pane
// side pane can be dismissed; a dismissed pane leaves a coloured rail on its edge that brings it
// back. The middle pane stays. Widths and dismissed state are
// a per-browser convenience kept in localStorage. At 900px and under (phones and tablets) one pane shows at a time,
// chosen by tabs that stay at the top of the screen while the page scrolls (4 October UI audit: stacked, the decision
// sat 8,000px down a phone page). `tab` and `onTab` let the page pick the pane (lab.tsx); dismissed panes come back.
export type Side = 'left' | 'right';
export type Column = { key: string; title: string; body: ReactNode; side?: Side };
type Layout = { left: number; right: number; hidden: Record<string, boolean> };
const MIN = 260, MAX = 720, DEFAULT: Layout = { left: 360, right: 360, hidden: {} }, KEY = 'lab-columns', CENTER_MIN = 360;
const NARROW = '(max-width: 900px)';
/** `revealAll`: each change brings every dismissed pane back (the walkthrough points at the evidence pane). */
export default function Columns({ columns, overlay, tab, onTab, revealAll }: { columns: [Column, Column, Column]; overlay?: ReactNode; tab?: string; onTab?: (key: string) => void; revealAll?: number }) {
  const [layout, setLayout] = useState<Layout>(DEFAULT), [boxWidth, setBoxWidth] = useState(0);
  const box = useRef<HTMLDivElement>(null), tabs = useRef<HTMLDivElement>(null);
  // The panes render only in the browser (after the case loads), so the first render can read the width.
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && matchMedia(NARROW).matches);
  useEffect(() => { const media = matchMedia(NARROW), follow = () => setNarrow(media.matches); follow(); media.addEventListener('change', follow); return () => media.removeEventListener('change', follow); }, []);
  const [own, setOwn] = useState(columns[1].key), active = tab ?? own;
  // A new pane starts at its top, just under the tabs, when the page was scrolled further down.
  const choose = useCallback((key: string) => {
    (onTab ?? setOwn)(key);
    const start = box.current ? box.current.getBoundingClientRect().top + scrollY : 0;
    if (scrollY > start) scrollTo(0, start);
  }, [onTab]);
  // Arrow keys move between the tabs and show each pane (the ARIA tabs pattern with automatic activation).
  const tabKeys = (e: React.KeyboardEvent) => {
    const keys = columns.map(c => c.key), i = keys.indexOf(active), next = e.key === 'ArrowRight' ? (i + 1) % 3 : e.key === 'ArrowLeft' ? (i + 2) % 3 : e.key === 'Home' ? 0 : e.key === 'End' ? 2 : -1;
    if (next < 0) return;
    e.preventDefault(); choose(keys[next]); tabs.current?.querySelectorAll<HTMLElement>('[role=tab]')[next]?.focus();
  };
  useEffect(() => { const el = box.current; if (!el) return; const ro = new ResizeObserver(([entry]) => setBoxWidth(entry.contentRect.width)); ro.observe(el); return () => ro.disconnect(); }, []);
  useEffect(() => { try { const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null'); if (saved && typeof saved.left === 'number' && typeof saved.right === 'number') setLayout({ ...DEFAULT, ...saved, hidden: saved.hidden ?? {} }); } catch { /* storage unavailable */ } }, []);
  const save = useCallback((next: Layout) => { setLayout(next); try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ } }, []);
  const clamp = useCallback((side: Side, w: number, current: Layout) => { const other = side === 'left' ? current.right : current.left, otherShown = !current.hidden[side === 'left' ? columns[2].key : columns[0].key]; const room = (box.current?.clientWidth ?? 1400) - (otherShown ? other : 0) - CENTER_MIN; return Math.round(Math.max(MIN, Math.min(MAX, room, w))); }, [columns]);
  const setWidth = useCallback((side: Side, w: number, commit: boolean) => setLayout(current => { const next = { ...current, [side]: clamp(side, w, current) }; if (commit) try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ } return next; }), [clamp]);
  const toggle = (key: string, shown: boolean) => save({ ...layout, hidden: { ...layout.hidden, [key]: !shown } });
  useEffect(() => { if (revealAll) setLayout(current => { if (!Object.values(current.hidden).some(Boolean)) return current; const next = { ...current, hidden: {} }; try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ } return next; }); }, [revealAll]);
  function drag(side: Side) {
    return (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 || !box.current) return;
      const handle = e.currentTarget, rect = box.current.getBoundingClientRect();
      const width = (ev: PointerEvent) => side === 'left' ? ev.clientX - rect.left : rect.right - ev.clientX;
      const move = (ev: PointerEvent) => setWidth(side, width(ev), false);
      const stop = (ev: PointerEvent) => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', stop); handle.removeEventListener('pointercancel', stop); setWidth(side, width(ev), true); };
      handle.setPointerCapture(e.pointerId); handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', stop); handle.addEventListener('pointercancel', stop);
      e.preventDefault();
    };
  }
  const keys = (side: Side) => (e: React.KeyboardEvent) => { const grow = side === 'left' ? 'ArrowRight' : 'ArrowLeft', shrink = side === 'left' ? 'ArrowLeft' : 'ArrowRight'; if (e.key === grow) setWidth(side, layout[side] + 24, true); else if (e.key === shrink) setWidth(side, layout[side] - 24, true); else if (e.key === 'Home') setWidth(side, DEFAULT[side], true); else return; e.preventDefault(); };
  const [left, center, right] = columns;
  const shown = (c: Column) => narrow || !layout.hidden[c.key];
  // Saved widths are a preference; when the window is narrower than they need, both sides shrink in proportion so the middle keeps its minimum.
  const wanted = (shown(left) ? layout.left : 0) + (shown(right) ? layout.right : 0), room = Math.max(0, boxWidth - CENTER_MIN - 20);
  const scale = boxWidth && wanted > room ? room / wanted : 1;
  const width = (side: Side) => Math.max(180, Math.round(layout[side] * scale));
  const pane = (c: Column, dismissable: boolean) => <section id={'lab-pane-' + c.key} className={'lab-pane lab-pane-' + c.key} aria-label={c.title}
    {...narrow ? { role: 'tabpanel', hidden: c.key !== active } : {}}>
    <div className="lab-pane-head"><h2>{c.title}</h2>{dismissable && !narrow && <button type="button" className="quiet lab-dismiss" onClick={() => toggle(c.key, false)} aria-label={'Dismiss ' + c.title} title={'Dismiss ' + c.title}>×</button>}</div>
    <div className="lab-pane-body">{c.body}</div>
  </section>;
  const rail = (c: Column, side: Side) => <button type="button" className={'lab-rail lab-rail-' + side + ' lab-rail-' + c.key} onClick={() => toggle(c.key, true)} aria-label={'Show ' + c.title} title={'Show ' + c.title}><span>{c.title}</span></button>;
  const handle = (side: Side, title: string) => <div className="lab-handle" role="separator" aria-orientation="vertical" aria-label={'Resize ' + title} aria-valuenow={layout[side]} aria-valuemin={MIN} aria-valuemax={MAX} tabIndex={0} onPointerDown={drag(side)} onDoubleClick={() => setWidth(side, DEFAULT[side], true)} onKeyDown={keys(side)} />;
  const template = [shown(left) ? `${width('left')}px 10px` : '28px', 'minmax(0,1fr)', shown(right) ? `10px ${width('right')}px` : '28px'].join(' ');
  return <div ref={box} className="lab-columns" style={{ '--lab-left': shown(left) ? width('left') + 'px' : '28px', gridTemplateColumns: template } as CSSProperties}>
    {narrow && <div ref={tabs} className="lab-tabs" role="tablist" aria-label="Panes" onKeyDown={tabKeys}>{columns.map(c => <button key={c.key} type="button" role="tab" id={'lab-tab-' + c.key} aria-controls={'lab-pane-' + c.key} aria-selected={c.key === active} tabIndex={c.key === active ? 0 : -1} onClick={() => choose(c.key)}>{c.key === center.key ? c.title.split(' · ')[0] : c.title}</button>)}</div>}
    {shown(left) ? <>{pane(left, true)}{handle('left', left.title)}</> : rail(left, 'left')}
    {pane(center, false)}
    {shown(right) ? <>{handle('right', right.title)}{pane(right, true)}</> : rail(right, 'right')}
    {overlay}
  </div>;
}
