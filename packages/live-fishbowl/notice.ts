import type { CasePacket } from '../agent-flow/contracts';
import { assumptionById } from '../agent-flow/posture';

export type NoticeParty = 'rider' | 'driver';
export type PrivacyFinding = { field: string; excerpt: string };
export type EditorialFinding = { kind: 'statistic' | 'promise' | 'past_ruling'; excerpt: string };
/** Said when a party notice names a past ruling: riders and drivers must not read the team's examples as Ryde policy. */
export const pastRulingFinding = 'Names a past ruling; riders and drivers should not read our team\'s examples as Ryde policy';
export type PartyNotice = {
  party: NoticeParty;
  headline: string;
  explanation: string;
  forYou: string;
  status: string;
  // Nothing sends a review or appeal request in this prototype, so the link says so (spec revision 16).
  appeal: { text: string; href: string; simulated: true };
  // ready: nothing holds this notice. Kept on privacy for older readers; the same value as the top-level ready.
  privacy: { findings: PrivacyFinding[]; ready: boolean };
  // Statistics or promises of payment or deadlines anywhere in the party-facing text hold the notice for a person.
  editorial: { findings: EditorialFinding[] };
  ready: boolean;
  // Team readings (approved assumptions, not Ryde policy) the proposal rests on, shown to both parties alike.
  readings: string[];
};

type NoticeDecision = {
  outcome: 'refund_recommendation' | 'charge_recommendation' | 'driver_payment_recommendation' | 'no_action' | 'human_review';
  remedy: { medium: 'none' | 'card' | 'voucher' | 'rider_charge' | 'driver_payment'; amountCents: number };
  // A driver payment's separate recovery from the rider (contract 4).
  riderRecovery?: { amountCents: number };
  explanationToBothParties: string;
  routing?: { route: 'release_with_review_option' | 'human_review'; reasons: unknown[]; notes: string[] };
  assumptions?: { id: string; criterion?: string }[];
  // A panel run (spec Part 2). Only whether the seats agreed is read: no count, rate or confidence reaches a party.
  panel?: { agree: boolean };
  caseId?: string;
  // A person made the final decision (store.ts recordDecision): the notice says so and is no longer held for that person.
  decidedByPerson?: boolean;
};

