# ACME bugspray

This is an ACME client in client-side Javascript, intended to be used as part
of learning the ACME protocol, and testing ACME servers.

It is currently unfinished.

Also I don't know Javascript, so it's probably bad.

## Security

This application is intended for testing only.

All keys live in the user's browser, are generated with WebCrypto, and stored
in IndexDB. This is intended for testing only, so there's no facility for long
term storage of credentials unless the user does so manually.

