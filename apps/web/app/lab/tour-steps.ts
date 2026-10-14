export { DEMO_CASE, demoRun, tourCase } from './walkthrough-case';

// The walkthrough's panes (tour.tsx), in order. The wording lives here so it can change without touching the tour.
// `target`: the parts of the page lit up together (one bright box around all of them); none puts the card in the middle.
// `pane`: the pane a phone or tablet shows for this step, since those show one pane at a time (columns.tsx).
// `also`: a second part lit up at the same time, with its own card and arrow (user, 8 October: the Evidence Collector
// and the Policy Analyst each show the evidence pane they read from). Phones show it as a step of its own (stepsFor).
// Wording, order and the words in [brackets], which the card underlines, are the user's own (walkthrough accents page,
// 8 October); "Judge" became "Arbitrator" throughout the site the same day. No card ends with a full stop (user, 8 October).
// Revived 11 October 2026 (owner): the step walkthrough is back in place of the explainer video, which lives on as the demo film;
// "agentic", not "autonomous" (owner, 11 October); the + button and the New case dialog are gone, so step 2 lights the case list alone.
// The Library and the Queue each get a card after the Arbitrator (owner, 12 October 2026), two steps rather than a two-part
// step: their two cards cannot sit side by side under the top bar, which would split every two-part step from there on.
export type TourPane = 'evidence' | 'chat' | 'status';
export type TourAlso = { target: string[]; pane?: TourPane; text: string };
export type TourStep = { target?: string[]; pane?: TourPane; text: string; also?: TourAlso };
const evidencePane: TourAlso = { target: ['#lab-pane-evidence'], pane: 'evidence', text: 'The case documents, timeline, and the applicable Ryde rules live here' };
export const tourSteps: TourStep[] = [
  {
    text: 'An [agentic dispute resolution platform] inspired by the best features of [arbitration]',
  },
  {
    target: ['.lab-picker'],
    text: 'Your case is resolved quickly and effectively by an [always-on independent third party]. Check it out: Open a case from the list',
  },
  {
    target: ['.lab .live-strip .desk'],
    text: 'Five [AI agents] work the case. [Each is its own CodeBuddy session]. The CodeBuddy file sets the job, AI model, turn limits, and tools',
  },
  {
    target: ['.lab .desk[data-role=evidence]'], also: evidencePane,
    text: 'The [Evidence Collector] reads the documents, calculations and timeline, and notes what they show and what is missing',
  },
  {
    target: ['.lab .desk[data-role=policy]'], also: evidencePane,
    text: 'The [Policy Analyst] finds which of Ryde\'s rules apply, where they conflict, and where no rule does',
  },
  {
    target: ['.lab .desk[data-role=rider]', '.lab .desk[data-role=driver]'],
    text: 'The [Rider and Driver Advocates] file their cases at the same time, unseen by each other, and prepare a [list of issues] for the Arbitrator',
  },
  {
    target: ['.lab .desk[data-role=judge]'],
    text: 'The [Arbitrator rules on each issue] raised by the Rider and Driver Advocates, [gives reasons], and [recommends a result]',
  },
  {
    target: ['.lab-library-link'],
    text: 'The [policy and precedent library] holds Ryde\'s rules and the [past rulings] the agents look up. A person\'s decision can become a [new ruling]',
  },
  {
    target: ['.lab-queue-button'],
    text: 'The [Queue] lists the cases waiting for a person, [most urgent first]',
  },
  {
    target: ['.lab .gate-screen', '.lab .gate-record'],
    text: 'P.S. We also screen for [safety] and [fraud]. Cases that mention [injury, assault, or harassment] go straight to a person. Issues like reused receipts or photos across previous cases are also flagged as [potential fake claims]',
  },
  {
    target: ['.lab-picker'],
    text: 'Let\'s go!',
  },
];
/** A step as shown: `base` is its place in tourSteps and `part` the part it shows, so a resize that splits or joins
 * steps keeps the walkthrough's place. */
export type ShownStep = TourStep & { base: number; part: 'main' | 'also' };
const joined: ShownStep[] = tourSteps.map((step, base) => ({ ...step, base, part: 'main' }));
const split: ShownStep[] = [];
{
  const shown = new Set<string>();
  tourSteps.forEach(({ also, ...step }, base) => {
    split.push({ ...step, pane: step.pane ?? also?.pane, base, part: 'main' }); shown.add(step.text);
    if (also && !shown.has(also.text)) { split.push({ ...also, base, part: 'also' }); shown.add(also.text); }
  });
}
/** Phones, and screens too short for two cards (a phone held sideways), show a second part as a step of its own. */
export const splitsAt = (width: number, height: number) => width <= 640 || height <= 560;
/** The steps for a screen: a second part becomes a step of its own, once, where two cards do not fit. */
export const stepsFor = (separate: boolean): ShownStep[] => separate ? split : joined;
/** A card's text in pieces, `em` for the words in [brackets]; `plainWords` is the text as read. */
export function tourWords(text: string): { text: string; em: boolean }[] {
  return text.split(/(\[[^\]]*\])/).filter(Boolean).map(t => t.startsWith('[') && t.endsWith(']') ? { text: t.slice(1, -1), em: true } : { text: t, em: false });
}
export const plainWords = (text: string) => tourWords(text).map(p => p.text).join('');
