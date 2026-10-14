import type { CasePacket, Source } from './contracts';
import { normaliseWords, quoteProblem, type QuotedCitation } from './quotes';
import { authoredTexts, elementRanges, type AuthoredText } from './own-side';
import { fitList, rejectionLimit } from './citations';

// Evidence checks 1 (MVP fixes, 10 October 2026): the Evidence Collector's chat reading, checked against the chat's own
// structure. Which entries need a reading, and whose they are, come from the record's structured sender and type fields and
// their exact lines (own-side.ts elementRanges); each quote is compared word for word (quotes.ts). Nothing here reads meaning
// from the words: tone and act stay the model's labelled reading, shown and argued over, and no money fact or routing
// threshold reads them (facts read structured fields only, 3 October 2026). Their one use is the second safety opinion below.

export const chatSourceId = 'evidence/chat_logs.json';
type Cite = QuotedCitation & { quote: string };
export type ChatReading = { citation: Cite; sender: string; tone: string; act: string; repliesToLine: number | null; note: string | null };
type Disagreement = { citations: Cite[] };
/** One chat entry and its lines. `read`: a rider or driver entry that takes exactly one reading. */
export type ChatEntry = { startLine: number; endLine: number; sender: string; type: string; content: string | null; read: boolean };

// A call entry is the app's log of a call, not the party's words; a system line is Ryde's; an entry with no words (a photo sent
// with no caption) has nothing to read. Every other rider or driver entry is read, whatever its type, so a caption is read too.
const isParty = (e: { sender?: unknown; type?: unknown; content?: unknown }) => (e.sender === 'rider' || e.sender === 'driver') && e.type !== 'call' && e.type !== 'system' && typeof e.content === 'string' && !!e.content.trim();
/** The chat's entries, or null when there is no chat source or it is not the pinned array form (then only quotes are checked). */
export function chatEntries(packet: Pick<CasePacket, 'sources'>): { source: Source; entries: ChatEntry[] } | null {
  const source = packet.sources.find(s => s.id === chatSourceId), ranges = source ? elementRanges(source) : null;
  if (!source || !ranges) return null;
  const value = JSON.parse(source.text) as Record<string, unknown>[];
  return { source, entries: value.map((e, i) => ({ ...ranges[i], sender: typeof e?.sender === 'string' ? e.sender : 'unknown', type: typeof e?.type === 'string' ? e.type : 'message', content: typeof e?.content === 'string' ? e.content : null, read: !!e && isParty(e) })) };
}
const span = (e: { startLine: number; endLine: number }) => `${e.startLine}-${e.endLine}`;
const what = (e: ChatEntry) => e.sender === 'system' || e.type === 'system' ? 'the system message' : e.type === 'call' ? `the ${e.sender}'s call log` : !e.content?.trim() ? `the ${e.sender}'s ${e.type} with no words` : `the ${e.sender}'s message`;
const wordsOf = (entries: ChatEntry[]) => entries.filter(e => e.read && e.content !== null).map(e => e.content!);
/** "evidence/chat_logs.json lines 6, 12, 30; evidence/statements.json line 12", at most 8 lines a source. */
const wordLines = (texts: AuthoredText[]) => [...new Set(texts.map(t => t.sourceId))].map(id => { const at = texts.filter(t => t.sourceId === id).map(t => t.line); return `${id} line${at.length > 1 ? 's' : ''} ${at.slice(0, 8).join(', ')}${at.length > 8 ? ` and ${at.length - 8} more` : ''}`; }).join('; ');
const excerpt = (text: string | null) => !text ? '' : ` ("${text.length > 90 ? text.slice(0, 87) + '...' : text}")`;

