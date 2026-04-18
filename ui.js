import {clearStorage, getObject, listObjects} from "./storage.js";
import {renderTreeview, setSelectedUrl} from "./nav.js";
import {buildBrowserEnv} from "./browserEnv.js";
import {getNoncePool, resetNoncePools, fromStored, AcmeDirectory, AcmeOrder, AcmeChallenge} from "./acme.js";

const env = buildBrowserEnv();

export function setup() {
    // NoncePool.load is lazy; touching each directory's pool here primes the
    // registry so listObjects already shows the correct names in the treeview.
    for (const [, object] of listObjects()) {
        if (object.type === 'nonces') {
            getNoncePool(env, object.parent);
        }
    }
    renderTreeview();
    document.querySelector('button#new-directory').addEventListener('click', () => {
        setSelectedUrl(null);
        renderTreeview();
        newDirectory();
    });
    document.querySelector('button#clear-storage').addEventListener('click', () => {
        if (!confirm("Are you sure you want to clear all data?")) {
            return
        }
        clearStorage();
        resetNoncePools();
        setSelectedUrl(null);
        renderTreeview();
        newDirectory();
    });
    newDirectory();
}

function div(...obj) {
    let d = document.createElement('div')
    d.replaceChildren(...obj)
    return d
}

function element(tag, innerText) {
    let e = document.createElement(tag);
    e.innerText = innerText;
    return e;
}

function copiable(value) {
    let e = document.createElement('input');
    e.type = 'text';
    e.readOnly = true;
    e.value = value;
    e.className = 'copiable';
    return e;
}

function label(id, text) {
    let e = document.createElement('label');
    e.htmlFor = id;
    e.innerText = text;
    return e;
}

function input(form, id, labelText, value) {
    let inputElement = document.createElement('input');
    inputElement.id = id;
    inputElement.name = id;
    inputElement.value = value;

    let r = div(label(id, labelText), inputElement);
    r.className = "inputWrapper";

    form.appendChild(r)

    return inputElement
}

function select(form, id, labelText, options) {
    let selectElement = document.createElement('select');
    selectElement.id = id;
    selectElement.name = id;

    for (const [val, text] of Object.entries(options)) {
        let opt = document.createElement('option');
        opt.value = val;
        opt.text = text;
        selectElement.appendChild(opt);
    }

    let r = div(label(id, labelText), selectElement);
    r.className = "inputWrapper";

    form.appendChild(r)

    return selectElement
}

function multi(form, id, name, createRow) {
    let multiList = document.createElement("ul");
    multiList.id = id;
    multiList.style.listStyle = 'none';

    let rows = [];

    const addRow = () => {
        const li = document.createElement('li');
        li.className = 'multi-row';

        const rowData = createRow();
        const rowElt = rowData.elt || rowData;
        const getValue = rowData.getValue || (() => rowElt.value);

        const removeButton = element('button', 'Remove');
        removeButton.type = 'button';
        removeButton.className = 'multi-remove';
        removeButton.onclick = () => {
            multiList.removeChild(li);
            rows = rows.filter(r => r.li !== li);
        };

        li.appendChild(rowElt);
        li.appendChild(removeButton);
        multiList.appendChild(li);
        rows.push({li, getValue});
    };

    const addButton = element('button', 'Add');
    addButton.type = 'button';
    addButton.className = 'multi-add';
    addButton.onclick = addRow;

    const container = div(element('p', name), multiList, addButton);
    container.className = "inputWrapper";
    form.appendChild(container);

    return {
        elt: container,
        values: function () {
            return rows.map(r => r.getValue());
        }
    }
}

function checkbox(form, id, labelText, nextToCheckbox) {
    let checkboxElement = document.createElement('input');
    checkboxElement.id = id;
    checkboxElement.name = id;
    checkboxElement.type = 'checkbox';

    let r = div(label(id, labelText), div(checkboxElement, nextToCheckbox));
    r.className = "checkboxWrapper";

    form.appendChild(r)

    return checkboxElement;
}

function viewObject(url) {
    renderObject(url, getObject(url));
}

function renderMethod(name, directory, signer) {
    let button = element('button', name);
    button.className = 'method';
    if (directory.resource[name] !== undefined) {
        button.onclick = () => runMethod(name, directory, signer);
    } else {
        button.disabled = true;
    }

    return button;
}

