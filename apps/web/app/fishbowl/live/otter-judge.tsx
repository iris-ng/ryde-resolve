'use client';
import { useEffect, useRef, useState } from 'react';
import type { DeskState } from '../../../../../packages/live-fishbowl/desk-state';
import { useReducedMotion } from './motion';
import { doneRepeatMs } from '../../../../../packages/live-fishbowl/sprite-engine';
import FrameCanvas from './frame-canvas';
import './otter-judge.css';

// Otter Judge, two-state pack v3. Reading and thinking share one 8-frame loop at 10 fps that starts at frame 0
// (no entry animation). Done plays frames 0..8 once (0.9 s), then rests on the idle still. No labels, dots or
// tick: the desk card's colour shows the state.
export type JudgeState = 'idle' | 'reading' | 'thinking' | 'done';
type Phase = 'idle' | 'processing' | 'done' | 'rest';
const base = '/otter/native/sources';
const frames = ['idle_native.png', ...Array.from({ length: 8 }, (_, i) => `processing_loop/frame_${i}.png`), ...Array.from({ length: 9 }, (_, i) => `done/done_${i}.png`)];

export function judgeState(desk: DeskState): JudgeState {
  if (desk.status === 'ready' || desk.status === 'sealed') return 'done';
  if (desk.status === 'working') return desk.detail ? 'reading' : 'thinking';
  return 'idle';
}

export default function OtterJudge({ state }: { state: JudgeState }) {
  const timeline = useRef({ phase: 'idle' as Phase, elapsed: 0, state: 'idle' as JudgeState });
  const [shot, setShot] = useState({ phase: 'idle' as Phase, elapsed: 0 });
  const reduced = useReducedMotion();

  useEffect(() => {
    const t = timeline.current;
    if (t.state !== state) {
      if (state === 'idle') { t.phase = 'idle'; t.elapsed = 0; }
      else if (state === 'done') { t.phase = 'done'; t.elapsed = 0; }
      else if (t.phase !== 'processing') { t.phase = 'processing'; t.elapsed = 0; }
      t.state = state;
    }
    setShot({ phase: t.phase, elapsed: t.elapsed });
  }, [state]);

  useEffect(() => {
    // A finished judge keeps its clock running: the done action repeats after a hold on the idle still.
    if (reduced || timeline.current.phase === 'idle' || (timeline.current.phase === 'rest' && state !== 'done')) return;
    let id = 0, timer: ReturnType<typeof setTimeout> | undefined, slept = 0, last = performance.now(), lastFrame = -1;
    // At rest before a repeat, one timer to the end of the hold instead of a callback every frame.
    const sleep = () => {
      slept = performance.now();
      timer = setTimeout(() => { timer = undefined; const t = timeline.current; t.phase = 'done'; t.elapsed = 0; lastFrame = 0; setShot({ phase: 'done', elapsed: 0 }); last = performance.now(); id = requestAnimationFrame(tick); }, Math.max(0, doneRepeatMs - timeline.current.elapsed));
    };
    const tick = (now: number) => {
      const t = timeline.current;
      // A frame timestamp can precede the effect's start time; never step the clock backwards.
      t.elapsed += Math.max(0, Math.min(now - last, 100)); last = Math.max(last, now);
      // The time past the end of the done action counts toward the rest.
      if (t.phase === 'done' && t.elapsed >= 900) { t.phase = 'rest'; t.elapsed -= 900; setShot({ phase: 'rest', elapsed: 0 }); sleep(); return; }
      if (t.phase === 'rest') { sleep(); return; }
      const frame = Math.floor(t.elapsed / 100);
      if (frame !== lastFrame) { setShot({ phase: t.phase, elapsed: t.elapsed }); lastFrame = frame; }
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    // Cancelled mid-rest (a state or setting change), the time already slept still counts toward the hold.
    return () => { cancelAnimationFrame(id); if (timer !== undefined) { clearTimeout(timer); timeline.current.elapsed += Math.max(0, performance.now() - slept); } };
  }, [reduced, state]);

  // Reduced motion shows stills: the first loop frame while working, the idle still otherwise.
  const phase: Phase = reduced ? (state === 'reading' || state === 'thinking' ? 'processing' : state === 'done' ? 'rest' : 'idle') : shot.phase;
  const frame = reduced ? 0 : Math.floor(shot.elapsed / 100);
  const source = phase === 'processing' ? `processing_loop/frame_${frame % 8}.png` : phase === 'done' ? `done/done_${Math.min(frame, 8)}.png` : 'idle_native.png';
  return <span className="otter-judge" aria-hidden="true" data-state={state} data-phase={phase}>
    <FrameCanvas base={base} frames={frames} current={source} still={reduced} />
  </span>;
}
