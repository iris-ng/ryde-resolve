import { createHash } from 'node:crypto';
import type { CasePacket } from '../agent-flow/contracts';
import { deriveFacts } from '../agent-flow/facts';
import { carriesKey } from '../outside-data/lookup';
import { readBounded, type Fetch } from '../outside-data/providers';
import { outcomeLine } from './catalog';
import { factPhrase } from './loop';
import type { Precedent } from './precedents';
import { caseFeatures, featureVocabulary, precedentText } from './retrieval';
import { branches } from '../agent-flow/checklists';
import type { Rule } from './ruleset';

// The semantic layer of the Policy & Precedent knowledge base (owner, 11 October 2026, slice 1):
// Voyage embeddings over the rules and every approved past ruling, cosine candidates, Voyage's reranker, a cut-off. It proposes
// rulings similar in meaning as comparison only. Binding (retrieval.ts rankPrecedents), routing and the Judge's note guard never
// read it. The worker alone calls Voyage (live-fishbowl/semantic-index.ts, agent-runner/semantic-bridge.ts); no role child holds
// the key. Written like outside-data/providers.ts: fetch, the key in a header only, a bounded reply, 15 s timeout, two retries on
// 429 and 5xx, and every failure an answer in our own words, never the provider's text.

// ---- Chunk text: one chunk per item, built by code. Nothing here is a party's name or free text from the case.
/** A rule's chunk: id and title, statement, each condition and limit, and the exact quote of each archived Ryde page it rests on. */
export const ruleChunkText = (rule: Pick<Rule, 'id' | 'title' | 'statement' | 'conditions' | 'sources'> & { limits?: string[] }): string =>
  [`${rule.id} ${rule.title}`, rule.statement, ...rule.conditions.map(c => `Condition: ${c}`), ...(rule.limits ?? []).map(l => `Limit: ${l}`), ...rule.sources.map(s => `Ryde page: ${s.exact_text}`)].filter(Boolean).join('\n');
/** A ruling's chunk: the words the keyword ranking reads (retrieval.ts precedentText), its distinguishing facts and its outcome line. */
export const rulingChunkText = (card: Pick<Precedent, 'title' | 'material_facts' | 'issues' | 'reasoning' | 'dispute_types' | 'distinguishing_facts' | 'remedy'>): string =>
  [precedentText(card as Precedent), ...card.distinguishing_facts.map(f => `Distinguishing fact: ${f}`), `Outcome: ${outcomeLine(card.remedy)}`].join('\n');
// A value a calculation may carry into the query: a number, a boolean, or a string that is a known value of a known fact (the
// retrieval vocabulary and the situation branches: fixed_quote, route_detour, rider). Any other string from the record is left out,
// whatever its shape: a promo code, a gantry name, a service name, a person's name in any case, anything typed. Inside an object only
// numbers and booleans are kept (a token's syntax says nothing about where it came from).
const token = /^[a-z][a-z0-9_]{0,40}$/;
const enums: Record<string, readonly unknown[]> = { ...featureVocabulary, dispute_branch: branches, route_consent_recorded: ['yes', 'no', 'disputed', 'not_applicable'] };
const safeValue = (key: string, v: unknown, depth = 0): string | undefined => {
  if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return String(v);
  if (typeof v === 'string') return depth === 0 && (enums[key] ?? []).includes(v) ? v : undefined;
  if (depth === 0 && v && typeof v === 'object' && !Array.isArray(v)) {
    const kept = Object.entries(v).flatMap(([k, x]) => { const s = safeValue(k, x, 1); return token.test(k) && s !== undefined ? [`${k} ${s}`] : []; });
    return kept.length ? kept.join(', ') : undefined;
  }
  return undefined;
};
/** The run's deterministic calculations as "id: value" lines: numbers, booleans and known enum values only (the shape of loop.ts materialFacts, with a stricter value filter). */
export const safeFactLines = (packet: CasePacket): string[] => deriveFacts(packet).facts.filter(f => f.id !== 'dispute_category' && token.test(f.id))
  .flatMap(f => { const v = safeValue(f.id, f.value); return v !== undefined && v.length <= 160 ? [`${f.id}: ${v}`] : []; }).slice(0, 24);
