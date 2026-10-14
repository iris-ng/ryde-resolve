import type { CasePacket, Task } from './contracts';
import { datasetBlock, datasetCategory, rulesV4 } from '../case-packet/dataset';
import { triage, type Triage } from '../live-fishbowl/triage';
import { chatSafetyReadings } from './chat-checks';

// One safety test for intake, the decision checks and routing (rules rebuild, October 2026). A dispute is a safety case when its
// type is in the safety group, a safety report exists, a ticket issue is marked safety-relevant, or the conservative intake
// screen flags its wording. Before contract 4, routing read the screen alone and the checks the first three: those packets
// keep their old test (safetyInvolvedIn, safetyForRouting). The dispute's branch (branches.ts) reads only the recorded signs
// (recordedSafetyCase), never the wording screen; the screen still sends the case to a person through the checks and routing.
type Sourced = Pick<CasePacket, 'sources'> & Partial<Pick<CasePacket, 'policySelection' | 'contractVersion' | 'factsVersion'>>;
function categoryOf(packet: Sourced): string {
  const ticket = datasetBlock(packet, 'dispute_ticket');
  if (ticket) return datasetCategory({ dispute_ticket: ticket });
  if (packet.policySelection?.category) return packet.policySelection.category;
  try { return JSON.parse(packet.sources.find(s => s.id === 'evidence/intake.json')?.text ?? 'null')?.category ?? 'other'; } catch { return 'other'; }
}
const recordedSafety = (packet: Sourced, category: string) => {
  const ticket = datasetBlock(packet, 'dispute_ticket');
  return category === 'safety' || packet.sources.some(s => s.id === 'evidence/safety_report.json') || (ticket?.issues ?? []).some((i: any) => !!i.safety_relevant);
};
/** The recorded signs only (structured fields): a safety dispute type, a safety report, an issue marked safety-relevant. */
export const recordedSafetyCase = (packet: Sourced) => recordedSafety(packet, categoryOf(packet));
/**
 * The wording screen reads the case's own record: what the parties, Ryde's systems and uploads say. Never the notes our own service
 * steps write during a run (derived/ sources): a Policy Analyst note saying "no abuse" once made the screen flag a no-show fee as a
 * safety case, which barred the Judge's team readings (DISP-042, 7 October 2026). A real allegation is in the record, so it is still read.
 */
const caseRecord = (packet: Sourced): Sourced => ({ ...packet, sources: packet.sources.filter(s => !s.id.startsWith('derived/')) });
export function isSafetyCase(packet: Sourced): boolean {
  return recordedSafety(packet, categoryOf(packet)) || triage(caseRecord(packet)).route !== 'ordinary';
}
/**
 * The second safety opinion (MVP fixes, 10 October 2026, owner decision D5): on a pinned run, the sealed chat reading of a
 * threat or abusive wording counts as a safety allegation, the same as a word-list flag. A person who clears the case lets the
 * run go on, never makes it a safe case: the decision checks and routing still see it. Earlier runs carry no reading.
 */
const chatSafety = (observations: unknown) => chatSafetyReadings(observations).length > 0;
/** Contract 3 and older: the decision checks' test (category, safety report, safety-relevant issue). Any contract: a chat reading of a threat or abuse (task.disclosed). */
export function safetyInvolvedIn(task: Pick<Task, 'packet'> & Partial<Pick<Task, 'disclosed'>>, category: string) {
  return (rulesV4(task.packet) ? isSafetyCase(task.packet) : recordedSafety(task.packet, category)) || chatSafety(task.disclosed?.evidence_collect);
}
/** The safety flag routing receives: the shared test under the rules rebuild (contract 4 and facts 4); older packets the intake screen alone, as before. `observations`: the sealed Evidence Collector output, whose chat reading of a threat or abuse also counts. */
export function safetyForRouting(packet: Sourced, screening: Pick<Triage, 'route'> = triage(packet), observations?: unknown): boolean {
  return (rulesV4(packet) ? isSafetyCase(packet) : screening.route !== 'ordinary') || chatSafety(observations);
}