function renderDirectory(url, directory) {
    let metadataDiv = div(element('h2', 'Metadata'));

    for (const [key, value] of Object.entries(directory.resource['meta'])) {
        let p = document.createElement('p');
        p.innerText = `${key}: ${JSON.stringify(value, null, 2)}`;
        metadataDiv.appendChild(p)
    }

    let methodsHeader = element('h2', 'Methods');

    let methodsDiv = div(methodsHeader);
    const methods = [['newNonce', 'newAccount', 'newOrder', 'newAuthz'], ['revokeCert', 'keyChange', 'renewalInfo']];
    for (const row of methods) {
        const rowDiv = div();
        rowDiv.className = 'row';
        for (const method of row) {
            rowDiv.appendChild(renderMethod(method, directory));
        }
        methodsDiv.appendChild(rowDiv);
    }

    let dirDiv = div(metadataDiv, methodsDiv)

    let unknownDiv = div(element('h2', 'Unknown Directory Entries'));
    let unknown = false;
    for (const [key, value] of Object.entries(directory.resource)) {
        if (key === "meta" || methods[0].includes(key) || methods[1].includes(key)) {
            continue
        }
        unknownDiv.appendChild(element('p', `${key}: ${JSON.stringify(value)}`));
        unknown = true;
    }
    if (unknown) {
        dirDiv.appendChild(unknownDiv)
    }
    return dirDiv;
}

/**
 * Generic renderer driven by AcmeObject methods. Used for account, order,
 * authorization, certificate. Directory and challenge have specialized renderers.
 * @param {import("./acme.js").AcmeObject} obj
 */
function renderGeneric(obj) {
    const d = div();
    for (const [k, v] of obj.displayFields()) {
        d.appendChild(element('p', `${k}: ${v}`));
    }
    const kids = obj.children();
    if (kids.length > 0) {
        d.appendChild(element('h2', 'Children'));
        const list = document.createElement('ul');
        for (const ch of kids) {
            const li = document.createElement('li');
            const btn = element('button', `${ch.label} - ${ch.url}`);
            btn.onclick = () => viewObject(ch.url);
            li.appendChild(btn);
            list.appendChild(li);
        }
        d.appendChild(list);
    }
    const methods = obj.methodNames();
    if (methods.length > 0) {
        const methodsDiv = div(element('h2', 'Methods'));
        const row = div();
        row.className = 'row';
        for (const m of methods) {
            const btn = element('button', m);
            btn.className = 'method';
            if (obj.methodEnabled(m)) {
                btn.onclick = () => dispatchObjectMethod(obj, m);
            } else {
                btn.disabled = true;
            }
            row.appendChild(btn);
        }
        methodsDiv.appendChild(row);
        d.appendChild(methodsDiv);
    }
    return d;
}

/**
 * @param {import("./acme.js").AcmeObject} obj
 * @param {string} method
 */
function dispatchObjectMethod(obj, method) {
    if (obj.type === 'account') {
        const directoryStored = getObject(obj.directoryUrl);
        if (directoryStored) {
            runMethod(method, directoryStored, {kid: obj.url, key: obj.keyName});
        }
        return;
    }
    if (obj instanceof AcmeOrder && method === 'finalize') {
        runFinalizeOrder(obj.url, obj.stored);
        return;
    }
    if (obj instanceof AcmeChallenge && method === 'respond') {
        postWithPreview((confirm) => obj.respond({confirm})).then(renderTreeview);
        return;
    }
}

/**
 * Renders a challenge: generic header + per-type instructions panel.
 * @param {AcmeChallenge} ch
 */
async function renderChallenge(ch) {
    const d = renderGeneric(ch);
    const items = await ch.instructions();
    if (items.length > 0) {
        d.appendChild(element('h2', 'Instructions'));
        for (const item of items) {
            if (item.text !== undefined) d.appendChild(element('p', item.text));
            if (item.copiable !== undefined) d.appendChild(copiable(item.copiable));
        }
    }
    return d;
}

