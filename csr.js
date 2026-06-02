// PKCS#10 (RFC 2986) certificate-signing-request generation.
//
// Bugspray's `finalize` step needs a CSR, but a user testing an ACME server
// often doesn't have one lying around. This module builds one — and the key to
// go with it — from the order's identifiers, entirely in-browser via WebCrypto.
//
// Like jws.js, `SubtleCrypto` is an explicit parameter (no `window`/`globalThis`
// references) so this works unchanged under both the browser and Bun.
//
// The hand-rolled ASN.1 here is deliberately minimal: just the DER primitives a
// CSR needs. The SubjectPublicKeyInfo and the PKCS#8 private key are produced by
// WebCrypto's own `exportKey`, so we never hand-encode an EC point.

/**
 * Byte buffer backed by a plain ArrayBuffer. WebCrypto's `sign`/`verify` want
 * `BufferSource` over an `ArrayBuffer` (not `ArrayBufferLike`), so we keep DER
 * bytes typed this way and they pass straight into `subtle.sign`.
 * @typedef {Uint8Array<ArrayBuffer>} Bytes
 */

/**
 * @typedef {Object} CsrIdentifier
 * @property {string} type - "dns" or "ip" (matches ACME identifier types)
 * @property {string} value
 */

/**
 * @typedef {Object} GeneratedCsr
 * @property {CryptoKeyPair} keyPair - the freshly generated EC P-256 key pair
 * @property {Bytes} der - DER-encoded PKCS#10 CertificationRequest
 * @property {string} base64url - `der` as unpadded base64url, ready for the ACME finalize payload
 * @property {string} pem - `der` as a PEM "CERTIFICATE REQUEST" block
 * @property {string} privateKeyPem - the private key as a PKCS#8 PEM "PRIVATE KEY" block
 */

// OIDs we encode by hand. The key's own algorithm identifiers come from the
// SubjectPublicKeyInfo that WebCrypto exports, so they're not listed here.
const OID = {
    ecdsaWithSHA256: "1.2.840.10045.4.3.2", // signatureAlgorithm
    extensionRequest: "1.2.840.113549.1.9.14", // PKCS#9 extensionRequest attribute
    subjectAltName: "2.5.29.17",
};

// ---------------------------------------------------------------------------
// ASN.1 DER primitives
// ---------------------------------------------------------------------------

/**
 * Concatenate byte arrays into one buffer.
 * @param {Uint8Array[]} arrays
 * @returns {Bytes}
 */
function concat(arrays) {
    let total = 0;
    for (const a of arrays) total += a.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const a of arrays) {
        out.set(a, off);
        off += a.length;
    }
    return out;
}

/**
 * DER length octets for a content length (short form < 128, else long form).
 * @param {number} len
 * @returns {Bytes}
 */
