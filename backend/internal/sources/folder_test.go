package sources

import (
	"testing"
	"time"

	"github.com/pspoerri/grib-viewer/internal/gribidx"
)

func TestGroupByRef(t *testing.T) {
	r1 := time.Date(2026, 7, 6, 0, 0, 0, 0, time.UTC)
	r2 := time.Date(2026, 7, 6, 12, 0, 0, 0, time.UTC)

	a := &gribidx.FileEntry{
		Path: "/data/a.grib2", Size: 10, MTime: 100,
		Msgs: []gribidx.Msg{
			{Msg: 0, Var: "t_2m", Ref: r1, Valid: r1},
			{Msg: 1, Var: "t_2m", Ref: r1, Valid: r1.Add(time.Hour)},
		},
	}
	// b carries messages of two runs (multi-message file with mixed
	// reference times).
	b := &gribidx.FileEntry{
		Path: "/data/b.grib2", Size: 20, MTime: 200,
		Msgs: []gribidx.Msg{
			{Msg: 0, Var: "tot_prec", Ref: r1, Valid: r1.Add(time.Hour)},
			{Msg: 1, Var: "tot_prec", Ref: r2, Valid: r2.Add(time.Hour)},
			{Msg: 2, Var: "tot_prec", Ref: r2, Valid: r2.Add(2 * time.Hour)},
		},
	}

	groups := groupByRef([]*gribidx.FileEntry{a, b})
	if len(groups) != 2 {
		t.Fatalf("expected 2 runs, got %d: %v", len(groups), groups)
	}

	g1 := groups[r1]
	if len(g1) != 2 {
		t.Fatalf("run r1: expected 2 file entries, got %d", len(g1))
	}
	if g1[0].Path != "/data/a.grib2" || len(g1[0].Msgs) != 2 {
		t.Fatalf("run r1 entry 0: %+v", g1[0])
	}
	if g1[1].Path != "/data/b.grib2" || len(g1[1].Msgs) != 1 || g1[1].Msgs[0].Msg != 0 {
		t.Fatalf("run r1 entry 1 must hold only b's r1 message: %+v", g1[1])
	}
	// Size/mtime carried through for change detection.
	if g1[1].Size != 20 || g1[1].MTime != 200 {
		t.Fatalf("run r1 entry 1 lost size/mtime: %+v", g1[1])
	}

	g2 := groups[r2]
	if len(g2) != 1 || g2[0].Path != "/data/b.grib2" || len(g2[0].Msgs) != 2 {
		t.Fatalf("run r2: %+v", g2)
	}
	// The source entries must not be mutated.
	if len(b.Msgs) != 3 {
		t.Fatalf("groupByRef mutated its input: %+v", b)
	}
}

func TestGroupByRefNormalizesUTC(t *testing.T) {
	loc := time.FixedZone("CEST", 2*3600)
	utc := time.Date(2026, 7, 6, 0, 0, 0, 0, time.UTC)
	local := utc.In(loc)

	a := &gribidx.FileEntry{Path: "/a", Msgs: []gribidx.Msg{{Var: "t", Ref: utc}}}
	b := &gribidx.FileEntry{Path: "/b", Msgs: []gribidx.Msg{{Var: "t", Ref: local}}}
	groups := groupByRef([]*gribidx.FileEntry{a, b})
	if len(groups) != 1 {
		t.Fatalf("same instant in different zones must group together, got %d groups", len(groups))
	}
	if len(groups[utc]) != 2 {
		t.Fatalf("expected both files under the UTC key: %v", groups)
	}
}

func TestSyntheticCutoffClassification(t *testing.T) {
	epoch := time.Unix(0, 0).UTC()
	if !epoch.Before(gribidx.SyntheticCutoff) {
		t.Fatal("epoch must be synthetic")
	}
	live := time.Date(2026, 7, 6, 0, 0, 0, 0, time.UTC)
	if live.Before(gribidx.SyntheticCutoff) {
		t.Fatal("live run must not be synthetic")
	}
}
