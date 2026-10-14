'use client';
import type { CSSProperties } from 'react';
import type { IntegrityContext } from '../../../../packages/agent-flow/routing';
import type { HistoryLine, RecordMatch } from '../../../../packages/evidence-collection/integrity';

// The record check (spec Part 3), operator view only, mounted in status.tsx under the recommendation and routing line:
// record matches in full with their cited lines and innocent readings, notes, then account history collapsed.
// Party notices never mention this check. Older events may lack citations, notes or history; each part is optional.
type Shown = Omit<IntegrityContext, 'matches'> & { matches?: (IntegrityContext['matches'][number] & Partial<Pick<RecordMatch, 'label' | 'citations' | 'register'>>)[]; notes?: string[]; history?: HistoryLine[]; reusedFrom?: { runId: string; seq: number } };
const checkNames: Record<string, string> = { receipt_reuse: 'Receipt also in an earlier claim', file_reuse: 'File also in an earlier claim', photo_near_duplicate: 'Photo almost the same as one in an earlier claim', already_settled: 'Claim already settled' };
const sentence = (s: string) => s ? s[0]!.toUpperCase() + s.slice(1) + (/[.!?]$/.test(s) ? '' : '.') : '';
const lines = (c: { sourceId: string; startLine: number; endLine: number }) => `${c.sourceId} ${c.startLine === c.endLine ? 'line ' + c.startLine : `lines ${c.startLine}–${c.endLine}`}`;
const box: CSSProperties = { minWidth: 0, margin: '0 0 16px', padding: 14, border: '1px solid var(--line)', borderRadius: 10, background: 'var(--surface)', overflowWrap: 'anywhere' };
const small: CSSProperties = { fontSize: 'var(--fs-small)', lineHeight: 1.5, color: 'var(--muted)', margin: '6px 0 0' };
const text: CSSProperties = { fontSize: 'var(--fs-body)', lineHeight: 1.6, margin: '6px 0 0' };

export default function IntegrityPanel({ integrity }: { integrity?: Shown }) {
  if (!integrity || typeof integrity !== 'object') return null;
  const matches = integrity.matches ?? [], notes = integrity.notes ?? [], history = integrity.history ?? [];
  const flagged = integrity.status === 'unavailable' || matches.length > 0;
  const headline = integrity.status === 'unavailable' ? 'could not run' : integrity.status === 'checked' ? (matches.length ? `${matches.length} record match${matches.length === 1 ? '' : 'es'} for review` : 'no record match') : 'not configured';
  return <section className={'lab-integrity ' + integrity.status} aria-labelledby="lab-integrity-heading" style={{ ...box, ...(flagged ? { borderColor: 'var(--warn-line)', background: 'var(--warn-soft)' } : {}) }}>
    <h3 id="lab-integrity-heading" style={{ fontSize: 'var(--fs-body)', margin: 0 }}>Record check · <span style={{ fontWeight: 400, color: flagged ? 'var(--ink)' : 'var(--muted)' }}>{headline}</span></h3>
    {integrity.reusedFrom && <p className="lab-integrity-reused" style={small}>Carried from parent run {String(integrity.reusedFrom.runId).slice(0, 8)} (an Arbitrator-only retry); not run again.</p>}
    {integrity.status === 'unavailable' && <p className="lab-integrity-unavailable" style={text}>{integrity.error ? sentence(integrity.error) + ' ' : ''}A person checks the case first. This is not a finding about anyone.</p>}
    {integrity.status === 'checked' && !matches.length && <p style={small}>No receipt, file or settlement in this case matches an earlier claim in the register. This is not a finding that the claim is sound.</p>}
    {matches.length > 0 && <ol className="lab-integrity-matches" style={{ margin: '8px 0 0', paddingLeft: 18 }}>
      {matches.map((m, i) => <li key={i} className="lab-integrity-match" style={{ margin: '0 0 10px' }}>
        <b style={{ fontSize: 'var(--fs-body)' }}>{checkNames[m.check] ?? m.check.replaceAll('_', ' ')}</b>
        <p style={text}>{m.text}</p>
        <p className="lab-integrity-innocent" style={text}><i>Possible innocent reading:</i> {m.innocentReading}</p>
        {m.citations?.length ? <p className="lab-integrity-cited" style={small}>Cited: {m.citations.map(lines).join('; ')}</p> : null}
        <p className="lab-integrity-label" style={{ ...small, color: 'var(--ink-soft)' }}>{sentence(m.label ?? 'a record match for review, not a finding about any person')}</p>
      </li>)}
    </ol>}
    {notes.length > 0 && <ul className="lab-integrity-notes" style={{ ...small, paddingLeft: 18 }}>{notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
    {history.length > 0 && <details className="lab-integrity-history" style={{ ...small, marginTop: 10 }}>
      <summary style={{ cursor: 'pointer' }}>Account history (background only; it never sends a case to a person)</summary>
      <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{history.map(h => <li key={h.party}>{h.text}</li>)}</ul>
    </details>}
    <p style={small}>Operator view. Parties are not told about this check.{integrity.registerSha256 ? ` Register ${integrity.registerSha256.slice(0, 12)}.` : ''}</p>
  </section>;
}
