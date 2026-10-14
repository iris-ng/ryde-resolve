// Keyword search for the case picker. Every word must appear; case, spaces and punctuation are ignored,
// so "no show", "no-show" and "noshow" all match "No-show".
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
/** Starred cases first (4 October, user request), the most recently starred on top; the rest keep the order given. */
export function starredFirst<T extends { starred_at?: string | null }>(rows: T[]): T[] {
  const starred = rows.filter(r => r.starred_at).sort((a, b) => Date.parse(b.starred_at!) - Date.parse(a.starred_at!));
  return [...starred, ...rows.filter(r => !r.starred_at)];
}
export function searchCases<T>(rows: T[], query: string, text: (row: T) => string): T[] {
  const words = query.split(/\s+/).map(squash).filter(Boolean);
  if (!words.length) return rows;
  return rows.filter(row => { const haystack = squash(text(row)); return words.every(w => haystack.includes(w)); });
}
