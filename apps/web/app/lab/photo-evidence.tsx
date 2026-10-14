'use client';
import { useEffect, useState } from 'react';
import type { PhotoRef } from '../../../../packages/agent-flow/contracts';
import { isFileAnswer, reach } from './answer';

// Photos in cleaning claims (spec Part 4, revision 12): each pinned photo with the model reading's boxes. The pinned
// metadata (hash, size, type) and the model reading are labelled separately; the reading is appearance only, never a finding.
type Box = { x: number; y: number; w: number; h: number };
type Observation = { kind: string; value: string; region: 'whole' | Box; visibility: string };
type Reading = { photoId: string; status: string; observations: Observation[]; cannotDetermine: string[] };
const kindLabels: Record<string, string> = { mess_visible: 'Mess', extent: 'Extent', location_in_cabin: 'Where', plate_visible: 'Plate in view', plate_text: 'Plate reads', mark_visible: 'Mark', same_scene_as: 'Same scene as' };
const words = (value: string) => value.replace(/_/g, ' ');
const unit = (n: unknown) => typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
const percent = (n: number) => `${(n * 100).toFixed(2)}%`;
const statusText: Record<string, string> = { examined: 'read', unclear: 'unclear: a person reviews this photo', unavailable: 'unavailable: a person reviews this photo' };
export type PhotoCard = { photoId: string; sha256: string; meta: string; status: string; boxes: { n: number; label: string; left: string; top: string; width: string; height: string }[]; items: { n: number; text: string; boxed: boolean }[]; cannotDetermine: string };
/** Pure view model: what each photo card shows. A reading is taken from events, so its shape is checked, not trusted. */
export function photoCards(photos: PhotoRef[], reading: unknown): PhotoCard[] {
  const read = (reading as { photos?: unknown } | undefined)?.photos;
  const readings = Array.isArray(read) ? read as Reading[] : [];
  return photos.map(photo => {
    const r = readings.find(x => x?.photoId === photo.photoId), observations = Array.isArray(r?.observations) ? r!.observations : [];
    const items = observations.map((o, i) => ({ n: i + 1, boxed: typeof o.region === 'object' && o.region !== null, text: `${kindLabels[o.kind] ?? words(String(o.kind))}: ${words(String(o.value))} (${o.visibility}${o.region === 'whole' ? ', whole photo' : ''})` }));
    const boxes = observations.flatMap((o, i) => typeof o.region === 'object' && o.region !== null ? [{ n: i + 1, label: kindLabels[o.kind] ?? words(String(o.kind)), left: percent(unit(o.region.x)), top: percent(unit(o.region.y)), width: percent(Math.min(unit(o.region.w), 1 - unit(o.region.x))), height: percent(Math.min(unit(o.region.h), 1 - unit(o.region.y))) }] : []);
    return {
      photoId: photo.photoId, sha256: photo.sha256,
      meta: `${photo.mediaType === 'image/png' ? 'PNG' : 'JPEG'} · ${Math.round(photo.bytes / 1024).toLocaleString('en-US')} KB · sha256 ${photo.sha256.slice(0, 12)}…`,
      status: !r ? 'not read yet' : statusText[r.status] ?? words(String(r.status)),
      boxes, items, cannotDetermine: Array.isArray(r?.cannotDetermine) ? r!.cannotDetermine.map(k => kindLabels[k] ?? words(k)).join(', ') : '',
    };
  });
}

