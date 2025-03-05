import {clearStorage, getObject, listObjects, setObject} from "./storage.js";
import {protect, newKey} from "./jws.js";

function setup() {
    renderTreeview();
    document.querySelector('button#new-directory').addEventListener('click', newDirectory);
    document.querySelector('button#clear-storage').addEventListener('click', () => {
        if (!confirm("Are you sure you want to clear all data?")) {
            return
        }
        clearStorage();
        renderTreeview();
        newDirectory();
    });
    newDirectory();
}

// addNavItem adds a new child to the passed in parent ul
// It returns a new ul list for this object's children
function addNavItem(url, object, parentList) {
    let child = document.createElement('li');
    child.className = `${object.type}Nav`;
    let label = document.createElement('span');
    if (object.name !== '') {
        label.innerText = object.name;
    } else {
        label.innerText = url;
    }

    child.appendChild(label);
    const list = document.createElement('ul');
    child.appendChild(list);
    parentList.appendChild(child);

    label.onclick = () => {renderObject(url, object)}

    return list;
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

function input(form, id, labelText, placeholder) {
    let label = document.createElement('label');
    label.htmlFor = id;
    label.innerText = labelText;
    let inputElement = document.createElement('input');
    inputElement.id = id;
    inputElement.name = id;
    inputElement.placeholder = placeholder;

    let r = div(label, inputElement);
    r.className = "inputWrapper";

    console.log('form', form);
    console.log(r);
    form.appendChild(r)

    return inputElement
}

function checkbox(form, id, labelText, nextToCheckbox) {
    let label = document.createElement('label');
    label.htmlFor = id;
    label.innerText = labelText;
    let checkboxElement = document.createElement('input');
    checkboxElement.id = id;
    checkboxElement.name = id;
    checkboxElement.type = 'checkbox';

    let r = div(label, div(checkboxElement, nextToCheckbox));
    r.className = "checkboxWrapper";

    form.appendChild(r)

    return checkboxElement;
}

// Call renderSidebar after updating a stored object
function renderTreeview() {
    // We just re-render the whole structure each time
    // tree maps url -> ul list, where children of that url should be added
    let tree = new Map();

    // Create a new root:
    let root = document.createElement('ul');
    tree.set('', root)

    for (const [url, object] of listObjects()) {
        let parentList = tree.get(object.parent);
        if (parentList === undefined) {
            console.log(`Failed to find parent for '${url}'`)
            parentList = root;
        }
        tree.set(url, addNavItem(url, object, parentList));
    }

    // Swap in new:
    let navContainer = document.getElementById('treeview')
    navContainer.replaceChildren(root)
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
    return "TODO: account";
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

// View an object. Will dispatch to the correct view* function based on type
function renderObject(url, object) {
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
    }

    let rawH2 = element('h2', 'Resource JSON');
    let raw = document.createElement('textarea')
    raw.className = 'rawObject';
    raw.value = JSON.stringify(object.resource, null, 2);

    document.getElementById('poker').replaceChildren(h1, div(resourceURL), resource, div(rawH2, raw));
}

function gotNonce(headers) {
    const nonce = headers.get('replay-nonce');
    if (nonce !== null) {
        // TODO: we may want to pool nonces somewhere
        document.querySelector('input#nonce').value = nonce;
    }
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
            gotNonce(resp.headers);
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
    form.appendChild(goButton('go-get-nonce', 'Get Nonce', async () => {
        const resp = await fetch(directory.resource['newNonce']);
        gotNonce(resp.headers);
    }));
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
    let getData = null;

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

    let nameInput = null;
    if (type !== null) {
        nameInput = input(f, 'name', `Save ${name} as name`, `Name for this ${type}`);
    }

    const go = goButton('go-run-method', `Run ${method}`, async () => {
        await poster({
            name: nameInput.value,
            url: directory.resource[method],
            type: type,
            ...getData(),
        })
    })

    document.getElementById('poker').replaceChildren(h1, f, go);
}

async function poster(data) {
    const h1 = element('h1', 'Submit Request');

    let f = document.createElement('form');

    // Key input, use KID

    // Endpoint URL

    input(f, 'nonce', 'Nonce', 'nonce');

    let msg = element('textarea', '');
    msg.value = JSON.stringify(data.msg, null, 2);
    f.appendChild(msg);

    let prot = element('textarea', '');
    // TODO: this depends on nonce, which is in this form above and probably isnt filled out yet
    prot.value = JSON.stringify(await protect(await newKey(data.key), data.useKID ? data.key : undefined, 'TODO:NONCE', data.url), null, 2);
    f.appendChild(prot);

    document.getElementById('poker').replaceChildren(h1, f);
}


export {renderTreeview, viewObject, setup}