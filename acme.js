import {getOrCreateKey, protect, sign, thumbprint} from "./jws.js";

/**
 * @typedef {import("./browserEnv.js").Env} Env
 * @typedef {import("./storage.js").StoredObject} StoredObject
 * @typedef {import("./storage.js").ObjectStore} ObjectStore
 * @typedef {import("./jws.js").JwsProtected} JwsProtected
 */

/**
 * @typedef {Object} NonceEntry
 * @property {string} nonce
 * @property {number | null} timestamp
 */

/** Sentinel returned by NoncePool.take() when the pool is empty. */
export const NO_NONCE_SENTINEL = "no-nonces-run-new-nonce";

/** Builds the storage URL for a directory's nonce pool. */
export function nonceStorageUrl(/** @type {string} */ directoryUrl) {
    return `${directoryUrl}/nonces`;
}

/**
 * Per-directory pool of replay nonces, mirrored to the ObjectStore so it shows
 * up in the treeview and survives reloads. Persistence shape stays as a
 * `nonces`-typed StoredObject with `{resource: {nonces: NonceEntry[]}}`.
 */
export class NoncePool {
    /**
     * @param {Env} env
     * @param {string} directoryUrl
     * @param {NonceEntry[]} entries
     */
    constructor(env, directoryUrl, entries) {
        /** @type {Env} */
        this.env = env;
        this.directoryUrl = directoryUrl;
        /** @type {NonceEntry[]} */
        this.entries = entries;
    }

    /**
     * Hydrate from the ObjectStore, migrating any legacy string-only entries.
     * @param {Env} env
     * @param {string} directoryUrl
     * @returns {NoncePool}
     */
    static load(env, directoryUrl) {
        const stored = env.objectStore.get(nonceStorageUrl(directoryUrl));
        const raw = (stored && stored.resource && Array.isArray(stored.resource.nonces))
            ? stored.resource.nonces : [];
        const entries = raw.map(/** @returns {NonceEntry} */ (n) =>
            typeof n === 'string' ? {nonce: n, timestamp: null} : n
        );
        return new NoncePool(env, directoryUrl, entries);
    }

    /** @param {string} nonce @param {number} [timestamp] */
    add(nonce, timestamp = Date.now()) {
        this.entries.push({nonce, timestamp});
        this.persist();
    }

    /**
     * Pull a nonce out of the pool. Returns the sentinel if empty so callers
     * still send a request and get a fresh nonce in the response headers.
     * @returns {string}
     */
    take() {
        if (this.entries.length === 0) {
            return NO_NONCE_SENTINEL;
        }
        const entry = this.entries.pop();
        this.persist();
        return entry.nonce;
    }

    /** @param {string} nonce */
    delete(nonce) {
        const idx = this.entries.findIndex(e => e.nonce === nonce);
        if (idx >= 0) {
            this.entries.splice(idx, 1);
            this.persist();
            return true;
        }
        return false;
    }

    persist() {
        this.env.objectStore.put({
            url: nonceStorageUrl(this.directoryUrl),
            type: 'nonces',
            name: `Nonce Pool (${this.entries.length})`,
            parent: this.directoryUrl,
            resource: {nonces: this.entries},
        });
    }

    /**
     * Harvest a Replay-Nonce header into the pool, if present.
     * @param {Headers} headers
     */
    captureFromHeaders(headers) {
        const nonce = headers.get('replay-nonce');
        if (nonce !== null) {
            this.add(nonce);
        }
    }
}

/** @type {Map<string, Map<string, NoncePool>>} */
const poolRegistries = new Map();

/**
 * Get-or-create the NoncePool for a (env, directoryUrl) pair. Pools are
 * memoized per Env so multiple consumers in the same process share state.
 * @param {Env} env
 * @param {string} directoryUrl
 * @returns {NoncePool}
 */
export function getNoncePool(env, directoryUrl) {
    let perEnv = poolRegistries.get(/** @type {any} */ (env));
    if (!perEnv) {
        perEnv = new Map();
        poolRegistries.set(/** @type {any} */ (env), perEnv);
    }
    let pool = perEnv.get(directoryUrl);
    if (!pool) {
        pool = NoncePool.load(env, directoryUrl);
        perEnv.set(directoryUrl, pool);
    }
    return pool;
}

