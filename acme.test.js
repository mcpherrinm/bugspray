import {test, expect, describe} from "bun:test";
import {
    NoncePool, NO_NONCE_SENTINEL, nonceStorageUrl, getNoncePool, resetNoncePools,
    AcmeObject, AcmeDirectory, AcmeAccount, AcmeOrder, AcmeAuthorization,
    AcmeChallenge, AcmeCertificate, fromStored, splitPemChain,
} from "./acme.js";
import {protect} from "./jws.js";

/**
 * @returns {import("./browserEnv.js").Env}
 */
function fakeEnv() {
    /** @type {Map<string, import("./storage.js").StoredObject>} */
    const objects = new Map();
    /** @type {Map<string, CryptoKeyPair>} */
    const keys = new Map();
    return {
        objectStore: {
            get: (url) => objects.get(url),
            list: () => objects.entries(),
            put: (obj) => { objects.set(obj.url, obj); },
            clear: () => { objects.clear(); },
        },
        keyStore: {
            async get(name) { return keys.get(name) ?? null; },
            async put(name, pair) { keys.set(name, pair); },
        },
        fetch: globalThis.fetch.bind(globalThis),
        subtle: globalThis.crypto.subtle,
    };
}

describe("NoncePool", () => {
    test("add/take/delete round-trip", () => {
        const env = fakeEnv();
        const pool = new NoncePool(env, "https://ca/dir", []);
        pool.add("n1", 1000);
        pool.add("n2", 2000);
        pool.add("n3", 3000);
        expect(pool.entries.length).toBe(3);

        // take is LIFO
        expect(pool.take()).toBe("n3");
        expect(pool.entries.length).toBe(2);

        // delete by value
        expect(pool.delete("n1")).toBe(true);
        expect(pool.entries.length).toBe(1);
        expect(pool.entries[0].nonce).toBe("n2");

        // delete missing returns false
        expect(pool.delete("nope")).toBe(false);
    });

    test("take from empty returns sentinel", () => {
        const env = fakeEnv();
        const pool = new NoncePool(env, "https://ca/dir", []);
        expect(pool.take()).toBe(NO_NONCE_SENTINEL);
    });

    test("persists into the object store", () => {
        const env = fakeEnv();
        const pool = new NoncePool(env, "https://ca/dir", []);
        pool.add("n1", 12345);
        const stored = env.objectStore.get(nonceStorageUrl("https://ca/dir"));
        expect(stored).toBeDefined();
        expect(stored.type).toBe("nonces");
        expect(stored.parent).toBe("https://ca/dir");
        expect(stored.resource.nonces).toEqual([{nonce: "n1", timestamp: 12345}]);
        expect(stored.name).toBe("Nonce Pool (1)");
    });

    test("hydrates from storage and migrates legacy string entries", () => {
        const env = fakeEnv();
        env.objectStore.put({
            url: nonceStorageUrl("https://ca/dir"),
            type: "nonces", name: "", parent: "https://ca/dir",
            resource: {nonces: ["legacy", {nonce: "newer", timestamp: 5}]},
        });
        const pool = NoncePool.load(env, "https://ca/dir");
        expect(pool.entries).toEqual([
            {nonce: "legacy", timestamp: null},
            {nonce: "newer", timestamp: 5},
        ]);
    });

    test("captureFromHeaders skips when header missing", () => {
        const env = fakeEnv();
        const pool = new NoncePool(env, "https://ca/dir", []);
        pool.captureFromHeaders(new Headers());
        expect(pool.entries.length).toBe(0);
        pool.captureFromHeaders(new Headers({"replay-nonce": "abc"}));
        expect(pool.entries.length).toBe(1);
        expect(pool.entries[0].nonce).toBe("abc");
    });

    test("getNoncePool memoizes per env", () => {
        resetNoncePools();
        const env = fakeEnv();
        const a = getNoncePool(env, "https://ca/dir");
        const b = getNoncePool(env, "https://ca/dir");
        expect(a).toBe(b);
    });
});

