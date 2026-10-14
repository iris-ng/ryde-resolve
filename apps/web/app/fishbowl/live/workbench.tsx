'use client';
import { assumptionById } from '../../../../../packages/agent-flow/posture';
import { plainText } from '../../../../../packages/live-fishbowl/plain';
import { libraryHref, readingNumber } from '../../../../../packages/policy/library-links';
import { LibraryLink } from '../../lab/library-window';
import { ChatReadingView, Citations } from '../../lab/evidence-checks';
import { GapAnswersView, GapPointsView } from '../../lab/record-checks';
import type { CasePacket } from '../../../../../packages/agent-flow/contracts';

type Event = { seq: number; actor: string; phase: string; kind: string; data?: any };
export type Cite = { sourceId: string; startLine: number; endLine: number };
const label = (text: string) => text.replaceAll('_', ' ').replace(/([a-z])([A-Z])/g, (_, a: string, b: string) => a + ' ' + b.toLowerCase());
// Headings for an agent's written fields, in plain words.
const fieldNames: Record<string, string> = { summary: 'Summary', position: 'Position', reasoning: 'Reasoning', counterEvidence: 'Evidence against', question: 'Question', disputedClaim: 'Claim being questioned', targetQuote: 'Quoted claim', answer: 'Answer', revisedPosition: 'Updated position' };

