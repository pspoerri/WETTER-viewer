import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import maplibregl from "maplibre-gl";
import { Protocol } from "pmtiles";
import "./index.css";
import App from "./App.tsx"; // the full UI, now rendering from the v2 backend
import ErrorBoundary from "./components/ErrorBoundary";
import { loadColormaps } from "./lib/colormap";
import { loadColormaps2 } from "./lib/wxColormap2";
import { setBasemapTiles } from "./lib/basemapStyle";
import { setTerrainTiles } from "./lib/terrainZsite";

// Register the pmtiles protocol once at startup so any `pmtiles://` URL
// — including those referenced by WeatherMap's terrain `mapterhorn://`
// chain — is resolvable before the map mounts. WeatherMap imports this
// same Protocol instance to chain its mapterhorn handler through.
export const pmtilesProtocol = new Protocol();
maplibregl.addProtocol("pmtiles", pmtilesProtocol.tile);

// Map data sources are configurable (grib-viewer.yaml `map:` block, served
// at /api/mapconfig). Applied via top-level await BEFORE the app
// renders so nothing constructs a style or map against the built-in
// defaults first; absent fields / a failed fetch keep the defaults.
try {
  const res = await fetch("/api/mapconfig");
  if (res.ok) {
    const cfg = (await res.json()) as { pmtiles?: string; terrain?: string };
    if (cfg.pmtiles) setBasemapTiles(cfg.pmtiles);
    if (cfg.terrain) await setTerrainTiles(cfg.terrain);
  }
} catch {
  // backend unreachable — built-in map data sources
}

// Colormaps load eagerly at startup. loadColormaps() warms the lib/colormap
// cache (the picker name list + stepping helpers); loadColormaps2 warms the
// cache the GPU drape (wxLayerManager) + client-drawn legend read. Both hit
// GET /api/colormaps.
void loadColormaps();
void loadColormaps2("");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
