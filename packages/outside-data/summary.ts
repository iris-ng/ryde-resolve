// Plain-English lines for an outside record on the External tab (AD-13). Client-safe: no Node built-ins.
const headings: Record<string, string> = { rainfall: 'Rainfall', place: 'Place', transport: 'Bus stops and taxi stands', street_picture: 'Street picture', road_route: 'Best road route' };
const placeWords: Record<string, string> = { pickup: 'the pickup point', driver_at_arrival: 'where the driver was at arrival', driver_at_cancellation: 'where the driver was at cancellation', dropoff: 'the drop-off', trip_start: 'the trip start', trip_end: 'the trip end' };
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const outsideHeading = (lookup: string) => headings[lookup] ?? 'Outside lookup';
/** Singapore wall-clock parts of an instant; null when it cannot be read. */
const sg = (iso: unknown) => { const t = typeof iso === 'string' ? Date.parse(iso) : NaN; return Number.isFinite(t) ? new Date(t + 8 * 3600000) : null; };
const clock = (d: Date) => { const h = d.getUTCHours(); return `${h % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`; };
const day = (d: Date) => `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
const title = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
const distance = (m: number) => m >= 1000 ? `${Math.round(m / 100) / 10} km` : `${m} m`;
const sentence = (s: string) => s ? s[0].toUpperCase() + s.slice(1) + (/[.!?]$/.test(s) ? '' : '.') : s;

/** Where and when the Collector asked, and when it looked it up. */
export function outsideAskedLine(r: any): string {
  const place = r?.asked?.place, w = r?.asked?.window, from = sg(w?.from), to = sg(w?.to), at = sg(r?.fetched_at);
  const where = place ? `At ${placeWords[place] ?? place}` : 'Between the trip\'s planned start and end';
  let when = '';
  if (from && to) { const a = clock(from), b = clock(to); when = `, ${a.slice(-2) === b.slice(-2) ? a.slice(0, -3) : a} to ${b} on ${day(from)}`; }
  const by = at ? ` Looked up ${day(at)}, ${clock(at)}, by the Evidence Collector${r?.via === 'saved_copy' ? ', answered from the team\'s saved copy' : ''}.` : '';
  return `${where}${when}.${by}`;
}
/** What the source returned, in a few plain lines. */
export function outsideSummary(r: any): string[] {
  const a = r?.answer;
  if (r?.status === 'unavailable' || r?.status === 'provider_error') return [`Not available: ${r?.reason ?? 'the provider gave no answer'}.`];
  if (r?.lookup === 'road_route' && r?.status === 'received' && typeof r?.distance_km === 'number') return [`${r.distance_km} km, about ${Math.round(Number(r.duration_min) || 0)} minutes without traffic.`];
  if (r?.status === 'none_found' || !a) return [r?.reason ? sentence(String(r.reason)) : 'Nothing found.'];
  switch (r.lookup) {
    case 'rainfall': return [
      ...(Array.isArray(a.stations) ? a.stations : []).map((s: any) => {
        const got = (Array.isArray(s.readings) ? s.readings : []).filter((x: any) => typeof x?.mm === 'number'), mm = Math.round(got.reduce((t: number, x: any) => t + x.mm, 0) * 10) / 10;
        return `${title(String(s.name))} station, ${distance(s.distance_m)} away: ${got.length ? `${mm} mm in ${got.length} reading${got.length === 1 ? '' : 's'}` : 'no reading'}.`;
      }),
      ...(typeof a.reportingStations === 'number' ? [`${a.reportingStations} stations reported across Singapore.`] : []),
      ...(Array.isArray(a.times) && typeof a.timesWithReadings === 'number' && a.timesWithReadings < a.times.length ? [`Readings for ${a.timesWithReadings} of the ${a.times.length} times asked.`] : [])];
    case 'place': return (Array.isArray(a.buildings) ? a.buildings : []).slice(0, 3).map((b: any) =>
      `${[b.building && title(b.building), b.block && `Block ${b.block}`, b.road && title(b.road)].filter(Boolean).join(', ')}${b.postal ? `, Singapore ${b.postal}` : ''}${typeof b.distance_m === 'number' ? `: ${b.distance_m} m` : ''}.`);
    case 'transport': {
      const stops = Array.isArray(a.busStops) ? a.busStops : [], stands = Array.isArray(a.taxiStands) ? a.taxiStands : [];
      if (!stops.length && !stands.length) return [`No bus stop or taxi stand within ${a.radius_m} m.`];
      return [...stops.slice(0, 3).map((s: any) => `Bus stop ${s.code}, ${title(String(s.description))} on ${title(String(s.road))}: ${s.distance_m} m.`),
        ...stands.slice(0, 2).map((t: any) => `Taxi ${String(t.type).toLowerCase() || 'stand'} ${t.code}, ${t.name}: ${t.distance_m} m.`)];
    }
    case 'street_picture': {
      const taken = sg(a.capturedAt), rd = a.reading;
      return [`Taken ${taken ? day(taken) : 'on an unknown date'}, ${a.distance_m} m from the place${typeof a.compassAngle === 'number' ? `, facing ${a.compassAngle}°` : ''}.`,
        ...(a.searchCapped ? ['Mapillary returned its limit of pictures here, so a nearer one may exist.'] : []),
        ...(rd ? [rd.shows, `Stopping place shown: ${String(rd.stopping_place).replace(/_/g, ' ')}. No-stopping markings: ${String(rd.no_stopping_markings).replace(/_/g, ' ')}.`, rd.limits] : ['The photo reader gave no reading.'])];
    }
    default: return [];
  }
}
