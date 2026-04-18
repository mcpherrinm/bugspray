// Integration test against a local Pebble instance (https://github.com/letsencrypt/pebble).
//
// Start pebble first, e.g.:
//   docker run --rm -p 14000:14000 -p 15000:15000 ghcr.io/letsencrypt/pebble:latest \
//     pebble -dnsserver host.docker.internal:8053
// Then `bun test acme.integration.test.js` (or just `bun test`).
//
// If pebble isn't reachable the suite skips itself. Override the directory URL
// with PEBBLE_DIRECTORY_URL=... if you run pebble somewhere other than the
// default https://localhost:14000/dir.

import {test, expect, describe, beforeAll, afterAll} from "bun:test";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {buildNodeEnv} from "./nodeEnv.js";
import {
    AcmeDirectory, AcmeAuthorization,
    getNoncePool, resetNoncePools,
} from "./acme.js";

// Pebble uses a self-signed cert; trust it for the duration of these tests.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const PEBBLE_URL = process.env.PEBBLE_DIRECTORY_URL || "https://localhost:14000/dir";

async function isPebbleReachable() {
    try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 2000);
        const r = await fetch(PEBBLE_URL, {signal: ctrl.signal});
        clearTimeout(t);
        return r.ok;
    } catch {
        return false;
    }
}

const reachable = await isPebbleReachable();
if (!reachable) {
    console.log(`(skipping pebble integration tests — ${PEBBLE_URL} unreachable)`);
}

describe.skipIf(!reachable)("ACME flow against pebble", () => {
    /** @type {string} */ let tmpDir;
    /** @type {string} */ let statePath;
    /** @type {import("./browserEnv.js").Env} */ let env;

    beforeAll(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "bugspray-itest-"));
        statePath = join(tmpDir, "state.json");
        env = buildNodeEnv({statePath});
        resetNoncePools();
    });

    afterAll(() => {
        rmSync(tmpDir, {recursive: true, force: true});
    });

    test("directory → nonce → newAccount → newOrder → reload authz", async () => {
        // 1. Fetch directory (plain GET, capture any replay-nonce header).
        const resp = await env.fetch(PEBBLE_URL);
        expect(resp.ok).toBe(true);
        const dirJson = await resp.json();
        env.objectStore.put({
            url: PEBBLE_URL, name: '', type: 'directory', parent: '', resource: dirJson,
        });
        getNoncePool(env, PEBBLE_URL).captureFromHeaders(resp.headers);
        expect(typeof dirJson.newNonce).toBe('string');
        expect(typeof dirJson.newAccount).toBe('string');
        expect(typeof dirJson.newOrder).toBe('string');

        const dir = new AcmeDirectory(env.objectStore.get(PEBBLE_URL), env);

        // 2. Get a fresh nonce so we don't depend on the directory GET returning one.
        const nonce = await dir.newNonce();
        expect(typeof nonce).toBe('string');
        expect(getNoncePool(env, PEBBLE_URL).entries.length).toBeGreaterThan(0);

        // 3. newAccount embeds JWK in protected header (kid=null).
        const acctResult = await dir.newAccount(
            {termsOfServiceAgreed: true, contact: ['mailto:test@example.com']},
            'test-key',
        );
        expect(acctResult.ok).toBe(true);
        const accountUrl = acctResult.targetUrl;
        expect(accountUrl).toMatch(/^https?:\/\//);
        const acct = env.objectStore.get(accountUrl);
        expect(acct.type).toBe('account');
        expect(acct.parent).toBe(PEBBLE_URL);
        expect(acct.resource.status).toBe('valid');

        // 4. newOrder for an arbitrary identifier; pebble accepts anything.
        const domain = `example-${Date.now()}.test`;
        const orderResult = await dir.newOrder(
            {identifiers: [{type: 'dns', value: domain}]},
            'test-key',
            accountUrl,
        );
        expect(orderResult.ok).toBe(true);
        const orderUrl = orderResult.targetUrl;
        const orderStored = env.objectStore.get(orderUrl);
        expect(orderStored.type).toBe('order');
        expect(orderStored.parent).toBe(accountUrl);
        expect(['pending', 'ready']).toContain(orderStored.resource.status);
        expect(Array.isArray(orderStored.resource.authorizations)).toBe(true);
        expect(orderStored.resource.authorizations.length).toBe(1);

        // newOrder's postProcess should have stitched the authz stub into the store.
        const authzUrl = orderStored.resource.authorizations[0];
        const authzStub = env.objectStore.get(authzUrl);
        expect(authzStub).toBeDefined();
        expect(authzStub.type).toBe('authorization');
        expect(authzStub.parent).toBe(orderUrl);
        expect(authzStub.resource).toBeNull();

        // 5. Reload authz (POST-as-GET) to fetch the actual challenges.
        const authzObj = new AcmeAuthorization(env.objectStore.get(authzUrl), env);
        const authzResult = await authzObj.reload();
        expect(authzResult.ok).toBe(true);
        const authz = env.objectStore.get(authzUrl);
        expect(authz.resource.identifier).toEqual({type: 'dns', value: domain});
        expect(authz.resource.status).toBe('pending');
        expect(Array.isArray(authz.resource.challenges)).toBe(true);
        expect(authz.resource.challenges.length).toBeGreaterThan(0);

        // postReload should have stitched a challenge stub for each challenge.
        for (const ch of authz.resource.challenges) {
            const stub = env.objectStore.get(ch.url);
            expect(stub).toBeDefined();
            expect(stub.type).toBe('challenge');
            expect(stub.parent).toBe(authzUrl);
            expect(stub.key).toBe('test-key');
        }
    }, 30000);
});
