import {readFileSync, writeFileSync, existsSync} from "node:fs";

/**
 * @typedef {import("./browserEnv.js").Env} Env
 * @typedef {import("./storage.js").StoredObject} StoredObject
 */

/**
 * @typedef {Object} StateFile
 * @property {Record<string, StoredObject>} objects
 * @property {Record<string, {private: any, public: any}>} keys
 */

/** @returns {StateFile} */
function loadState(/** @type {string} */ path) {
    if (!existsSync(path)) return {objects: {}, keys: {}};
    const text = readFileSync(path, 'utf8');
    return JSON.parse(text);
}

function saveState(/** @type {string} */ path, /** @type {StateFile} */ state) {
    writeFileSync(path, JSON.stringify(state, null, 2));
}

/**
 * Build a Bun/Node-backed Env that persists state to a single JSON file.
 * @param {{statePath: string}} opts
 * @returns {Env}
 */
export function buildNodeEnv({statePath}) {
    const state = loadState(statePath);
    const subtle = globalThis.crypto.subtle;

    /** @type {Map<string, StoredObject>} */
    const objects = new Map(Object.entries(state.objects));

    function persistObjects() {
        state.objects = Object.fromEntries(objects);
        saveState(statePath, state);
    }

    /** @type {import("./storage.js").ObjectStore} */
    const objectStore = {
        get: (url) => objects.get(url),
        list: () => objects.entries(),
        put: (obj) => {
            objects.set(obj.url, obj);
            persistObjects();
        },
        clear: () => {
            objects.clear();
            persistObjects();
        },
    };

    /** @type {import("./jws.js").KeyStore} */
    const keyStore = {
        async get(name) {
            const stored = state.keys[name];
            if (!stored) return null;
            const privateKey = await subtle.importKey(
                "jwk", stored.private, {name: "ECDSA", namedCurve: "P-256"}, true, ['sign']);
            const publicKey = await subtle.importKey(
                "jwk", stored.public, {name: "ECDSA", namedCurve: "P-256"}, true, ['verify']);
            return {privateKey, publicKey};
        },
        async put(name, pair) {
            state.keys[name] = {
                private: await subtle.exportKey("jwk", pair.privateKey),
                public: await subtle.exportKey("jwk", pair.publicKey),
            };
            saveState(statePath, state);
        },
    };

    return {
        objectStore,
        keyStore,
        fetch: globalThis.fetch.bind(globalThis),
        subtle,
    };
}
