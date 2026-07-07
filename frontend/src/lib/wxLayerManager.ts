/**
 * wxLayerManager — orchestrates N stacked GPU drapes (one WxV2Layer per
 * visible tiles/contour layer) on a MapLibre map. It owns the viewport
 * (moveend, debounced) + active-frame fetch loop, decodes the `/api/.../data`
 * protobuf Window, and keeps each layer's mode / opacity / colormap / range /
 * contour in sync.
 *
 * Data plane: ONE `/data` request per (layer/draw-unit, viewport, frame) with
 * the padded + quantized viewport bbox and a `maxcells` cell budget (the
 * server picks the pyramid level). A globe view showing a pole issues one
 * extra polar-band bbox request per visible pole; stitchWindows composes the
 * main window + bands. No tile stitching, no client pyramid math.
 *
 * Value mode (sparse GeoJSON points) is NOT handled here — WeatherMapV2 owns
 * that as a plain MapLibre symbol layer.
 */
import type { Map as MaplibreMap, CustomLayerInterface } from "maplibre-gl";
import { WxV2Layer } from "./wxLayer2.ts";
import { GpuFlowLayer } from "./gpuFlowLayer.ts";
import { windowsToFlowField } from "./flowLines.ts";
import { decodeChunk, stitchWindows, type Window, type Chunk } from "./wxdata2.ts";
import { fetchTerrariumZsite, pickTerrariumZoom } from "./terrainZsite.ts";
import { recordStart, recordDone } from "./chunkStats.ts";
import { colormapStops, rampForLayer, isLogColormap } from "./wxColormap2.ts";
import { dataRange, contourInterval } from "./contourScale.ts";
import {
  fetchV2Meta,
  fetchV2Composite,
  v2DataUrl,
  v2DataChunkUrl,
  framesInSpan,
  type V2VarMeta,
  type V2Composite,
} from "../api/v2client.ts";
import { isCompositeModel } from "../api/types.ts";
import { isLapseVar, LAPSE_GAMMA, lapseGateKey } from "../api/mapConfig.ts";
import { FRONT_ANCHOR_KEY } from "./basemapStyle.ts";
import { nearestTimestepIndex } from "../time.ts";

/** Composite feather band (km) applied inside each finer contributor's
 *  footprint, so seams between contributors blend smoothly. */
const COMPOSITE_FEATHER_KM = 50;
// Consecutive terrarium-DEM fetch failures before the lapse feature latches off
// for the session (transient tile-server 404s / network blips shouldn't kill it).
const DEM_MAX_STRIKES = 3;

/** Poleward edge of Web-Mercator rendering — a globe viewport reaching past
 *  it fetches the missing polar band as a second bbox request per pole. */
const MERC_LAT_MAX = 85.0511;

/** Viewport padding fraction per side (flat projection) so small pans stay
 *  inside the fetched window. */
const VIEW_PAD = 0.15;
/** moveend → refetch debounce. The bbox changes with every pan (the price of
 *  bbox windows); the debounce + quantized cache keys keep it smooth. */
const MOVE_DEBOUNCE_MS = 150;
/** Base per-request cell budget (multiplied by dpr² and the HDR toggle). */
const MAXCELLS_BASE = 700_000;

/** Quantize an outward-rounded bbox coordinate to 2 decimals so tiny pans
 *  reuse the cache (the quantized bbox is both the request bbox and the
 *  cache key). `dir` +1 rounds up, −1 rounds down. */
export function quantizeCoord(v: number, dir: 1 | -1): number {
  const q = dir > 0 ? Math.ceil(v * 100) / 100 : Math.floor(v * 100) / 100;
  // Avoid -0 (string "-0.00" vs "0.00" would split the cache key).
  return q === 0 ? 0 : q;
}

/** Padded + quantized "s,w,n,e" request bbox for a raw viewport box. Pads by
 *  `pad` per side, clamps lat to ±90 (lon to ±180), rounds outward to 0.01°. */
export function requestBBox(
  w: number,
  s: number,
  e: number,
  n: number,
  pad: number,
): string {
  const padX = (e - w) * pad;
  const padY = (n - s) * pad;
  const W = Math.max(-180, quantizeCoord(w - padX, -1));
  const E = Math.min(180, quantizeCoord(e + padX, 1));
  const S = Math.max(-90, quantizeCoord(s - padY, -1));
  const N = Math.min(90, quantizeCoord(n + padY, 1));
  return `${S.toFixed(2)},${W.toFixed(2)},${N.toFixed(2)},${E.toFixed(2)}`;
}

/** Split a request bbox into the mercator-addressable main box plus the
 *  polar band(s) past ±85.05° (one per visible pole). The server serves any
 *  bbox, but pole-crossing globe views fetch the caps separately so the main
 *  window's row budget isn't spent on the tiny-area caps. */
export function splitPolarBBoxes(bbox: string): string[] {
  const [s, w, n, e] = bbox.split(",").map(Number);
  if (!Number.isFinite(s)) return [bbox];
  // No pole in view → the request IS the viewport bbox, byte-identical.
  if (n <= MERC_LAT_MAX && s >= -MERC_LAT_MAX) return [bbox];
  // Pole in view → ONE request extended to the pole. A separate polar-band
  // request comes back on a different (finer) lattice level than the
  // budget-coarsened main window — stitchWindows can't merge mismatched
  // steps and the caps rendered as holes. The bbox window API serves
  // [s, 90] in one piece, so there is nothing to split.
  const s2 = s < -MERC_LAT_MAX ? -90 : s;
  const n2 = n > MERC_LAT_MAX ? 90 : n;
  return [`${s2},${w},${n2},${e}`];
}

export interface ManagedLayer {
  id: string;
  model: string;
  variable: string; // FULL product id (suffixes resolve server-side)
  mode: "drape" | "contour" | "flow";
  opacity: number; // 0..1
  colormap: string; // registry name
  vmin: number;
  vmax: number;
  // Value→colour fidelity, matching the legend (lib/colormap.ts is the source of
  // truth for both). `units` (Kelvin temperature) + `stepped` drive the discrete
  // temperature bands baked into the ramp texture; the log mapping for precip
  // palettes is keyed off `colormap` (isLogColormap) and done in the shader.
  units?: string; // variable units; "" / non-Kelvin → no stepping
  stepped?: boolean; // stepped override (undefined → units default)
  interp?: number; // drape interpolation: 0 nearest, 1 bilinear, 2 bicubic
  // contour-only
  contourInterval?: number; // 0/undefined = auto from data range
  contourSingle?: boolean; // true = single colour, false = colour by level
  contourColor?: [number, number, number, number];
  contourFill?: boolean;
  // windowed aggregation: the active calendar bucket (tz-aware day / 3h / 6h /
  // 12h) the drape reduces over. agg is the op; [windowStartMs, windowEndMs) is
  // the bucket span, mapped to each layer's own frames at fetch. Absent → hourly.
  agg?: string;
  windowStartMs?: number;
  windowEndMs?: number;
  // flow-only: particle count for the GPU streamline layer.
  flowParticles?: number;
  // Per-layer drape lapse-rate correction on/off (screen-temp layers only).
  // Absent ⇒ true. Applied when the served window carries a height plane.
  lapse?: boolean;
}

/** Neutral grayscale fallback ramp used until the named colormap resolves. */
const GRAY = (() => {
  const out = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = i;
    out[i * 4 + 3] = 255;
  }
  return out;
})();

/** A single GPU drape to render: one WxV2Layer instance. A plain layer is one
 *  unit; a composite layer expands into one unit per contributor (each
 *  fetching its own model's /data bbox window — stacked finest-on-top,
 *  sharing the parent layer's colormap/range). */
interface DrawUnit {
  key: string; // instance key — layer.id, or `${layer.id}::${model}` for a contributor
  layer: ManagedLayer; // parent: colormap / range / mode / opacity / agg
  model: string; // physical model to fetch from (a contributor for composites)
  featherKm: number; // feather band; 0 for a single drape or the global base
  domain: [number, number, number, number]; // contributor footprint (w, s, e, n)
  // flow-only: composite ladder rungs (finest→coarsest) — the flow field is
  // fetched from ONE source, re-picked per viewport (particles advected across
  // per-contributor field seams would jump; a single covering source can't).
  flowLadder?: { model: string; bbox: [number, number, number, number]; isBase: boolean }[];
}

const WORLD_DOMAIN: [number, number, number, number] = [-180, -90, 180, 90];