/**
 * The case as a query: its category and situation, its retrieval facts in the past-rulings page's words (loop.ts factPhrase), then the
 * run's deterministic calculations as "id: value" lines (safeFactLines). Never the title, the ticket's wording, a statement, a name or
 * any free string from the record: every line is code-written from structured fields with numeric, boolean or token values.
 */
export function caseQueryText(packet: CasePacket): string {
  const { category, features } = caseFeatures(packet), branch = deriveFacts(packet).branch;
  const facts = Object.entries(features).map(([k, v]) => factPhrase(k, v));
  return [`Dispute: ${category.replaceAll('_', ' ')}${branch ? `, situation ${String(branch).replaceAll('_', ' ')}` : ''}`, facts.length ? `Facts: ${facts.join('; ')}` : '', ...safeFactLines(packet)].filter(Boolean).join('\n');
}
export const textSha256 = (text: string) => createHash('sha256').update(text).digest('hex');

// ---- Configuration, from the worker's environment only (/etc/ryde/semantic.env on the server).
export const defaultEmbeddingModel = 'voyage-4-large', defaultEmbeddingDimension = 512, defaultRerankModel = 'rerank-2.5';
export type SemanticConfig = { apiKey: string; model: string; dimension: number; reranker: string };
export type SemanticSetting = { on: true; config: SemanticConfig } | { on: false; reason: string; model: string; dimension: number; reranker: string };
const modelId = /^[a-z0-9][a-z0-9.-]{0,39}$/;
/** On only with the switch, a key and plain settings; otherwise off with a one-line reason the ready line and the tool result print. */
export function semanticSetting(env: Record<string, string | undefined>): SemanticSetting {
  const model = env.RYDE_EMBEDDING_MODEL || defaultEmbeddingModel, reranker = env.RYDE_RERANK_MODEL || defaultRerankModel;
  const dimension = env.RYDE_EMBEDDING_DIMENSION ? Number(env.RYDE_EMBEDDING_DIMENSION) : defaultEmbeddingDimension;
  const off = (reason: string): SemanticSetting => ({ on: false, reason, model, dimension: Number.isInteger(dimension) ? dimension : defaultEmbeddingDimension, reranker });
  if (env.RYDE_SEMANTIC_SEARCH !== '1') return off('the semantic index is switched off (RYDE_SEMANTIC_SEARCH is not 1)');
  if (!env.VOYAGE_API_KEY) return off('no Voyage key');
  if (!Number.isInteger(dimension) || dimension < 1 || dimension > 4096) return off('RYDE_EMBEDDING_DIMENSION is not a whole number of dimensions');
  if (!modelId.test(model) || !modelId.test(reranker)) return off('RYDE_EMBEDDING_MODEL or RYDE_RERANK_MODEL is not a plain model id');
  return { on: true, config: { apiKey: env.VOYAGE_API_KEY, model, dimension, reranker } };
}

