package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pspoerri/grib-viewer/internal/buffer"
	"github.com/pspoerri/grib-viewer/internal/config"
	"github.com/pspoerri/grib-viewer/internal/engine"
	"github.com/pspoerri/grib-viewer/internal/gribidx"
)

// TestDownloadedDatasetAvailability is the executable form of the full model
// exposure audit. It probes metadata, the median, and every advertised product
// for every variable of every physical and composite model.
//
// The repository's data/ directory is used automatically when present. CI can
// supply another downloaded fixture set with GRIB_VIEWER_DATA_DIR and its
// matching configuration with GRIB_VIEWER_CONFIG. With no dataset, the test
// skips; an explicitly configured but missing dataset is an error.
func TestDownloadedDatasetAvailability(t *testing.T) {
	cfg, dataDir, downloaded := downloadedDataset(t)
	b := buffer.New(dataDir)
	s := New(engine.New(b, 256), cfg, nil)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/models", s.handleModels)
	mux.HandleFunc("GET /api/models/{model}/meta/{var}", s.handleMeta)
	mux.HandleFunc("GET /api/models/{model}/data/{time}/{var}", s.handleData)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	client := ts.Client()
	client.Timeout = time.Minute

	resp, err := client.Get(ts.URL + "/api/models")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("GET /api/models: HTTP %d: %s", resp.StatusCode, body)
	}
	var catalog struct {
		Models []modelDTO `json:"models"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&catalog); err != nil {
		t.Fatal(err)
	}
	if len(catalog.Models) == 0 {
		t.Fatal("downloaded dataset exposed no models")
	}

	physical := make([]string, 0, len(catalog.Models))
	modelIDs := make(map[string]bool, len(catalog.Models))
	for _, model := range catalog.Models {
		if modelIDs[model.ID] {
			t.Errorf("duplicate model %q", model.ID)
		}
		modelIDs[model.ID] = true
		if len(model.Variables) == 0 {
			t.Errorf("model %q has no variables", model.ID)
		}
		if !isComposite(model.ID) {
			physical = append(physical, model.ID)
		}
		for _, contributor := range model.Contributors {
			if !modelIDs[contributor] {
				// Physical models are emitted before composites, so this also
				// catches a contributor that is merely ordered too late.
				t.Errorf("model %q references absent contributor %q", model.ID, contributor)
			}
		}
	}
	sort.Strings(physical)
	if !slices.Equal(physical, downloaded) {
		t.Errorf("physical models = %v, downloaded models = %v", physical, downloaded)
	}

	type probe struct {
		model, variable, product, target string
	}
	var probes []probe
	counts := map[string]int{}
	add := func(model, variable, product, target string) {
		probes = append(probes, probe{model: model, variable: variable, product: product, target: target})
		counts[model]++
	}
	for _, model := range catalog.Models {
		seenVars := map[string]bool{}
		prefix := ts.URL + "/api/models/" + url.PathEscape(model.ID)
		for _, variable := range model.Variables {
			if seenVars[variable.Name] {
				t.Errorf("model %q exposes duplicate variable %q", model.ID, variable.Name)
			}
			seenVars[variable.Name] = true
			if !variable.Products.Median {
				t.Errorf("%s/%s is exposed without a median", model.ID, variable.Name)
			}
			dataURL := func(name string) string {
				return prefix + "/data/latest/" + url.PathEscape(name) + "?bbox=46%2C7%2C47%2C8&maxcells=64"
			}
			add(model.ID, variable.Name, "meta", prefix+"/meta/"+url.PathEscape(variable.Name))
			add(model.ID, variable.Name, "median", dataURL(variable.Name))

			products := variable.Products
			for _, p := range []struct {
				enabled bool
				name    string
				suffix  string
			}{
				{products.Mean, "mean", "_mean"},
				{products.Control, "control", "_ctrl"},
				{products.Min, "min", "_p0"},
				{products.Max, "max", "_p100"},
				{products.Spread, "spread", "_spread"},
			} {
				if p.enabled {
					add(model.ID, variable.Name, p.name, dataURL(variable.Name+p.suffix))
				}
			}
			for _, percentile := range products.Percentiles {
				if percentile == 50 { // the bare median already probes p50
					continue
				}
				name := fmt.Sprintf("p%d", percentile)
				add(model.ID, variable.Name, name, dataURL(variable.Name+"_"+name))
			}
			if products.Chance {
				tail, ok := availabilityThreshold(variable.Units)
				if !ok {
					t.Errorf("%s/%s advertises chance without an HTTP threshold token for %q", model.ID, variable.Name, variable.Units)
				} else {
					add(model.ID, variable.Name, "chance", dataURL(variable.Name+"_gt"+tail))
				}
			}
		}
	}

	jobs := make(chan probe)
	errs := make(chan string, len(probes))
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for p := range jobs {
				response, err := client.Get(p.target)
				if err != nil {
					errs <- fmt.Sprintf("%s/%s %s: %v", p.model, p.variable, p.product, err)
					continue
				}
				body, readErr := io.ReadAll(response.Body)
				response.Body.Close()
				if readErr != nil {
					errs <- fmt.Sprintf("%s/%s %s: read response: %v", p.model, p.variable, p.product, readErr)
					continue
				}
				if response.StatusCode < 200 || response.StatusCode >= 300 {
					errs <- fmt.Sprintf("%s/%s %s: HTTP %d: %s", p.model, p.variable, p.product, response.StatusCode, strings.TrimSpace(string(body)))
				}
			}
		}()
	}
	for _, p := range probes {
		jobs <- p
	}
	close(jobs)
	wg.Wait()
	close(errs)

	var failures []string
	for failure := range errs {
		failures = append(failures, failure)
	}
	sort.Strings(failures)
	if len(failures) > 0 {
		t.Fatalf("%d/%d availability probes failed:\n%s", len(failures), len(probes), strings.Join(failures, "\n"))
	}
	for _, model := range catalog.Models {
		t.Logf("%s: %d variables, %d probes", model.ID, len(model.Variables), counts[model.ID])
	}
	t.Logf("validated %d models, %d variable exposures, %d probes", len(catalog.Models), variableExposureCount(catalog.Models), len(probes))
}

func downloadedDataset(t *testing.T) (*config.Config, string, []string) {
	t.Helper()
	repoRoot, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	explicitData := os.Getenv("GRIB_VIEWER_DATA_DIR")
	dataDir := explicitData
	if dataDir == "" {
		dataDir = filepath.Join(repoRoot, "data")
	}
	dataDir, err = filepath.Abs(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if st, err := os.Stat(dataDir); err != nil || !st.IsDir() {
		if explicitData != "" {
			t.Fatalf("GRIB_VIEWER_DATA_DIR %q is not a directory", dataDir)
		}
		t.Skip("no downloaded model dataset")
	}

	configPath := os.Getenv("GRIB_VIEWER_CONFIG")
	if configPath == "" {
		configPath = filepath.Join(repoRoot, "grib-viewer.yaml")
	}
	cfg, err := config.Load(configPath)
	if err != nil {
		t.Fatalf("load dataset config: %v", err)
	}
	cfg.DataDir = dataDir
	b := buffer.New(dataDir)
	var downloaded []string
	for _, source := range cfg.Sources {
		runID, err := b.ReadLatest(source.ID)
		if err != nil {
			continue
		}
		if st, err := os.Stat(filepath.Join(b.RunDirByID(source.ID, runID), gribidx.IndexFile)); err == nil && !st.IsDir() {
			downloaded = append(downloaded, source.ID)
		}
	}
	if len(downloaded) == 0 {
		if explicitData != "" {
			t.Fatalf("GRIB_VIEWER_DATA_DIR %q contains no configured model indexes", dataDir)
		}
		t.Skip("no downloaded model indexes")
	}
	sort.Strings(downloaded)
	return cfg, dataDir, downloaded
}

func availabilityThreshold(units string) (string, bool) {
	switch units {
	case "K":
		return "273k", true
	case "m s-1", "m/s":
		return "1ms", true
	case "mm", "kg m-2", "mm/h":
		return "1mm", true
	case "Pa":
		return "1000hpa", true
	case "W m-2", "W/m2":
		return "100w", true
	default:
		return "", false
	}
}

func variableExposureCount(models []modelDTO) int {
	total := 0
	for _, model := range models {
		total += len(model.Variables)
	}
	return total
}
