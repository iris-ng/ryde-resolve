'use client';
import type { CSSProperties } from 'react';
import metricsFile from '../../../../packages/agent-flow/panel-metrics.json';
import { panelConfiguration, panelFingerprint, panelMetricsText, panelSplitText, parsePanelMetrics, servedModel, type PanelMetrics, type PanelSeatSummary, type PanelSummary } from '../../../../packages/agent-flow/panel';
import { ArtifactView, type Cite } from '../fishbowl/live/workbench';
import { confidenceSummary, type ConfidenceScore } from '../../../../packages/agent-flow/confidence';
import { plainText } from '../../../../packages/live-fishbowl/plain';

// The three judges on the Judge card (spec Part 2): each judge's model, which side it read first and its outcome,
// "3 of 3 agree" or the split, and how often released answers were wrong once the scorer has measured it. Mounted in
// status.tsx under the recommendation. A run without a panel (every run since 2 October, when the panel was switched
// off, and every run before 1 October) renders nothing. Styles are inline: lab.css is shared. The code says "seat"; the
// page says "Judge A, B, C" (plain-language pass, 2 October).
type Ev = { actor: string; phase: string; kind: string; data?: any };
const committedMetrics = parsePanelMetrics(metricsFile);
const orderText: Record<PanelSeatSummary['order'], string> = { rider_first: "read the rider's side first", driver_first: "read the driver's side first" };
const mediumText: Record<string, string> = { card: ' to the card', voucher: ' as a voucher' };
const money = (cents: number) => `SGD ${(cents / 100).toFixed(2)}`;
export function seatOutcome(s: Pick<PanelSeatSummary, 'failed' | 'outcome' | 'remedy' | 'riderRecovery'>) {
  if (s.failed) return 'Did not finish: ' + plainText(s.failed);
  const amount = money(s.remedy?.amountCents ?? 0);
  return s.outcome === 'refund_recommendation' ? `Refund ${amount}${mediumText[s.remedy?.medium ?? ''] ?? ''}` : s.outcome === 'charge_recommendation' ? `Cleaning fee ${amount} charged to the rider` : s.outcome === 'driver_payment_recommendation' ? `Pay the driver ${amount}; recover ${money(s.riderRecovery?.amountCents ?? 0)} from the rider`
    : s.outcome === 'no_action' ? 'No action' : 'No recommendation: a person decides';
}
/** The panel keeps the model the harness reported first; when that was a placeholder, read the seat's own events. */
export function seatModel(s: Pick<PanelSeatSummary, 'role' | 'model'>, events: Ev[]) {
  const mine = events.filter(e => e.actor === s.role && e.phase === 'decide');
  return servedModel(s.model) ?? mine.filter(e => e.kind === 'model_reported').map(e => servedModel(e.data?.model)).find(Boolean) ?? servedModel(mine.find(e => e.kind === 'runtime_configured')?.data?.requestedModel) ?? null;
}
const seatLine = (s: PanelSeatSummary, model: string | null) => `${model ?? 'model not reported'} · ${orderText[s.order]}`;

const css: Record<string, CSSProperties> = {
  box: { margin: '0 0 16px', padding: '12px 14px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--surface)', overflowWrap: 'anywhere' },
  head: { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '2px 10px', margin: '0 0 6px', fontSize: 'var(--fs-body)' },
  agree: { color: 'var(--good-ink)', fontWeight: 600 }, split: { color: 'var(--warn)', fontWeight: 600 },
  list: { listStyle: 'none', margin: 0, padding: 0 },
  seat: { display: 'grid', gridTemplateColumns: '56px minmax(0, 1fr)', columnGap: 10, padding: '8px 0', borderTop: '1px solid var(--line)', fontSize: 'var(--fs-body)', lineHeight: 1.5 },
  letter: { gridRow: 'span 3' }, muted: { color: 'var(--muted)', fontSize: 'var(--fs-small)' }, failed: { color: 'var(--bad-ink)', fontWeight: 600 },
  metrics: { margin: '8px 0 0', paddingTop: 8, borderTop: '1px solid var(--line)', fontSize: 'var(--fs-small)', color: 'var(--muted)' },
  score: { margin: '6px 0', fontSize: 'var(--fs-body)' }, lines: { margin: '4px 0', paddingLeft: 18, fontSize: 'var(--fs-small)', lineHeight: 1.5 },
};

