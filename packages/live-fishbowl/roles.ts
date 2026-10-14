// Browser-safe phase order and role map, shared by the worker, the store and the lab views.
// A run's decide seats come from its pinned packet: no `panel` means the single Judge of every older run.
import type { Phase, Role } from '../agent-flow/contracts';
export const phaseOrder: Phase[] = ['examine', 'collect', 'apply', 'investigate', 'challenge', 'respond', 'decide'];
export const prePhases: Phase[] = ['examine', 'collect', 'apply'];
type PanelLike = { panel?: { seats: readonly Role[] } };
export const decideRoles = (packet: PanelLike = {}): Role[] => [...(packet.panel?.seats ?? ['judge'])];
export const phaseRoles = (phase: Phase, packet: PanelLike = {}): Role[] =>
  phase === 'decide' ? decideRoles(packet) : phase === 'examine' ? ['photo'] : phase === 'collect' ? ['evidence'] : phase === 'apply' ? ['policy'] : ['rider', 'driver'];
/** The lab shows five cards: seats B and C work at the Judge's card, the photo examiner at the Evidence card. */
export const deskFor = (role: string) => role === 'judge_b' || role === 'judge_c' ? 'judge' : role === 'photo' ? 'evidence' : role;
export const roleLabels: Record<string, string> = { evidence: 'Evidence', policy: 'Policy', rider: 'Rider', driver: 'Driver', judge: 'Arbitrator', judge_b: 'Arbitrator B', judge_c: 'Arbitrator C', photo: 'Photo reader' };
