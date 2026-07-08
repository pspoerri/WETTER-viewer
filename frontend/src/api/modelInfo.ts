/**
 * Human-readable model metadata registry.
 *
 * The metadata itself lives in the backend config (each source's `info:`
 * block in grib-viewer.yaml) and arrives with the /api/models catalog;
 * setModelCatalog() feeds it here once at startup. Components keep the
 * synchronous modelInfoFor(id) lookup they always had — for unknown ids
 * (catalog not loaded yet, or a model without an info block) it degrades
 * to the raw id as the display name.
 */

import type { Model } from "./types";

export interface ModelInfo {
  /** Human-friendly name, e.g. "ICON-CH1-EPS". */
  name: string;
  /** One-line description of the domain, resolution, cadence. */
  description: string;
  /** Publishing organisation, e.g. "MeteoSwiss". */
  provider: string;
  /** Provider website (optional). */
  providerUrl?: string;
  /** Short license label, e.g. "CC BY 4.0". */
  license: string;
  /** Link to the license text (optional). */
  licenseUrl?: string;
  /**
   * For composite models: ids of the physical models that contribute
   * data. Rendered as a nested list in the attribution page.
   */
  contributors?: string[];
}

const registry = new Map<string, ModelInfo>();

/** Ingest the /api/models catalog (App calls this when models load). */
export function setModelCatalog(models: Model[]): void {
  for (const m of models) {
    registry.set(m.id, {
      name: m.name || m.id,
      description: m.description ?? "",
      provider: m.provider ?? "",
      providerUrl: m.provider_url,
      license: m.license ?? "",
      licenseUrl: m.license_url,
      contributors: m.contributors,
    });
  }
}

/** Every model id the loaded catalog knows about. */
export function knownModelIds(): string[] {
  return [...registry.keys()];
}

/** Lookup a model's metadata, or a synthetic fallback using the id. */
export function modelInfoFor(id: string): ModelInfo {
  return (
    registry.get(id) ?? {
      name: id,
      description: "",
      provider: "",
      license: "",
    }
  );
}
