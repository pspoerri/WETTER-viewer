package engine

import (
	"os"
	"path/filepath"
	"strings"

	"fmt"
	"github.com/pspoerri/grib-viewer/internal/gribidx"
	"math"
	"sync"
	"time"
)

const DefaultMaxCells = 700_000

// Window derives a bbox window (the serve primitive, spec 02).
func (e *Engine) Window(req WindowReq) (*Window, error) {
	req.Plane.Base = NormBase(req.Plane.Base)
	rv, err := e.View(req.Source, req.Run)
	if err != nil {
		return nil, err
	}
	if len(req.Times) == 0 {
		return nil, fmt.Errorf("engine: no times requested")
	}
	reg, err := e.regionFor(rv, req)
	if err != nil {
		return nil, err
	}

	w := &Window{Grid: reg.gridDef(), Synthetic: rv.Synthetic, Run: rv.Run}

	if req.Agg != "" && len(req.Times) > 1 {
		frames := make([][]float32, 0, len(req.Times))
		for _, t := range req.Times {
			p, err := e.plane(rv, req.Plane, t, reg)
			if err != nil {
				return nil, err
			}
			frames = append(frames, p)
		}
		folded, err := foldFrames(frames, req.Agg)
		if err != nil {
			return nil, err
		}
		w.Frames = [][]float32{folded}
		w.FrameTimes = []time.Time{req.Times[len(req.Times)-1]}
	} else {
		for _, t := range req.Times {
			p, err := e.plane(rv, req.Plane, t, reg)
			if err != nil {
				if len(w.Frames) > 0 && len(req.Times) > 1 {
					continue // holes in a chunk are skipped, not fatal
				}
				return nil, err
			}
			w.Frames = append(w.Frames, p)
			w.FrameTimes = append(w.FrameTimes, t)
		}
		if len(w.Frames) == 0 {
			return nil, ErrNotFound
		}
	}

	if req.WithHeight {
		if hs := e.heightPlane(rv, reg); hs != nil {
			w.Height = hs
		}
	}
	return w, nil
}

// foldFrames applies a temporal window op across frames, NaN-aware.
func foldFrames(frames [][]float32, op string) ([]float32, error) {
	switch op {
	case "max", "min", "mean", "sum":
	default:
		return nil, fmt.Errorf("engine: bad window op %q", op)
	}
	n := len(frames[0])
	out := make([]float32, n)
	cnt := make([]int32, n)
	for i := range out {
		out[i] = float32(math.NaN())
	}
	for _, f := range frames {
		for i, v := range f {
			if v != v {
				continue
			}
			if cnt[i] == 0 {
				out[i] = v
			} else {
				switch op {
				case "max":
					if v > out[i] {
						out[i] = v
					}
				case "min":
					if v < out[i] {
						out[i] = v
					}
				case "mean", "sum":
					out[i] += v
				}
			}
			cnt[i]++
		}
	}
	if op == "mean" {
		for i := range out {
			if cnt[i] > 0 {
				out[i] /= float32(cnt[i])
			}
		}
	}
	return out, nil
}

// heightPlane renders the model surface height on the same grid: from
// the run's hsurf when present, else from a static vertical_constants
// HHL file (MeteoSwiss ships surface height as the deepest half level).
func (e *Engine) heightPlane(rv *runView, reg region) []float32 {
	if byTime, ok := rv.planes["hsurf"]; ok {
		for ts, pm := range byTime {
			var loc msgLoc
			if l, ok := pm.byMember[-1]; ok {
				loc = l
			} else if l, ok := pm.byMember[0]; ok {
				loc = l
			} else {
				// EPS time-invariant fields carry a perturbation number
				// (DWD stamps member 1); terrain is member-invariant, so
				// any member's hsurf works
				for _, l := range pm.byMember {
					loc = l
					break
				}
			}
			if loc.Path == "" {
				continue
			}
			p, err := e.renderMemberCached(rv, "hsurf", loc, -1, time.Unix(ts, 0).UTC(), reg)
			if err != nil {
				return nil
			}
			return p
		}
	}
	loc, ok := e.staticHeight(rv.Source)
	if !ok {
		return nil
	}
	key := rv.Source + "|static-hsurf|" + reg.key()
	if p, ok := e.planes.get(key); ok {
		return p
	}
	p, err := e.renderMsg(rv, "hsurf(static)", loc, time.Time{}, reg)
	if err != nil {
		return nil
	}
	e.planes.put(key, p)
	return p
}