/** Every problem with a submission's chat reading and its disagreement quotes, each saying exactly what to change. */
export function chatReadingProblems(packet: Pick<CasePacket, 'sources'>, artifact: { chatReadings?: ChatReading[]; disagreements?: Disagreement[] }): string[] {
  const problems: string[] = [], readings = artifact.chatReadings ?? [], chat = chatEntries(packet);
  const hasChat = packet.sources.some(s => s.id === chatSourceId), party = chat?.entries.filter(e => e.read) ?? [];
  if (!hasChat || (chat && !party.length)) {
    if (readings.length) problems.push(`${hasChat ? 'The chat has no rider or driver message with words' : `This case has no chat log (${chatSourceId})`}, so chatReadings must be empty: remove all ${readings.length}.`);
  } else {
    const readBy = new Map<ChatEntry, number[]>();
    readings.forEach((r, i) => {
      const at = `chatReadings[${i}]`, c = r.citation;
      if (c.sourceId !== chatSourceId) { problems.push(`${at} cites ${packet.sources.some(s => s.id === c.sourceId) ? c.sourceId : 'a source that is not pinned'}; a chat reading cites ${chatSourceId} only, the lines of one message.`); return; }
      const touched = chat ? chat.entries.filter(e => c.startLine <= e.endLine && c.endLine >= e.startLine) : [], entry = touched[0];
      // A short message ("Ok.") is quoted whole; an excerpt still needs the minimum length (quotes.ts).
      const quote = quoteProblem(packet, c, wordsOf(touched));
      if (quote) problems.push(`${at}.citation: ${quote}`);
      if (!chat) return;
      if (touched.length !== 1 || c.startLine < entry.startLine || c.endLine > entry.endLine) {
        problems.push(`${at} cites lines ${c.startLine}-${c.endLine}, which ${touched.length > 1 ? `span ${touched.length} messages (lines ${touched.map(span).join(', ')})` : 'are not inside one chat message'}. Cite one message's lines only; the rider and driver messages are at lines ${party.map(span).join(', ')}.`);
        return;
      }
      if (!entry.read) { problems.push(`${at} cites ${what(entry)} at lines ${span(entry)}; only rider and driver messages with words take a reading (system messages, call logs and entries with no words take none). Remove it.`); return; }
      readBy.set(entry, [...(readBy.get(entry) ?? []), i]);
      if (r.sender !== entry.sender) problems.push(`${at} gives sender "${r.sender}", but the message at lines ${span(entry)} was sent by the ${entry.sender}: set sender to "${entry.sender}".`);
      if (!quote && entry.content !== null && !normaliseWords(entry.content).includes(normaliseWords(c.quote))) problems.push(`${at}: quote the message's words (its content), not its timestamp, sender or type.`);
      if (r.repliesToLine !== null) {
        const earlier = chat.entries.filter(e => e.startLine < entry.startLine);
        if (!earlier.some(e => e.startLine === r.repliesToLine)) problems.push(`${at}.repliesToLine ${r.repliesToLine} is not the first line of an earlier message. ${earlier.length ? `Earlier messages start at lines ${earlier.map(e => e.startLine).join(', ')}; use one of those, or null when it answers none.` : 'No message comes before this one; use null.'}`);
      }
    });
    for (const [entry, at] of readBy) if (at.length > 1) problems.push(`${at.map(i => `chatReadings[${i}]`).join(', ')} all read ${what(entry)} at lines ${span(entry)}; keep exactly one reading for each message.`);
    for (const e of party.filter(e => !readBy.has(e))) problems.push(`No reading for ${what(e)} at ${chatSourceId} lines ${span(e)}${excerpt(e.content)}: add one, in chat order.`);
  }
  // A disagreement has two sides, and each quotes that party's own words: a text value the party wrote, found from the record's
  // authorship fields (own-side.ts authoredTexts, complete), never a key, a sender, a call log or a timestamp. So neither side
  // can be invented. Where the words sit is checked here; that the quote stands in its cited lines, above.
  const own = { rider: authoredTexts(packet, 'rider'), driver: authoredTexts(packet, 'driver') };
  const quotes = (c: Cite, t: AuthoredText) => t.sourceId === c.sourceId && t.line >= c.startLine && t.line <= c.endLine && typeof c.quote === 'string' && !!normaliseWords(c.quote) && normaliseWords(t.text).includes(normaliseWords(c.quote));
  (artifact.disagreements ?? []).forEach((d, i) => {
    const misquoted = d.citations.filter((c, j) => { const q = quoteProblem(packet, c, c.sourceId === chatSourceId ? wordsOf(chat?.entries.filter(e => c.startLine <= e.endLine && c.endLine >= e.startLine) ?? []) : []); if (q) problems.push(`disagreements[${i}].citations[${j}]: ${q}`); return !!q; });
    for (const side of ['rider', 'driver'] as const) {
      const texts = own[side], on = (c: Cite) => texts.some(t => t.sourceId === c.sourceId && t.line >= c.startLine && t.line <= c.endLine);
      // A citation on the party's words whose quote is already reported above: fixing that quote answers this side too.
      if (d.citations.some(c => texts.some(t => quotes(c, t))) || misquoted.some(on)) continue;
      problems.push(texts.length ? `disagreements[${i}] quotes nothing the ${side} wrote: ${side}Says needs at least one citation whose quote is the ${side}'s own words (a statement's text, a chat message, the ticket's description, notes or the ${side}'s allegations, a document's text), not a field name, a sender or a call log. The ${side}'s words are at ${wordLines(texts)}.`
        : `disagreements[${i}]: the ${side} wrote nothing on the record (no statement, chat message, ticket or document text of theirs), so there is no ${side} side to quote. Remove it.`);
    }
  });
  return problems;
}
/** All the problems in one numbered rejection, or null. */
export function chatReadingRejection(packet: Pick<CasePacket, 'sources'>, artifact: { chatReadings?: ChatReading[]; disagreements?: Disagreement[] }): string | null {
  const problems = chatReadingProblems(packet, artifact);
  if (!problems.length) return null;
  const lead = `Chat reading: ${problems.length === 1 ? 'one problem. Fix it' : `${problems.length} problems. Fix each one`}, then submit again. `;
  return fitList(lead, problems.map((p, i) => `(${i + 1}) ${p}`), ' ', ' Every other reading stands as submitted.', rejectionLimit, n => ` (${n} more not shown: fix these, then submit again.)`);
}
/** The readings in chat order (the schema asks for chat order; the server keeps it rather than reject a shuffle). */
export const inChatOrder = <T extends { citation: { startLine: number } }>(readings: T[]) => [...readings].sort((a, b) => a.citation.startLine - b.citation.startLine);

