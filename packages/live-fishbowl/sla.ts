// Response-time targets (the handbook's "SLA and routing manager" stretch goal): each case a person must pick up gets a
// priority and a time by which a person should pick it up. Since 5 October the picker sorts by latest activity; the live
// queue (queue-dialog.tsx, owner, 11 October 2026) lists the waiting cases in the order a person should take them. Pure and
// browser-safe. The case summary and the gate cards read a run's own events; the case picker reads the catalog's trimmed
// copy of the same events (store.ts listWorkspaces, through queueEventsFromRow), so both give the same answer. Nothing
// here changes routing, a release decision or anything an agent sees: it only reads what the run recorded.
import type { RoutingReason } from '../agent-flow/routing';

/**
 * THE TEAM'S ASSUMPTION, NOT RYDE'S: Ryde publishes no response times for disputes. How long a person has to pick a case
 * up (assign it, or clear or refer a safety hold), counted from the event that sent it to a person: the safety flag for
 * Urgent, the routed decision for Normal. Change these here only; the summary and the picker read them.
 * Two priorities (user, 4 October): Urgent for anything involving safety (injury, danger, threats, harassment, sexual
 * misconduct, abuse, dangerous driving), Normal for everything else. The High tier (a charge or an amount over the
 * threshold, 24 hours) is gone: a charge is not urgent.
 */
export const responseTargets = {
  urgent: { label: 'Urgent', hours: 1, nearHours: 0.25, when: 'of a safety flag (the safety screen held the case) or of a decision sent to a person for a safety reason' },
  normal: { label: 'Normal', hours: 48, nearHours: 6, when: 'of a decision sent to a person for any other reason, including a charge and the record check' },
} as const;
export type Priority = keyof typeof responseTargets;
const priorities: Priority[] = ['urgent', 'normal'];
/** Routing reasons that raise a routed decision above Normal: only a safety reason. Every other reason, a charge, an amount
 *  over the threshold and the record check included, is Normal (user, 3 and 4 October). */
export const reasonPriority: Partial<Record<RoutingReason['code'], Priority>> = { safety: 'urgent' };

/** The fields of a run event this module reads. Full events (the lab) and the catalog's trimmed ones both fit. */
export type QueueEvent = { seq?: number; at?: string; kind: string; data?: any };
export type Pickup = { at: string | null; owner: string | null };
/** `from`: what started the clock. `since` and `due` are ISO times; `pickedUp` is set once a person has taken the case. */
/** `stakeCents`: the most money the person's decision can move (stakeCents below); null when the record gives no amount. */
export type ResponseTarget = { priority: Priority; label: string; hours: number; from: 'safety_flag' | 'routed'; since: string; due: string; pickedUp: Pickup | null; stakeCents: number | null };

// Only a full ISO time with its zone: a time without one would be read in the viewer's zone, which is a guess.
const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const time = (at: unknown) => typeof at === 'string' && iso.test(at) && Number.isFinite(Date.parse(at)) ? at : null;
const text = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : null;
const hours = (n: number) => `${n} hour${n === 1 ? '' : 's'}`;
const cents = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
const money = (c: number) => `S$${(c / 100).toFixed(2)}`;

/**
 * The most money a person's decision can move (owner, 11 October 2026), in cents: what ranks the live queue inside a priority.
 * After a recommendation, the larger of the recommended amount and the amount the Arbitrator gave under each open question's
 * other reading; on a panel run, each finished seat's recommended amount too (seats that split on the amount are exactly the
 * case where the person's decision moves money). With no recommendation from any seat (human_review), or before
 * any decision (a safety hold at the screen), the disputed
 * charge plus the claimed extra loss the intake screen worked out (triage.ts exposure). Not the amount a party asks for on its
 * own. Null when the record gives no amount. Ordering and wording only: no release decision or agent reads it.
 */
export function stakeCents(events: QueueEvent[]): number | null {
  const decision = events.find(e => e.kind === 'decision_proposed')?.data, exposure = events.find(e => e.kind === 'triage_completed')?.data?.exposure;
  const recommends = (d: any) => typeof d?.outcome === 'string' && d.outcome !== 'human_review';
  // A seat counts only with no `failed` field at all, as the catalog query reads it ("" or null is still marked).
  const seats = (Array.isArray(decision?.panel?.seats) ? decision.panel.seats : []).filter((seat: any) => recommends(seat) && seat?.failed === undefined).map((seat: any) => cents(seat.remedy?.amountCents));
  const own = recommends(decision) ? [cents(decision.remedy?.amountCents), ...(Array.isArray(decision.reviewReasons) ? decision.reviewReasons.map((q: any) => cents(q?.otherReading?.remedyCents)) : [])] : [];
  const amounts = [...own, ...seats].filter((c): c is number => c !== null);
  if (amounts.length) return Math.max(...amounts);
  const disputed = cents(exposure?.disputed_charge_cents), extra = cents(exposure?.additional_loss_cents);
  return disputed === null && extra === null ? null : (disputed ?? 0) + (extra ?? 0);
}

