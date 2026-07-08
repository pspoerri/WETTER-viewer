package sources

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/pspoerri/grib-viewer/internal/config"
)

// stacSource queries the MeteoSwiss OpenData STAC API
// (https://data.geo.admin.ch/api/stac/v1) via POST /search per
// (variable, perturbed, forecast horizon) tuple, with a GET items
// fallback for run discovery when POST returns 4xx.
type stacSource struct {
	id         string
	base       string // STAC root, no trailing slash; test-overridable
	collection string
	vars       []string // UPPERCASE at the API boundary
	maxStep    int
	now        func() time.Time
}

const stacDefaultBase = "https://data.geo.admin.ch/api/stac/v1"

// stacDefaultVars is the default variable set for ICON-CH collections.
var stacDefaultVars = []string{"T_2M", "TD_2M", "U_10M", "V_10M", "VMAX_10M", "TOT_PREC", "CLCT", "PMSL"}

// stacDefaultMaxStep is the default forecast horizon (ICON-CH1: +33 h).
const stacDefaultMaxStep = 33

func newSTACSource(cfg config.Source) *stacSource {
	vars := make([]string, 0, len(cfg.Variables))
	for _, v := range cfg.Variables {
		vars = append(vars, strings.ToUpper(v))
	}
	if len(vars) == 0 {
		vars = append(vars, stacDefaultVars...)
	}
	maxStep := cfg.MaxStep
	if maxStep <= 0 {
		maxStep = stacDefaultMaxStep
	}
	return &stacSource{
		id:         cfg.ID,
		base:       stacDefaultBase,
		collection: cfg.Collection,
		vars:       vars,
		maxStep:    maxStep,
		now:        time.Now,
	}
}

func (s *stacSource) ID() string { return s.id }

func (s *stacSource) Fetch(ctx context.Context, ref FileRef, dst io.Writer) error {
	return fetchURL(ctx, defaultClient, ref.URL, dst)
}

// stacSearchBody is the POST /search payload (only the fields we use).
type stacSearchBody struct {
	Collections           []string `json:"collections"`
	ForecastReferenceTime string   `json:"forecast:reference_datetime,omitempty"`
	ForecastVariable      string   `json:"forecast:variable,omitempty"`
	ForecastPerturbed     *bool    `json:"forecast:perturbed,omitempty"`
	ForecastHorizon       string   `json:"forecast:horizon,omitempty"`
	Limit                 int      `json:"limit,omitempty"`
}

type stacItemCollection struct {
	Features []stacItem `json:"features"`
}

type stacItem struct {
	ID         string               `json:"id"`
	Properties map[string]any       `json:"properties"`
	Assets     map[string]stacAsset `json:"assets"`
}

type stacAsset struct {
	ID   string `json:"id,omitempty"` // set on the collection /assets endpoint
	Href string `json:"href"`
	Type string `json:"type"`
}

// pickPrimaryAsset returns the first asset whose href ends .grib2 or
// whose MIME type contains "grib"; falls back to the first asset with
// an href at all.
func pickPrimaryAsset(item stacItem) (string, bool) {
	for _, a := range item.Assets {
		if strings.HasSuffix(strings.ToLower(a.Href), ".grib2") ||
			strings.Contains(strings.ToLower(a.Type), "grib") {
			return a.Href, true
		}
	}
	for _, a := range item.Assets {
		if a.Href != "" {
			return a.Href, true
		}
	}
	return "", false
}

