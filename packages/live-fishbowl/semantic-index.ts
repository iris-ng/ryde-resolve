import type { CasePacket } from '../agent-flow/contracts';
import { bindingStatuses, type Precedent } from '../policy/precedents';
import { caseFeatures, searchPrecedents } from '../policy/retrieval';
import { agentRule, ruleNotesOff, rulesetSha256, type Rule } from '../policy/ruleset';
import { caseQueryText, embedBatchSize, embedTexts, factsOnly, ruleChunkText, rulingChunkText, searchBudgetMs, semanticSetting, similarByMeaning, textSha256, type Candidate, type SemanticConfig, type SemanticOutcome, type VoyageDeps } from '../policy/semantic';
import { pool } from './connection';

// The semantic index in the live database (schema.ts live_embeddings), owned by the worker (11 October 2026). Every rule and every
// approved past ruling gets one vector, keyed by its text's hash; the worker fills the gaps at start and before each search, so an
// approved ruling joins with no release. A run's case query is embedded once and kept under the run's id. Nothing here throws into
// the worker: a Voyage failure, a database failure or a stored index built with another model leaves the semantic layer off for
// that call, with a plain reason, and the worker and the run go on with fact matching.
export type Db = { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> };
export type IndexDeps = VoyageDeps & { env: Record<string, string | undefined>; db?: Db };
export type Chunk = { id: string; kind: 'rule' | 'ruling'; ref: string; text: string; sha256: string };
// A rule's chunk is the text an agent is given (ruleset.ts agentRule). With the note lists off (RYDE_RULE_NOTES=off) the chunk keeps
// its own id, so the two texts never share a row: a worker on either setting finds its own vectors and leaves the other's in place.
export const ruleChunk = (rule: Rule): Chunk => { const text = ruleChunkText(agentRule(rule)); return { id: `rule:${rulesetSha256.slice(0, 12)}:${rule.id}${ruleNotesOff ? ':notes-off' : ''}`, kind: 'rule', ref: rule.id, text, sha256: textSha256(text) }; };
export const rulingChunk = (card: Precedent): Chunk => { const text = rulingChunkText(card), sha256 = textSha256(text); return { id: `ruling:${card.precedent_id}:${sha256.slice(0, 12)}`, kind: 'ruling', ref: card.precedent_id, text, sha256 }; };
export const caseChunkId = (runId: string) => `case:${runId}`;
/** Only cards an agent can see are embedded (the set pinPrecedents pins): reviewed or approved, never a draft or a withdrawn card. */
export const indexedCards = (cards: readonly Precedent[]) => cards.filter(c => (bindingStatuses as readonly string[]).includes(c.review_status));

export type IndexStatus = { mode: 'on' | 'off' | 'refused' | 'partial'; reason?: string; model: string; dimension: number; reranker: string; chunks: number; embedded: number; missing: number };
// A row counts as present only when its vector is whole (no null or NaN element); a damaged row is embedded again and replaced, and
// only a real insert is counted, so two workers indexing at once report what each inserted.
const wholeRows = 'SELECT id FROM live_embeddings WHERE id = ANY($1) AND NOT EXISTS (SELECT 1 FROM unnest(vector) AS v WHERE v IS NULL OR v <> v)';
const insert = 'INSERT INTO live_embeddings(id,kind,ref,text_sha256,model,dimension,vector,tokens) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO UPDATE SET vector=EXCLUDED.vector,tokens=EXCLUDED.tokens,text_sha256=EXCLUDED.text_sha256 RETURNING (xmax = 0) AS inserted';
/** A stored vector this worker can use: an array of the configured size whose every element is a finite number. */
const wholeVector = (v: unknown, dimension: number): v is number[] => Array.isArray(v) && v.length === dimension && v.every(x => typeof x === 'number' && Number.isFinite(x));
/**
 * Embed every rule and visible card whose text hash has no row yet. Idempotent: a second call with nothing new makes no Voyage call.
 * Rows built with another model or dimension than the configuration refuse the semantic layer (as the eLibrary refuses a mismatched
 * vector table), with one plain line; the worker runs on.
 */
