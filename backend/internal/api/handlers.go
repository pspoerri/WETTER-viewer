package api

import (
	"errors"
	"fmt"
	"math"
	"net/http"
	"runtime/debug"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/pspoerri/grib-viewer/internal/config"
	"github.com/pspoerri/grib-viewer/internal/engine"
	"github.com/pspoerri/grib-viewer/internal/render"
	"github.com/pspoerri/grib-viewer/internal/vars"
)

func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.Write([]byte("ok\n"))
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	if s.Status == nil {
		writeJSON(w, 200, map[string]any{})
		return
	}
	writeJSON(w, 200, s.Status())
}

// ---- catalog ----

type productsDTO struct {
	Median      bool  `json:"median"`
	Mean        bool  `json:"mean"`
	Control     bool  `json:"control"`
	Min         bool  `json:"min"`
	Max         bool  `json:"max"`
	Spread      bool  `json:"spread"`
	Percentiles []int `json:"percentiles,omitempty"`
	Members     int   `json:"members,omitempty"`
}

type aggDTO struct {
	Default string   `json:"default"`
	Valid   []string `json:"valid"`
}

type varDTO struct {
	Name     string      `json:"name"`
	Units    string      `json:"units,omitempty"`
	LongName string      `json:"long_name,omitempty"`
	Colormap string      `json:"colormap"`
	VMin     float64     `json:"vmin"`
	VMax     float64     `json:"vmax"`
	EPS      bool        `json:"eps"`
	Products productsDTO `json:"products"`
	Agg      aggDTO      `json:"aggregations"`
	Temporal string      `json:"temporal"`
	Steps    int         `json:"steps"`
}

type modelDTO struct {
	ID        string `json:"id"`
	LatestRun string `json:"latest_run,omitempty"`
	Synthetic bool   `json:"synthetic_time,omitempty"`

	// Attribution metadata from the source's `info:` config block
	// (composites synthesize theirs, with contributor source ids).
	Name         string   `json:"name,omitempty"`
	Description  string   `json:"description,omitempty"`
	Provider     string   `json:"provider,omitempty"`
	ProviderURL  string   `json:"provider_url,omitempty"`
	License      string   `json:"license,omitempty"`
	LicenseURL   string   `json:"license_url,omitempty"`
	Contributors []string `json:"contributors,omitempty"`

	Variables []varDTO `json:"variables"`
}

// applyInfo copies a source's attribution block onto the DTO.
func (md *modelDTO) applyInfo(info config.SourceInfo) {
	md.Name = info.Name
	md.Description = info.Description
	md.Provider = info.Provider
	md.ProviderURL = info.ProviderURL
	md.License = info.License
	md.LicenseURL = info.LicenseURL
}

func aggFor(k vars.ReducerKind) aggDTO {
	switch k {
	case vars.ReduceMinMax:
		return aggDTO{Default: "max", Valid: []string{"min", "max", "mean"}}
	case vars.ReduceMax:
		return aggDTO{Default: "max", Valid: []string{"max", "mean"}}
	case vars.ReduceMin:
		return aggDTO{Default: "min", Valid: []string{"min", "mean"}}
	case vars.ReduceSum:
		return aggDTO{Default: "sum", Valid: []string{"sum"}}
	case vars.ReducePeriod:
		return aggDTO{Default: "max", Valid: []string{"max"}}
	default:
		return aggDTO{Default: "mean", Valid: []string{"mean"}}
	}
}

func temporalName(t vars.Temporal) string {
	switch t {
	case vars.TemporalAccum:
		return "accum"
	case vars.TemporalTavg:
		return "tavg"
	case vars.TemporalStatic:
		return "static"
	default:
		return "instant"
	}
}

