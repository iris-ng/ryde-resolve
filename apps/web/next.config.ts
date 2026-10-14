import type { NextConfig } from "next";
import path from "node:path";
// The content security policy (12 October 2026): the site loads nothing from any other address, so a page may run, fetch, show
// and embed only this site's own files; no plugins, no form or base address elsewhere, and no other site may frame it. Inline
// scripts stay allowed: the App Router writes each page's data as inline scripts, and a nonce would need a proxy file and every
// page rendered per request. Development adds 'unsafe-eval' for the dev server's own reloading. No upgrade-insecure-requests:
// the operator reaches the site at http://localhost.
const csp = (frameAncestors: string) => [
  "default-src 'self'", `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "media-src 'self' blob:", "font-src 'self' data:",
  "connect-src 'self'", "worker-src 'self' blob:", "frame-src 'self'", "manifest-src 'self'", "object-src 'none'",
  "base-uri 'self'", "form-action 'self'", `frame-ancestors ${frameAncestors}`,
].join('; ');
const config: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.resolve(process.cwd()),
  poweredByHeader: false,
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "same-origin" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Content-Security-Policy", value: csp("'none'") }
      ]
    }, {
      // The library opens in the case page's library window (8 October), so its own pages, and only those, may be framed by
      // this site's pages. The later headers win over the DENY and frame-ancestors 'none' above.
      source: "/library/:path*",
      headers: [{ key: "X-Frame-Options", value: "SAMEORIGIN" }, { key: "Content-Security-Policy", value: csp("'self'") }]
    }, {
      // Operator pages must always reflect the deployed release; static chunks stay cacheable by hash.
      source: "/((?!_next/static|_next/image|favicon.ico|(?:otter|pango|fish|frog|rooster)/.+\\.png$|route-maps/\\d+/\\d+/\\d+\\.png$).*)",
      headers: [{ key: "Cache-Control", value: "no-store, must-revalidate" }]
    }, {
      // Character frames (.png only) change only with a release: the browser keeps them a day (private: no shared cache keeps a copy), then
      // asks again with its ETag. Without this every reload fetched every frame again (3 October).
      source: "/:character(otter|pango|fish|frog|rooster)/:frame(.+\\.png)",
      headers: [{ key: "Cache-Control", value: "private, max-age=86400" }]
    }, {
      // The street map behind the route drawing (evidence tabs, 10 October 2026): saved once, never changed in place, so kept a day too.
      source: "/route-maps/:zoom(\\d+)/:x(\\d+)/:y(\\d+\\.png)",
      headers: [{ key: "Cache-Control", value: "private, max-age=86400" }]
    }];
  }
};
export default config;
