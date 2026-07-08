package sources

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/pspoerri/grib-viewer/internal/buffer"
	"github.com/pspoerri/grib-viewer/internal/config"
	"github.com/pspoerri/grib-viewer/internal/gribidx"
)

// SourceStatus is the per-source state surfaced via /api/status.
type SourceStatus struct {
	Run         string    `json:"run"`
	FilesDone   int       `json:"files_done"`
	FilesTotal  int       `json:"files_total"`
	LastError   string    `json:"last_error,omitempty"`
	LastErrorAt time.Time `json:"last_error_at,omitzero"`
	LastSuccess time.Time `json:"last_success,omitzero"`
	Fetching    bool      `json:"fetching"`
}

// downloadWorkers bounds the per-pass download pool.
const downloadWorkers = 8

type sourceState struct {
	cfg config.Source
	src Source
	// generic sources (folder/http-index/s3) have no upstream variable
	// naming: any indexed message publishes the run, instead of the
	// headline variable.
	generic bool

	passMu sync.Mutex // serializes passes per source
	mu     sync.Mutex // guards status
	status SourceStatus
}

// Orchestrator drives the per-source fetch passes and maintains the
// buffer (spec 01: Discover -> diff -> download pool -> index -> latest
// -> prune).
type Orchestrator struct {
	buf     *buffer.Buffer
	states  []*sourceState
	byID    map[string]*sourceState
	changed chan string
}

func NewOrchestrator(buf *buffer.Buffer, cfgs []config.Source) (*Orchestrator, error) {
	o := &Orchestrator{
		buf:     buf,
		byID:    map[string]*sourceState{},
		changed: make(chan string, 64),
	}
	for _, cfg := range cfgs {
		src, err := New(cfg)
		if err != nil {
			return nil, err
		}
		if f, ok := src.(*folderSource); ok {
			f.inflateDir = filepath.Join(buf.SourceDir(cfg.ID), "inflated")
		}
		st := &sourceState{
			cfg:     cfg,
			src:     src,
			generic: cfg.Type == "folder" || cfg.Type == "http-index" || cfg.Type == "s3",
		}
		o.states = append(o.states, st)
		o.byID[cfg.ID] = st
	}
	return o, nil
}

// Changed returns a channel that receives a source id whenever its
// latest pointer or a run index was (re)written.
func (o *Orchestrator) Changed() <-chan string { return o.changed }

func (o *Orchestrator) notify(id string) {
	select {
	case o.changed <- id:
	default: // never block a fetch pass on a slow watcher
	}
}

// Status returns a snapshot of every source's fetch state.
func (o *Orchestrator) Status() map[string]SourceStatus {
	out := make(map[string]SourceStatus, len(o.states))
	for _, st := range o.states {
		st.mu.Lock()
		out[st.cfg.ID] = st.status
		st.mu.Unlock()
	}
	return out
}

// Run starts tickers for fetch:loop sources and a single pass for
// fetch:once sources; fetch:off sources are only read. It blocks until
// ctx is cancelled and all passes finished.
func (o *Orchestrator) Run(ctx context.Context) {
	var wg sync.WaitGroup
	for _, st := range o.states {
		switch st.cfg.Fetch {
		case "loop":
			wg.Add(1)
			go func(st *sourceState) {
				defer wg.Done()
				o.passLogged(ctx, st)
				t := time.NewTicker(st.cfg.Interval)
				defer t.Stop()
				for {
					select {
					case <-ctx.Done():
						return
					case <-t.C:
						o.passLogged(ctx, st)
					}
				}
			}(st)
		case "once":
			wg.Add(1)
			go func(st *sourceState) {
				defer wg.Done()
				o.passLogged(ctx, st)
			}(st)
		}
	}
	wg.Wait()
}

// RunOnce performs one pass for one source.
func (o *Orchestrator) RunOnce(ctx context.Context, id string) error {
	st, ok := o.byID[id]
	if !ok {
		return fmt.Errorf("sources: unknown source %q", id)
	}
	return o.pass(ctx, st)
}

