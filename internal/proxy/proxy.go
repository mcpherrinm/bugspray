// Package proxy is an ACME server proxy.
package proxy

import (
	"crypto/tls"
	"net/http"
	"net/http/httputil"
	"net/url"
)

// New returns a proxy that will proxy ACME requests to the target server.
func New(target *url.URL, insecureSkipVerify bool) httputil.ReverseProxy {
	return httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(target)
			r.Out.Host = r.In.Host
		},
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{
				InsecureSkipVerify: insecureSkipVerify,
			},
		},
	}
}
