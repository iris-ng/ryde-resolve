import type { CasePacket } from '../agent-flow/contracts';
import type { Cite, Fact } from '../agent-flow/facts';
import { photoReadingsSchema, type PhotoReading } from '../agent-flow/photo-schema';

// Two facts about the pinned photo reading alone (spec revision 23). They summarise what the Photo Examiner's fixed codes
// say the photos show, for every agent through read_calculations, and never route. They never read the claim's words:
// three review rounds showed free-text reading of a claim cannot be made safe with word rules, so the comparison with what
// the claim says is left to the Judge, who reads the claim. Each says "unavailable" unless every photo supports a value.
// The reading is parsed with the examiner's own schema (photo-schema.ts) before any rule applies.

type CiteFn = (block: string, needle?: string) => Cite;
const cabinAreas = new Set(['rear_seat', 'front_seat', 'floor', 'door', 'boot']);
const of = (p: PhotoReading, kind: string) => p.observations.filter(o => o.kind === kind);
const either = (items: string[], last = 'or') => items.length > 1 ? `${items.slice(0, -1).join(', ')} ${last} ${items.at(-1)}` : items.join('');

/**
 * A plate photo is set aside only on affirmative evidence that it shows no part of the cabin. The reading has no "outside
 * the car" code, so all of these must hold: the uploader's register records it as showing the plate (shows_vehicle_plate
 * true); it was examined; plate_visible is yes and plate_text is read, both at clear visibility; location_in_cabin is given
 * and every value is "other" at clear visibility; it has no mess_visible or mark_visible observation; and cannotDetermine
 * lists mess_visible.
 */
export function plateOnly(p: PhotoReading, register: { photo_id: string; [key: string]: unknown }[]) {
  return p.status === 'examined' && register.find(r => r?.photo_id === p.photoId)?.shows_vehicle_plate === true
    && of(p, 'plate_visible').length > 0 && of(p, 'plate_visible').every(o => o.value === 'yes' && o.visibility === 'clear') && of(p, 'plate_text').length > 0 && of(p, 'plate_text').every(o => o.visibility === 'clear')
    && of(p, 'location_in_cabin').length > 0 && of(p, 'location_in_cabin').every(o => o.value === 'other' && o.visibility === 'clear')
    && !of(p, 'mess_visible').length && !of(p, 'mark_visible').length && p.cannotDetermine.includes('mess_visible');
}

type Rule = { id: string; allowed: readonly string[]; base: string; need: (compared: PhotoReading[]) => string | null };
const rules: Rule[] = [
  {
    id: 'photos_show_only_dry_debris', allowed: ['crumbs', 'hair', 'none'],
    base: 'True when every pinned photo was read, every photo not set aside was examined and read clearly, at least one shows mess crumbs or hair, and no photo shows any other mess code or any mark code at any visibility; false when an examined photo shows another mess code (wet_patch, stain, solid_debris, dirt or other) or any mark (stain, scratch, tear, discolouration or other) clearly or partly; otherwise unavailable.',
    need: compared => compared.some(p => of(p, 'mess_visible').some(o => o.value === 'crumbs' || o.value === 'hair')) ? null : 'no photo shows crumbs or hair',
  },
  {
    id: 'photos_show_no_mess', allowed: ['none'],
    base: 'True when every pinned photo was read, every photo not set aside was examined, read clearly and shows mess code none with no mark, and at least one clearly shows a part of the cabin (rear_seat, front_seat, floor, door or boot); false when an examined photo shows any mess code other than none, or any mark, clearly or partly; otherwise unavailable.',
    need: compared => compared.some(p => of(p, 'location_in_cabin').some(o => cabinAreas.has(o.value) && o.visibility === 'clear')) ? null : 'no photo clearly shows a part of the cabin',
  },
];
const common = 'The photo reading is a model reading of appearance in fixed codes; it never names a substance or a cause. A photo is set aside only as a plate photo: recorded by the uploader as showing the plate, with the plate read clearly, placed only at "other" (no part of the cabin) and no mess or mark readable. A description of the photos for review, not a finding about anyone: photos taken after a partial clean, the angle or the lighting, or a mess outside the frame can look the same.';
const closing = 'This describes the photos only; compare it with what the claim says was there.';