/** The highest priority among a routed decision's reasons. Reasons that cannot be read (not an object with a string
 *  code, as the catalog query also reads them) raise nothing: the floor is Normal. */
export function routedPriority(reasons: unknown): Priority {
  const codes = Array.isArray(reasons) ? reasons.map(r => r?.code).filter(c => typeof c === 'string') : [];
  return priorities.find(p => codes.some(c => (reasonPriority[c as RoutingReason['code']] ?? 'normal') === p)) ?? 'normal';
}

/**
 * The run's place in the queue, or null when no person is needed (released, still in progress, no decision) or a time it
 * needs is missing or unreadable. In order:
 * 1. A safety flag no person has picked up (the screen's hold, or a safety upload during the run): Urgent, from the first
 *    such flag.
 * 2. A safety hold a person has assigned and not yet cleared or referred: Urgent, picked up.
 * 3. A decision routed to a person: the priority of its reasons, from the decision. Picked up once a person updates a
 *    handoff after it.
 * The store applies a person's update to the run's latest handoff (store.ts updateReview), so an update picks up every
 * handoff opened before it. A person's final decision (review_decided, the learning loop) also picks up a routed decision
 * that nobody had picked up. The store takes a final decision only from the assigned person, so the assignment has
 * already stopped the clock and the catalog, which does not carry review_decided, gives the same answer.
 */
export function responseTarget(events: QueueEvent[], runStatus?: string | null): ResponseTarget | null {
  if (!runStatus || runStatus === 'not started') return null;
  let decision: QueueEvent | undefined, decisionPickup: Pickup | null = null, flag: QueueEvent | undefined, picked: { since: QueueEvent; pickup: Pickup } | undefined;
  let latest: { safety: boolean; status: string } | undefined;
  for (const e of events) {
    if (e.kind === 'decision_proposed') decision ??= e;
    else if (e.kind === 'review_requested') { const safety = e.data?.kind !== 'merits_review'; latest = { safety, status: 'unassigned' }; if (safety) flag ??= e; }
    else if (e.kind === 'review_decided') { if (decision && !decisionPickup) decisionPickup = { at: time(e.at), owner: text(e.data?.owner) }; }
    else if (e.kind === 'review_updated' && latest && typeof e.data?.status === 'string') {
      latest.status = e.data.status;
      if (e.data.status === 'unassigned') continue;
      const pickup = { at: time(e.at), owner: text(e.data.owner) };
      if (flag) { picked = { since: flag, pickup }; flag = undefined; }
      if (decision && !decisionPickup) decisionPickup = pickup;
    }
  }
  const target = (priority: Priority, from: ResponseTarget['from'], start: QueueEvent, pickedUp: Pickup | null): ResponseTarget | null => {
    const since = time(start.at); if (!since) return null;
    const { label, hours } = responseTargets[priority];
    return { priority, label, hours, from, since, due: new Date(Date.parse(since) + hours * 3600000).toISOString(), pickedUp, stakeCents: stakeCents(events) };
  };
  if (flag) return target('urgent', 'safety_flag', flag, null);
  if (latest?.safety && latest.status === 'assigned' && picked) return target('urgent', 'safety_flag', picked.since, picked.pickup);
  const routing = decision?.data?.routing;
  if (decision && routing?.route === 'human_review') return target(routedPriority(routing.reasons), 'routed', decision, decisionPickup);
  return null;
}

/**
 * The catalog query's rows (store.ts listWorkspaces) as events this module reads. Each SQL row is one decision or handoff
 * event of the workspace's latest run, trimmed to its time, kind, route, reason codes and handoff state, and for a decision
 * its outcome and amounts (stakeCents); anything of the wrong type is dropped rather than guessed. The catalog adds one more
 * row, the intake screen's disputed charge and extra loss, as a trimmed `triage_completed` event (store.ts catalogRow).
 */