export default function PanelSeats({ panel, events = [], metrics = committedMetrics }: { panel?: PanelSummary; events?: Ev[]; metrics?: PanelMetrics }) {
  if (!panel) return null;
  const seats = panel.seats.map(s => ({ ...s, model: seatModel(s, events) }));
  // Measured numbers belong to one configuration; the run's own fingerprint decides whether they describe it.
  const config = panelConfiguration(panel, events);
  return <section className="lab-panel-seats" aria-label="Three arbitrators" style={css.box}>
    <p style={css.head}><b>Three arbitrators</b><span className={'lab-panel-split ' + (panel.agree ? 'panel-agree' : 'panel-split')} style={panel.agree ? css.agree : css.split}>{panelSplitText(panel)}</span></p>
    <ol style={css.list}>
      {seats.map(s => <li key={s.role} data-seat={s.seat} className={'lab-panel-seat' + (s.failed ? ' failed' : '')} style={css.seat}>
        <b style={css.letter}>Arbitrator {s.seat}</b>
        <span className="lab-panel-model">{s.model ?? 'model not reported'}</span>
        <small style={css.muted}>{orderText[s.order]}</small>
        <span className="lab-panel-outcome" style={s.failed ? css.failed : undefined}>{seatOutcome(s)}{s.confidenceScore ? ` · ${s.confidenceScore.score}/${s.confidenceScore.max}` : ''}</span>
      </li>)}
    </ol>
    <p className="lab-panel-metrics" style={css.metrics}>{panelMetricsText(metrics, config ? panelFingerprint(config) : null)}</p>
  </section>;
}

/** The server's 0 to 5 score (confidence.ts): headline, each open question that could change the outcome, the notes, and what the number counts. Runs made before it existed have none. */
export function ConfidenceScoreView({ score, compact = false }: { score?: ConfidenceScore; compact?: boolean }) {
  if (typeof score?.score !== 'number') return null;
  const { headline, lines: stored, note } = confidenceSummary(score), lines = stored.map(plainText);
  const body = <>{lines.length > 0 && <ul style={css.lines}>{lines.map((l, i) => <li key={i}>{l}</li>)}</ul>}<p style={css.muted}>{note}</p></>;
  return compact
    ? <details className="lab-confidence-score" data-score={score.score} style={css.score}><summary><b>{headline}</b></summary>{body}</details>
    : <section className="lab-confidence-score" data-score={score.score} aria-label="Confidence score" style={css.score}><p><b>{headline}</b></p>{body}</section>;
}
/** The Judge's own number stays in the audit, labelled as not used: nothing has shown it predicts a right answer. */
export function ConfidenceNotUsed({ item }: { item: any }) {
  if (typeof item?.confidence !== 'number') return null;
  return <p className="lab-confidence-not-used" style={css.muted}><b>The model's own confidence: {item.confidence} (not used).</b> Nothing has measured whether this number predicts a right answer, so no routing or release depends on it.{item.confidenceBasis ? ` Stated basis: ${item.confidenceBasis}` : ''}</p>;
}
export const withoutConfidence = (item: any) => { const { confidence: _c, confidenceBasis: _b, ...rest } = item ?? {}; return rest; };

/** Judges B and C in full for a reviewer; parties only ever receive Judge A's explanation. */
export function SeatOutputs({ panel, events = [], openSource, disclosed }: { panel?: PanelSummary; events?: Ev[]; openSource: (c: Cite) => void; disclosed?: Record<string, any> }) {
  const others = panel?.seats.filter(s => s.role !== 'judge') ?? [];
  if (!others.length) return null;
  return <div className="lab-panel-outputs">
    {others.map(s => <section key={s.role} className={'lab-panel-output' + (s.failed ? ' failed' : '')} aria-label={'Arbitrator ' + s.seat}>
      <h3>Arbitrator {s.seat} · {seatLine(s, seatModel(s, events))}</h3>
      {s.failed || !s.artifact ? <p style={css.failed}>{seatOutcome(s)}</p> : <><p><b>{seatOutcome(s)}</b></p><ConfidenceScoreView score={s.confidenceScore} compact /><ArtifactView item={withoutConfidence(s.artifact)} openSource={openSource} disclosed={disclosed} /><ConfidenceNotUsed item={s.artifact} /></>}
    </section>)}
  </div>;
}
