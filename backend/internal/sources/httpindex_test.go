package sources

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/pspoerri/grib-viewer/internal/config"
)

func TestHTTPIndexDiscover(t *testing.T) {
	fastRetries(t)
	mux := http.NewServeMux()
	pages := map[string]string{
		"/gribs/":           autoindex("run1/", "top.grib2", "notes.html"),
		"/gribs/run1/":      autoindex("a.grib2", "b.grib2.bz2", "deep/"),
		"/gribs/run1/deep/": autoindex("c.grb2", "deeper/"),
		// depth 3 from the root — still crawled
		"/gribs/run1/deep/deeper/": autoindex("d.grib"),
	}
	for path, body := range pages {
		mux.HandleFunc("GET "+path+"{$}", func(body string) http.HandlerFunc {
			return func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(body)) }
		}(body))
	}
	srv := httptest.NewServer(mux)
	defer srv.Close()

	src, err := newHTTPIndexSource(config.Source{ID: "archive", Type: "http-index", URL: srv.URL + "/gribs"})
	if err != nil {
		t.Fatalf("newHTTPIndexSource: %v", err)
	}
	listings, err := src.Discover(context.Background())
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	if len(listings) != 1 || !listings[0].Run.IsZero() {
		t.Fatalf("expected one zero-run listing, got %+v", listings)
	}
	got := map[string]string{}
	for _, f := range listings[0].Files {
		got[f.LocalName] = f.URL
	}
	want := map[string]string{
		"top.grib2":                  srv.URL + "/gribs/top.grib2",
		"run1__a.grib2":              srv.URL + "/gribs/run1/a.grib2",
		"run1__b.grib2":              srv.URL + "/gribs/run1/b.grib2.bz2",
		"run1__deep__c.grb2":         srv.URL + "/gribs/run1/deep/c.grb2",
		"run1__deep__deeper__d.grib": srv.URL + "/gribs/run1/deep/deeper/d.grib",
	}
	if len(got) != len(want) {
		t.Fatalf("got %d files %v, want %d", len(got), got, len(want))
	}
	for name, url := range want {
		if got[name] != url {
			t.Fatalf("file %s: got %q want %q", name, got[name], url)
		}
	}
}