// ---- Globe terrain drape --------------------------------------------------
// Surface-anchored fields are glued to the terrain (lift 0, subtle hillshade);
// atmospheric fields float above it — cloud-like fields at a cloud-deck height,
// upper-air ids at their pressure level's standard-atmosphere altitude.
const TERRAIN_SHADE = 0.5; // hillshade strength for ground drapes (see u_shade)
const ATMO_LIFT_M = 3000;
const PRESSURE_ALT_M: Record<string, number> = {
  "850": 1500,
  "700": 3000,
  "500": 5500,
  "300": 9200,
};
// ponytail: token list — extend when a new atmospheric variable family appears.
const ATMO_RE = /(^|_)(clc\w*|cloud\w*|cape\w*|dbz\w*|ceiling\w*|hbas\w*|htop\w*|hzerocl)/;
function terrainLiftM(varId: string): number {
  const hpa = /_(\d+)hpa/.exec(varId);
  if (hpa) return PRESSURE_ALT_M[hpa[1]] ?? 5500;
  return ATMO_RE.test(varId) ? ATMO_LIFT_M : 0;
}

export class WxLayerManager {
  private map: MaplibreMap;
  private units: DrawUnit[] = []; // flattened render order, top-to-bottom
  private primaryTimesteps: string[] = [];
  private inst = new Map<string, WxV2Layer>();
  private meta = new Map<string, Promise<V2VarMeta>>();
  private ladders = new Map<string, Promise<V2Composite>>(); // composite ladder cache
  private onLoading?: (loading: boolean) => void;
  // Notified once the shared z_site DEM's availability is known (success
  // or a 404) — lets the legend gate the ⛰ toggle via App state.
  private onDemAvailability?: (available: boolean) => void;
  private rebuildSeq = 0; // rebuild generation — drops stale expansions
  // Animation window buffer: decoded windows keyed by DATA identity
  // (model|run|var|bboxQ|ti|agg|window), so a frame is fetched once and reused
  // across the playhead, prefetch, and readiness checks. LRU-capped (MBs each).
  private winCache = new Map<string, Window>();
  private winInflight = new Map<string, Promise<Window | null>>();
  // Lapse-correction z_site DEM windows (terrarium mosaic) — static per
  // session, so NOT LRU-capped (they never carry a frame index). Capped to the
  // CURRENT (bbox, zoom) only (replaced on a new viewport). z_model no longer
  // needs its own fetch: the /data Window carries the height plane (field 8).
  private demWin = new Map<string, Window>();
  private demInflight = new Map<string, Promise<Window | null>>();
  // Per unit.key lapse identity (on|bbox|zoom) applyLapse last acted on, so the
  // per-vsync applyPlayhead loop doesn't re-issue DEM fetches / re-upload the
  // z textures every frame — only on a viewport / on-off change.
  private lastLapseKey = new Map<string, string>();
  // Per unit.key terrain-drape identity (globe|bbox|zoom) applyTerrain last
  // acted on — same per-vsync re-issue gate pattern as lastLapseKey.
  private lastTerrainKey = new Map<string, string>();
  // False once the terrarium z_site DEM has failed DEM_MAX_STRIKES times in a
  // row (a single success resets the counter): the lapse feature is then
  // unavailable for the rest of the session, so we stop retrying. Surfaced to
  // the legend via the onDemAvailability callback (App state).
  private demAvailable = true;
  private demStrikes = 0;
  // In-flight /data fetches, each with its AbortController + the viewport
  // bbox and DATA identity (model|variable) it was issued for. A zoom/pan
  // (new bbox) aborts every fetch for the OLD viewport; removing/swapping a
  // layer aborts every fetch for its identity. Prefetch lookahead for the
  // CURRENT bbox is untouched (same bbox → not stale).
  private activeFetches = new Set<{ ac: AbortController; bbox: string; sig: string }>();
  // Window-cache capacity must exceed the playback working set — every draw
  // unit (layer × composite contributor) × the buffered frames (current + tween
  // + CHUNK_AHEAD lookahead + slack). Sized per unit set below; this is the floor.
  private static readonly WIN_CACHE_MIN = 64;
  /** Playback lookahead depth (frames buffered ahead per unit, chunked). */
  private static readonly CHUNK_AHEAD = 8;
  /** Server-side animation-chunk frame cap — never span more than this. */
  private static readonly CHUNK_FRAME_CAP = 48;

  private winCacheMax(): number {
    // Derived from the lookahead so the two can't drift: current + tween +
    // CHUNK_AHEAD buffered + generous slack per unit.
    const perUnit = 2 * (WxLayerManager.CHUNK_AHEAD + 2);
    return Math.max(WxLayerManager.WIN_CACHE_MIN, this.units.length * perUnit);
  }
  private metaResolved = new Map<string, V2VarMeta>(); // unit.key → resolved meta (sync nativeTi)
  // Flow streamline layers: separate from `units` so the drape loop (exclusions,
  // loading gate, prefetch) stays untouched. One GpuFlowLayer per flow layer;
  // u/v windows ride the same winCache via synthetic per-component units.
  private flowUnits: DrawUnit[] = [];
  private flowInst = new Map<string, GpuFlowLayer>();
  private flowCount = new Map<string, number>(); // key → requested particle count
  private flowMetaResolved = new Map<string, V2VarMeta>(); // `${model}` → u_10m meta
  private lastWin = new Map<string, Window>(); // unit.key → window applyProps last ran for
  // Units that have shown at least one window (survives lastWin.clear(), which
  // only forces an applyProps re-run) and units whose meta/first-window fetch
  // failed — together they define the blocking-overlay semantic: loading is
  // "a visible unit has nothing on screen yet", NOT "any fetch in flight".
  private firstWin = new Set<string>();
  private firstFailed = new Set<string>();
  private unitSig = new Map<string, string>(); // unit.key → model|run|variable identity
  private readyListeners = new Set<() => void>();
  private playing = false;
  private playhead = 0; // fractional global frame
  private lastBbox = ""; // quantized viewport bbox of the last render (cache key + readiness)
  private lastLoading = false;
  private applyRaf = 0; // pending coalesced applyPlayhead (0 = none)
  private moveTimer = 0; // pending debounced moveend refetch (0 = none)
  private readonly onMove = () => {
    // Debounce the refetch — the bbox changes with every pan, and each new
    // quantized bbox is a fresh set of /data requests. ~150 ms after the last
    // moveend keeps drag-chains from thrashing the request pipeline.
    if (this.moveTimer) window.clearTimeout(this.moveTimer);
    this.moveTimer = window.setTimeout(() => {
      this.moveTimer = 0;
      this.applyPlayhead();
    }, MOVE_DEBOUNCE_MS);
  };
  private hdr = false; // HDR toggle: double the maxcells budget
  // Pinned run (from the run browser): every /data//meta request for this
  // model carries ?run=. null = latest (no query param).
  private pinned: { model: string; run: string } | null = null;

  constructor(
    map: MaplibreMap,
    onLoading?: (loading: boolean) => void,
    onDemAvailability?: (available: boolean) => void,
    onRunFlip?: (model: string) => void,
  ) {
    this.map = map;
    this.onLoading = onLoading;
    this.onDemAvailability = onDemAvailability;
    this.onRunFlip = onRunFlip;
    map.on("moveend", this.onMove);
    // Bare setInterval (not window.*): unit tests construct the manager in
    // Node — and unref there so an undisposed manager can't hang the process.
    this.runWatchTimer = setInterval(() => void this.checkLatestRuns(), 60_000);
    (this.runWatchTimer as unknown as { unref?: () => void }).unref?.();
  }

  /** Fired when the latest-run watchdog sees a model's run id flip, so the
   *  app can refresh run-derived state (timesteps axis, run label). */
  private onRunFlip?: (model: string) => void;

  // Latest-run watchdog: meta and window caches are keyed "latest" and would
  // otherwise serve a superseded run forever in a long-open tab (or when
  // switching back to a previously viewed source) — only a reload flushed
  // them. Poll each visible model's meta once a minute; on a run flip drop
  // that model's cached meta + windows and re-render.
  private runWatchTimer: ReturnType<typeof setInterval> | undefined;
  private seenRun = new Map<string, string>(); // model → last seen run id

  private async checkLatestRuns(): Promise<void> {
    const byModel = new Map<string, string>(); // model → a variable to probe with
    for (const u of this.units) byModel.set(u.model, u.layer.variable);
    for (const model of byModel.keys()) {
      if (this.runFor(model)) continue; // pinned run — immutable by definition
      let run: string | undefined;
      try {
        run = (await fetchV2Meta(model, byModel.get(model)!)).run;
      } catch {
        continue; // transient — retry next tick
      }
      if (!run) continue;
      const prev = this.seenRun.get(model);
      this.seenRun.set(model, run);
      if (!prev || prev === run) continue;
      for (const key of [...this.winCache.keys()]) {
        if (key.startsWith(model + "|")) this.winCache.delete(key);
      }
      for (const key of [...this.meta.keys()]) {
        if (key.startsWith(model + "/")) this.meta.delete(key);
      }
      for (const u of this.units) {
        if (u.model === model) this.metaResolved.delete(u.key);
      }
      for (const u of this.flowUnits) {
        if (u.model === model) this.flowMetaResolved.delete(u.model);
      }
      this.scheduleApply();
      this.onRunFlip?.(model);
    }
  }

