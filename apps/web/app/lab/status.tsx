'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { postureName, plainText } from '../../../../packages/live-fishbowl/plain';
import { displayReasons, routingLabel } from '../../../../packages/agent-flow/routing';
import type { Lab } from './use-lab';
import PanelSeats, { ConfidenceScoreView } from './panel-seats';
import { confidenceFor, panelWithScores } from '../../../../packages/agent-flow/confidence';
import { chatHold, heldForNewEvidence, intakeReturned, outcomeLabels, paymentWords, remedyText } from '../../../../packages/live-fishbowl/gates';
import { runProgress, seatsFromEvents, type RoleStatus } from '../../../../packages/live-fishbowl/progress';
import type { Role } from '../../../../packages/agent-flow/contracts';
import { timelineRows } from '../../../../packages/live-fishbowl/timeline';
import type { GateTone } from '../../../../packages/live-fishbowl/gates';
import { sgDateTime } from '../../../../packages/live-fishbowl/sg-time';
import { responseTarget } from '../../../../packages/live-fishbowl/sla';
import { failureText, forViewers, runNotice } from './run-notice';
import type { Cite } from '../fishbowl/live/workbench';
import { ChatMarks, QuotedCite, senderName } from './evidence-checks';

const human = (s: string) => s.replaceAll('_', ' ');
const seatNames: Record<string, string> = { judge: 'Arbitrator A', judge_b: 'Arbitrator B', judge_c: 'Arbitrator C' };
// The safety screen's and record check's lines open their dialogs (lab.tsx); the others point into the conversation.
const dialogRow = (key: string) => key === 'screen' || key === 'record';
const seatWords: Record<RoleStatus, string> = { pending: 'waiting', working: 'working', sealed: 'done', failed: 'failed', stopped: 'stopped', skipped: 'did not run' };

