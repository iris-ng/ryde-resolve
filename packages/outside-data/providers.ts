import { createHash } from 'node:crypto';
import { decode } from 'jpeg-js';

// The five outside sources the Evidence Collector can look up (AD-11, owner, 11 October 2026). These calls run in the worker, which
// holds the keys; no agent process does. Keys travel in request headers only, so a recorded `endpoint` never holds one, and every
// failure is an answer with a plain reason of our own, never a provider's text. Every reply is read with a byte limit as it streams,
// every field kept is bounded, and every call stops when the lookup's shared deadline passes or the task is cancelled.
// VOYAGE_API_KEY (the semantic index, policy/semantic.ts, 11 October 2026) is a worker-held key too: stripped from every agent environment and
// part of the key-leak check on every record a lookup saves.
export const outsideKeyNames = ['ONEMAP_TOKEN', 'LTA_DATAMALL_ACCOUNT_KEY', 'MAPILLARY_TOKEN', 'DATA_GOV_SG_API_KEY', 'VOYAGE_API_KEY'] as const;
/** Every worker-held key set in this environment, for the leak check (lookup.ts carriesKey). */
export const heldKeys = (env: Record<string, string | undefined>): string[] => outsideKeyNames.map(n => env[n]).filter((k): k is string => !!k);
export type OutsideKeys = { onemapToken?: string; ltaKey?: string; mapillaryToken?: string; dataGovKey?: string };
/** A process environment without the outside keys. */
export const withoutOutsideKeys = (env: Record<string, string | undefined>) => Object.fromEntries(Object.entries(env).filter(([k]) => !(outsideKeyNames as readonly string[]).includes(k)));
export const outsideKeys = (env: Record<string, string | undefined>): OutsideKeys => ({ onemapToken: env.ONEMAP_TOKEN || undefined, ltaKey: env.LTA_DATAMALL_ACCOUNT_KEY || undefined, mapillaryToken: env.MAPILLARY_TOKEN || undefined, dataGovKey: env.DATA_GOV_SG_API_KEY || undefined });
export type Fetch = typeof fetch;
export type Pt = { lat: number; lng: number };
export type Status = 'received' | 'none_found' | 'unavailable' | 'provider_error';
export type Fetched<T> = { status: Status; httpStatus: number | null; fetchedAt: string; endpoint: string; answer: T | null; reason?: string; rawSha256: string | null };
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const rad = (d: number) => d * Math.PI / 180;
/** Whole metres along the earth's surface; NaN when a coordinate is not a number. */
export const metres = (a: Pt, b: Pt) => { const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2; return Math.round(2 * 6371000 * Math.asin(Math.sqrt(h))); };
const plain = { 'user-agent': 'ryde-resolve evidence collector (hackathon)', accept: 'application/json' };
const now = () => new Date().toISOString();
const never = new AbortController().signal;
/** A provider's text, bounded and trimmed; null when it is not a non-empty string. */
const clip = (v: unknown, n = 120) => typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null;
const failed = <T>(endpoint: string, fetchedAt: string, httpStatus: number | null, reason: string, status: Status = httpStatus === null ? 'unavailable' : 'provider_error'): Fetched<T> => ({ status, httpStatus, fetchedAt, endpoint, answer: null, reason, rawSha256: null });
const stopped = 'the lookup ran out of time or was stopped';

