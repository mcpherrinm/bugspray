function b64(string) {
    return btoa(string)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

function b64array(array) {
    let asString = '';
    const bytes = new Uint8Array(array);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        asString += String.fromCharCode(bytes[i]);
    }

    return b64(asString);
}

// newKey returns a key identified by `name`. If it doesn't exist already, it is created
async function newKey(name) {
    const stored = window.localStorage.getItem(`bugspray|key|${name}`);

    if (stored !== null) {
        const data = JSON.parse(stored);
        const privateKey = await window.crypto.subtle.importKey(
            "jwk",
            data.private,
            {
                name: "ECDSA",
                namedCurve: "P-256"
            },
            true,
            ['sign']);
        const publicKey = await window.crypto.subtle.importKey(
            "jwk",
            data.public,
            {
                name: "ECDSA",
                namedCurve: "P-256"
            },
            true,
            ['verify']);

        let loadedKey = window.crypto.subtle.CryptoKeyPair = {
            privateKey: privateKey,
            publicKey: publicKey
        }
        console.log("Loaded private key", loadedKey);
        return loadedKey
   }

    console.log(`No key stored for ${name}, generating`)

    const newKey = await window.crypto.subtle.generateKey(
        {
            name: "ECDSA",
            namedCurve: "P-256"
        },
        true,
        ['sign', 'verify']
    )

    const privateKey= JSON.stringify({
        private: await window.crypto.subtle.exportKey("jwk", newKey.privateKey),
        public: await window.crypto.subtle.exportKey("jwk", newKey.publicKey),
    });
    console.log("New key", newKey);
    console.log("Exporting private key", privateKey);
    window.localStorage.setItem(`bugspray|key|${name}`, privateKey);

    console.log("New key", newKey);
    return newKey
}

async function protect(key, kid, nonce, url) {
    let prot= {
        nonce: nonce,
        url: url,
        alg: "ES256",
    }

    if (kid === undefined) {
        const jwk = await window.crypto.subtle.exportKey("jwk", key.publicKey);
        prot["jwk"] = {
            kty: jwk.kty,
            crv: jwk.crv,
            x: jwk.x,
            y: jwk.y,
        }
    } else {
        prot["kid"] = kid;
    }

    return prot
}

// Compute a signature for ACME
// If kid is null, a jwk field will be added. This should happen for newAccount and certificate-key revokeCert
// Payload should be an object that will be JSON-encoded.
// Nonce and URL strings per ACME.
async function sign(key, prot, payload) {
    const encodedProtected = b64(JSON.stringify(prot));
    let encodedPayload;
    if (payload === "") {
        encodedPayload = ""
    } else {
        encodedPayload = b64(JSON.stringify(payload));
    }

    const sig = await window.crypto.subtle.sign(
        {name: "ECDSA", hash: {name: "SHA-256"}},
        key.privateKey,
        new TextEncoder().encode(encodedProtected + "." + encodedPayload)
    )

    return JSON.stringify({
        "protected": encodedProtected,
        "payload": encodedPayload,
        "signature": b64array(sig),
    }, null, 2);
}

export {newKey, protect, sign};
