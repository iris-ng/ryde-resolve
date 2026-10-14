import type { CasePacket } from '../agent-flow/contracts';

export type TimelineEntry = { sourceId: string; sourceHash: string; startLine: number; endLine: number; recordedTime: string; originalEntry: string };
// A source index, never an assessment. No generated meaning, credibility or conclusion.
export function evidenceTimeline(packet: Pick<CasePacket, 'sources'>): TimelineEntry[] {
  return packet.sources.flatMap(source => source.lines.flatMap((line, index) => {
    const times = line.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\b/g) ?? [];
    return [...new Set(times)].filter(time => Number.isFinite(Date.parse(time))).map(recordedTime => ({
      sourceId: source.id, sourceHash: source.sha256, startLine: index + 1, endLine: index + 1, recordedTime, originalEntry: line,
    }));
  })).sort((a, b) => Date.parse(a.recordedTime) - Date.parse(b.recordedTime) || a.sourceId.localeCompare(b.sourceId) || a.startLine - b.startLine);
}
