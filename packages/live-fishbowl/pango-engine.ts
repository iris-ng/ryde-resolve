// Frame clock for the pangolin driver artwork (pango-resolution-lab-two-state-v2).
// Reading and thinking share one 8-frame steering loop at 10 fps; switching keeps the frame.
// Done finishes the current steering cycle, plays the honk frames 0..8 once (0.9 s), then rests on the idle still;
// with a repeat time the honk plays again after that long at rest while the driver stays done (3 October).
// No labels, dots or tick: the desk card's colour shows the state.
export const pangoStates = ['idle', 'reading', 'thinking', 'done'] as const;
export type PangoState = typeof pangoStates[number];
export type PangoAction = 'idle' | 'processing' | 'finishing' | 'honk' | 'rest';
export type PangoSnapshot = { state: PangoState; action: PangoAction; processingFrame: number; doneFrame: number };

export class PangoEngine {
  private state: PangoState = 'idle';
  private action: PangoAction = 'idle';
  private processingFrame = 0;
  private doneFrame = 0;
  private accumulator = 0;
  private restElapsed = 0;
  /** `repeatAfterMs` > 0 replays the honk after that long at rest, for as long as the state stays done. */
  constructor(private readonly repeatAfterMs = 0) {}

  reset(): PangoSnapshot {
    this.state = 'idle'; this.action = 'idle'; this.processingFrame = 0; this.doneFrame = 0; this.accumulator = 0; this.restElapsed = 0;
    return this.snapshot();
  }

  setState(next: PangoState): PangoSnapshot {
    if (!pangoStates.includes(next)) throw new RangeError(`Invalid Pango state: ${next}`);
    if (next === 'idle') return this.reset();
    if (next === 'reading' || next === 'thinking') {
      if (this.action === 'processing' && (this.state === 'reading' || this.state === 'thinking')) { this.state = next; return this.snapshot(); }
      this.state = next; this.action = 'processing'; this.processingFrame = 0; this.doneFrame = 0; this.accumulator = 0;
      return this.snapshot();
    }
    if (this.state === 'done') return this.snapshot();
    this.state = 'done'; this.doneFrame = 0; this.accumulator = 0;
    this.action = this.action === 'processing' ? 'finishing' : 'honk';
    return this.snapshot();
  }

  advance(ms: number): PangoSnapshot {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError('advance(ms) requires non-negative finite ms');
    this.accumulator += ms;
    while (this.accumulator >= 100) {
      this.accumulator -= 100;
      if (this.action === 'processing') this.processingFrame = (this.processingFrame + 1) % 8;
      else if (this.action === 'finishing') {
        this.processingFrame = (this.processingFrame + 1) % 8;
        if (this.processingFrame === 0) { this.action = 'honk'; this.doneFrame = 0; this.accumulator = 0; break; }
      } else if (this.action === 'honk') {
        if (this.doneFrame < 8) this.doneFrame++;
        // Repeating, the time left over runs on into the rest; otherwise the honk rests as it always has.
        else if (this.repeats()) { this.action = 'rest'; this.doneFrame = 0; this.restElapsed = 0; }
        else { this.action = 'rest'; this.doneFrame = 0; this.accumulator = 0; this.restElapsed = 0; break; }
      } else if (this.action === 'rest' && this.repeats()) {
        this.restElapsed += 100;
        if (this.restElapsed >= this.repeatAfterMs) { this.action = 'honk'; this.doneFrame = 0; this.restElapsed = 0; }
      }
    }
    return this.snapshot();
  }

  private repeats() { return this.state === 'done' && this.repeatAfterMs > 0; }
  /** While resting before a repeat, the milliseconds until the honk plays again (so a caller can sleep); else null. */
  restRemaining(): number | null { return this.action === 'rest' && this.repeats() ? Math.max(0, this.repeatAfterMs - this.restElapsed - this.accumulator) : null; }

  snapshot(): PangoSnapshot {
    return { state: this.state, action: this.action, processingFrame: this.processingFrame, doneFrame: this.doneFrame };
  }
}
