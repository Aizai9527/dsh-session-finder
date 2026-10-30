import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

/**
 * Guards for the v0.5.0 trio: scoped search, the deep jump and the draggable
 * panel. These are static checks on purpose — the behaviour itself is verified in
 * test/fixture.html through a real browser, and a static guard is what keeps a
 * later edit from quietly dropping the wiring again.
 */

const client = await readFile(fileURLToPath(new URL("../lib/client.js", import.meta.url)), "utf8");
const host = await readFile(fileURLToPath(new URL("../lib/index.js", import.meta.url)), "utf8");

let failures = 0;
/** @param {string} name @param {() => void} run */
function check(name, run) {
	try {
		run();
		console.log("ok " + name);
	}
	catch (error) {
		failures += 1;
		console.error("FAIL " + name + "\n" + (error instanceof Error ? error.message : String(error)));
	}
}

check("the client asks the chat view to load history through the hit seq", () => {
	assert.match(client, /function sessionFaceOf\(sessionId\)/, "sessionFaceOf helper exists");
	assert.match(client, /sessions\.binding\(sessionId\)/, "the face comes from ctx.sessions.binding");
	assert.match(client, /async function reachSeq\(sessionId, seq, ticket, onRound, stopped\)/, "reachSeq owns the jump loader");
	assert.match(client, /await face\.loadThrough\(seq\)/, "reachSeq awaits loadThrough at the hit seq");
	assert.match(client, /if \(stopped !== undefined && stopped\(\)\) return "given";/, "a decided jump stops the loader");
	assert.match(client, /if \(base !== null && base === lastBase\)/, "no progress waits instead of paging again");
	assert.match(client, /const base = typeof face\.baseSeq === "number" \? face\.baseSeq : null;/, "coverage is verified through baseSeq");
	assert.match(client, /if \(base !== null && base <= seq\) return "covered";/, "a covered window ends the paging");
	assert.match(client, /attempt % REACH_EVERY !== 0/, "the jump retries on a schedule while the loop waits");
});

check("the client sends the scope to the host route", () => {
	assert.match(client, /url\.searchParams\.set\("sessionId", scope\.sessionId\)/, "sessionId param");
	assert.match(client, /url\.searchParams\.set\("cwd", scope\.cwd\)/, "cwd param");
	assert.match(client, /function scopeQuery\(\)/, "scopeQuery builds the params");
});

check("the host narrows before paging and reports the scope", () => {
	assert.match(host, /url\.searchParams\.get\("sessionId"\)/, "host reads sessionId");
	assert.match(host, /url\.searchParams\.get\("cwd"\)/, "host reads cwd");
	assert.match(host, /snapshot\.header\.id === askedSession/, "session filter compares header id");
	assert.match(host, /snapshot\.header\.cwd === askedCwd/, "project filter compares header cwd");
	assert.match(host, /const page = scoped\.slice\(offset, offset \+ MAX_SESSIONS\)/, "paging runs on the narrowed list");
	assert.match(host, /^\t\tscope,$/m, "response reports the scope");
});

check("the overlay offers a scope select in the footer", () => {
	assert.match(client, /select class=\\"sf-scope\\" aria-label=/, "select is in the markup");
	assert.match(client, /state\.nodes\.scope\.addEventListener\("change"/, "change is wired");
	assert.match(client, /scopeAll: "全部会话"/, "all-sessions choice");
	assert.match(client, /scopeCurrent: "当前会话"/, "current-session choice");
	assert.match(client, /function scopeChoices\(\)/, "project choices are built from live sessions");
});

check("the current session is the default scope until the reader picks one", () => {
	assert.match(client, /if \(state\.scopeTouched !== true\) \{/, "default applies only while untouched");
	assert.match(client, /state\.scope = current === null \? "all" : "session";/, "falls back to all");
	assert.match(client, /function currentSessionId\(\)/, "current session is detected");
	assert.match(client, /_sessionRow/, "detection reads the sidebar row class");
});

check("the panel can be dragged by its header and remembers where", () => {
	assert.match(client, /const PANEL_KEY = "dsh-session-finder:panel";/, "storage key");
	assert.match(client, /function bindPanelDrag\(panel, head\)/, "drag binder exists");
	assert.match(client, /bindPanelDrag\(state\.nodes\.panel, state\.nodes\.head\)/, "binder is registered");
	assert.match(client, /function savePanelPosition\(\)/, "position is saved");
	assert.match(client, /const saved = readPanelPosition\(\);/, "position is restored on open");
	assert.match(client, /closest\("button, input, select, a, textarea"\)/, "interactive children are not drag handles");
});

if (failures > 0) {
	console.error("dsh-session-finder client scope: " + String(failures) + " check(s) failed");
	process.exit(1);
}
console.log("dsh-session-finder client scope: 6 checks passed");
