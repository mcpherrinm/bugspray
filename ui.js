import {clearStorage, getObject, listObjects, setObject} from "./storage.js";
import {newKey, protect, sign, thumbprint} from "./jws.js";
import {renderTreeview, setSelectedUrl} from "./nav.js";

export function setup() {
    for (const [url, object] of listObjects()) {
        if (object.type === 'nonces') {
            const directoryUrl = object.parent;
            noncePools[directoryUrl] = object.resource.nonces;
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
        noncePools = {};
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

function renderAccount(url, object) {
    let accountDiv = div();

    const expectedFields = ['status', 'contact', 'termsOfServiceAgreed', 'orders'];
    for (const field of expectedFields) {
        if (object.resource[field] !== undefined) {
            let value = object.resource[field];
            if (field === 'contact' && Array.isArray(value)) {
                value = value.join(', ');
            }
            accountDiv.appendChild(element('p', `${field}: ${value}`));
        }
    }

    let unknownDiv = div(element('h2', 'Unknown Account Entries'));
    let unknown = false;
    for (const [key, value] of Object.entries(object.resource)) {
        if (expectedFields.includes(key)) {
            continue;
        }
        unknownDiv.appendChild(element('p', `${key}: ${JSON.stringify(value)}`));
        unknown = true;
    }
    if (unknown) {
        accountDiv.appendChild(unknownDiv);
    }

    const directoryUrl = getDirectoryUrl(url);
    const directory = getObject(directoryUrl);
    if (directory) {
        let methodsHeader = element('h2', 'Methods');
        let methodsDiv = div(methodsHeader);
        const rows = [['newNonce', 'newOrder', 'newAuthz'], ['revokeCert', 'keyChange']];
        for (const row of rows) {
            const rowDiv = div();
            rowDiv.className = 'row';
            for (const method of row) {
                rowDiv.appendChild(renderMethod(method, directory, {kid: url, key: object.key}));
            }
            methodsDiv.appendChild(rowDiv);
        }
        accountDiv.appendChild(methodsDiv);
    }

    return accountDiv;
}

function renderOrder(url, object) {
    let orderDiv = div();

    const expectedFields = ['status', 'expires', 'identifiers', 'authorizations', 'finalize', 'certificate', 'error'];
    for (const field of expectedFields) {
        if (object.resource[field] !== undefined) {
            let value = object.resource[field];
            if (field === 'identifiers' && Array.isArray(value)) {
                value = value.map(i => `${i.type}:${i.value}`).join(', ');
            }
            if (field === 'authorizations' && Array.isArray(value)) {
                value = `${value.length} authorizations`;
            }
            if (field === 'error') {
                value = JSON.stringify(value);
            }
            orderDiv.appendChild(element('p', `${field}: ${value}`));
        }
    }

    let authzH2 = element('h2', 'Authorizations');
    let authzList = document.createElement('ul');
    for (const authzUrl of object.resource.authorizations) {
        let li = document.createElement('li');
        let viewBtn = element('button', authzUrl);
        viewBtn.onclick = () => viewObject(authzUrl);
        li.appendChild(viewBtn);
        authzList.appendChild(li);
    }
    orderDiv.appendChild(div(authzH2, authzList));

    if (object.resource.finalize) {
        let finalizeH2 = element('h2', 'Finalize Order');
        let csrLabel = element('p', 'CSR (PEM or Base64url-encoded DER):');
        let csrInput = document.createElement('textarea');
        csrInput.id = 'csr-input';
        csrInput.placeholder = '-----BEGIN CERTIFICATE REQUEST-----\n...\n-----END CERTIFICATE REQUEST-----';
        csrInput.className = 'rawObject';

        let finalizeBtn = goButton('finalize-order', 'Finalize Order', async () => {
            const directoryUrl = getDirectoryUrl(url);
            let kid = url;
            let cur = object;
            while (cur && cur.type !== 'account') {
                kid = cur.parent;
                cur = getObject(kid);
            }

            // Convert PEM to base64url DER if needed
            let csrValue = csrInput.value.trim();
            if (csrValue.startsWith('-----BEGIN')) {
                csrValue = csrValue
                    .replace(/-----BEGIN CERTIFICATE REQUEST-----/g, '')
                    .replace(/-----END CERTIFICATE REQUEST-----/g, '')
                    .replace(/\s+/g, '');
                // Standard base64 to base64url
                csrValue = csrValue
                    .replace(/\+/g, '-')
                    .replace(/\//g, '_')
                    .replace(/=+$/g, '');
            }

            await poster({
                url: object.resource.finalize,
                nonce: getNonce(directoryUrl),
                type: 'order',
                parent: object.parent,
                key: object.key,
                kid: kid,
                msg: { csr: csrValue },
            });
        });

        orderDiv.appendChild(div(finalizeH2, csrLabel, csrInput, finalizeBtn));
    }

    return orderDiv;
}

function renderAuthorization(url, object) {
    let authzDiv = div();

    const expectedFields = ['status', 'identifier', 'challenges', 'expires', 'wildcard', 'error'];
    for (const field of expectedFields) {
        if (object.resource[field] !== undefined) {
            let value = object.resource[field];
            if (field === 'identifier') {
                value = `${value.type} ${value.value}`;
            }
            if (field === 'challenges' && Array.isArray(value)) {
                value = `${value.length} challenges`;
            }
            if (field === 'error') {
                value = JSON.stringify(value);
            }
            authzDiv.appendChild(element('p', `${field}: ${value}`));
        }
    }

    let chH2 = element('h2', 'Challenges');
    let chList = document.createElement('ul');
    for (const ch of object.resource.challenges) {
        let li = document.createElement('li');
        li.innerText = `${ch.type} - ${ch.status} `;
        // TODO: render challenge details and "Respond" button
        chList.appendChild(li);
    }
    authzDiv.appendChild(div(chH2, chList));

    return authzDiv;
}

async function renderChallenge(url, object) {
    let challDiv = div();

    const ch = object.resource;
    challDiv.appendChild(element('p', `type: ${ch.type}`));
    challDiv.appendChild(element('p', `status: ${ch.status}`));
    challDiv.appendChild(element('p', `token: ${ch.token}`));

    if (ch.error) {
        challDiv.appendChild(element('p', `error: ${JSON.stringify(ch.error)}`));
    }

    // Compute challenge-specific instructions
    const authz = getObject(object.parent);
    const domain = authz?.resource?.identifier?.value || '<domain>';

    if (ch.type === 'dns-persist-01') {
        // dns-persist-01: RFC draft-ietf-acme-dns-persist
        // A static TXT record at _validation-persist.{domain} that persists across renewals.
        // Format: {ca-caa-domain}; accounturi={account-uri}

        // Walk up the parent chain to find the account URI: challenge -> authz -> order -> account
        let accountUri = '<account-uri>';
        if (authz) {
            const orderObj = getObject(authz.parent);
            if (orderObj?.type === 'account') {
                accountUri = authz.parent;
            } else if (orderObj) {
                accountUri = orderObj.parent || '<account-uri>';
            }
        }

        // Get the CA's CAA authorization domain from directory metadata
        const directoryUrl = getDirectoryUrl(object.parent);
        const directory = getObject(directoryUrl);
        const caaIdentities = directory?.resource?.meta?.caaIdentities;
        const caDomain = (caaIdentities && caaIdentities.length > 0) ? caaIdentities[0] : '<ca-caa-domain>';

        let instructionsH2 = element('h2', 'Instructions');
        challDiv.appendChild(instructionsH2);
        challDiv.appendChild(element('p', 'Create a persistent TXT record (does not need to change between renewals):'));
        challDiv.appendChild(copiable(`_validation-persist.${domain}`));
        challDiv.appendChild(element('p', 'Value:'));
        challDiv.appendChild(copiable(`${caDomain}; accounturi=${accountUri}`));
    } else if (object.key && ch.token) {
        const key = await newKey(object.key);
        const thumb = await thumbprint(key);
        const keyAuthz = `${ch.token}.${thumb}`;

        let instructionsH2 = element('h2', 'Instructions');
        challDiv.appendChild(instructionsH2);

        if (ch.type === 'http-01') {
            challDiv.appendChild(element('p', `Serve the following at:`));
            challDiv.appendChild(copiable(`http://${domain}/.well-known/acme-challenge/${ch.token}`));
            challDiv.appendChild(element('p', 'Content:'));
            challDiv.appendChild(copiable(keyAuthz));
        } else if (ch.type === 'dns-01' || ch.type === 'dns-account-01') {
            const digest = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(keyAuthz));
            const bytes = new Uint8Array(digest);
            const b64Val = btoa(String.fromCharCode(...bytes))
                .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            challDiv.appendChild(element('p', `Create a TXT record:`));
            challDiv.appendChild(copiable(`_acme-challenge.${domain}`));
            challDiv.appendChild(element('p', 'Value:'));
            challDiv.appendChild(copiable(b64Val));
        } else if (ch.type === 'tls-alpn-01') {
            const digest = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(keyAuthz));
            const bytes = new Uint8Array(digest);
            const hexVal = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
            challDiv.appendChild(element('p', 'Serve a TLS connection on port 443 with ALPN protocol "acme-tls/1". The certificate must have:'));
            challDiv.appendChild(element('p', 'Subject Alternative Name (dNSName):'));
            challDiv.appendChild(copiable(domain));
            challDiv.appendChild(element('p', 'A critical ACME extension (OID 1.3.6.1.5.5.7.1.31) containing an ASN.1 DER-encoded OctetString of the SHA-256 digest of the key authorization:'));
            challDiv.appendChild(copiable(hexVal));
        } else {
            challDiv.appendChild(element('p', 'Key Authorization:'));
            challDiv.appendChild(copiable(keyAuthz));
        }
    }

    let respondBtn = goButton('respond-challenge', 'Respond to Challenge', async () => {
        const directoryUrl = getDirectoryUrl(url);
        let kid = url;
        let cur = object;
        while (cur && cur.type !== 'account') {
            kid = cur.parent;
            cur = getObject(kid);
        }
        await poster({
            url: url,
            nonce: getNonce(directoryUrl),
            type: object.type,
            parent: object.parent,
            key: object.key,
            kid: kid,
            msg: {},
        });
    });
    challDiv.appendChild(respondBtn);

    return challDiv;
}

function renderCertificate(url, object) {
    return "TODO: cert";
}

function renderNonces(url, object) {
    let d = div(element('h2', 'Nonces in Pool'));
    for (const nonce of object.resource.nonces) {
        d.appendChild(element('li', nonce));
    }
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
        const directoryUrl = getDirectoryUrl(url);
        // Walk up parent chain to find account URL for KID
        let kid = url;
        let cur = object;
        while (cur && cur.type !== 'account') {
            kid = cur.parent;
            cur = getObject(kid);
        }
        let callback;
        if (object.type === 'authorization') {
            callback = (resourceJSON, location, keyName) => {
                resourceJSON.challenges.forEach(ch => {
                    setObject(ch.url, '', 'challenge', location, null, keyName);
                });
            };
        }
        await poster({
            url: url,
            nonce: getNonce(directoryUrl),
            type: object.type,
            parent: object.parent,
            key: object.key,
            kid: kid,
            msg: "",
            callback: callback,
        });
    };

    if (!object.resource) {
        let msg = element('p', 'Resource not yet fetched. Click Reload to fetch.');
        document.getElementById('poker').replaceChildren(h1, div(resourceURL, reloadBtn), msg);
        return;
    }

    let resource;
    switch (object.type) {
        case 'directory':
            resource = renderDirectory(url, object);
            break;
        case 'account':
            resource = renderAccount(url, object);
            break;
        case 'order':
            resource = renderOrder(url, object);
            break;
        case 'authorization':
            resource = renderAuthorization(url, object);
            break;
        case 'challenge':
            resource = await renderChallenge(url, object);
            break;
        case 'certificate':
            resource = renderCertificate(url, object);
            break;
        case 'nonces':
            document.getElementById('poker').replaceChildren(renderNonces(url, object));
            return;
    }

    let rawH2 = element('h2', 'Resource JSON');
    let raw = document.createElement('textarea')
    raw.className = 'rawObject';
    raw.value = JSON.stringify(object.resource, null, 2);

    document.getElementById('poker').replaceChildren(h1, div(resourceURL, reloadBtn), resource, div(rawH2, raw));
}

let noncePools = {}; // directoryUrl -> array of nonces

function gotNonce(headers, directoryUrl) {
    if (!directoryUrl) return;
    const nonce = headers.get('replay-nonce');
    if (nonce !== null) {
        if (!noncePools[directoryUrl]) {
            noncePools[directoryUrl] = [];
        }
        noncePools[directoryUrl].push(nonce);
        updateNonceStorage(directoryUrl);
    }
}

function getNonce(directoryUrl) {
    if (!directoryUrl || !noncePools[directoryUrl] || noncePools[directoryUrl].length === 0) {
        return 'no-nonces-run-new-nonce';
    }
    const n = noncePools[directoryUrl].pop();
    updateNonceStorage(directoryUrl);
    return n;
}

function updateNonceStorage(directoryUrl) {
    const pool = noncePools[directoryUrl] || [];
    setObject(`${directoryUrl}/nonces`, `Nonce Pool (${pool.length})`, 'nonces', directoryUrl, {nonces: pool});
    renderTreeview();
}

function getDirectoryUrl(url) {
    let obj = getObject(url);
    while (obj && obj.type !== 'directory') {
        url = obj.parent;
        obj = getObject(url);
    }
    return obj ? obj.url : null;
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
            const resp = await fetch(url);
            gotNonce(resp.headers, url);
            const directory = await resp.json();
            setObject(url, name.value, 'directory', '', directory);
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

function newNonce(form, directory) {
    let output = document.createElement('p');
    form.appendChild(goButton('go-get-nonce', 'Get Nonce', async () => {
        try {
            const resp = await fetch(directory.resource['newNonce']);
            const nonce = resp.headers.get('replay-nonce');
            if (nonce) {
                gotNonce(resp.headers, directory.url);
                output.innerText = `Added nonce: ${nonce}`;
            } else {
                output.innerText = 'No nonce returned in headers';
            }
        } catch (e) {
            output.innerText = `Error: ${e}`;
        }
    }));
    form.appendChild(output);
}

// New Account. RFC 8555 Section 7.3
function newAccount(f, directory) {
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

    return () => {
        return {
            msg: {
                termsOfServiceAgreed: tosAgreed.checked,
                contact: contact.values(),
                onlyReturnExisting: onlyReturnExisting.checked ? true : undefined
            },
            kid: null,
        };
    }
}

function newOrder(f, directory) {
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

        return {
            msg: msg,
            callback: (resourceJSON, location, keyName) => {
                resourceJSON.authorizations.forEach(authzUrl => {
                    setObject(authzUrl, '', 'authorization', location, null, keyName);
                });
            }
        }
    }
}


function newAuthz(f, directory) {
    f.appendChild(element('p', "Where did you even find a server that supports this?"));

    return () => {
        return {
            msg: {},
        }
    }
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

function runMethod(method, directory, signer) {
    const h1 = element('h1', `Run ${method}`);

    let f = document.createElement('form');

    let keyInput = input(f, 'keyName', 'Signing key', (signer && signer.key) || 'key1');
    let kidInput = input(f, 'kid', 'Key ID (Account URI)', (signer && signer.kid) || '');

    let type = null;
    // TODO: proper parent handling
    let parent = method === 'newAccount' ? directory.url : kidInput?.value;
    let getData = () => {return {}};

    switch (method) {
        case 'newNonce':
            newNonce(f, directory);
            // newNonce doesn't use POSTer, so handle and return early
            document.getElementById('poker').replaceChildren(h1, f);
            return;
        case 'newAccount':
            getData = newAccount(f, directory);
            type = 'account';
            break;
        case 'newOrder':
            getData = newOrder(f, directory);
            type = 'order';
            break;
        case 'newAuthz':
            getData = newAuthz(f, directory);
            type = 'authorization';
            break;
        case 'revokeCert':
            getData = revokeCert(f, directory, kidInput);
            break;
        case 'keyChange':
            getData = keyChange(f, directory);
            break;
        case 'renewalInfo':
            renewalInfo(f, directory);
            document.getElementById('poker').replaceChildren(h1, f);
            return;
        default:
            document.getElementById('poker').replaceChildren(h1, "Unknown? How did you get here?");
            return;
    }

    const go = goButton('go-run-method', `Run ${method}`, async () => {
        await poster({
            url: directory.resource[method],
            nonce: getNonce(directory.url),
            type: type,
            parent: parent,
            key: keyInput?.value,
            kid: kidInput?.value,
            ...getData(),
        })
    })

    document.getElementById('poker').replaceChildren(h1, f, go);
}

async function poster(data) {
    const h1 = element('h1', 'Submit Request');

    let f = document.createElement('form');

    let msg = element('textarea', '');
    msg.value = JSON.stringify(data.msg, null, 2);
    f.appendChild(msg);

    let prot = element('textarea', '');
    prot.id = 'protected';
    let key = await newKey(data.key);
    let protectedData = await protect(key, data.kid, data.nonce, data.url);
    prot.value = JSON.stringify(protectedData, null, 2);
    f.appendChild(div(label('protected', 'Protected Data'), prot));

    // TODO: we want to re-sign if the data is changed. Automatically, or maybe manually
    let signedData = await sign(key, protectedData, data.msg);

    let signed = element('textarea', '');
    signed.value = signedData;
    signed.id = 'signed';

    f.appendChild(div(label('signed', 'Signed Data'), signed));

    const go = goButton('submit', 'Submit Request', async () => {
        await submit(data.url, signedData, data.type, data.parent, data.key, data.callback);
    })

    document.getElementById('poker').replaceChildren(h1, f, go);
}

async function submit(url, signed, objType, objParent, keyName, callback) {
    const pending = element('h1', 'Submitting...')
    document.getElementById('poker').replaceChildren(pending);

    const resp = await fetch(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/jose+json'},
        body: signed,
    })
    gotNonce(resp.headers, getDirectoryUrl(objParent))

    const locationHeader = resp.headers.get('Location');
    const targetUrl = locationHeader || url;

    const resourceJSON = await resp.json();

    if (resp.ok) {
        setObject(targetUrl, '', objType, objParent, resourceJSON, keyName);
        if (callback) {
            callback(resourceJSON, targetUrl, keyName);
        }
        renderTreeview()
    }

    // TODO: this result view should include a bit more about the HTTP request/response

    let h1 = element('h1', 'Result');

    const location = element('p', targetUrl);
    let resource = element('textarea', '');
    resource.value = JSON.stringify(resourceJSON, null, 2);
    resource.id = 'result';

    const view = goButton('view', 'Go to object', () => {
        viewObject(targetUrl);
    })

    document.getElementById('poker').replaceChildren(h1, location, resource, view);
}

