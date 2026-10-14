// Server-side record check (spec Part 3, revisions 6 and 7). Computed once at run start from the raw dataset and the
// synthetic claims register, pinned as an `integrity_checked` event, and read by routing. Never on the packet or in a task.
// Only record matches route (an exact receipt or file, a settlement, or a photo that looks almost the same as one in an
// earlier claim); history is operator context and never routes. Missing context reads `unavailable`.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CasePacket } from '../agent-flow/contracts';
import type { IntegrityContext } from '../agent-flow/routing';
import { datasetVersion } from '../case-packet/dataset';
import { elementLines, keyLines, readRawDataset, registersRoot, verifiedFile, type Citation } from './raw-dataset';
import { fingerprintDistance, fingerprintMethod, fingerprintPattern, nearDuplicateBits, photoFingerprint } from './photo-fingerprint';
import { historyContext, type HistoryLine } from './history-checks';

/** The pin and result shape (`packet.integrity.version`, the event's `version`). Pinned packets carry it; do not bump it for a predicate change. */
export const integrityVersion = 1;
/**
 * The version of the record-check predicates (checkRecords, the payment and hold rules, record validation). It is recorded
 * on every integrity_checked event and is part of the panel's configuration fingerprint: bump it when a predicate changes.
 */
export const integrityPredicateVersion = '2026-10-03.2';
export const matchLabel = 'a record match for review, not a finding about any person';
/**
 * A receipt key is issuer plus receipt number; a file key is the sha256 of verified bytes; a photo hash is the fingerprint
 * of how a photo looks (photo-fingerprint.ts, method named once in the register). `createdAt` is when the entry entered the register.
 * `riderId`, `driverId` and `type` (the dispute type) name the trip's people and the kind of claim for the past-behaviour patterns
 * (facts 7, case-packet/earlier-claims.ts; MVP fixes, second release, 10 October 2026). No check here reads them.
 */
export type RegisterEntry = { claimId: string; tripId: string; createdAt: string; recipient: 'rider' | 'driver'; riderId?: string; driverId?: string; type?: string; status: 'settled' | 'partial' | 'pending' | 'rejected'; amountCents: number; receiptKeys: string[]; fileSha256s: string[]; photoHashes?: string[] };
export type ClaimsRegister = { version: 1; synthetic: true; note?: string; photoHashMethod?: typeof fingerprintMethod; entries: RegisterEntry[] };
export type RecordMatch = { check: 'receipt_reuse' | 'file_reuse' | 'photo_near_duplicate' | 'already_settled'; text: string; innocentReading: string; label: typeof matchLabel; citations: Citation[]; register?: { claimId: string; createdAt: string } };
/** Operator-only account history (history-checks.ts, where the past-behaviour facts read the same numbers). Context, never a routing trigger. */
export type { HistoryLine };
/** What the `integrity_checked` event carries. Routing reads only `status` and each match's check, text and innocent reading. */
export type IntegrityResult = Omit<IntegrityContext, 'matches'> & { matches: RecordMatch[]; notes: string[]; history?: HistoryLine[]; predicateVersion?: string; reusedFrom?: { runId: string; seq: number } };
export type FileKey = { sha256: string; label: string; citations: Citation[] };
/** A verified photo's fingerprint, compared with the photo hashes of earlier claims. */
export type PhotoPrint = FileKey & { photoId: string; fingerprint: string };
/** A photo with no fingerprint: `named` when the dataset names a file that could not be verified or read. */
export type PhotoGap = { photoId: string; reason: string; named: boolean };