/**
 * F7, the second safety opinion (owner decision D5, 10 October 2026: stop early): the sealed readings of a threat or of abusive
 * wording. Any one sends the case to a person before the Policy Analyst and the advocates (flow.ts, worker.ts), and makes
 * routing treat the case as a safety case if a person clears it to go on (safety.ts). It can only add a stop, never clear one.
 * Only a pinned run carries readings: the unpinned observations schema is strict and refuses them.
 */
export const chatReadingKind = 'chat_reading';
export function chatSafetyReadings(observations: unknown): ChatReading[] {
  const readings = (observations as { chatReadings?: unknown } | null | undefined)?.chatReadings;
  return Array.isArray(readings) ? readings.filter((r): r is ChatReading => !!r && typeof r === 'object' && ((r as ChatReading).act === 'threat' || (r as ChatReading).tone === 'abusive')) : [];
}
/**
 * The safety handoff a chat reading opens: the safety screen's fields (status, owner, kind, note, and the lines as flags in
 * `sources`), plus each reading, so the screen can say what was read and show the quotes. `cleared`: an evaluation run the
 * operator marked cleared for merits review in advance (flow.ts safetyCleared), recorded as at the safety screen.
 */
export function chatSafetyHandoff(readings: ChatReading[], cleared = false) {
  return { status: cleared ? 'cleared_for_fare_review' : 'unassigned', owner: cleared ? 'operator (evaluation)' : null, kind: chatReadingKind,
    note: `The Evidence Collector read ${readings.length === 1 ? 'a chat message' : `${readings.length} chat messages`} as a possible threat or abusive wording. Read the original chat and assign a responsible reviewer. This is a model's reading, not a finding about either party.`,
    sources: readings.map(r => ({ kind: r.act === 'threat' ? 'possible_threat' : 'abusive_wording', sourceId: r.citation.sourceId, startLine: r.citation.startLine, endLine: r.citation.endLine, quote: r.citation.quote })),
    readings: readings.map(r => ({ sender: r.sender, tone: r.tone, act: r.act, quote: r.citation.quote, sourceId: r.citation.sourceId, startLine: r.citation.startLine, endLine: r.citation.endLine, note: r.note })) };
}
export type ChatSafetyHandoff = ReturnType<typeof chatSafetyHandoff>;