/** Both facts, from the pinned register and the pinned reading (derived/photos.json) only. Emitted whatever the reading, so the fact IDs depend on the pinned packet alone. */
export function photoReadingFacts(packet: Pick<CasePacket, 'photos' | 'sources'>, registerBlock: unknown, cite: CiteFn): Fact[] {
  const pinned = packet.photos ?? [], reading = packet.sources.find(s => s.id === 'derived/photos.json'), hasRegister = packet.sources.some(s => s.id === 'evidence/photos.json');
  const citations: Cite[] = [...(hasRegister ? [cite('photos')] : []), ...(reading ? [{ sourceId: reading.id, startLine: 1, endLine: reading.lines.length }] : [])];
  // Every register entry needs its own non-empty photo ID: an entry without one, or two with one ID, could hide a photo
  // that was never read behind a pinned file.
  const register: { photo_id: string; [key: string]: unknown }[] = Array.isArray(registerBlock) ? registerBlock : [];
  const named = Array.isArray(registerBlock) && register.every(r => !!r && typeof r === 'object' && typeof r.photo_id === 'string' && r.photo_id.trim() !== '');
  const registered = named ? register.map(r => r.photo_id) : [], unread = registered.filter(p => !pinned.some(q => q.photoId === p));
  const repeated = [...new Set(registered.filter((id, i) => registered.indexOf(id) !== i))];
  // The reading is parsed with the examiner's own schema; nothing below sees a value it would refuse.
  let photos: PhotoReading[] | null = null;
  if (reading) try { const parsed = photoReadingsSchema.safeParse(JSON.parse(reading.text)?.photos); photos = parsed.success ? parsed.data : null; } catch { photos = null; }
  const complete = !!photos && photos.length === pinned.length && pinned.every(p => photos!.filter(r => r.photoId === p.photoId).length === 1);
  const codes = (p: PhotoReading) => {
    if (p.status !== 'examined') return `${p.photoId} ${p.status}`;
    if (plateOnly(p, register)) return `${p.photoId} set aside as a plate photo`;
    const shown = p.observations.filter(o => ['mess_visible', 'mark_visible', 'location_in_cabin'].includes(o.kind)).map(o => `${o.kind === 'mess_visible' ? 'mess' : o.kind === 'mark_visible' ? 'mark' : 'location'} ${o.value} (${o.visibility})`);
    const unreadable = p.cannotDetermine.filter(k => k === 'mess_visible' || k === 'mark_visible');
    return `${p.photoId} examined: ${[...shown, ...(unreadable.length ? [`cannot determine ${unreadable.join(' and ')}`] : [])].join(', ') || 'no mess, mark or location code'}`;
  };
  const detail = photos ? ` Photos: ${photos.map(codes).join('; ')}.` : '';
  return rules.map(rule => {
    const fact = (value: unknown, lead: string): Fact => ({ id: rule.id, value, explanation: `${lead}${rule.base} ${common}${detail} ${closing}`, citations });
    const unavailable = (why: string) => fact('unavailable', `Unavailable: ${why}. `);
    if (!pinned.length) return unavailable('no photo file is pinned for this claim, so no photo was read');
    if (!named) return unavailable('the photo register has an entry without a photo ID, so its entries cannot all be matched to the photo files');
    if (repeated.length) return unavailable(`the photo register lists ${repeated.join(', ')} more than once, so which entry each photo file answers to is unclear`);
    if (!reading) return unavailable('no photo reading (derived/photos.json) is pinned in this packet yet');
    if (!photos) return unavailable('the photo reading does not parse with the examiner\'s schema');
    if (!complete) return unavailable('the photo reading does not give exactly one reading for each pinned photo');
    // Every photo's codes are checked before any photo is set aside.
    const other = (p: PhotoReading) => p.observations.filter(o => o.kind === 'mark_visible' || (o.kind === 'mess_visible' && !rule.allowed.includes(o.value)));
    const seen = photos.filter(p => p.status === 'examined' && other(p).some(o => o.visibility === 'clear' || o.visibility === 'partial'));
    if (seen.length) return fact(false, `${either(seen.map(p => p.photoId), 'and')} ${seen.length > 1 ? 'show' : 'shows'} another code clearly or partly. `);
    if (unread.length) return unavailable(`the photo register lists ${unread.join(', ')} with no pinned file, so not every photo was read`);
    const problem = (p: PhotoReading) => other(p).length ? (p.status === 'examined' ? 'shows another code too unclearly to count' : `shows another code but was ${p.status === 'unavailable' ? 'not examined' : 'too unclear to read'}`)
      : p.status === 'unavailable' ? 'was not examined' : p.status !== 'examined' ? 'was too unclear to read' : plateOnly(p, register) ? null
      : p.cannotDetermine.includes('mess_visible') || p.cannotDetermine.includes('mark_visible') || !of(p, 'mess_visible').length ? 'does not let the mess be read'
      : of(p, 'mess_visible').some(o => o.visibility !== 'clear') ? 'shows the mess only partly or unclearly' : null;
    const problems = photos.flatMap(p => { const why = problem(p); return why ? [`${p.photoId} ${why}`] : []; });
    if (problems.length) return unavailable(problems.join('; '));
    const why = rule.need(photos.filter(p => !plateOnly(p, register)));
    return why ? unavailable(why) : fact(true, '');
  });
}

