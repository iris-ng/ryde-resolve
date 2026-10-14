'use client';
import { useEffect, useId, useRef, type RefObject } from 'react';
import { queueOrderNote, queueReasons, span, stakeText, targetsNote, type QueueEvent, type ResponseTarget } from '../../../../packages/live-fishbowl/sla';

/** One waiting case: the copy whose run waits, its target and the trimmed events its reasons come from. */
export type QueueRow = { id: string; runId: string | null; title: string; caseId: string; target: ResponseTarget; events: QueueEvent[] };

// The live queue (owner, 11 October 2026: the SLA and routing manager made visible): every case the system sent to a person
// that nobody has picked up, in the order a person should take them (sla.ts queueOrder), from the case list as it last loaded.
// Like the picker's priority, it reads each copy's latest run: a new run in the same copy takes the place of an earlier
// routed one (the earlier one then leaves the queue; that is the intended reading of a rerun).
// It reads what the runs recorded and changes nothing: no release decision, routing or agent reads the order. Opened from the
// Queue button in the top bar; a row opens its case.
export default function QueueDialog({ rows, now, opener, onPick, onClose }: { rows: QueueRow[]; now: number; opener: RefObject<HTMLElement | null>; onPick: (id: string, runId: string | null) => void; onClose: () => void }) {
  const box = useRef<HTMLDialogElement>(null), down = useRef(false), id = useId();
  useEffect(() => { const d = box.current!, back = opener.current; if (!d.open) d.showModal(); d.querySelector<HTMLElement>('.lab-full-close')?.focus(); return () => { d.close(); back?.focus({ preventScroll: true }); }; }, [opener]);
  const urgent = rows.filter(r => r.target.priority === 'urgent').length;
  return <dialog ref={box} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1} className="lab-dialog lab-full lab-queue"
    onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } }} onCancel={e => { e.preventDefault(); onClose(); }} onClose={e => { if (!e.currentTarget.open) onClose(); }}
    onPointerDown={e => { down.current = e.target === e.currentTarget; }} onClick={e => { if (down.current && e.target === e.currentTarget) onClose(); }}>
    <header className="lab-full-head"><div><h2 id={id}><b>Live queue</b> · <span>{rows.length ? `${rows.length} waiting for a person${urgent ? `, ${urgent} urgent` : ''}` : 'nobody waiting'}</span></h2></div><button type="button" className="quiet lab-full-close" onClick={onClose} aria-label="Close the live queue" title="Close">×</button></header>
    <div className="lab-full-body">
      <p className="lab-queue-intro">This is the live queue: every case whose latest run our system sent to a person, where nobody has picked it up yet, worked out from the recorded runs each time the case list loads. A new run of a case takes the place of its earlier one. {queueOrderNote}</p>
      <p className="lab-queue-intro">The order is for the people who review cases. It never changes a decision, and no agent sees it. No reviewers are on duty in this demo, so cases stay here until someone picks them up.</p>
      {rows.length ? <ol className="lab-queue-list">
        {rows.map((r, i) => { const stake = stakeText(r.target), reasons = queueReasons(r.events, r.target);
          return <li key={r.id}><button type="button" onClick={() => onPick(r.id, r.runId)}>
            <span className="lab-queue-place" aria-hidden="true">{i + 1}</span>
            <span className="lab-queue-main"><strong>{r.title}</strong>
              <span className="lab-queue-line"><b className={'tone-' + r.target.priority}>{r.target.label}</b> · {stake ?? 'no amount on record'} · waiting {span(now - Date.parse(r.target.since))} · {r.caseId}</span>
              {reasons.length > 0 && <span className="lab-queue-why">Sent to a person for {reasons.join(', ')}.</span>}</span>
          </button></li>; })}
      </ol> : <p className="lab-queue-empty">No case is waiting for a person right now.</p>}
      <p className="lab-gate-explain">The money at stake is the most money the person&apos;s decision can move: the larger of the Arbitrator&apos;s recommended amount and its amount under the other reading of each open question. With no recommendation, or before any agent ran, it is the disputed charge plus any extra loss claimed. {targetsNote}</p>
    </div>
  </dialog>;
}
