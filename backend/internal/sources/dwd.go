package sources

import (
	"context"
	"errors"
	"fmt"
	"io"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pspoerri/grib-viewer/internal/config"
)

// dwdSource lists DWD's opendata mod_autoindex file server at
// https://opendata.dwd.de/weather/nwp/{model}/grib/{HH}/{var}/.
//
// Filenames look like
//
//	{prefix}_{grid}_{leveltype}_{YYYYMMDDHH}_{FFF}[_{lvl}]_{VAR}.grib2.bz2
//
// (single-level; pressure-level carries the extra level group;
// time-invariant files have no forecast hour). The prefix and grid
// tokens come from the listing itself — new DWD models work by
// configuring model: only.
type dwdSource struct {
	id       string
	base     string   // .../weather/nwp/{model}/grib (no trailing slash); test-overridable
	vars     []string // lowercase allowlist; empty = all subdirectories
	maxStep  int      // 0 = no cap
	keepRuns int
	now      func() time.Time

	mu          sync.Mutex
	maxSeenStep int // max FFF ever seen for the headline var (completeness heuristic)
}

const dwdOpendataBase = "https://opendata.dwd.de/weather/nwp"

// dwdRunLayout is the YYYYMMDDHH run id used in DWD filenames.
const dwdRunLayout = "2006010215"

func newDWDSource(cfg config.Source) *dwdSource {
	vars := make([]string, 0, len(cfg.Variables))
	for _, v := range cfg.Variables {
		vars = append(vars, strings.ToLower(v))
	}
	return &dwdSource{
		id:       cfg.ID,
		base:     dwdOpendataBase + "/" + strings.Trim(cfg.Model, "/") + "/grib",
		vars:     vars,
		maxStep:  cfg.MaxStep,
		keepRuns: cfg.KeepRuns,
		now:      time.Now,
	}
}

func (s *dwdSource) ID() string { return s.id }

func (s *dwdSource) Fetch(ctx context.Context, ref FileRef, dst io.Writer) error {
	return fetchURL(ctx, defaultClient, ref.URL, dst)
}

// headline is the variable whose presence marks a run as published.
func (s *dwdSource) headline() string {
	if len(s.vars) > 0 {
		return s.vars[0]
	}
	return "t_2m"
}

// listingCache caches directory listings for the life of one Discover
// pass.
type listingCache map[string][]string

func (s *dwdSource) list(ctx context.Context, cache listingCache, url string) ([]string, error) {
	if h, ok := cache[url]; ok {
		return h, nil
	}
	body, err := getBody(ctx, defaultClient, url)
	if err != nil {
		return nil, err
	}
	h := parseHrefs(body)
	cache[url] = h
	return h, nil
}

var dwdHourDirRE = regexp.MustCompile(`^(\d{2})/$`)
var dwdVarDirRE = regexp.MustCompile(`^([a-z0-9_]+)/$`)

// runHours lists {base}/ and returns the run-hour directories present,
// sorted ascending.
func (s *dwdSource) runHours(ctx context.Context, cache listingCache) ([]int, error) {
	hrefs, err := s.list(ctx, cache, s.base+"/")
	if err != nil {
		return nil, err
	}
	var hours []int
	for _, h := range hrefs {
		if m := dwdHourDirRE.FindStringSubmatch(h); m != nil {
			n, _ := strconv.Atoi(m[1])
			if n < 24 {
				hours = append(hours, n)
			}
		}
	}
	sort.Ints(hours)
	return hours, nil
}

func is404(err error) bool {
	var se *httpStatusError
	return errors.As(err, &se) && se.Status == 404
}

// Discover walks back from now over the run hours present, returning a
// listing for each published run (newest first, up to keepRuns runs).
func (s *dwdSource) Discover(ctx context.Context) ([]RunListing, error) {
	cache := listingCache{}
	hours, err := s.runHours(ctx, cache)
	if err != nil {
		return nil, fmt.Errorf("dwd %s: list run hours: %w", s.id, err)
	}
	if len(hours) == 0 {
		return nil, fmt.Errorf("dwd %s: no run-hour directories under %s", s.id, s.base)
	}
	hourSet := map[int]bool{}
	for _, h := range hours {
		hourSet[h] = true
	}
	// Newest cadence point <= now.
	t := s.now().UTC().Truncate(time.Hour)
	for i := 0; i < 25 && !hourSet[t.Hour()]; i++ {
		t = t.Add(-time.Hour)
	}
	prevCadence := func(t time.Time) time.Time {
		t = t.Add(-time.Hour)
		for i := 0; i < 25 && !hourSet[t.Hour()]; i++ {
			t = t.Add(-time.Hour)
		}
		return t
	}

	want := s.keepRuns
	if want <= 0 {
		want = 1
	}
	if want > 8 {
		want = 8
	}
	maxProbes := want + 6

	var listings []RunListing
	var lastErr error
	for probe := 0; probe < maxProbes && len(listings) < want; probe++ {
		runID := t.Format(dwdRunLayout)
		hh := fmt.Sprintf("%02d", t.Hour())
		names, err := s.list(ctx, cache, s.base+"/"+hh+"/"+s.headline()+"/")
		published := false
		if err == nil {
			for _, name := range names {
				if f, ok := parseDWDFilename(name, s.headline()); ok && f.runID == runID {
					published = true
					break
				}
			}
		} else if !is404(err) {
			lastErr = err
		}
		if published {
			l, err := s.buildRun(ctx, cache, t)
			if err != nil {
				return nil, err
			}
			listings = append(listings, l)
		}
		t = prevCadence(t)
	}
	if len(listings) == 0 {
		if lastErr != nil {
			return nil, fmt.Errorf("dwd %s: %w", s.id, lastErr)
		}
		return nil, fmt.Errorf("dwd %s: no published run found within %d probes", s.id, maxProbes)
	}
	return listings, nil
}

