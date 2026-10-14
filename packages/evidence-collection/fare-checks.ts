import type { CasePacket, Source } from '../agent-flow/contracts';
import type { Cite, Fact } from '../agent-flow/facts';
import { datasetBlock } from '../case-packet/dataset';
import { selectBranch } from './branches';
import { strictInstant } from './consistency';

// Facts 6 (MVP fixes, 10 October 2026): promo and fare checks read from structured fields only (the campaign terms' extracted
// fields, the promo history, the quote's parts, the app's surge acknowledgement), each cited, each "unknown" when a field is
// missing. Arithmetic on the record, not entitlement: the Arbitrator answers the questions.
// `cite(block, needle)` cites the line of evidence/<block>.json that contains needle (or the whole source).
type CiteFn = (block: string, needle?: string) => Cite;
// The pricing disputes. Route disputes (route_detour, erp_toll) have their own checks (route-checks.ts).
const fareBranches = new Set<string>(['surge_pricing', 'promo_code', 'extra_charge', 'fare_overcharge', 'destination_change']);
const cents = (n: number) => Math.round(n * 100);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const whole = (v: unknown, min: number): v is number => Number.isInteger(v) && (v as number) >= min;
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\d$/.test(v) && strictInstant(`${v}T00:00Z`) !== null;
const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const dayName = (i: number) => weekdays[i][0].toUpperCase() + weekdays[i].slice(1);
const clock = (s: number) => [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(n => String(n).padStart(2, '0')).join(':');
const at = (iso: unknown) => String(iso).slice(11, 19); // a label: the time as the record writes it, already read with its offset

/** An instant's local date, seconds into the day and weekday (0 Sunday) in an IANA zone; null for an unknown zone. */
function local(instant: number, zone: string): { date: string; seconds: number; weekday: number } | null {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'long' }).formatToParts(new Date(instant)).map(x => [x.type, x.value]));
    const weekday = weekdays.indexOf(String(p.weekday).toLowerCase());
    return weekday < 0 ? null : { date: `${p.year}-${p.month}-${p.day}`, seconds: +p.hour * 3600 + +p.minute * 60 + +p.second, weekday };
  } catch { return null; }
}
const dayIndex = (s: unknown) => typeof s === 'string' ? weekdays.findIndex(d => d === s.trim().toLowerCase() || d.slice(0, 3) === s.trim().toLowerCase()) : -1;
/** The campaign days from a closed vocabulary only: a list of day names, or "<day> to <day>". Anything else is not read (null). */
function campaignDays(v: unknown): Set<number> | null {
  const list = Array.isArray(v) ? v : typeof v === 'string' && !/\bto\b|[-–]/i.test(v) ? v.split(/\s*,\s*|\s+and\s+/i) : null;
  if (list) { const ix = list.map(dayIndex); return ix.length && ix.every(i => i >= 0) ? new Set(ix) : null; }
  const range = typeof v === 'string' ? /^\s*([a-z]+)\s*(?:\bto\b|-|–)\s*([a-z]+)\s*$/i.exec(v) : null, a = dayIndex(range?.[1]), b = dayIndex(range?.[2]);
  if (a < 0 || b < 0) return null;
  const days = new Set<number>(); for (let i = a; ; i = (i + 1) % 7) { days.add(i); if (i === b) break; }
  return days;
}
/** "HH:MM-HH:MM" as seconds into the day; an overnight or unreadable window is not read (null). */
function campaignWindow(v: unknown): { start: number; end: number } | null {
  const m = typeof v === 'string' ? /^\s*(\d\d):(\d\d)\s*(?:-|–|to)\s*(\d\d):(\d\d)\s*$/.exec(v) : null;
  if (!m) return null;
  const [start, end] = [[m[1], m[2]], [m[3], m[4]]].map(([h, mi]) => +h <= 24 && +mi <= 59 ? +h * 3600 + +mi * 60 : NaN);
  return start < end && end <= 86400 ? { start, end } : null;
}
/** The lines of one document's field in the pretty-printed documents source (a multi-line value to its closing line). */
function docCite(source: Source | undefined, docId: unknown, key: string): Cite[] {
  if (!source) return [];
  const lines = source.lines, id = lines.findIndex(l => l.includes(`"document_id": ${JSON.stringify(docId)}`));
  if (id < 0) return [{ sourceId: source.id, startLine: 1, endLine: lines.length }];
  let open = id; while (open > 0 && lines[open].trim() !== '{') open--;
  const indent = lines[open].search(/\S/);
  let close = id; while (close < lines.length - 1 && !(lines[close].trim().startsWith('}') && lines[close].search(/\S/) === indent)) close++;
  const i = lines.findIndex((l, n) => n > open && n < close && l.trimStart().startsWith(`"${key}":`));
  if (i < 0) return [{ sourceId: source.id, startLine: id + 1, endLine: id + 1 }];
  let end = i;
  if (/[[{]\s*$/.test(lines[i])) { const own = lines[i].search(/\S/); while (end < close && !(/^\s*[\]}]/.test(lines[end]) && lines[end].search(/\S/) === own)) end++; }
  return [{ sourceId: source.id, startLine: i + 1, endLine: end + 1 }];
}

