import {test, expect, describe} from "bun:test";
import {spawnSync} from "node:child_process";
import {mkdtempSync, writeFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
    generateKeyAndCsr, buildCsrDer, ipToBytes, toBase64url, derToPem,
} from "./csr.js";

const subtle = globalThis.crypto.subtle;

// ---------------------------------------------------------------------------
// A minimal DER reader, just enough to pull a CSR apart for verification.
// ---------------------------------------------------------------------------

/**
 * @param {Uint8Array} bytes
 * @param {number} offset
 */
function readTLV(bytes, offset) {
    const tag = bytes[offset];
    let pos = offset + 1;
    let len = bytes[pos++];
    if (len & 0x80) {
        const n = len & 0x7f;
        len = 0;
        for (let i = 0; i < n; i++) len = len * 256 + bytes[pos++];
    }
    return {tag, tlvStart: offset, contentStart: pos, contentEnd: pos + len, tlvEnd: pos + len};
}

/** Left-trim leading zero bytes then left-pad to `width`. */
function toFixed(bytes, width) {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    const trimmed = bytes.subarray(i);
    const out = new Uint8Array(width);
    out.set(trimmed, width - trimmed.length);
    return out;
}

/** True if `needle` appears as a contiguous run inside `hay`. */
function contains(hay, needle) {
    outer: for (let i = 0; i + needle.length <= hay.length; i++) {
        for (let j = 0; j < needle.length; j++) {
            if (hay[i + j] !== needle[j]) continue outer;
        }
        return true;
    }
    return false;
}

/**
 * Pull (certificationRequestInfo bytes, raw r‖s signature) out of a CSR's DER.
 * @param {Uint8Array<ArrayBuffer>} der
 */
function dissectCsr(der) {
    const outer = readTLV(der, 0);
    expect(outer.tag).toBe(0x30);
    const cri = readTLV(der, outer.contentStart);
    expect(cri.tag).toBe(0x30);
    const sigAlg = readTLV(der, cri.tlvEnd);
    expect(sigAlg.tag).toBe(0x30);
    const sig = readTLV(der, sigAlg.tlvEnd);
    expect(sig.tag).toBe(0x03); // BIT STRING
    expect(der[sig.contentStart]).toBe(0x00); // unused-bits octet

    const criBytes = der.subarray(cri.tlvStart, cri.tlvEnd);

    const derSig = der.subarray(sig.contentStart + 1, sig.contentEnd);
    const seq = readTLV(derSig, 0);
    expect(seq.tag).toBe(0x30);
    const rInt = readTLV(derSig, seq.contentStart);
    const sInt = readTLV(derSig, rInt.tlvEnd);
    const r = toFixed(derSig.subarray(rInt.contentStart, rInt.contentEnd), 32);
    const s = toFixed(derSig.subarray(sInt.contentStart, sInt.contentEnd), 32);
    const rawSig = new Uint8Array(64);
    rawSig.set(r, 0);
    rawSig.set(s, 32);

    return {criBytes, rawSig};
}

// ---------------------------------------------------------------------------

describe("generateKeyAndCsr", () => {
    test("produces a CSR whose signature verifies over its own request info", async () => {
        const {keyPair, der} = await generateKeyAndCsr(subtle, [
            {type: "dns", value: "example.com"},
        ]);
        const {criBytes, rawSig} = dissectCsr(der);
        const ok = await subtle.verify(
            {name: "ECDSA", hash: {name: "SHA-256"}},
            keyPair.publicKey,
            rawSig,
            criBytes,
        );
        expect(ok).toBe(true);
    });

    test("base64url round-trips to the same DER and PEM markers are correct", async () => {
        const {der, base64url, pem, privateKeyPem} = await generateKeyAndCsr(subtle, [
            {type: "dns", value: "example.com"},
        ]);
        // base64url decodes back to der
        const padded = base64url.replace(/-/g, "+").replace(/_/g, "/");
        const bin = atob(padded);
        const decoded = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        expect(decoded).toEqual(der);

        expect(pem.startsWith("-----BEGIN CERTIFICATE REQUEST-----\n")).toBe(true);
        expect(pem.trimEnd().endsWith("-----END CERTIFICATE REQUEST-----")).toBe(true);
        expect(privateKeyPem.startsWith("-----BEGIN PRIVATE KEY-----\n")).toBe(true);
    });

    test("embeds dNSName and iPAddress SAN entries in the request info", async () => {
        const {der} = await generateKeyAndCsr(subtle, [
            {type: "dns", value: "san.example.com"},
            {type: "ip", value: "192.0.2.7"},
        ]);
        expect(contains(der, new TextEncoder().encode("san.example.com"))).toBe(true);
        expect(contains(der, Uint8Array.of(0x87, 0x04, 192, 0, 2, 7))).toBe(true); // [7] OCTET STRING, 4 bytes
    });

    test("an empty identifier list still yields a verifiable CSR", async () => {
        const {keyPair, der} = await generateKeyAndCsr(subtle, []);
        const {criBytes, rawSig} = dissectCsr(der);
        const ok = await subtle.verify(
            {name: "ECDSA", hash: {name: "SHA-256"}}, keyPair.publicKey, rawSig, criBytes);
        expect(ok).toBe(true);
    });

    test("rejects unsupported identifier types", async () => {
        await expect(
            generateKeyAndCsr(subtle, [/** @type {any} */ ({type: "email", value: "a@b.com"})]),
        ).rejects.toThrow(/unsupported identifier type/);
    });

    test("buildCsrDer reuses a caller-provided key pair", async () => {
        const keyPair = await subtle.generateKey(
            {name: "ECDSA", namedCurve: "P-256"}, true, ["sign", "verify"]);
        const der = await buildCsrDer(subtle, keyPair, [{type: "dns", value: "reuse.example"}]);
        const {criBytes, rawSig} = dissectCsr(der);
        const ok = await subtle.verify(
            {name: "ECDSA", hash: {name: "SHA-256"}}, keyPair.publicKey, rawSig, criBytes);
        expect(ok).toBe(true);
    });
});

