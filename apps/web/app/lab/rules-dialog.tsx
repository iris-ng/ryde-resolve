'use client';
import { useEffect, useId, useRef, type RefObject } from 'react';
import type { CasePacket } from '../../../../packages/agent-flow/contracts';
import { disputeTypeNames, isDisputeType, libraryHref, libraryTypeHref } from '../../../../packages/policy/library-links';
import { LibraryLink } from './library-window';

// The Ryde rules for this case, opened from the decision's "Ryde rules" button (user, 10 October 2026: the rules are not
// evidence, so they left the Evidence column). The rules the Arbitrator cited come first, then the others the agents were
// given; each opens its library page in the library window. A run from before the 40-rule ruleset shows the reviewed public
// pages it pinned, as the old Policies tab did.
type Rule = { rule_id: string; title?: unknown; statement?: unknown; text?: unknown };
function RuleList({ rules }: { rules: Rule[] }) {
  return <ul className="lab-rule-list">{rules.map(p => <li key={p.rule_id}><LibraryLink href={libraryHref('rules', p.rule_id)}><span className="lab-rule-id">{p.rule_id}</span><span><b>{String(p.title ?? '')}</b><span>{String(p.statement ?? '')}</span></span></LibraryLink></li>)}</ul>;
}

export function RulesForCase({ packet, cited }: { packet: CasePacket | undefined; cited: string[] }) {
  if (!packet) return <p className="lab-empty">This case has no rules picked yet.</p>;
  const reference = packet.policyReference, publicRules = packet.policyBasis === 'reviewed-public';
  const category = packet.policySelection?.category ?? reference?.selection.category;
  const rules = (packet.policies ?? []) as Rule[], ids = new Set(cited);
  const citedRules = cited.flatMap(id => rules.filter(r => r.rule_id === id)), others = rules.filter(r => !ids.has(r.rule_id));
  return <>
    {publicRules && <p className="lab-library-note">The Ryde rules the agents read for this case. <LibraryLink href={libraryTypeHref(category ?? '')}>Open the library</LibraryLink> for every rule and past ruling{isDisputeType(category) ? ` on ${disputeTypeNames[category].toLowerCase()} disputes` : ''}.</p>}
    {packet.policyBasis !== 'reviewed-public' && rules.map(p => <details key={p.rule_id}><summary>{p.rule_id}</summary><p>{String(p.text ?? JSON.stringify(p))}</p></details>)}
    {/* Dataset and custom cases carry the 40-rule ruleset's own rules, not the older reference cards; each opens its library page. */}
    {publicRules && !reference && !rules.length && <p className="lab-empty">No rules are picked for this case yet. They are picked from its dispute type once its documents are in.</p>}
    {publicRules && !reference && <>
      {citedRules.length > 0 && <><h3>Cited by the Arbitrator</h3><RuleList rules={citedRules} /></>}
      {others.length > 0 && <>{citedRules.length > 0 && <h3>Also given to the agents</h3>}<RuleList rules={others} /></>}
    </>}
    {(reference || !publicRules) && <><h3>Ryde&apos;s public pages we reviewed</h3>{reference ? <><p>{reference.notice}</p><p>{reference.selection.applicability}</p><p className="digest">Release {reference.releaseId} · SHA-256 {reference.sha256}</p>{reference.cards.filter(c => reference.selection.selectedIds.includes(c.id)).map(card => <details key={card.id}><summary>{card.id} · {card.title}</summary><p><b>Scope:</b> {card.scope.services} {card.scope.booking}</p><p><b>When it applied:</b> {card.dates.historical_applicability}</p><h4>Conditions</h4><ul>{card.conditions.map((c, i) => <li key={i}>{c}</li>)}</ul><h4>Exceptions and limits</h4><ul>{card.exceptions_and_limits.map((c, i) => <li key={i}>{c}</li>)}</ul><p><b>Related rules:</b> {card.dependencies.join(', ') || 'None'} · <b>Pages that disagree:</b> {card.conflict_ids.join(', ') || 'None recorded'}</p>{card.sources.map((s, i) => <section key={i}><a href={s.canonical_url} target="_blank" rel="noreferrer">Original public page ↗</a><p>Archived {s.snapshot_date} · lines {s.line_start}–{s.line_end}</p><blockquote>{s.exact_text}</blockquote><p className="digest">Original SHA-256 {s.sha256}</p></section>)}<p><LibraryLink href={libraryHref('rules', card.id)}>Open {card.id} in the library</LibraryLink></p></details>)}</> : <p>This run has no saved copy of the rules. Newer runs carry one.</p>}</>}
  </>;
}

export default function RulesDialog({ packet, cited, opener, onClose }: { packet: CasePacket | undefined; cited: string[]; opener: RefObject<HTMLElement | null>; onClose: () => void }) {
  const box = useRef<HTMLDialogElement>(null), down = useRef(false), id = useId();
  useEffect(() => { const d = box.current!, back = opener.current; if (!d.open) d.showModal(); d.querySelector<HTMLElement>('.lab-full-close')?.focus(); return () => { d.close(); back?.focus({ preventScroll: true }); }; }, [opener]);
  return <dialog ref={box} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1} className="lab-dialog lab-full lab-rules-dialog"
    onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } }} onCancel={e => { e.preventDefault(); onClose(); }} onClose={e => { if (!e.currentTarget.open) onClose(); }}
    onPointerDown={e => { down.current = e.target === e.currentTarget; }} onClick={e => { if (down.current && e.target === e.currentTarget) onClose(); }}>
    <header className="lab-full-head"><div><h2 id={id}><b>Ryde rules</b> · <span>for this case</span></h2></div><button type="button" className="quiet lab-full-close" onClick={onClose} aria-label="Close the Ryde rules" title="Close">×</button></header>
    <div className="lab-full-body"><RulesForCase packet={packet} cited={cited} /></div>
  </dialog>;
}
