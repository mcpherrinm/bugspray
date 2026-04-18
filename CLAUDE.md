# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

ACME (RFC 8555) client written in client-side JavaScript, intended for learning the protocol and testing ACME servers. Per the README: "intended for testing only" — keys live in the browser via WebCrypto/localStorage; there is no backend, no build step, and no test suite.

## Running

There is no build system. Open `index.html` over an HTTP origin (e.g. `python3 -m http.server` from the repo root, then visit `http://localhost:8000`). Modules are loaded as native ES modules via `<script type="module">`, so `file://` will not work.

## Architecture

The app is four ES modules with no framework:

- **`storage.js`** — Persists a single `Map<url, object>` to `localStorage` under the `bugspray` key. Every ACME resource is keyed by its URL. An `object` has shape `{url, type, name, parent, resource, key}` where `type` ∈ {`directory`, `account`, `order`, `authorization`, `challenge`, `certificate`, `nonces`}, `parent` is the URL of the owning resource (forming a tree rooted at directories), `resource` is the JSON returned by the server, and `key` is the localStorage name of the signing key. The whole map is rewritten on every `setObject` — fine because the dataset is tiny.

- **`jws.js`** — WebCrypto wrapper for ES256 JWS signing. `newKey(name)` lazily generates a P-256 keypair and persists it to `localStorage` under `bugspray|key|<name>` (separate from the resource Map). `protect(key, kid, nonce, url)` builds the JWS protected header — passing `kid === null` embeds the public `jwk` (used for `newAccount` and certificate-key `revokeCert`); otherwise the `kid` (account URL) is used. `sign` produces the final JWS JSON. `thumbprint` computes the JWK SHA-256 thumbprint for key authorizations.

- **`nav.js`** — Renders the left treeview from `listObjects()`, parenting each item under the entry whose URL matches its `parent` field. Clicking a label calls `renderObject(url, object)` from `ui.js`. Note: `nav.js` and `ui.js` import each other — works because both imports are functions consumed at call time.

- **`ui.js`** — Everything else: the right-pane renderers (`renderDirectory`, `renderAccount`, `renderOrder`, `renderAuthorization`, `renderChallenge`, `renderCertificate`, `renderNonces`), the request flow, and the in-memory nonce pool. Helper builders (`div`, `element`, `input`, `select`, `multi`, `checkbox`, `goButton`, `copiable`) are defined at the top — prefer reusing them over hand-rolling DOM.

### Request flow

User clicks a method button → `runMethod(method, directory, signer)` builds a form via the per-method helper (`newAccount`, `newOrder`, etc.), which returns a `getData()` closure → on submit, `poster(data)` shows the protected header + signed body in editable textareas → `submit(...)` POSTs to the ACME server, captures the `Location` header as the new resource's URL, stores it via `setObject`, and runs the per-method `callback` (e.g. `newOrder`'s callback creates child `authorization` and `certificate` objects so they appear in the tree). `newNonce` and `renewalInfo` bypass `poster` because they aren't authenticated POSTs. Every response is fed through `gotNonce(headers, directoryUrl)` to harvest `Replay-Nonce`.

### Nonce pool

`noncePools` is an in-memory `{directoryUrl: [{nonce, timestamp}, ...]}` mirrored to `Storage` as a synthetic `nonces`-typed object at `${directoryUrl}/nonces` so the pool appears in the treeview. `getNonce` pops; `gotNonce` pushes. On startup `setup()` rehydrates the pool from storage, migrating any legacy string-only entries to `{nonce, timestamp: null}`.

### Object tree shape

Directory → Account → Order → Authorization → Challenge, plus Certificate hanging off Order. The `parent` field is what makes the treeview work — when adding new resource creation paths, set `parent` correctly or the item will end up at the root with a console warning from `nav.js`.
