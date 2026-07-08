// Unified map layer configuration.
//
// Every map is a flat ordered list of MapLayer objects. Each layer
// references a variable from the current model and a display mode
// (tiles, contour, value, barbs). The layer order determines
// rendering stacking (first = bottom on map, last = top).
//
// Default presets replace the old "specialized maps" (Wind,
// Clouds & Precip) and the single-variable mode.

import type { BaseMapId, AggOp } from "./types.ts";
import { parseWindowVar, splitEnsembleVar, buildWindowVar } from "./types.ts";
import { parseThresholdId } from "./distIds.ts";
import type { AvailableVariable } from "./v2catalog.ts";
import type { WindowMode } from "../time.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DisplayMode = "tiles" | "contour" | "value" | "barbs" | "flow";

export interface MapLayer {
  /** Stable unique id within the layer list. */
  id: string;
  /** Variable name, e.g. "t_2m", "pmsl", "wind_speed_10m". */
  variable: string;
  displayMode: DisplayMode;
  opacity: number; // 0–1
  visible: boolean;

  // -- contour config (displayMode === "contour") --
  contourInterval?: number;
  contourColor?: string; // CSS color, default "#ffffff"
  contourWidth?: number; // line width in px, default 1

  // -- grid / barbs / value config --
  gridSpacing?: number; // CSS px between adjacent grid points, default 20
  gridBundle?: string; // bundle alias for grid endpoint, e.g. "wind"
  gridValueProp?: string; // GeoJSON property to display in value mode
  iconScale?: number; // barb icon scale, default 1.0
  gridResolution?: number; // resolution scale for GeoJSON zoom (0.5 = half zoom, 1.0 = full)

  // -- GPU animation path (displayMode === "tiles" only). When set, the
  // layer skips the raster pipeline and renders via WeatherAnimLayer:
  // one R16I texture array per tile with all timesteps as slices, frame
  // switch via a single u_time uniform. Only int16-encoded variables
  // are eligible (the GPU shader's only supported encoding); float32 /
  // uint8 variables fall back to the raster path automatically.
  gpuAnim?: boolean;

  // -- tile colormap override (displayMode === "tiles"). When set, the
  // tile URL gets `?cmap=<name>` appended so the server renders using
  // this colormap instead of the variable's default. The legend picks
  // this up too. --
  colormap?: string;

  // -- stepped/smooth override for the chosen colormap. `true` forces
  // the canonical 1°/2°/5° temperature stepping rule onto whatever
  // palette the layer ended up on (so picking "plasma" still gives
  // discrete bands on a temperature field). `false` strips the
  // stepping a default-stepped temperature variable would otherwise
  // apply. `undefined` defers to the field default — temperature
  // fields default to stepped through their default colormap, every
  // other field is smooth. --
  stepped?: boolean;

  // -- drape interpolation (displayMode === "tiles"): 0 nearest, 1 bilinear,
  // 2 bicubic B-spline. undefined → nearest (the native-grid default). --
  interp?: number;

  // -- flow line options (displayMode === "flow") --
  flowParticles?: number;  // number of active particles, default 2000
  flowSpeed?: number;      // speed multiplier, default 1.0
  flowWidth?: number;      // line width in px, default 1.5
  flowColor?: string;      // trail color, default "rgba(255,255,255,1)"
  flowUVar?: string;       // u component variable name (default "u_10m")
  flowVVar?: string;       // v component variable name (default "v_10m")
  flowMaxAge?: number;     // trail length in steps, default 40

  /** Per-layer ensemble mode override for composite models.
   *  "det" routes the layer to `auto`; "eps" routes it to `auto_eps`.
   *  Absent ⇒ inherit the default derived from `selectedModel`
   *  (`auto_eps` → "eps", `auto` → "det"). Ignored on physical models. */
  ensembleMode?: "det" | "eps";

  /** Per-layer windowed-aggregation operator, applied at request time
   *  when window-mode ≠ Hourly. The op (max/min/mean/sum) is built into
   *  the request var id via buildWindowVar(base, N, op) — the window
   *  length N comes from the global window-mode, the op from this field.
   *  Kept as a small per-layer field rather than baked into
   *  layer.variable because layer.variable also carries the ensemble
   *  product suffix (`_p90`, `_ctrl`, threshold ids) which the product /
   *  threshold parsers read verbatim — a `__{N}h_{op}` token mixed in
   *  would break them. Absent = the variable's advertised default op
   *  (aggregations.default). Precip "Total" is NOT an op — it selects the
   *  precip_{N}h accumulation variable directly. */
  aggOp?: AggOp;

  /** Per-layer lapse-rate elevation correction for screen-temperature
   *  layers. "fixed" = ICAO −6.5 K/km (the server default), "moist" =
   *  saturated-adiabatic prior, "off" = raw model values. Absent ⇒ the
   *  server default (on/fixed) — only "moist"/"off" are sent as ?lapse=.
   *  Only meaningful for t_2m/td_2m layers when the model advertises
   *  `lapse.available`. */
  lapse?: "fixed" | "moist" | "off";
}

export interface MapConfig {
  id: string;
  label: string;
  description?: string;
  /** Glyph (emoji or short text) used as the preset's icon in the
   *  compact preset picker. */
  icon: string;
  layers: MapLayer[];
  /** Optional base-map override applied when this preset is loaded. */
  baseMap?: BaseMapId;
  /** Optional satellite-underlay override applied when this preset is
   *  loaded. Renders the ESA WorldCover RGB tiles behind the basemap. */
  satellite?: boolean;
  /** Marks user-defined presets stored in localStorage. */
  user?: boolean;
  /** Marks server-defined presets from the backend config (grib-viewer.yaml
   *  `presets:` block). Listed like user presets but not deletable and
   *  never persisted to localStorage. */
  server?: boolean;
}

// ---------------------------------------------------------------------------
// ID generation — simple counter, no external deps
// ---------------------------------------------------------------------------

let _nextId = 1;

export function nextLayerId(): string {
  return `ly-${_nextId++}`;
}

/** Create a MapLayer with sensible defaults. */
export function createLayer(
  variable: string,
  displayMode: DisplayMode,
  opts?: Partial<Omit<MapLayer, "id" | "variable" | "displayMode">>,
): MapLayer {
  // The since-run-start cumulative `tot_prec` is never shown as a layer:
  // on the auto composite it blends mixed-run anchors into garbage, and a
  // running total isn't what users want anyway. Canonicalise to precip_1h
  // (the precip display base — see DIST_DISPLAY_BASE) so every downstream
  // path serves the correct per-window accumulation (precip_1h hourly,
  // precip_{N}h windowed). ponytail: one choke point — decode + add-layer
  // both route through here, and all tile/point/legend code reads
  // layer.variable.
  if (variable === "tot_prec") variable = "precip_1h";
  return {
    id: nextLayerId(),
    variable,
    displayMode,
    opacity: opts?.opacity ?? 1,
    visible: opts?.visible ?? true,
    ensembleMode: opts?.ensembleMode,
    lapse: opts?.lapse,
    contourInterval: opts?.contourInterval,
    contourColor: opts?.contourColor,
    contourWidth: opts?.contourWidth,
    gridSpacing: opts?.gridSpacing,
    gridBundle: opts?.gridBundle,
    gridValueProp: opts?.gridValueProp,
    iconScale: opts?.iconScale,
    gridResolution: opts?.gridResolution,
    gpuAnim: opts?.gpuAnim,
    colormap: opts?.colormap,
    stepped: opts?.stepped,
    flowParticles: opts?.flowParticles,
    flowSpeed: opts?.flowSpeed,
    flowWidth: opts?.flowWidth,
    flowColor: opts?.flowColor,
    flowUVar: opts?.flowUVar,
    flowVVar: opts?.flowVVar,
    flowMaxAge: opts?.flowMaxAge,
  };
}

// ---------------------------------------------------------------------------
// Default presets
// ---------------------------------------------------------------------------

