import { notFound } from 'next/navigation';
import { buildCatalog } from '../../../../../../packages/policy/catalog';
import { precedents } from '../../../../../../packages/policy/precedents';
import { libraryLoopCards } from '../../../../../../packages/live-fishbowl/store';
import { doorNames, doorOf, libraryTypeHref } from '../../../../../../packages/policy/library-links';
import EntryView from '../../entry-view';

// Every entry renders per request: a learned ruling withdrawn to remove a detail must leave the
// page at once, which a cached render would not. The file entries come from the catalog built once in memory; a learned ruling's
// page (L-xxxxxxxx) reads the database. No static params: the file entries are cheap to render on demand.
const catalog = buildCatalog();
export const dynamic = 'force-dynamic';
const findEntry = async (shelf: string, id: string) => catalog.find(shelf, id) ?? (shelf === 'rulings' && id.startsWith('L-') ? buildCatalog([...precedents, ...(await libraryLoopCards() ?? [])]).find(shelf, id) : undefined);
export async function generateMetadata({ params }: { params: Promise<{ shelf: string; id: string }> }) {
  const { shelf, id } = await params, entry = await findEntry(shelf, decodeURIComponent(id));
  return { title: entry ? `${entry.number} ${entry.title} · Library` : 'Library' };
}

// One entry of the library on its own page (links from a case and from elsewhere land here); the front page shows the same
// entry in its side pane.
export default async function EntryPage({ params }: { params: Promise<{ shelf: string; id: string }> }) {
  const { shelf, id } = await params, entry = await findEntry(shelf, decodeURIComponent(id));
  if (!entry) notFound();
  const door = doorOf(entry.shelf);
  return <main className={'lib-main shelf-' + entry.shelf}>
    <nav className="lib-crumbs" aria-label="Where you are"><a href="/library">Library</a> / <a href={libraryTypeHref(entry.types[0] ?? '', door)}>{doorNames[door].name}</a></nav>
    <EntryView entry={entry} />
  </main>;
}
