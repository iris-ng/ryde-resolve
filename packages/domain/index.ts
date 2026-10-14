import { z } from "zod";
export const policyVersion = "demo-2026-09-v1";
export const policies = [
  { id: "P-ROUTE-1", title: "Unapproved route charges", text: "Demo policy: refund the verified excess distance charge only when route evidence is complete and the rider did not consent to the detour. A longer route alone does not establish fault." },
  { id: "P-NOSHOW-1", title: "No-show eligibility", text: "Demo policy: a cancellation fee requires arrival within the pickup zone, at least five minutes of waiting, and a documented contact attempt. Refund the fee when verified facts fail these conditions." },
  { id: "P-REVIEW-1", title: "Insufficient evidence", text: "Demo policy: escalate when required trip, consent, waiting or contact facts are unknown, or when a safety concern is present. Do not interpret missing evidence as proof of fault." }
] as const;
const cents = z.number().int().nonnegative().max(100_000);
export const evidenceSchema = z.object({
  id: z.string(), kind: z.enum(["trip", "chat", "fare", "wait", "history"]),
  title: z.string(), detail: z.string(), source: z.string()
}).strict();
export const caseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  category: z.enum(["route_deviation", "no_show"]),
  title: z.string(), claim: z.string(), tripId: z.string(),
  rider: z.string(), driver: z.string(), disputedCents: cents,
  policyVersion: z.literal(policyVersion), synthetic: z.literal(true),
  evidence: z.array(evidenceSchema).min(1),
  facts: z.object({
    complete: z.boolean(), safetyFlag: z.boolean(),
    consentedDetour: z.boolean().nullable(), excessCents: cents.nullable(),
    arrivedInZone: z.boolean().nullable(),
    waitMinutes: z.number().nonnegative().nullable(),
    contactAttempt: z.boolean().nullable()
  }).strict()
}).strict();
export type DisputeCase = z.infer<typeof caseSchema>;
export const rulingSchema = z.object({
  outcome: z.enum(["refund", "no_action", "human_review"]), refundCents: cents,
  summary: z.string().min(1), riderExplanation: z.string().min(1), driverExplanation: z.string().min(1),
  evidenceIds: z.array(z.string()).min(1), policyIds: z.array(z.string()).min(1),
  policyVersion: z.literal(policyVersion), confidence: z.number().min(0).max(1).nullable(),
  mode: z.literal("simulation")
}).strict();
export type Ruling = z.infer<typeof rulingSchema>;
export type CaseArgument = {
  role: "Rider Advocate" | "Driver Advocate"; position: string;
  evidenceIds: string[]; policyIds: string[];
};
export type TraceEvent = { actor: string; action: string; detail: string; evidenceIds: string[] };
export type Analysis = { arguments: CaseArgument[]; ruling: Ruling };
export function needsReview(dispute: DisputeCase) {
  const f = dispute.facts;
  return !f.complete || f.safetyFlag || (dispute.category === "route_deviation"
    ? f.consentedDetour === null || f.excessCents === null
    : f.arrivedInZone === null || f.waitMinutes === null || f.contactAttempt === null);
}
export function validateRuling(input: unknown, dispute: DisputeCase): Ruling {
  const ruling = rulingSchema.parse(input);
  const evidence = new Set(dispute.evidence.map(e => e.id));
  if (ruling.evidenceIds.some(id => !evidence.has(id))) throw new Error("Unknown evidence citation");
  const allowedPolicies = new Set<string>(policies.map(p => p.id));
  if (ruling.policyIds.some(id => !allowedPolicies.has(id))) throw new Error("Unknown policy citation");
  if (ruling.policyVersion !== dispute.policyVersion) throw new Error("Policy version mismatch");
  if (ruling.refundCents > dispute.disputedCents) throw new Error("Refund exceeds disputed charge");
  if (ruling.outcome !== "refund" && ruling.refundCents !== 0) throw new Error("Non-refund outcome contains money");
  if (ruling.outcome === "refund" && ruling.refundCents === 0) throw new Error("Refund must be positive");
  if (needsReview(dispute) && ruling.outcome !== "human_review") throw new Error("Required escalation was bypassed");
  return ruling;
}
export function money(value: number) {
  return new Intl.NumberFormat("en-SG", { style: "currency", currency: "SGD" }).format(value / 100);
}