/** Reset every pool registry — for tests and "Clear Storage". */
export function resetNoncePools() {
    poolRegistries.clear();
}

/**
 * Snapshot a `Headers` object as an array of [name, value] pairs for storage.
 * (Headers#entries() is missing from some TS lib targets; iterate manually.)
 * @param {Headers} headers
 * @returns {Array<[string, string]>}
 */
function headersToArray(headers) {
    /** @type {Array<[string, string]>} */
    const out = [];
    headers.forEach((value, key) => out.push([key, value]));
    return out;
}

/**
 * Walk parent chain from the given URL up to the directory.
 * @param {ObjectStore} store
 * @param {string} url
 * @returns {string | null}
 */
function findDirectoryUrl(store, url) {
    let cur = store.get(url);
    let here = url;
    while (cur && cur.type !== 'directory') {
        here = cur.parent;
        cur = store.get(here);
    }
    return cur ? cur.url : null;
}

/**
 * Default JSON body parser. Subclasses override `static ingest` when the wire
 * format isn't JSON (notably `AcmeCertificate`). Takes already-read text so
 * the network layer can capture the raw body for display before parsing.
 * @param {string} text
 * @param {string | null} _contentType
 */
function defaultIngest(text, _contentType) {
    return text === '' ? null : JSON.parse(text);
}

/**
 * @typedef {Object} BuildSignedOpts
 * @property {Env} env
 * @property {string} url
 * @property {string} key - keystore name to sign with
 * @property {string | null} kid - account URL, or null to embed jwk
 * @property {string} nonce
 * @property {object | string} payload
 */

/**
 * @typedef {Object} BuildSignedResult
 * @property {JwsProtected} protectedData
 * @property {string} signedBody
 */

/**
 * Build the JWS protected header + signed body for a request, without sending.
 * Used by the requester UI to live-update the editable preview as the form
 * changes.
 * @param {BuildSignedOpts} opts
 * @returns {Promise<BuildSignedResult>}
 */
export async function buildSigned({env, url, key: keyName, kid, nonce, payload}) {
    const key = await getOrCreateKey(env.keyStore, env.subtle, keyName);
    const protectedData = await protect(env.subtle, key, kid, nonce, url);
    const signedBody = await sign(env.subtle, key, protectedData, payload);
    return {protectedData, signedBody};
}

/**
 * @typedef {Object} SubmitOpts
 * @property {Env} env
 * @property {string} url - target POST URL (may differ from the URL inside the signed protected header — caller's choice)
 * @property {string} signedBody
 * @property {string} type - storage type for the resulting object
 * @property {string} parent
 * @property {string} [name]
 * @property {string} [key] - signing key name to persist alongside the resource
 * @property {string} [directoryUrl] - directory whose nonce pool gets the next replay-nonce
 * @property {(text: string, contentType: string | null) => any} [ingest]
 * @property {(resource: any, targetUrl: string) => void} [postProcess]
 */

/**
 * @typedef {Object} SubmitResult
 * @property {boolean} ok
 * @property {Response} response
 * @property {string} targetUrl
 * @property {any} resource
 * @property {import("./storage.js").HttpRequestRecord} lastRequest
 * @property {import("./storage.js").HttpResponseRecord} lastResponse
 */

/**
 * POST a signed JWS body, capture the exchange, parse the body via the type's
 * ingest, and persist on success. The captured `lastRequest`/`lastResponse`
 * are returned so callers can render them in the response panel.
 * @param {SubmitOpts} opts
 * @returns {Promise<SubmitResult>}
 */