func (s *Server) varDTOFor(source, run, name string, members, steps int) varDTO {
	f, ok := vars.Lookup(engine.NormBase(name))
	if !ok {
		f = vars.Generic(name)
	}
	eps := members > 0
	dto := varDTO{
		Name: name, Units: f.Units, LongName: f.LongName,
		Colormap: f.Colormap, VMin: f.VMin, VMax: f.VMax,
		EPS: eps, Temporal: temporalName(f.Temporal),
		Agg: aggFor(f.Reducer), Steps: steps,
	}
	dto.Products = productsDTO{Median: true}
	if eps {
		dto.Products = productsDTO{
			Median: true, Mean: true, Control: true, Min: true, Max: true,
			Spread: true, Percentiles: []int{10, 25, 50, 75, 90}, Members: members,
		}
	}
	return dto
}

var hiddenVars = map[string]bool{"hsurf": true, "clat": true, "clon": true, "tlat": true, "tlon": true}

func (s *Server) modelDTO(id string) (*modelDTO, error) {
	info, err := s.Engine.Info(id, "latest")
	if err != nil {
		return nil, err
	}
	md := &modelDTO{ID: id, LatestRun: info.RunID, Synthetic: info.Synthetic}
	for i := range s.Cfg.Sources {
		if s.Cfg.Sources[i].ID == id {
			md.applyInfo(s.Cfg.Sources[i].Info)
			break
		}
	}
	names := make([]string, 0, len(info.Vars))
	for n := range info.Vars {
		if !hiddenVars[n] {
			names = append(names, n)
		}
	}
	names = append(names, s.Engine.DerivedVars(id, info.RunID)...)
	// advertise display aliases whose base is servable (the frontend
	// looks up layer metadata by the alias name, e.g. wind_gust_10m)
	for alias, base := range engine.Aliases() {
		if s.Engine.Resolvable(id, info.RunID, base) {
			names = append(names, alias)
		}
	}
	sort.Strings(names)
	seen := map[string]bool{}
	for _, n := range names {
		if seen[n] {
			continue
		}
		seen[n] = true
		members := s.Engine.MembersFor(id, info.RunID, n)
		steps := 0
		if st, err := s.Engine.StepsFor(id, info.RunID, n); err == nil {
			steps = len(st)
		}
		md.Variables = append(md.Variables, s.varDTOFor(id, info.RunID, n, members, steps))
	}
	return md, nil
}

// version is stamped at build time by the Makefile/Dockerfile via
// -ldflags "-X ...internal/api.version=$(git describe --tags --always --dirty)"
// → e.g. v0.1.0-3-gd647711.
var version string

// appVersion prefers the stamped git-describe version, then falls
// back to Go build info: the short VCS revision (with a -dirty
// marker), the module version for tagged module builds, or "dev"
// when nothing is stamped (`go run`).
func appVersion() string {
	if version != "" {
		return version
	}
	bi, ok := debug.ReadBuildInfo()
	if !ok {
		return "dev"
	}
	var rev, modified string
	for _, s := range bi.Settings {
		switch s.Key {
		case "vcs.revision":
			rev = s.Value
		case "vcs.modified":
			modified = s.Value
		}
	}
	if len(rev) >= 7 {
		v := rev[:7]
		if modified == "true" {
			v += "-dirty"
		}
		return v
	}
	if bi.Main.Version != "" && bi.Main.Version != "(devel)" {
		return bi.Main.Version
	}
	return "dev"
}

func (s *Server) handleVersion(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]string{"version": appVersion()})
}

// handleMapConfig serves the config's map-data URLs (pmtiles basemap
// archive, terrain tile server); the UI applies them before the map
// mounts, keeping built-in defaults for absent fields.
func (s *Server) handleMapConfig(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, s.Cfg.Map)
}

// handlePresets serves the config's server-defined layer presets
// verbatim; the UI merges them into its preset picker.
func (s *Server) handlePresets(w http.ResponseWriter, r *http.Request) {
	presets := s.Cfg.Presets
	if presets == nil {
		presets = []config.Preset{}
	}
	writeJSON(w, 200, struct {
		Presets []config.Preset `json:"presets"`
	}{Presets: presets})
}

