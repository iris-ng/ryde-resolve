import type { Artifact, CasePacket } from './contracts';
import { quoteProblem } from './quotes';

// Evidence checks 2 (MVP fixes F3, owner's rework, 10 October 2026): a gap in the record weighs against a point and never stops a
// run. A challenge may file gap points: a record the advocate asked for in this task (request_record) that is not on record or that
// can't be checked, and the opposing claim it weakens. The server numbers them; the Arbitrator answers each one
// (reduces_weight or no_effect). No routing rule, money check or release limit reads a gap point (routing.ts, panel.ts).
// Checked in the claim checks' one-pass style (claim-checks.ts): every problem in one rejection, which reaches the event trail before
// the paired disclosure, so it names a gap point by number and repeats an ID only when it is one the server issued (citations.ts, rule 1).

type Request = { requestId: string | null; answer: string | null; points: { sourceId: string; startLine: number; endLine: number }[] };
type GapPoint = NonNullable<Artifact['gapPoints']>[number];
const label = (i: number) => `Gap point ${i + 1}`;
const where = (p: Request['points']) => p.slice(0, 2).map(x => `${x.sourceId} lines ${x.startLine}-${x.endLine}`).join('; ');

/** The record requests this task made, from the server's lookup trail on the artifact (tools.ts attaches it before validation). */
export const requestsIn = (artifact: Pick<Artifact, 'lookups'>): Request[] => (artifact.lookups ?? []).filter(l => l.tool === 'request_record' && l.request).map(l => l.request!);
/** The server's number for each gap point: the challenge's artifact ID, then #G1, #G2 and so on (like claims #1 and issues #I1). */
export const gapPointIdFor = (artifactId: string, i: number) => `${artifactId}#G${i + 1}`;

/**
 * Every problem with a pinned challenge's gap points, in order, empty when they stand: the server owns gapPointId; each requestId names
 * a request made in this task whose answer is the one given and is not_on_record or cannot_check (a record on record is read and cited,
 * not a gap); targetClaimId names a claim in the opposing argument that no other gap point names; each quote is in its lines.
 */
export function gapPointProblems(packet: Pick<CasePacket, 'sources'>, artifact: Pick<Artifact, 'lookups' | 'artifactId'> & { gapPoints?: GapPoint[] }, opposing: Pick<Artifact, 'claims'> | undefined): string[] {
  const problems: string[] = [], requests = requestsIn(artifact), claims = new Set((opposing?.claims ?? []).map(c => c.claimId)), seen = new Set<string>();
  (artifact.gapPoints ?? []).forEach((g, i) => {
    const id = gapPointIdFor(artifact.artifactId ?? '', i);
    if (g.gapPointId !== undefined && g.gapPointId !== id) problems.push(`${label(i)}: gap point identity is server-owned. Omit gapPointId; the server numbers gap points ${gapPointIdFor(artifact.artifactId ?? '', 0)}, #G2 and so on.`);
    const request = requests.find(r => r.requestId !== null && r.requestId === g.requestId);
    if (!request) problems.push(`${label(i)}: requestId names no record request made in this task. Ask for the record with request_record in this task, then give the requestId it returns.`);
    else if (request.answer === 'on_record') problems.push(`${label(i)}: request ${request.requestId} was answered on_record: the case record has it (${where(request.points)}), so it is not a gap. Read those lines and cite what they show, or remove this gap point.`);
    else if (request.answer !== g.answer) problems.push(`${label(i)}: answer must be what request_record answered for ${request.requestId}: ${request.answer}.`);
    if (!claims.has(g.targetClaimId)) problems.push(`${label(i)}: targetClaimId names no claim in the opposing argument. Use a claimId from opponentArgument.claims.`);
    // One gap point per opposing claim: asking twice for the same missing record must not weigh twice.
    else if (seen.has(g.targetClaimId)) problems.push(`${label(i)}: another gap point already weakens ${g.targetClaimId}. File one gap point per opposing claim, and name every missing record it rests on in its why.`);
    else seen.add(g.targetClaimId);
    g.citations.forEach((c, j) => { const quote = quoteProblem(packet, c); if (quote) problems.push(`${label(i)}, citation ${j + 1}: ${quote}`); });
  });
  return problems;
}

/** The gap points in the disclosed challenges, numbered by the server, rider's first: what a pinned decision answers. */
export function disclosedGapPoints(disclosed: Record<string, Artifact>, driverFirst = false) {
  return (driverFirst ? ['driver', 'rider'] as const : ['rider', 'driver'] as const).flatMap(role => (disclosed[role + '_challenge']?.gapPoints ?? []).filter(g => typeof g.gapPointId === 'string').map(g => ({ gapPointId: g.gapPointId!, filedBy: role, targetClaimId: g.targetClaimId, answer: g.answer, why: g.why })));
}

/** Every problem with a pinned decision's answers to the gap points: each one answered exactly once, by gapPointId; empty when they stand. */
export function gapPointResponseProblems(disclosed: Record<string, Artifact>, responses: { gapPointId: string }[] | undefined): string[] {
  const expected = disclosedGapPoints(disclosed).map(g => g.gapPointId), given = responses ?? [], problems: string[] = [], answered = new Set<string>();
  given.forEach((r, j) => {
    if (!expected.includes(r.gapPointId)) problems.push(`gapPointResponses entry ${j + 1} names no gap point in the disclosed challenges.${expected.length ? '' : ' They have none, so omit gapPointResponses.'}`);
    else if (answered.has(r.gapPointId)) problems.push(`gapPointResponses entry ${j + 1} answers ${r.gapPointId} again. Answer each gap point once.`);
    answered.add(r.gapPointId);
  });
  const missing = expected.filter(id => !answered.has(id));
  if (missing.length) problems.push(`Answer every gap point in the disclosed challenges once, by its gapPointId (reduces_weight or no_effect, with a reason): ${missing.join(', ')} ${missing.length === 1 ? 'has' : 'have'} no answer.`);
  return problems;
}
