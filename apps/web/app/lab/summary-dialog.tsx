'use client';
import { useEffect, useId, useRef, type RefObject } from 'react';
import type { CaseSummary, FinalDecision, GateTone, Handoff, ReleaseGate } from '../../../../packages/live-fishbowl/gates';
import { caseBrief, safetyOnRun } from '../../../../packages/live-fishbowl/gates';
import { decidedNotice } from '../../../../packages/live-fishbowl/notice';
import { forViewers } from './run-notice';
import HandoffForm from './handoff-form';
import DecisionForm from './decision-form';
import PrecedentsConsidered from './precedents-considered';
import { plainText } from '../../../../packages/live-fishbowl/plain';
import { confidenceFor } from '../../../../packages/agent-flow/confidence';
import { ConfidenceScoreView } from './panel-seats';
import PartyNotices from './party-notices';
import SlaLine from './sla-line';
import { targetsNote, type TargetView } from '../../../../packages/live-fishbowl/sla';
import { badFaithSignals } from '../../../../packages/live-fishbowl/signals';
import type { EvidenceChecksView } from '../../../../packages/live-fishbowl/checks-view';

const marks: Record<GateTone, string> = { clear: '✓', review: '!', urgent: '!', waiting: '…', idle: '–' };

// The case summary: the outcome and every check in one place. It opens by itself once per run in each browser
// (lab.tsx), and from the release check card or the Summary button at any time. Before there is anything to
// summarise it says what the release check will do. A proposal routed to a person opens a merits handoff, which a
// reviewer picks up here. The rider and driver notices sit at the end (moved from the Status column, 3 October); the
// Status column's Notices button opens the summary scrolled to them. A case waiting for a person shows its priority and
// pick-up time under the outcome (sla.ts, 3 October). The person the merits handoff is assigned to records the final
// decision under it (decision-form.tsx, the learning loop, 4 October); after that the handoff is closed. Under the recommendation
// it says what the dispute is about, in the Evidence Collector's own paragraph, marked as written by AI (user decision, 4 October).
// Under the checks, the bad-faith signals (signals.ts, owner, 11 October 2026): the record check's matches, the consistency
// facts and past behaviour in one list, each with its innocent reading, labelled "not proof".
export default function SummaryDialog({ title, summary, sla = null, release, decision, packet, scored = false, toNotices = false, latest, final = null, rules = [], events = [], checks = null, busy, error, action, runId, viewOnly = false, opener, onClose, onReadDecision, onSafety }: {
  checks?: EvidenceChecksView | null; title: string; summary: CaseSummary | null; sla?: TargetView | null; release: ReleaseGate; decision: any; packet: Parameters<typeof PartyNotices>[0]['packet']; scored?: boolean; toNotices?: boolean; latest: Handoff | null; final?: FinalDecision | null; rules?: { id: string; title: string }[]; events?: Parameters<typeof safetyOnRun>[0]; busy: boolean; error: string;
  action: (body: object) => Promise<any>; runId: string; viewOnly?: boolean; opener: RefObject<HTMLElement | null>;
  onClose: () => void; onReadDecision: () => void; onSafety: () => void;
}) {
  const box = useRef<HTMLDialogElement>(null), down = useRef(false), id = useId();
  const say = (text: string) => viewOnly ? forViewers(text) : text;
  useEffect(() => {
    const d = box.current!, back = opener.current; if (!d.open) d.showModal();
    const notices = toNotices ? d.querySelector<HTMLElement>('.lab-party-notices') : null;
    if (notices) { notices.querySelector<HTMLElement>('button')?.focus({ preventScroll: true }); notices.scrollIntoView({ block: 'start' }); } else {
      // Focus starts on the close button at the top, as in the other dialogs. It used to start on "Read the full decision"
      // at the bottom: Safari scrolled there, so the summary opened at its end (user, 7 October: it looked like a bar with
      // no content), and elsewhere the focus sat out of sight. The body starts at the top,
      // now and once the browser has settled.
      d.querySelector<HTMLElement>('.lab-full-close')?.focus({ preventScroll: true });
      const body = d.querySelector<HTMLElement>('.lab-full-body'), top = () => { if (body) body.scrollTop = 0; };
      top(); requestAnimationFrame(top);
    }
    return () => { d.close(); back?.focus({ preventScroll: true }); };
  }, [opener, toNotices]);
  const reasons = summary?.release.reasons ?? [], brief = caseBrief(events), signals = badFaithSignals(events, checks);
  return <dialog ref={box} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1} className="lab-dialog lab-full lab-summary"
    onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } }} onCancel={e => { e.preventDefault(); onClose(); }} onClose={e => { if (!e.currentTarget.open) onClose(); }}
    onPointerDown={e => { down.current = e.target === e.currentTarget; }} onClick={e => { if (down.current && e.target === e.currentTarget) onClose(); }}>
    <header className="lab-full-head"><div><h2 id={id}><b>Case summary</b> · <span>{title}</span></h2></div><button type="button" className="quiet lab-full-close" onClick={onClose} aria-label="Close case summary" title="Close">×</button></header>
    <div className="lab-full-body">
      {!summary && <section className={'lab-summary-outcome tone-' + release.tone}><h3>No decision yet</h3><p>{release.word}. {say(release.note)}.</p></section>}
      {summary && <section className={'lab-summary-outcome tone-' + (summary.decided ? summary.release.tone : summary.stop === 'intake' ? 'idle' : summary.screen.tone)}>
        <h3>{summary.headline}{summary.remedy ? ' · ' + summary.remedy : ''}</h3>
        {summary.proposal && <p className="lab-summary-proposal">{summary.proposal}</p>}
        {summary.decided ? <p>{summary.release.held ? say(summary.release.note + ', so it is on hold. Start a new run to include the new evidence.') : final ? 'Sent to a person, who made the final decision (below).' : summary.release.tone === 'clear' ? 'Released as a recommendation, open for review and appeal.' : summary.release.tone === 'review' ? 'Sent to a person before release.' : summary.release.note + '.'} No payment executed.</p>
          : summary.stop === 'intake' ? <p>The claim went back to the driver before review, for the reasons under Checks below. No agent ran and no money moves.</p>
          : summary.stop === 'new_evidence' ? <p>A safety document was added after this run started, so this run cannot include it and cannot resume. Agents may already have worked on the earlier documents. {say('Start a new run to include the new one.')}</p>
          : summary.stop === 'chat' ? <p>{summary.cleared ? say('A person cleared the chat reading for the fare review. Resume the run to start the other agents.') : 'The Evidence Collector read a chat message as a possible threat or abuse, so a person looks before the other agents start. No account action was taken.'}</p>
          : summary.cleared ? <p>{say('A person cleared the safety screen for the fare review. No agent has run yet; resume the run to start them.')}</p>
          : <p>A person reviews the case before any agent starts. No agent ran and no account action was taken.</p>}
        {summary.decided && !summary.proposal && <ConfidenceScoreView score={confidenceFor(decision)} compact />}
      </section>}
      <section className="lab-summary-brief" aria-label="What this dispute is about">
        <h3>What this dispute is about</h3>
        {brief ? <><p>{brief}</p><p className="lab-summary-brief-source">Written by the Evidence Collector (AI) from the case file: its reading of the evidence, not a finding.</p></>
          : <p className="lab-summary-brief-source">The Evidence Collector (AI) writes a one-paragraph summary here once it has read the case file. There is none for this run yet.</p>}
      </section>
      {sla && <SlaLine view={sla} />}
      {summary && <><ul className="lab-summary-lines" aria-label="Checks">
        {summary.lines.map(line => <li key={line.label} className={'tone-' + line.tone}><i aria-hidden="true">{marks[line.tone]}</i><b>{line.label}</b><span>{say(line.text)}</span></li>)}
      </ul>
      {signals.available && <section className="lab-summary-reasons lab-summary-signals" aria-label="Bad-faith signals"><h4>Bad-faith signals (not proof)</h4>
        <p className="lab-gate-explain">Worked out by plain code from the record, not by an AI. Each signal has an innocent reading, and none decides the case. A record match sends the case to a person; the rest are for the reviewer to weigh.</p>
        {signals.signals.length ? <ul>{signals.signals.map(s => <li key={s.key}>{s.text}{s.sentToPerson && <b> Sent the case to a person.</b>} <span className="lab-signal-innocent">Innocent reading: {s.innocent}</span></li>)}</ul>
          : signals.ran && <p>None found in the checks that ran.</p>}
        {signals.notes.map(n => <p key={n} className="lab-gate-explain">{n}</p>)}
      </section>}
      {reasons.length > 0 && <section className="lab-summary-reasons"><h4>Why a person checks first</h4><ul>{reasons.map((r, i) => <li key={r.code + i}>{plainText(r.text)}</li>)}</ul></section>}
      {summary.release.notes.length > 0 && <section className="lab-summary-reasons"><h4>Notes for the reviewer</h4><ul>{summary.release.notes.map((n, i) => <li key={i}>{plainText(n)}</li>)}</ul></section>}</>}
      {latest?.kind === 'merits_review' && runId && !final && <HandoffForm key={runId} title="Review by a person" collapsed handoff={latest} actionable statuses={['assigned', 'referred_to_specialist']} busy={busy} error={error} action={action} runId={runId} viewOnly={viewOnly} />}
      {latest?.kind === 'merits_review' && runId && <DecisionForm key={'d' + runId} judge={decision ?? null} handoff={latest} final={final} safety={safetyOnRun(events)} scored={scored} rules={rules} busy={busy} error={error} action={action} runId={runId} viewOnly={viewOnly} />}
      {summary?.decided && decision && <PrecedentsConsidered decision={decision} packet={packet} events={events} />}
      {summary?.decided && <PartyNotices decision={final && decision && packet ? decidedNotice(decision, final, packet) : decision} packet={packet} />}
      {(!summary || summary.decided) && <p className="lab-gate-explain">The release check is plain code, not a model. After the Arbitrator decides, fixed rules decide whether a person looks first: for example a safety claim, a missing fact that could change the answer, an amount over S$50 (S$200 for a cleaning payment for vomit), a cleaning payment without clearly read photos and a clean record check, arbitrators who disagree, or a rule question on which more than S$10 depends. Any one of them sends the case to a person.</p>}
      {sla && <p className="lab-gate-explain">{targetsNote}</p>}
      <div className="lab-dialog-actions lab-summary-actions">
        {summary?.decided ? <button type="button" className="primary lab-summary-primary" onClick={onReadDecision}>{summary.proposal ? 'Read the Arbitrator\'s recommendation' : 'Read the full decision'}</button>
          : summary ? <button type="button" className="primary lab-summary-primary" onClick={onSafety}>Open the safety screen</button> : null}
        <button type="button" className={summary ? 'quiet' : 'quiet lab-summary-primary'} onClick={onClose}>Close</button>
      </div>
    </div>
  </dialog>;
}