var staticHeightCache sync.Map // source -> msgLoc (zero Path = none)

// staticHeight finds the surface-height message in the source's static
// files: an hsurf message, or the deepest HHL half level.
func (e *Engine) staticHeight(source string) (msgLoc, bool) {
	if v, ok := staticHeightCache.Load(source); ok {
		loc := v.(msgLoc)
		return loc, loc.Path != ""
	}
	best := msgLoc{}
	bestLevel := -1
	dir := e.buf.StaticDir(source)
	entries, _ := os.ReadDir(dir)
	for _, ent := range entries {
		name := strings.ToLower(ent.Name())
		if !strings.HasSuffix(name, ".grib2") && !strings.HasSuffix(name, ".grb2") {
			continue
		}
		fe, err := gribidx.ScanFile(filepath.Join(dir, ent.Name()), "")
		if err != nil {
			continue
		}
		for _, m := range fe.Msgs {
			switch m.Var {
			case "hsurf":
				staticHeightCache.Store(source, msgLoc{Path: fe.Path, Msg: m.Msg})
				return msgLoc{Path: fe.Path, Msg: m.Msg}, true
			case "hhl":
				if m.Level > bestLevel {
					bestLevel = m.Level
					best = msgLoc{Path: fe.Path, Msg: m.Msg}
				}
			}
		}
	}
	staticHeightCache.Store(source, best)
	return best, best.Path != ""
}

// oversample: output cells per native cell (per axis). Rendering finer
// than native keeps nearest-neighbour cell boundaries crisp, and the
// snapped lattice below keeps them STABLE — without snapping, cell
// centers follow the viewport bbox and the field visibly swims when
// zooming (worst on coarse global models).
const oversample = 2

// regionFor sizes the output grid on a fixed global lattice: cell
// sizes are nativeDeg/oversample × 2^k (smallest k fitting the cell
// budget) and cell edges are anchored at (-180, 90), so every request
// samples the same cell centers regardless of the viewport.
func (e *Engine) regionFor(rv *runView, req WindowReq) (region, error) {
	s, w, n, ee := req.BBox[0], req.BBox[1], req.BBox[2], req.BBox[3]
	if !(n > s) || !(ee > w) {
		return region{}, fmt.Errorf("engine: bad bbox")
	}
	maxCells := req.MaxCells
	if maxCells <= 0 {
		maxCells = DefaultMaxCells
	}
	deg, err := e.nativeDeg(rv, req.Plane.Base, req.Times[0])
	if err != nil {
		return region{}, err
	}
	cell := deg / oversample
	for (ee-w)/cell*((n-s)/cell) > float64(maxCells) {
		cell *= 2
	}
	// snap outward to the lattice anchored at (-180, 90)
	w2 := -180 + math.Floor((w+180)/cell)*cell
	e2 := -180 + math.Ceil((ee+180)/cell)*cell
	n2 := 90 - math.Floor((90-n)/cell)*cell
	s2 := 90 - math.Ceil((90-s)/cell)*cell
	nx := max(2, int(math.Round((e2-w2)/cell)))
	ny := max(2, int(math.Round((n2-s2)/cell)))
	return region{S: s2, W: w2, N: n2, E: e2, Nx: nx, Ny: ny}, nil
}

var nativeDegCache sync.Map // "source|run|var" -> float64

