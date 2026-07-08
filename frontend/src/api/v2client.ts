/**
 * v2client — REST client + URL builders for the bbox-window backend
 * (`/api/...`, spec docs/specs/2026-07-06-03-http-api.md). Same-origin
 * relative paths through the dev/prod proxy (vite `/api`, nginx `/api/`).
 *
 * Every data-bearing endpoint takes an optional `?run=` (the run id from
 * /runs, or RFC3339); omitted = latest. The frontend sends it whenever the
 * user pinned a run in the run browser.
 *
 * There is NO tile endpoint: the map fetches ONE protobuf Window per
 * (layer, viewport, frame) via /data with a bbox + maxcells budget.
 */

export interface V2VarProducts {
  median: boolean;
  mean: boolean;
  control: boolean;
  min: boolean;
  max: boolean;
  spread: boolean;
  percentiles?: number[];
  /** Individually addressable ensemble members (`_m{N}`); 0/absent = none. */
  members?: number;
}

export interface V2VarCat {
  name: string;
  units: string;
  long_name?: string;
  colormap?: string;
  vmin: number;
  vmax: number;
  eps: boolean;
  /** Ensemble products the run backs (mean/control/min/max/spread +
   *  selectable percentiles + member count). */
  products?: V2VarProducts;
  /** Windowed-aggregation capability: default op + the valid op set. */
  aggregations?: { default: string; valid: string[] };
  /** Temporal nature hint ("instant", "accum", …). */
  temporal?: string;
  native_deg?: number;
}

export interface V2ModelCat {
  id: string;
  latest_run: string;
  /** True when the run axis is synthetic (frame times not wall-clock
   *  meaningful — lead-hour display is forced). */
  synthetic_time?: boolean;
  /** Attribution metadata from the source's `info:` config block
   *  (composites synthesize theirs, with contributor source ids). */
  name?: string;
  description?: string;
  provider?: string;
  provider_url?: string;
  license?: string;
  license_url?: string;
  contributors?: string[];
  variables: V2VarCat[];
}

export interface V2VarMeta extends V2VarCat {
  model?: string;
  timesteps?: string[];
  run?: string;
  synthetic_time?: boolean;
  scale?: number;
  offset?: number;
}

/** One rung of a composite's resolution ladder (GET /api/composite/{id}). */
export interface V2Contributor {
  model: string;
  native_deg: number;
  bbox: { south: number; west: number; north: number; east: number };
  is_base: boolean;
  run: string;
  /** RFC3339 end of this contributor's horizon, when published. */
  horizon_to?: string;
}

/** The composite ladder descriptor: contributors finest→coarsest the frontend
 *  stacks + blends, plus the synthetic composite run id. */
export interface V2Composite {
  id: string;
  run: string;
  contributors: V2Contributor[];
}

export function fetchV2Composite(
  model: string,
  signal?: AbortSignal,
): Promise<V2Composite> {
  return getJSON<V2Composite>(`/api/composite/${model}`, signal);
}

import type { PointTimeSeriesResponse } from "./types.ts";

export interface V2Point {
  model?: string;
  variable?: string;
  lat?: number;
  lon?: number;
  value: number | null;
  height?: number | null;
  /** Site ground elevation (m), when the backend publishes it. */
  elevation?: number | null;
}

async function getJSON<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, signal ? { signal } : undefined);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return res.json() as Promise<T>;
}

/** Append `run=` to a URLSearchParams when a run is pinned. */
function setRun(qs: URLSearchParams, run?: string): void {
  if (run) qs.set("run", run);
}

/** Server-defined layer presets from the backend config (grib-viewer.yaml
 *  `presets:` block). Shape defined in mapConfig.ts (ServerPreset). */
export function fetchServerPresets<T>(signal?: AbortSignal): Promise<T[]> {
  return getJSON<{ presets?: T[] }>(`/api/presets`, signal).then(
    (d) => d.presets ?? [],
  );
}

export function fetchV2Models(signal?: AbortSignal): Promise<V2ModelCat[]> {
  return getJSON<{ models?: V2ModelCat[] }>(`/api/models`, signal).then(
    (d) => d.models ?? [],
  );
}

// ---------------------------------------------------------------------------
// Runs (the run browser / timerange explorer)
// ---------------------------------------------------------------------------

