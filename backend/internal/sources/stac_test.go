package sources

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/pspoerri/grib-viewer/internal/config"
)

// newSTACTestServer implements enough of the MeteoSwiss STAC API for
// the adapter: POST /search, GET /collections/{id}/assets, and the
// GET items fallback. The published run is 2026-07-06T03:00Z with
// horizons 0..2.
func newSTACTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	const publishedRun = "2026-07-06T03:00:00Z"
	mux := http.NewServeMux()
	mux.HandleFunc("POST /search", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Collections           []string `json:"collections"`
			ForecastReferenceTime string   `json:"forecast:reference_datetime"`
			ForecastVariable      string   `json:"forecast:variable"`
			ForecastPerturbed     *bool    `json:"forecast:perturbed"`
			ForecastHorizon       string   `json:"forecast:horizon"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		if len(body.Collections) != 1 || body.Collections[0] != "test-coll" {
			http.Error(w, "wrong collection", 400)
			return
		}
		if body.ForecastVariable != strings.ToUpper(body.ForecastVariable) {
			http.Error(w, "variable must be uppercase", 400)
			return
		}
		var hr int
		if _, err := fmt.Sscanf(body.ForecastHorizon, "P0DT%02dH00M00S", &hr); err != nil {
			http.Error(w, "bad horizon", 400)
			return
		}
		run, err := time.Parse(time.RFC3339, body.ForecastReferenceTime)
		if err != nil {
			http.Error(w, "bad reference_datetime", 400)
			return
		}
		features := []any{}
		if run.Equal(mustParse(publishedRun)) && hr <= 2 {
			kind := "ctrl"
			if body.ForecastPerturbed != nil && *body.ForecastPerturbed {
				kind = "pert"
			}
			features = append(features, map[string]any{
				"id": fmt.Sprintf("item-%s-%d-%s", body.ForecastVariable, hr, kind),
				"assets": map[string]any{
					"data": map[string]any{
						"href": fmt.Sprintf("https://example.org/%s_%s_%03d.grib2", strings.ToLower(body.ForecastVariable), kind, hr),
						"type": "application/x-grib",
					},
				},
			})
		}
		json.NewEncoder(w).Encode(map[string]any{"type": "FeatureCollection", "features": features})
	})
	mux.HandleFunc("GET /collections/test-coll/assets", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"assets": []any{
				map[string]any{"id": "horizontal_constants_icon-ch1-eps.grib2", "href": "https://example.org/hconst.grib2"},
				map[string]any{"id": "vertical_constants_icon-ch1-eps.grib2", "href": "https://example.org/vconst.grib2"},
				map[string]any{"id": "something_else.txt", "href": "https://example.org/other.txt"},
			},
		})
	})
	return httptest.NewServer(mux)
}

func mustParse(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return t
}

func newTestSTACSource(url string) *stacSource {
	src := newSTACSource(config.Source{
		ID: "iconch1", Type: "meteoswiss-stac", Collection: "test-coll",
		Variables: []string{"T_2M", "TOT_PREC"}, MaxStep: 2,
	})
	src.base = url
	src.now = func() time.Time { return time.Date(2026, 7, 6, 5, 30, 0, 0, time.UTC) }
	return src
}

func TestSTACDiscover(t *testing.T) {
	fastRetries(t)
	srv := newSTACTestServer(t)
	defer srv.Close()

	src := newTestSTACSource(srv.URL)
	listings, err := src.Discover(context.Background())
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	if len(listings) != 1 {
		t.Fatalf("expected 1 listing, got %d", len(listings))
	}
	l := listings[0]
	// Probes 05, 04 (empty) then finds 03.
	if !l.Run.Equal(time.Date(2026, 7, 6, 3, 0, 0, 0, time.UTC)) {
		t.Fatalf("run = %v", l.Run)
	}
	if !l.Complete {
		t.Fatal("run should be complete (headline reaches MaxStep)")
	}

	var static, ctrl, pert int
	byName := map[string]FileRef{}
	for _, f := range l.Files {
		byName[f.LocalName] = f
		switch {
		case f.Static:
			static++
		case strings.Contains(f.LocalName, "_ctrl_"):
			ctrl++
		case strings.Contains(f.LocalName, "_pert_"):
			pert++
		}
	}
	// 2 vars x 3 horizons for each of ctrl/pert + 2 static assets.
	if ctrl != 6 || pert != 6 || static != 2 {
		t.Fatalf("ctrl=%d pert=%d static=%d files=%d", ctrl, pert, static, len(l.Files))
	}
	f, ok := byName["t_2m_ctrl_001.grib2"]
	if !ok {
		t.Fatalf("missing t_2m_ctrl_001.grib2: %+v", byName)
	}
	if f.Var != "t_2m" || f.Step != 1 || f.URL != "https://example.org/t_2m_ctrl_001.grib2" {
		t.Fatalf("bad ref: %+v", f)
	}
	if _, ok := byName["horizontal_constants_icon-ch1-eps.grib2"]; !ok {
		t.Fatal("missing horizontal constants static ref")
	}
}

func TestSTACDiscoverIncomplete(t *testing.T) {
	fastRetries(t)
	srv := newSTACTestServer(t)
	defer srv.Close()

	src := newTestSTACSource(srv.URL)
	src.maxStep = 5 // server only publishes horizons 0..2
	listings, err := src.Discover(context.Background())
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	if listings[0].Complete {
		t.Fatal("run must be incomplete when trailing horizons are missing")
	}
}

func TestSTACDiscoverLatestRunFallback(t *testing.T) {
	fastRetries(t)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /search", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "search not supported", http.StatusBadRequest)
	})
	mux.HandleFunc("GET /collections/test-coll/items", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("sortby") != "-datetime" || r.URL.Query().Get("limit") != "1" {
			http.Error(w, "bad query", 400)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{
			"features": []any{map[string]any{
				"id": "latest",
				"properties": map[string]any{
					"forecast:reference_datetime": "2026-07-06T02:00:00Z",
				},
			}},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	src := newTestSTACSource(srv.URL)
	run, err := src.discoverLatestRun(context.Background(), 6)
	if err != nil {
		t.Fatalf("discoverLatestRun: %v", err)
	}
	if !run.Equal(time.Date(2026, 7, 6, 2, 0, 0, 0, time.UTC)) {
		t.Fatalf("run = %v", run)
	}
}
