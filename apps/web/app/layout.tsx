import type { Metadata } from "next";
import "./styles.css";
export const metadata: Metadata = {
  title: "Ryde Resolve",
  description: "An inspectable dispute-resolution scaffold using synthetic cases and simulated agents.",
  // Kept out of search engines on both addresses (owner, 11 October 2026); the public copy's proxy also says so in a header.
  robots: { index: false, follow: false }
};
// Applies the theme and animations chips' saved choices before first paint, so the page does not flash the other theme
// or start motion the viewer turned off. A page already open follows a change made in another tab, or by the case page
// around the library's window (user, 8 October: the library keeps the main site's mode); the browser tells every other
// page of the site when the saved choice changes. A page the browser brings back from memory on Back or Forward missed
// that news and runs no script on its way back, so it reads the saved choice again when shown (Safari, 8 October). Storage
// blocked at any of these moments leaves the page as it is.
const theme = `try{var d=document.documentElement,apply=function(){try{var t=localStorage.getItem('lab-theme'),m=localStorage.getItem('lab-motion');if(t==='light'||t==='dark')d.dataset.theme=t;else delete d.dataset.theme;if(m==='full'||m==='reduce')d.dataset.motion=m;else delete d.dataset.motion}catch(e){}};apply();addEventListener('storage',function(e){if(e.key===null||e.key==='lab-theme'||e.key==='lab-motion')apply()});addEventListener('pageshow',function(e){if(e.persisted)apply()})}catch(e){}`;
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: theme }} /></head><body>{children}</body></html>;
}
