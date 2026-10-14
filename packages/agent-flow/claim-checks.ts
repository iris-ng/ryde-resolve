import type { Artifact, CasePacket, Source } from './contracts';
import { rejectionLimit, TrustedRejection } from './citations';
import { deriveFacts } from './facts';
import { MIN_QUOTE_CHARS, normaliseWords, quoteProblem } from './quotes';

// Evidence checks 1 (MVP fixes, 10 October 2026): the claim checks on an advocate's opening argument in a pinned run. In run
// 02ea59f6 (DISP-002) the Rider Advocate's claim 2 rested on P04 by name but cited only the driver's first chat message, and
// another claim cited the whole chat log; both were accepted, since the checks proved only that cited lines exist and were read.
// Here each claim quotes its lines, lists every rule it rests on (and every rule ID its statement names), cites each listed rule's
// card, and cites narrowly. Structured checks only: a rule ID is a whole token from the case's own rule list, and the prose is
// never read for meaning (3 October 2026). That advocate needed five submissions because each rejection named one problem, so
// every problem comes back in one numbered rejection (claimRejection), with the submit tool's read failures added (tools.ts).

/** The most lines one claim or issue citation may cover. A whole source of this many lines or fewer always fits. */
export const maxCitationLines = 15;
/** The checks in the advocate's brief on a pinned run (prompt.ts), so a first submission can meet them. */
export const claimChecksBrief = `A claim that names a rule ID lists it in ruleIds, and a claim that lists a rule cites that rule's card (policy/public/<ruleId>.json) by the lines that state it. A claim or issue citation covers at most ${maxCitationLines} lines: cite the lines that show the point.`;

type Cite = { sourceId: string; startLine: number; endLine: number; quote?: string };
type Claim = { statement: string; ruleIds?: string[]; citations: Cite[] };
type Opening = { policyIds: string[]; claims?: Claim[]; issues?: { citations: Cite[] }[] };

const span = (c: Cite) => c.endLine - c.startLine + 1;
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
// Only trusted text (citations.ts, rule 1): a rejection reaches the event trail before the paired disclosure, so it names a claim
// and a citation by number, repeats a sourceId only when it is a pinned source, and never repeats a statement or a quote.
const claimLabel = (i: number) => `Claim ${i + 1}`;
const at = (where: string, j: number) => `${where}, citation ${j + 1}`;
function lines(packet: Pick<CasePacket, 'sources'>, c: Cite) {
  const id = packet.sources.some(s => s.id === c.sourceId) ? c.sourceId : 'this sourceId';
  return `${id} ${c.startLine === c.endLine ? `line ${c.startLine}` : `lines ${c.startLine}-${c.endLine}`}`;
}
const escaped = (id: string) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A rule ID written in the text as a whole token: P04 in "(P04)" or "P04," but not in P040, XP04 or P04x. */
const names = (text: string, id: string) => new RegExp(`(?<![A-Za-z0-9])${escaped(id)}(?![A-Za-z0-9])`).test(text);
const cardOf = (packet: Pick<CasePacket, 'sources'>, id: string) => packet.sources.find(s => s.id === `policy/public/${id}.json`);
// The card fields whose text states the rule (review of the joined core, 10 October 2026: a claim cited P04's card by its
// "id": "P04" line, quoted exactly). Its id, title, kind, categories, origin, page details (source_id, canonical_url, archive_path,
// sha256, line_start, line_end and the dates), dependencies, conflict IDs, status and the team's notes do not.
const ruleFields = new Set(['statement', 'conditions', 'limits', 'interpretation_proposed', 'exact_text']);
type RuleValue = { line: number; words: string };
const ruleValueCache = new WeakMap<Source, RuleValue[]>();
/**
 * The rule's wording on a card: each decoded string value under a rule field, with its line, normalised as a quote is. Found by
 * place in the card's pinned two-space form, where every value takes exactly the lines of its own serialisation, at any depth (as
 * own-side.ts elementRanges); a card in any other form falls back to its single-line rule fields. Keys and punctuation are never
 * part of it (review round 2: a quote of the key "statement" alone passed).
 */