function encodeLength(len) {
    if (len < 0x80) return Uint8Array.of(len);
    /** @type {number[]} */
    const bytes = [];
    let n = len;
    while (n > 0) {
        bytes.unshift(n & 0xff);
        n = Math.floor(n / 256);
    }
    return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

/**
 * Build one DER TLV (tag-length-value) from a tag byte and content.
 * @param {number} tag
 * @param {Uint8Array} content
 * @returns {Bytes}
 */
function tlv(tag, content) {
    return concat([Uint8Array.of(tag), encodeLength(content.length), content]);
}

/** SEQUENCE (0x30) wrapping the concatenation of its members. @param {Uint8Array[]} members @returns {Bytes} */
function sequence(members) {
    return tlv(0x30, concat(members));
}

/** SET (0x31) wrapping the concatenation of its members. @param {Uint8Array[]} members @returns {Bytes} */
function set(members) {
    return tlv(0x31, concat(members));
}

/**
 * DER OBJECT IDENTIFIER from a dotted-decimal string.
 * @param {string} dotted
 * @returns {Bytes}
 */
function encodeOid(dotted) {
    const parts = dotted.split(".").map((p) => parseInt(p, 10));
    if (parts.length < 2) throw new Error(`invalid OID: ${dotted}`);
    /** @type {number[]} */
    const body = [40 * parts[0] + parts[1]];
    for (let i = 2; i < parts.length; i++) {
        body.push(...base128(parts[i]));
    }
    return tlv(0x06, Uint8Array.from(body));
}

/**
 * Base-128 encode one OID sub-identifier: 7 bits per byte, high bit set on all
 * but the final (least-significant) byte.
 * @param {number} value
 * @returns {number[]}
 */
function base128(value) {
    const bytes = [value & 0x7f];
    let v = Math.floor(value / 128);
    while (v > 0) {
        bytes.unshift((v & 0x7f) | 0x80);
        v = Math.floor(v / 128);
    }
    return bytes;
}

/**
 * DER INTEGER from a big-endian magnitude (used for the ECDSA r and s values).
 * Strips leading zero bytes, then re-adds one if the high bit would otherwise
 * make the value look negative.
 * @param {Uint8Array} magnitude
 * @returns {Bytes}
 */
function encodeInteger(magnitude) {
    let i = 0;
    while (i < magnitude.length - 1 && magnitude[i] === 0) i++;
    let trimmed = magnitude.subarray(i);
    if ((trimmed[0] & 0x80) !== 0) {
        trimmed = concat([Uint8Array.of(0x00), trimmed]);
    }
    return tlv(0x02, trimmed);
}

// ---------------------------------------------------------------------------
// IP address parsing (for `ip` identifiers → iPAddress GeneralName octets)
// ---------------------------------------------------------------------------

/**
 * Encode an IPv4 or IPv6 literal as its 4- or 16-byte network representation.
 * @param {string} value
 * @returns {Bytes}
 */
export function ipToBytes(value) {
    return value.includes(":") ? ipv6ToBytes(value) : ipv4ToBytes(value);
}

/** @param {string} value @returns {Bytes} */
function ipv4ToBytes(value) {
    const parts = value.split(".");
    if (parts.length !== 4) throw new Error(`invalid IPv4 address: ${value}`);
    const out = new Uint8Array(4);
    for (let i = 0; i < 4; i++) {
        if (!/^\d{1,3}$/.test(parts[i])) throw new Error(`invalid IPv4 octet: ${parts[i]}`);
        const n = parseInt(parts[i], 10);
        if (n > 255) throw new Error(`invalid IPv4 octet: ${parts[i]}`);
        out[i] = n;
    }
    return out;
}

/** @param {string} value @returns {Bytes} */
function ipv6ToBytes(value) {
    const halves = value.split("::");
    if (halves.length > 2) throw new Error(`invalid IPv6 address: ${value}`);
    const splitGroups = (/** @type {string} */ s) => (s === "" ? [] : s.split(":"));

    /** @type {number[]} */
    let groups;
    if (halves.length === 1) {
        groups = splitGroups(halves[0]).map(hexGroup);
        if (groups.length !== 8) throw new Error(`invalid IPv6 address: ${value}`);
    } else {
        const head = splitGroups(halves[0]).map(hexGroup);
        const tail = splitGroups(halves[1]).map(hexGroup);
        const missing = 8 - head.length - tail.length;
        if (missing < 1) throw new Error(`invalid IPv6 address: ${value}`);
        groups = [...head, ...new Array(missing).fill(0), ...tail];
    }

    const out = new Uint8Array(16);
    for (let i = 0; i < 8; i++) {
        out[i * 2] = (groups[i] >> 8) & 0xff;
        out[i * 2 + 1] = groups[i] & 0xff;
    }
    return out;
}

/** @param {string} group @returns {number} */
function hexGroup(group) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) throw new Error(`invalid IPv6 group: ${group}`);
    return parseInt(group, 16);
}

// ---------------------------------------------------------------------------
// CSR assembly
// ---------------------------------------------------------------------------

/**
 * Build the SubjectAltName extension (`SEQUENCE { OID, OCTET STRING(GeneralNames) }`)
 * covering the given identifiers. dNSName is [2] IMPLICIT IA5String (tag 0x82);
 * iPAddress is [7] IMPLICIT OCTET STRING (tag 0x87).
 * @param {CsrIdentifier[]} identifiers
 * @returns {Bytes}
 */
function sanExtension(identifiers) {
    const generalNames = identifiers.map((id) => {
        if (id.type === "dns") {
            return tlv(0x82, new TextEncoder().encode(id.value));
        }
        if (id.type === "ip") {
            return tlv(0x87, ipToBytes(id.value));
        }
        throw new Error(`unsupported identifier type: ${id.type}`);
    });
    const generalNamesDer = sequence(generalNames); // GeneralNames ::= SEQUENCE OF GeneralName
    const extnValue = tlv(0x04, generalNamesDer); // OCTET STRING wraps the extension's DER
    return sequence([encodeOid(OID.subjectAltName), extnValue]);
}

