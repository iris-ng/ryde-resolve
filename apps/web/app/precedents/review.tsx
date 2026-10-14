'use client';
import '../zod-browser';
import { useCallback, useEffect, useState } from 'react';
import type { Precedent } from '../../../../packages/policy/precedents';
import { criterionQuestion, decisionLabels, loopStatusWords, outcomeWords, pastRulingsNotPolicy } from '../../../../packages/policy/loop-words';
import { remedyText } from '../../../../packages/live-fishbowl/gates';
import { runMessages } from '../../../../packages/live-fishbowl/messages';
import { connectionMode, reach, readAnswer, siteLoginEnded } from '../lab/answer';
import { forViewers } from '../lab/run-notice';

type Remedy = { medium: string; amountCents: number };
type Row = { id: string; revision: string; runId: string; workspaceId: string | null; caseId: string | null; status: string; card: Precedent; judge: { outcome: string; remedy: Remedy }; decision: { owner?: string; reason?: string; disagreedCriteria?: string[]; decidedAt?: string; final?: { outcome: string; remedy: Remedy } }; createdAt: string; reviewedBy: string | null; reviewNote: string | null; problems: string[]; conflicts?: string[]; conflictDetails?: { id: string; extra: string[] }[] };
type Rule = { id: string; title: string; categories: string[] };
const TOKEN_KEY = 'live-fishbowl-token';
const filters = [['draft_pending_review', 'Waiting'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['overturned', 'Withdrawn'], ['all', 'All']] as const;
const value = (v: unknown) => v === true ? 'yes' : v === false ? 'no' : v === null ? 'unknown' : String(v);
const joinWords = (list: string[]) => list.length < 2 ? list.join('') : list.slice(0, -1).join(', ') + ' and ' + list.at(-1);
const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

// The learning loop's review page (4 October). When a person decides a case differently from the Judge, code drafts a
// past ruling from that case (policy/loop.ts). Nothing here reaches an agent until a person approves it; an approved card
// joins the cards that runs started afterwards pin; it is never deleted, only withdrawn. Same operator session as the lab.
export default function Review() {
  const [token, setToken] = useState<string | null>(null), [draftToken, setDraftToken] = useState('');
  const [rows, setRows] = useState<Row[] | null>(null), [rules, setRules] = useState<Rule[]>([]), [error, setError] = useState(''), [filter, setFilter] = useState<string>('draft_pending_review');
  const [counts, setCounts] = useState<Record<string, number>>({}), [page, setPage] = useState(1), [pages, setPages] = useState(1);
  // The public copy (owner, 11 October 2026) reads the rulings and changes none: no approve, edit, reject or withdraw.
  // Since 12 October 2026 it shows the Library's rulings only (the server sends no others): one Approved tab, no reviewers' notes.
  const [viewOnly, setViewOnly] = useState(false);
  // The same first check as the lab (lab/answer.ts): a restart is tried again, never taken for a missing token (owner review, 8 October 2026).
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout> | undefined, tries = 0;
    const check = () => connectionMode().then(mode => { if (!alive) return; setError(mode === 'signed-out' ? runMessages.signedOut : ''); setViewOnly(mode === 'view'); if (mode === 'view') setFilter('approved'); setToken(mode === 'token' ? (() => { try { return sessionStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; } })() : 'site-session'); })
      .catch(() => { if (!alive) return; setError(runMessages.lostContact); timer = setTimeout(check, Math.min(10000, 1000 * 2 ** ++tries)); });
    void check();
    return () => { alive = false; clearTimeout(timer); };
  }, []);
  const api = useCallback(async (query = '', body?: object) => {
    const response = await reach('/api/live-fishbowl' + query, { method: body ? 'POST' : 'GET', headers: { ...(token && token !== 'site-session' ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), cache: 'no-store' });
    if (response.status === 401 && (token === 'site-session' || siteLoginEnded(response))) throw new Error(runMessages.signedOut);
    if (response.status === 401) { try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked */ } setToken(''); }
    return readAnswer(response);
  }, [token]);
  // The server filters and pages (store.ts listLoopPrecedents), and counts every state in full.
  // A page past the last (say the only draft on page 2 was just approved) moves back to the last page, which loads again.
  const load = useCallback(async () => { const data = await api(`?precedents=1&status=${filter}&page=${page}`); setCounts(data.counts); setPages(data.pages); if (page > data.pages) { setPage(data.pages); return; } setRows(data.precedents); setRules(data.rules); }, [api, filter, page]);
  useEffect(() => { if (token) load().then(() => setError('')).catch(e => setError(e.message)); }, [token, load]);
  const shown = rows ?? [];
  // The page says what happened: after an action the card may move to another tab.
  const [notice, setNotice] = useState('');
  const act = useCallback(async (id: string, review: object, done: string) => { setNotice(''); await api('', { action: 'precedent', id, review }); setNotice(done); await load(); }, [api, load]);
  return <main className="lab-precedents">
    <p><a href="/">Back to the lab</a></p>
    <h1>Past rulings from reviewers</h1>
    <p className="lab-precedents-lead">{pastRulingsNotPolicy}</p>
    <p className="lab-precedents-lead">{viewOnly ? forViewers('When a person decides a case differently from the Arbitrator, the system drafts a past ruling from that case, with no AI. No agent sees a draft. Once a person approves it, runs started after that can use it; runs already started keep the rulings they began with. A ruling is never shown for the case it came from, and it is never deleted: withdraw it if it turns out wrong.') : 'When a person decides a case differently from the Arbitrator, the system drafts a past ruling from that case, with no AI. No agent sees a draft. Once a person approves it, runs started after that can use it; runs already started keep the rulings they began with. A ruling is never shown for the case it came from, and it is never deleted: withdraw it if it turns out wrong.'}</p>
    {token === '' && <form className="live-login" onSubmit={e => { e.preventDefault(); try { sessionStorage.setItem(TOKEN_KEY, draftToken); } catch { /* storage blocked */ } setToken(draftToken); setDraftToken(''); }}><label>Operator token<input type="password" autoComplete="off" required minLength={32} value={draftToken} onChange={e => setDraftToken(e.target.value)} /></label><button>Connect</button></form>}
    {error && <p role="alert" className="lab-gate-error">{error}</p>}
    {notice && <p role="status" className="lab-gate-saved">{notice}</p>}
    {rows && <>
      <div className="lab-precedents-filter" role="group" aria-label="Show">{(viewOnly ? filters.filter(([k]) => k === 'approved') : filters).map(([k, label]) => <button key={k} type="button" aria-pressed={filter === k} onClick={() => { setFilter(k); setPage(1); }}>{label} ({counts[k] ?? 0})</button>)}</div>
      {!shown.length && <p className="lab-precedents-empty">{counts.all ? 'Nothing here.' : 'No past rulings yet. They appear when a person decides a case differently from the Arbitrator.'}</p>}
      {shown.map(row => <Card key={row.id + row.revision} row={row} rules={rules} act={act} viewOnly={viewOnly} />)}
      {pages > 1 && <nav className="lab-precedents-pages" aria-label="Pages"><button type="button" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Newer</button><span>Page {page} of {pages}</span><button type="button" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>Older</button></nav>}
    </>}
  </main>;
}

