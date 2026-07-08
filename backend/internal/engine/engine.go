// Package engine derives fields online from buffered GRIB (spec 02):
// decode via go-tiled-eccodes, region render, ensemble reduction,
// derived variables — all behind byte-budgeted caches.
package engine

import (
	"container/list"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	grib "github.com/pspoerri/go-tiled-eccodes"

	"github.com/pspoerri/grib-viewer/internal/buffer"
	"github.com/pspoerri/grib-viewer/internal/gribidx"
)

type Engine struct {
	buf *buffer.Buffer

	mu    sync.Mutex
	files map[string]*fileEntry // open mmap'd GRIB files, LRU
	flist *list.List            // fileEntry LRU order (front = recent)
	hcs   map[string]*grib.HorizontalConstants

	views  sync.Map // "source|runID" -> *runView
	planes *planeCache
	regIdx *regionIdxCache
	sf     *singleflight

	maxOpenFiles int
}

type fileEntry struct {
	path   string
	f      *grib.File
	el     *list.Element
	refs   int  // in-flight users; guarded by Engine.mu
	doomed bool // evicted/invalidated; Close when refs drops to 0
}

func New(buf *buffer.Buffer, fieldsMB int) *Engine {
	if fieldsMB <= 0 {
		fieldsMB = 4096
	}
	return &Engine{
		buf:          buf,
		files:        map[string]*fileEntry{},
		flist:        list.New(),
		hcs:          map[string]*grib.HorizontalConstants{},
		planes:       newPlaneCache(int64(fieldsMB) << 20),
		regIdx:       newRegionIdxCache(64),
		sf:           newSingleflight(),
		maxOpenFiles: 512,
	}
}

// InvalidateSource drops cached run views and the horizontal-constants
// catalogue for a source (new data landed; statics may have appeared).
func (e *Engine) InvalidateSource(source string) {
	e.views.Range(func(k, _ any) bool {
		if strings.HasPrefix(k.(string), source+"|") {
			e.views.Delete(k)
		}
		return true
	})
	e.mu.Lock()
	delete(e.hcs, source)
	// Open files attached coordinates at open time; drop them all so
	// late-arriving statics take effect (reopen is a cheap mmap).
	// In-flight renders hold references; the munmap waits for them.
	for path, fe := range e.files {
		e.flist.Remove(fe.el)
		delete(e.files, path)
		e.doomLocked(fe)
	}
	e.mu.Unlock()
}

// acquireFile returns an open (mmap'd) GRIB file with icosahedral
// coordinates attached, keeping an LRU of open files. The caller MUST
// release() the entry when done — eviction/invalidation only munmaps
// once no render is in flight. The shared HorizontalConstants
// catalogue means the mesh KD-tree is built once per source and
// reused across every file/member/step.
func (e *Engine) acquireFile(source, path string) (*fileEntry, error) {
	e.mu.Lock()
	if fe, ok := e.files[path]; ok {
		e.flist.MoveToFront(fe.el)
		fe.refs++
		e.mu.Unlock()
		return fe, nil
	}
	e.mu.Unlock()

	f, err := grib.Open(path)
	if err != nil {
		return nil, err
	}
	if hc := e.horizontalConstants(source); hc != nil {
		if _, err := f.AttachCoordinates(hc); err != nil {
			f.Close()
			return nil, fmt.Errorf("attach coordinates %s: %w", path, err)
		}
	}

	e.mu.Lock()
	defer e.mu.Unlock()
	if fe, ok := e.files[path]; ok { // lost the race
		f.Close()
		e.flist.MoveToFront(fe.el)
		fe.refs++
		return fe, nil
	}
	fe := &fileEntry{path: path, f: f, refs: 1}
	fe.el = e.flist.PushFront(fe)
	e.files[path] = fe
	for len(e.files) > e.maxOpenFiles {
		back := e.flist.Back()
		old := back.Value.(*fileEntry)
		e.flist.Remove(back)
		delete(e.files, old.path)
		e.doomLocked(old)
	}
	return fe, nil
}

// release drops one reference; doomed entries close on the last drop.
func (e *Engine) release(fe *fileEntry) {
	e.mu.Lock()
	fe.refs--
	closeNow := fe.doomed && fe.refs <= 0
	e.mu.Unlock()
	if closeNow {
		fe.f.Close()
	}
}

func (e *Engine) doomLocked(fe *fileEntry) {
	fe.doomed = true
	if fe.refs <= 0 {
		fe.f.Close()
	}
}

// horizontalConstants lazily loads and caches the per-source
// icosahedral coordinate catalogue from the buffer's static dir.
// Multiple constant files (DWD ships clat + clon separately) are
// concatenated — GRIB messages are self-delimiting.
func (e *Engine) horizontalConstants(source string) *grib.HorizontalConstants {
	e.mu.Lock()
	defer e.mu.Unlock()
	if hc, ok := e.hcs[source]; ok {
		return hc
	}
	dir := e.buf.StaticDir(source)
	entries, err := os.ReadDir(dir)
	if err != nil {
		e.hcs[source] = nil
		return nil
	}
	var blob []byte
	for _, ent := range entries {
		name := strings.ToLower(ent.Name())
		if !strings.HasSuffix(name, ".grib2") && !strings.HasSuffix(name, ".grb2") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, ent.Name()))
		if err == nil {
			blob = append(blob, raw...)
		}
	}
	if len(blob) == 0 {
		e.hcs[source] = nil
		return nil
	}
	hc, err := grib.LoadHorizontalConstantsFromBytes(blob)
	if err != nil {
		e.hcs[source] = nil
		return nil
	}
	e.hcs[source] = hc
	return hc
}