// ---- The Voyage client.
export const voyageEmbeddingsUrl = 'https://api.voyageai.com/v1/embeddings', voyageRerankUrl = 'https://api.voyageai.com/v1/rerank';
export const voyageTimeoutMs = 15000, voyageRetries = 2, voyageReplyLimit = 8_000_000;
/** One search_precedents call's whole budget on the worker (indexing the run's missing cards, the query embedding, the rerank, the database), under the child's wait (semantic-bridge.ts semanticWaitMs). */
export const searchBudgetMs = 100000;
/** Texts per embedding request: well under Voyage's limits for a batch, and one request covers the whole library today. */
export const embedBatchSize = 64;
export type CallStatus = 'received' | 'unavailable' | 'provider_error';
export type VoyageCall<T> = { status: 'received'; answer: T; httpStatus: 200; ms: number; tokens: number } | { status: 'unavailable' | 'provider_error'; httpStatus: number | null; ms: number; tokens: 0; reason: string };
export type VoyageDeps = { fetch: Fetch; signal?: AbortSignal; sleep?: (ms: number) => Promise<void> };
const plain = { 'user-agent': 'ryde-resolve semantic index (hackathon)', accept: 'application/json', 'content-type': 'application/json' };
const wait = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const never = new AbortController().signal;
type Posted = { httpStatus: number | null; body: any; reason?: string };
async function postOnce(deps: VoyageDeps, apiKey: string, url: string, body: unknown): Promise<Posted> {
  const signal = deps.signal ?? never;
  if (signal.aborted) return { httpStatus: null, body: null, reason: 'the search was stopped' };
  try {
    const r = await deps.fetch(url, { method: 'POST', headers: { ...plain, authorization: 'Bearer ' + apiKey }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(voyageTimeoutMs)]) });
    const bytes = await readBounded(r, voyageReplyLimit);
    if (!bytes) return { httpStatus: r.status, body: null, reason: 'the reply was larger than 8 MB' };
    let parsed: any = null; try { parsed = JSON.parse(bytes.toString('utf8')); } catch { /* not JSON: body stays null */ }
    return { httpStatus: r.status, body: parsed };
  } catch (e) { return { httpStatus: null, body: null, reason: signal.aborted ? 'the search was stopped' : e instanceof Error && e.name === 'TimeoutError' ? `Voyage did not answer within ${voyageTimeoutMs / 1000} seconds` : 'Voyage could not be reached' }; }
}
const retryable = (s: number | null) => s === null || s === 429 || s >= 500;
/** POST with the key in the Authorization header only; a 429, a 5xx or a network failure is tried again up to voyageRetries times. */
async function post(deps: VoyageDeps, apiKey: string, url: string, body: unknown): Promise<Posted> {
  for (let attempt = 0; ; attempt++) {
    const got = await postOnce(deps, apiKey, url, body);
    if (got.httpStatus === 200 || !retryable(got.httpStatus) || attempt >= voyageRetries || deps.signal?.aborted || got.reason === 'the search was stopped') return got;
    await (deps.sleep ?? wait)(500 * 2 ** attempt);
  }
}
const failure = <T>(got: Posted, ms: number): VoyageCall<T> => {
  if (got.httpStatus === null) return { status: 'unavailable', httpStatus: null, ms, tokens: 0, reason: got.reason ?? 'Voyage could not be reached' };
  if (got.httpStatus === 429) return { status: 'unavailable', httpStatus: 429, ms, tokens: 0, reason: 'Voyage refused: too many requests' };
  if (got.httpStatus === 401 || got.httpStatus === 403) return { status: 'unavailable', httpStatus: got.httpStatus, ms, tokens: 0, reason: 'the Voyage key was refused (expired or wrong)' };
  return { status: 'provider_error', httpStatus: got.httpStatus, ms, tokens: 0, reason: got.reason ?? `Voyage answered ${got.httpStatus}` };
};
const tokensOf = (body: any) => typeof body?.usage?.total_tokens === 'number' && Number.isFinite(body.usage.total_tokens) ? body.usage.total_tokens : 0;
const vectorOk = (v: unknown, dimension: number): v is number[] => Array.isArray(v) && v.length === dimension && v.every(x => typeof x === 'number' && Number.isFinite(x));
/** Embeddings for texts (input_type document for chunks, query for the case) at the configured dimension; a vector of another size is a provider error. */
export async function embedTexts(deps: VoyageDeps, cfg: SemanticConfig, texts: string[], inputType: 'document' | 'query'): Promise<VoyageCall<number[][]>> {
  const start = Date.now();
  if (!texts.length) return { status: 'received', answer: [], httpStatus: 200, ms: 0, tokens: 0 };
  const got = await post(deps, cfg.apiKey, voyageEmbeddingsUrl, { input: texts, model: cfg.model, input_type: inputType, output_dimension: cfg.dimension });
  const ms = Date.now() - start;
  if (got.httpStatus !== 200) return failure(got, ms);
  const rows: any[] = Array.isArray(got.body?.data) ? got.body.data : [];
  if (rows.length !== texts.length) return { status: 'provider_error', httpStatus: 200, ms, tokens: 0, reason: `Voyage returned ${rows.length} vectors for ${texts.length} texts` };
  // Each row names its text by index; the reply must cover every text exactly once, or a vector could be stored for the wrong text.
  const ordered: unknown[] = []; for (const r of rows) { if (Number.isInteger(r?.index) && r.index >= 0 && r.index < texts.length && !(r.index in ordered)) ordered[r.index] = r?.embedding; }
  if (ordered.length !== texts.length || rows.some(r => !Number.isInteger(r?.index))) return { status: 'provider_error', httpStatus: 200, ms, tokens: 0, reason: 'Voyage returned a reply this worker cannot read' };
  const badAt = ordered.findIndex(v => !vectorOk(v, cfg.dimension));
  if (badAt >= 0) { const bad = ordered[badAt]; return { status: 'provider_error', httpStatus: 200, ms, tokens: 0, reason: `Voyage returned ${Array.isArray(bad) ? `vectors of ${bad.length} values` : 'a reply this worker cannot read'}, not ${cfg.dimension}` }; }
  return { status: 'received', answer: ordered as number[][], httpStatus: 200, ms, tokens: tokensOf(got.body) };
}
export type RerankRow = { index: number; score: number };
/** Rerank the documents for the query: each row's index points into `documents`; rows out of range or repeated are dropped. Best first. */
export async function rerankTexts(deps: VoyageDeps, cfg: SemanticConfig, query: string, documents: string[], topK = documents.length): Promise<VoyageCall<RerankRow[]>> {
  const start = Date.now();
  if (!documents.length) return { status: 'received', answer: [], httpStatus: 200, ms: 0, tokens: 0 };
  const got = await post(deps, cfg.apiKey, voyageRerankUrl, { query, documents, model: cfg.reranker, top_k: Math.min(topK, documents.length), return_documents: false });
  const ms = Date.now() - start;
  if (got.httpStatus !== 200) return failure(got, ms);
  if (!Array.isArray(got.body?.data)) return { status: 'provider_error', httpStatus: 200, ms, tokens: 0, reason: 'Voyage returned a reply this worker cannot read' };
  const seen = new Set<number>(), rows: RerankRow[] = [];
  for (const r of got.body.data as any[]) {
    const index = r?.index, score = r?.relevance_score;
    if (!Number.isInteger(index) || index < 0 || index >= documents.length || seen.has(index) || typeof score !== 'number' || !Number.isFinite(score)) continue;
    seen.add(index); rows.push({ index, score });
  }
  return { status: 'received', answer: rows.sort((a, b) => b.score - a.score || a.index - b.index), httpStatus: 200, ms, tokens: tokensOf(got.body) };
}