// buildRun assembles the FileRefs of one run from the per-variable
// directory listings.
func (s *dwdSource) buildRun(ctx context.Context, cache listingCache, run time.Time) (RunListing, error) {
	runID := run.Format(dwdRunLayout)
	hh := fmt.Sprintf("%02d", run.Hour())

	vars := s.vars
	if len(vars) == 0 {
		hrefs, err := s.list(ctx, cache, s.base+"/"+hh+"/")
		if err != nil {
			return RunListing{}, fmt.Errorf("dwd %s: list variables: %w", s.id, err)
		}
		for _, h := range hrefs {
			if m := dwdVarDirRE.FindStringSubmatch(h); m != nil {
				vars = append(vars, m[1])
			}
		}
	}

	// Icosahedral models need the clat/clon companions regardless of
	// any variable allowlist; regular-grid models 404 here (tolerated).
	for _, c := range []string{"clat", "clon"} {
		if !slices.Contains(vars, c) {
			vars = append(vars, c)
		}
	}

	var files []FileRef
	maxHr := -1
	for _, v := range vars {
		dir := s.base + "/" + hh + "/" + v + "/"
		names, err := s.list(ctx, cache, dir)
		if err != nil {
			if is404(err) {
				continue // variable not published for this model
			}
			return RunListing{}, fmt.Errorf("dwd %s: list %s: %w", s.id, v, err)
		}
		static := v == "clat" || v == "clon"
		for _, name := range names {
			f, ok := parseDWDFilename(name, v)
			if !ok || f.runID != runID {
				continue
			}
			if !static && !f.timeInvariant && s.maxStep > 0 && f.step > s.maxStep {
				continue
			}
			if v == s.headline() && !f.timeInvariant && f.step > maxHr {
				maxHr = f.step
			}
			files = append(files, FileRef{
				URL:       dir + name,
				LocalName: strings.TrimSuffix(name, ".bz2"),
				Var:       v,
				Step:      f.step,
				Static:    static,
			})
		}
	}

	// Completeness heuristic: the headline variable's max forecast hour
	// vs the max ever seen for this model (capped at maxStep).
	s.mu.Lock()
	if maxHr > s.maxSeenStep {
		s.maxSeenStep = maxHr
	}
	expect := s.maxSeenStep
	s.mu.Unlock()
	if s.maxStep > 0 && s.maxStep < expect {
		expect = s.maxStep
	}
	return RunListing{
		Run:      run,
		Files:    files,
		Complete: maxHr >= expect && maxHr >= 0,
	}, nil
}

// dwdFile is the parse result of one DWD opendata filename.
type dwdFile struct {
	runID         string
	step          int
	timeInvariant bool
}

// dwdTailRE matches the trailing "_{YYYYMMDDHH}[_{FFF}][_{lvl}]" of a
// filename after the variable suffix and extensions were stripped.
// lvl covers pressure levels ("850"), the D2 level-marker ("2d"), and
// the D2 time-invariant "0" token.
var dwdTailRE = regexp.MustCompile(`_(\d{10})(?:_(\d{3}))?(?:_([0-9]+[a-z]?))?$`)

// parseDWDFilename parses one listing entry against the variable name
// the directory is for (the var is known from the listing path, which
// resolves the underscore ambiguity between level tokens and variable
// names like t_2m).
func parseDWDFilename(name, wantVar string) (dwdFile, bool) {
	n := strings.TrimSuffix(name, ".bz2")
	if !strings.HasSuffix(n, ".grib2") {
		return dwdFile{}, false
	}
	n = strings.TrimSuffix(n, ".grib2")
	// icon / icon-eu list variables in UPPERCASE (_T_2M), icon-d2 in
	// lowercase — compare case-insensitively
	if !strings.HasSuffix(strings.ToLower(n), "_"+strings.ToLower(wantVar)) {
		return dwdFile{}, false
	}
	rest := n[:len(n)-len(wantVar)-1]
	m := dwdTailRE.FindStringSubmatch(rest)
	if m == nil {
		return dwdFile{}, false
	}
	f := dwdFile{
		runID:         m[1],
		timeInvariant: strings.Contains(name, "time-invariant"),
	}
	if m[2] != "" && !f.timeInvariant {
		f.step, _ = strconv.Atoi(m[2])
	}
	return f, true
}
