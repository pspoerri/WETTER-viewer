package engine

import (
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	grib "github.com/pspoerri/go-tiled-eccodes"
	gribgrid "github.com/pspoerri/go-tiled-eccodes/grid"
	"github.com/pspoerri/go-tiled-eccodes/tile"

	"github.com/pspoerri/grib-viewer/internal/ensemble"
	"github.com/pspoerri/grib-viewer/internal/vars"
)

var (
	ErrNotFound  = errors.New("engine: variable or step not found")
	ErrNoProduct = errors.New("engine: product not supported by this run")
)

// region is the output sampling window (plate-carrée, cell-centered).
type region struct {
	S, W, N, E float64
	Nx, Ny     int
}

func (r region) key() string {
	return fmt.Sprintf("%.5f,%.5f,%.5f,%.5f/%dx%d", r.S, r.W, r.N, r.E, r.Nx, r.Ny)
}

func (r region) gridDef() GridDef {
	dlat := -(r.N - r.S) / float64(r.Ny)
	dlon := (r.E - r.W) / float64(r.Nx)
	return GridDef{
		Nx: r.Nx, Ny: r.Ny,
		Lat0: r.N + dlat/2, Lon0: r.W + dlon/2,
		DLat: dlat, DLon: dlon,
	}
}

// plane derives one product plane on a region grid, cached.
func (e *Engine) plane(rv *runView, spec PlaneSpec, valid time.Time, reg region) ([]float32, error) {
	key := strings.Join([]string{
		rv.Source, rv.RunID, spec.Base, planeKeyPart(spec),
		strconv.FormatInt(valid.Unix(), 10), reg.key(),
	}, "|")
	if p, ok := e.planes.get(key); ok {
		return p, nil
	}
	v, err, _ := e.sf.do(key, func() (any, error) {
		p, err := e.derivePlane(rv, spec, valid, reg)
		if err != nil {
			return nil, err
		}
		e.planes.put(key, p)
		return p, nil
	})
	if err != nil {
		return nil, err
	}
	return v.([]float32), nil
}

func planeKeyPart(spec PlaneSpec) string {
	s := spec.Product
	if spec.Exceed != nil {
		dir := "gt"
		if spec.Exceed.Below {
			dir = "lt"
		}
		s += fmt.Sprintf("|%s%g", dir, spec.Exceed.Thr)
	}
	return s
}

func (e *Engine) derivePlane(rv *runView, spec PlaneSpec, valid time.Time, reg region) ([]float32, error) {
	// Derived variables first (they recurse through e.plane for inputs).
	if p, handled, err := e.derivedPlane(rv, spec, valid, reg); handled {
		return p, err
	}

	byTime, ok := rv.planes[spec.Base]
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrNotFound, spec.Base)
	}
	pm, ok := byTime[valid.Unix()]
	if !ok {
		return nil, fmt.Errorf("%w: %s @ %s", ErrNotFound, spec.Base, valid.Format(time.RFC3339))
	}

	det, isDet := pm.byMember[-1]
	if isDet && len(pm.byMember) == 1 {
		switch {
		case spec.Exceed != nil:
			return nil, fmt.Errorf("%w: exceedance needs ensemble members", ErrNoProduct)
		case spec.Product == "" || spec.Product == "p50" || spec.Product == "ctrl" || spec.Product == "mean":
			return e.renderMsg(rv, spec.Base, det, valid, reg)
		default:
			return nil, fmt.Errorf("%w: %s on deterministic %s", ErrNoProduct, spec.Product, spec.Base)
		}
	}

	// Ensemble.
	if spec.Product == "ctrl" {
		if loc, ok := pm.byMember[0]; ok {
			return e.renderMsg(rv, spec.Base, loc, valid, reg)
		}
		return nil, fmt.Errorf("%w: no control member", ErrNoProduct)
	}
	if strings.HasPrefix(spec.Product, "m") && spec.Product != "mean" {
		n, err := strconv.Atoi(spec.Product[1:])
		if err != nil {
			return nil, fmt.Errorf("%w: bad member %q", ErrNoProduct, spec.Product)
		}
		if loc, ok := pm.byMember[n]; ok {
			return e.renderMsg(rv, spec.Base, loc, valid, reg)
		}
		return nil, fmt.Errorf("%w: member %d absent", ErrNotFound, n)
	}

	members, err := e.memberPlanes(rv, spec.Base, valid, reg)
	if err != nil {
		return nil, err
	}
	if spec.Exceed != nil {
		in := members
		if f, ok := vars.Lookup(spec.Base); ok && f.Temporal == vars.TemporalAccum {
			// Exceedance on accumulants applies to the step rate (spec 03).
			in, err = e.memberRates(rv, spec.Base, valid, reg)
			if err != nil {
				return nil, err
			}
		}
		return ensemble.Exceed(in, spec.Exceed.Thr, spec.Exceed.Below), nil
	}
	kind := spec.Product
	if kind == "" {
		kind = "p50"
	}
	return ensemble.ReducePlanes(members, kind)
}

