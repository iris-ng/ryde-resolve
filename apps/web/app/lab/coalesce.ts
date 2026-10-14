/**
 * Coalesces calls to an async job: at most one run in flight and one queued after it. Calls made before a run has begun
 * (the same tick) share it; calls made while it runs share one follow-up, which begins after the run ends. So any burst
 * of calls makes at most two runs, the last of which begins after the last call and sees the final state. Each caller's
 * promise settles with a run that began after its call. A failed run does not stop the follow-up.
 */
export function coalesce(job: () => Promise<void>): () => Promise<void> {
  let current: Promise<void> | null = null, next: Promise<void> | null = null, begun = false;
  const start = (): Promise<void> => {
    begun = false;
    const run: Promise<void> = Promise.resolve().then(() => { begun = true; return job(); }).finally(() => { current = null; });
    return current = run;
  };
  return () => next ?? (!current ? start() : !begun ? current : next = current.then(() => {}, () => {}).then(() => { next = null; return start(); }));
}