export async function submitSigned(opts) {
    const {env, url, signedBody, type, parent, name = '', key: keyName} = opts;
    const Cls = TYPE_REGISTRY[type];
    const ingest = opts.ingest || (Cls ? Cls.ingest : defaultIngest);
    const directoryUrl = opts.directoryUrl || findDirectoryUrl(env.objectStore, parent) || parent;
    const pool = getNoncePool(env, directoryUrl);

    const reqHeaders = {'Content-Type': 'application/jose+json'};
    const lastRequest = {method: 'POST', url, headers: reqHeaders, body: signedBody};

    const response = await env.fetch(url, {method: 'POST', headers: reqHeaders, body: signedBody});
    pool.captureFromHeaders(response.headers);

    const respText = await response.text();
    const contentType = response.headers.get('Content-Type');
    const lastResponse = {
        status: response.status,
        statusText: response.statusText,
        headers: headersToArray(response.headers),
        body: respText,
        contentType,
    };

    const targetUrl = response.headers.get('Location') || url;
    let resource = null;
    if (response.ok) {
        resource = ingest(respText, contentType);
        env.objectStore.put({
            url: targetUrl, type, name, parent,
            resource, key: keyName, lastRequest, lastResponse,
        });
        if (opts.postProcess) opts.postProcess(resource, targetUrl);
    }

    return {ok: response.ok, response, targetUrl, resource, lastRequest, lastResponse};
}

/**
 * @typedef {Object} PostSignedOpts
 * @property {Env} env
 * @property {string} url
 * @property {string} key
 * @property {string | null} kid
 * @property {object | string} payload
 * @property {string} type
 * @property {string} parent
 * @property {string} [name]
 * @property {(text: string, contentType: string | null) => any} [ingest]
 * @property {(resource: any, targetUrl: string) => void} [postProcess]
 */

/**
 * Convenience wrapper: take a nonce, build the signed body, submit, persist.
 * Used by class methods (AcmeDirectory.newOrder etc.) when the caller doesn't
 * need to expose the intermediate signed body for editing.
 * @param {PostSignedOpts} opts
 * @returns {Promise<SubmitResult>}
 */
export async function postSigned(opts) {
    const {env, url, key: keyName, kid, payload, type, parent, name = ''} = opts;
    const directoryUrl = findDirectoryUrl(env.objectStore, parent) || parent;
    const pool = getNoncePool(env, directoryUrl);
    const nonce = pool.take();
    const {signedBody} = await buildSigned({env, url, key: keyName, kid, nonce, payload});
    return await submitSigned({
        env, url, signedBody, type, parent, name, key: keyName,
        directoryUrl, ingest: opts.ingest, postProcess: opts.postProcess,
    });
}

// ---------------------------------------------------------------------------
// AcmeObject hierarchy
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ChildRef
 * @property {string} url
 * @property {string} label
 */

/**
 * Base class for every ACME resource (directory, account, order, etc.).
 * Subclasses override `displayFields`, `children`, `methodNames`, `ingest`, etc.
 */
export class AcmeObject {
    /** @param {StoredObject} stored @param {Env} env */
    constructor(stored, env) {
        this.stored = stored;
        this.env = env;
    }

    get url() { return this.stored.url; }
    get type() { return this.stored.type; }
    get name() { return this.stored.name; }
    get parent() { return this.stored.parent; }
    get resource() { return this.stored.resource; }
    get keyName() { return this.stored.key; }

    /**
     * Parse a raw response body into a JSON-serializable resource.
     * @param {string} text
     * @param {string | null} contentType
     * @returns {any}
     */
    static ingest(text, contentType) { return defaultIngest(text, contentType); }

    /** Walk parent chain to find the owning directory URL. */
    get directoryUrl() {
        let url = this.url;
        let cur = this.env.objectStore.get(url);
        while (cur && cur.type !== 'directory') {
            url = cur.parent;
            cur = this.env.objectStore.get(url);
        }
        return cur ? cur.url : null;
    }

    /** Walk parent chain to find the owning account URL (if any). */
    get accountUrl() {
        let url = this.url;
        let cur = this.env.objectStore.get(url);
        while (cur && cur.type !== 'account') {
            url = cur.parent;
            cur = this.env.objectStore.get(url);
        }
        return cur ? cur.url : null;
    }

    /** @returns {Array<[string, string]>} */
    displayFields() { return []; }

    /** @returns {ChildRef[]} */
    children() { return []; }

    /** @returns {string[]} */
    methodNames() { return []; }

    /**
     * Whether a given method should be enabled in the UI. Default: true.
     * Subclasses override to consult the directory for support.
     * @param {string} _name
     * @returns {boolean}
     */
    methodEnabled(_name) { return true; }

    /**
     * Called after a reload/update succeeds, to stitch any referenced child
     * resources into the object store. Default: noop.
     * @param {any} resource
     * @param {string} targetUrl
     */
    postReload(resource, targetUrl) { /* override */ }