function makePreset(
  id: string,
  label: string,
  description: string,
  icon: string,
  layerSpecs: Array<[string, DisplayMode, Partial<Omit<MapLayer, "id" | "variable" | "displayMode">>?]>,
  opts?: { baseMap?: BaseMapId },
): MapConfig {
  // Guarantee every non-tile layer (contour / value / barbs / flow)
  // renders above every tile layer. In this codebase `layers[0]` is
  // the visible top (WeatherMap renders bottom-to-top via
  // [...layers].reverse()), so non-tiles must come FIRST. Tile layers
  // at the end of the array are added to the map first and end up
  // under the overlays. Array.prototype.sort is stable, so tiles keep
  // their authored order relative to each other, and so do non-tiles.
  const ordered = [...layerSpecs].sort((a, b) => {
    const aTile = a[1] === "tiles" ? 1 : 0;
    const bTile = b[1] === "tiles" ? 1 : 0;
    return aTile - bTile;
  });
  return {
    id,
    label,
    description,
    icon,
    layers: ordered.map(([v, dm, layerOpts]) => createLayer(v, dm, layerOpts)),
    baseMap: opts?.baseMap,
  };
}

// Presets follow a consistent pattern:
//   - One main scalar field shown as tiles.
//   - Synoptic context via a `pmsl` contour overlay.
//   - Related alternates as hidden tile layers the user can flip to
//     via the visibility checkbox — a quick-switch rather than a true
//     overlay.
// Order: surface weather first, custom last.
const pmslContour: Partial<Omit<MapLayer, "id" | "variable" | "displayMode">> = {
  opacity: 1,
  contourColor: "#ffffff",
  contourWidth: 1,
};

export const PRESETS: MapConfig[] = [
  makePreset(
    "wind",
    "Surface (10 m)",
    "10 m wind gusts and wind-speed flow overlay",
    "🌬️",
    [
      ["wind_gust_10m", "tiles", { opacity: 1, gpuAnim: true }],
      [
        "wind_speed_10m",
        "flow",
        {
          opacity: 1,
          flowParticles: 8000,
          // GPU flow's calibration anchor: at flowSpeed=1 a 10 km/h
          // wind advects 10 CSS px/sec.
          flowSpeed: 1.0,
          flowWidth: 1.5,
          flowColor: "rgba(255,255,255,1)",
          flowUVar: "u_10m",
          flowVVar: "v_10m",
        },
      ],
      ["wind_speed_10m", "tiles", { opacity: 1, visible: false, gpuAnim: true }],
      ["wind_dir_10m", "tiles", { opacity: 1, visible: false, gpuAnim: true }],
    ],
    { baseMap: "black" },
  ),
  makePreset(
    "temperature",
    "Air (2 m)",
    "2 m air temperature",
    "🌡️",
    [
      // gpuAnim opts tile layers into the WebGL2 path: one texture
      // array per tile (R16I for int16 archives, R32F for derived /
      // composite float32), frame switch via a single u_time uniform —
      // no per-frame fetch, no per-frame upload. Both int16 and
      // float32 are supported; only uint8 (raw satellite bands) still
      // falls back to raster.
      ["t_2m", "tiles", { opacity: 1, gpuAnim: true }],
    ],
    { baseMap: "grayscale" },
  ),
  makePreset(
    "temperature_lapsed",
    "Air (2 m, terrain)",
    "2 m air temperature corrected to the terrain elevation (lapse rate). Baked smooth at ingest where a DEM is available; falls back to the raw field otherwise.",
    "⛰️",
    [
      ["t_2m_lapsed", "tiles", { opacity: 1, gpuAnim: true }],
    ],
    { baseMap: "grayscale" },
  ),
  makePreset(
    "temperature_wetbulb",
    "Wet bulb (2 m)",
    "2 m wet-bulb temperature",
    "💦",
    [
      ["wetbulb_2m", "tiles", { opacity: 1, gpuAnim: true }],
    ],
    { baseMap: "grayscale" },
  ),
  makePreset(
    "temperature_theta_e",
    "Theta-e (2 m)",
    "2 m equivalent potential temperature",
    "🔥",
    [
      ["theta_e_2m", "tiles", { opacity: 1, gpuAnim: true }],
    ],
    { baseMap: "grayscale" },
  ),
  makePreset(
    "temperature_dewpoint",
    "Dew point (2 m)",
    "2 m dew-point temperature",
    "💧",
    [
      ["td_2m", "tiles", { opacity: 1, gpuAnim: true }],
    ],
    { baseMap: "grayscale" },
  ),
  makePreset(
    "temperature_ground",
    "Ground",
    "ground / surface skin temperature",
    "🌍",
    [
      ["t_g", "tiles", { opacity: 1, gpuAnim: true }],
    ],
    { baseMap: "grayscale" },
  ),
  makePreset(
    "precipitation",
    "Precipitation",
    "Hourly precipitation with total cloud cover",
    "🌧️",
    [
      ["precip_1h", "tiles", { opacity: 1, gpuAnim: true }],
      ["clct", "tiles", { opacity: 1, gpuAnim: true }],
      ["pmsl", "contour", { ...pmslContour, visible: false }],
      ["rain_gsp_1h", "tiles", { opacity: 1, visible: false, gpuAnim: true }],
      ["snow_gsp_1h", "tiles", { opacity: 1, visible: false, gpuAnim: true }],
    ],
    { baseMap: "grayscale" },
  ),
  makePreset(
    "humidity",
    "Humidity at Sea Level",
    "Relative humidity",
    "💧",
    [
      ["relhum_2m", "tiles", { opacity: 1, gpuAnim: true }],
      ["pmsl", "contour", { ...pmslContour, visible: false }],
      ["td_2m", "tiles", { opacity: 1, visible: false, gpuAnim: true }],
      ["dpd_2m", "tiles", { opacity: 1, visible: false, gpuAnim: true }],
      ["tqv", "tiles", { opacity: 1, visible: false, gpuAnim: true }],
    ],
  ),
  makePreset(
    "radiation",
    "Radiation",
    "Global (down-welling) shortwave radiation at the surface; direct/net on demand",
    "☀️",
    [
      ["global_rad", "tiles", { opacity: 1, gpuAnim: true }],
      ["aswdir_s", "tiles", { opacity: 1, visible: false, gpuAnim: true }],
      ["clct", "tiles", { opacity: 1, visible: false, gpuAnim: true }],
      ["asob_s", "tiles", { opacity: 1, visible: false, gpuAnim: true }],
    ],
    { baseMap: "grayscale" },
  ),
  makePreset(
    "pressure",
    "Pressure",
    "Sea-level pressure tiles and pressure contours",
    "🧭",
    [
      ["pmsl", "contour", pmslContour],
      ["pmsl", "tiles", { opacity: 1, gpuAnim: true }],
      ["ps", "tiles", { opacity: 1, visible: false, gpuAnim: true }]
    ],
  ),
  makePreset(
    "snow",
    "Snow",
    "Snow depth; snowfall rate and freezing level on demand",
    "❄️",
    [
      ["h_snow", "tiles", { opacity: 1, gpuAnim: true }],
      ["snow_gsp_1h", "tiles", { opacity: 1, visible: false, gpuAnim: true }],
      ["hzerocl", "tiles", { opacity: 1, visible: false, gpuAnim: true }],
    ],
    { baseMap: "black" },
  ),
  makePreset(
    "convection",
    "CAPE",
    "CAPE with wind barbs",
    "⚡",
    [
      ["cape_ml", "tiles", { opacity: 1, gpuAnim: true }],
      [
        "wind_speed_10m",
        "barbs",
        { opacity: 1, gridBundle: "wind", gridSpacing: 70, iconScale: 0.8 },
      ],
      ["precip_1h", "tiles", { opacity: 1, visible: false, gpuAnim: true }],
      ["wind_gust_10m", "tiles", { opacity: 1, visible: false, gpuAnim: true }],
    ],
  ),
  // Isobaric upper-air presets. Each is authored at the 500 hPa
  // template level; the shared height selector (PresetBar) rewrites
  // every level-bearing layer to 850/500/300 at request time, and the
  // height persists across phenomenon switches. The previous
  // hidden-alternate-level layers are gone — the selector replaces
  // them. Variables exist on icondglobal (deterministic, worldwide),
  // iconeueps (percentiles over Europe), and both composites; the
  // legend's Spread / Chance-of chips apply wherever the EPS products
  // are advertised.
  makePreset(
    "upper_geopotential",
    "Height",
    "Geopotential height contours over color fill (default 500 hPa)",
    "🗺️",
    [
      // 100 gpm interval = 10 dam; the frontend geopotential unit group
      // (units.ts) renders the labels in dam (e.g. "552"). The GPU
      // contour shader reads the interval in raw archive units (gpm),
      // so this is pinned in gpm, not dam.
      ["fi_500hpa", "contour", { ...pmslContour, contourInterval: 100 }],
      ["fi_500hpa", "tiles", { opacity: 1, gpuAnim: true }],
    ],
    { baseMap: "grayscale" },
  ),
  makePreset(
    "upper_temperature",
    "Temp",
    "Air-mass temperature with geopotential height contours (default 500 hPa)",
    "🌡️",
    [
      ["t_500hpa", "tiles", { opacity: 1, gpuAnim: true }],
      ["fi_500hpa", "contour", { ...pmslContour, contourInterval: 100 }],
    ],
    { baseMap: "grayscale" },
  ),
  makePreset(
    "upper_wind",
    "Jet",
    "Isobaric wind speed with flow overlay (default 500 hPa)",
    "🌀",
    [
      ["wind_speed_500hpa", "tiles", { opacity: 1, gpuAnim: true }],
      [
        "wind_speed_500hpa",
        "flow",
        {
          opacity: 1,
          flowParticles: 8000,
          flowSpeed: 1.0,
          flowWidth: 1.5,
          flowColor: "rgba(255,255,255,1)",
          flowUVar: "u_500hpa",
          flowVVar: "v_500hpa",
        },
      ],
    ],
    { baseMap: "black" },
  ),
  // Satellite presets (RGB / IR / cloud / channels) and the matching
  // sat_goes_* / sat_himawari models are currently disabled because
  // the Meteosat coverage gap leaves the global mosaic incomplete.
  // The backend still has the ingest + handler code in-tree — to
  // re-enable, restore the makePreset entries here, the satellite
  // topic in TOPICS below, and the model-registration blank imports
  // referenced from backend/cmd/api/main.go.
];

