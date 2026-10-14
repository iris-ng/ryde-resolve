import { buildCatalog, policyAsOfLine } from '../../../../packages/policy/catalog';
import { precedents } from '../../../../packages/policy/precedents';
import { libraryLoopCards } from '../../../../packages/live-fishbowl/store';
import { disputeTypes, isDisputeType, isDoor } from '../../../../packages/policy/library-links';
import Browser from './browser';

// The library's front page (user, 8 October: kept clean): one line, the four case categories as folder tabs, and inside the
// chosen one two doors, policy and precedents. An entry opens in a side pane beside the list (?open=rulings/D11). A case's
// rules tab opens it on that case's category (?type=); otherwise it opens on the first category, cleaning (owner, 14 October).
export const dynamic = 'force-dynamic';
export default async function LibraryPage({ searchParams }: { searchParams: Promise<{ type?: string; door?: string; open?: string }> }) {
  // Learned rulings a person approved and marked join the file rulings here, read at request time (11 October 2026).
  const { type, door, open } = await searchParams, catalog = buildCatalog([...precedents, ...(await libraryLoopCards() ?? [])]);
  const [shelf, number] = (open ?? '').split('/'), opened = shelf && number ? catalog.find(shelf, number) : undefined;
  return <main className="lib-main lib-front">
    <h1>Explore the policy and precedent library</h1>
    <Browser entries={catalog.entries} asOf={policyAsOfLine()} initialType={isDisputeType(type) ? type : opened?.types[0] ?? disputeTypes[0]} initialDoor={isDoor(door) ? door : 'policy'} initialOpen={opened ? opened.shelf + '/' + opened.number : null} />
    <p className="lib-footnote">Ryde has not approved this library. Past rulings are hypotheticals, not real trips.</p>
  </main>;
}
