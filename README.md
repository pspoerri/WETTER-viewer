# GRIB-viewer

Note: **This project is 100% AI generated.
No guarantees. Best effort has been taken to validate the project.**

Standalone viewer for NWP GRIB output. Point it at DWD opendata, the
MeteoSwiss STAC, an S3 bucket, a web host, or a plain run-output
folder — it buffers the GRIB locally and derives **everything online**
(ensemble percentiles, exceedance probabilities, de-accumulation,
derived diagnostics): no ingest pipeline, no archive format. A
React + MapLibre frontend renders fields on the GPU (drapes, shader
contours, wind streamlines) from bbox-addressed protobuf windows.

Specs live in `docs/specs/`; measured performance in
`docs/2026-07-06-benchmark-results.md`.

## Quick start

Grab a self-contained binary (UI embedded, served at `/`) from the
[GitHub releases](https://github.com/pspoerri/WETTER-viewer/releases),
or build it yourself with `make release` (→ `bin/grib-viewer`, see
[Building from source](#building-from-source)). Then:

```bash
# macOS only: downloaded binaries carry the quarantine flag — remove it first
xattr -d com.apple.quarantine grib-viewer

./grib-viewer serve --fetch --config grib-viewer.yaml
```

That's the whole deployment: UI + API + fetch loops on one port.
Without `--fetch`, serve never downloads — it only reads the existing
buffer (run `grib-viewer fetch` separately, e.g. from a timer/cron).

## Fetching data

Every source in `grib-viewer.yaml` (spec 01) declares how it is fetched. A
folder source indexes any `*.grib2` files by their message headers — no
filename convention needed, synthetic/debug reference times display as
lead hours (+0h, +6h, …).

```yaml
sources:
  - id: icond2
    type: dwd-opendata     # dwd-opendata | meteoswiss-stac | folder | http-index | s3
    model: icon-d2         # path under opendata.dwd.de/weather/nwp/
    fetch: loop            # loop  = refetch every `interval` (with `serve --fetch`)
                           # once  = single pass at startup
                           # off   = never fetch; serve whatever is buffered
    interval: 15m
    keep_runs: 2           # retention; older runs are pruned (0 = keep all)
    variables: [t_2m, ...] # optional allowlist of upstream variable names;
                           # include hsurf — temperature downscaling
                           # (lapse-rate terrain correction) needs it
    max_step: 48           # optional forecast-hour cap
    info:                  # optional attribution block, served by /api/models
      name: ICON-D2        # friendly name shown in the UI's model switcher
      provider: Deutscher Wetterdienst (DWD)
      provider_url: https://www.dwd.de/
      license: DL-DE->BY-2.0
```

Commands:

```bash
# single pass over every source with fetch != off, then exit
./bin/grib-viewer fetch --config grib-viewer.yaml --once      # = make fetch

# single pass for one source (any fetch mode)
./bin/grib-viewer fetch --config grib-viewer.yaml --source iconch1   # = make fetch-one SOURCE=iconch1

# continuous fetch loops without the API server
./bin/grib-viewer fetch --config grib-viewer.yaml
```

Downloads land under `data_dir/{source}/runs/{run}/` (decompressed
GRIB + `index.json`); icosahedral coordinate companions (clat/clon)
under `data_dir/{source}/static/`. Folder sources never copy — they
index files where they live. The newest `keep_runs` runs are kept;
`/api/models/{model}/runs` lists everything buffered.

## Serving

```bash
# UI + API + fetch loops in-process, one port        (= make serve-fetch)
./bin/grib-viewer serve --fetch --config grib-viewer.yaml

# serve only (default): existing buffer, never downloads   (= make serve)
./bin/grib-viewer serve --config grib-viewer.yaml

# fetch progress / buffer state
curl http://127.0.0.1:8080/api/status
```

### Map data sources

The client reads all map data directly (no proxying needed). Both the
basemap archive and the terrain server are configurable in
`grib-viewer.yaml` (served to the UI at `/api/mapconfig`; omit a field to
keep the default):

```yaml
map:
  pmtiles: "https://tiles.rsp.li/osm/{z}/{x}/{y}.pbf"
  terrain: "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp"
```

- **Basemap (OpenStreetMap vector data)** — `map.pmtiles` accepts two
  forms: an XYZ tile URL template (the default above) or a
  [Protomaps](https://protomaps.com)-style **`.pmtiles` archive** the
  browser reads directly via HTTP range requests (CORS required), e.g.
  `https://s.rsp.li/geodata/planet.pmtiles`. Fresh planet archives can
  be downloaded from <https://maps.protomaps.com/builds/>; the
  [self-hosting guide](https://docs.protomaps.com/guide/getting-started)
  covers serving them. The five standard basemap flavors are generated
  at runtime from [`@protomaps/basemaps`](https://www.npmjs.com/package/@protomaps/basemaps)
  and split into below-drape fills and above-drape lines/labels; fonts
  and sprites come from the official Protomaps assets
  (`protomaps.github.io/basemaps-assets`).
- **Terrain / 3D relief** — [Mapterhorn](https://mapterhorn.com) DEM
  tiles, elevation from public-domain sources. `map.terrain` accepts the
  same two forms: a tile URL template (its TileJSON is expected next to
  the tiles at `{base}/tilejson.json`) or a terrarium-encoded
  **`.pmtiles` archive** read via HTTP range requests — Mapterhorn
  publishes downloadable planet archives.
- **Place search** — `nominatim.openstreetmap.org`.

## Deployment

### Prebuilt binaries

Releases (tags `v*`) ship self-contained binaries for macOS and Linux
(amd64 + arm64) at
<https://github.com/pspoerri/WETTER-viewer/releases>, built by
`.github/workflows/release.yml`; CI runs vet, tests, and both builds on
every push. On macOS the downloaded binary carries the quarantine
attribute and must be cleared before it will run:

```bash
xattr -d com.apple.quarantine grib-viewer
```

### Containers

```bash
# UI + API + fetch loops on :8080, GRIB buffer in ./data
# (podman-compose or docker compose)
make compose-up
make compose-down
```

### Hosting the frontend as static pages

The UI is a fully static bundle — fonts and basemap style documents are
vendored, routing is hash-based (`/#m=…`), so any static file host works
with no rewrite rules. The only thing it needs at runtime is the grib-viewer
API under the **same origin** at `/api` (all requests use relative
paths; there is no configurable API base URL).

Two ways to satisfy that:

1. **Embedded (default):** `make release` gzips `frontend/dist` into the
   binary; `./bin/grib-viewer serve` then serves the UI at `/` and the API at
   `/api` from one port. Nothing else to deploy.

2. **Separate static host + reverse proxy:** build the bundle with
   `make frontend` (→ `frontend/dist/`), upload it to any static
   server/CDN, and route `/api/*` on the same host to a running
   `grib-viewer serve`. Example (Caddy):

   ```
   example.org {
       root * /srv/grib-viewer-dist
       file_server
       handle /api/* {
           reverse_proxy 127.0.0.1:8080
       }
   }
   ```

   The equivalent nginx config is a `root` + `location /api/ {
   proxy_pass http://127.0.0.1:8080; }` pair. Serving `dist/` from a
   different origin than the API does NOT work without a proxy — the
   relative `/api` calls would hit the static host.

## Building from source

### Build dependencies

- **Go ≥ 1.26** — <https://go.dev/dl/> or `brew install go` / distro package
- **Node.js ≥ 22 with pnpm** — <https://nodejs.org/>; pnpm ships with
  Node's corepack: `corepack enable`
- **git** — version stamping (`git describe`); builds without it but
  the UI then shows version `dev`
- **GNU make, gzip** — preinstalled on macOS and Linux
- **docker compose or podman-compose** — only for `make compose-up`;
  the container build needs no local Go/Node toolchain

`make release` builds the self-contained binary (pure Go, no CGO; the
frontend is gzipped into it and served at `/`) as `bin/grib-viewer`.

### Development

```bash
# backend only: API on :8080, existing buffer (make serve-fetch to download too)
make serve

# frontend with hot reload on :5173, proxies /api to the backend
make dev

# end-to-end benchmark against real DWD data (EPS: make bench-eps)
make bench

# live end-to-end smoke test
make smoke

# backend tests / full local gate (vet + tests + frontend build)
make test
make ci
```

## Layer presets

`grib-viewer.yaml` ships the UI's layer presets. `layers` uses the share-URL
grammar — arrange the view in the UI and copy the `l=` parameter out of
the address bar:

```yaml
presets:
  - name: Storm watch
    icon: 🌀
    description: Gusts with pressure contours and hourly precipitation.
    layers: "vmax_10m.t.10.ga,!pmsl.c.10,precip_1h.t.10.ga"
    base_map: dark     # optional basemap override
  - id: temperature    # matches a built-in id -> OVERRIDES that built-in
    name: Air (2 m)
    icon: 🌡️
    layers: "t_2m.t.10.ga"
    base_map: grayscale
```

Entries whose `id` matches a built-in preset id (temperature, wind,
precipitation, …) override that built-in in place — same slot in its
topic strip, layers/name/icon from the config. The shipped `grib-viewer.yaml`
carries the complete built-in catalog this way (generated by
`node frontend/scripts/gen-preset-yaml.mjs`), so every preset can be
tuned without touching code. Entries with new (or no) ids appear in the
⭐ topic alongside the user's locally-saved presets; server presets are
not deletable there. Deleting an entry from the config simply falls back
to the built-in.

### Layer naming

`layers` is a comma-separated list of layer segments — the same grammar
the share URL's `l=` parameter uses:

```
[!]{variable}.{mode}.{opacity}[.option…]

wind_speed_10m.f.10.fp8000    flow streamlines, opacity 1.0, 8000 particles
!pmsl.c.10                    pressure contours, loaded but hidden
t_2m.t.10.ga.cmviridis        temperature drape, GPU-animated, viridis
```

- `!` — layer starts hidden (still loaded; toggleable in the panel).
- `{variable}` — a catalog id from `/api/models/{model}` (`t_2m`,
  `vmax_10m`, `pmsl`, derived ids like `wind_speed_10m` / `precip_1h`,
  isobaric levels like `t_850hpa`). Ensemble products append a suffix:
  `_p90` `_mean` `_ctrl` `_spread` `_m7` (member), exceedance
  `_gt{V}{unit}` / `_lt{V}{unit}` (decimal point written `p`:
  `precip_1h_gt0p5mm`).
- `{mode}` — one letter: `t` tiles (color drape) · `c` contour lines ·
  `v` value grid (numbers) · `b` wind barbs · `f` flow streamlines.
- `{opacity}` — 0–10 (×10, so `10` = fully opaque).
- Options (each dot-separated; omit for the default):

  | code | applies to | meaning |
  |------|-----------|---------|
  | `i{n}` | contour | interval in display units (`i1000`) |
  | `c{hex}` | contour | line color as hex without `#` (`cff0000`) |
  | `w{n}` | contour | line width px |
  | `s{n}` | value grid | grid spacing px (default 20) |
  | `k{n}` | value grid / barbs | icon scale ×10 |
  | `gr{n}` | value grid | sample resolution ×10 |
  | `g{id}` | barbs | u/v bundle id |
  | `vp{p}` | value grid | value property |
  | `fp{n}` | flow | particle count (default 2000) |
  | `fs{n}` | flow | speed factor ×10 |
  | `cm{name}` | tiles | colormap override (`cmviridis`) |
  | `ga` | tiles | GPU-animated drape (smooth frame tween) |
  | `st1` / `st0` | tiles | force stepped / smooth color bands |
  | `ao{op}` | any | windowed-aggregation op (`aomax`, `aomean`) |
  | `det` / `eps` | any | pin this layer to deterministic / ensemble |
  | `lp{mode}` | tiles | lapse-rate (terrain) correction mode |
  | `ip{n}` | tiles | drape interpolation (0 nearest, 1 bilinear) |

No need to memorize any of this: build the view in the UI and copy the
`l=` parameter out of the address bar.

## Layout

```
backend/   Go module: sources → GRIB buffer → derive engine → HTTP API
frontend/  React 19 + TypeScript + MapLibre GL (GPU render core)
docs/      specs + benchmark results
```
