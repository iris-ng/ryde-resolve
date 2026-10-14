import type { CasePacket, Source } from './contracts';
import { routeReferenceSourceId } from '../case-packet/route-reference';

// Evidence checks 1 (MVP fixes, 10 October 2026): each advocate starts from what its own party put on the record. The list is
// built from the record's structured authorship fields (filed_by, party, sender, submitted_by), never from a model, and points
// at exact lines. Everything else is a Ryde record both advocates may use. It is a reading guide, not an access limit.
export type Party = 'rider' | 'driver';
export type OwnSideItem = { sourceId: string; startLine: number; endLine: number; what: string };
export type OwnSide = { party: Party; items: OwnSideItem[]; rydeRecords: string[]; references: string[]; notice: string };

const parse = (source: Source | undefined): unknown => { try { return source ? JSON.parse(source.text) : null; } catch { return null; } };

/**
 * The line range of each element of a top-level array source. Sources are JSON.stringify(value, null, 2), so element i spans
 * exactly the lines of its own two-space-indented serialisation, starting on line 2. Returns null when the text is not that form.
 */
export function elementRanges(source: Source): { startLine: number; endLine: number }[] | null {
  const value = parse(source);
  if (!Array.isArray(value) || source.text !== JSON.stringify(value, null, 2)) return null;
  let line = 2;
  return value.map(element => {
    const span = JSON.stringify(element, null, 2).split('\n').length;
    const range = { startLine: line, endLine: line + span - 1 };
    line += span;
    return range;
  });
}

