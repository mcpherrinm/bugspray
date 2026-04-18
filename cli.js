#!/usr/bin/env bun
import {readFileSync, writeFileSync, unlinkSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {buildNodeEnv} from "./nodeEnv.js";
import {
    AcmeDirectory, AcmeOrder, AcmeAuthorization, AcmeChallenge,
    fromStored, getNoncePool, resetNoncePools,
    NO_NONCE_SENTINEL, buildSigned, submitSigned,
} from "./acme.js";

/**
 * @typedef {import("./browserEnv.js").Env} Env
 * @typedef {import("./storage.js").StoredObject} StoredObject
 */

// ---------------------------------------------------------------------------
// argv parser
// ---------------------------------------------------------------------------

/** @param {string[]} argv */
function parseArgs(argv) {
    /** @type {string[]} */
    const positionals = [];
    /** @type {Record<string, string | true>} */
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) { positionals.push(a); continue; }
        const body = a.slice(2);
        let name;
        /** @type {string | true} */
        let val;
        if (body.includes('=')) {
            const eq = body.indexOf('=');
            name = body.slice(0, eq);
            val = body.slice(eq + 1);
        } else {
            name = body;
            const next = argv[i + 1];
            if (next !== undefined && !next.startsWith('--')) {
                val = next;
                i++;
            } else {
                val = true;
            }
        }
        flags[name] = val;
    }
    return {positionals, flags};
}

