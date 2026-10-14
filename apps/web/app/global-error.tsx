'use client';
import CrashScreen from './crash-screen';
// The site's own frame failing (card 14, 8 October 2026): it replaces the root layout, so it brings its own html and body.
export default function GlobalError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1" /><meta name="color-scheme" content="light dark" /><title>Ryde Resolve</title></head><body style={{ margin: 0 }}><CrashScreen {...props} scope="site" /></body></html>;
}
