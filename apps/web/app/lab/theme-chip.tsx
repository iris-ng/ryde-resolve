'use client';
import { useEffect, useState } from 'react';
import { MOTION_KEY, prefersReduced, useReducedMotion, type Motion } from '../fishbowl/live/motion';

// Light or dark, as a chip in the top bar. The choice is a per-browser convenience in localStorage;
// until one is made the system setting decides. layout.tsx applies a saved choice before first paint.
export const THEME_KEY = 'lab-theme';
type Theme = 'light' | 'dark';
const system = (): Theme => matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
const current = (): Theme => { const t = document.documentElement.dataset.theme; return t === 'light' || t === 'dark' ? t : system(); };

export default function ThemeChip() {
  const [theme, setTheme] = useState<Theme | null>(null);
  useEffect(() => {
    setTheme(current());
    // The system setting, and the page's own setting when another tab changes it (layout.tsx).
    const media = matchMedia('(prefers-color-scheme: dark)'), follow = () => setTheme(current()), attr = new MutationObserver(follow);
    media.addEventListener('change', follow); attr.observe(document.documentElement, { attributeFilter: ['data-theme'] });
    return () => { media.removeEventListener('change', follow); attr.disconnect(); };
  }, []);
  const flip = () => {
    const next: Theme = current() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch { /* storage unavailable */ }
    setTheme(next);
  };
  const dark = theme === 'dark';
  return <button type="button" className="lab-theme" role="switch" aria-checked={dark} aria-label="Dark mode" title={dark ? 'Switch to light mode' : 'Switch to dark mode'} onClick={flip} suppressHydrationWarning>
    <span className="lab-theme-icon" aria-hidden="true">{dark
      ? <svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" /></svg>
      : <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.5" /><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1M4.6 19.4l2.1-2.1M17.3 6.7l2.1-2.1" /></svg>}</span>
  </button>;
}

// Animations on or off, as a chip beside the theme chip. Same rules as the theme: a per-browser choice in
// localStorage, applied before first paint by layout.tsx; until one is made the system setting decides.
export function MotionChip() {
  const on = !useReducedMotion();
  const flip = () => {
    const next: Motion = prefersReduced() ? 'full' : 'reduce';
    document.documentElement.dataset.motion = next;
    try { localStorage.setItem(MOTION_KEY, next); } catch { /* storage unavailable */ }
  };
  return <button type="button" className={'lab-theme lab-motion' + (on ? '' : ' off')} role="switch" aria-checked={on} aria-label="Animations" title={on ? 'Turn animations off' : 'Turn animations on'} onClick={flip} suppressHydrationWarning>
    {/* A ball with speed lines, not a play triangle: beside "Start new run" a play button read as "start" (4 October UI audit). */}
    <span className="lab-theme-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="15" cy="12" r="5" /><path d="M2.5 8.5h5M1.5 12h5M2.5 15.5h5" />{!on && <><path className="lab-motion-gap" d="M4.5 4.5l15 15" /><path className="lab-motion-slash" d="M4.5 4.5l15 15" /></>}</svg></span>
  </button>;
}