  /** HDR toggle: double the /data cell budget (the server picks a finer
   *  pyramid level). The window cache is keyed by bbox/ti, not budget, so a
   *  stale coarse window would otherwise linger on screen — clear it and
   *  force every visible unit to refetch at the new budget. */
  setHdr(on: boolean): void {
    if (this.hdr === on) return;
    this.hdr = on;
    this.winCache.clear();
    this.lastWin.clear(); // force applyProps to re-run once windows land
    this.applyPlayhead();
  }

  /** Pin a run for `model` (empty run unpins). Every data/meta request for
   *  that model then carries ?run=; the cache re-keys so pinned and latest
   *  windows never mix. */
  setPinnedRun(model: string, run: string): void {
    const next = run ? { model, run } : null;
    if (
      (this.pinned?.model ?? "") === (next?.model ?? "") &&
      (this.pinned?.run ?? "") === (next?.run ?? "")
    ) {
      return;
    }
    this.pinned = next;
    // Meta axes are per-run — drop them so nativeTi maps against the pinned
    // run's own timesteps.
    this.meta.clear();
    this.metaResolved.clear();
    this.flowMetaResolved.clear();
    this.winCache.clear();
    this.lastWin.clear();
    this.firstWin.clear();
    this.firstFailed.clear();
    for (const rec of this.activeFetches) rec.ac.abort();
    this.activeFetches.clear();
    this.winInflight.clear();
    this.applyPlayhead();
  }

  /** The pinned run id for `model`'s requests, or undefined (= latest). */
  private runFor(model: string): string | undefined {
    return this.pinned && this.pinned.model === model ? this.pinned.run : undefined;
  }

  private maxcells(): number {
    const dpr = window.devicePixelRatio || 1;
    return Math.round(MAXCELLS_BASE * dpr * dpr * (this.hdr ? 2 : 1));
  }

  dispose(): void {
    this.map.off("moveend", this.onMove);
    if (this.applyRaf) cancelAnimationFrame(this.applyRaf);
    if (this.moveTimer) window.clearTimeout(this.moveTimer);
    clearInterval(this.runWatchTimer);
    for (const rec of this.activeFetches) rec.ac.abort();
    this.activeFetches.clear();
    this.demWin.clear();
    this.demInflight.clear();
    this.lastLapseKey.clear();
    this.lastTerrainKey.clear();
    for (const id of this.inst.keys()) {
      if (this.map.getLayer(id)) this.map.removeLayer(id);
    }
    this.inst.clear();
    for (const id of this.flowInst.keys()) {
      if (this.map.getLayer(id)) this.map.removeLayer(id);
    }
    this.flowInst.clear();
  }

  private ladderFor(model: string): Promise<V2Composite> {
    let p = this.ladders.get(model);
    if (!p) {
      p = fetchV2Composite(model);
      this.ladders.set(model, p);
      p.catch(() => this.ladders.delete(model));
    }
    return p;
  }

  /** Expand the managed layers into a flat, top-to-bottom list of draw units.
   *  layers[0] is the topmost group; within a composite the finest contributor is
   *  topmost (so it wins in its domain) and the global base sits at the bottom. */
  private async expand(layers: ManagedLayer[]): Promise<DrawUnit[]> {
    const units: DrawUnit[] = [];
    for (const l of layers) {
      if (l.mode === "flow") {
        // One streamline unit; on a composite the ladder rides along so the
        // apply pass can pick the finest contributor covering the viewport.
        const u: DrawUnit = { key: l.id, layer: l, model: l.model, featherKm: 0, domain: WORLD_DOMAIN };
        if (isCompositeModel(l.model)) {
          try {
            const ladder = await this.ladderFor(l.model);
            u.flowLadder = ladder.contributors.map((c) => ({
              model: c.model,
              bbox: [c.bbox.west, c.bbox.south, c.bbox.east, c.bbox.north],
              isBase: c.is_base,
            }));
          } catch {
            continue;
          }
        }
        units.push(u);
        continue;
      }
      if (!isCompositeModel(l.model)) {
        units.push({ key: l.id, layer: l, model: l.model, featherKm: 0, domain: WORLD_DOMAIN });
        continue;
      }
      let ladder: V2Composite;
      try {
        ladder = await this.ladderFor(l.model);
      } catch {
        continue; // ladder unavailable → skip the composite layer this round
      }
      for (const c of ladder.contributors) {
        units.push({
          key: `${l.id}::${c.model}`,
          layer: l,
          model: c.model,
          // The global base fills everywhere (no feather); finer rungs feather to
          // their declared footprint so they hand off smoothly to the base below.
          featherKm: c.is_base ? 0 : COMPOSITE_FEATHER_KM,
          domain: [c.bbox.west, c.bbox.south, c.bbox.east, c.bbox.north],
        });
      }
    }
    return units;
  }

  /** The insert anchor keeping weather drapes BELOW the basemap's front
   *  overlay (borders, rivers/lakes/ocean, place labels). Prefer the merged
   *  style's recorded first-front-layer id (lib/basemapStyle.ts); fall back to
   *  the first place-label symbol layer (its own "wx-v2" symbols excluded).
   *  undefined → drapes go on top (the prior behaviour). */
  private labelBeforeId(): string | undefined {
    const style = this.map.getStyle();
    const anchor = (style?.metadata as Record<string, unknown> | undefined)?.[
      FRONT_ANCHOR_KEY
    ];
    if (typeof anchor === "string" && this.map.getLayer(anchor)) return anchor;
    return style?.layers?.find(
      (l) => l.type === "symbol" && !l.id.startsWith("wx-v2"),
    )?.id;
  }

  /** Replace the managed layer set, expanding composites into contributor drapes,
   *  then refetch. The expansion is async (it may fetch composite ladders), so a
   *  rebuild generation drops a stale expansion if setLayers is called again. */
  setLayers(layers: ManagedLayer[]): void {
    const seq = ++this.rebuildSeq;
    void this.expand(layers).then((all) => {
      if (seq !== this.rebuildSeq) return;
      const units = all.filter((u) => u.layer.mode !== "flow");
      const flowUnits = all.filter((u) => u.layer.mode === "flow");
      const before = this.labelBeforeId();
      const want = new Set(units.map((u) => u.key));
      for (const key of [...this.inst.keys()]) {
        if (!want.has(key)) {
          if (this.map.getLayer(key)) this.map.removeLayer(key);
          this.inst.delete(key);
        }
      }
      for (const u of units) {
        if (!this.inst.has(u.key)) {
          const layer = new WxV2Layer(u.key, {
            vmin: u.layer.vmin,
            vmax: u.layer.vmax,
            colormap: GRAY,
          });
          this.map.addLayer(layer as unknown as CustomLayerInterface, before);
          this.inst.set(u.key, layer);
        }
      }
      // Flow streamline instances (recreated on particle-count change — the
      // particle state texture is sized at construction).
      const wantFlow = new Set(flowUnits.map((u) => u.key));
      for (const key of [...this.flowInst.keys()]) {
        if (!wantFlow.has(key)) {
          if (this.map.getLayer(key)) this.map.removeLayer(key);
          this.flowInst.delete(key);
        }
      }
      for (const u of flowUnits) {
        const count = u.layer.flowParticles ?? 2000;
        if (this.flowInst.has(u.key) && this.flowCount.get(u.key) !== count) {
          if (this.map.getLayer(u.key)) this.map.removeLayer(u.key);
          this.flowInst.delete(u.key);
        }
        if (!this.flowInst.has(u.key)) {
          const fl = new GpuFlowLayer({ id: u.key, count, opacity: u.layer.opacity });
          this.map.addLayer(fl as unknown as CustomLayerInterface, before);
          this.flowInst.set(u.key, fl);
          this.flowCount.set(u.key, count);
        } else {
          this.flowInst.get(u.key)!.setOpacity(u.layer.opacity);
        }
      }
      // z-order: units[0] is topmost. moveLayer(key, before) puts key just under
      // the place labels, so applying bottom-to-top leaves units[0] closest to
      // the labels = topmost drape, the whole stack below the place names.
      for (let i = units.length - 1; i >= 0; i--) {
        if (this.map.getLayer(units[i].key))
          this.map.moveLayer(units[i].key, before);
      }
      // Streamlines ride on top of every drape (still below place labels).
      for (const u of flowUnits) {
        if (this.map.getLayer(u.key)) this.map.moveLayer(u.key, before);
      }
      this.units = units;
      this.flowUnits = flowUnits;
      this.lastWin.clear(); // unit set changed — force applyProps on the next render
      // Drop first-window bookkeeping for retired keys; surviving keys keep their
      // shown/failed status so an unrelated layer add doesn't flash the overlay.
      const live = new Set(units.map((u) => u.key));
      for (const k of this.firstWin) if (!live.has(k)) this.firstWin.delete(k);
      for (const k of this.firstFailed) if (!live.has(k)) this.firstFailed.delete(k);
      // Identities (model|run|variable) whose in-flight fetches are now stale —
      // retired layers and product/variable/model swaps — so their downloads are
      // aborted rather than left to land against a texture that no longer wants them.
      const abortSigs = new Set<string>();
      // A key whose DATA identity changed (product/variable switch on the
      // same layer id, or a model swap) is a fresh start: clear the stale
      // texture, re-resolve meta, and let the blocking overlay cover the first
      // fetch — otherwise the old variable's drape lingers with no indicator.
      for (const u of units) {
        const sig = this.unitFetchSig(u);
        if (this.unitSig.get(u.key) !== sig) {
          const old = this.unitSig.get(u.key);
          if (old) abortSigs.add(old);
          this.unitSig.set(u.key, sig);
          this.firstWin.delete(u.key);
          this.firstFailed.delete(u.key);
          this.metaResolved.delete(u.key);
          this.inst.get(u.key)?.clear();
        }
      }
      for (const k of this.unitSig.keys()) {
        if (!live.has(k)) {
          const old = this.unitSig.get(k);
          if (old) abortSigs.add(old);
          this.unitSig.delete(k);
        }
      }
      // Don't abort an identity that a surviving unit still wants.
      for (const u of units) abortSigs.delete(this.unitSig.get(u.key)!);
      this.abortBySig(abortSigs);
      this.applyPlayhead();
    });
  }

