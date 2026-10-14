import { z } from 'zod';
import type { CasePacket } from './contracts';
import type { Facts } from './facts';

const text = z.string().min(1).max(12000);
const time = z.iso.datetime({ offset: true });
const count = z.number().int().nonnegative().max(10000000);
const money = z.number().nonnegative().max(1000).refine(n => Math.abs(n * 100 - Math.round(n * 100)) < 1e-8, 'Use whole cents');
const point = { lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) };
const profile = { account_age_days: count, total_trips: count, avg_rating: z.number().min(0).max(5), fraud_flags: count };

// Closed schema: commentary, evaluator fields and unknown extensions cannot enter
// a blind packet as extra JSON keys. Evidence strings remain untrusted content.
export const organiserSchema = z.object({
  dispute_ticket: z.object({ dispute_id: z.literal('DISP-002'), trip_id: text, filed_by: z.literal('rider'), dispute_type: z.literal('no_show_charge'), description: text, filed_at: time, status: text }).strict(),
  rider_profile: z.object({ rider_id: text, name: text, ...profile, dispute_history: z.object({ total_disputes: count, upheld: count, rejected: count }).strict(), fraud_flag_details: text, payment_method: text }).strict(),
  driver_profile: z.object({ driver_id: text, name: text, ...profile, dispute_history: z.object({ total_disputes: count, upheld_against: count, rejected: count }).strict(), vehicle: text }).strict(),
  trip_data: z.object({ trip_id: text, rider_id: text, driver_id: text, pickup_location: z.object({ name: text, ...point }).strict(), dropoff_location: z.object({ name: text, ...point }).strict(), scheduled_time: time, driver_arrival_time: time, driver_wait_start: time, cancellation_time: time, cancellation_fee: money, cancellation_reason: z.literal('rider_no_show') }).strict(),
  gps_telemetry: z.array(z.object({ timestamp: time, ...point, speed_kmh: z.number().nonnegative().max(300), status: z.enum(['en_route', 'arrived', 'waiting', 'cancelled']) }).strict()).min(1).max(1000),
  chat_logs: z.array(z.object({ timestamp: time, sender: z.enum(['rider', 'driver', 'system']), type: z.enum(['message', 'call', 'system']), content: text }).strict()).max(1000),
  app_events: z.array(z.object({ timestamp: time, event_type: text, details: text }).strict()).min(1).max(1000),
  cancellation_policy: z.object({ free_wait_time_min: z.number().positive().max(60), cancellation_fee_after_wait: money, no_show_threshold_min: z.number().positive().max(120), fee_goes_to: text }).strict(),
}).strict().superRefine((d, ctx) => {
  const trip = d.trip_data;
  if (trip.trip_id !== d.dispute_ticket.trip_id || trip.rider_id !== d.rider_profile.rider_id || trip.driver_id !== d.driver_profile.driver_id) ctx.addIssue({ code: 'custom', message: 'Cross-record identity mismatch' });
  if (Date.parse(trip.cancellation_time) < Date.parse(trip.driver_arrival_time)) ctx.addIssue({ code: 'custom', message: 'Cancellation precedes recorded arrival' });
});
export type OrganiserDataset = z.infer<typeof organiserSchema>;
export const organiserCaseId = /^DISP-002(?:-V0[1-4])?$/;
export const organiserPolicyId = 'SAMPLE-DISP-002-CANCELLATION';
export const organiserProfile = `DISP-002 sample policy, version 1.
This is the policy supplied with the organiser sample, not a verified current or historical Ryde service policy. It must not inherit the laboratory dossier rules.
The no-show threshold is a total threshold, not free wait plus another threshold. The sample does not explicitly define whether early arrival, scheduled pickup, or app timer activation starts eligible waiting. Compare all recorded intervals; state any interpretation rather than inventing a clause. A human-review proposal is permitted when that omission changes entitlement.
The fee-applied app event is evidence that this sample records a charge, not independent processor reconciliation. No settled payment ledger or refund instrument is supplied. No money executes; any monetary remedy needs separate verification.
For decision checks, contact_evidence assesses what contacts the record supports; the policy does not state a mandatory contact count. Missing contacts alone are not an invented policy violation. remedy_if_needed is met when no monetary change is needed, and unresolved when a possible reversal needs missing settlement/refund verification. In that situation, human review can accompany an unmet entitlement criterion without fabricating a refund amount.
Account ratings, dispute history and fraud flags do not establish responsibility for this trip. Notification sent is not notification read; GPS samples are not continuous proof. Contact logs and app events may describe the same contact and must not be double-counted.
Confidence is uncalibrated. Evaluate the trip evidence, not an expected answer.`;

