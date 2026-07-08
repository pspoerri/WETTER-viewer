// Package sources implements the data-source layer (spec 01): adapters
// that discover forecast runs upstream (MeteoSwiss STAC, DWD opendata,
// generic autoindex/S3 hosts, local folders) and an orchestrator that
// downloads and indexes them into the on-disk GRIB buffer.
package sources

import (
	"context"
	"fmt"
	"io"
	"time"

	"github.com/pspoerri/grib-viewer/internal/config"
)

// FileRef identifies one file of a run.
type FileRef struct {
	URL       string // remote URL, or absolute local path for in-place files
	LocalName string // filename within the run dir ("" for in-place files)
	Var       string // variable hint for gribidx.ScanFile
	Step      int    // forecast hour (informational)
	Static    bool   // horizontal/vertical constants -> StaticDir
}

// RunListing describes one upstream run: its reference time and the
// files that make it up.
type RunListing struct {
	Run      time.Time
	Files    []FileRef
	Complete bool // no trailing steps missing vs expected horizon (best effort)
	InPlace  bool // folder source: files are indexed where they live
}

// Source is a data-source adapter.
type Source interface {
	ID() string
	Discover(ctx context.Context) ([]RunListing, error) // newest first
	// Fetch streams one remote file, bz2-inflated when the URL ends .bz2.
	Fetch(ctx context.Context, ref FileRef, dst io.Writer) error
}

// New constructs the adapter for cfg.Type.
func New(cfg config.Source) (Source, error) {
	switch cfg.Type {
	case "folder":
		if cfg.Path == "" {
			return nil, fmt.Errorf("sources: %s: folder source needs path", cfg.ID)
		}
		return newFolderSource(cfg), nil
	case "dwd-opendata":
		if cfg.Model == "" {
			return nil, fmt.Errorf("sources: %s: dwd-opendata source needs model", cfg.ID)
		}
		return newDWDSource(cfg), nil
	case "meteoswiss-stac":
		if cfg.Collection == "" {
			return nil, fmt.Errorf("sources: %s: meteoswiss-stac source needs collection", cfg.ID)
		}
		return newSTACSource(cfg), nil
	case "http-index":
		if cfg.URL == "" {
			return nil, fmt.Errorf("sources: %s: http-index source needs url", cfg.ID)
		}
		return newHTTPIndexSource(cfg)
	case "s3":
		if cfg.URL == "" {
			return nil, fmt.Errorf("sources: %s: s3 source needs url", cfg.ID)
		}
		return newS3Source(cfg)
	default:
		return nil, fmt.Errorf("sources: %s: unknown source type %q", cfg.ID, cfg.Type)
	}
}
