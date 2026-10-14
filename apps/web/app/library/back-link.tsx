'use client';
import { useEffect, useState } from 'react';

const KEY = 'library-from';
// Back to the cases. The case page keeps the open case and run in its address, so the address the library was opened from
// is remembered for this tab and the link returns to it, even after reading several entries. Otherwise it opens the case page.
export default function BackLink() {
  const [href, setHref] = useState('/');
  useEffect(() => {
    try {
      const from = document.referrer ? new URL(document.referrer) : null;
      if (from && from.origin === location.origin && from.pathname === '/') sessionStorage.setItem(KEY, from.pathname + from.search);
      const saved = sessionStorage.getItem(KEY);
      if (saved?.startsWith('/?') || saved === '/') setHref(saved);
    } catch { /* storage blocked: the plain link still works */ }
  }, []);
  return <a className="lib-back" href={href}>Back to cases</a>;
}