func (o *Orchestrator) passLogged(ctx context.Context, st *sourceState) {
	if err := o.pass(ctx, st); err != nil && !errors.Is(err, context.Canceled) {
		slog.Warn("sources: fetch pass failed", "source", st.cfg.ID, "err", err)
	}
}

// pass is one full Discover -> download -> index -> latest -> prune
// cycle for one source. Failures are isolated per source; disk-full
// aborts the whole pass.
func (o *Orchestrator) pass(ctx context.Context, st *sourceState) error {
	st.passMu.Lock()
	defer st.passMu.Unlock()
	id := st.cfg.ID
	st.setFetching(true)
	defer st.setFetching(false)

	listings, err := st.src.Discover(ctx)
	if err != nil {
		st.fail(err)
		return err
	}
	if keep := st.cfg.KeepRuns; keep > 0 && len(listings) > keep {
		listings = listings[:keep] // newest first
	}

	var published []string
	var firstErr error
	for i, l := range listings {
		trackStatus := i == 0 // newest listing drives the status counters
		var runs []string
		var err error
		switch {
		case l.InPlace:
			runs, err = o.processInPlace(st, l, trackStatus)
		case l.Run.IsZero():
			runs, err = o.processUngrouped(ctx, st, l, trackStatus)
		default:
			runs, err = o.processRemote(ctx, st, l, trackStatus)
		}
		published = append(published, runs...)
		if err != nil {
			if isENOSPC(err) {
				st.fail(err)
				return err // disk-full aborts the whole pass
			}
			if firstErr == nil {
				firstErr = err
			}
		}
		if err := ctx.Err(); err != nil {
			st.fail(err)
			return err
		}
	}

	// Flip the latest pointer forward when a newer published run exists.
	best := ""
	for _, r := range published {
		if r > best {
			best = r
		}
	}
	if best != "" {
		cur, _ := o.buf.ReadLatest(id)
		if best > cur {
			if err := o.buf.WriteLatest(id, best); err != nil {
				if isENOSPC(err) {
					st.fail(err)
					return err
				}
				if firstErr == nil {
					firstErr = err
				}
			} else {
				o.notify(id)
			}
		}
	}

	// Prune old runs, never the run currently being fetched.
	protect := best
	if protect == "" && len(listings) > 0 && !listings[0].Run.IsZero() {
		protect = listings[0].Run.UTC().Format(buffer.RunIDFormat)
	}
	if err := o.buf.Prune(id, st.cfg.KeepRuns, protect); err != nil && firstErr == nil {
		firstErr = err
	}

	if firstErr != nil {
		st.fail(firstErr)
		return firstErr
	}
	st.succeed()
	return nil
}