const sourceJson = (packet: CasePacket, id: string): any => {
  const source = packet.sources.find(candidate => candidate.id === id);
  try { return source ? JSON.parse(source.text) : null; } catch { return null; }
};
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A number stands alone: no digit before it (nor a digit and a point, "14.50" is not 4.50; nor a digit and a colon, the
// minutes of "16:50"; nor the last group of a grouped number, the 450 of "1,450") and no digit after it (nor a point and a
// digit, nor a comma and a group of three). A full stop that ends the sentence ("credited SGD 4.50.") does not hide it. A
// time is not a number here: "4.50 pm", "4.50 a.m.", "16 h", "4 hours", "4 o'clock", "4 oclock", "4:50".
// endsNumber is the number's own end; endsAlone adds that a time is not a number here. An explicit currency overrides the
// time and measure exclusions (moneyPattern): "S$4.50 hours" is money.
const standsAlone = '(?<!\\d|\\d\\.|\\d:)(?!(?<=\\d,)\\d{3}(?!\\d))', endsNumber = '(?!\\d|\\.\\d|,\\d{3}(?!\\d))';
const endsAlone = `${endsNumber}(?!\\s*(?:[ap]\\.?\\s?m(?![a-z])|h(?![a-z])|hrs?\\b|hours?\\b|o['’]?clock\\b)|:\\d)`;
// The first digit (zero) of every block of ten Unicode decimal digits that NFKC leaves as they are, ASCII first.
const digitZeros = [0x30, 0x660, 0x6f0, 0x7c0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66, 0xde6, 0xe50, 0xed0, 0xf20, 0x1040, 0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0x1a80, 0x1a90, 0x1b50, 0x1bb0, 0x1c40, 0x1c50, 0xa620, 0xa8d0, 0xa900, 0xa9d0, 0xa9f0, 0xaa50, 0xabf0, 0xff10, 0x104a0, 0x10d30, 0x10d40, 0x11066, 0x110f0, 0x11136, 0x111d0, 0x112f0, 0x11450, 0x114d0, 0x11650, 0x116c0, 0x116d0, 0x116da, 0x11730, 0x118e0, 0x11950, 0x11bf0, 0x11c50, 0x11d50, 0x11da0, 0x11de0, 0x11f50, 0x16130, 0x16a60, 0x16ac0, 0x16b50, 0x16d70, 0x1ccf0, 0x1d7ce, 0x1d7d8, 0x1d7e2, 0x1d7ec, 0x1d7f6, 0x1e140, 0x1e2f0, 0x1e4f0, 0x1e5f1, 0x1e950, 0x1fbf0];
/**
 * The text the privacy check reads: NFKC (fullwidth digits and points, non-breaking spaces), every Unicode decimal digit as
 * its ASCII digit ("٤.٥٠" is 4.50), a decimal mark between digits as a point (the Arabic decimal separator ٫, the decimal
 * separator key ⎖, the middle dot ·) and the Arabic thousands separator ٬ as a comma, and runs of spaces as one, so
 * "450  cents", "S$\u00a050" and "٤٫٥٠" read as written. Line breaks stay, so a check never
 * runs across two lines it did not before. A documented gap: amounts written in words ("four dollars and fifty cents")
 * are not read.
 */
export function privacyText(text: string) {
  return text.normalize('NFKC').replace(/\p{Nd}/gu, d => {
    const cp = d.codePointAt(0)!; let zero = digitZeros[0];
    for (const z of digitZeros) if (z <= cp && cp - z < 10) zero = z;
    return String.fromCharCode(48 + cp - zero);
  }).replace(/(?<=\d)[\u066B\u2396\u00B7](?=\d)/g, '.').replace(/(?<=\d)\u066C(?=\d)/g, ',')
    .replace(/[^\S\n]+/g, ' ').replace(/ ?\n ?/g, '\n');
}
/** A measure is not money: a figure followed by km, m, metres, min, minutes, s, seconds, kg or %. */
const notMeasure = `(?!\\s?(?:(?:km|m|metres?|meters?|mins?|minutes?|s|secs?|seconds?|kg)(?![a-z$])|%))`;
const numberPattern = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (Number.isInteger(value)) {
    const plain = String(value), grouped = value.toLocaleString('en-US');
    return `${standsAlone}(?:${escapeRegex(plain)}${plain === grouped ? '' : `|${escapeRegex(grouped)}`})${endsAlone}`;
  }
  return `${standsAlone}${escapeRegex(String(value))}0*${endsAlone}`;
};
/**
 * Every way an amount in dollars can be written as money, whatever words surround it: 4.50 and 4.5 (with or without S$,
 * SGD, $ before it or SGD, dollars after it), 450 cents. A whole amount (5) counts bare only as 5.00 or 5.0; as "5" it needs
 * a currency (S$5, SGD 5, $5, 5 SGD, 5 dollars). A time is never money (endsAlone), nor a bare figure before a measure
 * (notMeasure: 4.50 km); a currency marker overrides both ("S$4.50 m" and "SGD 4.50 h" are money).
 * Null for a zero or unreadable amount.
 */
const moneyPattern = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const cents = Math.round(value * 100), whole = Math.floor(cents / 100), part = String(cents % 100).padStart(2, '0');
  const wholes = [...new Set([String(whole), whole.toLocaleString('en-US')])].map(escapeRegex).join('|');
  const decimals = `(?:${wholes})\\.(?:${part}${part.endsWith('0') ? `|${part[0]}` : ''})0*`;
  // A currency marker before the figure makes it money whatever follows ("S$4.50 m" is held); a bare figure before a unit is a measure.
  const forms = [`${standsAlone}${decimals}${endsAlone}${notMeasure}`, `(?:S\\$|SGD|\\$)\\s?${decimals}${endsNumber}`, `${standsAlone}${decimals}\\s?(?:SGD\\b|dollars?\\b)`, `${standsAlone}${cents}\\s?(?:cents?\\b|¢)`];
  if (part === '00') forms.push(`(?:S\\$|SGD|\\$)\\s?(?:${wholes})${endsNumber}`, `${standsAlone}(?:${wholes})\\s?(?:SGD\\b|dollars?\\b)`);
  return new RegExp(forms.join('|'), 'gi');
};
const excerptAt = (text: string, index: number, length: number) => {
  const before = Math.max(text.lastIndexOf('\n', index - 1), text.lastIndexOf('.', index - 1), text.lastIndexOf('!', index - 1), text.lastIndexOf('?', index - 1));
  const ends = ['\n', '.', '!', '?'].map(mark => text.indexOf(mark, index + length)).filter(end => end >= 0);
  const end = ends.length ? Math.min(...ends) + 1 : Math.min(text.length, index + length + 80);
  return text.slice(Math.max(before + 1, index - 80), end).trim();
};

