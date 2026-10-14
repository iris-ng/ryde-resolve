'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';

const OPEN = 'lab-open-library';
type Opening = { href: string; from: HTMLElement | null };
/**
 * Opens the library window on the case page; false when no window is mounted (another page), so the caller opens a tab.
 * `from` is where focus returns on close: Safari does not focus a link on click, so the link passes itself.
 */
export const openLibrary = (href: string, from: HTMLElement | null = null) => !window.dispatchEvent(new CustomEvent<Opening>(OPEN, { detail: { href, from }, cancelable: true }));

// A library link inside a case (user, 8 October: the library opens in a window over the case). A plain click opens the
// library window; a click with a modifier key, a middle click, or a page without the window opens a new tab as usual.
export function LibraryLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  return <a href={href} target="_blank" rel="noreferrer" className={className}
    onClick={e => { if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; if (openLibrary(href, e.currentTarget)) e.preventDefault(); }}>{children}</a>;
}

// The library window: the library's own pages in a frame over the case, so reading a rule or a past ruling never leaves the
// case. Links inside move within the window; "Open in a new tab" takes the page shown. Escape, the close button or a click
// outside closes it, and focus returns where it was.
export default function LibraryWindow() {
  const [href, setHref] = useState<string | null>(null), [shown, setShown] = useState('/library');
  const box = useRef<HTMLDialogElement>(null), frame = useRef<HTMLIFrameElement>(null), back = useRef<HTMLElement | null>(null), down = useRef(false);
  useEffect(() => {
    const open = (e: Event) => {
      const { href: to, from } = (e as CustomEvent<Opening>).detail ?? {};
      if (typeof to !== 'string' || !to.startsWith('/library')) return;
      e.preventDefault(); back.current = from ?? document.activeElement as HTMLElement | null; setHref(to); setShown(to);
    };
    const message = (e: MessageEvent) => { if (e.origin === location.origin && e.source === frame.current?.contentWindow && e.data === 'library-close') setHref(null); };
    window.addEventListener(OPEN, open); window.addEventListener('message', message);
    return () => { window.removeEventListener(OPEN, open); window.removeEventListener('message', message); };
  }, []);
  useEffect(() => {
    const d = box.current;
    if (!href || !d) return;
    if (!d.open) d.showModal();
    d.querySelector<HTMLElement>('.lab-full-close')?.focus();
    return () => { d.close(); back.current?.focus({ preventScroll: true }); };
  }, [href]);
  if (!href) return null;
  const close = () => setHref(null);
  // The library changes its address without reloading (a category, a door, an entry in its pane), so "Open in a new tab"
  // reads the frame's address when a pointer or the keyboard reaches it, not only when a page loads.
  const follow = (link?: HTMLAnchorElement) => { try { const at = frame.current?.contentWindow?.location; if (at && at.pathname.startsWith('/library')) { setShown(at.pathname + at.search); if (link) link.href = at.pathname + at.search; } } catch { /* not readable: keep the last address */ } };
  return <dialog ref={box} aria-labelledby="lab-library-title" className="lab-dialog lab-library-window"
    onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } }} onCancel={e => { e.preventDefault(); close(); }}
    onPointerDown={e => { down.current = e.target === e.currentTarget; }} onClick={e => { if (down.current && e.target === e.currentTarget) close(); }}>
    <header className="lab-library-head">
      <h2 id="lab-library-title">Library</h2>
      <a href={shown} target="_blank" rel="noreferrer" onPointerDown={e => follow(e.currentTarget)} onFocus={e => follow(e.currentTarget)}>Open in a new tab ↗</a>
      <button type="button" className="quiet lab-full-close" onClick={close} aria-label="Close the library" title="Close">×</button>
    </header>
    <iframe ref={frame} src={href} title="Library" onLoad={() => follow()} />
  </dialog>;
}