/**
 * Facts 5 (7 October 2026, after exam case DISP-043, where the record never said whether the seat was fabric or leather): how the
 * seat upholstery looks in the pinned photos, from the seat_surface code only. "fabric" or "smooth" when every examined photo
 * that shows it clearly or partly agrees; "unavailable" when no photo shows it, the photos disagree, or the reading is incomplete.
 * Appearance only, like every photo fact; the Judge compares it with what the claim and the statements say.
 */
export function photoSurfaceFact(packet: Pick<CasePacket, 'photos' | 'sources'>, registerBlock: unknown, cite: CiteFn): Fact {
  const pinned = packet.photos ?? [], reading = packet.sources.find(s => s.id === 'derived/photos.json'), hasRegister = packet.sources.some(s => s.id === 'evidence/photos.json');
  const citations: Cite[] = [...(hasRegister ? [cite('photos')] : []), ...(reading ? [{ sourceId: reading.id, startLine: 1, endLine: reading.lines.length }] : [])];
  const register: { photo_id: string; [key: string]: unknown }[] = Array.isArray(registerBlock) ? registerBlock : [];
  const base = 'How the seat upholstery looks in the photos: fabric (woven or textured cloth, which a liquid can soak into) or smooth (a leather, vinyl or plastic look), from the seat_surface code; not a finding about the material.';
  const fact = (value: unknown, lead: string): Fact => ({ id: 'photos_show_seat_surface', value, explanation: `${lead}${base} ${common} ${closing}`, citations });
  const unavailable = (why: string) => fact('unavailable', `Unavailable: ${why}. `);
  if (!pinned.length) return unavailable('no photo file is pinned for this claim, so no photo was read');
  if (!reading) return unavailable('no photo reading (derived/photos.json) is pinned in this packet yet');
  let photos: PhotoReading[] | null = null;
  try { const parsed = photoReadingsSchema.safeParse(JSON.parse(reading.text)?.photos); photos = parsed.success ? parsed.data : null; } catch { photos = null; }
  if (!photos) return unavailable('the photo reading does not parse with the examiner\'s schema');
  if (!(photos.length === pinned.length && pinned.every(p => photos!.filter(r => r.photoId === p.photoId).length === 1))) return unavailable('the photo reading does not give exactly one reading for each pinned photo');
  const looks = photos.filter(p => p.status === 'examined' && !plateOnly(p, register))
    .flatMap(p => of(p, 'seat_surface').filter(o => (o.value === 'fabric' || o.value === 'smooth') && (o.visibility === 'clear' || o.visibility === 'partial')).map(o => ({ photoId: p.photoId, value: o.value as string })));
  const values = [...new Set(looks.map(l => l.value))];
  if (!values.length) return unavailable('no examined photo shows the seat clearly or partly');
  if (values.length > 1) return unavailable(`the photos disagree (${looks.map(l => `${l.photoId} ${l.value}`).join(', ')})`);
  return fact(values[0], `${either([...new Set(looks.map(l => l.photoId))], 'and')} ${looks.length > 1 ? 'show' : 'shows'} a ${values[0]} surface. `);
}
