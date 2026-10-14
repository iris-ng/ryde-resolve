// "Past rulings considered": the past rulings a Judge's decision weighed, in plain words, for the full decision view and the
// case summary. Precedents guide; they never settle an open question (user decision, 4 October). Browser-safe: it reads the
// decision and the run's pinned card titles only, never policy/precedents.ts (which uses node crypto).
import type { PrecedentSet } from '../policy/precedents';

export type PrecedentCite = { sourceId: string; startLine: number; endLine: number };
export type ConsideredPrecedent = { id: string; title: string | null; status: string; reason: string; citations: PrecedentCite[] };
export type PrecedentsConsidered = { state: 'listed'; items: ConsideredPrecedent[] } | { state: 'none' | 'not_recorded'; text: string };

const noteStatus: Record<string, string> = { followed: 'Followed', distinguished: 'Distinguished: this case differs' };
const compareStatus: Record<string, string> = { materially_matches: 'Compared: matches on every fact', distinguishable: 'Compared: this case differs', insufficient_information: 'Compared: not enough information' };
const cites = (v: unknown): PrecedentCite[] => Array.isArray(v) ? v.filter(c => c && typeof c.sourceId === 'string' && Number.isInteger(c.startLine) && Number.isInteger(c.endLine)) : [];

/**
 * One line per card the decision names: its id, its title when the run's pinned cards have it, Followed or Distinguished, the
 * Judge's reason and cited evidence; then any comparison list the decision carries. A binding card always has a note (the
 * guard refuses a decision without one), so when there is none the decision found no matching precedent: said plainly on a
 * run that pinned its cards or recorded notes, and "not recorded" on an older run that did neither.
 */
export function precedentsConsidered(decision: { precedentNotes?: unknown; precedents?: unknown } | null | undefined, packet?: { precedentSet?: Pick<PrecedentSet, 'cards'> } | null): PrecedentsConsidered {
  const title = (id: string) => packet?.precedentSet?.cards?.find(c => c.precedent_id === id)?.title ?? null;
  const notes = Array.isArray(decision?.precedentNotes) ? decision!.precedentNotes as { precedentId?: unknown; relation?: unknown; reason?: unknown; citations?: unknown }[] : null;
  const items: ConsideredPrecedent[] = (notes ?? []).filter(n => typeof n?.precedentId === 'string').map(n => ({
    id: n.precedentId as string, title: title(n.precedentId as string), status: noteStatus[String(n.relation)] ?? String(n.relation ?? ''), reason: typeof n.reason === 'string' ? n.reason : '', citations: cites(n.citations) }));
  for (const p of Array.isArray(decision?.precedents) ? decision!.precedents as { precedentId?: unknown; status?: unknown; differences?: unknown }[] : []) {
    if (typeof p?.precedentId !== 'string' || items.some(i => i.id === p.precedentId)) continue;
    items.push({ id: p.precedentId, title: title(p.precedentId), status: compareStatus[String(p.status)] ?? 'Compared', reason: typeof p.differences === 'string' ? p.differences : '', citations: [] });
  }
  if (items.length) return { state: 'listed', items };
  return notes || packet?.precedentSet ? { state: 'none', text: 'No past ruling matched this case.' } : { state: 'not_recorded', text: 'Not recorded for this run.' };
}

