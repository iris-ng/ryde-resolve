// Addresses of the reference library's pages (apps/web/app/library). Browser-safe: the case page's client components link
// a cited rule or past ruling straight to its page, so this file imports nothing.
export type Shelf = 'rules' | 'rulings' | 'conflicts';
export const shelfNames: Record<Shelf, string> = { rules: 'Ryde rules', rulings: 'Past rulings', conflicts: 'Where Ryde’s pages disagree' };
/**
 * The front page's two doors (user, 8 October): policy is Ryde's rules; precedents are the past rulings. Team readings are
 * in neither: the Arbitrator names one in its analysis when a case rests on it.
 */
export const libraryDoors = ['policy', 'precedents'] as const;
export type Door = typeof libraryDoors[number];
export const isDoor = (v: unknown): v is Door => (libraryDoors as readonly unknown[]).includes(v);
export const doorNames: Record<Door, { name: string }> = { policy: { name: 'Policy' }, precedents: { name: 'Precedents' } };
export const doorOf = (shelf: Shelf): Door => shelf === 'rulings' ? 'precedents' : 'policy';
/** A date as the library writes it: 23 September 2026. */
export const longDate = (iso: string) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
/** The dispute types the library is arranged by, in the order the front page shows them. Cleaning comes first, and the front
 * page opens on it (owner, 14 October 2026). */
export const disputeTypes = ['cleaning', 'no_show', 'route_deviation', 'safety'] as const;
export type DisputeType = typeof disputeTypes[number];
export const disputeTypeNames: Record<DisputeType, string> = { no_show: 'No-show or cancellation fee', route_deviation: 'Route, fare or toll', cleaning: 'Cleaning or damage', safety: 'Safety incident' };
/**
 * The same, short enough for four tabs across a phone. Each is the start of its full name, so voice control finds the tab
 * by the words on screen. The soft hyphen lets "Cleaning" break on the narrowest phones (320px).
 */
export const disputeTypeShortNames: Record<DisputeType, string> = { no_show: 'No-show', route_deviation: 'Route, fare', cleaning: 'Clean\u00ading', safety: 'Safety' };
export const isDisputeType = (v: unknown): v is DisputeType => (disputeTypes as readonly unknown[]).includes(v);
/** A team reading's short number, as a case's decision names it: A5 for A5-DETOUR-TOLL-BORNE-BY-DRIVER. */
export const readingNumber = (id: string) => id.split('-')[0];
/** A past ruling's short number: D11 for PREC-D11-DETOUR-TOLL-NO-CONSENT; a learned ruling keeps its whole id. */
// A file ruling reads as D11; a learned ruling (PREC-L-<run id>) as L-81736302, the first eight characters of its run id.
export const rulingNumber = (id: string) => id.match(/^PREC-(D\d+)-/)?.[1] ?? id.match(/^PREC-L-([0-9a-f]{8})/)?.[1]?.replace(/^/, 'L-') ?? id;
/** An entry's page, by its short number: /library/rules/P10, /library/rulings/D11. */
export const libraryHref = (shelf?: Shelf, id = '') => !shelf ? '/library' : `/library/${shelf}/${encodeURIComponent(shelf === 'rulings' ? rulingNumber(id) : id)}`;
/** An entry opened in the front page's side pane, as it reads in the address: rulings/D11. */
export const paneKey = (shelf: Shelf, number: string) => `${shelf}/${number}`;
/** The front page opened on one dispute type, and on one door (policy unless named): what a case's rules tab links to. */
export const libraryTypeHref = (type: string, door: Door = 'policy') => !isDisputeType(type) ? '/library' : `/library?type=${type}${door === 'policy' ? '' : '&door=' + door}`;
