# 01 — Data sources, run discovery, GRIB buffer

## Config file

YAML, passed via `--config`. One file drives both `serve` and `fetch`.

```yaml
listen: :8080
data_dir: ./data          # GRIB buffer root
geocoder_url: https://nominatim.openstreetmap.org   # Nominatim /search + /reverse
cache:
  fields_mb: 4096         # decoded-field LRU budget (spec 02)

sources:
  - id: iconch1
    type: meteoswiss-stac
    collection: ch.meteoschweiz.ogd-forecasting-icon-ch1
    fetch: loop           # loop | once | off  (off = serve what's buffered)
    interval: 15m
    keep_runs: 3          # retention; 0 = keep everything
    variables: []         # optional allowlist of upstream variable names

  - id: icond2
    type: dwd-opendata
    model: icon-d2-eps    # path under https://opendata.dwd.de/weather/nwp/
    fetch: loop
    interval: 15m
    keep_runs: 2

  - id: team-run
    type: folder
    path: /scratch/exp42/output   # watch a run output directory
    fetch: loop           # rescan on interval; once = single scan
    interval: 1m

  - id: archive
    type: http-index      # generic autoindex web host; also: type s3
    url: https://example.org/gribs/
    fetch: once
```

Defaults: `fetch: loop`, `interval: 15m`, `keep_runs: 2`. Unknown keys
are errors (catch typos). `id` is the model id in the API and UI.

## Source adapter interface

```go
type Source interface {
    ID() string
    // Discover enumerates runs currently available upstream,
    // newest first, with per-run available (variable, step, member-file) sets.
    Discover(ctx) ([]RunListing, error)
    // Fetch downloads one file into the buffer (streamed, bz2-inflated).
    Fetch(ctx, ref FileRef, dst io.Writer) error
}
```

A `RunListing` carries: run reference time (may be synthetic, see
below), the file refs grouped by (variable, forecast step), and a
`complete` estimate. **Discovery is two-tier** (learned the hard way):

- *published* = a headline field (`t_2m` or the first configured
  variable) exists for the run → the run appears in the API;
- *complete* = no trailing forecast steps are missing vs the model's
  expected horizon → flagged in the run listing so the UI can show
  "still uploading".

## Adapters

### `dwd-opendata`

- Apache mod_autoindex listings at
  `https://opendata.dwd.de/weather/nwp/{model}/grib/{HH}/{variable}/`.
- Parse `href="..."` attributes; match filenames of the shapes
  `<prefix>_<grid>_<leveltype>_<YYYYMMDDHH>_<FFF>[_<lvl>]_<var>.grib2[.bz2]`
  (single-level, pressure-level, time-invariant variants). The prefix
  and grid tokens come from the listing itself, not hard-coded per
  model — new DWD models work by configuring `model:` only.
- Run cadence inferred from which `{HH}` directories exist; latest run
  = walk back from now in cadence steps until the headline variable's
  directory lists that run id (bounded probes, default 6).
- Icosahedral grids need `clat`/`clon` time-invariant files — fetch
  into the buffer's `static/` dir on first use.
- In-memory listing cache per directory path for the life of one
  discovery pass.
- Retry: 4 attempts, exponential backoff from 1 s, ±50 % jitter; 4xx
  terminal (except 408/429), 5xx/network retried.

### `meteoswiss-stac`

- STAC API at `https://data.geo.admin.ch/api/stac/v1`.
- `POST /search` with `collections`, `forecast:reference_datetime`,
  `forecast:variable` (upper-case at the boundary),
  `forecast:perturbed` (false = control asset, true = one GRIB packing
  all perturbed members), `forecast:horizon` (`P0DT{HH}H00M00S`).
- One search per forecast hour (the API takes no horizon range);
  missing hours are non-fatal.
- Latest run: hourly probe backwards (cadence 1 h publication grid) up
  to 6 steps, "published" = a `t_2m` control search returns a feature.
  On POST 4xx fall back once to
  `GET /collections/{id}/items?limit=1&sortby=-datetime`.