function renderNonces(url, object) {
    const directoryUrl = object.parent;
    const pool = getNoncePool(env, directoryUrl);
    let d = div(element('h2', 'Nonces in Pool'));
    let list = document.createElement('ul');
    list.className = 'nonceList';
    pool.entries.forEach((item) => {
        let li = document.createElement('li');
        li.className = 'nonceRow';

        let nonceText = element('span', item.nonce);
        nonceText.className = 'nonceValue';

        let timeText = element('span', item.timestamp ? new Date(item.timestamp).toLocaleString() : 'unknown time');
        timeText.className = 'nonceTime';

        let del = element('button', '✕');
        del.className = 'nonceDelete';
        del.title = 'Delete nonce';
        del.onclick = () => {
            pool.delete(item.nonce);
            renderTreeview();
            renderObject(url, getObject(url));
        };

        li.append(nonceText, timeText, del);
        list.appendChild(li);
    });
    d.appendChild(list);
    return d;
}

// View an object. Will dispatch to the correct view* function based on type
export async function renderObject(url, object) {
    setSelectedUrl(url);
    renderTreeview();
    let text = `${object.type}`
    if (object.name !== '') {
        text = `${object.name} ${text}`
    }
    let h1 = element('h1', text)

    let resourceURL = element('pre', url)

    let reloadBtn = element('button', 'Reload');
    reloadBtn.onclick = async () => {
        const obj = fromStored(object, env);
        await postWithPreview((confirm) => obj.reload({confirm}));
    };

    if (!object.resource) {
        let msg = element('p', 'Resource not yet fetched. Click Reload to fetch.');
        document.getElementById('poker').replaceChildren(h1, div(resourceURL, reloadBtn), msg);
        return;
    }

    let resource;
    if (object.type === 'directory') {
        resource = renderDirectory(url, object);
    } else if (object.type === 'nonces') {
        document.getElementById('poker').replaceChildren(renderNonces(url, object));
        return;
    } else {
        const obj = fromStored(object, env);
        if (obj instanceof AcmeChallenge) {
            resource = await renderChallenge(obj);
        } else {
            resource = renderGeneric(obj);
        }
    }

    let rawH2 = element('h2', 'Resource JSON');
    let raw = document.createElement('textarea')
    raw.className = 'rawObject';
    raw.value = JSON.stringify(object.resource, null, 2);

    document.getElementById('poker').replaceChildren(h1, div(resourceURL, reloadBtn), resource, div(rawH2, raw));
}

function goButton(id, label, onClick) {
    let go = document.createElement('button');
    go.type = 'button';
    go.id = id;
    go.className = 'go';
    go.innerText = label;
    go.onclick = onClick;
    return go;
}

// New Directory creates a directory directly.
// Because it's not a POST, and not authenticated, it doesn't go through the POSTer.
function newDirectory() {
    let h1 = element('h1', 'Add Directory');

    let f = document.createElement('form');

    const name = input(f, 'name', 'Name', "Let's Encrypt Staging");
    const urlInput = input(f, 'directory-url', 'URL', "https://acme-staging-v02.api.letsencrypt.org/directory");

    f.append(goButton('go-get-directory', 'Add Directory', async () => {
        let url = urlInput.value;
        if (url === '') {
            url = urlInput.placeholder;
        }

        console.log(`Getting directory url ${url}`)
        try {
            const resp = await env.fetch(url);
            getNoncePool(env, url).captureFromHeaders(resp.headers);
            const directory = await resp.json();
            env.objectStore.put({url, name: name.value, type: 'directory', parent: '', resource: directory});
        } catch (e) {
            console.log(`Failed to fetch directory ${url}: ${e}`);
            let err = document.createElement('p');
            err.innerText = e;
            f.appendChild(err);
            return
        }

        renderTreeview();
        viewObject(url);
    }));

    document.getElementById('poker').replaceChildren(h1, f);
}

/** @param {HTMLFormElement} form @param {AcmeDirectory} dirObj */
function newNonceForm(form, dirObj) {
    let output = document.createElement('p');
    form.appendChild(goButton('go-get-nonce', 'Get Nonce', async () => {
        try {
            const nonce = await dirObj.newNonce();
            renderTreeview();
            output.innerText = nonce ? `Added nonce: ${nonce}` : 'No nonce returned in headers';
        } catch (e) {
            output.innerText = `Error: ${e}`;
        }
    }));
    form.appendChild(output);
}

