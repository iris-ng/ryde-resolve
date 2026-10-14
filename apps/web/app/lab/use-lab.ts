'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CasePacket } from '../../../../packages/agent-flow/contracts';
import type { TimelineEntry } from '../../../../packages/live-fishbowl/evidence';
import type { Triage } from '../../../../packages/live-fishbowl/triage';
import type { QueueEvent } from '../../../../packages/live-fishbowl/sla';
import type { EvidenceChecksView } from '../../../../packages/live-fishbowl/checks-view';
import { coalesce } from './coalesce';
import { isRunMessage, runMessages } from '../../../../packages/live-fishbowl/messages';
import { connectionMode, isCatalogAnswer, isFileAnswer, isRunAnswer, isTailAnswer, isWorkspaceAnswer, reach, readAnswer, siteLoginEnded } from './answer';

export type Event = { seq: number; at: string; actor: string; phase: string; kind: string; message: string; sources?: string[]; data?: any; hash: string; previousHash: string };
// The saved street map comes beside the case file (route.ts, 12 October 2026), so the file the audit log saves stays as sealed;
// the page joins the two in memory, where the map cards read it (evidence-checks.tsx savedRouteMap).
type MapNote = { routeMap?: { map: unknown; savedAt: string } | null };
const withMap = <T extends MapNote & { packet: CasePacket }>(value: T): T => value.routeMap ? { ...value, packet: { ...value.packet, routeMap: value.routeMap } } : value;
export type Workspace = MapNote & { packet: CasePacket; timeline: TimelineEntry[]; triage: Triage; id: string; caseId: string; title: string; posture?: any; detection?: { category: string; label: string; documents: number; matches: { sourceId: string; line: number; term: string }[] } | null; baseDocuments: { id: string; filename: string; size: number; sha256: string }[]; documents: { id: string; filename: string; size: number; sha256: string }[]; runs: { id: string; status: string; created_at: string }[]; groupRuns?: GroupRun[]; outsideLookups?: boolean };
/** A run of any copy of the open case (store.ts groupRuns), with the workspace it ran in. Older servers omit the list. */
export type GroupRun = { id: string; status: string; created_at: string; workspace_id: string };
/** `held`, `age_seconds`, `lease_expired_seconds`: whether a server holds the run, on the database's clock (store.ts runQuery); older servers omit them. */
/** `checks`: the route, promo and fare checks and the advocates' own-side lists for this run (checks-view.ts); null or absent on older runs and servers.
 * `outsideLookups` (on a run and on the workspace, for the next run): the Evidence Collector looks outside data up itself (records.ts canLookUpOutside). */
export type Run = { id: string; status: string; requested: string; error?: string; packet: CasePacket; held?: boolean; age_seconds?: number; lease_expired_seconds?: number | null; checks?: EvidenceChecksView | null; outsideLookups?: boolean; scored?: boolean } & MapNote;
/** `queue_events`: the latest run's decision and handoff events, trimmed for the response-time target (sla.ts); older servers omit it. */
export type CaseRow = { id: string; case_id: string; title: string; status: string | null; created_at: string; run_id: string | null; run_created_at?: string | null; run_finished_at?: string | null; runs?: number; posture?: unknown; documents?: number; category?: string | null; queue_events?: QueueEvent[]; starred_at?: string | null };

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export const validId = (value: string | null | undefined) => value && UUID.test(value) ? value : '';
export const isActive = (status: string) => ['queued', 'running', 'pausing', 'paused', 'stopping'].includes(status);
const TOKEN_KEY = 'live-fishbowl-token';
const staleSession = 'That answer belonged to an earlier session.';
/** How long Play back takes for a whole run, in milliseconds. */
export const replayMs = 60000;
export { readAnswer } from './answer';