// `disclosed`: the run's disclosed arguments, so a challenge's gap points and the Arbitrator's answers can quote the point each one is
// against (second release, 10 October 2026). Without it they still show, with less to quote.
export function ArtifactView({ item, openSource, disclosed }: { item: any; openSource: (c: Cite) => void; disclosed?: Record<string, any> }) {
  const citations = (items: Cite[] = []) => items.map((c, i) => <button className="citation" key={i} onClick={() => openSource(c)}>{c.sourceId.split('/').at(-1)} · L{c.startLine}–{c.endLine}</button>);
  // MVP fixes (owner, 10 October 2026): on a run with evidence checks, an advocate's counterEvidence is the strongest objection to its
  // party's case and its answer; its claims then carry ruleIds. Older arguments keep the old heading.
  const advancing = Array.isArray(item?.claims) && item.claims.some((c: any) => Array.isArray(c?.ruleIds));
  return <div className="argument-view">
    {['summary', 'position', 'reasoning', 'counterEvidence', 'question', 'disputedClaim', 'targetQuote', 'answer', 'revisedPosition'].map(key => item[key] && <section key={key}><h4>{key === 'counterEvidence' && advancing ? `The best point against the ${item.author === 'driver' ? 'driver' : 'rider'}, and the reply` : fieldNames[key] ?? label(key)}</h4><p>{item[key]}</p></section>)}
    {/* A pinned run's claims name their rules and quote their lines (MVP fixes, 10 October 2026); older claims show as before. */}
    {item.claims?.map((claim: any) => <section key={claim.claimId}><h4>Claim</h4><p>{claim.statement}</p>
      {Array.isArray(claim.ruleIds) && claim.ruleIds.length > 0 && <p className="lab-claim-rules"><span>Ryde rules:</span> {claim.ruleIds.map((id: string) => <LibraryLink key={id} className="lab-rule-chip" href={libraryHref('rules', id)}>{id}</LibraryLink>)}</p>}
      {claim.citations?.some((c: any) => typeof c?.quote === 'string') ? <Citations items={claim.citations} openSource={openSource} /> : citations(claim.citations)}</section>)}
    {item.issues?.map((issue: any, i: number) => <section key={'i' + i}><h4>Issue raised ({issue.party})</h4><p>{issue.allegation}</p>{citations(issue.citations)}</section>)}
    {item.observations?.map((o: any, i: number) => <section key={'o' + i}><h4>Observation · {label(o.type)}</h4><p><b>{o.subject}:</b> {o.value}{o.observedAt ? ` (${o.observedAt})` : ''}</p>{o.qualityFlags?.length ? <p className="flags">{o.qualityFlags.join(' · ')}</p> : null}{citations(o.citations)}</section>)}
    {item.evidenceRequests?.map((r: any, i: number) => <p key={'r' + i}><b>Evidence request · {label(r.status)}:</b> {r.target}. {r.purpose}{r.result ? ` Result: ${r.result}` : ''}</p>)}
    <ChatReadingView item={item} openSource={openSource} />
    <GapPointsView item={item} disclosed={disclosed} openSource={openSource} />
    {item.assessments?.map((a: any, i: number) => <section key={'as' + i}><h4>Ryde rule {a.ruleId} · applies: {a.applies}{a.conflictIds?.length ? ` · conflicts ${a.conflictIds.join(', ')}` : ''}</h4>{a.conditions.map((c: any, j: number) => <p key={j}><b>{c.condition} · {label(c.status)}.</b> {c.reason} {citations(c.citations)}</p>)}{a.exceptions?.length ? <p><b>Exceptions:</b> {a.exceptions.join('; ')}</p> : null}</section>)}
    {item.policyGaps?.map((g: any, i: number) => <p key={'g' + i}><b>Rule gap:</b> {g.issue}. {g.gap}</p>)}
    {item.precedents?.map((p: any, i: number) => <p key={'p' + i}><b>Past ruling {p.precedentId} · {label(p.status)}:</b> {p.differences}</p>)}
    {item.issueDispositions?.map((d: any, i: number) => <p key={'d' + i}><b>Issue {d.issueId.split('/').slice(-2).join('/')} · {label(d.status)}:</b> {d.reason}</p>)}
    {item.criteria?.map((criterion: any) => <section key={criterion.condition}><h4>{label(criterion.condition)} · {label(criterion.status)}</h4><p>{criterion.reason}</p>{citations(criterion.citations)}</section>)}
    <GapAnswersView item={item} disclosed={disclosed} />
    {item.revisions?.map((revision: any, i: number) => <section key={i}><h4>Position corrected</h4><p><b>Before:</b> {revision.previousText}</p><p><b>After:</b> {revision.updatedText}</p></section>)}
    {[...(item.uncertainties ?? []), ...(item.remainingUncertainties ?? []), ...(item.unresolvedIssues ?? [])].map((text: string, i) => <p key={i}><b>Unresolved:</b> {text}</p>)}
    {item.reviewReasons?.map((r: any, i: number) => <p key={i}><b>Open question, {label(r.condition)}{r.kind ? ` (${label(r.kind)})` : ''}:</b> {r.reason} {r.decisionImpact}{r.recommendedReading && <><br /><b>Reading this recommendation rests on:</b> {r.recommendedReading}</>}</p>)}
    {item.routing && <section className={'routing ' + item.routing.route}><h4>{item.routing.route === 'human_review' ? 'Sent to a person before release' : 'Released as a recommendation, open for review and appeal'}</h4>{item.routing.reasons.length ? <ul>{item.routing.reasons.map((r: any, i: number) => <li key={r.code + i}>{plainText(r.text)}</li>)}</ul> : <p>No release rule fired: no safety flag, remedy within SGD {(item.routing.thresholdCents / 100).toFixed(2)}, no missing fact, at most two team readings.</p>}</section>}
    {item.conditional && <section className="conditional-banner"><h4>Conditional demo assessment</h4></section>}
    {item.assumptions?.map((a: any, i: number) => { const r = assumptionById(a.id); return <section key={'as' + i} className="assumption"><h4>Team reading {readingNumber(a.id)} · fills a gap in {label(a.criterion)}</h4><p>{r?.statement ?? 'Unknown assumption'}</p><p><b>What would overturn it:</b> {r?.whatWouldOverturn}</p><p><b>Limits:</b> {r?.forbids}</p><p><b>Rules:</b> {(r?.ruleIds ?? []).join(', ')}</p></section>; })}
    {item.explanationToBothParties && <section><h4>Proposed explanation to both parties</h4><p>{item.explanationToBothParties}</p></section>}
    {item.additionalTargets?.map((t: any, i: number) => <section key={'t' + i}><h4>Also challenged</h4><p><b>Claim:</b> {t.targetQuote}</p><p>{t.disputedClaim} {t.question}</p></section>)}
    {item.additionalAnswers?.map((a: any, i: number) => <section key={'a' + i}><h4>Answer to the additional challenge</h4><p>{a.answer}</p></section>)}
    {typeof item.confidence === 'number' && <p><b>The model's own confidence: {item.confidence} (not used).</b> {item.confidenceBasis}</p>}
    <p><b>Ryde rules read and cited:</b> {(item.policyIds ?? []).map((id: string, i: number) => <span key={id}>{i ? ', ' : ''}<LibraryLink href={libraryHref('rules', id)}>{id}</LibraryLink></span>)}</p>{citations(item.citations)}
  </div>;
}

// The External tab's operator fetch form was removed on 11 October 2026 (owner): the Evidence Collector looks outside data up itself.