// memberPlanes renders every present ensemble member for (var, valid).
func (e *Engine) memberPlanes(rv *runView, name string, valid time.Time, reg region) ([][]float32, error) {
	pm, ok := rv.planes[name][valid.Unix()]
	if !ok {
		return nil, fmt.Errorf("%w: %s @ %s", ErrNotFound, name, valid.Format(time.RFC3339))
	}
	mems := make([]int, 0, len(pm.byMember))
	for m := range pm.byMember {
		if m >= 0 {
			mems = append(mems, m)
		}
	}
	if len(mems) == 0 {
		// deterministic plane posing as a one-member ensemble
		if loc, ok := pm.byMember[-1]; ok {
			p, err := e.renderMsg(rv, name, loc, valid, reg)
			if err != nil {
				return nil, err
			}
			return [][]float32{p}, nil
		}
		return nil, fmt.Errorf("%w: %s has no planes", ErrNotFound, name)
	}
	sort.Ints(mems)
	out := make([][]float32, 0, len(mems))
	for _, m := range mems {
		p, err := e.renderMemberCached(rv, name, pm.byMember[m], m, valid, reg)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, nil
}

func (e *Engine) renderMemberCached(rv *runView, name string, loc msgLoc, member int, valid time.Time, reg region) ([]float32, error) {
	key := strings.Join([]string{
		rv.Source, rv.RunID, name, "raw", strconv.Itoa(member),
		strconv.FormatInt(valid.Unix(), 10), reg.key(),
	}, "|")
	if p, ok := e.planes.get(key); ok {
		return p, nil
	}
	p, err := e.renderMsg(rv, name, loc, valid, reg)
	if err != nil {
		return nil, err
	}
	e.planes.put(key, p)
	return p, nil
}

// memberRates de-accumulates member planes to a per-hour step rate.
func (e *Engine) memberRates(rv *runView, name string, valid time.Time, reg region) ([][]float32, error) {
	cur, err := e.memberPlanes(rv, name, valid, reg)
	if err != nil {
		return nil, err
	}
	prevT, dh, ok := prevStep(rv, name, valid)
	if !ok { // first step: rate = acc / lead
		lead := valid.Sub(rv.Run).Hours()
		if lead <= 0 {
			lead = 1
		}
		return scalePlanes(cur, 1/lead), nil
	}
	prev, err := e.memberPlanes(rv, name, prevT, reg)
	if err != nil {
		return nil, err
	}
	return diffPlanes(cur, prev, dh), nil
}

func prevStep(rv *runView, name string, valid time.Time) (time.Time, float64, bool) {
	vi := rv.Vars[name]
	if vi == nil {
		return time.Time{}, 0, false
	}
	i := sort.Search(len(vi.Steps), func(i int) bool { return !vi.Steps[i].Before(valid) })
	if i <= 0 || i >= len(vi.Steps) || !vi.Steps[i].Equal(valid) {
		return time.Time{}, 0, false
	}
	prev := vi.Steps[i-1]
	return prev, valid.Sub(prev).Hours(), true
}

func scalePlanes(ps [][]float32, k float64) [][]float32 {
	out := make([][]float32, len(ps))
	for i, p := range ps {
		q := make([]float32, len(p))
		for j, v := range p {
			q[j] = v * float32(k)
		}
		out[i] = q
	}
	return out
}

func diffPlanes(cur, prev [][]float32, dh float64) [][]float32 {
	n := min(len(cur), len(prev))
	out := make([][]float32, n)
	for m := 0; m < n; m++ {
		q := make([]float32, len(cur[m]))
		for j := range q {
			d := (cur[m][j] - prev[m][j]) / float32(dh)
			if d < 0 || d != d {
				if cur[m][j] != cur[m][j] || prev[m][j] != prev[m][j] {
					d = float32(math.NaN())
				} else {
					d = 0
				}
			}
			q[j] = d
		}
		out[m] = q
	}
	return out
}

// renderMsg region-renders one GRIB message with nearest sampling and
// tavg de-averaging where the catalog demands it.
func (e *Engine) renderMsg(rv *runView, name string, loc msgLoc, valid time.Time, reg region) ([]float32, error) {
	fe, err := e.acquireFile(rv.Source, loc.Path)
	if err != nil {
		return nil, err
	}
	defer e.release(fe)
	msgs := fe.f.Messages()
	if loc.Msg >= len(msgs) {
		return nil, fmt.Errorf("engine: message %d out of range in %s", loc.Msg, loc.Path)
	}
	m := msgs[loc.Msg]
	dst := make([]float32, reg.Nx*reg.Ny)
	if g, gerr := m.Grid(); gerr == nil {
		if u, ok := g.(*gribgrid.Unstructured); ok {
			if !u.HasCoordinates() {
				return nil, fmt.Errorf("engine: %s is on an icosahedral grid but %s has no clat/clon in static/ — fetch the model's horizontal constants", name, rv.Source)
			}
			if err := e.renderUnstructured(m, u, reg, dst); err != nil {
				return nil, fmt.Errorf("render %s: %w", loc.Path, err)
			}
			return dst, nil
		}
	}
	err = m.RenderRegionFloat32(grib.Region{
		South: reg.S, West: reg.W, North: reg.N, East: reg.E,
		Width: reg.Nx, Height: reg.Ny,
		Sample: tile.Nearest,
	}, dst)
	if err != nil {
		return nil, fmt.Errorf("render %s: %w", loc.Path, err)
	}
	return dst, nil
}

func medianConsecutiveMeters(lats, lons []float64) float64 {
	n := len(lats)
	if n < 2 {
		return 0
	}
	const samples = 256
	stride := n / samples
	if stride < 1 {
		stride = 1
	}
	var ds []float64
	for i := 0; i+1 < n; i += stride {
		d := haversineMeters(lats[i], lons[i], lats[i+1], lons[i+1])
		if d > 0 {
			ds = append(ds, d)
		}
	}
	if len(ds) == 0 {
		return 0
	}
	sort.Float64s(ds)
	return ds[len(ds)/2]
}

func haversineMeters(lat1, lon1, lat2, lon2 float64) float64 {
	const R = 6371229.0
	rad := math.Pi / 180
	dlat := (lat2 - lat1) * rad
	dlon := (lon2 - lon1) * rad
	a := math.Sin(dlat/2)*math.Sin(dlat/2) +
		math.Cos(lat1*rad)*math.Cos(lat2*rad)*math.Sin(dlon/2)*math.Sin(dlon/2)
	return 2 * R * math.Asin(math.Sqrt(a))
}