function cardRuleValues(card: Source): RuleValue[] {
  const cached = ruleValueCache.get(card); if (cached) return cached;
  const out: RuleValue[] = [], add = (line: number, text: string) => out.push({ line, words: normaliseWords(text) });
  let value: unknown; try { value = JSON.parse(card.text); } catch { value = undefined; }
  if (value !== undefined && card.text === JSON.stringify(value, null, 2)) {
    const walk = (v: unknown, line: number, rule: boolean): number => {
      if (Array.isArray(v) && v.length) { let next = line + 1; for (const e of v) next = walk(e, next, rule); return next + 1; }
      if (v && typeof v === 'object' && Object.keys(v).length) { let next = line + 1; for (const [k, e] of Object.entries(v)) next = walk(e, next, rule || ruleFields.has(k)); return next + 1; }
      if (rule && typeof v === 'string') add(line, v);
      return line + 1;
    };
    walk(value, 1, false);
  } else card.lines.forEach((l, i) => { const m = l.match(/^\s*"(?:statement|interpretation_proposed|exact_text)"\s*:\s*("(?:[^"\\]|\\.)*")/); if (m) { try { add(i + 1, JSON.parse(m[1]) as string); } catch { /* not a JSON string: no rule words */ } } });
  ruleValueCache.set(card, out);
  return out;
}
/** The card lines that carry the rule's wording (cardRuleValues). */
export const cardRuleLines = (card: Source) => cardRuleValues(card).map(v => v.line);
/** Whether a citation of the card quotes the rule's words: its quote lies inside one rule value on a line it cites. */
function quotesRule(card: Source, c: Cite) {
  const quote = normaliseWords(c.quote ?? '');
  return quote.length >= MIN_QUOTE_CHARS && cardRuleValues(card).some(v => v.line >= c.startLine && v.line <= c.endLine && v.words.includes(quote));
}
/** The card, its length and the line its statement is on: a place to start, from the packet's own text. */
function cardText(card: Source) {
  const statement = card.lines.findIndex(l => /^\s*"statement"\s*:/.test(l)) + 1;
  return `${card.id} (${card.lines.length} lines${statement ? `; its statement is line ${statement}` : ''})`;
}
function widthProblem(packet: Pick<CasePacket, 'sources'>, where: string, c: Cite, quoted: boolean): string | null {
  if (span(c) <= maxCitationLines) return null;
  return `${where} (${lines(packet, c)}) covers ${span(c)} lines; a citation covers at most ${maxCitationLines}. Cite only the lines that show the point (for example one chat message), or split it into citations of at most ${maxCitationLines} lines${quoted ? ', each with its own exact quote' : ''}.`;
}

/**
 * Every claim-check problem in a pinned opening argument, in order: claim by claim (rule IDs, then each citation's width and
 * quote), then the issues' citations (width). Empty when it stands. Citations are already known to name pinned sources and
 * lines inside them (citationRejection runs first). A listed rule's card citation must quote the rule's own words
 * (cardRuleLines). A listed rule whose card is not pinned as a source (no policy/public/<id>.json) needs no card citation: there
 * is nothing to cite.
 */
export function openingClaimProblems(packet: CasePacket, artifact: Opening, allowedPolicyIds: string[] = deriveFacts(packet).allowedPolicyIds): string[] {
  const problems: string[] = [], pinned = new Set(packet.policies.map(p => p.rule_id)), inPolicyIds = (id: string) => artifact.policyIds.includes(id);
  const listPolicy = (id: string) => `add ${id} to policyIds (read it with read_policy first)`;
  (artifact.claims ?? []).forEach((claim, i) => {
    const label = claimLabel(i), ruleIds = claim.ruleIds ?? [];
    // The rule's card when the claim does not cite its words: no citation of the card, or only of lines that do not state the
    // rule (a card with no rule lines asks for any citation of it). `quoted` says which.
    const uncited = (id: string) => {
      const card = cardOf(packet, id); if (!card) return null;
      const cites = claim.citations.filter(c => c.sourceId === card.id);
      if (cites.length && (!cardRuleLines(card).length || cites.some(c => quotesRule(card, c)))) return null;
      return { ...card, quoted: cites.length > 0 };
    };
    // A rule the statement names is a rule the claim rests on. One item says everything a resubmission needs for it.
    for (const id of allowedPolicyIds.filter(id => names(claim.statement, id) && !ruleIds.includes(id))) {
      const card = uncited(id), steps = [`add ${id} to this claim's ruleIds`, ...(inPolicyIds(id) ? [] : [listPolicy(id)]), ...(card ? [`cite its card ${cardText(card)} by the lines that state the rule, with a short exact quote from them`] : [])];
      problems.push(`${label}: the statement names ${id}, but ruleIds does not list it. ${capital(steps.join(', '))}; or take ${id} out of the statement.`);
    }
    ruleIds.forEach((id, k) => {
      // A model-written ID is repeated only when it is a rule pinned in this packet (citations.ts, rule 1).
      if (!allowedPolicyIds.includes(id)) { problems.push(`${label}: ruleIds entry ${k + 1}${pinned.has(id) ? ` (${id})` : ''} is not one of this case's rules. Remove it, or use a rule ID that list_evidence lists under policies.`); return; }
      const card = uncited(id), gaps = [...(inPolicyIds(id) ? [] : ['policyIds does not list it']), ...(card ? [card.quoted ? 'no citation of its card quotes the words that state the rule (its statement, conditions, limits or quoted page text)' : 'the claim cites no line of its card'] : [])];
      if (!gaps.length) return;
      const fixes = [...(inPolicyIds(id) ? [] : [listPolicy(id)]), ...(card ? [`cite ${cardText(card)} by the lines that state the rule, with a short exact quote from them`] : [])];
      problems.push(`${label}: ruleIds lists ${id}, but ${gaps.join(' and ')}. ${capital(fixes.join(' and '))}; or remove ${id} from ruleIds.`);
    });
    claim.citations.forEach((c, j) => {
      const where = at(label, j), wide = widthProblem(packet, where, c, true), quote = quoteProblem(packet, c);
      if (wide) problems.push(wide);
      if (quote) problems.push(`${where}: ${quote}`);
    });
  });
  // Issue citations are shown to readers beside each issue (workbench.tsx), so they cite narrowly too. The argument's own
  // citation list is an index the read checks cover, not shown beside any statement, so it keeps its width.
  (artifact.issues ?? []).forEach((issue, i) => issue.citations.forEach((c, j) => { const wide = widthProblem(packet, at(`Issue ${i + 1}`, j), c, false); if (wide) problems.push(wide); }));
  return [...new Set(problems)];
}

/** The most the submit tool's read failures may take of a combined rejection; the claim problems come first. */
const readRoom = 800;
/**
 * One rejection for every problem, numbered: the claim problems, then the submit tool's read failures (readCheckRejection's text)
 * as one more item. Within rejectionLimit, so the event trail and the model see the same text; what does not fit is counted.
 * `what` names the submission: the opening argument, or (evidence checks 2, second release) a challenge's gap points or a decision's
 * answers to them, which use the same one-pass rejection.
 */
export function claimRejection(problems: string[], reads: string | null = null, what = 'opening argument'): string {
  const trimmed = reads?.replace(/\s*Then submit again\.$/, '').trim() ?? '';
  const read = trimmed.length > readRoom ? trimmed.slice(0, readRoom - 4) + ' ...' : trimmed;
  const total = problems.length + (read ? 1 : 0);
  const lead = `This ${what} has ${total === 1 ? 'one problem' : `${total} problems`}. Fix ${total === 1 ? 'it' : 'all of them'}, then submit again.`;
  const reserve = (read ? read.length + 6 : 0) + 30;
  let body = '', shown = 0;
  for (const problem of problems) {
    const next = `${body} ${shown + 1}. ${problem}`;
    if (lead.length + next.length + reserve > rejectionLimit) break;
    body = next; shown++;
  }
  const hidden = problems.length - shown;
  const text = lead + body + (hidden ? ` (${hidden} more not shown.)` : '') + (read ? ` ${shown + 1}. ${read}` : '');
  return text.length <= rejectionLimit ? text : text.slice(0, rejectionLimit - 4) + ' ...';
}

/** A pinned opening argument's claim problems (validateArtifact), or a pinned challenge's or decision's gap-point problems (`what`). The submit tool adds its read failures to the same rejection. */
export class ClaimCheckError extends TrustedRejection {
  constructor(readonly problems: string[], readonly artifact: Artifact, readonly what = 'opening argument') { super(claimRejection(problems, null, what)); }
}
