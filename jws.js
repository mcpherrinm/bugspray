/**
 * @typedef {Object} KeyStore
 * @property {(name: string) => Promise<CryptoKeyPair | null>} get
 * @property {(name: string, pair: CryptoKeyPair) => Promise<void>} put
 */

/**
 * @typedef {Object} JwsProtected
 * @property {string} nonce
 * @property {string} url
 * @property {string} alg
 * @property {string} [kid]
 * @property {object} [jwk]
 */

/** @param {string} string */
function b64(string) {
    return btoa(string)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

/** @param {ArrayBuffer | Uint8Array} array */
function b64array(array) {
    let asString = '';
    const bytes = new Uint8Array(array);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        asString += String.fromCharCode(bytes[i]);
    }

    return b64(asString);
}

/**
 * Returns a key identified by `name`. If it doesn't exist already, it is created and saved.
 * @param {KeyStore} keyStore
 * @param {SubtleCrypto} subtle
 * @param {string} name
 * @returns {Promise<CryptoKeyPair>}
 */
async function getOrCreateKey(keyStore, subtle, name) {
    const existing = await keyStore.get(name);
    if (existing !== null) {
        return existing;
    }

    const newPair = await subtle.generateKey(
        {name: "ECDSA", namedCurve: "P-256"},
        true,
        ['sign', 'verify']
    );

    await keyStore.put(name, newPair);
    return newPair;
}

/**
 * Build the protected part of a JWS.
 * If kid is null, a jwk field will be added (used for newAccount and certificate-key revokeCert).
 * @param {SubtleCrypto} subtle
 * @param {CryptoKeyPair} key
 * @param {string | null} kid
 * @param {string} nonce
 * @param {string} url
 * @returns {Promise<JwsProtected>}
 */
async function protect(subtle, key, kid, nonce, url) {
    /** @type {JwsProtected} */
    const prot = {
        nonce: nonce,
        url: url,
        alg: "ES256",
    };

    if (kid === null) {
        const jwk = await subtle.exportKey("jwk", key.publicKey);
        prot.jwk = {
            kty: jwk.kty,
            crv: jwk.crv,
            x: jwk.x,
            y: jwk.y,
        };
    } else {
        prot.kid = kid;
    }

    return prot;
}

/**
 * Compute a JWS for ACME.
 * payload is an object that will be JSON-encoded, or "" for an empty payload (POST-as-GET).
 * @param {SubtleCrypto} subtle
 * @param {CryptoKeyPair} key
 * @param {JwsProtected} prot
 * @param {object | string} payload
 * @returns {Promise<string>}
 */
async function sign(subtle, key, prot, payload) {
    const encodedProtected = b64(JSON.stringify(prot));
    let encodedPayload;
    if (payload === "") {
        encodedPayload = "";
    } else {
        encodedPayload = b64(JSON.stringify(payload));
    }

    const sig = await subtle.sign(
        {name: "ECDSA", hash: {name: "SHA-256"}},
        key.privateKey,
        new TextEncoder().encode(encodedProtected + "." + encodedPayload)
    );

    return JSON.stringify({
        "protected": encodedProtected,
        "payload": encodedPayload,
        "signature": b64array(sig),
    }, null, 2);
}

/**
 * @param {SubtleCrypto} subtle
 * @param {CryptoKeyPair} key
 * @returns {Promise<string>}
 */
async function thumbprint(subtle, key) {
    const jwk = await subtle.exportKey("jwk", key.publicKey);
    const input = JSON.stringify({crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y});
    const hash = await subtle.digest("SHA-256", new TextEncoder().encode(input));
    return b64array(hash);
}

export {getOrCreateKey, protect, sign, thumbprint};
