import {listObjects} from "./storage.js";
import {renderObject} from "./ui.js";

let selectedUrl = null;

export function setSelectedUrl(url) {
    selectedUrl = url;
}

// Call renderTreeview after updating a stored object
export function renderTreeview() {
    let root = document.createElement('ul');
    const objects = Array.from(listObjects());

    // Create all items first
    const items = new Map();
    for (const [url, object] of objects) {
        let child = document.createElement('li');
        child.className = `${object.type}Nav treeItem`;
        if (url === selectedUrl) {
            child.classList.add('selected');
        }

        let toggle = document.createElement('span');
        toggle.className = 'toggle';
        toggle.innerText = '▼';
        child.appendChild(toggle);

        let label = document.createElement('span');
        label.className = 'label';
        label.innerText = object.name !== '' ? object.name : url;
        child.appendChild(label);

        const list = document.createElement('ul');
        child.appendChild(list);

        toggle.onclick = (e) => {
            e.stopPropagation();
            child.classList.toggle('collapsed');
            toggle.innerText = child.classList.contains('collapsed') ? '▶' : '▼';
        };

        label.onclick = () => {
            renderObject(url, object);
        }

        items.set(url, { li: child, childrenList: list, parent: object.parent });
    }

    // Then attach them to parents
    for (const [url, item] of items) {
        let parentList;
        if (item.parent === '') {
            parentList = root;
        } else {
            const parentItem = items.get(item.parent);
            if (parentItem) {
                parentList = parentItem.childrenList;
                parentItem.li.classList.add('hasChildren');
            } else {
                console.log(`Failed to find parent for '${url}' ('${item.parent}'), attaching to root`);
                parentList = root;
            }
        }
        parentList.appendChild(item.li);
    }

    document.getElementById('treeview').replaceChildren(root);
}
