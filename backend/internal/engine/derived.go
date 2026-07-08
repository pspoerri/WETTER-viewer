package engine

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"time"

	"github.com/pspoerri/grib-viewer/internal/ensemble"
	"github.com/pspoerri/grib-viewer/internal/vars"
)

// Derived variables (spec 02): concrete kernels, computed per member
// where members exist, then folded with the requested product.

var (
	precipRe = regexp.MustCompile(`^precip_(\d+)h$`)
	windRe   = regexp.MustCompile(`^wind_(?:speed_)?(10m|\d+hpa)$`)
)

// derivedPlane handles derived ids. handled=false → not a derived id.
func (e *Engine) derivedPlane(rv *runView, spec PlaneSpec, valid time.Time, reg region) ([]float32, bool, error) {
	switch {
	case precipRe.MatchString(spec.Base):
		hours, _ := strconv.Atoi(precipRe.FindStringSubmatch(spec.Base)[1])
		p, err := e.precipWindow(rv, spec, valid, reg, hours)
		return p, true, err

	case windRe.MatchString(spec.Base):
		lvl := windRe.FindStringSubmatch(spec.Base)[1]
		p, err := e.windSpeed(rv, spec, valid, reg, "u_"+lvl, "v_"+lvl)
		return p, true, err

	case spec.Base == "wind_dir_10m":
		p, err := e.windDir(rv, spec, valid, reg)
		return p, true, err

	case spec.Base == "ghi":
		p, err := e.ghi(rv, spec, valid, reg)
		return p, true, err

	case spec.Base == "relhum_2m":
		p, err := e.relhum(rv, spec, valid, reg)
		return p, true, err
	}

	// Time-averaged upstream fields display as de-averaged step rates.
	if f, ok := vars.Lookup(spec.Base); ok && f.Temporal == vars.TemporalTavg {
		if _, isRaw := rv.planes[spec.Base]; isRaw {
			members, err := e.tavgMembers(rv, spec.Base, valid, reg)
			if err != nil {
				return nil, true, err
			}
			p, err := e.fold(rv, spec, members, []string{spec.Base})
			return p, true, err
		}
	}
	return nil, false, nil
}

// fold applies the requested product/exceedance over member planes,
// guarding non-trivial products on deterministic inputs.
func (e *Engine) fold(rv *runView, spec PlaneSpec, members [][]float32, inputs []string) ([]float32, error) {
	det := false
	for _, in := range inputs {
		if vi := rv.Vars[in]; vi != nil && vi.Members == 0 {
			det = true
		}
	}
	if det && len(members) <= 1 {
		nontrivial := spec.Exceed != nil || spec.Product == "spread" ||
			(spec.Product != "" && spec.Product != "p50" && spec.Product != "mean" && spec.Product != "ctrl")
		if nontrivial {
			return nil, fmt.Errorf("%w: %s on deterministic inputs", ErrNoProduct, spec.Product)
		}
		return members[0], nil
	}
	if spec.Exceed != nil {
		return ensemble.Exceed(members, spec.Exceed.Thr, spec.Exceed.Below), nil
	}
	kind := spec.Product
	if kind == "" {
		kind = "p50"
	}
	return ensemble.ReducePlanes(members, kind)
}

// precipWindow: tot_prec(t) − tot_prec(t−N), clamped ≥ 0, per member.
func (e *Engine) precipWindow(rv *runView, spec PlaneSpec, valid time.Time, reg region, hours int) ([]float32, error) {
	cur, err := e.memberPlanes(rv, "tot_prec", valid, reg)
	if err != nil {
		return nil, err
	}
	from := valid.Add(-time.Duration(hours) * time.Hour)
	var members [][]float32
	if from.After(rv.Run) {
		prevT, ok := nearestStep(rv, "tot_prec", from)
		if !ok {
			return nil, fmt.Errorf("%w: tot_prec @ %s", ErrNotFound, from.Format(time.RFC3339))
		}
		prev, err := e.memberPlanes(rv, "tot_prec", prevT, reg)
		if err != nil {
			return nil, err
		}
		members = diffPlanes(cur, prev, 1) // Δh=1: keep totals, not rates
	} else {
		members = cur // accumulation since run start
	}
	return e.fold(rv, spec, members, []string{"tot_prec"})
}

// windSpeed: hypot(u, v) per member (percentile-of-speed, spec 00).
func (e *Engine) windSpeed(rv *runView, spec PlaneSpec, valid time.Time, reg region, un, vn string) ([]float32, error) {
	u, err := e.memberPlanes(rv, un, valid, reg)
	if err != nil {
		return nil, err
	}
	v, err := e.memberPlanes(rv, vn, valid, reg)
	if err != nil {
		return nil, err
	}
	speeds, err := ensemble.PairedMagnitude(u, v)
	if err != nil {
		return nil, err
	}
	return e.fold(rv, spec, speeds, []string{un, vn})
}