// New Account. RFC 8555 Section 7.3
function newAccountForm(f, directory) {
    const contact = multi(f, 'contact', 'Contacts (optional)', () => {
        const i = document.createElement('input');
        i.type = 'text';
        i.placeholder = 'mailto:admin@example.com';
        return i;
    });

    let tosLink = element('a', 'Terms of Service');
    tosLink.href = directory.resource['meta']['termsOfService'];
    const tosAgreed = checkbox(f, 'tosAgreed', 'Agree to Terms of Service', tosLink);

    const onlyReturnExisting = checkbox(f, 'onlyReturnExisting', 'Only return existing', 'Don\'t create a new account: Look up by account key');

    // Warn that EAB isn't implemented if required
    if (directory.resource['meta']['externalAccountRequired']) {
        f.appendChild(element('p', "⚠️ External Account Binding is required, but not implemented."));
    }

    return () => ({
        termsOfServiceAgreed: tosAgreed.checked,
        contact: contact.values(),
        onlyReturnExisting: onlyReturnExisting.checked ? true : undefined,
    });
}

function newOrderForm(f, directory) {
    let profiles = directory.resource?.meta?.profiles;
    let profileSelect = null;
    if (profiles) {
        let options = {'': 'Default (None)'};
        for (const p of Object.keys(profiles)) {
            options[p] = p;
        }
        profileSelect = select(f, 'profile', 'Profile (optional)', options);
    }

    const identifiers = multi(f, 'identifiers', 'Identifiers', () => {
        const type = document.createElement('select');
        const dns = document.createElement('option');
        dns.text = 'dns';
        dns.value = 'dns';
        type.add(dns);
        const ip = document.createElement('option');
        ip.text = 'ip';
        ip.value = 'ip';
        type.add(ip);

        const val = document.createElement('input');
        val.type = 'text';
        val.placeholder = 'example.com';

        const elt = div(type, val);
        elt.style.display = 'flex';
        elt.style.flex = '1';
        elt.style.gap = '0.5rem';
        elt.style.alignItems = 'center';

        return {
            elt,
            getValue: () => {
                return {
                    type: type.value,
                    value: val.value
                }
            }
        }
    });

    const notBefore = input(f, 'notBefore', 'Not Before (optional)', '');
    notBefore.type = 'datetime-local';
    const notAfter = input(f, 'notAfter', 'Not After (optional)', '');
    notAfter.type = 'datetime-local';

    return () => {
        const msg = {
            identifiers: identifiers.values(),
        };

        if (profileSelect && profileSelect.value) {
            msg.profile = profileSelect.value;
        }

        if (notBefore.value) {
            msg.notBefore = new Date(notBefore.value).toISOString();
        }

        if (notAfter.value) {
            msg.notAfter = new Date(notAfter.value).toISOString();
        }

        return msg;
    };
}


function newAuthzForm(f, directory) {
    f.appendChild(element('p', "Where did you even find a server that supports this?"));
    return () => ({});
}

function revokeCert(f, directory, kidInput) {
    f.appendChild(element('p', "TODO: Implement me."));

    const useKID = checkbox(f, 'useKID', 'Use KID', 'we need to allow providing a key for revoking with a key');

    return () => {
        return {
            msg: {},
            kid: useKID.checked ? kidInput.value : null,
        }
    }
}

function keyChange(f, directory) {
    f.appendChild(element('p', "TODO: Implement me."));
    return () => {
        return {
            msg: {},
        }
    }
}

function renewalInfo(f, url) {
    f.appendChild(element('p', "TODO: Implement me."));
}

function runFinalizeOrder(url, object) {
    const h1 = element('h1', 'Run finalize');

    let f = document.createElement('form');

    let kid = url;
    let cur = object;
    while (cur && cur.type !== 'account') {
        kid = cur.parent;
        cur = getObject(kid);
    }

    let keyInput = input(f, 'keyName', 'Signing key', object.key || 'key1');
    let kidInput = input(f, 'kid', 'Key ID (Account URI)', kid);

    let csrInput = document.createElement('textarea');
    csrInput.id = 'csr-input';
    csrInput.placeholder = '-----BEGIN CERTIFICATE REQUEST-----\n...\n-----END CERTIFICATE REQUEST-----';
    csrInput.className = 'rawObject';
    f.appendChild(div(label('csr-input', 'CSR (PEM or Base64url-encoded DER):'), csrInput));

    const go = goButton('go-run-method', 'Run finalize', async () => {
        const stored = {...object, key: keyInput.value};
        const order = new AcmeOrder(stored, env);
        await postWithPreview((confirm) => order.finalize(csrInput.value, {confirm}));
    });

    document.getElementById('poker').replaceChildren(h1, f, go);
}

