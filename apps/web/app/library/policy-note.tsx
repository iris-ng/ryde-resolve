'use client';
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { Entry } from '../../../../packages/policy/catalog';
import { libraryHref } from '../../../../packages/policy/library-links';
import EntryView, { inPane, type Open } from './entry-view';

// Where our rules differ from the organisers' sample policy, Policy v2.1, sent on 13 October 2026 (owner, 13 October 2026).
// Each line was checked against v2.1 and our rules. Shown on the operator site and the public copy alike (owner, 13 October 2026).
// The organisers' three sample cases (owner, 14 October 2026): a second fold-out, one row a case, with the answer each rule book
// gives and what our system did when it ran them on 14 October 2026.
const orgCases: { id: string; title: string; story: string; theirs: string; ours: string; same: boolean; did: string; why: string }[] = [
  { id: 'ORG-001', title: 'A longer route to Changi', same: false,
    story: 'Charged S$35.00 on a S$28.50 estimate. The driver went round a car fire on the PIE and never told the rider.',
    theirs: 'Refund S$3.44 for the extra distance, at the per-km rate in their sample file. Their own rule 6.2 then sends a detour over 2 km to a person.',
    ours: 'No refund. The meter fare stands when the record explains the detour, and the fire does. Not telling the rider is a conduct matter; Ryde\'s pages attach no money to it.',
    did: 'No refund, but a person decides.',
    why: 'The file does not say which service was booked or how it was booked, so no service-specific fare rule can be fitted, and the S$2.22 toll has no itemised entry. On its latest run the Arbitrator named no refund and still handed the case over; on one earlier run it named no answer at all.' },
  { id: 'ORG-002', title: 'A no-show fee', same: true,
    story: 'A S$5.00 fee. Booked 08:45, the driver was at the pin at 08:43, sent 4 messages and called once, and cancelled at 08:51. The rider says they waited in the lobby.',
    theirs: 'The fee stands. The driver waited past the 5 minutes from the booked time and made contact.',
    ours: 'The fee stands too, if the rider was not there: the driver was at the pin and waited more than 3 minutes.',
    did: 'No recommendation; a person decides.',
    why: 'Nothing in the file records where the rider was or when. The rider\'s account of waiting in the lobby cannot be checked against a record, and it would change the answer.' },
  { id: 'ORG-003', title: 'A surge nobody mentioned', same: true,
    story: 'Quoted S$12.00, charged S$16.50 after the surge rose from 1.0 to 1.5 before pickup. The rider was not told.',
    theirs: 'Refund S$4.50, the surge difference. Under S$10, so their AI decides.',
    ours: 'Refund S$4.50. A fixed quote is the fare; a surge after booking does not change it.',
    did: 'Refund S$4.50, but a person decides.',
    why: 'The file never says which service was booked. Our note marking it as an assumed on-demand ride was not accepted by the Arbitrator, which also flagged that the payment record was rebuilt from the fare.' },
];

const rows: { topic: string; theirs: string; ours: string; rules: string[] }[] = [
  { topic: 'No-show', rules: ['P04', 'P28', 'P14', 'P01'],
    theirs: 'The driver must wait 5 minutes from the scheduled pickup time, and send at least 1 message and make at least 1 call. If not, the rider pays no fee. The fee is S$5, paid to the driver.',
    ours: 'The driver must mark arrival at the pickup and wait more than 3 minutes. Each side should try to reach the other by chat or call, but Ryde sets no minimum. The rider pays S$6.61 and the driver gets S$4.50. RydeTAXI trips are not covered.' },
  { topic: 'Detour', rules: ['P10', 'P33', 'P18'],
    theirs: 'Over 1 km with no traffic reason: the fare for the extra distance is refunded. Over 1 km because of traffic: part of it is refunded if the rider was not told, none if the rider was told and agreed. 1 km or less: no refund.',
    ours: 'The quoted fare is fixed: a longer route can add tolls, nothing else. The driver may choose the route, but a route the rider asks for must be agreed before the trip. Our team\'s reading A12, not Ryde\'s wording: if a metered taxi leaves the app\'s route, the rider is refunded what the meter charged above the top of the app\'s estimate, unless the record explains the detour or the driver says the rider agreed.' },
  { topic: 'Surge', rules: ['P33', 'P12'],
    theirs: 'If surge rises between the quote and the start of the trip, the app must tell the rider the new fare and offer free cancellation. Without that notice, the difference is refunded. If the rider was told and went ahead, the higher fare stands.',
    ours: 'Quoted fares are generally fixed, whatever the surge (except RydeTAXI). Tolls and an accepted change of destination can still add to the total. Ryde\'s pages say nothing about telling the rider of a surge.' },
  { topic: 'Cleaning', rules: ['P19', 'P20'],
    theirs: 'Up to S$50, with timestamped photos taken in the app and sent within 24 hours of the trip. No quote from a cleaner is needed. Repairs are paid at cost, with a written quote from a certified workshop within 7 days.',
    ours: 'Up to S$40 for food or drink, S$120 for bodily fluids or stains, and S$200 for vomit. The car must be professionally cleaned within 24 hours and the claim made within 48 hours, with photos and a cleaning receipt. There is no rule on repairs.' },
  { topic: 'When a person decides', rules: [],
    theirs: 'Claims over S$50; claims of S$10 to S$50, and any detour, when the AI is less than 80% sure; detours over 2 km; damage claims the rider disputes; and any safety concern. A fraud flag raises the bar to 95%. Under S$10, the AI\'s ruling is final.',
    ours: 'Amounts over S$50 (S$200 for a vomit clean-up that passes every check); a missing fact that could change the answer; an open rule question worth more than S$10; a fare refund that does not match the overcharge on record; and any safety concern or record-check finding. The AI\'s own confidence figure is never used. Every recommendation released without a person\'s review can be appealed by either side.' },
];

