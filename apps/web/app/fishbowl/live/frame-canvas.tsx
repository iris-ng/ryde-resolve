'use client';
import { useEffect, useReducer, useRef } from 'react';

// Character frames are drawn on a canvas from one page-wide store of loaded images. The site serves the frame files with
// Cache-Control: no-store (next.config.ts and the Caddy proxy), so an <img> whose src changed, or that mounted again after
// a case switch, fetched its file again, and frames showed late or blank on a real connection (3 October). Here each file
// is fetched once per page and a frame is drawn only once it has loaded. A failed file is tried again, a few times.
const store = new Map<string, HTMLImageElement>(), failures = new Map<string, number>(), wakers = new Set<() => void>();
export const retries = 5;
const loaded = (img: HTMLImageElement) => img.complete && img.naturalWidth > 0;
/** The stored image for a frame file, fetched the first time. `mounting` is true only when a figure mounts: a file that
 *  failed and used up its retries is then tried afresh (a case switch); drawing never restarts the retries. */
export function frameImage(url: string, mounting = false): HTMLImageElement {
  const known = store.get(url);
  if (known && !(mounting && known.complete && known.naturalWidth === 0 && (failures.get(url) ?? 0) > retries)) return known;
  if (known) failures.delete(url);
  const img = new Image();
  img.addEventListener('load', () => { failures.delete(url); wakers.forEach(wake => wake()); }, { once: true });
  img.addEventListener('error', () => {
    const tries = (failures.get(url) ?? 0) + 1; failures.set(url, tries);
    if (tries <= retries) setTimeout(() => { if (store.get(url) === img) { store.delete(url); frameImage(url); } }, 1000 * 2 ** (tries - 1));
  }, { once: true });
  img.src = url; store.set(url, img);
  return img;
}

/**
 * One character frame. `frames` lists every frame the figure can show, idle still first; `current` is the one wanted;
 * `still` is true under reduced motion. Within one pose (the processing loop, the done action, the idle still) the frame
 * already drawn stays until the next one arrives. A new pose never keeps the old one: until its frame arrives the idle
 * still shows, or nothing. The canvas carries the frame on show in `data-frame` (empty when nothing is drawn).
 */
export default function FrameCanvas({ base, frames, current, still = false, className = 'otter-source' }: { base: string; frames: readonly string[]; current: string; still?: boolean; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null), [arrivals, wake] = useReducer((n: number) => n + 1, 0), list = frames.join('|');
  useEffect(() => {
    wakers.add(wake);
    for (const frame of list.split('|')) frameImage(`${base}/${frame}`, true);
    return () => { wakers.delete(wake); };
  }, [base, list]);
  useEffect(() => {
    const canvas = ref.current, context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const idle = list.split('|')[0]!, pose = `${current.includes('/') ? current.split('/')[0] : 'idle'}|${still ? 'still' : 'moving'}`;
    const wanted = frameImage(`${base}/${current}`), rest = frameImage(`${base}/${idle}`);
    if (!loaded(wanted) && canvas.dataset.frame && canvas.dataset.pose === pose) return;
    const [img, name] = loaded(wanted) ? [wanted, current] : loaded(rest) ? [rest, idle] : [null, ''];
    const frame = name && `${base}/${name}`;
    if (canvas.dataset.frame === frame && canvas.dataset.pose === pose) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (img) context.drawImage(img, 0, 0, canvas.width, canvas.height);
    canvas.dataset.frame = frame; canvas.dataset.pose = pose;
  }, [base, current, still, list, arrivals]);
  return <canvas ref={ref} className={className} width={128} height={128} aria-hidden="true" />;
}