// The lab's whole data layer: operator session, the case catalog, the selected case, and the
// selected run's event stream. Components render what this returns and call its actions.
//
// Run polling: a full load first (with backoff on failure), then tail fetches while the run is
// active. Every event carries its own hash and the previous event's hash. A tail must continue the
// retained chain (next seq, matching previousHash); any gap, a disclosure that adds derived
// sources, or the end of the run triggers one more full load so the packet and saved artifacts
// are current. Every response is dropped if the run or the loop generation changed while it was
// in flight, so switching case or run never shows the previous selection's data.
export function useLab() {
  const [token, setToken] = useState(''), [ready, setReady] = useState(false), [needsToken, setNeedsToken] = useState(false);
  const [cases, setCases] = useState<CaseRow[]>([]), [catalogLoading, setCatalogLoading] = useState(true);
  const [workspace, setWorkspace] = useState<Workspace | null>(null), [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [runId, setRunId] = useState(''), [run, setRun] = useState<Run | null>(null), [events, setEvents] = useState<Event[]>([]), [timeline, setTimeline] = useState<TimelineEntry[] | null>(null);
  const [error, setError] = useState(''), [pollError, setPollError] = useState(''), [busy, setBusy] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  // A visitor whose site sign-in ended; the case list that could not be loaded; a run that does not exist (owner review, 8 October 2026).
  const [signedOut, setSignedOut] = useState(false), [catalogFailed, setCatalogFailed] = useState(false), [runMissing, setRunMissing] = useState(false);
  // The public copy of the site (owner, 11 October 2026): it reads everything and changes nothing, and Play shows a run again.
  const [viewOnly, setViewOnly] = useState(false);
  const workspaceRef = useRef(''), runIdRef = useRef(''), lastSeq = useRef(0), lastHash = useRef(''), statusRef = useRef('not started'), gen = useRef(0);

  // The session in force, changed at once (before the next render) on every switch of token, with a generation that
  // counts the switches: a response to a request sent in an earlier session must neither fill the page nor sign out the
  // newer session.
  const session = useRef({ token: '', gen: 0 });
  const switchSession = useCallback((next: string) => { session.current = { token: next, gen: session.current.gen + 1 }; setToken(next); }, []);

  // Session: a site session (set by the reverse proxy) needs no token; otherwise the saved operator token.
  useEffect(() => {
    let alive = true;
    const query = new URLSearchParams(window.location.search);
    workspaceRef.current = validId(query.get('case'));
    setRunId(validId(query.get('run')));
    // The first check decides between the site's own sign-in and the operator token. If the site cannot be reached yet (a
    // restart), it tries again instead of asking a visitor for a token they never had.
    let timer: ReturnType<typeof setTimeout> | undefined, tries = 0;
    const check = () => connectionMode()
      .then(mode => { if (!alive) return; setError(''); if (mode === 'signed-out') setSignedOut(true); setViewOnly(mode === 'view'); switchSession(mode === 'token' ? sessionStorage.getItem(TOKEN_KEY) ?? '' : 'site-session'); setReady(true); })
      .catch(() => { if (!alive) return; setError(runMessages.lostContact); timer = setTimeout(check, Math.min(10000, 1000 * 2 ** ++tries)); });
    void check();
    return () => { alive = false; clearTimeout(timer); };
  }, [switchSession]);
  const connect = useCallback((value: string) => { sessionStorage.setItem(TOKEN_KEY, value); switchSession(value); setNeedsToken(false); setError(''); }, [switchSession]);

  const api = useCallback(async (query = '', body?: object) => {
    const sent = session.current.gen;
    const response = await reach('/api/live-fishbowl' + query, { method: body ? 'POST' : 'GET', headers: { ...(token && token !== 'site-session' ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), cache: 'no-store' });
    if (response.status === 401) {
      // Sent in an earlier session, even one with the same token (signed out, then the same token entered again): the
      // rejection is about that session, not the current one, so it must not sign the current one out.
      if (token !== session.current.token || sent !== session.current.gen) throw new Error(staleSession);
      // A visitor signed in to the site: their sign-in ended. Only the operator, who uses a token, is asked for one.
      if (token === 'site-session' || siteLoginEnded(response)) { setSignedOut(true); throw new Error(runMessages.signedOut); }
      sessionStorage.removeItem(TOKEN_KEY); switchSession('');
      setNeedsToken(true); throw new Error(token ? 'The saved operator token was rejected. Enter it again.' : 'Enter the operator token to open cases.');
    }
    return readAnswer(response);
  }, [token, switchSession]);

  const syncUrl = useCallback((caseId: string, run: string) => {
    const url = new URL(window.location.href);
    if (caseId) url.searchParams.set('case', caseId); else url.searchParams.delete('case');
    if (run) url.searchParams.set('run', run); else url.searchParams.delete('run');
    window.history.replaceState(null, '', url);
  }, []);

  // Every reload of the list goes through one queue (coalesce.ts): triggers that land together (an action's own reload,
  // the trail then gaining that handoff, a status change, opening the picker) make at most two requests, the last of
  // which begins after the last trigger, so the list ends on the final state. Requests never overlap, so none can land
  // after a newer one. A request belongs to the session it began in: one that began just before a switch (this render's
  // token already replaced) is skipped, the new session's own load follows; a list that comes back after a switch is
  // dropped, so a failure in the new session can never leave the old session's cases on screen.
  const loadCatalog = useRef(async () => {});
  loadCatalog.current = async () => {
    const { gen, token: current } = session.current;
    if (current !== token) return;
    const data = await api('?catalog=1');
    if (!isCatalogAnswer(data)) throw new Error(runMessages.lostContact);
    if (gen !== session.current.gen) return;
    setCases(data.workspaces);
  };
  const catalogQueue = useRef<(() => Promise<void>) | null>(null);
  const refreshCatalog = useCallback(() => (catalogQueue.current ??= coalesce(() => loadCatalog.current()))(), []);
  // A new session (the operator token) loads the list again.
  // A list that could not be loaded (the records down, a restart) is asked for again every 10 seconds until it comes.
  const [catalogRetry, setCatalogRetry] = useState(0);
  useEffect(() => {
    if (!ready) return;
    let alive = true, timer: ReturnType<typeof setTimeout> | undefined; setCatalogLoading(true);
    refreshCatalog().then(() => { if (alive) { setError(''); setCatalogFailed(false); } })
      .catch(e => { if (!alive) return; setError(e.message); setCatalogFailed(true); if ((e as Error).message !== runMessages.signedOut) timer = setTimeout(() => setCatalogRetry(n => n + 1), 10000); })
      .finally(() => { if (alive) setCatalogLoading(false); });
    return () => { alive = false; clearTimeout(timer); };
  }, [refreshCatalog, ready, api, catalogRetry]);
  // The picker shows each case's latest run status; when the open run changes status, reload the list so its dot follows.
  const seenStatus = useRef('');
  useEffect(() => {
    if (!run) return;
    const [id, before] = seenStatus.current.split(' ');
    seenStatus.current = run.id + ' ' + run.status;
    if (id === run.id && before !== run.status) refreshCatalog().catch(() => {});
  }, [run, refreshCatalog]);
  // The picker also shows each case's place in the queue (sla.ts), which a handoff moves without changing the run's
  // status: when the open run's trail gains a handoff event (here or from another operator), reload the list too.
  // The picker reloads it on opening as well; nothing polls the catalog on a timer.
  const handoffs = events.filter(e => e.kind === 'review_requested' || e.kind === 'review_updated').length, seenHandoffs = useRef({ run: '', count: 0 });
  useEffect(() => {
    if (!run) return;
    const before = seenHandoffs.current; seenHandoffs.current = { run: run.id, count: handoffs };
    if (before.run === run.id && handoffs > before.count) refreshCatalog().catch(() => {});
  }, [run, handoffs, refreshCatalog]);

  const refreshWorkspace = useCallback(async () => { if (workspaceRef.current) { const value = await api('?workspace=' + workspaceRef.current); if (!isWorkspaceAnswer(value)) throw new Error(runMessages.lostContact); if (value.id === workspaceRef.current) setWorkspace(withMap(value)); } }, [api]);
  const [workspaceTick, setWorkspaceTick] = useState(0);
  useEffect(() => {
    if (!ready || !token) return;
    const id = workspaceRef.current; if (!id) { setWorkspace(null); return; }
    let cancelled = false; setWorkspaceLoading(true);
    (async () => {
      try {
        const value = await api('?workspace=' + id);
        if (!isWorkspaceAnswer(value)) throw new Error(runMessages.lostContact);
        if (cancelled || workspaceRef.current !== id) return;
        setWorkspace(withMap(value)); setRunId(r => r || value.runs[0]?.id || ''); setError('');
      } catch (e) { if (!cancelled) setError((e as Error).message); }
      finally { if (!cancelled) setWorkspaceLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [api, ready, token, workspaceTick]);
  useEffect(() => { if (ready) syncUrl(workspaceRef.current, runId); }, [ready, runId, workspaceTick, syncUrl]);

  useEffect(() => {
    setRunMissing(false);
    if (!token || !runId || !workspaceRef.current) { setRun(null); setEvents([]); setTimeline(null); lastSeq.current = 0; lastHash.current = ''; statusRef.current = 'not started'; return; }
    const mine = ++gen.current, wsId = workspaceRef.current; let cancelled = false, timer: ReturnType<typeof setTimeout> | undefined, loaded = false, failures = 0;
    const live = () => !cancelled && mine === gen.current;
    const schedule = (ms: number) => { if (live()) timer = setTimeout(loop, ms); };
    async function loop() {
      if (!live()) return;
      try {
        if (!loaded) {
          const value = await api('?run=' + runId + '&workspace=' + wsId);
          if (!isRunAnswer(value)) throw new Error(runMessages.lostContact);
          if (!live()) return;
          setRun(withMap(value.run)); setEvents(value.events); setTimeline(value.timeline); lastSeq.current = value.events.at(-1)?.seq ?? 0; lastHash.current = value.events.at(-1)?.hash ?? ''; statusRef.current = value.run.status; loaded = true;
        } else {
          const tail = await api('?run=' + runId + '&workspace=' + wsId + '&since=' + lastSeq.current);
          if (!isTailAnswer(tail)) throw new Error(runMessages.lostContact);
          if (!live()) return;
          const first = tail.events[0];
          if (first && (first.seq !== lastSeq.current + 1 || (lastHash.current && first.previousHash !== lastHash.current))) { loaded = false; schedule(0); return; }
          if (tail.events.length) { lastSeq.current = tail.events.at(-1).seq; lastHash.current = tail.events.at(-1).hash; setEvents(prev => [...prev, ...tail.events]); }
          const ended = !isActive(tail.run.status), disclosed = tail.events.some((e: Event) => e.kind === 'disclosed' && ['collect', 'apply'].includes(e.phase));
          statusRef.current = tail.run.status;
          const { status, requested, error, held, age_seconds, lease_expired_seconds } = tail.run;
          setRun(prev => prev && (prev.status !== status || prev.requested !== requested || prev.error !== error || prev.held !== held || prev.age_seconds !== age_seconds || prev.lease_expired_seconds !== lease_expired_seconds) ? { ...prev, status, requested, error, held, age_seconds, lease_expired_seconds } : prev);
          if (ended || disclosed) { loaded = false; if (ended) { setPollError(''); return schedule(0); } }
        }
        failures = 0; setPollError('');
        if (!isActive(statusRef.current)) return;
        schedule(2000);
      } catch (e) {
        if (!live()) return;
        // A run that does not exist never will: say so once, and stop asking (owner review, 8 October 2026).
        if ((e as Error).message === 'Run not found') { setRunMissing(true); setPollError(''); return; }
        // A visitor who was signed out sees that instead; asking again would only repeat it.
        if ((e as Error).message === runMessages.signedOut) { setPollError(''); return; }
        failures++; setPollError((e as Error).message); schedule(Math.min(10000, 1000 * 2 ** failures));
      }
    }
    void loop();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [api, token, runId, refreshTick]);

  runIdRef.current = runId;
  const chooseRun = useCallback((id: string) => { setRunId(id); setRun(null); setEvents([]); setTimeline(null); lastSeq.current = 0; lastHash.current = ''; }, []);
  // `latestRun` (the picker's row knows it) starts the run's load alongside the case's instead of after it: the run is the
  // slow part (every event of the run), and the case's own answer would otherwise have to arrive first.
  // Choosing the case already open still moves to the run asked for (the picker passes the case's latest run).
  const selectCase = useCallback((id: string, latestRun?: string | null) => {
    if (id === workspaceRef.current) { const next = validId(latestRun); if (next && next !== runIdRef.current) chooseRun(next); return; }
    workspaceRef.current = id; setWorkspace(null); chooseRun(validId(latestRun)); setError(''); setWorkspaceTick(t => t + 1);
  }, [chooseRun]);
  // A run from the Run list, which spans every copy of the case: one in another copy opens that copy's workspace.
  const openRun = useCallback((workspaceId: string, id: string) => {
    if (workspaceId === workspaceRef.current) chooseRun(id); else selectCase(workspaceId, id);
  }, [chooseRun, selectCase]);

  async function action(body: object) {
    setBusy(true); setError('');
    let result: any;
    try { result = await api('', body); } catch (e) { setError((e as Error).message); setBusy(false); return undefined; }
    try { await refreshWorkspace(); setRefreshTick(t => t + 1); } catch (e) { setError('Saved, but the page could not refresh: ' + (e as Error).message); } finally { setBusy(false); }
    refreshCatalog().catch(() => {});
    return result;
  }
  // True when the case was removed. A failure stays on screen, so a caller removing several copies stops at the first one.
  async function deleteCase(id: string, keepError = false): Promise<boolean> {
    setBusy(true); if (!keepError) setError('');
    try { await api('', { action: 'delete', workspace: id }); if (id === workspaceRef.current) selectCase(''); await refreshCatalog(); return true; }
    catch (e) { setError((e as Error).message); return false; } finally { setBusy(false); }
  }
  async function starCase(id: string, starred: boolean) {
    setError('');
    try { await api('', { action: 'star', workspace: id, starred }); await refreshCatalog(); } catch (e) { setError((e as Error).message); }
  }
  async function startRun() { const result = await action({ action: 'start', workspace: workspace?.id }); if (result?.id) chooseRun(result.id); }
  async function downloadAudit() {
    if (!run) return;
    try {
      // The run as sealed (route.ts `audit`), so the saved file can be re-checked hash by hash.
      const full = await api('?run=' + runId + '&workspace=' + workspaceRef.current + '&audit=1');
      const url = URL.createObjectURL(new Blob([JSON.stringify(full, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = `fishbowl-${runId}.json`; a.click(); URL.revokeObjectURL(url);
    } catch (e) { setError('Export failed: ' + (e as Error).message); }
  }
  async function downloadSource(sourceId: string) {
    try {
      const response = await reach('/api/live-fishbowl?run=' + runId + '&workspace=' + workspaceRef.current + '&source=' + encodeURIComponent(sourceId), { headers: token && token !== 'site-session' ? { Authorization: 'Bearer ' + token } : {}, cache: 'no-store' });
      if (response.status === 401 && (token === 'site-session' || siteLoginEnded(response))) { setSignedOut(true); throw new Error(runMessages.signedOut); }
      if (!response.ok) await readAnswer(response);
      // A page or an error answer in place of the file is not saved as the source.
      if (!isFileAnswer(response)) throw new Error(runMessages.lostContact);
      const url = URL.createObjectURL(await response.blob()); const a = document.createElement('a'); a.href = url; a.download = sourceId.split('/').at(-1)!; a.click(); URL.revokeObjectURL(url);
    } catch (e) { const m = (e as Error).message; setError(isRunMessage(m) ? m : 'Source download failed: ' + m); }
  }

  // Play back (owner, 11 October 2026): the public copy's Play shows the open run again from its stored events, in the order they
  // happened, about a minute for a ten-minute run; no model is called and nothing is saved. A wait longer than three seconds (an
  // agent thinking) counts as three, then the whole run is fitted to the minute. While it plays, every view reads the events shown
  // so far and a running run; it ends by itself, on Stop, or when another run or case opens.
  const [replay, setReplay] = useState<{ runId: string; shown: number; key: number } | null>(null), schedule = useRef<number[]>([]);
  const startReplay = useCallback(() => {
    if (!run || isActive(run.status) || !events.length) return;
    // A run with any time missing, or all its times the same, is spread evenly over the minute instead.
    const at = events.map(e => Date.parse(e.at)), timed = at.every(Number.isFinite);
    const gaps = at.map((t, i) => i ? Math.min(Math.max(t - at[i - 1], 0), 3000) : 0);
    const steps = timed && gaps.some(g => g > 0) ? gaps : gaps.map((_, i) => i ? 1 : 0), scale = replayMs / (steps.reduce((a, b) => a + b, 0) || 1);
    let sum = 0; schedule.current = steps.map(d => sum += d * scale);
    setReplay({ runId: run.id, shown: 0, key: Date.now() });
  }, [run, events]);
  const stopReplay = useCallback(() => setReplay(null), []);
  const replayKey = replay?.key;
  useEffect(() => {
    if (!replayKey) return;
    const start = performance.now(), times = schedule.current;
    const id = setInterval(() => {
      const elapsed = performance.now() - start;
      let shown = 0; while (shown < times.length && times[shown] <= elapsed) shown++;
      setReplay(r => r && r.key === replayKey ? (shown >= times.length ? null : r.shown === shown ? r : { ...r, shown }) : r);
    }, 120);
    return () => clearInterval(id);
  }, [replayKey]);
  useEffect(() => { setReplay(r => r && r.runId !== run?.id ? null : r); }, [run?.id]);
  const replaying = !!replay && replay.runId === run?.id;
  const shownEvents = useMemo(() => replaying ? events.slice(0, Math.max(1, replay!.shown)) : events, [replaying, replay, events]);
  const shownRun = useMemo(() => replaying && run ? { ...run, status: 'running', error: undefined, held: true, lease_expired_seconds: null } : run, [replaying, run]);

  const status = shownRun?.status ?? 'not started';
  // A run is chosen but its events have not arrived: not "no run". Views say it is loading instead.
  const runLoading = !!runId && run?.id !== runId && !runMissing;
  return {
    ready, token, needsToken, connect, signedOut, catalogFailed, runMissing, viewOnly,
    cases, catalogLoading, refreshCatalog, workspace, workspaceLoading, selectCase, deleteCase, starCase,
    runId, run: shownRun, runLoading, events: shownEvents, timeline, status, running: isActive(status), chooseRun, openRun, startRun, downloadAudit, downloadSource,
    replaying, replayShare: replaying && events.length ? replay!.shown / events.length : 0, startReplay, stopReplay,
    error, setError, pollError, busy, action,
  };
}
export type Lab = ReturnType<typeof useLab>;
