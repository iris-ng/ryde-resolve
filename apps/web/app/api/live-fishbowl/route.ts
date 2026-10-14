import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { NextResponse } from 'next/server';
import { liveCase, catalogue, loadLiveCase, retiredFromPicker } from '../../../../../packages/live-fishbowl/cases';
import { pinnedPhotoFile } from '../../../../../packages/evidence-collection/photo-examiner';
import { evidenceChecksPin, type CasePacket } from '../../../../../packages/agent-flow/contracts';
import { withDerivedSources, withLoggedOutsideRecords } from '../../../../../packages/live-fishbowl/model';
import { evidenceTimeline } from '../../../../../packages/live-fishbowl/evidence';
import { evidenceChecksView } from '../../../../../packages/live-fishbowl/checks-view';
import { mapillaryThumb, outsideKeys } from '../../../../../packages/outside-data/providers';
import { canLookUpOutside, startingPacket } from '../../../../../packages/outside-data/records';
import { triage, safetyIntakeSchema } from '../../../../../packages/live-fishbowl/triage';
import * as live from '../../../../../packages/live-fishbowl/store';
import { detectCategory, categoryLabels } from '../../../../../packages/live-fishbowl/classify';
import { ruleSummaries } from '../../../../../packages/policy/ruleset';
import { migrationMissing, migrationMissingMessage } from '../../../../../packages/live-fishbowl/schema';
import { operatorTokenRequired, runMessages, viewOnlyRefused } from '../../../../../packages/live-fishbowl/messages';
import { mayView, type PublicScope } from '../../../../../packages/live-fishbowl/public-scope';
import { savedRouteMapFor } from '../../../../../packages/live-fishbowl/saved-route-map';
import { savedStreetPicture } from '../../../../../packages/live-fishbowl/saved-street-picture';
import { isScoredCase } from '../../../../../packages/policy/evaluation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
// Two ways in (owner, 11 October 2026). The operator site, behind the site login,
// sends the control token and may do everything. The public copy, ryde-resolve.pages.dev with no login, sends the view token: it
// reads the owner's chosen cases (public-scope.ts) and changes nothing. Caddy sets each header and drops any copy a visitor sends (infra/Caddyfile.fishbowl), and Caddy also
// refuses every change on the public copy before it reaches here; this check is the second lock. The control token wins if both came.
const same = (a: string, b: string) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
function authorize(request: Request, write: boolean): { denied: NextResponse } | { view: boolean } {
  const token = process.env.FISHBOWL_CONTROL_TOKEN;
  if (!token || token.length < 32) return { denied: NextResponse.json({ error: 'Live Fishbowl is not configured. An operator must configure its control token and worker.' }, { status: 503 }) };
  const site = process.env.FISHBOWL_SITE_AUTH === '1';
  // Behind the site proxy only Caddy's header carries operator power (12 October 2026); a Bearer token is for local runs without it.
  const incoming = (site ? request.headers.get('x-fishbowl-site-token') : request.headers.get('authorization')?.replace(/^Bearer /, '')) ?? '';
  const viewToken = process.env.FISHBOWL_VIEW_TOKEN ?? '', operator = same(incoming, token);
  const view = !operator && site && viewToken.length >= 32 && viewToken !== token && same(request.headers.get('x-fishbowl-view-token') ?? '', viewToken);
  if (!operator && !view) return { denied: NextResponse.json({ error: 'A valid Fishbowl operator token is required.', code: operatorTokenRequired }, { status: 401 }) };
  // The operator's own pages only (cross-site forms refused). FISHBOWL_PUBLIC_ORIGIN may name several origins, comma-separated.
  // The public copy only reads: no Origin check.
  const origin = request.headers.get('origin');
  const listed = (process.env.FISHBOWL_PUBLIC_ORIGIN ?? '').split(',').map(o => o.trim()).filter(Boolean);
  const expected = listed.length ? listed : [`${new URL(request.url).protocol}//${request.headers.get('host') ?? new URL(request.url).host}`];
  if (!view && origin && !expected.includes(origin)) return { denied: NextResponse.json({ error: 'Origin rejected' }, { status: 403 }) };
  if (view && write) return { denied: NextResponse.json({ error: runMessages.viewOnly, code: viewOnlyRefused }, { status: 403 }) };
  return { view };
}
const json = (data: unknown) => NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });
/** The case list the public copy sends: its own cases only, by number and title (no folder names, no exam tags). */
const publicCases = (scope: PublicScope) => catalogue.filter(c => scope.cases.has(c.id)).map(c => ({ id: c.id, title: c.title }));
async function workspaceView(id?: string, caseId?: string, extra: { title?: string; category?: string } = {}, scope: PublicScope | null = null) {
  // Load and validate the case packet BEFORE creating a workspace row, so a failed load leaves nothing behind.
  if (!id) await loadLiveCase(liveCase(caseId ?? 'DISP-004').id, extra);
  const value = await live.workspace(id, caseId, extra);
  // Before a run the page shows the case as a new run starts with it (owner, 11 October 2026): from evidence checks 4 (AD-11) the
  // team's outside notes, saved road route and evidence requests are left out, since the Evidence Collector looks things up itself.
  const base = await loadLiveCase(value.caseId, { category: value.category ?? undefined, title: value.customTitle ?? undefined }), packet = startingPacket(await live.workspacePacket(value.id!, base), evidenceChecksPin);
  const detection = value.caseId === 'CUSTOM' ? detectCategory(packet.sources) : null, groupRuns = await live.groupRuns(value.id!);
  return { ...value, groupRuns, detection: detection && { category: detection.category, label: categoryLabels[detection.category], documents: detection.documents, matches: detection.matches.slice(0, 12) }, title: value.customTitle || liveCase(value.caseId).title, cases: scope ? publicCases(scope) : catalogue, packet, routeMap: savedRouteMapFor(packet.caseId), outsideLookups: canLookUpOutside(packet, evidenceChecksPin), timeline: evidenceTimeline(packet), triage: triage(packet), baseDocuments: base.sources.map(s => ({ id: s.id, filename: s.id.split('/').at(-1), size: Buffer.byteLength(s.text), sha256: s.sha256 })) };
}
function failure(error: unknown) {
  const e = error as { code?: string; message?: string; stack?: string };
  // Operators need the real cause in the server log; the browser gets a bounded message.
  console.error('[live-fishbowl]', e.code ?? '-', (e.message ?? String(error)).slice(0, 500));
  if (e.code === '23505') return NextResponse.json({ error: 'This document is already in the workspace.' }, { status: 409 });
  if (migrationMissing(e)) return NextResponse.json({ error: migrationMissingMessage }, { status: 503 });
  // The database down or slow: the driver's own wording (no code) included, so no raw database text reaches the page (owner review, 8 October 2026).
  const storage = (typeof e.code === 'string' && (/^[0-9A-Z]{5}$/.test(e.code) || /^E(CONN|TIMEDOUT|NOTFOUND|HOSTUNREACH|AI_AGAIN|PIPE)/.test(e.code)))
    || /timeout exceeded when trying to connect|Connection terminated|connect ECONNREFUSED|too many clients|the database system is (starting up|shutting down)/i.test(e.message ?? '');
  if (storage) return NextResponse.json({ error: runMessages.recordsDown }, { status: 503 });
  if (typeof e.code === 'string' && /^E(NOENT|ACCES|ISDIR|NOTDIR|LOOP)/.test(e.code)) return NextResponse.json({ error: `Case files are missing on the server (${e.code}). Ask the operator to check the evidence directories in the web image.` }, { status: 500 });
  if (error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError) return NextResponse.json({ error: 'Unexpected server error. The operator log has the details.' }, { status: 500 });
  if (error instanceof Error) return NextResponse.json({ error: error.message.slice(0, 500) }, { status: 400 });
  return NextResponse.json({ error: 'Unexpected server error.' }, { status: 500 });
}
export async function GET(request: Request) {
  const access = authorize(request, false); if ('denied' in access) return access.denied;
  const q = new URL(request.url).searchParams;
  try {
    // The public copy is a site session too, marked view-only so the page shows Play back in place of the controls that change things.
    if (q.has('connection')) return json(access.view ? { siteSession: true, viewOnly: true } : { siteSession: process.env.FISHBOWL_SITE_AUTH === '1' && Boolean(request.headers.get('x-fishbowl-site-token')) });
    // The public copy reads only its own cases (owner, 12 October 2026, public-scope.ts). Anything else answers exactly as a
    // workspace or run that does not exist, so a visitor learns nothing about it.
    const scope = access.view ? await live.publicScope() : null;
    const shownWorkspace = async (id: string | null) => { if (scope && !(id && uuid(id) && (await live.workspaceScope(id).then(w => w && mayView(scope, w))))) throw new Error('Workspace not found'); };
    const shownRun = async (id: string) => { if (scope && !(await live.runScope(id).then(w => w && mayView(scope, w)))) throw new Error('Run not found'); };
    if (q.has('catalog')) return json(scope ? { workspaces: await live.listWorkspaces(scope), cases: publicCases(scope) } : { workspaces: await live.listWorkspaces(), cases: catalogue.filter(c => /^(DISP|ORG)-/.test(c.id) && !retiredFromPicker.has(c.id)) });
    // The learning loop's past rulings page: every card drafted from a person's decision, and the rules a card may name.
    if (q.has('precedents')) {
      const id = q.get('id'), page = Number(q.get('page') ?? '1');
      if (id !== null && !/^PREC-L-[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid past ruling');
      if (!Number.isInteger(page) || page < 1 || page > 10000) throw new Error('Invalid page');
      // The public copy shows the Library's rulings only, without reviewers' notes (store.ts listLibraryPrecedents).
      return json({ ...(scope ? await live.listLibraryPrecedents({ page, id: id ?? undefined }, scope) : await live.listLoopPrecedents({ status: q.get('status') ?? undefined, page, id: id ?? undefined })), rules: ruleSummaries });
    }
    // A photo's bytes for the Evidence column: only a photo pinned on the requested run (or, before any run, on the
    // workspace's own case), matched by ID and sha256, re-read from that case's folder under the loader contract.
    if (q.has('photo')) {
      if (!uuid(q.get('workspace'))) throw new Error('Invalid workspace');
      await shownWorkspace(q.get('workspace'));
      let pinned: CasePacket;
      if (q.has('run')) {
        if (!uuid(q.get('run'))) throw new Error('Invalid run');
        await shownRun(q.get('run')!);
        const view = await live.readLiveRun(q.get('run')!);
        if (view.run.workspace_id !== q.get('workspace')) throw new Error('Run does not belong to this case workspace');
        pinned = view.run.packet;
      } else {
        const w = await live.workspace(q.get('workspace')!);
        pinned = await loadLiveCase(w.caseId, { category: w.category ?? undefined, title: w.customTitle ?? undefined });
      }
      const photo = await pinnedPhotoFile(pinned, q.get('photo'), q.get('sha256'));
      return new Response(new Uint8Array(photo.bytes), { headers: { 'Content-Type': photo.mediaType, 'Content-Disposition': 'inline', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
    if (q.has('run')) {
      if (!uuid(q.get('run'))) throw new Error('Invalid run');
      // since=SEQ: the page already holds events up to SEQ and needs only run status plus the tail. No packet, timeline or source in that response.
      const since = q.has('since') ? Number(q.get('since')) : 0;
      if (!Number.isInteger(since) || since < 0 || since > 1e6) throw new Error('Invalid since');
      await shownRun(q.get('run')!);
      if (since > 0) {
        const tail = await live.readLiveRun(q.get('run')!, since);
        if (q.has('workspace') && tail.run.workspace_id !== q.get('workspace')) throw new Error('Run does not belong to this case workspace');
        return json(tail);
      }
      const result = await live.readLiveRun(q.get('run')!);
      // The audit log (12 October 2026): the run exactly as sealed, before anything below adds display sources, so whoever downloads
      // it can re-check every hash: sha256(canonical(run.packet)) is run.packet_hash, and each event without its hash and
      // previousHash, canonical, after the previous hash, gives its hash (store.ts readLiveRun).
      if (q.has('audit')) {
        if (q.has('workspace') && result.run.workspace_id !== q.get('workspace')) throw new Error('Run does not belong to this case workspace');
        return json(result);
      }
      // Sealed service-role artifacts are read-only sources for later tasks; expose them for citation lookups and downloads.
      // Outside lookups a Collector made before failing show too, from the event log (model.ts withLoggedOutsideRecords).
      result.run.packet = withLoggedOutsideRecords(withDerivedSources(result.run.packet, await live.checkpoints(q.get('run')!)), result.events);
      if (q.has('workspace') && result.run.workspace_id !== q.get('workspace')) throw new Error('Run does not belong to this case workspace');
      if (q.has('street')) {
        // Outside lookups (AD-15): only a picture this run's records name. The site's own saved copy first (owner, 13 October 2026,
        // saved-street-picture.ts); the public copy never asks Mapillary, so no visitor can make the server fetch. Only the operator,
        // for a picture not saved, gets it from Mapillary by its ID with the web's own key (Mapillary only; no agent holds it).
        // Without a copy, the key or the picture, 404, and the tab keeps the recorded description.
        const id = q.get('street')!;
        const named = /^\d{1,30}$/.test(id) && result.run.packet.sources.some((s: { id: string; text: string }) => { if (!s.id.startsWith('evidence/outside_street_picture_')) return false; try { return JSON.parse(s.text)?.answer?.imageId === id; } catch { return false; } });
        const bytes = !named ? null : await savedStreetPicture(id) ?? (access.view ? null : await mapillaryThumb(fetch, outsideKeys(process.env), id));
        if (!bytes) return new Response('Picture not available', { status: 404, headers: { 'Cache-Control': 'no-store' } });
        return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' } });
      }
      if (q.has('source')) {
        const source = result.run.packet.sources.find((s: { id: string }) => s.id === q.get('source'));
        if (!source) throw new Error('Source not found');
        return new Response(source.text, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="evidence.txt"', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
      }
      // The route, promo and fare checks and the advocates' own-side lists, worked out from this run's locked case file (checks-view.ts).
      // `scored` and `routeMap` (12 October 2026): the decision form's test-case note and the case's saved street map, sent beside the
      // case file (never inside it, so the file the audit log saves stays as sealed) so the page holds neither the exam manifest nor the register.
      return json({ ...result, run: { ...result.run, routeMap: savedRouteMapFor(result.run.packet.caseId), scored: isScoredCase(result.run.packet.caseId), checks: evidenceChecksView(result.run.packet), outsideLookups: canLookUpOutside(result.run.packet, result.run.packet.evidenceChecks) }, timeline: evidenceTimeline(result.run.packet) });
    }
    if (!uuid(q.get('workspace'))) throw new Error('Invalid workspace');
    await shownWorkspace(q.get('workspace'));
    return json(await workspaceView(q.get('workspace')!, undefined, {}, scope));
  } catch (e) { return failure(e); }
}
export async function POST(request: Request) {
  const access = authorize(request, true); if ('denied' in access) return access.denied;
  try {
    // Bound actual streamed bytes, including chunked requests, before parsing.
    const reader = request.body?.getReader(); let size = 0; const chunks: Uint8Array[] = [];
    if (reader) for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 100000) { await reader.cancel(); return NextResponse.json({ error: 'Request too large' }, { status: 413 }); } chunks.push(part.value); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body.action === 'workspace') return json(await workspaceView(undefined, liveCase(body.caseId ?? 'CUSTOM').id, { title: typeof body.title === 'string' ? body.title : undefined }));
    if (['pause', 'resume', 'stop'].includes(body.action) && uuid(body.run)) return json(await live.controlRun(body.run, body.action));
    if (body.action === 'delete' && uuid(body.workspace)) return json(await live.archiveWorkspace(body.workspace));
    if (body.action === 'star' && uuid(body.workspace) && typeof body.starred === 'boolean') return json(await live.starWorkspace(body.workspace, body.starred));
    if (body.action === 'posture' && uuid(body.workspace)) return json(await live.setPosture(body.workspace, body.posture));
    if (body.action === 'review' && uuid(body.run)) return json(await live.updateReview(body.run, body.review));
    if (body.action === 'decide' && uuid(body.run)) return json(await live.recordDecision(body.run, body.decision));
    if (body.action === 'precedent' && typeof body.id === 'string' && /^PREC-L-[0-9a-f-]{36}$/.test(body.id)) return json(await live.reviewLoopPrecedent(body.id, body.review));
    if (!uuid(body.workspace)) throw new Error('Invalid workspace');
    if (body.action === 'safety') return json(await live.addDocument(body.workspace, 'safety-intake.json', Buffer.from(JSON.stringify({ kind: 'operator_safety_intake', submittedAt: new Date().toISOString(), ...safetyIntakeSchema.parse(body.intake) }, null, 2))));
    // The operator's "Fetch outside data" form and its action were removed on 11 October 2026 (owner): the Evidence Collector looks
    // outside data up itself (outside_lookup, AD-11).
    if (body.action === 'upload') {
      if (typeof body.filename !== 'string' || typeof body.base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.base64)) throw new Error('Invalid document encoding');
      return json(await live.addDocument(body.workspace, body.filename, Buffer.from(body.base64, 'base64')));
    }
    if (body.action === 'start') {
      // A custom case's dispute type is detected from its documents at run start, so the pinned rules follow what was uploaded.
      const detected = await live.detectWorkspaceCategory(body.workspace);
      const workspace = await live.workspace(body.workspace);
      return json(await live.startRun(body.workspace, await loadLiveCase(workspace.caseId, { category: detected?.category ?? workspace.category ?? undefined, title: workspace.customTitle ?? undefined })));
    }
    throw new Error('Unknown action');
  } catch (e) { return failure(e); }
}