export const queueKinds = ['decision_proposed', 'review_requested', 'review_updated'] as const;
export function queueEventsFromRow(raw: unknown): QueueEvent[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r): QueueEvent[] => {
    if (r && typeof r === 'object' && r.kind === 'triage_completed') return [{ kind: r.kind, data: { exposure: { disputed_charge_cents: cents(r.disputed), additional_loss_cents: cents(r.additional) } } }];
    if (!r || typeof r !== 'object' || !queueKinds.includes(r.kind)) return [];
    const event: QueueEvent = { kind: r.kind, ...(Number.isInteger(r.seq) ? { seq: r.seq } : {}), ...(typeof r.at === 'string' ? { at: r.at } : {}) };
    if (r.kind === 'decision_proposed') {
      const amounts = { ...(typeof r.outcome === 'string' ? { outcome: r.outcome } : {}), ...(cents(r.amount) !== null ? { remedy: { amountCents: r.amount } } : {}),
        ...(Array.isArray(r.others) ? { reviewReasons: r.others.map((c: unknown) => ({ otherReading: { remedyCents: cents(c) } })) } : {}),
        // The catalog sends only the amounts of finished seats that recommended something (store.ts catalogQuery).
        ...(Array.isArray(r.seats) ? { panel: { seats: r.seats.filter((c: unknown) => cents(c) !== null).map((c: number) => ({ outcome: 'seat_recommendation', remedy: { amountCents: c } })) } } : {}) };
      return [{ ...event, data: typeof r.route === 'string' ? { routing: { route: r.route, reasons: Array.isArray(r.reasons) ? r.reasons.filter((c: unknown) => typeof c === 'string').map((code: string) => ({ code })) : [] }, ...amounts } : {} }];
    }
    return [{ ...event, data: { ...(typeof r.handoff === 'string' ? { kind: r.handoff } : {}), ...(typeof r.status === 'string' ? { status: r.status } : {}), owner: typeof r.owner === 'string' ? r.owner : null } }];
  });
}

/**
 * The live queue's order (owner, 11 October 2026): cases waiting for a person first, then everyone else (picked up or no
 * target) in the given order. Among the waiting: Urgent before Normal; inside each, a case near or past its target first
 * (within `nearHours` of it), then the most money the person's decision can move, then the one waiting longest. No money
 * brackets: the S$50 release limit already decides which cases reach a person.
 */
export function queueOrder<T>(rows: T[], targetOf: (row: T) => ResponseTarget | null, now = Date.now()): T[] {
  const keyed = rows.map((row, i) => { const t = targetOf(row); return { row, i, t: t && !t.pickedUp ? t : null }; });
  const near = (t: ResponseTarget) => Date.parse(t.due) - now <= responseTargets[t.priority].nearHours * 3600000 ? 0 : 1;
  return keyed.sort((a, b) => !a.t || !b.t ? (a.t ? -1 : b.t ? 1 : a.i - b.i)
    : priorities.indexOf(a.t.priority) - priorities.indexOf(b.t.priority) || near(a.t) - near(b.t) || (b.t.stakeCents ?? -1) - (a.t.stakeCents ?? -1)
      || Date.parse(a.t.since) - Date.parse(b.t.since) || a.i - b.i).map(k => k.row);
}
/** Why a waiting case went to a person, in a few words each, from the routing reason codes the catalog carries (the full
 *  reasons, in the Arbitrator's words, are on the case's summary). A safety hold before any decision says the screen. */
const reasonWords: Record<RoutingReason['code'], string> = {
  safety: 'a safety report', no_recommendation: 'no recommendation was possible', amount_over_threshold: 'an amount over the release limit',
  claimed_loss: 'a claimed extra loss', fact_gap: 'a missing fact', policy_gap: 'a rule question', precedent_departure: 'it departs from a past ruling',
  many_assumptions: 'many assumptions', charge_review: 'a charge to a party', integrity_check: 'a record match', photos_unexamined: 'photos not read',
  judges_disagree: 'the Arbitrators disagree', panel_incomplete: 'an Arbitrator did not finish', criteria_conflict: 'answers that conflict',
  precedent_overflow: 'too many past rulings', precedents_disagree: 'past rulings disagree', precedent_on_open_fact: 'a past ruling on an open fact',
  unsupported_dispute: 'a dispute type we do not handle', service_scope: 'outside the service the rules cover', partial_refund: 'a partial refund',
  refund_beyond_record: 'a refund beyond the record',
};
export function queueReasons(events: QueueEvent[], target: ResponseTarget): string[] {
  if (target.from === 'safety_flag') return ['the safety screen held it'];
  const codes = events.find(e => e.kind === 'decision_proposed')?.data?.routing?.reasons;
  const words = (Array.isArray(codes) ? codes : []).map((r: any) => typeof r?.code === 'string' ? reasonWords[r.code as RoutingReason['code']] ?? r.code.replaceAll('_', ' ') : null).filter((w): w is string => !!w);
  return [...new Set(words)];
}
/** The money at stake in words, or null when the record gives no amount. */
export const stakeText = (t: ResponseTarget) => t.stakeCents === null ? null : t.stakeCents ? `${money(t.stakeCents)} at stake` : 'no money at stake';
/** The live queue's order in one sentence, for the queue's own page. */
export const queueOrderNote = 'Urgent cases come before Normal ones. Inside each, a case close to or past its target comes first, then the case where the person\'s decision can move the most money, then the one waiting longest.';