// ---- run views ----

// msgKey addresses one (canonical var, valid time) group of messages.
type planeMsgs struct {
	// member -> location; det planes use member key -1
	byMember map[int]msgLoc
}

type msgLoc struct {
	Path string
	Msg  int
}

type runView struct {
	RunView
	// canonical var -> valid unix -> members
	planes map[string]map[int64]*planeMsgs
}

// View loads (cached) the queryable view of a run. runID "" or
// "latest" resolves the latest pointer.
func (e *Engine) View(source, runID string) (*runView, error) {
	if runID == "" || runID == "latest" {
		var err error
		runID, err = e.buf.ReadLatest(source)
		if err != nil {
			return nil, fmt.Errorf("no runs for %s", source)
		}
	}
	key := source + "|" + runID
	if v, ok := e.views.Load(key); ok {
		return v.(*runView), nil
	}
	v, err, _ := e.sf.do(key, func() (any, error) {
		ri, err := gribidx.Load(e.buf.RunDirByID(source, runID))
		if err != nil {
			return nil, err
		}
		return buildView(source, runID, ri), nil
	})
	if err != nil {
		return nil, err
	}
	rv := v.(*runView)
	e.views.Store(key, rv)
	return rv, nil
}

// canonicalVar composes the catalog id from an indexed message: hints
// that already carry a suffix pass through; header-named vars gain
// level suffixes ({v}_{n}m for height-above-ground, {v}_{n}hpa
// isobaric, {v}_l{n} soil).
func canonicalVar(m gribidx.Msg) string {
	v := strings.ToLower(m.Var)
	if strings.ContainsRune(v, '_') { // adapter hints are already canonical
		return v
	}
	switch m.LevelType {
	case 103:
		if m.Level > 0 {
			return fmt.Sprintf("%s_%dm", v, m.Level)
		}
	case 100:
		return fmt.Sprintf("%s_%dhpa", v, m.Level)
	case 106:
		return fmt.Sprintf("%s_l%d", v, m.Level)
	}
	return v
}

func buildView(source, runID string, ri *gribidx.RunIndex) *runView {
	rv := &runView{
		RunView: RunView{
			Source:    source,
			RunID:     runID,
			Run:       ri.Run,
			Synthetic: ri.Synthetic,
			Complete:  ri.Complete,
			Vars:      map[string]*VarInfo{},
		},
		planes: map[string]map[int64]*planeMsgs{},
	}
	for fi := range ri.Files {
		fe := &ri.Files[fi]
		for _, m := range fe.Msgs {
			name := canonicalVar(m)
			byTime, ok := rv.planes[name]
			if !ok {
				byTime = map[int64]*planeMsgs{}
				rv.planes[name] = byTime
			}
			ts := m.Valid.Unix()
			pm, ok := byTime[ts]
			if !ok {
				pm = &planeMsgs{byMember: map[int]msgLoc{}}
				byTime[ts] = pm
			}
			pm.byMember[m.Member] = msgLoc{Path: fe.Path, Msg: m.Msg}
			vi, ok := rv.Vars[name]
			if !ok {
				vi = &VarInfo{Name: name, LevelType: m.LevelType, Level: m.Level}
				rv.Vars[name] = vi
			}
		}
	}
	for name, byTime := range rv.planes {
		vi := rv.Vars[name]
		maxMembers := 0
		steps := make([]time.Time, 0, len(byTime))
		for ts, pm := range byTime {
			steps = append(steps, time.Unix(ts, 0).UTC())
			n := 0
			for mem := range pm.byMember {
				if mem >= 0 {
					n++
				}
			}
			if n > maxMembers {
				maxMembers = n
			}
		}
		sort.Slice(steps, func(i, j int) bool { return steps[i].Before(steps[j]) })
		vi.Steps = steps
		vi.Members = maxMembers
	}
	return rv
}

// Runs lists buffered run IDs for a source, newest first.
func (e *Engine) Runs(source string) ([]string, error) { return e.buf.ListRuns(source) }

// ---- tiny singleflight (stdlib-only) ----

type singleflight struct {
	mu sync.Mutex
	m  map[string]*sfCall
}

type sfCall struct {
	wg  sync.WaitGroup
	val any
	err error
}

func newSingleflight() *singleflight { return &singleflight{m: map[string]*sfCall{}} }

func (s *singleflight) do(key string, fn func() (any, error)) (any, error, bool) {
	s.mu.Lock()
	if c, ok := s.m[key]; ok {
		s.mu.Unlock()
		c.wg.Wait()
		return c.val, c.err, true
	}
	c := &sfCall{}
	c.wg.Add(1)
	s.m[key] = c
	s.mu.Unlock()

	c.val, c.err = fn()
	c.wg.Done()

	s.mu.Lock()
	delete(s.m, key)
	s.mu.Unlock()
	return c.val, c.err, false
}