export const registerPath = () => process.env.EVIDENCE_REGISTER ?? path.join(registersRoot(), 'claims-register.json');
/** The issuer ignores case and runs of spaces; the receipt number is exact after trimming its ends (spec revision 7). */
export const receiptKey = (issuer: string, number: string) => `${issuer.trim().replace(/\s+/g, ' ').toLowerCase()}|${number.trim()}`;
const zoned = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):(\d{2}))$/;
/** Milliseconds for an ISO time that names its time zone and is a real calendar time; null otherwise (never rolled over). */
export function zonedTime(value: unknown) {
  const m = typeof value === 'string' ? zoned.exec(value) : null;
  if (!m) return null;
  const [year, month, day, hour, minute, second, offsetHours, offsetMinutes] = m.slice(1).map(v => Number(v ?? 0)) as number[];
  const daysInMonth = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
  if (month! < 1 || month! > 12 || day! < 1 || day! > daysInMonth || hour! > 23 || minute! > 59 || second! > 59 || offsetHours! > 14 || offsetMinutes! > 59) return null;
  const time = Date.parse(value as string);
  return Number.isNaN(time) ? null : time;
}
const entrySchema = z.object({
  claimId: z.string().min(1).max(80), tripId: z.string().min(1).max(80), createdAt: z.string().refine(v => zonedTime(v) !== null, 'an ISO time with a time zone'),
  recipient: z.enum(['rider', 'driver']), riderId: z.string().min(1).max(80).optional(), driverId: z.string().min(1).max(80).optional(), type: z.string().regex(/^[a-z_]{1,40}$/).optional(),
  status: z.enum(['settled', 'partial', 'pending', 'rejected']), amountCents: z.number().int().min(0),
  receiptKeys: z.array(z.string().min(3).max(300).refine(k => { const [issuer, number, extra] = k.split('|'); return !!issuer && !!number && extra === undefined && receiptKey(issuer, number) === k; }, 'a canonical receiptKey(issuer, number)')).max(20),
  fileSha256s: z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(20),
  photoHashes: z.array(z.string().regex(fingerprintPattern)).max(20).optional(),
}).strict();
// Fingerprints from another method cannot be compared, so a register that names any other method is unreadable.
const registerSchema = z.object({ version: z.literal(1), synthetic: z.literal(true), note: z.string().max(600).optional(), photoHashMethod: z.literal(fingerprintMethod).optional(), entries: z.array(entrySchema) }).strict();
/** Throws a short reason. A register that fails any rule is unreadable, so the check reads `unavailable`. */
export function parseRegister(text: string): ClaimsRegister {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('the claims register is not valid JSON'); }
  const parsed = registerSchema.safeParse(value);
  if (!parsed.success) { const issue = parsed.error.issues[0]!; throw new Error(`the claims register is malformed at ${issue.path.join('.') || 'the top level'}: ${issue.message}`); }
  const ids = parsed.data.entries.map(e => e.claimId);
  if (new Set(ids).size !== ids.length) throw new Error('the claims register lists a claim twice');
  if (!parsed.data.photoHashMethod && parsed.data.entries.some(e => e.photoHashes?.length)) throw new Error('the claims register lists photo fingerprints without naming how they were made');
  return parsed.data as ClaimsRegister;
}
export async function loadRegister(file = registerPath()) {
  let text: string;
  try { text = await readFile(file, 'utf8'); } catch { throw new Error('the claims register is missing'); }
  return { register: parseRegister(text), sha256: createHash('sha256').update(text).digest('hex'), text };
}

