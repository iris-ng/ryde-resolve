import type { CasePacket, Source } from './contracts';

// Rejection text for citations (3 October 2026). The checks are the validator's (contracts.ts) and the case tools'
// (tools.ts); this file only words the rejection. Across the pilot and the 1 October runs "Invalid source citation" was
// the most common rejected submission and named neither the citation nor the fix, so agents guessed, re-read whole
// sources or called list_evidence to find line counts. Every likely cause shown here comes from those runs: a policy card
// cited with the line numbers its sources[] give for the archived Ryde page (P08, P17, P18 and P38 quote lines 111 to 256
// of pages their 42 to 68 line cards do not have), an archived page cited by its own path, and lines past the first 100
// of a long source.
// Two rules. (1) Only trusted text: a model-written sourceId is repeated only when it is
// exactly an ID the packet holds (a pinned source, a rule ID, an archived page's source_id or archive_path); otherwise the
// citation is named by its place in the submission, and every suggestion comes from the packet. A sealed argument cannot
// reach the event trail this way, even dressed as a path. (2) One length: every rejection here fits rejectionLimit, so the
// tool_error event and the model (toolHandler passes up to 2000 characters) see the same text; parts that do not fit are
// counted, never cut off silently.
type Cite = { sourceId: string; startLine: number; endLine: number };
/**
 * A rejection built never to repeat model text (rule 1): this file's citation and
 * read-check rejections, the claim checks, the chat-reading checks and the gap-point checks, and the case tools' own fixed refusals.
 * Only its message reaches the event trail; any other error is logged there as a fixed line, while the model still reads it in full.
 */
export class TrustedRejection extends Error {}
/** The longest rejection this file writes. */
export const rejectionLimit = 1900;
/** read_evidence returns at most this many lines per call. */
const readWindow = 100;
const lines = (a: number, b: number) => a === b ? `line ${a}` : `lines ${a}-${b}`;
const base = (id: string) => id.trim().toLowerCase().split('/').pop()!.replace(/\.[a-z]+$/, '');
const sized = (s: Source) => `${s.id} (${s.lines.length} lines)`;
const pages = (rule: CasePacket['policies'][number]) => (Array.isArray(rule.sources) ? rule.sources : []) as { source_id?: unknown; archive_path?: unknown }[];
/** True only for an ID the packet itself holds, which is safe to repeat back. */
function knownId(packet: CasePacket, id: string): boolean {
  return packet.sources.some(s => s.id === id) || packet.policies.some(r => r.rule_id === id || pages(r).some(p => p.source_id === id || p.archive_path === id));
}
const named = (packet: CasePacket, id: string) => knownId(packet, id) ? `"${id}"` : 'This sourceId';
/** "1-100, 102" from a set of line numbers. */
export function lineRanges(set: Iterable<number>): string {
  const sorted = [...new Set(set)].sort((a, b) => a - b), out: string[] = [];
  for (let i = 0; i < sorted.length; i++) { let j = i; while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++; out.push(sorted[i] === sorted[j] ? String(sorted[i]) : `${sorted[i]}-${sorted[j]}`); i = j; }
  return out.join(', ');
}
/**
 * lead, then as many items as fit, then "and N more" for the rest, then tail, within `room` characters. The result never
 * exceeds `room`: if even the count does not fit, it is cut with a closing "...".
 */
