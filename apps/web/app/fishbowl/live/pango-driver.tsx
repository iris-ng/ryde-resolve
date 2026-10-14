'use client';
import { useEffect, useRef, useState } from 'react';
import { PangoEngine, type PangoSnapshot, type PangoState } from '../../../../../packages/live-fishbowl/pango-engine';
import { useReducedMotion } from './motion';
import { doneRepeatMs } from '../../../../../packages/live-fishbowl/sprite-engine';
import FrameCanvas from './frame-canvas';
import './otter-judge.css';

const base = '/pango/native';
const frames = ['idle.png', ...Array.from({ length: 8 }, (_, i) => `processing/frame_${i}.png`), ...Array.from({ length: 9 }, (_, i) => `done/frame_${i}.png`)];
const same = (a: PangoSnapshot, b: PangoSnapshot) => a.action === b.action && a.state === b.state && a.processingFrame === b.processingFrame && a.doneFrame === b.doneFrame;

export default function PangoDriver({ state }: { state: PangoState }) {
  const engine = useRef<PangoEngine | null>(null);
  engine.current ??= new PangoEngine(doneRepeatMs);
  const [shot, setShot] = useState(() => engine.current!.snapshot());
  const reduced = useReducedMotion();

  useEffect(() => {
    const e = engine.current!;
    const first = e.setState(state);
    setShot(old => same(old, first) ? old : first);
    // A finished driver keeps its clock running: the honk repeats after a hold on the idle still.
    const still = (s: PangoSnapshot) => s.action === 'idle' || (s.action === 'rest' && s.state !== 'done');
    if (reduced || still(first)) return;
    let id = 0, timer: ReturnType<typeof setTimeout> | undefined, slept = 0, last = performance.now();
    // Each frame on the animation clock; during a rest before a repeat, one timer to its end instead.
    const show = (next: PangoSnapshot) => {
      setShot(old => same(old, next) ? old : next);
      if (still(next)) return;
      const wait = e.restRemaining();
      if (wait !== null) { slept = performance.now(); timer = setTimeout(() => { timer = undefined; last = performance.now(); show(e.advance(wait)); }, wait); return; }
      id = requestAnimationFrame(tick);
    };
    const tick = (now: number) => {
      // A frame timestamp can precede the effect's start time; never step the clock backwards.
      const next = e.advance(Math.max(0, Math.min(now - last, 100))); last = Math.max(last, now);
      show(next);
    };
    id = requestAnimationFrame(tick);
    // Cancelled mid-rest (a state or setting change), the time already slept still counts toward the hold.
    return () => { cancelAnimationFrame(id); if (timer !== undefined) { clearTimeout(timer); e.advance(Math.max(0, performance.now() - slept)); } };
  }, [state, reduced]);

  // Reduced motion shows still poses: the first steering frame while working, the idle still otherwise.
  const s: PangoSnapshot = reduced ? { state, action: state === 'done' ? 'rest' : state === 'idle' ? 'idle' : 'processing', processingFrame: 0, doneFrame: 0 } : shot;
  const source = s.action === 'processing' || s.action === 'finishing' ? `processing/frame_${s.processingFrame}.png` : s.action === 'honk' ? `done/frame_${s.doneFrame}.png` : 'idle.png';
  return <span className="pango-driver" aria-hidden="true" data-state={state} data-action={s.action}>
    <FrameCanvas base={base} frames={frames} current={source} still={reduced} />
  </span>;
}
