package sources

import (
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"net/url"
	"strings"

	"github.com/pspoerri/grib-viewer/internal/config"
)

// s3Source lists a public S3 bucket prefix via anonymous ListObjectsV2
// (GET ?list-type=2&prefix=) and returns a single zero-run listing —
// the same download-scan-group flow as http-index. No AWS SDK.
//
// cfg.URL accepts s3://bucket/prefix (resolved to the us-east-1
// virtual-hosted endpoint) or an https endpoint + prefix
// (https://bucket.s3.region.amazonaws.com/prefix or any S3-compatible
// virtual-hosted-style endpoint).
type s3Source struct {
	id       string
	endpoint string // scheme://host, no trailing slash
	prefix   string
}

func newS3Source(cfg config.Source) (*s3Source, error) {
	endpoint, prefix, err := parseS3URL(cfg.URL)
	if err != nil {
		return nil, fmt.Errorf("sources: %s: %w", cfg.ID, err)
	}
	return &s3Source{id: cfg.ID, endpoint: endpoint, prefix: prefix}, nil
}

func parseS3URL(raw string) (endpoint, prefix string, err error) {
	if rest, ok := strings.CutPrefix(raw, "s3://"); ok {
		bucket, pfx, _ := strings.Cut(rest, "/")
		if bucket == "" {
			return "", "", fmt.Errorf("s3 url %q has no bucket", raw)
		}
		return fmt.Sprintf("https://%s.s3.us-east-1.amazonaws.com", bucket), pfx, nil
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", "", fmt.Errorf("bad s3 url %q: %w", raw, err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", "", fmt.Errorf("s3 url %q: unsupported scheme %q", raw, u.Scheme)
	}
	return u.Scheme + "://" + u.Host, strings.TrimPrefix(u.Path, "/"), nil
}

func (s *s3Source) ID() string { return s.id }

func (s *s3Source) Fetch(ctx context.Context, ref FileRef, dst io.Writer) error {
	return fetchURL(ctx, defaultClient, ref.URL, dst)
}

// s3ListResult is the minimal ListObjectsV2 XML response subset.
type s3ListResult struct {
	XMLName               xml.Name `xml:"ListBucketResult"`
	IsTruncated           bool     `xml:"IsTruncated"`
	NextContinuationToken string   `xml:"NextContinuationToken"`
	Contents              []struct {
		Key  string `xml:"Key"`
		Size int64  `xml:"Size"`
	} `xml:"Contents"`
}

func (s *s3Source) Discover(ctx context.Context) ([]RunListing, error) {
	var files []FileRef
	cont := ""
	for {
		q := url.Values{}
		q.Set("list-type", "2")
		q.Set("prefix", s.prefix)
		if cont != "" {
			q.Set("continuation-token", cont)
		}
		body, err := getBody(ctx, defaultClient, s.endpoint+"/?"+q.Encode())
		if err != nil {
			return nil, fmt.Errorf("s3 %s: list: %w", s.id, err)
		}
		var res s3ListResult
		if err := xml.Unmarshal(body, &res); err != nil {
			return nil, fmt.Errorf("s3 %s: parse list response: %w", s.id, err)
		}
		for _, o := range res.Contents {
			if !isGribName(o.Key) {
				continue
			}
			files = append(files, FileRef{
				URL:       s.endpoint + "/" + escapeS3Key(o.Key),
				LocalName: pathLocalName("/"+o.Key, "/"+s.prefix),
			})
		}
		if !res.IsTruncated || res.NextContinuationToken == "" {
			break
		}
		cont = res.NextContinuationToken
		if len(files) > 1_000_000 {
			return nil, fmt.Errorf("s3 %s: refusing to list >1M keys under %s", s.id, s.prefix)
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
	}
	return []RunListing{{Files: files, Complete: true}}, nil // Run zero: grouped after download
}

// escapeS3Key percent-encodes key segments while keeping the "/"
// separators literal.
func escapeS3Key(k string) string {
	parts := strings.Split(k, "/")
	for i, p := range parts {
		parts[i] = url.PathEscape(p)
	}
	return strings.Join(parts, "/")
}
