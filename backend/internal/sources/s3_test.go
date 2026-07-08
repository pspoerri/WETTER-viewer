package sources

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/pspoerri/grib-viewer/internal/config"
)

func TestParseS3URL(t *testing.T) {
	cases := []struct {
		in, endpoint, prefix string
		ok                   bool
	}{
		{"s3://my-bucket/some/prefix", "https://my-bucket.s3.us-east-1.amazonaws.com", "some/prefix", true},
		{"s3://my-bucket", "https://my-bucket.s3.us-east-1.amazonaws.com", "", true},
		{"https://my-bucket.s3.eu-central-1.amazonaws.com/gribs/", "https://my-bucket.s3.eu-central-1.amazonaws.com", "gribs/", true},
		{"s3://", "", "", false},
		{"ftp://host/x", "", "", false},
	}
	for _, c := range cases {
		ep, pfx, err := parseS3URL(c.in)
		if (err == nil) != c.ok {
			t.Errorf("%s: err=%v want ok=%v", c.in, err, c.ok)
			continue
		}
		if err == nil && (ep != c.endpoint || pfx != c.prefix) {
			t.Errorf("%s: got (%s, %s) want (%s, %s)", c.in, ep, pfx, c.endpoint, c.prefix)
		}
	}
}

func TestS3DiscoverPaginated(t *testing.T) {
	fastRetries(t)
	const page1 = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>bucket</Name>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>tok-2</NextContinuationToken>
  <Contents><Key>gribs/run1/a.grib2</Key><Size>100</Size></Contents>
  <Contents><Key>gribs/run1/b.grib2.bz2</Key><Size>50</Size></Contents>
  <Contents><Key>gribs/run1/readme.txt</Key><Size>5</Size></Contents>
</ListBucketResult>`
	const page2 = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>bucket</Name>
  <IsTruncated>false</IsTruncated>
  <Contents><Key>gribs/run2/c.grb2</Key><Size>10</Size></Contents>
</ListBucketResult>`

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if q.Get("list-type") != "2" || q.Get("prefix") != "gribs/" {
			http.Error(w, fmt.Sprintf("bad query: %s", r.URL.RawQuery), 400)
			return
		}
		switch q.Get("continuation-token") {
		case "":
			w.Write([]byte(page1))
		case "tok-2":
			w.Write([]byte(page2))
		default:
			http.Error(w, "bad token", 400)
		}
	}))
	defer srv.Close()

	src, err := newS3Source(config.Source{ID: "archive", Type: "s3", URL: srv.URL + "/gribs/"})
	if err != nil {
		t.Fatalf("newS3Source: %v", err)
	}
	listings, err := src.Discover(context.Background())
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	if len(listings) != 1 || !listings[0].Run.IsZero() {
		t.Fatalf("expected one zero-run listing, got %+v", listings)
	}
	files := listings[0].Files
	if len(files) != 3 {
		t.Fatalf("expected 3 grib files (txt filtered), got %d: %+v", len(files), files)
	}
	if files[0].URL != srv.URL+"/gribs/run1/a.grib2" {
		t.Fatalf("bad URL: %s", files[0].URL)
	}
	if files[0].LocalName != "run1__a.grib2" {
		t.Fatalf("bad LocalName: %s", files[0].LocalName)
	}
	if files[1].LocalName != "run1__b.grib2" { // .bz2 stripped
		t.Fatalf("bad LocalName for bz2: %s", files[1].LocalName)
	}
	if files[2].LocalName != "run2__c.grb2" {
		t.Fatalf("bad LocalName page 2: %s", files[2].LocalName)
	}
}