/** @param {Record<string, string | true>} flags @param {string} name */
function strFlag(flags, name) {
    return typeof flags[name] === 'string' ? /** @type {string} */ (flags[name]) : null;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** @param {string} msg */
function die(msg) { console.error(msg); process.exit(1); }

/** @param {Env} env @param {string} url */
function findDirectoryUrl(env, url) {
    let cur = env.objectStore.get(url);
    let here = url;
    while (cur && cur.type !== 'directory') {
        here = cur.parent;
        cur = env.objectStore.get(here);
    }
    return cur ? cur.url : null;
}

/** @param {Env} env @param {string} url */
function findAccountUrl(env, url) {
    let cur = env.objectStore.get(url);
    let here = url;
    while (cur && cur.type !== 'account') {
        here = cur.parent;
        cur = env.objectStore.get(here);
    }
    return cur ? cur.url : null;
}

/** @param {Env} env @param {string} parentUrl @param {string} type */
function childrenOfType(env, parentUrl, type) {
    /** @type {StoredObject[]} */
    const out = [];
    for (const [, o] of env.objectStore.list()) {
        if (o.parent === parentUrl && o.type === type) out.push(o);
    }
    return out;
}

/** @param {string} body @param {string | null} ct */
function prettyBody(body, ct) {
    if (!body) return '';
    if (!ct || ct.includes('json')) {
        try { return JSON.stringify(JSON.parse(body), null, 2); } catch { /* fall through */ }
    }
    return body;
}

/** @param {Env} env @param {string} type */
function postProcessFor(env, type) {
    if (type === 'order') {
        return (/** @type {any} */ resource, /** @type {string} */ targetUrl) => {
            const s = env.objectStore.get(targetUrl);
            if (s) new AcmeOrder(s, env).postReload(resource, targetUrl);
        };
    }
    if (type === 'authorization') {
        return (/** @type {any} */ resource, /** @type {string} */ targetUrl) => {
            const s = env.objectStore.get(targetUrl);
            if (s) new AcmeAuthorization(s, env).postReload(resource, targetUrl);
        };
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// subcommand: directory <url>
// ---------------------------------------------------------------------------

/** @param {Env} env @param {string} url @param {string} name */
async function cmdDirectory(env, url, name) {
    const resp = await env.fetch(url);
    const text = await resp.text();
    if (!resp.ok) {
        console.error(`${resp.status} ${resp.statusText}`);
        console.error(text);
        process.exit(1);
    }
    getNoncePool(env, url).captureFromHeaders(resp.headers);
    const directory = JSON.parse(text);
    env.objectStore.put({url, name: name || '', type: 'directory', parent: '', resource: directory});
    console.log(`directory stored: ${url}`);
    console.log(`Next: bun run cli.js view ${url}`);
}

// ---------------------------------------------------------------------------
// subcommand: list / tree / raw / view / nonce / clear
// ---------------------------------------------------------------------------

/** @param {Env} env @param {string | null} type */
function cmdList(env, type) {
    let any = false;
    for (const [url, o] of env.objectStore.list()) {
        if (type && o.type !== type) continue;
        const label = o.name ? ` (${o.name})` : '';
        console.log(`[${o.type}] ${url}${label}`);
        any = true;
    }
    if (!any) console.log('(empty)');
}

/** @param {Env} env */
function cmdTree(env) {
    /** @type {Map<string, StoredObject[]>} */
    const byParent = new Map();
    for (const [, o] of env.objectStore.list()) {
        const arr = byParent.get(o.parent) || [];
        arr.push(o);
        byParent.set(o.parent, arr);
    }
    /** @param {string} parentUrl @param {number} depth */
    function render(parentUrl, depth) {
        const kids = byParent.get(parentUrl) || [];
        for (const k of kids) {
            const label = k.name ? ` (${k.name})` : '';
            console.log(`${'  '.repeat(depth)}[${k.type}] ${k.url}${label}`);
            render(k.url, depth + 1);
        }
    }
    render('', 0);
}

/** @param {Env} env @param {string} url */
function cmdRaw(env, url) {
    const s = env.objectStore.get(url);
    if (!s) die(`unknown URL: ${url}`);
    console.log(JSON.stringify({
        resource: s.resource,
        lastRequest: s.lastRequest,
        lastResponse: s.lastResponse,
    }, null, 2));
}

/** @param {Env} env @param {string} url */
async function cmdView(env, url) {
    const stored = env.objectStore.get(url);
    if (!stored) die(`unknown URL: ${url}`);
    console.log(`[${stored.type}] ${url}`);
    if (stored.name) console.log(`  name: ${stored.name}`);

    if (stored.type === 'nonces') {
        const pool = getNoncePool(env, stored.parent);
        console.log(`  pool size: ${pool.entries.length}`);
        for (const e of pool.entries) {
            const t = e.timestamp ? new Date(e.timestamp).toISOString() : 'unknown';
            console.log(`    ${e.nonce}  (${t})`);
        }
        return;
    }

    if (!stored.resource) {
        console.log('  (resource not yet fetched)');
        console.log(`Next: bun run cli.js call ${url} reload`);
        return;
    }

    const obj = fromStored(stored, env);
    for (const [k, v] of obj.displayFields()) {
        console.log(`  ${k}: ${v}`);
    }
    const kids = obj.children();
    if (kids.length > 0) {
        console.log('children:');
        for (const ch of kids) console.log(`  ${ch.label}: ${ch.url}`);
    }
    const methods = obj.methodNames().filter(m => obj.methodEnabled(m));
    if (methods.length > 0) console.log(`methods: ${methods.join(' ')}`);

    if (obj instanceof AcmeChallenge) {
        const items = await obj.instructions();
        if (items.length > 0) {
            console.log('instructions:');
            for (const item of items) {
                if (item.text) console.log(`  ${item.text}`);
                if (item.copiable) console.log(`    ${item.copiable}`);
            }
        }
    }

    printNextSteps(env, obj);
}

/** @param {Env} env @param {string} url */
async function cmdNonce(env, url) {
    const dirUrl = findDirectoryUrl(env, url);
    if (!dirUrl) die(`no directory found for ${url}`);
    const stored = env.objectStore.get(dirUrl);
    if (!stored) die(`directory not stored: ${dirUrl}`);
    const dir = new AcmeDirectory(stored, env);
    const nonce = await dir.newNonce();
    console.log(nonce ? `Added nonce: ${nonce}` : 'No replay-nonce header in response');
    console.log(`Pool size: ${getNoncePool(env, dirUrl).entries.length}`);
}

/** @param {Env} env @param {boolean} yes */
function cmdClear(env, yes) {
    if (!yes) {
        const ans = prompt('Clear all state? [y/N]');
        if (!ans || !ans.toLowerCase().startsWith('y')) {
            console.log('Aborted.');
            return;
        }
    }
    env.objectStore.clear();
    resetNoncePools();
    console.log('Cleared.');
}

// ---------------------------------------------------------------------------
// subcommand: call <url> <method>
// ---------------------------------------------------------------------------

const DEFAULT_TEMPLATES = {
    newAccount: JSON.stringify({
        termsOfServiceAgreed: true,
        contact: ["mailto:you@example.com"],
        onlyReturnExisting: false,
    }, null, 2),
    newOrder: JSON.stringify({identifiers: [{type: "dns", value: "example.com"}]}, null, 2),
    newAuthz: JSON.stringify({identifier: {type: "dns", value: "example.com"}}, null, 2),
    finalize: JSON.stringify({csr: ""}, null, 2),
    respond: JSON.stringify({}, null, 2),
};

/** Storage type to record under, for each directory-level method. */
const METHOD_TYPE = {
    newOrder: 'order',
    newAuthz: 'authorization',
    revokeCert: 'revokeCert',
    keyChange: 'keyChange',
};

/**
 * @param {Env} env
 * @param {string} url
 * @param {string} method
 * @param {Record<string, string | true>} flags
 */
async function cmdCall(env, url, method, flags) {
    const obj = env.objectStore.get(url);
    if (!obj) die(`unknown URL: ${url}`);

    let targetUrl, kid, type, parent, initialPayload;
    let normalizeCsr = false;

    if (method === 'reload') {
        if (obj.type === 'directory') die('use `directory <url>` to refresh a directory');
        targetUrl = url;
        kid = findAccountUrl(env, url);
        if (!kid) die(`no account found in parent chain of ${url}`);
        type = obj.type;
        parent = obj.parent;
        initialPayload = '';
    } else if (method === 'newAccount') {
        if (obj.type !== 'directory') die('newAccount must be called on a directory');
        targetUrl = obj.resource && obj.resource.newAccount;
        if (!targetUrl) die('directory does not advertise newAccount');
        kid = null;
        type = 'account';
        parent = url;
        initialPayload = DEFAULT_TEMPLATES.newAccount;
    } else if (METHOD_TYPE[method]) {
        let dirUrl, accountUrl;
        if (obj.type === 'directory') {
            dirUrl = url;
            const acctOverride = strFlag(flags, 'account');
            if (acctOverride) {
                accountUrl = acctOverride;
            } else {
                const accts = childrenOfType(env, url, 'account');
                if (accts.length === 0) {
                    die(`no account exists for ${url}\n` +
                        `Run: bun run cli.js call ${url} newAccount --edit`);
                }
                if (accts.length > 1) {
                    console.error('multiple accounts available; pass --account <url>:');
                    for (const a of accts) console.error(`  ${a.url}`);
                    process.exit(1);
                }
                accountUrl = accts[0].url;
            }
        } else if (obj.type === 'account') {
            accountUrl = url;
            dirUrl = obj.parent;
        } else {
            die(`${method} must be called on a directory or account`);
        }
        const dir = env.objectStore.get(dirUrl);
        if (!dir) die(`directory not stored: ${dirUrl}`);
        targetUrl = dir.resource && dir.resource[method];
        if (!targetUrl) die(`directory does not advertise ${method}`);
        kid = accountUrl;
        type = METHOD_TYPE[method];
        parent = accountUrl;
        initialPayload = DEFAULT_TEMPLATES[method] || '{}';
    } else if (method === 'finalize') {
        if (obj.type !== 'order') die('finalize must be called on an order');
        targetUrl = obj.resource && obj.resource.finalize;
        if (!targetUrl) die('order does not advertise finalize URL');
        kid = findAccountUrl(env, url);
        type = 'order';
        parent = obj.parent;
        initialPayload = DEFAULT_TEMPLATES.finalize;
        normalizeCsr = true;
    } else if (method === 'respond') {
        if (obj.type !== 'challenge') die('respond must be called on a challenge');
        targetUrl = url;
        kid = findAccountUrl(env, url);
        type = 'challenge';
        parent = obj.parent;
        initialPayload = DEFAULT_TEMPLATES.respond;
    } else {
        die(`unknown method: ${method}`);
        return; // unreachable, for typecheck
    }

    let payloadText;
    const payloadFile = strFlag(flags, 'payload-file');
    const payloadFlag = strFlag(flags, 'payload');
    if (payloadFile !== null) {
        payloadText = readFileSync(payloadFile, 'utf8');
    } else if (payloadFlag !== null) {
        payloadText = payloadFlag;
    } else {
        payloadText = initialPayload;
    }

    if (flags.edit) {
        const tmp = join(tmpdir(), `bugspray-${process.pid}-${Date.now()}.json`);
        writeFileSync(tmp, payloadText);
        const editor = process.env.EDITOR || 'vi';
        const res = spawnSync(editor, [tmp], {stdio: 'inherit'});
        if (res.status !== 0) {
            try { unlinkSync(tmp); } catch { /* ignore */ }
            console.error('Editor exited non-zero; aborting.');
            process.exit(res.status || 1);
        }
        payloadText = readFileSync(tmp, 'utf8');
        try { unlinkSync(tmp); } catch { /* ignore */ }
    }

    let payload;
    if (payloadText.trim() === '') {
        payload = '';
    } else {
        try {
            payload = JSON.parse(payloadText);
        } catch (e) {
            die(`payload is not valid JSON: ${e instanceof Error ? e.message : e}`);
            return;
        }
    }

    if (normalizeCsr && payload && typeof payload === 'object' && typeof payload.csr === 'string') {
        payload.csr = AcmeOrder.normalizeCsr(payload.csr);
    }

    const directoryUrl = findDirectoryUrl(env, url) || url;
    const pool = getNoncePool(env, directoryUrl);
    const nonce = pool.take();
    if (nonce === NO_NONCE_SENTINEL) {
        console.error('No nonce available.');
        console.error(`Next: bun run cli.js nonce ${directoryUrl}`);
        process.exit(1);
    }

    const keyName = strFlag(flags, 'key') || obj.key || 'key1';

    const {protectedData, signedBody} = await buildSigned({
        env, url: targetUrl, key: keyName, kid, nonce, payload,
    });

    console.log(`POST ${targetUrl}`);
    console.log('Content-Type: application/jose+json');
    console.log();
    console.log('--- payload ---');
    console.log(typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2));
    console.log();
    console.log('--- protected ---');
    console.log(JSON.stringify(protectedData, null, 2));
    console.log();
    console.log('--- signed ---');
    console.log(signedBody);
    console.log();

    const result = await submitSigned({
        env, url: targetUrl, signedBody,
        type, parent, name: '',
        key: keyName, directoryUrl,
        postProcess: postProcessFor(env, type),
    });

    const resp = result.lastResponse;
    console.log(`${result.ok ? '✓' : '✗'} ${resp.status} ${resp.statusText}`);
    for (const [k, v] of resp.headers) console.log(`${k}: ${v}`);
    console.log();
    const pretty = prettyBody(resp.body, resp.contentType);
    if (pretty) console.log(pretty);
    console.log();

    if (!result.ok) {
        console.log(`Next: bun run cli.js nonce ${directoryUrl}`);
        process.exit(1);
    }

    console.log(`Stored ${type}.`);
    const newStored = env.objectStore.get(result.targetUrl);
    if (newStored) {
        const newObj = fromStored(newStored, env);
        await printNextSteps(env, newObj);
    }
}

// ---------------------------------------------------------------------------
// next-step hints
// ---------------------------------------------------------------------------

/** @param {Env} env @param {import("./acme.js").AcmeObject} obj */
function printNextSteps(env, obj) {
    const type = obj.type;
    const url = obj.url;
    const r = obj.resource;
    if (type === 'directory') {
        const accts = childrenOfType(env, url, 'account');
        const pool = getNoncePool(env, url);
        /** @type {string[]} */
        const hints = [];
        if (pool.entries.length === 0) hints.push(`bun run cli.js nonce ${url}`);
        if (accts.length > 0) {
            for (const a of accts) hints.push(`bun run cli.js call ${a.url} newOrder --edit`);
        } else {
            hints.push(`bun run cli.js call ${url} newAccount --edit`);
        }
        console.log('Next:');
        for (const h of hints) console.log(`  ${h}`);
        return;
    }
    if (type === 'account') {
        console.log(`Next: bun run cli.js call ${url} newOrder --edit`);
        return;
    }
    if (type === 'order') {
        const status = r && r.status;
        const authzUrls = r && Array.isArray(r.authorizations) ? r.authorizations : [];
        if (status === 'pending') {
            console.log('Next:');
            for (const u of authzUrls) console.log(`  bun run cli.js view ${u}`);
        } else if (status === 'ready') {
            console.log(`Next: bun run cli.js call ${url} finalize --edit`);
        } else if (status === 'processing') {
            console.log(`Next: bun run cli.js call ${url} reload`);
        } else if (status === 'valid' && r.certificate) {
            console.log(`Next: bun run cli.js view ${r.certificate}`);
        }
        return;
    }
    if (type === 'authorization') {
        if (!r) {
            console.log(`Next: bun run cli.js call ${url} reload`);
            return;
        }
        const chs = Array.isArray(r.challenges) ? r.challenges : [];
        const pending = chs.filter(/** @param {any} c */ c => c.status === 'pending');
        if (pending.length > 0) {
            console.log('Next:');
            for (const c of pending) console.log(`  bun run cli.js view ${c.url}`);
        }
        return;
    }
    if (type === 'challenge') {
        const status = r && r.status;
        if (status === 'pending') {
            console.log(`Next: bun run cli.js call ${url} respond`);
        } else if (status === 'processing') {
            console.log(`Next: bun run cli.js call ${url} reload`);
        }
        return;
    }
    if (type === 'certificate') {
        if (r && Array.isArray(r.chain)) {
            console.log(`chain length: ${r.chain.length}`);
        }
        if (obj.parent) console.log(`Next: bun run cli.js view ${obj.parent}`);
    }
}

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------

/** @param {string} [cmd] */
function cmdHelp(cmd) {
    const usage = {
        directory: 'directory <url> [--name <str>]   fetch and store a directory (plain GET)',
        list:      'list [--type <t>]                list stored objects',
        tree:      'tree                             print object tree',
        view:      'view <url>                       show an object, methods, and next steps',
        raw:       'raw <url>                        dump resource + last HTTP exchange as JSON',
        nonce:     'nonce <url>                      GET newNonce for the URL\'s directory',
        call:      'call <url> <method> [--payload <json>] [--payload-file <p>] [--edit] [--key <n>] [--account <a>]',
        reload:    'reload <url> [--edit]            alias for `call <url> reload`',
        clear:     'clear [--yes]                    wipe the state file and nonce pools',
        help:      'help [<command>]                 this help',
    };
    if (cmd && usage[cmd]) {
        console.log(`bun run cli.js ${usage[cmd]}`);
        return;
    }
    console.log('bun run cli.js <command> [args]');
    console.log('commands:');
    for (const k of Object.keys(usage)) console.log(`  ${usage[k]}`);
    console.log('');
    console.log('global flags:');
    console.log('  --state <path>   state file (default ./bugspray-state.json)');
    console.log('');
    console.log('compat: `bun run cli.js <https-url>` is shorthand for `directory <url>`.');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const {positionals, flags} = parseArgs(process.argv.slice(2));
const statePath = strFlag(flags, 'state') || './bugspray-state.json';
const env = buildNodeEnv({statePath});

const cmd = positionals[0];

if (cmd === undefined) {
    console.log('usage: bun run cli.js <command> [args]');
    console.log('try:   bun run cli.js help');
    process.exit(1);
}

switch (cmd) {
    case 'directory':
        if (!positionals[1]) { cmdHelp('directory'); process.exit(1); }
        await cmdDirectory(env, positionals[1], strFlag(flags, 'name') || '');
        break;
    case 'list':
        cmdList(env, strFlag(flags, 'type'));
        break;
    case 'tree':
        cmdTree(env);
        break;
    case 'view':
        if (!positionals[1]) { cmdHelp('view'); process.exit(1); }
        await cmdView(env, positionals[1]);
        break;
    case 'raw':
        if (!positionals[1]) { cmdHelp('raw'); process.exit(1); }
        cmdRaw(env, positionals[1]);
        break;
    case 'nonce':
        if (!positionals[1]) { cmdHelp('nonce'); process.exit(1); }
        await cmdNonce(env, positionals[1]);
        break;
    case 'call':
        if (!positionals[1] || !positionals[2]) { cmdHelp('call'); process.exit(1); }
        await cmdCall(env, positionals[1], positionals[2], flags);
        break;
    case 'reload':
        if (!positionals[1]) { cmdHelp('reload'); process.exit(1); }
        await cmdCall(env, positionals[1], 'reload', flags);
        break;
    case 'clear':
        cmdClear(env, !!flags.yes);
        break;
    case 'help':
        cmdHelp(positionals[1]);
        break;
    default:
        if (cmd.startsWith('http://') || cmd.startsWith('https://')) {
            await cmdDirectory(env, cmd, strFlag(flags, 'name') || '');
        } else {
            console.error(`unknown command: ${cmd}`);
            cmdHelp();
            process.exit(1);
        }
}
