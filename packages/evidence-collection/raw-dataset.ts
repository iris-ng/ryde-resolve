// Server-side reader for a dispute's raw dataset.json (fraud flags and all), for the record check only (spec Part 3).
// Nothing here reaches an agent. The raw file must reproduce the run's pinned evidence sources exactly, so the check
// reads the same record the agents read; any difference reads `unavailable`, never clean.
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { CasePacket } from '../agent-flow/contracts';
import { loadDatasetPacket } from '../case-packet/dataset';
import { earlierClaimsSourceId } from '../case-packet/earlier-claims';
import { catalogue } from '../live-fishbowl/cases';
import { startingPacket } from '../outside-data/records';

export type RawDataset = { data: any; file: string; folder: string };
export type Citation = { sourceId: string; startLine: number; endLine: number };
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
/** The standalone web server changes directory, so the default follows EVIDENCE_DISPUTES_ROOT (set in compose) like caseRoot() does. */
export const registersRoot = () => process.env.EVIDENCE_REGISTERS_ROOT ?? (process.env.EVIDENCE_DISPUTES_ROOT ? path.join(path.dirname(process.env.EVIDENCE_DISPUTES_ROOT), 'registers') : path.join(process.cwd(), 'evidence/registers'));
const disputesRoot = () => process.env.EVIDENCE_DISPUTES_ROOT ?? path.join(process.cwd(), 'evidence/disputes');
/** Development cases for the record check live beside the register (never in the held-out set or the catalogue). */
export const devCasesPath = () => path.join(registersRoot(), 'dev-cases.json');
export type DevCase = { id: string; title: string; folder: string; base: string };
export async function devCases(): Promise<DevCase[]> {
  const index = JSON.parse(await readFile(devCasesPath(), 'utf8'));
  if (index?.version !== 1 || index.set !== 'development' || index.synthetic !== true || !Array.isArray(index.cases)) throw new Error('the development case index is malformed');
  return index.cases;
}
/** Static lookups only (no directory scan): the catalogue first, then the development index. `root` holds the folder. */
export async function datasetLocation(caseId: string): Promise<{ file: string; root: string } | null> {
  const listed = catalogue.find(c => c.id === caseId) as { folder?: string } | undefined;
  if (listed?.folder) return { file: path.join(disputesRoot(), listed.folder, 'dataset.json'), root: disputesRoot() };
  const dev = (await devCases().catch(() => [])).find(c => c.id === caseId);
  if (!dev || path.isAbsolute(dev.folder) || dev.folder.split(/[\\/]/).includes('..')) return null;
  return { file: path.join(registersRoot(), dev.folder, 'dataset.json'), root: registersRoot() };
}
export const datasetFileFor = async (caseId: string) => (await datasetLocation(caseId))?.file ?? null;
/** Throws a short reason (no server paths) when the raw dataset is missing or differs from the pinned packet. */
export async function readRawDataset(packet: Pick<CasePacket, 'caseId' | 'sources' | 'evidenceChecks'>): Promise<RawDataset> {
  const at = await datasetLocation(packet.caseId);
  if (!at) throw new Error(`no raw dataset is on the server for ${packet.caseId}`);
  // Real paths first: dataset.json must be a regular file in its own dispute folder, and the folder inside its root.
  let file: string;
  try {
    // Read at run time from folders the web image copies (infra/Dockerfile); nothing here should be traced into the build.
    const [real, folder, root] = await Promise.all([realpath(/*turbopackIgnore: true*/ at.file), realpath(/*turbopackIgnore: true*/ path.dirname(at.file)), realpath(/*turbopackIgnore: true*/ at.root)]);
    if (real !== path.join(folder, 'dataset.json') || !folder.startsWith(root + path.sep) || !(await stat(real)).isFile()) throw new Error('out of place');
    file = real;
  } catch { throw new Error(`the raw dataset for ${packet.caseId} is missing, or is not a regular file inside its dispute folder`); }
  let data: any, rebuilt: CasePacket;
  try { data = JSON.parse(await readFile(file, 'utf8')); rebuilt = await loadDatasetPacket(file); }
  catch { throw new Error(`the raw dataset for ${packet.caseId} is unreadable`); }
  // The earlier-claims extract (facts 7, MVP fixes second release) comes from the claims register, not from dataset.json, and the check
  // reads the register itself: a register change between pinning and checking is not a different case file.
  const evidence = (sources: CasePacket['sources']) => JSON.stringify(sources.filter(s => s.id.startsWith('evidence/') && s.id !== earlierClaimsSourceId).map(s => [s.id, s.sha256]).sort());
  // A run pinned at evidence checks 4 or later starts without the advance outside data (packages/outside-data/records.ts
  // startingPacket), so the pinned sources may be the file's sources trimmed that way; a packet loaded whole (a test, an
  // audit) carries them all. Either is this file's record and nothing else is. Found 11 October 2026: every dataset run at
  // checks 4 read `unavailable`, and went to a person for that reason alone, because only the whole file was accepted.
  const pinned = evidence(packet.sources), whole = evidence(rebuilt.sources), started = evidence(startingPacket(rebuilt, packet.evidenceChecks).sources);
  if (rebuilt.caseId !== packet.caseId || data?.dispute_ticket?.dispute_id !== packet.caseId || (pinned !== whole && pinned !== started))
    throw new Error(`the raw dataset on the server does not match the pinned packet for ${packet.caseId}`);
  return { data, file, folder: path.dirname(file) };
}
const fileCap = 6 * 1024 * 1024;
/**
 * A file key needs verified bytes: a regular file inside the dispute folder, never under its expected/ answer keys
 * (real path, so symlinks count), whose sha256 equals the recorded hash.
 */