// windDir: meteorological wind direction atan2(−u, −v) in degrees.
func (e *Engine) windDir(rv *runView, spec PlaneSpec, valid time.Time, reg region) ([]float32, error) {
	if spec.Exceed != nil || (spec.Product != "" && spec.Product != "p50") {
		return nil, fmt.Errorf("%w: wind_dir has no ensemble products", ErrNoProduct)
	}
	u, err := e.plane(rv, PlaneSpec{Base: "u_10m"}, valid, reg)
	if err != nil {
		return nil, err
	}
	v, err := e.plane(rv, PlaneSpec{Base: "v_10m"}, valid, reg)
	if err != nil {
		return nil, err
	}
	out := make([]float32, len(u))
	for i := range out {
		d := math.Atan2(float64(-u[i]), float64(-v[i])) * 180 / math.Pi
		if d < 0 {
			d += 360
		}
		out[i] = float32(d)
	}
	return out, nil
}

// ghi: aswdifd_s + aswdir_s summed per member, de-averaged to a rate.
func (e *Engine) ghi(rv *runView, spec PlaneSpec, valid time.Time, reg region) ([]float32, error) {
	sum := func(t time.Time) ([][]float32, error) {
		a, err := e.memberPlanes(rv, "aswdifd_s", t, reg)
		if err != nil {
			return nil, err
		}
		b, err := e.memberPlanes(rv, "aswdir_s", t, reg)
		if err != nil {
			return nil, err
		}
		n := min(len(a), len(b))
		out := make([][]float32, n)
		for m := 0; m < n; m++ {
			p := make([]float32, len(a[m]))
			for i := range p {
				p[i] = a[m][i] + b[m][i]
			}
			out[m] = p
		}
		return out, nil
	}
	cur, err := sum(valid)
	if err != nil {
		return nil, err
	}
	members, err := deAverage(rv, "aswdifd_s", valid, cur, func(t time.Time) ([][]float32, error) { return sum(t) })
	if err != nil {
		return nil, err
	}
	return e.fold(rv, spec, members, []string{"aswdifd_s", "aswdir_s"})
}

// relhum: Magnus over water from same-product t_2m / td_2m planes.
// ponytail: RH of the reduced planes, not per-member RH — close enough
// for display; switch to per-member if the difference ever matters.
func (e *Engine) relhum(rv *runView, spec PlaneSpec, valid time.Time, reg region) ([]float32, error) {
	if spec.Exceed != nil || spec.Product == "spread" {
		return nil, fmt.Errorf("%w: relhum_2m products", ErrNoProduct)
	}
	sub := PlaneSpec{Product: spec.Product}
	sub.Base = "t_2m"
	t, err := e.plane(rv, sub, valid, reg)
	if err != nil {
		return nil, err
	}
	sub.Base = "td_2m"
	td, err := e.plane(rv, sub, valid, reg)
	if err != nil {
		return nil, err
	}
	out := make([]float32, len(t))
	for i := range out {
		tc := float64(t[i]) - 273.15
		tdc := float64(td[i]) - 273.15
		rh := 100 * math.Exp(17.62*tdc/(243.12+tdc)-17.62*tc/(243.12+tc))
		out[i] = float32(math.Min(100, math.Max(0, rh)))
	}
	return out, nil
}

// tavgMembers de-averages a run-start-averaged field to per-step rates.
func (e *Engine) tavgMembers(rv *runView, name string, valid time.Time, reg region) ([][]float32, error) {
	cur, err := e.memberPlanes(rv, name, valid, reg)
	if err != nil {
		return nil, err
	}
	return deAverage(rv, name, valid, cur, func(t time.Time) ([][]float32, error) {
		return e.memberPlanes(rv, name, t, reg)
	})
}

// deAverage converts values averaged over [run, t] into the [prev, t]
// step rate: (cur·h − prev·h_prev)/Δh. First step keeps its value.
func deAverage(rv *runView, axisVar string, valid time.Time, cur [][]float32, at func(time.Time) ([][]float32, error)) ([][]float32, error) {
	prevT, dh, ok := prevStep(rv, axisVar, valid)
	if !ok {
		return cur, nil
	}
	prev, err := at(prevT)
	if err != nil {
		return nil, err
	}
	h := valid.Sub(rv.Run).Hours()
	hPrev := prevT.Sub(rv.Run).Hours()
	n := min(len(cur), len(prev))
	out := make([][]float32, n)
	for m := 0; m < n; m++ {
		p := make([]float32, len(cur[m]))
		for i := range p {
			v := (float64(cur[m][i])*h - float64(prev[m][i])*hPrev) / dh
			if v < 0 {
				v = 0
			}
			p[i] = float32(v)
		}
		out[m] = p
	}
	return out, nil
}

func nearestStep(rv *runView, name string, t time.Time) (time.Time, bool) {
	vi := rv.Vars[name]
	if vi == nil || len(vi.Steps) == 0 {
		return time.Time{}, false
	}
	best, bestD := vi.Steps[0], math.Abs(vi.Steps[0].Sub(t).Hours())
	for _, s := range vi.Steps[1:] {
		if d := math.Abs(s.Sub(t).Hours()); d < bestD {
			best, bestD = s, d
		}
	}
	return best, bestD <= 3.0
}
