/**
 * terrainZsite — client-side z_site DEM for the GPU drape lapse correction.
 *
 * Instead of a backend-served elevation archive, we fetch terrarium-encoded
 * WebP DEM tiles DIRECTLY from the configured terrain source (Mapterhorn by
 * default — see setTerrainTiles), decode
 * them, mosaic the covering tiles, and bilinear-resample the Web Mercator pixel
 * grid onto a regular lat/lon grid — the SAME `Window` shape `setLapse` already
 * consumes (from wxdata2's window decode). Highest resolution available, no
 * backend DEM serving.
 *
 * Everything except `fetchTerrariumZsite`'s fetch+bitmap wrapper is a pure
 * function over plain {width,height,data} / Float32Array inputs so the terrarium
 * math and the mercator→lat/lon resample are unit-testable without a browser
 * (node has no createImageBitmap).
 *
 * Terrarium encoding: meters = R*256 + G + B/256 − 32768 (0 m ⇒ R=128,G=0,B=0).
 */

import { PMTiles } from "pmtiles";
import type { Window } from "./wxdata2.ts";

/** Terrarium terrain source. The authoritative value comes from the
 *  backend config (grib-viewer.yaml `map.terrain`, defaulted server-side and
 *  served at /api/mapconfig; applied by main.tsx before the map
 *  mounts). The literals below are only the no-backend fallback
 *  (static-only hosting without the API). Two forms: a full tile URL
 *  template, or a terrarium-encoded `.pmtiles` archive read via HTTP
 *  range requests. `export let`: importers see the live binding. */
export let TERRARIUM_TILE_URL = "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp";
export let TERRARIUM_TILEJSON_URL = "https://tiles.mapterhorn.com/tilejson.json";

/** Non-null when map.terrain points at a .pmtiles archive: the sampler
 *  reads tile bytes through it instead of per-tile HTTP fetches. */
let terrainArchive: PMTiles | null = null;
/** Archive depth cap. XYZ servers (Mapterhorn) overzoom server-side and
 *  stay uncapped; an archive returns nothing past its maxZoom, which
 *  would read as an all-NoData mosaic at deep map zooms. */
let terrainMaxZoom: number | null = null;

export async function setTerrainTiles(template: string): Promise<void> {
  if (!template) return;
  if (template.toLowerCase().endsWith(".pmtiles")) {
    terrainArchive = new PMTiles(template);
    // MapLibre's raster-dem source reads the TileJSON (maxzoom, ©
    // attribution) through the registered pmtiles protocol.
    TERRARIUM_TILEJSON_URL = `pmtiles://${template}`;
    try {
      terrainMaxZoom = (await terrainArchive.getHeader()).maxZoom;
    } catch {
      // header unreadable now — deep zooms may NoData until it is
    }
    return;
  }
  TERRARIUM_TILE_URL = template;
  // The server's TileJSON (maxzoom, © attribution) is expected next to
  // the tiles: strip the /{z}/{x}/{y}.{ext} tail for the base URL.
  const base = template.replace(/\/\{z\}\/\{x\}\/\{y\}\.[a-z0-9]+$/i, "");
  if (base !== template) TERRARIUM_TILEJSON_URL = `${base}/tilejson.json`;
}