export function parseOrganiserMarkdown(markdown: string): OrganiserDataset {
  if (Buffer.byteLength(markdown) > 262144) throw new Error('Sample exceeds 256 KiB');
  const blocks = [...markdown.matchAll(/^```json\s*\r?\n([\s\S]*?)^```\s*$/gm)];
  if (blocks.length !== 1) throw new Error('Expected exactly one JSON dataset block');
  return organiserSchema.parse(JSON.parse(blocks[0][1]));
}

export function organiserFacts(packet: CasePacket): Facts {
  const read = (key: keyof OrganiserDataset) => JSON.parse(packet.sources.find(s => s.id === `evidence/${key}.json`)!.text);
  // Revalidate loaded sources; a manifest hash proves byte integrity, not shape.
  const data = organiserSchema.parse(Object.fromEntries(Object.keys(organiserSchema.shape).map(key => [key, read(key as keyof OrganiserDataset)])));
  const cite = (key: keyof OrganiserDataset) => { const source = packet.sources.find(s => s.id === `evidence/${key}.json`)!; return { sourceId: source.id, startLine: 1, endLine: source.lines.length }; };
  const facts: Facts['facts'] = [];
  const add = (id: string, value: unknown, explanation: string, keys: (keyof OrganiserDataset)[]) => facts.push({ id, value, explanation, citations: keys.map(cite) });
  const trip = data.trip_data;
  const cancel = Date.parse(trip.cancellation_time);
  const duration = (start: string) => (cancel - Date.parse(start)) / 1000;
  add('recorded_wait_seconds', duration(trip.driver_arrival_time), 'Cancellation minus recorded arrival; does not prove continuous physical presence.', ['trip_data']);
  add('scheduled_wait_seconds', duration(trip.scheduled_time), 'Cancellation minus scheduled pickup; eligible-wait origin is unspecified.', ['trip_data']);
  const timers = data.app_events.filter(e => e.event_type === 'wait_timer_started');
  add('app_timer_wait_seconds', timers.length === 1 ? duration(timers[0].timestamp) : null, 'Cancellation minus the unique recorded timer start; missing or duplicate starts remain unknown.', ['trip_data', 'app_events']);
  add('sample_no_show_threshold_seconds', data.cancellation_policy.no_show_threshold_min * 60, 'Sample total no-show threshold; no assumed clock origin and not added to free wait.', ['cancellation_policy']);
  const intervals=[duration(trip.driver_arrival_time),duration(trip.scheduled_time),...(timers.length===1?[duration(timers[0].timestamp)]:[])];
  if(timers.length===1&&intervals.every(seconds=>seconds>=0&&seconds<data.cancellation_policy.no_show_threshold_min*60))add('wait_threshold_met',false,'Every supplied candidate wait interval is below the sample threshold; none can establish a sufficient wait.', ['trip_data','app_events','cancellation_policy']);
  add('sample_free_wait_seconds', data.cancellation_policy.free_wait_time_min * 60, 'Separate sample free-wait period.', ['cancellation_policy']);
  const inWindow = data.chat_logs.filter(e => Date.parse(e.timestamp) >= Date.parse(trip.driver_arrival_time) && Date.parse(e.timestamp) <= cancel);
  add('driver_contact_counts', { messages: inWindow.filter(e => e.sender === 'driver' && e.type === 'message').length, calls: inWindow.filter(e => e.sender === 'driver' && e.type === 'call').length }, 'Recorded contacts in the arrival-to-cancellation window; call records do not prove an answered call or message delivery.', ['chat_logs', 'trip_data']);
  add('rider_message_count', inWindow.filter(e => e.sender === 'rider' && e.type === 'message').length, 'Zero recorded messages does not establish rider absence.', ['chat_logs']);
  add('recorded_fee_cents', Math.round(trip.cancellation_fee * 100), 'Fee recorded in trip data; not a verified settled payment.', ['trip_data']);
  add('fee_matches_sample_policy', trip.cancellation_fee === data.cancellation_policy.cancellation_fee_after_wait, 'Compares recorded fee to the sample policy amount only.', ['trip_data', 'cancellation_policy']);
  add('settled_payment_verified', false, 'No independent settlement/refund records are supplied; no cash or voucher remedy is authorized by this packet.', ['trip_data']);
  return { category: 'no_show', facts, allowedPolicyIds: [organiserPolicyId], requiredCriteria: ['arrival_at_pickup', 'wait_threshold', 'contact_evidence', 'recorded_charge', 'remedy_if_needed'], requiredSourceIds: ['dispute_ticket', 'trip_data', 'gps_telemetry', 'chat_logs', 'app_events', 'cancellation_policy'].map(k => `evidence/${k}.json`), cashCeiling: null, pendingRefund: false };
}
