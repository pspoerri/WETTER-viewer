/**
 * WeatherMapV2 — the v2 native-grid renderer for App.tsx, replacing the v1
 * WeatherMap's PNG-tile/style.json/anim/flow core. It honors the same Props +
 * WeatherMapHandle contract App already drives, but delegates the weather draw
 * to wxLayerManager (GPU bbox-window drape + in-shader contours) and keeps only a
 * raster basemap, value-mode GeoJSON, camera/click/hover, and the handle.
 *
 * Smooth GPU playback is wired: setPlayhead tweens between frames, backed by a
 * window buffer + frame prefetch + readiness gate in wxLayerManager. Wind
 * flow (streamlines) and barbs are rendered via the manager / refreshBarbs.
 * 3D terrain (MapLibre raster-dem setTerrain + hillshade, Mapterhorn tiles)
 * follows the `terrain` prop; a pinned run (`selectedRun`) rides every data
 * request as ?run=.
 */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { BASE_MAPS } from "../api/types";
import type { BaseMapId, ProjectionId, WeatherStyle } from "../api/types";
import {
  mergeBasemapStyles,
  patchBasemapStyle,
  stripTextHalos,
  fetchStyleJson,
  buildProtomapsStyles,
  type AnyStyle,
} from "../lib/basemapStyle";
import { splitEnsembleVar } from "../api/types";
import { parseThresholdId } from "../api/distIds";
import type { MapLayer } from "../api/mapConfig";
import { gridWindComponents, windowAggFor } from "../api/mapConfig";
import { barbGlyph } from "../lib/windBarbGlyph.ts";
import { mergeWindGrids, barbBucketName } from "../lib/windBarbs.ts";
import type { AvailableVariable } from "../api/v2catalog";
import type { Variable } from "../api/types";
import { describeVar } from "../api/varDisplay";
import { modelInfoFor } from "../api/modelInfo";
import type { WindowMode, TimeWindow } from "../time";
import { WxLayerManager, type ManagedLayer } from "../lib/wxLayerManager.ts";
import { v2GridUrl } from "../api/v2client.ts";
import { TERRARIUM_TILEJSON_URL } from "../lib/terrainZsite.ts";
import { FRONT_ANCHOR_KEY } from "../lib/basemapStyle.ts";

// Dark strokes to match maplibre's stock icons — App.css light-flips the whole
// button via filter: invert(0.82).
const GLOBE_ICON = `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#333" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3.5 9h17M3.5 15h17"/></svg>`;
const FLAT_ICON = `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#333" stroke-width="1.7"><path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z"/><path d="M9 4v14M15 6v14"/></svg>`;

/** Map control toggling globe ↔ flat projection, docked below the geolocate
 *  button. State (icon/title) follows the projection prop via setGlobe. */
class ProjectionToggleControl implements maplibregl.IControl {
  private container: HTMLDivElement | null = null;
  private btn: HTMLButtonElement | null = null;
  private globe = false;
  private onToggle: () => void;
  constructor(onToggle: () => void) {
    this.onToggle = onToggle;
  }
  onAdd(): HTMLElement {
    this.container = document.createElement("div");
    this.container.className = "maplibregl-ctrl maplibregl-ctrl-group";
    this.btn = document.createElement("button");
    this.btn.type = "button";
    this.btn.className = "wx-projection-toggle";
    this.btn.addEventListener("click", () => this.onToggle());
    this.container.appendChild(this.btn);
    this.sync();
    return this.container;
  }
  onRemove(): void {
    this.container?.remove();
    this.container = null;
    this.btn = null;
  }
  setGlobe(globe: boolean): void {
    this.globe = globe;
    this.sync();
  }
  private sync(): void {
    if (!this.btn) return;
    const title = this.globe ? "Switch to flat map" : "Switch to globe";
    this.btn.title = title;
    this.btn.setAttribute("aria-label", title);
    this.btn.innerHTML = this.globe ? FLAT_ICON : GLOBE_ICON;
  }
}

/** Imperative handle App.tsx drives (camera + play loop). setPlayhead/setPlaying
 *  delegate to wxLayerManager for fractional GPU-tween playback. */
export interface WeatherMapHandle {
  map: maplibregl.Map | null;
  waitForFrameReady(idx: number, timeoutMs?: number): Promise<void>;
  isFrameReady(idx: number): boolean;
  setPlayhead(t: number): void;
  setPlaying(playing: boolean): void;
  setView(view: {
    center: [number, number];
    zoom: number;
    bearing?: number;
    pitch?: number;
  }): void;
  flyTo(target: {
    center: [number, number];
    zoom?: number;
    bbox?: [number, number, number, number];
  }): void;
}