    /**
     * POST-as-GET to refresh the resource.
     */
    reload() {
        const Cls = /** @type {any} */ (this.constructor);
        return postSigned({
            env: this.env,
            url: this.url,
            key: this.keyName || '',
            kid: this.accountUrl,
            payload: '',
            type: this.type,
            parent: this.parent,
            ingest: Cls.ingest,
            postProcess: (resource, targetUrl) => this.postReload(resource, targetUrl),
        });
    }
}

/** ACME account (RFC 8555 §7.1.2). */
export class AcmeAccount extends AcmeObject {
    displayFields() {
        const r = this.resource || {};
        /** @type {Array<[string, string]>} */
        const fields = [];
        for (const f of ['status', 'termsOfServiceAgreed', 'orders']) {
            if (r[f] !== undefined) fields.push([f, String(r[f])]);
        }
        if (Array.isArray(r.contact)) fields.push(['contact', r.contact.join(', ')]);
        return fields;
    }

    methodNames() {
        return ['newNonce', 'newOrder', 'newAuthz', 'revokeCert', 'keyChange'];
    }

    methodEnabled(name) {
        const dir = this.env.objectStore.get(this.directoryUrl || '');
        return !!(dir && dir.resource && dir.resource[name] !== undefined);
    }
}

/** ACME order (RFC 8555 §7.1.3). */
export class AcmeOrder extends AcmeObject {
    displayFields() {
        const r = this.resource || {};
        /** @type {Array<[string, string]>} */
        const fields = [];
        for (const f of ['status', 'expires', 'notBefore', 'notAfter', 'finalize', 'certificate']) {
            if (r[f] !== undefined) fields.push([f, String(r[f])]);
        }
        if (Array.isArray(r.identifiers)) {
            fields.push(['identifiers', r.identifiers.map(/** @param {any} i */ i => `${i.type}:${i.value}`).join(', ')]);
        }
        if (r.error) fields.push(['error', JSON.stringify(r.error)]);
        return fields;
    }

    children() {
        const r = this.resource || {};
        /** @type {ChildRef[]} */
        const out = [];
        if (Array.isArray(r.authorizations)) {
            for (const u of r.authorizations) out.push({url: u, label: 'authorization'});
        }
        if (r.certificate) out.push({url: r.certificate, label: 'certificate'});
        return out;
    }

    methodNames() { return ['finalize']; }

    postReload(resource, targetUrl) {
        if (!resource) return;
        if (Array.isArray(resource.authorizations)) {
            for (const authzUrl of resource.authorizations) {
                if (this.env.objectStore.get(authzUrl)) continue;
                this.env.objectStore.put({
                    url: authzUrl, type: 'authorization', name: '',
                    parent: targetUrl, resource: null, key: this.keyName,
                });
            }
        }
        if (resource.certificate && !this.env.objectStore.get(resource.certificate)) {
            this.env.objectStore.put({
                url: resource.certificate, type: 'certificate', name: '',
                parent: targetUrl, resource: null, key: this.keyName,
            });
        }
    }

    /**
     * Accepts a PEM-encoded CSR or base64url-encoded DER. Returns base64url DER.
     * @param {string} csr
     */
    static normalizeCsr(csr) {
        let v = csr.trim();
        if (v.startsWith('-----BEGIN')) {
            v = v
                .replace(/-----BEGIN CERTIFICATE REQUEST-----/g, '')
                .replace(/-----END CERTIFICATE REQUEST-----/g, '')
                .replace(/\s+/g, '');
            v = v.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
        }
        return v;
    }

    /**
     * @param {string} csr
     */
    finalize(csr) {
        return postSigned({
            env: this.env,
            url: this.resource.finalize,
            key: this.keyName || '',
            kid: this.accountUrl,
            payload: {csr: AcmeOrder.normalizeCsr(csr)},
            type: 'order',
            parent: this.parent,
            postProcess: (resource, targetUrl) => this.postReload(resource, targetUrl),
        });
    }
}

/** ACME authorization (RFC 8555 §7.1.4). */
export class AcmeAuthorization extends AcmeObject {
    displayFields() {
        const r = this.resource || {};
        /** @type {Array<[string, string]>} */
        const fields = [];
        for (const f of ['status', 'expires', 'wildcard']) {
            if (r[f] !== undefined) fields.push([f, String(r[f])]);
        }
        if (r.identifier) fields.push(['identifier', `${r.identifier.type}:${r.identifier.value}`]);
        return fields;
    }