// ---------------------------------------------------------------------------
// Topic groups
// ---------------------------------------------------------------------------
//
// Topics are the user-facing buckets in the on-map preset bar. Each
// topic shows a single icon; when a topic is the active one, its
// `presetIds` are exposed as a sub-row of labelled buttons.
//
// `Custom` is a synthetic topic — its sub-options are the user's
// saved presets (loaded at runtime from localStorage). When the user
// has no saved presets, clicking Custom should open the side panel
// instead so they can build one.

export interface PresetTopic {
  id: string;
  label: string;
  icon: string;
  /** Preset id loaded when the topic icon is clicked. */
  defaultPresetId: string;
  /** Built-in preset ids exposed as sub-options under this topic, in
   *  display order. The Custom topic is empty here — user presets
   *  fill in dynamically. */
  presetIds: string[];
}

export const TOPICS: PresetTopic[] = [
  {
    id: "temperature",
    label: "Temperature",
    icon: "🌡️",
    defaultPresetId: "temperature",
    presetIds: [
      "temperature",
      "temperature_ground",
      "temperature_dewpoint",
      "temperature_wetbulb",
      "temperature_theta_e",
    ],
  },
  {
    // Renamed Precipitation → "Surface". Keeps the id "precipitation"
    // so saved presets / hashes referencing the topic id don't break.
    // Absorbs the former single-preset Wind and Pressure topics:
    // surface wind and MSL pressure are surface fields, not their own
    // topic icon. Humidity / CAPE / Snow / Radiation remain folded in
    // here as synoptic-scale moisture, instability, and insolation.
    id: "precipitation",
    label: "Surface",
    icon: "🌧️",
    defaultPresetId: "precipitation",
    presetIds: [
      "precipitation",
      "humidity",
      "convection",
      "snow",
      "radiation",
      "pressure",
      "wind",
    ],
  },
  // Satellite topic disabled — see comment by the (removed) satellite
  // presets above.
  {
    // Isobaric upper-air charts: synoptic height, air-mass temperature,
    // jet-level wind. Now also carries the geopotential concept the
    // removed Pressure topic used to own. Gains the shared height
    // selector (see PresetBar). The legend's Spread / Chance-of chips
    // apply on percentile-capable models.
    id: "upperair",
    label: "Upper air",
    icon: "🎈",
    defaultPresetId: "upper_geopotential",
    presetIds: ["upper_geopotential", "upper_temperature", "upper_wind"],
  },
  {
    id: "custom",
    label: "Custom",
    icon: "⭐",
    defaultPresetId: "",
    presetIds: [],
  },
];

// ---------------------------------------------------------------------------
// Exceedance-probability variants
// ---------------------------------------------------------------------------
//
// Probability products are options OF their base parameter, not
// standalone entries: a t_2m layer offers frost / ≥25 °C / ≥30 °C as
// a dropdown, gusts offer the Beaufort ladder, and so on. Selecting a
// variant rewrites layer.variable to the prob_* id (a plain 0–100 %
// variable on every endpoint); "off" returns to the base field.
// Variants whose archive isn't ingested on the active model are
// filtered against the catalog by the dropdown.

export interface ProbVariant {
  /** prob_* variable id, e.g. "prob_frost". */
  id: string;
  /** Short threshold label shown in the dropdown. */
  label: string;
}

const GUST_PROB_VARIANTS: ProbVariant[] = [
  { id: "prob_wind_bft5", label: "Bft 5 (≥8 m/s)" },
  { id: "prob_wind_bft7", label: "Bft 7 (≥14 m/s)" },
  { id: "prob_wind_bft8", label: "Bft 8 (≥17 m/s)" },
  { id: "prob_wind_bft10", label: "Bft 10 (≥25 m/s)" },
  { id: "prob_wind_bft12", label: "Bft 12 (≥33 m/s)" },
];

const RAD_PROB_VARIANTS: ProbVariant[] = [
  { id: "prob_rad_gt120w", label: "≥120 W/m²" },
  { id: "prob_rad_gt400w", label: "≥400 W/m²" },
  { id: "prob_rad_gt800w", label: "≥800 W/m²" },
];

/** Probability variants per base variable id. Field aliases that
 *  serve the same physical quantity (vmax_10m / wind_gust_10m,
 *  asob_s / aswdir_s) share one ladder. */
export const PROB_VARIANTS: Record<string, ProbVariant[]> = {
  t_2m: [
    { id: "prob_frost", label: "Frost (≤0 °C)" },
    { id: "prob_t2m_gt25c", label: "≥25 °C" },
    { id: "prob_t2m_gt30c", label: "≥30 °C" },
  ],
  wind_gust_10m: GUST_PROB_VARIANTS,
  vmax_10m: GUST_PROB_VARIANTS,
  precip_1h: [
    { id: "prob_prec_gt0p1mm", label: "≥0.1 mm/h" },
    { id: "prob_prec_gt1mm", label: "≥1 mm/h" },
    { id: "prob_prec_gt2mm", label: "≥2 mm/h" },
    { id: "prob_prec_gt5mm", label: "≥5 mm/h" },
    { id: "prob_prec_gt10mm", label: "≥10 mm/h" },
  ],
  asob_s: RAD_PROB_VARIANTS,
  aswdir_s: RAD_PROB_VARIANTS,
};

/** Reverse lookup: prob_* id → base variable id, preferring the first
 *  base that lists it (wind_gust_10m over vmax_10m, asob_s over
 *  aswdir_s). Returns undefined for non-probability ids. */
const PROB_VARIANT_BASE: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [base, variants] of Object.entries(PROB_VARIANTS)) {
    for (const v of variants) {
      if (!(v.id in out)) out[v.id] = base;
    }
  }
  return out;
})();

export function probVariantBase(varId: string): string | undefined {
  return PROB_VARIANT_BASE[varId];
}

/** Display base → dist archive base for the request-time threshold
 *  slider. Identity entries included so one lookup answers "is this
 *  base threshold-capable at all". `clct` is deliberately absent —
 *  the backend has no `%` unit token, so cloud cover gets no
 *  threshold slider (it still benefits from the percentile slider). */
export const DIST_BASES: Record<string, string> = {
  t_2m: "t_2m",
  td_2m: "td_2m",
  vmax_10m: "vmax_10m",
  wind_gust_10m: "vmax_10m",
  // The surface-wind layer variable is wind_speed_10m (the u/v-magnitude
  // derived name); it shares the wind_10m percentile/dist archive. No
  // layer ever carries a literal `wind_10m`, so only the display-name key
  // is mapped.
  wind_speed_10m: "wind_10m",
  pmsl: "pmsl",
  // Precip layers are the windowed precip_{N}h accumulations (precip_1h
  // hourly, precip_2h/3h/6h/12h/24h windows — see createLayer's tot_prec
  // canonicalisation and pointVarForLayer). Every window shares tot_prec's
  // member/dist archive for threshold + percentile products.
  precip_1h: "tot_prec",
  precip_2h: "tot_prec",
  precip_3h: "tot_prec",
  precip_6h: "tot_prec",
  precip_12h: "tot_prec",
  precip_24h: "tot_prec",
  tot_prec: "tot_prec",
  asob_s: "ghi",
  aswdir_s: "ghi",
  ghi: "ghi",
};