export async function verifiedFile(folder: string, filename: unknown, recorded: unknown): Promise<{ ok: true; sha256: string; bytes: number; data: Buffer } | { ok: false; reason: string }> {
  if (typeof recorded !== 'string' || !/^[0-9a-f]{64}$/.test(recorded)) return { ok: false, reason: 'no recorded hash' };
  if (typeof filename !== 'string' || !filename || filename.includes('\0') || /^[a-z][a-z0-9+.-]*:/i.test(filename)) return { ok: false, reason: 'no file name' };
  const answerKey = (relative: string) => relative.split(/[\\/]/).some(part => part.toLowerCase() === 'expected');
  if (!path.isAbsolute(filename) && answerKey(filename)) return { ok: false, reason: 'inside an expected/ folder' };
  let real: string, root: string;
  try { [real, root] = await Promise.all([realpath(path.resolve(folder, filename)), realpath(folder)]); } catch { return { ok: false, reason: 'no bytes' }; }
  if (!real.startsWith(root + path.sep)) return { ok: false, reason: 'outside the dispute folder' };
  if (answerKey(path.relative(root, real))) return { ok: false, reason: 'inside an expected/ folder' };
  const info = await stat(real);
  if (!info.isFile()) return { ok: false, reason: 'not a regular file' };
  if (info.size > fileCap) return { ok: false, reason: 'larger than 6 MB' };
  const data = await readFile(real), digest = sha(data);
  return digest === recorded ? { ok: true, sha256: digest, bytes: info.size, data } : { ok: false, reason: 'bytes do not match the recorded hash' };
}
// Line numbers in the pinned JSON sources, which the loader writes with JSON.stringify(block, null, 2).
const lineCount = (value: unknown) => JSON.stringify(value, null, 2).split('\n').length;
/** Lines of element `index` of an array block. */
export function elementLines(block: string, array: unknown[], index: number): Citation {
  let start = 2;
  for (let i = 0; i < index; i++) start += lineCount(array[i]);
  return { sourceId: `evidence/${block}.json`, startLine: start, endLine: start + lineCount(array[index]) - 1 };
}
/** Lines of top-level key `key` of an object block, or null when the key is absent. */
export function keyLines(block: string, object: Record<string, unknown>, key: string): Citation | null {
  const lines = JSON.stringify(object, null, 2).split('\n'), at = lines.findIndex(l => l.startsWith(`  ${JSON.stringify(key)}:`));
  if (at < 0) return null;
  let end = at + 1;
  while (end < lines.length - 1 && !/^ {2}"/.test(lines[end]!)) end++;
  return { sourceId: `evidence/${block}.json`, startLine: at + 1, endLine: end };
}
