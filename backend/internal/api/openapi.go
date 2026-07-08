package api

import "net/http"

// Minimal OpenAPI 3 document; paths mirror Handler(). A coverage test
// keeps this list in sync with the mux (spec 03).
var openAPIPaths = []string{
	"/api/healthz",
	"/api/status",
	"/api/models",
	"/api/models/{model}/runs",
	"/api/models/{model}/runs/{run}",
	"/api/models/{model}/meta/{var}",
	"/api/models/{model}/point/{time}/{var}",
	"/api/models/{model}/data/{time}/{var}",
	"/api/models/{model}/window/{time}/{var}",
	"/api/models/{model}/grid/{time}/{var}",
	"/api/composite/{id}",
	"/api/colormaps",
	"/api/openapi.json",
}

func (s *Server) handleOpenAPI(w http.ResponseWriter, r *http.Request) {
	paths := map[string]any{}
	for _, p := range openAPIPaths {
		paths[p] = map[string]any{"get": map[string]any{"responses": map[string]any{"200": map[string]any{"description": "OK"}}}}
	}
	writeJSON(w, 200, map[string]any{
		"openapi": "3.0.3",
		"info": map[string]any{
			"title":   "grib-viewer",
			"version": "1",
			"description": "Standalone NWP GRIB viewer API. Windows are bbox-addressed " +
				"(no tiling); fields derive online from buffered GRIB.",
		},
		"paths": paths,
	})
}
