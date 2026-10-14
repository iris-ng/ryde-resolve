// Photo fingerprints for the record check's near-duplicate photo match (spec Part 3). A fingerprint records how a photo
// looks, not its bytes: a re-saved, resized, lightly cropped or recoloured copy keeps almost the same fingerprint, where
// its SHA-256 changes completely. Pure code; no model reads the photo here.
import { decode } from 'jpeg-js';

/** The fingerprint method. Bump it if the method changes: fingerprints from two methods cannot be compared. */
export const fingerprintMethod = 'dhash-9x8-v2';
/** Bits out of 64 that may differ for two photos to count as near duplicates. Set from the evidence photos (see tests). */
export const nearDuplicateBits = 10;
export const fingerprintPattern = /^[0-9a-f]{16}$/;
// jpeg-js decodes on the web server's main thread at run start, inside the run's database transaction, so the work is
// bounded before decoding. Decode time grows with pixels times scans (about 0.7 s for a 12-megapixel single-scan photo,
// so the budget is about 2 s).
const maxMegapixels = 16, maxScans = 16, megapixelScans = 36;
/** FF DA byte pairs in b[from, to): a decoder cannot start a scan anywhere else. */
function scanMarkers(b: Uint8Array, from = 0, to = b.length) {
  let n = 0;
  for (let i = from; i + 1 < to; i++) if (b[i] === 0xff && b[i + 1] === 0xda) n++;
  return n;
}

/** The EXIF orientation (1 to 8) in an APP1 segment's payload; 1 when there is none or it cannot be read. */
function exifOrientation(seg: Uint8Array): number {
  if (seg.length < 14 || String.fromCharCode(...seg.subarray(0, 6)) !== 'Exif\0\0') return 1;
  const t = seg.subarray(6), little = t[0] === 0x49 && t[1] === 0x49;
  if (!little && !(t[0] === 0x4d && t[1] === 0x4d)) return 1;
  const u16 = (at: number) => little ? t[at]! | t[at + 1]! << 8 : t[at]! << 8 | t[at + 1]!;
  const u32 = (at: number) => (little ? t[at]! | t[at + 1]! << 8 | t[at + 2]! << 16 | t[at + 3]! << 24 : t[at]! << 24 | t[at + 1]! << 16 | t[at + 2]! << 8 | t[at + 3]!) >>> 0;
  if (t.length < 8 || u16(2) !== 42) return 1;
  const ifd = u32(4);
  if (ifd + 2 > t.length) return 1;
  for (let k = 0, count = u16(ifd); k < count; k++) {
    const at = ifd + 2 + k * 12;
    if (at + 12 > t.length) return 1;
    if (u16(at) === 0x0112) { const value = u16(at + 8); return value >= 1 && value <= 8 ? value : 1; }
  }
  return 1;
}

/**
 * Walks the JPEG's segments the way jpeg-js reads them, without decoding: frame size, number of scans and EXIF
 * orientation. jpeg-js reads frame, scan and restart headers field by field and ignores their stated length, so a length
 * that disagrees with the fields is refused, as is any segment jpeg-js does not know. Throws a short reason.
 */
function jpegLayout(b: Uint8Array) {
  let i = 2, width = 0, height = 0, scans = 0, orientation = 1, firstScan = -1;
  const u16 = (at: number) => b[at]! << 8 | b[at + 1]!;
  const malformed = () => new Error('the JPEG is malformed');
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) throw malformed();
    const marker = b[i + 1]!;
    if (marker === 0xff) { i++; continue; } // fill byte
    i += 2;
    if (marker === 0xd9) break; // end of image
    if (marker === 0x00) continue; // jpeg-js skips a stray FF 00
    if (i + 1 >= b.length) throw malformed();
    const length = u16(i), end = i + length;
    if (length < 2 || end > b.length) throw malformed();
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (width || length < 8 || length !== 8 + 3 * b[i + 7]!) throw malformed();
      height = u16(i + 3); width = u16(i + 5);
    } else if (marker === 0xc4) { // Huffman tables: 17 bytes plus the code count each, ending exactly at the length
      let at = i + 2;
      while (at < end) { let codes = 0; for (let k = 1; k <= 16; k++) codes += b[at + k] ?? 0; at += 17 + codes; }
      if (at !== end) throw malformed();
    } else if (marker === 0xdb) { // quantisation tables: 65 or 129 bytes each, ending exactly at the length
      let at = i + 2;
      while (at < end) { const precision = b[at]! >> 4; if (precision > 1) throw malformed(); at += precision ? 129 : 65; }
      if (at !== end) throw malformed();
    } else if (marker === 0xdd || marker === 0xdc) { if (length !== 4) throw malformed(); }
    else if (marker === 0xda) { if (length !== 6 + 2 * b[i + 2]!) throw malformed(); }
    else if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) { if (marker === 0xe1 && orientation === 1) orientation = exifOrientation(b.subarray(i + 2, end)); }
    else throw new Error('the JPEG uses a kind of segment the decoder does not read');
    i = end;
    if (marker === 0xda) {
      if (firstScan < 0) firstScan = i - length - 2;
      if (++scans > maxScans) throw new Error(`the JPEG has more than ${maxScans} scans`);
      // The scan's data runs to the next marker that is not a stuffed 0xff or a restart marker.
      while (i + 1 < b.length && !(b[i] === 0xff && b[i + 1] !== 0 && !(b[i + 1]! >= 0xd0 && b[i + 1]! <= 0xd7))) i++;
    }
  }
  if (!width || !height || !scans) throw new Error('the JPEG has no usable picture');
  // Up to the first scan this walk and jpeg-js read the same segments, so metadata there (an EXIF thumbnail with scans of
  // its own) is skipped by both. After it, jpeg-js can stop inside scan data and read on from there (its recovery paths),
  // so every scan marker from the first scan onward counts.
  return { width, height, scans, orientation, reachable: scanMarkers(b, firstScan) };
}