/** Dist base → preferred display base, the inverse of DIST_BASES.
 *  Preference is explicit (wind_gust_10m over vmax_10m, asob_s over
 *  aswdir_s/ghi, precip_1h over raw tot_prec); no single
 *  insertion-order rule over DIST_BASES reproduces this, so the table
 *  stays explicit — keep it in sync: every value of DIST_BASES must
 *  be a key here. Used to label the slider's owning parameter and to
 *  restore the layer when the threshold is switched off. */
export const DIST_DISPLAY_BASE: Record<string, string> = {
  t_2m: "t_2m",
  td_2m: "td_2m",
  vmax_10m: "wind_gust_10m",
  wind_10m: "wind_speed_10m",
  pmsl: "pmsl",
  tot_prec: "precip_1h",
  ghi: "asob_s",
};

/** Short human label per dist base for the live threshold readout
 *  ("P(precip > 2.5 mm/h)"). */
export const DIST_LABELS: Record<string, string> = {
  t_2m: "T2m",
  td_2m: "Td",
  vmax_10m: "gusts",
  wind_10m: "wind",
  pmsl: "MSLP",
  tot_prec: "precip",
  ghi: "radiation",
};

/** The available `{base}_spread` (server-derived p90 − p10) sibling for
 *  a value base, or null when the catalog publishes none. Spread product
 *  names don't uniformly track the dist base (`wind_gust_10m_spread` is
 *  named after the display var, while precip's spread is `tot_prec_spread`
 *  named after the archive base), so probe the base itself plus its dist
 *  base and display base. Used by the legend's Spread view-mode chip,
 *  offered only for forecast vars that actually publish a spread product. */
export function spreadIdFor(
  base: string,
  catalog: Map<string, { available?: boolean }>,
): string | null {
  const distB = DIST_BASES[base] ?? base;
  const dispB = DIST_DISPLAY_BASE[distB] ?? base;
  for (const cand of [`${base}_spread`, `${distB}_spread`, `${dispB}_spread`]) {
    const v = catalog.get(cand);
    if (v && v.available !== false) {
      // Precip spread is advertised on the archive base (tot_prec_spread), but
      // the consistent display id precip_{N}h_spread serves the same product via
      // the member kernel — return that so the request stays on precip_Nh and
      // the window swap can carry the suffix.
      const sb = strippedBase(base);
      if (sb === "tot_prec" || /^precip_\d+h$/.test(sb)) {
        return `${sb === "tot_prec" ? "precip_1h" : sb}_spread`;
      }
      return cand;
    }
  }
  return null;
}

/** EPS sibling of a deterministic model. A deterministic run has no
 *  ensemble, so its probability products live on the paired EPS
 *  suite of the same system — the per-layer Probability dropdown
 *  offers the sibling's variants and switches the model on pick
 *  (layers survive a model switch). */
export const EPS_SIBLING: Record<string, string> = {
  icondglobal: "iconepsglobal",
};

/** Topic id whose presetIds (or, for Custom, user-preset ids) include
 *  the supplied preset id. Returns null when the preset doesn't belong
 *  to any topic — typical of edited "custom" layouts. */
export function findTopicForPresetId(
  presetId: string | null,
  userPresets: MapConfig[],
): string | null {
  if (!presetId) return null;
  for (const t of TOPICS) {
    if (t.id === "custom") continue;
    if (t.presetIds.includes(presetId)) return t.id;
  }
  if (userPresets.some((p) => p.id === presetId)) return "custom";
  return null;
}

// Server-side overrides of built-in presets: config presets whose `id`
// matches a built-in replace it IN PLACE — the topic strips resolve
// preset ids through findPreset, so an overridden preset keeps its
// topic slot, threshold ladder, and hash id while taking its layers,
// label, and icon from grib-viewer.yaml. Installed once by applyServerPresets.
const presetOverrides = new Map<string, MapConfig>();

export function findPreset(id: string): MapConfig | undefined {
  return presetOverrides.get(id) ?? PRESETS.find((p) => p.id === id);
}

/** Install server presets from /api/presets: entries whose id matches a
 *  built-in become overrides (picked up via findPreset); the rest are
 *  returned for the ⭐ strip. */
export function applyServerPresets(configs: MapConfig[]): MapConfig[] {
  const extras: MapConfig[] = [];
  for (const c of configs) {
    if (PRESETS.some((p) => p.id === c.id)) {
      presetOverrides.set(c.id, c);
    } else {
      extras.push(c);
    }
  }
  return extras;
}

// ---------------------------------------------------------------------------
// User-defined presets (localStorage)
// ---------------------------------------------------------------------------
//
// User presets persist a snapshot of the current layer list under a
// chosen name + icon. Stored as JSON under USER_PRESETS_KEY. Layer
// IDs are not persisted — fresh ones are generated on load so two
// reloads of the same preset don't collide.

const USER_PRESETS_KEY = "wx:userPresets";

interface StoredUserPreset {
  id: string;
  label: string;
  description?: string;
  icon: string;
  baseMap?: BaseMapId | "esa-worldcover";
  satellite?: boolean;
  /** Plain-data layer specs (no IDs); IDs are generated on load. */
  layers: Omit<MapLayer, "id">[];
}

function isStoredUserPreset(x: unknown): x is StoredUserPreset {
  if (!x || typeof x !== "object") return false;
  const p = x as Partial<StoredUserPreset>;
  return (
    typeof p.id === "string" &&
    typeof p.label === "string" &&
    typeof p.icon === "string" &&
    Array.isArray(p.layers)
  );
}

export function loadUserPresets(): MapConfig[] {
  try {
    const raw = localStorage.getItem(USER_PRESETS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStoredUserPreset).map((sp) => {
      // Migration: the old "esa-worldcover" baseMap is now a separate
      // satellite-underlay toggle. Convert stored presets so they keep
      // the same visual when reloaded.
      const isLegacySat = sp.baseMap === "esa-worldcover";
      return {
        id: sp.id,
        label: sp.label,
        description: sp.description,
        icon: sp.icon,
        baseMap: isLegacySat ? undefined : (sp.baseMap as BaseMapId | undefined),
        satellite: sp.satellite || isLegacySat || undefined,
        user: true,
        layers: sp.layers.map((l) => ({ ...l, id: nextLayerId() })),
      };
    });
  } catch {
    return [];
  }
}

export function saveUserPresets(presets: MapConfig[]): void {
  try {
    const stored: StoredUserPreset[] = presets.map((p) => ({
      id: p.id,
      label: p.label,
      description: p.description,
      icon: p.icon,
      baseMap: p.baseMap,
      satellite: p.satellite,
      // Strip per-instance IDs so reloading regenerates them.
      layers: p.layers.map(({ id: _id, ...rest }) => rest),
    }));
    localStorage.setItem(USER_PRESETS_KEY, JSON.stringify(stored));
  } catch {
    // Storage unavailable — silently drop.
  }
}

export function makeUserPresetId(): string {
  return `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Server-defined preset as /api/presets delivers it (the backend
 *  config's `presets:` block, verbatim). */
export interface ServerPreset {
  /** Optional stable id. Matching a built-in preset's id OVERRIDES that
   *  built-in in place (same topic slot); otherwise the id names the
   *  entry in the ⭐ strip and the URL hash. */
  id?: string;
  name: string;
  icon: string;
  description?: string;
  /** Share-URL layer grammar, e.g. "vmax_10m.t.10.ga,!pmsl.c.10". */
  layers: string;
  base_map?: string;
}

/** Convert /api/presets entries into picker configs. Layer specs use
 *  the share-URL grammar (decodeLayerSegment); entries whose layers all
 *  fail to parse are dropped. Ids derive from the name so the active
 *  preset survives reloads and can ride the URL hash. */
export function serverPresetsToConfigs(presets: ServerPreset[]): MapConfig[] {
  const out: MapConfig[] = [];
  for (const sp of presets) {
    const layers = sp.layers
      .split(",")
      .filter(Boolean)
      .map(decodeLayerSegment)
      .filter((l): l is MapLayer => l != null);
    if (layers.length === 0) continue;
    out.push({
      id: sp.id || `srv-${sp.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      label: sp.name,
      description: sp.description,
      icon: sp.icon || "⭐",
      baseMap: sp.base_map as BaseMapId | undefined,
      server: true,
      layers,
    });
  }
  return out;
}