interface Props {
  baseMap: BaseMapId;
  projection: ProjectionId;
  onProjectionChange?: (projection: ProjectionId) => void;
  /** 3D terrain toggle: MapLibre raster-dem setTerrain (with exaggeration)
   *  + hillshade from the Mapterhorn terrarium tiles. */
  terrain?: boolean;
  hdr: boolean;
  weatherStyle: WeatherStyle | null;
  activeTimestep: number;
  layers: MapLayer[];
  selectedModel: string;
  /** Pinned run id (run browser) — sent as ?run= on every data/grid/meta
   *  request for the selected model. Empty/undefined = latest. */
  selectedRun?: string;
  availableVariables?: AvailableVariable[];
  unitPrefs?: Record<string, string>;
  onMapClick?: (lat: number, lon: number) => void;
  onMapHover?: (
    info: { lat: number; lon: number; x: number; y: number } | null,
  ) => void;
  clickPoint?: { lat: number; lon: number } | null;
  onGpuLoadingChange?: (loading: boolean) => void;
  /** E5: fired once the shared z_site DEM's availability is known this
   *  session (success or a 404) — gates the legend's per-layer ⛰ toggle. */
  onDemAvailabilityChange?: (available: boolean) => void;
  /** The latest run for a visible model changed upstream (watchdog). */
  onRunFlip?: (model: string) => void;
  initialView?: {
    center: [number, number];
    zoom: number;
    bearing?: number;
    pitch?: number;
  };
  onViewChange?: (view: {
    center: [number, number];
    zoom: number;
    bearing: number;
    pitch: number;
  }) => void;
  windowMode?: WindowMode;
  activeWindow?: TimeWindow | null;
}

/** Build or fetch the back + front basemap styles and merge them into one
 *  document (see lib/basemapStyle.ts) — the front's borders/water/labels render
 *  above the weather drapes via the recorded front-anchor layer id. Also strips
 *  plain-text source attribution — the AttributionControl supplies a LINKED
 *  OpenStreetMap credit plus the loaded model's data provider(s) instead. */
async function fetchBasemapStyle(
  baseMap: BaseMapId,
): Promise<maplibregl.StyleSpecification> {
  const cfg = BASE_MAPS[baseMap];
  let back: AnyStyle | null;
  let front: AnyStyle | null;
  if (cfg.flavor) {
    // Standard flavors: generated from @protomaps/basemaps and split
    // programmatically into back (fills) / front (lines + labels).
    ({ back, front } = buildProtomapsStyles(cfg.flavor));
  } else {
    // Custom flavors (summer / winter): authored documents vendored in
    // public/styles.
    [back, front] = await Promise.all([
      fetchStyleJson(`${baseMap}-back`),
      fetchStyleJson(`${baseMap}-front`).catch(() => null), // front optional: back-only fallback
    ]);
  }
  if (!back) throw new Error(`basemap fetch failed: ${baseMap}`);
  patchBasemapStyle(back);
  if (front) {
    patchBasemapStyle(front);
    // Above-drape labels drop their halo outline (noise over the drape).
    stripTextHalos(front);
  }
  const style = mergeBasemapStyles(back, front);
  for (const src of Object.values(style.sources ?? {})) {
    delete (src as { attribution?: string }).attribution;
  }
  return style as maplibregl.StyleSpecification;
}

/** Distinct data-source providers for the selected model — a composite
 *  (auto / auto_eps) expands to its contributors, so `auto` (which blends DWD and
 *  MeteoSwiss models) credits both; a physical model credits only its own. */
function modelProviders(model: string): { name: string; url?: string }[] {
  const info = modelInfoFor(model);
  const ids = info.contributors?.length ? info.contributors : [model];
  const seen = new Set<string>();
  const out: { name: string; url?: string }[] = [];
  for (const id of ids) {
    const ci = modelInfoFor(id);
    if (!ci.provider || seen.has(ci.provider)) continue;
    seen.add(ci.provider);
    out.push({ name: ci.provider, url: ci.providerUrl });
  }
  return out;
}

/** Attribution-bar entries: a linked OpenStreetMap credit followed by each
 *  currently-loaded weather data provider (DWD / MeteoSwiss / both). The
 *  Mapterhorn DEM credit is NOT listed here — the terrain-dem TileJSON
 *  carries its own attribution, which MapLibre surfaces automatically
 *  whenever the source is in use (adding it here too duplicated the credit
 *  after a terrain toggle). */
