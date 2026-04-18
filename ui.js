import {clearStorage, getObject, listObjects} from "./storage.js";
import {renderTreeview, setSelectedUrl} from "./nav.js";
import {buildBrowserEnv} from "./browserEnv.js";
import {
    getNoncePool, resetNoncePools, fromStored,
    AcmeDirectory, AcmeOrder, AcmeChallenge,
    buildSigned, submitSigned,
} from "./acme.js";

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
    initSplitters();
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
    if (obj instanceof AcmeDirectory) {
        runMethod(method, obj.stored, undefined);
        return;
    }
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
        renderRequester({
            title: 'Respond to Challenge',
            url: obj.url,
            type: obj.type,
            parent: obj.parent,
            keyName: obj.keyName || 'key1',
            kid: obj.accountUrl || '',
            directoryUrl: obj.directoryUrl || obj.parent,
            buildForm: () => () => ({}),
        });
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

    const obj = fromStored(object, env);

    let reloadBtn = element('button', 'Reload');
    reloadBtn.onclick = () => reloadObjectImmediate(obj);

    let reloadReqBtn = element('button', 'Reload Request');
    reloadReqBtn.onclick = () => openReloadRequester(obj);
    if (object.type === 'directory') reloadReqBtn.disabled = true;

    const reloadRow = div(reloadBtn, reloadReqBtn);

    if (!object.resource) {
        let msg = element('p', 'Resource not yet fetched. Click Reload to fetch.');
        document.getElementById('poker').replaceChildren(h1, div(resourceURL, reloadRow), msg);
        return;
    }

    let resource;
    if (object.type === 'nonces') {
        document.getElementById('poker').replaceChildren(renderNonces(url, object));
        return;
    }
    if (obj instanceof AcmeChallenge) {
        resource = await renderChallenge(obj);
    } else {
        resource = renderGeneric(obj);
    }

    let rawH2 = element('h2', 'Resource JSON');
    let raw = document.createElement('textarea')
    raw.className = 'rawObject';
    raw.value = JSON.stringify(object.resource, null, 2);

    document.getElementById('poker').replaceChildren(h1, div(resourceURL, reloadRow), resource, div(rawH2, raw));

    showLastExchangeForObject(url);
}

/**
 * Reload (POST-as-GET) immediately, show the exchange in #poster, stay on
 * the object view. If the nonce pool is empty, fetch a fresh nonce first so
 * the user doesn't need to click twice.
 * @param {import("./acme.js").AcmeObject} obj
 */
async function reloadObjectImmediate(obj) {
    if (obj instanceof AcmeDirectory) {
        await obj.reload();
        renderTreeview();
        viewObject(obj.url);
        showLastExchangeForObject(obj.url);
        return;
    }
    const dirUrl = obj.directoryUrl;
    if (dirUrl && getNoncePool(env, dirUrl).entries.length === 0) {
        const dirStored = env.objectStore.get(dirUrl);
        if (dirStored) await new AcmeDirectory(dirStored, env).newNonce();
    }
    const result = await obj.reload();
    renderTreeview();
    if (result.ok) viewObject(result.targetUrl);
    showLastExchangeForObject(result.targetUrl);
}

/**
 * Open the requester pre-populated for a POST-as-GET on this object's URL.
 * @param {import("./acme.js").AcmeObject} obj
 */
function openReloadRequester(obj) {
    renderRequester({
        title: `Reload ${obj.type}`,
        url: obj.url,
        type: obj.type,
        parent: obj.parent,
        keyName: obj.keyName || 'key1',
        kid: obj.accountUrl || '',
        directoryUrl: obj.directoryUrl || obj.parent,
        buildForm: () => () => '',
        postProcess: (resource, targetUrl) => obj.postReload(resource, targetUrl),
    });
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
    const kid = findAccountUrl(url);
    renderRequester({
        title: 'Run finalize',
        url: object.resource.finalize,
        type: 'order',
        parent: object.parent,
        keyName: object.key || 'key1',
        kid,
        directoryUrl: findDirectoryUrl(url),
        buildForm: (f) => {
            const csrInput = document.createElement('textarea');
            csrInput.id = 'csr-input';
            csrInput.placeholder = '-----BEGIN CERTIFICATE REQUEST-----\n...\n-----END CERTIFICATE REQUEST-----';
            csrInput.className = 'rawObject';
            f.appendChild(div(label('csr-input', 'CSR (PEM or Base64url-encoded DER):'), csrInput));
            return () => ({csr: AcmeOrder.normalizeCsr(csrInput.value)});
        },
        postProcess: (resource, targetUrl) => {
            new AcmeOrder({...object, key: undefined, url: targetUrl}, env)
                .postReload(resource, targetUrl);
        },
    });
}