  /** Set the active forecast frame (integer). `primaryTimesteps` is the global
   *  axis the index refers to; each layer maps it to its own timesteps by
   *  wall-clock. Drives the playhead at the integer position (no tween). */
  setFrame(frame: number, primaryTimesteps: string[]): void {
    this.primaryTimesteps = primaryTimesteps;
    this.playhead = frame;
    this.applyPlayhead();
  }

  /** Fractional playhead for smooth GPU playback (TimeBar's vsync loop). Renders
   *  each drape as a tween between the two bracketing integer frames. Synchronous
   *  when both frames are cached (the steady state) — only a miss goes async. */
  setPlayhead(t: number): void {
    this.playhead = t;
    this.applyPlayhead();
  }

  /** Playback on/off — gates frame prefetch (we look ahead only while playing). */
  setPlaying(playing: boolean): void {
    this.playing = playing;
    if (playing) this.prefetchAround(Math.floor(this.playhead));
  }

  /** Current playback flag — lets a manager rebuild (basemap swap) carry it
   *  over; a fresh manager defaulting to false would silently stop the
   *  prefetch lookahead and wedge the play loop's readiness gate. */
  isPlaying(): boolean {
    return this.playing;
  }

  /** Is every visible unit's window for global frame `f` already decoded+cached?
   *  TimeBar gates the playhead on this so playback never tweens into half-loaded
   *  data. A unit whose meta hasn't resolved yet counts as not-ready. */
  isFrameReady(f: number): boolean {
    for (const u of this.units) {
      // A failed unit (meta 404 — contributor lacks the variable — or first
      // window unobtainable) can never become ready; waiting on it would stall
      // playback into the 8s waitForFrameReady timeout on every frame.
      if (this.firstFailed.has(u.key)) continue;
      const meta = this.metaResolved.get(u.key);
      if (!meta) return false;
      const ti = this.nativeTi(meta, f);
      if (ti < 0) continue; // this contributor doesn't cover f → nothing to load for it
      if (!this.inDomain(u, this.lastBbox)) continue; // off-screen contributor
      if (!this.winCache.has(this.cacheKey(u, this.lastBbox, ti))) return false;
    }
    return true;
  }

  /** Resolve when frame `f` is ready (or after timeoutMs). Kicks the fetches so a
   *  held playhead unfreezes as soon as the missing windows land. */
  waitForFrameReady(f: number, timeoutMs = 8000): Promise<void> {
    if (this.isFrameReady(f)) return Promise.resolve();
    this.prefetchFrame(f);
    return new Promise((resolve) => {
      let timer = 0;
      const check = () => {
        if (!this.isFrameReady(f)) return;
        clearTimeout(timer);
        this.readyListeners.delete(check);
        resolve();
      };
      timer = window.setTimeout(() => {
        this.readyListeners.delete(check);
        resolve();
      }, timeoutMs);
      this.readyListeners.add(check);
    });
  }

  private metaFor(model: string, variable: string): Promise<V2VarMeta> {
    const run = this.runFor(model);
    const key = `${model}/${variable}@${run ?? ""}`;
    let p = this.meta.get(key);
    if (!p) {
      p = fetchV2Meta(model, variable, undefined, run);
      this.meta.set(key, p);
      p.catch(() => this.meta.delete(key));
    }
    return p;
  }

  /** Current padded + quantized request bbox ("s,w,n,e", 2 dp). The quantized
   *  form is BOTH the request bbox and the window cache key, so tiny pans that
   *  stay within the same 0.01° grid reuse the cache. */
  private viewport(): { bbox: string; lonSpan: number; latSpan: number } {
    const b = this.map.getBounds();
    let w = b.getWest();
    let e = b.getEast();
    let s = b.getSouth();
    let n = b.getNorth();
    // Globe shows more world than the corner-derived bounds (the curved horizon
    // overflows a lat/lon box), so an unpadded fetch leaves bare basemap arcs at
    // the sphere's edges. Pad wider; a fully zoomed-out globe falls through
    // to the whole-world branch below. Lat clamps to the FULL pole: the globe
    // shows the polar caps, fetched via the extra polar-band request.
    const pad = this.map.getProjection?.()?.type === "globe" ? 0.35 : VIEW_PAD;
    if (!(w >= -180 && e <= 180 && e > w && e - w < 350)) {
      w = -180;
      e = 180;
      s = -90;
      n = 90;
      return { bbox: `-90.00,-180.00,90.00,180.00`, lonSpan: 360, latSpan: 180 };
    }
    const bbox = requestBBox(w, s, e, n, pad);
    const [S, W, N, E] = bbox.split(",").map(Number);
    return { bbox, lonSpan: E - W, latSpan: Math.max(1, N - S) };
  }

  /** Does the viewport bbox ("s,w,n,e") intersect this unit's footprint? A
   *  composite contributor entirely off-screen (icond2 while the map shows the
   *  southern hemisphere) has nothing to fetch — the server would 404 every
   *  window with "window does not overlap the grid". */
  private inDomain(u: DrawUnit, bbox: string): boolean {
    if (!u.domain) return true;
    const [s, w, n, e] = bbox.split(",").map(Number);
    if (!Number.isFinite(s)) return true; // no viewport yet — don't exclude
    const [dw, ds, de, dn] = u.domain;
    return s < dn && n > ds && w < de && e > dw;
  }

  /** Global frame `f` → this unit's nearest native timestep index. */
  private nativeTi(meta: V2VarMeta, f: number): number {
    const ts = meta.timesteps ?? [];
    const gMs = this.primaryTimesteps[f] ? Date.parse(this.primaryTimesteps[f]) : NaN;
    if (!Number.isFinite(gMs) || ts.length === 0) {
      return Math.min(f, Math.max(0, ts.length - 1));
    }
    // A composite contributor covers only the frames inside its OWN horizon. Past
    // its last frame (e.g. the finest model beyond +33 h on the auto union timeline)
    // return -1 so the caller drops it and the coarser contributor shows through —
    // otherwise nearestTimestepIndex would clamp to, and freeze on, its last frame.
    const firstMs = Date.parse(ts[0]);
    const lastMs = Date.parse(ts[ts.length - 1]);
    const headGap = ts.length >= 2 ? Date.parse(ts[1]) - firstMs : 3_600_000;
    const tailGap = ts.length >= 2 ? lastMs - Date.parse(ts[ts.length - 2]) : 3_600_000;
    if (gMs < firstMs - headGap || gMs > lastMs + tailGap) return -1;
    return nearestTimestepIndex(ts, gMs);
  }