/** Build a user MapConfig from the current layer list. Layers are
 *  cloned (id stripped) so subsequent edits don't mutate the saved
 *  version. */
export function buildUserPreset(
  label: string,
  icon: string,
  layers: MapLayer[],
  baseMap?: BaseMapId,
  satellite?: boolean,
  description?: string,
): MapConfig {
  return {
    id: makeUserPresetId(),
    label,
    description,
    icon,
    baseMap,
    satellite: satellite || undefined,
    user: true,
    // Fresh IDs so the preset's layers don't share IDs with the live
    // ones we built it from — important for detectPreset's identity
    // checks and for any subsequent in-place edits.
    layers: layers.map((l) => ({ ...l, id: nextLayerId() })),
  };
}

// ---------------------------------------------------------------------------
// URL hash encoding / decoding
// ---------------------------------------------------------------------------
//
// Format:
//   #m=icond2&l=t_2m.t.7,!vmax_10m.t.6,pmsl.c.8.i1000.cwhite.w10&p=wind&base=dark&proj=merc&3d
//
// Layer segment: [!]variable.mode.opacityX10[.options...]
//   mode: t=tiles, c=contour, v=value, b=barbs
//   ! prefix = hidden layer
//   Options (dot-separated): i<interval>, c<color>, w<width>,
//     s<spacing>, k<iconScaleX10>, g<gridBundle>, vp<valueProp>

const MODE_TO_CHAR: Record<DisplayMode, string> = {
  tiles: "t",
  contour: "c",
  value: "v",
  barbs: "b",
  flow: "f",
};
const CHAR_TO_MODE: Record<string, DisplayMode> = {
  t: "tiles",
  c: "contour",
  v: "value",
  b: "barbs",
  f: "flow",
};

export interface MapHashState {
  model?: string;
  run?: string;
  presetId?: string;
  layers: MapLayer[];
  base?: string;
  proj?: string;
  /** Point-of-interest "lat,lon[,label]" — opens the point popup on load. */
  pt?: string;
  terrain?: boolean;
  satellite?: boolean;
  /** Map camera (center / zoom / bearing / pitch). Only emitted into
   *  the hash once the user has actually moved the map; absent on
   *  fresh first-loads so the default view in WeatherMap takes over. */
  view?: MapView;
  /** Active window-mode. Omitted when "hourly" (the default) to keep
   *  existing shared links unchanged. */
  windowMode?: WindowMode;
  /** RFC3339 anchor of the active time window (startIso). Omitted when
   *  absent / irrelevant (hourly mode). */
  anchor?: string;
  /** Time display format ("utc" | "local" | "lead"). Omitted when "utc"
   *  (the default) to keep the hash compact. */
  tf?: string;
}

export interface MapView {
  /** [lng, lat] */
  center: [number, number];
  zoom: number;
  bearing?: number;
  pitch?: number;
}

export function encodeLayerSegment(layer: MapLayer): string {
  const prefix = layer.visible ? "" : "!";
  const opInt = Math.round(layer.opacity * 10);
  const mode = MODE_TO_CHAR[layer.displayMode] ?? "t";
  let seg = `${prefix}${layer.variable}.${mode}.${opInt}`;

  // Contour options
  if (layer.contourInterval != null) seg += `.i${layer.contourInterval}`;
  if (layer.contourColor && layer.contourColor !== "#ffffff") {
    // Strip # for compactness
    seg += `.c${layer.contourColor.replace("#", "")}`;
  }
  if (layer.contourWidth != null && layer.contourWidth !== 1) {
    seg += `.w${layer.contourWidth}`;
  }

  // Grid options
  if (layer.gridSpacing != null && layer.gridSpacing !== 20) {
    seg += `.s${layer.gridSpacing}`;
  }
  if (layer.iconScale != null && layer.iconScale !== 1.0) {
    seg += `.k${Math.round(layer.iconScale * 10)}`;
  }
  if (layer.gridResolution != null && layer.gridResolution !== 0.5) {
    seg += `.gr${Math.round(layer.gridResolution * 10)}`;
  }
  if (layer.gridBundle) seg += `.g${layer.gridBundle}`;
  if (layer.gridValueProp) seg += `.vp${layer.gridValueProp}`;

  // Flow options
  if (layer.flowParticles != null && layer.flowParticles !== 2000) {
    seg += `.fp${layer.flowParticles}`;
  }
  if (layer.flowSpeed != null && layer.flowSpeed !== 1.0) {
    seg += `.fs${Math.round(layer.flowSpeed * 10)}`;
  }

  // Colormap override (tile layers). Hex-safe names only so no encoding dance.
  if (layer.colormap) {
    seg += `.cm${layer.colormap}`;
  }

  // GPU animation flag (tile layers). Single bit; presence == enabled.
  if (layer.gpuAnim) {
    seg += `.ga`;
  }

  // Stepped/smooth override. .st1 forces stepped, .st0 forces smooth;
  // absent leaves the field default in place.
  if (layer.stepped === true) {
    seg += `.st1`;
  } else if (layer.stepped === false) {
    seg += `.st0`;
  }

  // Windowed-aggregation op. Absent = the variable's advertised default.
  if (layer.aggOp) seg += `.ao${layer.aggOp}`;

  // Per-layer ensemble mode. Absent = inherit from selectedModel.
  if (layer.ensembleMode === "det") seg += `.det`;
  else if (layer.ensembleMode === "eps") seg += `.eps`;

  // Per-layer drape lapse-rate toggle (E5). Absent = on (server/drape default).
  if (layer.lapse) seg += `.lp${layer.lapse}`;

  // Drape interpolation override. Absent = nearest (0), the native default.
  if (layer.interp) seg += `.ip${layer.interp}`;

  return seg;
}

export function decodeLayerSegment(seg: string): MapLayer | null {
  const hidden = seg.startsWith("!");
  if (hidden) seg = seg.slice(1);

  const parts = seg.split(".");
  if (parts.length < 3) return null;

  const variable = parts[0];
  const mode = CHAR_TO_MODE[parts[1]];
  if (!mode) return null;

  const opInt = parseInt(parts[2], 10);
  if (isNaN(opInt)) return null;

  const layer = createLayer(variable, mode, {
    opacity: Math.min(1, Math.max(0, opInt / 10)),
    visible: !hidden,
  });

  // Parse optional segments
  for (let i = 3; i < parts.length; i++) {
    const p = parts[i];
    if (p.startsWith("ip")) {
      // Exact-prefix before the generic "i" (contour interval) handler.
      layer.interp = parseInt(p.slice(2), 10) || 0;
    } else if (p.startsWith("i")) {
      layer.contourInterval = parseFloat(p.slice(1));
    } else if (p.startsWith("cm")) {
      layer.colormap = p.slice(2);
    } else if (p.startsWith("c")) {
      layer.contourColor = `#${p.slice(1)}`;
    } else if (p.startsWith("w")) {
      layer.contourWidth = parseFloat(p.slice(1));
    } else if (p.startsWith("s")) {
      layer.gridSpacing = parseInt(p.slice(1), 10);
    } else if (p.startsWith("k")) {
      layer.iconScale = parseInt(p.slice(1), 10) / 10;
    } else if (p.startsWith("gr")) {
      layer.gridResolution = parseInt(p.slice(2), 10) / 10;
    } else if (p === "ga") {
      // Exact-match before the generic "g" prefix handler.
      layer.gpuAnim = true;
    } else if (p.startsWith("g")) {
      layer.gridBundle = p.slice(1);
    } else if (p.startsWith("vp")) {
      layer.gridValueProp = p.slice(2);
    } else if (p.startsWith("fp")) {
      layer.flowParticles = parseInt(p.slice(2), 10);
    } else if (p.startsWith("fs")) {
      layer.flowSpeed = parseInt(p.slice(2), 10) / 10;
    } else if (p.startsWith("lv")) {
      // Legacy hash token: vertical levels were once encoded as a
      // separate `.lv<N>` token. Upper-level layers are no longer
      // served, so the token is silently discarded.
    } else if (p === "ne") {
      // Legacy hash token: per-layer EPS opt-out, removed with the
      // global Baseline picker. Silently discarded so old links load.
    } else if (p === "st1") {
      layer.stepped = true;
    } else if (p === "st0") {
      layer.stepped = false;
    } else if (p.startsWith("ao")) {
      layer.aggOp = p.slice(2) as AggOp;
    } else if (p === "det") {
      layer.ensembleMode = "det";
    } else if (p === "eps") {
      layer.ensembleMode = "eps";
    } else if (p.startsWith("lp")) {
      layer.lapse = p.slice(2) as MapLayer["lapse"];
    }
  }

  return layer;
}

