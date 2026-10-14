'use client';
import '../zod-browser';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Strip from '../fishbowl/live/strip';
import { deskStates } from '../../../../packages/live-fishbowl/desk-state';
import { caseSummary, chatHold, finalDecision, heldForNewEvidence, latestHandoff, recordGate, releaseGate, screenGate } from '../../../../packages/live-fishbowl/gates';
import { responseTarget, targetView } from '../../../../packages/live-fishbowl/sla';
import { useNow } from './sla-line';
import { actorName } from '../../../../packages/live-fishbowl/plain';
import type { Cite } from '../fishbowl/live/workbench';
import TopBar from './top-bar';
import Columns from './columns';
import Evidence, { SourceTray, type EvidencePick } from './evidence';
import Chat, { type ChatJump } from './chat';
import Status from './status';
import { useLab } from './use-lab';
import { forViewers, runNotice } from './run-notice';
import { isRunMessage, runMessages } from '../../../../packages/live-fishbowl/messages';
import SafetyDialog from './safety-dialog';
import SummaryDialog from './summary-dialog';
import LibraryWindow from './library-window';
import CaseDialog from './case-dialog';
import RecordDialog from './record-dialog';
import RulesDialog from './rules-dialog';
import Tour, { markTourSeen, tourSeen } from './tour';
import './top-bar.css';
import { DEMO_CASE, demoRun, tourCase } from './walkthrough-case';
import '../fishbowl/live/live.css';
import './lab.css';
import './ryde.css';
import './gates.css';
import './responsive.css';
import './checks.css';