  /** Window-mode block coverage: with agg + [windowStartMs, windowEndMs) set,
   *  does this unit's timeline span the WHOLE block (clipped to the union
   *  timeline)? A composite rung whose horizon ends inside the block would
   *  otherwise reduce over its few leading frames and paint that as the
   *  block's value — iconch1's last 00Z frame posing as the daily max (the
   *  iconch1→iconch2 cutover bug). */
  private coversWindow(l: ManagedLayer, meta: V2VarMeta): boolean {
    if (!l.agg || l.windowStartMs == null || l.windowEndMs == null) return true;
    const ts = meta.timesteps ?? [];
    if (ts.length === 0) return false;
    const union = this.primaryTimesteps;
    const s = Math.max(l.windowStartMs, union.length ? Date.parse(union[0]) : -Infinity);
    const e = Math.min(l.windowEndMs, union.length ? Date.parse(union[union.length - 1]) + 1 : Infinity);
    const firstMs = Date.parse(ts[0]);
    const lastMs = Date.parse(ts[ts.length - 1]);
    const tailGap = ts.length >= 2 ? lastMs - Date.parse(ts[ts.length - 2]) : 3_600_000;
    return firstMs <= s && lastMs + tailGap >= e;
  }

  /** True when this unit sits out the active window block: it does NOT cover
   *  the whole block while a sibling unit of the same layer does. With no
   *  covering sibling (single-model layers, the union's partial first/last
   *  day) nothing is dropped — the old partial reduce stays. */
  private windowDropped(u: DrawUnit): boolean {
    const meta = this.metaResolved.get(u.key);
    if (!meta || this.coversWindow(u.layer, meta)) return false;
    return this.units.some((o) => {
      if (o.layer.id !== u.layer.id || o.key === u.key) return false;
      const om = this.metaResolved.get(o.key);
      return !!om && this.coversWindow(o.layer, om);
    });
  }

  /** Cache/identity key for a unit's window at native index `ti`. Keyed by DATA
   *  identity — model|run|var|bboxQ|frame|agg|window — so identical requests
   *  across layers dedup, a layer that swaps its variable can't read a stale
   *  window, and a pinned run never mixes with latest. */
  private cacheKey(u: DrawUnit, bbox: string, ti: number): string {
    const l = u.layer;
    const run = this.runFor(u.model) ?? "latest";
    return `${u.model}|${run}|${l.variable}|${bbox}|${ti}|${l.agg ?? ""}|${l.windowStartMs ?? ""}|${l.windowEndMs ?? ""}`;
  }

  private peek(u: DrawUnit, ti: number): Window | null {
    const key = this.cacheKey(u, this.lastBbox, ti);
    const w = this.winCache.get(key);
    if (!w) return null;
    // True LRU: refresh recency on hit (Map eviction below pops the oldest
    // entry, which without this is oldest-INSERTED — a frame still on screen
    // could be evicted by its own lookahead).
    this.winCache.delete(key);
    this.winCache.set(key, w);
    return w;
  }

  /** DATA identity of a unit's fetches (model|run|variable) — the abort key for
   *  layer removal / product swaps. Matches the sig computed in setLayers. */
  private unitFetchSig(u: DrawUnit): string {
    return `${u.model}|${this.runFor(u.model) ?? ""}|${u.layer.variable}`;
  }

  /** Abort every in-flight /data fetch issued for a viewport other than the
   *  current one — a zoom/pan superseded them. Same-bbox fetches (the current
   *  frame + prefetch lookahead) are kept, so panning doesn't thrash the buffer. */
  private abortStaleViewport(currentBbox: string): void {
    for (const rec of [...this.activeFetches]) {
      if (rec.bbox !== currentBbox) {
        this.activeFetches.delete(rec);
        rec.ac.abort();
      }
    }
  }

  /** Abort every in-flight /data fetch whose DATA identity is in `sigs` — used
   *  when a layer is removed or swaps its variable/model. */
  private abortBySig(sigs: Set<string>): void {
    if (sigs.size === 0) return;
    for (const rec of [...this.activeFetches]) {
      if (sigs.has(rec.sig)) {
        this.activeFetches.delete(rec);
        rec.ac.abort();
      }
    }
  }

  /** Cached window, a deduped in-flight fetch, or a fresh fetch; caches the result
   *  and fires the readiness listeners when it lands. */
  private ensureWindow(
    u: DrawUnit,
    meta: V2VarMeta,
    ti: number,
    vp: { bbox: string; lonSpan: number; latSpan: number },
    prefetch = false,
  ): Promise<Window | null> {
    if (ti < 0) return Promise.resolve(null); // contributor doesn't cover this frame
    if (!this.inDomain(u, vp.bbox)) return Promise.resolve(null); // off-screen contributor
    const key = this.cacheKey(u, vp.bbox, ti);
    const hit = this.winCache.get(key);
    if (hit) return Promise.resolve(hit);
    const inflight = this.winInflight.get(key);
    if (inflight) return inflight;
    const rec = { ac: new AbortController(), bbox: vp.bbox, sig: this.unitFetchSig(u) };
    this.activeFetches.add(rec);
    const p = this.fetchWindow(u.model, u.layer, meta, ti, vp, prefetch, rec.ac.signal)
      .then((w) => {
        this.activeFetches.delete(rec);
        this.winInflight.delete(key);
        if (w) {
          this.cachePut(key, w);
          this.fireReady();
        }
        // A settled window (hit OR miss) can change the loading verdict, so
        // re-evaluate the gate right here — the *success* path re-runs
        // applyPlayhead (which re-evaluates at its tail), but a failed/empty
        // window (404 / thin data) would otherwise leave `loading` stuck true.
        this.setLoading(this.computeLoading());
        return w;
      })
      .catch(() => {
        // Includes AbortError (superseded by a newer viewport/layer): drop the
        // in-flight slot and return null. Callers guard on bbox staleness so an
        // aborted null never marks the unit failed or clears its texture.
        this.activeFetches.delete(rec);
        this.winInflight.delete(key);
        this.setLoading(this.computeLoading());
        return null;
      });
    this.winInflight.set(key, p);
    return p;
  }

  private fireReady(): void {
    for (const cb of [...this.readyListeners]) cb();
  }

  private setLoading(v: boolean): void {
    if (v === this.lastLoading) return;
    this.lastLoading = v;
    this.onLoading?.(v);
  }

  /** Coalesce async re-renders into one per animation frame. Many windows
   *  settling on a single zoom/frame (composite units × double-buffered
   *  current+next windows) must re-render ONCE, not once each — the reentrant
   *  applyPlayhead fan-out would otherwise storm the main thread and kill the
   *  tab on zoom. Direct callers (setFrame/setPlayhead) stay synchronous. */
  private scheduleApply(): void {
    if (this.applyRaf) return;
    this.applyRaf = requestAnimationFrame(() => {
      this.applyRaf = 0;
      this.applyPlayhead();
    });
  }