function Card({ row, rules, act, viewOnly }: { row: Row; rules: Rule[]; act: (id: string, review: object, done: string) => Promise<void>; viewOnly: boolean }) {
  const { card } = row, [owner, setOwner] = useState(''), [note, setNote] = useState(''), [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState('');
  // Approving or publishing puts the text on the Library page, so the person confirms it names no one (owner, 11 October 2026).
  const [privacyConfirmed, setPrivacyConfirmed] = useState(false), inLibrary = !!card.privacy_check;
  // Every action names the revision on screen; the server refuses it if the card changed meanwhile.
  const run = async (review: object, done: string) => { setBusy(true); setError(''); setSaved(''); try { await act(row.id, { ...review, revision: row.revision }, done); setSaved(done); setEditing(false); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const person = row.decision.final ?? { outcome: card.remedy.outcome, remedy: { medium: card.remedy.medium, amountCents: card.remedy.amount_cents } };
  const said = (o: { outcome: string; remedy: Remedy }, labels: Record<string, string>) => (labels[o.outcome] ?? outcomeWords(o.outcome)) + (remedyText(o.remedy) ? ', ' + remedyText(o.remedy) : '');
  const link = row.workspaceId ? `/?case=${row.workspaceId}&run=${row.runId}` : null;
  return <article className={'lab-precedent tone-' + row.status}>
    <header><h2>{card.title}</h2><span className="lab-precedent-status">{loopStatusWords[row.status] ?? row.status}{row.status === 'approved' ? (inLibrary ? ' · in the Library' : ' · not yet in the Library') : ''}</span></header>
    <p className="lab-precedent-source">From run {row.runId.slice(0, 8)}{row.caseId ? ` on case ${row.caseId}` : ''}, {day(row.createdAt)}. {link && <a href={link}>Open the case</a>}</p>
    <div className="lab-precedent-compare">
      <div><h3>The Arbitrator recommended</h3><p>{said(row.judge, { ...decisionLabels, human_review: 'no recommendation' })}</p></div>
      <div><h3>{row.decision.owner ?? 'A person'} decided</h3><p>{said(person, decisionLabels)}</p></div>
    </div>
    <h3>Why</h3><p className="lab-precedent-text">{card.reasoning}</p>
    {(row.decision.disagreedCriteria?.length ?? 0) > 0 && <><h3>Findings of the Arbitrator they disagreed with</h3><ul>{row.decision.disagreedCriteria!.map(c => <li key={c}>{criterionQuestion(c)}</li>)}</ul></>}
    <details><summary>What this ruling matches on</summary>
      <h4>Facts it is matched on</h4>{Object.keys(card.features).length ? <ul>{Object.entries(card.features).map(([k, v]) => <li key={k}>{k.replaceAll('_', ' ')}: {value(v)}</li>)}</ul> : <p>None. Without matched facts the Arbitrator may compare it but never has to weigh it.</p>}
      <h4>Figures from the record</h4>{card.material_facts.length ? <ul>{card.material_facts.map(f => <li key={f}>{f.replaceAll('_', ' ')}</li>)}</ul> : <p>None.</p>}
      <h4>Ryde rules</h4><p>{card.rule_ids.join(', ') || 'None'}</p>
      {card.distinguishing_facts.length > 0 && <><h4>What would change the answer</h4><ul>{card.distinguishing_facts.map(f => <li key={f}>{f}</li>)}</ul></>}
      <h4>Ryde rules release</h4><p>{card.policy_release}</p>
      <h4>Where it came from</h4><p>{card.provenance}</p>
      {(card.evaluation_overlap ?? []).length > 0 && <p>Never shown for case {card.evaluation_overlap!.join(', ')}.</p>}
    </details>
    {row.problems.length > 0 && <div className="lab-gate-error"><b>Cannot be approved yet.</b><ul>{row.problems.map(p => <li key={p}>{p}</li>)}</ul></div>}
    {/* A true conflict (the same deciding facts, a different outcome) is a warning; an overlap that needs a further fact is only a note (4 October). */}
    {(row.conflictDetails ?? []).some(d => !d.extra.length) && <p className="lab-precedent-warning"><b>Same deciding facts, different outcome:</b> {row.conflictDetails!.filter(d => !d.extra.length).map(d => d.id).join(', ')}. While both are approved, every case with these facts goes to a person. {viewOnly ? 'The team withdraws the one that is wrong.' : 'Withdraw the one that is wrong.'}</p>}
    {(row.conflictDetails ?? []).some(d => d.extra.length) && <div className="lab-precedent-source"><b>Could overlap, no action needed.</b> These approved rulings reach a different outcome, and no fact rules out a case matching both. Each needs an extra fact this ruling doesn&apos;t have:<ul>{row.conflictDetails!.filter(d => d.extra.length).map(d => <li key={d.id}>{d.id} also needs {joinWords(d.extra)}.</li>)}</ul>Only a case with this ruling&apos;s facts plus one of those would match both, and it would go to a person.</div>}
    {row.reviewedBy && !viewOnly && <p className="lab-precedent-source">Last change by {row.reviewedBy}{row.reviewNote ? `: ${row.reviewNote}` : '.'}</p>}
    {saved && <p role="status" className="lab-gate-saved">{saved}</p>}
    {error && <p role="alert" className="lab-gate-error">{error}</p>}
    {!viewOnly && (row.status === 'draft_pending_review' || row.status === 'approved') && <div className="lab-precedent-actions">
      <label>Your name<input value={owner} onChange={e => setOwner(e.target.value)} /></label>
      <label>Note{row.status === 'approved' ? ' (why it is withdrawn)' : ' (needed to reject)'}<textarea value={note} onChange={e => setNote(e.target.value)} /></label>
      {(row.status === 'draft_pending_review' || !inLibrary) && <label className="check-label"><input type="checkbox" checked={privacyConfirmed} onChange={e => setPrivacyConfirmed(e.target.checked)} /> The text names no person, car plate, address, phone number or email. Once approved it appears on the Library page.</label>}
      {row.status === 'draft_pending_review' ? <div className="workbench-actions">
        <button type="button" className="primary" disabled={busy || !owner.trim() || !privacyConfirmed || row.problems.length > 0} onClick={() => run({ action: 'approve', owner, note, privacyConfirmed }, 'Approved. Runs started from now on can use it, and it is on the Library page.')}>Approve</button>
        <button type="button" disabled={busy} aria-expanded={editing} onClick={() => setEditing(v => !v)}>{editing ? 'Close the editor' : 'Edit'}</button>
        <button type="button" disabled={busy || !owner.trim() || note.trim().length < 10} onClick={() => run({ action: 'reject', owner, note }, 'Rejected. It stays out of every run.')}>Reject</button>
      </div> : <div className="workbench-actions">{!inLibrary && <button type="button" className="primary" disabled={busy || !owner.trim() || !privacyConfirmed} onClick={() => run({ action: 'publish', owner, note, privacyConfirmed }, 'Published. It is on the Library page.')}>Publish to the Library</button>}<button type="button" disabled={busy || !owner.trim() || note.trim().length < 10} onClick={() => run({ action: 'overturn', owner, note }, 'Withdrawn. Runs started from now on no longer use it.')}>Withdraw</button></div>}
    </div>}
    {editing && !viewOnly && <Editor card={card} rules={rules} busy={busy} owner={owner} onSave={edit => run({ action: 'edit', owner, note, edit }, 'Changes saved. Approve it when it reads right.')} />}
  </article>;
}

// Words and rules can change; the facts it matches on and the figures can only be removed (they come from the record).
function Editor({ card, rules, busy, owner, onSave }: { card: Precedent; rules: Rule[]; busy: boolean; owner: string; onSave: (edit: object) => void }) {
  const [title, setTitle] = useState(card.title), [reasoning, setReasoning] = useState(card.reasoning), [issues, setIssues] = useState(card.issues.join('\n')), [distinct, setDistinct] = useState(card.distinguishing_facts.join('\n'));
  const [ruleIds, setRuleIds] = useState(card.rule_ids), [features, setFeatures] = useState(Object.keys(card.features)), [facts, setFacts] = useState(card.material_facts.map((_, i) => i));
  const lines = (t: string) => t.split('\n').map(l => l.trim()).filter(Boolean);
  const toggle = <T,>(list: T[], set: (v: T[]) => void, v: T) => set(list.includes(v) ? list.filter(x => x !== v) : [...list, v]);
  const relevant = rules.filter(r => r.categories.some(c => card.dispute_types.includes(c)) || ruleIds.includes(r.id) || card.rule_ids.includes(r.id));
  const [all, setAll] = useState(false);
  return <form className="lab-precedent-editor" onSubmit={e => { e.preventDefault(); onSave({ title, reasoning, issues: lines(issues), distinguishing_facts: lines(distinct), rule_ids: ruleIds, keepFeatures: features, keepFacts: facts }); }}>
    <label>Title<input value={title} onChange={e => setTitle(e.target.value)} /></label>
    <label>Reasoning<textarea value={reasoning} onChange={e => setReasoning(e.target.value)} /></label>
    <label>Questions it answers, one per line<textarea value={issues} onChange={e => setIssues(e.target.value)} /></label>
    <label>What would change the answer, one per line<textarea value={distinct} onChange={e => setDistinct(e.target.value)} /></label>
    <fieldset><legend>Ryde rules</legend>{(all ? rules : relevant).map(r => <label key={r.id} className="check-label"><input type="checkbox" checked={ruleIds.includes(r.id)} onChange={() => toggle(ruleIds, setRuleIds, r.id)} /> {r.id} · {r.title}</label>)}
      {card.rule_ids.filter(id => !rules.some(r => r.id === id)).map(id => <label key={id} className="check-label"><input type="checkbox" checked={ruleIds.includes(id)} onChange={() => toggle(ruleIds, setRuleIds, id)} /> {id} · not one of the Ryde rules</label>)}
      <button type="button" className="quiet" onClick={() => setAll(v => !v)}>{all ? 'Show Ryde rules for this dispute type' : 'Show every Ryde rule'}</button></fieldset>
    {Object.keys(card.features).length > 0 && <fieldset><legend>Facts it is matched on (untick to remove)</legend>{Object.entries(card.features).map(([k, v]) => <label key={k} className="check-label"><input type="checkbox" checked={features.includes(k)} onChange={() => toggle(features, setFeatures, k)} /> {k.replaceAll('_', ' ')}: {value(v)}</label>)}</fieldset>}
    {card.material_facts.length > 0 && <fieldset><legend>Figures from the record (untick to remove)</legend>{card.material_facts.map((f, i) => <label key={i} className="check-label"><input type="checkbox" checked={facts.includes(i)} onChange={() => toggle(facts, setFacts, i)} /> {f.replaceAll('_', ' ')}</label>)}</fieldset>}
    <div className="workbench-actions"><button type="submit" className="primary" disabled={busy || !owner.trim() || !ruleIds.length}>Save changes</button>{!owner.trim() && <span className="lab-precedent-source">Add your name above first.</span>}</div>
  </form>;
}