function runMethod(method, directory, signer) {
    const h1 = element('h1', `Run ${method}`);
    let f = document.createElement('form');
    const dirObj = new AcmeDirectory(directory, env);

    if (method === 'newNonce') {
        newNonceForm(f, dirObj);
        hidePoster();
        document.getElementById('poker').replaceChildren(h1, f);
        return;
    }
    if (method === 'revokeCert' || method === 'keyChange' || method === 'renewalInfo') {
        f.appendChild(element('p', 'TODO: Implement me.'));
        hidePoster();
        document.getElementById('poker').replaceChildren(h1, f);
        return;
    }

    const accountUrl = (signer && signer.kid) || '';
    const initialKey = (signer && signer.key) || 'key1';

    if (method === 'newAccount') {
        renderRequester({
            title: `Run ${method}`,
            url: directory.resource.newAccount,
            type: 'account',
            parent: directory.url,
            keyName: initialKey,
            kid: '', // newAccount embeds JWK; KID empty means kid=null
            directoryUrl: directory.url,
            buildForm: (form) => newAccountForm(form, directory),
        });
        return;
    }

    if (method === 'newOrder') {
        renderRequester({
            title: `Run ${method}`,
            url: directory.resource.newOrder,
            type: 'order',
            parent: accountUrl,
            keyName: initialKey,
            kid: accountUrl,
            directoryUrl: directory.url,
            buildForm: (form) => newOrderForm(form, directory),
            postProcess: (resource, targetUrl) => {
                if (Array.isArray(resource.authorizations)) {
                    for (const authzUrl of resource.authorizations) {
                        if (env.objectStore.get(authzUrl)) continue;
                        env.objectStore.put({
                            url: authzUrl, type: 'authorization', name: '',
                            parent: targetUrl, resource: null, key: initialKey,
                        });
                    }
                }
                if (resource.certificate && !env.objectStore.get(resource.certificate)) {
                    env.objectStore.put({
                        url: resource.certificate, type: 'certificate', name: '',
                        parent: targetUrl, resource: null, key: initialKey,
                    });
                }
            },
        });
        return;
    }

    if (method === 'newAuthz') {
        renderRequester({
            title: `Run ${method}`,
            url: directory.resource.newAuthz,
            type: 'authorization',
            parent: accountUrl,
            keyName: initialKey,
            kid: accountUrl,
            directoryUrl: directory.url,
            buildForm: (form) => newAuthzForm(form, directory),
        });
        return;
    }

    document.getElementById('poker').replaceChildren(h1, 'Unknown? How did you get here?');
}

// ---------------------------------------------------------------------------
// Requester + Poster
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} RequesterCfg
 * @property {string} title
 * @property {string} url - initial target URL
 * @property {string} type - storage type
 * @property {string} parent
 * @property {string} [name]
 * @property {string} keyName
 * @property {string} kid - empty string means kid=null (embed JWK)
 * @property {string} directoryUrl
 * @property {(form: HTMLFormElement) => () => any} buildForm
 * @property {(resource: any, targetUrl: string) => void} [postProcess]
 */

/**
 * Wire up the column splitters so the user can drag the dividers. Each
 * `.splitter` element names the target column to resize and which side it
 * sits on. Dragging adjusts the target's width in pixels.
 */
