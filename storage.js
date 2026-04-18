// TODO: This should get persisted to IndexDB or something
// It is jank for now.

/**
 * @typedef {Object} HttpRequestRecord
 * @property {string} method
 * @property {string} url
 * @property {Record<string, string>} headers
 * @property {string} body
 */

/**
 * @typedef {Object} HttpResponseRecord
 * @property {number} status
 * @property {string} statusText
 * @property {Array<[string, string]>} headers
 * @property {string} body
 * @property {string | null} contentType
 */

/**
 * @typedef {Object} StoredObject
 * @property {string} url
 * @property {string} type
 * @property {string} name
 * @property {string} parent
 * @property {any} resource - JSON-serializable response payload. Per-type classes own the shape.
 * @property {string} [key] - Name of the signing key in the KeyStore.
 * @property {HttpRequestRecord} [lastRequest]
 * @property {HttpResponseRecord} [lastResponse]
 */

/**
 * @typedef {Object} ObjectStore
 * @property {(url: string) => StoredObject | undefined} get
 * @property {() => Iterable<[string, StoredObject]>} list
 * @property {(obj: StoredObject) => void} put
 * @property {() => void} clear
 */

/** @type {Map<string, StoredObject>} */
let Storage = new Map();

function initStorage() {
    const stored = window.localStorage.getItem("bugspray");
    if (stored !== null) {
        Storage = new Map(Object.entries(JSON.parse(stored)));
    }
}

function clearStorage() {
    Storage = new Map();
    window.localStorage.setItem("bugspray", JSON.stringify({}));
}

/**
 * @param {string} url
 * @param {string} name
 * @param {string} type
 * @param {string} parent
 * @param {any} resource
 * @param {string} [key]
 */
function setObject(url, name, type, parent, resource, key) {
    Storage.set(url, {
        url: url,
        type: type,
        name: name || '',
        parent: parent,
        resource: resource,
        key: key
    });

    // Just store the whole thing each time.
    // Not great, but it is easy.
    window.localStorage.setItem("bugspray", JSON.stringify(Object.fromEntries(Storage)));
}

/** @param {string} url */
function getObject(url) {
    return Storage.get(url);
}

// listObject returns all the objects in Localstorage
/** @returns {Generator<[string, StoredObject]>} */
function* listObjects() {
    for (const [url, entry] of Storage) {
        yield [url, entry];
    }
}

/**
 * Merge the last request/response pair onto an existing stored object so the
 * UI can render the HTTP exchange in the side panel.
 * @param {string} url
 * @param {HttpRequestRecord} request
 * @param {HttpResponseRecord} response
 */
function setObjectIO(url, request, response) {
    const existing = Storage.get(url);
    if (!existing) return;
    existing.lastRequest = request;
    existing.lastResponse = response;
    window.localStorage.setItem("bugspray", JSON.stringify(Object.fromEntries(Storage)));
}

/**
 * Wraps the module-level Storage map in the ObjectStore typedef so consumers
 * (acme.js) can be written without depending on browser globals.
 * @returns {ObjectStore}
 */
function createObjectStore() {
    return {
        get: getObject,
        list: () => listObjects(),
        put: (obj) => {
            Storage.set(obj.url, obj);
            window.localStorage.setItem("bugspray", JSON.stringify(Object.fromEntries(Storage)));
        },
        clear: clearStorage,
    };
}

export {initStorage, clearStorage, setObject, getObject, listObjects, createObjectStore, setObjectIO};