// The lab keeps the operator token in session storage (use-lab.ts); a site session sends none and the proxy adds it.
const TOKEN_KEY = 'live-fishbowl-token';
/** The photo is served only as pinned on this run (or on the workspace's case before a run), never by hash alone. */
function usePhotoSource(photoId: string, sha256: string, workspaceId?: string, runId?: string) {
  const [state, setState] = useState<{ src: string | null; failed: boolean }>({ src: null, failed: false });
  useEffect(() => {
    let alive = true, url = '', token = '';
    try { token = sessionStorage.getItem(TOKEN_KEY) ?? ''; } catch { /* storage blocked: rely on the site session */ }
    setState({ src: null, failed: false });
    if (!workspaceId) { setState({ src: null, failed: true }); return () => { alive = false; }; }
    const scope = `&workspace=${encodeURIComponent(workspaceId)}` + (runId ? `&run=${encodeURIComponent(runId)}` : '');
    // With a deadline, so a photo that never arrives says it could not be loaded instead of waiting (lab/answer.ts).
    reach(`/api/live-fishbowl?photo=${encodeURIComponent(photoId)}&sha256=${encodeURIComponent(sha256)}${scope}`, { cache: 'no-store', headers: token ? { Authorization: 'Bearer ' + token } : {} })
      .then(r => isFileAnswer(r) ? r.blob() : Promise.reject(new Error('HTTP ' + r.status)))
      .then(blob => { if (!alive) return; url = URL.createObjectURL(blob); setState({ src: url, failed: false }); })
      .catch(() => { if (alive) setState({ src: null, failed: true }); });
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [photoId, sha256, workspaceId, runId]);
  return state;
}

const chip = { display: 'inline-block', padding: '1px 7px', borderRadius: 999, border: '1px solid var(--accent-line, var(--line))', color: 'var(--accent, var(--ink))', fontSize: 'var(--fs-small)', fontWeight: 600, letterSpacing: '.02em' };
function Photo({ card, workspaceId, runId }: { card: PhotoCard; workspaceId?: string; runId?: string }) {
  const { src: loaded, failed: refused } = usePhotoSource(card.photoId, card.sha256, workspaceId, runId);
  // Bytes that arrive but do not display as an image read as a photo that could not be loaded, never a broken picture.
  const [broken, setBroken] = useState(''), src = loaded && broken !== loaded ? loaded : null, failed = refused || (!!loaded && broken === loaded);
  return <figure data-photo={card.photoId} style={{ margin: '0 0 14px', border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden', background: 'var(--surface, transparent)' }}>
    <div style={{ position: 'relative', lineHeight: 0, background: 'var(--sunken, #111)' }}>
      {src ? <img src={src} alt={`Photo ${card.photoId} as submitted`} onError={() => setBroken(src)} style={{ display: 'block', width: '100%', height: 'auto' }} />
        : <div style={{ aspectRatio: '4 / 3', display: 'grid', placeItems: 'center', color: 'var(--muted)', fontSize: 'var(--fs-small)', lineHeight: 1.4 }}>{failed ? 'Photo could not be loaded' : 'Loading photo…'}</div>}
      {src && card.boxes.map(b => <span key={b.n} aria-label={`model reading box ${b.n}: ${b.label}`} style={{ position: 'absolute', left: b.left, top: b.top, width: b.width, height: b.height, border: '2px solid #ffc629', borderRadius: 3, boxShadow: '0 0 0 1px rgba(0,0,0,.55)', pointerEvents: 'none' }}>
        <b style={{ position: 'absolute', left: -2, top: -2, background: '#ffc629', color: '#1b1b1b', fontSize: 11, lineHeight: '16px', padding: '0 5px', borderRadius: '3px 0 3px 0' }}>{b.n}</b>
      </span>)}
      {src && card.boxes.length > 0 && <span style={{ ...chip, position: 'absolute', right: 8, top: 8, lineHeight: '16px', background: 'rgba(0,0,0,.6)', color: '#fff', borderColor: 'rgba(255,255,255,.5)' }}>model reading</span>}
    </div>
    <figcaption style={{ padding: '8px 10px', fontSize: 'var(--fs-small)', lineHeight: 1.45 }}>
      <div><b>{card.photoId}</b> <small style={{ color: 'var(--muted)' }}>Pinned file: {card.meta}</small></div>
      <div style={{ marginTop: 6 }}><span style={chip}>model reading</span> <span style={{ color: 'var(--muted)' }}>{card.status}</span></div>
      {card.items.length > 0 && <ol style={{ margin: '6px 0 0', paddingLeft: 20 }}>{card.items.map(i => <li key={i.n} value={i.n}>{i.text}{i.boxed ? ' · boxed' : ''}</li>)}</ol>}
      {card.cannotDetermine && <p style={{ margin: '6px 0 0', color: 'var(--muted)' }}>Cannot tell from this photo: {card.cannotDetermine}</p>}
    </figcaption>
  </figure>;
}

export default function PhotoEvidence({ photos, reading, workspaceId, runId }: { photos?: PhotoRef[]; reading?: unknown; workspaceId?: string; runId?: string }) {
  if (!photos?.length) return null;
  const cards = photoCards(photos, reading);
  return <section aria-label="Photos" style={{ marginBottom: 16 }}>
    <h2 style={{ fontSize: 'var(--fs-body)', margin: '0 0 4px' }}>Photos</h2>
    <p style={{ margin: '0 0 10px', fontSize: 'var(--fs-small)', color: 'var(--muted)' }}>The boxes and notes are a model reading of appearance only, not a finding. The photo's time and place are the uploader's claim.</p>
    {cards.map(card => <Photo key={card.photoId} card={card} workspaceId={workspaceId} runId={runId} />)}
  </section>;
}
