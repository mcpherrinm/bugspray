#!/usr/bin/env bun
import {buildNodeEnv} from "./nodeEnv.js";
import {AcmeDirectory, fromStored} from "./acme.js";

const url = process.argv[2];
if (!url) {
    console.error("usage: bun run cli.js <directory-url>");
    process.exit(1);
}

const env = buildNodeEnv({statePath: "./bugspray-state.json"});

const response = await env.fetch(url);
const directoryJson = await response.json();
env.objectStore.put({
    url,
    name: url,
    type: "directory",
    parent: "",
    resource: directoryJson,
});

const directory = /** @type {AcmeDirectory} */ (fromStored(env.objectStore.get(url), env));
console.log("Directory:", directory.url);
console.log("Methods:", Object.keys(directoryJson).filter(k => k !== "meta").join(", "));
console.log("Meta:");
for (const [k, v] of Object.entries(directoryJson.meta || {})) {
    console.log(`  ${k}: ${JSON.stringify(v)}`);
}