// processRemote downloads a remote run's missing files with the worker
// pool, incrementally (re)indexes, and saves index.json.
func (o *Orchestrator) processRemote(ctx context.Context, st *sourceState, l RunListing, trackStatus bool) ([]string, error) {
	id := st.cfg.ID
	runID := l.Run.UTC().Format(buffer.RunIDFormat)
	runDir := o.buf.RunDir(id, l.Run)
	if err := os.MkdirAll(runDir, 0o755); err != nil {
		return nil, err
	}

	prev, _ := gribidx.Load(runDir)
	prevBy := map[string]gribidx.FileEntry{}
	if prev != nil {
		for _, fe := range prev.Files {
			prevBy[filepath.Base(fe.Path)] = fe
		}
	}

	dstFor := func(ref FileRef) string {
		if ref.Static {
			return filepath.Join(o.buf.StaticDir(id), ref.LocalName)
		}
		return filepath.Join(runDir, ref.LocalName)
	}

	// Diff against the buffer: missing = not present or size 0.
	var missing []FileRef
	nonStatic, present := 0, 0
	for _, ref := range l.Files {
		if !ref.Static {
			nonStatic++
		}
		if fileNonEmpty(dstFor(ref)) {
			if !ref.Static {
				present++
			}
			continue
		}
		missing = append(missing, ref)
	}
	if trackStatus {
		st.setProgress(runID, present, nonStatic)
	}

	failed, dlErr := o.download(ctx, st, missing, dstFor, trackStatus)
	if dlErr != nil && isENOSPC(dlErr) {
		return nil, dlErr
	}

	// Incremental index: keep prior FileEntry records for unchanged
	// files, scan only new/changed ones with the Var hint.
	var files []gribidx.FileEntry
	scannedNew, scanErrs, presentNow := 0, 0, 0
	for _, ref := range l.Files {
		if ref.Static {
			continue
		}
		p := dstFor(ref)
		fi, err := os.Stat(p)
		if err != nil || fi.Size() == 0 {
			continue
		}
		presentNow++
		if fe, ok := prevBy[ref.LocalName]; ok && fe.Size == fi.Size() && fe.MTime == fi.ModTime().Unix() {
			files = append(files, fe)
			continue
		}
		fe, err := gribidx.ScanFile(p, ref.Var)
		if err != nil {
			if isENOSPC(err) {
				return nil, err
			}
			slog.Warn("sources: index scan failed", "source", id, "file", p, "err", err)
			scanErrs++
			continue
		}
		files = append(files, *fe)
		scannedNew++
	}
	sortFileEntries(files)

	ri := &gribidx.RunIndex{
		Source:    id,
		Run:       l.Run.UTC(),
		Synthetic: l.Run.UTC().Before(gribidx.SyntheticCutoff),
		Complete:  l.Complete && failed == 0 && scanErrs == 0 && presentNow == nonStatic,
		Files:     files,
	}
	if !indexEqual(prev, ri) {
		if err := gribidx.Save(runDir, ri); err != nil {
			return nil, err
		}
		o.notify(id)
	}

	var published []string
	if o.hasHeadline(st, ri) {
		published = append(published, runID)
	}
	return published, dlErr
}

// processInPlace writes index.json for a folder run — the run dir holds
// only the index; the GRIB files stay where they live.
func (o *Orchestrator) processInPlace(st *sourceState, l RunListing, trackStatus bool) ([]string, error) {
	id := st.cfg.ID
	runID := l.Run.UTC().Format(buffer.RunIDFormat)
	runDir := o.buf.RunDir(id, l.Run)
	if err := os.MkdirAll(runDir, 0o755); err != nil {
		return nil, err
	}
	prev, _ := gribidx.Load(runDir)

	var files []gribidx.FileEntry
	if si, ok := st.src.(interface {
		ScannedIndex(run time.Time) []*gribidx.FileEntry
	}); ok {
		for _, fe := range si.ScannedIndex(l.Run) {
			files = append(files, *fe)
		}
	} else {
		// Fallback: scan each file, reusing prior entries when
		// size+mtime match.
		prevBy := map[string]gribidx.FileEntry{}
		if prev != nil {
			for _, fe := range prev.Files {
				prevBy[fe.Path] = fe
			}
		}
		for _, ref := range l.Files {
			fi, err := os.Stat(ref.URL)
			if err != nil {
				continue
			}
			if fe, ok := prevBy[ref.URL]; ok && fe.Size == fi.Size() && fe.MTime == fi.ModTime().Unix() {
				files = append(files, fe)
				continue
			}
			fe, err := gribidx.ScanFile(ref.URL, ref.Var)
			if err != nil {
				slog.Warn("sources: index scan failed", "source", id, "file", ref.URL, "err", err)
				continue
			}
			files = append(files, *fe)
		}
	}
	sortFileEntries(files)

	ri := &gribidx.RunIndex{
		Source:    id,
		Run:       l.Run.UTC(),
		Synthetic: l.Run.UTC().Before(gribidx.SyntheticCutoff),
		Complete:  l.Complete,
		Files:     files,
	}
	if trackStatus {
		st.setProgress(runID, len(files), len(files))
	}
	if !indexEqual(prev, ri) {
		if err := gribidx.Save(runDir, ri); err != nil {
			return nil, err
		}
		o.notify(id)
	}
	var published []string
	if o.hasHeadline(st, ri) {
		published = append(published, runID)
	}
	return published, nil
}

