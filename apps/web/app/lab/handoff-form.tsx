'use client';
import { useState } from 'react';
import type { Handoff } from '../../../../packages/live-fishbowl/gates';
import { handoffAction, handoffState, plainText } from '../../../../packages/live-fishbowl/plain';
import { forViewers } from './run-notice';

export const label = (text: string) => text.replaceAll('_', ' ').replace(/([a-z])([A-Z])/g, (_, a: string, b: string) => a + ' ' + b.toLowerCase());

// One handoff and the controls to move it on. The store applies an update to the run's latest handoff (store.ts
// updateReview), so the controls show only when this handoff is that one. Feedback is this form's own: the page's
// alert sits behind the modal, and an earlier, unrelated error is not this form's.
// On the public copy (owner, 11 October 2026) it shows who has the review and its note, with no controls.
export default function HandoffForm({ title, collapsed = false, handoff, actionable, statuses, busy, error, action, runId, viewOnly = false }: {
  title: string; collapsed?: boolean; handoff: Handoff; actionable: boolean; statuses: string[]; busy: boolean; error: string; action: (body: object) => Promise<any>; runId: string; viewOnly?: boolean;
}) {
  const [owner, setOwner] = useState(''), [note, setNote] = useState(''), [saved, setSaved] = useState(''), [failed, setFailed] = useState(false);
  const send = (status: string) => { setSaved(''); setFailed(false); void action({ action: 'review', run: runId, review: { owner, status, note } }).then(r => { if (r) setSaved(`Marked ${handoffState[status] ?? label(status)}.`); else setFailed(true); }); };
  const heading = `${title} · ${handoffState[handoff.status] ?? label(handoff.status)}`;
  const body = <><p><b>Assigned to:</b> {handoff.owner ?? 'Nobody assigned'}</p>{handoff.note && <p>{plainText(viewOnly ? forViewers(handoff.note) : handoff.note)}</p>}
    {failed && error && <p role="alert" className="lab-gate-error">{error}</p>}
    {saved && <p role="status" className="lab-gate-saved">{saved}</p>}
    {viewOnly ? null : actionable ? <>
      <label>Reviewer name<input value={owner} onChange={e => setOwner(e.target.value)} /></label>
      <label>Review note<textarea value={note} onChange={e => setNote(e.target.value)} /></label>
      <div className="workbench-actions">{statuses.map(status => <button key={status} type="button" disabled={busy || !owner.trim() || note.trim().length < 10 || (status === 'cleared_for_fare_review' && handoff.status !== 'assigned')} onClick={() => send(status)}>{handoffAction[status] ?? label(status)}</button>)}</div>
    </> : <p className="lab-gate-notice">A later review request on this run is the one to update now.</p>}
  </>;
  // Folded where it is secondary (the case summary), open where it is the point (the safety dialog).
  return collapsed ? <details className="handoff lab-handoff-fold"><summary>{heading}</summary>{body}</details> : <section className="handoff"><h3>{heading}</h3>{body}</section>;
}