/** A span of time in words, rounded down: "under a minute", "45 min", "2 h 10 min", "30 h", "3 days". */
export function span(ms: number) {
  const min = Math.floor(Math.max(0, ms) / 60000), h = Math.floor(min / 60);
  if (min < 1) return 'under a minute';
  if (min < 60) return `${min} min`;
  if (h < 10) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  return h < 48 ? `${h} h` : `${Math.floor(h / 24)} days`;
}
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** A time on the 24-hour clock in the viewer's zone (or `timeZone`), with the date when it is not today: "18:05", "14:55 on 30 Sep". */
export function clock(at: string, now: number, timeZone?: string) {
  const parts = (d: Date) => Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(d).map(p => [p.type, p.value]));
  const t = parts(new Date(at)), today = parts(new Date(now)), hm = `${t.hour.padStart(2, '0')}:${t.minute.padStart(2, '0')}`;
  return t.year === today.year && t.month === today.month && t.day === today.day ? hm : `${hm} on ${Number(t.day)} ${months[Number(t.month) - 1]}`;
}

/** The priority alone (4 October, user request): no "due by" or "overdue by" wording and no red for overdue, since no
 *  reviewers are on duty in this demo and every waiting case would read overdue. `stake` is the money at stake in words while
 *  a case waits and there is any (owner, 11 October 2026): the case list and the summary's priority line add it ("Normal ·
 *  S$6.61 at stake"); the gate cards keep the priority alone. The live queue's order is queueOrder.
 *  `when` and `card` are empty while a case waits; once a person picks it up they say who. `state` still records waiting,
 *  due or overdue for the code; nothing shows it. */
export type TargetView = { tone: 'urgent' | 'review' | 'idle'; state: 'waiting' | 'due' | 'overdue' | 'picked_up'; label: string; when: string; card: string; short: string; text: string; rule: string; stake: string };
/** How a target reads at `now`: `text` for the summary and the safety screen, `short` for the picker, `card` for the gate cards. */
export function targetView(t: ResponseTarget, now: number, _timeZone?: string): TargetView {
  const due = Date.parse(t.due), label = t.label;
  const rule = `Target: a person picks it up within ${hours(t.hours)} of ${t.from === 'safety_flag' ? 'the safety flag' : 'the decision going to a person'}. Our team's assumption; Ryde publishes no response times.`;
  if (t.pickedUp) { const who = `picked up by ${t.pickedUp.owner ?? 'a reviewer'}`; return { tone: 'idle', state: 'picked_up', label, when: who, card: 'picked up', short: `${label} · ${who}`, text: `${label} · ${who}`, rule, stake: '' }; }
  const tone = t.priority === 'urgent' ? 'urgent' : 'idle', stake = t.stakeCents ? `${money(t.stakeCents)} at stake` : '';
  return { tone, state: now > due ? 'overdue' : now === due ? 'due' : 'waiting', label, when: '', card: '', short: label, text: label, rule, stake };
}
/** The lab has no reviewers on duty, so an unpicked case runs past its target: said once at the top of the case list. */
// Since 5 October the picker sorts by latest activity (case-groups.ts), so waiting cases no longer come first.
export const demoReviewNote = 'No reviewers are on duty in this demo. A case waiting for a person shows its priority.';
/** Every target in one sentence each, for the footnote under the summary. */
export const targetsNote = 'Response-time targets are our team\'s assumption; Ryde publishes none. ' + priorities.map(p => `${responseTargets[p].label}: within ${hours(responseTargets[p].hours)} ${responseTargets[p].when}.`).join(' ');