export async function ensureIndex(cards: readonly Precedent[], rules: readonly Rule[], deps: IndexDeps): Promise<IndexStatus> {
  const setting = semanticSetting(deps.env), db = deps.db ?? pool;
  if (!setting.on) return { mode: 'off', reason: setting.reason, model: setting.model, dimension: setting.dimension, reranker: setting.reranker, chunks: 0, embedded: 0, missing: 0 };
  const cfg = setting.config, base = { model: cfg.model, dimension: cfg.dimension, reranker: cfg.reranker };
  const chunks = [...rules.map(ruleChunk), ...indexedCards(cards).map(rulingChunk)];
  try {
    const stored = (await db.query("SELECT DISTINCT model, dimension FROM live_embeddings WHERE kind IN ('rule','ruling')")).rows as { model: string; dimension: number }[];
    const other = stored.find(r => r.model !== cfg.model || Number(r.dimension) !== cfg.dimension);
    if (other) return { ...base, mode: 'refused', reason: `the stored index was built with ${other.model}/${other.dimension}, not ${cfg.model}/${cfg.dimension}; the semantic layer stays off until they match`, chunks: chunks.length, embedded: 0, missing: chunks.length };
    const have = new Set((await db.query(wholeRows, [chunks.map(c => c.id)])).rows.map(r => r.id as string));
    const missing = chunks.filter(c => !have.has(c.id));
    let embedded = 0;
    for (let at = 0; at < missing.length; at += embedBatchSize) {
      const batch = missing.slice(at, at + embedBatchSize), call = await embedTexts(deps, cfg, batch.map(c => c.text), 'document');
      if (call.status !== 'received') return { ...base, mode: 'partial', reason: call.reason, chunks: chunks.length, embedded, missing: missing.length - embedded };
      // The reply counts tokens for the batch as a whole; each row keeps its share, rounded, as a cost note, not an audit figure.
      const share = Math.round(call.tokens / batch.length);
      for (let i = 0; i < batch.length; i++) { const r = (await db.query(insert, [batch[i].id, batch[i].kind, batch[i].ref, batch[i].sha256, cfg.model, cfg.dimension, call.answer[i], share])).rows[0]; if (r?.inserted !== false) embedded++; }
    }
    return { ...base, mode: 'on', chunks: chunks.length, embedded, missing: 0 };
  } catch { return { ...base, mode: 'off', reason: 'the index table could not be read (run the database step for this release)', chunks: chunks.length, embedded: 0, missing: chunks.length }; }
}
/** The worker's ready-line words for the index. */
export const indexLine = (s: IndexStatus): string => s.mode === 'on' ? `semantic index: on, ${s.model}/${s.dimension}, ${s.reranker}, ${s.chunks} chunks, ${s.embedded} embedded now`
  : s.mode === 'partial' ? `semantic index: partial, ${s.model}/${s.dimension}, ${s.reranker}, ${s.chunks} chunks, ${s.embedded} embedded now, ${s.missing} not embedded (${s.reason})`
  : `semantic index: off (${s.reason})`;

