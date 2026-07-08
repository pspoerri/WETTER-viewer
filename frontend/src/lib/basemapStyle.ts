/**
 * Back + front basemap style merging, ported from the v1 WeatherMap.
 *
 * The basemap is authored as two style documents: the *back* style (land,
 * landuse, hillshade fills) renders underneath the weather drapes; the
 * *front* style (country borders, rivers/lakes/ocean lines, roads, place
 * labels) renders on top of them. Fetching both and merging in memory into
 * one MapLibre style lets the native pipeline load sources, sprite and
 * glyphs atomically — installing the back style and add-hoc addLayer'ing
 * the front afterwards was racy on first load (weather landed above the
 * front overlay), and silently dropped the front's glyphs/sprite, which
 * broke label font rendering.
 *
 * The merged style records the first front layer's id in
 * metadata[FRONT_ANCHOR_KEY]; weather layers insert with that id as
 * `beforeId` to sandwich between back and front.
 */

export const FRONT_ANCHOR_KEY = "wx:front-anchor";

import { layers as protomapsLayers, namedFlavor } from "@protomaps/basemaps";

/** Official Protomaps asset endpoints. The generated layers reference
 *  Noto Sans font stacks and the v4 sprite sheets, both published at
 *  protomaps.github.io/basemaps-assets — fonts and sprites come from
 *  the official source rather than a third-party mirror. */
const PROTOMAPS_GLYPHS =
  "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf";
const protomapsSprite = (flavor: string) =>
  `https://protomaps.github.io/basemaps-assets/sprites/v4/${flavor}`;

/** Flavors @protomaps/basemaps ships. BASE_MAPS entries carrying one
 *  build their style programmatically (buildProtomapsStyles) instead of
 *  fetching authored documents. */
export type ProtomapsFlavor = "light" | "dark" | "white" | "black" | "grayscale";

export type AnyStyle = {
  version?: number;
  sources?: Record<string, unknown>;
  layers?: Array<{ id: string; filter?: unknown; [k: string]: unknown }>;
  sprite?: unknown;
  glyphs?: string;
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
};

// MapLibre's `<=` / `>` operators require both operands to be the same
// primitive type. When `kind_detail` is absent and `admin_level` is a
// string, `coalesce` returns "2" and the numeric comparison throws a
// runtime type mismatch — the filter evaluates false and the country
// border layer never renders. Wrap any coalesce touching those props in
// `to-number` (a no-op for numbers).
const BOUNDARIES_PROPS = ["kind_detail", "admin_level"];

function expressionReferences(expr: unknown, props: string[]): boolean {
  if (!Array.isArray(expr)) return false;
  if (expr[0] === "get" && typeof expr[1] === "string" && props.includes(expr[1])) {
    return true;
  }
  return expr.some((child) => expressionReferences(child, props));
}

function coerceBoundariesCoalesce(expr: unknown): unknown {
  if (!Array.isArray(expr)) return expr;
  const mapped = expr.map(coerceBoundariesCoalesce);
  if (mapped[0] === "coalesce" && expressionReferences(mapped, BOUNDARIES_PROPS)) {
    return ["to-number", mapped];
  }
  return mapped;
}

/** OSM vector basemap source. The authoritative value comes from the
 *  backend config (grib-viewer.yaml `map.pmtiles`, defaulted server-side and
 *  served at /api/mapconfig; applied by main.tsx before the map
 *  mounts) — the literal below is only the no-backend fallback. Two
 *  forms: an XYZ tile URL template ({z}/{x}/{y}.pbf) or a
 *  Protomaps-style `.pmtiles` archive read directly via HTTP range
 *  requests. patchBasemapStyle installs it on every style's vector
 *  source — the style documents carry no tile endpoint of their own.
 *  Planet
 *  archives: https://maps.protomaps.com/builds/ — self-hosting guide:
 *  https://docs.protomaps.com/guide/getting-started. Fonts and sprites
 *  come from the official Protomaps assets (neither form carries them). */
let basemapTiles = "https://tiles.rsp.li/osm/{z}/{x}/{y}.pbf";

export function setBasemapTiles(url: string): void {
  if (url) basemapTiles = url;
}

// Layers that belong ABOVE the weather drapes, matching the authored
// back/front contract: coastline, rivers/streams, admin boundaries, and
// water/island/place labels. Everything else — including the entire
// road network and its labels — stays BELOW the drapes, where it only
// shows through translucent or absent weather layers.
const isFrontLayerId = (id: string): boolean =>
  id.startsWith("boundaries") ||
  id.startsWith("places_") ||
  id.startsWith("water_label_") ||
  id.startsWith("earth_label_") ||
  id === "water_stream" ||
  id === "water_river";

