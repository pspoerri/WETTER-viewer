package api

import (
	"encoding/binary"
	"math"

	"github.com/pspoerri/grib-viewer/internal/engine"
)

// Hand-rolled protobuf encoder for the Window message (spec 03).
// Mirrors the frontend's hand-rolled decoder; no protoc in the build.
//
//	1 model string        7 nodata int32
//	2 variable string     8 height bytes (LE int16)
//	3 grid message        9 nframes int32
//	4 values bytes       10 frame_unix repeated int64 (packed)
//	5 scale float        11 synthetic_time bool
//	6 offset float       12 run_unix int64
//	grid: 1 nx, 2 ny (varint), 3 lat0, 4 lon0, 5 dlat, 6 dlon (double)

const noData = -32768

type quant struct{ Scale, Offset float64 }

// autoQuant ranges the quantization over the actual frames when the
// catalog has no fixed scale (unknown/debug variables).
func autoQuant(frames [][]float32) quant {
	lo, hi := math.Inf(1), math.Inf(-1)
	for _, f := range frames {
		for _, v := range f {
			fv := float64(v)
			if fv != fv {
				continue
			}
			if fv < lo {
				lo = fv
			}
			if fv > hi {
				hi = fv
			}
		}
	}
	if lo > hi { // all NaN
		return quant{Scale: 1, Offset: 0}
	}
	if hi == lo {
		return quant{Scale: 1, Offset: lo}
	}
	return quant{Scale: (hi - lo) / 60000, Offset: (hi + lo) / 2}
}

func quantizePlane(p []float32, q quant) []byte {
	out := make([]byte, len(p)*2)
	for i, v := range p {
		var raw int16
		if v != v {
			raw = noData
		} else {
			r := math.Round((float64(v) - q.Offset) / q.Scale)
			if r > 32767 {
				r = 32767
			} else if r < -32767 {
				r = -32767
			}
			raw = int16(r)
		}
		binary.LittleEndian.PutUint16(out[i*2:], uint16(raw))
	}
	return out
}

type pbuf struct{ b []byte }

func (p *pbuf) varint(v uint64) {
	for v >= 0x80 {
		p.b = append(p.b, byte(v)|0x80)
		v >>= 7
	}
	p.b = append(p.b, byte(v))
}
func (p *pbuf) tag(field, wire int) { p.varint(uint64(field<<3 | wire)) }
func (p *pbuf) str(field int, s string) {
	p.tag(field, 2)
	p.varint(uint64(len(s)))
	p.b = append(p.b, s...)
}
func (p *pbuf) bytes(field int, d []byte) {
	p.tag(field, 2)
	p.varint(uint64(len(d)))
	p.b = append(p.b, d...)
}
func (p *pbuf) i64(field int, v int64) { p.tag(field, 0); p.varint(uint64(v)) }
func (p *pbuf) f32(field int, v float32) {
	p.tag(field, 5)
	p.b = binary.LittleEndian.AppendUint32(p.b, math.Float32bits(v))
}
func (p *pbuf) f64(field int, v float64) {
	p.tag(field, 1)
	p.b = binary.LittleEndian.AppendUint64(p.b, math.Float64bits(v))
}
func (p *pbuf) bool(field int, v bool) {
	if v {
		p.i64(field, 1)
	}
}

func encodeGrid(g engine.GridDef) []byte {
	var p pbuf
	p.i64(1, int64(g.Nx))
	p.i64(2, int64(g.Ny))
	p.f64(3, g.Lat0)
	p.f64(4, g.Lon0)
	p.f64(5, g.DLat)
	p.f64(6, g.DLon)
	return p.b
}

func encodeWindow(model, variable string, w *engine.Window, q quant) []byte {
	var p pbuf
	p.str(1, model)
	p.str(2, variable)
	p.bytes(3, encodeGrid(w.Grid))

	vals := make([]byte, 0, len(w.Frames)*len(w.Frames[0])*2)
	for _, f := range w.Frames {
		vals = append(vals, quantizePlane(f, q)...)
	}
	p.bytes(4, vals)
	p.f32(5, float32(q.Scale))
	p.f32(6, float32(q.Offset))
	p.tag(7, 0)
	var nd int64 = noData
	p.varint(uint64(nd)) // proto3 int32: negative = sign-extended 64-bit varint
	if w.Height != nil {
		p.bytes(8, quantizePlane(w.Height, quant{Scale: 1, Offset: 0}))
	}
	p.i64(9, int64(len(w.Frames)))
	if len(w.FrameTimes) > 0 {
		var packed pbuf
		for _, t := range w.FrameTimes {
			packed.varint(uint64(t.Unix()))
		}
		p.bytes(10, packed.b)
	}
	p.bool(11, w.Synthetic)
	if !w.Run.IsZero() {
		p.i64(12, w.Run.Unix())
	}
	return p.b
}