// nativeDeg estimates the native grid spacing of a variable in degrees.
func (e *Engine) nativeDeg(rv *runView, base string, at time.Time) (float64, error) {
	name := e.sampleVarFor(rv, base)
	key := rv.Source + "|" + rv.RunID + "|" + name
	if v, ok := nativeDegCache.Load(key); ok {
		return v.(float64), nil
	}
	byTime, ok := rv.planes[name]
	if !ok {
		return 0, fmt.Errorf("%w: %s", ErrNotFound, base)
	}
	var loc msgLoc
	found := false
	for _, pm := range byTime {
		for _, l := range pm.byMember {
			loc, found = l, true
			break
		}
		if found {
			break
		}
	}
	if !found {
		return 0, fmt.Errorf("%w: %s", ErrNotFound, base)
	}
	fe, err := e.acquireFile(rv.Source, loc.Path)
	if err != nil {
		return 0, err
	}
	defer e.release(fe)
	m := fe.f.Messages()[loc.Msg]
	deg := 0.25
	if ll, ok := m.RegularLatLon(); ok {
		deg = math.Min(math.Abs(ll.DLat), math.Abs(ll.DLon))
	} else {
		if g, err := m.Grid(); err == nil {
			if u, ok := g.(interface{ Coordinates() ([]float64, []float64) }); ok {
				if lats, lons := u.Coordinates(); lats != nil {
					if sp := medianConsecutiveMeters(lats, lons); sp > 0 {
						deg = sp / 111_195.0
					}
				}
			}
		}
	}
	nativeDegCache.Store(key, deg)
	return deg, nil
}

// sampleVarFor maps derived ids to a raw input for grid sizing.
func (e *Engine) sampleVarFor(rv *runView, base string) string {
	if _, ok := rv.planes[base]; ok {
		return base
	}
	switch {
	case precipRe.MatchString(base):
		return "tot_prec"
	case base == "ghi":
		return "aswdifd_s"
	case base == "relhum_2m":
		return "t_2m"
	case windRe.MatchString(base):
		return "u_" + windRe.FindStringSubmatch(base)[1]
	case base == "wind_dir_10m":
		return "u_10m"
	}
	return base
}

// GridExtent reports a variable's native footprint (composite ladder).
func (e *Engine) GridExtent(source, runID, name string) (south, west, north, east float64, err error) {
	rv, err := e.View(source, runID)
	if err != nil {
		return 0, 0, 0, 0, err
	}
	byTime, ok := rv.planes[name]
	if !ok {
		return 0, 0, 0, 0, ErrNotFound
	}
	var loc msgLoc
	found := false
	for _, pm := range byTime {
		for _, l := range pm.byMember {
			loc, found = l, true
			break
		}
		break
	}
	if !found {
		return 0, 0, 0, 0, ErrNotFound
	}
	fe, err := e.acquireFile(source, loc.Path)
	if err != nil {
		return 0, 0, 0, 0, err
	}
	defer e.release(fe)
	m := fe.f.Messages()[loc.Msg]
	if ll, ok := m.RegularLatLon(); ok {
		north, west = ll.Lat0, ll.Lon0
		south = ll.Lat0 + float64(ll.Ny-1)*ll.DLat
		east = ll.Lon0 + float64(ll.Nx-1)*ll.DLon
		// grids often carry 0..360 longitudes; clients speak ±180
		if west >= 180 {
			west -= 360
			east -= 360
		}
		return south, west, north, east, nil
	}
	if g, gerr := m.Grid(); gerr == nil {
		if u, ok := g.(interface{ Coordinates() ([]float64, []float64) }); ok {
			if lats, lons := u.Coordinates(); lats != nil {
				south, north = minMax(lats)
				west, east = minMax(lons)
				return south, west, north, east, nil
			}
		}
	}
	return -90, -180, 90, 180, nil
}

func minMax(v []float64) (lo, hi float64) {
	lo, hi = math.Inf(1), math.Inf(-1)
	for _, x := range v {
		if x < lo {
			lo = x
		}
		if x > hi {
			hi = x
		}
	}
	return lo, hi
}