describe("parent-chain walks", () => {
    test("directoryUrl and accountUrl walk through arbitrary depth", () => {
        const env = fakeEnv();
        const dirUrl = "https://ca/dir";
        const acctUrl = "https://ca/acct/1";
        const orderUrl = "https://ca/order/1";
        const authzUrl = "https://ca/authz/1";
        const chUrl = "https://ca/chall/1";
        env.objectStore.put({url: dirUrl, type: "directory", name: "", parent: "", resource: {}});
        env.objectStore.put({url: acctUrl, type: "account", name: "", parent: dirUrl, resource: {}});
        env.objectStore.put({url: orderUrl, type: "order", name: "", parent: acctUrl, resource: {}});
        env.objectStore.put({url: authzUrl, type: "authorization", name: "", parent: orderUrl, resource: {}});
        env.objectStore.put({url: chUrl, type: "challenge", name: "", parent: authzUrl, resource: {}});

        const ch = fromStored(env.objectStore.get(chUrl), env);
        expect(ch.directoryUrl).toBe(dirUrl);
        expect(ch.accountUrl).toBe(acctUrl);
    });
});

describe("fromStored dispatch", () => {
    const env = fakeEnv();
    /** @type {Array<{type: string, cls: typeof AcmeObject}>} */
    const cases = [
        {type: "directory", cls: AcmeDirectory},
        {type: "account", cls: AcmeAccount},
        {type: "order", cls: AcmeOrder},
        {type: "authorization", cls: AcmeAuthorization},
        {type: "challenge", cls: AcmeChallenge},
        {type: "certificate", cls: AcmeCertificate},
    ];
    for (const {type, cls} of cases) {
        test(`type=${type} → ${cls.name}`, () => {
            const obj = fromStored({url: `https://x/${type}`, type, name: "", parent: "", resource: {}}, env);
            expect(obj).toBeInstanceOf(cls);
        });
    }

    test("unknown type falls back to AcmeObject", () => {
        const obj = fromStored({url: "x", type: "weird", name: "", parent: "", resource: {}}, env);
        expect(obj).toBeInstanceOf(AcmeObject);
    });
});

describe("AcmeOrder.normalizeCsr", () => {
    test("base64url DER passes through unchanged", () => {
        expect(AcmeOrder.normalizeCsr("abc-_123")).toBe("abc-_123");
        expect(AcmeOrder.normalizeCsr("  abc  ")).toBe("abc");
    });

    test("PEM is stripped and base64-→base64url converted", () => {
        const pem = "-----BEGIN CERTIFICATE REQUEST-----\nAB+/CD\nEF==\n-----END CERTIFICATE REQUEST-----";
        // base64 "AB+/CDEF" → base64url "AB-_CDEF" (trailing == padding dropped)
        expect(AcmeOrder.normalizeCsr(pem)).toBe("AB-_CDEF");
    });
});

describe("AcmeCertificate", () => {
    test("ingest splits multi-cert chain", async () => {
        const cert = "-----BEGIN CERTIFICATE-----\nMIIA\n-----END CERTIFICATE-----";
        const cert2 = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
        const body = `${cert}\n${cert2}\n`;
        const response = new Response(body);
        const ingested = await AcmeCertificate.ingest(response);
        expect(ingested.pem).toBe(body);
        expect(ingested.chain).toEqual([cert, cert2]);
    });

    test("ingest handles single cert with CRLF", async () => {
        const body = "-----BEGIN CERTIFICATE-----\r\nMIIA\r\n-----END CERTIFICATE-----\r\n";
        const ingested = await AcmeCertificate.ingest(new Response(body));
        expect(ingested.chain.length).toBe(1);
    });

    test("ingest of empty body yields empty chain", async () => {
        const ingested = await AcmeCertificate.ingest(new Response(""));
        expect(ingested.chain).toEqual([]);
    });

    test("splitPemChain returns [] when no markers", () => {
        expect(splitPemChain("garbage")).toEqual([]);
    });

    test("fromStored migrates legacy {value, contentType} to {pem, chain}", () => {
        const env = fakeEnv();
        const pem = "-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----";
        env.objectStore.put({
            url: "https://ca/cert/1", type: "certificate", name: "", parent: "https://ca/order/1",
            resource: {value: pem, contentType: "application/pem-certificate-chain"},
        });
        const cert = /** @type {AcmeCertificate} */ (fromStored(env.objectStore.get("https://ca/cert/1"), env));
        expect(cert).toBeInstanceOf(AcmeCertificate);
        // migrated in place
        const stored = env.objectStore.get("https://ca/cert/1");
        expect(stored.resource.pem).toBe(pem);
        expect(stored.resource.chain).toEqual([pem]);
        expect(stored.resource.value).toBeUndefined();
    });
});

