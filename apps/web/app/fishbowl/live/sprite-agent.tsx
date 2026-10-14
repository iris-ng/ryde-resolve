'use client';
import { useEffect, useRef, useState } from 'react';
import { characters, doneRepeatMs, SpriteEngine, type Character, type SpriteSnapshot, type SpriteState } from '../../../../../packages/live-fishbowl/sprite-engine';
import { useReducedMotion } from './motion';
import FrameCanvas from './frame-canvas';
import './otter-judge.css';

const same = (a: SpriteSnapshot, b: SpriteSnapshot) => a.action === b.action && a.state === b.state && a.processingFrame === b.processingFrame && a.doneFrame === b.doneFrame;

/** One of the supplied three-state characters (fish, frog, rooster), drawn like the pangolin driver. */
export default function SpriteAgent({ character, state }: { character: Character; state: SpriteState }) {
  const spec = characters[character], base = `/${character}/native`;
  const frames = ['idle.png', ...spec.processing.map((_, i) => `processing/frame_${i}.png`), ...spec.done.map((_, i) => `done/frame_${i}.png`)];
  const engine = useRef<SpriteEngine | null>(null);
  engine.current ??= new SpriteEngine(spec, doneRepeatMs);
  const [shot, setShot] = useState(() => engine.current!.snapshot());
  const reduced = useReducedMotion();

  useEffect(() => {
    const e = engine.current!;
    const first = e.setState(state);
    setShot(old => same(old, first) ? old : first);
    // A finished agent keeps its clock running: its done action repeats after a hold on the idle still.
    const still = (s: SpriteSnapshot) => s.action === 'idle' || (s.action === 'rest' && s.state !== 'done');
    if (reduced || still(first)) return;
    let id = 0, timer: ReturnType<typeof setTimeout> | undefined, slept = 0, last = performance.now();
    // Each frame on the animation clock; during a rest before a repeat, one timer to its end instead.
    const show = (next: SpriteSnapshot) => {
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

  // Reduced motion shows still poses: the first processing frame while working, the idle still otherwise.
  const s: SpriteSnapshot = reduced ? { state, action: state === 'done' ? 'rest' : state === 'idle' ? 'idle' : 'processing', processingFrame: 0, doneFrame: 0 } : shot;
  const source = s.action === 'processing' || s.action === 'finishing' ? `processing/frame_${s.processingFrame}.png` : s.action === 'done' ? `done/frame_${s.doneFrame}.png` : 'idle.png';
  return <span className="sprite-agent" aria-hidden="true" data-character={character} data-state={state} data-action={s.action}>
    <FrameCanvas base={base} frames={frames} current={source} still={reduced} />
  </span>;
}
