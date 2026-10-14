import type { MouseEvent } from 'react';
import type { ConflictEntry, Entry, Link, Quote, RuleEntry, RulingEntry } from '../../../../packages/policy/catalog';
import { disputeTypeNames, longDate } from '../../../../packages/policy/library-links';

// One library entry: its head, its text, and the entries it relies on and that rely on it. The entry's own page shows it
// (level 1, plain links); the front page's side pane shows it too (level 2), where `open` keeps links inside the pane.
/** Opens an entry in the side pane; `from` is the clicked link, where focus returns on close (Safari does not focus a clicked link). */
export type Open = (to: { shelf: Entry['shelf']; number: string }, from?: HTMLElement) => void;
type Props = { entry: Entry; level?: 1 | 2; open?: Open };
const kind: Record<Entry['shelf'], string> = { rules: 'Ryde rule', rulings: 'Past ruling', conflicts: 'Where Ryde’s pages disagree' };
/** A plain click stays in the pane; a modified or middle click opens the entry's page as the browser would. */
export const inPane = (open: Open | undefined, to: { shelf: Entry['shelf']; number: string }) => open && ((e: MouseEvent<HTMLAnchorElement>) => {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault(); open(to, e.currentTarget);
});

export default function EntryView({ entry, level = 1, open }: Props) {
  const Title = level === 1 ? 'h1' : 'h2';
  return <>
    <header className="lib-head">
      <span className="lib-tab" aria-hidden="true">{entry.number}</span>
      <div><Title className="lib-title"><span className="lib-visually-hidden">{entry.number}: </span>{entry.title}</Title><p className="lib-kind">{kind[entry.shelf]}{'readOn' in entry && entry.readOn ? `, as read on ${longDate(entry.readOn)}` : ''}</p>{entry.types.length > 0 && <ul className="lib-types" aria-label="Case categories">{entry.types.map(t => <li key={t}>{disputeTypeNames[t]}</li>)}</ul>}</div>
    </header>
    {entry.shelf === 'rules' && <Rule e={entry} level={level} open={open} />}
    {entry.shelf === 'conflicts' && <Conflict e={entry} level={level} open={open} />}
    {entry.shelf === 'rulings' && <Ruling e={entry} level={level} open={open} />}
  </>;
}

type Part<E> = { e: E; level: 1 | 2; open?: Open };
const Heading = ({ level, children }: { level: 1 | 2; children: React.ReactNode }) => level === 1 ? <h2>{children}</h2> : <h3>{children}</h3>;
function Links({ title, links, empty, level, open }: { title: string; links: Link[]; empty?: string; level: 1 | 2; open?: Open }) {
  if (!links.length && !empty) return null;
  return <section><Heading level={level}>{title}</Heading>{links.length ? <ul>{links.map(l => <li key={l.shelf + l.id}><a className={'shelf-' + l.shelf} href={l.href} onClick={inPane(open, l)}><span className="lib-tab">{l.number}</span><span>{l.title}</span></a></li>)}</ul> : <p>{empty}</p>}</section>;
}
const List = ({ items }: { items: string[] }) => <ul>{items.map(i => <li key={i}>{i}</li>)}</ul>;
function Quotes({ quotes }: { quotes: Quote[] }) {
  // Most quotes come from the help centre; the Terms and the Code of Conduct are on Ryde's main site.
  return <>{quotes.map((q, i) => <figure key={i} className="lib-quote"><blockquote>{q.text}</blockquote><p>{q.url.startsWith('https://help.') ? 'Ryde’s help page' : 'Ryde’s website'}, as read on {longDate(q.archived)}. <a href={q.url} target="_blank" rel="noreferrer">Open Ryde&apos;s page</a></p></figure>)}</>;
}

function Rule({ e, level, open }: Part<RuleEntry>) {
  return <>
    <p className="lib-lead">{e.summary}</p>
    <div className="lib-body">
      <article className="lib-text">
        {e.conditions.length > 0 && <><Heading level={level}>When it applies</Heading><List items={e.conditions} /></>}
        <Heading level={level}>Ryde&apos;s own words</Heading><Quotes quotes={e.quotes} />
      </article>
      <aside className="lib-links" aria-label="Linked entries">
        <Links level={level} open={open} title="Past rulings that apply it" links={e.rulings} empty="None yet." />
        <Links level={level} open={open} title="Rules it depends on" links={e.related} />
        <Links level={level} open={open} title="Where Ryde's pages disagree" links={e.conflicts} />
      </aside>
    </div>
  </>;
}

function Conflict({ e, level, open }: Part<ConflictEntry>) {
  return <>
    <p className="lib-lead">{e.summary}</p>
    <div className="lib-body">
      <article className="lib-text">
        <Heading level={level}>Where it stands</Heading><p>{e.standing}</p>
        {e.quotes.length > 0 && <><Heading level={level}>What the pages say</Heading><Quotes quotes={e.quotes} /></>}
      </article>
      <aside className="lib-links" aria-label="Linked entries">
        <Links level={level} open={open} title="Ryde rules on each side" links={e.rules} />
        <Links level={level} open={open} title="Rules the team's reading rests on" links={e.readingRules} />
      </aside>
    </div>
  </>;
}

function Ruling({ e, level, open }: Part<RulingEntry>) {
  return <>
    <div className="lib-verdict"><p className="lib-outcome">{e.outcome}</p><p>{e.standing}</p></div>
    <div className="lib-body">
      <article className="lib-text">
        <Heading level={level}>What happened</Heading><List items={e.facts} />
        {e.trip && <p className="lib-origin">{e.trip}.</p>}
        <Heading level={level}>The question</Heading><List items={e.questions} />
        <Heading level={level}>Why</Heading><p>{e.reasoning}</p>
        {e.changes.length > 0 && <><Heading level={level}>What would change the answer</Heading><List items={e.changes} /></>}
        {e.matchesOn.length > 0 && <><Heading level={level}>Facts a case is matched on</Heading><table className="lib-facts"><tbody>{e.matchesOn.map(f => <tr key={f.fact}><th scope="row">{f.fact}</th><td>{f.value}</td></tr>)}</tbody></table></>}
        <Heading level={level}>Where it came from</Heading><p className="lib-origin">{e.origin}</p>
      </article>
      <aside className="lib-links" aria-label="Linked entries">
        <Links level={level} open={open} title="Ryde rules it applies" links={e.rules} />
        <Links level={level} open={open} title="Where Ryde's pages disagree" links={e.conflicts} />
      </aside>
    </div>
  </>;
}