- Static assets from `GET /collections/{id}/assets`:
  `horizontal_constants_*.grib2` (icosahedral `tlat`/`tlon`) and
  `vertical_constants_*.grib2` (HSURF) → buffer `static/`.
- Asset pick: first asset whose href ends `.grib2` or MIME contains
  `grib`.

### `folder`

The adapter for "point it at a run output directory". **No filename
convention is assumed.** A scan walks `*.grib2 | *.grb2 | *.grib |
*.bz2`, reads only the GRIB **section headers** of each message
(cheap; no data decode) and indexes by:

- reference time (section 1),
- forecast step / valid time (section 4),
- parameter (discipline/category/number + centre),
- level type/value, perturbation number, grid template.

Messages group into runs by reference time. This is what makes debug
output visualizable regardless of naming or non-standard time usage.
Multi-message files (many steps/members per file) are fine — the index
records (file, offset) per message. Rescan on `interval`; a file is
re-indexed only when size/mtime changed.

### `http-index` / `s3`

Generic remote folder: enumerate files (autoindex HTML href scrape /
S3 ListObjectsV2, anonymous or ambient credentials), download to the
buffer, then index **exactly like `folder`** (header-based). This keeps
the generic adapters convention-free too; dwd/meteoswiss adapters exist
only because their listings allow discovering runs *without*
downloading.

## GRIB buffer

```
{data_dir}/
  {source_id}/
    static/                    # clat/clon, horizontal/vertical constants
    runs/{YYYYMMDDTHHMMZ}/     # decompressed .grib2 files + index.json
      index.json               # message index: file, offset, param, step, member, level
    latest                     # {"run": "..."} pointer, atomic rename
```

- Everything stored **decompressed** (bz2 inflation was ~43 % of old
  ingest CPU; pay it once at download, never at request time).
- Downloads stream to `.part-*` temp files, atomic rename. Cache hit =
  file exists non-empty.
- `index.json` is written after a run's scan/fetch pass (atomic); the
  serve path reads only the index + targeted file offsets.
- Retention: per source `keep_runs` newest runs are kept; pruning never
  touches the run currently being fetched, and the previous run is
  retained until the new one is *published* (fallback during upload).
- Disk-full aborts the whole fetch cycle (remaining sources would hit
  the same wall and strew temps).

## Fetch orchestration

- `fetch: loop` sources run on independent tickers (`interval`) inside
  `grib-viewer serve` (or `grib-viewer fetch`); `once` sources run a single pass
  at startup; `off` sources are only read.
- Per-source pass: Discover → diff against buffer → download missing
  files with a bounded worker pool (8 connections per host — the Go
  default of 2 throttles badly) → update `index.json` → flip `latest`
  → prune old runs.
- Failures are isolated per source and surfaced via `/api/status`
  (per-source: current run, files done/total, last error, last
  success) and Prometheus metrics.
- New data is visible without restart: the serve layer watches `latest`
  pointers / index mtimes.

## Time-format mixing (live vs debug output)

Every run gets an **absolute internal time axis**:

- Live sources: reference time from upstream = wall-clock UTC; valid
  time = ref + step. Normal case.
- Debug output: some experimental runs carry placeholder reference
  times (epoch, year 1, repeated constants). The folder adapter marks a
  run `synthetic_time: true` when its reference time is implausible
  (< 1990 or duplicated across obviously different runs); the axis is
  still ref + step, but the API exposes the flag and the frontend
  displays **lead time (+0 h, +6 h …)** instead of wall-clock, hides
  "now"-anchored features (start anchor, `now` token, day/night
  shading), and never mixes such a run into composites.
- The UI time-format toggle is three-way: Local | UTC | Lead (+H).
  Lead is forced for synthetic runs, available for all.

## Run/timerange exploration

`Discover` results are retained (`keep_runs`) rather than
latest-only, and the API lists **all buffered runs** per model with
their valid windows and per-variable step coverage (spec 03,
`/api/models/{model}/runs`). The frontend's run browser renders this
as a picker with coverage bars (spec 04).