// processUngrouped handles http-index/s3 listings whose run is unknown
// before download: files land in {source}/incoming/, get header-scanned
// and grouped by reference time, then move (os.Rename) into their run
// dirs where per-run indexes are written.
func (o *Orchestrator) processUngrouped(ctx context.Context, st *sourceState, l RunListing, trackStatus bool) ([]string, error) {
	id := st.cfg.ID
	incoming := filepath.Join(o.buf.SourceDir(id), "incoming")
	if err := os.MkdirAll(incoming, 0o755); err != nil {
		return nil, err
	}

	// A file counts as already fetched when its LocalName exists in any
	// run dir (moved on a prior pass) or in incoming/.
	have := map[string]bool{}
	runs, _ := o.buf.ListRuns(id)
	for _, run := range runs {
		entries, err := os.ReadDir(o.buf.RunDirByID(id, run))
		if err != nil {
			continue
		}
		for _, e := range entries {
			if !e.IsDir() && e.Name() != gribidx.IndexFile {
				have[e.Name()] = true
			}
		}
	}

	var missing []FileRef
	done := 0
	for _, ref := range l.Files {
		if have[ref.LocalName] || fileNonEmpty(filepath.Join(incoming, ref.LocalName)) {
			done++
			continue
		}
		missing = append(missing, ref)
	}
	if trackStatus {
		st.setProgress("", done, len(l.Files))
	}
	dstFor := func(ref FileRef) string { return filepath.Join(incoming, ref.LocalName) }
	failed, dlErr := o.download(ctx, st, missing, dstFor, trackStatus)
	if dlErr != nil && isENOSPC(dlErr) {
		return nil, dlErr
	}

	// Header-scan everything sitting in incoming/ and group by ref time.
	var entries []*gribidx.FileEntry
	dirents, err := os.ReadDir(incoming)
	if err != nil {
		return nil, err
	}
	for _, e := range dirents {
		if e.IsDir() || strings.HasPrefix(e.Name(), ".part-") {
			continue
		}
		p := filepath.Join(incoming, e.Name())
		fe, err := gribidx.ScanFile(p, "")
		if err != nil {
			slog.Warn("sources: incoming scan failed", "source", id, "file", p, "err", err)
			continue
		}
		entries = append(entries, fe)
	}
	groups := groupByRef(entries)
	refs := make([]time.Time, 0, len(groups))
	for ref := range groups {
		refs = append(refs, ref)
	}
	sort.Slice(refs, func(i, j int) bool { return refs[i].After(refs[j]) })

	var published []string
	moved := map[string]string{} // incoming path -> final path
	for _, ref := range refs {
		runID := ref.Format(buffer.RunIDFormat)
		runDir := o.buf.RunDir(id, ref)
		if err := os.MkdirAll(runDir, 0o755); err != nil {
			return published, err
		}
		var files []gribidx.FileEntry
		newNames := map[string]bool{}
		for _, fe := range groups[ref] {
			final, ok := moved[fe.Path]
			if !ok {
				final = filepath.Join(runDir, filepath.Base(fe.Path))
				if err := os.Rename(fe.Path, final); err != nil {
					if isENOSPC(err) {
						return published, err
					}
					slog.Warn("sources: move into run dir failed", "source", id, "file", fe.Path, "err", err)
					continue
				}
				moved[fe.Path] = final
			}
			cp := *fe
			cp.Path = final
			files = append(files, cp)
			newNames[filepath.Base(final)] = true
		}
		// Merge with the run's existing index (files from prior passes).
		prev, _ := gribidx.Load(runDir)
		if prev != nil {
			for _, pfe := range prev.Files {
				if !newNames[filepath.Base(pfe.Path)] {
					files = append(files, pfe)
				}
			}
		}
		sortFileEntries(files)
		ri := &gribidx.RunIndex{
			Source:    id,
			Run:       ref,
			Synthetic: ref.Before(gribidx.SyntheticCutoff),
			Complete:  failed == 0,
			Files:     files,
		}
		if !indexEqual(prev, ri) {
			if err := gribidx.Save(runDir, ri); err != nil {
				return published, err
			}
			o.notify(id)
		}
		if o.hasHeadline(st, ri) {
			published = append(published, runID)
		}
	}
	return published, dlErr
}