// search issues POST /search for one (run, variable, horizon, perturbed)
// tuple. Variable names are upper-case at this boundary.
func (s *stacSource) search(ctx context.Context, run time.Time, variable string, hr int, perturbed bool) (*stacItemCollection, error) {
	body := stacSearchBody{
		Collections:           []string{s.collection},
		ForecastReferenceTime: run.UTC().Format(time.RFC3339),
		ForecastVariable:      strings.ToUpper(variable),
		ForecastPerturbed:     &perturbed,
		ForecastHorizon:       fmt.Sprintf("P0DT%02dH00M00S", hr),
		Limit:                 1,
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	var ic stacItemCollection
	if err := doJSON(ctx, defaultClient, "POST", s.base+"/search", payload, &ic); err != nil {
		return nil, err
	}
	return &ic, nil
}

// discoverLatestRun probes the search endpoint backwards from now in
// 1-hour steps (publication grid) up to maxProbes, "published" = the
// headline variable's control search returns a feature. On a 4xx POST
// it falls back once to GET /collections/{id}/items?sortby=-datetime.
func (s *stacSource) discoverLatestRun(ctx context.Context, maxProbes int) (time.Time, error) {
	if maxProbes <= 0 {
		maxProbes = 6
	}
	cand := s.now().UTC().Truncate(time.Hour)
	var lastErr error
	for i := 0; i < maxProbes; i++ {
		ic, err := s.search(ctx, cand, s.vars[0], 0, false)
		if err == nil && len(ic.Features) > 0 {
			return cand, nil
		}
		if err != nil {
			var se *httpStatusError
			if errors.As(err, &se) && se.Status >= 400 && se.Status < 500 {
				run, fbErr := s.fallbackLatestItem(ctx)
				if fbErr == nil {
					return run, nil
				}
				return time.Time{}, fmt.Errorf("stac %s: search 4xx and items fallback failed: %w / %w", s.id, err, fbErr)
			}
			lastErr = err
		}
		cand = cand.Add(-time.Hour)
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("stac %s: no published run found within the last %d hours", s.id, maxProbes)
	}
	return time.Time{}, lastErr
}

// fallbackLatestItem reads forecast:reference_datetime off the most
// recent item in the collection.
func (s *stacSource) fallbackLatestItem(ctx context.Context) (time.Time, error) {
	u := s.base + "/collections/" + s.collection + "/items?" +
		url.Values{"limit": {"1"}, "sortby": {"-datetime"}}.Encode()
	var ic stacItemCollection
	if err := doJSON(ctx, defaultClient, "GET", u, nil, &ic); err != nil {
		return time.Time{}, err
	}
	if len(ic.Features) == 0 {
		return time.Time{}, fmt.Errorf("stac %s: items fallback returned no features", s.id)
	}
	p := ic.Features[0].Properties
	if v, ok := p["forecast:reference_datetime"].(string); ok {
		return time.Parse(time.RFC3339, v)
	}
	if v, ok := p["datetime"].(string); ok {
		return time.Parse(time.RFC3339, v)
	}
	return time.Time{}, fmt.Errorf("stac %s: fallback item %q missing forecast:reference_datetime", s.id, ic.Features[0].ID)
}

// staticRefs lists the collection-level static assets (horizontal /
// vertical constants for the icosahedral grid).
func (s *stacSource) staticRefs(ctx context.Context) ([]FileRef, error) {
	u := s.base + "/collections/" + s.collection + "/assets"
	// MeteoSwiss returns assets as a JSON array of objects with an
	// "id" field (not a JSON object keyed by id like item assets).
	var raw struct {
		Assets []stacAsset `json:"assets"`
	}
	if err := doJSON(ctx, defaultClient, "GET", u, nil, &raw); err != nil {
		return nil, err
	}
	var out []FileRef
	for _, a := range raw.Assets {
		if a.ID == "" || a.Href == "" {
			continue
		}
		if strings.Contains(a.ID, "horizontal_constants") || strings.Contains(a.ID, "vertical_constants") {
			out = append(out, FileRef{URL: a.Href, LocalName: a.ID, Static: true})
		}
	}
	return out, nil
}

// Discover finds the latest published run and lists its per-horizon
// assets for every configured variable, control and perturbed.
func (s *stacSource) Discover(ctx context.Context) ([]RunListing, error) {
	run, err := s.discoverLatestRun(ctx, 6)
	if err != nil {
		return nil, err
	}

	type job struct {
		v    string
		hr   int
		pert bool
	}
	var jobs []job
	for _, v := range s.vars {
		for _, pert := range []bool{false, true} {
			for hr := 0; hr <= s.maxStep; hr++ {
				jobs = append(jobs, job{v, hr, pert})
			}
		}
	}
	results := make([]FileRef, len(jobs)) // zero URL = missing horizon
	var (
		wg       sync.WaitGroup
		mu       sync.Mutex
		firstErr error
	)
	sem := make(chan struct{}, 8)
	for i, j := range jobs {
		wg.Add(1)
		go func(i int, j job) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-sem }()
			ic, err := s.search(ctx, run, j.v, j.hr, j.pert)
			if err != nil {
				mu.Lock()
				if firstErr == nil {
					firstErr = fmt.Errorf("stac %s: list %s hr=%d: %w", s.id, j.v, j.hr, err)
				}
				mu.Unlock()
				return
			}
			if len(ic.Features) == 0 {
				return // missing forecast hour is non-fatal
			}
			href, ok := pickPrimaryAsset(ic.Features[0])
			if !ok {
				return
			}
			lvar := strings.ToLower(j.v)
			kind := "ctrl"
			if j.pert {
				kind = "pert"
			}
			results[i] = FileRef{
				URL:       href,
				LocalName: fmt.Sprintf("%s_%s_%03d.grib2", lvar, kind, j.hr),
				Var:       lvar,
				Step:      j.hr,
			}
		}(i, j)
	}
	wg.Wait()
	if firstErr != nil {
		return nil, firstErr
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	headline := strings.ToLower(s.vars[0])
	maxHr := -1
	var files []FileRef
	for i, r := range results {
		if r.URL == "" {
			continue
		}
		files = append(files, r)
		if r.Var == headline && !jobs[i].pert && r.Step > maxHr {
			maxHr = r.Step
		}
	}
	sort.SliceStable(files, func(a, b int) bool {
		if files[a].Var != files[b].Var {
			return files[a].Var < files[b].Var
		}
		return files[a].Step < files[b].Step
	})

	if static, err := s.staticRefs(ctx); err != nil {
		slog.Warn("stac: static assets unavailable", "source", s.id, "err", err)
	} else {
		files = append(files, static...)
	}

	return []RunListing{{
		Run:      run,
		Files:    files,
		Complete: maxHr >= s.maxStep,
	}}, nil
}