export function fitList(lead: string, items: string[], sep: string, tail: string, room: number, more = (n: number) => `${sep}and ${n} more not shown`): string {
  let body = '', shown = 0;
  for (const item of items) {
    const next = shown ? body + sep + item : item, rest = items.length - shown - 1;
    if ((lead + next + (rest ? more(rest) : '') + tail).length > room) break;
    body = next; shown++;
  }
  const text = lead + body + (shown < items.length ? (shown ? more(items.length - shown) : more(items.length).replace(sep, '')) : '') + tail;
  return text.length <= room ? text : text.slice(0, Math.max(0, room - 4)) + ' ...';
}
// The archived pages each pinned card quotes (rule.sources: source_id, archive_path). Older packets carry none.
function quotingCards(packet: CasePacket, id: string): Source[] {
  const wanted = id.trim().toLowerCase(), cards: Source[] = [];
  for (const rule of packet.policies) {
    const quotes = pages(rule).some(p => [p.source_id, p.archive_path].some(v => typeof v === 'string' && v.length > 2 && (v.toLowerCase() === wanted || base(v) === base(wanted) || (/^\d{6,}$/.test(v) && wanted.includes(v)))));
    const card = packet.sources.find(s => s.id === `policy/public/${rule.rule_id}.json`);
    if (quotes && card) cards.push(card);
  }
  return cards;
}
const few = (sources: Source[], joiner: string) => sources.slice(0, 4).map(sized).join(joiner) + (sources.length > 4 ? ` and ${sources.length - 4} more` : '');
/** Why one citation is invalid, or null. The same three tests as the validator: an unknown source, a reversed range, a range past the end. */
export function citationProblem(packet: CasePacket, c: Cite): { text: string; unknown: boolean } | null {
  const source = packet.sources.find(s => s.id === c.sourceId);
  if (source && c.endLine >= c.startLine && c.endLine <= source.lines.length) return null;
  if (!source) {
    const near = packet.sources.filter(s => base(s.id) === base(c.sourceId));
    if (near.length) return { unknown: false, text: `${named(packet, c.sourceId)} is not a pinned source; did you mean ${few(near, ' or ')}? Use the sourceId exactly as list_evidence gives it.` };
    const cards = quotingCards(packet, c.sourceId);
    if (cards.length) return { unknown: false, text: `${knownId(packet, c.sourceId) ? `"${c.sourceId}" is an archived Ryde page` : 'This sourceId looks like an archived Ryde page'} that policy cards quote, not a pinned source. Cite the card that quotes it, with the card's own line numbers: ${few(cards, ', ')}.` };
    if (/calculation|^facts?$|^derived\/facts/i.test(c.sourceId.trim())) return { unknown: false, text: `${named(packet, c.sourceId)} is not a source: read_calculations output cannot be cited. Cite the original lines each fact lists in its citations.` };
    return { unknown: true, text: `${named(packet, c.sourceId)} is not a pinned source in this case.` };
  }
  if (c.endLine < c.startLine) return { unknown: false, text: `${source.id}: endLine ${c.endLine} comes before startLine ${c.startLine}. Put the first line in startLine and the last in endLine.` };
  const card = source.id.startsWith('policy/public/') ? ` Line numbers under a card's sources (line_start, line_end) count lines of the archived Ryde page, not of the card; cite the card's own lines, 1 to ${source.lines.length}.` : ` Cite lines 1 to ${source.lines.length} only.`;
  return { unknown: false, text: `${source.id} has ${source.lines.length} lines, so ${lines(c.startLine, c.endLine)} run${c.startLine === c.endLine ? 's' : ''} past its end.${card}` };
}
/** Where each citation object sits in a submission (for example criteria[2].citations[0]). Keys come from the strict schema. */
function citationPaths(artifact: unknown): Map<object, string> {
  const at = new Map<object, string>();
  const walk = (x: unknown, path: string) => {
    if (Array.isArray(x)) x.forEach((v, i) => walk(v, `${path}[${i}]`));
    else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) {
      const here = path ? `${path}.${k}` : k;
      if (k === 'citations' && Array.isArray(v)) v.forEach((c, i) => { if (c && typeof c === 'object') at.set(c, `${here}[${i}]`); });
      else walk(v, here);
    }
  };
  walk(artifact, '');
  return at;
}
/**
 * The rejection for a submission's invalid citations, or null when every one names a pinned source and lines inside it.
 * `cites` is the validator's own list (citationsFor), so what is checked does not change; this adds where each invalid
 * citation sits, why it fails and what to cite instead, all in one rejection.
 */
