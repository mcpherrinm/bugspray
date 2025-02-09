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

async function newKey() {
    return await window.crypto.subtle.generateKey(
        {
            name: "ECDSA",
            namedCurve: "P-256"
        },
        true,
        ['sign', 'verify']
    )
}

// Compute a signature for ACME
// If kid is null, a jwk field will be added. This should happen for newAccount and certificate-key revokeCert
// Payload should be an object that will be JSON-encoded.
// Nonce and URL strings per ACME.
async function sign(key, kid, payload, nonce, url) {
    const prot= {
        nonce: nonce,
        url: url,
        alg: "ES256",
    }

    if (kid === null) {
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

    console.log(prot)

    const encodedProtected = b64(JSON.stringify(prot));
    const encodedPayload = b64(JSON.stringify(payload));

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

export {newKey, sign};
