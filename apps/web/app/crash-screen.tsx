'use client';
import { useEffect } from 'react';
import { runMessages } from '../../../packages/live-fishbowl/messages';

// Card 14 of the run failure messages (owner review, 8 October 2026): a screen that fails to draw (a malformed answer the
// checks did not foresee, or a bug) shows the owner's message and a way to try again, never Next.js's own "Application error"
// line on an empty page. Shared by error.tsx (a page fails) and global-error.tsx (the site's frame fails).
// `scope`: which boundary caught it (the page, or the site's frame), for tests and the console; the person sees the same message.
export default function CrashScreen({ error, reset, scope }: { error: Error & { digest?: string }; reset: () => void; scope: 'page' | 'site' }) {
  // The cause goes to the browser console for whoever debugs it; the person reads only the message.
  useEffect(() => { try { console.error(`[ryde-resolve] a ${scope} failed to draw:`, error?.digest ?? error?.message); } catch { /* nothing to log */ } }, [error, scope]);
  return <main role="alert" className="crash-screen" data-scope={scope} style={{ minHeight: '60vh', display: 'grid', placeItems: 'center', padding: '18vh 16px', textAlign: 'center', font: '17px/1.5 system-ui, sans-serif' }}>
    <div style={{ display: 'grid', gap: 16, justifyItems: 'center', maxWidth: '34rem' }}>
      <p style={{ margin: 0 }}>{runMessages.pageError}</p>
      <button type="button" onClick={() => reset()} style={{ font: 'inherit', padding: '8px 18px', borderRadius: 8, border: '1px solid currentColor', background: 'transparent', color: 'inherit', cursor: 'pointer' }}>Try again</button>
    </div>
  </main>;
}
