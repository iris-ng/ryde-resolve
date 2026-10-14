// Pure view model for the lab chat column: each agent's saved output becomes a bubble,
// every other event folds into a collapsed group of notes between bubbles.
import type { Desk } from './desk-state';
import { deskFor } from './roles';
type Ev = { seq: number; actor: string; phase: string; kind: string; message: string; at: string; data?: any };
/** `step` is the run step the output belongs to (collect, apply, investigate, challenge, respond, decide, examine), from
 *  the disclosed key or the decision; `source` is that key ('decision' for the Judge's decision), unique within an event. */
export type FeedBubble = { type: 'bubble'; seq: number; at: string; role: Desk; phase: string; step: string; source: string; artifact: any; decision: boolean; message: string };
export type FeedNote = { seq: number; at: string; actor: string; phase: string; kind: string; message: string; data?: any };
export type FeedNotes = { type: 'notes'; seq: number; items: FeedNote[] };
export type FeedItem = FeedBubble | FeedNotes;
// Disclosed keys are role_phase (judge_b_decide, photo_examine); map the role to its card and the phase to its step.
const roleOf = (key: string) => deskFor(key.slice(0, key.lastIndexOf('_'))) as Desk;
const stepOf = (key: string) => key.slice(key.lastIndexOf('_') + 1);
export function buildFeed(events: Ev[], actor = 'all'): FeedItem[] {
  const feed: FeedItem[] = [];
  const note = (e: Ev) => { const last = feed.at(-1); const item = { seq: e.seq, at: e.at, actor: e.actor, phase: e.phase, kind: e.kind, message: e.message, data: e.data }; if (last?.type === 'notes') last.items.push(item); else feed.push({ type: 'notes', seq: e.seq, items: [item] }); };
  for (const e of events) {
    if (e.kind === 'decision_proposed') { if (actor === 'all' || actor === 'judge') feed.push({ type: 'bubble', seq: e.seq, at: e.at, role: 'judge', phase: e.phase, step: 'decide', source: 'decision', artifact: e.data, decision: true, message: e.message }); continue; }
    if (e.kind === 'disclosed' && e.data) { for (const [key, artifact] of Object.entries(e.data)) { const role = roleOf(key); if (actor === 'all' || actor === role) feed.push({ type: 'bubble', seq: e.seq, at: e.at, role, phase: e.phase, step: stepOf(key), source: key, artifact, decision: false, message: e.message }); } continue; }
    if (actor === 'all' || deskFor(e.actor) === actor) note(e);
  }
  return feed;
}

/** A stable id for a bubble or a step note, used to find it on the page. */
export const feedId = (item: FeedBubble | FeedNote) => 'source' in item ? `b${item.seq}-${item.source}` : `n${item.seq}`;
/** Newest first, like an inbox (4 October, user request): the groups and the steps inside each group both reverse. */
export const newestFirst = (feed: FeedItem[]): FeedItem[] => [...feed].reverse().map(i => i.type === 'notes' ? { ...i, items: [...i.items].reverse() } : i);
const safetyHandoff = (n: FeedNote) => (n.kind === 'review_requested' || n.kind === 'review_updated') && n.data?.kind !== 'merits_review';
const meritsHandoff = (n: FeedNote) => (n.kind === 'review_requested' || n.kind === 'review_updated') && n.data?.kind === 'merits_review';
/**
 * What a click on a timeline line (timeline.ts row keys) points at in the conversation: the agents' outputs for a step,
 * or, for the gates, the steps that record them (the safety screen and its handoffs, the record check, the decision and
 * the handoff to a person). A step with no output yet points at its own steps. `steps` says the "Show steps" view is
 * needed to see them. Ids come in feed order.
 */
export function stepTargets(feed: FeedItem[], key: string): { ids: string[]; steps: boolean } {
  const bubbles = feed.flatMap(i => i.type === 'bubble' ? [i] : []), notes = feed.flatMap(i => i.type === 'notes' ? i.items : []);
  const pick = (b: (x: FeedBubble) => boolean, n: (x: FeedNote) => boolean) => {
    const found = [...bubbles.filter(b), ...notes.filter(n)].sort((x, y) => x.seq - y.seq);
    return { ids: found.map(feedId), steps: found.some(x => !('source' in x)) };
  };
  if (key === 'screen') return pick(() => false, n => n.kind === 'triage_completed' || safetyHandoff(n));
  if (key === 'record') return pick(() => false, n => n.kind === 'integrity_checked');
  if (key === 'release') return pick(b => b.decision, meritsHandoff);
  const outputs = pick(b => b.step === key, () => false);
  return outputs.ids.length ? outputs : pick(() => false, n => n.phase === key);
}