export interface V2RunInfo {
  run: string;
  valid_from?: string;
  valid_to?: string;
  complete?: boolean;
  synthetic_time?: boolean;
  /** Per-variable step coverage (variable id → steps present). */
  steps?: Record<string, number>;
  horizon_hours?: number;
  cadence_hours?: number;
}

/** GET /api/models/{model}/runs — all buffered runs, newest first. */
export function fetchV2Runs(
  model: string,
  signal?: AbortSignal,
): Promise<V2RunInfo[]> {
  return getJSON<{ runs?: V2RunInfo[] }>(
    `/api/models/${model}/runs`,
    signal,
  ).then((d) => d.runs ?? []);
}

/** GET /api/models/{model}/runs/{run|latest} — one run's descriptor. */
export function fetchV2Run(
  model: string,
  run: string = "latest",
  signal?: AbortSignal,
): Promise<V2RunInfo> {
  return getJSON<V2RunInfo>(
    `/api/models/${model}/runs/${encodeURIComponent(run)}`,
    signal,
  );
}

export function fetchV2Meta(
  model: string,
  variable: string,
  signal?: AbortSignal,
  run?: string,
): Promise<V2VarMeta> {
  const qs = new URLSearchParams();
  setRun(qs, run);
  const q = qs.size > 0 ? `?${qs}` : "";
  return getJSON<V2VarMeta>(
    `/api/models/${model}/meta/${encodeURIComponent(variable)}${q}`,
    signal,
  );
}

/** Hours between adjacent frames (the axis cadence); 1 when unknown. */
function cadenceHours(ts?: string[]): number {
  if (!ts || ts.length < 2) return 1;
  const h = Math.round((Date.parse(ts[1]) - Date.parse(ts[0])) / 3.6e6);
  return h > 0 ? h : 1;
}

/** A frame index into a timesteps axis, plus an optional calendar-bucket window.
 *  Shared by every endpoint so they all build the same {time}/{var} grammar. */
export interface V2Time {
  /** The layer/model timesteps axis (ISO). The {time} segment is timesteps[time]. */
  timesteps?: string[];
  /** Frame index into `timesteps`. */
  time: number;
  /** Window-mode reduction over the inclusive frame bucket [t0,t1] with op. */
  window?: { t0: number; t1: number; op: string };
}

/** Resolve the {time} path segment + the variable's __{N}h_{op} window suffix.
 *  No window → the frame's RFC3339 instant (or "latest" if the axis is
 *  unknown). Window → the one-window span {start}+PT{N}H + the __{N}h_{op}
 *  suffix, where N spans the inclusive bucket so the backend's half-open block
 *  [start,start+N) reduces exactly the bucket's frames. */
export function v2TimeGrammar(t: V2Time): { timePath: string; suffix: string } {
  const at = (i: number) => t.timesteps?.[i];
  if (t.window) {
    const start = at(t.window.t0);
    const end = at(t.window.t1);
    if (start && end) {
      const hours = Math.max(
        1,
        Math.round((Date.parse(end) - Date.parse(start)) / 3.6e6) +
          cadenceHours(t.timesteps),
      );
      return {
        timePath: `${start}+PT${hours}H`,
        suffix: `__${hours}h_${t.window.op}`,
      };
    }
  }
  return { timePath: at(t.time) ?? "latest", suffix: "" };
}

/** Lead-time {time} segment (`+{N}h`) — resolves against the run's reference
 *  time server-side; the natural form for synthetic-time runs. */
export function leadTimeSegment(hours: number): string {
  return `+${Math.round(hours)}h`;
}

/** Build the "{time}/{var+suffix}" path tail every time-bearing route shares.
 *  Both segments are URI-encoded (the span's ':' and '+' must survive the
 *  server's path unescaping + time-spec parse). */
function timeVarPath(variable: string, t: V2Time): string {
  const { timePath, suffix } = v2TimeGrammar(t);
  return `${encodeURIComponent(timePath)}/${encodeURIComponent(variable + suffix)}`;
}

export interface PointOpts extends Partial<V2Time> {
  /** Pinned run id — emitted as ?run= when set. */
  run?: string;
}

export function fetchV2Point(
  model: string,
  variable: string,
  lat: number,
  lon: number,
  opts: PointOpts = {},
  signal?: AbortSignal,
): Promise<V2Point> {
  const qs = new URLSearchParams({ lat: String(lat), lon: String(lon) });
  setRun(qs, opts.run);
  const path = timeVarPath(variable, {
    timesteps: opts.timesteps,
    time: opts.time ?? 0,
    window: opts.window,
  });
  return getJSON<V2Point>(`/api/models/${model}/point/${path}?${qs}`, signal);
}

