import { z } from 'zod';

// The Photo Examiner's reading schema, on its own so that contracts.ts (photoExamSchema) and the facts built from the
// pinned reading (photo-reading-facts.ts) parse with the same schema: contracts.ts loads the facts, so the facts cannot
// import it from there. Depends on zod only.

// Server-side photo reading (cleaning claims). Appearance only: no cause, material, authenticity, age of a mark or fee tier (spec revision 12).
const box=z.object({x:z.number().min(0).max(1),y:z.number().min(0).max(1),w:z.number().gt(0).max(1),h:z.number().gt(0).max(1)}).strict().refine(b=>b.x+b.w<=1&&b.y+b.h<=1,'A box must stay inside the image');
// Values are fixed per kind: appearance only, never cause, material, authenticity or the age of a mark.
const photoRegion=z.union([z.literal('whole'),box]),visibility=z.enum(['clear','partial','unclear']);
const photoObservation=<K extends string,V extends z.ZodTypeAny>(kind:K,value:V)=>z.object({kind:z.literal(kind),value,region:photoRegion,visibility}).strict();
export const photoObservationSchema=z.discriminatedUnion('kind',[
  photoObservation('mess_visible',z.enum(['none','wet_patch','solid_debris','crumbs','hair','dirt','stain','other'])),
  photoObservation('extent',z.enum(['small','medium','large','unclear'])),
  photoObservation('location_in_cabin',z.enum(['rear_seat','front_seat','floor','door','boot','other','unclear'])),
  photoObservation('plate_visible',z.enum(['yes','no','partial'])),
  // Plate-shaped only (up to four letters, up to four digits, an optional final letter), so the field cannot carry a message.
  photoObservation('plate_text',z.string().regex(/^[A-Z]{1,4} ?[0-9]{1,4}( ?[A-Z])?$/,'Plate text as read, in plate shape: letters, digits, an optional final letter')),
  photoObservation('mark_visible',z.enum(['stain','scratch','tear','discolouration','other'])),
  photoObservation('same_scene_as',z.string().max(40)),
  // 7 October 2026 (exam DISP-043): how the seat upholstery looks, woven fabric or smooth (a leather, vinyl or plastic look); seats only,
  // since a mat or the floor beside a fabric seat is often smooth. Appearance, not a finding about the material; the spill rule turns on it.
  photoObservation('seat_surface',z.enum(['fabric','smooth','unclear'])),
]);
export const photoKinds=['mess_visible','extent','location_in_cabin','plate_visible','plate_text','mark_visible','same_scene_as','seat_surface'] as const;
/** The photo reading's summary is written by the server from the statuses, never by the model. */
export const photoSummary=(photos:{status:string}[])=>{const n=(s:string)=>photos.filter(p=>p.status===s).length;return `Photo reading of ${photos.length} photo(s): ${n('examined')} examined, ${n('unclear')} unclear, ${n('unavailable')} unavailable. A model reading of appearance only, not a finding.`;};
/** The readings of a photo set: photoExamSchema's `photos` field. */
export const photoReadingsSchema=z.array(z.object({photoId:z.string().max(40),status:z.enum(['examined','unclear','unavailable']),
    observations:z.array(photoObservationSchema).max(12),
    // Which kinds of observation the photo does not allow: fixed codes, no prose.
    cannotDetermine:z.array(z.enum(photoKinds)).max(photoKinds.length)}).strict()).min(1).max(3);
export type PhotoReading = z.infer<typeof photoReadingsSchema>[number];
