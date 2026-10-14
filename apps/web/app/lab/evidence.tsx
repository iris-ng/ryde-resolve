'use client';
import { useEffect, useId, useRef, useState } from 'react';
import type { Cite } from '../fishbowl/live/workbench';
import type { Lab } from './use-lab';
import PhotoEvidence from './photo-evidence';
import { ChatReadingCard, FareCard, RouteCard, WaitMapCard } from './evidence-checks';
import { HistoryCard } from './record-checks';
import { ChatRecord, ExternalRecord, FareRecord, GpsRecord, HistoryRecord } from './evidence-record';
import { evidenceTabs, openingTab, type EvidenceTab } from './evidence-tabs';

// The left column: one tab per type of evidence (evidence tabs, user, 10 October 2026), each holding that type's record and
// any analysis of it: GPS and telemetry (the route figures, app events, and after a run the route drawing on its street map
// and the route checks), chat and calls (the messages, and after a run the Evidence Collector's reading), payment and fare,
// past behaviour (labelled as context only), external data (the Evidence Collector's lookups), and the files (photos and
// the list; the drop zone for adding documents to a case was removed on the owner's word, 11 October 2026: cases arrive
// built, and a new case takes its documents in the New case dialog). A case opens on the tab that best fits its dispute (evidence-tabs.ts);
// a tab picked by hand stays until another case opens, kept by the page so hiding and restoring the column keeps it too.
// The list of files is folded under one "Case documents" row until
// clicked, and shows file names only (user, 7 October). The checks are the run's own, from its locked case file.
// The tabs stay at the top of the pane in two rows of three, and the GPS tab leads with the route on its map, the
// explanation below it (user, 10 October 2026).
export type EvidencePick = { id: string; tab: EvidenceTab } | null;
export default function Evidence({ lab, openSource, picked: kept, onPick }: { lab: Lab; openSource: (c: Cite) => void; picked?: EvidencePick; onPick?: (p: EvidencePick) => void }) {
  const { workspace, run, events } = lab;
  const [own, setOwn] = useState<EvidencePick>(null), [listOpen, setListOpen] = useState(false);
  const picked = onPick ? kept ?? null : own, setPicked = onPick ?? setOwn;
  const listId = useId(), tabsId = useId();
  const bar = useRef<HTMLDivElement>(null), panel = useRef<HTMLDivElement>(null);
  useEffect(() => { setListOpen(false); }, [workspace?.id]);
  if (!workspace) return null;
  const packet = run?.packet ?? workspace.packet;
  const tab = picked?.id === workspace.id ? picked.tab : openingTab(packet);
  // A case file this packet left out (the advance outside data, from evidence checks 4) is not listed; an upload made after a run is.
  const documents = [...workspace.baseDocuments.filter(d => !d.id.startsWith('policy/') && packet.sources.some(s => s.id === d.id)), ...workspace.documents];
  // Whether the Evidence Collector looks outside data up, as the server says (AD-11): in this run, or in the next one when none is shown.
  const lookups = !!(run?.packet ? run.outsideLookups : workspace.outsideLookups);
  const reading = (key: string) => events.find(e => e.kind === 'disclosed' && e.data?.[key])?.data?.[key];
  const checks = run?.checks;
  // A tab picked while the evidence is scrolled down opens at its start, just under the pinned tabs: the pane
  // scrolls on a desktop, the page on a phone. The panel's top does not move when its content changes, so it is measured now.
  const choose = (next: EvidenceTab) => {
    setPicked({ id: workspace.id, tab: next });
    // Under the bar by its own bottom margin, as the panel sits when nothing is scrolled.
    const top = panel.current?.getBoundingClientRect().top, under = bar.current && bar.current.getBoundingClientRect().bottom + parseFloat(getComputedStyle(bar.current).marginBottom || '0');
    if (top === undefined || under === undefined || under === null || top >= under) return;
    const pane = panel.current!.closest<HTMLElement>('.lab-pane-body'), scrolls = !!pane && ['auto', 'scroll'].includes(getComputedStyle(pane).overflowY);
    if (scrolls) pane!.scrollTop += top - under; else scrollBy(0, top - under);
  };
  return <div className="lab-evidence">
    <div ref={bar} className="lab-evidence-tabbar"><div className="live-tabs lab-evidence-tabs" role="tablist" aria-label="Evidence sections">{evidenceTabs.map(t => <button key={t.key} id={`${tabsId}-${t.key}`} type="button" role="tab" aria-selected={tab === t.key} aria-pressed={tab === t.key} aria-controls={`${tabsId}-panel`} title={t.title} onClick={() => choose(t.key)}>{t.label}</button>)}</div></div>
    <div ref={panel} role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-${tab}`}>
      {tab === 'gps' && <>
        {run && <RouteCard packet={packet} checks={checks} openSource={openSource} />}
        {run && <WaitMapCard packet={packet} checks={checks} openSource={openSource} />}
        <GpsRecord packet={packet} openSource={openSource} />
      </>}
      {tab === 'chat' && <>
        <ChatRecord packet={packet} openSource={openSource} />
        <ChatReadingCard packet={packet} reading={reading('evidence_collect')} openSource={openSource} />
      </>}
      {tab === 'fare' && <>
        <FareRecord packet={packet} checks={checks} openSource={openSource} />
        {run && <FareCard checks={checks} openSource={openSource} />}
      </>}
      {tab === 'history' && <>
        {!checks?.history?.length && <HistoryRecord packet={packet} />}
        {run && <HistoryCard packet={packet} checks={checks} openSource={openSource} />}
      </>}
      {tab === 'external' && <>
        <ExternalRecord packet={packet} runId={run?.id} lookups={lookups} events={events} openSource={openSource} />
      </>}
      {tab === 'files' && <>
        <PhotoEvidence photos={packet.photos} reading={reading('photo_examine')} workspaceId={workspace.id} runId={run?.id} />
        {documents.length ? <>
          <button type="button" className="lab-documents-toggle" aria-expanded={listOpen} aria-controls={listId} onClick={() => setListOpen(o => !o)}><span>Case documents</span><span className="lab-documents-count">{documents.length}</span><span className="lab-chevron" aria-hidden="true">⌄</span></button>
          <ul id={listId} className="lab-documents" hidden={!listOpen}>{documents.map(d => { const source = packet.sources.find(s => s.id === d.id); return <li key={d.id}><button type="button" disabled={!source} onClick={() => source && openSource({ sourceId: d.id, startLine: 1, endLine: source.lines.length })}>{d.filename}</button></li>; })}</ul>
        </> : <p className="lab-empty">This case has no documents.</p>}
      </>}
    </div>
  </div>;
}
// The tray slides over the chat column from the evidence column and shows one original with the cited lines lit.
// Escape closes it through the page's layered Escape handler (lab.tsx).
export function SourceTray({ packet, cite, onClose, onDownload }: { packet: { sources: { id: string; sha256: string; lines: string[] }[] } | undefined; cite: Cite | null; onClose: () => void; onDownload: (id: string) => void }) {
  const box = useRef<HTMLElement>(null);
  const source = cite && packet?.sources.find(s => s.id === cite.sourceId);
  useEffect(() => { if (source) box.current?.focus(); }, [source]);
  useEffect(() => { if (cite && source) box.current?.querySelector('.read-line')?.scrollIntoView({ block: 'center' }); }, [cite, source]);
  if (!cite) return null;
  return <aside ref={box} tabIndex={-1} className="lab-tray" role="dialog" aria-label={'Original ' + cite.sourceId}>
    <div className="lab-tray-head"><div><h3>{cite.sourceId}</h3>{source && <small>SHA-256 {source.sha256}</small>}</div>{source && <button type="button" onClick={() => onDownload(source.id)}>Download original</button>}<button type="button" className="quiet" onClick={onClose} aria-label="Close original">×</button></div>
    {source ? <pre>{source.lines.map((line, i) => <span key={i} className={i + 1 >= cite.startLine && i + 1 <= cite.endLine ? 'read-line' : ''}><i>{i + 1}</i>{line}{'\n'}</span>)}</pre> : <p className="lab-empty">This document is not part of this run. Pick the run that used it.</p>}
  </aside>;
}
