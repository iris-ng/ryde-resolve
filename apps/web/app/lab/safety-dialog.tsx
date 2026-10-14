'use client';
import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import type { ChatHold, Handoff, ScreenGate } from '../../../../packages/live-fishbowl/gates';
import { chatHoldMessages, forViewers } from './run-notice';
import { ChatMarks, QuotedCite, senderName } from './evidence-checks';
import type { Cite } from '../fishbowl/live/workbench';
import HandoffForm, { label } from './handoff-form';
import SlaLine from './sla-line';
import type { TargetView } from '../../../../packages/live-fishbowl/sla';

// The safety screen's own dialog, opened from its gate card: what the screen found, the flagged lines with their
// sources, the safety handoff and the form for reporting a safety concern. Moved here from the Evidence column's
// Safety tab so the screen reads as a step of the run, not as evidence. A merits handoff (a proposal routed to a
// person) is not a safety matter: it sits in the case summary. A safety flag waiting for a person shows its Urgent
// pick-up time here too (sla.ts). A run held by the chat reading (MVP fixes, 10 October 2026) says so here with the lines it
// quoted, above the same handoff controls.
export default function SafetyDialog({ screen, sla = null, latest, hold = null, blocked = false, opener, busy, error, action, workspaceId, runId, viewOnly = false, onClose, openSource }: {
  screen: ScreenGate; sla?: TargetView | null; latest: Handoff | null; hold?: ChatHold | null; blocked?: boolean; opener: RefObject<HTMLElement | null>; busy: boolean; error: string; action: (body: object) => Promise<any>;
  workspaceId: string; runId: string; viewOnly?: boolean; onClose: () => void; openSource: (c: Cite) => void;
}) {
  const box = useRef<HTMLDialogElement>(null), down = useRef(false), id = useId();
  const [statement, setStatement] = useState(''), [safety, setSafety] = useState({ immediateDanger: false, injury: false, harassment: false, dangerousDriving: false });
  const [loss, setLoss] = useState(''), [saved, setSaved] = useState(''), [failed, setFailed] = useState(false);
  useEffect(() => { const d = box.current!, back = opener.current; if (!d.open) d.showModal(); d.querySelector<HTMLElement>('.lab-full-close')?.focus(); return () => { d.close(); back?.focus({ preventScroll: true }); }; }, [opener]);
  const handoff = screen.handoff, triage = screen.triage, say = (text: string) => viewOnly ? forViewers(text) : text;
  const submit = () => {
    setSaved(''); setFailed(false);
    void action({ action: 'safety', workspace: workspaceId, intake: { ...safety, statement, claimedAdditionalCents: loss === '' ? null : Math.round(Number(loss) * 100) } })
      .then(r => { if (r) { setSaved('Saved as a document. Start a new run to include it.'); setStatement(''); setLoss(''); } else setFailed(true); });
  };
  return <dialog ref={box} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1} className="lab-dialog lab-full lab-gate-dialog"
    onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } }} onCancel={e => { e.preventDefault(); onClose(); }} onClose={e => { if (!e.currentTarget.open) onClose(); }}
    onPointerDown={e => { down.current = e.target === e.currentTarget; }} onClick={e => { if (down.current && e.target === e.currentTarget) onClose(); }}>
    <header className="lab-full-head"><div><h2 id={id}><b>Safety screen</b> · <span>{screen.recorded ? 'recorded for this run' : runId ? 'not recorded' : 'preview'}</span></h2></div><button type="button" className="quiet lab-full-close" onClick={onClose} aria-label="Close safety screen" title="Close">×</button></header>
    <div className="lab-full-body">
      <p className={'lab-gate-result tone-' + screen.tone}><b>{screen.word}.</b> {say(screen.note)}{/[.]$/.test(screen.note) ? '' : '.'}</p>
      {sla && <SlaLine view={sla} />}
      <p className="lab-gate-explain">The screen is plain code, not a model. Before any agent starts, it reads each line of the case documents and uploads (not the rule pages) for words such as injury, harassment, sexual misconduct, abuse, threat or crash. A hit holds the run and asks a person to review it; no agent starts until that person clears it for the fare review and resumes the run. A safety document uploaded during a run pauses that run, and a new run must include it.</p>
      {triage?.notice && <p className="lab-gate-notice">{triage.notice}</p>}
      {screen.flags.map((f, i) => <p key={i} className="lab-gate-flag"><b>Flagged line:</b> {f.quote} <button type="button" className="citation" onClick={() => openSource(f)}>{f.sourceId.split('/').at(-1)} · L{f.startLine}</button></p>)}
      {hold && <section className="lab-chat-hold" aria-label="Chat reading">
        <h3>Chat reading</h3>
        <p>After the screen, the Evidence Collector (AI) reads the chat one message at a time. It read {hold.readings.length === 1 ? 'this message' : `these ${hold.readings.length} messages`} as a possible threat or abuse, so the run {hold.going ? 'was held' : 'is held'} before the other agents start. This is the AI&apos;s reading, not a finding about either party.</p>
        {hold.readings.map((r, i) => <QuotedCite key={i} c={r} openSource={openSource} who={<><b>{senderName(r.sender)}</b> <ChatMarks tone={r.tone} act={r.act} /></>} />)}
        {/* New safety evidence during the run outranks any clearance: it can never resume (store.ts controlRun). */}
        {!hold.going && <p className="lab-gate-notice">{say(blocked ? chatHoldMessages.newEvidence + '.' : hold.cleared ? 'Cleared for the fare review. Resume the run from the Status column to start the other agents.' : 'Assign a reviewer and read the original chat. Once the reviewer clears it for the fare review, resume the run from the Status column.')}</p>}
      </section>}
      {handoff && runId && <HandoffForm key={runId} title="Safety review" handoff={handoff} actionable={latest === handoff} statuses={['assigned', 'cleared_for_fare_review', 'referred_to_specialist']} busy={busy} error={error} action={action} runId={runId} viewOnly={viewOnly} />}
      {/* Not on the public copy (owner, 11 October 2026): it saves a document for the next run. */}
      {!viewOnly && <details><summary>Report a safety concern or additional loss</summary><p>Saved as a document for this case. Start a new run to include it.</p>
        {failed && error && <p role="alert" className="lab-gate-error">{error}</p>}
        {saved && <p role="status" className="lab-gate-saved">{saved}</p>}
        <form onSubmit={e => { e.preventDefault(); submit(); }}>
          {Object.entries(safety).map(([key, value]) => <label className="check-label" key={key}><input type="checkbox" checked={value} onChange={e => setSafety({ ...safety, [key]: e.target.checked })} />{label(key)}</label>)}
          <label>Original complaint<textarea required value={statement} maxLength={3000} onChange={e => setStatement(e.target.value)} /></label>
          <label>Additional loss claimed (SGD, leave blank if unknown)<input type="number" min="0" max="1000000" step="0.01" value={loss} onChange={e => setLoss(e.target.value)} /></label>
          <button disabled={busy}>Save for the next run</button>
        </form>
      </details>}
    </div>
  </dialog>;
}