/** Payment types that can settle a claim. Vouchers and wallet credits that name no claim are skipped outright: a driver's fare payout is a wallet credit. */
const settlementTypes = ['refund', 'reversal', 'voucher_issued', 'wallet_credit'], creditTypes = ['voucher_issued', 'wallet_credit'];
const sgd = (cents: number) => `SGD ${(cents / 100).toFixed(2)}`;
const str = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;
const innocent = {
  receipt_reuse: 'A shop can reuse a receipt number or template, and one receipt can honestly support two related claims; a person compares both originals.',
  file_reuse: 'The same person may have sent a file again by mistake, or both claims used a shared template or image; a person compares both claims.',
  photo_near_duplicate: 'Photos of the same seat taken minutes apart, or one photo sent again after resizing or editing, look almost the same; so can photos of similar plain surfaces. A person compares both photos side by side.',
  already_settled: 'The earlier settlement may have paid for a different charge on the same trip, or the claim may have been filed before the claimant saw it; a person checks what it covered.',
};
/** Line citation for one register entry (the committed register keeps one entry per line). */
function registerCitation(text: string | undefined, claimId: string): Citation[] {
  const at = text?.split('\n').findIndex(l => new RegExp(`"claimId"\\s*:\\s*${JSON.stringify(claimId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(l)) ?? -1;
  return at < 0 ? [] : [{ sourceId: 'register/claims-register.json', startLine: at + 1, endLine: at + 1 }];
}
// The fields the checks read, typed. Other fields pass through untouched. Required keys that a semantic check reports more
// clearly (claim ID, filing time, claimant, trip) are left to those checks.
const text = z.string().optional();
const recordShapes = {
  dispute_ticket: z.object({ dispute_id: text, trip_id: text, filed_by: text, filed_at: text, requested_remedy: z.object({ amount: z.number().optional() }).passthrough().nullable().optional() }).passthrough(),
  trip_data: z.object({ trip_id: text }).passthrough(),
  documents: z.object({ document_id: z.string(), kind: z.string(), filename: text, file: text, sha256: text, extracted_fields: z.record(z.string(), z.unknown()).optional() }).passthrough(),
  receipt: z.object({ company: text, issuer: text, merchant: text, receipt_number: text, receipt_no: text, invoice_number: text }).passthrough(),
  photos: z.object({ photo_id: z.string(), filename: text, file: text, sha256: text }).passthrough(),
  app_events: z.object({ event_type: text, data: z.object({ claim_id: text }).passthrough().optional() }).passthrough(),
  payment_events: z.object({ timestamp: z.string(), type: z.string(), amount: z.number(), status: z.string(), counterparty: text, reference: text, trip_id: text, claim_id: text, dispute_id: text,
    original_reference: text, original_transaction: text, reverses: text, refers_to: text, original_type: text, note: text, description: text }).passthrough(),
};
/** Throws a short reason naming the record when a block or record the checks read cannot be read: never read as empty or clean. */
export function assertReadable(data: any) {
  const plain = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);
  const check = (where: string, schema: z.ZodTypeAny, value: unknown) => { const r = schema.safeParse(value); if (!r.success) { const issue = r.error.issues[0]!; throw new Error(`record ${where} cannot be read (${issue.path.join('.') || 'the record'}: ${issue.message})`); } };
  if (!plain(data)) throw new Error('the raw dataset has the wrong shape');
  if (!plain(data.dispute_ticket)) throw new Error('the dispute_ticket block is missing or has the wrong shape');
  check('dispute_ticket', recordShapes.dispute_ticket, data.dispute_ticket);
  if (data.trip_data !== undefined) { if (!plain(data.trip_data)) throw new Error('the trip_data block has the wrong shape'); check('trip_data', recordShapes.trip_data, data.trip_data); }
  // A block that is present must be a list of readable records: read as an empty list, a malformed block would read clean.
  for (const block of ['documents', 'photos', 'app_events', 'payment_events'] as const) {
    if (data[block] === undefined) continue;
    if (!Array.isArray(data[block])) throw new Error(`the ${block} block has the wrong shape`);
    data[block].forEach((record: unknown, i: number) => {
      if (!plain(record)) throw new Error(`the ${block} block has the wrong shape (record ${block}[${i}] is not a record)`);
      check(`${block}[${i}]`, recordShapes[block], record);
      const doc = record as { kind?: string; extracted_fields?: unknown };
      if (block === 'documents' && (doc.kind === 'receipt' || doc.kind === 'invoice') && doc.extracted_fields !== undefined) check(`${block}[${i}]`, recordShapes.receipt, doc.extracted_fields);
    });
  }
}
/**
 * The two record-match checks on a raw dataset (pure). Revision 7: a match needs a different claim ID and a register
 * entry created before this dispute was filed. Throws a short reason when a fact the checks need is missing.
 */
export function checkRecords(data: any, register: ClaimsRegister, options: { verified?: FileKey[]; prints?: PhotoPrint[]; photoGaps?: PhotoGap[]; registerText?: string } = {}): { matches: RecordMatch[]; notes: string[] } {
  assertReadable(data);
  const ticket = data.dispute_ticket, matches: RecordMatch[] = [], notes: string[] = [];
  const claimId = str(ticket.dispute_id), tripId = str(ticket.trip_id) ?? str(data?.trip_data?.trip_id), filed = zonedTime(ticket.filed_at);
  if (!claimId) throw new Error('the dispute has no claim ID');
  if (!tripId) throw new Error('the dispute names no trip');
  if (filed === null) throw new Error('the filing time is missing or has no time zone, so the look-back cannot be applied');
  const recipient = ticket.filed_by === 'rider' || ticket.filed_by === 'driver' ? ticket.filed_by as 'rider' | 'driver' : null;
  if (!recipient) throw new Error('the claimant is not recorded as the rider or the driver');
  const amount = ticket.requested_remedy?.amount, claimedCents = typeof amount === 'number' && Number.isFinite(amount) ? Math.round(amount * 100) : null;
  const filedLines = keyLines('dispute_ticket', ticket, 'filed_at'), ticketCite = (key: string) => [keyLines('dispute_ticket', ticket, key), filedLines].filter((c): c is Citation => !!c);
  // This claim's own IDs: the dispute ID and the claim ID its claim-submitted event records (a cleaning claim has both). A
  // register row or payment naming any of them is this claim, never "a different claim" (revision 7).
  const own = new Set([claimId, ...(data.app_events ?? []).filter((e: any) => /claim_submitted$/.test(e.event_type ?? '')).map((e: any) => str(e.data?.claim_id)).filter(Boolean)]);
  const earlier = register.entries.filter(e => !own.has(e.claimId) && (zonedTime(e.createdAt) ?? Infinity) < filed);
  const match = (check: RecordMatch['check'], text: string, citations: Citation[], e?: RegisterEntry) => matches.push({ check, text, innocentReading: innocent[check], label: matchLabel, citations: [...citations, ...(e ? registerCitation(options.registerText, e.claimId) : [])], ...(e ? { register: { claimId: e.claimId, createdAt: e.createdAt } } : {}) });
  const documents: any[] = data.documents ?? [], photos: any[] = data.photos ?? [];
  // Receipt reuse: third-party receipts and invoices only; Ryde's own trip receipt is shared by every claim on a trip.
  documents.forEach((doc, i) => {
    if (doc?.kind !== 'receipt' && doc?.kind !== 'invoice') return;
    const fields = doc.extracted_fields ?? {}, issuer = str(fields.company) ?? str(fields.issuer) ?? str(fields.merchant), number = str(fields.receipt_number) ?? str(fields.receipt_no) ?? str(fields.invoice_number);
    if (!issuer || !number) { notes.push(`${doc.document_id ?? 'A receipt'} has no ${issuer ? 'receipt number' : 'issuer'}, so it can be matched by file hash only.`); return; }
    const key = receiptKey(issuer, number);
    for (const e of earlier.filter(e => e.receiptKeys.includes(key)))
      match('receipt_reuse', `Receipt ${number} from ${issuer} (${doc.document_id}) is also listed in the register under claim ${e.claimId}, entered ${e.createdAt}, before this dispute was filed.`, [elementLines('documents', documents, i), ...(filedLines ? [filedLines] : [])], e);
  });
  // File reuse: only hashes of verified bytes are keys. A recorded hash is a claim about a file, not a file.
  const verified = new Map((options.verified ?? []).map(f => [f.sha256, f]));
  for (const f of verified.values())
    for (const e of earlier.filter(e => e.fileSha256s.includes(f.sha256)))
      match('file_reuse', `File ${f.label} has the same SHA-256 as a file in claim ${e.claimId}, entered ${e.createdAt}, before this dispute was filed.`, [...f.citations, ...(filedLines ? [filedLines] : [])], e);
  // Near-duplicate photos (revision 22): a verified photo whose fingerprint is within nearDuplicateBits of a photo in an
  // earlier claim. An entry that lists the same bytes is already a file match, so it is not listed twice. When earlier
  // claims hold fingerprints, a named photo that could not be read means the comparison did not run: unavailable, never
  // clean. A photo with no file at all is a note, like a receipt with no number.
  if (earlier.some(e => e.photoHashes?.length)) {
    const unread = (options.photoGaps ?? []).filter(g => g.named);
    if (unread.length) throw new Error(unread.map(g => `photo ${g.photoId} could not be compared with photos in earlier claims (${g.reason})`).join('; '));
    for (const g of options.photoGaps ?? []) notes.push(`${g.photoId} has no photo file, so it was not compared with photos in earlier claims.`);
  }
  for (const p of options.prints ?? []) for (const e of earlier) {
    if (!e.photoHashes?.length || e.fileSha256s.includes(p.sha256)) continue;
    const bits = Math.min(...e.photoHashes.map(h => fingerprintDistance(p.fingerprint, h)));
    if (bits <= nearDuplicateBits)
      match('photo_near_duplicate', `Photo ${p.label} looks almost the same as a photo in claim ${e.claimId}, entered ${e.createdAt}, before this dispute was filed: their fingerprints differ in ${bits} of 64 points, and ${nearDuplicateBits} or fewer counts as almost the same.`, [...p.citations, ...(filedLines ? [filedLines] : [])], e);
  }
  const recorded = [...documents.map(d => [d?.document_id, d?.sha256]), ...photos.map(p => [p?.photo_id, p?.sha256])].filter(([, h]) => typeof h === 'string' && !verified.has(h));
  for (const [id, hash] of recorded) for (const e of earlier.filter(e => e.fileSha256s.includes(hash)))
    notes.push(`${id}'s recorded hash is listed under claim ${e.claimId}, but its bytes were not verified here, so it is not a record match.`);
  // Already settled: same trip and recipient, settled for at least the claimed amount. Partial, pending or short settlements are notes.
  // Declined red-team finding: an earlier settlement on the same trip for a different charge also matches. That is the predicate
  // revision 7 fixed (same trip, same recipient, settled, at least the claimed amount); the match carries an innocent reading and
  // a person compares the two claims. The register is synthetic and its entries are ours.
  for (const e of earlier.filter(e => e.tripId === tripId && e.recipient === recipient)) {
    if (e.status === 'rejected') continue;
    if (e.status === 'settled' && claimedCents !== null && e.amountCents >= claimedCents)
      match('already_settled', `The register shows claim ${e.claimId} on the same trip (${tripId}) settled to the ${recipient} for ${sgd(e.amountCents)}, at least the ${sgd(claimedCents)} claimed here, entered ${e.createdAt}, before this dispute was filed.`, ticketCite('requested_remedy'), e);
    else notes.push(`Claim ${e.claimId} on the same trip is ${e.status} to the ${recipient} for ${sgd(e.amountCents)}${claimedCents === null ? '; this claim states no amount to compare' : e.status === 'settled' ? `, less than the ${sgd(claimedCents)} claimed here` : ''}. A note, not a record match.`);
  }
  // Settlements in the payment record. Types alone are too ambiguous (a partial repayment, a released card hold), so an
  // event matches only when it names this claim, reaches the claimant, is settled, before filing, for at least the claimed
  // amount, and does not release a hold. A dataset records one trip: no trip_id means this trip; another trip is ignored.
  const payments: any[] = data.payment_events ?? [];
  const holds = new Set(payments.filter(p => p.type === 'authorization').map(p => str(p.reference)).filter((r): r is string => !!r));
  const holdRef = (v: unknown) => { const r = str(v); return !!r && (holds.has(r) || /^(auth|hold|pre-?auth)\b/i.test(r)); };
  const releasesHold = (p: any) => [p.reference, p.original_reference, p.original_transaction, p.reverses, p.refers_to].some(holdRef)
    || /^(authori[sz]ation|hold|pre-?auth)/i.test(str(p.original_type) ?? '') || /\b(hold|pre-?auth\w*|authori[sz]ation)\b/i.test(`${p.note ?? ''} ${p.description ?? ''}`);
  payments.forEach((p, i) => {
    const namesClaim = [p.claim_id, p.dispute_id, p.reference].some(v => own.has(str(v) ?? ''));
    // An event that names this claim is judged on its recipient; one with no usable recipient cannot be judged, so never reads clean.
    if (namesClaim && !['rider', 'driver', 'platform'].includes(p.counterparty)) throw new Error(`record payment_events[${i}] names this claim but has no usable recipient (counterparty)`);
    if (!settlementTypes.includes(p.type) || p.counterparty !== recipient || (p.status !== 'settled' && p.status !== 'pending')) return;
    const trip = str(p.trip_id);
    if (trip !== null && trip !== tripId) return; // another trip's settlement: nothing
    if (releasesHold(p)) return; // releasing a card hold repays nothing: nothing
    if (!namesClaim && creditTypes.includes(p.type)) return; // a voucher or credit that names no claim, such as a fare payout: nothing
    const at = zonedTime(p.timestamp);
    if (at === null) throw new Error('a settlement in the payment record has no usable time');
    const cents = Math.round(p.amount * 100);
    const what = `${p.status} ${p.type.replace('_', ' ')} of ${sgd(cents)} to the ${recipient}${p.reference ? ` (${p.reference})` : ''}`;
    // An unnamed refund or reversal before filing may be a partial repayment of something else: shown, never routed.
    if (!namesClaim) { if (at < filed) notes.push(`The payment record shows a ${what} on this trip before filing; it does not name this claim. A note, not a record match.`); return; }
    const short = [at >= filed ? 'is dated after this dispute was filed' : '', p.status !== 'settled' ? 'is pending' : '',
      claimedCents === null ? 'cannot be compared because this claim states no amount' : cents < claimedCents ? `is less than the ${sgd(claimedCents)} claimed here` : ''].filter(Boolean);
    if (!short.length) match('already_settled', `The payment record shows a ${what} naming this claim, on this trip (${tripId}) at ${p.timestamp}, before this dispute was filed, at least the ${sgd(claimedCents!)} claimed here.`, [elementLines('payment_events', payments, i), ...ticketCite('requested_remedy')]);
    else notes.push(`The payment record shows a ${what} naming this claim; it ${short.join(', ')}. A note, not a record match.`);
  });
  return { matches, notes };
}
export { historyContext };
/**
 * Hashes of bytes verified here: files beside the raw dataset (photos included) and uploaded originals, which the server
 * hashed itself. A photo the loader pinned (`packet.photos`) is a key only when its own dataset entry and a file in the
 * dispute folder verify to the same hash; otherwise it is a note, never a key.
 */
async function verifiedFiles(data: any, folder: string, packet: Pick<CasePacket, 'sources' | 'photos'>): Promise<{ keys: FileKey[]; prints: PhotoPrint[]; photoGaps: PhotoGap[]; notes: string[] }> {
  const keys: FileKey[] = [], prints: PhotoPrint[] = [], notes: string[] = [], photoKeys = new Map<string, string>(), why = new Map<string, string>();
  const add = (key: FileKey) => { if (!keys.some(k => k.sha256 === key.sha256)) keys.push(key); };
  // Only verified photo bytes get a fingerprint; `why` keeps the last reason a photo got none. Gaps are worked out below.
  const print = (photoId: string, key: FileKey, bytes: Buffer) => {
    if (prints.some(p => p.sha256 === key.sha256)) return;
    try { prints.push({ ...key, photoId, fingerprint: photoFingerprint(bytes) }); }
    catch (e) { why.set(photoId, e instanceof Error ? e.message : 'the photo could not be read'); }
  };
  const quiet = ['no bytes', 'no recorded hash', 'no file name'];
  const photos: any[] = Array.isArray(data?.photos) ? data.photos : [];
  for (const block of ['documents', 'photos'] as const) {
    const items: any[] = Array.isArray(data?.[block]) ? data[block] : [];
    for (const [i, item] of items.entries()) {
      const id = item?.document_id ?? item?.photo_id, names = [...new Set([item?.filename, item?.file].filter((n): n is string => typeof n === 'string' && !!n))];
      let reason: string | undefined;
      for (const name of names) {
        const result = await verifiedFile(folder, name, item.sha256);
        if (result.ok) {
          const key = { sha256: result.sha256, label: `${id} (${name})`, citations: [elementLines(block, items, i)] };
          add(key); if (block === 'photos') { photoKeys.set(item.photo_id, result.sha256); print(id, key, result.data); }
          reason = undefined; break;
        }
        if (!quiet.includes(result.reason)) reason ??= result.reason;
        if (block === 'photos') why.set(item.photo_id, result.reason);
      }
      if (reason) notes.push(`${id}: ${reason}; not used as a file key.`);
    }
  }
  for (const photo of packet.photos ?? []) {
    const i = photos.findIndex(p => p?.photo_id === photo.photoId);
    if (i >= 0 && photoKeys.get(photo.photoId) === photo.sha256) continue;
    if (i >= 0 && typeof photo.file === 'string') {
      const result = await verifiedFile(folder, photo.file, photos[i].sha256);
      if (result.ok && result.sha256 === photo.sha256) { const key = { sha256: result.sha256, label: `${photo.photoId} (${path.basename(photo.file)})`, citations: [elementLines('photos', photos, i)] }; add(key); print(photo.photoId, key, result.data); continue; }
    }
    notes.push(`${photo.photoId}: the pinned photo could not be verified against its dataset entry and a file in the dispute folder; not used as a file key.`);
  }
  // A photo with no fingerprint: every dataset photo entry, and every pinned photo (the bytes the agents see).
  // Two photo entries with the same bytes share one print, so either one counts as compared.
  const photoGaps: PhotoGap[] = [], printed = (photoId: string) => prints.some(p => p.photoId === photoId || (photoKeys.has(photoId) && p.sha256 === photoKeys.get(photoId)));
  for (const item of photos) {
    // A photo the dataset says has no bytes, or that names no file, is described only: a note. Any other is a named photo.
    const id = String(item?.photo_id ?? 'A photo'), named = item?.bytes_available !== false && [item?.filename, item?.file].some(n => typeof n === 'string' && !!n);
    if (!printed(id)) photoGaps.push({ photoId: id, reason: named ? why.get(id) ?? 'the photo could not be read' : 'no photo bytes are supplied', named });
  }
  // A pinned photo is bytes the agents see: without a print it is always a named gap, even if its entry is described only.
  for (const photo of packet.photos ?? []) {
    if (prints.some(p => p.sha256 === photo.sha256)) continue;
    const gap = { photoId: photo.photoId, reason: why.get(photo.photoId) ?? 'the pinned photo could not be verified and read', named: true }, at = photoGaps.findIndex(g => g.photoId === photo.photoId);
    if (at < 0) photoGaps.push(gap); else if (!photoGaps[at]!.named) photoGaps[at] = gap;
  }
  for (const s of packet.sources.filter(s => s.id.startsWith('uploads/')))
    add({ sha256: s.sha256, label: s.id.split('/').at(-1)!, citations: [{ sourceId: s.id, startLine: 1, endLine: Math.max(1, s.lines.length) }] });
  return { keys, prints, photoGaps, notes };
}
/** Null when the run does not include the check (no `packet.integrity`). A configured check that cannot run reads `unavailable`, never clean. */
export async function integrityContext(packet: Pick<CasePacket, 'integrity' | 'caseId' | 'sources' | 'photos' | 'evidenceChecks'>, options: { registerFile?: string } = {}): Promise<IntegrityResult | null> {
  if (!packet.integrity) return null;
  const unavailable = (error: string, registerSha256: string | null = null): IntegrityResult => ({ status: 'unavailable', version: integrityVersion, predicateVersion: integrityPredicateVersion, registerSha256, matches: [], notes: [], error });
  if (packet.integrity.version !== integrityVersion) return unavailable('this record-check version is not known');
  const reason = (e: unknown) => e instanceof Error ? e.message : 'the record check failed';
  let loaded: Awaited<ReturnType<typeof loadRegister>>;
  try { loaded = await loadRegister(options.registerFile); } catch (e) { return unavailable(reason(e)); }
  try {
    const raw = await readRawDataset(packet), files = await verifiedFiles(raw.data, raw.folder, packet);
    const { matches, notes } = checkRecords(raw.data, loaded.register, { verified: files.keys, prints: files.prints, photoGaps: files.photoGaps, registerText: loaded.text });
    return { status: 'checked', version: integrityVersion, predicateVersion: integrityPredicateVersion, registerSha256: loaded.sha256, matches, notes: [...files.notes, ...notes], history: historyContext(raw.data) };
  } catch (e) { return unavailable(reason(e), loaded.sha256); }
}
/**
 * A Judge-only retry carries its parent's pinned record check (register hash included) instead of running it again, so the
 * same evidence keeps the same hold even if the register changed since. `reusedFrom` tells a carried result from a fresh one.
 * Undefined when the parent recorded no check (older runs replay unchanged). A parent result that cannot be read is carried
 * as unavailable: never replaced by a fresh, possibly clean, check.
 */
export function parentIntegrity(events: { kind?: unknown; seq?: unknown; data?: unknown; [field: string]: unknown }[], parentRunId: string): IntegrityResult | undefined {
  const event = [...events].reverse().find(e => e?.kind === 'integrity_checked');
  if (!event) return undefined;
  const reusedFrom = { runId: parentRunId, seq: Number(event.seq) }, data = event.data as Partial<IntegrityResult> | null | undefined;
  const readable = !!data && typeof data === 'object' && ['checked', 'unavailable', 'not_configured'].includes(data.status as string) && Array.isArray(data.matches) && typeof data.version === 'number';
  if (!readable) return { status: 'unavailable', version: integrityVersion, registerSha256: null, matches: [], notes: [], error: 'the parent run\'s record-check result could not be read', reusedFrom };
  const { reusedFrom: _earlier, ...result } = data as IntegrityResult;
  return { ...result, notes: result.notes ?? [], reusedFrom };
}
/** Dataset cases (built from a dataset.json) include the record check; sample packs and custom cases do not. */
export const isDatasetCase = (packet: Pick<CasePacket, 'datasetVersion' | 'sources'>) => packet.datasetVersion === datasetVersion && packet.sources.some(s => s.id === 'evidence/dispute_ticket.json');
/** The run-start pin for the live store: spread into the packet before it is hashed. */
export const integrityPin = (packet: Pick<CasePacket, 'datasetVersion' | 'sources'>): { integrity?: { version: 1 } } => isDatasetCase(packet) ? { integrity: { version: integrityVersion } } : {};
/**
 * The run-start pin for the CLI runners. A fresh run on a dataset case includes the record check. A Judge retry mirrors
 * its parent's pinned packet, so a recording made before the check replays unchanged (judgeRetry needs identical packets).
 */
export async function pinIntegrity<T extends CasePacket>(packet: T, retry: { output: string; parentRunId?: string }): Promise<T> {
  const { integrity: _existing, ...rest } = packet;
  if (retry.parentRunId === undefined) return { ...rest, ...integrityPin(packet) } as T;
  if (!/^[a-f0-9-]{36}$/.test(retry.parentRunId)) return packet; // the runner refuses an invalid parent itself
  const parent = await readFile(path.join(retry.output, retry.parentRunId, 'packet.json'), 'utf8').then(text => JSON.parse(text) as Partial<CasePacket>, () => null);
  return (parent?.integrity ? { ...rest, integrity: parent.integrity } : rest) as T;
}