export function fareCheckFacts(packet: CasePacket, cite: CiteFn): Fact[] {
  const branch = selectBranch(packet).branch;
  if (!fareBranches.has(branch)) return [];
  const has = (block: string) => packet.sources.some(s => s.id === `evidence/${block}.json`);
  const trip = datasetBlock(packet, 'trip_data') ?? {}, fare = datasetBlock(packet, 'fare_breakdown'), rawEvents = datasetBlock(packet, 'app_events'), rawDocs = datasetBlock(packet, 'documents');
  const events: any[] = Array.isArray(rawEvents) ? rawEvents : [], docs: any[] = Array.isArray(rawDocs) ? rawDocs : [];
  const ticketCite = has('dispute_ticket') ? [cite('dispute_ticket', '"dispute_type"')] : [];
  const out: Fact[] = [];
  const add = (id: string, value: boolean | null, explanation: string, citations: Cite[]) => out.push({ id, value, explanation, citations: citations.length ? citations : ticketCite });
  const booked = strictInstant(trip.booking_time), bookingCite = has('trip_data') ? [cite('trip_data', '"booking_time"')] : [];
  const lines: any[] | null = Array.isArray(fare?.line_items) ? fare.line_items : null;
  const tripLines = (lines ?? []).filter(l => String(l?.code ?? '').toUpperCase() === 'TRIP_FARE');
  const tripFare = tripLines.length === 1 && finite(tripLines[0].amount) ? cents(tripLines[0].amount) : null;
  const fareCite = (needle: string) => has('fare_breakdown') ? [cite('fare_breakdown', needle)] : [];
  if (branch === 'promo_code') promoChecks();
  fareChecks();
  return out;

  function promoChecks() {
    // The campaign is the fare's own promo code, else the one code the promo app events name. Events naming two codes leave it
    // unknown, never the first in the list.
    const fareCode = typeof fare?.promo?.code === 'string' && fare.promo.code.trim() ? fare.promo.code as string : null;
    const eventCodes = [...new Set<string>(events.filter(e => typeof e?.event_type === 'string' && e.event_type.startsWith('promo_') && typeof e?.data?.code === 'string' && e.data.code.trim()).map(e => e.data.code))];
    const code = fareCode ?? (eventCodes.length === 1 ? eventCodes[0] : null), docSource = packet.sources.find(s => s.id === 'evidence/documents.json');
    // The terms and history are found by structured fields alone, as campaign-terms.ts finds the terms (a document's text is never read).
    const termsDocs = code ? docs.filter(d => ((d?.kind === 'campaign_terms' && (d.campaign_id ?? d.code) === code) || d?.document_id === `DOC-TERMS-${code}`) && !['unavailable', 'missing', 'withdrawn'].includes(String(d.status ?? ''))) : [];
    const unusable = (d: any) => ['unavailable', 'missing', 'withdrawn'].includes(String(d?.status ?? ''));
    const allHistories = code ? docs.filter(d => (d?.kind === 'promo_history' || String(d?.document_id ?? '').startsWith('DOC-PROMO-HIST')) && d?.extracted_fields?.code === code
      && !(typeof d.extracted_fields.rider_id === 'string' && typeof trip.rider_id === 'string' && d.extracted_fields.rider_id !== trip.rider_id)) : [];
    // A history marked unavailable, missing or withdrawn is not in evidence, as for the terms.
    const histories = allHistories.filter(d => !unusable(d));
    const terms = termsDocs.length === 1 ? termsDocs[0] : null, history = histories.length === 1 ? histories[0] : null;
    const f = terms?.extracted_fields && typeof terms.extracted_fields === 'object' ? terms.extracted_fields : null, h = history?.extracted_fields ?? null;
    const t = (key: string) => terms ? docCite(docSource, terms.document_id, key) : [], hc = (key: string) => history ? docCite(docSource, history.document_id, key) : [];
    const noTerms = !code ? (eventCodes.length > 1 ? `The fare records no promo code and the promo app events name ${eventCodes.join(' and ')}, so which campaign this trip concerns is unknown` : 'No promo code is recorded on the fare or a promo app event') : termsDocs.length > 1 ? `${termsDocs.length} campaign-terms documents for ${code} are in the record` : !f ? `No campaign-terms document for ${code} with structured fields is in the record` : null;
    const zone = packet.timezone;
    // An advance booking: the terms say "booked", so the booking moment and the pickup are both tried; they must agree to be definite.
    // A pickup time that is missing or unreadable stays an unknown moment, so no time check is definite.
    const advance = trip.booking_mode === 'advance', pickup = advance ? strictInstant(trip.scheduled_time) : null;
    const moments = booked === null || !zone ? null : [local(booked, zone), ...(advance && pickup !== booked ? [pickup === null ? null : local(pickup, zone)] : [])];
    const tried = moments && moments.every(m => m) ? moments as NonNullable<ReturnType<typeof local>>[] : null;
    const when = moments?.[0] ? `Booked at ${clock(moments[0].seconds)} on ${dayName(moments[0].weekday)} ${moments[0].date} (${zone})` : '';
    const noTime = booked === null ? 'The booking time cannot be read with its time zone' : !zone ? 'The dataset states no time zone, so the local booking time is unknown' : moments![0] === null ? 'The dataset\'s time zone cannot be read'
      : 'This is an advance booking whose pickup time (scheduled_time) cannot be read with its time zone, and the terms do not say whether the booking moment or the pickup counts';
    /** One check on the local booking time: definite only when every moment tried gives the same answer. */
    const timed = (id: string, cites: Cite[], unreadable: string | null, test: (m: NonNullable<ReturnType<typeof local>>) => boolean | null, said: string, terms: string, [yes, no]: [string, string], edge = '') => {
      const results = noTerms || unreadable ? [] : tried?.map(test) ?? [];
      if (noTerms) add(id, null, `${noTerms}, so whether the booking ${said} is unknown.`, cites);
      else if (unreadable) add(id, null, `The campaign terms give no readable ${unreadable}, so whether the booking ${said} is unknown.`, cites);
      else if (!tried) add(id, null, `${noTime}, so whether the booking ${said} is unknown.`, cites);
      else if (results.length > 1 && results[0] !== results[1]) add(id, null, `${when}, for a pickup at ${clock(tried[1].seconds)} on ${dayName(tried[1].weekday)} ${tried[1].date}. The two give different answers and the terms do not say which counts on an advance booking, so whether the booking ${said} is unknown.`, [...cites, cite('trip_data', '"scheduled_time"')]);
      else if (results[0] === null) add(id, null, `${when}. ${edge}`, cites);
      else add(id, results[0], `${when}; ${terms}. ${results[0] ? yes : no}. A record of the booking against the terms, not a finding about anyone.`, cites);
    };
    const from = isDate(f?.valid_from) ? f.valid_from : null, to = isDate(f?.valid_to) ? f.valid_to : null;
    timed('promo_booked_within_campaign_dates', [...t('valid_from'), ...t('valid_to'), ...bookingCite], from && to && from <= to ? null : 'valid_from and valid_to dates (YYYY-MM-DD)', m => m.date >= from! && m.date <= to!, 'falls within the campaign dates', `the terms run from ${from} to ${to}, both days included`, ['The booking is inside the campaign dates', 'The booking is outside the campaign dates']);
    const window = campaignWindow(f?.window);
    // The opening minute counts ("from 07:00"); within the closing minute (10:00:00 to 10:00:59) the terms do not say, so unknown.
    timed('promo_booked_within_campaign_hours', [...t('window'), ...bookingCite], window ? null : 'window (HH:MM-HH:MM)', m => m.seconds < window!.start ? false : m.seconds < window!.end ? true : m.seconds < window!.end + 60 ? null : false, 'falls within the campaign hours',
      `the terms' window is ${f?.window}`, ['The booking is inside the campaign hours', 'The booking is outside the campaign hours'], 'That is the minute the campaign window closes, and the terms do not say whether that minute counts, so whether the booking falls within the campaign hours is unknown.');
    const days = campaignDays(f?.days);
    timed('promo_booked_on_campaign_day', [...t('days'), ...bookingCite], days ? null : 'days (day names, or "<day> to <day>")', m => days!.has(m.weekday), 'is on a campaign day', `the terms' days are ${Array.isArray(f?.days) ? f.days.join(', ') : f?.days}`, ['That is a campaign day', 'That is not a campaign day']);

    // Service: the trip's booked service against the terms' list.
    // Non-empty single names only; an entry or string naming several services (a comma, "and", "or") is not read.
    const named = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '', oneName = (v: unknown): v is string => named(v) && !/[,;/]|\s(and|or)\s/i.test(v);
    const services = Array.isArray(f?.services) ? (f.services.length && f.services.every(oneName) ? (f.services as string[]).map(x => x.trim()) : null) : oneName(f?.services) ? [f.services.trim()] : null;
    const service = named(trip.service_type) ? trip.service_type.trim() as string : null, serviceCites = [...t('services'), ...(has('trip_data') && service ? [cite('trip_data', '"service_type"')] : [])];
    if (noTerms) add('promo_service_eligible', null, `${noTerms}, so whether the booked service is covered is unknown.`, serviceCites);
    else if (!services) add('promo_service_eligible', null, 'The campaign terms give no readable list of services, so whether the booked service is covered is unknown.', serviceCites);
    else if (!service) add('promo_service_eligible', null, 'The trip records no service type, so whether the booked service is covered is unknown.', serviceCites);
    else { const ok = services.some(s => s.toLowerCase() === service.toLowerCase()); add('promo_service_eligible', ok, `The trip was booked as ${service}; the terms cover ${services.join(', ')}. ${ok ? 'The service is covered' : 'The service is not covered'}.`, serviceCites); }

    // Minimum fare: the trip-fare line (before the platform fee, which is its own line) against the terms' minimum.
    const min = finite(f?.minimum_trip_fare) && f.minimum_trip_fare >= 0 ? cents(f.minimum_trip_fare) : null, minCites = [...t('minimum_trip_fare'), ...fareCite('"TRIP_FARE"')];
    const otherCurrency = typeof f?.currency === 'string' && typeof fare?.currency === 'string' && f.currency !== fare.currency;
    if (noTerms) add('promo_trip_fare_meets_minimum', null, `${noTerms}, so whether the trip fare meets the campaign minimum is unknown.`, minCites);
    else if (min === null || otherCurrency) add('promo_trip_fare_meets_minimum', null, otherCurrency ? `The terms state amounts in ${f.currency} and the fare in ${fare.currency}, so they are not compared.` : 'The campaign terms give no readable minimum_trip_fare, so whether the trip fare meets it is unknown.', minCites);
    else if (tripFare === null) add('promo_trip_fare_meets_minimum', null, 'The fare has no single trip-fare line (TRIP_FARE) with an amount, so the trip fare before the platform fee is unknown.', minCites);
    else add('promo_trip_fare_meets_minimum', tripFare >= min, `The trip-fare line (TRIP_FARE, before the platform fee) is ${tripFare} cents; the terms' minimum trip fare is ${min} cents. ${tripFare >= min ? 'It meets the minimum.' : 'It is below the minimum.'}`, minCites);

    // Use limits: the promo history's own count of uses before this trip, cross-checked against the app's promo check at booking.
    // The redeemed list counts earlier days of the campaign; that day's earlier uses come from uses_today_before_trip, since the list
    // may hold this trip's own redemption (DISP-018).
    // A promo check whose time cannot be read may have come before the booking: it is kept, so a different count leaves the limit unknown (round 6).
    const checks = events.filter(e => typeof e?.event_type === 'string' && e.event_type.startsWith('promo_') && e?.data?.code === code && booked !== null && (strictInstant(e.timestamp) ?? -Infinity) <= booked);
    const seen = (key: string) => [...new Set(checks.map(e => e?.data?.[key]).filter(v => whole(v, 0)))] as number[];
    const appCite = (key: string) => has('app_events') && seen(key).length ? [cite('app_events', `"${key}"`)] : [];
    const today = whole(h?.uses_today_before_trip, 0) ? h.uses_today_before_trip as number : null, perDay = whole(f?.uses_per_day, 1) ? f.uses_per_day as number : null;
    const noHistory = !history ? (histories.length > 1 ? `${histories.length} promo histories for ${code} are in the record` : allHistories.length ? `The promo history for ${code} is marked ${allHistories.map(d => d.status).join(' and ')}` : `No promo history for ${code} is in the record (a promo-history document)`) : null;
    // A history that counts uses earlier that day but lists fewer redemptions on that day contradicts itself.
    const sameDay = Array.isArray(h?.redeemed) && h.redeemed.every(isDate) && tried && new Set(tried.map(m => m.date)).size === 1 ? (h.redeemed as string[]).filter(d => d === tried[0].date).length : null;
    const selfContradicts = today !== null && sameDay !== null && sameDay < today ? `The promo history counts ${today} use${today === 1 ? '' : 's'} earlier that day (uses_today_before_trip) but lists ${sameDay} redemption${sameDay === 1 ? '' : 's'} on ${tried![0].date} (redeemed); it contradicts itself, so ` : null;
    const disagree = (key: string, ours: number) => { const app = seen(key); return app.some(v => v !== ours) ? `The promo history counts ${ours}; the app's promo check before the booking counted ${app.join(' and ')} (${key}). The records disagree, so ` : null; };
    const dailyCites = [...t('uses_per_day'), ...hc('uses_today_before_trip'), ...appCite('uses_today')];
    if (noTerms) add('promo_daily_limit_reached', null, `${noTerms}, so whether the daily use limit was reached is unknown.`, dailyCites);
    else if (perDay === null) add('promo_daily_limit_reached', null, 'The campaign terms give no readable uses_per_day, so whether the daily use limit was reached is unknown.', dailyCites);
    else if (noHistory || today === null) add('promo_daily_limit_reached', null, `${noHistory ?? 'The promo history gives no readable uses_today_before_trip'}, so how often the code was used that day before this trip, and whether the daily limit was reached, is unknown.`, dailyCites);
    else if (selfContradicts) add('promo_daily_limit_reached', null, `${selfContradicts}whether the daily limit was reached is unknown.`, [...dailyCites, ...hc('redeemed')]);
    else if (disagree('uses_today', today)) add('promo_daily_limit_reached', null, `${disagree('uses_today', today)}whether the daily limit was reached is unknown.`, dailyCites);
    else add('promo_daily_limit_reached', today >= perDay, `The promo history records ${today} use${today === 1 ? '' : 's'} of ${code} that day before this trip (uses_today_before_trip); the terms allow ${perDay} a day (uses_per_day). ${today >= perDay ? 'The daily limit was already reached before this booking.' : 'The daily limit was not reached.'}`, dailyCites);

    const perCampaign = whole(f?.uses_per_campaign, 1) ? f.uses_per_campaign as number : null, redeemed = Array.isArray(h?.redeemed) && h.redeemed.every(isDate) ? h.redeemed as string[] : null;
    // Uses on earlier days, counted to the booking day and, on an advance booking, to the pickup day: they must agree to be definite.
    const counts = redeemed && from && tried ? tried.map(m => redeemed.filter(d => d >= from && d < m.date).length) : null, earlier = counts && counts.every(n => n === counts[0]) ? counts[0] : null;
    const campaignCites = [...t('uses_per_campaign'), ...hc('redeemed'), ...hc('uses_today_before_trip'), ...appCite('campaign_uses')];
    if (noTerms) add('promo_campaign_limit_reached', null, `${noTerms}, so whether the campaign use limit was reached is unknown.`, campaignCites);
    else if (perCampaign === null || !from) add('promo_campaign_limit_reached', null, `The campaign terms give no readable ${perCampaign === null ? 'uses_per_campaign' : 'valid_from date'}, so whether the campaign use limit was reached is unknown.`, campaignCites);
    else if (noHistory || today === null || !redeemed) add('promo_campaign_limit_reached', null, `${noHistory ?? 'The promo history gives no readable list of redemption dates (redeemed, YYYY-MM-DD) or uses_today_before_trip'}, so how often the code was used before this trip is unknown.`, campaignCites);
    else if (earlier === null) add('promo_campaign_limit_reached', null, counts ? 'On this advance booking, counting earlier uses to the booking day and to the pickup day gives different numbers, and the terms do not say which counts, so whether the campaign limit was reached is unknown.' : `${noTime}, so which redemptions came before this trip is unknown.`, [...campaignCites, ...bookingCite]);
    else if (selfContradicts) add('promo_campaign_limit_reached', null, `${selfContradicts}whether the campaign limit was reached is unknown.`, campaignCites);
    // That day's uses are part of the campaign total: if the app and the history disagree on them, the total is unknown too (round 5).
    else if (disagree('uses_today', today)) add('promo_campaign_limit_reached', null, `${disagree('uses_today', today)}the uses before this trip, and whether the campaign limit was reached, are unknown.`, [...campaignCites, ...appCite('uses_today')]);
    else if (disagree('campaign_uses', earlier + today)) add('promo_campaign_limit_reached', null, `${disagree('campaign_uses', earlier + today)}whether the campaign limit was reached is unknown.`, campaignCites);
    else { const used = earlier + today; add('promo_campaign_limit_reached', used >= perCampaign, `${used} uses of ${code} before this trip during the campaign (${earlier} on earlier days from ${from}, from the redeemed list; ${today} earlier that day, uses_today_before_trip); the terms allow ${perCampaign} (uses_per_campaign). ${used >= perCampaign ? 'The campaign limit was already reached.' : 'The campaign limit was not reached.'}`, campaignCites); }

    // Stacking: the final fare's own discount lines decide. Codes recorded as applied are tracked through the
    // log, applied and removed in time order, with the fare's own promo fields; a code the app only refused is not on the fare. One
    // discount line with two codes on the fare, unreadable lines, or a removal that cannot be ordered, leave it unknown.
    const adds = ['promo_applied', 'promo_redeemed'], removes = ['promo_removed', 'promo_unapplied', 'promo_cancelled'];
    const moves = events.filter(e => [...adds, ...removes].includes(e?.event_type) && typeof e?.data?.code === 'string' && e.data.code.trim());
    const time = (e: any) => strictInstant(e?.timestamp), ordered = !moves.some(e => removes.includes(e.event_type)) || moves.every(e => time(e) !== null);
    const net = new Set<string>(); for (const e of ordered ? [...moves].sort((a, b) => (time(a) ?? 0) - (time(b) ?? 0)) : []) { if (adds.includes(e.event_type)) net.add(e.data.code); else net.delete(e.data.code); }
    const onFare = [...new Set<string>([...net, ...(fare?.promo?.applied === true && typeof fare.promo.code === 'string' && fare.promo.code.trim() ? [fare.promo.code] : []),
      ...(Array.isArray(fare?.promos) ? fare.promos.filter((p: any) => p?.applied === true && typeof p.code === 'string' && p.code.trim()).map((p: any) => p.code) : [])])];
    const readable = !!lines && lines.every(l => typeof l?.code === 'string' && finite(l?.amount)), promoLines = readable ? lines!.filter(l => fareLinePart(l) === 'promo') : [];
    const stackCites = [...fareCite('"line_items"'), ...(has('app_events') && moves.length ? [cite('app_events', `"${moves[0].event_type}"`)] : [])];
    const said = `The fare carries ${promoLines.length} promo discount line${promoLines.length === 1 ? '' : 's'}; codes recorded as on this trip (applied, less any removed): ${onFare.length ? onFare.join(', ') : 'none'}.`;
    if (!readable) add('promo_codes_stacked', null, 'The fare lines are missing or not all readable (a code and an amount each), so whether more than one promo discount is on the fare is unknown.', fareCite('"line_items"'));
    else if (!ordered) add('promo_codes_stacked', null, 'A promo was applied or removed at a time that cannot be read, so which codes stayed on the trip, and whether more than one promo is on it, is unknown.', stackCites);
    else if (promoLines.length > 1) add('promo_codes_stacked', true, `${said} So more than one promo is on this trip.`, stackCites);
    else if (onFare.length > 1) add('promo_codes_stacked', null, `${said} One discount line and more than one code: the records do not settle whether more than one promo is on this trip.`, stackCites);
    else add('promo_codes_stacked', false, `${said} So no more than one promo is on this trip.`, stackCites);
  }

  function fareChecks() {
    // Rebuild: the quote's parts as the fare records them (the trip-fare line, the platform or booking fee, a promo discount line),
    // against the quoted total. No case records a base fare as a number (only in prose), so base x surge is not recomputed: the
    // trip-fare line is taken as recorded, with the numeric surge beside it. Every other line is listed as outside the quote's parts.
    const quoted = finite(fare?.quoted_total) ? cents(fare.quoted_total) : null, surge = finite(fare?.surge_multiplier) ? fare.surge_multiplier : null;
    const amountsOk = !!lines && lines.every(l => finite(l?.amount) && typeof l?.code === 'string');
    const isFee = (l: any) => fareLinePart(l) === 'fee', isPromo = (l: any) => fareLinePart(l) === 'promo';
    const rebuildCites = [...fareCite('"line_items"'), ...fareCite('"quoted_total"')];
    if (!fare) add('fare_parts_match_quote', null, 'No fare breakdown is in the record, so the quote cannot be rebuilt from its parts.', []);
    else if (quoted === null) add('fare_parts_match_quote', null, 'The fare records no quoted total, so there is no quote to rebuild.', rebuildCites);
    else if (!amountsOk || tripFare === null) add('fare_parts_match_quote', null, 'The fare has no single trip-fare line (TRIP_FARE), or a line without a code and amount, so the quote cannot be rebuilt from its parts.', rebuildCites);
    else {
      const fees = lines!.filter(isFee), promos = lines!.filter(isPromo), others = lines!.filter(l => String(l.code).toUpperCase() !== 'TRIP_FARE' && !isFee(l) && !isPromo(l));
      const sum = (ls: any[]) => ls.reduce((a, l) => a + cents(l.amount), 0), rebuilt = tripFare + sum(fees) + sum(promos), gap = rebuilt - quoted;
      const unapplied = fare.promo && fare.promo.applied !== true && finite(fare.promo.discount) && !promos.length ? ` The fare records promo${typeof fare.promo.code === 'string' ? ' ' + fare.promo.code : ''} with a discount of ${cents(fare.promo.discount)} cents, not applied on the fare.` : '';
      add('fare_parts_match_quote', gap === 0,
        `The quote's parts as the fare records them: trip fare ${tripFare} cents (TRIP_FARE${surge !== null ? `; the fare records surge x${surge}` : ''}) + ${fees.map(l => `${String(l.code).toLowerCase().replace('_', ' ')} ${cents(l.amount)} cents`).join(' + ') || 'no fee line'}${promos.length ? ` - promo ${-sum(promos)} cents` : ''} = ${rebuilt} cents, against the quoted total of ${quoted} cents. `
        + (gap === 0 ? 'They match.' : `They differ: the parts are ${Math.abs(gap)} cents ${gap > 0 ? 'above' : 'below'} the quote.`)
        + (others.length ? ` Lines on the fare outside the quote's parts: ${others.map(l => `${l.code} ${cents(l.amount)} cents`).join(', ')}.` : ' No other line is on the fare.')
        + `${unapplied} The record gives no base fare as a number, so base x surge is not recomputed. Arithmetic on the fare lines: it shows what was added or changed, not whether it was owed.`, rebuildCites);
    }
    // Surge: only where one is in play. The quote booked is the last one shown at or before the booking with the quoted total. Its
    // records (every quote shown at that moment, and every showing of the same quote ID) must agree on the quote and its surge; records
    // that disagree leave it unknown, whatever their order. Every quote shown at that moment
    // counts, whatever its total: another total at the same moment is a contradiction too (round 3).
    const time = (e: any) => strictInstant(e?.timestamp), isQuote = (e: any) => e?.event_type === 'quote_displayed';
    const shown = events.filter(e => isQuote(e) && booked !== null && (time(e) ?? Infinity) <= booked && finite(e?.data?.total) && quoted !== null && cents(e.data.total) === quoted);
    const last = shown.length ? Math.max(...shown.map(e => time(e)!)) : null, tied = events.filter(e => isQuote(e) && last !== null && time(e) === last), ids = new Set(tied.map(e => e?.data?.quote_id).filter(id => id !== undefined && id !== null));
    const records = [...new Set([...tied, ...events.filter(e => isQuote(e) && ids.has(e?.data?.quote_id))])];
    const describe = (e: any) => `${e?.data?.quote_id ?? 'a quote'} at surge x${finite(e?.data?.surge_multiplier) ? e.data.surge_multiplier : 'unrecorded'}, ${finite(e?.data?.total) ? cents(e.data.total) + ' cents' : 'no total'}`;
    // A quote shown at that moment without its data (no total) is a contradiction too (round 4).
    // A quote shown at a time that cannot be read may be the quote booked, or shown beside it: it is never dropped (round 6).
    const undated = events.filter(e => isQuote(e) && time(e) === null);
    const versions = [...new Set([...records, ...undated].map(describe))], conflict = (tied.length > 0 && (versions.length > 1 || tied.some(e => !finite(e?.data?.total)))) || undated.length > 0;
    const quote = conflict ? undefined : tied[0], quoteSurge = finite(quote?.data?.surge_multiplier) ? quote.data.surge_multiplier : null;
    const firstShown = quote ? records.filter(e => time(e) !== null).sort((a, b) => time(a)! - time(b)!)[0] ?? quote : undefined;
    const anySurge = (surge ?? 1) > 1 || events.some(e => e?.event_type === 'quote_displayed' && finite(e?.data?.surge_multiplier) && e.data.surge_multiplier > 1);
    if (!fare || !anySurge) return;
    const quoteCite = quote && has('app_events') ? [cite('app_events', firstShown.timestamp)] : [], quoteName = quote ? `the quote booked (${quote?.data?.quote_id ?? 'quote'}, shown at ${at(firstShown.timestamp)}, ${quoted} cents)` : '';
    const conflictCites = has('app_events') ? [...new Set(records.map(e => e.timestamp))].map(ts => cite('app_events', ts)) : [];
    const conflictWhy = undated.length ? `The app recorded ${undated.length === 1 ? 'a quote' : `${undated.length} quotes`} (${[...new Set(undated.map(describe))].join('; ')}) at a time that cannot be read, which may be the quote booked or shown beside it` : `The app's records of the quote booked disagree: ${versions.join('; ')} (quote_displayed)`;
    if (conflict) add('fare_surge_matches_booked_quote', null, `${conflictWhy}, so which quote was booked, and its surge, is unknown.`, [...fareCite('"surge_multiplier"'), ...conflictCites]);
    else if (!quote) add('fare_surge_matches_booked_quote', null, 'No quote shown at or before the booking has the quoted total, so which quote was booked, and its surge, is unknown.', [...fareCite('"surge_multiplier"'), ...bookingCite]);
    else if (surge === null || quoteSurge === null) add('fare_surge_matches_booked_quote', null, `${quoteName[0].toUpperCase() + quoteName.slice(1)} or the fare records no surge multiplier, so they cannot be compared.`, [...fareCite('"surge_multiplier"'), ...quoteCite]);
    else add('fare_surge_matches_booked_quote', surge === quoteSurge, `The fare records surge x${surge}; ${quoteName} records surge x${quoteSurge}. ${surge === quoteSurge ? 'The same.' : 'Different.'} A record of the two prices, not whether a change was owed.`, [...fareCite('"surge_multiplier"'), ...quoteCite]);
    // Accepted: a rider's surge acknowledgement (its event type, by the rider) after the quote booked was shown and by the booking.
    const since = firstShown ? time(firstShown) ?? -Infinity : -Infinity;
    const riderAcks = events.filter(e => ['surge_acknowledged', 'surge_accepted'].includes(e?.event_type) && e?.actor === 'rider');
    const acks = riderAcks.filter(e => booked !== null && time(e) !== null && time(e)! <= booked && time(e)! >= since);
    // An acknowledgement whose time cannot be read may fall in the window: it leaves the answer unknown unless a readable one for the
    // quote booked already shows acceptance and it too is plain or for the quote booked (round 6).
    const undatedAcks = riderAcks.filter(e => time(e) === null);
    // An acknowledgement that names a quote or a surge must name the quote booked and its surge: another one never shows acceptance
    // of this quote, and one that cannot be compared, or a mix, leaves it unknown.
    const given = (v: unknown) => v !== undefined && v !== null;
    const kind = (e: any): 'plain' | 'match' | 'other' | 'unknown' => {
      const id = e?.data?.quote_id, s = e?.data?.surge_multiplier;
      if (!given(id) && !given(s)) return 'plain';
      if (!quote || (given(id) && !given(quote?.data?.quote_id)) || (given(s) && (quoteSurge === null || !finite(s)))) return 'unknown';
      return (!given(id) || id === quote.data.quote_id) && (!given(s) || s === quoteSurge) ? 'match' : 'other';
    };
    const kinds = acks.map(kind), named = (e: any) => [e?.data?.quote_id, given(e?.data?.surge_multiplier) ? `surge x${e.data.surge_multiplier}` : undefined].filter(given).join(' at ');
    const ackCites = has('app_events') ? acks.map(e => cite('app_events', e.timestamp)) : [];
    if (conflict) add('surge_accepted_before_booking', null, `${conflictWhy}, so when it was shown, and whether the rider acknowledged its surge before the booking, is unknown.`, [...conflictCites, ...bookingCite]);
    else if (booked === null || !Array.isArray(rawEvents)) add('surge_accepted_before_booking', null, booked === null ? 'The booking time cannot be read with its time zone, so whether a surge acknowledgement came before it is unknown.' : 'No app events are in the record, so whether the rider acknowledged a surge is unknown.', bookingCite);
    else if (undatedAcks.length && (!acks.length || undatedAcks.map(kind).some(k => k === 'other' || k === 'unknown'))) add('surge_accepted_before_booking', null, `The app recorded a surge acknowledgement by the rider at a time that cannot be read${undatedAcks.some(e => given(e?.data?.quote_id) || given(e?.data?.surge_multiplier)) ? ` (${undatedAcks.map(named).filter(Boolean).join(' and ')})` : ''}, so whether it came ${quote ? `after ${quoteName} was shown and ` : ''}before the booking at ${at(trip.booking_time)}, and so whether the rider accepted the surge, is unknown.`, [...(has('app_events') ? undatedAcks.map(e => cite('app_events', `"${e.event_type}"`)) : []), ...quoteCite, ...bookingCite]);
    else if (kinds.some(k => k === 'other' || k === 'unknown')) add('surge_accepted_before_booking', null, `The app recorded a surge acknowledgement by the rider before the booking that names ${acks.filter((_, i) => kinds[i] !== 'plain' && kinds[i] !== 'match').map(named).join(' and ')}, ${quote ? `not ${quoteName} at surge x${quoteSurge ?? 'unrecorded'}` : 'and the quote booked is unknown'}${kinds.some(k => k === 'plain' || k === 'match') ? ', beside one for the quote booked' : ''}. The records do not settle whether the rider accepted the surge of the quote booked.`, [...ackCites, ...quoteCite, ...bookingCite]);
    else add('surge_accepted_before_booking', acks.length > 0, acks.length ? `The app recorded the rider acknowledging a surge (${acks[0].event_type}) at ${at(acks[0].timestamp)}, ${quote ? `after ${quoteName} was shown and ` : ''}before the booking at ${at(trip.booking_time)}.`
      : `The app events record no surge acknowledgement by the rider ${quote ? `between the showing of ${quoteName}${quoteSurge !== null ? `, at surge x${quoteSurge},` : ''} and ` : 'before '}the booking at ${at(trip.booking_time)}. The app events are the app's own log of the booking.`, [...(acks.length ? ackCites : quoteCite), ...bookingCite]);
  }
}

/**
 * Which of the quote's parts a fare line is, as the rebuild above sorts them: the trip-fare line, a platform or booking fee, a
 * promo discount (a negative PROMO or DISCOUNT line), or a line outside the quote's parts. Shared with the lab's fare card.
 */
export function fareLinePart(l: { code?: unknown; amount?: unknown }): 'trip' | 'fee' | 'promo' | 'other' {
  const code = String(l?.code ?? '').toUpperCase();
  if (code === 'TRIP_FARE') return 'trip';
  if (code === 'PLATFORM_FEE' || code === 'BOOKING_FEE') return 'fee';
  return /PROMO|DISCOUNT/.test(code) && finite(l?.amount) && l.amount < 0 ? 'promo' : 'other';
}