/** Round a number to N decimal places without trailing zeros so the
 *  hash stays compact (`8.5,47.4,6` rather than
 *  `8.500000,47.400000,6.000000`). */
function trim(n: number, dp: number): string {
  return parseFloat(n.toFixed(dp)).toString();
}

function encodeView(v: MapView): string {
  // lng,lat with 4 dp ≈ 11 m at the equator — plenty for shareable
  // bookmarks. Zoom keeps 2 dp because fractional zoom drives tile
  // sampling math elsewhere.
  const parts = [trim(v.center[0], 4), trim(v.center[1], 4), trim(v.zoom, 2)];
  if (v.bearing && Math.abs(v.bearing) > 0.5) parts.push(trim(v.bearing, 1));
  if (v.pitch && Math.abs(v.pitch) > 0.5) {
    if (parts.length === 3) parts.push("0"); // pad bearing
    parts.push(trim(v.pitch, 1));
  }
  return parts.join(",");
}

function decodeView(raw: string): MapView | undefined {
  const parts = raw.split(",").map((s) => parseFloat(s));
  if (parts.length < 3) return undefined;
  const [lng, lat, zoom, bearing, pitch] = parts;
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || !Number.isFinite(zoom)) {
    return undefined;
  }
  const view: MapView = { center: [lng, lat], zoom };
  if (Number.isFinite(bearing)) view.bearing = bearing;
  if (Number.isFinite(pitch)) view.pitch = pitch;
  return view;
}

export function encodeMapHash(state: MapHashState): string {
  const params: string[] = [];
  if (state.model) params.push(`m=${state.model}`);
  if (state.run) params.push(`r=${state.run}`);
  if (state.presetId) params.push(`p=${state.presetId}`);
  if (state.layers.length > 0) {
    params.push(`l=${state.layers.map(encodeLayerSegment).join(",")}`);
  }
  if (state.base && state.base !== "grayscale") params.push(`base=${state.base}`);
  // Globe is the default projection — only a non-default (mercator) is
  // written, so bare URLs open in globe and legacy proj=globe links stay valid.
  if (state.proj && state.proj !== "globe") params.push(`proj=${state.proj}`);
  if (state.pt) params.push(`pt=${encodeURIComponent(state.pt)}`);
  if (state.terrain) params.push("3d");
  if (state.satellite) params.push("sat");
  if (state.view) params.push(`v=${encodeView(state.view)}`);
  if (state.windowMode && state.windowMode !== "hourly") params.push(`wm=${state.windowMode}`);
  if (state.anchor) params.push(`an=${encodeURIComponent(state.anchor)}`);
  if (state.tf && state.tf !== "utc") params.push(`tf=${state.tf}`);
  return params.length > 0 ? `#${params.join("&")}` : "";
}

export function decodeMapHash(hash: string): MapHashState | null {
  if (!hash || hash === "#") return null;
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const pairs = raw.split("&");
  const state: MapHashState = { layers: [] };

  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq < 0) {
      // Flag without value
      if (pair === "3d") state.terrain = true;
      if (pair === "sat") state.satellite = true;
      continue;
    }
    const key = pair.slice(0, eq);
    const val = decodeURIComponent(pair.slice(eq + 1));
    switch (key) {
      case "m":
        state.model = val;
        break;
      case "r":
        state.run = val;
        break;
      case "p":
        state.presetId = val;
        break;
      case "l": {
        const segs = val.split(",").filter(Boolean);
        for (const seg of segs) {
          const layer = decodeLayerSegment(seg);
          if (layer) state.layers.push(layer);
        }
        break;
      }
      case "base":
        // Migrate legacy esa-worldcover basemap to the new satellite
        // toggle so old shared links keep working.
        if (val === "esa-worldcover") {
          state.satellite = true;
        } else {
          state.base = val;
        }
        break;
      case "proj":
        state.proj = val;
        break;
      case "pt":
        state.pt = decodeURIComponent(val);
        break;
      // Legacy `ep=` (global ensemble plane) is silently ignored — the
      // Baseline picker was removed; view-mode now lives in layer ids.
      case "v": {
        const view = decodeView(val);
        if (view) state.view = view;
        break;
      }
      case "wm":
        state.windowMode = val as WindowMode;
        break;
      case "an":
        state.anchor = val;
        break;
      case "tf":
        state.tf = val;
        break;
    }
  }
  return state;
}

/** Strip any ensemble product / threshold suffix from a variable id,
 *  returning the raw value base. Mirrors PrimaryEpsEntry's base
 *  resolution: threshold (chance) → spread → mean → ensemble plane
 *  (`_p{P}` / `_ctrl` / `_m{N}` via splitEnsembleVar). splitEnsembleVar
 *  does NOT know `_mean`/`_spread`, so they're peeled explicitly first. */
export function strippedBase(id: string): string {
  const thr = parseThresholdId(id);
  if (thr) return thr.base;
  if (id.endsWith("_spread")) return id.slice(0, -"_spread".length);
  if (id.endsWith("_mean")) return id.slice(0, -"_mean".length);
  return splitEnsembleVar(id).base;
}

/** Fixed ICAO environmental lapse rate (K/m) applied by the GPU drape
 *  elevation correction: T_site = T_model + γ·(z_site − z_model). The
 *  frontend's single source of this constant — the shader (E4) and the
 *  manager (E3) both read it. Mirrors the backend's −6.5 K/km default. */
export const LAPSE_GAMMA = -0.0065;

/** True when a variable id is a screen-temperature field the drape lapse
 *  correction applies to: base ∈ {t_2m, td_2m} after stripping the window
 *  token (`__{N}h_{op}`) and any ensemble plane suffix (`_p{P}` / `_mean` /
 *  `_ctrl` / `_m{N}`). Chance-of (`_gt`/`_lt`) and `_spread` ids are
 *  EXCLUDED — a threshold-probability or a spread field isn't an absolute
 *  temperature, so lapse-shifting it is meaningless. strippedBase resolves
 *  both threshold and spread ids back to their temperature base, so those
 *  two are guarded explicitly BEFORE it (mirroring windowAggFor's
 *  parseThresholdId-first ordering). */
export function isLapseVar(id: string): boolean {
  const windowBase = parseWindowVar(id).base;
  if (parseThresholdId(windowBase)) return false; // _gt/_lt chance-of
  if (windowBase.endsWith("_spread")) return false; // p90−p10 difference field
  const base = strippedBase(windowBase);
  return base === "t_2m" || base === "td_2m";
}

/** Identity of a drape unit's lapse state for change-detection: the manager
 *  early-returns applyLapse when this is unchanged, so real texture uploads only
 *  happen on a viewport (bbox) / pyramid-level / on-off transition — not every
 *  vsync. `level` is irrelevant (and −1) when off, so the off state collapses to
 *  one key regardless of level. */
export function lapseGateKey(on: boolean, bbox: string, level: number): string {
  return on ? `1|${bbox}|${level}` : "0";
}

/** Base variable id after stripping both the window token and any ensemble /
 *  threshold suffix — e.g. `t_2m_p90__24h_max` → `t_2m`. Used to match a
 *  derived fetch id (a percentile band variant, a windowed hover id) back to
 *  the layer whose ⛰ toggle governs it. Does NOT itself gate on whether the
 *  variable is lapse-eligible — pair with `isLapseVar`. */
export function lapseBase(id: string): string {
  return strippedBase(parseWindowVar(id).base);
}

/** E5: gating predicate for the per-layer ⛰ lapse toggle chip in the legend.
 *  Shown only for lapse-eligible variables (isLapseVar) when the shared
 *  z_site DEM resolved available this session (WxLayerManager's
 *  onDemAvailability callback, surfaced to the legend via App state). Pure
 *  so it's unit-testable without mounting MapLegend. */
export function showLapseToggle(variable: string, demAvailable: boolean): boolean {
  return demAvailable && isLapseVar(variable);
}

/** Flip a layer's lapse toggle: on (default — undefined/"fixed") ↔ off.
 *  Reuses the existing point-query field (MapLayer.lapse) as the single
 *  source of truth for both the GPU drape's on/off state and the ?lapse=
 *  query param on point/hover requests, so the two can never drift. */
