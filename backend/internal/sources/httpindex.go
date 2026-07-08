package sources

import (
	"context"
	"fmt"
	"io"
	"net/url"
	"strings"

	"github.com/pspoerri/grib-viewer/internal/config"
)

// httpIndexSource enumerates a generic autoindex web host: it
// recursively scrapes hrefs (depth <= 3) for GRIB files and returns a
// single zero-run listing — the orchestrator downloads the files,
// header-scans them, and groups them into runs by reference time
// (exactly like the folder adapter, spec 01).
type httpIndexSource struct {
	id   string
	base *url.URL
}

const httpIndexMaxDepth = 3

func newHTTPIndexSource(cfg config.Source) (*httpIndexSource, error) {
	raw := cfg.URL
	if !strings.HasSuffix(raw, "/") {
		raw += "/"
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("sources: %s: bad url %q: %w", cfg.ID, cfg.URL, err)
	}
	return &httpIndexSource{id: cfg.ID, base: u}, nil
}

func (s *httpIndexSource) ID() string { return s.id }

func (s *httpIndexSource) Fetch(ctx context.Context, ref FileRef, dst io.Writer) error {
	return fetchURL(ctx, defaultClient, ref.URL, dst)
}

func (s *httpIndexSource) Discover(ctx context.Context) ([]RunListing, error) {
	seen := map[string]bool{}
	files, err := s.crawl(ctx, s.base, 0, seen)
	if err != nil {
		return nil, fmt.Errorf("http-index %s: %w", s.id, err)
	}
	return []RunListing{{Files: files, Complete: true}}, nil // Run zero: grouped after download
}

func (s *httpIndexSource) crawl(ctx context.Context, dir *url.URL, depth int, seen map[string]bool) ([]FileRef, error) {
	if seen[dir.String()] {
		return nil, nil
	}
	seen[dir.String()] = true
	body, err := getBody(ctx, defaultClient, dir.String())
	if err != nil {
		return nil, err
	}
	var out []FileRef
	for _, href := range parseHrefs(body) {
		ref, err := url.Parse(href)
		if err != nil {
			continue
		}
		abs := dir.ResolveReference(ref)
		// Stay on-host and under the configured prefix.
		if abs.Host != s.base.Host || !strings.HasPrefix(abs.Path, s.base.Path) {
			continue
		}
		switch {
		case strings.HasSuffix(abs.Path, "/"):
			if depth < httpIndexMaxDepth {
				sub, err := s.crawl(ctx, abs, depth+1, seen)
				if err != nil {
					return nil, err
				}
				out = append(out, sub...)
			}
		case isGribName(abs.Path):
			out = append(out, FileRef{
				URL:       abs.String(),
				LocalName: pathLocalName(abs.Path, s.base.Path),
			})
		}
	}
	return out, nil
}

// pathLocalName derives a unique run-dir filename from the path below
// the configured prefix ("a/b/f.grib2.bz2" -> "a__b__f.grib2").
func pathLocalName(path, prefix string) string {
	rel := strings.Trim(strings.TrimPrefix(path, prefix), "/")
	name := strings.ReplaceAll(rel, "/", "__")
	name = strings.TrimSuffix(name, ".bz2")
	if name == "" {
		name = "file.grib2"
	}
	if unescaped, err := url.PathUnescape(name); err == nil {
		name = strings.ReplaceAll(unescaped, "/", "__")
	}
	return name
}
