'use client';
import { useEffect, useId, useRef, type RefObject } from 'react';
import { posturePresets } from '../../../../packages/agent-flow/posture';
import { postureName } from '../../../../packages/live-fishbowl/plain';
import { isActive, type Lab } from './use-lab';

// Case details: the facts about the case and the choice for unclear rules, moved out of the Status column (3 October)
// so that column holds only the decision and the run. Opened from the run section's "Case details" button.
export default function CaseDialog({ lab, opener, onClose }: { lab: Lab; opener: RefObject<HTMLElement | null>; onClose: () => void }) {
  const box = useRef<HTMLDialogElement>(null), down = useRef(false), id = useId();
  const { workspace, busy, action, running, error, setError, viewOnly } = lab;
  // Errors show inside the dialog: the page's error line sits behind the modal.
  useEffect(() => { const d = box.current!, back = opener.current; setError(''); if (!d.open) d.showModal(); d.querySelector<HTMLElement>('.lab-full-close')?.focus(); return () => { d.close(); back?.focus({ preventScroll: true }); }; }, [opener, setError]);
  if (!workspace) return null;
  // Any active run of this case blocks the change, not only the one on screen (the server refuses it too).
  const active = running || workspace.runs.some(r => isActive(r.status));
  // The case's files as a new run gets them: without the advance outside data a run leaves out (evidence checks 4, AD-11).
  const documents = workspace.baseDocuments.filter(d => !d.id.startsWith('policy/') && workspace.packet.sources.some(s => s.id === d.id)).length + workspace.documents.length;
  return <dialog ref={box} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1} className="lab-dialog lab-full lab-case-dialog"
    onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } }} onCancel={e => { e.preventDefault(); onClose(); }} onClose={e => { if (!e.currentTarget.open) onClose(); }}
    onPointerDown={e => { down.current = e.target === e.currentTarget; }} onClick={e => { if (down.current && e.target === e.currentTarget) onClose(); }}>
    <header className="lab-full-head"><div><h2 id={id}><b>Case details</b> · <span>{workspace.title}</span></h2></div><button type="button" className="quiet lab-full-close" onClick={onClose} aria-label="Close case details" title="Close">×</button></header>
    <div className="lab-full-body">
      <dl className="lab-facts">
        <div><dt>Dispute type</dt><dd>{workspace.detection ? (workspace.detection.documents ? workspace.detection.label : 'Detected once documents are uploaded') : workspace.caseId === 'CUSTOM' ? 'Not detected yet' : 'Sample ' + workspace.caseId}</dd></div>
        <div><dt>Evidence</dt><dd>{documents} document{documents === 1 ? '' : 's'}</dd></div>
        <div><dt>Rules</dt><dd>Ryde&apos;s public pages, saved 23 September 2026</dd></div>
      </dl>
      <div className="lab-posture"><h3>When the rules are unclear</h3><p className="lab-posture-help">{viewOnly ? 'The choice this case\'s next run starts with. Only the team can change it.' : active ? 'A run is active. Stop it to change this; a run keeps the choice it started with.' : 'Applies to the next run; a run keeps the choice it started with.'}</p>{error && <p role="alert" className="lab-form-error">{error}</p>}<div className="posture-actions">{(Object.keys(posturePresets) as (keyof typeof posturePresets)[]).map(preset => <button key={preset} type="button" className={workspace.posture?.preset === preset ? 'quiet selected' : 'quiet'} aria-pressed={workspace.posture?.preset === preset} disabled={viewOnly || busy || active || workspace.posture?.preset === preset} onClick={() => action({ action: 'posture', workspace: workspace.id, posture: posturePresets[preset] })}>{postureName(posturePresets[preset])}</button>)}</div></div>
    </div>
  </dialog>;
}