  /** Render the current playhead: each drape tweens between its two bracketing
   *  native frames. Synchronous on cache hits; a miss kicks a fetch that re-applies
   *  when it lands. Also the single render entry for moves and layer changes. */
  private applyPlayhead(): void {
    if (this.units.length === 0 && this.flowUnits.length === 0) {
      this.setLoading(false);
      return;
    }
    const prevBbox = this.lastBbox;
    const vp = this.viewport();
    this.lastBbox = vp.bbox;
    // A genuine viewport change (zoom/pan) supersedes every in-flight fetch for
    // the old bbox. Frame-only re-renders (playback vsync, setFrame) keep the
    // same bbox, so nothing is aborted and the prefetch buffer survives.
    if (vp.bbox !== prevBbox) this.abortStaleViewport(vp.bbox);
    const t = this.playhead;
    const N = this.primaryTimesteps.length;
    const f0 = Math.max(0, Math.floor(t));
    const f1 = Math.min(f0 + 1, Math.max(0, N - 1));
    const frac = t - Math.floor(t);
    // Per-layer accumulator of ACTIVE finer contributor domains: units iterate
    // finest→coarsest within a layer, so each unit yields exactly to the finer
    // ones already seen this frame (per-pixel finest-wins — see
    // WxV2Layer.setExclusions). Units past their horizon or with nothing shown
    // don't exclude, so the coarser drape keeps covering their area.
    const finerByLayer = new Map<string, WxV2Layer[]>();
    for (const u of this.units) {
      const inst = this.inst.get(u.key);
      if (!inst) continue;
      const finer = finerByLayer.get(u.layer.id) ?? [];
      inst.setExclusions(finer, u.featherKm > 0 ? u.featherKm : 50);
      const meta = this.metaResolved.get(u.key);
      if (!meta) {
        // A failed meta (404 — contributor lacks the variable, e.g. iconeueps
        // relhum_2m) stays failed until the layer set changes; without the guard
        // every render pass refetched the 404.
        if (!this.firstFailed.has(u.key)) void this.resolveMetaThenApply(u);
        continue;
      }
      const tiA = this.nativeTi(meta, f0);
      if (tiA < 0 || !this.inDomain(u, vp.bbox) || this.windowDropped(u)) {
        // Past this contributor's horizon (or entirely off-screen, or unable
        // to cover the active window block) → drop it so the coarser
        // contributor shows through, instead of freezing on its last frame /
        // fetching windows the server would 404.
        inst.clear();
        this.lastWin.delete(u.key);
        this.firstWin.delete(u.key);
        continue;
      }
      // This unit will draw this frame (fresh window, or its previous texture
      // while a fetch is in flight): coarser siblings must yield to it — the
      // instance reference lets them gate the yield on its actual valid pixels.
      // The base (featherKm=0) registers too: rungs BELOW it (iconepsglobal on
      // auto) must yield to it, or the EPS field bleeds through wherever the
      // base's palette is transparent (dry precip).
      if (this.peek(u, tiA) || this.firstWin.has(u.key)) {
        finer.push(inst);
        finerByLayer.set(u.layer.id, finer);
      }
      const tween = u.layer.mode === "drape" && frac > 0 && f1 !== f0;
      let tiB = tween ? this.nativeTi(meta, f1) : tiA;
      if (tiB < 0) tiB = tiA; // next frame outside this contributor's horizon → no tween
      const wA = this.peek(u, tiA);
      if (!wA) {
        void this.ensureWindow(u, meta, tiA, vp).then((w) => {
          // Viewport moved on while this was in flight (aborted or just slow):
          // its result is stale — don't let it clear the texture or mark the
          // unit failed. A fresh applyPlayhead already issued the new fetch.
          if (vp.bbox !== this.lastBbox) return;
          if (w) {
            this.firstFailed.delete(u.key);
            this.scheduleApply();
          } else {
            // First window unobtainable (404/thin data): mark it so the
            // blocking overlay doesn't wait on this unit forever.
            this.firstFailed.add(u.key);
            inst.clear();
            this.setLoading(this.computeLoading());
          }
        });
        continue;
      }
      const wB = tween && tiB !== tiA ? this.peek(u, tiB) : null;
      inst.setFrames(wA, wB, wB ? frac : 0);
      if (this.lastWin.get(u.key) !== wA) {
        this.applyProps(inst, u, wA);
        this.lastWin.set(u.key, wA);
      }
      this.firstWin.add(u.key);
      this.firstFailed.delete(u.key);
      this.applyLapse(u, vp, wA);
      this.applyTerrain(u, vp);
      if (tween && tiB !== tiA && !wB) {
        // Lookahead warming for the tween target — prefetch, so a miss here
        // doesn't blink the visible-loading chip at every frame boundary.
        void this.ensureWindow(u, meta, tiB, vp, true).then((w) => {
          if (w) this.scheduleApply();
        });
      }
    }
    if (this.playing) this.prefetchAround(f0);
    this.applyFlow(f0, f1, frac, vp);
    this.setLoading(this.computeLoading());
  }

  /** Drive the GPU streamline layers: fetch the (u_10m, v_10m) window pair for
   *  the current (and tween-target) frame from ONE source model and hand the
   *  assembled FlowFields to GpuFlowLayer. On a composite the source is the
   *  finest contributor whose declared footprint contains the viewport
   *  (particles advected across per-contributor seams would jump; a single
   *  covering field can't seam). Missing windows are fetched and the layer
   *  keeps advecting its previous field until they land. */
  private applyFlow(
    f0: number,
    f1: number,
    frac: number,
    vp: { bbox: string; lonSpan: number; latSpan: number },
  ): void {
    if (this.flowUnits.length === 0) return;
    const [s, w, n, e] = vp.bbox.split(",").map(Number);
    for (const u of this.flowUnits) {
      const inst = this.flowInst.get(u.key);
      if (!inst) continue;
      let model = u.model;
      if (u.flowLadder) {
        const covering = u.flowLadder.find(
          (c) => c.isBase || (c.bbox[0] <= w && c.bbox[1] <= s && c.bbox[2] >= e && c.bbox[3] >= n),
        );
        if (!covering) continue;
        model = covering.model;
      }
      const meta = this.flowMetaResolved.get(model);
      if (!meta) {
        void this.metaFor(model, "u_10m")
          .then((m) => {
            this.flowMetaResolved.set(model, m);
            this.scheduleApply();
          })
          .catch(() => {}); // model without u/v (or meta failure) → flow stays inert
        continue;
      }
      // Synthetic per-component units: same cacheKey/ensureWindow pipeline as
      // the drapes, hourly frames (windowed agg is a drape concept — stripped).
      const comp = (variable: string): DrawUnit => ({
        ...u,
        model,
        layer: { ...u.layer, variable, agg: undefined, windowStartMs: undefined, windowEndMs: undefined },
      });
      const uu = comp("u_10m");
      const vu = comp("v_10m");
      const tiA = this.nativeTi(meta, f0);
      if (tiA < 0) continue; // past this source's horizon — keep the last field
      const need = (cu: DrawUnit, ti: number): Window | null => {
        const hit = this.peek(cu, ti);
        if (!hit)
          void this.ensureWindow(cu, meta, ti, vp, true).then((got) => {
            if (got) this.scheduleApply();
          });
        return hit;
      };
      const wUA = need(uu, tiA);
      const wVA = need(vu, tiA);
      if (!wUA || !wVA) continue;
      const fieldA = windowsToFlowField(wUA, wVA);
      if (!fieldA) continue;
      let fieldB = null;
      const tiB = frac > 0 && f1 !== f0 ? this.nativeTi(meta, f1) : tiA;
      if (tiB >= 0 && tiB !== tiA) {
        const wUB = need(uu, tiB);
        const wVB = need(vu, tiB);
        if (wUB && wVB) fieldB = windowsToFlowField(wUB, wVB);
      }
      inst.setUVFields(fieldA, fieldB, fieldB ? frac : 0);
    }
  }

  private resolveMetaThenApply(u: DrawUnit): Promise<void> {
    return this.metaFor(u.model, u.layer.variable)
      .then((meta) => {
        this.metaResolved.set(u.key, meta);
        this.firstFailed.delete(u.key);
        this.scheduleApply();
      })
      .catch((e: unknown) => {
        // Only a definitive 4xx (contributor lacks the variable) is permanent.
        // Transient failures — startup aborts, network blips — stay unlatched
        // so the next render pass retries; latching them left the unit dead
        // (meta never resolved) until the next layer change.
        if (!/^4\d\d /.test(String((e as Error)?.message ?? ""))) return;
        // No meta → this unit can never show; exclude it from the loading
        // verdict so the overlay doesn't wait on it forever.
        this.firstFailed.add(u.key);
        this.inst.get(u.key)?.clear();
        this.setLoading(this.computeLoading());
      });
  }

  /** The blocking-overlay verdict: true while some unit that SHOULD be visible at
   *  the current frame has nothing on screen yet (meta unresolved, or no first
   *  window applied). In-flight refreshes of an already-shown unit (pans, frame
   *  advances, playback lookahead) do NOT count — those get the non-blocking chip
   *  via chunkStats. Failed units are excluded so the verdict can't stick true. */
  private computeLoading(): boolean {
    const f0 = Math.max(0, Math.floor(this.playhead));
    for (const u of this.units) {
      if (this.firstFailed.has(u.key)) continue;
      const meta = this.metaResolved.get(u.key);
      if (!meta) return true;
      if (this.firstWin.has(u.key)) continue;
      if (this.nativeTi(meta, f0) < 0) continue; // doesn't cover this frame
      if (!this.inDomain(u, this.lastBbox)) continue; // off-screen contributor
      if (this.windowDropped(u)) continue; // sits out the active window block
      return true;
    }
    return false;
  }

  /** Warm the cache ahead of the playhead so playback never stalls at a frame
   *  boundary. Plain layers buffer CHUNK_AHEAD hours in ONE span /data request
   *  per unit (a multi-frame Window chunk); windowed (agg) layers keep
   *  per-frame reduced fetches. Fire-and-forget; results land in winCache. */
  private prefetchAround(f0: number): void {
    const N = this.primaryTimesteps.length;
    const CHUNK_AHEAD = WxLayerManager.CHUNK_AHEAD;
    const vp = this.viewport();
    for (const u of this.units) {
      const meta = this.metaResolved.get(u.key);
      if (!meta) continue;
      if (!this.inDomain(u, vp.bbox)) continue; // off-screen contributor
      if (this.windowDropped(u)) continue; // sits out the active window block
      // Uncached, not-in-flight native frames in (f0, f0+CHUNK_AHEAD],
      // wrapping past the end so the loop restart (frame 0) is already
      // warm when playback wraps — long timelines evict it by then.
      const tis: number[] = [];
      for (let d = 1; d <= Math.min(CHUNK_AHEAD, N - 1); d++) {
        const f = (f0 + d) % N;
        const ti = this.nativeTi(meta, f);
        if (ti < 0 || tis.includes(ti)) continue;
        const key = this.cacheKey(u, vp.bbox, ti);
        if (this.winCache.has(key) || this.winInflight.has(key)) continue;
        tis.push(ti);
      }
      if (tis.length === 0) continue;
      if (u.layer.agg || tis.length === 1) {
        // Windowed layers reduce per frame server-side; a single missing frame
        // isn't worth a chunk round-trip either.
        for (const ti of tis) void this.ensureWindow(u, meta, ti, vp, true);
        continue;
      }
      this.ensureChunk(u, meta, tis, vp);
    }
  }