func (s *Server) handleModels(w http.ResponseWriter, r *http.Request) {
	out := struct {
		Models []modelDTO `json:"models"`
	}{Models: []modelDTO{}}
	for _, src := range s.Cfg.Sources {
		md, err := s.modelDTO(src.ID)
		if err != nil {
			continue // not yet buffered
		}
		out.Models = append(out.Models, *md)
	}
	for _, id := range []string{"auto", "auto_eps"} {
		if md := s.compositeModelDTO(id); md != nil {
			out.Models = append(out.Models, *md)
		}
	}
	writeJSON(w, 200, out)
}

// ---- runs ----

type runDTO struct {
	Run       string         `json:"run"`
	Ref       string         `json:"ref"`
	ValidFrom string         `json:"valid_from,omitempty"`
	ValidTo   string         `json:"valid_to,omitempty"`
	Complete  bool           `json:"complete"`
	Synthetic bool           `json:"synthetic_time,omitempty"`
	Steps     map[string]int `json:"steps,omitempty"`
}

func (s *Server) runDTO(source, runID string, withSteps bool) (*runDTO, error) {
	info, err := s.Engine.Info(source, runID)
	if err != nil {
		return nil, err
	}
	dto := &runDTO{
		Run: info.RunID, Ref: info.Run.Format(time.RFC3339),
		Complete: info.Complete, Synthetic: info.Synthetic,
	}
	var lo, hi time.Time
	for _, vi := range info.Vars {
		if len(vi.Steps) == 0 {
			continue
		}
		if lo.IsZero() || vi.Steps[0].Before(lo) {
			lo = vi.Steps[0]
		}
		if last := vi.Steps[len(vi.Steps)-1]; last.After(hi) {
			hi = last
		}
	}
	if !lo.IsZero() {
		dto.ValidFrom = lo.Format(time.RFC3339)
		dto.ValidTo = hi.Format(time.RFC3339)
	}
	if withSteps {
		dto.Steps = map[string]int{}
		for n, vi := range info.Vars {
			if !hiddenVars[n] {
				dto.Steps[n] = len(vi.Steps)
			}
		}
	}
	return dto, nil
}

func (s *Server) handleRuns(w http.ResponseWriter, r *http.Request) {
	model := r.PathValue("model")
	if isComposite(model) {
		dto, err := s.compositeRunDTO(model)
		if err != nil {
			writeErr(w, 404, err.Error())
			return
		}
		writeJSON(w, 200, struct {
			Runs []runDTO `json:"runs"`
		}{Runs: []runDTO{*dto}})
		return
	}
	runs, err := s.Engine.Runs(model)
	if err != nil || len(runs) == 0 {
		writeErr(w, 404, "no runs for "+model)
		return
	}
	out := struct {
		Runs []runDTO `json:"runs"`
	}{}
	for _, id := range runs {
		if dto, err := s.runDTO(model, id, true); err == nil {
			out.Runs = append(out.Runs, *dto)
		}
	}
	writeJSON(w, 200, out)
}

func (s *Server) handleRun(w http.ResponseWriter, r *http.Request) {
	model := r.PathValue("model")
	if isComposite(model) {
		dto, err := s.compositeRunDTO(model)
		if err != nil {
			writeErr(w, 404, err.Error())
			return
		}
		writeJSON(w, 200, dto)
		return
	}
	dto, err := s.runDTO(model, r.PathValue("run"), true)
	if err != nil {
		writeErr(w, 404, err.Error())
		return
	}
	writeJSON(w, 200, dto)
}

// ---- meta ----

