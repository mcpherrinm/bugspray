import {clearStorage, getObject, listObjects, setObject} from "./storage.js";
import {newKey, protect, sign} from "./jws.js";
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

function label(id, text) {
    let e = document.createElement('label');
    e.htmlFor = id;
    e.innerText = text;
    return e;
}

function input(form, id, labelText, placeholder) {
    let inputElement = document.createElement('input');
    inputElement.id = id;
    inputElement.name = id;
    inputElement.placeholder = placeholder;

    let r = div(label(id, labelText), inputElement);
    r.className = "inputWrapper";

    form.appendChild(r)

    return inputElement
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

function renderMethod(name, directory) {
    let button = element('button', name);
    button.className = 'method';
    if (directory.resource[name] !== undefined) {
        button.onclick = () => runMethod(name, directory);
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
                rowDiv.appendChild(renderMethod(method, directory));
            }
            methodsDiv.appendChild(rowDiv);
        }
        accountDiv.appendChild(methodsDiv);
    }

    return accountDiv;
}

function renderOrder(url, object) {
    return "TODO: order";
}

function renderAuthorization(url, object) {
    return "TODO: authz"
}

function renderChallenge(url, object) {
    return "TODO: chall"
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
export function renderObject(url, object) {
    setSelectedUrl(url);
    renderTreeview();
    let text = `${object.type}`
    if (object.name !== '') {
        text = `${object.name} ${text}`
    }
    let h1 = element('h1', text)

    let resourceURL = element('pre', url)

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
            resource = renderChallenge(url, object);
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

    document.getElementById('poker').replaceChildren(h1, div(resourceURL), resource, div(rawH2, raw));
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
    const keyName = input(f, 'keyName', 'Name of Key', 'key1');
    const contact = input(f, 'contact', 'Contact (optional)', 'mailto:contact@example.com');
    // TODO: allow multiple contacts

    let tosLink = element('a', 'Terms of Service');
    tosLink.href = directory.resource['meta']['termsOfService'];
    const tosAgreed = checkbox(f, 'tosAgreed', 'Agree to Terms of Service', tosLink);

    const onlyReturnExisting = checkbox(f, 'onlyReturnExisting', 'Only return existing', 'Don\'t create a new account: Look up by account key');

    // Warn that EAB isn't implemented if required
    if (directory.resource['meta']['externalAccountRequired']) {
        f.appendChild(element('p', "⚠️ External Account Binding is required, but not implemented."));
    }

    return () => {
        let data = {
            msg: {
                termsOfServiceAgreed: tosAgreed.checked,
            },
            key: keyName.value,
            useKID: false,
            type: 'account',
            parent: directory.url,
        }
        if (contact.value !== '') {
            data.msg.contact = [contact.value];
        }
        if (onlyReturnExisting.checked) {
            data.msg.onlyReturnExisting = true;
        }
        return data;
    }
}

function newOrder(f, url) {
    const keyName = input(f, 'keyName', 'Name of Key', 'key1');
    f.appendChild(element('p', "TODO: Implement me."));

    return () => {
        return {
            msg: {},
            key: keyName.value,
            useKID: false,
        }
    }
}


function newAuthz(f, url) {
    const keyName = input(f, 'keyName', 'Name of Key', 'key1');
    f.appendChild(element('p', "Where did you even find a server that supports this?"));

    return () => {
        return {
            msg: {},
            key: keyName.value,
            useKID: false,
        }
    }
}

function revokeCert(f, url) {
    const keyName = input(f, 'keyName', 'Name of Key', 'key1');
    f.appendChild(element('p', "TODO: Implement me."));

    const useKID = checkbox(f, 'useKID', 'Use KID', 'we need to allow providing a key for revoking with a key');

    return () => {
        return {
            msg: {},
            key: keyName.value,
            useKID: useKID.checked,
        }
    }
}

function keyChange(f, url) {
    const keyName = input(f, 'keyName', 'Name of Key', 'key1');
    f.appendChild(element('p', "TODO: Implement me."));
    return () => {
        return {
            msg: {},
            key: keyName.value,
            useKID: true,
        }
    }
}

function renewalInfo(f, url) {
    f.appendChild(element('p', "TODO: Implement me."));
}

function runMethod(method, directory) {
    const h1 = element('h1', `Run ${method}`);

    let f = document.createElement('form');

    let type = null;
    let parent = directory.url;
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
            getData = revokeCert(f, directory);
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
    let protectedData = await protect(key, data.useKID ? data.key : undefined, data.nonce, data.url);
    prot.value = JSON.stringify(protectedData, null, 2);
    f.appendChild(div(label('protected', 'Protected Data'), prot));

    // TODO: we want to re-sign if the data is changed. Automatically, or maybe manually
    let signedData = await sign(key, protectedData, data.msg);

    let signed = element('textarea', '');
    signed.value = signedData;
    signed.id = 'signed';

    f.appendChild(div(label('signed', 'Signed Data'), signed));

    const go = goButton('submit', 'Submit Request', async () => {
        await submit(data.url, signedData, data.type, data.parent);
    })

    document.getElementById('poker').replaceChildren(h1, f, go);
}

async function submit(url, signed, objType, objParent) {
    const pending = element('h1', 'Submitting...')
    document.getElementById('poker').replaceChildren(pending);

    const resp = await fetch(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/jose+json'},
        body: signed,
    })
    gotNonce(resp.headers, getDirectoryUrl(objParent))

    const locationHeader = resp.headers.get('Location');

    const resourceJSON = await resp.json();

    if (locationHeader) {
        setObject(locationHeader, '', objType, objParent, resourceJSON);
        renderTreeview()
    }

    // TODO: this result view should include a bit more about the HTTP request/response

    let h1 = element('h1', 'Result');

    const location = element('p', locationHeader || 'unknown location');
    let resource = element('textarea', '');
    resource.value = JSON.stringify(resourceJSON, null, 2);
    resource.id = 'result';

    const view = goButton('view', 'Go to object', () => {
        viewObject(locationHeader);
    })

    document.getElementById('poker').replaceChildren(h1, location, resource, view);
}