    children() {
        const r = this.resource || {};
        /** @type {ChildRef[]} */
        const out = [];
        if (Array.isArray(r.challenges)) {
            for (const ch of r.challenges) out.push({url: ch.url, label: ch.type});
        }
        return out;
    }

    postReload(resource, targetUrl) {
        if (!resource || !Array.isArray(resource.challenges)) return;
        for (const ch of resource.challenges) {
            if (this.env.objectStore.get(ch.url)) continue;
            this.env.objectStore.put({
                url: ch.url, type: 'challenge', name: '',
                parent: targetUrl, resource: null, key: this.keyName,
            });
        }
    }
}

/**
 * @typedef {Object} ChallengeInstruction
 * @property {string} [text]
 * @property {string} [copiable]
 */

/** ACME challenge (RFC 8555 §8). */
export class AcmeChallenge extends AcmeObject {
    displayFields() {
        const r = this.resource || {};
        /** @type {Array<[string, string]>} */
        const fields = [];
        for (const f of ['type', 'status', 'token', 'validated']) {
            if (r[f] !== undefined) fields.push([f, String(r[f])]);
        }
        if (r.error) fields.push(['error', JSON.stringify(r.error)]);
        return fields;
    }

    methodNames() { return ['respond']; }

    /** Look up the authorization's domain (identifier.value). */
    get authzDomain() {
        const authz = this.env.objectStore.get(this.parent);
        return authz?.resource?.identifier?.value || '<domain>';
    }

    /** Compute token.thumbprint. */
    async keyAuthorization() {
        if (!this.keyName) return null;
        const key = await getOrCreateKey(this.env.keyStore, this.env.subtle, this.keyName);
        const thumb = await thumbprint(this.env.subtle, key);
        return `${this.resource.token}.${thumb}`;
    }

    /**
     * Per-challenge-type instructions as a list of paragraphs and copiable strings.
     * UI renders; CLI could log. Pure data, no DOM.
     * @returns {Promise<ChallengeInstruction[]>}
     */
    async instructions() {
        const r = this.resource || {};
        const domain = this.authzDomain;

        if (r.type === 'dns-persist-01') {
            const dir = this.env.objectStore.get(this.directoryUrl || '');
            const caaIdentities = dir?.resource?.meta?.caaIdentities;
            const caDomain = (caaIdentities && caaIdentities.length > 0) ? caaIdentities[0] : '<ca-caa-domain>';
            const accountUri = this.accountUrl || '<account-uri>';
            const authz = this.env.objectStore.get(this.parent);
            const isWildcard = authz?.resource?.wildcard === true;
            let value = `${caDomain}; accounturi=${accountUri}`;
            if (isWildcard) value += '; policy=wildcard';
            return [
                {text: 'Create a persistent TXT record (does not need to change between renewals):'},
                {copiable: `_validation-persist.${domain}`},
                {text: 'Value:'},
                {copiable: value},
            ];
        }

        if (!this.keyName || !r.token) return [];

        const keyAuthz = await this.keyAuthorization();
        if (!keyAuthz) return [];

        if (r.type === 'http-01') {
            return [
                {text: 'Serve the following at:'},
                {copiable: `http://${domain}/.well-known/acme-challenge/${r.token}`},
                {text: 'Content:'},
                {copiable: keyAuthz},
            ];
        }

        if (r.type === 'dns-01' || r.type === 'dns-account-01') {
            const b64Val = await sha256b64url(this.env.subtle, keyAuthz);
            return [
                {text: 'Create a TXT record:'},
                {copiable: `_acme-challenge.${domain}`},
                {text: 'Value:'},
                {copiable: b64Val},
            ];
        }

        if (r.type === 'tls-alpn-01') {
            const hexVal = await sha256hex(this.env.subtle, keyAuthz);
            return [
                {text: 'Serve a TLS connection on port 443 with ALPN protocol "acme-tls/1". The certificate must have:'},
                {text: 'Subject Alternative Name (dNSName):'},
                {copiable: domain},
                {text: 'A critical ACME extension (OID 1.3.6.1.5.5.7.1.31) containing an ASN.1 DER-encoded OctetString of the SHA-256 digest of the key authorization:'},
                {copiable: hexVal},
            ];
        }

        return [
            {text: 'Key Authorization:'},
            {copiable: keyAuthz},
        ];
    }

