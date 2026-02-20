// TODO: This should get persisted to IndexDB or something
// It is jank for now.

let Storage = new Map();

function initStorage() {
    const stored = window.localStorage.getItem("bugspray");
    if (stored !== null) {
        Storage = new Map(Object.entries(JSON.parse(stored)));
    }
}

function clearStorage() {
    Storage = new Map();
    window.localStorage.setItem("bugspray", JSON.stringify({}))
}

function setObject(url, name, type, parent, resource, key) {
    Storage.set(url, {
        url: url,
        type: type,
        name: name || '',
        parent: parent,
        resource: resource,
        key: key
    })

    // Just store the whole thing each time.
    // Not great, but it is easy.
    window.localStorage.setItem("bugspray", JSON.stringify(Object.fromEntries(Storage)))
}

function getObject(url) {
    return Storage.get(url);
}

// listObject returns all the objects in Localstorage
function* listObjects() {
    for (const [url, entry] of Storage) {
        yield [url, entry]
    }
}

export {initStorage, clearStorage, setObject, getObject, listObjects}
