# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

ACME (RFC 8555) client written in client-side JavaScript, intended for learning the protocol and testing ACME servers. Per the README: "intended for testing only"; keys live in the browser via WebCrypto/localStorage. No build step — `index.html` loads the modules directly.

## Commands

- `bun test` — run `acme.test.js` (pure-logic coverage for the `acme.js` domain).
- `bun run typecheck` — JSDoc-driven typecheck via `bunx tsc` against `jsconfig.json`. `noImplicitAny` and `strictNullChecks` are off so legacy DOM code in `ui.js`/`nav.js` passes without full annotation; new files in `acme.js` etc. carry JSDoc types for editor help.
- `bun run cli.js <directory-url>` — Node/Bun smoke test that fetches a directory and prints metadata, writing state to `./bugspray-state.json`.
- Browser: serve the repo over HTTP (e.g. `python3 -m http.server`) and open `index.html`. `file://` will not work — the modules need a real origin.

## Architecture

Four layers, all ES modules with no framework:

```
ui.js, nav.js   ← browser DOM (also: cli.js for Node)
     │
     ▼
  acme.js       ← domain: AcmeObject + Directory/Account/Order/
                  Authorization/Challenge/Certificate, NoncePool, postSigned
     │               │
     ▼               ▼
  jws.js         Env typedef (objectStore, keyStore, fetch, subtle)
  (pure crypto)       │
                ┌─────┴─────┐
                ▼           ▼
         browserEnv.js   nodeEnv.js
         (localStorage)  (JSON file)
```

- **`acme.js`** owns every ACME resource as a JSDoc-typed ES6 class. Each subclass provides `displayFields()`, `children()`, `methodNames()`, and — when the wire format isn't JSON — a `static ingest(response)`. `AcmeCertificate.ingest` parses `application/pem-certificate-chain` into `{pem, chain}`; the storage contract is therefore "`resource` is always JSON-serializable", with no content-type sniffing in the network layer. `fromStored` dispatches stored objects to the right class and migrates any legacy `{value, contentType}` certificate payloads in place.
- **`postSigned`** (in `acme.js`) is the single chokepoint for ACME-authenticated requests: it pulls a nonce from the directory's `NoncePool`, signs with `jws.js`, optionally routes through a `ConfirmHook` for preview/edit, POSTs, captures the reply nonce, and persists the response. The `ConfirmHook` is how `ui.js` keeps the "show protected/signed JSON before sending" UX without leaking DOM into `acme.js`.
- **`NoncePool`** is one-per-directory, memoized in an in-process registry, and mirrored to the `ObjectStore` as a synthetic `${directoryUrl}/nonces` entry (unchanged wire shape, so old localStorage works). `NoncePool.load` tolerates and migrates pre-timestamp string entries.
- **`storage.js`** persists a single `Map<url, StoredObject>` to `localStorage` under `bugspray`. `createObjectStore()` returns the `ObjectStore` typedef consumed by `acme.js`, so that module never imports `storage.js` directly.
- **`jws.js`** takes `SubtleCrypto` and a `KeyStore` as explicit parameters — no `window` references — so it works under both the browser (`buildBrowserEnv`) and Bun (`buildNodeEnv`). `kid === null` embeds the public `jwk` (used for `newAccount` and certificate-key `revokeCert`); otherwise the account URL goes into `kid`.
- **`ui.js`** owns layout only. It renders each object through a generic renderer (`displayFields` / `children` / `methodNames`) plus a small specialized renderer that consumes `AcmeChallenge.instructions()`. The `directory` page has its own renderer because of the meta + two-row method grid layout. Method dispatch (`dispatchObjectMethod`) branches on type: directory/account methods invoke `runMethod` (form-builder UI → `AcmeDirectory.newFoo(...)`), `AcmeOrder.finalize` opens a CSR form, `AcmeChallenge.respond` goes straight to the preview.

### Object tree and `parent`

Directory → Account → Order → Authorization → Challenge, with Certificate hanging off Order. The `parent` field in every `StoredObject` is what drives both the treeview (`nav.js`) and the `directoryUrl` / `accountUrl` walks in `AcmeObject`. If you add a resource type, set `parent` correctly or the item ends up at the root and `nav.js` logs a warning.

### Request flow end-to-end

1. User clicks a method button on a directory or account page.
2. `runMethod` builds the form via a per-method helper (`newAccountForm`, `newOrderForm`, …) that returns a `getData()` closure yielding the request payload.
3. On submit, `runMethod` calls `dirObj.newFoo(payload, keyName, accountUrl, {confirm: showPreviewAndAwaitSubmit})`.
4. `postSigned` signs → `ConfirmHook` renders the preview (editable protected/signed textareas) and resolves on submit-click with the (possibly edited) signed body → `env.fetch` POSTs → `NoncePool.captureFromHeaders` harvests the next nonce → response body goes through `AcmeFoo.ingest` → the stored object is written and any per-class `postProcess` stitches child stubs into the tree (`newOrder` creates authz + cert children; `authorization.reload` creates challenge children; etc.).

Reloading any existing object (the "Reload" button on each page) calls `obj.reload({confirm})`, which uses the object's static `ingest` and its per-class `postReload` hook. There is exactly one POST-and-persist path; the content-type branch from the old `submit` is gone.