describe("ipToBytes", () => {
    test("IPv4", () => {
        expect(Array.from(ipToBytes("192.0.2.7"))).toEqual([192, 0, 2, 7]);
        expect(Array.from(ipToBytes("255.255.255.255"))).toEqual([255, 255, 255, 255]);
    });

    test("IPv6 full and compressed forms", () => {
        expect(Array.from(ipToBytes("2001:db8::1"))).toEqual(
            [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
        expect(ipToBytes("::1").length).toBe(16);
        expect(Array.from(ipToBytes("::1")).slice(0, 15).every((b) => b === 0)).toBe(true);
        expect(ipToBytes("::1")[15]).toBe(1);
        expect(Array.from(ipToBytes("2001:0db8:0000:0000:0000:0000:0000:0001"))).toEqual(
            [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    });

    test("rejects malformed addresses", () => {
        expect(() => ipToBytes("1.2.3")).toThrow();
        expect(() => ipToBytes("256.0.0.1")).toThrow();
        expect(() => ipToBytes("1.2.3.x")).toThrow();
        expect(() => ipToBytes("2001:db8::1::2")).toThrow(); // two "::"
        expect(() => ipToBytes("12345::1")).toThrow(); // group too long
    });
});

describe("encoding helpers", () => {
    test("toBase64url is unpadded and url-safe", () => {
        // 0xfb 0xff -> base64 "+/8=" -> base64url "-_8"
        expect(toBase64url(Uint8Array.of(0xfb, 0xff))).toBe("-_8");
    });

    test("derToPem wraps at 64 columns", () => {
        const pem = derToPem(new Uint8Array(60).fill(0x41), "TEST");
        const lines = pem.trimEnd().split("\n");
        expect(lines[0]).toBe("-----BEGIN TEST-----");
        expect(lines[lines.length - 1]).toBe("-----END TEST-----");
        for (const line of lines.slice(1, -1)) {
            expect(line.length).toBeLessThanOrEqual(64);
        }
    });
});

// Independent cross-check: ask the system openssl to verify our CSR. Skips when
// openssl isn't installed.
const opensslAvailable = (() => {
    try {
        return spawnSync("openssl", ["version"]).status === 0;
    } catch {
        return false;
    }
})();
if (!opensslAvailable) console.log("(skipping openssl CSR cross-check — openssl not found)");

describe.skipIf(!opensslAvailable)("openssl cross-check", () => {
    test("openssl verifies the signature and reports the SANs", async () => {
        const {pem} = await generateKeyAndCsr(subtle, [
            {type: "dns", value: "openssl.example.com"},
            {type: "ip", value: "192.0.2.9"},
        ]);
        const dir = mkdtempSync(join(tmpdir(), "bugspray-csr-"));
        const csrPath = join(dir, "req.pem");
        try {
            writeFileSync(csrPath, pem);
            const res = spawnSync(
                "openssl", ["req", "-in", csrPath, "-noout", "-verify", "-text"],
                {encoding: "utf8"});
            const combined = `${res.stdout || ""}${res.stderr || ""}`;
            expect(combined).toMatch(/verify OK/i);
            expect(combined).toContain("openssl.example.com");
            expect(combined).toContain("192.0.2.9");
        } finally {
            rmSync(dir, {recursive: true, force: true});
        }
    });
});
