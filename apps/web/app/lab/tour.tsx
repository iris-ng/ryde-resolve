'use client';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { splitsAt, stepsFor, tourWords } from './tour-steps';
import RydeCar from './ryde-car';
import { arrowX } from './tour-geometry';
import './tour.css';

// The walkthrough (user request, 6 October): the page goes dark and blurred except one bright box around the part being explained,
// with a card beside it and an arrow from the card to the box. A step can light a second part with its own card and arrow
// (user, 8 October); that card holds only its words, and the first card keeps the buttons. It opens by itself on a first visit (lab.tsx) and from
// the top bar's Walkthrough button. A modal dialog, so the page underneath cannot be clicked and Escape closes it; other
// dialogs that open by themselves (the case summary) wait for it, since they wait for any open dialog. The animations
// chip and the system's reduced-motion setting turn its fades and glides off (styles.css).
type Box = { top: number; left: number; width: number; height: number };
type Arrow = { from: [number, number]; to: [number, number]; straight?: boolean };
type Place = { top: number; left: number; width: number; height: number; arrow: Arrow | null };
// The card grows with the window: a third of its width, between 360 and 560 pixels; phones use the full width.
const PAD = 8, GAP = 44, PHONE_GAP = 56, EDGE = 16, CARD_MIN = 360, CARD_MAX = 560, NARROW = 640;