/** Align a backend point-series response (whose `timesteps` may skip native
 *  frames the backend had no data for) onto the full requested axis, matching
 *  by RFC3339 instant equality. Missing ticks become null. Exported for unit
 *  testing without mocking fetch. */
export function alignSeriesToAxis(
  requested: string[],
  respTimesteps: string[],
  respValues: (number | null)[],
): (number | null)[] {
  const byInstant = new Map<number, number | null>();
  respTimesteps.forEach((t, i) => byInstant.set(Date.parse(t), respValues[i] ?? null));
  return requested.map((t) => byInstant.get(Date.parse(t)) ?? null);
}

interface RawPointSeries {
  timesteps?: string[];
  values?: (number | null)[];
}

/** Fetch one variable's series over `timesteps` with a single span request:
 *  {timesteps[0]}+PT{H}H, H = (last-first) + one native step, so the backend's
 *  half-open [start,start+H) window covers exactly the requested axis. Falls
 *  back to a single instant /point when the axis has fewer than 2 ticks.
 *  Errors become an all-null column. */
async function fetchVarSeries(
  model: string,
  variable: string,
  lat: number,
  lon: number,
  timesteps: string[],
  run: string | undefined,
  signal?: AbortSignal,
): Promise<(number | null)[]> {
  if (timesteps.length < 2) {
    return Promise.all(
      timesteps.map((_, i) =>
        fetchV2Point(model, variable, lat, lon, { time: i, timesteps, run }, signal)
          .then((r) => r.value)
          .catch(() => null),
      ),
    );
  }
  const start = timesteps[0];
  const step = cadenceHours(timesteps);
  const hours = Math.max(
    1,
    Math.round((Date.parse(timesteps[timesteps.length - 1]) - Date.parse(start)) / 3.6e6) + step,
  );
  const timePath = encodeURIComponent(`${start}+PT${hours}H`);
  const qs = new URLSearchParams({ lat: String(lat), lon: String(lon) });
  setRun(qs, run);
  const url = `/api/models/${model}/point/${timePath}/${encodeURIComponent(variable)}?${qs}`;
  try {
    const res = await getJSON<RawPointSeries>(url, signal);
    return alignSeriesToAxis(timesteps, res.timesteps ?? [], res.values ?? []);
  } catch {
    return timesteps.map(() => null);
  }
}

/** Build a per-tick point series (the PointTimeSeriesResponse shape) from the
 *  single-request span series endpoint — one /point request PER VARIABLE (not
 *  per variable×frame). Full ensemble / derived / exceedance / window ids
 *  resolve server-side (t_2m_p90, precip_1h, prob_prec_gt1mm, t_2m__6h_max,
 *  …). A variable whose request errors becomes an all-null column so a
 *  partial axis still charts. `run` (when non-empty) is the pinned run id and
 *  rides every request as ?run=. */
export async function fetchV2PointSeries(
  model: string,
  vars: string[],
  lat: number,
  lon: number,
  timesteps: string[],
  run: string,
  signal?: AbortSignal,
  _isLapseOff?: (variable: string) => boolean,
): Promise<PointTimeSeriesResponse> {
  const entries = await Promise.all(
    vars.map(
      async (v) =>
        [
          v,
          await fetchVarSeries(model, v, lat, lon, timesteps, run || undefined, signal),
        ] as const,
    ),
  );
  return { model, run, lat, lon, timesteps, values: Object.fromEntries(entries) };
}

/** Normalize an exceedance-probability series to PERCENT: /point serves
 *  fractions (0..1); a series whose max is ≤ 1 is scaled ×100. Scan-based so
 *  genuinely-percent series (max > 1) pass through untouched. */
export function normalizeProbSeries(vals: (number | null)[]): (number | null)[] {
  let mx = 0;
  for (const v of vals) if (v != null && v > mx) mx = v;
  if (mx > 1.001) return vals;
  return vals.map((v) => (v == null ? null : v * 100));
}

/** Inclusive native frame range [t0,t1] of the timesteps whose valid instant
 *  falls in the calendar bucket [startMs, endMs). This is the daily/3h/6h/12h
 *  window-mode mapping: the frontend buckets the forecast hours into tz-aware
 *  calendar windows (bucketTimesteps) and reduces each window's own frames — a
 *  per-day reduction, not a rolling N-hour trailing window. Returns null when
 *  the layer's axis has no frame in the bucket. */