func (s *Server) handleMeta(w http.ResponseWriter, r *http.Request) {
	model, name := r.PathValue("model"), r.PathValue("var")
	runID := r.URL.Query().Get("run")
	if isComposite(model) {
		resolved, err := s.resolveModel(model, engine.NormBase(stripToBase(name)))
		if err != nil {
			writeErr(w, 404, err.Error())
			return
		}
		model, runID = resolved, ""
	}
	info, err := s.Engine.Info(model, runID)
	if err != nil {
		writeErr(w, 404, err.Error())
		return
	}
	name = engine.NormBase(stripToBase(name))
	if !s.Engine.Resolvable(model, info.RunID, name) {
		writeErr(w, 404, "unknown variable "+name)
		return
	}
	steps, _ := s.Engine.StepsFor(model, info.RunID, name)
	deg, _ := s.Engine.NativeDeg(model, info.RunID, name)
	members := s.Engine.MembersFor(model, info.RunID, name)
	f, ok := vars.Lookup(name)
	if !ok {
		f = vars.Generic(name)
	}
	stepStrs := make([]string, len(steps))
	for i, t := range steps {
		stepStrs[i] = t.Format(time.RFC3339)
	}
	writeJSON(w, 200, map[string]any{
		"model": model, "run": info.RunID, "variable": name,
		"units": f.Units, "colormap": f.Colormap, "vmin": f.VMin, "vmax": f.VMax,
		"scale": f.Scale, "offset": f.Offset,
		"native_deg": deg, "members": members,
		"timesteps": stepStrs, "synthetic_time": info.Synthetic,
	})
}

// ---- data plane helpers ----

type dataReq struct {
	model, runID string
	vr           *varRequest
	frames       []frameSet
	info         *engine.RunView
}

func (s *Server) parseDataReq(w http.ResponseWriter, r *http.Request, singleFrame bool) *dataReq {
	model := r.PathValue("model")
	runID := r.URL.Query().Get("run")

	var vr *varRequest
	var err error
	if isComposite(model) {
		// composite ids resolve to the finest contributor carrying
		// the variable; pinned runs don't compose with composites
		vr, err = parseVarID(r.PathValue("var"), s.compositeResolvable(model))
		if err != nil {
			writeErr(w, 404, err.Error())
			return nil
		}
		model, err = s.resolveModel(model, vr.Plane.Base)
		if err != nil {
			writeErr(w, 404, err.Error())
			return nil
		}
		runID = ""
	}

	info, err := s.Engine.Info(model, runID)
	if err != nil {
		writeErr(w, 404, err.Error())
		return nil
	}
	if vr == nil {
		vr, err = parseVarID(r.PathValue("var"), func(base string) bool {
			return s.Engine.Resolvable(model, info.RunID, base)
		})
		if err != nil {
			writeErr(w, 404, err.Error())
			return nil
		}
	}
	ts, err := parseTimeSpec(r.PathValue("time"))
	if err != nil {
		writeErr(w, 400, err.Error())
		return nil
	}
	steps, err := s.Engine.StepsFor(model, info.RunID, vr.Plane.Base)
	if err != nil {
		writeErr(w, 404, err.Error())
		return nil
	}
	frames, err := resolveTimes(steps, info.Run, info.Synthetic, ts, vr.WinHours)
	if err != nil {
		var te *timeAxisErr
		if errors.As(err, &te) && !te.from.IsZero() {
			writeJSON(w, 404, apiError{Error: te.msg, ValidFrom: te.from.Format(time.RFC3339), ValidTo: te.to.Format(time.RFC3339)})
		} else {
			writeErr(w, 400, err.Error())
		}
		return nil
	}
	if ts.Span > 0 && vr.WinHours == 0 && singleFrame {
		writeErr(w, 400, "span needs a window op on this endpoint")
		return nil
	}
	if singleFrame && len(frames) > 1 {
		writeErr(w, 400, "multi-frame span not allowed on this endpoint")
		return nil
	}
	if len(frames) > 48 {
		frames = frames[:48] // chunk cap (spec 03)
	}
	// cache headers for immutable addressing
	if runID != "" && !ts.Latest && !ts.Now {
		etag := fmt.Sprintf("%q", info.RunID+"|"+r.URL.RequestURI())
		if r.Header.Get("If-None-Match") == etag {
			w.WriteHeader(http.StatusNotModified)
			return nil
		}
		w.Header().Set("ETag", etag)
		w.Header().Set("Cache-Control", "public, max-age=3600, immutable")
	}
	w.Header().Set("X-Model-Run", info.RunID)
	return &dataReq{model: model, runID: info.RunID, vr: vr, frames: frames, info: info}
}

