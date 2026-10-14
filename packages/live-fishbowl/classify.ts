import type { CasePacket } from '../agent-flow/contracts';
import { customCategories, type CustomCategory } from './cases';

// Detects the dispute type of a custom case from its uploaded documents, so the
// operator never picks it by hand. Deterministic keyword scoring over the
// documents' own words; the winning category selects the public rules that are
// pinned for the run. Safety wins on any hit because a safety allegation must
// route to a human reviewer before any merits work. Ties and empty
// workspaces fall back to 'other'. The result is a routing choice, not a
// finding about either party, and every fact still comes from the documents.
type Signal = { term: RegExp; weight: number };
const signals: Record<Exclude<CustomCategory, 'other'>, Signal[]> = {
  safety: [
    { term: /\b(harass\w*|assault\w*|threat\w*|injur(?:y|ies|ed)|dangerous(?:ly)? driv\w*|drove dangerously|reckless\w*|crash(?:ed|es)?|collision|accident|police report|unsafe|molest\w*|grop(?:e|ed|es|ing)|sexual\w*|indecent\w*|stalk(?:ed|er|ers|ing)?|rap(?:e|ed|es|ing)|touched me|followed me|following me|intoxicat\w*|drunk|weapon|abus\w*)\b/i, weight: 3 },
    { term: /\b(safety|felt unsafe|scared|afraid|frighten\w*|speeding|ran a red|swerv\w*)\b/i, weight: 2 },
    { term: /\b(safety_incident|dangerous_driving|harassment|accident_injury|identity_mismatch)\b/i, weight: 4 },
  ],
  cleaning: [
    { term: /\b(cleaning fee|cleaning charge|clean-?up|detailing|upholstery|vomit\w*|spill\w*|stain\w*|soil\w*|mess\b|odou?r|smell\w*|sand\b|mud\b|pet hair|damage[sd]? (?:to )?(?:the )?(?:seat|car|vehicle|interior)|property damage|repair (?:cost|bill|quote))\b/i, weight: 3 },
    { term: /\b(cleaning_fee|property_damage)\b/i, weight: 4 },
    { term: /\b(receipt|photo(?:graph)?s?|before and after|invoice)\b/i, weight: 1 },
  ],
  route_deviation: [
    { term: /\b(route deviation|detour\w*|longer route|wrong route|took the long way|went the wrong way|circuitous|erp\b|toll\w*|gantry|overcharg\w*|extra charge|additional charge|fare (?:was|is) (?:higher|more|wrong)|fare discrepancy|surge|promo(?:tion|tional)? code|voucher not applied|destination change|changed the destination|multi-?stop|extra stop|unexplained stop|fare breakdown|quoted fare|upfront fare|final fare)\b/i, weight: 3 },
    { term: /\b(route_deviation|fare_overcharge|erp_toll|surge_pricing|promo_code|destination_change|extra_charge|late_arrival|trip_not_taken|fare_evasion)\b/i, weight: 4 },
    { term: /\b(route|fare|distance|kilomet\w*|km\b|expressway|highway|traffic|navigation|gps route)\b/i, weight: 1 },
  ],
  no_show: [
    { term: /\b(no-?\s?show|no show fee|cancellation fee|cancel(?:led|lation) (?:by|fee|charge)|driver cancel\w*|rider cancel\w*|waiting (?:time|fee)|wait(?:ed|ing)? (?:for|at|over|more than)|pickup point|pick-?up (?:location|point|pin)|wrong pickup|couldn'?t find (?:the )?(?:driver|rider|car)|did not (?:show|turn) up|didn'?t (?:show|turn) up|never (?:arrived|showed|came)|i'?m here|arrived at pickup|grace period|late pickup)\b/i, weight: 3 },
    { term: /\b(no_show_charge|cancellation_fee|waiting_fee|driver_cancellation|late_pickup|rider_no_show)\b/i, weight: 4 },
    { term: /\b(pickup|pick-up|cancel\w*|wait\w*|arriv\w*|minutes late|meeting point|lobby|driveway|entrance)\b/i, weight: 1 },
  ],
};
export type CategoryDetection = { category: CustomCategory; scores: Record<Exclude<CustomCategory, 'other'>, number>; matches: { category: CustomCategory; sourceId: string; line: number; term: string }[]; documents: number };
/** Scores every uploaded document (never rule cards) and returns the best category with the lines that drove it. */
export function detectCategory(sources: Pick<CasePacket['sources'][number], 'id' | 'lines'>[]): CategoryDetection {
  const scores = { safety: 0, cleaning: 0, route_deviation: 0, no_show: 0 };
  const matches: CategoryDetection['matches'] = [];
  const documents = sources.filter(s => !s.id.startsWith('policy/') && !s.id.startsWith('derived/'));
  for (const source of documents) {
    for (let i = 0; i < source.lines.length; i++) {
      const line = source.lines[i];
      for (const category of Object.keys(signals) as (keyof typeof signals)[]) {
        for (const { term, weight } of signals[category]) {
          const found = line.match(term);
          if (!found) continue;
          scores[category] += weight;
          if (matches.length < 40) matches.push({ category, sourceId: source.id, line: i + 1, term: found[0].slice(0, 60) });
        }
      }
    }
  }
  const ranked = (Object.entries(scores) as [keyof typeof scores, number][]).sort((a, b) => b[1] - a[1]);
  let category: CustomCategory = 'other';
  if (scores.safety >= 3) category = 'safety';
  else if (ranked[0][1] > 0 && ranked[0][1] > ranked[1][1]) category = ranked[0][0];
  if (!(customCategories as readonly string[]).includes(category)) category = 'other';
  return { category, scores, matches, documents: documents.length };
}
export const categoryLabels: Record<CustomCategory, string> = { no_show: 'No-show or cancellation fee', route_deviation: 'Route, fare or toll', cleaning: 'Cleaning or damage', safety: 'Safety incident', other: 'Other dispute' };
