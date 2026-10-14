import { createHash } from 'node:crypto';
import { withOutsideRecords, type Artifact, type CasePacket, type OutsideCall, type OutsideKind, type Phase, type Role } from '../agent-flow/contracts';
import { isDatasetPacket } from '../case-packet/dataset';
// Pinned photo IDs and hashes stay in the evidence version whenever sources are added (spec Part 4).
import { evidenceVersionOf } from '../case-packet/photos';

import { phaseOrder, prePhases as preOrder, phaseRoles as rolesFor } from './roles';
export const phases: Phase[] = phaseOrder;
export const prePhases: Phase[] = preOrder;
export const phaseRoles = rolesFor;
export type Checkpoint = { role: Role; phase: Phase; artifact: Artifact };
// Pre-debate service phases run only for dataset packets when enabled.
export const preAgentsEnabled = (packet: Pick<CasePacket, 'datasetVersion'>) => isDatasetPacket(packet) && process.env.RYDE_PRE_AGENTS !== '0';
/** The next phase with work left. `failed` lists decide seats B or C that ended without a submission: they are terminal, never re-run. */
export function nextStage(checkpoints: Checkpoint[], packet?: Pick<CasePacket, 'datasetVersion' | 'panel' | 'photos'>, failed: Role[] = []) {
  const active = phases.filter(p => p === 'examine' ? !!packet?.photos?.length : prePhases.includes(p) ? !!packet && preAgentsEnabled(packet) : true);
  return active.find(phase => phaseRoles(phase, packet).some(role => !checkpoints.some(c => c.phase === phase && c.role === role) && !(phase === 'decide' && failed.includes(role))));
}
// Sealed pre-phase artifacts become hashed read-only sources for every later task, in phase order (spec revision 9).
const derivedIds: Partial<Record<Phase, string>> = { examine: 'derived/photos.json', collect: 'derived/observations.json', apply: 'derived/applicability.json' };
// Outside lookups (AD-13): the Collector's records (its server-owned `outside` trail) are pinned before the derived sources, each
// checked against its hash, and left out of derived/observations.json so the text is not repeated. A run without the field is unchanged.
export function withDerivedSources(packet: CasePacket, checkpoints: Checkpoint[]): CasePacket {
  const outside = checkpoints.filter(c => c.phase === 'collect').flatMap(c => (c.artifact as { outside?: OutsideCall[] }).outside ?? []);
  for (const call of outside) if (hash(call.text) !== call.sha256) throw new Error('An outside record does not match its hash');
  const derived = prePhases.flatMap(phase => checkpoints.filter(c => c.phase === phase).map(c => { const { outside: _outside, ...artifact } = c.artifact as Artifact; const text = JSON.stringify(artifact, null, 2); return { id: derivedIds[phase]!, text, lines: text.split('\n'), sha256: hash(text) }; }));
  if (!derived.length && !outside.length) return packet;
  const sources = [...withOutsideRecords(packet, outside).sources.filter(s => !s.id.startsWith('derived/')), ...derived];
  return { ...packet, sources, evidenceVersion: evidenceVersionOf(sources, packet.photos) };
}
/**
 * Outside lookups: each lookup's whole record is also in the run's event log (outside_fetched), so the screen can
 * show what the Evidence Collector looked up even when it failed before submitting. A logged record is used only when its text matches its
 * hash and its source is not already pinned (a sealed Collector artifact wins); a later event for the same source replaces an earlier one.
 */
export function withLoggedOutsideRecords(packet: CasePacket, events: { kind?: string; data?: any }[]): CasePacket {
  const pinned = new Set(packet.sources.map(s => s.id)), calls: OutsideCall[] = [];
  for (const e of events) {
    const d = e?.kind === 'outside_fetched' ? e.data ?? {} : null;
    const m = d && typeof d.sourceId === 'string' ? /^evidence\/(?:outside_(rainfall|place|transport|street_picture)_(\d{1,2})|route_reference)\.json$/.exec(d.sourceId) : null;
    if (!m || typeof d.text !== 'string' || typeof d.sha256 !== 'string' || hash(d.text) !== d.sha256 || pinned.has(d.sourceId)) continue;
    const call: OutsideCall = { kind: (m[1] ?? 'road_route') as OutsideKind, n: m[2] ? Number(m[2]) : 1, sourceId: d.sourceId, place: typeof d.place === 'string' ? d.place : null, window: typeof d.window === 'string' ? d.window : null, text: d.text, sha256: d.sha256 };
    const at = calls.findIndex(c => c.sourceId === call.sourceId); if (at >= 0) calls[at] = call; else calls.push(call);
  }
  if (!calls.length) return packet;
  const sources = withOutsideRecords(packet, calls).sources;
  return { ...packet, sources, evidenceVersion: evidenceVersionOf(sources, packet.photos) };
}
export function disclosedBefore(phase: Phase, checkpoints: Checkpoint[]) {
  return Object.fromEntries(checkpoints.filter(c => phases.indexOf(c.phase) < phases.indexOf(phase)).map(c => [`${c.role}_${c.phase}`, c.artifact]));
}
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
export function uploadSource(id: string, filename: string, bytes: Buffer, maxBytes = 65536) {
  if (!/^[\w .()-]{1,100}\.(txt|md|csv|json)$/i.test(filename)) throw new Error('Use a TXT, MD, CSV or JSON filename (up to 100 characters before the extension).');
  if (!bytes.length || bytes.length > maxBytes) throw new Error(`Each document must contain 1–${maxBytes.toLocaleString('en-US')} bytes.`);
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (text.includes('\0')) throw new Error('Binary documents are not supported.');
  if (text.split(/\r?\n/).length > 2000) throw new Error('A document may contain at most 2,000 lines.');
  return { id: `uploads/${id}/${filename}`, sha256: hash(bytes), text, lines: text.split(/\r?\n/) };
}
export function supplementPacket(base: CasePacket, sources: CasePacket['sources']): CasePacket {
  const combined = [...base.sources, ...sources];
  return { ...base, sources: combined, evidenceVersion: evidenceVersionOf(combined, base.photos) };
}
