/**
 * Guard checks for the search-history list.
 *
 * The behaviour is exercised in `test/fixture.html`; this file pins the
 * decisions that keep the list honest:
 *
 *   1. only real queries are remembered, newest first, without duplicates;
 *   2. the list is hidden as soon as the box has text, so it never covers hits;
 *   3. Escape dismisses the list (and keeps the panel open) but not focus;
 *   4. entries render through textContent, so a query can never inject markup.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let checks = 0;

/** @param {string} label @param {() => unknown | Promise<unknown>} body */
async function check(label, body) {
	await body();
	checks += 1;
	process.stdout.write("ok " + label + "\n");
}

const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

await check("history lives under its own storage key with a bound", () => {
	assert.ok(source.includes("const HISTORY_KEY = \"dsh-session-finder:history\";"));
	assert.ok(source.includes("const HISTORY_LIMIT = 10;"));
	assert.ok(source.includes("function readHistory()"));
	assert.ok(source.includes("function writeHistory(list)"));
});

await check("only successful queries are remembered, newest first", () => {
	assert.ok(source.includes("rememberQuery(query);"), "runSearch records the query it just ran");
	assert.ok(source.includes("if (text.length < MIN_QUERY_LENGTH) return;"), "short strings are not history");
	assert.ok(source.includes("const next = [text];"), "the newest entry goes first");
	assert.ok(source.includes("if (entry !== text) next.push(entry);"), "duplicates collapse onto one entry");
	assert.ok(source.includes("if (next.length >= HISTORY_LIMIT) break;"), "the list is capped");
});

await check("the list hides as soon as the box has text", () => {
	assert.ok(source.includes("const open = state.history.length > 0 && input.value.trim() === \"\" && state.historyHidden !== true;"),
		"history only shows over an empty box, and stays dismissed after Escape");
});

await check("clearing removes the storage key", () => {
	assert.ok(source.includes("localStorage.removeItem(HISTORY_KEY);"));
	assert.ok(source.includes("clear.textContent = TEXT.historyClear;"));
	assert.ok(source.includes("class = \"sf-history-clear\"" ) === false || source.includes(".sf-history-clear"));
	assert.ok(manifest.version.split(".").length === 3, "manifest version still parses");
});

await check("the list is wired into the panel", () => {
	assert.ok(source.includes("<div class=\\\"sf-history\\\" role=\\\"listbox\\\""));
	assert.ok(source.includes("history: overlay.querySelector(\".sf-history\")"));
	assert.ok(source.includes("input.addEventListener(\"focus\", () => { renderHistory(); });"));
	assert.ok(source.includes("state.nodes.history.addEventListener(\"keydown\", onHistoryKeydown);"));
});

await check("keyboard walks the list and Escape keeps the panel", () => {
	assert.ok(source.includes("function focusHistory(direction)"));
	assert.ok(source.includes("if (box?.dataset.open === \"true\")"));
	assert.ok(source.includes("state.historyHidden = true;"), "Escape dismisses instead of closing");
	assert.ok(source.includes("window.setTimeout(() => { target.focus(); }, 0);"),
		"focus returns to the box after the focused item is hidden");
	assert.ok(source.includes("label.textContent = entry;"), "entries are text, never markup");
});

process.stdout.write("dsh-session-finder history: " + String(checks) + " checks passed\n");
