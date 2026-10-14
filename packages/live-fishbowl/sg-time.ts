// Times in the lab are Singapore times, labelled "SGT", whatever the viewer's own zone (4 October UI audit: the
// conversation used the viewer's clock and locale while the queue used Singapore's). A fixed zone and locale also make
// the server and the browser draw the same text. Dates are built from numeric parts, as in sla.ts, so September is
// "Sep" on every runtime (newer ICU data writes "Sept" for en-GB).
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const format = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Singapore', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const parts = (iso: string) => Object.fromEntries(format.formatToParts(new Date(iso)).map(p => [p.type, p.value]));

/** "14:55 SGT" */
export const sgClock = (iso: string) => { const t = parts(iso); return `${t.hour}:${t.minute} SGT`; };
/** "14:55:07 SGT" */
export const sgSeconds = (iso: string) => { const t = parts(iso); return `${t.hour}:${t.minute}:${t.second} SGT`; };
/** "4 Oct 2026" */
export const sgDate = (iso: string) => { const t = parts(iso); return `${Number(t.day)} ${months[Number(t.month) - 1]} ${t.year}`; };
/** "4 Oct 2026, 14:55 SGT" */
export const sgDateTime = (iso: string) => `${sgDate(iso)}, ${sgClock(iso)}`;