    respond() {
        return postSigned({
            env: this.env,
            url: this.url,
            key: this.keyName || '',
            kid: this.accountUrl,
            payload: {},
            type: this.type,
            parent: this.parent,
        });
    }
}

/**
 * Split a PEM bundle into an array of individual certificate blocks.
 * @param {string} pem
 */
export function splitPemChain(pem) {
    const matches = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    return matches ? matches : [];
}

/**
 * @typedef {Object} LinkHeader
 * @property {string} url
 * @property {Record<string, string>} params
 */

/**
 * Parse a set of HTTP response headers (as stored in HttpResponseRecord) into
 * RFC 8288 Link entries. Handles multiple Link-header rows and comma-separated
 * values within one row. Unrecognized entries are silently skipped.
 * @param {Array<[string, string]>} headers
 * @returns {LinkHeader[]}
 */
export function parseLinkHeaders(headers) {
    /** @type {LinkHeader[]} */
    const out = [];
    for (const [name, value] of headers) {
        if (name.toLowerCase() !== 'link') continue;
        // Split on commas that precede a `<…>` target, so commas inside quoted
        // params stay with their entry.
        const parts = value.split(/,(?=\s*<)/);
        for (const part of parts) {
            const m = part.match(/<([^>]+)>\s*(.*)/);
            if (!m) continue;
            /** @type {Record<string, string>} */
            const params = {};
            const pm = m[2].matchAll(/;\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*=\s*(?:"([^"]*)"|([^;\s]*))/g);
            for (const match of pm) {
                params[match[1].toLowerCase()] = match[2] !== undefined ? match[2] : match[3];
            }
            out.push({url: m[1], params});
        }
    }
    return out;
}

/** ACME certificate (RFC 8555 §7.4.2). Wire format is application/pem-certificate-chain. */
export class AcmeCertificate extends AcmeObject {
    /**
     * @param {string} text
     * @param {string | null} _contentType
     */
    static ingest(text, _contentType) {
        return {pem: text, chain: splitPemChain(text)};
    }

    displayFields() {
        const r = this.resource || {};
        /** @type {Array<[string, string]>} */
        const fields = [];
        if (Array.isArray(r.chain)) fields.push(['chain length', String(r.chain.length)]);
        return fields;
    }

    /**
     * Alternate-chain URLs from the last fetch's Link: rel="alternate" headers
     * (RFC 8555 §7.4.2). Empty if the cert hasn't been fetched or the server
     * advertised no alternates.
     * @returns {string[]}
     */
    alternateLinks() {
        const headers = this.stored.lastResponse?.headers;
        if (!headers) return [];
        return parseLinkHeaders(headers)
            .filter(l => l.params.rel === 'alternate')
            .map(l => l.url);
    }
}

/**
 * @param {SubtleCrypto} subtle
 * @param {string} input
 */
