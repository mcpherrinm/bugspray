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
 * Hook used to preview / edit the signed JWS body before it goes on the wire.
 * The default (when omitted) just returns the original signed body.
 * @callback ConfirmHook
 * @param {{protectedData: JwsProtected, defaultSigned: string, msg: object|string, url: string}} preview
 * @returns {Promise<string | null>} body to POST, or null to cancel
 */

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
 * Parse an HTTP response into a JSON-serializable resource. Default behavior:
 * `application/json` → `response.json()`, otherwise wrap as `{value, contentType}`.
 * Subclass-specific parsers (notably `AcmeCertificate.ingest`) replace this in step 7.
 * @param {Response} response
 */
async function defaultIngest(response) {
    const contentType = response.headers.get('Content-Type');
    if (contentType === 'application/json') {
        return await response.json();
    }
    const text = await response.text();
    return {value: text, contentType};
}

/**
 * @typedef {Object} PostSignedOpts
 * @property {Env} env
 * @property {string} url - target POST URL
 * @property {string} key - keystore name to sign with
 * @property {string | null} kid - account URL, or null to embed jwk
 * @property {object | string} payload - request body (object → JSON-encoded; "" → POST-as-GET)
 * @property {string} type - storage type for the resulting object
 * @property {string} parent - storage parent URL
 * @property {string} [name]
 * @property {(response: Response) => Promise<any>} [ingest]
 * @property {(resource: any, targetUrl: string) => void} [postProcess]
 * @property {ConfirmHook} [confirm]
 */

/**
 * @typedef {Object} PostSignedResult
 * @property {boolean} ok
 * @property {Response} response
 * @property {string} targetUrl
 * @property {any} resource
 */

/**
 * Sign + POST + persist. The single chokepoint for ACME-authenticated requests.
 * @param {PostSignedOpts} opts
 * @returns {Promise<PostSignedResult | null>} null when the user cancels via confirm hook
 */
export async function postSigned(opts) {
    const {env, url, key: keyName, kid, payload, type, parent, name = ''} = opts;
    const ingest = opts.ingest || defaultIngest;
    const directoryUrl = findDirectoryUrl(env.objectStore, parent) || parent;
    const pool = getNoncePool(env, directoryUrl);
    const nonce = pool.take();
    const key = await getOrCreateKey(env.keyStore, env.subtle, keyName);
    const protectedData = await protect(env.subtle, key, kid, nonce, url);
    const defaultSigned = await sign(env.subtle, key, protectedData, payload);

    const signedBody = opts.confirm
        ? await opts.confirm({protectedData, defaultSigned, msg: payload, url})
        : defaultSigned;
    if (signedBody === null) return null;

    const response = await env.fetch(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/jose+json'},
        body: signedBody,
    });
    pool.captureFromHeaders(response.headers);

    const targetUrl = response.headers.get('Location') || url;
    const resource = await ingest(response);

    if (response.ok) {
        env.objectStore.put({url: targetUrl, type, name, parent, resource, key: keyName});
        if (opts.postProcess) opts.postProcess(resource, targetUrl);
    }

    return {ok: response.ok, response, targetUrl, resource};
}

// ---------------------------------------------------------------------------
// AcmeObject base class — full subclass tree lands in step 7.
// ---------------------------------------------------------------------------

/**
 * Base class for every ACME resource (directory, account, order, etc.).
 * Subclasses override `displayFields`, `children`, `methodNames`, etc.
 */
export class AcmeObject {
    /**
     * @param {StoredObject} stored
     * @param {Env} env
     */
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
}

/**
 * The ACME directory resource (RFC 8555 §7.1.1). Owns the URLs of all the
 * top-level operations and is the entry point for newAccount/newOrder/etc.
 */
export class AcmeDirectory extends AcmeObject {
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
     * @param {{confirm?: ConfirmHook}} [hooks]
     */
    newAccount(payload, keyName, hooks = {}) {
        return postSigned({
            env: this.env,
            url: this.resource.newAccount,
            key: keyName,
            kid: null, // embed jwk
            payload,
            type: 'account',
            parent: this.url,
            confirm: hooks.confirm,
        });
    }

    /**
     * @param {object} payload - {identifiers, profile?, notBefore?, notAfter?}
     * @param {string} keyName
     * @param {string} accountUrl
     * @param {{confirm?: ConfirmHook}} [hooks]
     */
    newOrder(payload, keyName, accountUrl, hooks = {}) {
        return postSigned({
            env: this.env,
            url: this.resource.newOrder,
            key: keyName,
            kid: accountUrl,
            payload,
            type: 'order',
            parent: accountUrl,
            confirm: hooks.confirm,
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
     * @param {{confirm?: ConfirmHook}} [hooks]
     */
    newAuthz(payload, keyName, accountUrl, hooks = {}) {
        return postSigned({
            env: this.env,
            url: this.resource.newAuthz,
            key: keyName,
            kid: accountUrl,
            payload,
            type: 'authorization',
            parent: accountUrl,
            confirm: hooks.confirm,
        });
    }
}

/**
 * Map a StoredObject to its AcmeObject subclass instance. Stub for step 5;
 * subsequent steps wire concrete subclasses in.
 * @param {StoredObject} stored
 * @param {Env} env
 * @returns {AcmeObject}
 */
export function fromStored(stored, env) {
    if (stored.type === 'directory') return new AcmeDirectory(stored, env);
    return new AcmeObject(stored, env);
}

// re-export jws helpers so consumers only need to import acme.js
export {getOrCreateKey, protect, sign, thumbprint};