  /** One span /data request covering the given native frames: registers a
   *  per-frame promise in winInflight (so isFrameReady/awaitFrame see it),
   *  splits the multi-frame Window into per-frame Windows keyed by valid time. */
  private ensureChunk(
    u: DrawUnit,
    meta: V2VarMeta,
    tis: number[],
    vp: { bbox: string; lonSpan: number; latSpan: number },
  ): void {
    const axis = meta.timesteps;
    if (!axis) {
      for (const ti of tis) void this.ensureWindow(u, meta, ti, vp, true);
      return;
    }
    // Chunk only a CONSECUTIVE native run: when the primary timeline steps
    // coarser than this unit's native cadence (6h global tail over an hourly
    // axis), the wanted tis have gaps — a first..last span would make the
    // server stack every native frame in between (blowing its frame cap and
    // downloading unwanted data). Leading consecutive run → one chunk; the
    // stragglers go per-frame.
    let runLen = 1;
    while (runLen < tis.length && tis[runLen] === tis[runLen - 1] + 1) runLen++;
    if (runLen < 2) {
      for (const ti of tis) void this.ensureWindow(u, meta, ti, vp, true);
      return;
    }
    for (const ti of tis.slice(runLen)) void this.ensureWindow(u, meta, ti, vp, true);
    tis = tis.slice(0, Math.min(runLen, WxLayerManager.CHUNK_FRAME_CAP));
    const startISO = axis[tis[0]];
    const endISO = axis[tis[tis.length - 1]];
    // Half-open span [start, end+1s) covers the last frame inclusively.
    const seconds = Math.max(1, Math.round((Date.parse(endISO) - Date.parse(startISO)) / 1000) + 1);
    const rec = { ac: new AbortController(), bbox: vp.bbox, sig: this.unitFetchSig(u) };
    this.activeFetches.add(rec);
    const chunkP = this.fetchChunk(u.model, u.layer, meta, startISO, seconds, vp, rec.ac.signal);
    void chunkP.catch(() => {}).finally(() => this.activeFetches.delete(rec));
    for (const ti of tis) {
      const key = this.cacheKey(u, vp.bbox, ti);
      const p = chunkP
        .then((byTi) => {
          this.winInflight.delete(key);
          const w = byTi?.get(ti) ?? null;
          if (w) {
            this.cachePut(key, w);
            this.fireReady();
          }
          this.setLoading(this.computeLoading());
          return w;
        })
        .catch(() => {
          this.winInflight.delete(key);
          this.setLoading(this.computeLoading());
          return null;
        });
      this.winInflight.set(key, p);
    }
    void chunkP.then((byTi) => {
      if (byTi) this.scheduleApply();
    });
  }

  /** Fetch + decode the main viewport window and (on a pole-crossing globe
   *  view) the extra polar-band window(s), one GET each. A 404 (no overlap
   *  with the model domain) is a nodata hole, not a dead window; an abort
   *  rejects the whole batch so callers see the usual AbortError. */
  private async fetchBoxes(
    urlFor: (bbox: string) => string,
    bbox: string,
    signal?: AbortSignal,
  ): Promise<{ chunks: Chunk[]; bytes: number; all404: boolean }> {
    const boxes = splitPolarBBoxes(bbox);
    let bytes = 0;
    let all404 = true;
    const fetchOne = (url: string): Promise<Chunk | null> =>
      (async () => {
        const res = await fetch(url, signal ? { signal } : undefined);
        if (res.status === 404) return null;
        all404 = false;
        if (!res.ok) return null;
        const buf = await res.arrayBuffer();
        bytes += buf.byteLength;
        return decodeChunk(buf);
      })().catch((err) => {
        if (signal?.aborted) throw err;
        all404 = false; // network blip = transient, not "this model lacks the var"
        return null;
      });
    const chunks = (await Promise.all(boxes.map((b) => fetchOne(urlFor(b))))).filter(
      (c): c is Chunk => !!c,
    );
    return { chunks, bytes, all404 };
  }

  private async fetchChunk(
    model: string,
    l: ManagedLayer,
    meta: V2VarMeta,
    startISO: string,
    seconds: number,
    vp: { bbox: string; lonSpan: number; latSpan: number },
    signal?: AbortSignal,
  ): Promise<Map<number, Window> | null> {
    const run = this.runFor(model);
    const maxcells = this.maxcells();
    const token = recordStart(true);
    try {
      const { chunks, bytes } = await this.fetchBoxes(
        (bb) =>
          v2DataChunkUrl(model, l.variable, { bbox: bb, maxcells, run, startISO, seconds }),
        vp.bbox,
        signal,
      );
      if (chunks.length === 0) {
        recordDone(token, 0, false);
        return null;
      }
      recordDone(token, bytes, true);
      // Stitch per frame, matched by valid time (the main window and a polar
      // band of the same span carry the same frames; the lookup just makes a
      // straggler harmless).
      const ref = chunks.reduce((a, b) => (b.times.length > a.times.length ? b : a));
      const byTi = new Map<number, Window>();
      for (let k = 0; k < ref.times.length; k++) {
        const iso = ref.times[k];
        const ti = iso ? (meta.timesteps?.indexOf(iso) ?? -1) : -1;
        if (ti < 0) continue;
        const w = stitchWindows(
          chunks.map((c) => {
            const i = c.times.indexOf(iso);
            return i >= 0 ? c.frames[i] : null;
          }),
        );
        if (w) byTi.set(ti, w);
      }
      return byTi;
    } catch (e) {
      recordDone(token, 0, false);
      throw e;
    }
  }

  private cachePut(key: string, w: Window): void {
    this.winCache.set(key, w);
    const max = this.winCacheMax();
    while (this.winCache.size > max) {
      const oldest = this.winCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.winCache.delete(oldest);
    }
  }

  private prefetchFrame(f: number): void {
    const vp = this.viewport();
    for (const u of this.units) {
      const meta = this.metaResolved.get(u.key);
      // NOT prefetch: this runs when the play loop is PAUSED on frame f
      // (awaitFrame) — the user is staring at a stalled animation, so these
      // fetches must count as visible and light the loading chip.
      if (meta && !this.windowDropped(u)) void this.ensureWindow(u, meta, this.nativeTi(meta, f), vp, false);
    }
  }

  private async fetchWindow(
    model: string,
    l: ManagedLayer,
    meta: V2VarMeta,
    ti: number,
    vp: { bbox: string; lonSpan: number; latSpan: number },
    prefetch = false,
    signal?: AbortSignal,
  ): Promise<Window | null> {
    // Daily / sub-daily window mode: reduce the layer's own frames that fall in
    // the active tz-aware calendar bucket (per-day reduction, not a rolling
    // trailing window). null when this layer's cadence has no frame in the bucket.
    const aw =
      l.agg && l.windowStartMs != null && l.windowEndMs != null
        ? framesInSpan(meta.timesteps, l.windowStartMs, l.windowEndMs)
        : undefined;
    const timeParams = {
      timesteps: meta.timesteps,
      time: ti,
      window: aw && l.agg ? { t0: aw.t0, t1: aw.t1, op: l.agg } : undefined,
    };
    const run = this.runFor(model);
    const maxcells = this.maxcells();
    // One logical window fetch = one chunkStats entry (a polar-band companion
    // request is internal), so the loading overlay's "N requests in flight"
    // and the bandwidth estimator see one unit of work per (layer, frame).
    const token = recordStart(prefetch);
    try {
      const { chunks, bytes } = await this.fetchBoxes(
        (bb) => v2DataUrl(model, l.variable, { bbox: bb, maxcells, run, ...timeParams }),
        vp.bbox,
        signal,
      );
      const win = stitchWindows(chunks.map((c) => c.frames[0] ?? null));
      if (!win) {
        recordDone(token, bytes, false);
        return null;
      }
      recordDone(token, bytes, true);
      return win;
    } catch (e) {
      recordDone(token, 0, false);
      throw e;
    }
  }