async function sha256b64url(subtle, input) {
    const digest = await subtle.digest("SHA-256", new TextEncoder().encode(input));
    const bytes = new Uint8Array(digest);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * @param {SubtleCrypto} subtle
 * @param {string} input
 */
async function sha256hex(subtle, input) {
    const digest = await subtle.digest("SHA-256", new TextEncoder().encode(input));
    const bytes = new Uint8Array(digest);
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The ACME directory resource (RFC 8555 §7.1.1). Owns the URLs of all the
 * top-level operations and is the entry point for newAccount/newOrder/etc.
 */
export class AcmeDirectory extends AcmeObject {
    displayFields() {
        /** @type {Array<[string, string]>} */
        const fields = [];
        const meta = this.resource?.meta || {};
        for (const [k, v] of Object.entries(meta)) {
            fields.push([k, JSON.stringify(v, null, 2)]);
        }
        return fields;
    }

    methodNames() {
        return ['newNonce', 'newAccount', 'newOrder', 'newAuthz',
                'revokeCert', 'keyChange', 'renewalInfo'];
    }

    methodEnabled(name) {
        return !!(this.resource && this.resource[name] !== undefined);
    }

    /** Directories aren't authenticated; use a plain GET. */
    async reload() {
        const lastRequest = {method: 'GET', url: this.url, headers: {}, body: ''};
        const response = await this.env.fetch(this.url);
        const respText = await response.text();
        const contentType = response.headers.get('Content-Type');
        const lastResponse = {
            status: response.status, statusText: response.statusText,
            headers: headersToArray(response.headers),
            body: respText, contentType,
        };
        let resource = null;
        if (response.ok) {
            resource = JSON.parse(respText);
            this.env.objectStore.put({...this.stored, resource, lastRequest, lastResponse});
        }
        return {ok: response.ok, response, targetUrl: this.url, resource, lastRequest, lastResponse};
    }

    /**
     * Plain GET to the newNonce endpoint, harvesting the response header.
     * @returns {Promise<string | null>} the nonce captured, or null if missing
     */
    async newNonce() {
        const response = await this.env.fetch(this.resource.newNonce);
        const nonce = response.headers.get('replay-nonce');
        if (nonce !== null) {
            getNoncePool(this.env, this.url).add(nonce);
        }
        return nonce;
    }

    /**
     * @param {object} payload - {termsOfServiceAgreed, contact, onlyReturnExisting}
     * @param {string} keyName
     */
    newAccount(payload, keyName) {
        return postSigned({
            env: this.env,
            url: this.resource.newAccount,
            key: keyName,
            kid: null, // embed jwk
            payload,
            type: 'account',
            parent: this.url,
        });
    }

    /**
     * @param {object} payload - {identifiers, profile?, notBefore?, notAfter?}
     * @param {string} keyName
     * @param {string} accountUrl
     */
    newOrder(payload, keyName, accountUrl) {
        return postSigned({
            env: this.env,
            url: this.resource.newOrder,
            key: keyName,
            kid: accountUrl,
            payload,
            type: 'order',
            parent: accountUrl,
            postProcess: (resource, targetUrl) => {
                if (Array.isArray(resource.authorizations)) {
                    for (const authzUrl of resource.authorizations) {
                        if (this.env.objectStore.get(authzUrl)) continue;
                        this.env.objectStore.put({
                            url: authzUrl, type: 'authorization', name: '',
                            parent: targetUrl, resource: null, key: keyName,
                        });
                    }
                }
                if (resource.certificate && !this.env.objectStore.get(resource.certificate)) {
                    this.env.objectStore.put({
                        url: resource.certificate, type: 'certificate', name: '',
                        parent: targetUrl, resource: null, key: keyName,
                    });
                }
            },
        });
    }

    /**
     * @param {object} payload
     * @param {string} keyName
     * @param {string} accountUrl
     */
    newAuthz(payload, keyName, accountUrl) {
        return postSigned({
            env: this.env,
            url: this.resource.newAuthz,
            key: keyName,
            kid: accountUrl,
            payload,
            type: 'authorization',
            parent: accountUrl,
        });
    }
}

/** @type {Record<string, typeof AcmeObject>} */
const TYPE_REGISTRY = {
    directory: AcmeDirectory,
    account: AcmeAccount,
    order: AcmeOrder,
    authorization: AcmeAuthorization,
    challenge: AcmeChallenge,
    certificate: AcmeCertificate,
};

/**
 * Map a StoredObject to its AcmeObject subclass instance. Migrates legacy
 * certificate `{value, contentType}` payloads to `{pem, chain}` in place.
 * @param {StoredObject} stored
 * @param {Env} env
 * @returns {AcmeObject}
 */
export function fromStored(stored, env) {
    if (stored.type === 'certificate' && stored.resource
        && typeof stored.resource === 'object'
        && 'value' in stored.resource && !('pem' in stored.resource)) {
        const pem = String(stored.resource.value);
        const migrated = {pem, chain: splitPemChain(pem)};
        const fixed = {...stored, resource: migrated};
        env.objectStore.put(fixed);
        return new AcmeCertificate(fixed, env);
    }
    const Cls = TYPE_REGISTRY[stored.type] || AcmeObject;
    return new (/** @type {any} */ (Cls))(stored, env);
}

// re-export jws helpers so consumers only need to import acme.js
export {getOrCreateKey, protect, sign, thumbprint};