function attributionEntries(model: string): string[] {
  const link = (href: string, text: string) =>
    `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  const entries = [
    link("https://www.openstreetmap.org", "© OpenStreetMap contributors"),
  ];
  for (const p of modelProviders(model)) {
    entries.push(p.url ? link(p.url, `© ${p.name}`) : `© ${p.name}`);
  }
  return entries;
}

/** Strip a product suffix (_gt/_lt chance, _mean, _spread, _ctrl, _p{N}, _m{N})
 *  to the base variable id, for the catalog lookup. The full id is what's sent
 *  to the backend — only the legend window (vmin/vmax/colormap) needs the base. */
function productBase(id: string): string {
  const thr = parseThresholdId(id);
  if (thr) return thr.base;
  if (id.endsWith("_spread")) return id.slice(0, -"_spread".length);
  if (id.endsWith("_mean")) return id.slice(0, -"_mean".length);
  return splitEnsembleVar(id).base; // _ctrl / _p{N} / _m{N} / bare
}

/** Resolve an App MapLayer to the manager's ManagedLayer. The FULL product id
 *  (t_2m_mean, t_2m_p90, tot_prec_gt2p5mm) is sent to the backend, which
 *  resolves the ensemble product (plane) or chance-of (member count) from the
 *  suffix — so the frontend no longer computes a plane index. Chance-of renders
 *  a 0..1 probability field with the `prob` colormap; the legend window for
 *  every other product comes from the base variable's catalog entry. A non-hourly
 *  window mode reduces the active tz-aware calendar bucket (`activeWindow`) — a
 *  per-day (or 3h/6h/12h) reduction over that bucket's own frames. */
function toManaged(
  layer: MapLayer,
  model: string,
  catalog: Map<string, AvailableVariable>,
  windowMode: WindowMode | undefined,
  activeWindow: TimeWindow | null | undefined,
): ManagedLayer | null {
  if (!layer.visible) return null;
  if (layer.displayMode === "flow") {
    // Streamlines: the manager fetches the (u_10m, v_10m) pair itself; the
    // layer's own variable/colormap/range play no part in rendering.
    return {
      id: layer.id,
      model,
      variable: layer.variable,
      mode: "flow",
      opacity: layer.opacity ?? 1,
      colormap: "",
      vmin: 0,
      vmax: 1,
      flowParticles: layer.flowParticles,
    };
  }
  if (layer.displayMode !== "tiles" && layer.displayMode !== "contour") {
    return null; // value + barbs are drawn outside the manager (see refreshValues/refreshBarbs)
  }
  const isChance = parseThresholdId(layer.variable) != null;
  const av = catalog.get(productBase(layer.variable));
  // Windowed reduction is active only in a non-hourly mode with a resolved bucket.
  const windowed =
    !!windowMode && windowMode !== "hourly" && !!activeWindow;
  return {
    id: layer.id,
    model,
    variable: layer.variable, // FULL product id — the backend resolves the suffix
    mode: layer.displayMode === "contour" ? "contour" : "drape",
    opacity: layer.opacity ?? 1,
    interp: layer.interp,
    colormap: isChance ? "prob" : (layer.colormap ?? av?.default_colormap ?? ""),
    vmin: isChance ? 0 : (av?.vmin ?? 0),
    vmax: isChance ? 1 : (av?.vmax ?? 1),
    // Drive the legend-matching drape: `units` (Kelvin → stepped temperature
    // bands) + `stepped` override are forwarded so the GPU ramp bakes the same
    // bands the legend shows. Chance-of is a 0..1 `prob` field — force units ""
    // so it never steps (the prob palette isn't a temperature ladder).
    units: isChance ? "" : av?.units,
    stepped: isChance ? false : layer.stepped,
    contourInterval: layer.contourInterval,
    contourSingle: !!layer.contourColor && layer.contourColor !== "#ffffff",
    contourColor: [1, 1, 1, 0.95],
    contourFill: false,
    // The manager maps [windowStartMs, windowEndMs) to this layer's own frames
    // (framesInSpan) and reduces them with the op — a calendar-bucket reduction,
    // not a rolling trailing window. windowAggFor resolves the op in priority
    // order: chance-of (_gt/_lt threshold ids) always forces "max" — the
    // documented PEAK semantics, matching the point/hover path's implicit-peak
    // form; precip-total layers (precip_{N}h; tot_prec is canonicalised to
    // precip_1h at layer creation) sum their de-accumulated hourly rates into
    // the window TOTAL, matching the point path's precip_{N}h accumulation
    // (pointVarForLayer); everything else falls back to the layer's own aggOp
    // or the variable's advertised default.
    agg: windowed ? windowAggFor(layer, catalog) : undefined,
    windowStartMs: windowed ? activeWindow!.startMs : undefined,
    windowEndMs: windowed ? activeWindow!.endMs : undefined,
    // E5: the layer's ⛰ toggle (reuses the existing point-query `lapse`
    // field — "off" ⇒ raw model value, anything else ⇒ the drape default).
    lapse: layer.lapse !== "off",
  };
}

// ---- wind-barb icon factory ----------------------------------------------
// One canvas image per rounded-5-kt bucket, added to the map once and reused
// across features/refreshes (map.hasImage guards re-creation). The glyph is
// drawn pointing NORTH (staff up the −Y axis, the station point at the image
// centre); the symbol layer's icon-rotate then swings the whole glyph to the
// wind's meteorological FROM bearing (icon-rotation-alignment:"map"), so the
// staff points INTO the wind — the exact convention v1's renderClickBarbs uses
// (SVG glyph pointing up, transform="rotate(fromBearingDeg(u,v))").
const BARB_GLYPH_RADIUS = 18; // glyph-space half-extent the icon must contain
const BARB_SUPERSAMPLE = 3; // draw ×3, declared via pixelRatio → crisp on HiDPI

/** Parse a barbGlyph pennant `points` string ("x,y x,y x,y") into a path. */
function fillPennant(ctx: CanvasRenderingContext2D, pts: string) {
  const nums = pts.trim().split(/\s+/).map((p) => p.split(",").map(Number));
  if (nums.length < 3) return;
  ctx.beginPath();
  ctx.moveTo(nums[0][0], nums[0][1]);
  for (let i = 1; i < nums.length; i++) ctx.lineTo(nums[i][0], nums[i][1]);
  ctx.closePath();
  ctx.fill();
}

function drawBarbParts(
  ctx: CanvasRenderingContext2D,
  parts: ReturnType<typeof barbGlyph>,
  color: string,
  lineWidth: number,
) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lineWidth;
  if (parts.calm) {
    ctx.beginPath();
    ctx.arc(0, 0, 3, 0, 2 * Math.PI);
    ctx.stroke();
    return;
  }
  for (const [x1, y1, x2, y2] of parts.lines) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  for (const pts of parts.pennants) fillPennant(ctx, pts);
}

/** Ensure the barb icon for `speedKt`'s bucket exists on the map; returns its
 *  image name (for the feature `icon` property). */
function ensureBarbImage(map: maplibregl.Map, speedKt: number): string {
  const name = barbBucketName(speedKt);
  if (map.hasImage(name)) return name;
  const parts = barbGlyph(speedKt);
  const R = BARB_GLYPH_RADIUS;
  const SS = BARB_SUPERSAMPLE;
  const size = 2 * R * SS;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return name;
  ctx.scale(SS, SS);
  ctx.translate(R, R); // origin = station point at the image centre
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  drawBarbParts(ctx, parts, "rgba(12,16,24,0.85)", 2.4); // dark halo
  drawBarbParts(ctx, parts, "rgba(255,255,255,0.95)", 1.1); // barb
  const img = ctx.getImageData(0, 0, size, size);
  map.addImage(
    name,
    { width: size, height: size, data: img.data },
    { pixelRatio: SS },
  );
  return name;
}

const WeatherMapV2 = forwardRef<WeatherMapHandle, Props>(function WeatherMapV2(
  props,
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const mgrRef = useRef<WxLayerManager | null>(null);
  const playingRef = useRef(false); // true while TimeBar drives setPlayhead at vsync
  const baseMapRef = useRef<BaseMapId>(props.baseMap);
  const attribRef = useRef<maplibregl.AttributionControl | null>(null);
  const clickMarkerRef = useRef<maplibregl.Marker | null>(null);
  // One AbortController per GeoJSON overlay: each refresh aborts the previous
  // in-flight fetch so a slow older response (from a stale viewport/frame) can't
  // land after a newer one and overwrite the source — last-write-wins + no wasted
  // bandwidth on zoom/pan/frame/layer changes.
  const valuesAbortRef = useRef<AbortController | null>(null);
  const barbsAbortRef = useRef<AbortController | null>(null);

  // (Re)build the attribution control so it tracks the selected model + terrain
  // state: a linked OpenStreetMap credit, the loaded weather provider(s)
  // (DWD / MeteoSwiss), and © Mapterhorn while the DEM is in use (globe mode).
  const applyAttribution = (map: maplibregl.Map, model: string) => {
    if (attribRef.current) {
      try {
        map.removeControl(attribRef.current);
      } catch {
        /* control already detached */
      }
      attribRef.current = null;
    }
    const ctrl = new maplibregl.AttributionControl({
      compact: true,
      customAttribution: attributionEntries(model),
    });
    map.addControl(ctrl);
    attribRef.current = ctrl;
  };

  // Mirror props the once-registered map handlers read.
  const p = useRef(props);
  p.current = props;

  const projectionCtlRef = useRef<ProjectionToggleControl | null>(null);

  // Apply the current projection + terrain to the map (the Mapterhorn
  // terrain-example pattern: a raster-dem source in terrarium encoding, a
  // hillshade layer, and setTerrain for 3D exaggeration):
  // - the TERRAIN TOGGLE drives MapLibre's 3D relief (setTerrain with
  //   exaggeration) in either projection;
  // - the hillshade layer renders whenever terrain is on OR the globe is
  //   active (so relief reads where no ground drape covers it — clouds-only
  //   views, bare basemap).
  // Must run only with a loaded style (setProjection/addSource throw otherwise).
  const applyProjection = (map: maplibregl.Map) => {
    const globe = p.current.projection === "globe";
    const terrain3d = !!p.current.terrain;
    map.setProjection({ type: globe ? "globe" : "mercator" });
    if (globe || terrain3d) {
      if (!map.getSource("terrain-dem")) {
        map.addSource("terrain-dem", {
          type: "raster-dem",
          encoding: "terrarium",
          url: TERRARIUM_TILEJSON_URL, // carries the Mapterhorn attribution
          tileSize: 512,
        });
      }
      if (!map.getLayer("wx-basemap-hillshade")) {
        // Below every weather drape: before the first custom layer if drapes
        // already exist, else before the front-overlay anchor they insert at.
        const style = map.getStyle();
        const anchor = (style?.metadata as Record<string, unknown> | undefined)?.[
          FRONT_ANCHOR_KEY
        ];
        // getStyle() DOES list custom layers at runtime, but the spec union
        // omits type "custom" — hence the loose cast.
        const styleLayers = (style?.layers ?? []) as { id: string; type: string }[];
        const before =
          styleLayers.find((l) => l.type === "custom")?.id ??
          (typeof anchor === "string" && map.getLayer(anchor) ? anchor : undefined);
        map.addLayer(
          {
            id: "wx-basemap-hillshade",
            type: "hillshade",
            source: "terrain-dem",
            // Kept faint: ground drapes carry their own Lambert shading, and
            // the two stack wherever a drape covers the basemap.
            paint: { "hillshade-exaggeration": 0.1 },
          },
          before,
        );
      }
    } else {
      if (map.getLayer("wx-basemap-hillshade")) map.removeLayer("wx-basemap-hillshade");
    }
    // 3D exaggeration follows the terrain TOGGLE (the reference tracked the
    // flag but never applied it — now wired per the Mapterhorn example).
    if (terrain3d) {
      map.setTerrain({ source: "terrain-dem", exaggeration: 1.1 });
    } else if (map.getTerrain()) {
      map.setTerrain(null);
    }
    projectionCtlRef.current?.setGlobe(globe);
    // Terrain state changed → rebuild the attribution bar (© Mapterhorn rides
    // the DEM being in use).
    applyAttribution(map, p.current.selectedModel);
    // No camera event fires on a projection swap, but the visible area changes
    // (the globe horizon overflows the mercator viewport) — kick the manager's
    // moveend refetch so the drape covers the new projection's extent.
    map.fire("moveend");
  };

  const primaryTimesteps = () =>
    p.current.weatherStyle?.metadata["weather-api:timesteps"] ?? [];

  const catalogMap = () =>
    new Map((p.current.availableVariables ?? []).map((v) => [v.name, v]));

  // Push the current layer list into the manager + refresh the value layer.
  const syncLayers = () => {
    const mgr = mgrRef.current;
    if (!mgr) return;
    const cat = catalogMap();
    const managed = p.current.layers
      .map((l) =>
        toManaged(
          l,
          p.current.selectedModel,
          cat,
          p.current.windowMode,
          p.current.activeWindow,
        ),
      )
      .filter((m): m is ManagedLayer => m != null);
    mgr.setLayers(managed);
    void refreshValues();
    void refreshBarbs();
  };

  // Value mode: render the topmost visible `value` layer as GeoJSON symbols.
  const refreshValues = async () => {
    const map = mapRef.current;
    if (!map || !map.getSource("wx-v2-values")) return;
    const src = map.getSource("wx-v2-values") as maplibregl.GeoJSONSource;
    // Supersede any in-flight value fetch — its response is now stale.
    valuesAbortRef.current?.abort();
    const ac = new AbortController();
    valuesAbortRef.current = ac;
    const layer = p.current.layers.find(
      (l) => l.visible && l.displayMode === "value",
    );
    if (!layer) {
      src.setData({ type: "FeatureCollection", features: [] });
      return;
    }
    const b = map.getBounds();
    const bbox = `${b.getSouth().toFixed(4)},${b.getWest().toFixed(4)},${b.getNorth().toFixed(4)},${b.getEast().toFixed(4)}`;
    const lonSpan = Math.max(0.5, b.getEast() - b.getWest());
    const ts = primaryTimesteps();
    const time = Math.min(p.current.activeTimestep, Math.max(0, ts.length - 1));
    try {
      const res = await fetch(
        // Full product id (incl. chance-of _gt/_lt); the backend resolves the
        // suffix, so no plane index is sent.
        v2GridUrl(p.current.selectedModel, layer.variable, {
          bbox,
          spacing: Math.max(0.1, lonSpan / 22),
          timesteps: ts,
          time,
          run: p.current.selectedRun || undefined,
        }),
        { signal: ac.signal },
      );
      if (!res.ok) return;
      const fc = (await res.json()) as GeoJSON.FeatureCollection;
      // The /grid value is the backend's raw SI value (Kelvin, Pa, m/s, …); the
      // symbol label must show the user's display unit (°C, hPa, …), the same
      // conversion the hover readout applies — otherwise t_2m reads "285" not "12".
      const d = describeVar(
        layer.variable,
        (p.current.availableVariables ?? []) as unknown as Variable[],
        p.current.unitPrefs ?? {},
      );
      for (const f of fc.features) {
        const v = f.properties?.value;
        if (typeof v === "number" && f.properties) f.properties.value = d.convert(v);
      }
      if (ac.signal.aborted) return;
      src.setData(fc);
    } catch {
      /* ignore */
    }
  };

  // Barb mode: render the topmost visible `barbs` layer's (u_10m, v_10m) wind
  // grid as rotated barb symbols with a speed label. Same three refresh
  // triggers as refreshValues (syncLayers, active frame, moveend). u and v are
  // fetched as two separate single-scalar /grid calls (v2 /grid serves one
  // value per feature) with identical bbox/spacing/time and merged client-side
  // by coordinate — see mergeWindGrids for why coordinate-keyed, not index.
  const refreshBarbs = async () => {
    const map = mapRef.current;
    if (!map || !map.getSource("wx-v2-barbs")) return;
    const src = map.getSource("wx-v2-barbs") as maplibregl.GeoJSONSource;
    // Supersede any in-flight barb fetch pair — its response is now stale.
    barbsAbortRef.current?.abort();
    const ac = new AbortController();
    barbsAbortRef.current = ac;
    const empty: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: [],
    };
    const layer = p.current.layers.find(
      (l) => l.visible && l.displayMode === "barbs",
    );
    const comps = layer ? gridWindComponents(layer) : null;
    if (!layer || !comps) {
      src.setData(empty);
      return;
    }
    const [uVar, vVar] = comps;
    const b = map.getBounds();
    const bbox = `${b.getSouth().toFixed(4)},${b.getWest().toFixed(4)},${b.getNorth().toFixed(4)},${b.getEast().toFixed(4)}`;
    const lonSpan = Math.max(0.5, b.getEast() - b.getWest());
    // gridSpacing is CSS px between adjacent barbs; convert to degrees via the
    // current viewport width. Fall back to the value-mode spacing derivation.
    const cssW = map.getCanvas().clientWidth || 1;
    const spacing = layer.gridSpacing
      ? Math.max(0.05, (layer.gridSpacing * lonSpan) / cssW)
      : Math.max(0.1, lonSpan / 22);
    const ts = primaryTimesteps();
    const time = Math.min(p.current.activeTimestep, Math.max(0, ts.length - 1));
    const gridOpts = {
      bbox,
      spacing,
      timesteps: ts,
      time,
      run: p.current.selectedRun || undefined,
    };
    const iconScale = layer.iconScale ?? 1;
    try {
      const [uRes, vRes] = await Promise.all([
        fetch(v2GridUrl(p.current.selectedModel, uVar, gridOpts), { signal: ac.signal }),
        fetch(v2GridUrl(p.current.selectedModel, vVar, gridOpts), { signal: ac.signal }),
      ]);
      if (!uRes.ok || !vRes.ok) return;
      const [uFC, vFC] = await Promise.all([uRes.json(), vRes.json()]);
      const points = mergeWindGrids(uFC, vFC);
      // Speed label in the user's display units (same convert the hover readout
      // and value mode apply). uVar is a wind-group var, so its converter maps
      // the m/s magnitude to the active wind unit (km/h / kt / …).
      const d = describeVar(
        uVar,
        (p.current.availableVariables ?? []) as unknown as Variable[],
        p.current.unitPrefs ?? {},
      );
      const features: GeoJSON.Feature[] = points.map((pt) => ({
        type: "Feature",
        properties: {
          icon: ensureBarbImage(map, pt.speedKt),
          direction: pt.direction,
          iconSize: iconScale,
          label: String(Math.round(d.convert(pt.speed))),
        },
        geometry: { type: "Point", coordinates: [pt.lon, pt.lat] },
      }));
      if (ac.signal.aborted) return;
      src.setData({ type: "FeatureCollection", features });
    } catch {
      /* ignore */
    }
  };

  // Value source + symbol layer (guarded against duplicate adds on
  // styledata/HMR re-runs — an unguarded addSource throws "Source already
  // exists" and aborts the whole re-init, blanking every layer). Per-feature
  // `value`, formatted with no fractional digits.
  const addValuesLayer = (map: maplibregl.Map) => {
    if (map.getSource("wx-v2-values")) return;
    map.addSource("wx-v2-values", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addLayer({
      id: "wx-v2-values-sym",
      type: "symbol",
      source: "wx-v2-values",
      layout: {
        "text-field": ["number-format", ["get", "value"], { "max-fraction-digits": 0 }],
        "text-size": 11,
      },
      paint: {
        "text-color": "#ffffff",
        "text-halo-color": "#0c1018",
        "text-halo-width": 1.3,
      },
    });
  };

  // Barb source + symbol layer (guarded like the value layer against duplicate
  // adds on styledata/HMR re-runs). Per-feature `icon`/`direction`/`iconSize`/
  // `label`; icon-rotation-alignment:"map" keeps barbs oriented to the ground.
  const addBarbsLayer = (map: maplibregl.Map) => {
    if (map.getSource("wx-v2-barbs")) return;
    map.addSource("wx-v2-barbs", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addLayer({
      id: "wx-v2-barbs-sym",
      type: "symbol",
      source: "wx-v2-barbs",
      layout: {
        "icon-image": ["get", "icon"],
        "icon-rotate": ["get", "direction"],
        "icon-rotation-alignment": "map",
        "icon-allow-overlap": true,
        "icon-size": ["get", "iconSize"],
        "text-field": ["get", "label"],
        "text-size": 10,
        "text-offset": [0, 1.4],
        "text-anchor": "top",
        "text-optional": true,
      },
      paint: {
        "text-color": "#ffffff",
        "text-halo-color": "#0c1018",
        "text-halo-width": 1.2,
      },
    });
  };

  // Click point marker: show a marker at the clicked/geocoded point while
  // PointPopup is open, remove it when the point is cleared. Reads clickPoint
  // from the props ref (not a closure) so it's safe to call from the map-ready
  // path (initLayers) too — a clickPoint set before the async basemap fetch
  // resolves mapRef.current must not be dropped silently (ref mutation doesn't
  // re-render, so the effect below never re-fires once the map appears).
  const syncClickMarker = () => {
    const map = mapRef.current;
    if (!map) return;
    clickMarkerRef.current?.remove();
    clickMarkerRef.current = null;
    const cp = p.current.clickPoint;
    if (!cp) return;
    const el = document.createElement("div");
    el.className = "click-indicator";
    clickMarkerRef.current = new maplibregl.Marker({ element: el })
      .setLngLat([cp.lon, cp.lat])
      .addTo(map);
  };

  // ---- create the map once (async: build the basemap first) ----
  useEffect(() => {
    let disposed = false;
    const iv = p.current.initialView;

    // Attach the custom layers + camera/click/hover handlers to a fresh map.
    const wireMap = (map: maplibregl.Map) => {
      // Standard MapLibre controls: zoom/compass (NavigationControl) + "find my
      // location" (GeolocateControl), matching the v1 map.
      map.addControl(
        new maplibregl.NavigationControl({ visualizePitch: true }),
        "top-right",
      );
      map.addControl(
        new maplibregl.GeolocateControl({
          positionOptions: { enableHighAccuracy: true },
          trackUserLocation: true,
        }),
        "top-right",
      );
      // Globe ↔ flat toggle, below the geolocate button.
      const projCtl = new ProjectionToggleControl(() =>
        p.current.onProjectionChange?.(
          p.current.projection === "globe" ? "mercator" : "globe",
        ),
      );
      projectionCtlRef.current = projCtl;
      map.addControl(projCtl, "top-right");
      const initLayers = () => {
        applyProjection(map);
        mgrRef.current?.dispose();
        const mgr = new WxLayerManager(
          map,
          (loading) => p.current.onGpuLoadingChange?.(loading),
          (available) => p.current.onDemAvailabilityChange?.(available),
          (model) => p.current.onRunFlip?.(model),
        );
        mgr.setHdr(p.current.hdr);
        mgr.setPinnedRun(p.current.selectedModel, p.current.selectedRun ?? "");
        mgrRef.current = mgr;
        if (import.meta.env.DEV) {
          (window as unknown as { __wxmgr?: WxLayerManager }).__wxmgr = mgr;
        }
        addValuesLayer(map);
        addBarbsLayer(map);
        syncLayers();
        mgr.setFrame(p.current.activeTimestep, primaryTimesteps());
        syncClickMarker();
      };

      map.on("load", initLayers);

      map.on("click", (e) => {
        p.current.onMapClick?.(e.lngLat.lat, e.lngLat.lng);
      });
      map.on("mousemove", (e) => {
        p.current.onMapHover?.({
          lat: e.lngLat.lat,
          lon: e.lngLat.lng,
          x: e.point.x,
          y: e.point.y,
        });
      });
      map.on("mouseout", () => p.current.onMapHover?.(null));
      const reportView = () => {
        const c = map.getCenter();
        p.current.onViewChange?.({
          center: [c.lng, c.lat],
          zoom: map.getZoom(),
          bearing: map.getBearing(),
          pitch: map.getPitch(),
        });
      };
      map.on("moveend", reportView);
      map.on("moveend", () => void refreshValues());
      map.on("moveend", () => void refreshBarbs());
    };

    void fetchBasemapStyle(p.current.baseMap)
      .then((style) => {
        if (disposed || !containerRef.current) return;
        const map = new maplibregl.Map({
          container: containerRef.current,
          style,
          center: iv?.center ?? [10, 48],
          zoom: iv?.zoom ?? 4,
          bearing: iv?.bearing ?? 0,
          pitch: iv?.pitch ?? 0,
          attributionControl: false, // custom control supplies linked OSM + provider credits
        });
        mapRef.current = map;
        // Dev-only handle for headless QA probes (page.evaluate camera control).
        if (import.meta.env.DEV) {
          (window as unknown as { __wxmap?: maplibregl.Map }).__wxmap = map;
        }
        baseMapRef.current = p.current.baseMap;
        applyAttribution(map, p.current.selectedModel);
        wireMap(map);
      })
      .catch(() => {
        /* basemap fetch failed — map not created; the page still mounts */
      });

    return () => {
      disposed = true;
      mgrRef.current?.dispose();
      mgrRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Rebuild the basemap on baseMap change (setStyle wipes custom layers → re-init).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || baseMapRef.current === props.baseMap) return;
    baseMapRef.current = props.baseMap;
    const reinit = () => {
      const wasPlaying = mgrRef.current?.isPlaying() ?? false;
      mgrRef.current?.dispose();
      const mgr = new WxLayerManager(
        map,
        (l) => p.current.onGpuLoadingChange?.(l),
        (available) => p.current.onDemAvailabilityChange?.(available),
        (model) => p.current.onRunFlip?.(model),
      );
      mgr.setHdr(p.current.hdr);
      mgr.setPinnedRun(p.current.selectedModel, p.current.selectedRun ?? "");
      mgr.setPlaying(wasPlaying);
      mgrRef.current = mgr;
      if (import.meta.env.DEV) {
        // Keep the dev probe handle on the LIVE manager — a basemap change
        // disposes the old one, and probes against it read empty state.
        (window as unknown as { __wxmgr?: WxLayerManager }).__wxmgr = mgr;
      }
      applyProjection(map);
      // "styledata" can fire more than once per setStyle (and StrictMode/HMR
      // re-runs effects) — addValuesLayer/addBarbsLayer guard against re-adding.
      addValuesLayer(map);
      addBarbsLayer(map);
      syncLayers();
      mgr.setFrame(p.current.activeTimestep, primaryTimesteps());
    };
    // Rebuild strictly AFTER the new style is in. The old "first styledata"
    // trigger was a race: the outgoing manager's own addLayer fires styledata,
    // so reinit ran against the OLD style and setStyle then wiped the fresh
    // manager's layers whenever its async expand won the race — the drape
    // (and its lapse/terrain) silently vanished until reload.
    void fetchBasemapStyle(props.baseMap)
      .then((s) => {
        // Carry the active projection INTO the incoming style: a fetched
        // style without one makes setStyle's diff drop globe → the view
        // visibly snaps to mercator until reinit re-applies it ("the whole
        // map reprojects when a preset swaps the basemap").
        if (p.current.projection === "globe") {
          (s as { projection?: { type: string } }).projection = { type: "globe" };
        }
        map.once("style.load", reinit);
        map.setStyle(s);
      })
      .catch(() => {
        /* basemap fetch failed — keep the current style */
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.baseMap]);

  // Selected model change → refresh the data-provider attribution (DWD/MeteoSwiss/
  // both for the auto composite); the OSM basemap credit stays.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    applyAttribution(map, props.selectedModel);
  }, [props.selectedModel]);

  // Layers / model / catalog / window-mode change → re-sync the manager.
  useEffect(() => {
    syncLayers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    props.layers,
    props.selectedModel,
    props.availableVariables,
    props.windowMode,
    props.activeWindow,
  ]);

  // Active frame change → drive the manager + value layer. While playing, the
  // TimeBar rAF loop owns the drape via setPlayhead (fractional); skip the integer
  // setFrame here so the React-state echo doesn't stutter the tween each crossing.
  useEffect(() => {
    if (!playingRef.current) {
      mgrRef.current?.setFrame(props.activeTimestep, primaryTimesteps());
    }
    void refreshValues();
    void refreshBarbs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.activeTimestep, props.weatherStyle]);

  // HDR toggle → bias the manager's pyramid-level pick one step finer and
  // force a refetch. Map-init timing: if this fires before the map/manager
  // exist, the initLayers/reinit paths above pick up p.current.hdr when they
  // construct the manager, same as the clickPoint marker pattern below.
  useEffect(() => {
    mgrRef.current?.setHdr(props.hdr);
  }, [props.hdr]);

  // Projection / terrain toggles. setProjection/addSource throw on an
  // unloaded style, so a busy style defers the apply to the next idle
  // instead of silently dropping the toggle (the old early-return meant
  // the Terrain checkbox sometimes did nothing at all).
  const prevTerrainRef = useRef(!!props.terrain);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const was = prevTerrainRef.current;
    const now = !!props.terrain;
    prevTerrainRef.current = now;
    const run = () => {
      applyProjection(map);
      // 3D relief is invisible from straight above — tilt into it when the
      // toggle turns on (and level back out when it turns off) so the
      // switch always has a visible effect.
      if (now && !was && map.getPitch() < 5) {
        map.easeTo({ pitch: 60, duration: 900 });
      } else if (!now && was && map.getPitch() > 0) {
        map.easeTo({ pitch: 0, duration: 600 });
      }
    };
    if (map.isStyleLoaded()) {
      run();
      return;
    }
    map.once("idle", run);
    return () => {
      map.off("idle", run);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.projection, props.terrain]);

  // Pinned-run change → re-key the manager's caches + refetch, and refresh
  // the GeoJSON overlays (they carry ?run= too).
  useEffect(() => {
    mgrRef.current?.setPinnedRun(props.selectedModel, props.selectedRun ?? "");
    void refreshValues();
    void refreshBarbs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.selectedRun, props.selectedModel]);

  // Re-sync the marker whenever clickPoint changes. (If the map isn't ready
  // yet, syncClickMarker no-ops here and the map-ready path above — initLayers
  // — picks it up from p.current.clickPoint once the map exists.)
  useEffect(() => {
    syncClickMarker();
  }, [props.clickPoint]);

  // Unmount-only cleanup: remove the marker when the map itself is torn down.
  // (Kept as its own empty-dep effect so it does NOT fire on every clickPoint
  // change — syncClickMarker already handles remove+recreate for those.)
  useEffect(() => {
    return () => {
      clickMarkerRef.current?.remove();
      clickMarkerRef.current = null;
    };
  }, []);

  useImperativeHandle(
    ref,
    (): WeatherMapHandle => ({
      get map() {
        return mapRef.current;
      },
      // Delegate playback to the layer manager: fractional GPU tween + window
      // tile-buffer + frame prefetch + readiness gate (TimeBar drives these).
      waitForFrameReady: (idx, timeoutMs) =>
        mgrRef.current?.waitForFrameReady(idx, timeoutMs) ?? Promise.resolve(),
      isFrameReady: (idx) => mgrRef.current?.isFrameReady(idx) ?? true,
      setPlayhead: (t) => mgrRef.current?.setPlayhead(t),
      setPlaying: (playing) => {
        playingRef.current = playing;
        mgrRef.current?.setPlaying(playing);
      },
      setView: (view) => {
        mapRef.current?.jumpTo({
          center: view.center,
          zoom: view.zoom,
          bearing: view.bearing ?? 0,
          pitch: view.pitch ?? 0,
        });
      },
      flyTo: (target) => {
        const map = mapRef.current;
        if (!map) return;
        if (target.bbox) {
          map.fitBounds(
            [
              [target.bbox[0], target.bbox[1]],
              [target.bbox[2], target.bbox[3]],
            ],
            { maxZoom: 9, duration: 800 },
          );
        } else {
          map.flyTo({ center: target.center, zoom: target.zoom ?? 8, duration: 800 });
        }
      },
    }),
    [],
  );

  return <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />;
});

export default WeatherMapV2;
