'use client';
import { useEffect, useState } from 'react';
import type { TargetView } from '../../../../packages/live-fishbowl/sla';

/** The current time for wording that counts down ("in 45 min"), refreshed every `ms` while set; 0 holds it still. */
export function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { setNow(Date.now()); if (!ms) return; const id = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(id); }, [ms]);
  return now;
}

// A case's response-time target (sla.ts) in the case summary and the safety screen: its priority (who picked it up, once
// someone has), and the target it comes from, marked as the team's assumption.
export default function SlaLine({ view }: { view: TargetView }) {
  return <div className={`lab-sla tone-${view.tone} sla-${view.state}`}><p><b>{view.label} priority{view.stake ? ` · ${view.stake}` : ''}{view.when ? ` · ${view.when}` : ''}.</b></p><p className="lab-sla-rule">{view.rule}</p></div>;
}
