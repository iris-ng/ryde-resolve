'use client';
import { useEffect, useId, useRef, type RefObject } from 'react';
import type { RecordGate } from '../../../../packages/live-fishbowl/gates';
import IntegrityPanel from './integrity-panel';

// The record check's own dialog, opened from its gate card (3 October): what the check compared, each match with its
// cited lines and innocent reading, notes and account history. Moved here from the Status column so the check reads as
// a step of the run, beside the safety screen. Operator view only; party notices never mention it.
export default function RecordDialog({ gate, opener, runId, onClose }: { gate: RecordGate; opener: RefObject<HTMLElement | null>; runId: string; onClose: () => void }) {
  const box = useRef<HTMLDialogElement>(null), down = useRef(false), id = useId();
  useEffect(() => { const d = box.current!, back = opener.current; if (!d.open) d.showModal(); d.querySelector<HTMLElement>('.lab-full-close')?.focus(); return () => { d.close(); back?.focus({ preventScroll: true }); }; }, [opener]);
  return <dialog ref={box} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1} className="lab-dialog lab-full lab-gate-dialog lab-record-dialog"
    onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } }} onCancel={e => { e.preventDefault(); onClose(); }} onClose={e => { if (!e.currentTarget.open) onClose(); }}
    onPointerDown={e => { down.current = e.target === e.currentTarget; }} onClick={e => { if (down.current && e.target === e.currentTarget) onClose(); }}>
    <header className="lab-full-head"><div><h2 id={id}><b>Record check</b> · <span>{gate.integrity ? 'recorded for this run' : runId ? 'not recorded' : 'no run yet'}</span></h2></div><button type="button" className="quiet lab-full-close" onClick={onClose} aria-label="Close record check" title="Close">×</button></header>
    <div className="lab-full-body">
      <p className={'lab-gate-result tone-' + gate.tone}><b>{gate.word}.</b> {gate.note}.</p>
      <p className="lab-gate-explain">The record check is plain code, not a model. When a run starts it compares the case with a register of earlier claims: a receipt already used in another claim, a file with the same bytes as one in another claim, or a claim already paid. A match sends the case to a person before release, with the innocent reading beside it. It never changes the outcome, the agents never see it, and the parties are not told. The register is synthetic.</p>
      <IntegrityPanel integrity={gate.integrity ?? undefined} />
    </div>
  </dialog>;
}