/** At most `limit` bytes of a body, read as it streams; null when it is larger (the read is cancelled at once). */
export async function readBounded(r: Response, limit: number): Promise<Buffer | null> {
  const reader = r.body?.getReader(); if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length; if (size > limit) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
async function getJson(f: Fetch, url: string, headers: Record<string, string>, signal: AbortSignal) {
  if (signal.aborted) return { httpStatus: null as number | null, body: null as any, raw: null as string | null, reason: stopped as string | undefined };
  try {
    const r = await f(url, { headers: { ...plain, ...headers }, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
    const bytes = await readBounded(r, 4_000_000);
    if (!bytes) return { httpStatus: r.status as number | null, body: null as any, raw: null as string | null, reason: 'the reply was larger than 4 MB' as string | undefined };
    const raw = bytes.toString('utf8');
    let body: any = null; try { body = JSON.parse(raw); } catch { /* not JSON: body stays null */ }
    return { httpStatus: r.status as number | null, body, raw: raw as string | null, reason: undefined as string | undefined };
  } catch (e) { return { httpStatus: null, body: null, raw: null, reason: signal.aborted ? stopped : e instanceof Error && e.name === 'TimeoutError' ? 'the provider did not answer within 15 seconds' : 'the provider could not be reached' }; }
}
// Mapillary serves picture files from Facebook's image hosts; nothing else is ever fetched for a picture, redirects are refused, and
// only a JPEG file is kept.
const pictureHosts = /^(?:[a-z0-9-]+\.)*(?:fbcdn\.net|mapillary\.com)$/;
/** A real picture: JPEG bytes that decode, within bounds, to a picture at least 32 pixels each way. */
export function isJpeg(b: Buffer): boolean {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return false;
  try { const img = decode(b, { useTArray: true, maxResolutionInMP: 16, maxMemoryUsageInMB: 128 }); return img.width >= 32 && img.height >= 32 && img.width <= 8192 && img.height <= 8192; } catch { return false; }
}
async function fetchPicture(f: Fetch, url: unknown, signal: AbortSignal): Promise<Buffer | null> {
  let u: URL; try { u = new URL(String(url)); } catch { return null; }
  if (u.protocol !== 'https:' || !pictureHosts.test(u.hostname) || signal.aborted) return null;
  try { const r = await f(u.toString(), { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) }); if (!r.ok) return null; const b = await readBounded(r, 3_000_000); return b && isJpeg(b) ? b : null; }
  catch { return null; }
}

export type Rainfall = { times: string[]; timesWithReadings: number; reportingStations: number | null; stations: { id: string; name: string; distance_m: number; readings: { at: string; mm: number | null }[] }[] };
/** NEA rain gauges (data.gov.sg): the three stations nearest the place, one reading per 5-minute time. */
export async function rainfall(f: Fetch, keys: OutsideKeys, place: Pt, times: string[], signal: AbortSignal = never): Promise<Fetched<Rainfall>> {
  const base = 'https://api-open.data.gov.sg/v2/real-time/api/rainfall', endpoint = `${base}?date=<each 5-minute time>`, fetchedAt = now();
  if (!times.length) return failed(endpoint, fetchedAt, null, 'no reading time falls in the window', 'unavailable');
  const pages: { at: string; stamp: number | null; stations: any[]; values: Map<string, number> }[] = [], raws: string[] = [];
  for (const t of times.slice(0, 13)) {
    const got = await getJson(f, `${base}?date=${encodeURIComponent(t)}`, keys.dataGovKey ? { 'x-api-key': keys.dataGovKey } : {}, signal);
    if (got.httpStatus === 429) return failed(endpoint, fetchedAt, 429, 'data.gov.sg refused: too many requests', 'unavailable');
    if (got.httpStatus !== 200 || got.body?.code !== 0 || !Array.isArray(got.body?.data?.readings)) return failed(endpoint, fetchedAt, got.httpStatus, got.reason ?? `data.gov.sg answered ${got.httpStatus}`);
    raws.push(got.raw!);
    // A reading counts only for the time asked: at or up to five minutes before it, and not one an earlier time already used, so the
    // same reading is never counted twice and a reading from another time never stands in.
    const reading = got.body.data.readings[0], asked = Date.parse(t + '+08:00'), stamp = Date.parse(String(reading?.timestamp));
    // Only a station with an ID and a rain value in range counts; a time whose reading has none is not covered.
    const values = new Map<string, number>();
    for (const x of Array.isArray(reading?.data) ? reading.data.slice(0, 200) : []) { const id = clip(x?.stationId, 20), v = x?.value; if (id && typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1000) values.set(id, v); }
    const stations = Array.isArray(got.body.data.stations) ? got.body.data.stations.slice(0, 200) : [];
    const fits = Number.isFinite(stamp) && stamp <= asked && asked - stamp < 300000 && !pages.some(p => p.stamp === stamp) && values.size > 0;
    if (!fits) { pages.push({ at: t + '+08:00', stamp: null, stations, values: new Map() }); continue; }
    pages.push({ at: clip(reading.timestamp, 40)!, stamp, stations, values });
  }
  // No usable reading at any time asked is no answer, never "0 stations reported".
  const used = pages.filter(p => p.stamp !== null);
  if (!used.length) return failed(endpoint, fetchedAt, 200, 'data.gov.sg gave no reading for the times asked', 'unavailable');
  const all = new Map<string, any>(); for (const p of pages) for (const s of p.stations) { const id = clip(s?.id, 20); if (id) all.set(id, s); }
  const near = [...all.entries()].map(([id, s]) => ({ id, s, d: metres(place, { lat: s?.location?.latitude, lng: s?.location?.longitude }) })).filter(x => Number.isFinite(x.d)).sort((a, b) => a.d - b.d).slice(0, 3);
  return { status: 'received', httpStatus: 200, fetchedAt, endpoint, rawSha256: sha(raws.join('\n')), answer: { times, timesWithReadings: used.length, reportingStations: Math.max(...used.map(p => p.values.size)),
    stations: near.map(({ id, s, d }) => ({ id, name: clip(s?.name) ?? id, distance_m: d, readings: pages.map(p => { const v = p.values.get(id); return { at: p.at, mm: typeof v === 'number' ? v : null }; }) })) } };
}

export type OnemapPlace = { buildings: { building: string | null; block: string | null; road: string | null; postal: string | null; distance_m: number | null }[] };
/** OneMap reverse geocode (SLA): buildings, block, road and postal code within 50 m. */
export async function onemapPlace(f: Fetch, keys: OutsideKeys, place: Pt, signal: AbortSignal = never): Promise<Fetched<OnemapPlace>> {
  const endpoint = `https://www.onemap.gov.sg/api/public/revgeocode?location=${place.lat},${place.lng}&buffer=50&addressType=All&otherFeatures=N`, fetchedAt = now();
  if (!keys.onemapToken) return failed(endpoint, fetchedAt, null, 'no OneMap token is set', 'unavailable');
  // The probe (Task 0) records which authorization form OneMap takes; both are tried, the raw token first.
  let got = await getJson(f, endpoint, { authorization: keys.onemapToken }, signal);
  if (got.httpStatus === 401) got = await getJson(f, endpoint, { authorization: 'Bearer ' + keys.onemapToken }, signal);
  if (got.httpStatus === 401 || got.httpStatus === 403) return failed(endpoint, fetchedAt, got.httpStatus, 'the OneMap token was refused (expired or wrong)', 'unavailable');
  const info = got.body?.GeocodeInfo;
  if (got.httpStatus !== 200 || !Array.isArray(info)) return failed(endpoint, fetchedAt, got.httpStatus, got.reason ?? `OneMap answered ${got.httpStatus}`);
  const text = (v: unknown) => { const t = clip(v); return t && t !== 'NIL' ? t : null; };
  const buildings = info.slice(0, 5).map((g: any) => { const d = metres(place, { lat: Number(g?.LATITUDE), lng: Number(g?.LONGITUDE) }); return { building: text(g?.BUILDINGNAME), block: text(g?.BLOCK), road: text(g?.ROAD), postal: text(g?.POSTALCODE), distance_m: Number.isFinite(d) ? d : null }; });
  return { status: buildings.length ? 'received' : 'none_found', httpStatus: 200, fetchedAt, endpoint, rawSha256: sha(got.raw!), answer: { buildings }, ...(buildings.length ? {} : { reason: 'OneMap lists no building within 50 m' }) };
}

export type Nearby = { radius_m: number; busStops: { code: string; road: string; description: string; distance_m: number }[]; taxiStands: { code: string; name: string; type: string; distance_m: number }[] };
const ltaBase = 'https://datamall2.mytransport.sg/ltaodataservice/';
// The lists change monthly; the worker keeps them for an hour so a run's lookups page through them once.
const ltaCache = new Map<string, { rows: any[]; raw: string; at: number }>();
export const resetLtaCache = () => ltaCache.clear();
async function ltaAll(f: Fetch, key: string, path: string, signal: AbortSignal): Promise<{ rows: any[] | null; raw: string; httpStatus: number | null; reason?: string }> {
  const hit = ltaCache.get(path); if (hit && Date.now() - hit.at < 3600000) return { rows: hit.rows, raw: hit.raw, httpStatus: 200 };
  // Rows are told apart by their own code (BusStopCode, TaxiCode), else by their fields in a fixed order. A row repeated within one page
  // is kept once; a code already seen on an earlier page means the pages overlap and the list cannot be trusted whole.
  const idOf = (row: any) => { const code = path === 'BusStops' ? row?.BusStopCode : path === 'TaxiStands' ? row?.TaxiCode : undefined; return code !== undefined && code !== null && String(code).trim() ? 'code:' + String(code).trim() : row && typeof row === 'object' ? 'row:' + JSON.stringify(row, Object.keys(row).sort()) : 'row:' + JSON.stringify(row); };
  const rows: any[] = [], earlier = new Set<string>(); let raw = '';
  for (let skip = 0; ; skip += 500) {
    // A list that has not ended in 40 pages, or that repeats a page, is incomplete: no answer rather than a list missing stops.
    if (skip >= 20000) return { rows: null, raw, httpStatus: 200, reason: 'LTA DataMall\'s list did not end within 40 pages, so it is incomplete' };
    const got = await getJson(f, `${ltaBase}${path}?$skip=${skip}`, { AccountKey: key }, signal);
    if (got.httpStatus !== 200 || !Array.isArray(got.body?.value)) return { rows: null, raw, httpStatus: got.httpStatus, reason: got.reason ?? `LTA DataMall answered ${got.httpStatus}` };
    // A row seen on an earlier page, adjacent or not, means the pages overlap: the list cannot be trusted to be whole.
    const page = new Set<string>();
    for (const row of got.body.value) { const id = idOf(row); if (earlier.has(id)) return { rows: null, raw, httpStatus: 200, reason: 'LTA DataMall repeated a page, so the list is incomplete' }; if (!page.has(id)) { page.add(id); rows.push(row); } }
    for (const id of page) earlier.add(id);
    raw += got.raw;
    if (got.body.value.length < 500) break;
  }
  ltaCache.set(path, { rows, raw, at: Date.now() });
  return { rows, raw, httpStatus: 200 };
}
/** LTA DataMall bus stops and taxi stands within the radius, nearest first (at most five of each). */
export async function ltaNearby(f: Fetch, keys: OutsideKeys, place: Pt, radius_m = 250, signal: AbortSignal = never): Promise<Fetched<Nearby>> {
  const endpoint = `${ltaBase}BusStops and ${ltaBase}TaxiStands`, fetchedAt = now();
  if (!keys.ltaKey) return failed(endpoint, fetchedAt, null, 'no LTA DataMall key is set', 'unavailable');
  const stops = await ltaAll(f, keys.ltaKey, 'BusStops', signal), stands = stops.rows ? await ltaAll(f, keys.ltaKey, 'TaxiStands', signal) : stops;
  if (!stops.rows || !stands.rows) { const bad = stops.rows ? stands : stops; return failed(endpoint, fetchedAt, bad.httpStatus, bad.reason ?? 'LTA DataMall gave no list', 'unavailable'); }
  const near = <T>(rows: any[], map: (r: any, d: number) => T) => rows.map(r => ({ r, d: metres(place, { lat: Number(r?.Latitude), lng: Number(r?.Longitude) }) })).filter(x => Number.isFinite(x.d) && x.d <= radius_m).sort((a, b) => a.d - b.d).slice(0, 5).map(x => map(x.r, x.d));
  return { status: 'received', httpStatus: 200, fetchedAt, endpoint, rawSha256: sha(stops.raw + stands.raw), answer: { radius_m,
    busStops: near(stops.rows, (r, d) => ({ code: clip(String(r.BusStopCode ?? ''), 12) ?? '', road: clip(r.RoadName) ?? '', description: clip(r.Description) ?? '', distance_m: d })),
    taxiStands: near(stands.rows, (r, d) => ({ code: clip(String(r.TaxiCode ?? ''), 12) ?? '', name: clip(r.Name) ?? '', type: clip(r.Type, 20) ?? '', distance_m: d })) } };
}

export type StreetPicture = { imageId: string; capturedAt: string | null; compassAngle: number | null; isPano: boolean; distance_m: number; mediaType: 'image/jpeg'; bytes: number; sha256: string; searchCapped: boolean };
/** Mapillary returns at most this many pictures per search; a full page means a nearer picture may have been left out. */
export const mapillaryLimit = 500;
const pictureDate = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 4102444800000 ? new Date(v).toISOString() : null;
/** The nearest Mapillary picture within the radius (flat pictures before panoramas), with its file, for the photo reader. */
export async function mapillaryNearest(f: Fetch, keys: OutsideKeys, place: Pt, radius_m = 40, signal: AbortSignal = never): Promise<Fetched<StreetPicture> & { image?: Buffer }> {
  const dLat = radius_m / 111320, dLng = radius_m / (111320 * Math.cos(rad(place.lat))), fetchedAt = now();
  const bbox = [place.lng - dLng, place.lat - dLat, place.lng + dLng, place.lat + dLat].map(x => x.toFixed(6)).join(',');
  const endpoint = `https://graph.mapillary.com/images?fields=id,captured_at,compass_angle,computed_geometry,geometry,is_pano,thumb_1024_url&bbox=${bbox}&limit=${mapillaryLimit}`;
  if (!keys.mapillaryToken) return failed(endpoint, fetchedAt, null, 'no Mapillary token is set', 'unavailable');
  const got = await getJson(f, endpoint, { authorization: 'OAuth ' + keys.mapillaryToken }, signal);
  if (got.httpStatus !== 200 || !Array.isArray(got.body?.data)) return failed(endpoint, fetchedAt, got.httpStatus, got.reason ?? `Mapillary answered ${got.httpStatus}`);
  const capped = got.body.data.length >= mapillaryLimit;
  const pick = got.body.data.slice(0, mapillaryLimit).map((i: any) => { const c = (i?.computed_geometry ?? i?.geometry)?.coordinates; return Array.isArray(c) ? { i, d: metres(place, { lat: Number(c[1]), lng: Number(c[0]) }) } : null; })
    .filter((x: any) => x && Number.isFinite(x.d) && x.d <= radius_m && typeof x.i?.thumb_1024_url === 'string' && /^\d{1,30}$/.test(String(x.i?.id)))
    .sort((a: any, b: any) => Number(a.i.is_pano === true) - Number(b.i.is_pano === true) || a.d - b.d)[0];
  if (!pick) return capped ? failed(endpoint, fetchedAt, 200, `Mapillary returned its limit of ${mapillaryLimit} pictures near the place, so whether one is within ${radius_m} m is unknown`, 'unavailable')
    : { status: 'none_found', httpStatus: 200, fetchedAt, endpoint, answer: null, reason: `Mapillary has no picture within ${radius_m} m`, rawSha256: sha(got.raw!) };
  const image = await fetchPicture(f, pick.i.thumb_1024_url, signal);
  if (!image) return failed(endpoint, fetchedAt, 200, signal.aborted ? stopped : 'the picture file could not be downloaded as a JPEG from Mapillary', 'unavailable');
  // Only a number in range is a direction; a missing or null angle stays unknown, never 0 (north).
  const angle = pick.i.compass_angle;
  return { status: 'received', httpStatus: 200, fetchedAt, endpoint, rawSha256: sha(got.raw!), image, answer: { imageId: String(pick.i.id), capturedAt: pictureDate(pick.i.captured_at),
    compassAngle: typeof angle === 'number' && Number.isFinite(angle) && angle >= 0 && angle <= 360 ? Math.round(angle) : null, isPano: pick.i.is_pano === true, distance_m: pick.d, mediaType: 'image/jpeg', bytes: image.length, sha256: sha(image), searchCapped: capped } };
}
/** A picture's current file, by its Mapillary ID, for the screen: a JPEG from Mapillary's image hosts, else null. */
export async function mapillaryThumb(f: Fetch, keys: OutsideKeys, imageId: string, signal: AbortSignal = never): Promise<Buffer | null> {
  if (!keys.mapillaryToken || !/^\d{1,30}$/.test(imageId)) return null;
  const got = await getJson(f, `https://graph.mapillary.com/${imageId}?fields=thumb_1024_url`, { authorization: 'OAuth ' + keys.mapillaryToken }, signal);
  return got.httpStatus === 200 ? fetchPicture(f, got.body?.thumb_1024_url, signal) : null;
}

export type RoadRoute = { from: Pt; to: Pt; distance_km: number; duration_min: number; points: [number, number][] };
const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
/** The OSRM demo server's driving route on OpenStreetMap roads (as evidence/tools/fetch-route-references.mjs saved them). */
export async function osrmRoute(f: Fetch, from: Pt, to: Pt, signal: AbortSignal = never): Promise<Fetched<RoadRoute>> {
  const endpoint = `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=simplified&geometries=geojson`, fetchedAt = now();
  const got = await getJson(f, endpoint, {}, signal), route = got.body?.routes?.[0];
  const sane = Number.isFinite(route?.distance) && route.distance > 0 && route.distance < 2e6 && Number.isFinite(route?.duration) && route.duration >= 0 && route.duration < 1e6;
  if (got.httpStatus !== 200 || got.body?.code !== 'Ok' || !sane || !Array.isArray(route?.geometry?.coordinates)) return failed(endpoint, fetchedAt, got.httpStatus, got.reason ?? `OSRM gave no route (answer ${got.httpStatus})`);
  // [lng, lat] becomes [lat, lng], at most 50 points, first and last kept.
  const all = route.geometry.coordinates.slice(0, 100000).filter((c: unknown) => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]) && Math.abs(c[1]) <= 90 && Math.abs(c[0]) <= 180), n = Math.min(50, all.length);
  const picked = n < 2 ? all : Array.from({ length: n }, (_, i) => all[Math.round(i * (all.length - 1) / (n - 1))]);
  return { status: 'received', httpStatus: 200, fetchedAt, endpoint, rawSha256: sha(got.raw!), answer: { from, to, distance_km: round(route.distance / 1000, 2), duration_min: round(route.duration / 60, 1), points: picked.map(([lng, lat]: [number, number]) => [round(lat, 5), round(lng, 5)] as [number, number]) } };
}
