// Frame clock for the supplied three-state character artwork (fish, 3 October; frog and rooster, 5 October). Same contract as the
// pangolin's engine: reading and thinking share one processing loop and switching between them keeps the frame; done
// finishes the current processing cycle, plays the done frames once, then rests on the idle still; with a repeat time it
// plays them again after that long at rest, for as long as the agent stays done (user request, 3 October). Each pack's manifest
// gives its frame times, so a frame can hold longer than the next. No labels, dots or tick: the desk card's colour shows
// the state.
export const spriteStates = ['idle', 'reading', 'thinking', 'done'] as const;
export type SpriteState = typeof spriteStates[number];
export type SpriteAction = 'idle' | 'processing' | 'finishing' | 'done' | 'rest';
export type SpriteSnapshot = { state: SpriteState; action: SpriteAction; processingFrame: number; doneFrame: number };
/** Milliseconds per frame, in order: the processing loop and the one-shot done action. */
export type SpriteSpec = { processing: readonly number[]; done: readonly number[] };

const times = (count: number, ms: number) => Array.from({ length: count }, () => ms);
/** From each pack's manifest.json (fish-resolution-lab-two-state-v2, frog-three-state, rooster-three-state). */
export const characters = {
  fish: { processing: times(8, 100), done: [500, 200, 200, 200, 1100] },
  frog: { processing: times(9, 120), done: [500, 120, 120, 120, 120, 120, 120, 120, 900] },
  rooster: { processing: times(9, 120), done: times(9, 120) },
} as const satisfies Record<string, SpriteSpec>;
export type Character = keyof typeof characters;
/** A finished agent repeats its done action after this long on its idle still (user request, 3 October). */
export const doneRepeatMs = 2000;

export class SpriteEngine {
  private state: SpriteState = 'idle';
  private action: SpriteAction = 'idle';
  private processingFrame = 0;
  private doneFrame = 0;
  private accumulator = 0;

  /** `repeatAfterMs` > 0 replays the done action after that long at rest, for as long as the state stays done. */
  constructor(private readonly spec: SpriteSpec, private readonly repeatAfterMs = 0) {
    if (!spec.processing.length || !spec.done.length || [...spec.processing, ...spec.done].some(ms => !Number.isFinite(ms) || ms <= 0)) throw new RangeError('Every frame needs a positive duration');
  }

  reset(): SpriteSnapshot {
    this.state = 'idle'; this.action = 'idle'; this.processingFrame = 0; this.doneFrame = 0; this.accumulator = 0;
    return this.snapshot();
  }

  setState(next: SpriteState): SpriteSnapshot {
    if (!spriteStates.includes(next)) throw new RangeError(`Invalid sprite state: ${next}`);
    if (next === 'idle') return this.reset();
    if (next === 'reading' || next === 'thinking') {
      if (this.action === 'processing' && (this.state === 'reading' || this.state === 'thinking')) { this.state = next; return this.snapshot(); }
      this.state = next; this.action = 'processing'; this.processingFrame = 0; this.doneFrame = 0; this.accumulator = 0;
      return this.snapshot();
    }
    if (this.state === 'done') return this.snapshot();
    // From the loop, keep the time already spent on the current frame; anything else starts the done action fresh.
    this.state = 'done'; this.doneFrame = 0;
    if (this.action === 'processing') this.action = 'finishing';
    else { this.action = 'done'; this.accumulator = 0; }
    return this.snapshot();
  }

  advance(ms: number): SpriteSnapshot {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError('advance(ms) requires non-negative finite ms');
    const repeats = this.state === 'done' && this.repeatAfterMs > 0;
    if (this.action === 'idle' || (this.action === 'rest' && !repeats)) { this.accumulator = 0; return this.snapshot(); }
    this.accumulator += ms;
    for (;;) {
      if (this.action === 'processing' || this.action === 'finishing') {
        const hold = this.spec.processing[this.processingFrame]!;
        if (this.accumulator < hold) break;
        this.accumulator -= hold;
        this.processingFrame = (this.processingFrame + 1) % this.spec.processing.length;
        // The leftover time carries into the done action, so one long step lands where many short ones would.
        if (this.action === 'finishing' && this.processingFrame === 0) { this.action = 'done'; this.doneFrame = 0; }
      } else if (this.action === 'done') {
        const hold = this.spec.done[this.doneFrame]!;
        if (this.accumulator < hold) break;
        this.accumulator -= hold;
        if (this.doneFrame < this.spec.done.length - 1) this.doneFrame++;
        else { this.action = 'rest'; this.doneFrame = 0; if (!repeats) { this.accumulator = 0; break; } }
      } else if (this.action === 'rest') {
        // Repeating: after the hold on the idle still, the done action plays again; the leftover time carries on.
        if (this.accumulator < this.repeatAfterMs) break;
        this.accumulator -= this.repeatAfterMs; this.action = 'done'; this.doneFrame = 0;
      } else break;
    }
    return this.snapshot();
  }

  /** While resting before a repeat, the milliseconds until the done action plays again (so a caller can sleep); else null. */
  restRemaining(): number | null { return this.action === 'rest' && this.state === 'done' && this.repeatAfterMs > 0 ? Math.max(0, this.repeatAfterMs - this.accumulator) : null; }

  snapshot(): SpriteSnapshot {
    return { state: this.state, action: this.action, processingFrame: this.processingFrame, doneFrame: this.doneFrame };
  }
}