/**
 * A 64-bit difference hash as 16 hex characters: the photo as displayed (EXIF orientation applied), its brightness
 * averaged into 9 by 8 cells, then one bit per pair of neighbouring cells in a row (1 when the left cell is darker).
 * JPEG only, within the decode limits above. Throws a short reason otherwise.
 */
export function photoFingerprint(bytes: Uint8Array): string {
  if (!(bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) throw new Error('not a JPEG');
  // Every scan marker the decoder could reach counts, not only those this walk found; metadata it skips does not.
  const shape = jpegLayout(bytes), megapixels = shape.width * shape.height / 1e6, scans = Math.max(shape.scans, shape.reachable);
  if (megapixels > maxMegapixels) throw new Error(`the JPEG is too large to compare (${megapixels.toFixed(1)} megapixels)`);
  // The decoder enforces the pixel limit on every frame it reads, so the budget holds even if this walk misread the file.
  const allowed = Math.min(maxMegapixels, megapixelScans / scans);
  if (megapixels > allowed) throw new Error(`the JPEG would take too long to compare (${megapixels.toFixed(1)} megapixels, up to ${scans} scans)`);
  let image: { width: number; height: number; data: Uint8Array };
  try { image = decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: allowed, maxMemoryUsageInMB: 256 }); }
  catch { throw new Error('the JPEG could not be decoded'); }
  const { width: W, height: H, data } = image, o = shape.orientation;
  if (W !== shape.width || H !== shape.height || W < 9 || H < 8 || data.length !== W * H * 4) throw new Error('the JPEG has no usable picture');
  // Each stored pixel's cell in the displayed picture: orientations 5 to 8 swap the axes, and some flip one or both.
  const turned = o >= 5, across = turned ? H : W, down = turned ? W : H;
  const flipX = turned ? o === 6 || o === 7 : o === 2 || o === 3, flipY = turned ? o === 7 || o === 8 : o === 3 || o === 4;
  const xPart = new Int32Array(W), yPart = new Int32Array(H);
  for (let x = 0; x < W; x++) xPart[x] = turned ? Math.floor((flipY ? W - 1 - x : x) * 8 / down) * 9 : Math.floor((flipX ? W - 1 - x : x) * 9 / across);
  for (let y = 0; y < H; y++) yPart[y] = turned ? Math.floor((flipX ? H - 1 - y : y) * 9 / across) : Math.floor((flipY ? H - 1 - y : y) * 8 / down) * 9;
  const sums = new Float64Array(72), counts = new Float64Array(72);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const at = (y * W + x) * 4, cell = xPart[x]! + yPart[y]!;
    sums[cell]! += 0.299 * data[at]! + 0.587 * data[at + 1]! + 0.114 * data[at + 2]!;
    counts[cell]! += 1;
  }
  let bits = 0n;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const left = sums[r * 9 + c]! / counts[r * 9 + c]!, right = sums[r * 9 + c + 1]! / counts[r * 9 + c + 1]!;
    bits = (bits << 1n) | (left < right ? 1n : 0n);
  }
  return bits.toString(16).padStart(16, '0');
}

/** How many of the 64 bits differ between two fingerprints. */
export function fingerprintDistance(a: string, b: string): number {
  if (!fingerprintPattern.test(a) || !fingerprintPattern.test(b)) throw new Error('not a fingerprint');
  let x = BigInt('0x' + a) ^ BigInt('0x' + b), count = 0;
  for (; x; x &= x - 1n) count++;
  return count;
}
