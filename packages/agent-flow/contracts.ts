import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PolicyReference } from '../live-fishbowl/policy';
import { conflictAffects, conflictExplanation } from '../policy/ruleset';
import { assumptionById, assumptionIds, readingFits, reviewKinds, tollRecorded, type Posture } from './posture';
import { datasetBlock, effectiveFactsVersion, isDatasetPacket, rulesV4 } from '../case-packet/dataset';
import { deriveFacts } from './facts';
import { precedentNoteProblems } from '../policy/retrieval';
import type { PrecedentSet } from '../policy/precedents';
import { citationRejection, TrustedRejection } from './citations';
import { ClaimCheckError, openingClaimProblems } from './claim-checks';
import { photoReadingsSchema, photoSummary } from './photo-schema';
import { roleOf, type Branch, type CriterionRole } from './checklists';
import { safetyInvolvedIn } from './safety';
import { chatEntries, chatReadingRejection, inChatOrder, type ChatReading } from './chat-checks';
import { gapPointIdFor, gapPointProblems, gapPointResponseProblems } from './gap-points';
import { lookupTools, recordAnswers } from './lookups';
export { photoKinds, photoObservationSchema, photoReadingsSchema, photoSummary } from './photo-schema';

// judge_b and judge_c are the panel's seats B and C (seat A is `judge`); photo is the server-side photo examiner, not a model agent file.
export const roles = ['rider', 'driver', 'judge', 'evidence', 'policy', 'judge_b', 'judge_c', 'photo'] as const;
export type Role = typeof roles[number];
export const judgeRoles = ['judge', 'judge_b', 'judge_c'] as const;
export const isJudge = (role: string) => (judgeRoles as readonly string[]).includes(role);
export type Phase = 'examine' | 'collect' | 'apply' | 'investigate' | 'challenge' | 'respond' | 'decide';
export const rolePhase: Record<'collect' | 'apply' | 'decide', Role> = { collect: 'evidence', apply: 'policy', decide: 'judge' };
export const citationSchema = z.object({ sourceId: z.string().max(180), startLine: z.number().int().positive(), endLine: z.number().int().positive() }).strict();
/** Evidence checks 1 (10 October 2026): a citation that carries a short exact quote from the lines it cites. */
export const quotedCitationSchema = citationSchema.extend({ quote: z.string().min(1).max(300).describe('A short exact quote, copied word for word from the cited lines (spacing and capitals may differ). The server checks it against those lines.') }).strict();
const prose = z.string().min(1).max(5000);
const support = { citations: z.array(citationSchema).min(1).max(30), policyIds: z.array(z.string().max(100)).min(1).max(12) };
export const argumentSchema = z.object({ position: prose, reasoning: prose, counterEvidence: prose, uncertainties: z.array(prose).max(12), ...support }).strict();
export const challengeSchema = z.object({ question: prose, disputedClaim: prose, ...support }).strict();
export const responseSchema = z.object({ answer: prose, revisedPosition: prose, remainingUncertainties: z.array(prose).max(12), ...support }).strict();
export const decisionSchema = z.object({
  // charge_recommendation (contract 3 and older): the rider is charged a fee that goes to the driver (a cleaning claim); medium rider_charge.
  // driver_payment_recommendation (contract 4, owner decision of 6 October 2026): Ryde pays the driver (medium driver_payment) and,
  // as a separate decision, recovers riderRecovery from the rider; the payment does not wait on the recovery.
  outcome: z.enum(['refund_recommendation', 'charge_recommendation', 'driver_payment_recommendation', 'no_action', 'human_review']).describe('A driver\'s cleaning claim asked with the branch questions is answered with driver_payment_recommendation (medium driver_payment) and riderRecovery, never charge_recommendation.'),
  remedy: z.object({ medium: z.enum(['none', 'card', 'voucher', 'rider_charge', 'driver_payment']), amountCents: z.number().int().min(0).max(100000) }).strict(),
  reasoning: prose, explanationToBothParties: prose,
  confidence: z.number().min(0).max(1), confidenceBasis: prose,
  unresolvedIssues: z.array(prose).max(12), ...support,
}).strict();
export type Artifact = ProtocolFields & (z.infer<typeof argumentSchema> | z.infer<typeof challengeSchema> | z.infer<typeof responseSchema> | z.infer<typeof decisionSchema> | z.infer<typeof observationsSchema> | z.infer<typeof applicabilitySchema> | z.infer<typeof photoExamSchema>);
export type Source = { id: string; sha256: string; text: string; lines: string[] };
export type CasePacket = { contractVersion?: number; caseId: string; title: string; evidenceVersion: string; policyVersion: string; sources: Source[]; policyProfile: string; policies: { rule_id: string; [key: string]: unknown }[]; datasetKind?: 'organiser-sample' | 'synthetic-variant'; policyBasis?: 'reviewed-public'; policyReference?: PolicyReference; posture?: Posture; datasetVersion?: string;
  /** A dataset's own IANA time zone (dataset_meta.timezone), for local times such as a receipt's cleaning time. Absent: unknown. */
  timezone?: string;
  /** 2: the consistency facts (3 October). 3: also photos_show_only_dry_debris and photos_show_no_mess (3 October, revision 23). Absent: the facts every earlier packet computed, so old runs replay and retry unchanged. */
  factsVersion?: number; policySelection?: { category: string; tags: string[]; selectedIds: string[]; conflictIds: string[]; unknownHints: string[] };
  /** Pinned at run creation. Absent: one Judge, as in every run before the panel. */
  panel?: PanelConfig;
  /** Pinned at run creation. Absent: the integrity check is not part of this run. */
  integrity?: { version: 1 };
  /** Verified photo files for the examine step (hashes only; bytes never become text sources). Absent: no examine step. */
  photos?: PhotoRef[];
  /** Pinned at run creation (store.ts startRun): the past rulings this run may see. Absent: the bundled file cards. */
  precedentSet?: PrecedentSet;
  /**
   * Pinned at run creation (store.ts startRun, the CLI); a Judge-only retry keeps its parent's. 1 (MVP fixes, 10 October 2026):
   * advocates get their party's own-side list (own-side.ts); each claim names its own rules and quotes its evidence (quoted
   * citations); the Evidence Collector reads the chat (chatReadings, disagreements); a threat or abuse reading sends the case to a
   * person before the advocates. 2 (MVP fixes, second release, 10 October 2026), with facts 7: also the advocates' record lookups and
   * record requests, gap points in a challenge (a missing record that weakens an opposing claim) and the Arbitrator's answer to each,
   * and the past-behaviour patterns. 3 (owner, 10 October 2026, after the second-release trial): as 2, but no record requests and no
   * gap points; each advocate is given the Evidence Collector's evidence-request list as it wrote it and says in its own argument or
   * challenge when a point rests on a missing record. 4 (owner, 11 October 2026, AD-11 to AD-13): as 3, and the Evidence Collector
   * looks up outside data itself (outside_lookup, through the worker, which holds the keys); each answer is a citable record, the
   * lookups its dispute needs are required, and nothing outside is fed to the run in advance. Absent: every earlier run, validated
   * and replayed exactly as before; 1 to 3 keep their own checks.
   */
  evidenceChecks?: { version: 1 | 2 | 3 | 4 } };
