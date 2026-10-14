import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { crc32 } from 'node:zlib';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { PhotoRef, Source } from '../agent-flow/contracts';

// Photo files for the examine step (spec Part 4, revision 11). A dataset's photo register may name a file beside
// dataset.json. The file is read only from inside the dispute folder, never through a link, only when its content is
// JPEG or PNG and its bytes match the recorded sha256. Bytes stay out of the text sources: the packet carries hashes.
export const photoLimits = { count: 3, bytes: 1_500_000, totalBytes: 6_000_000 } as const;
export type PhotoLimits = { count: number; bytes: number; totalBytes: number };
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
/** The media type by the file's first bytes; the file name is never trusted. */
export function sniffImage(bytes: Uint8Array): PhotoRef['mediaType'] | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)) return 'image/png';
  return null;
}
// Structure, with no image library: enough to refuse a file that only starts like an image. Sides from 16 to 4096 pixels.
export const imageSides = { min: 16, max: 4096 } as const;
type Shape = { mediaType: PhotoRef['mediaType']; width: number; height: number };
const sane = (width: number, height: number) => width >= imageSides.min && height >= imageSides.min && width <= imageSides.max && height <= imageSides.max;
/** PNG: the signature, IHDR first with sane dimensions, every chunk inside the file with a valid CRC, image data, and IEND last. */
function pngShape(b: Buffer): Shape | null {
  if (sniffImage(b) !== 'image/png') return null;
  let at = 8, width = 0, height = 0, data = false;
  while (at + 12 <= b.length) {
    const length = b.readUInt32BE(at), type = b.toString('latin1', at + 4, at + 8), end = at + 12 + length;
    if (length > 0x7fffffff || end > b.length || !/^[A-Za-z]{4}$/.test(type) || crc32(b.subarray(at + 4, at + 8 + length)) !== b.readUInt32BE(at + 8 + length)) return null;
    if (at === 8) { if (type !== 'IHDR' || length !== 13) return null; width = b.readUInt32BE(at + 8); height = b.readUInt32BE(at + 12); }
    else if (type === 'IHDR') return null;
    if (type === 'IDAT') data = true;
    if (type === 'IEND') return length === 0 && end === b.length && data && sane(width, height) ? { mediaType: 'image/png', width, height } : null;
    at = end;
  }
  return null;
}
const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
/** JPEG: SOI, segments that stay inside the file, one frame header with sane dimensions, a scan, and EOI as the last bytes. */
function jpegShape(b: Buffer): Shape | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let at = 2, width = 0, height = 0, scanned = false;
  while (at < b.length) {
    if (b[at] !== 0xff) return null;
    while (at < b.length && b[at] === 0xff) at++;
    if (at >= b.length) return null;
    const marker = b[at++];
    if (marker === 0xd9) return at === b.length && scanned && sane(width, height) ? { mediaType: 'image/jpeg', width, height } : null;
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    if (marker === 0x00 || marker === 0xd8 || at + 2 > b.length) return null;
    const length = b.readUInt16BE(at);
    if (length < 2 || at + length > b.length) return null;
    if (frameMarkers.has(marker)) { if (length < 8 || width) return null; height = b.readUInt16BE(at + 3); width = b.readUInt16BE(at + 5); }
    at += length;
    if (marker === 0xda) {
      if (!width) return null;
      scanned = true;
      // Entropy-coded data runs to the next real marker. Inside it, FF 00 is a stuffed byte, FF D0 to FF D7 restart the
      // scan, and any run of FF fill bytes may come before a marker; all three belong to the scan.
      for (;;) {
        while (at < b.length && b[at] !== 0xff) at++;
        let next = at + 1;
        while (next < b.length && b[next] === 0xff) next++;
        if (next >= b.length) return null;
        if (b[next] === 0x00 || (b[next] >= 0xd0 && b[next] <= 0xd7)) { at = next + 1; continue; }
        at = next - 1;
        break;
      }
    }
  }
  return null;
}
/** The image's type and size when its structure holds up; null for anything else, whatever its first bytes say. */
export function imageShape(bytes: Buffer): Shape | null {
  const type = sniffImage(bytes);
  return type === 'image/png' ? pngShape(bytes) : type === 'image/jpeg' ? jpegShape(bytes) : null;
}
// Plain relative names only: at most one folder level, no dot segments or hidden files, no URL, drive or absolute path,
// and never the folders that hold answer keys (expected/) or external originals (original/).
const safeName = /^(?!\.)[\w.-]{1,100}(?:\/(?!\.)[\w.-]{1,100})?$/;
export function photoFileName(file: unknown): string {
  if (typeof file !== 'string' || !safeName.test(file) || /^(expected|original)\//i.test(file) || !/\.(jpe?g|png)$/i.test(file)) throw new Error('Photo file name must be a plain .jpg, .jpeg or .png path inside the dispute folder: ' + JSON.stringify(String(file).slice(0, 80)));
  return file;
}
/** Read one photo file inside `folder` and verify it. Throws on any breach of the contract; never follows a link. */
export async function readPhotoFile(folder: string, file: string, expected: { sha256: string; maxBytes?: number }) {
  const name = photoFileName(file), maxBytes = expected.maxBytes ?? photoLimits.bytes;
  if (typeof expected.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expected.sha256)) throw new Error('Photo ' + name + ' needs a recorded sha256 of 64 lowercase hex characters');
  const root = await realpath(folder), target = path.join(root, name);
  // The real path must be the literal path under the real dispute folder: a link anywhere on the way is refused.
  // Limit: a local writer who swaps a parent folder for a link after this check is not stopped; the dispute folders are
  // read-only fixtures baked into the image, and anyone who can write there already controls the server.
  if (await realpath(target) !== target) throw new Error('Photo file must not be or pass through a link: ' + name);
  // Open once, without following a link and without blocking (a FIFO would block a plain open), then check that descriptor.
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('Photo must be a regular file: ' + name);
    if (info.size > maxBytes) throw new Error(`Photo ${name} is larger than ${maxBytes} bytes`);
    // Read at most the cap plus one byte from the same descriptor: a file that grows after the check is refused, not read in full.
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    for (let n = 1; n > 0 && size < buffer.length; size += n) n = (await handle.read(buffer, size, buffer.length - size, size)).bytesRead;
    if (size > maxBytes) throw new Error(`Photo ${name} is larger than ${maxBytes} bytes`);
    const bytes = Buffer.from(buffer.subarray(0, size));
    const mediaType = imageShape(bytes)?.mediaType;
    if (!mediaType) throw new Error('Photo must be a JPEG or PNG file by content (a well-formed image, sides 16 to 4096 pixels): ' + name);
    const digest = sha(bytes);
    if (digest !== expected.sha256) throw new Error('Photo bytes do not match the recorded sha256: ' + name);
    return { bytes, mediaType, sha256: digest, size: bytes.length };
  } finally { await handle.close(); }
}
/** Verify and pin the register's photos that carry bytes (`bytes_available: true`). Undefined when none do. */
export async function loadDatasetPhotos(folder: string, register: unknown, limits: PhotoLimits = photoLimits): Promise<PhotoRef[] | undefined> {
  if (register === undefined) return undefined;
  if (!Array.isArray(register)) throw new Error('The photos block must be an array');
  const withBytes = register.filter(p => p?.bytes_available === true);
  if (!withBytes.length) return undefined;
  if (withBytes.length > limits.count) throw new Error(`At most ${limits.count} photos with bytes per case`);
  const refs: PhotoRef[] = [];
  let total = 0;
  for (const entry of withBytes) {
    const photoId = entry.photo_id;
    if (typeof photoId !== 'string' || !/^[A-Za-z0-9._-]{1,40}$/.test(photoId) || refs.some(r => r.photoId === photoId)) throw new Error('Each photo needs a unique photo_id of up to 40 letters, digits, dots, dashes or underscores');
    const read = await readPhotoFile(folder, entry.filename, { sha256: entry.sha256, maxBytes: limits.bytes });
    total += read.size;
    if (total > limits.totalBytes) throw new Error(`Photos may hold at most ${limits.totalBytes} bytes in total`);
    refs.push({ photoId, sha256: read.sha256, mediaType: read.mediaType, bytes: read.size, file: entry.filename });
  }
  return refs;
}
/** Re-read a pinned photo for the examiner or the viewer: same contract, and it must still be the pinned file. */
export async function readPinnedPhoto(folder: string, ref: PhotoRef, limits: PhotoLimits = photoLimits) {
  const read = await readPhotoFile(folder, ref.file, { sha256: ref.sha256, maxBytes: limits.bytes });
  if (read.mediaType !== ref.mediaType || read.size !== ref.bytes) throw new Error('Photo ' + ref.photoId + ' no longer matches its pinned type and size');
  return read;
}
/** The evidence version: every source's ID and hash, then every pinned photo's ID and hash. Without photos it is unchanged. */
export const evidenceVersionOf = (sources: Pick<Source, 'id' | 'sha256'>[], photos?: Pick<PhotoRef, 'photoId' | 'sha256'>[]) =>
  sha(JSON.stringify([...sources.map(s => [s.id, s.sha256]), ...(photos ?? []).map(p => ['photo:' + p.photoId, p.sha256])]));