/** The vectors of the visible cards of one category, with their chunk texts for the reranker, and how many of them have no vector yet. */
export async function vectorsFor(category: string, cards: readonly Precedent[], cfg: SemanticConfig, db: Db = pool): Promise<{ candidates: Candidate[]; missing: number }> {
  const wanted = indexedCards(cards).filter(c => c.category === category).map(rulingChunk);
  if (!wanted.length) return { candidates: [], missing: 0 };
  const rows = (await db.query('SELECT id, vector FROM live_embeddings WHERE id = ANY($1) AND model=$2 AND dimension=$3', [wanted.map(c => c.id), cfg.model, cfg.dimension])).rows as { id: string; vector: number[] }[];
  const byId = new Map(rows.map(r => [r.id, r.vector]));
  const candidates = wanted.flatMap(c => { const v = byId.get(c.id); return wholeVector(v, cfg.dimension) ? [{ precedentId: c.ref, text: c.text, vector: v }] : []; });
  return { candidates, missing: wanted.length - candidates.length };
}
/** The run's saved case vector when it was made from this very text under this model; null otherwise (the text changed, or nothing saved). */
export async function caseVector(runId: string, text: string, cfg: SemanticConfig, db: Db = pool): Promise<number[] | null> {
  const row = (await db.query('SELECT vector, text_sha256 FROM live_embeddings WHERE id=$1 AND model=$2 AND dimension=$3', [caseChunkId(runId), cfg.model, cfg.dimension])).rows[0] as { vector: number[]; text_sha256: string } | undefined;
  return row && row.text_sha256 === textSha256(text) && wholeVector(row.vector, cfg.dimension) ? row.vector : null;
}
/** Keep the run's case vector (one row per run; a changed text replaces it) so the Arbitrator's call reuses the Policy Analyst's embedding. */
export async function saveCaseEmbedding(runId: string, text: string, vector: number[], tokens: number, cfg: SemanticConfig, db: Db = pool): Promise<void> {
  await db.query('INSERT INTO live_embeddings(id,kind,ref,text_sha256,model,dimension,vector,tokens) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO UPDATE SET text_sha256=EXCLUDED.text_sha256,model=EXCLUDED.model,dimension=EXCLUDED.dimension,vector=EXCLUDED.vector,tokens=EXCLUDED.tokens,created_at=now()',
    [caseChunkId(runId), 'case', runId, textSha256(text), cfg.model, cfg.dimension, vector, tokens]);
}
/**
 * The worker's answer to one search_precedents call: the rulings this case may see (the same pool the fact search uses: its category,
 * reviewed, not hidden from this case) are indexed if any lack a vector, the case is embedded (or its saved vector reused), and those
 * rulings are ranked and reranked. Only that pool is ever sent to Voyage for this case. The whole call shares one deadline
 * (searchBudgetMs) under the child's wait, and the task's stop signal ends it. Facts only, with the reason, on any failure; a ruling
 * left without a vector (Voyage refused mid-index) is counted and the reason carried, and the search goes on over the rest.
 */
export async function findSimilar(packet: CasePacket, cards: readonly Precedent[], deps: IndexDeps & { runId: string }): Promise<SemanticOutcome> {
  const setting = semanticSetting(deps.env), db = deps.db ?? pool;
  if (!setting.on) return factsOnly(setting.reason, setting);
  const cfg = setting.config, base = { model: cfg.model, dimension: cfg.dimension, reranker: cfg.reranker };
  const signal = AbortSignal.any([deps.signal ?? new AbortController().signal, AbortSignal.timeout(searchBudgetMs)]), bounded = { ...deps, signal };
  const stopped = () => factsOnly('the search ran out of time or was stopped', base);
  const search = async (): Promise<SemanticOutcome> => {
    try {
      const category = caseFeatures(packet).category, visible = new Set(searchPrecedents(packet, { limit: 10000 }).map(h => h.precedentId));
      const pool_ = indexedCards(cards).filter(c => c.category === category && visible.has(c.precedent_id));
      const index = await ensureIndex(pool_, [], bounded);
      if (index.mode === 'refused' || index.mode === 'off') return factsOnly(index.reason ?? 'the index is off', base);
      if (signal.aborted) return stopped();
      const { candidates, missing } = await vectorsFor(category, pool_, cfg, db);
      const text = caseQueryText(packet), cached = await caseVector(deps.runId, text, cfg, db);
      if (signal.aborted) return stopped();
      const outcome = await similarByMeaning(bounded, cfg, text, candidates, cached ?? undefined, missing);
      if (index.mode === 'partial' && outcome.result.mode === 'on' && outcome.result.reason) outcome.result.reason += ` (${index.reason})`;
      if (outcome.query && !cached && !signal.aborted) await saveCaseEmbedding(deps.runId, text, outcome.query.vector, outcome.query.tokens, cfg, db).catch(() => { /* the search stands; the next call embeds again */ });
      return outcome;
    } catch { return signal.aborted ? stopped() : factsOnly('the index could not be read', base); }
  };
  // The deadline bounds the database waits too: when it passes, the answer is facts only at once, whatever
  // query is still waiting on a lock; that query finishes or fails on its own and writes nothing the next search cannot redo.
  if (signal.aborted) return stopped();
  return Promise.race([search(), new Promise<SemanticOutcome>(done => signal.addEventListener('abort', () => done(stopped()), { once: true }))]);
}
