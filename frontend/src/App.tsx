import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import "./App.css";
import type {
  Model,
  Run,
  BaseMapId,
  ProjectionId,
  TimeFormat,
  WeatherStyle,
} from "./api/types";
import { isCompositeModel, splitPercentileVar } from "./api/types";
import type { AvailableVariable } from "./api/v2catalog";
import {
  fetchV2Models,
  fetchV2Meta,
  fetchV2Runs,
  fetchServerPresets,
  type V2ModelCat,
} from "./api/v2client";
import { v2ModelsToModels, v2VarsToAvailable } from "./api/v2catalog";
import { setModelCatalog } from "./api/modelInfo";
import { v2WeatherStyle } from "./api/v2style";
import type { MapLayer, DisplayMode, MapConfig, MapView } from "./api/mapConfig";
import {
  findPreset,
  createLayer,
  serverPresetsToConfigs,
  applyServerPresets,
  type ServerPreset,
  primaryVariable,
  visibleVariables,
  visibleWindowedVariables,
  detectPreset,
  encodeMapHash,
  decodeMapHash,
  loadUserPresets,
  saveUserPresets,
  buildUserPreset,
  TOPICS,
  findTopicForPresetId,
  parseIsobarLevel,
  swapIsobarLevel,
  activeIsobarLevel,
  lapseOffBases,
} from "./api/mapConfig";
import {
  bucketTimesteps,
  nearestTimestepIndex,
  startAnchorIndex,
  setLeadReference,
} from "./time";
import type { TimeWindow, WindowMode } from "./time";
import WeatherMap from "./components/WeatherMapV2";
import type { WeatherMapHandle } from "./components/WeatherMapV2";
import LocationSearch from "./components/LocationSearch";
import type { SearchResult } from "./components/LocationSearch";
import Controls from "./components/Controls";
import RunBrowser from "./components/RunBrowser";
import PresetBar from "./components/PresetBar";
import TimeBar from "./components/TimeBar";
import PointPopup from "./components/PointPopup";
import HoverValueLabel from "./components/HoverValueLabel";
import StatusBadge from "./components/StatusBadge";
import ModelInfoPage from "./components/ModelInfoPage";
import DetailPage from "./components/DetailPage";
import MapLegend from "./components/MapLegend";
import LoadingIndicator from "./components/LoadingIndicator";
import { usePersistentState } from "./lib/usePersistentState";
import {
  presetTargetModel,
  compositeEpsState,
  compositeModelForEps,
  bulkApplyMode,
} from "./lib/epsMode";
import { seedEnsembleMode } from "./lib/layerSeed";

// ---------------------------------------------------------------------------
// Hash sync helpers
// ---------------------------------------------------------------------------

function readInitialHash() {
  const parsed = decodeMapHash(window.location.hash);
  return parsed;
}

/** The four valid window modes. A crafted / stale hash could carry any
 *  string in `wm=`; bucketTimesteps would mis-bucket (or NaN-span) on an
 *  unknown mode, so every hash-sourced windowMode is validated through
 *  this guard and falls back to "hourly" when invalid. */
const VALID_WINDOW_MODES: ReadonlySet<string> = new Set([
  "hourly",
  "3h",
  "6h",
  "12h",
  "daily",
]);

function validWindowMode(raw: string | undefined): WindowMode {
  return raw != null && VALID_WINDOW_MODES.has(raw)
    ? (raw as WindowMode)
    : "hourly";
}

/** Validate a hash-sourced time format ("utc" | "local" | "lead"). */
function validTimeFormat(raw: string | undefined): TimeFormat | null {
  return raw === "utc" || raw === "local" || raw === "lead" ? raw : null;
}

/** Parse a /detail?loc="lat,lon[,label]" value. */
function parseDetailLoc(loc: string | null): { lat: number; lon: number; label?: string } | null {
  if (!loc) return null;
  const [latS, lonS, ...labelParts] = loc.split(",");
  const lat = Number(latS);
  const lon = Number(lonS);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon, label: labelParts.join(",") || undefined };
}

