import { z } from 'zod';
import type { CasePacket } from '../agent-flow/contracts';
import { rulesV4 } from '../case-packet/dataset';

export const safetyIntakeSchema = z.object({
  immediateDanger: z.boolean(), injury: z.boolean(), harassment: z.boolean(), dangerousDriving: z.boolean(),
  claimedAdditionalCents: z.number().int().min(0).max(100000000).nullable(),
  statement: z.string().trim().min(1).max(3000),
}).strict();
export type Triage = { version: 2 | 3; route: 'ordinary' | 'safety_review' | 'urgent_safety'; urgency: 'none' | 'review' | 'urgent'; exposure: { fare_cents: number | null; disputed_charge_cents: number | null; claimed_additional_cents: number | null; additional_loss_cents: number; unquantified_loss: boolean }; flags: { kind: string; sourceId: string; startLine: number; endLine: number; quote: string }[]; notice: string };
// Issue categories that name a charge on the trip: their claimed amounts are the money in dispute, not extra loss.
const chargeCategories = new Set(['no_show_charge', 'cancellation_fee', 'waiting_fee', 'driver_cancellation', 'route_deviation', 'fare_overcharge', 'surge_pricing', 'promo_code', 'destination_change', 'erp_toll', 'extra_charge', 'trip_not_taken', 'cleaning_fee']);
/** Version 3 (contract 4 and facts 4, rules rebuild): the disputed charge is the recorded cancellation fee or the collection the ticket names, never the requested amount, and extra loss is every claim that is not a charge. Older packets keep version 2. */
export function triage(packet: Pick<CasePacket, 'sources'> & Partial<Pick<CasePacket, 'factsVersion' | 'contractVersion'>>): Triage {
  const flags: Triage['flags'] = [];
  for (const source of packet.sources) {
    // Rule documents are not complaints. Uploaded documents are always screened.
    if (!source.id.startsWith('uploads/') && /policy|rules|external\//i.test(source.id)) continue;
    const rows = source.lines;
    for (let i = 0; i < rows.length; i++) {
      const line = rows[i];
      const structured = line.match(/^\s*"(immediateDanger|injury|harassment|dangerousDriving|immediate_danger|injury_reported|safety_relevant)"\s*:\s*(true|false),?\s*$/);
      if (structured) { if (structured[2] === 'true') flags.push({ kind: /immediate/.test(structured[1]) ? 'immediate_danger' : 'safety_report', sourceId: source.id, startLine: i + 1, endLine: i + 1, quote: line }); continue; }
      // Conservative screening candidates, not factual findings. Deliberately flag
      // ambiguous negation/quotes for review rather than silently dismissing them.
      const screenedText = line.replace(/\bthreaten\w*\s+to\s+(?:complain|report)\b/gi, '');
      // Sexual misconduct and abuse count as safety too (user, 4 October): molest, grope, sexual, indecent, inappropriate
      // touching, stalking, abuse, rape.
      if (/\b(injur(?:y|ies|ed)|harass\w*|assault\w*|threat\w*|dangerous driving|drove dangerously|crash(?:ed)?|hurt me|touched me|following me|molest\w*|grop(?:e|ed|es|ing)|sexual\w*|indecent\w*|inappropriately|stalk(?:ed|er|ers|ing)?|abus(?:e|ed|es|ing|ive)|rap(?:e|ed|es|ing))\b/i.test(screenedText)) {
        const urgent = /\b(right now|still threatening|following me|immediate danger|help now)\b/i.test(line);
        flags.push({ kind: urgent ? 'immediate_danger' : 'possible_safety_report', sourceId: source.id, startLine: i + 1, endLine: i + 1, quote: line });
      }
    }
  }
  const route = flags.some(f => f.kind === 'immediate_danger') ? 'urgent_safety' : flags.length ? 'safety_review' : 'ordinary';
  // Exposure from dataset blocks when present; separate the fare from the disputed charge and from claimed extra loss.
  const block = (id: string) => { try { return JSON.parse(packet.sources.find(s => s.id === `evidence/${id}.json`)?.text ?? 'null'); } catch { return null; } };
  const trip = block('trip_data'), ticket = block('dispute_ticket');
  const cents = (v: unknown) => typeof v === 'number' ? Math.round(v * 100) : null;
  const claimed = (ticket?.issues ?? []).map((i: any) => i.claimed_amount).filter((v: unknown) => typeof v === 'number');
  const v3 = rulesV4(packet);
  const intake = packet.sources.filter(s => s.id.startsWith('uploads/')).map(s => { try { return JSON.parse(s.text); } catch { return null; } }).find(x => x?.kind === 'operator_safety_intake');
  const operatorForm = Number.isInteger(intake?.claimedAdditionalCents) ? intake.claimedAdditionalCents : 0;
  let disputed: number | null, additional_loss_cents: number;
  if (v3) {
    // The disputed charge: the recorded cancellation fee, else the settled collection the ticket names by reference, else the amounts
    // claimed on issues that name a charge (a toll, a fee), else unknown. Never the requested remedy, which can include a loss.
    const named = [ticket?.charge_reference, ticket?.payment_reference, ticket?.reference].find(r => typeof r === 'string' && r);
    const payments = block('payment_events'), isCharge = (i: any) => chargeCategories.has(String(i.category ?? i.type ?? ''));
    const chargeClaims = (ticket?.issues ?? []).filter((i: any) => typeof i.claimed_amount === 'number' && isCharge(i));
    disputed = cents(trip?.cancellation_fee) ?? (named && Array.isArray(payments) ? cents(payments.find((p: any) => p.reference === named && p.status === 'settled')?.amount) : null)
      ?? (chargeClaims.length ? chargeClaims.reduce((a: number, i: any) => a + (cents(i.claimed_amount) ?? 0), 0) : null);
    // Extra loss: every claim whose issue is not a charge on the trip (lost time, a missed booking, other), plus the operator form.
    const lossClaims = (ticket?.issues ?? []).filter((i: any) => typeof i.claimed_amount === 'number' && !isCharge(i));
    additional_loss_cents = lossClaims.reduce((a: number, i: any) => a + (cents(i.claimed_amount) ?? 0), 0) + operatorForm;
  } else {
    // Version 2: every independent claim summed, minus the disputed charge, plus any amount the operator recorded on the explicit safety intake form.
    disputed = cents(trip?.cancellation_fee ?? ticket?.requested_remedy?.amount);
    const claimedSum = claimed.reduce((a: number, v: number) => a + (cents(v) ?? 0), 0);
    additional_loss_cents = Math.max(0, claimedSum - (disputed ?? 0)) + operatorForm;
  }
  const exposure = { fare_cents: cents(trip?.final_fare ?? trip?.quoted_fare), disputed_charge_cents: disputed, claimed_additional_cents: claimed.length ? Math.max(...claimed.map(cents)) : null, additional_loss_cents, unquantified_loss: /compensation|loss|reservation|lost .* hours|late for/i.test(String(ticket?.description ?? '') + String(ticket?.requested_remedy?.notes ?? '')) };
  return { version: v3 ? 3 : 2, route, urgency: route === 'urgent_safety' ? 'urgent' : route === 'safety_review' ? 'review' : 'none', exposure, flags,
    notice: 'Conservative intake screening, not a finding about either party. Quoted or negated language can require review; this English-language screen can miss paraphrases. Use the explicit safety form too. No suspension, emergency dispatch or payment is performed.' };
}

export const reviewUpdateSchema = z.object({ owner: z.string().trim().min(1).max(100), status: z.enum(['assigned', 'cleared_for_fare_review', 'referred_to_specialist']), note: z.string().trim().min(10).max(3000) }).strict();
