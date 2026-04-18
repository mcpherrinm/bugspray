import {createObjectStore} from "./storage.js";

/**
 * @typedef {Object} Env
 * @property {import("./storage.js").ObjectStore} objectStore
 * @property {import("./jws.js").KeyStore} keyStore
 * @property {typeof fetch} fetch
 * @property {SubtleCrypto} subtle
 */

/**
 * Build a browser-backed Env: localStorage for objects and keys, window.fetch, window.crypto.subtle.
 * @returns {Env}
 */
export function buildBrowserEnv() {
    const subtle = window.crypto.subtle;

    /** @type {import("./jws.js").KeyStore} */
    const keyStore = {
        async get(name) {
            const stored = window.localStorage.getItem(`bugspray|key|${name}`);
            if (stored === null) return null;
            const data = JSON.parse(stored);
            const privateKey = await subtle.importKey(
                "jwk", data.private, {name: "ECDSA", namedCurve: "P-256"}, true, ['sign']);
            const publicKey = await subtle.importKey(
                "jwk", data.public, {name: "ECDSA", namedCurve: "P-256"}, true, ['verify']);
            return {privateKey, publicKey};
        },
        async put(name, pair) {
            const data = JSON.stringify({
                private: await subtle.exportKey("jwk", pair.privateKey),
                public: await subtle.exportKey("jwk", pair.publicKey),
            });
            window.localStorage.setItem(`bugspray|key|${name}`, data);
        },
    };

    return {
        objectStore: createObjectStore(),
        keyStore,
        fetch: window.fetch.bind(window),
        subtle,
    };
}