export default function App() {
  // ---- Bootstrap from URL hash (if present) ----
  const initialHash = useRef(readInitialHash());

  const [models, setModels] = useState<Model[]>([]);
  const [v2cat, setV2cat] = useState<V2ModelCat[]>([]);
  const [selectedModel, setSelectedModel] = useState(
    initialHash.current?.model ?? "auto", // default to the composite (best-resolution)
  );

  // Saved user presets, persisted to localStorage. Loaded eagerly so
  // a hash referencing a user preset id can resolve on first render.
  const [userPresets, setUserPresets] = useState<MapConfig[]>(() => loadUserPresets());

  // Server-defined presets from the backend config (wetter.yaml
  // `presets:` block). Fetched once; listed like user presets but not
  // deletable and never written to localStorage.
  const [serverPresets, setServerPresets] = useState<MapConfig[]>([]);
  useEffect(() => {
    const ctrl = new AbortController();
    fetchServerPresets<ServerPreset>(ctrl.signal)
      .then((list) =>
        // Entries overriding a built-in install via applyServerPresets;
        // only the remainder lists under the ⭐ topic.
        setServerPresets(applyServerPresets(serverPresetsToConfigs(list))),
      )
      .catch(() => {}); // endpoint missing/failing -> built-ins only
    return () => ctrl.abort();
  }, []);
  const allPresets = useMemo(
    () => [...serverPresets, ...userPresets],
    [serverPresets, userPresets],
  );

  // Unified layer list — replaces old mapMode + selectedVariable + layerStates
  const [layers, setLayers] = useState<MapLayer[]>(() => {
    if (initialHash.current?.layers?.length) return initialHash.current.layers;
    // Seed from the initial preset's layers — the v2 catalog now carries the
    // derived vars the presets reference (wind_speed_10m, precip_1h, _spread, …),
    // so a preset shows its full multi-layer stack. Hash-restored layers win.
    const presetId = initialHash.current?.presetId ?? "wind";
    const preset =
      userPresets.find((p) => p.id === presetId) ?? findPreset(presetId);
    if (preset?.layers?.length) {
      return preset.layers.map((l) => ({ ...l, id: `ly-${++_presetCounter}` }));
    }
    return [createLayer("t_2m", "tiles", {})];
  });

  const [activePreset, setActivePreset] = useState<string | null>(() => {
    if (initialHash.current?.presetId) return initialHash.current.presetId;
    return "wind";
  });

  // Runs for the selected model
  const [runs, setRuns] = useState<Run[]>([]);
  const [latestRun, setLatestRun] = useState("");
  const [selectedRun, setSelectedRun] = useState(
    initialHash.current?.run ?? "",
  );
  const [weatherStyle, setWeatherStyle] = useState<WeatherStyle | null>(null);
  const [activeTimestep, setActiveTimestep] = useState(0);
  const [baseMap, setBaseMap] = useState<BaseMapId>(() => {
    if (initialHash.current?.base) return initialHash.current.base as BaseMapId;
    // No explicit basemap in the hash — pick up the initial preset's
    // baseMap so the very first paint matches what handleLoadPreset
    // would do on a manual click.
    const presetId = initialHash.current?.presetId ?? "wind";
    const seed =
      userPresets.find((p) => p.id === presetId) ?? findPreset(presetId);
    return seed?.baseMap ?? "grayscale";
  });
  const [satellite, setSatellite] = useState<boolean>(() => {
    if (initialHash.current?.satellite != null) {
      return !!initialHash.current.satellite;
    }
    const presetId = initialHash.current?.presetId ?? "wind";
    const seed =
      userPresets.find((p) => p.id === presetId) ?? findPreset(presetId);
    return !!seed?.satellite;
  });
  const [projection, setProjection] = useState<ProjectionId>(
    (initialHash.current?.proj as ProjectionId) ?? "globe",
  );
  const [terrain, setTerrain] = useState(initialHash.current?.terrain ?? false);
  const [timeFormat, setTimeFormat] = usePersistentState<TimeFormat>(
    "wx:timeFormat",
    "utc",
    (raw): raw is TimeFormat =>
      raw === "local" || raw === "utc" || raw === "lead",
  );
  const [windowMode, setWindowMode] = usePersistentState<WindowMode>(
    "wx:windowMode",
    "hourly",
    (raw): raw is WindowMode =>
      raw === "hourly" ||
      raw === "3h" ||
      raw === "6h" ||
      raw === "12h" ||
      raw === "daily",
  );
  const [unitPrefs, setUnitPrefs] = usePersistentState<Record<string, string>>(
    "wx:unitPrefs",
    {},
    (raw): raw is Record<string, string> =>
      typeof raw === "object" && raw !== null && !Array.isArray(raw),
  );
  // HDR mode: when on, the GPU tile drivers fetch tiles at one zoom
  // level deeper (effectively halving MapLibre's logical tileSize).
  // Roughly 4× the bandwidth and chunk count, but 2× the data
  // resolution per CSS pixel. Default on; the loading overlay also
  // exposes a switch so a slow connection can flip back to SDR.
  const [hdr, setHdr] = usePersistentState<boolean>(
    "wx:hdr",
    true,
    (raw): raw is boolean => typeof raw === "boolean",
  );
  // Playback speed: wall-clock ms per forecast hour. 250 = a 1h-cadence
  // archive crosses one integer frame every 250 ms; a 3h-cadence segment
  // dwells 750 ms. Settable from the hamburger menu's Speed section.
  // Clamped to the preset range (125 ms = fastest, 4 s = slowest) so a
  // corrupted localStorage value can't wedge playback into a stall or
  // burn-out.
  const [playbackMsPerHour, setPlaybackMsPerHour] = usePersistentState<number>(
    "wx:playbackMsPerHour",
    1000,
    (raw): raw is number =>
      typeof raw === "number" && Number.isFinite(raw) && raw >= 125 && raw <= 4000,
  );
  const [availableVariables, setAvailableVariables] = useState<AvailableVariable[]>([]);
  // Catalog of the model EPS interactions would land on (auto_eps when
  // on either composite, the model itself otherwise). Gates the legend's
  // Spread / Chance-of chips so EPS chrome only renders when the switch
  // target actually supports the layer.
  const [epsTargetVariables, setEpsTargetVariables] = useState<AvailableVariable[]>([]);
  // Per-model variable catalog covering every model a layer can route to
  // (modelsInUse(selectedModel): both composite flavors on a composite,
  // else just the model). WeatherMap resolves per-layer metadata
  // (contour-interval defaults, unit lookups, window-op caps) against
  // `layerModel(layer)` so a `det` layer on auto and an `eps` layer on
  // auto_eps each read their own model's catalog. Keyed by model id.
  const [variablesByModel, setVariablesByModel] = useState<
    Map<string, AvailableVariable[]>
  >(new Map());

  // The RFC3339 timestep axis from the active style. Drives the window
  // bucketer.
  const timesteps = useMemo(
    () => weatherStyle?.metadata["weather-api:timesteps"] ?? [],
    [weatherStyle],
  );

  // Synthetic-time run/window: frame times are not wall-clock meaningful —
  // labels show lead hours, day/night + "now" anchoring are disabled, and
  // the Local/UTC toggle is locked to "Lead".
  const synthetic = !!weatherStyle?.metadata["weather-api:synthetic"];
  const effTimeFormat: TimeFormat = synthetic ? "lead" : timeFormat;

  // Keep time.ts's lead reference in sync with the active run: parseable run
  // id wins, else the first frame (lead +0h at the axis head). Set inline
  // (module state, idempotent) so the window memo below and every child's
  // render already see the fresh reference.
  {
    const run = weatherStyle?.metadata["weather-api:run"];
    const ms = run ? Date.parse(run) : NaN;
    setLeadReference(Number.isFinite(ms) ? ms : (timesteps[0] ?? null));
  }

  // Window buckets for the current mode + tz. Hourly returns one window
  // per step; 6h/12h/daily bucket on the nesting grid. The active window
  // is the bucket that contains the active timestep (falls back to the
  // first bucket). In window mode WeatherMap drives one reduced span
  // tile per window from `activeWindow`.
  const windows = useMemo<TimeWindow[]>(
    () => bucketTimesteps(timesteps, windowMode, effTimeFormat),
    [timesteps, windowMode, effTimeFormat],
  );
  const activeWindow = useMemo<TimeWindow | null>(
    () =>
      windows.find((w) => w.nativeIndices.includes(activeTimestep)) ??
      windows[0] ??
      null,
    [windows, activeTimestep],
  );

  const [loading, setLoading] = useState(false);
  const [gpuLoading, setGpuLoading] = useState(false);
  // E5: shared z_site DEM availability, surfaced by WxLayerManager once the
  // first fetch resolves (success or a 404). Optimistic default (true, mirrors
  // the manager's own default) so the ⛰ toggle doesn't flash in then out on
  // the common case where the DEM IS available.
  const [demAvailable, setDemAvailable] = useState(true);
  // Playback pauses on an unloaded window used to flip a `frameLoading` state
  // ORed into the CENTERED overlay — every stall flashed the full-screen
  // spinner ("the preload screen flickers"). Stalls now surface through the
  // non-blocking chip instead (chunkStats visibleInFlight, 400 ms debounce);
  // the overlay is reserved for "a layer has nothing on screen yet".
  const [menuOpen, setMenuOpen] = useState(false);
  const [modelInfoOpen, setModelInfoOpen] = useState(false);
  const [clickPoint, setClickPoint] = useState<{
    lat: number;
    lon: number;
    /** Place name for the popup header (search picks carry the geocoder's). */
    label?: string;
    kind?: string;
    /** Map zoom at click time — scales the reverse-geocode acceptance radius. */
    zoom?: number;
  } | null>(null);
  // Full-page detail view for clickPoint, at the linkable
  // /detail?loc=lat,lon[,label][&view=multi] PATH ("multi" = the
  // multi-model comparison tab).
  // Initialized synchronously from the URL: the hash writer below must
  // already see the detail view on its mount run, or it rewrites a
  // /detail deep link back to the map URL before the state lands.
  const [detailView, setDetailView] = useState<"detail" | "multi" | null>(() => {
    if (window.location.pathname !== "/detail") return null;
    const q = new URLSearchParams(window.location.search);
    return parseDetailLoc(q.get("loc")) ? (q.get("view") === "multi" ? "multi" : "detail") : null;
  });
  // Deep links: a pt= hash (MCP map_url) opens the popup on load; the
  // /detail?loc PATH opens the full detail page directly.
  useEffect(() => {
    if (window.location.pathname === "/detail") {
      const pt = parseDetailLoc(new URLSearchParams(window.location.search).get("loc"));
      if (pt) {
        setClickPoint(pt);
        return;
      }
    }
    const pt = parseDetailLoc(initialHash.current?.pt ?? null);
    if (pt) setClickPoint(pt);
  }, []);
  // Entering the detail view rewrites the URL to /detail?loc=… (linkable,
  // back-button friendly); leaving lets the hash writer below restore the
  // map URL. replaceState while already there keeps label/tab refinements.
  useEffect(() => {
    if (!detailView || !clickPoint) return;
    const loc = `${clickPoint.lat.toFixed(4)},${clickPoint.lon.toFixed(4)}${clickPoint.label ? `,${clickPoint.label}` : ""}`;
    const url = `/detail?loc=${encodeURIComponent(loc)}${detailView === "multi" ? "&view=multi" : ""}`;
    if (window.location.pathname !== "/detail") {
      window.history.pushState({ detail: true }, "", url);
    } else if (window.location.href !== new URL(url, window.location.origin).href) {
      window.history.replaceState({ detail: true }, "", url);
    }
  }, [detailView, clickPoint]);
  // Mouse-hover position over the map, used to drive the floating
  // value label. `null` while the cursor isn't over the map canvas;
  // touch interactions never set it.
  const [hoverPoint, setHoverPoint] = useState<{
    lat: number;
    lon: number;
    x: number;
    y: number;
  } | null>(null);

  const mapRef = useRef<WeatherMapHandle>(null);
  const bottomStackRef = useRef<HTMLDivElement>(null);

  // Suppress hash writes during the initial mount phase
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
  }, []);

  // Latest camera reported by WeatherMap (lng/lat/zoom/bearing/pitch).
  // Stored in a ref to avoid re-rendering the whole tree on every
  // moveend; both the navigation push effect and the view replace
  // path read this when assembling the hash.
  const viewRef = useRef<MapView | undefined>(initialHash.current?.view);
  // Debounce the view-only hash writes — moveend fires once per
  // settled gesture but rapid wheel-zoom can chain several in a row.
  const viewWriteTimer = useRef<number | null>(null);

  // Counter incremented every time the user interacts with the map
  // or timeline. PresetBar listens to this and dismisses the active
  // sub-options strip on mobile so the user gets a clean view of
  // what they're inspecting. Desktop ignores this hint — the strip
  // stays open until the user clicks elsewhere.
  const [hideHint, setHideHint] = useState(0);
  // While the play loop is running, taps / pans / per-frame timestep
  // ticks should NOT auto-dismiss the mobile preset strip — the user
  // is watching playback, not navigating. Pressing Play itself still
  // triggers a hide (handled in handlePlayingChange below); the
  // PresetBar's 20s idle timer is the only auto-dismiss during play.
  const playingRef = useRef(false);
  const triggerHide = useCallback(() => {
    if (playingRef.current) return;
    setHideHint((h) => h + 1);
  }, []);
  const handlePlayingChange = useCallback((playing: boolean) => {
    playingRef.current = playing;
    if (playing) setHideHint((h) => h + 1);
  }, []);
  // Suppress the timestep-driven hide for a short window after a
  // preset load — preset loads re-anchor activeTimestep as part of
  // their own cascade, and we don't want that programmatic change
  // to immediately collapse the strip the user just opened.
  const lastPresetLoadAt = useRef(0);

  // Expose the current bottom-stack height (attribution strip + time
  // bar) as a CSS custom property so absolutely-positioned siblings
  // (notably MapLibre's .maplibregl-ctrl-bottom-right) can clear it.
  // --time-bar-h tracks just the time bar; both custom props are kept so
  // wide layouts can flank the time bar with the legend and nav buttons.
  useEffect(() => {
    const el = bottomStackRef.current;
    if (!el) return;
    const update = () => {
      document.documentElement.style.setProperty(
        "--bottom-stack-h",
        `${el.offsetHeight}px`,
      );
      const tb = el.querySelector<HTMLElement>(".time-bar");
      document.documentElement.style.setProperty(
        "--time-bar-h",
        `${tb?.offsetHeight ?? el.offsetHeight}px`,
      );
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    const tb = el.querySelector<HTMLElement>(".time-bar");
    if (tb) ro.observe(tb);
    return () => ro.disconnect();
  }, []);

  // ---- Hash sync: write hash on navigation-relevant state change ----
  // Pushes a new history entry so browser back/forward navigates
  // through layer / preset / model changes. View-only updates go
  // through replaceState in handleViewChange below — those don't
  // belong in history (panning would otherwise spam the back stack).
  useEffect(() => {
    if (!mountedRef.current) return;
    const hash = encodeMapHash({
      model: selectedModel || undefined,
      run: selectedRun || undefined,
      presetId: activePreset ?? undefined,
      layers,
      base: baseMap,
      proj: projection,
      terrain,
      satellite,
      view: viewRef.current,
      windowMode,
      anchor: windowMode === "hourly" ? undefined : activeWindow?.startIso,
      tf: timeFormat,
    });
    if (detailView) return; // /detail?loc owns the URL while open
    if (hash !== window.location.hash || window.location.pathname === "/detail") {
      window.history.pushState(null, "", "/" + hash);
    }
  }, [selectedModel, selectedRun, activePreset, layers, baseMap, projection, terrain, satellite, windowMode, activeWindow, timeFormat, detailView]);

  // ---- View sync: replaceState on every settled gesture ----
  // Debounced so a wheel-zoom that emits a flurry of moveends only
  // produces one history rewrite at the end. View changes never
  // create a new history entry — only navigation changes do.
  const handleViewChange = useCallback(
    (view: { center: [number, number]; zoom: number; bearing: number; pitch: number }) => {
      viewRef.current = view;
      // Mobile dismiss: panning / zooming counts as a user gesture
      // and dismisses the strip. (Programmatic camera moves from
      // popstate land here too, but those are rare enough to ignore.)
      triggerHide();
      if (viewWriteTimer.current) {
        window.clearTimeout(viewWriteTimer.current);
      }
      viewWriteTimer.current = window.setTimeout(() => {
        const hash = encodeMapHash({
          model: selectedModel || undefined,
          run: selectedRun || undefined,
          presetId: activePreset ?? undefined,
          layers,
          base: baseMap,
          proj: projection,
          terrain,
          satellite,
          view,
          windowMode,
          anchor: windowMode === "hourly" ? undefined : activeWindow?.startIso,
          tf: timeFormat,
        });
        if (window.location.pathname === "/detail") return; // detail owns the URL
        if (hash !== window.location.hash) {
          window.history.replaceState(
            null,
            "",
            hash || window.location.pathname,
          );
        }
      }, 300);
    },
    [selectedModel, selectedRun, activePreset, layers, baseMap, projection, terrain, satellite, windowMode, activeWindow, timeFormat, triggerHide],
  );

  useEffect(
    () => () => {
      if (viewWriteTimer.current) window.clearTimeout(viewWriteTimer.current);
    },
    [],
  );

  // Timestep changes (play loop, TimeBar drag, keyboard step) count
  // as timeline interaction and dismiss the strip — but skip the
  // echo that fires immediately after a preset load resets the
  // active timestep.
  useEffect(() => {
    if (!mountedRef.current) return;
    if (Date.now() - lastPresetLoadAt.current < 800) return;
    triggerHide();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTimestep]);

  // ---- popstate: re-apply state when the user navigates back/forward ----
  useEffect(() => {
    const onPopState = () => {
      const parsed = decodeMapHash(window.location.hash);
      if (!parsed) return;
      if (parsed.model !== undefined) setSelectedModel(parsed.model);
      setSelectedRun(parsed.run ?? "");
      if (parsed.layers.length > 0) setLayers(parsed.layers);
      if (parsed.presetId !== undefined) setActivePreset(parsed.presetId);
      if (parsed.base) setBaseMap(parsed.base as BaseMapId);
      setProjection((parsed.proj as ProjectionId) ?? "globe"); // absent = the globe default
      if (window.location.pathname === "/detail") {
        const q = new URLSearchParams(window.location.search);
        const pt = parseDetailLoc(q.get("loc"));
        if (pt) {
          setClickPoint(pt);
          setDetailView(q.get("view") === "multi" ? "multi" : "detail");
        }
      } else {
        setDetailView(null); // back button from the detail page returns to the map
      }
      setTerrain(!!parsed.terrain);
      setSatellite(!!parsed.satellite);
      // Validate the hash-sourced window mode against the four known
      // values — a crafted / stale hash must not push an invalid mode
      // into bucketTimesteps. Falls back to "hourly".
      setWindowMode(validWindowMode(parsed.windowMode));
      const tf = validTimeFormat(parsed.tf);
      if (tf) setTimeFormat(tf);
      if (parsed.view) {
        viewRef.current = parsed.view;
        mapRef.current?.setView?.(parsed.view);
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [setWindowMode, setTimeFormat]);

  // Seed the window mode from the initial URL hash (a shared
  // `#…&wm=daily` link), taking precedence over the persisted value.
  // Validated through validWindowMode so a crafted hash can't break the
  // bucketer; absent / invalid `wm` leaves the persisted/default mode.
  useEffect(() => {
    const wm = initialHash.current?.windowMode;
    if (wm != null) setWindowMode(validWindowMode(wm));
    const tf = validTimeFormat(initialHash.current?.tf);
    if (tf) setTimeFormat(tf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Load the v2 catalog on mount ----
  useEffect(() => {
    const ctrl = new AbortController();
    fetchV2Models(ctrl.signal)
      .then((cat) => {
        if (ctrl.signal.aborted) return;
        setV2cat(cat);
        const ms = v2ModelsToModels(cat);
        setModelCatalog(ms);
        setModels(ms);
        if (cat.length > 0 && !selectedModel) {
          const dm = cat.find((m) => m.id === "icond2") ?? cat[0];
          setSelectedModel(dm.id);
        }
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        console.error(err);
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Buffered runs for the selected model (GET /runs, newest first) ----
  // Feeds the run selector + the RunBrowser panel. Composites have no runs
  // of their own. The pinned run is NOT reset here: user model switches clear
  // it in handleModelChange, while hash/popstate restores set model + run
  // together and must survive this effect.
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);
  useEffect(() => {
    setRuns([]);
    setLatestRun("");
    setRunsError(null);
    if (!selectedModel || isCompositeModel(selectedModel)) return;
    const ctrl = new AbortController();
    setRunsLoading(true);
    fetchV2Runs(selectedModel, ctrl.signal)
      .then((rs) => {
        if (ctrl.signal.aborted) return;
        setRuns(
          rs.map((r) => ({
            run: r.run,
            forecast_start: r.valid_from,
            forecast_end: r.valid_to,
            complete: r.complete,
            synthetic_time: r.synthetic_time,
            steps: r.steps,
          })),
        );
        setLatestRun(rs[0]?.run ?? "");
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        setRunsError(String((err as Error)?.message ?? err));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setRunsLoading(false);
      });
    return () => ctrl.abort();
  }, [selectedModel]);

  // Run-browser panel visibility (opened from Controls).
  const [runBrowserOpen, setRunBrowserOpen] = useState(false);

  // ---- Available variables derived from the v2 catalog ----
  // v2's /models response carries every variable per model, so the
  // per-variable catalog is a pure derivation (no extra fetch). Composite
  // routing is hidden in v2, so the EPS-target + per-model maps collapse
  // to the single selected model.
  useEffect(() => {
    if (!selectedModel) {
      setAvailableVariables([]);
      setEpsTargetVariables([]);
      setVariablesByModel(new Map());
      return;
    }
    const cat = v2cat.find((m) => m.id === selectedModel);
    const vars = cat ? v2VarsToAvailable(cat) : [];
    setAvailableVariables(vars);
    setEpsTargetVariables(vars);
    setVariablesByModel(new Map([[selectedModel, vars]]));
  }, [selectedModel, v2cat]);

  // ---- Load weather style (driven by first visible layer) ----
  // Prefers tile layers but falls back to GeoJSON-only layers so
  // contour / barbs / value / flow-only maps still get a timestep
  // axis for the TimeBar.
  const primaryVar = useMemo(() => primaryVariable(layers), [layers]);
  // Mirror weatherStyle + activeTimestep into refs so the layer-load
  // effect can read the OLD layer's timeline at the moment a switch
  // fires, without re-running on every step change.
  // Bumped by the map manager's latest-run watchdog: a run flip upstream
  // must refresh the run-derived state here too (timesteps axis, anchor),
  // not just the manager's own window caches.
  const [runEpoch, setRunEpoch] = useState(0);
  const handleRunFlip = useCallback(() => setRunEpoch((n) => n + 1), []);

  const weatherStyleRef = useRef(weatherStyle);
  const activeTimestepRef = useRef(activeTimestep);
  useEffect(() => { weatherStyleRef.current = weatherStyle; }, [weatherStyle]);
  useEffect(() => { activeTimestepRef.current = activeTimestep; }, [activeTimestep]);

  useEffect(() => {
    if (!selectedModel || !primaryVar) {
      setWeatherStyle(null);
      return;
    }

    // Capture the user's current wall-clock position from the layer
    // we're about to replace so we can re-anchor on the new layer's
    // timeline. activeTimestep < 0 means the previous layer was
    // already in "no-data" state — nothing to preserve, fall back to
    // nearest-now after fetch.
    const prevTs =
      weatherStyleRef.current?.metadata["weather-api:timesteps"] ?? [];
    const prevIdx = activeTimestepRef.current;
    const targetMs =
      prevIdx >= 0 && prevTs[prevIdx]
        ? Date.parse(prevTs[prevIdx])
        : NaN;

    const ctrl = new AbortController();
    setLoading(true);

    // The timesteps axis is per-base; strip any ensemble plane suffix
    // (t_2m_p90 → t_2m) so /meta resolves (/meta only knows base ids). A
    // pinned run rides along so the axis matches the pinned run's steps.
    fetchV2Meta(
      selectedModel,
      splitPercentileVar(primaryVar).base,
      ctrl.signal,
      selectedRun || undefined,
    )
      .then((meta) => {
        if (ctrl.signal.aborted) return;
        const style = v2WeatherStyle(meta);
        setWeatherStyle(style);
        const timesteps = style.metadata["weather-api:timesteps"] ?? [];
        const anchor = style.metadata["weather-api:start"];
        if (Number.isFinite(targetMs) && timesteps.length > 0) {
          // Layer/model switch: keep the user's current wall-clock
          // position. When the new axis doesn't cover it, nearest
          // clamps to the closest edge (earliest frame when the
          // position lies before the axis, last frame when beyond) —
          // NOT the server anchor, which would yank the view to ≈now.
          // Deliberate: matching always compares wall-clock time, even
          // in lead-time display mode (tf=lead) — the same real-world
          // moment is preserved across sources, not the same +Xh lead.
          setActiveTimestep(nearestTimestepIndex(timesteps, targetMs));
        } else {
          // First load → open at the server's start anchor (≈ now, but off
          // a de-accumulation's empty analysis frame).
          setActiveTimestep(startAnchorIndex(timesteps, anchor));
        }
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        console.error("Failed to load weather style:", err);
        setWeatherStyle(null);
      })
      .finally(() => {
        if (ctrl.signal.aborted) return;
        setLoading(false);
      });

    return () => ctrl.abort();
  }, [selectedModel, primaryVar, selectedRun, runEpoch]);

  // ---- Layer management callbacks ----

  const handleModelChange = useCallback(
    (modelId: string) => {
      setSelectedModel(modelId);
      setSelectedRun("");
      setClickPoint(null);
      // Clear the initial hash run so subsequent model changes reset properly
      if (initialHash.current) initialHash.current.run = undefined;
    },
    [],
  );

  const handleAddLayer = useCallback(
    (variable: string, displayMode: DisplayMode) => {
      const defaults: Partial<MapLayer> = {};
      // Seed the per-layer ensembleMode from the active model's default:
      // a layer added on a composite routes to the active flavor (auto →
      // det, auto_eps → eps); a physical-model add leaves it undefined
      // (ensembleMode is ignored there). Product stays Median = the bare
      // variable id the picker passes through.
      const seed = seedEnsembleMode(selectedModel);
      if (seed) defaults.ensembleMode = seed;
      if (displayMode === "tiles") {
        // Same default every preset uses: the GPU animation path
        // (per-tile texture arrays, scrub/playback without per-frame
        // fetches). Ineligible encodings fall back to raster
        // automatically, so opting in is always safe.
        defaults.gpuAnim = true;
      }
      if (displayMode === "barbs") {
        defaults.gridBundle = "wind";
        defaults.gridValueProp = "speed";
        defaults.iconScale = 1.0;
      }
      if (displayMode === "contour") {
        defaults.contourColor = "#ffffff";
        defaults.contourWidth = 1;
      }
      if (displayMode === "flow") {
        defaults.flowParticles = 8000;
        defaults.flowSpeed = 1.0;
        defaults.flowWidth = 1.5;
        defaults.flowColor = "rgba(255,255,255,1)";
        defaults.flowUVar = "u_10m";
        defaults.flowVVar = "v_10m";
      }
      // Prepend so the new layer appears at the top of the list and
      // renders on top of the map (WeatherMap reverses layers, making
      // index 0 the visible top of the stack).
      setLayers((prev) => [createLayer(variable, displayMode, defaults), ...prev]);
      setActivePreset(null);
    },
    [selectedModel],
  );

  const handleRemoveLayer = useCallback((layerId: string) => {
    setLayers((prev) => prev.filter((l) => l.id !== layerId));
    setActivePreset(null);
  }, []);

  const handleLayerUpdate = useCallback(
    (layerId: string, patch: Partial<MapLayer>) => {
      setLayers((prev) =>
        prev.map((l) => (l.id === layerId ? { ...l, ...patch } : l)),
      );
      setActivePreset(null);
    },
    [],
  );

  const handleLayerReorder = useCallback((newOrder: string[]) => {
    setLayers((prev) => {
      const byId = new Map(prev.map((l) => [l.id, l]));
      return newOrder.map((id) => byId.get(id)!).filter(Boolean);
    });
    setActivePreset(null);
  }, []);

  const handleLoadPreset = useCallback(
    (presetId: string) => {
      const preset =
        allPresets.find((p) => p.id === presetId) ?? findPreset(presetId);
      if (!preset) return;
      // Stamp the load time so the timestep effect ignores the
      // programmatic re-anchor that the new style fetch will trigger.
      lastPresetLoadAt.current = Date.now();
      setLayers((prev) => {
        // Deep-copy layers with fresh per-instance ids.
        let next = preset.layers.map((l) => ({
          ...l,
          id: `ly-${++_presetCounter}`,
        }));
        // Upper-air height carry-over: when both the outgoing layers and
        // the incoming preset are isobaric, rewrite the 500 hPa template
        // to the height the user is currently viewing so switching
        // phenomenon (Height/Temp/Jet) doesn't snap back to 500. Reads
        // `prev` here so the callback needn't depend on `layers`.
        const carry = activeIsobarLevel(prev);
        if (
          carry != null &&
          next.some((l) => parseIsobarLevel(l.variable) != null)
        ) {
          next = next.map((l) => ({
            ...l,
            variable: swapIsobarLevel(l.variable, carry),
            flowUVar: l.flowUVar ? swapIsobarLevel(l.flowUVar, carry) : l.flowUVar,
            flowVVar: l.flowVVar ? swapIsobarLevel(l.flowVVar, carry) : l.flowVVar,
          }));
        }
        return next;
      });
      setActivePreset(presetId);
      setClickPoint(null);
      setBaseMap(preset.baseMap ?? "grayscale");
      setSatellite(!!preset.satellite);
      // Presets load the mixed `auto` composite; physical model
      // selections are never overridden.
      const target = presetTargetModel(selectedModel);
      if (target !== selectedModel) handleModelChange(target);
    },
    [allPresets, selectedModel, handleModelChange],
  );

  // Rewrite every level-bearing layer (fill, contour, flow u/v) to the
  // chosen isobaric level. activePreset is left alone — the detect
  // effect re-runs detectPreset on the new layers and, thanks to
  // level-agnostic matchesPreset, keeps the phenomenon preset selected
  // so the Upper-air topic and height selector stay put.
  const handleSwapUpperHeight = useCallback((hPa: number) => {
    setLayers((prev) =>
      prev.map((l) => ({
        ...l,
        variable: swapIsobarLevel(l.variable, hPa),
        flowUVar: l.flowUVar ? swapIsobarLevel(l.flowUVar, hPa) : l.flowUVar,
        flowVVar: l.flowVVar ? swapIsobarLevel(l.flowVVar, hPa) : l.flowVVar,
      })),
    );
  }, []);

  const handleSaveUserPreset = useCallback(
    (label: string, icon: string) => {
      const trimmed = label.trim();
      if (!trimmed) return;
      const preset = buildUserPreset(trimmed, icon, layers, baseMap, satellite);
      setUserPresets((prev) => {
        const next = [...prev, preset];
        saveUserPresets(next);
        return next;
      });
      setActivePreset(preset.id);
    },
    [layers, baseMap, satellite],
  );

  const handleDeleteUserPreset = useCallback(
    (presetId: string) => {
      setUserPresets((prev) => {
        const next = prev.filter((p) => p.id !== presetId);
        saveUserPresets(next);
        return next;
      });
      // If we just deleted the active preset, fall back to "custom"
      // detection on the next layer-change pass.
      setActivePreset((cur) => (cur === presetId ? null : cur));
    },
    [],
  );

  const handleRunChange = useCallback((run: string) => {
    setSelectedRun(run);
    setClickPoint(null);
  }, []);

  const handleMapClick = useCallback(
    (lat: number, lon: number) => {
      setClickPoint({ lat, lon, zoom: viewRef.current?.zoom });
      triggerHide();
    },
    [triggerHide],
  );

  // Location search pick: fly the camera to the result and open the
  // point inspector there, mirroring a manual map click.
  const handleSearchPick = useCallback(
    (r: SearchResult) => {
      mapRef.current?.flyTo({ center: r.center, bbox: r.bbox });
      setClickPoint({ lat: r.center[1], lon: r.center[0], label: r.placeName, kind: r.kind });
      triggerHide();
    },
    [triggerHide],
  );

  // ---- Keyboard shortcuts ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          t.isContentEditable
        ) {
          return;
        }
      }

      const timesteps = weatherStyle?.metadata["weather-api:timesteps"] ?? [];
      const lastStep = timesteps.length - 1;
      const stepTo = (i: number) => {
        if (lastStep < 0) return;
        setActiveTimestep(Math.max(0, Math.min(lastStep, i)));
      };

      // ←/→ step one unit: a whole window in an aggregation mode, a
      // single timestep in hourly. (`,`/`.` always step a raw timestep.)
      const stepUnit = (dir: -1 | 1) => {
        if (windowMode !== "hourly" && windows.length > 0) {
          const cur = windows.findIndex((w) =>
            w.nativeIndices.includes(activeTimestep),
          );
          const base = cur >= 0 ? cur : 0;
          const target =
            windows[Math.max(0, Math.min(windows.length - 1, base + dir))];
          if (target) setActiveTimestep(target.nativeIndices[0]);
        } else {
          stepTo(activeTimestep + dir);
        }
      };

      switch (e.key) {
        case "ArrowLeft":
          stepUnit(-1);
          e.preventDefault();
          return;
        case "ArrowRight":
          stepUnit(1);
          e.preventDefault();
          return;
        case ",":
          stepTo(activeTimestep - 1);
          e.preventDefault();
          return;
        case ".":
          stepTo(activeTimestep + 1);
          e.preventDefault();
          return;
        case "<":
          stepTo(activeTimestep - 6);
          e.preventDefault();
          return;
        case ">":
          stepTo(activeTimestep + 6);
          e.preventDefault();
          return;
        case "Home":
          stepTo(0);
          e.preventDefault();
          return;
        case "End":
          stepTo(lastStep);
          e.preventDefault();
          return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [weatherStyle, activeTimestep, windowMode, windows]);

  const handleUnitPrefChange = useCallback(
    (groupId: string, optionId: string) => {
      setUnitPrefs((prev) => ({ ...prev, [groupId]: optionId }));
    },
    [setUnitPrefs],
  );

  const selectedModelVariables = useMemo(
    () => models.find((m) => m.id === selectedModel)?.variables ?? [],
    [models, selectedModel],
  );

  const pointVars = useMemo(() => {
    const vis = visibleVariables(layers);
    return vis.length > 0 ? vis : primaryVar ? [primaryVar] : [];
  }, [layers, primaryVar]);

  // E5: bases (t_2m/td_2m) whose ⛰ toggle is OFF among the visible layers —
  // threaded into the point/hover/popup fetches so ?lapse=off parity holds
  // for a layer whose drape correction the user turned off.
  const lapseOff = useMemo(() => lapseOffBases(layers), [layers]);

  // Catalog map for window-aggregation capability lookups (the live
  // /variables data carries the `aggregations` object).
  const varInfoMap = useMemo(
    () => new Map(availableVariables.map((v) => [v.name, v])),
    [availableVariables],
  );

  // Hover readout must mirror the DISPLAYED tile: the active ensemble
  // product (already in layer.variable) AND the active window mode (which
  // lives in aggOp + windowMode, composed only at request time). Without
  // this the hover would query the un-windowed base value. The query time
  // is the active window's END instant so the point handler reduces over
  // the same trailing block the tile shows; hourly mode keeps the active
  // timestep. The click PointPopup (a time series) still uses pointVars —
  // windowing its series view is a separate follow-up.
  const hoverVars = useMemo(() => {
    const vis = visibleWindowedVariables(
      layers,
      windowMode,
      activeWindow?.spanHours ?? 0,
      varInfoMap,
    );
    return vis.length > 0 ? vis : primaryVar ? [primaryVar] : [];
  }, [layers, windowMode, activeWindow, varInfoMap, primaryVar]);

  // Active upper-air pressure level, derived from the live layers. Null
  // when no layer is isobaric — the height selector hides in that case.
  const upperHeight = useMemo(() => activeIsobarLevel(layers), [layers]);

  // Detect if current layers match a preset (for highlighting the active button)
  useEffect(() => {
    const detected = detectPreset(layers, allPresets);
    if (detected !== activePreset) {
      setActivePreset(detected);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers, allPresets]);

  // Keep document.title in sync with the active preset so the
  // browser tab tells the user which layer they're looking at —
  // useful for bookmarks, history, and tab-switching.
  useEffect(() => {
    const baseTitle = "Wetter";
    if (!activePreset) {
      document.title = baseTitle;
      return;
    }
    const preset =
      allPresets.find((p) => p.id === activePreset) ??
      findPreset(activePreset);
    if (!preset) {
      document.title = baseTitle;
      return;
    }
    const topicId = findTopicForPresetId(activePreset, allPresets);
    const topic = topicId ? TOPICS.find((t) => t.id === topicId) : undefined;
    // Single-option topics (or unmatched presets) skip the topic
    // qualifier — "Wetter — CAPE" reads cleaner than
    // "Wetter — Precipitation · CAPE" when the topic and
    // sub-option are the same in spirit.
    document.title =
      topic && topic.label !== preset.label
        ? `${baseTitle} — ${topic.label} · ${preset.label}`
        : `${baseTitle} — ${preset.label}`;
  }, [activePreset, allPresets]);

  return (
    <div className="app">
      <div className="map-wrapper">
        <WeatherMap
          ref={mapRef}
          baseMap={baseMap}
          projection={projection}
          onProjectionChange={setProjection}
          terrain={terrain}
          hdr={hdr}
          weatherStyle={weatherStyle}
          activeTimestep={activeTimestep}
          layers={layers}
          selectedModel={selectedModel}
          selectedRun={
            isCompositeModel(selectedModel) ? undefined : selectedRun || undefined
          }
          availableVariables={availableVariables}
          unitPrefs={unitPrefs}
          onMapClick={handleMapClick}
          onMapHover={setHoverPoint}
          clickPoint={clickPoint}
          onGpuLoadingChange={setGpuLoading}
          onDemAvailabilityChange={setDemAvailable}
          onRunFlip={handleRunFlip}
          initialView={initialHash.current?.view}
          onViewChange={handleViewChange}
          windowMode={windowMode}
          activeWindow={activeWindow}
        />
        <PresetBar
          activePreset={activePreset}
          userPresets={allPresets}
          availableVariables={availableVariables}
          onLoadPreset={handleLoadPreset}
          onDeleteUserPreset={handleDeleteUserPreset}
          menuOpen={menuOpen}
          onToggleMenu={() => setMenuOpen((o) => !o)}
          hideHint={hideHint}
          upperHeight={upperHeight}
          onSetUpperHeight={handleSwapUpperHeight}
        />
        <Controls
          models={models}
          selectedModel={selectedModel}
          onModelChange={handleModelChange}
          runs={runs}
          latestRun={latestRun}
          selectedRun={selectedRun}
          onRunChange={handleRunChange}
          layers={layers}
          userPresets={allPresets}
          onSaveUserPreset={handleSaveUserPreset}
          onAddLayer={handleAddLayer}
          onRemoveLayer={handleRemoveLayer}
          onLayerUpdate={handleLayerUpdate}
          onLayerReorder={handleLayerReorder}
          availableVariables={availableVariables}
          variablesByModel={variablesByModel}
          unitPrefs={unitPrefs}
          onUnitPrefChange={handleUnitPrefChange}
          weatherStyle={weatherStyle}
          baseMap={baseMap}
          onBaseMapChange={setBaseMap}
          projection={projection}
          onProjectionChange={setProjection}
          terrain={terrain}
          onTerrainChange={setTerrain}
          hdr={hdr}
          onHdrChange={setHdr}
          timeFormat={effTimeFormat}
          onTimeFormatChange={setTimeFormat}
          leadLocked={synthetic}
          onOpenRunBrowser={() => setRunBrowserOpen(true)}
          playbackMsPerHour={playbackMsPerHour}
          onPlaybackMsPerHourChange={setPlaybackMsPerHour}
          open={menuOpen}
        />
        {runBrowserOpen && (
          <RunBrowser
            model={selectedModel}
            runs={runs}
            loading={runsLoading}
            error={runsError}
            selectedRun={selectedRun}
            onPin={handleRunChange}
            onClose={() => setRunBrowserOpen(false)}
          />
        )}
        <MapLegend
          layers={layers}
          weatherStyle={weatherStyle}
          selectedModel={selectedModel}
          selectedRun={
            isCompositeModel(selectedModel) ? undefined : selectedRun || undefined
          }
          unitPrefs={unitPrefs}
          windowMode={windowMode}
          onWindowModeChange={setWindowMode}
          onUnitPrefChange={handleUnitPrefChange}
          onLayerUpdate={handleLayerUpdate}
          lapseAvailable={demAvailable}
          epsTargetVariables={
            isCompositeModel(selectedModel) ? epsTargetVariables : undefined
          }
          variablesByModel={variablesByModel}
          compositeEps={compositeEpsState(selectedModel)}
          onMasterMode={(mode) => {
            // Master DET|EPS switch: composite-only. Flip the composite
            // default AND bulk-apply the mode to every visible tile layer
            // (Decision 4) — discarding prior per-layer overrides.
            if (!isCompositeModel(selectedModel)) return;
            handleModelChange(compositeModelForEps(mode === "eps"));
            setLayers((ls) => bulkApplyMode(ls, mode));
          }}
        />
        <StatusBadge
          model={selectedModel}
          models={models}
          onModelChange={handleModelChange}
          weatherStyle={weatherStyle}
          activeTimestep={activeTimestep}
          timeFormat={effTimeFormat}
          windowMode={windowMode}
          activeWindow={activeWindow}
          onOpenModelInfo={() => setModelInfoOpen(true)}
        />
        <LocationSearch onPick={handleSearchPick} />
        <div className="bottom-stack" ref={bottomStackRef}>
          <TimeBar
            weatherStyle={weatherStyle}
            activeTimestep={activeTimestep}
            onTimestepChange={setActiveTimestep}
            timeFormat={effTimeFormat}
            windowMode={windowMode}
            mapRef={mapRef}
            onPlayingChange={handlePlayingChange}
            msPerForecastHour={playbackMsPerHour}
          />
        </div>
        <LoadingIndicator
          active={loading || gpuLoading}
          hdr={hdr}
          onHdrChange={setHdr}
        />
        {detailView && clickPoint && (
          <DetailPage
            model={selectedModel}
            lat={clickPoint.lat}
            lon={clickPoint.lon}
            placeLabel={clickPoint.label}
            modelVariables={selectedModelVariables}
            allModels={models}
            activeProduct={primaryVar ?? undefined}
            unitPrefs={unitPrefs}
            timesteps={timesteps}
            run={
              isCompositeModel(selectedModel)
                ? undefined
                : selectedRun || undefined
            }
            timeFormat={effTimeFormat}
            view={detailView}
            onViewChange={setDetailView}
            onClose={() => setDetailView(null)}
          />
        )}
        {modelInfoOpen && (
          <ModelInfoPage
            model={selectedModel}
            weatherStyle={weatherStyle}
            baseMap={baseMap}
            satellite={satellite}
            terrain={terrain}
            onSetLayers={(ls, preset) => {
              setLayers(ls);
              setActivePreset(preset);
            }}
            onClose={() => setModelInfoOpen(false)}
          />
        )}
        <HoverValueLabel
          model={selectedModel}
          run={
            isCompositeModel(selectedModel)
              ? undefined
              : selectedRun || undefined
          }
          variables={hoverVars}
          timeIndex={activeTimestep}
          timesteps={timesteps}
          hover={hoverPoint}
          modelVariables={selectedModelVariables}
          unitPrefs={unitPrefs}
          lapseOffBases={lapseOff}
        />
        {clickPoint && (
          <PointPopup
            model={selectedModel}
            variable={primaryVar ?? ""}
            variables={pointVars}
            lapseOffBases={lapseOff}
            run={
              isCompositeModel(selectedModel)
                ? undefined
                : selectedRun || undefined
            }
            lat={clickPoint.lat}
            lon={clickPoint.lon}
            placeLabel={clickPoint.label}
            placeKind={clickPoint.kind}
            clickZoom={clickPoint.zoom}
            onOpenDetail={(label, view) => {
              // Remember the resolved place name so the detail page + hash carry it.
              setClickPoint((cp) => (cp ? { ...cp, label: cp.label ?? label } : cp));
              // Context-matched tab: the popup's Multi view opens multi-model.
              setDetailView(view ?? "detail");
            }}
            timeFormat={effTimeFormat}
            modelVariables={selectedModelVariables}
            allModels={models}
            unitPrefs={unitPrefs}
            activeTimestep={activeTimestep}
            onTimestepChange={setActiveTimestep}
            globalTimesteps={timesteps}
            onClose={() => setClickPoint(null)}
          />
        )}
      </div>
    </div>
  );
}

let _presetCounter = 0;