/** Decode one terrarium RGB triplet to meters. */
export function terrariumMeters(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

/** An ImageData-like decoded tile (RGBA, row-major). */
export interface RGBAImage {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

/** Decode a terrarium tile's RGBA pixels to a per-pixel meters Float32Array
 *  (row-major, width*height). Alpha is ignored. */
export function decodeTerrariumTile(img: RGBAImage): Float32Array {
  const n = img.width * img.height;
  const out = new Float32Array(n);
  const d = img.data;
  for (let i = 0; i < n; i++) {
    out[i] = terrariumMeters(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
  }
  return out;
}

/** Terrarium zoom for a MapLibre map zoom: ~1 DEM px per screen px, floored 0.
 *  No upper cap on XYZ servers — Mapterhorn overzooms server-side; a
 *  .pmtiles archive clamps to its header maxZoom (see setTerrainTiles). */
export function pickTerrariumZoom(mapZoom: number): number {
  const z = Math.round(mapZoom);
  if (z < 0) return 0;
  if (terrainMaxZoom != null && z > terrainMaxZoom) return terrainMaxZoom;
  return z;
}

// --- Web Mercator tile / pixel math (tile-index space is tileSize-independent) --

function lonToTile(lon: number, z: number): number {
  return ((lon + 180) / 360) * 2 ** z;
}

function latToTile(lat: number, z: number): number {
  const s = Math.sin((lat * Math.PI) / 180);
  const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  return y * 2 ** z;
}

export interface TileRange {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** Inclusive terrarium tile-index range covering a bbox at zoom z. y0 is the
 *  northern (smaller-y) edge. Indices clamp to [0, 2^z−1] (poles / antimeridian
 *  are clamped, not wrapped — viewport bboxes don't straddle them). */
export function tileRangeForBBox(
  west: number,
  south: number,
  east: number,
  north: number,
  z: number,
): TileRange {
  const n = 2 ** z;
  const clampT = (v: number) => Math.max(0, Math.min(n - 1, Math.floor(v)));
  return {
    x0: clampT(lonToTile(west, z)),
    x1: clampT(lonToTile(east, z)),
    y0: clampT(latToTile(north, z)),
    y1: clampT(latToTile(south, z)),
  };
}

const MAX_DIM = 1024;
const MAX_CELLS = 700000;

export interface GridSize {
  nx: number;
  ny: number;
}

/** Output grid dimensions: ~one cell per source mercator pixel across the bbox
 *  at the chosen zoom, each dim in [2, MAX_DIM] and total ≤ MAX_CELLS (avoids
 *  over-allocating a giant R32F texture on a wide zoomed-out view). */
export function chooseGrid(
  west: number,
  south: number,
  east: number,
  north: number,
  z: number,
  tileSize: number,
): GridSize {
  const spanX = (lonToTile(east, z) - lonToTile(west, z)) * tileSize;
  const spanY = (latToTile(south, z) - latToTile(north, z)) * tileSize;
  let nx = Math.max(2, Math.min(MAX_DIM, Math.round(spanX)));
  let ny = Math.max(2, Math.min(MAX_DIM, Math.round(spanY)));
  if (nx * ny > MAX_CELLS) {
    const s = Math.sqrt(MAX_CELLS / (nx * ny));
    nx = Math.max(2, Math.floor(nx * s));
    ny = Math.max(2, Math.floor(ny * s));
  }
  return { nx, ny };
}

export interface Mosaic {
  /** Global pixel origin (top-left) of the mosaic at the tile zoom. */
  originPx: number;
  originPy: number;
  width: number;
  height: number;
  /** Row-major meters over width*height; NaN for a missing tile's pixels. */
  meters: Float32Array;
}

/** Stitch a grid of decoded tiles (tiles[row][col], each tileSize*tileSize
 *  meters, or null for a tile that failed) into one mosaic. x0/y0 are the
 *  top-left tile indices. */
export function assembleMosaic(
  tiles: (Float32Array | null)[][],
  tileSize: number,
  x0: number,
  y0: number,
): Mosaic {
  const rows = tiles.length;
  const cols = tiles[0]?.length ?? 0;
  const width = cols * tileSize;
  const height = rows * tileSize;
  const meters = new Float32Array(width * height);
  meters.fill(NaN);
  for (let ry = 0; ry < rows; ry++) {
    for (let cx = 0; cx < cols; cx++) {
      const t = tiles[ry][cx];
      if (!t) continue;
      for (let py = 0; py < tileSize; py++) {
        const dstRow = (ry * tileSize + py) * width + cx * tileSize;
        const srcRow = py * tileSize;
        for (let px = 0; px < tileSize; px++) meters[dstRow + px] = t[srcRow + px];
      }
    }
  }
  return { originPx: x0 * tileSize, originPy: y0 * tileSize, width, height, meters };
}

// NaN-aware bilinear sample of the mosaic at (lx, ly) mosaic-local pixel coords.
function sampleBilinear(m: Mosaic, lx: number, ly: number): number {
  lx = Math.max(0, Math.min(m.width - 1, lx));
  ly = Math.max(0, Math.min(m.height - 1, ly));
  const x0 = Math.floor(lx);
  const y0 = Math.floor(ly);
  const x1 = Math.min(x0 + 1, m.width - 1);
  const y1 = Math.min(y0 + 1, m.height - 1);
  const fx = lx - x0;
  const fy = ly - y0;
  const v00 = m.meters[y0 * m.width + x0];
  const v10 = m.meters[y0 * m.width + x1];
  const v01 = m.meters[y1 * m.width + x0];
  const v11 = m.meters[y1 * m.width + x1];
  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;
  let acc = 0;
  let wsum = 0;
  if (!Number.isNaN(v00)) {
    acc += v00 * w00;
    wsum += w00;
  }
  if (!Number.isNaN(v10)) {
    acc += v10 * w10;
    wsum += w10;
  }
  if (!Number.isNaN(v01)) {
    acc += v01 * w01;
    wsum += w01;
  }
  if (!Number.isNaN(v11)) {
    acc += v11 * w11;
    wsum += w11;
  }
  return wsum > 0 ? acc / wsum : NaN;
}

const Z_NODATA = -32768;

/** Resample a mercator mosaic onto a regular lat/lon grid covering the bbox,
 *  producing the `Window` shape `setLapse` consumes (int16 meters, scale 1,
 *  offset 0, NaN → nodata). Each output row's mercator Y is computed per-row
 *  (mercator is nonlinear in latitude); bilinear in pixel space. */
export function resampleToWindow(
  m: Mosaic,
  z: number,
  tileSize: number,
  west: number,
  south: number,
  east: number,
  north: number,
  nx: number,
  ny: number,
): Window {
  const values = new Int16Array(nx * ny);
  const dlon = nx > 1 ? (east - west) / (nx - 1) : 0;
  const dlat = ny > 1 ? (south - north) / (ny - 1) : 0;
  // Precompute source global-px X per output column (independent of row).
  const colPx = new Float64Array(nx);
  for (let i = 0; i < nx; i++) {
    colPx[i] = lonToTile(west + dlon * i, z) * tileSize - m.originPx;
  }
  for (let j = 0; j < ny; j++) {
    const lat = north + dlat * j;
    const ly = latToTile(lat, z) * tileSize - m.originPy;
    for (let i = 0; i < nx; i++) {
      const v = sampleBilinear(m, colPx[i], ly);
      values[j * nx + i] = Number.isNaN(v) ? Z_NODATA : Math.round(v);
    }
  }
  return {
    model: "terrarium",
    variable: "z_site",
    grid: { nx, ny, lat0: north, lon0: west, dlat, dlon },
    values,
    scale: 1,
    offset: 0,
    nodata: Z_NODATA,
  };
}

// --- browser wrapper (fetch + WebP decode) ------------------------------

function tileURL(z: number, x: number, y: number): string {
  return TERRARIUM_TILE_URL.replace("{z}", String(z))
    .replace("{x}", String(x))
    .replace("{y}", String(y));
}

/** Tile bytes for (z, x, y) from whichever backend is configured:
 *  archive getZxy (undefined = sparse gap) or per-tile XYZ fetch
 *  (404 = sparse gap). null = coverage gap → NoData hole. */
async function fetchTileBlob(
  z: number,
  x: number,
  y: number,
  signal: AbortSignal,
): Promise<Blob | null> {
  if (terrainArchive) {
    const t = await terrainArchive.getZxy(z, x, y, signal);
    return t?.data ? new Blob([t.data]) : null;
  }
  const res = await fetch(tileURL(z, x, y), { signal });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`terrarium tile ${z}/${x}/${y}: ${res.status}`);
  return res.blob();
}

// Decode a WebP blob to RGBA pixels via createImageBitmap + a canvas. Prefers
// OffscreenCanvas (worker-safe, no DOM) and falls back to a detached <canvas>.
async function decodeWebP(blob: Blob): Promise<RGBAImage> {
  const bmp = await createImageBitmap(blob);
  const w = bmp.width;
  const h = bmp.height;
  let ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
  if (typeof OffscreenCanvas !== "undefined") {
    ctx = new OffscreenCanvas(w, h).getContext("2d") as OffscreenCanvasRenderingContext2D | null;
  } else {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    ctx = c.getContext("2d");
  }
  if (!ctx) throw new Error("terrainZsite: no 2d canvas context");
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  const id = ctx.getImageData(0, 0, w, h);
  return { width: w, height: h, data: id.data };
}

/** Fetch the terrarium DEM covering `bbox` ("south,west,north,east") at
 *  terrarium `zoom`, decode + mosaic + resample to a regular lat/lon `Window`
 *  (the z_site plane `setLapse` consumes). Rejects if any covering tile fails
 *  (the caller's latch counts consecutive failures) or the fetch is aborted.
 *  The tile pixel size is PROBED from the first decoded tile — never assume 256
 *  (the old globe code hardcoded 256 against 512-px tiles and silently failed). */
export async function fetchTerrariumZsite(
  bbox: string,
  zoom: number,
  signal: AbortSignal,
): Promise<Window> {
  const [south, west, north, east] = bbox.split(",").map(Number);
  const z = pickTerrariumZoom(zoom);
  const range = tileRangeForBBox(west, south, east, north, z);
  const cols = range.x1 - range.x0 + 1;
  const rows = range.y1 - range.y0 + 1;
  const n = 2 ** z;

  const grid: (Float32Array | null)[][] = Array.from({ length: rows }, () =>
    new Array<Float32Array | null>(cols).fill(null),
  );
  let tileSize = 0;

  let failed = 0;
  const jobs: Promise<void>[] = [];
  for (let ry = 0; ry < rows; ry++) {
    for (let cx = 0; cx < cols; cx++) {
      const tx = ((range.x0 + cx) % n + n) % n; // x wraps; y is clamped in range
      const ty = range.y0 + ry;
      jobs.push(
        (async () => {
          // The planet tileset is SPARSE: pure-ocean tiles are omitted
          // (404 / absent from the archive). A coverage gap is NoData
          // (assembleMosaic NaN-fills null cells → z_site NaN → lapse
          // corr 0, terrain lift 0 — sea level, correct), NOT a mosaic
          // failure — a US West Coast viewport always contains Pacific
          // tiles, and failing the whole mosaic killed lapse there.
          const blob = await fetchTileBlob(z, tx, ty, signal);
          if (!blob) return;
          const img = await decodeWebP(blob);
          if (!tileSize) tileSize = img.width; // probe once
          grid[ry][cx] = decodeTerrariumTile(img);
        })().catch((err) => {
          // One flaky tile among dozens must not fail the mosaic — a wide
          // viewport fetches 20–60 tiles and the caller's strike latch would
          // turn a couple of transient blips into lapse/terrain OFF for the
          // whole session. A failed tile is a NoData hole; only an abort or
          // EVERY tile failing (a real outage) rejects.
          if (signal.aborted) throw err;
          failed++;
        }),
      );
    }
  }
  await Promise.all(jobs);
  if (failed > 0 && failed === rows * cols) {
    throw new Error(`terrarium mosaic: all ${failed} tiles failed`);
  }
  // Every covering tile 404'd (a pure-ocean viewport): synthesize an all-NoData
  // window at the standard tile size — sea level everywhere, not a failure.
  if (!tileSize) tileSize = 512;

  const mosaic = assembleMosaic(grid, tileSize, range.x0, range.y0);
  const { nx, ny } = chooseGrid(west, south, east, north, z, tileSize);
  return resampleToWindow(mosaic, z, tileSize, west, south, east, north, nx, ny);
}
