import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Source } from '../agent-flow/contracts';

// Facts 6 (MVP fixes, 10 October 2026): the best road route between a route case's planned trip start and end, saved once per case in
// evidence/registers/route-references.json (written by evidence/tools/fetch-route-references.mjs) and never fetched during a run.
// The dataset.json files stay byte-identical (exam records pin their hashes): a listed case gets one more source,
// evidence/route_reference.json, labelled as a reference so no one reads it as part of the case file.
export const routeReferenceSourceId = 'evidence/route_reference.json';
export const routeReferenceLabel = 'Reference only, not part of the case file: the shortest-time driving route between the trip\'s planned start and end (the first and last planned points) on OpenStreetMap roads, from the OSRM demo server, saved once by the team on the date in fetched_at and never fetched during a run. It is not the app\'s navigation, and not what traffic or road closures allowed that day. Points are [lat, lng].';
/** Beside the claims register, found the way raw-dataset.ts registersRoot() finds it (copied, since that module imports the dataset loader). */
export const routeReferencesPath = () => path.join(process.env.EVIDENCE_REGISTERS_ROOT ?? (process.env.EVIDENCE_DISPUTES_ROOT ? path.join(path.dirname(process.env.EVIDENCE_DISPUTES_ROOT), 'registers') : path.join(process.cwd(), 'evidence/registers')), 'route-references.json');
const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const place = (p: any) => finite(p?.lat) && finite(p?.lng);
/** One line per [lat, lng] point, so a 50-point route reads in about 50 lines. */
export const referenceText = (value: unknown) => JSON.stringify(value, null, 2).replace(/\[\s+(-?[\d.e-]+),\s+(-?[\d.e-]+)\s+\]/g, '[$1, $2]');

/** The labelled reference source for a case, or null when the register is absent or does not list it. A malformed register throws. */
export async function routeReferenceSource(caseId: string): Promise<Source | null> {
  let text: string;
  try { text = await readFile(/*turbopackIgnore: true*/ routeReferencesPath(), 'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  let register: any;
  try { register = JSON.parse(text); } catch { throw new Error('evidence/registers/route-references.json is not valid JSON'); }
  if (register?.version !== 1 || !register.entries || typeof register.entries !== 'object') throw new Error('evidence/registers/route-references.json is malformed');
  const entry = register.entries[caseId];
  if (entry === undefined) return null;
  const valid = entry?.caseId === caseId && finite(entry.distance_km) && entry.distance_km > 0 && place(entry.from) && place(entry.to) && Array.isArray(entry.points) && entry.points.length <= 50;
  if (!valid) throw new Error(`The route reference for ${caseId} in evidence/registers/route-references.json is malformed`);
  const body = referenceText({ label: routeReferenceLabel, ...entry });
  return { id: routeReferenceSourceId, text: body, lines: body.split('\n'), sha256: createHash('sha256').update(body).digest('hex') };
}