function runMethod(method, directory, signer) {
    const h1 = element('h1', `Run ${method}`);

    let f = document.createElement('form');

    let keyInput = input(f, 'keyName', 'Signing key', (signer && signer.key) || 'key1');
    let kidInput = input(f, 'kid', 'Key ID (Account URI)', (signer && signer.kid) || '');

    /** @type {(formGetData: () => any) => Promise<void>} */
    let invoke = async () => {};
    /** @type {(() => any) | null} */
    let getData = null;
    const dirObj = new AcmeDirectory(directory, env);

    switch (method) {
        case 'newNonce':
            newNonceForm(f, dirObj);
            document.getElementById('poker').replaceChildren(h1, f);
            return;
        case 'newAccount':
            getData = newAccountForm(f, directory);
            invoke = async (g) => {
                await postWithPreview((confirm) =>
                    dirObj.newAccount(g(), keyInput.value, {confirm}));
            };
            break;
        case 'newOrder':
            getData = newOrderForm(f, directory);
            invoke = async (g) => {
                await postWithPreview((confirm) =>
                    dirObj.newOrder(g(), keyInput.value, kidInput.value, {confirm}));
            };
            break;
        case 'newAuthz':
            getData = newAuthzForm(f, directory);
            invoke = async (g) => {
                await postWithPreview((confirm) =>
                    dirObj.newAuthz(g(), keyInput.value, kidInput.value, {confirm}));
            };
            break;
        case 'revokeCert':
        case 'keyChange':
            f.appendChild(element('p', 'TODO: Implement me.'));
            document.getElementById('poker').replaceChildren(h1, f);
            return;
        case 'renewalInfo':
            f.appendChild(element('p', 'TODO: Implement me.'));
            document.getElementById('poker').replaceChildren(h1, f);
            return;
        default:
            document.getElementById('poker').replaceChildren(h1, 'Unknown? How did you get here?');
            return;
    }

    const go = goButton('go-run-method', `Run ${method}`, () => invoke(getData));
    document.getElementById('poker').replaceChildren(h1, f, go);
}

/**
 * Run a request that needs the editable preview UI before sending. The caller
 * supplies a function that takes a ConfirmHook and returns the postSigned
 * promise. We render the result page when it resolves.
 * @param {(confirm: import("./acme.js").ConfirmHook) => Promise<import("./acme.js").PostSignedResult | null>} runWithConfirm
 */
async function postWithPreview(runWithConfirm) {
    const result = await runWithConfirm(showPreviewAndAwaitSubmit);
    if (result === null) return; // cancelled
    renderTreeview();
    renderResult(result);
}

/** @type {import("./acme.js").ConfirmHook} */
async function showPreviewAndAwaitSubmit({protectedData, defaultSigned, msg, url}) {
    return new Promise((resolve) => {
        const h1 = element('h1', 'Submit Request');
        const f = document.createElement('form');

        const msgArea = element('textarea', '');
        msgArea.value = typeof msg === 'string' ? msg : JSON.stringify(msg, null, 2);
        f.appendChild(msgArea);

        const protArea = element('textarea', '');
        protArea.id = 'protected';
        protArea.value = JSON.stringify(protectedData, null, 2);
        f.appendChild(div(label('protected', 'Protected Data'), protArea));

        const signedArea = element('textarea', '');
        signedArea.id = 'signed';
        signedArea.value = defaultSigned;
        f.appendChild(div(label('signed', 'Signed Data'), signedArea));

        const go = goButton('submit', 'Submit Request', () => {
            const pending = element('h1', 'Submitting...');
            document.getElementById('poker').replaceChildren(pending);
            resolve(signedArea.value);
        });

        document.getElementById('poker').replaceChildren(h1, f, go);
    });
}

/** @param {import("./acme.js").PostSignedResult} result */
function renderResult(result) {
    const h1 = element('h1', 'Result');
    const location = element('p', result.targetUrl);
    const resource = element('textarea', '');
    resource.value = JSON.stringify(result.resource, null, 2);
    resource.id = 'result';
    const view = goButton('view', 'Go to object', () => {
        viewObject(result.targetUrl);
    });
    document.getElementById('poker').replaceChildren(h1, location, resource, view);
}

