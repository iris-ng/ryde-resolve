import type { FailureCategory } from '../agent-flow/failure';

// What a person trying a run is told when something goes wrong (owner review of 8 October 2026, the "Run failure messages" page,
// artifact 1DCHWzxjXESnNyYTtP2rft: every card approved, these are the owner's own words). No message ends with a full stop
// (owner, same review). The proxy's restarting page (infra/Caddyfile.fishbowl) repeats two of them; a test keeps them equal.
export const runMessages = {
  noServer: 'This run is waiting for a free server. Runs usually start within a minute. If it has not started in 5 minutes, stop it and try again later',
  serverStopped: 'The server working on this run stopped, so the run did not finish. No rider or driver was affected. Please start a new run',
  safetyStop: 'Stopped for a safety check. This case mentions a possible safety issue, so a person reviews it before any agent runs. No agent will run on this case',
  runNotFound: 'We could not find this run. The link may be wrong or out of date. Pick a case from the list to start a new run',
  outOfCredit: 'This run stopped because our AI provider has run out of credit. No rider or driver was affected. Please try again later',
  providerSlow: 'The AI model provider did not answer in time, so this run stopped. Please try again in a few minutes',
  agentProblem: 'This run has stopped as an agent ran into a temporary problem. Please try this run again',
  updating: 'Update in progress! Back soon',
  lostContact: 'Lost contact with the site for a moment, reconnecting ... (Your run carries on in the background)',
  restarting: 'Ryde Resolve is restarting. Back in a few seconds, please reload',
  signedOut: 'You have been signed out. Reload the page to sign in again',
  recordsDown: 'The site cannot reach its records right now. Please try again in a few minutes',
  threeRuns: 'We can only do 3 runs at once, working on it!',
  // Card 14 (owner's wording, 8 October 2026): any screen that fails to draw shows this instead of a blank page.
  pageError: 'Something on this page could not load. Please reload the page',
  // The public copy of the site (owner, 11 October 2026): it reads every case and run, and changes nothing.
  viewOnly: 'This is the public copy of the site, so nothing can be changed here. Play shows a recorded run again',
} as const;

/** The code of the app's own refusal for a missing or wrong operator token: the page's first check reads only this as a token deployment. */
export const operatorTokenRequired = 'operator_token_required';
/** The code of the app's refusal of a change sent from the public copy of the site. */
export const viewOnlyRefused = 'view_only';

/** The daily limit, with the time the next run can start (Singapore time; "tomorrow" when that falls on the next day there). */
export function dailyLimitMessage(limit: number, nextStart: Date, now: Date = new Date()) {
  const sg = (d: Date) => new Date(d.getTime() + 8 * 3600 * 1000);
  // Rounded up to the minute: a run that drops out at 14:35:20 lets the next one start from 14:36, never earlier than said.
  const at = sg(new Date(Math.ceil(nextStart.getTime() / 60000) * 60000)), today = sg(now), time = at.toISOString().slice(11, 16);
  const tomorrow = at.toISOString().slice(0, 10) !== today.toISOString().slice(0, 10);
  return `Oops! We hit today's limit of ${limit} runs. Try again from ${time}${tomorrow ? ' tomorrow' : ''} (Singapore time)`;
}

/**
 * The message for a run that stopped because a step failed, from the fixed failure labels its steps reported (failure.ts).
 * Credit first: it decides whether trying again can help. Then the provider not answering, then anything else an agent ran into.
 */
export function stoppedRunMessage(causes: readonly FailureCategory[]) {
  if (causes.includes('credits exhausted')) return runMessages.outOfCredit;
  if (causes.some(c => c === 'rate limited' || c === 'timeout' || c === 'provider error' || c === 'model not available')) return runMessages.providerSlow;
  return runMessages.agentProblem;
}

/** Every message a person may be shown as it stands: the page shows these without the "Live updates paused" prefix. */
export const isRunMessage = (text: string) => (Object.values(runMessages) as string[]).includes(text) || text.startsWith('Oops! We hit today\'s limit of ');