export function privacyFindings(text: string, packet: CasePacket, party: NoticeParty): PrivacyFinding[] {
  text = privacyText(text);
  const other = party === 'rider' ? 'driver' : 'rider';
  const profile = sourceJson(packet, `evidence/${other}_profile.json`);
  const findings: PrivacyFinding[] = [], seen = new Set<string>();
  const addNumber = (field: string, value: unknown, labels: string[]) => {
    const number = numberPattern(value);
    if (!number || seen.has(field)) return;
    const words = labels.map(escapeRegex).join('|');
    const pattern = new RegExp(`(?:${number}[^\\n.!?]{0,32}(?:${words})|(?:${words})[^\\n.!?]{0,32}${number})`, 'i');
    const match = pattern.exec(text);
    if (match) { seen.add(field); findings.push({ field, excerpt: excerptAt(text, match.index, match[0].length) }); }
  };
  // No words are read: any money-like mention of the amount holds the notice, the same figure paid by the rider included (a
  // person checks a coincidence). Conservative by construction.
  const addMoney = (field: string, value: unknown) => {
    const pattern = moneyPattern(value), match = pattern && !seen.has(field) ? pattern.exec(text) : null;
    if (match) { seen.add(field); findings.push({ field, excerpt: excerptAt(text, match.index, match[0].length) }); }
  };

  if (profile && typeof profile === 'object') {
    addNumber(`${other}_profile.account_age_days`, profile.account_age_days, ['day', 'days', 'account age', 'account is']);
    addNumber(`${other}_profile.total_trips`, profile.total_trips, ['trip', 'trips', 'rides']);
    addNumber(`${other}_profile.avg_rating`, profile.avg_rating, ['rating', 'rated', 'stars', 'star']);
    for (const row of Array.isArray(profile.rating_history) ? profile.rating_history : []) {
      addNumber(`${other}_profile.rating_history.avg_rating`, row?.avg_rating, ['rating', 'rated', 'stars', 'star']);
      addNumber(`${other}_profile.rating_history.trips`, row?.trips, ['trip', 'trips', 'rides']);
    }
    for (const [key, value] of Object.entries(profile.dispute_history ?? {})) {
      addNumber(`${other}_profile.dispute_history.${key}`, value, ['dispute', 'disputes', 'upheld', 'rejected', 'pending', 'complaint', 'complaints']);
    }
    addNumber(`${other}_profile.fraud_flags`, profile.fraud_flags, ['fraud flag', 'fraud flags', 'flagged for fraud']);
    addNumber(`${other}_profile.cancellation_rate_pct`, profile.cancellation_rate_pct, ['cancellation rate', 'cancel rate', '% cancellation', 'percent cancellation']);
    if (typeof profile.fraud_flag_details === 'string' && profile.fraud_flag_details.trim()) {
      const variants = [profile.fraud_flag_details, profile.fraud_flag_details.replaceAll('_', ' ')];
      const variant = variants.find(value => text.toLowerCase().includes(value.toLowerCase()));
      if (variant) {
        const index = text.toLowerCase().indexOf(variant.toLowerCase());
        findings.push({ field: `${other}_profile.fraud_flag_details`, excerpt: excerptAt(text, index, variant.length) });
      }
    }
  }
  // Facts 7 (MVP fixes F9, second release, 10 October 2026): the other party's earlier claims (evidence/earlier_claims.json) are
  // their history, like their profile: how many there were, near words for earlier claims, and any money-like mention of an
  // amount, except one equal to the amount this dispute asks for, which the notice must be free to state.
  const theirs = sourceJson(packet, 'evidence/earlier_claims.json')?.[other]?.claims, asked = sourceJson(packet, 'evidence/dispute_ticket.json')?.requested_remedy?.amount;
  if (Array.isArray(theirs) && theirs.length) {
    addNumber(`earlier_claims.${other}.count`, theirs.length, ['earlier claim', 'previous claim', 'past claim', 'prior claim', 'other claim', 'claims before', 'claims in the']);
    for (const claim of theirs) if (Number.isInteger(claim?.amount_cents) && claim.amount_cents !== Math.round(Number(asked) * 100)) addMoney(`earlier_claims.${other}.amount`, claim.amount_cents / 100);
  }

  // Team review: the driver's payout or compensation is the driver's own money and stays out of the rider's notice. Main's
  // check (the amount near a payout word) still runs, so nothing it held is let through; then any money-like mention of the
  // amount holds the notice whatever the words around it.
  if (party === 'rider') {
    const payments = sourceJson(packet, 'evidence/payment_events.json');
    for (const event of Array.isArray(payments) ? payments : []) {
      if (event?.counterparty !== 'driver') continue;
      addNumber('payment_events.driver_credit', event.amount, ['credit', 'credited', 'payout', 'paid out', 'compensation', 'earn', 'earned', 'earnings']);
      addMoney('payment_events.driver_credit', event.amount);
    }
  }
  if (party === 'driver') {
    const payments = sourceJson(packet, 'evidence/payment_events.json');
    const digits = new Set<string>();
    for (const event of Array.isArray(payments) ? payments : []) {
      for (const match of String(event?.method ?? '').matchAll(/(?:ending\s*|\*{2,}\s*)(\d{4})/gi)) digits.add(match[1]);
    }
    for (const lastFour of digits) {
      const match = new RegExp(`(?:ending\\s*|\\*{2,}\\s*)${escapeRegex(lastFour)}\\b`, 'i').exec(text);
      if (match) findings.push({ field: 'payment_events.card_digits', excerpt: excerptAt(text, match.index, match[0].length) });
    }
  }
  return findings;
}

