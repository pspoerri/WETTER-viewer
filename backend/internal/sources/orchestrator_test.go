package sources

import (
	"context"
	"testing"
	"time"

	"github.com/pspoerri/grib-viewer/internal/buffer"
	"github.com/pspoerri/grib-viewer/internal/config"
	"github.com/pspoerri/grib-viewer/internal/gribidx"
)

func TestNewDispatch(t *testing.T) {
	cases := []struct {
		cfg config.Source
		ok  bool
	}{
		{config.Source{ID: "a", Type: "folder", Path: "/tmp/x"}, true},
		{config.Source{ID: "b", Type: "dwd-opendata", Model: "icon-d2"}, true},
		{config.Source{ID: "c", Type: "meteoswiss-stac", Collection: "coll"}, true},
		{config.Source{ID: "d", Type: "http-index", URL: "https://example.org/gribs/"}, true},
		{config.Source{ID: "e", Type: "s3", URL: "s3://bucket/prefix"}, true},
		{config.Source{ID: "f", Type: "folder"}, false},          // missing path
		{config.Source{ID: "g", Type: "dwd-opendata"}, false},    // missing model
		{config.Source{ID: "h", Type: "meteoswiss-stac"}, false}, // missing collection
		{config.Source{ID: "i", Type: "wat"}, false},
	}
	for _, c := range cases {
		src, err := New(c.cfg)
		if (err == nil) != c.ok {
			t.Errorf("%s/%s: err=%v want ok=%v", c.cfg.ID, c.cfg.Type, err, c.ok)
			continue
		}
		if err == nil && src.ID() != c.cfg.ID {
			t.Errorf("%s: ID()=%q", c.cfg.ID, src.ID())
		}
	}
}

func TestOrchestratorEmptyFolderPass(t *testing.T) {
	buf := buffer.New(t.TempDir())
	o, err := NewOrchestrator(buf, []config.Source{
		{ID: "team", Type: "folder", Path: t.TempDir(), Fetch: "loop", Interval: time.Minute, KeepRuns: 2},
	})
	if err != nil {
		t.Fatalf("NewOrchestrator: %v", err)
	}
	if err := o.RunOnce(context.Background(), "team"); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	st, ok := o.Status()["team"]
	if !ok {
		t.Fatal("missing status entry")
	}
	if st.LastSuccess.IsZero() {
		t.Fatal("LastSuccess not set after a clean pass")
	}
	if st.Fetching {
		t.Fatal("Fetching must be false after the pass")
	}
	if err := o.RunOnce(context.Background(), "nope"); err == nil {
		t.Fatal("RunOnce on unknown source must error")
	}
}

func TestIndexEqual(t *testing.T) {
	run := time.Date(2026, 7, 6, 0, 0, 0, 0, time.UTC)
	mk := func() *gribidx.RunIndex {
		return &gribidx.RunIndex{
			Source: "s", Run: run, Complete: true,
			Files: []gribidx.FileEntry{
				{Path: "/a", Size: 1, MTime: 10, Msgs: []gribidx.Msg{{Var: "t_2m", Ref: run}}},
				{Path: "/b", Size: 2, MTime: 20, Msgs: []gribidx.Msg{{Var: "t_2m", Ref: run}}},
			},
		}
	}
	a, b := mk(), mk()
	if !indexEqual(a, b) {
		t.Fatal("identical indexes must compare equal")
	}
	if indexEqual(nil, b) {
		t.Fatal("nil prev is never equal")
	}
	b = mk()
	b.Complete = false
	if indexEqual(a, b) {
		t.Fatal("Complete flip must not compare equal")
	}
	b = mk()
	b.Files[1].Size = 99
	if indexEqual(a, b) {
		t.Fatal("size change must not compare equal")
	}
	// Order-insensitive on prev.
	b = mk()
	b.Files[0], b.Files[1] = b.Files[1], b.Files[0]
	sorted := mk()
	if !indexEqual(b, sorted) {
		t.Fatal("prev file order must not matter")
	}
}

func TestHasHeadline(t *testing.T) {
	run := time.Date(2026, 7, 6, 0, 0, 0, 0, time.UTC)
	ri := &gribidx.RunIndex{Files: []gribidx.FileEntry{
		{Path: "/a", Msgs: []gribidx.Msg{{Var: "tot_prec", Ref: run}}},
	}}
	o := &Orchestrator{}

	dwd := &sourceState{cfg: config.Source{ID: "x", Type: "dwd-opendata"}}
	if o.hasHeadline(dwd, ri) {
		t.Fatal("no t_2m indexed -> not published")
	}
	ri.Files[0].Msgs = append(ri.Files[0].Msgs, gribidx.Msg{Var: "t_2m", Ref: run})
	if !o.hasHeadline(dwd, ri) {
		t.Fatal("t_2m indexed -> published")
	}

	// First configured variable overrides the t_2m default.
	custom := &sourceState{cfg: config.Source{ID: "x", Type: "dwd-opendata", Variables: []string{"TOT_PREC"}}}
	ri2 := &gribidx.RunIndex{Files: []gribidx.FileEntry{{Path: "/a", Msgs: []gribidx.Msg{{Var: "tot_prec", Ref: run}}}}}
	if !o.hasHeadline(custom, ri2) {
		t.Fatal("first configured variable must publish")
	}

	// Generic sources publish on any message.
	generic := &sourceState{cfg: config.Source{ID: "x", Type: "folder"}, generic: true}
	ri3 := &gribidx.RunIndex{Files: []gribidx.FileEntry{{Path: "/a", Msgs: []gribidx.Msg{{Var: "p0_1_2", Ref: run}}}}}
	if !o.hasHeadline(generic, ri3) {
		t.Fatal("generic source with any message must publish")
	}
	if o.hasHeadline(generic, &gribidx.RunIndex{}) {
		t.Fatal("generic source with no messages must not publish")
	}
}
