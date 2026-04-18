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

// ---------------------------------------------------------------------------
// AcmeObject base class — full subclass tree lands in steps 6 & 7.
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
 * Map a StoredObject to its AcmeObject subclass instance. Stub for step 5;
 * subsequent steps wire concrete subclasses in.
 * @param {StoredObject} stored
 * @param {Env} env
 * @returns {AcmeObject}
 */
export function fromStored(stored, env) {
    return new AcmeObject(stored, env);
}

// re-export jws helpers so consumers only need to import acme.js
export {getOrCreateKey, protect, sign, thumbprint};
