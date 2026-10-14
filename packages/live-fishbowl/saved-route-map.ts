import register from '../../evidence/registers/route-maps.json';

// The saved street map travels with the case it belongs to (12 October 2026): the server reads the register and sends only
// the open case's entry, beside the case file (route.ts `routeMap`), so the page never holds the list of every case with a map
// and the case file stays as sealed. Server only. The page joins it to its in-memory copy of the file (use-lab.ts withMap),
// checks the entry's shape itself (route-map.ts savedMap) and shows the save date in its credit.
export type SavedRouteMap = { map: unknown; savedAt: string };
const entries = register.entries as Record<string, unknown>;
export function savedRouteMapFor(caseId: unknown): SavedRouteMap | null {
  return typeof caseId === 'string' && Object.hasOwn(entries, caseId) ? { map: entries[caseId], savedAt: register.fetched_at } : null;
}
/** The case file as the page holds it in memory, with its saved street map joined (tests render the map cards with this). */
export function withSavedRouteMap<P extends { caseId?: unknown }>(packet: P): P & { routeMap?: SavedRouteMap } {
  const routeMap = savedRouteMapFor(packet?.caseId);
  return routeMap ? { ...packet, routeMap } : packet;
}
