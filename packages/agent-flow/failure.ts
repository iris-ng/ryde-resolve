// Fixed failure categories for logs and reviewer-visible events. Provider and harness error text can quote a prompt,
// case content or a credential, so it is never stored or shown: only one of these labels, chosen from the text, is.
// (Run f631ba3c lost a panel seat to "429 Credits exhausted" and the event trail showed nothing a person could act on.)
export const failureCategories = ['credits exhausted', 'rate limited', 'authentication', 'moderation or guardrail', 'context too long', 'reasoning replay missing', 'timeout', 'model not available', 'turn limit', 'cancelled', 'provider error', 'other'] as const;
export type FailureCategory = typeof failureCategories[number];
const rules: [RegExp, FailureCategory][] = [
  [/credit|insufficient (funds|balance|quota)|quota exceeded|payment required|\b402\b/i, 'credits exhausted'],
  [/reasoning[_ ]?(content|details)?[^.]{0,60}(missing|required|must be)/i, 'reasoning replay missing'],
  [/rate.?limit|too many requests|\b429\b/i, 'rate limited'],
  [/unauthori[sz]ed|invalid (api )?key|incorrect api key|credentials|\b401\b/i, 'authentication'],
  [/moderat|flagged|guardrail|content.?(policy|filter)|safety system|\b403\b/i, 'moderation or guardrail'],
  [/context.?(length|window)|maximum context|too many tokens|prompt is too long/i, 'context too long'],
  [/timed? ?out|deadline|\b504\b|\b408\b/i, 'timeout'],
  [/model[^.]{0,40}(not found|not allowed|unavailable|does not exist|not supported)|no endpoints found|\b404\b/i, 'model not available'],
  [/max(imum)? (number of )?turns|turn limit/i, 'turn limit'],
  [/cancel|abort|interrupted/i, 'cancelled'],
  [/\b5\d\d\b|provider returned error|upstream|bad gateway|overloaded|internal server error/i, 'provider error'],
];
/** One fixed label for an error text. Never returns any of the text itself. */
export function failureCategory(text: unknown): FailureCategory {
  const value = String(text instanceof Error ? text.message : text ?? '');
  if (!value.trim()) return 'other';
  for (const [pattern, category] of rules) if (pattern.test(value)) return category;
  return 'other';
}
/**
 * The label a role already reported for its failure, read back exactly: role.ts writes "Harness
 * stopped: <reason> (<label>[, status NNN])" and the role child's error ends "Cause: <label>[, status NNN].". Guessing again from
 * those words loses labels such as "provider error" or "model not available", which carry no status code.
 */
export function reportedFailure(message: unknown): FailureCategory {
  const text = String(message instanceof Error ? message.message : message ?? '');
  const labels = failureCategories as readonly string[];
  for (const pattern of [/\(([^(),]+)(?:, status \d{3})?\)\s*$/, /Cause: ([^,.]+)(?:, status \d{3})?\.?\s*$/]) {
    const label = pattern.exec(text)?.[1]?.trim();
    if (label && labels.includes(label)) return label as FailureCategory;
  }
  const reason = /^Harness stopped: ([^(]+?)(?: \(|$)/.exec(text)?.[1]?.trim();
  if (reason === 'turn limit' || reason === 'authentication') return reason;
  return failureCategory(text);
}