// A rule named in the note opens in a popup over the page, so the reader stays on the page (owner, 13 October 2026). Links
// inside the popup open there too. Escape, the close button or a click outside closes it, and focus goes back to the link.
// Escape is handled here first, so a side pane open behind the popup stays open (browser.tsx skips a handled Escape).
export default function PolicyNote({ entries }: { entries: Entry[] }) {
  const [opened, setOpened] = useState<Entry | null>(null);
  const dialog = useRef<HTMLDialogElement>(null), from = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const d = dialog.current;
    if (!opened || !d) return;
    if (!d.open) d.showModal();
    d.scrollTo({ top: 0 });
    d.querySelector<HTMLElement>('.lib-pane-close')?.focus({ preventScroll: true });
  }, [opened]);
  const open: Open = (to, clicked) => {
    const entry = entries.find(e => e.shelf === to.shelf && e.number === to.number);
    if (!entry) { location.assign(libraryHref(to.shelf, to.number)); return; }
    if (!dialog.current?.open) from.current = clicked ?? null;
    setOpened(entry);
  };
  const close = () => dialog.current?.close();
  const closed = () => { setOpened(null); from.current?.focus({ preventScroll: true }); from.current = null; };
  const escape = (e: KeyboardEvent<HTMLDialogElement>) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  const outside = (e: MouseEvent<HTMLDialogElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (e.target === e.currentTarget && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) close();
  };
  return <section className="lib-note" aria-labelledby="lib-note-title">
    <h2 id="lib-note-title">How our rules differ from the organisers' sample policy</h2>
    <p>This library holds Ryde's rules as stated on Ryde's public help pages. Our agents apply these, plus a few team readings where the pages are silent. The organisers' sample, Policy v2.1, is a different rule book, so the same case can have a different outcome.</p>
    <details>
      <summary>How does Policy v2.1 differ from the Ryde rules?</summary>
      <table role="table">
        <thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col"><span className="lib-visually-hidden">Topic</span></th><th role="columnheader" scope="col">Organisers' Policy v2.1</th><th role="columnheader" scope="col">Our rules</th></tr></thead>
        <tbody role="rowgroup">{rows.map(r => <tr role="row" key={r.topic}>
          <th role="rowheader" scope="row">{r.topic}</th>
          <td role="cell" data-label="Organisers' Policy v2.1">{r.theirs}</td>
          <td role="cell" data-label="Our rules">{r.ours}{r.rules.length > 0 && <span className="lib-note-rules">{r.rules.length > 1 ? 'Rules ' : 'Rule '}{r.rules.map((id, i) => <span key={id}>{i ? ', ' : ''}<a href={libraryHref('rules', id)} onClick={inPane(open, { shelf: 'rules', number: id })}>{id}</a></span>)}</span>}</td>
        </tr>)}</tbody>
      </table>
      <p className="lib-note-foot">The organisers sent Policy v2.1 on 13 October 2026.</p>
    </details>
    <p className="lib-note-line">How would the organisers' sample cases fare under the rules?</p>
    <details>
      <summary>The organisers' sample cases</summary>
      <table role="table" className="lib-note-cases">
        <thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col">Case</th><th role="columnheader" scope="col">Under Policy v2.1</th><th role="columnheader" scope="col">Under our rules</th><th role="columnheader" scope="col">What our system did</th></tr></thead>
        <tbody role="rowgroup">{orgCases.map(c => <tr role="row" key={c.id}>
          <th role="rowheader" scope="row"><span className="lib-note-case">{c.title}</span><span className="lib-note-story">{c.story}</span></th>
          <td role="cell" data-label="Under Policy v2.1">{c.theirs}</td>
          <td role="cell" data-label="Under our rules">{c.ours}<span className={'lib-note-tag' + (c.same ? ' is-same' : '')}>{c.same ? 'Same answer as v2.1' : 'Different answer from v2.1'}</span></td>
          <td role="cell" data-label="What our system did"><strong>{c.did}</strong> {c.why}</td>
        </tr>)}</tbody>
      </table>
      <div className="lib-note-why">
        <p><strong>Why all three went to a person.</strong> The organisers' files are shorter than Ryde's own records: no service type, no booking mode, no payment events, no rider position. Our system is built to surface gaps in the evidence rather than guess. Where a missing fact could change the answer, it names the gap and hands the case to a person with the facts it did settle.</p>
        <p>The route and the no-show cases were run three times, on 13 October and twice on 14 October. Every run sent both to a person for the same gaps.</p>
      </div>
    </details>
    <dialog ref={dialog} className={'lib-pane lib-dialog shelf-' + (opened?.shelf ?? 'rules')} aria-label={opened ? `${opened.number}: ${opened.title}` : undefined} onKeyDown={escape} onClick={outside} onClose={closed}>
      {opened && <>
        <div className="lib-pane-bar"><a href={opened.href} target="_blank" rel="noreferrer">Open as a page ↗</a><button type="button" className="lib-pane-close" onClick={close} aria-label="Close" title="Close">×</button></div>
        <EntryView entry={opened} level={2} open={open} />
      </>}
    </dialog>
  </section>;
}