/** One text value a party wrote: the line that holds it and its words (JSON string escapes decoded). */
export type AuthoredText = { sourceId: string; line: number; text: string };
// The fields that hold a party's own words, by source; everything else (keys, times, senders, extracted fields) is metadata.
const authoredFields: { id: string; author: (e: any) => unknown; keys: string[]; skip?: (e: any) => boolean }[] = [
  { id: 'evidence/statements.json', author: e => e?.party, keys: ['text'] },
  // A call entry is the app's log of a call and a system line is Ryde's: neither is the party's words.
  { id: 'evidence/chat_logs.json', author: e => e?.sender, keys: ['content'], skip: e => e?.type === 'call' || e?.type === 'system' },
  { id: 'evidence/documents.json', author: e => e?.submitted_by, keys: ['text'] },
];
const textLine = /^\s*"([^"\\]+)":\s*("(?:[^"\\]|\\.)*")\s*,?\s*$/;
function textsIn(source: Source, startLine: number, endLine: number, keys: string[]): AuthoredText[] {
  const out: AuthoredText[] = [];
  for (let line = startLine; line <= endLine; line++) {
    const m = source.lines[line - 1]?.match(textLine);
    if (m && keys.includes(m[1])) { try { out.push({ sourceId: source.id, line, text: JSON.parse(m[2]) }); } catch { /* not a JSON string */ } }
  }
  return out;
}
/**
 * Every text value the party itself wrote, complete (the own-side list shown to an advocate stops at 30 items; this never does),
 * found from the record's authorship fields (MVP fixes, 10 October 2026): the filer's ticket description, notes and allegations,
 * the party's statements, its chat messages' words and its documents' text. A disagreement quotes each side from these.
 */
export function authoredTexts(packet: Pick<CasePacket, 'sources'>, party: Party): AuthoredText[] {
  const evidence = packet.sources.filter(s => s.id.startsWith('evidence/')), byId = (id: string) => evidence.find(s => s.id === id);
  const out: AuthoredText[] = [], ticket = byId('evidence/dispute_ticket.json');
  if (ticket) {
    // The filer wrote the description and the remedy notes; each issue's allegation is its alleged_by party's (a ticket can
    // record the other party's counter-allegation, as DISP-006 does). Allegation lines come in issue order.
    const t = parse(ticket) as { filed_by?: unknown; issues?: { alleged_by?: unknown; allegation?: unknown }[] } | null;
    if (t?.filed_by === party) out.push(...textsIn(ticket, 1, ticket.lines.length, ['description', 'notes']));
    const alleged = (Array.isArray(t?.issues) ? t!.issues : []).filter(i => typeof i?.allegation === 'string'), lines = textsIn(ticket, 1, ticket.lines.length, ['allegation']);
    if (lines.length === alleged.length) lines.forEach((x, i) => { if ((alleged[i].alleged_by ?? t?.filed_by) === party) out.push(x); });
  }
  for (const spec of authoredFields) {
    const source = byId(spec.id), value = parse(source), ranges = source ? elementRanges(source) : null;
    if (!source || !Array.isArray(value) || !ranges) continue;
    value.forEach((e, i) => { if (spec.author(e) === party && !spec.skip?.(e)) out.push(...textsIn(source, ranges[i].startLine, ranges[i].endLine, spec.keys)); });
  }
  return out;
}

const MAX_ITEMS = 30;
const label: Record<Party, string> = { rider: 'The rider', driver: 'The driver' };

export function ownSideIndex(packet: Pick<CasePacket, 'sources'>, party: Party): OwnSide {
  const items: OwnSideItem[] = [];
  const evidence = packet.sources.filter(s => s.id.startsWith('evidence/'));
  const byId = (id: string) => evidence.find(s => s.id === id);
  // The ticket belongs to the party that filed it.
  const ticketSource = byId('evidence/dispute_ticket.json'), ticket = parse(ticketSource) as { filed_by?: unknown } | null;
  if (ticketSource && ticket?.filed_by === party) { items.push({ sourceId: ticketSource.id, startLine: 1, endLine: ticketSource.lines.length, what: `${label[party]}'s dispute ticket` }); }
  // Array sources whose elements name an author: statements (party), chat (sender), documents and photos (submitted_by).
  const authored: { id: string; author: (e: any) => unknown; what: (e: any) => string; merge: boolean }[] = [
    { id: 'evidence/statements.json', author: e => e?.party, what: e => `${label[party]}'s statement${typeof e?.submitted_at === 'string' ? ` (${e.submitted_at})` : ''}`, merge: false },
    { id: 'evidence/chat_logs.json', author: e => e?.sender, what: () => `${label[party]}'s chat messages`, merge: true },
    { id: 'evidence/documents.json', author: e => e?.submitted_by, what: e => `${label[party]}'s document${typeof e?.document_id === 'string' ? ` ${e.document_id}` : ''}${typeof e?.kind === 'string' ? ` (${e.kind.replace(/_/g, ' ')})` : ''}`, merge: false },
    { id: 'evidence/photos.json', author: e => e?.submitted_by, what: e => `${label[party]}'s photo${typeof e?.photo_id === 'string' ? ` ${e.photo_id}` : ''}`, merge: false },
  ];
  for (const spec of authored) {
    const source = byId(spec.id), value = parse(source), ranges = source ? elementRanges(source) : null;
    if (!source || !Array.isArray(value) || !ranges) continue;
    let open: OwnSideItem | null = null;
    value.forEach((element, i) => {
      if (spec.author(element) !== party) { open = null; return; }
      // Consecutive chat messages from the party read as one item, so a long exchange stays one line of the list.
      if (spec.merge && open && open.endLine + 1 === ranges[i].startLine) { open.endLine = ranges[i].endLine; return; }
      open = { sourceId: source.id, ...ranges[i], what: spec.what(element) };
      items.push(open);
    });
  }
  const kept = items.slice(0, MAX_ITEMS);
  return {
    party, items: kept,
    // Ryde's own records: every evidence source with no party author (trip, GPS, app events, fare, payments, profiles ...).
    rydeRecords: evidence.map(s => s.id).filter(id => id !== 'evidence/dispute_ticket.json' && id !== routeReferenceSourceId && !authored.some(a => a.id === id)),
    // The saved best road route (route-reference.ts) is the team's reference, not a Ryde record and not part of the case file.
    references: evidence.some(s => s.id === routeReferenceSourceId) ? [routeReferenceSourceId] : [],
    notice: `Items ${party === 'rider' ? 'the rider' : 'the driver'} put on the record, found from the record's own authorship fields${items.length > kept.length ? ` (first ${MAX_ITEMS} of ${items.length})` : ''}. Start from them, then test them against Ryde's own records (rydeRecords). The ticket, statements, chat, documents and photos also hold the other party's items. Both advocates may read and cite every source; this list is a starting point, not a limit.`,
  };
}
