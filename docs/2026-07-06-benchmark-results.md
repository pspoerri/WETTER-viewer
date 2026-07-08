# End-to-end benchmark — 2026-07-06

Method: `grib-viewer bench` fetches a bounded **real** run from DWD
opendata into the buffer, serves the API in-process (httptest, full
HTTP path incl. gzip + protobuf encode), and times requests. Hardware:
Apple Silicon laptop. Reproduce with `make bench` / `make bench-eps`.

Everything below is **derived online from raw GRIB at request time** —
no pre-built archives exist (spec 00).

## ICON-D2 (deterministic, 10 steps buffered, regular 2.2 km grid)

| benchmark | median | best | bytes |
|---|---|---|---|
| catalog /models | 500µs | 400µs | 16.7kB |
| runs list | 200µs | 100µs | 552B |
| window cold (t_2m, full domain, 700k-cell budget) | 54.2ms | 54.2ms | 2.7MB |
| window warm | 34.5ms | 34.1ms | 2.7MB |
| chunk (multi-frame animation) | 258.6ms | — | 13.3MB |
| point series (full horizon) | 6.6ms | 200µs | 569B |
| window agg `__6h_max` | 42.5ms | 42ms | 2.7MB |
| derived `precip_1h` | 34.5ms | 19.8ms | 1.3MB |
| derived `wind_speed_10m` | 34.7ms | 17.2ms | 1.3MB |

## ICON-D2-EPS (20 members, 7 steps buffered, icosahedral 542k-cell mesh)

| benchmark | median | best | bytes |
|---|---|---|---|
| window cold (t_2m p50, full domain; 20 member decodes + region index build) | 247.4ms | — | 1.3MB |
| window warm | 17.5ms | 17.4ms | 1.3MB |
| chunk (7 frames × 20 members cold) | 1.22s | — | 8.0MB |
| point series (full horizon) | 126.1ms | 200µs | 425B |
| window agg `__6h_max` | 20.5ms | 19.5ms | 1.3MB |
| ensemble p90 cold / warm | 138.9ms / 16.6ms | — | 1.3MB |
| exceedance `_gt24c` (arbitrary threshold) | 19.8ms | 8.4ms | 1.3MB |
| spread (p90−p10) | 145ms | 22.8ms | 1.3MB |
| derived `precip_1h` (member-paired de-accumulation) | 267.7ms | 18.6ms | 1.3MB |

Fetch+index of the bounded EPS subset (4 vars × 7 steps × 20 members +
clat/clon statics, bz2 inflated to disk): ~6 s discovery+download on a
fast link; header-only indexing of a run is milliseconds.

## The load-bearing optimization

Per-pixel nearest-neighbour lookup against the icosahedral mesh costs
~240 µs/pixel through the generic spatial-hash path — 2m49s for one
700k-pixel window. The engine instead builds a **region index map by
forward splat** (project every mesh cell into pixel space once, nearest
to pixel center wins, radius-1 pinhole fill): **5.9 ms** for the same
window, cached per (mesh, region) and reused across every member,
step, and product. That is what makes online ensemble derivation
viable (`internal/engine/regionidx.go`).

## Verification

- `make test` (Go, all packages), frontend `pnpm build` + 31 unit-test
  files: green.
- `scripts/smoke.sh`: live DWD fetch → serve → endpoint assertions
  (values in plausible physical ranges): green.
- Full stack in headless Chrome (backend + Vite + real data): app
  boots, vendored basemap renders, composite resolves, GPU drape draws
  the ICON-D2 field with correct domain footprint, TimeBar live. Only
  console noise: missing upstream terrain tiles on tiles.rsp.li
  (external; the terrain feature latches off gracefully).