// ---- Ranking: cosine over the category's vectors, the nearest few reranked, a cut-off.
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
/** How many of the nearest rulings by cosine go to the reranker, how many may come back, and the rerank score one needs to be listed. */
export const cosineCandidates = 10, semanticLimit = 5, rerankCutoff = 0.35;
export type Candidate = { precedentId: string; text: string; vector: number[] };
export type SemanticHit = { precedentId: string; cosine: number; rerank: number; rank: number };
export type SemanticResult = { mode: 'on' | 'facts_only'; model: string; dimension: number; reranker: string; reason?: string; hits: SemanticHit[] };
const round = (x: number) => Math.round(x * 1000) / 1000;
/** The `cosineCandidates` nearest candidates to the query, best first; a candidate whose vector is another size is skipped. */
export const rankByCosine = (query: number[], candidates: Candidate[]): { precedentId: string; cosine: number }[] =>
  candidates.filter(c => c.vector.length === query.length).map(c => ({ precedentId: c.precedentId, cosine: cosine(query, c.vector) }))
    .sort((a, b) => b.cosine - a.cosine || a.precedentId.localeCompare(b.precedentId)).slice(0, cosineCandidates).map(n => ({ ...n, cosine: round(n.cosine) }));
/** The reranker's rows mapped back to rulings: at or above the cut-off, best first, at most `semanticLimit`, ranked 1 upwards. */
export const cutRerank = (nearest: { precedentId: string; cosine: number }[], rows: RerankRow[]): SemanticHit[] =>
  rows.filter(r => r.index >= 0 && r.index < nearest.length && r.score >= rerankCutoff).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, semanticLimit)
    .map((r, i) => ({ precedentId: nearest[r.index].precedentId, cosine: nearest[r.index].cosine, rerank: round(r.score), rank: i + 1 }));

// ---- The search as the tool sees it.
export type CallTrace = { status: CallStatus; httpStatus: number | null; ms: number; tokens: number; reason?: string };
export type SemanticTrace = { queryTextSha256: string; threshold: number; candidates: { precedentId: string; cosine: number }[]; notIndexed: number; embedding: CallTrace | null; rerank: (CallTrace & { documents: number }) | null };
export type SemanticOutcome = { result: SemanticResult; trace: SemanticTrace; query?: { text: string; vector: number[]; tokens: number } };
/** What the tool calls: in a live run the bridge to the worker, which holds the key (semantic-bridge.ts); elsewhere nothing, so the result is facts only. */
export type SemanticSearch = (packet: CasePacket, visibleIds: string[]) => Promise<SemanticOutcome>;
export const factsOnly = (reason: string, setting: { model: string; dimension: number; reranker: string }, queryTextSha256 = ''): SemanticOutcome =>
  ({ result: { mode: 'facts_only', model: setting.model, dimension: setting.dimension, reranker: setting.reranker, reason, hits: [] }, trace: { queryTextSha256, threshold: rerankCutoff, candidates: [], notIndexed: 0, embedding: null, rerank: null } });
