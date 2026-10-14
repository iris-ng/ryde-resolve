'use client';
import CrashScreen from './crash-screen';
// A page that fails to draw (card 14, 8 October 2026). The site's frame stays; the page shows the owner's message.
export default function PageError(props: { error: Error & { digest?: string }; reset: () => void }) { return <CrashScreen {...props} scope="page" />; }