func bboxParam(r *http.Request) ([4]float64, error) {
	parts := strings.Split(r.URL.Query().Get("bbox"), ",")
	if len(parts) != 4 {
		return [4]float64{}, fmt.Errorf("bbox=south,west,north,east required")
	}
	var b [4]float64
	for i, p := range parts {
		v, err := strconv.ParseFloat(strings.TrimSpace(p), 64)
		if err != nil {
			return b, fmt.Errorf("bad bbox component %q", p)
		}
		b[i] = v
	}
	// clamp viewport padding overshoot; grids speak ±180/±90
	b[0] = math.Max(b[0], -90)
	b[2] = math.Min(b[2], 90)
	b[1] = math.Max(b[1], -180)
	b[3] = math.Min(b[3], 180)
	return b, nil
}

func (s *Server) windowFor(dr *dataReq, bbox [4]float64, maxCells int, withHeight bool) (*engine.Window, error) {
	var out *engine.Window
	for _, fs := range dr.frames {
		req := engine.WindowReq{
			Source: dr.model, Run: dr.runID, Plane: dr.vr.Plane,
			Times: fs.Times, BBox: bbox, MaxCells: maxCells,
			WithHeight: withHeight,
		}
		if dr.vr.WinHours > 0 {
			req.Agg = dr.vr.WinOp
		}
		w, err := s.Engine.Window(req)
		if err != nil {
			if out != nil && len(dr.frames) > 1 {
				continue // holes in chunks are skipped
			}
			return nil, err
		}
		labels := w.FrameTimes
		if dr.vr.WinHours > 0 {
			labels = []time.Time{fs.Label} // windowed blocks labelled by block start
		}
		if out == nil {
			out = w
			out.FrameTimes = labels
		} else {
			out.Frames = append(out.Frames, w.Frames...)
			out.FrameTimes = append(out.FrameTimes, labels...)
		}
	}
	if out == nil {
		return nil, engine.ErrNotFound
	}
	return out, nil
}

func errCode(err error) int {
	switch {
	case errors.Is(err, engine.ErrNotFound), errors.Is(err, engine.ErrNoProduct):
		return 404
	default:
		return 400
	}
}

// ---- /data (protobuf) ----

func (s *Server) handleData(w http.ResponseWriter, r *http.Request) {
	dr := s.parseDataReq(w, r, false)
	if dr == nil {
		return
	}
	bbox, err := bboxParam(r)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	maxCells, _ := strconv.Atoi(r.URL.Query().Get("maxcells"))
	withHeight := dr.vr.Plane.Base == "t_2m" || dr.vr.Plane.Base == "td_2m"
	win, err := s.windowFor(dr, bbox, maxCells, withHeight)
	if err != nil {
		writeErr(w, errCode(err), err.Error())
		return
	}
	q := quantFor(dr.vr, win)
	w.Header().Set("Content-Type", "application/x-protobuf")
	w.Write(encodeWindow(dr.model, r.PathValue("var"), win, q))
}

func quantFor(vr *varRequest, win *engine.Window) quant {
	if vr.Plane.Exceed != nil {
		return quant{Scale: 1e-4, Offset: 0}
	}
	if vr.Field.Scale > 0 {
		return quant{Scale: vr.Field.Scale, Offset: vr.Field.Offset}
	}
	return autoQuant(win.Frames)
}

// ---- /window (JSON debug) ----

