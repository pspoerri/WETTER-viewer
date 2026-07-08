package sources

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/pspoerri/grib-viewer/internal/config"
)

func autoindex(names ...string) string {
	var b strings.Builder
	b.WriteString(`<html><body><a href="../">Parent</a><a href="?C=N;O=D">Name</a>`)
	for _, n := range names {
		fmt.Fprintf(&b, `<a href="%s">%s</a>`, n, n)
	}
	b.WriteString("</body></html>")
	return b.String()
}

func TestParseDWDFilename(t *testing.T) {
	cases := []struct {
		name, wantVar string
		ok            bool
		runID         string
		step          int
		timeInv       bool
	}{
		// ICON-EU-EPS single-level
		{"icon-eu-eps_europe_icosahedral_single-level_2026070600_012_t_2m.grib2.bz2", "t_2m", true, "2026070600", 12, false},
		// ICON-D2 single-level with "2d" level marker
		{"icon-d2_germany_icosahedral_single-level_2026070600_001_2d_t_2m.grib2.bz2", "t_2m", true, "2026070600", 1, false},
		// pressure-level with the extra level group
		{"icon-eu-eps_europe_icosahedral_pressure-level_2026070600_000_500_fi.grib2.bz2", "fi", true, "2026070600", 0, false},
		// time-invariant, EU form (no FFF)
		{"icon-eu-eps_europe_icosahedral_time-invariant_2026070600_clat.grib2.bz2", "clat", true, "2026070600", 0, true},
		// time-invariant, D2 form (extra _000_0_)
		{"icon-d2_germany_icosahedral_time-invariant_2026070600_000_0_clat.grib2.bz2", "clat", true, "2026070600", 0, true},
		// uncompressed grib2 accepted too
		{"icon_global_icosahedral_single-level_2026070600_048_tot_prec.grib2", "tot_prec", true, "2026070600", 48, false},
		// wrong variable directory
		{"icon-d2_germany_icosahedral_single-level_2026070600_001_2d_t_2m.grib2.bz2", "td_2m", false, "", 0, false},
		// not a grib file
		{"icon-d2_germany_readme.txt", "t_2m", false, "", 0, false},
	}
	for _, c := range cases {
		f, ok := parseDWDFilename(c.name, c.wantVar)
		if ok != c.ok {
			t.Errorf("%s (%s): ok=%v want %v", c.name, c.wantVar, ok, c.ok)
			continue
		}
		if !ok {
			continue
		}
		if f.runID != c.runID || f.step != c.step || f.timeInvariant != c.timeInv {
			t.Errorf("%s: got %+v want run=%s step=%d timeInv=%v", c.name, f, c.runID, c.step, c.timeInv)
		}
	}
}

// newDWDTestServer serves a synthetic opendata tree with runs at 00
// and 12 UTC for 2026-07-06 (00 run) / 2026-07-05 (12 run).
func newDWDTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	file := func(run, hr, v string) string {
		return fmt.Sprintf("icon-d2_germany_icosahedral_single-level_%s_%s_2d_%s.grib2.bz2", run, hr, v)
	}
	mux := http.NewServeMux()
	pages := map[string]string{
		"/":    autoindex("00/", "12/"),
		"/00/": autoindex("t_2m/", "tot_prec/", "clat/"),
		"/12/": autoindex("t_2m/", "tot_prec/", "clat/"),
		"/00/t_2m/": autoindex(
			file("2026070600", "000", "t_2m"),
			file("2026070600", "001", "t_2m"),
			file("2026070600", "048", "t_2m"),
		),
		"/00/tot_prec/": autoindex(
			file("2026070600", "000", "tot_prec"),
			file("2026070600", "001", "tot_prec"),
		),
		"/00/clat/": autoindex(
			"icon-d2_germany_icosahedral_time-invariant_2026070600_000_0_clat.grib2.bz2",
		),
		"/12/t_2m/": autoindex(
			file("2026070512", "000", "t_2m"),
			file("2026070512", "048", "t_2m"),
		),
		"/12/tot_prec/": autoindex(
			file("2026070512", "000", "tot_prec"),
		),
		"/12/clat/": autoindex(
			"icon-d2_germany_icosahedral_time-invariant_2026070512_000_0_clat.grib2.bz2",
		),
	}
	for path, body := range pages {
		mux.HandleFunc("GET "+path+"{$}", func(body string) http.HandlerFunc {
			return func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(body)) }
		}(body))
	}
	return httptest.NewServer(mux)
}

func TestDWDDiscover(t *testing.T) {
	fastRetries(t)
	srv := newDWDTestServer(t)
	defer srv.Close()

	src := newDWDSource(config.Source{ID: "icond2", Type: "dwd-opendata", Model: "icon-d2", KeepRuns: 2, MaxStep: 1})
	src.base = srv.URL
	src.now = func() time.Time { return time.Date(2026, 7, 6, 5, 30, 0, 0, time.UTC) }

	listings, err := src.Discover(context.Background())
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	if len(listings) != 2 {
		t.Fatalf("expected 2 runs, got %d", len(listings))
	}
	newest := listings[0]
	if got := newest.Run; !got.Equal(time.Date(2026, 7, 6, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("newest run = %v", got)
	}
	if got := listings[1].Run; !got.Equal(time.Date(2026, 7, 5, 12, 0, 0, 0, time.UTC)) {
		t.Fatalf("second run = %v", got)
	}

	// MaxStep=1 filters FFF=048: expect t_2m 000+001, tot_prec 000+001, clat.
	byVar := map[string][]FileRef{}
	for _, f := range newest.Files {
		byVar[f.Var] = append(byVar[f.Var], f)
	}
	if len(byVar["t_2m"]) != 2 || len(byVar["tot_prec"]) != 2 || len(byVar["clat"]) != 1 {
		t.Fatalf("unexpected file sets: %+v", byVar)
	}
	clat := byVar["clat"][0]
	if !clat.Static {
		t.Fatal("clat must be static")
	}
	if !strings.HasSuffix(clat.LocalName, ".grib2") || strings.HasSuffix(clat.LocalName, ".bz2") {
		t.Fatalf("LocalName must strip .bz2: %q", clat.LocalName)
	}
	for _, f := range byVar["t_2m"] {
		if !strings.HasPrefix(f.URL, srv.URL+"/00/t_2m/") {
			t.Fatalf("bad URL %q", f.URL)
		}
	}
	// Headline max step (1 after MaxStep filter) reaches the cap -> complete.
	if !newest.Complete {
		t.Fatal("newest run should be complete (headline reaches MaxStep)")
	}
}

func TestDWDDiscoverVariableAllowlist(t *testing.T) {
	fastRetries(t)
	srv := newDWDTestServer(t)
	defer srv.Close()

	src := newDWDSource(config.Source{ID: "icond2", Type: "dwd-opendata", Model: "icon-d2", KeepRuns: 1, Variables: []string{"T_2M"}})
	src.base = srv.URL
	src.now = func() time.Time { return time.Date(2026, 7, 6, 5, 30, 0, 0, time.UTC) }

	listings, err := src.Discover(context.Background())
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	if len(listings) != 1 {
		t.Fatalf("expected 1 run, got %d", len(listings))
	}
	// clat/clon statics bypass the allowlist (icosahedral grids are
	// unusable without them); everything else must be t_2m.
	n := 0
	for _, f := range listings[0].Files {
		if f.Static {
			continue
		}
		if f.Var != "t_2m" {
			t.Fatalf("allowlist violated: %+v", f)
		}
		n++
	}
	if n != 3 {
		t.Fatalf("expected 3 t_2m files, got %d", n)
	}
}
