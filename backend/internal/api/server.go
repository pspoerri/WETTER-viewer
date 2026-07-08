// Package api implements the HTTP surface (spec 03).
package api

import (
	"compress/gzip"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/pspoerri/grib-viewer/internal/config"
	"github.com/pspoerri/grib-viewer/internal/engine"
)

type Server struct {
	Engine  *engine.Engine
	Cfg     *config.Config
	Status  func() any   // orchestrator status snapshot (opaque JSON)
	Static  http.Handler // embedded frontend (webui.Handler()); nil = API-only
	sources map[string]config.Source

	reqs *prometheus.CounterVec
	dur  *prometheus.HistogramVec
	once sync.Once
}

func New(eng *engine.Engine, cfg *config.Config, status func() any) *Server {
	srcs := map[string]config.Source{}
	for _, s := range cfg.Sources {
		srcs[s.ID] = s
	}
	return &Server{Engine: eng, Cfg: cfg, Status: status, sources: srcs}
}

func (s *Server) metrics() {
	s.once.Do(func() {
		s.reqs = promauto.NewCounterVec(prometheus.CounterOpts{
			Name: "grib_viewer_http_requests_total",
		}, []string{"route", "status"})
		s.dur = promauto.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "grib_viewer_http_request_seconds",
			Buckets: prometheus.DefBuckets,
		}, []string{"route"})
	})
}

// Static, when set, serves the embedded frontend from / (mounted
// outside the API's gzip middleware — its assets are pre-compressed).
func (s *Server) Handler() http.Handler {
	s.metrics()
	mux := http.NewServeMux()
	route := func(pattern string, h http.HandlerFunc) {
		mux.Handle(pattern, s.instrument(pattern, h))
	}
	route("GET /api/healthz", s.handleHealthz)
	route("GET /api/status", s.handleStatus)
	route("GET /api/models", s.handleModels)
	route("GET /api/models/{model}/runs", s.handleRuns)
	route("GET /api/models/{model}/runs/{run}", s.handleRun)
	route("GET /api/models/{model}/meta/{var}", s.handleMeta)
	route("GET /api/models/{model}/point/{time}/{var}", s.handlePoint)
	route("GET /api/models/{model}/data/{time}/{var}", s.handleData)
	route("GET /api/models/{model}/window/{time}/{var}", s.handleWindowJSON)
	route("GET /api/models/{model}/grid/{time}/{var}", s.handleGrid)
	route("GET /api/composite/{id}", s.handleComposite)
	route("GET /api/colormaps", s.handleColormaps)
	route("GET /api/presets", s.handlePresets)
	route("GET /api/mapconfig", s.handleMapConfig)
	route("GET /api/version", s.handleVersion)
	route("GET /api/openapi.json", s.handleOpenAPI)
	mux.Handle("GET /metrics", promhttp.Handler())
	apiHandler := s.withCORS(withGzip(mux))
	if s.Static == nil {
		return apiHandler
	}
	outer := http.NewServeMux()
	outer.Handle("/api/", apiHandler)
	outer.Handle("/metrics", apiHandler)
	outer.Handle("/", s.Static)
	return outer
}

// ---- middleware ----

type statusWriter struct {
	http.ResponseWriter
	code int
}

func (w *statusWriter) WriteHeader(c int) { w.code = c; w.ResponseWriter.WriteHeader(c) }

func (s *Server) instrument(route string, h http.HandlerFunc) http.Handler {
	timer := s.dur.WithLabelValues(route)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sw := &statusWriter{ResponseWriter: w, code: 200}
		obs := prometheus.NewTimer(timer)
		h(sw, r)
		obs.ObserveDuration()
		s.reqs.WithLabelValues(route, fmt.Sprint(sw.code)).Inc()
	})
}

func (s *Server) allowOrigin(origin string) bool {
	if origin == "" {
		return false
	}
	for _, o := range s.Cfg.CORSOrigins {
		if o == "*" || strings.EqualFold(o, origin) {
			return true
		}
	}
	// default: loopback on any port
	for _, h := range []string{"http://localhost", "https://localhost", "http://127.0.0.1", "https://127.0.0.1", "http://[::1]", "https://[::1]"} {
		if origin == h || strings.HasPrefix(origin, h+":") {
			return true
		}
	}
	return false
}

func (s *Server) withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); s.allowOrigin(origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Add("Vary", "Origin")
		}
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

type gzipWriter struct {
	http.ResponseWriter
	gz *gzip.Writer
}

func (w *gzipWriter) Write(p []byte) (int, error) { return w.gz.Write(p) }

func withGzip(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Content-Encoding", "gzip")
		gz := gzip.NewWriter(w)
		defer gz.Close()
		next.ServeHTTP(&gzipWriter{ResponseWriter: w, gz: gz}, r)
	})
}

// ---- helpers ----

type apiError struct {
	Error     string `json:"error"`
	ValidFrom string `json:"valid_from,omitempty"`
	ValidTo   string `json:"valid_to,omitempty"`
	Products  any    `json:"products,omitempty"`
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, apiError{Error: msg})
}
