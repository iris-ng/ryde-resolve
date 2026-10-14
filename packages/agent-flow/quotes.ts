import type { CasePacket, Source } from './contracts';

// Evidence checks 1 (MVP fixes, 10 October 2026): a quoted citation must quote its own lines. This compares the agent's
// quote with the cited text, word for word after a fixed normalisation; it never reads meaning (facts read structured fields
// only, 3 October 2026). Shared by the claim checks and the chat-reading checks.
export const MIN_QUOTE_CHARS = 6;

const unescaped: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: ' ', f: ' ', n: ' ', r: ' ', t: ' ' };
/** JSON string escapes decoded once, left to right: the sources are JSON text, a quote is the words as read. Source side only. */
export function decodeJsonEscapes(text: string): string {
  return text.replace(/\\(?:u([0-9a-fA-F]{4})|(["\\/bfnrt]))/g, (_, hex: string | undefined, c: string | undefined) => hex ? String.fromCharCode(parseInt(hex, 16)) : unescaped[c!]);
}
/** Lower-case, straight quotes and dashes, plain spaces, whitespace collapsed: the same for the quote and the cited words. */
export function normaliseWords(text: string): string {
  return text
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/ /g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
/** JSON text as its words read: string escapes decoded once, then normalised as a quote is (normaliseWords). */
export const normaliseQuoteText = (text: string) => normaliseWords(decodeJsonEscapes(text));
// In valid JSON a backslash occurs only inside a string value, so decoding a JSON source's lines decodes exactly its string
// values. Any other source (a TXT, Markdown or CSV upload) is plain text: its backslashes are its own characters.
const jsonText = new WeakMap<Source, boolean>();
const isJson = (source: Source) => { let known = jsonText.get(source); if (known === undefined) { try { JSON.parse(source.text); known = true; } catch { known = false; } jsonText.set(source, known); } return known; };
/** A source's cited lines as their words read: JSON sources decoded once (normaliseQuoteText), plain text only normalised. */
export const citedWords = (source: Source, startLine: number, endLine: number) => { const text = source.lines.slice(startLine - 1, endLine).join(' '); return isJson(source) ? normaliseQuoteText(text) : normaliseWords(text); };

export type QuotedCitation = { sourceId: string; startLine: number; endLine: number; quote?: string };

/**
 * Why this citation's quote does not stand, or null when it is found word for word in the cited lines. The text never repeats the
 * quote, and repeats the sourceId only when it is a pinned source (citations.ts, rule 1): a rejection reaches the event trail
 * before disclosure, and a sealed argument must not. `whole`: complete texts (a chat message's words) that may be quoted in full
 * even when shorter than the minimum, such as "Ok." (DISP-021, MVP fixes, 10 October 2026); an excerpt still needs the minimum.
 */
export function quoteProblem(packet: Pick<CasePacket, 'sources'>, citation: QuotedCitation, whole: readonly string[] = []): string | null {
  const source = packet.sources.find(s => s.id === citation.sourceId);
  const where = `${source ? source.id : 'This sourceId'}:${citation.startLine}-${citation.endLine}`;
  if (typeof citation.quote !== 'string' || !citation.quote.trim()) return `${where} has no quote. Copy a short exact quote from the cited lines.`;
  const quote = normaliseWords(citation.quote);
  if (quote.length < MIN_QUOTE_CHARS && !whole.some(text => normaliseWords(text) === quote)) return `${where}: the quote is too short to check (${quote.length} characters). Quote at least ${MIN_QUOTE_CHARS} characters of the cited text${whole.length ? ', or the message\'s complete words' : ''}.`;
  if (!source) return `${where}: no such source.`;
  if (citation.startLine < 1 || citation.endLine < citation.startLine || citation.endLine > source.lines.length) return `${where}: the line range is outside the source (1 to ${source.lines.length}).`;
  const cited = citedWords(source, citation.startLine, citation.endLine);
  return cited.includes(quote) ? null : `${where}: the quote is not in those lines. Quote the cited lines word for word, or cite the lines that say it.`;
}
