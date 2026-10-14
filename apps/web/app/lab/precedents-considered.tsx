'use client';
import { precedentsConsidered, similarRulings, type PrecedentCite } from '../../../../packages/live-fishbowl/precedents-view';
import { rulingNumber } from '../../../../packages/policy/library-links';
import { pastRulingsNotPolicy } from '../../../../packages/policy/loop-words';
import { libraryHref } from '../../../../packages/policy/library-links';
import { LibraryLink } from './library-window';

// The past rulings a decision weighed (precedents-view.ts), under the verdict in the full decision view and in the case
// summary. Cited evidence opens the source where the view can open one (the full view); elsewhere it is plain text.
// Below it, the semantic index's "Similar rulings found by meaning" (11 October 2026) from the run's semantic_searched event: scores
// beside the fact comparison's standing, so a reader sees that similarity and binding are two different things. Nothing on older runs.
export default function PrecedentsConsidered({ decision, packet, events, openSource }: { decision: any; packet?: Parameters<typeof precedentsConsidered>[1]; events?: Parameters<typeof similarRulings>[0]; openSource?: (c: PrecedentCite) => void }) {
  const view = precedentsConsidered(decision, packet), similar = similarRulings(events, packet);
  const cite = (c: PrecedentCite, i: number) => { const text = `${c.sourceId.split('/').at(-1)} · L${c.startLine}–${c.endLine}`; return openSource ? <button key={i} type="button" className="citation" onClick={() => openSource(c)}>{text}</button> : <span key={i} className="lab-precedent-cite">{text}</span>; };
  return <section className="lab-precedents-considered" aria-label="Past rulings considered">
    <h4>Past rulings considered</h4>
    <p className="lab-precedents-note">{pastRulingsNotPolicy}</p>
    {view.state === 'listed' ? <ul>{view.items.map(item => <li key={item.id}>
      {/* A team ruling opens its library page; a learned ruling is not in the library until it passes a privacy check. */}
      <p><b>{/^PREC-D\d+-/.test(item.id) ? <LibraryLink href={libraryHref('rulings', item.id)}>{item.id}</LibraryLink> : item.id}</b>{item.title ? <> · {item.title}</> : null}</p>
      <p><b>{item.status}.</b> {item.reason}</p>
      {item.citations.length > 0 && <p className="lab-precedent-cites">{item.citations.map(cite)}</p>}
    </li>)}</ul> : <p>{view.text}</p>}
    {similar.state === 'listed' && <div className="lab-similar-rulings">
      <h4>Similar rulings found by meaning</h4>
      <p className="lab-precedents-note">Found by an embedding search ({similar.model}/{similar.dimension}) and a reranker ({similar.reranker}); rulings with a rerank score of at least {similar.threshold}. Similarity is not a finding that the facts match: the standing column is the fact comparison.</p>
      <table className="lab-check-table lab-similar-table"><thead><tr><th scope="col">Ruling</th><th scope="col">Standing</th><th scope="col">Cosine</th><th scope="col">Rerank</th></tr></thead>
        <tbody>{similar.items.map(item => <tr key={item.id}>
          <td><span>{/^PREC-D\d+-/.test(item.id) ? <LibraryLink href={libraryHref('rulings', item.id)}>{rulingNumber(item.id)}</LibraryLink> : rulingNumber(item.id)}{item.title ? <> · {item.title}</> : null}</span></td>
          <td><span>{item.standing}</span></td><td>{item.cosine.toFixed(2)}</td><td>{item.rerank.toFixed(2)}</td>
        </tr>)}</tbody></table>
    </div>}
    {similar.state === 'none' && <p className="lab-precedents-note">{similar.text}</p>}
  </section>;
}
