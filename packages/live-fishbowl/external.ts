import { createHash } from 'node:crypto';
import { z } from 'zod';

export const externalRequestSchema = z.object({ provider: z.enum(['rainfall', 'traffic']), mode: z.enum(['live', 'simulation']), time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/).default('10:00:00'), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict().refine(x => Number.isFinite(Date.parse(x.date)) && new Date(x.date).toISOString().startsWith(x.date), 'Invalid date');
export type ExternalRequest = z.infer<typeof externalRequestSchema>;
const endpoints = { rainfall: 'https://api-open.data.gov.sg/v2/real-time/api/rainfall', traffic: 'https://datamall2.mytransport.sg/ltaodataservice/TrafficIncidents' };
export async function collectExternal(input: ExternalRequest, fetcher: typeof fetch = fetch, accountKey = process.env.LTA_DATAMALL_ACCOUNT_KEY) {
  const request = externalRequestSchema.parse(input), fetchedAt = new Date().toISOString();
  const url = new URL(endpoints[request.provider]);
  if (request.provider === 'rainfall') url.searchParams.set('date', request.date + 'T' + request.time);
  const base = { schemaVersion: 1, kind: 'external_response', provider: request.provider, provenance: request.mode, requestedDate: request.date, requestedTimeSGT: request.time, fetchedAt, endpoint: url.toString(), adapterVersion: '1',
    coverage: request.provider === 'traffic' ? 'Current incidents at retrieval time only. No historical coverage or trip relevance is established.' : 'Readings at or before the requested Singapore date/time. Check stations, reading times and pagination; coverage may be incomplete.',
    notice: 'Source response only. Relevance, credibility and effect on the dispute are for each advocate and the Arbitrator to explain.' };
  if (request.mode === 'live' && request.provider === 'traffic' && !accountKey) return { ...base, status: 'unavailable', reason: 'LTA AccountKey is not configured. No traffic query was sent.', rawBody: null, rawSha256: null };
  if (request.mode === 'live' && request.provider === 'traffic') {
    const pages: { endpoint: string; fetchedAt: string; httpStatus: number; rawBody: string; rawSha256: string }[] = [];
    let bytes = 0;
    for (let page = 0; page < 4; page++) {
      const endpoint = new URL(url); endpoint.searchParams.set('$skip', String(page * 500));
      try {
        const response = await fetcher(endpoint, { headers: { AccountKey: accountKey!, Accept: 'application/json' }, signal: AbortSignal.timeout(12000), redirect: 'error' });
        const reader = response.body?.getReader(), chunks: Uint8Array[] = [];
        if (reader) for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.length;
          if (bytes > 90000) { await reader.cancel(); return { ...base, status: 'unavailable', reason: 'Traffic response exceeds the evidence size bound. Coverage is incomplete.', pages, paginationComplete: false, rawBody: null, rawSha256: null }; }
          chunks.push(part.value);
        }
        const rawBody = Buffer.concat(chunks).toString('utf8');
        pages.push({ endpoint: endpoint.toString(), fetchedAt: new Date().toISOString(), httpStatus: response.status, rawBody, rawSha256: createHash('sha256').update(rawBody).digest('hex') });
        let parsed: any; try { parsed = JSON.parse(rawBody); } catch {}
        if (response.status !== 200 || !Array.isArray(parsed?.value)) return { ...base, status: 'provider_error', reason: 'Invalid traffic page; retained pages do not establish complete coverage.', pages, paginationComplete: false, rawBody: null, rawSha256: null };
        if (parsed.value.length < 500) return { ...base, status: 'received', pages, paginationComplete: true, rawBody: pages.length === 1 ? rawBody : null, rawSha256: pages.length === 1 ? pages[0].rawSha256 : null };
      } catch { return { ...base, status: 'unavailable', reason: 'Traffic request failed; retained pages are incomplete, not evidence of no incident.', pages, paginationComplete: false, rawBody: null, rawSha256: null }; }
    }
    return { ...base, status: 'received', pages, paginationComplete: false, reason: 'Four-page collection bound reached. Coverage is incomplete.', rawBody: null, rawSha256: null };
  }
  let rawBody: string;
  let httpStatus: number | null = null;
  if (request.mode === 'simulation') {
    rawBody = JSON.stringify(request.provider === 'traffic'
      ? { value: [{ Type: 'Roadwork', Latitude: 1.284, Longitude: 103.851, Message: 'SIMULATED roadwork for adapter demonstration; not evidence of a real incident.' }] }
      : { code: 0, data: { stations: [{ id: 'SIM-STATION', name: 'Synthetic station', location: { latitude: 1.284, longitude: 103.851 } }], readingType: 'rainfall', readingUnit: 'mm', readings: [{ timestamp: request.date + 'T' + request.time + '+08:00', data: [{ stationId: 'SIM-STATION', value: 2.4 }] }] } });
  } else {
    try {
      const response = await fetcher(url, { headers: request.provider === 'traffic' ? { AccountKey: accountKey!, Accept: 'application/json' } : { Accept: 'application/json' }, signal: AbortSignal.timeout(12000), redirect: 'error' });
      httpStatus = response.status;
      // Read bounded bytes; do not follow redirects or accept arbitrary endpoints.
      const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      if (reader) for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 120000) { await reader.cancel(); return { ...base, status: 'unavailable', reason: 'Response exceeds the bounded evidence size. No truncated response was admitted.', httpStatus, rawBody: null, rawSha256: null }; } chunks.push(part.value); }
      rawBody = Buffer.concat(chunks).toString('utf8');
    } catch { return { ...base, status: 'unavailable', reason: 'Provider request failed or timed out. This is not evidence of no rain or no incident.', rawBody: null, rawSha256: null }; }
  }
  let parsed: any;
  try { parsed = JSON.parse(rawBody); } catch { /* Preserve failed response exactly. */ }
  const valid = (httpStatus === null || httpStatus === 200) && (request.provider === 'traffic' ? Array.isArray(parsed?.value) : parsed?.code === 0 && Array.isArray(parsed?.data?.readings));
  return { ...base, status: valid ? 'received' : 'provider_error', httpStatus, rawBody, rawSha256: createHash('sha256').update(rawBody).digest('hex'),
    ...(valid ? { paginationComplete: !parsed?.data?.paginationToken && !parsed?.data?.nextToken && !parsed?.data?.pagination?.nextToken } : { reason: 'Provider response did not match the expected successful format. Retained for inspection, not interpreted as an empty result.' }) };
}
