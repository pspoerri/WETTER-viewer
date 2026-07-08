package api

import (
	"encoding/binary"
	"math"
	"testing"
	"time"

	"github.com/pspoerri/grib-viewer/internal/engine"
)

// minimal protobuf reader for round-trip verification
type pbr struct {
	b []byte
	i int
}

func (r *pbr) varint() uint64 {
	var v uint64
	var s uint
	for {
		c := r.b[r.i]
		r.i++
		v |= uint64(c&0x7f) << s
		if c < 0x80 {
			return v
		}
		s += 7
	}
}

func (r *pbr) fields() map[int][]any {
	out := map[int][]any{}
	for r.i < len(r.b) {
		tag := r.varint()
		field, wire := int(tag>>3), int(tag&7)
		switch wire {
		case 0:
			out[field] = append(out[field], r.varint())
		case 1:
			out[field] = append(out[field], binary.LittleEndian.Uint64(r.b[r.i:]))
			r.i += 8
		case 2:
			n := int(r.varint())
			out[field] = append(out[field], r.b[r.i:r.i+n])
			r.i += n
		case 5:
			out[field] = append(out[field], binary.LittleEndian.Uint32(r.b[r.i:]))
			r.i += 4
		}
	}
	return out
}

func TestWindowRoundTrip(t *testing.T) {
	w := &engine.Window{
		Grid: engine.GridDef{Nx: 3, Ny: 2, Lat0: 47.95, Lon0: 7.05, DLat: -0.1, DLon: 0.1},
		Frames: [][]float32{
			{280.12, 281.5, float32(math.NaN()), 279, 280, 281},
			{281, 282, 283, 284, float32(math.NaN()), 286},
		},
		FrameTimes: []time.Time{time.Unix(1000000, 0), time.Unix(1003600, 0)},
		Synthetic:  true,
		Run:        time.Unix(999999, 0),
	}
	q := quant{Scale: 0.01, Offset: 270}
	raw := encodeWindow("icond2", "t_2m", w, q)

	f := (&pbr{b: raw}).fields()
	if string(f[1][0].([]byte)) != "icond2" || string(f[2][0].([]byte)) != "t_2m" {
		t.Fatalf("model/var: %v %v", f[1], f[2])
	}
	g := (&pbr{b: f[3][0].([]byte)}).fields()
	if g[1][0].(uint64) != 3 || g[2][0].(uint64) != 2 {
		t.Fatalf("grid nx/ny")
	}
	if math.Float64frombits(g[3][0].(uint64)) != 47.95 {
		t.Fatalf("lat0")
	}
	vals := f[4][0].([]byte)
	if len(vals) != 2*6*2 {
		t.Fatalf("values len %d", len(vals))
	}
	v0 := int16(binary.LittleEndian.Uint16(vals[0:]))
	scale := float64(math.Float32frombits(f[5][0].(uint32)))
	offset := float64(math.Float32frombits(f[6][0].(uint32)))
	got := float64(v0)*scale + offset
	if math.Abs(got-280.12) > 0.006 {
		t.Fatalf("dequant %v", got)
	}
	nd := int64(f[7][0].(uint64))
	if int16(nd) != -32768 {
		t.Fatalf("nodata %d", nd)
	}
	if v2 := int16(binary.LittleEndian.Uint16(vals[4:])); v2 != -32768 {
		t.Fatalf("NaN cell not nodata: %d", v2)
	}
	if f[9][0].(uint64) != 2 {
		t.Fatalf("nframes")
	}
	times := (&pbr{b: f[10][0].([]byte)})
	if times.varint() != 1000000 {
		t.Fatalf("frame_unix[0]")
	}
	if f[11][0].(uint64) != 1 {
		t.Fatalf("synthetic flag")
	}
	if f[12][0].(uint64) != 999999 {
		t.Fatalf("run_unix")
	}
}

func TestAutoQuant(t *testing.T) {
	q := autoQuant([][]float32{{1, 2, 3, float32(math.NaN())}})
	if q.Scale <= 0 {
		t.Fatal("scale")
	}
	raw := quantizePlane([]float32{2}, q)
	v := float64(int16(binary.LittleEndian.Uint16(raw))) * q.Scale
	if math.Abs(v+q.Offset-2) > q.Scale {
		t.Fatalf("autoquant round trip: %v", v+q.Offset)
	}
}