export const noLiveRunReason = 'semantic search runs only in a live run, where the worker holds the key';
const callTrace = (c: VoyageCall<unknown>): CallTrace => ({ status: c.status, httpStatus: c.httpStatus, ms: c.ms, tokens: c.tokens, ...(c.status === 'received' ? {} : { reason: c.reason }) });
/**
 * Embed the case (or reuse its vector), rank the category's indexed rulings by cosine, rerank the nearest, cut. A Voyage failure at
 * either step makes this call facts only, with the reason; nothing here throws. A result that carries the key (impossible, checked
 * like an outside record) is dropped the same way.
 */
export async function similarByMeaning(deps: VoyageDeps, cfg: SemanticConfig, queryText: string, candidates: Candidate[], cached?: number[], notIndexed = 0): Promise<SemanticOutcome> {
  const sha = textSha256(queryText), setting = { model: cfg.model, dimension: cfg.dimension, reranker: cfg.reranker };
  let query = cached && cached.length === cfg.dimension ? { text: queryText, vector: cached, tokens: 0 } : undefined, embedding: CallTrace | null = null;
  if (!query) {
    const call = await embedTexts(deps, cfg, [queryText], 'query');
    embedding = callTrace(call);
    if (call.status !== 'received') { const out = factsOnly(call.reason, setting, sha); out.trace.embedding = embedding; out.trace.notIndexed = notIndexed; return out; }
    query = { text: queryText, vector: call.answer[0], tokens: call.tokens };
  }
  const nearest = rankByCosine(query.vector, candidates);
  const byId = new Map(candidates.map(c => [c.precedentId, c]));
  const call = await rerankTexts(deps, cfg, queryText, nearest.map(n => byId.get(n.precedentId)!.text));
  const rerank = { ...callTrace(call), documents: nearest.length };
  if (call.status !== 'received') { const out = factsOnly(call.reason, setting, sha); out.trace = { ...out.trace, candidates: nearest, notIndexed, embedding, rerank }; out.query = query; return out; }
  const outcome: SemanticOutcome = { result: { mode: 'on', ...setting, hits: cutRerank(nearest, call.answer), ...(notIndexed ? { reason: `${notIndexed} ruling${notIndexed === 1 ? '' : 's'} in this category ${notIndexed === 1 ? 'has' : 'have'} no vector yet` } : {}) },
    trace: { queryTextSha256: sha, threshold: rerankCutoff, candidates: nearest, notIndexed, embedding, rerank }, query };
  // Impossible by construction (the result holds numbers, our own ids and our own words) but checked like an outside record. carriesKey
  // matches a key shorter than 12 characters whole, which a one-letter test key would find everywhere; a real key is far longer.
  if (cfg.apiKey.length >= 12 && carriesKey(JSON.stringify({ result: outcome.result, trace: outcome.trace }), [cfg.apiKey])) return factsOnly('the reply could not be recorded safely', setting, sha);
  return outcome;
}
/** The tool's notice for the semantic block, with the cut-off printed so the number is visible. */
export const semanticNotice = (r: SemanticResult): string => r.mode === 'on'
  ? `Semantic search on (${r.model}/${r.dimension}, reranker ${r.reranker}): the ${cosineCandidates} nearest rulings by cosine were reranked and up to ${semanticLimit} with a rerank score of at least ${rerankCutoff} are listed with a similarity${r.reason ? ` (${r.reason})` : ''}. Hits marked binding must be followed or distinguished. Hits marked similar by meaning were found by an embedding search and a reranker; similarity is not a finding that the facts match. Read them with read_precedent and treat them as comparison.`
  : `Semantic search unavailable for this run: ${r.reason ?? 'off'}; fact matching only.`;
/** The weight of a hit the embedding search found that does not bind: comparison, said in the same place binding is said. */
export const similarOnlyWeight = 'similar by meaning only: found by the embedding search; not every decisive fact matches (see differingFeatures)';