type GateWords = { tone: GateTone; word: string };
// The decision card's "Ryde rules" button opens the rules for this case (rules-dialog.tsx; user, 10 October 2026: they are
// not evidence, so they left the Evidence column).
// The right column holds two things: the decision, then the run. The notices moved into the case summary, the case facts
// and the choice for unclear rules into the Case details dialog, and the record check into its own gate's dialog (3
// October). The run keeps a timeline: one line per step, the gates included (the progress list came back simpler, at the
// user's request). Routing notes for the reviewer stay in the summary. The recommendation card gives the outcome, the
// confidence and the routing; the Judge's own words are in the conversation, not repeated here (4 October UI audit). It takes
// the release check's colour, amber while a person must look and green once released or decided (4 October, user request). A panel run with no decision yet keeps one line of
// per-judge states: the Judge card shows only the latest seat.
// Each timeline line is a button (4 October, user request): it brings that step's messages into view in the conversation;
// the safety screen's and record check's lines open their dialogs, as their cards do (lab.tsx).
// The timeline reads newest first, the release check on top and the safety screen at the bottom, like the conversation
// (4 October, user request); timeline.ts keeps run order.
export default function Status({ lab, gates, onReadDecision, onRules, onNotices, onCaseDetails, onJump, onSafety, openSource }: { lab: Lab; gates: { screen: GateWords; record?: GateWords; release: GateWords }; onReadDecision: () => void; onRules?: () => void; onNotices: () => void; onCaseDetails: () => void; onJump?: (key: string, label: string) => void; onSafety?: () => void; openSource?: (c: Cite) => void }) {
  const { workspace, run, runId, events, status, running, busy, action, startRun, downloadAudit, openRun } = lab;
  const decision = useMemo(() => events.find(e => e.kind === 'decision_proposed'), [events]);
  const seats = useMemo(() => (run?.packet?.panel?.seats as Role[] | undefined) ?? seatsFromEvents(events), [run?.packet, events]);
  const seatStates = useMemo(() => !decision && seats.length > 1 ? runProgress(events, status, seats).find(p => p.phase === 'decide')?.roles ?? [] : [], [decision, seats, events, status]);
  const timeline = useMemo(() => timelineRows(runProgress(events, status, seats, !!run?.packet?.photos?.length), gates, lab.runLoading).reverse(), [events, status, seats, run?.packet, gates, lab.runLoading]);
  const terminal = !running && status !== 'not started';
  // Stop cannot be undone (Pause can), so it asks first, in place, and the safe choice takes focus (4 October UI audit).
  const [stopping, setStopping] = useState(false), keep = useRef<HTMLButtonElement>(null), stopButton = useRef<HTMLButtonElement>(null), asked = useRef(false);
  useEffect(() => { if (stopping) { asked.current = true; keep.current?.focus(); } else if (asked.current) { asked.current = false; stopButton.current?.focus(); } }, [stopping]);
  useEffect(() => { setStopping(false); }, [runId, terminal]);
  if (!workspace) return null;
  // The Run list spans every copy of the case (case-groups.ts); an older server sends only this workspace's runs. The open
  // run is always listed, even past the newest 30, so the list never names another run. A run
  // that is its copy's latest and still waits for a person says so (the picker's row points here).
  const own = workspace.runs.map(r => ({ ...r, workspace_id: workspace.id }));
  const listed = [...(workspace.groupRuns ?? own), ...own].filter((r, i, all) => all.findIndex(x => x.id === r.id) === i).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const runs = runId && !listed.some(r => r.id === runId) ? [{ id: runId, status, created_at: '', workspace_id: workspace.id }, ...listed] : listed;
  const waits = new Set(lab.cases.filter(c => { const t = c.run_id ? responseTarget(c.queue_events ?? [], c.status) : null; return !!t && !t.pickedUp; }).map(c => c.run_id));
  const remedy = remedyText(decision?.data?.remedy), paused = run?.requested === 'pause';
  // A run that waits for a server, lost its server, stopped for safety, stopped on a failure, or does not exist says so here (owner review, 8 October 2026).
  const say = (text: string) => lab.viewOnly ? forViewers(text) : text;
  const rawNotice = decision ? null : runNotice({ run, events, status, missing: lab.runMissing }), notice = rawNotice && say(rawNotice);
  const routing = decision?.data?.routing;
  // Held by the chat reading (MVP fixes, 10 October 2026): the card says why in plain words, quotes the lines, and points to
  // the safety screen's handoff controls; the run's own pause button resumes it once a person has cleared it.
  // New safety evidence outranks the hold: the run can never resume, so the card gives way to the notice and Resume is off.
  const blocked = heldForNewEvidence(events), hold = decision || blocked ? null : chatHold(events), held = !!hold && !hold.going;
  // The chat reading's hold not yet cleared: the server refuses a resume (store.ts controlRun), so Resume is off and says why.
  const waitsForReview = held && !hold!.cleared;
  // The rules are reachable in every state, not only once the Arbitrator has decided: a case
  // with no run, a held run or a stopped one still has the rules picked for it.
  // Prominent, with a book icon (user, 10 October 2026), not a quiet link.
  const rulesButton = onRules && <button type="button" className="lab-rules-button" aria-haspopup="dialog" onClick={onRules}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z" /><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5" /><path d="M8 7.5h8M8 11h6" /></svg>Ryde rules</button>;
  return <div className="lab-status">
    {decision ? <section className={'lab-proposal tone-' + gates.release.tone} aria-label="Recommendation"><h3>{outcomeLabels[decision.data?.outcome] ?? human(decision.data?.outcome ?? 'Recommendation ready')}{remedy ? ' · ' + remedy : ''}</h3>{paymentWords(decision.data) && <p className="lab-payment-words">{paymentWords(decision.data)}</p>}<ConfidenceScoreView score={confidenceFor(decision.data)} compact />{routing && (routing.route === 'human_review' || routing.reasons?.length > 0) && <div className={'routing-line ' + routing.route}>{routing.route === 'human_review' && <b>{routingLabel(routing)}</b>}{routing.reasons?.length > 0 && <ul>{displayReasons(decision.data).map((r: { code: string; text: string; seats?: string[] }, i: number) => <li key={r.code + i}>{decision.data.panel && r.seats?.length ? <b>{r.seats.length > 1 ? 'Arbitrators ' : 'Arbitrator '}{r.seats.join(', ')}: </b> : null}{plainText(r.text)}</li>)}</ul>}</div>}<div className="lab-proposal-actions"><button type="button" onClick={onReadDecision}>Read the decision</button>{rulesButton}<button type="button" className="quiet" onClick={onNotices}>Notices</button></div></section>
      : held && hold ? <section className="lab-proposal tone-review lab-hold" aria-label="Recommendation" aria-live="polite"><h3>Held for a safety review</h3>
        <p>{hold.cleared ? say(`${hold.handoff.owner ?? 'A reviewer'} cleared it for the fare review. Resume the run below to start the other agents.`) : 'A person must look first. The Evidence Collector read a chat message as a possible threat or abuse, so no other agent runs until a person clears it.'}</p>
        {hold.readings.length > 0 && <div className="lab-hold-quotes">{hold.readings.map((r, i) => <QuotedCite key={i} c={r} openSource={c => openSource?.(c)} who={<><b>{senderName(r.sender)}</b> <ChatMarks tone={r.tone} act={r.act} /></>} />)}</div>}
        <div className="lab-proposal-actions"><button type="button" onClick={onSafety}>Open the safety review</button>{rulesButton}</div></section>
      : notice ? <section className="lab-proposal pending" aria-label="Recommendation" aria-live="polite"><h3>{intakeReturned(events) ? 'Returned to the driver' : 'No recommendation yet'}</h3><p>{notice}</p>{rulesButton && <div className="lab-proposal-actions">{rulesButton}</div>}</section>
      : lab.runLoading ? <section className="lab-proposal pending" aria-label="Recommendation" aria-busy="true"><h3>Loading the run…</h3><p>The run's steps and decision are on their way.</p></section>
      : <section className="lab-proposal pending" aria-label="Recommendation"><h3>No recommendation yet</h3><p>{status === 'not started' ? say('Start a run. The Arbitrator decides after the other agents.') : terminal ? `The run ${human(status)} before the Arbitrator decided.` : 'The Arbitrator decides after the other agents finish.'}</p>{rulesButton && <div className="lab-proposal-actions">{rulesButton}</div>}</section>}
    {seatStates.length > 0 && <section className="lab-seat-states" aria-label="Arbitrators so far"><h3>Arbitrators</h3><ul>{seatStates.map(s => <li key={s.role} className={'seat-' + s.status}>{seatNames[s.role] ?? s.role} {seatWords[s.status]}</li>)}</ul></section>}
    <PanelSeats panel={panelWithScores(decision?.data)} events={events} />
    <section className="lab-run" aria-label="Run">
      <p className={'lab-state ' + status.replace(/\s/g, '-') + (lab.replaying ? ' replaying' : '')}><i />{lab.runLoading ? 'Loading' : lab.replaying ? 'Playing back the recorded run' : human(status)}{status === 'pausing' ? ' · finishing current tasks' : ''}{held && status === 'paused' ? ' · waiting for a person' : ''}{run?.error && decision ? ' · ' + say(failureText(run.error)) : ''}</p>
      <div className="lab-controls">
        {lab.viewOnly ? <>
          {/* The public copy (owner, 11 October 2026): Play shows the recorded run again (use-lab.ts startReplay), and the same
              button stops it. Nothing here starts, pauses or stops a real run; a run still going plays live as it is. */}
          <button type="button" className={'lab-run-icon' + (lab.replaying ? '' : ' primary')} disabled={!run || lab.runLoading || (!lab.replaying && (running || !events.length))} aria-label={lab.replaying ? 'Stop the replay' : 'Play back this run'} title={lab.replaying ? 'Stop the replay' : running ? 'This run is still going: watch it here as it happens' : 'Play back this run: its recorded messages again, faster. No AI is called'} onClick={lab.replaying ? lab.stopReplay : lab.startReplay}><RunIcon kind={lab.replaying ? 'stop' : 'start'} /></button>
          <span className="lab-replay-note">{lab.replaying ? `Playing back · ${Math.round(lab.replayShare * 100)}%` : run && !running && events.length ? 'Play back the actual recorded run' : ''}</span>
        </> : <>
          {/* One icon each (user, 7 October): start, pause, stop; the words are their labels and tooltips. Start is the main
              button only when starting a run is the next step: no decision yet and nothing running. A paused run keeps the
              pause icon, pressed, and pressing it again resumes: a play icon there would look like Start, which begins a
              new, paid run. */}
          <button type="button" className={'lab-run-icon' + (decision || running ? '' : ' primary')} disabled={busy} aria-busy={busy || undefined} aria-label={busy ? 'Saving' : 'Start a new run'} title={busy ? 'Saving…' : 'Start a new run'} onClick={startRun}><RunIcon kind="start" /></button>
          <button type="button" className="lab-run-icon" aria-pressed={paused} aria-label={paused ? 'Resume the run' : 'Pause the run'} title={paused ? (blocked ? 'New safety evidence: start a new run to include it' : waitsForReview ? 'Assign and clear the safety review first' : 'Paused: press to resume') : 'Pause the run'} disabled={!run || terminal || busy || status === 'stopping' || (paused && (blocked || waitsForReview))} onClick={() => action({ action: paused ? 'resume' : 'pause', run: runId })}><RunIcon kind="pause" /></button>
          {stopping && !terminal
            ? <span className="lab-stop-confirm" role="group" aria-label="Stop the run?"><span>Stop this run? It can&apos;t be resumed.</span><button type="button" className="danger" disabled={busy} onClick={() => { setStopping(false); void action({ action: 'stop', run: runId }); }}>Stop run</button><button ref={keep} type="button" className="quiet" onClick={() => setStopping(false)}>Keep running</button></span>
            : <button ref={stopButton} type="button" className="lab-run-icon" aria-label="Stop the run" title="Stop the run" disabled={!run || terminal || busy} onClick={() => setStopping(true)}><RunIcon kind="stop" /></button>}
        </>}
      </div>
      <ol className="lab-timeline" aria-label="Run progress" aria-busy={lab.runLoading || undefined}>{timeline.map(row => <li key={row.key} className={`lab-timeline-${row.kind} tone-${row.tone}`} title={row.detail ? `${row.label}: ${row.detail}` : undefined}>
        <button type="button" className="lab-timeline-jump" disabled={!run || lab.runLoading} aria-haspopup={dialogRow(row.key) ? 'dialog' : undefined} aria-label={`${row.label}: ${row.state}${row.detail ? ` (${row.detail})` : ''}. ${dialogRow(row.key) ? 'Open its details' : 'Show in the conversation'}`} onClick={() => onJump?.(row.key, row.label)}>
          <span className="lab-timeline-mark" aria-hidden="true" /><span className="lab-timeline-text"><b>{row.label}</b> · {row.state}{row.detail && <span className="lab-timeline-detail"> ({row.detail})</span>}</span>
        </button>
      </li>)}</ol>
      {runs.length > 1 && <label className="lab-run-pick">Run<select aria-label="Run" value={runId} onChange={e => { const r = runs.find(x => x.id === e.target.value); if (r) openRun(r.workspace_id, r.id); }}>{runs.map(r => <option key={r.id} value={r.id}>{r.created_at ? sgDateTime(r.created_at) : 'This run'} · {human(r.id === runId ? status : r.status)}{waits.has(r.id) ? ' · waits for a person' : ''}</option>)}</select></label>}
      <p className="lab-next-posture">Next run: {postureName(workspace.posture)}</p>
      <div className="lab-run-more">
        <button type="button" className="quiet" onClick={onCaseDetails}>Case details</button>
        <button type="button" className="quiet" disabled={!run} onClick={downloadAudit}>Download audit log</button>
      </div>
    </section>
  </div>;
}

// The run buttons' icons: a triangle to start, two bars to pause, a square to stop.
function RunIcon({ kind }: { kind: 'start' | 'pause' | 'stop' }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true">{kind === 'start' ? <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" /> : kind === 'pause' ? <path d="M7 5h3.2v14H7zM13.8 5H17v14h-3.2z" /> : <rect x={6} y={6} width={12} height={12} rx={2} />}</svg>;
}
