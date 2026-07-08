package sources

import (
	"compress/bzip2"
	"context"
	"fmt"
	"hash/fnv"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/pspoerri/grib-viewer/internal/buffer"
	"github.com/pspoerri/grib-viewer/internal/config"
	"github.com/pspoerri/grib-viewer/internal/gribidx"
)

// folderSource watches a local run-output directory. No filename
// convention is assumed: Discover scans every GRIB file's message
// headers (cached by size+mtime) and groups messages into runs by
// reference time. The scan results are cached so the orchestrator's
// index step (via ScannedIndex) never scans twice.
type folderSource struct {
	id   string
	path string
	// inflateDir caches inflated copies of .bz2 files (gribidx cannot
	// index compressed data). Set by the orchestrator to
	// buffer.SourceDir(id)/inflated; when empty, .bz2 files are skipped.
	inflateDir string

	mu      sync.Mutex
	scanned map[string]*folderScanRec
	groups  map[time.Time][]*gribidx.FileEntry
}

type folderScanRec struct {
	size  int64
	mtime int64
	entry *gribidx.FileEntry
}

func newFolderSource(cfg config.Source) *folderSource {
	return &folderSource{
		id:      cfg.ID,
		path:    cfg.Path,
		scanned: map[string]*folderScanRec{},
	}
}

func (s *folderSource) ID() string { return s.id }

// Fetch copies a local file (bz2-inflated) — normally unused because
// folder runs are indexed in place.
func (s *folderSource) Fetch(ctx context.Context, ref FileRef, dst io.Writer) error {
	f, err := os.Open(ref.URL)
	if err != nil {
		return err
	}
	defer f.Close()
	var src io.Reader = f
	if strings.HasSuffix(strings.ToLower(ref.URL), ".bz2") {
		src = bzip2.NewReader(f)
	}
	_, err = io.Copy(dst, src)
	return err
}

// Discover walks the folder, scans changed files, and returns one
// in-place RunListing per distinct reference time, newest first.
func (s *folderSource) Discover(ctx context.Context) ([]RunListing, error) {
	var entries []*gribidx.FileEntry
	seen := map[string]bool{}
	err := filepath.WalkDir(s.path, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if !isGribName(p) {
			return nil
		}
		target := p
		if strings.HasSuffix(strings.ToLower(p), ".bz2") {
			t, err := s.inflate(p)
			if err != nil {
				slog.Warn("folder: skip bz2 file", "source", s.id, "file", p, "err", err)
				return nil
			}
			target = t
		}
		fe, err := s.scanCached(target)
		if err != nil {
			slog.Warn("folder: skip unreadable GRIB file", "source", s.id, "file", target, "err", err)
			return nil
		}
		seen[target] = true
		entries = append(entries, fe)
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("folder %s: %w", s.id, err)
	}

	groups := groupByRef(entries)
	s.mu.Lock()
	s.groups = groups
	for p := range s.scanned {
		if !seen[p] {
			delete(s.scanned, p)
		}
	}
	s.mu.Unlock()

	refs := make([]time.Time, 0, len(groups))
	for ref := range groups {
		refs = append(refs, ref)
	}
	sort.Slice(refs, func(i, j int) bool { return refs[i].After(refs[j]) }) // newest first

	out := make([]RunListing, 0, len(refs))
	for _, ref := range refs {
		var files []FileRef
		for _, fe := range groups[ref] {
			files = append(files, FileRef{URL: fe.Path})
		}
		out = append(out, RunListing{
			Run:      ref,
			Files:    files,
			Complete: true, // a folder is what it is
			InPlace:  true,
		})
	}
	return out, nil
}

// ScannedIndex returns the cached per-run scan results of the last
// Discover pass. The orchestrator type-asserts for this so in-place
// runs are never scanned twice.
func (s *folderSource) ScannedIndex(run time.Time) []*gribidx.FileEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.groups[run.UTC()]
}

// scanCached indexes path unless size+mtime match the cached entry.
func (s *folderSource) scanCached(path string) (*gribidx.FileEntry, error) {
	st, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	rec := s.scanned[path]
	s.mu.Unlock()
	if rec != nil && rec.size == st.Size() && rec.mtime == st.ModTime().Unix() {
		return rec.entry, nil
	}
	fe, err := gribidx.ScanFile(path, "")
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.scanned[path] = &folderScanRec{size: fe.Size, mtime: fe.MTime, entry: fe}
	s.mu.Unlock()
	return fe, nil
}

// inflate decompresses a .bz2 file into the sibling cache once,
// returning the inflated path. Re-inflates when the source is newer
// than the cached copy.
func (s *folderSource) inflate(src string) (string, error) {
	if s.inflateDir == "" {
		return "", fmt.Errorf("no inflate cache dir configured")
	}
	st, err := os.Stat(src)
	if err != nil {
		return "", err
	}
	h := fnv.New32a()
	h.Write([]byte(src))
	name := strings.TrimSuffix(filepath.Base(src), ".bz2")
	dst := filepath.Join(s.inflateDir, fmt.Sprintf("%08x-%s", h.Sum32(), name))
	if dstSt, err := os.Stat(dst); err == nil && dstSt.Size() > 0 && !dstSt.ModTime().Before(st.ModTime()) {
		return dst, nil
	}
	f, err := os.Open(src)
	if err != nil {
		return "", err
	}
	defer f.Close()
	tmp, commit, err := buffer.CreateAtomic(dst)
	if err != nil {
		return "", err
	}
	if _, err := io.Copy(tmp, bzip2.NewReader(f)); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return "", err
	}
	if err := commit(); err != nil {
		return "", err
	}
	return dst, nil
}

// groupByRef splits scanned files into runs by message reference time.
// A file whose messages carry several reference times contributes a
// filtered FileEntry (same path/size/mtime, only the matching messages)
// to each run.
func groupByRef(files []*gribidx.FileEntry) map[time.Time][]*gribidx.FileEntry {
	out := map[time.Time][]*gribidx.FileEntry{}
	for _, fe := range files {
		byRef := map[time.Time][]gribidx.Msg{}
		var order []time.Time
		for _, m := range fe.Msgs {
			ref := m.Ref.UTC()
			if _, ok := byRef[ref]; !ok {
				order = append(order, ref)
			}
			byRef[ref] = append(byRef[ref], m)
		}
		for _, ref := range order {
			out[ref] = append(out[ref], &gribidx.FileEntry{
				Path:  fe.Path,
				Size:  fe.Size,
				MTime: fe.MTime,
				Msgs:  byRef[ref],
			})
		}
	}
	return out
}