// An editorial guard, not a guarantee (same standing as the label-word check, spec revision 19): it holds a notice for a
// person to edit and never rewrites the model's text, and it can miss wording. It looks for two things parties must not get:
// statistics about the decision (a percentage; confidence or probability with a number that measures it, a percentage or a
// 0 to 1 value; counts of panel seats, judges, reviews or AI reviews, in digits or words) and promises of a future payment
// or its timing, contractions included. Counts of evidence or vehicle seats ("two of three GPS readings", "two of three
// seats in the car"), numbers inside a proposition ("confident two passengers were present"), past facts and negated
// clauses ("no voucher has been issued") are case facts and pass. Every match is checked, not only the first.
const numberWords = 'zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred';
const count = '(?:\\d+|one|two|three|four|five)', will = "(?:\\s+will|\\s+shall|['’]ll)";
const percentWords = `(?:${numberWords})(?:[\\s-](?:one|two|three|four|five|six|seven|eight|nine))?\\s+per\\s?cent\\b`;
// A score on a scale ("4/5", "4.8 out of 5", "four of five") after the noun confidence, probability, likelihood or certainty,
// or after "scored", since reviewers see a 0 to 5 confidence score (confidence.ts). Not after the adjective "confident":
// "confident 2/3 of the journey was completed" is a case fact.
const onScale = `(?:\\d+(?:\\.\\d+)?\\s*\\/\\s*\\d+\\b|(?:\\d+(?:\\.\\d+)?|${numberWords})\\s+(?:out\\s+)?of\\s+(?:\\d+|${numberWords})\\b)`;
const confidenceNumber = `(?:\\d+(?:\\.\\d+)?\\s*(?:%|per\\s?cent\\b)|${percentWords}|0?\\.\\d+\\b|1\\.0+\\b)`;
const statisticWord = '(?:confiden(?:t|ce)|probabilit(?:y|ies)|likelihood|certainty)';
const panelCount = `(?:${count}\\s+(?:of|out of)\\s+(?:the\\s+)?${count}|all\\s+(?:\\d+|two|three|four|five)|both)`;
const panelNoun = '(?:(?:(?:separate|independent|ai)\\s+)*(?:reviews?|reviewers?|judges?|arbitrators?|ai|models?|panellists?|assessments?)|(?:panel|judge|judging|arbitrator)\\s+seats?|seats?\\s+(?:on|of|in)\\s+the\\s+(?:judge\\s+|arbitrator\\s+|review\\s+)?panel)';
const moneyWord = '(?:refund|voucher|credit|payment|money|reimbursement)s?';
const editorialChecks: [EditorialFinding['kind'], RegExp][] = [
  // A past ruling named in party text (an id, "past ruling", "precedent") is held: past rulings are our team's examples, not Ryde policy.
  // An id with any separator or none ("PREC-D03", "PREC D03", "PRECD03", "PREC-L-7d1e…"), or a reference to earlier rulings or
  // decisions. "precedence", "rule", "a ruling on the fare" and "an earlier decision" are ordinary words and pass.
  ['past_ruling', /\bPREC[\s_\-\u2013\u2014.:#/]*(?:[A-Z]?\d|L[\s_\-\u2013\u2014]?[0-9a-f]{4})[A-Z0-9-]*|\b(?:past|prior|previous|earlier)\s+rulings?\b|\bpast\s+decisions?\b|\bprecedents?\b/gi],
  ['statistic', /\d+(?:\.\d+)?\s*(?:%|per\s?cent\b)/gi],
  ['statistic', new RegExp(`\\b(?:a\\s+)?${percentWords}`, 'gi')],
  ['statistic', new RegExp(`\\b${statisticWord}\\b[\\s:=]+(?:(?:level|score|value|rating|of|is|was|at|about|around|roughly|near)\\s+){0,3}${confidenceNumber}`, 'gi')],
  ['statistic', new RegExp(`(?:^|[^\\d.])(?:0?\\.\\d+|1\\.0+)\\s+${statisticWord}\\b`, 'gi')],
  ['statistic', new RegExp(`\\b(?:confidence|probabilit(?:y|ies)|likelihood|certainty)(?:\\s+score)?\\b[\\s:=]+(?:(?:level|score|value|rating|of|is|was|at|about|around|roughly|near)\\s+){0,3}${onScale}`, 'gi')],
  ['statistic', new RegExp(`\\bscor(?:e|ed|es|ing)\\b[\\s:=]+(?:(?:of|is|was|at|a)\\s+){0,2}${onScale}`, 'gi')],
  ['statistic', new RegExp(`\\b${panelCount}\\s+${panelNoun}\\b`, 'gi')],
  ['statistic', new RegExp(`\\b${count}\\s+(?:of|out of)\\s+(?:the\\s+)?${count}\\s+(?:agree|agreed|agrees)\\b`, 'gi')],
  ['statistic', /\b(?:error|accuracy|success|agreement|hit)\s+rates?\b/gi],
  ['promise', new RegExp(`\\byou${will}\\s+(?:receive|get|be\\s+(?:paid|refunded|credited|reimbursed|compensated))\\b`, 'gi')],
  ['promise', /\b(?:we|ryde|i)\s+(?:guarantee|promise)s?\b/gi],
  ['promise', new RegExp(`\\bexpect\\s+(?:your|the|a)\\s+${moneyWord}\\b`, 'gi')],
  ['promise', new RegExp(`\\b(?:your|the)\\s+${moneyWord}\\s+(?:will\\s+)?(?:arrives?|lands?|comes?|reach(?:es)?)\\b`, 'gi')],
  ['promise', new RegExp(`(?:\\bwill|\\bshall|['’]ll)\\s+be\\s+(?:refunded|paid|credited|returned|reversed|reimbursed|issued|waived|sent)\\b`, 'gi')],
  ['promise', new RegExp(`\\b(?:we|ryde|they)${will}\\s+(?:refund|pay|credit|reimburse|issue|waive|return|reverse|send)\\b`, 'gi')],
  ['promise', new RegExp(`\\b${moneyWord}\\s+(?:is|are|will be|gets?|should be)\\s+(?:processed|paid|sent|issued|credited|made|returned)\\b[^.!?\\n]{0,30}\\b(?:within|in|by)\\b`, 'gi')],
];
// A promise in a negated clause ("nothing will be refunded until", "we do not guarantee") is not a promise.
const negated = (text: string, index: number, length: number) => {
  const start = Math.max(...[';', ':', '.', '!', '?', '\n', ','].map(mark => text.lastIndexOf(mark, index - 1))) + 1;
  return /\b(?:no|not|never|nothing|none|cannot|can['’]t|won['’]t|don['’]t|doesn['’]t|isn['’]t)\b/i.test(text.slice(start, index + length));
};
// The sentence around a match. A point between two digits (SGD 6.61) does not end a sentence.
const sentenceAt = (text: string, index: number, length: number) => {
  const boundary = (i: number) => '\n.!?'.includes(text[i]) && !(text[i] === '.' && /\d/.test(text[i - 1] ?? '') && /\d/.test(text[i + 1] ?? ''));
  let start = index; while (start > 0 && !boundary(start - 1)) start--;
  let end = index + length; while (end < text.length && !boundary(end)) end++;
  return text.slice(start, Math.min(text.length, end + 1)).trim();
};
export function editorialFindings(text: string): EditorialFinding[] {
  const findings: EditorialFinding[] = [];
  for (const [kind, pattern] of editorialChecks) for (const match of text.matchAll(pattern)) {
    // Every match counts: a negated first promise must not hide a later one.
    if (kind === 'promise' && negated(text, match.index!, match[0].length)) continue;
    const excerpt = sentenceAt(text, match.index!, match[0].length);
    if (!findings.some(f => f.kind === kind && f.excerpt === excerpt)) findings.push({ kind, excerpt });
  }
  return findings;
}

const money = (amountCents: number) => `SGD ${(amountCents / 100).toFixed(2)}`;
const headline = (outcome: NoticeDecision['outcome']) => outcome === 'refund_recommendation' ? 'Refund recommended' : outcome === 'charge_recommendation' ? 'Cleaning fee recommended' : outcome === 'driver_payment_recommendation' ? 'Cleaning payment recommended' : outcome === 'no_action' ? 'No action recommended' : 'Human review required';
// Notices are conditional and label review and appeal as simulated: this prototype moves no money and sends no request
// Party notices carry no statistics: no confidence, count or error rate.
const simulated = '(simulated in this prototype)';
const status = (decision: NoticeDecision) => decision.decidedByPerson ? `A person reviewed this and made this decision. You can ask a person to look again ${simulated}.` : !decision.routing
  ? 'Proposal only. Nothing has been sent.'
  : decision.routing.route === 'release_with_review_option'
    ? (decision.panel?.agree ? 'Three separate AI reviews reached the same result. ' : '') + `This is a recommendation, not a final decision. You can ask a person to look at it ${simulated}.`
    : `A person checks this before it is sent ${simulated}.`;
const forParty = (decision: NoticeDecision, party: NoticeParty) => {
  if (decision.outcome === 'human_review') return 'A person reviews this before anything changes.';
  if (decision.outcome === 'no_action') return 'We recommend no change to your account.';
  const amount = money(decision.remedy.amountCents);
  // A charge is a recommendation a person confirms first (spec revision 8); nothing is charged or paid by this notice.
  // A driver payment and the recovery from the rider are separate (owner decision, 6 October 2026): Ryde pays the driver either way.
  if (decision.outcome === 'driver_payment_recommendation') {
    const recovery = decision.riderRecovery?.amountCents ?? 0;
    return party === 'rider'
      ? (recovery ? `We recommend that Ryde recover ${money(recovery)} from you for the cleaning. Nothing is charged until a person confirms it.` : 'We recommend no charge to you for the cleaning. Nothing changes on your account.')
      : `We recommend that Ryde pays you ${amount} for the cleaning, whether or not the rider pays. Nothing is paid until a person confirms it.`;
  }
  if (decision.outcome === 'charge_recommendation') return party === 'rider'
    ? `We recommend a ${amount} cleaning fee. Nothing is charged until a person confirms it.`
    : `We recommend the rider pays you a ${amount} cleaning fee. Nothing is paid until a person confirms it.`;
  if (party === 'rider') return decision.remedy.medium === 'voucher'
    ? `We recommend a ${amount} Ryde voucher for you. This is a recommendation: this notice issues no voucher.`
    : `We recommend returning ${amount} to the card you paid with. This is a recommendation: no money has moved.`;
  return decision.remedy.medium === 'voucher'
    ? `We recommend a ${amount} Ryde voucher for the rider. Your separate driver credit is not changed by this notice.`
    : `We recommend that Ryde returns the rider's ${amount}. Your separate driver credit is not changed by this notice.`;
};

/**
 * The decision the notices describe once a person made the final one (the learning loop). Agreeing keeps the Judge's text.
 * Deciding differently uses the person's outcome and remedy with fixed wording built from them and the titles of the rules
 * cited (the Judge's and any the person added, as pinned in the run); the person's reason stays internal and never reaches
 * a party, and the team readings the Judge rested on are dropped. The same privacy and editorial checks then run on it.
 */
export function decidedNotice(judge: NoticeDecision & { policyIds?: string[] }, final: { decision: 'agree' | 'override'; final: { outcome: string; remedy: { medium: string; amountCents: number }; riderRecovery?: { amountCents: number } }; addedRuleIds?: string[] }, packet: Pick<CasePacket, 'policies'>): NoticeDecision {
  if (final.decision === 'agree') return { ...judge, decidedByPerson: true };
  const ids = [...new Set([...(judge.policyIds ?? []), ...(final.addedRuleIds ?? [])])];
  const titles = ids.map(id => packet.policies.find(p => p.rule_id === id)?.title).filter((t): t is string => typeof t === 'string' && !!t.trim());
  const decided = { refund_recommendation: 'a refund', charge_recommendation: 'a cleaning fee', driver_payment_recommendation: 'a cleaning payment to the driver', no_action: 'no change' }[final.final.outcome] ?? 'a decision';
  const explanation = `A person reviewed the records of this case and decided on ${decided}.` + (titles.length ? ` The decision rests on these Ryde rules: ${titles.join('; ')}.` : '');
  return { outcome: final.final.outcome as NoticeDecision['outcome'], remedy: final.final.remedy as NoticeDecision['remedy'], ...(final.final.riderRecovery ? { riderRecovery: final.final.riderRecovery } : {}), explanationToBothParties: explanation, routing: judge.routing, caseId: judge.caseId, decidedByPerson: true };
}
/** `packet` is the run's pinned packet (the privacy check reads the profiles the run saw), never the workspace's current one. */
export function partyNotices(decision: NoticeDecision, packet: CasePacket): Record<NoticeParty, PartyNotice> {
  const caseId = decision.caseId ?? packet.caseId, readings = [...new Set((decision.assumptions ?? []).map(a => a.id))].map(id => assumptionById(id)?.title ?? id);
  const make = (party: NoticeParty): PartyNotice => {
    const notice = {
      party,
      headline: headline(decision.outcome),
      explanation: decision.explanationToBothParties,
      forYou: forParty(decision, party),
      status: status(decision),
      appeal: { text: 'Disagree? Ask a person to look again (simulated: this prototype sends no request).', href: `/appeal?case=${encodeURIComponent(caseId)}&party=${party}`, simulated: true as const },
      readings,
    };
    // The whole party-facing text, field by field, so an excerpt never runs across two fields. The privacy check reads the
    // generated lines too: a remedy equal to the driver's credit, in "What this means for you", is held.
    const fields = [notice.headline, notice.explanation, notice.forYou, notice.status, notice.appeal.text, ...readings];
    const findings: PrivacyFinding[] = [];
    for (const f of fields.flatMap(text => privacyFindings(text, packet, party))) if (!findings.some(x => x.field === f.field)) findings.push(f);
    const editorial = [...new Map(fields.flatMap(editorialFindings).map(f => [f.kind + f.excerpt, f])).values()];
    const ready = findings.length === 0 && editorial.length === 0 && decision.outcome !== 'human_review' && (decision.decidedByPerson || decision.routing?.route !== 'human_review');
    return { ...notice, privacy: { findings, ready }, editorial: { findings: editorial }, ready };
  };
  return { rider: make('rider'), driver: make('driver') };
}