// The one-page lab: top bar with the case picker, the agents in a row, then evidence, chat and status side by side.
export default function Lab() {
  const lab = useLab();
  const { workspace, events, status, running, run, error, setError, pollError } = lab;
  const [jump, setJump] = useState<ChatJump | null>(null), [actor, setActor] = useState('all'), [cite, setCite] = useState<Cite | null>(null), [draftToken, setDraftToken] = useState('');
  const states = useMemo(() => deskStates(events, status), [events, status]);
  // The checks either side of the agents (gates.ts): one source for the gate cards, the progress list and the summary.
  // While a chosen run's events load, both gates say so: "No run yet" or a preview would be wrong for a case that has a run.
  const loadingRun = lab.runLoading;
  // The public copy says the team's steps as the team's (run-notice.ts forViewers): its visitors cannot resume or start a run.
  const say = useCallback((text: string) => lab.viewOnly ? forViewers(text) : text, [lab.viewOnly]);
  const notice = useMemo(() => { const n = runNotice({ run, events, status, missing: lab.runMissing }); return n && say(n); }, [run, events, status, lab.runMissing, say]);
  const screen = useMemo(() => loadingRun ? { ...screenGate([], true), tone: 'waiting' as const, word: 'Loading', note: 'Loading the run' } : screenGate(events, !!run, workspace?.triage), [loadingRun, events, run, workspace?.triage]);
  const record = useMemo(() => loadingRun ? { ...recordGate([], false), tone: 'waiting' as const, word: 'Loading', note: 'Loading the run' } : recordGate(events, !!run), [loadingRun, events, run]);
  const release = useMemo(() => loadingRun ? { ...releaseGate([], 'running'), word: 'Loading', note: 'Loading the run' } : releaseGate(events, status), [loadingRun, events, status]);
  const summary = useMemo(() => caseSummary(events, status, run?.packet?.photos?.length ?? 0), [events, status, run?.packet?.photos?.length]);
  const decision = useMemo(() => events.find(e => e.kind === 'decision_proposed')?.data, [events]), latest = useMemo(() => latestHandoff(events), [events]);
  // The chat reading's hold (MVP fixes, 10 October 2026): the safety dialog shows its quoted lines above the handoff controls.
  const hold = useMemo(() => chatHold(events), [events]), held = !!hold && !hold.going && !decision;
  // A person's final decision (learning loop) and the run's own rules, the only ones that person may add.
  const final = useMemo(() => finalDecision(events), [events]), rules = useMemo(() => (run?.packet?.policies ?? []).map(p => ({ id: p.rule_id, title: String(p.title ?? '') })), [run?.packet?.policies]);
  // The response-time target (sla.ts): on the gate that holds the case (the screen for a safety flag, the release check for
  // a routed decision), in the summary and in the safety dialog. Its wording counts down, so it refreshes while it waits.
  const target = useMemo(() => loadingRun ? null : responseTarget(events, status), [loadingRun, events, status]);
  const now = useNow(target && !target.pickedUp ? 30000 : 0), sla = useMemo(() => target && targetView(target, now), [target, now]);
  // The Evidence tab picked by hand, kept here so hiding and restoring the column keeps it (evidence.tsx).
  const [evidencePick, setEvidencePick] = useState<EvidencePick>(null);
  // Another case clears it, so coming back to a case opens on its own best tab again.
  useEffect(() => { setEvidencePick(p => p && p.id === workspace?.id ? p : null); }, [workspace?.id]);
  const [dialog, setDialog] = useState<'none' | 'summary' | 'safety' | 'record' | 'case' | 'rules'>('none'), [toNotices, setToNotices] = useState(false), opener = useRef<HTMLElement | null>(null);
  const openDialog = useCallback((which: 'summary' | 'safety' | 'record' | 'case' | 'rules', notices = false) => { opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setToNotices(notices); setDialog(which); }, []);
  const closeDialog = useCallback(() => setDialog('none'), []);
  const gates = useMemo(() => {
    const held = <G extends object>(gate: G, from: string) => sla && target?.from === from ? { ...gate, target: sla } : gate;
    const told = <G extends { note: string }>(gate: G) => ({ ...gate, note: say(gate.note) });
    return { screen: told(held(screen, 'safety_flag')), record: told(record), release: told(held(release, 'routed')), onScreen: () => openDialog('safety'), onRecord: () => openDialog('record'), onRelease: () => openDialog('summary') };
  }, [screen, record, release, sla, target?.from, openDialog, say]);
  // The walkthrough (tour.tsx): the step-by-step tour with its hand-drawn marks, revived 11 October 2026 (owner) in place of
  // the explainer video, which became the demo film. The summary's auto-open waits for the walkthrough's first-visit decision and for the
  // walkthrough to close: both open by themselves, and an effect cannot see an opening the other scheduled in the same
  // commit, so the summary checks these states rather than the page.
  const [touring, setTouring] = useState(false), [tourDecided, setTourDecided] = useState(false);
  // Switching case or run closes any open check dialog. Declared before the auto-open below, which runs after it.
  useEffect(() => { setDialog('none'); }, [workspace?.id, run?.id]);
  // The summary opens by itself once per run in each browser, the first time the run has something to summarise and
  // nothing else is open (another dialog, the source tray). A summary that could not open yet waits.
  // It counts as shown only once it opens; `shown` also covers blocked storage.
  const summaryRun = summary && run?.id, shown = useRef(new Set<string>()), [overlayClosed, setOverlayClosed] = useState(0);
  // A summary opened by hand that fills in while open (the decision lands) has been shown: closing it must not reopen it.
  useEffect(() => { if (dialog === 'summary' && summaryRun && !shown.current.has(summaryRun)) { shown.current.add(summaryRun); markSummarySeen(summaryRun); } }, [dialog, summaryRun]);
  // Dialogs this page does not track (the chat's full response) close by leaving the page, which fires
  // no event here: while one holds back a waiting summary, look twice a second for it to go.
  useEffect(() => {
    if (!summaryRun || dialog !== 'none' || shown.current.has(summaryRun) || !document.querySelector('dialog[open]')) return;
    const id = setInterval(() => { if (!document.querySelector('dialog[open]')) setOverlayClosed(n => n + 1); }, 500);
    return () => clearInterval(id);
  }, [summaryRun, dialog, overlayClosed]);
  useEffect(() => {
    if (!summaryRun || !workspace || cite || !tourDecided || touring || lab.replaying || dialog !== 'none' || document.querySelector('dialog[open]')) return;
    if (shown.current.has(summaryRun) || seenSummary(summaryRun)) return;
    shown.current.add(summaryRun); markSummarySeen(summaryRun); openDialog('summary');
  }, [summaryRun, workspace, cite, tourDecided, touring, lab.replaying, dialog, overlayClosed, openDialog]);
  // Phones and tablets show one pane at a time (columns.tsx). Each case or run opens on the pane that matters: Evidence
  // before any run, the conversation while one runs, Status once it has stopped. After that only the reader changes it,
  // so a decision landing mid-read does not swap the pane. Anything that points into the conversation shows it. A run the
  // chat reading holds waits for a person, so it opens on Status, where the hold is explained.
  const [tab, setTab] = useState('chat'), opened = useRef('');
  useEffect(() => {
    if (!workspace || loadingRun) return;
    const key = workspace.id + ':' + (run?.id ?? '');
    if (opened.current === key) return;
    opened.current = key; setTab(!run ? 'evidence' : running && !held ? 'chat' : 'status');
  }, [workspace, run, loadingRun, running, held]);
  // Play back (public copy, owner 11 October 2026) is watched in the conversation: starting one shows it, with every agent.
  useEffect(() => { if (lab.replaying) { setActor('all'); setTab('chat'); } }, [lab.replaying]);
  // The walkthrough points at a case's parts, so with no case open or loading it first opens one: the demo case DISP-004 (Amirah's, the film's), else the first case in the dropdown (tourCase, user, 7 October).
  const needsLogin = lab.ready && (lab.needsToken || !lab.token);
  const tourOpener = useRef<HTMLElement | null>(null);
  const { workspaceLoading, cases, selectCase, openRun, runId: openRunId } = lab;
  // The case the walkthrough opened, and every case it tried: a case deleted since the list loaded fails to open, and
  // then the next choice is tried (up to three). Once the demo case loads, it moves to the newest finished run of any
  // copy; if that copy then fails to load, it goes back to the copy that loaded. Closing the
  // walkthrough forgets it, so a case opened by hand afterwards is never retried or moved.
  const tourPick = useRef<{ id: string; tried: Set<string>; back?: { id: string; run: string } } | null>(null);
  // Landing (owner, 11 October 2026): with no case in the address, the page opens the starred case, Amirah's, once per load; the
  // Ryde Resolve name links to this same landing, so it too arrives on that case. It picks the way the walkthrough does (the same
  // pick record: the newest finished run of any copy, a deleted case retried), so the first-visit walkthrough finds the case
  // already opening and picks nothing of its own. A case named in the address is left alone, even after it is deleted; a list
  // that failed to load or came back empty is not counted as landed, so the next successful load still lands.
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current) return;
    if (new URLSearchParams(window.location.search).has('case')) { landed.current = true; return; }
    if (!lab.ready || needsLogin || lab.catalogLoading || lab.catalogFailed || workspace || workspaceLoading || tourPick.current) return;
    const first = tourCase(cases); if (!first) return;
    landed.current = true; tourPick.current = { id: first.id, tried: new Set([first.id]) }; selectCase(first.id, first.run_id);
  }, [lab.ready, needsLogin, lab.catalogLoading, lab.catalogFailed, workspace, workspaceLoading, cases, selectCase]);
  // The walkthrough lights the evidence pane, so a pane dismissed earlier comes back when it starts.
  const [revealPanes, setRevealPanes] = useState(0);
  const startTour = useCallback(() => {
    setRevealPanes(n => n + 1);
    tourOpener.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : document.querySelector<HTMLElement>('.lab-tour-button');
    if (!workspace && !workspaceLoading && !tourPick.current) { const c = tourCase(cases); if (c) { tourPick.current = { id: c.id, tried: new Set([c.id]) }; selectCase(c.id, c.run_id); } }
    setTouring(true);
  }, [workspace, workspaceLoading, cases, selectCase]);
  useEffect(() => {
    const pick = tourPick.current; if (!pick) return;
    if (workspace?.id === pick.id) {
      const best = workspace.caseId === DEMO_CASE && !pick.back ? demoRun(workspace.groupRuns ?? workspace.runs.map(r => ({ ...r, workspace_id: workspace.id }))) : null;
      // Moving to another copy keeps the pick until that copy loads, with the way back.
      if (best && best.workspace_id !== workspace.id) { pick.back = { id: workspace.id, run: openRunId }; pick.id = best.workspace_id; pick.tried.add(best.workspace_id); openRun(best.workspace_id, best.id); return; }
      tourPick.current = null;
      if (best && best.id !== openRunId) openRun(best.workspace_id, best.id);
      return;
    }
    if (workspace || workspaceLoading || !error) return;
    if (pick.back) { const back = pick.back; tourPick.current = null; setError(''); selectCase(back.id, back.run); return; }
    const next = pick.tried.size < 3 ? tourCase(cases.filter(r => !pick.tried.has(r.id))) : null;
    if (!next) { tourPick.current = null; return; }
    pick.tried.add(next.id); pick.id = next.id; setError(''); selectCase(next.id, next.run_id);
  }, [workspace, workspaceLoading, error, cases, selectCase, openRun, openRunId, setError]);
  // A first visit opens it once per browser, once the page can show cases and nothing else is open. Marked as seen on
  // opening, so leaving halfway does not bring it back; the Walkthrough button replays it.
  // A dialog this page does not track (the chat's full response) holds the decision back, and the summary waits on the
  // decision, so look twice a second for that dialog to close.
  const [tourRetry, setTourRetry] = useState(0);
  useEffect(() => {
    if (tourDecided || !lab.ready || needsLogin || lab.catalogLoading || dialog !== 'none') return;
    if (document.querySelector('dialog[open]')) { const id = setInterval(() => { if (!document.querySelector('dialog[open]')) setTourRetry(n => n + 1); }, 500); return () => clearInterval(id); }
    setTourDecided(true);
    if (tourSeen()) return;
    markTourSeen(); startTour();
  }, [tourDecided, lab.ready, needsLogin, lab.catalogLoading, dialog, startTour, tourRetry]);
  // The decision bubble is drawn once the conversation pane shows, so it is found two frames later.
  const showDecision = useCallback(() => { setActor('all'); setTab('chat'); requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector('.lab-bubble.decision')?.scrollIntoView({ block: 'start' }))); }, []);
  const readDecision = useCallback(() => { setDialog('none'); showDecision(); }, [showDecision]);
  // A flagged line opened from the safety dialog closes the dialog; closing the source then returns focus to the safety gate.
  const trayReturn = useRef<HTMLElement | null>(null);
  const citeFromDialog = useCallback((c: Cite) => { trayReturn.current = document.querySelector<HTMLElement>('.lab .gate-screen') ?? opener.current; setDialog('none'); setCite(c); }, []);
  // The tray shows the run's pinned sources. A document uploaded after the run started is not one of them (a flagged line
  // from a mid-run safety upload points at it), so the tray falls back to the case's own copy and downloads that text.
  const pinned = run?.packet ?? workspace?.packet;
  const lateSource = !!cite && !!workspace && !pinned?.sources.some(s => s.id === cite.sourceId) && workspace.packet.sources.some(s => s.id === cite.sourceId);
  const trayPacket = lateSource ? workspace!.packet : pinned;
  const downloadSource = useCallback((id: string) => {
    const own = !run?.packet?.sources.some(s => s.id === id) && workspace?.packet.sources.find(s => s.id === id);
    if (!own) return lab.downloadSource(id);
    const url = URL.createObjectURL(new Blob([own.text], { type: 'text/plain' })), a = document.createElement('a');
    a.href = url; a.download = id.split('/').at(-1)!; a.click(); URL.revokeObjectURL(url);
  }, [run?.packet, workspace?.packet, lab.downloadSource]);
  const selectDesk = useCallback((role: string) => { setActor(a => a === role ? 'all' : role); setTab('chat'); }, []);
  const openSource = useCallback((c: Cite) => { trayReturn.current = null; setCite(c); }, []);
  const closeTray = useCallback(() => { setCite(null); const back = trayReturn.current; trayReturn.current = null; if (back?.isConnected) requestAnimationFrame(() => back.focus({ preventScroll: true })); }, []);
  // Escape peels one layer. Open dialogs and the case menu take it first (they handle it before it reaches
  // window); then the source tray closes; then the agent filter returns to the whole conversation.
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open]')) return; if (cite) closeTray(); else if (actor !== 'all') setActor('all'); else return; e.preventDefault(); };
    addEventListener('keydown', key); return () => removeEventListener('keydown', key);
  }, [cite, actor, closeTray]);
  const fixture = events.some(e => e.kind === 'test_fixture');
  return <main className="live-app lab">
    <TopBar cases={lab.cases} selected={workspace?.id ?? ''} loading={lab.catalogLoading || !lab.ready} busy={lab.busy} summaryReady={!!summary} viewOnly={lab.viewOnly} onSummary={() => openDialog('summary')} onTour={startTour} onSelect={(id, latestRun) => { setCite(null); setActor('all'); lab.selectCase(id, latestRun); }} onDelete={lab.deleteCase} onStar={(id, starred) => { void lab.starCase(id, starred); }} onOpen={() => { lab.refreshCatalog().catch(() => {}); }} />
    {touring && <Tour opener={tourOpener} onPane={setTab} onClose={() => { tourPick.current = null; setTouring(false); }} />}
    <div className="lab-notices">
      {needsLogin && <form className="live-login" onSubmit={e => { e.preventDefault(); lab.connect(draftToken); setDraftToken(''); }}><label>Operator token<input type="password" autoComplete="off" required minLength={32} value={draftToken} onChange={e => setDraftToken(e.target.value)} /></label><button>Connect</button></form>}
      {error && !(lab.signedOut && error === runMessages.signedOut) && <div role="alert" className="live-error">{error} <button type="button" className="quiet" onClick={() => setError('')}>Dismiss</button></div>}
      {lab.signedOut && <div role="alert" className="live-error">{runMessages.signedOut}</div>}
      {pollError && <div role="status" className="live-error">{isRunMessage(pollError) ? pollError : 'Live updates paused: ' + pollError}</div>}
      {fixture && <div className="live-test-note">Recorded test · no AI calls</div>}
    </div>
    {workspace ? <>
      <Strip states={states} selected={actor} onSelect={selectDesk} gates={gates} />
      <Columns tab={tab} onTab={setTab} revealAll={revealPanes}
        overlay={<SourceTray packet={trayPacket} cite={cite} onClose={closeTray} onDownload={downloadSource} />}
        columns={[
          { key: 'evidence', title: 'Evidence', body: <Evidence lab={lab} openSource={openSource} picked={evidencePick} onPick={setEvidencePick} /> },
          { key: 'chat', title: actor === 'all' ? 'Conversation' : 'Conversation · ' + actorName(actor), body: <Chat events={events} actor={actor} running={running} hasRun={!!run} loading={loadingRun} notice={notice} openSource={openSource} jump={jump} packet={run?.packet} tone={release.tone} checks={run?.checks} viewOnly={lab.viewOnly} /> },
          { key: 'status', title: 'Status', body: <Status lab={lab} gates={gates} onReadDecision={showDecision} onRules={() => openDialog('rules')} onNotices={() => openDialog('summary', true)} onCaseDetails={() => openDialog('case')} onSafety={() => openDialog('safety')} openSource={openSource} onJump={(key, label) => { if (key === 'screen' || key === 'record') return openDialog(key === 'screen' ? 'safety' : 'record'); setActor('all'); setTab('chat'); setJump(j => ({ key, label, n: (j?.n ?? 0) + 1 })); }} /> },
        ]} />
      {dialog === 'safety' && <SafetyDialog screen={screen} sla={target?.from === 'safety_flag' ? sla : null} latest={latest} hold={hold} blocked={heldForNewEvidence(events)} opener={opener} busy={lab.busy} error={error} action={lab.action} workspaceId={workspace.id} runId={run?.id ?? ''} viewOnly={lab.viewOnly} onClose={closeDialog} openSource={citeFromDialog} />}
      {dialog === 'summary' && <SummaryDialog title={workspace.title} summary={summary} sla={sla} release={release} decision={decision} packet={run?.packet} scored={!!run?.scored} toNotices={toNotices} latest={latest} final={final} rules={rules} events={events} checks={run?.checks ?? null} busy={lab.busy} error={error} action={lab.action} runId={run?.id ?? ''} viewOnly={lab.viewOnly} opener={opener} onClose={closeDialog} onReadDecision={readDecision} onSafety={() => setDialog('safety')} />}
      {dialog === 'case' && <CaseDialog lab={lab} opener={opener} onClose={closeDialog} />}
      {dialog === 'rules' && <RulesDialog packet={run?.packet ?? workspace.packet} cited={Array.isArray(decision?.policyIds) ? decision.policyIds.filter((id: unknown): id is string => typeof id === 'string') : []} opener={opener} onClose={closeDialog} />}
      {dialog === 'record' && <RecordDialog gate={record} opener={opener} runId={run?.id ?? ''} onClose={closeDialog} />}
    </> : lab.workspaceLoading ? <div className="live-skeleton" aria-busy="true" /> : !needsLogin && lab.ready && !lab.catalogLoading && <div className="lab-welcome">{lab.catalogFailed && !lab.cases.length ? <h1>{runMessages.recordsDown}</h1> : <h1>{lab.cases.length ? 'Pick a case to begin' : 'No cases yet'}</h1>}{!(lab.catalogFailed && !lab.cases.length) && <><p>{lab.cases.length ? 'Choose one from the case picker.' : 'Cases are added by the team; none is listed yet.'}</p></>}</div>}
    <LibraryWindow />
  </main>;
}

// Which runs' summaries this browser has shown. Storage can be blocked or empty; the summary then just shows again.
const SEEN_KEY = 'lab-summary-seen';
function seenSummary(runId: string) { try { return (JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as string[]).includes(runId); } catch { return false; } }
function markSummarySeen(runId: string) { try { const seen = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]'); localStorage.setItem(SEEN_KEY, JSON.stringify([...(Array.isArray(seen) ? seen : []).filter((id: unknown) => id !== runId).slice(-199), runId])); } catch { /* storage blocked */ } }
