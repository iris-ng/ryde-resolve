// The street map behind the route drawing (evidence tabs, 10 October 2026). OpenStreetMap's standard map pictures (tiles),
// saved once per route case by evidence/tools/fetch-route-maps.mjs into apps/web/public/route-maps, listed in
// evidence/registers/route-maps.json, and served by this site: a page view never asks an outside map server. The maths is
// Web Mercator, as the tiles are drawn, so the script that picks the tiles and the drawing that places them agree.

export const TILE = 256;
export type MapPoint = { lat: number; lng: number };
/** The area the drawing shows, in world pixels at the map's zoom (x grows east, y grows south). */
export type MapFrame = { x0: number; y0: number; x1: number; y1: number };
export type TileRange = { x0: number; x1: number; y0: number; y1: number };
/** One case's saved map: the zoom, the area the drawing shows, and the tiles that cover it. */
export type RouteMap = { zoom: number; frame: MapFrame; tiles: TileRange };
export type RouteMapRegister = { version: number; source: string; attribution: string; licence: string; fetched_at: string; entries: Record<string, RouteMap> };

/** The drawing's width in its own units, and the height range it keeps (a flat route is not drawn as a sliver). */
export const drawingWidth = 320, drawingMinHeight = 150, drawingMaxHeight = 250;
const minZoom = 10, maxZoom = 17;
/** The widest the shown area may be at the chosen zoom, in tile pixels: twice the drawing's width, sharp on a double-density screen. */
const maxPixels = 640;
const earth = 40075016.686;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export const worldX = (lng: number, zoom: number) => (lng + 180) / 360 * TILE * 2 ** zoom;
export function worldY(lat: number, zoom: number) {
  const r = Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * TILE * 2 ** zoom;
}
/** Ground metres in one world pixel at this latitude and zoom. */
export const metresPerPixel = (lat: number, zoom: number) => earth * Math.cos(lat * Math.PI / 180) / (TILE * 2 ** zoom);
/** The latitude at a world pixel row, for the scale bar at the middle of the shown area. */
export const latitudeAt = (y: number, zoom: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / (TILE * 2 ** zoom)))) * 180 / Math.PI;

/**
 * The area to draw around these points, and the zoom to draw it at. A margin of an eighth of the larger side and at least
 * 200 m goes round the points; then the short side grows until the shape fits the drawing's height range, centred. The
 * zoom is the closest one at which the area is at most twice the drawing's width in tile pixels. With `zoom` given (a
 * drawing with no saved map), the area is worked out at that zoom instead. Null with no usable point.
 */
export function routeMapFrame(points: MapPoint[], zoom?: number): { zoom: number; frame: MapFrame } | null {
  const usable = points.filter(p => finite(p?.lat) && finite(p?.lng) && Math.abs(p.lat) <= 85 && Math.abs(p.lng) <= 180);
  if (!usable.length) return null;
  const xs = usable.map(p => worldX(p.lng, 0)), ys = usable.map(p => worldY(p.lat, 0));
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const lat = latitudeAt((minY + maxY) / 2, 0);
  const pad = Math.max(Math.max(maxX - minX, maxY - minY) / 8, 200 / metresPerPixel(lat, 0));
  let w = maxX - minX + 2 * pad, h = maxY - minY + 2 * pad;
  if (h / w > drawingMaxHeight / drawingWidth) w = h * drawingWidth / drawingMaxHeight;
  if (h / w < drawingMinHeight / drawingWidth) h = w * drawingMinHeight / drawingWidth;
  let z = zoom;
  if (z === undefined) { z = minZoom; while (z < maxZoom && w * 2 ** (z + 1) <= maxPixels) z++; }
  const k = 2 ** z, cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  return { zoom: z, frame: { x0: (cx - w / 2) * k, y0: (cy - h / 2) * k, x1: (cx + w / 2) * k, y1: (cy + h / 2) * k } };
}

/** The tiles that cover an area, by their numbers at the area's zoom. */
export const tilesFor = (frame: MapFrame): TileRange => ({ x0: Math.floor(frame.x0 / TILE), x1: Math.floor(frame.x1 / TILE), y0: Math.floor(frame.y0 / TILE), y1: Math.floor(frame.y1 / TILE) });
export const tilePath = (zoom: number, x: number, y: number) => `/route-maps/${zoom}/${x}/${y}.png`;

/** A saved map read from the register, its shape checked: the page never trusts a shape it reads. */
export function savedMap(value: unknown): RouteMap | null {
  const m = value as RouteMap | null;
  const f = m?.frame, t = m?.tiles;
  if (!m || !Number.isInteger(m.zoom) || m.zoom < minZoom || m.zoom > maxZoom || !f || !t) return null;
  if (![f.x0, f.y0, f.x1, f.y1].every(finite) || f.x1 <= f.x0 || f.y1 <= f.y0) return null;
  if (![t.x0, t.x1, t.y0, t.y1].every(n => Number.isInteger(n)) || t.x1 < t.x0 || t.y1 < t.y0 || (t.x1 - t.x0 + 1) * (t.y1 - t.y0 + 1) > 64) return null;
  // The area lies on the map, and the tiles are exactly the ones that cover it (tiles beside the area would
  // claim a street map while showing none).
  const world = TILE * 2 ** m.zoom, cover = tilesFor(f);
  if (f.x0 < 0 || f.y0 < 0 || f.x1 > world || f.y1 > world || cover.x0 !== t.x0 || cover.x1 !== t.x1 || cover.y0 !== t.y0 || cover.y1 !== t.y1) return null;
  return m;
}
/** True when every point lies inside the saved area: a map saved for other ground (a custom case reusing an ID) is not used. */
export const mapHolds = (map: RouteMap, points: MapPoint[]) => points.every(p => {
  const x = worldX(p.lng, map.zoom), y = worldY(p.lat, map.zoom);
  return x >= map.frame.x0 && x <= map.frame.x1 && y >= map.frame.y0 && y <= map.frame.y1;
});
