/**
 * Guard checks for the v0.5.1 anchoring rules.
 *
 * The behavioural half lives in `search.test.mjs` (extraction) and
 * `route.test.mjs` (the route); this file pins the decisions that keep
 * "three hits, one highlight" and "opened but never rendered" from coming back:
 *
 *   1. tool hits are located by `data-chat-call-id`, not by their hidden arguments;
 *   2. a row already used by another hit of the same query is never reused;
 *   3. when neither works, the hit's turn (`data-chat-turn`) is the anchor.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { callIdOf, turnOf } from "../lib/search.js";

let checks = 0;

/** @param {string} label @param {() => unknown | Promise<unknown>} body */
async function check(label, body) {
	await body();
	checks += 1;
	process.stdout.write("ok " + label + "\n");
}

const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
const host = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");

await check("tool events expose their call id", () => {
	assert.equal(callIdOf({ type: "tool/call", data: { callId: "call_a" } }), "call_a");
	assert.equal(callIdOf({ type: "tool/result", data: { message: { toolCallId: "call_b" } } }), "call_b");
	assert.equal(callIdOf({ type: "tool/result", data: { message: { source: { callId: "call_c" } } } }), "call_c");
	assert.equal(callIdOf({ type: "user/message", data: { content: [] } }), "");
	assert.equal(callIdOf({ type: "assistant/message", data: { message: { id: "uuid" } } }), "");
});

await check("the host route reports the call id", () => {
	assert.ok(host.includes("callId: part.callId === \"\" ? null : part.callId"),
		"the route copies the part's call id");
	assert.ok(host.includes("callId: item.callId,"), "the response keeps it");
});

await check("the client keeps the call id from the response", () => {
	assert.ok(source.includes("callId: typeof item.callId === \"string\" && item.callId !== \"\" ? item.callId : null"),
		"searchHost must not drop the field it just received");
});

await check("the tool row is found by data-chat-call-id", () => {
	assert.ok(source.includes("const CALL_ATTRIBUTE = \"data-chat-call-id\";"));
	assert.ok(source.includes("function callRowOf(root, callId)"));
	assert.ok(source.includes("const row = callId === \"\" ? null : callRowOf(root, callId);"),
		"choose() tries the exact row before any text match");
	assert.ok(source.includes("const callId = typeof hit.callId === \"string\" ? hit.callId : \"\";"));
});

await check("tool hits never fall back to the query word", () => {
	assert.ok(source.includes("if (callId === \"\") {"),
		"query terms are only added for hits without a call id");
	assert.ok(source.includes("const target = findMatch(root, needles, state.claims);"),
		"text matching receives the set of claimed rows");
});

await check("a row is claimed once per query", () => {
	assert.ok(source.includes("claims: new Set()"));
	assert.ok(source.includes("state.claims.clear();"), "a new query starts with no claims");
	assert.equal(source.match(/state\.claims\.add\(/gu)?.length, 2, "both anchors claim their row");
	assert.ok(source.includes("if (claimed !== undefined && claimed.has(block)) continue;"),
		"the block scan skips claimed rows");
	assert.ok(source.includes("return claimed === undefined || !claimed.has(block) ? block : null;"),
		"the text walk skips claimed rows");
});

await check("a stale jump stops before marking", () => {
	assert.ok(source.includes("const ticket = (state.jumpId += 1);"), "each jump takes a ticket");
	assert.ok(source.includes("if (state.jumpId !== ticket) return false;"),
		"the poll loop aborts once a newer jump starts");
	assert.ok(source.match(/if \(state\.jumpId !== ticket\) return false;/gu)?.length >= 2,
		"both marking paths re-check before painting");
	assert.ok(source.includes("state.jumpId += 1;"), "search and close bump the counter");
});

await check("the turn is read from the event, never guessed", () => {
	assert.equal(turnOf({ type: "turn/start", data: { turn: 3 } }, 0), 3);
	assert.equal(turnOf({ type: "assistant/message", data: { turn: 4 } }, 3), 4);
	assert.equal(turnOf({ type: "user/message", data: { content: [] } }, 5), 5, "user events inherit the turn");
	assert.equal(turnOf({ type: "tool/call", data: {} }, 2), 2);
	assert.equal(turnOf({ type: "turn/start", data: { turn: 0 } }, 7), 7, "a zero turn is not a turn");
});

await check("every extracted part carries its turn", () => {
	const search = readFileSync(new URL("../lib/search.js", import.meta.url), "utf8");
	assert.ok(search.includes("if (type === \"turn/start\") {"), "the scan observes turn boundaries");
	assert.ok(search.includes("turn: turnOf(event, turn)"), "each part stores its turn");
	assert.ok(host.includes("turn: typeof part.turn === \"number\" && part.turn > 0 ? part.turn : null"),
		"the route reports the turn");
	assert.ok(host.includes("turn: item.turn,"), "the response keeps it");
	assert.ok(source.includes("turn: typeof item.turn === \"number\" && item.turn > 0 ? item.turn : null"),
		"the client keeps the field it just received");
});

await check("a hit with no call id still lands on its turn", () => {
	assert.ok(source.includes("const TURN_ATTRIBUTE = \"data-chat-turn\";"));
	assert.ok(source.includes("function turnRowOf(root, turn)"));
	assert.ok(source.includes("const turned = turnRowOf(root, hit.turn);"),
		"choose() tries the turn before plain text");
	assert.ok(source.includes("const inner = findMatch(turned, needles, undefined);"),
		"the exact text inside the turn is preferred when it exists");
});

process.stdout.write("dsh-session-finder anchor: " + String(checks) + " checks passed\n");