// Water polygons render below the drapes; this outline keeps the
// coastline legible when an opaque drape covers the water fill. Same
// constant layer the authored documents carry.
const SYNTHESIZED_COASTLINE = {
  id: "__synthesized_coastline",
  type: "line",
  source: "osm-vector",
  "source-layer": "water",
  filter: ["==", "$type", "Polygon"],
  paint: { "line-color": "#555", "line-width": 0.5 },
};

/** Build the back/front style pair for a named flavor directly from
 *  @protomaps/basemaps and split the layer list programmatically along
 *  the same contract as the authored back/front documents (see
 *  isFrontLayerId). */
export function buildProtomapsStyles(flavor: ProtomapsFlavor): {
  back: AnyStyle;
  front: AnyStyle;
} {
  const all = protomapsLayers("osm-vector", namedFlavor(flavor), {
    lang: "en",
  }) as unknown as NonNullable<AnyStyle["layers"]>;
  const shell = (): AnyStyle => ({
    version: 8,
    sources: {
      "osm-vector": {
        type: "vector",
        // No endpoint here — patchBasemapStyle installs the configured
        // map.pmtiles value on every vector source.
        attribution: "© OpenStreetMap contributors",
      },
    },
    glyphs: PROTOMAPS_GLYPHS,
    sprite: protomapsSprite(flavor),
    layers: [],
  });
  const back = shell();
  back.layers = all.filter((l) => !isFrontLayerId(l.id));
  const front = shell();
  front.layers = [
    SYNTHESIZED_COASTLINE,
    ...all.filter((l) => isFrontLayerId(l.id)),
  ];
  return { back, front };
}

/** Applied to BOTH the back and front style documents. */
export function patchBasemapStyle(style: AnyStyle): void {
  for (const src of Object.values(style.sources ?? {})) {
    const s = src as { type?: string; tiles?: string[]; url?: string };
    if (s.type !== "vector") continue;
    if (basemapTiles.endsWith(".pmtiles")) {
      delete s.tiles;
      s.url = `pmtiles://${basemapTiles}`;
    } else {
      delete s.url;
      s.tiles = [basemapTiles];
    }
  }
  if (!Array.isArray(style.layers)) return;
  // Highway shields are map furniture, not weather context — drop the layer.
  style.layers = style.layers.filter((l) => l.id !== "roads_shields");
  for (const layer of style.layers) {
    // Drop the townspot/capital dot sprites on place labels — the white
    // fill reads as a data point on top of the weather drape.
    if (layer.id.startsWith("places")) {
      delete (layer.layout as Record<string, unknown> | undefined)?.["icon-image"];
    }
    if (layer?.filter === undefined) continue;
    layer.filter = coerceBoundariesCoalesce(layer.filter);
  }
}

/** Remove the halo outline around the front style's label text — the
 *  white (light flavors) / black (dark flavors) outline around place and
 *  water names reads as noise over colorful weather drapes. */
export function stripTextHalos(style: AnyStyle): void {
  for (const layer of style.layers ?? []) {
    if (layer.type !== "symbol") continue;
    const paint = layer.paint as Record<string, unknown> | undefined;
    if (!paint) continue;
    delete paint["text-halo-color"];
    delete paint["text-halo-width"];
    delete paint["text-halo-blur"];
  }
}

/** Fetch a vendored style document from /styles/{name}.json (the
 *  authored summer/winter pairs shipped in public/styles). Returns null
 *  on failure. Rejects an HTML dev-server fallback page (vite serves
 *  index.html for unknown paths) by requiring JSON to parse. */
export async function fetchStyleJson(name: string): Promise<AnyStyle | null> {
  try {
    const res = await fetch(`/styles/${name}.json`);
    if (!res.ok) return null;
    const text = await res.text();
    return JSON.parse(text) as AnyStyle;
  } catch {
    return null;
  }
}

/** Merge front into back: sources combined (front wins on collision),
 *  layers concatenated back-first (bottom), sprite/glyphs prefer the
 *  front's — labels and icons live there. A null front (fetch failed)
 *  returns the back unchanged so the map still renders. */
export function mergeBasemapStyles(back: AnyStyle, front: AnyStyle | null): AnyStyle {
  if (!front?.layers?.length) return back;
  return {
    ...back,
    version: back.version ?? 8,
    sources: { ...(back.sources ?? {}), ...(front.sources ?? {}) },
    layers: [...(back.layers ?? []), ...front.layers],
    sprite: front.sprite ?? back.sprite,
    glyphs: front.glyphs ?? back.glyphs,
    metadata: { ...(back.metadata ?? {}), [FRONT_ANCHOR_KEY]: front.layers[0].id },
  };
}
