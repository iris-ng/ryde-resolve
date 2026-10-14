import { z } from 'zod';
import { photoModel } from '../evidence-collection/photo-examiner';
import { readBounded } from './providers';

// AD-15 (owner, 11 October 2026): a Mapillary street picture is read by the same photo reader as cleaning photos (gpt-6-luna through
// our model gateway). The reading describes appearance only; it is shown and citable, and no money, routing rule or fact reads it.
// It runs in the worker (AD-11), which holds the gateway settings; no agent process makes this call.
export const streetReadingVersion = 1;
export const stoppingPlaces = ['driveway', 'drop_off_porch', 'pickup_bay', 'taxi_stand', 'bus_stop', 'kerbside', 'none_visible', 'unclear'] as const;
export const streetReadingSchema = z.object({
  shows: z.string().min(1).max(400),
  stopping_place: z.enum(stoppingPlaces),
  no_stopping_markings: z.enum(['visible', 'not_visible', 'unclear']),
  markings_seen: z.array(z.string().min(1).max(60)).max(4),
  limits: z.string().min(1).max(300),
}).strict();
export type StreetReading = z.infer<typeof streetReadingSchema>;
export type StreetReadingResult = { status: 'answered' | 'unavailable'; reading: StreetReading | null; model: string; reason?: string };
export const streetInstructions = 'You describe one street-level photograph of a pickup place in Singapore for a ride-hailing dispute record. Describe only what is visible. Reply with one JSON object: "shows": one plain sentence of at most 40 words on the road, the kerb and any building entrance; "stopping_place": the place a car could stop that the picture shows, one of driveway, drop_off_porch, pickup_bay, taxi_stand, bus_stop, kerbside, none_visible, unclear; "no_stopping_markings": visible, not_visible or unclear (yellow kerb lines, zig-zag lines, no-stopping signs); "markings_seen": up to 4 short items, such as "double yellow lines" or "bus stop sign"; "limits": one plain sentence on what the picture cannot show (its own date, traffic at another time). Never guess what happened on any trip.';
const settings = { stream: false, reasoning_effort: 'low', max_completion_tokens: 4000, response_format: { type: 'json_object' } } as const;

export async function readStreetPicture(f: typeof fetch, env: Record<string, string | undefined>, image: Buffer, requestId: string, signal: AbortSignal = new AbortController().signal): Promise<StreetReadingResult> {
  const gateway = env.RYDE_MODEL_GATEWAY_URL ?? '', secret = env.RYDE_MODEL_GATEWAY_SECRET ?? '', model = photoModel;
  if (!/^https?:\/\/\S+$/.test(gateway) || secret.length < 32) return { status: 'unavailable', reading: null, model, reason: 'the model gateway is not configured' };
  const body = JSON.stringify({ model, ...settings, messages: [{ role: 'system', content: streetInstructions }, { role: 'user', content: [{ type: 'text', text: 'The picture:' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + image.toString('base64') } }] }] });
  // A reply that is cut off, not JSON or not the schema is asked for once more, as the photo examiner does; a gateway error is not.
  // Both attempts share the lookup's deadline (signal): a stopped or late lookup makes no further paid call.
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (signal.aborted) return { status: 'unavailable', reading: null, model, reason: 'the lookup ran out of time or was stopped' };
    let response: Response;
    try { response = await f(gateway.replace(/\/$/, '') + '/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + secret, 'content-type': 'application/json', 'x-request-id': requestId }, body, signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]) }); }
    catch { return { status: 'unavailable', reading: null, model, reason: signal.aborted ? 'the lookup ran out of time or was stopped' : 'the gateway could not be reached' }; }
    if (!response.ok) return { status: 'unavailable', reading: null, model, reason: `the gateway answered ${response.status}` };
    try {
      const bytes = await readBounded(response, 1_000_000); if (!bytes) continue;
      const reply: any = JSON.parse(bytes.toString('utf8'));
      const parsed = streetReadingSchema.safeParse(JSON.parse(reply?.choices?.[0]?.message?.content ?? 'null'));
      if (parsed.success) return { status: 'answered', reading: parsed.data, model };
    } catch { /* asked once more below */ }
  }
  return { status: 'unavailable', reading: null, model, reason: 'the photo reader gave no usable reading' };
}
