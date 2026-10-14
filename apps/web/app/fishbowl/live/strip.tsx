'use client';
import { memo } from 'react';
import OtterJudge, { judgeState } from './otter-judge';
import PangoDriver from './pango-driver';
import SpriteAgent from './sprite-agent';
import FrameCanvas from './frame-canvas';
import type { Character } from '../../../../../packages/live-fishbowl/sprite-engine';
import type { DeskState } from '../../../../../packages/live-fishbowl/desk-state';
import type { GateTone } from '../../../../../packages/live-fishbowl/gates';
import type { TargetView } from '../../../../../packages/live-fishbowl/sla';

// The run in order: the safety screen and the record check, five desks, then the release check. A desk's colour carries
// its state (yellow working, green done, red failed); only a working desk shows what it is doing. The checks are plain
// code, not agents, so they are drawn as gates and always say their state in words. Re-renders only when something drawn changes.
// Role colours are theme tokens (styles.css), so the figures follow the light or dark theme.
export const colors: Record<DeskState['role'], string> = { evidence: 'var(--role-evidence)', policy: 'var(--role-policy)', rider: 'var(--role-rider)', driver: 'var(--role-driver)', judge: 'var(--role-judge)' };
export function Person({ color }: { color: string }) {
  return <g className="person" shapeRendering="crispEdges" transform="translate(32 66) scale(0.72)">
    <path fill="#24293d" d="M-18-64h32v8h8v24H-22v-24h4z" />
    <path fill="#e3ad83" d="M-14-52h26v28h-26zM12-46h6v12h-6z" />
    <path fill="#24293d" d="M-18-56h30v8H-6v8h-12zM-8-42h4v4h-4zM6-42h4v4H6z" />
    <path fill="#bd795e" d="M-2-30h10v4H-2z" />
    <path style={{ fill: color }} d="M-22-20h42v32h-42zM-30-12h8v24h-8zM20-12h8v24h-8z" />
    <path fill="#e3ad83" d="M-30 10h12v8h-12zM18 10h12v8H18z" />
    <path fill="#28374b" d="M-18 12h14v24h-14zM6 12h14v24H6z" />
  </g>;
}
// The supplied characters (3 October; frog and rooster replaced 5 October): the frog detective gathers evidence, the rooster reads the policy, the fish argues
// for the rider on the phone. The otter judges and the pangolin drives. The person figure is the fallback.
export const characterOf: Partial<Record<DeskState['role'], Character>> = { evidence: 'frog', policy: 'rooster', rider: 'fish' };
// Screen readers get the state in words, since sighted users read it from the colour.
const spoken: Record<DeskState['status'], string> = { waiting: 'waiting', working: 'working', sealed: 'done', ready: 'done', attention: 'failed, needs attention', stopped: 'stopped' };
function Desk({ desk, selected, onSelect }: { desk: DeskState; selected: boolean; onSelect: (role: DeskState['role']) => void }) {
  const working = desk.status === 'working';
  return <button type="button" className={`desk ${desk.status}${selected ? ' selected' : ''}`} data-role={desk.role} aria-pressed={selected} onClick={() => onSelect(desk.role)} title={`${desk.title}: ${desk.line}${working && desk.detail ? ', ' + desk.detail : ''}`}>
    <span className="desk-figure">{desk.role === 'judge' ? <OtterJudge state={judgeState(desk)} /> : desk.role === 'driver' ? <PangoDriver state={judgeState(desk)} /> : characterOf[desk.role] ? <SpriteAgent character={characterOf[desk.role]!} state={judgeState(desk)} /> : <svg viewBox="0 0 64 104" aria-hidden="true">
      <rect x="6" y="70" width="52" height="8" fill="#ad7f53" /><rect x="10" y="78" width="6" height="18" fill="#876244" /><rect x="48" y="78" width="6" height="18" fill="#876244" />
      <rect x="12" y="52" width="20" height="16" fill="#33494f" /><rect x="14" y="54" width="16" height="12" fill={working ? '#99d6c0' : '#829f9b'} />
      <Person color={colors[desk.role]} />
    </svg>}</span>
    <span className="desk-text">
      <b>{desk.title}</b>
      <span className="desk-line" aria-hidden="true">{working ? desk.line : '\u00a0'}</span>
      {working && desk.detail ? <small className="desk-detail" aria-hidden="true">{desk.detail}</small> : null}
    </span>
    <i className="desk-state">{working ? `working: ${desk.line}${desk.detail ? ', ' + desk.detail : ''}` : spoken[desk.status]}</i>
  </button>;
}
/** `target`: the response-time target of the case this gate holds (sla.ts). It has its own line on the card, shown at
 *  every width, unlike the note, which narrow cards leave to the tooltip and the dialog. */
