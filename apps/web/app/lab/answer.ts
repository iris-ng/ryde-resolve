import { operatorTokenRequired, runMessages } from '../../../../packages/live-fishbowl/messages';

// How every page talks to /api/live-fishbowl (owner review of 8 October 2026): a request that
// stalls, a page instead of the site's JSON (the proxy or the tunnel during a restart), an empty or malformed answer, or a lost
// connection all read as one "lost contact" message, never as the browser's own error text, a blank screen or an endless wait.

const lost = () => new Error(runMessages.lostContact);

/**
 * A request that may stall at most `ms` (30 s, 60 s for an action or an upload) before the answer starts and between two
 * pieces of it, whatever its length: a long export that keeps arriving is never cut off, one that stops is. The answer is
 * read whole here, so a reader never meets a broken stream. A timer, not AbortSignal.timeout, so older browsers stop too.
 */
export async function reach(url: string, init: RequestInit = {}, ms = init.method === 'POST' ? 60000 : 30000): Promise<Response> {
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), ms);
  const stillArriving = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), ms); };
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const parts: Uint8Array[] = [];
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) { stillArriving(); const { done, value } = await reader.read(); if (done) break; if (value) parts.push(value); }
    }
    const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0; for (const p of parts) { bytes.set(p, at); at += p.length; }
    const empty = [101, 204, 205, 304].includes(response.status);
    return new Response(empty ? null : bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch { throw lost(); }
  finally { clearTimeout(timer); }
}

/** An answer, read only when it is the site's own JSON object: anything else, an empty body included, is lost contact. */
export async function readAnswer(response: Response) {
  const text = await response.text().catch(() => { throw lost(); });
  let value: any;
  try { value = JSON.parse(text); } catch { throw lost(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw lost();
  if (!response.ok) throw new Error(typeof value.error === 'string' && value.error ? value.error : runMessages.lostContact);
  return value;
}

/** The site's sign-in (the proxy's login) refusing the request: a 401 that asks for Basic credentials. The app's own refusal is JSON. */
export const siteLoginEnded = (response: Response) => response.status === 401 && /^basic\b/i.test(response.headers.get('www-authenticate') ?? '');
/** The app's own 401, by its fixed code. Anything else answering 401 (a page, an empty body, another service's JSON) is lost contact. */
async function appRefusal(response: Response) {
  try { const value = JSON.parse(await response.text()); return !!value && typeof value === 'object' && value.code === operatorTokenRequired; } catch { return false; }
}

/**
 * The first check: the site's own sign-in (the proxy passes it on), an operator deployment that asks for a token (the app's
 * 401), or a visitor whose site sign-in ended. Anything else (a restart, no connection, a malformed answer) throws "lost
 * contact" and is tried again. `view` is the public copy of the site (owner, 11 October 2026): a site session that reads and
 * never changes anything.
 */
export async function connectionMode(): Promise<'site' | 'view' | 'token' | 'signed-out'> {
  const response = await reach('/api/live-fishbowl?connection=1', { cache: 'no-store' });
  if (siteLoginEnded(response)) return 'signed-out';
  if (response.status === 401) { if (await appRefusal(response)) return 'token'; throw lost(); }
  const value = await readAnswer(response);
  if (typeof value.siteSession !== 'boolean') throw lost();
  return value.siteSession ? (value.viewOnly === true ? 'view' : 'site') : 'token';
}

// The shapes the pages render from. An answer that does not have them is not used: it would crash the page instead.
// Field by field: a list whose entries lack what the page reads would still crash it.
const text = (v: unknown) => typeof v === 'string' && v.length > 0;
const str = (v: unknown) => typeof v === 'string';
const orNull = (v: unknown, ok: (x: unknown) => boolean) => v === null || v === undefined || ok(v);
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const listOf = (v: unknown, ok: (x: any) => boolean) => Array.isArray(v) && v.every(x => object(x) && ok(x));
const isEvent = (e: any) => Number.isInteger(e.seq) && text(e.kind) && str(e.actor) && str(e.phase) && orNull(e.message, str);
const isSource = (s: any) => text(s.id) && str(s.text) && Array.isArray(s.lines) && s.lines.every(str) && orNull(s.sha256, str);
const isPacket = (p: any) => object(p) && listOf(p.sources, isSource) && orNull(p.photos, x => listOf(x, ph => text(ph.photoId)));
/** A timeline entry (evidence.ts TimelineEntry): what the Timeline tab draws. */
const isTimeline = (v: unknown) => listOf(v, t => str(t.sourceId) && Number.isInteger(t.startLine) && Number.isInteger(t.endLine) && str(t.recordedTime) && str(t.originalEntry));
const isRunRow = (r: any) => text(r.id) && text(r.status);
const isDocument = (d: any) => text(d.id) && str(d.filename);
export const isRunAnswer = (v: any) => object(v?.run) && isRunRow(v.run) && isPacket(v.run.packet) && orNull(v.run.error, str) && listOf(v.events, isEvent) && orNull(v.timeline, isTimeline);
export const isTailAnswer = (v: any) => object(v?.run) && text(v.run.status) && orNull(v.run.error, str) && listOf(v.events, isEvent);
export const isCatalogAnswer = (v: any) => listOf(v?.workspaces, w => text(w.id) && str(w.case_id) && str(w.title) && orNull(w.status, str) && orNull(w.run_id, str) && orNull(w.created_at, str))
  && listOf(v?.cases, c => text(c.id) && str(c.title));
export const isWorkspaceAnswer = (v: any) => object(v) && text(v.id) && str(v.caseId) && str(v.title) && isPacket(v.packet) && isTimeline(v.timeline) && object(v.triage)
  && listOf(v.baseDocuments, isDocument) && listOf(v.documents, isDocument) && listOf(v.runs, isRunRow) && orNull(v.groupRuns, x => listOf(x, isRunRow)) && orNull(v.detection, object);

/** A file the site sends (a source document, a photo): never a page or JSON in its place. */
export const isFileAnswer = (response: Response) => response.ok && !/^(text\/html|application\/json)\b/i.test(response.headers.get('content-type') ?? '');
