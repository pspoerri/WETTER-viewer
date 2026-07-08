package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"sort"
	"text/tabwriter"
	"time"

	"github.com/pspoerri/grib-viewer/internal/api"
	"github.com/pspoerri/grib-viewer/internal/buffer"
	"github.com/pspoerri/grib-viewer/internal/config"
	"github.com/pspoerri/grib-viewer/internal/engine"
	"github.com/pspoerri/grib-viewer/internal/sources"
)

// runBench: end-to-end benchmark (spec 06 / goal): fetch (unless
// --no-fetch), serve in-process, time the full HTTP path.
func runBench(ctx context.Context, cfg *config.Config, sourceID string, skipFetch bool) error {
	if sourceID == "" && len(cfg.Sources) > 0 {
		sourceID = cfg.Sources[0].ID
	}
	buf := buffer.New(cfg.DataDir)

	if !skipFetch {
		orch, err := sources.NewOrchestrator(buf, cfg.Sources)
		if err != nil {
			return err
		}
		t0 := time.Now()
		if err := orch.RunOnce(ctx, sourceID); err != nil {
			return fmt.Errorf("fetch %s: %w", sourceID, err)
		}
		fmt.Printf("fetch+index %s: %s\n", sourceID, time.Since(t0).Round(time.Millisecond))
	}

	eng := engine.New(buf, cfg.Cache.FieldsMB)
	srv := httptest.NewServer(api.New(eng, cfg, nil).Handler())
	defer srv.Close()

	get := func(path string) (int, []byte, time.Duration, error) {
		t0 := time.Now()
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			return 0, nil, 0, err
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return resp.StatusCode, body, time.Since(t0), nil
	}

	// discover what we have
	info, err := eng.Info(sourceID, "latest")
	if err != nil {
		return fmt.Errorf("no buffered run for %s (fetch first): %w", sourceID, err)
	}
	steps, err := eng.StepsFor(sourceID, info.RunID, "t_2m")
	if err != nil || len(steps) == 0 {
		return fmt.Errorf("run has no t_2m axis: %v", err)
	}
	members := eng.MembersFor(sourceID, info.RunID, "t_2m")
	south, west, north, east, _ := eng.GridExtent(sourceID, info.RunID, "t_2m")
	bbox := fmt.Sprintf("%.2f,%.2f,%.2f,%.2f", south, west, north, east)
	mid := steps[len(steps)/2].Format(time.RFC3339)
	span := fmt.Sprintf("%s+PT%dH", steps[0].Format(time.RFC3339), min(12, len(steps)-1))

	fmt.Printf("\nmodel=%s run=%s steps=%d members=%d domain=[%s]\n\n",
		sourceID, info.RunID, len(steps), members, bbox)

	type row struct {
		name, path string
		repeat     int
	}
	rows := []row{
		{"catalog /models", "/api/models", 3},
		{"runs list", "/api/models/" + sourceID + "/runs", 3},
		{"window cold (t_2m, full domain)", "/api/models/" + sourceID + "/data/" + url.PathEscape(mid) + "/t_2m?bbox=" + bbox + "&run=" + info.RunID, 1},
		{"window warm", "/api/models/" + sourceID + "/data/" + url.PathEscape(mid) + "/t_2m?bbox=" + bbox + "&run=" + info.RunID, 5},
		{"chunk 12 frames", "/api/models/" + sourceID + "/data/" + url.PathEscape(span) + "/t_2m?bbox=" + bbox + "&run=" + info.RunID, 1},
		{"point series (full horizon)", "/api/models/" + sourceID + "/point/" + url.PathEscape(fmt.Sprintf("%s+PT%dH", steps[0].Format(time.RFC3339), len(steps))) + "/t_2m?lat=47.4&lon=8.5&run=" + info.RunID, 2},
		{"window agg __6h_max", "/api/models/" + sourceID + "/data/" + url.PathEscape(mid) + "/t_2m__6h_max?bbox=" + bbox + "&run=" + info.RunID, 2},
	}
	if members > 0 {
		rows = append(rows,
			row{"ensemble p90 cold", "/api/models/" + sourceID + "/data/" + url.PathEscape(mid) + "/t_2m_p90?bbox=" + bbox + "&run=" + info.RunID, 1},
			row{"ensemble p90 warm", "/api/models/" + sourceID + "/data/" + url.PathEscape(mid) + "/t_2m_p90?bbox=" + bbox + "&run=" + info.RunID, 3},
			row{"exceedance gt24c", "/api/models/" + sourceID + "/data/" + url.PathEscape(mid) + "/t_2m_gt24c?bbox=" + bbox + "&run=" + info.RunID, 2},
			row{"spread", "/api/models/" + sourceID + "/data/" + url.PathEscape(mid) + "/t_2m_spread?bbox=" + bbox + "&run=" + info.RunID, 2},
		)
	}
	if eng.Resolvable(sourceID, info.RunID, "precip_1h") {
		rows = append(rows, row{"derived precip_1h", "/api/models/" + sourceID + "/data/" + url.PathEscape(mid) + "/precip_1h?bbox=" + bbox + "&run=" + info.RunID, 2})
	}
	if eng.Resolvable(sourceID, info.RunID, "wind_speed_10m") {
		rows = append(rows, row{"derived wind_speed_10m", "/api/models/" + sourceID + "/data/" + url.PathEscape(mid) + "/wind_speed_10m?bbox=" + bbox + "&run=" + info.RunID, 2})
	}

	tw := tabwriter.NewWriter(os.Stdout, 2, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "benchmark\tstatus\tmedian\tbest\tbytes")
	for _, r := range rows {
		var durs []time.Duration
		var code int
		var size int
		for i := 0; i < r.repeat; i++ {
			c, body, d, err := get(r.path)
			if err != nil {
				return err
			}
			code, size = c, len(body)
			durs = append(durs, d)
		}
		sort.Slice(durs, func(i, j int) bool { return durs[i] < durs[j] })
		med := durs[len(durs)/2]
		fmt.Fprintf(tw, "%s\t%d\t%s\t%s\t%s\n", r.name, code,
			med.Round(time.Millisecond/10), durs[0].Round(time.Millisecond/10), fmtBytes(size))
	}
	return tw.Flush()
}

func fmtBytes(n int) string {
	switch {
	case n >= 1<<20:
		return fmt.Sprintf("%.1fMB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.1fkB", float64(n)/(1<<10))
	default:
		return fmt.Sprintf("%dB", n)
	}
}