export function toggleLapse(current: MapLayer["lapse"]): MapLayer["lapse"] {
  return current === "off" ? undefined : "off";
}

/** Base ids (t_2m/td_2m) whose ⛰ toggle is OFF among the visible layers —
 *  feeds `isLapseOffForFetch` so point/hover requests for a DERIVED id (a
 *  percentile band variant, a windowed hover id) inherit the same toggle
 *  state as the layer that owns it. A base lands in the off-set ONLY IF
 *  every visible lapse-eligible layer sharing that base is off — any ONE
 *  visible layer left on wins and keeps the base out of the set. This
 *  avoids cross-layer bleed (e.g. a `t_2m` drape toggled off must not
 *  silently strip lapse correction from a co-visible `t_2m_p90` layer
 *  that's still on). The remaining same-base-mixed ambiguity (which of
 *  several ON layers "owns" a derived fetch id) is deliberately biased
 *  toward CORRECTED values, matching the server's own `?lapse=` default. */
export function lapseOffBases(layers: MapLayer[]): Set<string> {
  const onBases = new Set<string>();
  const offBases = new Set<string>();
  for (const l of layers) {
    if (!l.visible || !isLapseVar(l.variable)) continue;
    const base = lapseBase(l.variable);
    if (l.lapse === "off") {
      offBases.add(base);
    } else {
      onBases.add(base);
    }
  }
  const out = new Set<string>();
  for (const base of offBases) {
    if (!onBases.has(base)) out.add(base);
  }
  return out;
}

/** True when a point/hover fetch id `id` should carry `?lapse=off`, per the
 *  visible layers' toggle states in `offBases` (see `lapseOffBases`). */
export function isLapseOffForFetch(id: string, offBases: Set<string>): boolean {
  return isLapseVar(id) && offBases.has(lapseBase(id));
}

/** The Median / forecast-value form of a variable id — the bare
 *  `displayVar` the legend's `Med` segment restores (alias families:
 *  gusts → wind_gust_10m, precip → precip_1h, radiation → asob_s).
 *  Idempotent on ids that are already Median. */
export function medianVarId(id: string): string {
  const rawBase = strippedBase(id);
  const distBase = DIST_BASES[rawBase] ?? rawBase;
  return DIST_DISPLAY_BASE[distBase] ?? rawBase;
}

// ---------------------------------------------------------------------------
// Window-mode aggregation helpers (caps-driven)
// ---------------------------------------------------------------------------
//
// The set of window ops (max/min/mean/sum) a variable supports — and the
// op offered by default — is advertised by the backend per variable in
// the `aggregations` capability (Task B3), surfaced through
// `AvailableVariable`. The frontend reads it from the live catalog
// (`varInfo`), never a hardcoded table. While the catalog is still
// loading, or a variable carries no `aggregations` (diagnostics like
// wetbulb_2m, precip accumulations served via the precip_{N}h swap), the
// helpers return null/false and the legend shows no window-op chips.

/** Resolve a (possibly suffixed) variable id to its catalog base. Strips
 *  the window token (`__{N}h[_{op}]`) then every ensemble product
 *  (`_mean` / `_spread` / `_gt`/`_lt` threshold / `_p{P}` / `_ctrl` /
 *  `_m{N}`) so the lookup lands on the base archive variable.
 *  splitEnsembleVar alone misses `_mean`/`_spread`/threshold, so a Mean
 *  layer (t_2m_mean) failed catalog lookups — HoverValueLabel then
 *  resolved no unit group and showed raw Kelvin instead of °C. Uses the
 *  shared strippedBase peeler after removing the window token. */
export function aggBase(varId: string): string {
  return strippedBase(parseWindowVar(varId).base);
}

/** Windowed-aggregation capability for a variable from the live catalog,
 *  or null when the catalog hasn't loaded the base, or the base has no
 *  aggregations. */
export function aggCapsFor(
  varInfo: Map<string, AvailableVariable>,
  varId: string,
): { ops: string[]; default: string } | null {
  return varInfo.get(aggBase(varId))?.aggregations ?? null;
}

export function supportsAgg(
  varInfo: Map<string, AvailableVariable>,
  varId: string,
): boolean {
  return aggCapsFor(varInfo, varId) != null;
}

/** The op the legend's primary tile entry currently carries — the value
 *  the non-tile wind layers inherit. "Primary entry" = the first visible
 *  `tiles` layer (matching how MapLegend derives its primary from
 *  tileLayers). Null when there is no windable primary. */
export function primaryAggOp(
  layers: MapLayer[],
  varInfo: Map<string, AvailableVariable>,
): string | null {
  const primary = layers.find((l) => l.visible && l.displayMode === "tiles");
  if (!primary) return null;
  const caps = aggCapsFor(varInfo, primary.variable);
  if (!caps) return null;
  return primary.aggOp ?? caps.default;
}

/** Resolve the window op for a non-tile layer: inherit `primaryOp` when the
 *  layer's own variable supports it, else fall back to that variable's
 *  default. Null when the layer's variable advertises no aggregations. */
export function inheritedWindowOp(
  layer: MapLayer,
  primaryOp: string | null,
  varInfo: Map<string, AvailableVariable>,
): string | null {
  const caps = aggCapsFor(varInfo, layer.variable);
  if (!caps) return null;
  if (primaryOp && caps.ops.includes(primaryOp)) return primaryOp;
  return caps.default;
}

/** Windowed u,v request string for flow/barbs: "u__Nh_op,v__Nh_op". */
export function windowedWindVars(
  uVar: string,
  vVar: string,
  spanHours: number,
  op: string,
): string {
  return `${buildWindowVar(uVar, spanHours, op)},${buildWindowVar(vVar, spanHours, op)}`;
}

const WIND_BUNDLE_COMPONENTS: Record<string, [string, string]> = {
  wind: ["u_10m", "v_10m"],
};

/** The (u,v) component pair for a wind grid/flow layer, from explicit
 *  flowUVar/flowVVar or a known gridBundle. Null for non-vector layers. */
export function gridWindComponents(layer: MapLayer): [string, string] | null {
  if (layer.flowUVar && layer.flowVVar) return [layer.flowUVar, layer.flowVVar];
  if (layer.gridBundle && WIND_BUNDLE_COMPONENTS[layer.gridBundle]) {
    return WIND_BUNDLE_COMPONENTS[layer.gridBundle];
  }
  return null;
}

/** Windowed grid request vars for a barbs/value layer, or null in hourly
 *  mode / when the layer has no aggregations. Wind-vector layers window the
 *  (u,v) pair; scalar layers window the single effective var. `primaryOp`
 *  is the inherited op (see primaryAggOp). */
export function windowedGridVars(
  layer: MapLayer,
  windowMode: WindowMode,
  spanHours: number,
  varInfo: Map<string, AvailableVariable>,
  primaryOp: string | null,
): string | null {
  if (windowMode === "hourly") return null;
  const op = inheritedWindowOp(layer, primaryOp, varInfo);
  if (!op) return null;
  const comp = gridWindComponents(layer);
  if (comp) return windowedWindVars(comp[0], comp[1], spanHours, op);
  return buildWindowVar(layer.variable, spanHours, op);
}

// ---------------------------------------------------------------------------
// Isobaric upper-air level helpers
// ---------------------------------------------------------------------------
//
// The upper-air presets carry their pressure level in the variable id
// (`fi_500hpa`, `t_850hpa`, `wind_speed_300hpa`, `u_300hpa`). The shared
// height selector reads the active level from the live layers and
// rewrites every level-bearing layer to a new level — no separate
// hash/preset field. These are pure string helpers.

/** Parse the isobaric pressure level (hPa) out of a variable id like
 *  "fi_500hpa", "t_850hpa", "wind_speed_300hpa", or "fi_500hpa[dam]".
 *  The grammar is a trailing `_{digits}hpa` token. Returns null for
 *  non-isobaric ids (surface fields, pmsl, u_10m, …). */