export function framesInSpan(
  timesteps: string[] | undefined,
  startMs: number,
  endMs: number,
): { t0: number; t1: number } | null {
  if (!timesteps || timesteps.length === 0) return null;
  let t0 = -1;
  let t1 = -1;
  for (let i = 0; i < timesteps.length; i++) {
    const ms = Date.parse(timesteps[i]);
    if (ms >= startMs && ms < endMs) {
      if (t0 < 0) t0 = i;
      t1 = i;
    }
  }
  return t0 >= 0 ? { t0, t1 } : null;
}

// ---------------------------------------------------------------------------
// Window data (/data) — ONE bbox request per (layer, viewport, frame)
// ---------------------------------------------------------------------------

export interface DataParams extends V2Time {
  /** "S,W,N,E" viewport window (padded + quantized by the caller). */
  bbox: string;
  /** Client cell budget; the server picks the pyramid level. */
  maxcells?: number;
  /** Pinned run id (?run=); absent = latest. */
  run?: string;
}

/** Single-frame (or windowed-reduction) /data URL. */
export function v2DataUrl(
  model: string,
  variable: string,
  p: DataParams,
): string {
  const qs = new URLSearchParams({ bbox: p.bbox });
  if (p.maxcells) qs.set("maxcells", String(Math.round(p.maxcells)));
  setRun(qs, p.run);
  return `/api/models/${model}/data/${timeVarPath(variable, p)}?${qs}`;
}

export interface DataChunkParams {
  bbox: string;
  maxcells?: number;
  run?: string;
  startISO: string;
  seconds: number;
}

/** Animation-chunk /data URL: a plain span {start}+PT{seconds}S with no window
 *  op stacks every covered native frame into ONE multi-frame Window (cap 48)
 *  — playback buffers hours per request instead of dribbling per-frame. */
export function v2DataChunkUrl(
  model: string,
  variable: string,
  p: DataChunkParams,
): string {
  const timePath = encodeURIComponent(`${p.startISO}+PT${p.seconds}S`);
  const qs = new URLSearchParams({ bbox: p.bbox });
  if (p.maxcells) qs.set("maxcells", String(Math.round(p.maxcells)));
  setRun(qs, p.run);
  return `/api/models/${model}/data/${timePath}/${encodeURIComponent(variable)}?${qs}`;
}

export interface GridParams extends V2Time {
  bbox: string;
  spacing: number;
  run?: string;
}

export function v2GridUrl(
  model: string,
  variable: string,
  p: GridParams,
): string {
  const qs = new URLSearchParams({ bbox: p.bbox, spacing: String(p.spacing) });
  setRun(qs, p.run);
  return `/api/models/${model}/grid/${timeVarPath(variable, p)}?${qs}`;
}

/** Latest-run details as the model-info page consumes them. */
export interface LatestRunInfo {
  model: string;
  run: string;
  /** RFC3339 nominal run start. */
  start?: string;
  /** RFC3339 first / last forecast timestep. */
  forecast_start?: string;
  forecast_end?: string;
  /** Number of archives in the run directory. */
  variables?: number;
  /** Total bytes summed across every archive. */
  size_bytes?: number;
  /** Forecast timestep count. */
  timesteps?: number;
  /** Upstream publishing cadence in hours. */
  cadence_hours?: number;
  /** Longest forecast hour the model publishes. */
  horizon_hours?: number;
  /** RFC3339 start time of the next run after the latest one. */
  next_run?: string;
  /** RFC3339 wall-clock time at which next_run is expected upstream. */
  next_available_at?: string;
  /** Human-readable attribution string from the backend. */
  attribution?: string;
}

/** Fetch + adapt the latest-run descriptor into the LatestRunInfo shape the
 *  model-info page renders. valid_from/valid_to map onto forecast_start/_end. */
export async function fetchV2LatestRun(
  model: string,
  signal?: AbortSignal,
): Promise<LatestRunInfo> {
  const d = await fetchV2Run(model, "latest", signal);
  return {
    model,
    run: d.run,
    forecast_start: d.valid_from,
    forecast_end: d.valid_to,
    horizon_hours: d.horizon_hours,
    cadence_hours: d.cadence_hours,
  };
}
