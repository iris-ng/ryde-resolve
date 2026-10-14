import { z } from 'zod';

// The content security policy (next.config.ts, 12 October 2026) refuses eval. Zod probes for it once, with Function(''), to
// speed up object parsing, catches the refusal and falls back; the browser still logs the refusal as an error. Turning that
// speed-up off in the browser skips the probe. Schemas read the setting when they are built, so each client page imports this
// module first. The server keeps the faster path.
if (typeof window !== 'undefined') z.config({ jitless: true });
