'use client';
import { useEffect, useState } from 'react';
import { outcomeLabels, paymentWords, remedyText, type FinalDecision, type Handoff } from '../../../../packages/live-fishbowl/gates';
import { agreeDraftNotice, agreementDraft, criterionQuestion, decisionLabels } from '../../../../packages/policy/loop-words';

type Judge = { outcome?: string; remedy?: { medium: string; amountCents: number }; riderRecovery?: { amountCents: number }; policyIds?: string[]; criteria?: { condition: string; status: string }[]; reviewReasons?: { condition: string; kind?: string; otherReading?: { outcome: string; remedyCents: number } }[]; routing?: { reasons?: { code?: string }[] }; panel?: { seats?: unknown[] } };
const statusWords: Record<string, string> = { met: 'yes', not_met: 'no', unresolved: 'not settled' };
const dollars = /^\d{1,4}(\.\d{1,2})?$/;

// A person's final decision on a decision the release check sent to them (store.ts recordDecision): agree with the Judge, or
// decide differently. Deciding differently drafts a past ruling from this case, which reaches no agent until a person
// approves it on the past rulings page. Only the person the review is assigned to can decide; a safety case never comes here.
export default function DecisionForm({ judge, handoff, final, safety = false, scored = false, rules, busy, error, action, runId, viewOnly = false }: {
  judge: Judge | null; handoff: Handoff; final: FinalDecision | null; safety?: boolean; scored?: boolean; rules: { id: string; title: string }[]; busy: boolean; error: string; action: (body: object) => Promise<any>; runId: string; viewOnly?: boolean;
}) {
  const recommended = !!judge?.outcome && judge.outcome !== 'human_review';
  const [mode, setMode] = useState<'agree' | 'override'>(recommended ? 'agree' : 'override');
  const [owner, setOwner] = useState(handoff.owner ?? ''), [outcome, setOutcome] = useState('no_action'), [medium, setMedium] = useState('voucher'), [amount, setAmount] = useState(''), [recovery, setRecovery] = useState(''), [tier, setTier] = useState('food_drink_crumbs_sand');
  const [reason, setReason] = useState(''), [criteria, setCriteria] = useState<string[]>([]), [added, setAdded] = useState<string[]>([]), [failed, setFailed] = useState(false);
  // The handoff can be assigned while this form is open (the form above it): the name follows until someone types one.
  useEffect(() => { if (handoff.owner) setOwner(o => o || handoff.owner!); }, [handoff.owner]);
  const judgeText = judge?.outcome ? (outcomeLabels[judge.outcome] ?? judge.outcome) + (paymentWords(judge) ? ' · ' + paymentWords(judge) : remedyText(judge.remedy) ? ' · ' + remedyText(judge.remedy) : '') : 'No decision yet';
  if (final) return <section className="handoff lab-final-decision"><h3>Final decision · {final.decision === 'agree' ? 'agreed with the Arbitrator' : 'decided differently'}</h3>
    <p><b>{final.owner}</b> {final.decision === 'agree' ? 'agreed with the Arbitrator' : `decided: ${decisionLabels[final.final.outcome] ?? final.final.outcome}${paymentWords(final.final) ? '. ' + paymentWords(final.final) : remedyText(final.final.remedy) ? ', ' + remedyText(final.final.remedy) : ''}`}. The Arbitrator recommended: {judgeText}.</p>
    <p>{final.reason}</p>
    {final.disagreedCriteria.length > 0 && <p><b>Findings they disagreed with:</b> {final.disagreedCriteria.map(criterionQuestion).join(' ')}</p>}
    {final.draftWithheld && <p className="lab-gate-notice">{final.draftWithheld}</p>}
    {final.draftId && <p className="lab-gate-notice">A draft past ruling was made from this case. It reaches no agent until a person approves it on the <a href="/precedents">past rulings page</a>.</p>}
    <p className="lab-gate-notice">Recorded by the shared demo operator. Nothing was paid or charged.</p></section>;
  const assigned = handoff.status === 'assigned';
  if (safety) return <section className="handoff lab-decision-form"><h3>Final decision by a person</h3><p>The Arbitrator recommended: <b>{judgeText}</b>.</p>
    <p className="lab-gate-notice">This run involves a safety concern, so no decision on the merits is recorded here and no past ruling is drafted. A specialist handles it.</p></section>;
  // The public copy (owner, 11 October 2026) shows a decision once a person has made it, never the form to make one.
  if (viewOnly) return <section className="handoff lab-decision-form"><h3>Final decision by a person</h3><p>The Arbitrator recommended: <b>{judgeText}</b>.</p>
    <p className="lab-gate-notice">No final decision is recorded yet. A reviewer records it on the team&apos;s own copy of the site.</p></section>;
  if (!assigned) return <section className="handoff lab-decision-form"><h3>Final decision by a person</h3><p>The Arbitrator recommended: <b>{judgeText}</b>.</p>
    <p className="lab-gate-notice">{handoff.status === 'referred_to_specialist' ? 'This review was referred to a specialist, so no final decision is recorded here.' : 'Assign the review first. The person it is assigned to then records the final decision here.'}</p></section>;
  const needsAmount = mode === 'override' && outcome !== 'no_action', cents = needsAmount && dollars.test(amount.trim()) ? Math.round(Number(amount) * 100) : 0;
  // Paying the driver and recovering from the rider are two decisions (6 October 2026): the recovery is its own amount, 0 allowed.
  const payment = mode === 'override' && outcome === 'driver_payment_recommendation', recoveryCents = payment && dollars.test(recovery.trim()) ? Math.round(Number(recovery) * 100) : null;
  const ready = owner.trim() && reason.trim().length >= 10 && (mode === 'agree' ? recommended : (!needsAmount || cents > 0) && (!payment || recoveryCents !== null));
  const toggle = (list: string[], set: (v: string[]) => void, id: string) => set(list.includes(id) ? list.filter(x => x !== id) : [...list, id]);
  const send = () => {
    setFailed(false);
    const body = mode === 'agree' ? { owner, decision: 'agree', reason } : { owner, decision: 'override', outcome, ...(outcome === 'refund_recommendation' ? { medium } : {}), ...(needsAmount ? { amountCents: cents } : {}), ...(payment && recoveryCents !== null ? { recoveryCents, cleaningTier: tier } : {}), reason, disagreedCriteria: criteria, addedRuleIds: added };
    void action({ action: 'decide', run: runId, decision: body }).then(r => { if (!r) setFailed(true); });
  };
  const cited = judge?.policyIds ?? [], agreeing = agreementDraft(judge);
  return <section className="handoff lab-decision-form"><h3>Final decision by a person</h3>
    <p>The Arbitrator recommended: <b>{judgeText}</b>.</p>
    {failed && error && <p role="alert" className="lab-gate-error">{error}</p>}
    <fieldset disabled={busy}>
      <legend className="lab-sr">Your decision</legend>
      <label className="check-label"><input type="radio" name="decision-mode" checked={mode === 'agree'} disabled={!recommended} onChange={() => setMode('agree')} /> Agree with the Arbitrator</label>
      <label className="check-label"><input type="radio" name="decision-mode" checked={mode === 'override'} onChange={() => setMode('override')} /> Decide differently</label>
      {!recommended && <p className="lab-gate-notice">The Arbitrator made no recommendation, so you give the decision.</p>}
      {mode === 'override' && <>
        <label>Outcome<select value={outcome} onChange={e => setOutcome(e.target.value)}>{Object.entries(decisionLabels).map(([k, v]) => <option key={k} value={k}>{v[0].toUpperCase() + v.slice(1)}</option>)}</select></label>
        {outcome === 'refund_recommendation' && <label>Paid<select value={medium} onChange={e => setMedium(e.target.value)}><option value="card">To the card</option><option value="voucher">As a voucher</option></select></label>}
        {needsAmount && <label>{payment ? 'Pay the driver, in dollars' : 'Amount in dollars'}<input inputMode="decimal" placeholder="6.61" value={amount} onChange={e => setAmount(e.target.value)} aria-invalid={!!amount && !cents} /></label>}
        {payment && <label>Mess tier (its cap is the most the driver can be paid)<select value={tier} onChange={e => setTier(e.target.value)}><option value="food_drink_crumbs_sand">Food, drink, crumbs or sand (up to SGD 40)</option><option value="bodily_fluids_or_stains">Bodily fluids or stains (up to SGD 120)</option><option value="vomit">Vomit (up to SGD 200)</option></select></label>}
        {payment && <label>Recover from the rider, in dollars (Ryde pays the driver even if this fails)<input inputMode="decimal" placeholder="40.00" value={recovery} onChange={e => setRecovery(e.target.value)} aria-invalid={!!recovery && recoveryCents === null} /></label>}
        {(judge?.criteria?.length ?? 0) > 0 && <fieldset className="lab-decision-picks"><legend>Which of the Arbitrator&apos;s findings do you disagree with?</legend>
          {judge!.criteria!.map(c => <label key={c.condition} className="check-label"><input type="checkbox" checked={criteria.includes(c.condition)} onChange={() => toggle(criteria, setCriteria, c.condition)} /> {criterionQuestion(c.condition)} <span className="lab-decision-judge">Arbitrator: {statusWords[c.status] ?? c.status}</span></label>)}
        </fieldset>}
        {rules.some(r => !cited.includes(r.id)) && <details className="lab-decision-picks"><summary>Add Ryde rules the Arbitrator did not cite (optional)</summary>
          {rules.filter(r => !cited.includes(r.id)).map(r => <label key={r.id} className="check-label"><input type="checkbox" checked={added.includes(r.id)} onChange={() => toggle(added, setAdded, r.id)} /> {r.id} · {r.title}</label>)}
        </details>}
      </>}
      <label>Your name<input value={owner} onChange={e => setOwner(e.target.value)} /></label>
      <label>{mode === 'agree' ? 'Why you agree' : 'Why you decide this (kept for reviewers and the draft past ruling; the parties get fixed wording)'}<textarea value={reason} onChange={e => setReason(e.target.value)} placeholder="In plain words, at least 10 characters" /></label>
      {/* Agreeing on a question the record or the rules leave open drafts a ruling too (loop.ts draftsOnDecision), unless the case is scored. */}
      {mode === 'agree' && (agreeing.drafts || agreeing.reason) && <p className="lab-gate-notice">{!agreeing.drafts ? agreeing.reason + ' Your agreement is still recorded.' : scored ? 'This is a scored test case, so agreeing records your decision but drafts no past ruling: scored cases only test the system and never teach it.' : agreeDraftNotice}</p>}
      {mode === 'override' && <p className="lab-gate-notice">{scored ? 'This is a scored test case, so deciding differently records your decision but drafts no past ruling: scored cases only test the system and never teach it.' : 'Deciding differently also drafts a past ruling from this case with your reason. It reaches no agent until a person approves it.'}</p>}
      <div className="workbench-actions"><button type="button" className="primary" disabled={!ready || busy} onClick={send}>Record final decision</button></div>
    </fieldset>
  </section>;
}