export function parseIsobarLevel(varId: string): number | null {
  const m = /_(\d+)hpa/.exec(varId);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Rewrite the isobaric level token of a variable id to `hPa`,
 *  preserving the (possibly compound) base and any trailing [unit]
 *  bracket. Non-isobaric ids pass through unchanged.
 *    swapIsobarLevel("fi_500hpa[dam]", 850)    === "fi_850hpa[dam]"
 *    swapIsobarLevel("wind_speed_300hpa", 500) === "wind_speed_500hpa"
 *    swapIsobarLevel("pmsl", 500)              === "pmsl" */
export function swapIsobarLevel(varId: string, hPa: number): string {
  return varId.replace(/_(\d+)hpa/, `_${hPa}hpa`);
}

/** The pressure level of the first level-bearing layer in the list, or
 *  null when no layer carries an isobaric level. Drives the upper-air
 *  height selector — the active height is derived from the live layers,
 *  not stored separately. */
export function activeIsobarLevel(layers: MapLayer[]): number | null {
  for (const l of layers) {
    const lvl = parseIsobarLevel(l.variable);
    if (lvl != null) return lvl;
  }
  return null;
}

/** Drives the style.json fetch: prefers the first visible tile layer,
 *  falls back to the first visible layer of any mode. The fallback
 *  lets GeoJSON-only maps (contour / barbs / value / flow) still
 *  obtain a timestep axis so the TimeBar renders and animation plays.
 *  Tile layers are preferred so WeatherMap's tile-URL swapping in
 *  deriveLayerStyle keeps matching the fetched style. */
export function primaryVariable(layers: MapLayer[]): string | undefined {
  const tileLayer = layers.find(
    (l) => l.visible && l.displayMode === "tiles",
  );
  if (tileLayer) return tileLayer.variable;
  const anyLayer = layers.find((l) => l.visible);
  return anyLayer ? anyLayer.variable : undefined;
}

/** Collect unique variables from all visible layers (for point popup). */
export function visibleVariables(layers: MapLayer[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const l of layers) {
    if (!l.visible) continue;
    const v = l.variable;
    if (seen.has(v)) continue;
    seen.add(v);
    result.push(v);
  }
  return result;
}

/** True when the layer's base variable is precip accumulation, so a
 *  windowed point/tile request is a `precip_{N}h` accumulation rather
 *  than a windowed op. Matches the ensemble-product forms too
 *  (`precip_1h_mean`, `precip_6h_p90`, …) via strippedBase, so those
 *  route through the suffix-preserving precip window swap. */
export function isPrecipTotalLayer(layer: MapLayer): boolean {
  const base = strippedBase(layer.variable);
  return base === "tot_prec" || /^precip_\d+h$/.test(base);
}

/** The window-mode aggregation OP for a tile/contour drape request
 *  (`?agg=`), in priority order: chance-of (`_gt`/`_lt` threshold ids,
 *  including aliases whose stripped base is a precip total, e.g.
 *  `tot_prec_gt2p5mm`, `prob_prec_gt1mm`) always forces `"max"` — the
 *  documented PEAK semantics, matching the point/hover path's
 *  implicit-peak `__{N}h` form (windowedVarId/buildWindowVar with op
 *  `""`). `isPrecipTotalLayer` also matches on `strippedBase`, so it
 *  would otherwise swallow chance-of ids too and sum a 0..1 probability
 *  field into out-of-range garbage — chance-of MUST be checked first.
 *  Non-chance precip-total layers sum their de-accumulated hourly rates
 *  into the window's total. Everything else uses the layer's explicit
 *  aggOp, else the variable's catalog-advertised default, else "mean". */
export function windowAggFor(
  layer: MapLayer,
  varInfo: Map<string, AvailableVariable>,
): string {
  if (parseThresholdId(layer.variable)) return "max";
  if (isPrecipTotalLayer(layer)) return "sum";
  return layer.aggOp ?? aggCapsFor(varInfo, layer.variable)?.default ?? "mean";
}

/** Swap a precip layer id's accumulation window to N hours, preserving any
 *  ensemble-product suffix: `precip_1h` → `precip_6h`, `precip_1h_mean` →
 *  `precip_6h_mean`, `precip_1h_p90` → `precip_6h_p90`, `tot_prec` →
 *  `precip_6h`. The backend serves `precip_{N}h_{product}` directly (the
 *  rewrite → `tot_prec_{product}__{N}h` → member kernel). */
export function precipWindowVar(varId: string, n: number): string {
  return varId.replace(/^(?:precip_\d+h|tot_prec)/, `precip_${n}h`);
}

/** Effective request var id for a windowed value layer in the
 *  `{base}__{N}h_{op}` grammar. N = the active window's spanHours; op =
 *  the layer's aggOp or the variable's advertised default. Hourly mode
 *  returns the bare id (no window mod). Chance-of (`_gt`/`_lt`) ids take
 *  the implicit-peak form `{base}__{N}h`; precip Total returns the bare
 *  id here — windowed callers swap to `precip_{N}h` (see pointVarForLayer
 *  and WeatherMap's windowRequestFor). Returns the bare id when the
 *  variable advertises no aggregations (catalog still loading, or a
 *  diagnostic field). */
export function windowedVarId(
  layer: MapLayer,
  windowMode: WindowMode,
  spanHours: number,
  varInfo: Map<string, AvailableVariable>,
): string {
  const base = layer.variable;
  if (windowMode === "hourly") return base;
  // Chance-of (_gt/_lt) auto-peaks server-side — implicit-peak form.
  if (parseThresholdId(base)) return buildWindowVar(base, spanHours, "");
  // Precip Total is a precip_{N}h selection, not an op.
  if (isPrecipTotalLayer(layer)) return base;
  const caps = aggCapsFor(varInfo, base);
  if (!caps) return base;
  return buildWindowVar(base, spanHours, layer.aggOp ?? caps.default);
}

/** Windowed variable id for a point/hover query of one layer — mirrors
 *  the displayed tile's request exactly so the readout matches the map
 *  (same ensemble product AND `__{N}h_{op}` window). Identical to
 *  windowedVarId except precip Total resolves to the `precip_{N}h`
 *  accumulation, which the point handler reads at the trailing instant. */
export function pointVarForLayer(
  layer: MapLayer,
  windowMode: WindowMode,
  spanHours: number,
  varInfo: Map<string, AvailableVariable>,
): string {
  if (windowMode !== "hourly" && isPrecipTotalLayer(layer)) {
    return precipWindowVar(layer.variable, spanHours);
  }
  return windowedVarId(layer, windowMode, spanHours, varInfo);
}

/** Visible layers' windowed point-query var ids (deduped) for the hover
 *  readout, so it reflects the active ensemble product AND window mode.
 *  In hourly mode this equals visibleVariables. */
export function visibleWindowedVariables(
  layers: MapLayer[],
  windowMode: WindowMode,
  spanHours: number,
  varInfo: Map<string, AvailableVariable>,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const l of layers) {
    if (!l.visible) continue;
    const v = pointVarForLayer(l, windowMode, spanHours, varInfo);
    if (seen.has(v)) continue;
    seen.add(v);
    result.push(v);
  }
  return result;
}

/** Canonicalise an isobaric variable id by collapsing its level token,
 *  so layers that differ only by pressure level compare equal. A no-op
 *  for non-isobaric ids. Used by matchesPreset so the upper-air height
 *  selector can rewrite levels without flipping the active preset to
 *  "custom" (which would deselect the topic and hide the selector). */
function canonicalIsobarVar(v: string): string {
  return v.replace(/_(\d+)hpa/, "_LVLhpa");
}

/** Check if a preset matches the current layer config (by comparing
 *  variable + mode + visibility + opacity for each layer position).
 *  Isobaric level differences are ignored (canonicalIsobarVar) so a
 *  preset viewed at any of 850/500/300 hPa still matches its template. */
export function matchesPreset(layers: MapLayer[], preset: MapConfig): boolean {
  if (layers.length !== preset.layers.length) return false;
  for (let i = 0; i < layers.length; i++) {
    const a = layers[i];
    const b = preset.layers[i];
    if (
      canonicalIsobarVar(a.variable) !== canonicalIsobarVar(b.variable) ||
      a.displayMode !== b.displayMode ||
      a.visible !== b.visible ||
      Math.round(a.opacity * 10) !== Math.round(b.opacity * 10)
    ) {
      return false;
    }
  }
  return true;
}

/** Detect which preset (if any) matches the current layers.
 *  Returns "custom" when layers don't match any named preset.
 *  User presets (when supplied) take precedence over built-ins so a
 *  saved tweak of e.g. "wind" wins over the built-in "wind". */
export function detectPreset(
  layers: MapLayer[],
  userPresets: MapConfig[] = [],
): string | null {
  for (const p of userPresets) {
    if (matchesPreset(layers, p)) return p.id;
  }
  for (const p of PRESETS) {
    if (p.id === "custom") continue; // skip — custom is the fallback
    if (matchesPreset(layers, presetOverrides.get(p.id) ?? p)) return p.id;
  }
  return "custom";
}
