package sources

import (
	"bytes"
	"compress/bzip2"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// Shared fetch plumbing (spec 01): one tuned http.Client, 4-attempt
// retry with exponential backoff and ±50% jitter, bz2 inflation when
// a URL ends .bz2, and 4xx-terminal (except 408/429) discrimination.

const userAgent = "grib-viewer/0.1 (+https://github.com/pspoerri/grib-viewer)"

// downloadMaxAttempts is the retry budget for transient failures.
const downloadMaxAttempts = 4

// baseRetryDelay is the initial backoff delay. A var so tests can
// shrink it.
var baseRetryDelay = 1 * time.Second

// newHTTPClient returns a client tuned for parallel GRIB downloads.
// The default Go transport caps connections per host at 2, which
// throttles the 8-worker download pool; the 5-minute timeout covers
// the largest published GRIB2 files.
func newHTTPClient() *http.Client {
	transport := &http.Transport{
		Proxy:               http.ProxyFromEnvironment,
		MaxIdleConns:        128,
		MaxIdleConnsPerHost: 8,
		MaxConnsPerHost:     8,
		IdleConnTimeout:     90 * time.Second,
		ForceAttemptHTTP2:   true,
	}
	return &http.Client{Timeout: 5 * time.Minute, Transport: transport}
}

// defaultClient is shared by every adapter so connection pooling works
// across sources hitting the same host.
var defaultClient = newHTTPClient()

// httpStatusError carries the remote status for 4xx/5xx discrimination.
type httpStatusError struct {
	Status int
	URL    string
	Body   string
}

func (e *httpStatusError) Error() string {
	if e.Body == "" {
		return fmt.Sprintf("%s returned HTTP %d", e.URL, e.Status)
	}
	b := e.Body
	if len(b) > 200 {
		b = b[:200] + "..."
	}
	return fmt.Sprintf("%s returned HTTP %d: %s", e.URL, e.Status, b)
}

// isTerminal reports whether err should not be retried: any 4xx except
// 408 (request timeout) and 429 (too many requests).
func isTerminal(err error) bool {
	var se *httpStatusError
	if errors.As(err, &se) && se.Status >= 400 && se.Status < 500 {
		return se.Status != http.StatusRequestTimeout && se.Status != http.StatusTooManyRequests
	}
	return false
}

// partialError marks a failure that happened after bytes were already
// written to the destination — retrying would duplicate output, so
// withRetry treats it as terminal and unwraps it.
type partialError struct{ err error }

func (e *partialError) Error() string { return e.err.Error() }
func (e *partialError) Unwrap() error { return e.err }

// retrySleep waits delay ±50% jitter, honoring ctx cancellation.
func retrySleep(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		delay = time.Millisecond
	}
	d := delay/2 + time.Duration(rand.Int64N(int64(delay)))
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(d):
		return nil
	}
}

// withRetry runs fn up to downloadMaxAttempts times with exponential
// backoff from baseRetryDelay. Terminal 4xx and partial writes abort
// immediately.
func withRetry(ctx context.Context, desc string, fn func() error) error {
	var lastErr error
	delay := baseRetryDelay
	for attempt := 1; attempt <= downloadMaxAttempts; attempt++ {
		err := fn()
		if err == nil {
			return nil
		}
		var pe *partialError
		if errors.As(err, &pe) {
			return pe.err
		}
		if isTerminal(err) {
			return err
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		lastErr = err
		if attempt == downloadMaxAttempts {
			break
		}
		if err := retrySleep(ctx, delay); err != nil {
			return err
		}
		delay *= 2
	}
	return fmt.Errorf("%s after %d attempts: %w", desc, downloadMaxAttempts, lastErr)
}

// fetchOnce performs a single GET and streams the body into w,
// bz2-inflating when the URL ends .bz2.
func fetchOnce(ctx context.Context, client *http.Client, url string, w io.Writer) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", userAgent)
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return &httpStatusError{Status: resp.StatusCode, URL: url, Body: string(body)}
	}
	var src io.Reader = resp.Body
	if strings.HasSuffix(strings.ToLower(url), ".bz2") {
		src = bzip2.NewReader(resp.Body)
	}
	_, err = io.Copy(w, src)
	return err
}

type countingWriter struct {
	w io.Writer
	n int64
}

func (c *countingWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.n += int64(n)
	return n, err
}

// fetchURL streams url into dst with retries. Once any bytes reached
// dst a failure is terminal (the caller must restart with a fresh
// destination); before that, transient errors are retried.
func fetchURL(ctx context.Context, client *http.Client, url string, dst io.Writer) error {
	cw := &countingWriter{w: dst}
	return withRetry(ctx, "fetch "+url, func() error {
		start := cw.n
		err := fetchOnce(ctx, client, url, cw)
		if err != nil && cw.n > start {
			return &partialError{err}
		}
		return err
	})
}

// getBody GETs url into memory (listings, JSON) with retries.
func getBody(ctx context.Context, client *http.Client, url string) ([]byte, error) {
	var out []byte
	err := withRetry(ctx, "get "+url, func() error {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return err
		}
		req.Header.Set("User-Agent", userAgent)
		resp, err := client.Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return &httpStatusError{Status: resp.StatusCode, URL: url, Body: string(body)}
		}
		if readErr != nil {
			return readErr
		}
		out = body
		return nil
	})
	return out, err
}

// doJSON issues method+url (with optional JSON request body) and
// decodes the JSON response into out, with retries.
func doJSON(ctx context.Context, client *http.Client, method, url string, reqBody []byte, out any) error {
	return withRetry(ctx, method+" "+url, func() error {
		var r io.Reader
		if reqBody != nil {
			r = bytes.NewReader(reqBody)
		}
		req, err := http.NewRequestWithContext(ctx, method, url, r)
		if err != nil {
			return err
		}
		req.Header.Set("User-Agent", userAgent)
		if reqBody != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := client.Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
			return &httpStatusError{Status: resp.StatusCode, URL: url, Body: string(body)}
		}
		return json.NewDecoder(resp.Body).Decode(out)
	})
}

// hrefAttrRE pulls href values out of an Apache mod_autoindex page.
var hrefAttrRE = regexp.MustCompile(`href="([^"]+)"`)

// parseHrefs extracts href attribute values from an autoindex HTML
// listing, skipping parent links and sort-query links.
func parseHrefs(html []byte) []string {
	var out []string
	for _, m := range hrefAttrRE.FindAllSubmatch(html, -1) {
		h := string(m[1])
		if h == "" || h == "../" || strings.HasPrefix(h, "?") || strings.HasPrefix(h, "#") {
			continue
		}
		out = append(out, h)
	}
	return out
}

// isGribName reports whether a path looks like a GRIB file we handle:
// *.grib2 | *.grb2 | *.grib | *.bz2.
func isGribName(p string) bool {
	l := strings.ToLower(p)
	return strings.HasSuffix(l, ".grib2") || strings.HasSuffix(l, ".grb2") ||
		strings.HasSuffix(l, ".grib") || strings.HasSuffix(l, ".bz2")
}