// download fetches refs with a bounded worker pool through
// buffer.CreateAtomic (stream to .part-*, atomic rename). ENOSPC
// cancels the pool.
func (o *Orchestrator) download(ctx context.Context, st *sourceState, refs []FileRef, dstFor func(FileRef) string, trackStatus bool) (failed int, firstErr error) {
	if len(refs) == 0 {
		return 0, nil
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	sem := make(chan struct{}, downloadWorkers)
	var wg sync.WaitGroup
	var mu sync.Mutex
	for _, ref := range refs {
		wg.Add(1)
		go func(ref FileRef) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-sem }()
			err := o.downloadOne(ctx, st.src, ref, dstFor(ref))
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				failed++
				if firstErr == nil {
					firstErr = fmt.Errorf("download %s: %w", ref.URL, err)
				}
				st.recordError(err)
				if isENOSPC(err) {
					cancel()
				}
				return
			}
			if trackStatus && !ref.Static {
				st.incDone()
			}
		}(ref)
	}
	wg.Wait()
	return failed, firstErr
}

func (o *Orchestrator) downloadOne(ctx context.Context, src Source, ref FileRef, dst string) error {
	tmp, commit, err := buffer.CreateAtomic(dst)
	if err != nil {
		return err
	}
	if err := src.Fetch(ctx, ref, tmp); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	return commit()
}

// hasHeadline reports whether the run is published: the headline
// variable (t_2m or the first configured variable) is indexed — or,
// for generic sources without upstream naming, any message at all.
func (o *Orchestrator) hasHeadline(st *sourceState, ri *gribidx.RunIndex) bool {
	if st.generic {
		for _, fe := range ri.Files {
			if len(fe.Msgs) > 0 {
				return true
			}
		}
		return false
	}
	headline := "t_2m"
	if len(st.cfg.Variables) > 0 {
		headline = strings.ToLower(st.cfg.Variables[0])
	}
	for _, fe := range ri.Files {
		for _, m := range fe.Msgs {
			if m.Var == headline {
				return true
			}
		}
	}
	return false
}

func sortFileEntries(files []gribidx.FileEntry) {
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
}

// indexEqual reports whether saving ri over prev would be a no-op
// (same files by path/size/mtime/message count, same flags), so
// unchanged passes neither rewrite index.json nor emit change signals.
func indexEqual(prev, ri *gribidx.RunIndex) bool {
	if prev == nil {
		return false
	}
	if prev.Complete != ri.Complete || prev.Synthetic != ri.Synthetic || len(prev.Files) != len(ri.Files) {
		return false
	}
	pf := append([]gribidx.FileEntry(nil), prev.Files...)
	sortFileEntries(pf)
	for i, fe := range ri.Files {
		p := pf[i]
		if p.Path != fe.Path || p.Size != fe.Size || p.MTime != fe.MTime || len(p.Msgs) != len(fe.Msgs) {
			return false
		}
	}
	return true
}

func fileNonEmpty(path string) bool {
	fi, err := os.Stat(path)
	return err == nil && fi.Size() > 0
}

func isENOSPC(err error) bool {
	if errors.Is(err, syscall.ENOSPC) {
		return true
	}
	var pe *fs.PathError
	return errors.As(err, &pe) && errors.Is(pe.Err, syscall.ENOSPC)
}

// --- sourceState status helpers ---

func (st *sourceState) setFetching(v bool) {
	st.mu.Lock()
	st.status.Fetching = v
	st.mu.Unlock()
}

func (st *sourceState) setProgress(run string, done, total int) {
	st.mu.Lock()
	if run != "" {
		st.status.Run = run
	}
	st.status.FilesDone = done
	st.status.FilesTotal = total
	st.mu.Unlock()
}

func (st *sourceState) incDone() {
	st.mu.Lock()
	st.status.FilesDone++
	st.mu.Unlock()
}

func (st *sourceState) recordError(err error) {
	st.mu.Lock()
	st.status.LastError = err.Error()
	st.status.LastErrorAt = time.Now().UTC()
	st.mu.Unlock()
}

func (st *sourceState) fail(err error) {
	st.recordError(err)
}

func (st *sourceState) succeed() {
	st.mu.Lock()
	st.status.LastSuccess = time.Now().UTC()
	st.mu.Unlock()
}