/**
 * Build the `attributes [0]` field of the CertificationRequestInfo. When there
 * are identifiers, it carries a single PKCS#9 extensionRequest holding the SAN
 * extension; otherwise it's an empty `[0]`.
 * @param {CsrIdentifier[]} identifiers
 * @returns {Bytes}
 */
function attributes(identifiers) {
    if (identifiers.length === 0) return tlv(0xa0, new Uint8Array(0));
    const extensions = sequence([sanExtension(identifiers)]); // Extensions ::= SEQUENCE OF Extension
    const attribute = sequence([encodeOid(OID.extensionRequest), set([extensions])]);
    // attributes [0] IMPLICIT SET OF Attribute → the [0] tag (0xa0) replaces the SET tag.
    return tlv(0xa0, attribute);
}

/**
 * Build the CertificationRequestInfo (the to-be-signed body of the CSR).
 * @param {Uint8Array} spki - DER SubjectPublicKeyInfo from `exportKey("spki", …)`
 * @param {CsrIdentifier[]} identifiers
 * @returns {Bytes}
 */
function certificationRequestInfo(spki, identifiers) {
    const version = tlv(0x02, Uint8Array.of(0x00)); // v1 (0)
    const subject = sequence([]); // empty Name; identifiers live in the SAN extension
    return sequence([version, subject, spki, attributes(identifiers)]);
}

/**
 * Convert a P1363 raw ECDSA signature (r‖s, as WebCrypto produces) into the DER
 * `SEQUENCE { INTEGER r, INTEGER s }` an X.509/PKCS#10 signature requires.
 * @param {Uint8Array} raw
 * @returns {Bytes}
 */
function ecdsaRawToDer(raw) {
    const half = raw.length / 2;
    const r = raw.subarray(0, half);
    const s = raw.subarray(half);
    return sequence([encodeInteger(r), encodeInteger(s)]);
}

/**
 * Build a DER-encoded PKCS#10 CertificationRequest from an existing key pair.
 * @param {SubtleCrypto} subtle
 * @param {CryptoKeyPair} keyPair - an ECDSA P-256 key pair with a usable private key
 * @param {CsrIdentifier[]} identifiers
 * @returns {Promise<Bytes>}
 */
export async function buildCsrDer(subtle, keyPair, identifiers) {
    const spki = new Uint8Array(await subtle.exportKey("spki", keyPair.publicKey));
    const cri = certificationRequestInfo(spki, identifiers);

    const rawSig = new Uint8Array(
        await subtle.sign({name: "ECDSA", hash: {name: "SHA-256"}}, keyPair.privateKey, cri),
    );
    const signatureAlgorithm = sequence([encodeOid(OID.ecdsaWithSHA256)]);
    // BIT STRING: a leading 0x00 "unused bits" octet, then the DER signature.
    const signature = tlv(0x03, concat([Uint8Array.of(0x00), ecdsaRawToDer(rawSig)]));

    return sequence([cri, signatureAlgorithm, signature]);
}

/**
 * Generate a fresh ECDSA P-256 key pair and a CSR covering `identifiers`,
 * returning the key, the CSR in several encodings, and the private key as PEM.
 * @param {SubtleCrypto} subtle
 * @param {CsrIdentifier[]} identifiers
 * @returns {Promise<GeneratedCsr>}
 */
export async function generateKeyAndCsr(subtle, identifiers) {
    const keyPair = await subtle.generateKey(
        {name: "ECDSA", namedCurve: "P-256"},
        true,
        ["sign", "verify"],
    );
    const der = await buildCsrDer(subtle, keyPair, identifiers);
    const pkcs8 = new Uint8Array(await subtle.exportKey("pkcs8", keyPair.privateKey));
    return {
        keyPair,
        der,
        base64url: toBase64url(der),
        pem: derToPem(der, "CERTIFICATE REQUEST"),
        privateKeyPem: derToPem(pkcs8, "PRIVATE KEY"),
    };
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

/** @param {Uint8Array} bytes @returns {string} */
function toBase64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
}

/** Unpadded base64url, matching the encoding ACME expects for the CSR. @param {Uint8Array} bytes */
export function toBase64url(bytes) {
    return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Wrap DER bytes in a PEM block with 64-character base64 lines.
 * @param {Uint8Array} bytes
 * @param {string} label - e.g. "CERTIFICATE REQUEST" or "PRIVATE KEY"
 * @returns {string}
 */
export function derToPem(bytes, label) {
    const body = toBase64(bytes).replace(/(.{64})/g, "$1\n").replace(/\n$/, "");
    return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}
