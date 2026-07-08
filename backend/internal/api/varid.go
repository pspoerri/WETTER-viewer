package api

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/pspoerri/grib-viewer/internal/engine"
	"github.com/pspoerri/grib-viewer/internal/vars"
)

// varRequest is a fully parsed variable id (spec 03 grammar):
//
//	{base}{plane}{__window}[unit]
type varRequest struct {
	Plane    engine.PlaneSpec
	WinHours int    // 0 = no window suffix
	WinOp    string // max|min|mean|sum; "" with WinHours>0 = exceed peak (max)
	UnitCode string // display conversion, applied to point/grid values
	Field    vars.Field
}

var (
	windowRe  = regexp.MustCompile(`^(..*?)__(\d+)h(?:_(max|min|mean|sum))?$`)
	productRe = regexp.MustCompile(`^(.+)_(p\d{1,3}|mean|ctrl|spread|m\d+)$`)
	// threshold tails: value-then-unit (2p5mm, -5c) or prefixed (bft8)
	exceedRe = regexp.MustCompile(`^(.+)_(gt|lt)((?:-?[0-9][0-9p]*[a-z]+)|(?:[a-z]+[0-9]+))$`)
)

// stripToBase peels unit/window/product/exceedance suffixes without a
// resolvability check (meta-endpoint convenience).
func stripToBase(id string) string {
	if i := strings.LastIndexByte(id, '['); i >= 0 {
		id = id[:i]
	}
	if m := windowRe.FindStringSubmatch(id); m != nil {
		id = m[1]
	}
	if m := exceedRe.FindStringSubmatch(id); m != nil {
		return m[1]
	}
	if m := productRe.FindStringSubmatch(id); m != nil {
		return m[1]
	}
	return id
}

// parseVarID parses id and validates the base against the run.
// resolvable reports whether a candidate base is servable.
func parseVarID(id string, resolvable func(base string) bool) (*varRequest, error) {
	vr := &varRequest{}
	s := id

	// 1. [unit] bracket (stripped first, applied last).
	if i := strings.LastIndexByte(s, '['); i >= 0 {
		if !strings.HasSuffix(s, "]") {
			return nil, fmt.Errorf("bad unit bracket in %q", id)
		}
		vr.UnitCode = strings.ToLower(s[i+1 : len(s)-1])
		s = s[:i]
	}

	// 2. __{N}h_{op} window suffix.
	if m := windowRe.FindStringSubmatch(s); m != nil {
		n, _ := strconv.Atoi(m[2])
		if n <= 0 {
			return nil, fmt.Errorf("bad window %q", id)
		}
		vr.WinHours = n
		vr.WinOp = m[3]
		s = m[1]
	}

	// 3. base [+ product | exceedance], longest-base-first: an id that
	// resolves as-is is a base (u_10m is not member 10 of u_10).
	switch {
	case resolvable(s):
		vr.Plane.Base = s
	default:
		if m := exceedRe.FindStringSubmatch(s); m != nil && resolvable(m[1]) {
			f, ok := vars.Lookup(m[1])
			if !ok {
				f = vars.Generic(m[1])
			}
			thr, err := vars.ParseThresholdTail(m[3], f.Units)
			if err != nil {
				return nil, fmt.Errorf("threshold %q: %w", m[3], err)
			}
			vr.Plane.Base = m[1]
			vr.Plane.Exceed = &engine.ExceedSpec{Thr: thr, Below: m[2] == "lt"}
			break
		}
		if m := productRe.FindStringSubmatch(s); m != nil && resolvable(m[1]) {
			if p := m[2]; strings.HasPrefix(p, "p") {
				n, _ := strconv.Atoi(p[1:])
				if n > 100 {
					return nil, fmt.Errorf("bad percentile %q", p)
				}
			}
			vr.Plane.Base = m[1]
			vr.Plane.Product = m[2]
			break
		}
		return nil, fmt.Errorf("unknown variable %q", id)
	}

	if vr.WinHours > 0 && vr.WinOp == "" {
		if vr.Plane.Exceed == nil {
			return nil, fmt.Errorf("window %q needs an op (__%dh_max etc.)", id, vr.WinHours)
		}
		vr.WinOp = "max" // exceed peak: documented lower bound (spec 03)
	}

	f, ok := vars.Lookup(vr.Plane.Base)
	if !ok {
		f = vars.Generic(vr.Plane.Base)
	}
	vr.Field = f
	return vr, nil
}