  /** Fetch (or reuse) the shared z_site DEM window for the viewport, sourced
   *  DIRECTLY from terrarium-encoded WebP DEM tiles (Mapterhorn by default, the
   *  Mapterhorn mirror) — no backend elevation archive. The terrarium zoom
   *  is derived from the map zoom (~1 DEM px per screen px, capped at the source
   *  maxzoom). Cached per (bbox, zoom) — static, never LRU-evicted. Transient
   *  tile failures don't kill the feature: only DEM_MAX_STRIKES consecutive
   *  failures latch it off (a success resets). Abort-integrated via activeFetches
   *  so a pan supersedes an in-flight mosaic fetch (aborting all its tiles). */
  private ensureDem(
    vp: { bbox: string; lonSpan: number; latSpan: number },
  ): Promise<Window | null> {
    if (!this.demAvailable) return Promise.resolve(null);
    const zoom = pickTerrariumZoom(this.map.getZoom());
    const key = `${vp.bbox}|${zoom}`;
    const hit = this.demWin.get(key);
    if (hit) return Promise.resolve(hit);
    const inflight = this.demInflight.get(key);
    if (inflight) return inflight;
    const rec = { ac: new AbortController(), bbox: vp.bbox, sig: "lapse:zsite" };
    this.activeFetches.add(rec);
    const p = fetchTerrariumZsite(vp.bbox, zoom, rec.ac.signal)
      .then((w) => {
        this.activeFetches.delete(rec);
        this.demInflight.delete(key);
        this.demStrikes = 0; // a good mosaic resets the failure latch
        this.demWin.clear(); // keep only the current (bbox, zoom) DEM
        this.demWin.set(key, w);
        // Fires on EVERY successful fetch, not just the first — harmless,
        // the App-level setState it drives is idempotent once true.
        this.onDemAvailability?.(true);
        this.scheduleApply();
        return w;
      })
      .catch((err) => {
        this.activeFetches.delete(rec);
        this.demInflight.delete(key);
        // A superseded viewport aborts the mosaic — not a real failure, so it
        // must not count toward the latch. Any other error is a strike; after
        // DEM_MAX_STRIKES in a row the feature is disabled for the session.
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          if (++this.demStrikes >= DEM_MAX_STRIKES) {
            this.demAvailable = false;
            this.onDemAvailability?.(false);
          }
        }
        return null;
      });
    this.demInflight.set(key, p);
    return p;
  }

  /** Wire the drape lapse correction for one rendering unit: fetch the shared
   *  z_site DEM and pair it with the z_model height plane riding the unit's
   *  own /data window (field 8 — same grid by construction, so gridsAlign
   *  always holds). Only for screen-temp layers (isLapseVar) with lapse
   *  enabled, the DEM available, and a height plane present; otherwise the
   *  correction is cleared. A DEM fetch failure simply leaves lapse off for
   *  this unit — it never blocks the value drape. */
  private applyLapse(
    u: DrawUnit,
    vp: { bbox: string; lonSpan: number; latSpan: number },
    win: Window,
  ): void {
    const inst = this.inst.get(u.key);
    if (!inst) return;
    const on =
      (u.layer.lapse ?? true) &&
      this.demAvailable &&
      isLapseVar(u.layer.variable) &&
      !!win.height;
    const zoom = pickTerrariumZoom(this.map.getZoom());
    // Gate: skip when neither the on-state nor the (bbox, zoom) changed — this
    // runs every vsync, and setLapse would otherwise re-issue the DEM fetch +
    // re-upload z textures each frame. The pending fetch below still calls
    // setLapse when it resolves, so a same-key re-entry early-returning is fine.
    const gk = lapseGateKey(on, vp.bbox, zoom);
    if (this.lastLapseKey.get(u.key) === gk) return;
    this.lastLapseKey.set(u.key, gk);
    if (!on) {
      inst.setLapse(null, null, LAPSE_GAMMA, false);
      return;
    }
    void this.ensureDem(vp).then((zsite) => {
      // Viewport moved on while the DEM fetch was in flight — the window is
      // for a stale bbox; a fresh applyPlayhead already re-issued it.
      if (vp.bbox !== this.lastBbox) return;
      const live = this.inst.get(u.key);
      if (!live) return;
      // z_model rides the CURRENT window (the one on screen when the DEM
      // lands), not the possibly-stale `win` captured at call time.
      const cur = this.lastWin.get(u.key) ?? win;
      const zmodel = heightWindow(cur);
      if (zsite && zmodel) {
        live.setLapse(zsite, zmodel, LAPSE_GAMMA, true);
        return;
      }
      live.setLapse(null, null, LAPSE_GAMMA, false);
      // A TRANSIENT DEM failure (not the latched-off case) must not freeze
      // lapse off until the viewport changes — drop the gate so the next
      // applyPlayhead retries. The latched case keeps the gate, else this
      // would spin a per-vsync repaint loop.
      if (zsite === null && this.demAvailable) this.lastLapseKey.delete(u.key);
    });
  }

  /** Globe terrain drape for one rendering unit: hand it the shared z_site DEM
   *  so its mesh hugs the relief (surface fields, subtle hillshade) or floats
   *  above it (atmospheric fields — clouds, upper-air). Flat mode (or the DEM
   *  latched unavailable) clears it; a DEM fetch failure just leaves the drape
   *  un-lifted — it never blocks the value drape. */
  private applyTerrain(
    u: DrawUnit,
    vp: { bbox: string; lonSpan: number; latSpan: number },
  ): void {
    const inst = this.inst.get(u.key);
    if (!inst) return;
    const on = this.demAvailable && this.map.getProjection?.()?.type === "globe";
    const gk = `${on}|${vp.bbox}|${pickTerrariumZoom(this.map.getZoom())}`;
    if (this.lastTerrainKey.get(u.key) === gk) return;
    this.lastTerrainKey.set(u.key, gk);
    if (!on) {
      inst.setTerrainDrape(null, 0, 0);
      return;
    }
    void this.ensureDem(vp).then((zsite) => {
      if (vp.bbox !== this.lastBbox) return;
      const live = this.inst.get(u.key);
      if (!live) return;
      const lift = terrainLiftM(u.layer.variable);
      live.setTerrainDrape(zsite, lift, lift === 0 ? TERRAIN_SHADE : 0);
      // Transient DEM failure → drop the gate so the next applyPlayhead
      // retries (the latched-off case keeps it — see applyLapse).
      if (!zsite && this.demAvailable) this.lastTerrainKey.delete(u.key);
    });
  }

  private applyProps(inst: WxV2Layer, u: DrawUnit, win: Window): void {
    const l = u.layer;
    if (l.mode === "flow") return; // flow units never reach the drape loop
    inst.setMode(l.mode);
    inst.setInterp(l.interp ?? 0);
    inst.setOpacity(l.opacity);
    inst.setRange(l.vmin, l.vmax);
    const stops = colormapStops(l.colormap);
    // Keep each stop's own alpha (no 255 override): the palettes encode
    // transparency — precip/prob at 0 is fully transparent so the basemap reads
    // through "no rain", cloud/solar/snow/vertical_wind/radar carry alpha ramps,
    // and the shader multiplies this per-stop alpha by the layer opacity (NaN
    // nodata is already discarded there). rampForLayer BAKES temperature bands
    // into the texture (aligned to the legend's integer-°C boundaries) so the
    // drape steps like the legend; setLog matches the legend's log precip axis.
    inst.setColormap(
      stops
        ? rampForLayer(stops, {
            stepped: l.stepped,
            units: l.units,
            vmin: l.vmin,
            vmax: l.vmax,
          })
        : GRAY,
    );
    inst.setLog(isLogColormap(l.colormap));
    // Composite feather: fade alpha over the 50 km band inside the contributor's
    // footprint. 0 → no feather (single drape or the global base).
    inst.setFeather(u.featherKm, u.domain);
    if (l.mode === "contour") {
      const dr = dataRange(win.values, win.nodata, win.scale, win.offset);
      const interval =
        l.contourInterval && l.contourInterval > 0
          ? l.contourInterval
          : dr
            ? contourInterval(dr.lo, dr.hi)
            : contourInterval(l.vmin, l.vmax);
      inst.setContourState({
        interval,
        base: 0,
        lineMode: l.contourSingle ? 1 : 0,
        lineColor: l.contourColor ?? [1, 1, 1, 0.95],
        fillOn: l.contourFill ?? false,
        widthPx: 1.5,
      });
    }
  }
}

/** Wrap a /data window's optional height plane (z_model, int16 meters) into
 *  the Window shape setLapse consumes — same grid as the value window, so the
 *  lapse shader's shared sampling kernel indexes it exactly. */
export function heightWindow(win: Window): Window | null {
  if (!win.height || win.height.length !== win.grid.nx * win.grid.ny) return null;
  return {
    model: win.model,
    variable: "z_model",
    grid: win.grid,
    values: win.height,
    scale: 1,
    offset: 0,
    nodata: -32768,
  };
}