export function citationRejection(packet: CasePacket, artifact: unknown, cites: Cite[]): string | null {
  const at = citationPaths(artifact), problems = new Map<string, { where: string[]; unknown: boolean }>();
  for (const c of cites) {
    const problem = citationProblem(packet, c); if (!problem) continue;
    const entry = problems.get(problem.text) ?? { where: [], unknown: problem.unknown };
    entry.where.push(at.get(c) ?? 'a citation'); problems.set(problem.text, entry);
  }
  if (!problems.size) return null;
  const count = [...problems.values()].reduce((n, p) => n + p.where.length, 0);
  const items = [...problems.entries()].map(([text, p]) => `${p.where.slice(0, 3).join(', ')}${p.where.length > 3 ? ` and ${p.where.length - 3} more` : ''}: ${text}`);
  const lead = `Invalid source citation: ${count === 1 ? 'one citation names' : `${count} citations name`} a source or lines that do not exist. `;
  const message = fitList(lead, items, ' ', ' Fix each one, then submit again.', rejectionLimit, n => ` ${n} more problems not shown.`);
  // An unknown source with no better guess gets the pinned list, in whatever room the problems leave.
  if (![...problems.values()].some(p => p.unknown) || rejectionLimit - message.length < 80) return message;
  return message + fitList(' Pinned sources: ', packet.sources.map(sized), ', ', '.', rejectionLimit - message.length, n => `, and ${n} more (list_evidence lists them all)`);
}
/** The fewest read_evidence calls, each within the read limit, that together cover every line in `missing`. */
export function readsCovering(missing: Iterable<number>): [number, number][] {
  const sorted = [...new Set(missing)].sort((a, b) => a - b), reads: [number, number][] = [];
  for (const line of sorted) { const last = reads.at(-1); if (last && line <= last[0] + readWindow - 1) last[1] = line; else reads.push([line, line]); }
  return reads;
}
/**
 * The case tools' read-check rejection: every cited line not read in this task, grouped by source, with the exact reads
 * that cover it; cited policies not read; calculations not read; the Judge's required sources not read. One message,
 * within rejectionLimit; sources and IDs here are pinned or validated, never model text.
 */
export function readCheckRejection(packet: CasePacket, failed: { unread: Map<string, Set<number>>; read: Map<string, Set<number>>; unreadPolicies: string[]; calculationsUnread: boolean; missingJudgeSources: string[] }): string | null {
  const { unread, read, unreadPolicies, calculationsUnread, missingJudgeSources } = failed;
  const fixed = [
    ...(unreadPolicies.length ? ['Read each cited policy before submission: ' + unreadPolicies.join(', ') + ' ' + (unreadPolicies.length === 1 ? 'is' : 'are') + ' in policyIds but not read with read_policy in this task.'] : []),
    ...(calculationsUnread ? ['Read the deterministic calculations before submission: call read_calculations.'] : []),
    ...(missingJudgeSources.length ? [fitList('Arbitrator must inspect decisive source: ', missingJudgeSources, ', ', ' (not read in this task; read each with read_evidence).', 600)] : []),
  ];
  if (!unread.size && !fixed.length) return null;
  const tail = ' Then submit again.', rest = fixed.length ? ' ' + fixed.join(' ') : '';
  const items = [...unread.entries()].map(([id, missing]) => {
    const had = read.get(id), total = packet.sources.find(s => s.id === id)?.lines.length, reads = readsCovering(missing);
    const it = missing.size === 1 ? 'it' : 'them';
    const how = reads.length === 1 ? `read ${it} with read_evidence, sourceId ${id}, startLine ${reads[0][0]}, endLine ${reads[0][1]}` : `read them with read_evidence, sourceId ${id}, once for each startLine-endLine pair: ${reads.map(([a, b]) => `${a}-${b}`).join(', ')}`;
    return `${id} ${missing.size === 1 ? 'line' : 'lines'} ${lineRanges(missing)} (${had?.size ? `you read lines ${lineRanges(had)}${total ? ` of ${total}` : ''}` : 'not read in this task'}; ${how})`;
  });
  const unreadText = items.length ? fitList('Citation not directly read in this task: ', items, '; ', '. Read those lines, or cite only lines you read.', rejectionLimit - rest.length - tail.length, n => `; and ${n} more sources not shown`) : '';
  const message = (unreadText + rest).trim() + tail;
  return message.length <= rejectionLimit ? message : message.slice(0, rejectionLimit - 4) + ' ...';
}
