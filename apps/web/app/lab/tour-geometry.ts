// Where a phone's straight walkthrough arrow runs (tour.tsx): under the box's middle, within the stretch the card and the
// box share, up to 24px in from its ends (less when that stretch is narrow); none when they share no stretch (a narrow box at the screen's edge put the arrow just outside the card).
export function arrowX(cardLeft: number, cardRight: number, boxLeft: number, boxRight: number): number | null {
  const a = Math.max(cardLeft, boxLeft), b = Math.min(cardRight, boxRight);
  if (b - a < 2) return null;
  const inset = Math.min(24, (b - a) / 2);
  return Math.max(a + inset, Math.min(b - inset, (boxLeft + boxRight) / 2));
}