/** The evidence-checks pin every new run takes (see CasePacket.evidenceChecks). 4 from 11 October 2026: outside lookups. */
export const evidenceChecksPin = { version: 4 } as const;
// Both pins together: the evidence checks apply only to a packet that also computes facts 6, so a packet with
// either pin alone (which no creation path makes: store.ts startRun and both runners pin both) behaves exactly as before.
export const hasEvidenceChecks = (packet: Pick<CasePacket, 'evidenceChecks' | 'factsVersion' | 'contractVersion'>) => (packet.evidenceChecks?.version ?? 0) >= 1 && effectiveFactsVersion(packet) >= 6;
/** The second release's checks: the evidence-checks pin at 2 and facts 7, both (as for version 1, a packet with either alone has none). */
export const hasEvidenceChecks2 = (packet: Pick<CasePacket, 'evidenceChecks' | 'factsVersion' | 'contractVersion'>) => (packet.evidenceChecks?.version ?? 0) >= 2 && effectiveFactsVersion(packet) >= 7;
/** The third release's switch: the second release's checks without record requests and gap points (see CasePacket.evidenceChecks). */
export const hasEvidenceChecks3 = (packet: Pick<CasePacket, 'evidenceChecks' | 'factsVersion' | 'contractVersion'>) => (packet.evidenceChecks?.version ?? 0) >= 3 && effectiveFactsVersion(packet) >= 7;
/** Record requests, gap points and the Arbitrator's answers to them: the second release only (evidence checks 2 exactly). */
export const hasGapPoints = (packet: Pick<CasePacket, 'evidenceChecks' | 'factsVersion' | 'contractVersion'>) => hasEvidenceChecks2(packet) && !hasEvidenceChecks3(packet);
/** Outside lookups (AD-11 to AD-13): the Evidence Collector's outside_lookup calls, saved as citable records. Version 4 and facts 7, both. */
export const hasOutsideLookups = (packet: Pick<CasePacket, 'evidenceChecks' | 'factsVersion' | 'contractVersion'>) => (packet.evidenceChecks?.version ?? 0) >= 4 && effectiveFactsVersion(packet) >= 7;
export const outsideSourceKinds = ['rainfall', 'place', 'transport', 'street_picture', 'road_route'] as const;
export type OutsideKind = typeof outsideSourceKinds[number];
export const maxOutsideCalls = 12;
/** The road route keeps the route reference's source ID, so the route checks and the route drawing read it unchanged. */
export const outsideSourceId = (kind: OutsideKind, n: number) => kind === 'road_route' ? 'evidence/route_reference.json' : `evidence/outside_${kind}_${n}.json`;
export const outsideCallSchema = z.object({ kind: z.enum(outsideSourceKinds), n: z.number().int().min(1).max(maxOutsideCalls), sourceId: z.string().max(80), place: z.string().max(40).nullable(), window: z.string().max(40).nullable(), text: z.string().min(2).max(60000), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export const outsideTrailSchema = z.array(outsideCallSchema).max(maxOutsideCalls);
export type OutsideCall = z.infer<typeof outsideCallSchema>;
/**
 * A packet with a trail's records as sources, replacing any with the same ID. The trail is the server's (tools.ts, from the worker's
 * answers), like an advocate's lookups; the worker checks each record against its hash when it pins them (model.ts).
 */
export function withOutsideRecords<P extends Pick<CasePacket, 'sources'>>(packet: P, calls: OutsideCall[]): P {
  if (!calls.length) return packet;
  // Checked wherever a trail is used (the tool server, the worker's revalidation before it seals the artifact, every later role):
  // each record's ID fits its kind and number, no two share an ID, and each text matches its hash.
  for (const c of calls) {
    if (c.sourceId !== outsideSourceId(c.kind, c.n)) throw new TrustedRejection('An outside record has the wrong source ID');
    if (createHash('sha256').update(c.text).digest('hex') !== c.sha256) throw new TrustedRejection('An outside record does not match its hash');
  }
  const ids = new Set(calls.map(c => c.sourceId));
  if (ids.size !== calls.length) throw new TrustedRejection('Two outside records share a source ID');
  return { ...packet, sources: [...packet.sources.filter(s => !ids.has(s.id)), ...calls.map(c => ({ id: c.sourceId, text: c.text, lines: c.text.split('\n'), sha256: c.sha256 }))] };
}
/**
 * Evidence checks 2 (MVP fixes F2, second release, 10 October 2026): an advocate's record lookups and their trail (tools.ts, lookups.ts),
 * on a dataset case's own record (evidence/*.json). A blank case's record is its uploads, which the lookups do not read, so it has none.
 */
export const hasLookups = (task: Pick<Task, 'role' | 'phase' | 'packet'>) => (task.role === 'rider' || task.role === 'driver') && (task.phase === 'investigate' || task.phase === 'challenge' || task.phase === 'respond') && hasEvidenceChecks2(task.packet) && isDatasetPacket(task.packet) && task.packet.sources.some(s => s.id.startsWith('evidence/'));
/** request_record, in the two tasks a missing record can matter to: the opening argument and the challenge (a gap point). */
export const hasRecordRequests = (task: Pick<Task, 'role' | 'phase' | 'packet'>) => hasLookups(task) && task.phase !== 'respond' && hasGapPoints(task.packet);
export type PanelConfig = { version: 1; seats: Role[] };
export type PhotoRef = { photoId: string; sha256: string; mediaType: 'image/jpeg' | 'image/png'; bytes: number; file: string };
export type Task = { caseId: string; runId: string; sessionId: string; role: Role; phase: Phase; packet: CasePacket; disclosed: Record<string, Artifact>; timeoutMs: number; protocolVersion?: 2 };
export type Activity = { kind: string; message: string; sources?: string[]; data?: unknown };
export type Executor = (task: Task, emit: (event: Activity) => void, signal: AbortSignal) => Promise<Artifact>;
export type FlowEvent = Activity & { seq: number; at: string; runId: string; caseId: string; actor: string; phase: string; parent: number | null; evidenceVersion: string; policyVersion: string };

// Protocol 2 with an explicit issues list. Issues are atomic allegations with attribution; they are not findings.
export const issueSchema=z.object({issueId:z.string().max(120).optional(),party:z.enum(['rider','driver','record']),allegation:z.string().min(1).max(600),citations:z.array(citationSchema).min(1).max(6)}).strict();
/** Open-question kinds that routing weighs (fact gaps and policy gaps); safety is handled separately. */
export const gapKinds:readonly string[]=['missing_fact','evidence_gap','no_rule','page_conflict','scope_extension'];
/** Pinned into every new run's packet (store.ts startRun, the CLI). From 3 (1 October 2026) an open question on a recommendation must state otherReading. From 4 (rules rebuild, October 2026) a facts-4 packet is checked by question role (roleProblems) and a cleaning charge names its tier. Older packets are validated as they were. */
export const decisionContractVersion=4;
export type ProtocolFields = {issues?:z.infer<typeof issueSchema>[];artifactId?:string;author?:Role;summary?:string;claims?:{claimId:string;statement:string;ruleIds?:string[];citations:(z.infer<typeof citationSchema>&{quote?:string})[]}[];chatReadings?:z.infer<typeof chatReadingSchema>[];disagreements?:z.infer<typeof disagreementSchema>[];gapPoints?:(z.infer<typeof gapPointSchema>&{gapPointId?:string})[];gapPointResponses?:z.infer<typeof gapPointResponseSchema>[];outside?:OutsideCall[];lookups?:{tool:string;at:string;args:Record<string,unknown>;returned:{sourceId:string;startLine:number;endLine:number}[];request?:{requestId:string|null;answer:typeof recordAnswers[number]|null;points:{sourceId:string;startLine:number;endLine:number}[]}}[];targetArgumentId?:string;targetClaimId?:string|null;targetQuote?:string|null;challengeKind?:'dispute'|'no_material_challenge';additionalTargets?:{targetClaimId:string;targetQuote:string;disputedClaim:string;question:string;citations?:z.infer<typeof citationSchema>[]}[];additionalAnswers?:{targetClaimId:string;answer:string}[];explanationToBothParties?:string;ownArgumentId?:string;responseToChallengeId?:string;revisions?:{claimId:string;previousText:string;updatedText:string}[];criteria?:{condition:string;status:'met'|'not_met'|'unresolved';reason:string;citations:z.infer<typeof citationSchema>[]}[];factIds?:string[];reviewReasons?:{condition:string;kind?:string;reason:string;decisionImpact:string;conflictIds?:string[];recommendedReading?:string;otherReading?:{outcome:string;remedyCents:number}}[];cleaningTier?:string;riderRecovery?:{amountCents:number};assumptions?:{id:string;criterion:string}[];conditional?:boolean;issueDispositions?:{issueId:string;status:'supported'|'not_supported'|'unresolved'|'outside_scope';reason:string}[];precedentNotes?:{precedentId:string;relation:'followed'|'distinguished';reason:string;citations?:z.infer<typeof citationSchema>[]}[]};
const short=z.string().min(1).max(2400);
/** Cleaning tiers and their caps in cents, from the archived public cleaning pages (rule P19). */
export const cleaningCaps={food_drink_crumbs_sand:4000,bodily_fluids_or_stains:12000,vomit:20000} as const;
const cleaningTiers=Object.keys(cleaningCaps) as [keyof typeof cleaningCaps,...(keyof typeof cleaningCaps)[]];
const identity={artifactId:z.string().max(180),author:z.enum(roles),summary:z.string().min(1).max(1800).describe("Reader-facing explanation: lead with the conclusion, then explain the evidence and its significance in 2–3 short paragraphs. Use complete sentences and familiar words; keep IDs and technical shorthand in structured fields. Aim for 80–140 words, less if sufficient; never pad.")};
const v2Argument=argumentSchema.extend({...identity,position:short,reasoning:z.string().min(1).max(6000),counterEvidence:short,uncertainties:z.array(z.string().max(350)).max(4),claims:z.array(z.object({claimId:z.string().optional(),statement:short,citations: z.array(citationSchema).min(1).max(6)}).strict()).min(1).max(5),issues:z.array(issueSchema).max(12).optional()});
// Evidence checks 1: an opening argument whose every claim names the rules it rests on and quotes its evidence, and whose
// counterEvidence is the strongest objection to the party's case with the advocate's answer to it.
const v2ArgumentChecked=v2Argument.extend({
  counterEvidence:short.describe('The strongest objection to your party\'s case, and your answer to it.'),
  claims:z.array(z.object({claimId:z.string().optional(),statement:short,
    ruleIds:z.array(z.string().max(20)).max(4).describe('The rule IDs (P numbers) this claim rests on; empty for a purely factual claim. A claim that names a rule cites that rule\'s card.'),
    citations:z.array(quotedCitationSchema).min(1).max(6)}).strict()).min(1).max(5)});
const extraTarget=z.object({targetClaimId:z.string(),targetQuote:z.string(),disputedClaim:short,question:short,citations:z.array(citationSchema).max(6).optional()}).strict();
const v2Challenge=challengeSchema.extend({...identity,question:short,disputedClaim:short,challengeKind:z.enum(['dispute','no_material_challenge']),targetArgumentId:z.string(),targetClaimId:z.string().nullable(),targetQuote:z.string().nullable(),additionalTargets:z.array(extraTarget).max(2).optional()});
const v2Response=responseSchema.extend({...identity,answer:z.string().min(1).max(4000),additionalAnswers:z.array(z.object({targetClaimId:z.string(),answer:z.string().min(1).max(2000)}).strict()).max(2).optional(),revisedPosition:short,remainingUncertainties:z.array(z.string().max(350)).max(4),ownArgumentId:z.string(),responseToChallengeId:z.string(),revisions:z.array(z.object({claimId:z.string(),previousText:z.string(),updatedText:short}).strict()).max(5)});
const v2Decision=decisionSchema.extend({...identity,reasoning:z.string().min(1).max(6000),explanationToBothParties:z.string().min(1).max(3000),unresolvedIssues:z.array(z.string().max(350)).max(4),criteria:z.array(z.object({condition:z.string(),status:z.enum(['met','not_met','unresolved']),reason:z.string().min(1).max(1200),citations:z.array(citationSchema).min(1).max(6)}).strict()).min(1).max(8),factIds:z.array(z.string()).max(80),reviewReasons:z.array(z.object({condition:z.string(),kind:z.enum(reviewKinds),reason:z.string().min(1).max(1200),decisionImpact:z.string().min(1).max(450),conflictIds:z.array(z.string().max(8)).max(7).optional(),recommendedReading:z.string().min(1).max(700).optional(),otherReading:z.object({outcome:z.enum(['refund_recommendation','charge_recommendation','driver_payment_recommendation','no_action','human_review']),remedyCents:z.number().int().min(0).max(100000)}).strict().optional().describe('Required on a recommendation for every missing_fact, evidence_gap, no_rule, page_conflict or scope_extension question: the outcome and amount you would recommend under the other reading of this question, or if the missing fact turned out the other way. Equal to your recommendation only when the question truly changes nothing (decisionImpact says why). The server, not you, decides from it whether a person looks first: state it as it is.')}).strict()).max(8),assumptions:z.array(z.object({id:z.enum(assumptionIds),criterion:z.string().max(60)}).strict()).max(4).optional(),conditional:z.boolean().optional(),riderRecovery:z.object({amountCents:z.number().int().min(0).max(100000)}).strict().optional().describe('Contract 4, required with driver_payment_recommendation: the amount Ryde recovers from the rider, from 0 up to the payment. Ryde pays the driver even if recovery fails.'),cleaningTier:z.enum(cleaningTiers).optional().describe('Contract 4: the cleaning tier a charge to the rider rests on (required on a cleaning charge); its cap is the most the charge may be.'),issueDispositions:z.array(z.object({issueId:z.string().max(120),status:z.enum(['supported','not_supported','unresolved','outside_scope']),reason:z.string().min(1).max(600)}).strict()).max(24).optional(),precedentNotes:z.array(z.object({precedentId:z.string().max(80),relation:z.enum(['followed','distinguished']),reason:z.string().min(10).max(600),citations:z.array(citationSchema).max(6).optional()}).strict()).max(6).optional()});
// Pre-debate service roles (dataset packets only). Neither decides anything.
export const observationsSchema=z.object({...identity,author:z.literal('evidence'),
  observations:z.array(z.object({type:z.enum(['statement_assertion','chat_agreement','chat_refusal','source_conflict','record_absence','timeline_note','external_context','other']),subject:z.string().min(1).max(200),value:z.string().min(1).max(600),observedAt:z.string().max(40).nullable(),citations:z.array(citationSchema).min(1).max(6),qualityFlags:z.array(z.string().max(80)).max(6)}).strict()).min(1).max(40),
  evidenceRequests:z.array(z.object({target:z.string().min(1).max(200),purpose:z.string().min(1).max(400),status:z.enum(['open','unavailable','out_of_coverage','failed','fulfilled']),result:z.string().max(600).nullable()}).strict()).max(12),
  citations:z.array(citationSchema).min(1).max(30),policyIds:z.array(z.string()).max(0)}).strict();
export const applicabilitySchema=z.object({...identity,author:z.literal('policy'),
  assessments:z.array(z.object({ruleId:z.string().max(20),issueIds:z.array(z.string().max(40)).max(12),applies:z.enum(['yes','no','unknown']),conditions:z.array(z.object({condition:z.string().min(1).max(300),status:z.enum(['met','unmet','unknown']),assumptionId:z.enum(assumptionIds).optional(),reason:z.string().min(1).max(600),citations:z.array(citationSchema).max(6)}).strict()).min(1).max(8),exceptions:z.array(z.string().max(300)).max(6),conflictIds:z.array(z.string().max(10)).max(7)}).strict()).min(1).max(24),
  policyGaps:z.array(z.object({issue:z.string().min(1).max(300),gap:z.string().min(1).max(600)}).strict()).max(10),
  precedents:z.array(z.object({precedentId:z.string().max(80),status:z.enum(['materially_matches','distinguishable','insufficient_information']),differences:z.string().max(600)}).strict()).max(5),
  citations:z.array(citationSchema).min(1).max(30),policyIds:z.array(z.string().max(100)).min(1).max(40)}).strict();
// Server-side photo reading (cleaning claims): the reading itself lives in photo-schema.ts, shared with the photo-reading facts.
export const photoExamSchema=z.object({...identity,author:z.literal('photo'),
  photos:photoReadingsSchema,
  citations:z.array(citationSchema).max(0),policyIds:z.array(z.string()).max(0)}).strict();
/** Issues listed by both opening arguments; the Judge must dispose of each exactly once. */
export function openingIssues(disclosed:Record<string,Artifact>,driverFirst=false){return (driverFirst?['driver','rider'] as const:['rider','driver'] as const).flatMap(role=>(disclosed[role+'_investigate']?.issues??[]).map(i=>({...i,issueId:i.issueId!})));}
export const artifactId=(task:Pick<Task,'runId'|'role'|'phase'>)=>`${task.runId}/${task.role}/${task.phase}`;
// Evidence checks 1: the Evidence Collector also reads the chat, message by message, and lists the points the parties disagree on.
// Tone and act are a model's reading, shown and argued over; no money fact reads them (facts read structured fields only).
export const chatTones=['calm','polite','frustrated','angry','abusive'] as const;
export const chatActs=['agreement','refusal','request','proposal','threat','apology','complaint','accusation','information'] as const;
export const chatReadingSchema=z.object({
  citation:quotedCitationSchema.describe('The chat message: its lines in evidence/chat_logs.json and an exact quote of its words.'),
  sender:z.enum(['rider','driver','system']),
  tone:z.enum(chatTones),
  act:z.enum(chatActs),
  repliesToLine:z.number().int().positive().nullable().describe('The first line, in the same chat source, of the message this one answers; null when it answers none.'),
  note:z.string().max(300).nullable(),
}).strict();
export const disagreementSchema=z.object({
  topic:z.string().min(1).max(200),
  riderSays:z.string().min(1).max(400),
  driverSays:z.string().min(1).max(400),
  citations:z.array(quotedCitationSchema).min(1).max(6),
}).strict();
// The readings list is sized from the packet in schemaFor: one per rider or driver message with words, however long the chat
// (the dataset schema sets no limit). 80 is only the case-free bound, for the instructions hash.
const chatReadingsField=(max:number)=>z.array(chatReadingSchema).max(max).describe('One reading per rider or driver chat message (photo captions included; call logs, system messages and entries with no words take none), in chat order. Empty only when the chat has no rider or driver message.');
const observationsChecked=observationsSchema.extend({
  chatReadings:chatReadingsField(80),
  disagreements:z.array(disagreementSchema).max(8).describe('Each point the rider and driver disagree on, across statements, chat and the ticket, with both sides cited. Record both sides; do not resolve it.'),
});
// Evidence checks 2 (MVP fixes F3, owner, 10 October 2026): a gap in the record weighs against a point and never stops a run. An advocate
// that asked for a record (request_record) and was told it is not on record, or that it can't be checked, may file a gap
// point in its challenge: which opposing claim it weakens and why. The Arbitrator answers each one: reduces the weight, or no effect.
// A gap point never sends a case to a person by itself.
export const gapAnswers=['not_on_record','cannot_check'] as const;
export const gapPointSchema=z.object({
  targetClaimId:z.string().describe('The opposing claim this gap weakens, by its claimId.'),
  requestId:z.string().max(80).describe('The id request_record returned for the record you asked for in this task.'),
  answer:z.enum(gapAnswers).describe('What request_record answered: not_on_record (no such record exists in the case) or cannot_check (outside what the system can look up).'),
  why:z.string().min(1).max(600).describe('Why the missing record weakens that claim.'),
  citations:z.array(quotedCitationSchema).max(4),
}).strict();
export const gapEffects=['reduces_weight','no_effect'] as const;
export const gapPointResponseSchema=z.object({
  gapPointId:z.string().max(120).describe('The gap point answered, as the coordinator numbered it (gap points in the disclosed challenges).'),
  effect:z.enum(gapEffects),
  reason:z.string().min(1).max(600),
}).strict();
// The server numbers each gap point (gapPointId, like a claimId), so an accepted challenge validates again unchanged (flow.ts, worker.ts).
const v2ChallengeChecked2=v2Challenge.extend({gapPoints:z.array(gapPointSchema.extend({gapPointId:z.string().max(140).optional().describe('Omit: the server numbers gap points.')})).max(3).optional().describe('Up to three gaps in the record that weaken opposing claims; each rests on a record you asked for with request_record in this task.')});
// The server's lookup trail on an advocate's artifact (tools.ts): what it looked up, when, with which arguments, and which lines came back.
const trailRange=citationSchema;
export const lookupTrailSchema=z.array(z.object({tool:z.enum([...lookupTools,'request_record']),at:z.string().max(40),args:z.record(z.string(),z.unknown()),returned:z.array(trailRange).max(400),
  request:z.object({requestId:z.string().max(80).nullable(),answer:z.enum(recordAnswers).nullable(),points:z.array(trailRange).max(60)}).strict().optional()}).strict()).max(80);
export function schemaFor(task:Pick<Task,'phase'|'protocolVersion'> & Partial<Pick<Task,'packet'|'disclosed'>>){
  const checked=!!task.packet&&hasEvidenceChecks(task.packet), checked2=!!task.packet&&hasGapPoints(task.packet);
  if(task.phase==='examine')return photoExamSchema;
  if(task.phase==='collect'){const required=checked?chatEntries(task.packet!)?.entries.filter(e=>e.read).length:undefined;return !checked?observationsSchema:required===undefined?observationsChecked:observationsChecked.extend({chatReadings:chatReadingsField(required)});}
  if(task.phase==='apply')return applicabilitySchema;
  const modern=task.protocolVersion===2;
  let schema:z.ZodTypeAny=(modern?{investigate:checked?v2ArgumentChecked:v2Argument,challenge:checked2?v2ChallengeChecked2:v2Challenge,respond:v2Response,decide:v2Decision}:{investigate:argumentSchema,challenge:challengeSchema,respond:responseSchema,decide:decisionSchema})[task.phase];
  if(modern&&task.phase==='decide'&&task.packet){const criteria=deriveFacts(task.packet).requiredCriteria;schema=v2Decision.extend({criteria:z.array(v2Decision.shape.criteria.element.extend({condition:z.enum(criteria as [string,...string[]])})).length(criteria.length),...(checked2?{gapPointResponses:z.array(gapPointResponseSchema).max(6).optional().describe('One answer for every gap point in the disclosed challenges: reduces_weight or no_effect, with a reason. A gap point never sends a case to a person by itself.')}:{})});}
  return schema;
}
export function citationsFor(artifact:Artifact){const a=artifact as any;return [...artifact.citations,...(artifact.claims??[]).flatMap(c=>c.citations),...(artifact.criteria??[]).flatMap(c=>c.citations),...((a.observations??[]) as {citations:z.infer<typeof citationSchema>[]}[]).flatMap(o=>o.citations),...((a.additionalTargets??[]) as {citations?:z.infer<typeof citationSchema>[]}[]).flatMap(t=>t.citations??[]),...((a.assessments??[]) as {conditions:{citations:z.infer<typeof citationSchema>[]}[]}[]).flatMap(x=>x.conditions.flatMap(c=>c.citations)),...(artifact.issues??[]).flatMap(i=>i.citations),...(artifact.precedentNotes??[]).flatMap(n=>n.citations??[]),...(artifact.chatReadings??[]).map(r=>r.citation),...(artifact.disagreements??[]).flatMap(d=>d.citations),...(artifact.gapPoints??[]).flatMap(g=>g.citations)];}
/** Fields the server owns. A model-written `routing` object or `confidenceScore` is dropped, never stored: both are computed after validation (routing.ts, confidence.ts). */
export function withoutServerFields(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !('routing' in input || 'panel' in input || 'confidenceScore' in input)) return input;
  const { routing: _routing, panel: _panel, confidenceScore: _score, ...rest } = input as Record<string, unknown>;
  return rest;
}
// A safety allegation anywhere in the packet: safety.ts (contract 4: the shared test; older packets: category, report, flagged issue).
/**
 * Whether an enabled team reading could settle an open question on this packet: one written for the case's category, on that criterion,
 * for that kind of gap (a page conflict only when it resolves each conflict named). Under contract 4 a reading counts only when its rules
 * are pinned and its wording fits the case (Task 18), so a metered RydeTAXI detour with no estimate may abstain. The validator refuses an
 * abstention when every gap is like this. With `fitted`, only a reading whose own wording positively fits the case (it has a fit test,
 * posture.ts readingFits) and only on the situation's own question, not the general scope or records questions: routing does not
 * release such a question under the S$10 limit for open questions (owner decision, 7 October 2026), since the Judge left open what the
 * team has already answered (DISP-034 under A12). Matching on the general questions alone would catch open questions no reading answers.
 */
export function settledByReading(packet: CasePacket, category: string, byRole: boolean, fitted = false) {
  type Reading = { id: string; ruleIds: readonly string[]; kind: string; kinds?: readonly string[]; criteria: readonly string[]; categories: readonly string[]; resolvesConflicts?: readonly string[]; fits?: string };
  const readings = ((packet.posture?.allowedAssumptions ?? []).map(assumptionById).filter(Boolean) as Reading[]).filter(a => !fitted || !!a.fits);
  if (fitted && !byRole) return () => false;
  const usable = (a: Reading, condition: string) => !byRole || (a.ruleIds.every(r => packet.policies.some(p => p.rule_id === r)) && !readingMisfit(a.id, packet, condition));
  return (r: { condition: string; kind?: string; conflictIds?: string[] }) => !(fitted && ['policy_applicability', 'evidence_readiness'].includes(r.condition)) && readings.filter(a => usable(a, r.condition)).some(a => (a.kinds ?? [a.kind]).includes(r.kind ?? '') && a.criteria.includes(r.condition) && a.categories.includes(category)
    && (r.kind !== 'page_conflict' || (r.conflictIds ?? []).every(id => (a.resolvesConflicts ?? []).includes(id))));
}
/** Under the rules rebuild, why a reading's own wording does not fit the recorded case (posture.ts readingFits), or null. */
function readingMisfit(id: string, packet: CasePacket, criterion?: string): string | null {
  const approved=assumptionById(id) as { fits?: keyof typeof readingFits } | undefined;
  if(!approved?.fits||!rulesV4(packet))return null;
  const fit=readingFits[approved.fits];
  return fit.test(datasetBlock(packet,'trip_data'),datasetBlock(packet,'fare_breakdown'),datasetBlock(packet,'route_data'),criterion)?null:id+' does not fit this case: it needs '+fit.text+'.';
}
// Whether an approved assumption may be used on this packet at all; shared by the Judge and the Policy Analyst.
function assumptionIneligibility(id: string, task: Pick<Task,'packet'>, category: string, safetyInvolved: boolean): string | null {
  const approved=assumptionById(id); if(!approved)return 'Unknown assumption '+id;
  const misfit=readingMisfit(id,task.packet); if(misfit)return misfit;
  if(!task.packet.posture||!task.packet.posture.allowedAssumptions.includes(id))return 'The pinned posture does not enable assumption '+id+'; leave the criterion unresolved';
  if(safetyInvolved)return 'No assumption may be invoked when a safety allegation is present';
  if(!(approved.categories as readonly string[]).includes(category))return id+' does not apply to category '+category;
  if(approved.ruleIds.some(r=>!task.packet.policies.some(p=>p.rule_id===r)))return id+' needs rules that are not pinned in this packet';
  // A10 (P08): "Requests submitted after 30 days of the trip will not be considered for waivers." An unknown filing time is not in time.
  if('withinDaysOfTrip' in approved){const days=deriveFacts(task.packet).facts.find(f=>f.id==='days_trip_to_dispute')?.value;if(typeof days!=='number'||days>approved.withinDaysOfTrip)return id+' applies only to a request within '+approved.withinDaysOfTrip+' days of the trip; '+(typeof days==='number'?'this one was filed '+Math.floor(days)+' days after it':'the record does not show when it was filed relative to the trip');}
  if('requiresMissing' in approved){const trip=(()=>{try{return JSON.parse(task.packet.sources.find(x=>x.id==='evidence/trip_data.json')?.text??'{}');}catch{return {};}})();for(const f of approved.requiresMissing)if(trip[f]!==undefined)return id+' may only be invoked when '+f+' is absent from the packet; it is recorded as '+String(trip[f]);}
  return null;
}
/** Remedy shape. A refund returns money to the rider by card or voucher; a charge (cleaning claims only, within the amount claimed) takes a fee from the rider for the driver. Category checks run when the category is known. */
export function remedyProblems(d:{outcome:string;remedy:{medium:string;amountCents:number};riderRecovery?:{amountCents:number}},category:string|null,claimedCents:number|null,filedBy:string|null=null):string[]{
  const {medium,amountCents}=d.remedy,problems:string[]=[];
  if((medium==='none')!==(amountCents===0))problems.push('Remedy medium/amount mismatch');
  if(!['refund_recommendation','charge_recommendation','driver_payment_recommendation'].includes(d.outcome)&&amountCents!==0)problems.push('Review/no-action cannot recommend an amount');
  // Contract 4: a driver payment answers a driver's cleaning claim, within the amount claimed, with the recovery from the rider stated apart.
  const payment=d.outcome==='driver_payment_recommendation';
  if(payment&&medium!=='driver_payment')problems.push('A driver payment uses medium driver_payment');
  if(payment&&amountCents===0)problems.push('A driver payment requires an amount');
  if(payment&&category!==null&&category!=='cleaning')problems.push('A payment to the driver is recommended only in cleaning claims');
  if(payment&&claimedCents!==null&&amountCents>claimedCents)problems.push('A driver payment cannot exceed the amount claimed');
  if(payment&&category==='cleaning'&&(claimedCents===null||!Number.isFinite(claimedCents)))problems.push('A driver payment needs a known claimed amount');
  if(payment&&category==='cleaning'&&filedBy!=='driver')problems.push('A driver payment answers a driver-filed claim only');
  if(payment&&typeof d.riderRecovery?.amountCents!=='number')problems.push('A driver payment states riderRecovery: the amount Ryde recovers from the rider, from 0 up to the payment');
  else if(payment&&(d.riderRecovery!.amountCents<0||d.riderRecovery!.amountCents>amountCents))problems.push('The rider recovery must be at most the payment to the driver');
  if(!payment&&d.riderRecovery!==undefined)problems.push('riderRecovery belongs only on a driver payment');
  if(d.outcome==='refund_recommendation'&&amountCents===0)problems.push('Refund recommendation requires an amount');
  if(d.outcome==='refund_recommendation'&&!['card','voucher'].includes(medium))problems.push('A refund returns money to the rider by card or voucher');
  if(d.outcome==='charge_recommendation'&&medium!=='rider_charge')problems.push('A charge recommendation uses medium rider_charge');
  if(d.outcome==='charge_recommendation'&&amountCents===0)problems.push('Charge recommendation requires an amount');
  if(d.outcome==='charge_recommendation'&&category!==null&&category!=='cleaning')problems.push('A charge to the rider is recommended only in cleaning claims');
  if(d.outcome==='charge_recommendation'&&claimedCents!==null&&amountCents>claimedCents)problems.push('A charge cannot exceed the amount claimed');
  // With the category known (a validated Judge decision), a charge needs a driver-filed claim with a known claimed amount. An unknown filing party is not a driver.
  if(d.outcome==='charge_recommendation'&&category==='cleaning'&&(claimedCents===null||!Number.isFinite(claimedCents)))problems.push('A charge needs a known claimed amount');
  if(d.outcome==='charge_recommendation'&&category==='cleaning'&&filedBy!=='driver')problems.push('A charge to the rider answers a driver-filed claim only');
  return problems;
}
/** A cleaning payment names its tier and stays within the tier's cap and the amount claimed (Judge and person alike). */
export function cleaningPaymentProblems(d: { remedy: { amountCents: number }; cleaningTier?: string }, claimedCents: number | null | undefined): string[] {
  const problems: string[] = [], cap = d.cleaningTier ? (cleaningCaps as Record<string, number>)[d.cleaningTier] : undefined;
  if (cap === undefined) problems.push('A cleaning payment names its tier (cleaningTier).');
  else if (d.remedy.amountCents > cap) problems.push(`The payment is above the ${d.cleaningTier} cap of ${cap} cents.`);
  if (typeof claimedCents === 'number' && d.remedy.amountCents > claimedCents) problems.push('A payment cannot exceed the amount claimed.');
  return problems;
}
type Crit = { condition: string; status: string };
const cancellationBranches = new Set<string>(['rider_cancellation', 'driver_no_show', 'driver_cancellation']);
// Fare disputes where the accepted quote is the lawful fare (a fixed fare is charged as quoted whatever the route, P10, P33), so the
// excess above it is the whole error (red team, round 2). A toll, an extra charge or an edit fee may sit inside the quote itself.
export const quoteBranches = new Set<string | undefined>(['surge_pricing', 'fare_overcharge', 'promo_code', 'route_detour']);
type Dec = { outcome: string; remedy: { medium: string; amountCents: number }; cleaningTier?: string; riderRecovery?: { amountCents: number }; reviewReasons?: { condition: string; recommendedReading?: string }[] };
/** Contract 4: one rule per question role (checklists.ts). Returns the problems; empty means the outcome fits the answers. */
export function roleProblems(branch: Branch, criteria: Crit[], d: Dec, assumptions: { id: string; criterion: string }[], money: { claimedCents?: number | null; heldCents?: number | null; excessCents?: number | null; paidForClaimCents?: number | null } = {}): string[] {
  const problems: string[] = [], role = (c: Crit) => roleOf(branch, c.condition);
  const is = (r: CriterionRole, s: string) => criteria.filter(c => role(c) === r && c.status === s);
  const review = d.outcome === 'human_review';
  if (branch === 'unsupported' && !review) problems.push('This kind of dispute has no supported branch yet; recommend human review.');
  if (d.outcome === 'driver_payment_recommendation' && branch !== 'cleaning_claim') problems.push('A payment to the driver answers only a driver\'s cleaning claim.');
  if ((is('scope', 'not_met').length || is('evidence', 'not_met').length) && !review)
    problems.push('A scope or evidence question answered no sends the case to a person. Mark a missing fact unresolved with a missing_fact question, or recommend human review.');
  if (is('payment', 'not_met').length && d.outcome === 'refund_recommendation') problems.push('The payment records do not support a refund. If they may be incomplete, mark the payment question unresolved.');
  const goodwill = is('concession', 'met');
  for (const c of goodwill) if (!assumptions.some(a => a.criterion === c.condition)) problems.push(`${c.condition} can only be met under its approved team reading; invoke it or answer no.`);
  if (goodwill.length && d.outcome === 'refund_recommendation' && d.remedy.medium !== 'voucher') problems.push('A goodwill or waiver refund is paid as a voucher.');
  if (branch === 'cleaning_claim') {
    const claim = criteria.filter(c => role(c) === 'claim_condition');
    if (d.outcome === 'refund_recommendation') problems.push('A driver\'s cleaning claim is answered by a driver payment, no action or a person; a refund to the rider belongs to the rider\'s own dispute.');
    if (d.outcome === 'charge_recommendation') problems.push('A cleaning claim is answered by a driver payment with a separate recovery from the rider (driver_payment_recommendation with riderRecovery), not a charge.');
    if (d.outcome === 'driver_payment_recommendation') {
      if (claim.some(c => c.status !== 'met')) problems.push('A cleaning payment needs every claim condition met.');
      problems.push(...cleaningPaymentProblems(d, money.claimedCents));
    }
    // A claim already paid (red team, round 2) may close with no action; routing sends it to a person to confirm nothing more is owed.
    if (d.outcome === 'no_action' && !claim.some(c => c.status === 'not_met') && !(money.paidForClaimCents ?? 0)) problems.push('Declining a cleaning claim names the claim condition that failed.');
    return problems;
  }
  // A rider's appeal against a cleaning charge found not due at all: all of it still held goes back.
  if (branch === 'cleaning_appeal' && d.outcome === 'refund_recommendation' && criteria.find(c => c.condition === 'cleaning_fee_due')?.status === 'not_met' && typeof money.heldCents === 'number' && d.remedy.amountCents !== money.heldCents)
    problems.push(`A cleaning fee found not due goes back in full (${money.heldCents} cents still held).`);
  // A rider's appeal against a cleaning charge that was due but above the cap: at least the part above the tier's cap goes back.
  if (branch === 'cleaning_appeal' && d.outcome === 'refund_recommendation' && criteria.find(c => c.condition === 'cleaning_fee_due')?.status === 'met' && criteria.find(c => c.condition === 'charged_within_cap')?.status === 'not_met') {
    const cap = d.cleaningTier ? (cleaningCaps as Record<string, number>)[d.cleaningTier] : undefined;
    if (cap === undefined) problems.push('A refund of the part of a cleaning charge above the cap names the tier that fits (cleaningTier).');
    else if (typeof money.heldCents === 'number' && d.remedy.amountCents < money.heldCents - cap) problems.push(`A refund must return at least the part of the charge above the ${d.cleaningTier} cap (${money.heldCents - cap} cents).`);
  }
  const failedFee = is('fee_condition', 'not_met').length > 0;
  const openReading = (d.reviewReasons ?? []).some(r => ['fee_condition', 'concession'].includes(roleOf(branch, r.condition) ?? '') && !!r.recommendedReading?.trim());
  const openFee = (d.reviewReasons ?? []).some(r => roleOf(branch, r.condition) === 'fee_condition' && !!r.recommendedReading?.trim());
  if (d.outcome === 'refund_recommendation' && !failedFee && !goodwill.length && openReading && !openFee && d.remedy.medium !== 'voucher') problems.push('A refund resting on an open goodwill question is a voucher, like the goodwill it would be.');
  // A cancellation fee is owed in full or not at all, and goodwill returns the whole fee (owner decision, 6 October): the refund is all of it still held.
  // A waiting fee or a fare for a trip not taken, found not owed, goes back whole too (red team, round 2).
  if (d.outcome === 'refund_recommendation' && typeof money.heldCents === 'number' && (goodwill.length || cancellationBranches.has(branch) || (failedFee && ['waiting_fee', 'trip_not_taken'].includes(branch))) && d.remedy.amountCents !== money.heldCents)
    problems.push(`A refund of a cancellation fee, or a goodwill refund, returns all of the fee still held (${money.heldCents} cents), no more and no less.`);
  // Nothing still held of the disputed charge (already returned in full, or only ever a hold): no action is the remedy.
  // A repriced or overcharged fare already corrected in full leaves no excess: no action is the remedy too.
  if (d.outcome === 'no_action' && (failedFee || goodwill.length) && money.heldCents !== 0 && !(quoteBranches.has(branch) && money.excessCents === 0)) problems.push('No action cannot stand when a fee condition failed or a goodwill reason applies.');
  if (d.outcome === 'refund_recommendation' && !failedFee && !goodwill.length && !openReading) problems.push('A refund needs a failed fee condition, an approved goodwill reason, or an open question with the reading it rests on.');
  return problems;
}
export const sampleRefundRefusal='Sample has no verified settlement or supported refund instrument; recommend human review before a monetary remedy';
export const cardRefundRefusal='Cash recommendation exceeds reconciled available capture or pending refund is unresolved';
/**
 * Every money check a recommended remedy passes, whoever makes it: the Judge (validateArtifact) and a person's final decision
 * (policy/loop.ts checkDecision). The remedy's shape and the charge rules (remedyProblems, with the case's category, the
 * claimed amount and the filing party), no refund on an organiser sample, and no card refund above what was collected and
 * not refunded, or at all while a refund is pending or the payments do not reconcile (cashCeiling null).
 */
export function moneyProblems(d:{outcome:string;remedy:{medium:string;amountCents:number};riderRecovery?:{amountCents:number};cleaningTier?:string},packet:CasePacket,facts=deriveFacts(packet)):string[]{
  const claimed=facts.facts.find(f=>f.id==='claimed_cleaning_cents')?.value,filedBy=(()=>{try{return JSON.parse(packet.sources.find(s=>s.id==='evidence/dispute_ticket.json')?.text??'{}').filed_by??null;}catch{return null;}})();
  const problems=remedyProblems(d,facts.category,typeof claimed==='number'?claimed:null,filedBy);
  if(packet.datasetKind&&d.outcome==='refund_recommendation')problems.push(sampleRefundRefusal);
  // A driver payment exists from contract 4 (a cleaning claim under the branch questions); there it replaces the single charge.
  const cleaningClaimV4=(packet.contractVersion??0)>=4&&facts.branch==='cleaning_claim';
  if(d.outcome==='driver_payment_recommendation'&&!cleaningClaimV4)problems.push('A driver payment needs contract 4 (rules rebuild) and a driver\'s cleaning claim; this run answers a cleaning claim with a charge');
  if(d.outcome==='driver_payment_recommendation'&&cleaningClaimV4){
    const num=(id:string)=>{const v=facts.facts.find(f=>f.id===id)?.value;return typeof v==='number'?v:0;},paid=num('driver_paid_for_claim_cents'),recovered=num('rider_recovered_for_claim_cents');
    const cap=d.cleaningTier?(cleaningCaps as Record<string,number>)[d.cleaningTier]:undefined;
    problems.push(...cleaningPaymentProblems(d,typeof claimed==='number'?claimed-paid:null));
    if(paid&&cap!==undefined&&paid+d.remedy.amountCents>cap)problems.push(`The driver was already paid ${paid} cents for this claim; with this payment the total passes the ${d.cleaningTier} cap of ${cap} cents.`);
    if(paid&&typeof claimed==='number'&&paid+d.remedy.amountCents>claimed)problems.push(`The driver was already paid ${paid} cents for this claim; with this payment the total passes the ${claimed} cents claimed.`);
    if(facts.facts.find(f=>f.id==='driver_payment_pending_for_claim')?.value===true)problems.push('A payment to the driver for this claim is still pending; wait for it to settle before recommending another.');
    if(facts.facts.find(f=>f.id==='rider_recovery_pending_for_claim')?.value===true&&(d.riderRecovery?.amountCents??0)>0)problems.push('A recovery from the rider for this claim is still pending; recommend no new recovery until it settles.');
    if(typeof d.riderRecovery?.amountCents==='number'&&recovered+d.riderRecovery.amountCents>paid+d.remedy.amountCents)problems.push(`Recovery from the rider (${recovered} cents already, plus this) cannot pass what the driver is paid in all.`);
  }
  if(d.outcome==='charge_recommendation'&&cleaningClaimV4)problems.push('A cleaning claim is answered by a driver payment with a separate recovery from the rider (driver_payment_recommendation with riderRecovery), not a charge');
  // Contract 4 (rules rebuild): vouchers have the card limits, and no refund may exceed what is still held of the disputed charge.
  if((packet.contractVersion??0)>=4&&!!facts.branch){
    if(d.outcome==='refund_recommendation'){
      if(facts.cashCeiling===null||d.remedy.amountCents>facts.cashCeiling)problems.push('A refund, by card or voucher, exceeds what the rider paid and was not returned, or a refund is still pending');
      const held=facts.facts.find(f=>f.id==='disputed_charge_outstanding_cents')?.value,excess=facts.facts.find(f=>f.id==='fare_excess_cents')?.value,paidNet=facts.facts.find(f=>f.id==='rider_refund_ceiling_cents')?.value;
      // Where the quote is the lawful fare, the excess above it is the ceiling; on a toll, extra charge or edit fee the quote may itself
      // hold the unlawful item, so the excess only decides whether a person checks the amount (routing.ts; red team, round 2).
      if(typeof excess==='number'&&quoteBranches.has(facts.branch)&&d.remedy.amountCents>excess)problems.push(`A fare refund cannot exceed the excess the record shows (${excess} cents: the charge above the quote, plus any collection above the fare).`);
      if(typeof held!=='number')problems.push('No settled charge in the payment records is linked to this dispute, so nothing can be returned; mark the payment question unresolved.');
      // A fare collected more than once: on a fare dispute a refund is not limited to the latest collection. Where the quote is the
      // lawful fare the excess bounds it; on a toll, extra charge or edit fee everything the rider paid and got back does, and an
      // amount other than the excess goes to a person (routing.ts; red team, round 3).
      else if(d.remedy.amountCents>held&&!(typeof excess==='number'&&d.remedy.amountCents<=(quoteBranches.has(facts.branch)?excess:Math.max(excess,typeof paidNet==='number'?paidNet:held))))problems.push(`A refund, by card or voucher, cannot exceed what is still held of the disputed charge (${held} cents).`);
    }
  }else if(d.outcome==='refund_recommendation'&&d.remedy.medium==='card'&&(facts.cashCeiling===null||d.remedy.amountCents>facts.cashCeiling))problems.push(cardRefundRefusal);
  return problems;
}
// The shared explanation never labels a person; account history alone never decides a criterion.
export const labelWords=/\b(fraud|fraudulent|fake|forged|scam|lying|liar)\b/i;
// The earlier-claims extract (facts 7) is history too: a question resting on it alone is refused, as on the profiles alone (second release).
const profileSources=new Set(['evidence/rider_profile.json','evidence/driver_profile.json','evidence/earlier_claims.json']);
export function profileOnlyCriteria(criteria:{condition:string;citations:{sourceId:string}[]}[]){return criteria.filter(c=>c.citations.length&&c.citations.every(x=>profileSources.has(x.sourceId))).map(c=>c.condition);}
export function validateArtifact(task: Pick<Task, 'phase' | 'role' | 'packet'> & Partial<Pick<Task,'protocolVersion'|'runId'|'disclosed'>>, input: unknown): Artifact {
  input = withoutServerFields(input);
  const allowed=task.phase==='decide'?isJudge(task.role):task.phase==='examine'?task.role==='photo':task.phase==='collect'?task.role==='evidence':task.phase==='apply'?task.role==='policy':['rider','driver'].includes(task.role);
  if (!allowed) throw new TrustedRejection('Role cannot submit in this phase');
  // Evidence checks 2 (MVP fixes F2, second release, 10 October 2026): an advocate's lookup trail is the server's (tools.ts replaces any
  // model-written one), disclosed with the argument. It is set aside for the shape check and put back, so the coordinator's, the
  // worker's and a retry's validation (flow.ts, worker.ts, replay.ts) keep it. Any other run has no such field, exactly as before.
  let trail: z.infer<typeof lookupTrailSchema> | undefined;
  if (hasLookups(task) && input && typeof input === 'object' && !Array.isArray(input) && 'lookups' in input) { const { lookups, ...rest } = input as Record<string, unknown>; trail = lookupTrailSchema.parse(lookups); input = rest; }
  // Outside lookups (AD-13): the Collector's outside trail is the server's too (tools.ts replaces any model-written one). It is set
  // aside for the shape check and put back, and its records join the packet the citation checks read, so the worker's revalidation
  // on a fresh packet passes as the tool server's did.
  let outside: OutsideCall[] | undefined;
  if (task.phase === 'collect' && hasOutsideLookups(task.packet) && input && typeof input === 'object' && !Array.isArray(input) && 'outside' in input) {
    const { outside: calls, ...rest } = input as Record<string, unknown>; outside = outsideTrailSchema.parse(calls); input = rest;
    task = { ...task, packet: withOutsideRecords(task.packet, outside) };
  }
  const artifact = schemaFor(task).parse(input) as Artifact;
  if (trail) artifact.lookups = trail;
  if (outside) artifact.outside = outside;
  // A citation must name a pinned source and lines inside it; the rejection says which ones fail and what to cite instead.
  const citationError = citationRejection(task.packet, artifact, citationsFor(artifact));
  if (citationError) throw new TrustedRejection(citationError);
  for (const id of artifact.policyIds) if (!task.packet.policies.some(p => p.rule_id === id)) throw new TrustedRejection('Unknown policy citation');
  // Evidence checks 1 (MVP fixes, 10 October 2026): the chat reading is checked against the chat's own structure, whatever the
  // protocol, like its shape; every problem comes back in one numbered rejection (chat-checks.ts).
  if (task.phase === 'collect' && hasEvidenceChecks(task.packet)) {
    const chatError = chatReadingRejection(task.packet, artifact as { chatReadings: ChatReading[] }); if (chatError) throw new TrustedRejection(chatError);
    artifact.chatReadings = inChatOrder(artifact.chatReadings ?? []);
  }
  if ('outcome' in artifact) { const problems = remedyProblems(artifact, null, null); if (problems.length) throw new TrustedRejection(problems[0]); }
  // Photo readings and charges are new with the panel work: their checks hold whatever the protocol.
  if(task.phase==='examine'){
    const pinned=(task.packet.photos??[]).map(p=>p.photoId),read=(artifact as z.infer<typeof photoExamSchema>).photos;
    if(read.length!==pinned.length||new Set(read.map(p=>p.photoId)).size!==read.length||read.some(p=>!pinned.includes(p.photoId)))throw new TrustedRejection('Give exactly one reading for each pinned photo: '+pinned.join(', '));
    for(const p of read)for(const o of p.observations)if(o.kind==='same_scene_as'&&(o.value===p.photoId||!pinned.includes(o.value)))throw new TrustedRejection('same_scene_as must name another pinned photo');
    if(read.some(p=>p.observations.filter(o=>o.kind==='plate_text').length>1))throw new TrustedRejection('Give at most one plate_text reading for each photo');
    if(artifact.summary!==photoSummary(read))throw new TrustedRejection('The photo reading summary is the server-written line from photoSummary(), not prose');
  }
  if(task.protocolVersion!==2){
    if('outcome' in artifact&&(artifact.outcome==='charge_recommendation'||artifact.outcome==='driver_payment_recommendation'))throw new TrustedRejection('A charge or driver payment needs protocol 2, which checks the filing party and the claimed amount');
    return artifact;
  }
  if(!task.runId||artifact.artifactId!==artifactId({...task,runId:task.runId})||artifact.author!==task.role)throw new TrustedRejection('Artifact identity must match the assigned task');
  // Editorial guard on the words both parties read; not a fairness control (spec revision 19).
  const partyWord=(artifact as {explanationToBothParties?:string}).explanationToBothParties?.match(labelWords)?.[0];
  if(partyWord)throw new TrustedRejection(`Party-facing text must not label a person: "${partyWord.toLowerCase()}" in explanationToBothParties. Describe the record instead, for example "the receipt number matches an earlier claim".`);
  const profileOnly=profileOnlyCriteria((artifact as {criteria?:{condition:string;citations:{sourceId:string}[]}[]}).criteria??[]);
  if(profileOnly.length)throw new TrustedRejection('A criterion cannot rest on account profile citations alone: '+profileOnly.join(', ')+'. Cite the trip evidence it turns on.');
  const facts=deriveFacts(task.packet);
  if(artifact.policyIds.some(id=>!facts.allowedPolicyIds.includes(id)))throw new TrustedRejection('Policy is outside this case category; completed-trip waiting fees do not apply to a cancelled no-show');
  if(task.phase==='examine')return artifact;
  if(task.phase==='collect'||task.phase==='apply'){const a=artifact as any;for(const [i,x] of ((a.assessments??[]) as {ruleId:string}[]).entries())if(!task.packet.policies.some(p=>p.rule_id===x.ruleId)||!artifact.policyIds.includes(x.ruleId))throw new TrustedRejection('Each assessed rule must be pinned in this packet and listed in policyIds: assessment '+(i+1)+(task.packet.policies.some(p=>p.rule_id===x.ruleId)?' ('+x.ruleId+')':' names a rule this case does not pin'));
    // The Policy Analyst may only cite an assumption the pinned posture enables and that was written for this case type.
    for(const id of new Set<string>((a.assessments??[]).flatMap((x:any)=>(x.conditions??[]).map((c:any)=>c.assumptionId).filter(Boolean)))){
      const problem=assumptionIneligibility(id,task,facts.category,safetyInvolvedIn(task,facts.category)); if(problem)throw new TrustedRejection(problem);
    }
    return artifact;}
  const disclosed=task.disclosed??{},opponent=task.role==='rider'?'driver':'rider';
  if(task.phase==='investigate'){artifact.claims=artifact.claims!.map((c,i)=>{const id=artifact.artifactId+'#'+(i+1);if(c.claimId&&c.claimId!==id)throw new TrustedRejection('Claim identity is server-owned: omit claimId in every claim; the server numbers them '+artifact.artifactId+'#1, #2 and so on');return {...c,claimId:id};});if(artifact.issues)artifact.issues=artifact.issues.map((x,i)=>{const id=artifact.artifactId+'#I'+(i+1);if(x.issueId&&x.issueId!==id)throw new TrustedRejection('Issue identity is server-owned: omit issueId in every issue; the server numbers them '+artifact.artifactId+'#I1, #I2 and so on');return {...x,issueId:id};});}
  // Evidence checks 1 (MVP fixes, 10 October 2026): each claim quotes its lines, lists and cites the rules it names, and cites at most 15 lines; every problem in one rejection.
  if(task.phase==='investigate'&&hasEvidenceChecks(task.packet)){const problems=openingClaimProblems(task.packet,artifact,facts.allowedPolicyIds);if(problems.length)throw new ClaimCheckError(problems,artifact);}
  if(task.phase==='challenge'){
    const target=disclosed[opponent+'_investigate'];
    if(!target||artifact.targetArgumentId!==target.artifactId)throw new TrustedRejection('Challenge must target the opposing argument');
    const norm=(t:string|null|undefined)=>(t??'').replace(/\s+/g,' ').replace(/[\u2018\u2019]/g,"'").replace(/[\u201c\u201d]/g,'"').trim().toLowerCase();
    const resolveClaim=(id:string|null,quote:string|null)=>{const claim=target.claims?.find(c=>c.claimId===id);if(!claim)throw new TrustedRejection('Challenge must name an existing opposing claim ID (targetClaimId)');if(norm(claim.statement)!==norm(quote)&&!norm(claim.statement).includes(norm(quote)))throw new TrustedRejection('targetQuote must be the exact opposing claim text (or a verbatim part of it) for '+id);return claim;};
    if(artifact.challengeKind==='dispute'){
      const claim=resolveClaim(artifact.targetClaimId??null,artifact.targetQuote??null);
      artifact.targetQuote=claim.statement; // server canonicalises the quote; the claim ID is the identity
    }else if(artifact.targetClaimId!==null||artifact.targetQuote!==null)throw new TrustedRejection('No-material-challenge must use null targetClaimId and targetQuote');
    const extras=artifact.additionalTargets??[];
    if(extras.length&&artifact.challengeKind!=='dispute')throw new TrustedRejection('Additional targets require a dispute challenge');
    const ids=new Set([artifact.targetClaimId,...extras.map(t=>t.targetClaimId)]);
    if(ids.size!==extras.length+1)throw new TrustedRejection('Each challenged claim may be targeted once');
    for(const t of extras){const claim=resolveClaim(t.targetClaimId,t.targetQuote);t.targetQuote=claim.statement;}
    // Evidence checks 2 (MVP fixes F3, owner, 10 October 2026): gap points rest on this task's record requests and weaken opposing
    // claims; every problem in one rejection (gap-points.ts), then the server numbers them.
    if(hasGapPoints(task.packet)&&artifact.gapPoints?.length){
      const problems=gapPointProblems(task.packet,artifact,target);
      if(problems.length)throw new ClaimCheckError(problems,artifact,'challenge');
      artifact.gapPoints=artifact.gapPoints.map((g,i)=>({...g,gapPointId:gapPointIdFor(artifact.artifactId!,i)}));
    }
  }
  if(task.phase==='respond'){
    const own=disclosed[task.role+'_investigate'],challenge=disclosed[opponent+'_challenge'];
    if(!own||!challenge||artifact.ownArgumentId!==own.artifactId||artifact.responseToChallengeId!==challenge.artifactId||challenge.targetArgumentId!==own.artifactId)throw new TrustedRejection('Response must answer the challenge addressed to your own argument');
    const expected=(challenge.additionalTargets??[]).map(t=>t.targetClaimId),given=(artifact.additionalAnswers??[]).map(a=>a.targetClaimId);
    if(expected.length!==given.length||expected.some(id=>!given.includes(id)))throw new TrustedRejection('Answer every additional challenged claim exactly once: '+(expected.length?expected.join(', ')+', one additionalAnswers entry for each targetClaimId (you gave '+given.length+')':'this challenge has no additional targets, so omit additionalAnswers and answer the one challenge in answer'));
    for(const revision of artifact.revisions??[]){const claim=own.claims?.find(c=>c.claimId===revision.claimId);if(!claim||claim.statement!==revision.previousText)throw new TrustedRejection('Cannot retract or revise another agent’s claim; previousText must match your own claim exactly');}
  }
  if(task.phase==='decide'&&'outcome' in artifact){
    const criteria=artifact.criteria!;
    if(criteria.length!==facts.requiredCriteria.length||new Set(criteria.map(c=>c.condition)).size!==criteria.length||facts.requiredCriteria.some(id=>!criteria.some(c=>c.condition===id)))throw new TrustedRejection('Decision criteria must exactly match: '+facts.requiredCriteria.join(', ')+'');
    const missingFacts=facts.facts.filter(f=>!artifact.factIds!.includes(f.id)).map(f=>f.id),unknownFacts=artifact.factIds!.filter(id=>!facts.facts.some(f=>f.id===id));
    if(missingFacts.length||unknownFacts.length)throw new TrustedRejection('Acknowledge every supplied deterministic fact by ID; do not invent fact IDs. Missing: '+missingFacts.join(', ')+'. Unknown: '+(unknownFacts.length?unknownFacts.length+' factIds that read_calculations does not list':'none'));
    const fact=(id:string)=>facts.facts.find(f=>f.id===id)?.value;
    const requireStatus=(condition:string,value:unknown)=>{if(!facts.requiredCriteria.includes(condition))return;if(typeof value==='boolean'&&criteria.find(c=>c.condition===condition)?.status!==(value?'met':'not_met'))throw new TrustedRejection('Criterion '+condition+' contradicts a deterministic calculation: read_calculations requires status '+(value?'met':'not_met')+' for '+condition);};
    if(facts.category==='no_show'){requireStatus('wait_threshold',fact('wait_threshold_met'));if(fact('trip_not_started')===true)requireStatus('trip_not_completed',true);}
    // Contract 4: a declared wait of 3 minutes or less cannot be "more than 3 minutes" at the pickup (P04 counts from I'm Here; red team, round 1).
    // An advance booking counts from the booked time, or from the arrival if later (owner decision, 6 October 2026).
    const advanceWait=fact('wait_exceeds_three_minutes_from_wait_start');
    if((task.packet.contractVersion??0)>=4&&facts.branch==='driver_no_show'&&advanceWait===null&&criteria.find(c=>c.condition==='wait_threshold')?.status==='met')throw new TrustedRejection('Criterion wait_threshold cannot be met: on an advance booking the no-show wait counts from the booked time, or from the driver\'s arrival if later, and the record does not give those times, so whether the driver waited more than 3 minutes is unknown. Leave it unresolved with a missing_fact question');
    else if((task.packet.contractVersion??0)>=4&&facts.branch==='driver_no_show'&&advanceWait===false&&criteria.find(c=>c.condition==='wait_threshold')?.status==='met')throw new TrustedRejection('Criterion wait_threshold contradicts a deterministic calculation: on an advance booking the no-show wait counts from the booked time, or from the driver\'s arrival if later (owner decision, 6 October 2026), and that wait is 3 minutes or less (no_show_wait_start, wait_exceeds_three_minutes_from_wait_start)');
    else if((task.packet.contractVersion??0)>=4&&facts.branch==='driver_no_show'&&advanceWait===undefined&&fact('wait_exceeds_three_minutes_from_declared_arrival')===false&&criteria.find(c=>c.condition==='wait_threshold')?.status==='met')throw new TrustedRejection('Criterion wait_threshold contradicts a deterministic calculation: the wait from the declared arrival to the cancellation is 3 minutes or less (wait_exceeds_three_minutes_from_declared_arrival)');
    // Contract 4: the claim procedure cannot be met against the record: both clocks computed in time, a photo record showing the plate,
    // and a receipt with every field the driver page asks for.
    if((task.packet.contractVersion??0)>=4&&facts.branch==='cleaning_claim'&&criteria.find(c=>c.condition==='claim_procedure')?.status==='met'){
      const receipt=fact('receipt_fields_present') as Record<string,unknown>|undefined;
      const fails=[fact('claim_within_48h')!==true&&'the claim is not shown within 48 hours',fact('cleaning_within_24h')!==true&&'the cleaning is not shown within 24 hours',fact('plate_visible_in_any_photo')!==true&&'no photo is recorded as showing the plate',(!receipt||Object.entries(receipt).some(([k,v])=>k==='amount'?v===null:v!==true))&&'the receipt lacks a field the driver page asks for'].filter(Boolean);
      if(fails.length)throw new TrustedRejection('Criterion claim_procedure contradicts the record ('+fails.join('; ')+'): answer not_met, or unresolved if the record may be incomplete');
    }
    // Contract 4: a promo dispute without the campaign terms in the record keeps the campaign question open.
    if((task.packet.contractVersion??0)>=4&&facts.branch==='promo_code'&&fact('campaign_terms_in_evidence')!==true&&criteria.find(c=>c.condition==='charge_matches_campaign_terms')?.status!=='unresolved')throw new TrustedRejection('The campaign terms are not in the record (campaign_terms_in_evidence), so charge_matches_campaign_terms stays unresolved with a missing_fact question');
    // Contract 4: the free period is computed (P02, P03, P07); an unknown one (exactly 15 minutes ahead, missing or out-of-order times)
    // stays open. A driver the record shows on time was not late.
    if((task.packet.contractVersion??0)>=4&&facts.branch==='rider_cancellation'){
      const grace=fact('cancelled_after_grace'),answer=criteria.find(c=>c.condition==='cancelled_after_grace')?.status;
      if(typeof grace==='boolean')requireStatus('cancelled_after_grace',grace);
      else if(answer&&answer!=='unresolved')throw new TrustedRejection('Criterion cancelled_after_grace contradicts a deterministic calculation: the free period cannot be computed from the record (read_calculations), so leave it unresolved with its question');
      // A10 rests on the GPS standard (owner decision, 6 October 2026): the waiver is met only when the GPS shows the car parked away or moving away.
      if(criteria.find(c=>c.condition==='driver_not_heading_waiver')?.status==='met'&&fact('driver_parked_away_before_cancel')!==true&&fact('driver_moving_away_before_cancel')!==true)throw new TrustedRejection('Criterion driver_not_heading_waiver contradicts a deterministic calculation: the GPS does not show the car parked away or moving away (driver_parked_away_before_cancel, driver_moving_away_before_cancel); answer no, or unresolved if the GPS is too thin');
      if(fact('driver_missed_eta_by_2_min')===false&&criteria.find(c=>c.condition==='late_driver_goodwill')?.status==='met')throw new TrustedRejection('Criterion late_driver_goodwill contradicts a deterministic calculation: the record shows the driver was not more than 2 minutes late (driver_missed_eta_by_2_min)');
      // Red team, round 1: a late driver the record computes is not "not late": give the goodwill, or leave it open for a person.
      // Where the fee could stand, with no ETA record, or thin GPS and no arrival, a settled goodwill answer must rest on a cited message.
      // A cited message is a chat or app-event line range that holds a message's text (red team, round 2: an empty log is not a message).
      const messageLine=/"(content|details)"\s*:\s*"\s*[^"\s]/;
      const answerOf=(id:string)=>criteria.find(c=>c.condition===id),fromMessage=(c:{citations:{sourceId:string;startLine:number;endLine:number}[]}|undefined)=>!!c&&c.citations.some(x=>(x.sourceId==='evidence/chat_logs.json'||x.sourceId==='evidence/app_events.json')&&(task.packet.sources.find(s=>s.id===x.sourceId)?.lines??[]).slice(x.startLine-1,x.endLine).some(l=>messageLine.test(l)));
      const late=answerOf('late_driver_goodwill'),waiver=answerOf('driver_not_heading_waiver');
      if(fact('driver_missed_eta_by_2_min')===true&&late?.status==='not_met')throw new TrustedRejection('Criterion late_driver_goodwill contradicts a deterministic calculation: the record shows the driver more than 2 minutes late (driver_missed_eta_by_2_min). Answer met under A9, or leave it unresolved for a person if the record shows the rider caused the delay');
      if(grace!==false&&fact('driver_missed_eta_by_2_min')===null&&late&&late.status!=='unresolved'&&!fromMessage(late))throw new TrustedRejection('No pickup time shown at matching is recorded, so late_driver_goodwill stays unresolved unless a cited message (chat_logs or app_events) gives the pickup time; cite it, or leave the question unresolved');
      // The GPS shows the car parked or moving away and A10 can apply: "not heading there: no" rests on a cited message that clears the
      // driver (a roadblock, a call), or the question stays open (red team, round 2).
      if(grace!==false&&waiver?.status==='not_met'&&(fact('driver_parked_away_before_cancel')===true||fact('driver_moving_away_before_cancel')===true)&&!fromMessage(waiver)&&!assumptionIneligibility('A10-DRIVER-NOT-HEADING-WAIVER',task,facts.category,safetyInvolvedIn(task,facts.category)))throw new TrustedRejection('Criterion driver_not_heading_waiver contradicts the GPS (driver_parked_away_before_cancel or driver_moving_away_before_cancel) unless a cited message (chat_logs or app_events) clears the driver: answer met under A10, cite the message line, or leave it unresolved');
      if(grace!==false&&fact('gps_supports_movement_finding')!==true&&fact('driver_arrived_before_cancel')!==true&&waiver?.status==='not_met'&&!fromMessage(waiver))throw new TrustedRejection('The GPS cannot show where the driver was and no arrival is recorded, so driver_not_heading_waiver stays unresolved unless a cited message (chat_logs or app_events) shows it; cite it, or leave the question unresolved');
    }
    if(task.packet.datasetKind){
      if(artifact.outcome==='refund_recommendation')throw new TrustedRejection(sampleRefundRefusal);
      if(fact('fee_matches_sample_policy')===false)requireStatus('recorded_charge',false);
    }else if(fact('payment_reconciled')===true&&!((task.packet.contractVersion??0)>=4&&!!facts.branch&&typeof fact('disputed_charge_outstanding_cents')!=='number'))requireStatus('charge_reconciliation',true);
    else if(criteria.some(c=>c.condition==='charge_reconciliation')&&criteria.find(c=>c.condition==='charge_reconciliation')?.status!=='unresolved')throw new TrustedRejection('Unreconciled or missing payment evidence requires an unresolved charge criterion');
    const precedentProblems=precedentNoteProblems(task.packet,artifact);
    if(precedentProblems.length)throw new TrustedRejection(precedentProblems.join(' '));
    const register=openingIssues(disclosed);
    if(register.length){const ids=register.map(i=>i.issueId),given=(artifact.issueDispositions??[]).map(d=>d.issueId);if(ids.length!==given.length||ids.some(id=>!given.includes(id))||new Set(given).size!==given.length)throw new TrustedRejection('Arbitrator must dispose of every opening issue exactly once: '+ids.join(', '));}
    const unresolved=criteria.filter(c=>c.status==='unresolved');
    if(!rulesV4(task.packet)&&(artifact.reviewReasons?.length??0)>4)throw new TrustedRejection('List at most 4 open questions (reviewReasons) on this contract');
    // Contract 4 (rules rebuild): a facts-4 packet is checked by question role. A scope or records question answered no is itself a
    // ground for a person's review (roleProblems allows nothing else), so its review reason may name it.
    const byRole=(task.packet.contractVersion??0)>=4&&!!facts.branch;
    const answeredNo=byRole?criteria.filter(c=>c.status==='not_met'&&['scope','evidence'].includes(roleOf(facts.branch!,c.condition)??'')):[];
    if(artifact.outcome==='human_review'){
      const grounds=[...unresolved,...answeredNo];
      if(!grounds.length||!artifact.reviewReasons?.length)throw new TrustedRejection('Human review requires an unresolved decision prerequisite, not a general caveat');
      if(artifact.reviewReasons.some(r=>!grounds.some(c=>c.condition===r.condition)))throw new TrustedRejection('Review reason must identify an unresolved criterion and its decision impact');
    }else{
      // The Judge always recommends. An unresolved criterion is allowed on a recommendation only as an open question that states the reading the recommendation rests on; routing (not the Judge) then decides whether a person looks first.
      const settled=artifact.reviewReasons!.filter(r=>!unresolved.some(c=>c.condition===r.condition)).map(r=>{const c=criteria.find(x=>x.condition===r.condition);return c?c.condition+' is '+c.status:'one names no required criterion';});
      if(settled.length)throw new TrustedRejection('An open question must name an unresolved criterion; resolved criteria carry no review reasons: '+[...new Set(settled)].join(', ')+'. Remove those review reasons, or mark the criterion unresolved if the question is still open.');
      for(const c of unresolved){const q=artifact.reviewReasons!.find(r=>r.condition===c.condition);if(!q)throw new TrustedRejection('Every unresolved criterion needs an open question (reviewReasons) with the reading your recommendation rests on: '+c.condition);if(!q.recommendedReading?.trim())throw new TrustedRejection('Open question on '+c.condition+' must state recommendedReading: the reading your recommendation rests on and what the other reading would change');}
      // Contract 3 (1 October): an open fact or policy question on a recommendation states the outcome under the other reading. Routing keeps a question whose other reading gives the same outcome and amount as a note (a missing fact too, from 7 October 2026, when a rule question with S$10 or less at stake also releases); otherwise it sends the case to a person (run e28d1159, DISP-013: a wait-clock gap that changed nothing sent a decided case to a person). Older packets have no contract version and are validated as they were.
      if((task.packet.contractVersion??0)>=3)for(const q of artifact.reviewReasons!)if(gapKinds.includes(q.kind??'')&&!q.otherReading)throw new TrustedRejection('Open question on '+q.condition+' ('+q.kind+') must state otherReading: the outcome and amount you would recommend under the other reading of this question (equal to your recommendation when it holds either way; decisionImpact must say why)');
    }
    // Ambiguity posture, version 2: only registry assumptions, only where the posture allows, never on safety, only on the criteria each
    // names. A reading may decide an outcome with money (A5 allocates a toll; A9 and A10 support a voucher, checked by roleProblems), but
    // never supplies a fact, a payment or an amount: the money checks still apply.
    const posture=task.packet.posture, assumptions=artifact.assumptions??[], reasons=artifact.reviewReasons??[];
    const safetyInvolved=safetyInvolvedIn(task,facts.category);
    for(const c of unresolved)if(!reasons.some(r=>r.condition===c.condition))throw new TrustedRejection('Every unresolved criterion must list its blockers as review reasons: '+c.condition);
    // A page conflict blocks only the criteria it bears on. C01 (fee amount) cannot keep arrival_at_pickup in review.
    const pinnedConflicts=task.packet.policySelection?.conflictIds??[];
    for(const r of reasons){
      if(r.kind==='page_conflict'){
        if(!r.conflictIds?.length)throw new TrustedRejection('A page_conflict blocker must name the conflict IDs from list_conflicts (conflictIds) on '+r.condition);
        for(const id of r.conflictIds){
          // A model-written conflict ID is repeated to the model only: this refusal is logged as a fixed line (tools.ts).
          if(!pinnedConflicts.includes(id))throw new Error('Conflict '+id+' is not recorded for this case');
          const affects=conflictAffects(id);
          if(!affects.includes(r.condition))throw new TrustedRejection('Conflict '+id+' concerns '+affects.join('/')+' and cannot block '+r.condition+'; decide that criterion on the evidence or name a different kind of blocker');
          if(byRole&&id==='C07'&&r.condition==='fare_follows_fare_rule'&&!tollRecorded(datasetBlock(task.packet,'fare_breakdown'),datasetBlock(task.packet,'route_data')))throw new TrustedRejection('Conflict C07 concerns ERP tolls, and no toll is in the record, so it cannot hold fare_follows_fare_rule open');
          if((task.packet.contractVersion??0)>=4&&id==='C04'&&facts.branch==='driver_no_show'&&typeof fact('wait_exceeds_three_minutes_from_wait_start')==='boolean')throw new TrustedRejection('Conflict C04 no longer holds an advance no-show open: the owner decided on 6 October 2026 that the wait counts from the booked time, or from the driver\'s arrival if later (no_show_wait_start, wait_exceeds_three_minutes_from_wait_start). Decide '+r.condition+' on that and do not cite C04.');
          const explained=conflictExplanation(id); if(explained)throw new TrustedRejection('Conflict '+id+' is explained by a team reading, not an open disagreement: '+explained+' Decide '+r.condition+' on that reading and do not cite '+id+' as a blocker.');
        }
      }else if(r.conflictIds?.length)throw new TrustedRejection('conflictIds belong only on page_conflict blockers ('+r.condition+')');
    }
    const seen=new Set<string>();
    for(const a of assumptions){
      const problem=assumptionIneligibility(a.id,task,facts.category,safetyInvolved); if(problem)throw new TrustedRejection(problem);
      const approved=assumptionById(a.id)!;
      const misfit=readingMisfit(a.id,task.packet,a.criterion); if(misfit)throw new TrustedRejection(misfit);
      if(!(approved.criteria as readonly string[]).includes(a.criterion)||!facts.requiredCriteria.includes(a.criterion))throw new TrustedRejection(a.id+' may not decide criterion '+(facts.requiredCriteria.includes(a.criterion)?a.criterion:'(one this case does not ask)'));
      if(seen.has(a.id+':'+a.criterion))throw new TrustedRejection('Duplicate assumption '+a.id+' on '+a.criterion); seen.add(a.id+':'+a.criterion);
      // An assumption settles the gap it covers; the criterion may stay unresolved for other gaps, which stay listed and routed.
    }
    // Abstaining (human_review) is refused when every listed gap is of a kind an enabled assumption can settle. The kind is broad,
    // so the gap may be a different question (DISP-017's refused promo code): then the Judge still recommends, keeps the gap as an
    // open question, and routing sends the case to a person. It never has to invoke an assumption that does not fit.
    if(posture?.allowedAssumptions.length){
      const decidable=settledByReading(task.packet,facts.category,byRole);
      // An unsupported dispute has nothing to recommend, and a scope or records "no" is a finding, not a gap a reading settles.
      if(artifact.outcome==='human_review'&&!safetyInvolved&&!(byRole&&facts.branch==='unsupported')){
        const blocking=reasons.filter(r=>!decidable(r)||answeredNo.some(c=>c.condition===r.condition));
        if(!blocking.length)throw new TrustedRejection('Every gap you listed is of a kind an enabled approved assumption can settle ('+posture.allowedAssumptions.join(', ')+'). If one settles a gap, invoke it in assumptions[]. For any gap no assumption settles, give your recommendation and keep that gap as an open question with the reading it rests on; the routing step then decides whether a person looks first. Do not relabel the same doubt under another kind.');
      }
    }
    if(assumptions.length&&posture?.mode!=='conditional_demo')throw new TrustedRejection('Assumptions are permitted only in conditional_demo mode');
    artifact.conditional=assumptions.length>0;
    const filedBy=(()=>{try{return JSON.parse(task.packet.sources.find(s=>s.id==='evidence/dispute_ticket.json')?.text??'{}').filed_by??null;}catch{return null;}})();
    // The money checks a person's final decision also passes (moneyProblems): shape, charge rules, sample refunds and the card ceiling.
    const remedy=moneyProblems(artifact,task.packet,facts); if(remedy.length)throw new TrustedRejection(remedy[0]);
    // Evidence checks 2 (MVP fixes F3, owner, 10 October 2026): every gap point in the disclosed challenges answered once, by its ID.
    // The answers weigh claims in the reasoning; no routing rule reads them (routing.ts).
    if(hasGapPoints(task.packet)){const problems=gapPointResponseProblems(disclosed,artifact.gapPointResponses);if(problems.length)throw new ClaimCheckError(problems,artifact,'decision');}
    if(byRole){
      const claimed=facts.facts.find(f=>f.id==='claimed_cleaning_cents')?.value;
      const held=facts.facts.find(f=>f.id==='disputed_charge_outstanding_cents')?.value;
      const excess=facts.facts.find(f=>f.id==='fare_excess_cents')?.value;
      const problems=roleProblems(facts.branch!,criteria,artifact as Dec,artifact.assumptions??[],{claimedCents:typeof claimed==='number'?claimed:null,heldCents:typeof held==='number'?held:null,excessCents:typeof excess==='number'?excess:null,paidForClaimCents:typeof fact('driver_paid_for_claim_cents')==='number'?fact('driver_paid_for_claim_cents') as number:null});
      if(problems.length)throw new TrustedRejection(problems[0]);
      return artifact;
    }
    // Contract 3 and older: in a rider's dispute an unmet criterion is an entitlement to a remedy. In a driver's cleaning claim it is a reason to decline the charge.
    const driverClaim=facts.category==='cleaning'&&filedBy==='driver';
    if(artifact.outcome==='no_action'&&!driverClaim&&criteria.some(c=>c.status==='not_met'))throw new TrustedRejection('No-action cannot ignore an unmet decision criterion');
    if(artifact.outcome==='refund_recommendation'){
      if(!criteria.some(c=>c.condition!=='charge_reconciliation'&&(c.status==='not_met'||(c.status==='unresolved'&&artifact.reviewReasons?.some(r=>r.condition===c.condition&&r.recommendedReading)))))throw new TrustedRejection('A refund requires an unmet entitlement condition, or an open entitlement question with the reading it rests on; a cash ceiling is not entitlement');
    }
  }
  return artifact;
}
