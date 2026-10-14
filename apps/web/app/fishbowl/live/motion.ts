import { useSyncExternalStore } from 'react';

// One motion preference for the CSS and the frame engines. The lab's Animations chip stores 'full' or 'reduce'
// per browser and sets data-motion on <html> (layout.tsx applies a saved choice before first paint); without a
// choice the system prefers-reduced-motion setting decides. An explicit choice always wins.
export const MOTION_KEY = 'lab-motion';
export type Motion = 'full' | 'reduce';
const query = '(prefers-reduced-motion: reduce)';
export const reducedMotion = (choice: string | null | undefined, system: boolean) => choice === 'reduce' || (choice !== 'full' && system);
export const prefersReduced = () => reducedMotion(document.documentElement.dataset.motion, matchMedia(query).matches);
const watch = (update: () => void) => {
  const media = matchMedia(query), attr = new MutationObserver(update);
  media.addEventListener('change', update); attr.observe(document.documentElement, { attributeFilter: ['data-motion'] });
  return () => { media.removeEventListener('change', update); attr.disconnect(); };
};
// Follows both the system setting and data-motion live, so toggling the chip needs no reload. A figure mounted
// after hydration starts on the right pose; server HTML and hydration assume motion.
export const useReducedMotion = () => useSyncExternalStore(watch, prefersReduced, () => false);