export type GateView = { tone: GateTone; word: string; note: string; target?: Pick<TargetView, 'tone' | 'state' | 'label' | 'card' | 'short'> | null };
export type StripGates = { screen: GateView; record?: GateView; release: GateView; onScreen: () => void; onRecord?: () => void; onRelease: () => void };
const marks: Record<GateTone, string> = { clear: '✓', review: '!', urgent: '!', waiting: '…', idle: '–' };
const gateIcons = {
  screen: <path d="M12 2.5 4.5 5.4v5.7c0 4.7 3.2 8.8 7.5 10.4 4.3-1.6 7.5-5.7 7.5-10.4V5.4z" />,
  release: <path d="M5.5 21.5V3M5.5 4h12l-2.6 4.2 2.6 4.3h-12" />,
  record: <path d="M7 3.5h7.5l3.5 3.5v13.5H7zM14.5 3.5V7H18M10 11h5M10 14.5h5M10 18h3" />,
};
function Gate({ kind, title, gate, onOpen }: { kind: 'screen' | 'record' | 'release'; title: string; gate: GateView; onOpen: () => void }) {
  const t = gate.target, note = t ? `${gate.note}. ${t.short}` : gate.note;
  return <button type="button" className={`gate gate-${kind} tone-${gate.tone}`} aria-haspopup="dialog" onClick={onOpen} title={note} aria-label={`${title}: ${gate.word}. ${note}`.replace(/\.\.$/, '.')}>
    <svg className="gate-icon" viewBox="0 0 24 24" aria-hidden="true">{gateIcons[kind]}</svg>
    <span className="gate-text" aria-hidden="true"><b>{title}</b><span className="gate-word"><i className="gate-mark">{marks[gate.tone]}</i>{gate.word}</span><small>{gate.note}</small>
      {t && <span className={`gate-target tone-${t.tone} sla-${t.state}`}><span className="gate-target-label">{t.label}</span>{t.card && <> <span>{t.card.replace(/(\d) /g, '$1\u00a0')}</span></>}</span>}</span>
  </button>;
}
function Strip({ states, selected, onSelect, gates }: { states: DeskState[]; selected: string; onSelect: (role: DeskState['role']) => void; gates?: StripGates }) {
  return <div className={'live-strip' + (gates ? ' with-gates' : '') + (gates?.record ? ' with-record' : '')} role="group" aria-label="Run order">
    {gates && <Gate kind="screen" title="Safety screen" gate={gates.screen} onOpen={gates.onScreen} />}
    {gates?.record && gates.onRecord && <Gate kind="record" title="Record check" gate={gates.record} onOpen={gates.onRecord} />}
    {states.map(d => <Desk key={d.role} desk={d} selected={selected === d.role} onSelect={onSelect} />)}
    {gates && <Gate kind="release" title="Release check" gate={gates.release} onOpen={gates.onRelease} />}
  </div>;
}
const sameGate = (a?: GateView, b?: GateView) => a === b || (!!a && !!b && a.tone === b.tone && a.word === b.word && a.note === b.note
  && a.target?.short === b.target?.short && a.target?.card === b.target?.card && a.target?.tone === b.target?.tone);
export default memo(Strip, (a, b) => a.selected === b.selected && a.onSelect === b.onSelect && a.states.length === b.states.length && a.states.every((d, i) => d.status === b.states[i].status && d.line === b.states[i].line && d.detail === b.states[i].detail)
  && !!a.gates === !!b.gates && (!a.gates || (sameGate(a.gates.screen, b.gates?.screen) && sameGate(a.gates.record, b.gates?.record) && sameGate(a.gates.release, b.gates?.release) && a.gates.onScreen === b.gates?.onScreen && a.gates.onRecord === b.gates?.onRecord && a.gates.onRelease === b.gates?.onRelease)));

// A small standalone portrait of one agent, for name tags outside the strip.
export function Avatar({ role }: { role: DeskState['role'] }) {
  // Drawn from the same page-wide frame store as the desks, so a new message never fetches its portrait again.
  const still = role === 'judge' ? ['/otter/native/sources', 'idle_native.png'] : role === 'driver' ? ['/pango/native', 'idle.png'] : characterOf[role] ? [`/${characterOf[role]}/native`, 'idle.png'] : null;
  if (still) return <FrameCanvas className="avatar otter-avatar" base={still[0]!} frames={[still[1]!]} current={still[1]!} />;
  return <svg className="avatar" viewBox="4 14 56 82" aria-hidden="true"><Person color={colors[role]} /></svg>;
}
