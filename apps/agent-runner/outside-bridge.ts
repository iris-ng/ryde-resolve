import { z } from 'zod';
import { TrustedRejection } from '../../packages/agent-flow/citations';
import { hasOutsideLookups, maxOutsideCalls, outsideSourceKinds, type Task } from '../../packages/agent-flow/contracts';
import { placeNames, windowNames } from '../../packages/outside-data/places';
import { outsideLookup, type LookupOutside } from '../../packages/outside-data/lookup';

// Outside lookups (owner, 11 October 2026): agents never hold a key. The Evidence Collector's helper sends its request to the worker over
// the role child's message channel; the worker, which holds the keys and runs no model, makes the lookup and sends back the saved record.
const request = z.object({
  type: z.literal('outside_lookup'), id: z.string().max(40),
  args: z.object({ source: z.enum(outsideSourceKinds), place: z.enum(placeNames).optional(), window: z.enum(windowNames).optional() }).strict(),
  n: z.number().int().min(1).max(maxOutsideCalls), requestId: z.string().max(120),
}).strict();
export type OutsideAnswer = { type: 'outside_answer'; id: string; answer?: Awaited<ReturnType<LookupOutside>>; error?: string };
/**
 * Worker side. Only the Evidence Collector's collect task at evidence checks 4 may ask, at most maxOutsideCalls times (`asked` counts this
 * one). Null: not a lookup message. A refusal carries only the server's own words (a TrustedRejection), never a provider's or the model's.
 */
export async function answerOutsideRequest(task: Task, message: unknown, asked: number, deps: { fetch: typeof fetch; env: Record<string, string | undefined>; signal?: AbortSignal; budgetMs?: number } = { fetch, env: process.env }): Promise<OutsideAnswer | null> {
  const parsed = request.safeParse(message); if (!parsed.success) return null;
  const { id, args, n, requestId } = parsed.data;
  if (task.role !== 'evidence' || task.phase !== 'collect' || !hasOutsideLookups(task.packet)) return { type: 'outside_answer', id, error: 'Outside lookups are not available in this task' };
  if (asked > maxOutsideCalls) return { type: 'outside_answer', id, error: `At most ${maxOutsideCalls} outside lookups per task` };
  try { return { type: 'outside_answer', id, answer: await outsideLookup(task.packet, args, { fetch: deps.fetch, env: deps.env, n, requestId, ...(deps.signal ? { signal: deps.signal } : {}), ...(deps.budgetMs ? { budgetMs: deps.budgetMs } : {}) }) }; }
  catch (e) { return { type: 'outside_answer', id, error: e instanceof TrustedRejection ? e.message : 'The outside lookup failed on the server' }; }
}
/** How long the child waits for the worker: longer than a lookup's own budget (lookup.ts lookupBudgetMs), so a slow source comes back as an unavailable record, not a timeout. */
export const bridgeWaitMs = 150000;
/** Child side: a LookupOutside that asks the worker and waits up to bridgeWaitMs for its own answer. */
export function askWorker(send: (m: unknown) => void, onMessage: (handler: (m: any) => void) => void): LookupOutside {
  const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>(); let seq = 0;
  onMessage(m => {
    if (m?.type !== 'outside_answer' || typeof m.id !== 'string') return;
    const p = pending.get(m.id); if (!p) return;
    pending.delete(m.id); clearTimeout(p.timer);
    if (m.answer) p.resolve(m.answer); else p.reject(new TrustedRejection(typeof m.error === 'string' ? m.error : 'The outside lookup failed on the server'));
  });
  return (args, n, requestId) => new Promise((resolve, reject) => {
    const id = String(++seq), timer = setTimeout(() => { if (pending.delete(id)) reject(new TrustedRejection('The worker did not answer the outside lookup in time')); }, bridgeWaitMs);
    timer.unref?.();
    pending.set(id, { resolve, reject, timer });
    send({ type: 'outside_lookup', id, args, n, requestId });
  });
}