func (s *Server) handleWindowJSON(w http.ResponseWriter, r *http.Request) {
	dr := s.parseDataReq(w, r, true)
	if dr == nil {
		return
	}
	bbox, err := bboxParam(r)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	maxCells, _ := strconv.Atoi(r.URL.Query().Get("maxcells"))
	win, err := s.windowFor(dr, bbox, maxCells, false)
	if err != nil {
		writeErr(w, errCode(err), err.Error())
		return
	}
	vals := make([]*float64, len(win.Frames[0]))
	conv := unitConv(dr.vr)
	for i, v := range win.Frames[0] {
		if v == v {
			f := conv(float64(v))
			vals[i] = &f
		}
	}
	writeJSON(w, 200, map[string]any{
		"model": dr.model, "run": dr.runID, "variable": r.PathValue("var"),
		"grid": map[string]any{
			"nx": win.Grid.Nx, "ny": win.Grid.Ny,
			"lat0": win.Grid.Lat0, "lon0": win.Grid.Lon0,
			"dlat": win.Grid.DLat, "dlon": win.Grid.DLon,
		},
		"time":   win.FrameTimes[0].Format(time.RFC3339),
		"values": vals, "synthetic_time": win.Synthetic,
	})
}

func unitConv(vr *varRequest) func(float64) float64 {
	if vr.UnitCode == "" || vr.Plane.Exceed != nil {
		return func(v float64) float64 { return v }
	}
	conv, _, err := vars.ResolveUnit(vr.Field.Units, vr.UnitCode)
	if err != nil {
		return func(v float64) float64 { return v }
	}
	return conv
}

// ---- /point ----

func (s *Server) handlePoint(w http.ResponseWriter, r *http.Request) {
	dr := s.parseDataReq(w, r, false)
	if dr == nil {
		return
	}
	q := r.URL.Query()
	lat, err1 := strconv.ParseFloat(q.Get("lat"), 64)
	lon, err2 := strconv.ParseFloat(q.Get("lon"), 64)
	if err1 != nil || err2 != nil {
		writeErr(w, 400, "lat and lon required")
		return
	}
	conv := unitConv(dr.vr)
	var times []string
	var values []*float64
	var height *float64
	for _, fs := range dr.frames {
		req := engine.PointReq{
			Source: dr.model, Run: dr.runID, Plane: dr.vr.Plane,
			Times: fs.Times, Lat: lat, Lon: lon,
		}
		if dr.vr.WinHours > 0 {
			req.Agg = dr.vr.WinOp
		}
		res, err := s.Engine.Point(req)
		if err != nil {
			writeErr(w, errCode(err), err.Error())
			return
		}
		label := fs.Label
		if dr.vr.WinHours == 0 && len(res.Times) == 1 {
			label = res.Times[0]
		}
		times = append(times, label.Format(time.RFC3339))
		for _, v := range res.Values {
			if v != nil && dr.vr.Plane.Exceed == nil {
				c := conv(*v)
				v = &c
			}
			values = append(values, v)
		}
		if res.Height != nil {
			height = res.Height
		}
	}
	out := map[string]any{
		"model": dr.model, "run": dr.runID, "variable": r.PathValue("var"),
		"lat": lat, "lon": lon, "synthetic_time": dr.info.Synthetic,
	}
	if height != nil {
		out["height"] = *height
	}
	if len(values) == 1 {
		out["value"] = values[0]
		out["time"] = times[0]
	} else {
		out["timesteps"] = times
		out["values"] = values
	}
	writeJSON(w, 200, out)
}

// ---- /grid (GeoJSON) ----

func (s *Server) handleGrid(w http.ResponseWriter, r *http.Request) {
	dr := s.parseDataReq(w, r, true)
	if dr == nil {
		return
	}
	bbox, err := bboxParam(r)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	spacing, _ := strconv.ParseFloat(r.URL.Query().Get("spacing"), 64)
	if spacing <= 0 {
		spacing = 1.0
	}
	nx := int((bbox[3] - bbox[1]) / spacing)
	ny := int((bbox[2] - bbox[0]) / spacing)
	if nx < 1 || ny < 1 {
		writeErr(w, 400, "bbox smaller than spacing")
		return
	}
	if nx*ny > 20000 {
		writeErr(w, 400, "too many grid points")
		return
	}
	win, err := s.windowFor(dr, bbox, nx*ny, false)
	if err != nil {
		writeErr(w, errCode(err), err.Error())
		return
	}
	conv := unitConv(dr.vr)
	g := win.Grid
	features := []any{}
	for row := 0; row < g.Ny; row++ {
		for col := 0; col < g.Nx; col++ {
			v := win.Frames[0][row*g.Nx+col]
			if v != v {
				continue
			}
			features = append(features, map[string]any{
				"type": "Feature",
				"geometry": map[string]any{
					"type":        "Point",
					"coordinates": []float64{g.Lon0 + float64(col)*g.DLon, g.Lat0 + float64(row)*g.DLat},
				},
				"properties": map[string]any{"value": conv(float64(v))},
			})
		}
	}
	writeJSON(w, 200, map[string]any{"type": "FeatureCollection", "features": features})
}

