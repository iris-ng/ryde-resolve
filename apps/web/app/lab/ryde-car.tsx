import type { SVGProps } from 'react';

// The Ryde Resolve mark (user request, 7 October): a small Ryde-pink car with a tick on its door, facing right. The
// walkthrough's opening drives it across the screen (tour.css); app/icon.svg is the same car on a pink tile for the
// browser tab. Colours come from --car-* settings (tour.css) with fallbacks, so it also draws outside the lab. The wheels
// are groups of their own so they can turn, and the speed lines behind the car show only while it moves.
const wheel = (cx: number) => <g className="lab-car-wheel">
  <circle cx={cx} cy={26} r={5.2} fill="var(--car-tyre, #26262b)" stroke="var(--car-gap, #fff)" strokeWidth={1.6} />
  <circle cx={cx} cy={26} r={2.2} fill="var(--car-hub, #d9d9de)" />
  <path d={`M${cx - 2.2} 26h4.4M${cx} 23.8v4.4`} stroke="var(--car-tyre, #26262b)" strokeWidth={0.9} />
</g>;
export default function RydeCar(props: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 64 31.5" overflow="visible" aria-hidden="true" {...props}>
    <g className="lab-car-speed" stroke="var(--car-speed, #e93864)" strokeWidth={1.8} strokeLinecap="round" opacity={0}>
      <path d="M-15 12h9M-19 18h12M-13 24h8" />
    </g>
    <path fill="var(--car-body, #e93864)" d="M7 26C4.8 26 3.5 24.6 3.5 22.6V18.6C3.5 16.6 4.8 15.2 6.8 14.9L14.5 13.6 20.2 7.6C21.4 6.3 23 5.6 24.8 5.6H37.6C39.6 5.6 41.4 6.5 42.6 8.1L47.2 13.6 55.4 15C58.5 15.5 60.5 17.6 60.5 20.4V23C60.5 24.7 59.2 26 57.5 26Z" />
    <path fill="var(--car-glass, #ffe3eb)" d="M17.6 13.4 22.2 8.6C22.9 7.9 23.8 7.5 24.8 7.5H30.6V13.4ZM33 7.5H37.6C39 7.5 40.2 8.1 41 9.2L44.3 13.4H33Z" />
    <rect x={57.2} y={17.2} width={3} height={2.2} rx={1} fill="#ffe08a" />
    <rect x={3.5} y={17} width={2} height={2.6} rx={0.8} fill="#8a1538" />
    <path d="M33.6 19.4l2.2 2.2 4.4-4.4" fill="none" stroke="#fff" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
    {wheel(17)}{wheel(48)}
  </svg>;
}
