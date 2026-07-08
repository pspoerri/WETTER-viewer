// Emit the full built-in preset catalog as grib-viewer.yaml `presets:` entries
// (share-URL layer grammar via encodeLayerSegment). One-shot generator:
//   node scripts/gen-preset-yaml.mjs
import { PRESETS, encodeLayerSegment } from "../src/api/mapConfig.ts";

const q = (s) => JSON.stringify(s); // JSON strings are valid YAML scalars
let out = "";
for (const p of PRESETS) {
  out += `  - id: ${p.id}\n`;
  out += `    name: ${q(p.label)}\n`;
  out += `    icon: ${q(p.icon)}\n`;
  if (p.description) out += `    description: ${q(p.description)}\n`;
  out += `    layers: ${q(p.layers.map(encodeLayerSegment).join(","))}\n`;
  if (p.baseMap) out += `    base_map: ${p.baseMap}\n`;
}
console.log(out);