// ---- composite ladder ----

func (s *Server) handleComposite(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id != "auto" && id != "auto_eps" {
		writeErr(w, 404, "unknown composite "+id)
		return
	}
	type contrib struct {
		Model     string             `json:"model"`
		NativeDeg float64            `json:"native_deg"`
		BBox      map[string]float64 `json:"bbox"`
		IsBase    bool               `json:"is_base"`
		Run       string             `json:"run"`
		HorizonTo string             `json:"horizon_to,omitempty"`
	}
	var out []contrib
	for _, src := range s.Cfg.Sources {
		info, err := s.Engine.Info(src.ID, "latest")
		if err != nil || info.Synthetic {
			continue
		}
		if id == "auto_eps" && s.Engine.MembersFor(src.ID, info.RunID, headlineVar(info)) == 0 {
			continue
		}
		name := headlineVar(info)
		if name == "" {
			continue
		}
		deg, err := s.Engine.NativeDeg(src.ID, info.RunID, name)
		if err != nil {
			continue
		}
		south, west, north, east, err := s.Engine.GridExtent(src.ID, info.RunID, name)
		if err != nil {
			continue
		}
		c := contrib{
			Model: src.ID, NativeDeg: deg,
			BBox:   map[string]float64{"south": south, "west": west, "north": north, "east": east},
			IsBase: east-west >= 350,
			Run:    info.RunID,
		}
		if steps, err := s.Engine.StepsFor(src.ID, info.RunID, name); err == nil && len(steps) > 0 {
			c.HorizonTo = steps[len(steps)-1].Format(time.RFC3339)
		}
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].NativeDeg < out[j].NativeDeg })
	h := ""
	for _, c := range out {
		h += c.Model + "@" + c.Run + ";"
	}
	writeJSON(w, 200, map[string]any{
		"id": id, "run": fmt.Sprintf("%s-%08x", id, fnv32(h)), "contributors": out,
	})
}

func headlineVar(info *engine.RunView) string {
	if _, ok := info.Vars["t_2m"]; ok {
		return "t_2m"
	}
	for n := range info.Vars {
		if !hiddenVars[n] {
			return n
		}
	}
	return ""
}

func fnv32(s string) uint32 {
	h := uint32(2166136261)
	for i := 0; i < len(s); i++ {
		h = (h ^ uint32(s[i])) * 16777619
	}
	return h
}

// ---- colormaps ----

func (s *Server) handleColormaps(w http.ResponseWriter, r *http.Request) {
	type stopDTO struct {
		Position float64 `json:"position"`
		R        uint8   `json:"r"`
		G        uint8   `json:"g"`
		B        uint8   `json:"b"`
		A        uint8   `json:"a"`
	}
	type cmDTO struct {
		Name   string    `json:"name"`
		Stops  []stopDTO `json:"stops"`
		Hidden bool      `json:"hidden,omitempty"`
	}
	var out []cmDTO
	for _, cm := range render.AllIncludingHidden() {
		d := cmDTO{Name: cm.Name, Hidden: cm.Hidden}
		for _, st := range cm.Stops {
			d.Stops = append(d.Stops, stopDTO{
				Position: st.Position,
				R:        st.Color.R, G: st.Color.G, B: st.Color.B, A: st.Color.A,
			})
		}
		out = append(out, d)
	}
	writeJSON(w, 200, map[string]any{"colormaps": out})
}
