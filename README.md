# ACME bugspray
Interactive ACME client, intended for testing

## Architecture

There are two parts to this:

The backend is a small Go application which proxies ACME requests, as well as
serving the Web UI. It can serve HTTP-01 challenges on behalf of the frontend.
An example configuration proxying to a local copy of Pebble is provided.

The frontend is a Javascript ACME client, intended for interactive use. It can
be used standalone to talk directly to an ACME server, or can have its requests
proxied through the backend.

## Security

This application is intended for testing only.

All keys live in the user's browser, are generated with WebCrypto, and stored
in IndexDB. This is intended for testing only, so there's no facility for long
term storage of credentials unless the user does so manually.

