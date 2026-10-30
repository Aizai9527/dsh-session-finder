/**
 * Static guard for host paging.
 *
 * The reported failure was a search for text plainly visible in a session that
 * answered "没有命中". Two separate limits caused it: the host stopped reading a
 * session after 400 000 characters, and the client stopped at the first page of
 * sessions. Both are easy to reintroduce, so this pins the behaviour.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (name) => readFileSync(fileURLToPath(new URL(`../lib/${name}`, import.meta.url)), "utf8");
const client = read("client.js");
const search = read("search.js");
const host = read("index.js");

const cap = /const MAX_SESSION_CHARS = ([0-9_]+) \* 1024 \* 1024;/u.exec(search);
assert.ok(cap !== null, "search.js must keep a per-session character cap");
assert.ok(Number(cap[1].replaceAll("_", "")) >= 8, "the per-session cap must cover a long-running session (>= 8M characters)");

assert.ok(/partial = true;/u.test(search), "textsOf must mark a session whose content was cut short");
assert.ok(/partialSessions/u.test(host), "the route must report how many sessions were only partly read");

assert.ok(/const MAX_AUTO_PAGES = ([0-9]+);/u.test(client), "client must bound how many session pages one query reads");
assert.ok(/await searchPages\(query, offset, controller\?\.signal\)/u.test(client), "runSearch must go through searchPages");
assert.ok(/if \(merged\.items\.length > 0\) break;/u.test(client), "auto paging must stop at the first page with hits");
assert.ok(/state\.items\.length === 0 \? TEXT\.moreOlder : TEXT\.more/u.test(client), "the paging button must say what it will do when nothing was found");

console.log("dsh-session-finder paging: 6 checks passed");
