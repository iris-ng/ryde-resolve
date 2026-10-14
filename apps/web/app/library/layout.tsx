import type { Metadata } from 'next';
import BackLink from './back-link';
import './library.css';

export const metadata: Metadata = { title: 'Library · Ryde Resolve' };
// The reference library's frame: the site's name, where you are, and the way back to the case that was open.
// Inside the case page's library window (a frame), the library drops its own bar and Escape closes the window, unless the
// page used it first (closing the side pane). Set before the first paint, like the theme, so the bar never flashes.
const framed = `try{if(window.self!==window.top){document.documentElement.dataset.embedded='1';addEventListener('keydown',function(e){if(e.key==='Escape')setTimeout(function(){if(!e.defaultPrevented)parent.postMessage('library-close',location.origin)})})}}catch(e){}`;
export default function LibraryLayout({ children }: { children: React.ReactNode }) {
  return <div className="lib">
    <script dangerouslySetInnerHTML={{ __html: framed }} />
    <header className="lib-bar"><a className="lib-bar-home" href="/">Ryde Resolve</a><a className="lib-bar-here" href="/library">Library</a><BackLink /></header>
    {children}
  </div>;
}
