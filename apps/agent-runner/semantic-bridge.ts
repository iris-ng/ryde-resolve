import { z } from 'zod';
import { TrustedRejection } from '../../packages/agent-flow/citations';
import { isJudge, type Task } from '../../packages/agent-flow/contracts';
import { isDatasetPacket } from '../../packages/case-packet/dataset';
import { runLibrary } from '../../packages/policy/precedents';
import { factsOnly, searchBudgetMs, semanticSetting, type SemanticOutcome, type SemanticSearch } from '../../packages/policy/semantic';
import { findSimilar, type IndexDeps } from '../../packages/live-fishbowl/semantic-index';

// The semantic search (11 October 2026): like outside lookups, agents never hold the Voyage key. The Policy Analyst's and the
// Arbitrator's search_precedents helper sends one message to the worker over the role child's channel; the worker, which holds the
// key and runs no model, embeds the case from its own copy of the packet (the child sends no text), ranks the run's pinned rulings
// and sends back the scores. A refusal carries only the server's own words.
const request = z.object({ type: z.literal('semantic_search'), id: z.string().max(40) }).strict();
export type SemanticAnswer = { type: 'semantic_answer'; id: string; answer?: SemanticOutcome; error?: string };
/** search_precedents is called once by the Policy Analyst and once by the Arbitrator; a task gets this many searches at most. */
export const maxSemanticCalls = 3;
/** The tasks that may ask: the Policy Analyst's apply step and a Judge seat's decide step, on a dataset case (the tool exists only there). */
export const maySearch = (task: Pick<Task, 'role' | 'phase' | 'packet'>) => isDatasetPacket(task.packet) && ((task.role === 'policy' && task.phase === 'apply') || (isJudge(task.role) && task.phase === 'decide'));
/** Worker side. Null: not a semantic message. Never throws: a failure is a facts-only answer with a plain reason. */
export async function answerSemanticRequest(task: Task, message: unknown, asked: number, deps: IndexDeps = { fetch, env: process.env }): Promise<SemanticAnswer | null> {
  const parsed = request.safeParse(message); if (!parsed.success) return null;
  const { id } = parsed.data;
  if (!maySearch(task)) return { type: 'semantic_answer', id, error: 'Semantic search is not available in this task' };
  if (asked > maxSemanticCalls) return { type: 'semantic_answer', id, error: `At most ${maxSemanticCalls} semantic searches per task` };
  // The child gets the scores and the trace; the case text and its vector stay in the worker.
  try { const { query: _kept, ...answer } = await findSimilar(task.packet, runLibrary(task.packet), { ...deps, runId: task.runId }); return { type: 'semantic_answer', id, answer }; }
  catch { const s = semanticSetting(deps.env); return { type: 'semantic_answer', id, answer: factsOnly('the semantic search failed on the server', s.on ? s.config : s) }; }
}
/** How long the child waits for the worker: longer than the worker's own budget for the whole search (semantic.ts searchBudgetMs), so a slow Voyage comes back as facts only, not a timeout. */
export const semanticWaitMs = searchBudgetMs + 20000;
/** Child side: a SemanticSearch that asks the worker and waits up to semanticWaitMs for its own answer. The packet and ids it is given stay in the child. */
export function askSemantic(send: (m: unknown) => void, onMessage: (handler: (m: any) => void) => void): SemanticSearch {
  const pending = new Map<string, { resolve: (v: SemanticOutcome) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>(); let seq = 0;
  onMessage(m => {
    if (m?.type !== 'semantic_answer' || typeof m.id !== 'string') return;
    const p = pending.get(m.id); if (!p) return;
    pending.delete(m.id); clearTimeout(p.timer);
    if (m.answer) p.resolve(m.answer); else p.reject(new TrustedRejection(typeof m.error === 'string' ? m.error : 'The semantic search failed on the server'));
  });
  return () => new Promise((resolve, reject) => {
    const id = 's' + String(++seq), timer = setTimeout(() => { if (pending.delete(id)) reject(new TrustedRejection('The worker did not answer the semantic search in time')); }, semanticWaitMs);
    timer.unref?.();
    pending.set(id, { resolve, reject, timer });
    send({ type: 'semantic_search', id });
  });
}