// ---- "Similar rulings found by meaning" (semantic index, 11 October 2026): read from the run's semantic_searched event, never from a
// Voyage call, so the page needs no key and an older run shows nothing. The standing column is the fact comparison the tool made,
// in plain words; the scores are the embedding search's, comparison only.
export type SimilarRuling = { id: string; title: string | null; cosine: number; rerank: number; standing: string };
export type SimilarRulings = { state: 'listed'; model: string; dimension: number; reranker: string; threshold: number; items: SimilarRuling[] } | { state: 'none'; text: string } | { state: 'not_recorded' };
type SemanticEvent = { kind?: string; actor?: string; data?: any };
const factWords = (s: string) => { const m = /^([a-z0-9_ ]+?): (.*)$/.exec(s); return m ? `${m[1].replaceAll('_', ' ')} (${m[2].replaceAll('_', ' ')})` : s.replaceAll('_', ' '); };
const list = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
/** A found ruling's standing: binding when the fact comparison says so, otherwise similar only, with the facts that differ or are not settled. */
export function similarStanding(hit: { binding?: unknown; differingFeatures?: unknown; unknownFeatures?: unknown }): string {
  if (hit.binding === true) return 'Binding: every recorded fact matches';
  const differing = list(hit.differingFeatures), unknown = list(hit.unknownFeatures);
  if (differing.length) return `Similar only: differs on ${differing.map(factWords).join('; ')}`;
  if (unknown.length) return `Similar only: this case does not settle ${unknown.map(factWords).join(', ')}`;
  return 'Similar only: not every recorded fact matches';
}
const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : 0;
/** The last semantic search of the run (the Arbitrator's, when it ran): its hits with their standing, or why there are none. */
export function similarRulings(events: SemanticEvent[] | null | undefined, packet?: { precedentSet?: Pick<PrecedentSet, 'cards'> } | null): SimilarRulings {
  const last = [...(events ?? [])].reverse().find(e => e?.kind === 'semantic_searched' && e.data && typeof e.data === 'object');
  if (!last) return { state: 'not_recorded' };
  const d = last.data, title = (id: string) => packet?.precedentSet?.cards?.find(c => c.precedent_id === id)?.title ?? (typeof d.hits?.find?.((h: any) => h?.precedentId === id)?.title === 'string' ? d.hits.find((h: any) => h.precedentId === id).title : null);
  if (d.mode !== 'on') return { state: 'none', text: `Semantic search unavailable for this run: ${typeof d.reason === 'string' ? d.reason : 'off'}; fact matching only.` };
  const items: SimilarRuling[] = (Array.isArray(d.hits) ? d.hits : []).filter((h: any) => typeof h?.precedentId === 'string')
    .map((h: any) => ({ id: h.precedentId, title: title(h.precedentId), cosine: number(h.cosine), rerank: number(h.rerank), standing: similarStanding(h) }));
  if (!items.length) return { state: 'none', text: `No past ruling similar in meaning was found (${String(d.model ?? '')}/${String(d.dimension ?? '')}, ${String(d.reranker ?? '')}; none of the ${number(d.candidates?.length)} nearest reached a rerank score of ${number(d.threshold)}).` };
  return { state: 'listed', model: String(d.model ?? ''), dimension: number(d.dimension), reranker: String(d.reranker ?? ''), threshold: number(d.threshold), items };
}
const seconds = (ms: unknown) => `${(number(ms) / 1000).toFixed(1)} s`;
const who: Record<string, string> = { policy: 'Policy Analyst', judge: 'Arbitrator', judge_b: 'Arbitrator B', judge_c: 'Arbitrator C' };
/** One line per Voyage call for the External tab: "Embedding search, voyage-4-large, 0.4 s, 312 tokens; rerank-2.5, 0.9 s, 10 documents". */
export function semanticCallLines(events: SemanticEvent[] | null | undefined): { who: string; text: string; called: boolean }[] {
  return (events ?? []).filter(e => e?.kind === 'semantic_searched' && e.data && typeof e.data === 'object').map(e => {
    const d = e.data, by = who[String(e.actor ?? '')] ?? 'Agent', parts: string[] = [];
    if (d.embedding) parts.push(`Embedding search, ${String(d.model ?? '')}, ${seconds(d.embedding.ms)}, ${number(d.embedding.tokens)} tokens${d.embedding.status !== 'received' ? ` (not available: ${String(d.embedding.reason ?? '')})` : ''}`);
    else if (d.mode === 'on') parts.push(`Embedding search, ${String(d.model ?? '')}, the run's saved case vector reused`);
    if (d.rerank) parts.push(`${String(d.reranker ?? '')}, ${seconds(d.rerank.ms)}, ${number(d.rerank.documents)} document${number(d.rerank.documents) === 1 ? '' : 's'}${d.rerank.status !== 'received' ? ` (not available: ${String(d.rerank.reason ?? '')})` : ''}`);
    return { who: by, called: parts.length > 0, text: parts.length ? parts.join('; ') : `Semantic search unavailable: ${String(d.reason ?? 'off')}` };
  });
}
