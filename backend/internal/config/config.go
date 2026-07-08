// Package config loads the grib-viewer YAML configuration (spec 01).
package config

import (
	"bytes"
	"fmt"
	"os"
	"time"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Listen      string   `yaml:"listen"`
	DataDir     string   `yaml:"data_dir"`
	CORSOrigins []string `yaml:"cors_origins"`
	Cache       Cache    `yaml:"cache"`
	Map         MapData  `yaml:"map"`
	Sources     []Source `yaml:"sources"`
	Presets     []Preset `yaml:"presets"`
}

// MapData points the UI at its basemap/terrain data, served verbatim by
// /api/mapconfig. Load() fills defaults for absent fields, so the
// config is the single source of truth — the frontend's hardcoded
// copies only apply when no backend is reachable at all (static-only
// hosting without the API).
type MapData struct {
	// PMTiles is the OSM vector basemap source. Two forms: an XYZ tile
	// URL template (https://…/{z}/{x}/{y}.pbf) or a Protomaps-style
	// .pmtiles archive URL, which the browser reads directly via HTTP
	// range requests (CORS required). Planet archives can be downloaded
	// from https://maps.protomaps.com/builds/.
	PMTiles string `yaml:"pmtiles" json:"pmtiles,omitempty"`
	// Terrain is the terrarium-encoded terrain source. Two forms: a
	// tile URL template (https://tiles.mapterhorn.com/{z}/{x}/{y}.webp,
	// whose TileJSON is expected next to it at {base}/tilejson.json) or
	// a terrarium .pmtiles archive URL read directly via HTTP range
	// requests (CORS required).
	Terrain string `yaml:"terrain" json:"terrain,omitempty"`
}

// Preset is a server-defined layer preset, served verbatim by
// /api/presets. The UI lists these in its preset picker alongside the
// user's locally-saved ones (server presets are not deletable there).
// Layers uses the share-URL grammar — build the view in the UI and copy
// the `l=` parameter out of the address bar.
type Preset struct {
	// ID is optional. When it matches one of the UI's built-in preset
	// ids (temperature, wind, precipitation, …) this entry OVERRIDES
	// that built-in in place — same topic slot, layers/label/icon from
	// here. Any other (or absent) id lists the preset in the ⭐ strip.
	ID          string `yaml:"id" json:"id,omitempty"`
	Name        string `yaml:"name" json:"name"`
	Icon        string `yaml:"icon" json:"icon"`               // emoji glyph for the picker (default ⭐)
	Description string `yaml:"description" json:"description,omitempty"`
	Layers      string `yaml:"layers" json:"layers"`             // e.g. "vmax_10m.t.10.ga,!pmsl.c.10"
	BaseMap     string `yaml:"base_map" json:"base_map,omitempty"` // optional basemap override
}

type Cache struct {
	FieldsMB int `yaml:"fields_mb"`
}

type Source struct {
	ID       string        `yaml:"id"`
	Type     string        `yaml:"type"`  // folder | dwd-opendata | meteoswiss-stac | http-index | s3
	Fetch    string        `yaml:"fetch"` // loop | once | off
	Interval time.Duration `yaml:"interval"`
	KeepRuns int           `yaml:"keep_runs"`

	// type-specific
	Path       string   `yaml:"path"`       // folder
	Model      string   `yaml:"model"`      // dwd-opendata: path under weather/nwp/
	Collection string   `yaml:"collection"` // meteoswiss-stac
	URL        string   `yaml:"url"`        // http-index | s3
	Variables  []string `yaml:"variables"`  // optional allowlist of upstream variable names
	MaxStep    int      `yaml:"max_step"`   // optional forecast-hour cap (0 = all)

	// Human-readable model metadata, surfaced verbatim by /api/models.
	Info SourceInfo `yaml:"info"`
}

// SourceInfo is the per-model attribution block the UI renders (model
// switcher labels, attribution page, map credits). All fields optional;
// the frontend falls back to the source id.
type SourceInfo struct {
	Name        string `yaml:"name"`         // friendly name, e.g. "ICON-D2-EPS"
	Description string `yaml:"description"`  // one-line domain/resolution/cadence
	Provider    string `yaml:"provider"`     // publishing organisation
	ProviderURL string `yaml:"provider_url"` // provider website
	License     string `yaml:"license"`      // short license label
	LicenseURL  string `yaml:"license_url"`  // license text link
}

func Load(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	cfg := &Config{
		Listen: ":8080",
		Cache:  Cache{FieldsMB: 4096},
	}
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	dec.KnownFields(true) // unknown keys are errors (catch typos)
	if err := dec.Decode(cfg); err != nil {
		return nil, fmt.Errorf("config %s: %w", path, err)
	}
	if cfg.DataDir == "" {
		cfg.DataDir = "./data"
	}
	if cfg.Map.PMTiles == "" {
		cfg.Map.PMTiles = "https://tiles.rsp.li/osm/{z}/{x}/{y}.pbf"
	}
	if cfg.Map.Terrain == "" {
		cfg.Map.Terrain = "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp"
	}
	seen := map[string]bool{}
	for i := range cfg.Sources {
		s := &cfg.Sources[i]
		if s.ID == "" {
			return nil, fmt.Errorf("config: source %d has no id", i)
		}
		if seen[s.ID] {
			return nil, fmt.Errorf("config: duplicate source id %q", s.ID)
		}
		seen[s.ID] = true
		if s.Fetch == "" {
			s.Fetch = "loop"
		}
		switch s.Fetch {
		case "loop", "once", "off":
		default:
			return nil, fmt.Errorf("config: source %s: fetch must be loop|once|off", s.ID)
		}
		if s.Interval == 0 {
			s.Interval = 15 * time.Minute
		}
		if s.KeepRuns == 0 {
			s.KeepRuns = 2
		}
	}
	for i := range cfg.Presets {
		p := &cfg.Presets[i]
		if p.Name == "" {
			return nil, fmt.Errorf("config: preset %d has no name", i)
		}
		if p.Layers == "" {
			return nil, fmt.Errorf("config: preset %q has no layers", p.Name)
		}
		if p.Icon == "" {
			p.Icon = "⭐"
		}
	}
	return cfg, nil
}
