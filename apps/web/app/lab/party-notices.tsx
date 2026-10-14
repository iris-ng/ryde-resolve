'use client';
import { useMemo, useState } from 'react';
import { partyNotices, pastRulingFinding, type NoticeParty } from '../../../../packages/live-fishbowl/notice';

const human = (s: string) => s.replaceAll('_', ' ');

// The rider and driver notices for a decision, in the case summary (moved from the Status column, 3 October). They come
// from the run's own pinned packet, not the workspace's current one.
export default function PartyNotices({ decision, packet }: { decision: any; packet: Parameters<typeof partyNotices>[1] | undefined }) {
  const notices = useMemo(() => decision && packet ? partyNotices(decision, packet) : null, [decision, packet]);
  const [party, setParty] = useState<NoticeParty>('rider');
  const notice = notices?.[party];
  if (!notice) return null;
  return <section className="lab-party-notices" aria-labelledby="party-notices-heading">
    <h3 id="party-notices-heading">Notices</h3>
    <div className="lab-notice-tabs" role="group" aria-label="Notice recipient">
      {(['rider', 'driver'] as const).map(p => <button key={p} type="button" aria-pressed={party === p} onClick={() => setParty(p)}>{p === 'rider' ? 'Rider' : 'Driver'}</button>)}
    </div>
    <article className="lab-party-notice">
      <h4>{notice.headline}</h4>
      <p className="lab-notice-explanation">{notice.explanation}</p>
      <div className="lab-notice-meaning"><b>What this means for you</b><p>{notice.forYou}</p></div>
      {notice.readings.length > 0 && <p className="lab-notice-readings">This rests on team readings, not Ryde policy: {notice.readings.join('; ')}.</p>}
      <p className="lab-notice-status">{notice.status}</p>
      <a href={notice.appeal.href}>{notice.appeal.text}</a>
      {notice.privacy.findings.length > 0 && <p className="lab-notice-warning">Held: the shared text mentions the other party&apos;s private data ({[...new Set(notice.privacy.findings.map(finding => human(finding.field.split('.').at(-1) ?? finding.field)))].join(', ')}). A person must edit it before it is sent.</p>}
      {notice.editorial.findings.some(f => f.kind === 'past_ruling') && <p className="lab-notice-warning lab-notice-editorial">Held: {pastRulingFinding} (&ldquo;{notice.editorial.findings.find(f => f.kind === 'past_ruling')!.excerpt}&rdquo;). A person must edit it before it is sent.</p>}
      {notice.editorial.findings.some(f => f.kind !== 'past_ruling') && <p className="lab-notice-warning lab-notice-editorial">Held: the shared text {[...new Set(notice.editorial.findings.filter(f => f.kind !== 'past_ruling').map(f => f.kind === 'statistic' ? 'states a statistic' : 'promises a payment or a deadline'))].join(' and ')} (&ldquo;{notice.editorial.findings.find(f => f.kind !== 'past_ruling')!.excerpt}&rdquo;). A person must edit it before it is sent.</p>}
    </article>
  </section>;
}
