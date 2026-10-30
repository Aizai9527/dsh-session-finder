/**
 * Static guard for the client plugin's declared services.
 *
 * `uiWorkspace` is what makes a hit navigable: without it the client context has
 * no `openSession`, so clicking a row only raises a toast. The bundle cannot be
 * imported in Node (it registers itself on `window.__ModuleLoader__`), so this
 * checks the declaration in the source instead.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("../lib/client.js", import.meta.url)), "utf8");
const match = /const inject = \[([^\]]*)\];/u.exec(source);

assert.ok(match !== null, "client.js must declare an inject list");
const services = match[1].split(",").map((part) => part.trim().replace(/^"|"$/gu, "")).filter((part) => part !== "");

assert.deepEqual(services.sort(), ["sessions", "uiWorkspace"], "client must inject sessions and uiWorkspace");
assert.ok(/state\.ctx\?\.uiWorkspace \?\? state\.ctx\?\.root\?\.uiWorkspace/u.test(source), "choose() must resolve uiWorkspace from the injected or root context");

console.log("dsh-session-finder client: 2 checks passed");
