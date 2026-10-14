import { fileURLToPath } from 'node:url';
import { harnessRouting, roleChild } from './role';
import { createRoleExecutor, roleCleanups } from './executor';
import { workOnce } from '../../packages/live-fishbowl/worker';
import { withPhotoExaminer } from '../../packages/evidence-collection/photo-examiner';
import { pool } from '../../packages/live-fishbowl/connection';
import type { Task } from '../../packages/agent-flow/contracts';
import { ensureIndex, indexLine, type IndexStatus } from '../../packages/live-fishbowl/semantic-index';
import { semanticSetting } from '../../packages/policy/semantic';
import { approvedPrecedentCards } from '../../packages/live-fishbowl/store';
import { precedents } from '../../packages/policy/precedents';
import { allRules } from '../../packages/policy/ruleset';

const startBudgetMs = 90000;
async function indexAtStart(signal: AbortSignal): Promise<IndexStatus> {
  const setting = semanticSetting(process.env);
  if (!setting.on) return { mode: 'off', reason: setting.reason, model: setting.model, dimension: setting.dimension, reranker: setting.reranker, chunks: 0, embedded: 0, missing: 0 };
  const late: IndexStatus = { mode: 'off', reason: `the index did not finish within ${startBudgetMs / 1000} seconds at start; the next search fills what is missing`, model: setting.config.model, dimension: setting.config.dimension, reranker: setting.config.reranker, chunks: 0, embedded: 0, missing: 0 };
  const stop = AbortSignal.any([signal, AbortSignal.timeout(startBudgetMs)]);
  const work = (async () => ensureIndex([...precedents, ...await approvedPrecedentCards().catch(() => [])], allRules, { fetch, env: process.env, signal: stop }))();
  return Promise.race([work.catch(() => late), new Promise<IndexStatus>(done => { stop.addEventListener('abort', () => done(late), { once: true }); })]);
}
async function main() {
  if (process.argv.includes('--role-child')) {
    await new Promise<void>(resolve => process.once('message', (task: Task) => { void roleChild(task).finally(resolve); }));
    return;
  }
  if (!process.env.DATABASE_URL || !process.env.RYDE_CODEBUDDY_ENTRY) throw new Error('Live worker requires explicit database and harness entry. Models come from the agent definitions unless overridden.');
  const routing = harnessRouting(); // each role's route has its credential: CodeBuddy runtime token or model gateway URL and secret
  const signal = new AbortController();
  process.once('SIGTERM', () => signal.abort()); process.once('SIGINT', () => signal.abort());
  const executor = withPhotoExaminer(createRoleExecutor(fileURLToPath(import.meta.url)));
  // The semantic index (11 October 2026): every rule and approved past ruling without a vector is embedded now, with the worker's own
  // Voyage key; off with a plain reason when there is no key or switch (then the database is not read for it). Bounded: a start that
  // does not finish within the budget is reported and the worker goes to its queue; the next search fills what is missing. Never
  // stops the worker.
  const index = await indexAtStart(signal.signal);
  console.log(`Live Fishbowl worker ready (protocol 2; no automatic retries; model gateway: ${routing.gateway.join(', ') || 'none'}; CodeBuddy: ${routing.codebuddy.join(', ') || 'none'}; ${indexLine(index)}).`);
  if (process.argv.includes('--once')) { await workOnce(executor, signal.signal, undefined, { afterPhase: roleCleanups }); await pool.end(); return; }
  while (!signal.signal.aborted) {
    try { if (!await workOnce(executor, signal.signal, undefined, { afterPhase: roleCleanups })) await new Promise(resolve => setTimeout(resolve, 1000)); }
    catch { console.error('Live worker could not access its queue; retrying connection.'); await new Promise(resolve => setTimeout(resolve, 3000)); }
  }
  await pool.end();
}
main().then(() => process.exit(0)).catch(error => { console.error(error instanceof Error ? error.message : 'Live worker failed'); process.exit(1); });