function initSplitters() {
    document.querySelectorAll('.splitter').forEach((sp) => {
        sp.addEventListener('mousedown', (/** @type {Event} */ ev) => {
            const e = /** @type {MouseEvent} */ (ev);
            const targetId = /** @type {HTMLElement} */ (sp).dataset.resizes;
            const side = /** @type {HTMLElement} */ (sp).dataset.side;
            if (!targetId) return;
            const target = document.getElementById(targetId);
            if (!target) return;

            e.preventDefault();
            sp.classList.add('dragging');
            const startX = e.clientX;
            const startWidth = target.offsetWidth;

            function onMove(/** @type {MouseEvent} */ mv) {
                const dx = mv.clientX - startX;
                // 'left' side splitter shrinks/grows the target leftward.
                const newWidth = side === 'right' ? startWidth - dx : startWidth + dx;
                target.style.width = `${Math.max(120, newWidth)}px`;
            }
            function onUp() {
                sp.classList.remove('dragging');
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            }
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    });
}

function hidePoster() {
    const p = document.getElementById('poster');
    p.hidden = true;
    p.replaceChildren();
}

/**
 * @param {RequesterCfg} cfg
 */
function renderRequester(cfg) {
    // ---- center pane ----
    const h1 = element('h1', cfg.title);
    const form = document.createElement('form');
    const keyInput = input(form, 'keyName', 'Signing key', cfg.keyName);
    const kidInput = input(form, 'kid', 'Key ID (Account URI)', cfg.kid);
    const getMsg = cfg.buildForm(form);

    const submitBtn = goButton('submit', 'Submit', () => doSubmit());
    document.getElementById('poker').replaceChildren(h1, form, submitBtn);

    // ---- right pane (composer) ----
    const poster = document.getElementById('poster');
    poster.hidden = false;

    const reqTab = makeTabBtn('Request');
    const respTab = makeTabBtn('Response');
    const tabBar = div(reqTab, respTab);
    tabBar.className = 'tabBar';

    const reqPane = document.createElement('div');
    reqPane.className = 'tabPane';
    const respPane = document.createElement('div');
    respPane.className = 'tabPane';
    respPane.hidden = true;

    function activate(/** @type {'req'|'resp'} */ which) {
        reqTab.classList.toggle('active', which === 'req');
        respTab.classList.toggle('active', which === 'resp');
        reqPane.hidden = which !== 'req';
        respPane.hidden = which !== 'resp';
    }
    reqTab.onclick = () => activate('req');
    respTab.onclick = () => activate('resp');
    activate('req');

    const nonceBanner = document.createElement('div');
    nonceBanner.className = 'nonceMissing';
    nonceBanner.hidden = true;

    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.value = cfg.url;

    const payloadArea = document.createElement('textarea');
    const protectedArea = document.createElement('textarea');
    const signedArea = document.createElement('textarea');

    reqPane.append(
        nonceBanner,
        labeled('URL', urlInput),
        labeled('Payload', payloadArea, true),
        labeled('Protected Header', protectedArea, true),
        labeled('Signed JWS', signedArea, true),
    );

    poster.replaceChildren(tabBar, reqPane, respPane);

    // ---- nonce + signing state ----
    /** @type {string | null} */
    let currentNonce = null;
    /** @type {boolean} signed body is in sync with form state */
    let signedFresh = false;

    function showNonceBanner() {
        nonceBanner.replaceChildren();
        const msg = element('span', 'No nonce available — required to sign.');
        const fetchBtn = element('button', 'Get new nonce');
        fetchBtn.type = 'button';
        fetchBtn.onclick = async () => {
            fetchBtn.disabled = true;
            try {
                const dirStored = env.objectStore.get(cfg.directoryUrl);
                if (dirStored) {
                    await new AcmeDirectory(dirStored, env).newNonce();
                    renderTreeview();
                }
                await takeNonceAndRebuild();
            } finally {
                fetchBtn.disabled = false;
            }
        };
        nonceBanner.append(msg, fetchBtn);
        nonceBanner.hidden = false;
        submitBtn.disabled = true;
    }
    function hideNonceBanner() {
        nonceBanner.hidden = true;
        submitBtn.disabled = false;
    }

    async function takeNonceAndRebuild() {
        const pool = getNoncePool(env, cfg.directoryUrl);
        if (pool.entries.length === 0) {
            currentNonce = null;
            showNonceBanner();
            payloadArea.value = '';
            protectedArea.value = '';
            signedArea.value = '';
            return;
        }
        currentNonce = pool.take();
        renderTreeview();
        hideNonceBanner();
        await rebuildSigned();
    }

    async function rebuildSigned() {
        if (currentNonce === null) return;
        const msg = getMsg();
        const url = urlInput.value;
        const kid = kidInput.value === '' ? null : kidInput.value;
        try {
            const {protectedData, signedBody} = await buildSigned({
                env, url, key: keyInput.value, kid, nonce: currentNonce, payload: msg,
            });
            payloadArea.value = typeof msg === 'string' ? msg : JSON.stringify(msg, null, 2);
            protectedArea.value = JSON.stringify(protectedData, null, 2);
            signedArea.value = signedBody;
            signedFresh = true;
        } catch (e) {
            signedArea.value = `Error signing: ${e}`;
            signedFresh = false;
        }
    }

    form.addEventListener('input', () => { rebuildSigned(); });
    urlInput.addEventListener('input', () => { rebuildSigned(); });

    async function doSubmit() {
        if (currentNonce === null) return;
        submitBtn.disabled = true;
        try {
            const result = await submitSigned({
                env,
                url: urlInput.value,
                signedBody: signedArea.value,
                type: cfg.type,
                parent: cfg.parent,
                name: cfg.name || '',
                key: keyInput.value,
                directoryUrl: cfg.directoryUrl,
                postProcess: cfg.postProcess,
            });
            renderTreeview();
            currentNonce = null; // consumed
            if (result.ok) {
                viewObject(result.targetUrl); // also re-renders #poster with the new exchange
            } else {
                renderResponseInto(respPane, result.lastResponse);
                activate('resp');
                // Take a fresh nonce for retry
                await takeNonceAndRebuild();
            }
        } catch (e) {
            respPane.replaceChildren(element('p', `Network error: ${e}`));
            activate('resp');
        } finally {
            submitBtn.disabled = currentNonce === null;
        }
    }

    // Kick off
    takeNonceAndRebuild();
}

/** Build a tab button with `.tabBtn` styling and a data-tab attribute. */
function makeTabBtn(/** @type {string} */ text) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tabBtn';
    b.innerText = text;
    b.dataset.tab = text.toLowerCase().slice(0, 4); // 'requ' | 'resp' — only used for resp lookup
    return b;
}

/**
 * Wrap a control with an uppercase field-label div. Pass grow=true for
 * textarea rows that should expand to fill available vertical space.
 * @param {string} name
 * @param {HTMLElement} control
 * @param {boolean} [grow]
 */
function labeled(name, control, grow = false) {
    const lbl = document.createElement('div');
    lbl.className = 'fieldLabel';
    lbl.innerText = name;
    const wrapper = div(lbl, control);
    if (grow) wrapper.className = 'grow';
    return wrapper;
}

/**
 * Render an HTTP response into a tab pane (status, headers, body).
 * @param {HTMLElement} pane
 * @param {import("./storage.js").HttpResponseRecord} resp
 */
function renderResponseInto(pane, resp) {
    const status = element('p', `${resp.status} ${resp.statusText}`);
    status.className = (resp.status >= 200 && resp.status < 300) ? 'statusOk' : 'statusErr';

    const headers = element('pre', resp.headers.map(([k, v]) => `${k}: ${v}`).join('\n'));
    const body = element('pre', prettyBody(resp.body, resp.contentType));

    pane.replaceChildren(
        labeled('Status', status),
        labeled('Headers', headers),
        labeled('Body', body),
    );
}

/**
 * Render an HTTP request into a tab pane (method+url, headers, body).
 * @param {HTMLElement} pane
 * @param {import("./storage.js").HttpRequestRecord} req
 */
function renderRequestInto(pane, req) {
    const line = element('pre', `${req.method} ${req.url}`);
    const headers = element('pre',
        Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\n'));
    const body = element('pre', prettyBody(req.body, 'application/jose+json'));
    pane.replaceChildren(
        labeled('Request Line', line),
        labeled('Headers', headers),
        labeled('Body', body),
    );
}

/** Pretty-print a JSON body if it parses, else return as-is. */
function prettyBody(/** @type {string} */ body, /** @type {string | null} */ _ct) {
    if (!body) return '';
    try {
        return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
        return body;
    }
}

/** If the stored object has a recorded HTTP exchange, show it in #poster. */
function showLastExchangeForObject(/** @type {string} */ url) {
    const stored = getObject(url);
    if (!stored || !stored.lastResponse || !stored.lastRequest) {
        hidePoster();
        return;
    }

    const poster = document.getElementById('poster');
    poster.hidden = false;

    const reqTab = makeTabBtn('Request');
    const respTab = makeTabBtn('Response');
    const tabBar = div(reqTab, respTab);
    tabBar.className = 'tabBar';

    const closeBtn = element('button', '✕');
    closeBtn.className = 'posterClose';
    closeBtn.title = 'Close';
    closeBtn.onclick = hidePoster;
    tabBar.appendChild(closeBtn);

    const reqPane = document.createElement('div');
    reqPane.className = 'tabPane';
    const respPane = document.createElement('div');
    respPane.className = 'tabPane';

    renderRequestInto(reqPane, stored.lastRequest);
    renderResponseInto(respPane, stored.lastResponse);

    function activate(/** @type {'req'|'resp'} */ which) {
        reqTab.classList.toggle('active', which === 'req');
        respTab.classList.toggle('active', which === 'resp');
        reqPane.hidden = which !== 'req';
        respPane.hidden = which !== 'resp';
    }
    reqTab.onclick = () => activate('req');
    respTab.onclick = () => activate('resp');
    activate('resp'); // default to response when viewing past exchange

    poster.replaceChildren(tabBar, reqPane, respPane);
}

/** Walk parent chain to find the directory URL (for nonce pool lookups). */
function findDirectoryUrl(/** @type {string} */ url) {
    let obj = getObject(url);
    let here = url;
    while (obj && obj.type !== 'directory') {
        here = obj.parent;
        obj = getObject(here);
    }
    return obj ? obj.url : here;
}

/** Walk parent chain to find the account URL (for KID). */
function findAccountUrl(/** @type {string} */ url) {
    let obj = getObject(url);
    let here = url;
    while (obj && obj.type !== 'account') {
        here = obj.parent;
        obj = getObject(here);
    }
    return obj ? obj.url : here;
}

