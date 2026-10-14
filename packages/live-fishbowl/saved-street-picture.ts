import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { registersRoot } from '../evidence-collection/raw-dataset';

// The street pictures the public copy shows, saved once (owner, 13 October 2026; evidence/tools/save-street-pictures.mjs) so a page
// view never makes the server ask Mapillary. Server only. A picture is answered only when evidence/registers/street-pictures.json
// lists it and its file matched the listed size and sha256 when first read; anything else is null, never an error, and the caller
// decides (route.ts: only the operator may still ask Mapillary). The register and each picture are read once per root and kept until
// the server restarts (they change only with a release, so a repaired file needs a restart): six files, under 1 MB. A register that
// is missing means no saved pictures; one that cannot be read or is malformed is logged and read again on the next request.
type Entry = { sha256: string; bytes: number };
const registers = new Map<string, Promise<Record<string, Entry>>>(), pictures = new Map<string, Promise<Buffer | null>>();
function entries(root: string) {
  let read = registers.get(root);
  if (!read) {
    read = readFile(path.join(root, 'street-pictures.json'), 'utf8').then(text => {
      const r = JSON.parse(text);
      if (r?.version !== 1 || !r.entries || typeof r.entries !== 'object' || Array.isArray(r.entries)) throw new Error('evidence/registers/street-pictures.json is malformed');
      return r.entries as Record<string, Entry>;
    }, (e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return {}; throw e; });
    read.catch(() => registers.delete(root));
    registers.set(root, read);
  }
  return read;
}
export async function savedStreetPicture(imageId: string, root = registersRoot()): Promise<Buffer | null> {
  if (!/^\d{1,30}$/.test(imageId)) return null;
  let list: Record<string, Entry>;
  // A broken register is no saved pictures, not a failed request: the operator still falls back to Mapillary.
  try { list = await entries(root); } catch (e) { console.error('[street-pictures]', String((e as Error)?.message ?? e).slice(0, 200)); return null; }
  const entry = Object.hasOwn(list, imageId) ? list[imageId] : null;
  if (!entry || typeof entry.sha256 !== 'string') return null;
  const key = `${root}\n${imageId}`;
  let picture = pictures.get(key);
  if (!picture) {
    picture = readFile(path.join(root, 'street-pictures', `${imageId}.jpg`))
      .then(bytes => bytes.length === entry.bytes && createHash('sha256').update(bytes).digest('hex') === entry.sha256 ? bytes : null, () => null);
    pictures.set(key, picture);
  }
  return picture;
}
