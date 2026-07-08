package engine

import (
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pspoerri/grib-viewer/internal/buffer"
	"github.com/pspoerri/grib-viewer/internal/gribidx"
)

// Integration test against real GRIB fixtures. Set WETTER_FIXTURE_DIR
// to a directory containing *.grib2 files (e.g. one t_2m + one
// tot_prec ICON-D2 message file); skipped otherwise.
func TestEngineRealGRIB(t *testing.T) {
	dir := os.Getenv("WETTER_FIXTURE_DIR")
	if dir == "" {
		t.Skip("WETTER_FIXTURE_DIR not set")
	}
	paths, _ := filepath.Glob(filepath.Join(dir, "*.grib2"))
	if len(paths) == 0 {
		t.Skip("no fixtures")
	}

	root := t.TempDir()
	buf := buffer.New(root)
	ri := &gribidx.RunIndex{Source: "fix", Complete: true}
	for _, p := range paths {
		fe, err := gribidx.ScanFile(p, "")
		if err != nil {
			t.Fatalf("scan %s: %v", p, err)
		}
		if ri.Run.IsZero() && len(fe.Msgs) > 0 {
			ri.Run = fe.Msgs[0].Ref
		}
		ri.Files = append(ri.Files, *fe)
	}
	runDir := buf.RunDir("fix", ri.Run)
	if err := os.MkdirAll(runDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := gribidx.Save(runDir, ri); err != nil {
		t.Fatal(err)
	}
	if err := buf.WriteLatest("fix", ri.Run.UTC().Format(buffer.RunIDFormat)); err != nil {
		t.Fatal(err)
	}

	eng := New(buf, 256)
	info, err := eng.Info("fix", "latest")
	if err != nil {
		t.Fatal(err)
	}
	var name string
	var steps []time.Time
	for n, vi := range info.Vars {
		if len(vi.Steps) > 0 {
			name, steps = n, vi.Steps
			if n == "t_2m" {
				break
			}
		}
	}
	if name == "" {
		t.Fatal("no variables indexed")
	}
	t.Logf("var=%s steps=%d run=%s", name, len(steps), info.Run)

	w, err := eng.Window(WindowReq{
		Source: "fix", Run: "latest",
		Plane:    PlaneSpec{Base: name},
		Times:    steps[:1],
		BBox:     [4]float64{47, 6, 55, 15},
		MaxCells: 100_000,
	})
	if err != nil {
		t.Fatalf("window: %v", err)
	}
	valid := 0
	for _, v := range w.Frames[0] {
		if v == v {
			valid++
		}
	}
	t.Logf("grid %dx%d, %d/%d valid cells", w.Grid.Nx, w.Grid.Ny, valid, len(w.Frames[0]))
	if valid == 0 {
		t.Fatal("window is all NoData")
	}
	if name == "t_2m" {
		for _, v := range w.Frames[0] {
			if v == v && (v < 200 || v > 340) {
				t.Fatalf("implausible t_2m %v K", v)
			}
		}
	}

	pt, err := eng.Point(PointReq{
		Source: "fix", Run: "latest",
		Plane: PlaneSpec{Base: name},
		Times: steps[:1], Lat: 50.0, Lon: 10.0,
	})
	if err != nil {
		t.Fatalf("point: %v", err)
	}
	if pt.Values[0] == nil || math.IsNaN(*pt.Values[0]) {
		t.Fatal("point returned nodata inside domain")
	}
	t.Logf("point %s @50,10 = %v", name, *pt.Values[0])
}