// One box around every visible part the step names, a little larger than them and kept on the screen.
function measure(selectors: string[] | undefined): Box | null {
  if (!selectors) return null;
  const rects = selectors.flatMap(s => [...document.querySelectorAll<HTMLElement>(s)]).map(el => el.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0);
  if (!rects.length) return null;
  const top = Math.max(4, Math.min(...rects.map(r => r.top)) - PAD), left = Math.max(4, Math.min(...rects.map(r => r.left)) - PAD);
  const bottom = Math.min(innerHeight - 4, Math.max(...rects.map(r => r.bottom)) + PAD), right = Math.min(innerWidth - 4, Math.max(...rects.map(r => r.right)) + PAD);
  return bottom - top < 8 || right - left < 8 ? null : { top, left, width: right - left, height: bottom - top };
}
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
// Two lit boxes keep a clear gap (user, 8 October: the Evidence Collector's box ran into the evidence pane's). They part
// along whichever way needs less, each giving up at most its own padding on the facing side, so each still holds its part.
const APART = 8;
export function apart(a: Box | null, b: Box | null): [Box | null, Box | null] {
  if (!a || !b) return [a, b];
  const ox = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left), oy = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  if (ox <= -APART || oy <= -APART) return [a, b];
  const needX = ox + APART, needY = oy + APART;
  if (needY <= needX && needY <= 2 * PAD) {
    const cut = needY / 2, first = a.top <= b.top;
    const up = first ? a : b, down = first ? b : a, u = { ...up, height: up.height - cut }, d = { ...down, top: down.top + cut, height: down.height - cut };
    return first ? [u, d] : [d, u];
  }
  if (needX <= 2 * PAD) {
    const cut = needX / 2, first = a.left <= b.left;
    const l = first ? a : b, r = first ? b : a, lb = { ...l, width: l.width - cut }, rb = { ...r, left: r.left + cut, width: r.width - cut };
    return first ? [lb, rb] : [rb, lb];
  }
  return [a, b];
}
// Where a line from a box's centre towards a point leaves the box, pushed `out` pixels further.
function exit(b: Box, toward: [number, number], out: number): [number, number] {
  const cx = b.left + b.width / 2, cy = b.top + b.height / 2, dx = toward[0] - cx, dy = toward[1] - cy, len = Math.hypot(dx, dy) || 1;
  const t = Math.min(dx ? b.width / 2 / Math.abs(dx) : Infinity, dy ? b.height / 2 / Math.abs(dy) : Infinity);
  return [cx + dx * t + dx / len * out, cy + dy * t + dy / len * out];
}
const overlaps = (a: Box, b: Box) => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
// The card goes below, above, right or left of the box, whichever fits first, and clear of `avoid` (the other part and its
// card on a two-part step): beside the box it may slide along that side to get clear. A phone keeps it full width, under the box
// or over it, a short way off (user, 7 October: docked at the screen's top or bottom it could sit far from its box; at
// 28px it sat too close and its arrow was a stub), with a straight up-or-down arrow lined up with the box. A box too big
// for any side (a pane filling the screen) gets the card inside it, near its bottom, clear of the pane's heading and
// newest messages at the top, without an arrow.
function place(hole: Box | null, height: number, avoid: Box[] = []): Place {
  const vw = innerWidth, vh = innerHeight, width = vw <= NARROW ? vw - 2 * EDGE : Math.round(clamp(vw * 0.34, CARD_MIN, Math.min(CARD_MAX, vw - 2 * EDGE)));
  const arrowTo = (card: Box) => { if (!hole || overlaps(card, hole)) return null; const c: [number, number] = [hole.left + hole.width / 2, hole.top + hole.height / 2], cc: [number, number] = [card.left + card.width / 2, card.top + card.height / 2]; return { from: exit(card, c, 6), to: exit(hole, cc, 8) }; };
  if (!hole) return { top: Math.max(EDGE, (vh - height) / 2), left: (vw - width) / 2, width, height, arrow: null };
  if (vw <= NARROW) {
    const below = { top: hole.top + hole.height + PHONE_GAP, left: EDGE, width, height }, above = { top: hole.top - PHONE_GAP - height, left: EDGE, width, height };
    const card = below.top + height <= vh - EDGE ? below : above.top >= EDGE ? above : null;
    if (!card) return { top: vh - EDGE - height, left: EDGE, width, height, arrow: null };
    const x = arrowX(card.left, card.left + width, hole.left, hole.left + hole.width), under = card === below;
    if (x === null) return { ...card, arrow: null };
    return { ...card, arrow: { from: [x, under ? card.top - 6 : card.top + height + 6], to: [x, under ? hole.top + hole.height + 8 : hole.top - 8], straight: true } };
  }
  const midX = clamp(hole.left + hole.width / 2 - width / 2, EDGE, vw - EDGE - width), midY = clamp(hole.top + hole.height / 2 - height / 2, EDGE, vh - EDGE - height);
  const lefts = [midX, ...avoid.flatMap(a => [a.left + a.width + 16, a.left - 16 - width])].map(l => clamp(l, EDGE, vw - EDGE - width));
  const tops = [midY, ...avoid.flatMap(a => [a.top + a.height + 16, a.top - 16 - height])].map(t => clamp(t, EDGE, vh - EDGE - height));
  // Each side as it was first, then slid along it; a slid card still faces its box over at least 40px (half a smaller box), so it never ends
  // up beside something else with a long arrow back (8 October preview: the pane's card sat by the agent cards).
  const sides = (list: number[]) => [
    list.map(left => ({ top: hole.top + hole.height + GAP, left, width, height })),
    list.map(left => ({ top: hole.top - GAP - height, left, width, height })),
  ];
  const ends = (list: number[]) => [
    list.map(top => ({ top, left: hole.left + hole.width + GAP, width, height })),
    list.map(top => ({ top, left: hole.left - GAP - width, width, height })),
  ];
  const [below, above] = sides(lefts), [right, left] = ends(tops);
  const tries: Box[] = [below[0], above[0], right[0], left[0], ...below.slice(1), ...above.slice(1), ...right.slice(1), ...left.slice(1)];
  const faces = (c: Box) => c.top >= hole.top + hole.height || c.top + height <= hole.top
    ? Math.min(c.left + width, hole.left + hole.width) - Math.max(c.left, hole.left) >= Math.min(40, hole.width / 2)
    : Math.min(c.top + height, hole.top + hole.height) - Math.max(c.top, hole.top) >= Math.min(40, hole.height / 2);
  const fits = tries.find(c => c.top >= EDGE && c.left >= EDGE && c.top + height <= vh - EDGE && c.left + width <= vw - EDGE && faces(c) && !avoid.some(a => overlaps(c, a)));
  if (fits) return { ...fits, arrow: arrowTo(fits) };
  const inside = [hole.top + hole.height - height - 24, hole.top + 24].map(t => ({ top: clamp(t, EDGE, vh - EDGE - height), left: midX, width, height }));
  return { ...(inside.find(c => !avoid.some(a => overlaps(c, a))) ?? inside[0]), arrow: null };
}
// The dark layer's outline: the whole screen with each box cut out. A missing box is a zero-size cut in the middle of
// the first box (or of the screen), so there are always two cuts with the same commands and the browser can glide them
// from one step to the next, the second box growing out of the first.
const n1 = (v: number) => v.toFixed(1);
function dimPath(boxes: (Box | null)[], vw: number, vh: number) {
  const first = boxes.find(Boolean);
  const cut = (b: Box | null | undefined) => {
    const x = b ? b.left : first ? first.left + first.width / 2 : vw / 2, y = b ? b.top : first ? first.top + first.height / 2 : vh / 2, w = b ? b.width : 0, h = b ? b.height : 0, r = b ? Math.min(14, w / 2, h / 2) : 0;
    return `M${n1(x + r)} ${n1(y)}H${n1(x + w - r)}A${n1(r)} ${n1(r)} 0 0 1 ${n1(x + w)} ${n1(y + r)}V${n1(y + h - r)}A${n1(r)} ${n1(r)} 0 0 1 ${n1(x + w - r)} ${n1(y + h)}H${n1(x + r)}A${n1(r)} ${n1(r)} 0 0 1 ${n1(x)} ${n1(y + h - r)}V${n1(y + r)}A${n1(r)} ${n1(r)} 0 0 1 ${n1(x + r)} ${n1(y)}Z`;
  };
  return `path(evenodd, "M0 0H${n1(vw)}V${n1(vh)}H0Z ${cut(boxes[0])} ${cut(boxes[1])}")`;
}
// Hand-drawn arrows (user choice, 7 October: the pen, from the walkthrough accents page): one ink stroke bowing to one
// side with a slow, small wobble, drawn as stacked strokes so it is thin at the ends and thicker in the middle, and an
// uneven two-stroke head. The start moves a little along the card's edge so a short arrow still has room to curve. Each
// arrow has a fixed seed, so it is the same every time its step shows. Drawn from 140ms over 300ms, the head after.
type Pt = [number, number];
const N = 32, T0 = 140, DUR = 300;
const PEN = { layers: [[0, 1, 1.5], [0.06, 0.94, 2.3], [0.2, 0.78, 3.1]], head: 2.3, size: 11, bend: 0.22, minBend: 6, wobble: 0.7 };
function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function shiftStart(c: Box, from: Pt, s: number): Pt {
  const d = [Math.abs(from[0] - c.left), Math.abs(from[0] - c.left - c.width), Math.abs(from[1] - c.top), Math.abs(from[1] - c.top - c.height)], m = Math.min(...d);
  return m === d[2] || m === d[3] ? [clamp(from[0] + s, c.left + 20, c.left + c.width - 20), from[1]] : [from[0], clamp(from[1] + s, c.top + 20, c.top + c.height - 20)];
}
function handLine(from: Pt, to: Pt, r: () => number, side: number): Pt[] {
  const dx = to[0] - from[0], dy = to[1] - from[1], len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len;
  const bend = side * clamp(len * PEN.bend, PEN.minBend, 26), k1 = bend * (0.9 + r() * 0.4), k2 = bend * (0.3 + r() * 0.4);
  const p1: Pt = [from[0] + dx * 0.3 + nx * k1, from[1] + dy * 0.3 + ny * k1], p2: Pt = [from[0] + dx * 0.72 + nx * k2, from[1] + dy * 0.72 + ny * k2];
  const amp = PEN.wobble * (0.5 + r() * 0.5), ph = r() * Math.PI * 2, fr = 1 + r(), pts: Pt[] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N, u = 1 - t, w = amp * Math.sin(2 * Math.PI * fr * t + ph) * Math.sin(Math.PI * t);
    pts.push([u * u * u * from[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * to[0] + nx * w, u * u * u * from[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * to[1] + ny * w]);
  }
  return pts;
}
// The head: one stroke up one barb to the tip and down the other, the barbs of different length and angle.
function handHead(pts: Pt[], r: () => number, size: number) {
  const tip = pts[pts.length - 1], back = pts[pts.length - 5], l = Math.hypot(tip[0] - back[0], tip[1] - back[1]) || 1, ux = (tip[0] - back[0]) / l, uy = (tip[1] - back[1]) / l;
  const barb = (deg: number, len: number): Pt => { const a = deg * Math.PI / 180, x = ux * Math.cos(a) - uy * Math.sin(a), y = ux * Math.sin(a) + uy * Math.cos(a); return [tip[0] - x * len, tip[1] - y * len]; };
  const b1 = barb(24 + r() * 10, size * (1 + r() * 0.3)), b2 = barb(-(28 + r() * 10), size * (0.8 + r() * 0.3)), top: Pt = [tip[0] + ux * 1.2, tip[1] + uy * 1.2];
  const bow = (a: Pt, b: Pt, k: number): Pt => { const ex = b[0] - a[0], ey = b[1] - a[1], el = Math.hypot(ex, ey) || 1; return [(a[0] + b[0]) / 2 - ey / el * k, (a[1] + b[1]) / 2 + ex / el * k]; };
  const c1 = bow(b1, top, 0.8 + r() * 0.6), c2 = bow(top, b2, 0.8 + r() * 0.6);
  return `M${n1(b1[0])} ${n1(b1[1])}Q${n1(c1[0])} ${n1(c1[1])} ${n1(top[0])} ${n1(top[1])}Q${n1(c2[0])} ${n1(c2[1])} ${n1(b2[0])} ${n1(b2[1])}`;
}
export function penStrokes(card: Box, arrow: Arrow, seed: number): { d: string; width: number; at: number; dur: number }[] {
  const r = rng(seed), sign = r() < 0.5 ? -1 : 1, from = shiftStart(card, arrow.from, sign * (arrow.straight ? 14 + r() * 8 : 22 + r() * 14)), to = arrow.to;
  const dx = to[0] - from[0], dy = to[1] - from[1], len = Math.hypot(dx, dy) || 1;
  const side = Math.sign((from[0] - arrow.from[0]) * (-dy / len) + (from[1] - arrow.from[1]) * (dx / len)) || sign, pts = handLine(from, to, r, side);
  const line = (p: Pt[]) => 'M' + p.map(q => n1(q[0]) + ' ' + n1(q[1])).join('L');
  return [...PEN.layers.map(([a, b, width]) => ({ d: line(pts.slice(Math.round(a * N), Math.round(b * N) + 1)), width, at: T0 + a * DUR, dur: (b - a) * DUR })),
    { d: handHead(pts, r, PEN.size), width: PEN.head, at: T0 + DUR, dur: 150 }];
}
// A card's words, with the chosen ones underlined in a pink pen stroke (tour.css).
const Words = ({ text }: { text: string }) => <>{tourWords(text).map((p, i) => p.em ? <span key={i} className="lab-tour-em">{p.text}</span> : p.text)}</>;

const WORD = 'Ryde Resolve';
const sameBox = (a: Box | null, b: Box | null) => a === b || (!!a && !!b && Math.abs(a.top - b.top) + Math.abs(a.left - b.left) + Math.abs(a.width - b.width) + Math.abs(a.height - b.height) < 1);

/** `onPane`: shows a pane on phones and tablets, which show one at a time. `opener`: where focus goes back on closing. */
export default function Tour({ onClose, onPane, opener }: { onClose: () => void; onPane: (pane: string) => void; opener: RefObject<HTMLElement | null> }) {
  const box = useRef<HTMLDialogElement>(null), card = useRef<HTMLDivElement>(null), note = useRef<HTMLDivElement>(null), next = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ base: number; part: 'main' | 'also' }>({ base: 0, part: 'main' }), [holes, setHoles] = useState<[Box | null, Box | null]>([null, null]), [spots, setSpots] = useState<[Place | null, Place | null]>([null, null]);
  const spot = spots[0];
  // The opening (user request, 7 October): "Ryde Resolve" writes itself on the plain page colour while the car drives in
  // and out, then fades to the blurred page and the first card (tour.css). About three seconds; a click or a key skips
  // it. It plays even with motion off (user, 7 October: the animations chip sits behind it, so it could not be turned on
  // in time); the rest of the walkthrough still follows that setting. A timer ends it too, in case the fade's end never
  // arrives (a hidden tab).
  const [intro, setIntro] = useState(true), endIntro = useCallback(() => setIntro(false), []);
  useEffect(() => { if (!intro) return; const t = setTimeout(endIntro, 3600); return () => clearTimeout(t); }, [intro, endIntro]);
  const [view, setView] = useState(() => ({ w: innerWidth, h: innerHeight }));
  // A two-part step whose two cards cannot both sit clear of the other card and box splits in two at that window size, as
  // on a phone; another window size tries both cards again.
  const [crowded, setCrowded] = useState(''), size = view.w + 'x' + view.h, sizeNow = useRef(size); sizeNow.current = size;
  const tourSteps = useMemo(() => stepsFor(splitsAt(view.w, view.h) || crowded === size), [view.w, view.h, crowded, size]);
  // The walkthrough holds the step itself, not its number: a resize that splits or joins steps keeps the same step (or,
  // for a second part shown on its own, its first part) without drawing its card again, so focus stays on the same
  // button.
  const found = tourSteps.findIndex(s => s.base === pos.base && s.part === pos.part), at = found >= 0 ? found : Math.max(0, tourSteps.findIndex(s => s.base === pos.base));
  const current = tourSteps[at], stepId = current.base + current.part, last = at === tourSteps.length - 1, pane = current.pane ?? current.also?.pane;
  // Opened before the card is measured (layout effects run in order), since a closed dialog's card has no height.
  useLayoutEffect(() => {
    // Opening a modal dialog focuses its first button (the close cross); the dialog takes focus instead.
    const d = box.current!, back = opener.current; if (!d.open) d.showModal(); d.focus({ preventScroll: true });
    return () => { d.close(); if (back?.isConnected) back.focus({ preventScroll: true }); };
  }, [opener]);
  // A new step shows its pane, brings its part into view, then measures it. Parts that are still loading (the case the
  // tour opened) or that move (resizing, scrolling, a run going on) are measured again a few times a second.
  useEffect(() => {
    if (pane) onPane(pane);
    const both = (): [Box | null, Box | null] => apart(measure(current.target), measure(current.also?.target));
    let frame = requestAnimationFrame(() => {
      const first = current.target?.map(s => document.querySelector<HTMLElement>(s)).find(Boolean);
      first?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      frame = requestAnimationFrame(() => setHoles(both()));
    });
    // A pane the page swapped back meanwhile (a case finishing loading picks its own pane on phones) is shown again.
    const again = () => { const m = both(); if (pane && ((current.target && !m[0]) || (current.also && !m[1]))) onPane(pane); setHoles(h => sameBox(h[0], m[0]) && sameBox(h[1], m[1]) ? h : m); };
    const timer = setInterval(again, 300);
    const resize = () => { setView({ w: innerWidth, h: innerHeight }); again(); };
    addEventListener('resize', resize); addEventListener('scroll', again, true);
    return () => { cancelAnimationFrame(frame); clearInterval(timer); removeEventListener('resize', resize); removeEventListener('scroll', again, true); };
  }, [current, pane, onPane]);
  // The card is measured after it draws, then placed beside the box; a window resize places it again. Its height depends
  // on its width, which the first placing sets, so when the drawn height differs it is placed once more.
  // A second part's card is placed after the first, clear of the first card and of both boxes.
  const also = !!current.also;
  const arrange = useCallback((hs: [Box | null, Box | null], h1: number, h2: number): [Place, Place | null] => {
    const first = place(hs[0], h1, hs[1] ? [hs[1]] : []);
    return [first, also && hs[1] ? place(hs[1], h2, [hs[0], first].filter((b): b is Box => !!b)) : null];
  }, [also]);
  const heights = () => [card.current?.offsetHeight || 200, note.current?.offsetHeight || 120] as const;
  const show = useCallback(([a, b]: [Place, Place | null], hs: [Box | null, Box | null]) => {
    if (b && (overlaps(a, b) || (hs[1] && overlaps(a, hs[1])) || (hs[0] && overlaps(b, hs[0])))) setCrowded(sizeNow.current);
    setSpots([a, b]);
  }, []);
  useLayoutEffect(() => { show(arrange(holes, ...heights()), holes); }, [holes, stepId, view, arrange, show]);
  useLayoutEffect(() => { const [h1, h2] = heights(), [a, b] = spots; if (a && (Math.abs(h1 - a.height) > 1 || (b && Math.abs(h2 - b.height) > 1))) show(arrange(holes, h1, h2), holes); }, [spots, holes, arrange, show]);
  // A card can also change size on its own, for example when the fonts finish loading and the text wraps differently:
  // place them again then, so the buttons never end up below the screen.
  const holesNow = useRef(holes); holesNow.current = holes;
  const arrangeNow = useRef(arrange); arrangeNow.current = arrange;
  const spotsNow = useRef(spots); spotsNow.current = spots;
  useEffect(() => {
    const els = [card.current, note.current].filter((e): e is HTMLDivElement => !!e); if (!els.length || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { const [h1, h2] = heights(), sp = spotsNow.current; if (sp[0] && (Math.abs(h1 - sp[0].height) > 1 || (sp[1] && Math.abs(h2 - sp[1].height) > 1))) show(arrangeNow.current(holesNow.current, h1, h2), holesNow.current); });
    els.forEach(e => ro.observe(e)); return () => ro.disconnect();
  }, [stepId, show]);
  // Focus starts on the dialog itself, which draws no ring; Enter and the arrow keys move from there, Tab reaches the
  // buttons. The card's own buttons are arrows too (user request, 6 October): back, forward, and Done on the last card;
  // the cross closes the tour at any point. Each step draws a new card, so a step reached by pressing Next or Back puts focus on the new Next: after a
  // click it shows no ring, after a key press it keeps the keyboard's ring. Focus waits for the first placing, since a
  // hidden card cannot take it.
  const placed = !!spot, fromButton = useRef(false);
  useEffect(() => {
    if (!placed) return;
    const d = box.current;
    if (fromButton.current) next.current?.focus({ preventScroll: true });
    else if (d && !d.contains(document.activeElement)) d.focus({ preventScroll: true });
    fromButton.current = false;
  }, [stepId, placed]);
  const go = useCallback((to: number) => { if (to >= tourSteps.length) onClose(); else { const s = tourSteps[Math.max(0, to)]; setPos({ base: s.base, part: s.part }); } }, [onClose, tourSteps]);
  const press = (to: number) => { fromButton.current = true; go(to); };
  const keys = (e: React.KeyboardEvent) => {
    // A held key acts once: its repeats would race through the cards after skipping the opening.
    if (e.repeat) { if (e.key !== 'Escape' && e.key !== 'Tab') e.preventDefault(); return; }
    // During the opening any key skips it, Tab included (the card's buttons are hidden until then); Escape still closes,
    // and shortcuts with Cmd, Ctrl or Alt, or a modifier on its own, pass through. The first card then waits for the
    // next key.
    if (intro) { if (e.key === 'Escape' || e.metaKey || e.ctrlKey || e.altKey || ['Shift', 'Meta', 'Control', 'Alt'].includes(e.key)) return; e.preventDefault(); endIntro(); return; }
    if (e.key === 'ArrowRight' || (e.key === 'Enter' && e.target === e.currentTarget)) { e.preventDefault(); go(at + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(at - 1); }
  };
  const [hole, hole2] = holes, joinedCut = hole && hole2 && overlaps(hole, hole2);
  const cut = dimPath(joinedCut ? [{ top: Math.min(hole.top, hole2.top), left: Math.min(hole.left, hole2.left), width: Math.max(hole.left + hole.width, hole2.left + hole2.width) - Math.min(hole.left, hole2.left), height: Math.max(hole.top + hole.height, hole2.top + hole2.height) - Math.min(hole.top, hole2.top) }, null] : holes, view.w, view.h), centre = { top: view.h / 2, left: view.w / 2, width: 0, height: 0 };
  const arrows = spots.map((sp, i) => sp?.arrow ? <svg key={`arrow${stepId}-${i}`} className="lab-tour-arrow" data-part={i} aria-hidden="true">{penStrokes(sp, sp.arrow, (current.base + 1) * 7919 + (current.part === 'also' ? 31 : 0) + i * 104729).map((s, j) => <path key={j} d={s.d} pathLength={1} style={{ strokeWidth: s.width, animationDelay: Math.round(s.at) + 'ms', animationDuration: Math.round(s.dur) + 'ms' }} />)}</svg> : null);
  return <dialog ref={box} className={'lab-tour' + (intro ? ' intro' : '')} aria-label="Walkthrough" tabIndex={-1} style={{ '--tour-cut': cut } as CSSProperties} onCancel={e => { e.preventDefault(); onClose(); }} onKeyDown={keys}>
    <div className="lab-tour-dim" style={{ clipPath: cut }} aria-hidden="true" />
    <div className={'lab-tour-hole' + (hole ? '' : ' none')} style={hole ?? centre} aria-hidden="true" />
    <div className={'lab-tour-hole' + (hole2 ? '' : ' none')} style={hole2 ?? (hole ? { top: hole.top + hole.height / 2, left: hole.left + hole.width / 2, width: 0, height: 0 } : centre)} aria-hidden="true" />
    {arrows}
    <div key={stepId} ref={card} className="lab-tour-card" style={spot ? { top: spot.top, left: spot.left, width: spot.width } : { visibility: 'hidden' }} role="group" aria-roledescription="step" aria-label={`Step ${at + 1} of ${tourSteps.length}`}>
      <button type="button" className="quiet lab-tour-close" aria-label="Close the walkthrough" title="Close" onClick={onClose}>×</button>
      <p className="lab-tour-text"><Words text={current.text} /></p>
      <div className="lab-tour-foot">
        <span className="lab-tour-dots" aria-hidden="true">{tourSteps.map((_, i) => <i key={i} className={i === at ? 'on' : i < at ? 'done' : ''} />)}</span>
        <span className="lab-tour-actions">
          <button type="button" className="quiet lab-tour-step" aria-label="Back" title="Back (left arrow key)" disabled={at === 0} onClick={() => press(at - 1)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6" /></svg></button>
          <button ref={next} type="button" className={'primary' + (last ? '' : ' lab-tour-step')} aria-label={last ? 'Done' : 'Next'} title={last ? 'Close the walkthrough' : 'Next (right arrow key)'} onClick={() => press(at + 1)}>{last ? 'Done' : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>}</button>
        </span>
      </div>
    </div>
    {current.also && <div key={'note' + stepId} ref={note} className="lab-tour-card lab-tour-note" style={spots[1] ? { top: spots[1].top, left: spots[1].left, width: spots[1].width } : { visibility: 'hidden' }} role="note">
      <p className="lab-tour-text"><Words text={current.also.text} /></p>
    </div>}
    {intro && <div className="lab-tour-hero" aria-hidden="true" onClick={endIntro} onAnimationEnd={e => { if (e.target === e.currentTarget) endIntro(); }}>
      <div className="lab-hero-stage">
        <p className="lab-hero-word">{[...WORD].map((ch, i) => <span key={i} className={i > 4 ? 'resolve' : undefined} style={{ '--i': i } as CSSProperties}>{ch === ' ' ? '\u00a0' : ch}</span>)}</p>
        <div className="lab-hero-road"><span className="lab-hero-line" /><RydeCar className="lab-hero-car" /></div>
      </div>
    </div>}
  </dialog>;
}

// Whether this browser has had the walkthrough. Blocked storage counts as seen: the page could not remember a close, so
// opening it by itself would repeat on every visit.
const SEEN_KEY = 'lab-tour-seen';
// Seen once per browser (the old rule); a tab that marked the explainer video shown (8 October's session marker, which the browser
// checks still set) counts too, so no test or returning viewer gets the walkthrough twice.
export function tourSeen() { try { return localStorage.getItem(SEEN_KEY) !== null || sessionStorage.getItem('lab-walkthrough-shown') !== null; } catch { return true; } }
export function markTourSeen() { try { localStorage.setItem(SEEN_KEY, new Date().toISOString()); } catch { /* storage blocked */ } }