describe("AcmeChallenge.instructions", () => {
    /** Build a chall→authz→order→account→directory tree for instructions tests. */
    function challengeTree(env, chType) {
        const dirUrl = "https://ca/dir";
        const acctUrl = "https://ca/acct/1";
        const orderUrl = "https://ca/order/1";
        const authzUrl = "https://ca/authz/1";
        const chUrl = "https://ca/chall/1";
        env.objectStore.put({url: dirUrl, type: "directory", name: "", parent: "",
            resource: {meta: {caaIdentities: ["example-ca.org"]}}});
        env.objectStore.put({url: acctUrl, type: "account", name: "", parent: dirUrl, resource: {}});
        env.objectStore.put({url: orderUrl, type: "order", name: "", parent: acctUrl, resource: {}});
        env.objectStore.put({url: authzUrl, type: "authorization", name: "", parent: orderUrl,
            resource: {identifier: {type: "dns", value: "example.com"}}});
        env.objectStore.put({url: chUrl, type: "challenge", name: "", parent: authzUrl,
            resource: {type: chType, status: "pending", token: "tok123"}, key: "k1"});
        return chUrl;
    }

    test("http-01 instructions include the well-known path and key authorization", async () => {
        const env = fakeEnv();
        const url = challengeTree(env, "http-01");
        const ch = /** @type {AcmeChallenge} */ (fromStored(env.objectStore.get(url), env));
        const items = await ch.instructions();
        const paths = items.filter(i => i.copiable).map(i => i.copiable);
        expect(paths[0]).toBe("http://example.com/.well-known/acme-challenge/tok123");
        // key authorization is "tok123.<thumbprint>"
        expect(paths[1].startsWith("tok123.")).toBe(true);
    });

    test("dns-01 instructions emit _acme-challenge.<domain> and a base64url SHA-256", async () => {
        const env = fakeEnv();
        const url = challengeTree(env, "dns-01");
        const ch = /** @type {AcmeChallenge} */ (fromStored(env.objectStore.get(url), env));
        const items = await ch.instructions();
        const copiables = items.filter(i => i.copiable).map(i => i.copiable);
        expect(copiables[0]).toBe("_acme-challenge.example.com");
        // base64url, no padding
        expect(/^[A-Za-z0-9_-]+$/.test(copiables[1])).toBe(true);
    });

    test("tls-alpn-01 emits a 64-char hex digest", async () => {
        const env = fakeEnv();
        const url = challengeTree(env, "tls-alpn-01");
        const ch = /** @type {AcmeChallenge} */ (fromStored(env.objectStore.get(url), env));
        const items = await ch.instructions();
        const copiables = items.filter(i => i.copiable).map(i => i.copiable);
        expect(copiables[0]).toBe("example.com");
        expect(copiables[1]).toMatch(/^[0-9a-f]{64}$/);
    });

    test("dns-persist-01 uses CAA identity and account URI", async () => {
        const env = fakeEnv();
        const url = challengeTree(env, "dns-persist-01");
        const ch = /** @type {AcmeChallenge} */ (fromStored(env.objectStore.get(url), env));
        const items = await ch.instructions();
        const copiables = items.filter(i => i.copiable).map(i => i.copiable);
        expect(copiables[0]).toBe("_validation-persist.example.com");
        expect(copiables[1]).toBe("example-ca.org; accounturi=https://ca/acct/1");
    });
});

describe("jws.protect", () => {
    test("kid form sets kid and omits jwk", async () => {
        const subtle = globalThis.crypto.subtle;
        const pair = await subtle.generateKey(
            {name: "ECDSA", namedCurve: "P-256"}, true, ["sign", "verify"]);
        const prot = await protect(subtle, pair, "https://acct/1", "nonce-abc", "https://x/y");
        expect(prot.alg).toBe("ES256");
        expect(prot.nonce).toBe("nonce-abc");
        expect(prot.url).toBe("https://x/y");
        expect(prot.kid).toBe("https://acct/1");
        expect(prot.jwk).toBeUndefined();
    });

    test("kid=null form embeds jwk and omits kid", async () => {
        const subtle = globalThis.crypto.subtle;
        const pair = await subtle.generateKey(
            {name: "ECDSA", namedCurve: "P-256"}, true, ["sign", "verify"]);
        const prot = await protect(subtle, pair, null, "nonce-abc", "https://x/y");
        expect(prot.kid).toBeUndefined();
        expect(prot.jwk).toBeDefined();
        expect(prot.jwk.kty).toBe("EC");
        expect(prot.jwk.crv).toBe("P-256");
        expect(typeof prot.jwk.x).toBe("string");
        expect(typeof prot.jwk.y).toBe("string");
    });
});
