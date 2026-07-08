#!/usr/bin/env bash
# End-to-end smoke: fetch a tiny real ICON-D2 subset, serve, verify
# every endpoint answers with sane payloads, tear down.
set -euo pipefail
cd "$(dirname "$0")/.."

BIN=${BIN:-bin/grib-viewer}
DIR=$(mktemp -d /tmp/grib-viewer-smoke.XXXXXX)
trap 'kill $SRV_PID 2>/dev/null || true; rm -rf "$DIR"' EXIT

cat > "$DIR/config.yaml" <<EOF
listen: 127.0.0.1:18080
data_dir: $DIR/data
sources:
  - id: icond2
    type: dwd-opendata
    model: icon-d2
    fetch: once
    keep_runs: 1
    variables: [t_2m, tot_prec, u_10m, v_10m, hsurf]
    max_step: 3
EOF

echo "== fetch (bounded: 5 vars x 4 steps)"
$BIN fetch --config "$DIR/config.yaml" --once

echo "== serve"
$BIN serve --config "$DIR/config.yaml" &
SRV_PID=$!
for i in $(seq 1 50); do
  curl -sf http://127.0.0.1:18080/api/healthz >/dev/null 2>&1 && break
  sleep 0.2
done

api() { curl -sfg "http://127.0.0.1:18080$1"; }  # -g: [unit] brackets are not globs

echo "== endpoints"
api /api/healthz | grep -q ok
api /api/models | grep -q '"icond2"'
api /api/models/icond2/runs | grep -q '"valid_from"'
RUN=$(api /api/models/icond2/runs/latest | python3 -c 'import sys,json;print(json.load(sys.stdin)["run"])')
echo "   run: $RUN"
api "/api/models/icond2/meta/t_2m" | grep -q '"timesteps"'
api "/api/models/icond2/point/latest/t_2m?lat=50.0&lon=10.0" | python3 -c '
import sys,json
d=json.load(sys.stdin)
v=d["value"]
assert v is not None and 200<v<330, f"t_2m implausible: {v}"
print(f"   point t_2m = {v:.2f} K")'
api "/api/models/icond2/data/latest/t_2m?bbox=47,6,55,15" > "$DIR/win.pb"
test "$(stat -f%z "$DIR/win.pb" 2>/dev/null || stat -c%s "$DIR/win.pb")" -gt 10000
echo "   window: $(stat -f%z "$DIR/win.pb" 2>/dev/null || stat -c%s "$DIR/win.pb") bytes"
api "/api/models/icond2/window/latest/t_2m[c]?bbox=49,9,50,10" | python3 -c '
import sys,json
d=json.load(sys.stdin)
vals=[v for v in d["values"] if v is not None]
assert vals and all(-60<v<50 for v in vals), "celsius window implausible"
print(f"   window/json: {len(vals)} cells, {min(vals):.1f}..{max(vals):.1f} C")'
api "/api/models/icond2/grid/latest/u_10m?bbox=47,6,55,15&spacing=1" | grep -q FeatureCollection
api "/api/models/icond2/data/latest/wind_speed_10m?bbox=47,6,55,15" > /dev/null
api "/api/models/icond2/data/+2h/precip_1h?bbox=47,6,55,15" > /dev/null
api /api/composite/auto | grep -q contributors
api /api/colormaps | grep -q '"prob"'
api /api/openapi.json | grep -q '"openapi"'

echo "== smoke OK"
