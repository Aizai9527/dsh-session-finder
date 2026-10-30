/**
 * Host-half route checks: register the handler through a fake plugin context and
 * drive it with synthetic sessions. Covers paging math, role priority, the
 * "visible text only" rule, and the connection fence.
 */

import assert from "node:assert/strict";
import { apply } from "../lib/index.js";

let checks = 0;

/** @param {string} label @param {() => unknown | Promise<unknown>} body */
async function check(label, body) {
	await body();
	checks += 1;
	process.stdout.write("ok " + label + "\n");
}

const sessions = new Map();
const snapshots = [];

/** @param {string} id @param {number} createdAt @param {unknown[]} events @param {string} [cwd] */
function addSession(id, createdAt, events, cwd) {
	sessions.set(id, events);
	snapshots.push({ header: { id, createdAt, ...(cwd === undefined ? {} : { cwd }) }, revision: "r1" });
}

addSession("s-new", 3000, [
	{ type: "system/message", seq: 0, data: { message: { content: [{ type: "text", text: "系统提示 插件" }] } } },
	{ type: "assistant/message", seq: 1, data: { message: { content: [{ type: "reasoning", text: "思维链 插件" }, { type: "text", text: "最终回答，没有那个词" }] } } },
	{ type: "user/message", seq: 2, data: { content: [{ type: "text", text: "帮我搜索一下插件里的会话记录" }] } }
], "C:\\proj\\alpha");
addSession("s-mid", 2000, [
	{ type: "user/message", seq: 1, data: { content: [{ type: "text", text: "插件搜索两个词都有" }] } },
	{ type: "tool/call", seq: 2, data: { callId: "call_mid_1", name: "bash", arguments: "{\"cmd\":\"echo 插件\"}" } },
	{ type: "tool/result", seq: 3, data: { message: { toolCallId: "call_mid_2", content: [{ type: "text", text: "命令输出：完成" }] } } }
], "C:\\proj\\beta");
addSession("s-old", 1000, [
	{ type: "user/message", seq: 1, data: { content: [{ type: "text", text: "一个普通的问题" }] } }
], "C:\\proj\\beta");
for (let index = 0; index < 50; index += 1) {
	addSession("s-bulk-" + String(index), 500 - index, [
		{ type: "user/message", seq: 1, data: { content: [{ type: "text", text: "批量会话 编号" + String(index) }] } }
	], "C:\\proj\\beta");
}

const persistence = {
	async list() { return [...snapshots]; },
	async open(id) {
		return {
			async read() { return { events: sessions.get(id) ?? [] }; },
			async close() { /* noop */ }
		};
	}
};

let handler = null;
const ctx = {
	effect(run) { run(); },
	webServer: {
		register(spec) {
			handler = spec.handler;
			return () => {};
		}
	},
	get(name) { return name === "sessionPersistence" ? persistence : undefined; },
	connection: undefined
};

apply(ctx);

/** @param {string} url @returns the JSON response. */
async function call(url) {
	let status = 0;
	let body = "";
	const req = { url, headers: {}, method: "GET" };
	const res = {
		writableEnded: false,
		writeHead(value) { status = value; },
		end(chunk) {
			if (chunk !== undefined) body += chunk.toString("utf8");
			this.writableEnded = true;
		}
	};
	await handler(req, res);
	return { status, body: body === "" ? null : JSON.parse(body) };
}

await check("route is registered", () => {
	assert.equal(typeof handler, "function");
});

await check("legacy path form searches visible text only", async () => {
	const response = await call("/session-finder/search/" + encodeURIComponent("插件"));
	assert.equal(response.status, 200);
	assert.equal(response.body.query, "插件");
	assert.deepEqual(response.body.terms, ["插件"]);
	assert.equal(response.body.scanned, 53, "one page holds every session at this size");
	assert.equal(response.body.totalSessions, 53);
	assert.equal(response.body.nextOffset, 53);
	assert.equal(response.body.hasOlder, false, "nothing is left behind the page");
	assert.equal(response.body.items.length, 3, "one user hit, one user hit, one tool hit");
	assert.equal(response.body.truncated, false);
	assert.ok(response.body.items.every((item) => item.snippet.includes("插件")));
	assert.ok(!response.body.items.some((item) => item.snippet.includes("系统提示")), "system prompt is not indexed");
	assert.ok(!response.body.items.some((item) => item.snippet.includes("思维链")), "reasoning is not indexed");
	const roles = response.body.items.map((item) => item.role);
	assert.deepEqual([...new Set(roles)].sort(), ["tool", "user"]);
});

await check("?q= form requires every term", async () => {
	const both = await call("/session-finder/search?q=" + encodeURIComponent("插件 搜索"));
	assert.equal(both.status, 200);
	assert.ok(both.body.items.length >= 2);
	assert.ok(both.body.items.every((item) => item.snippet.includes("插件") && item.snippet.includes("搜索")));
	const missing = await call("/session-finder/search?q=" + encodeURIComponent("插件 不存在的词"));
	assert.equal(missing.status, 200);
	assert.equal(missing.body.items.length, 0, "a missing term rejects the hit");
});

await check("a tool hit carries the call id the chat renders", async () => {
	const response = await call("/session-finder/search?q=" + encodeURIComponent("echo"));
	assert.equal(response.status, 200);
	const tool = response.body.items.find((item) => item.role === "tool");
	assert.ok(tool !== undefined, "the tool call is a hit");
	assert.equal(tool.callId, "call_mid_1", "tool/call reports its own call id");
	const result = await call("/session-finder/search?q=" + encodeURIComponent("命令输出"));
	const resultHit = result.body.items.find((item) => item.role === "tool");
	assert.ok(resultHit !== undefined, "the tool result is a hit");
	assert.equal(resultHit.callId, "call_mid_2", "tool/result reports its tool call id");
	const user = response.body.items.find((item) => item.role === "user");
	assert.equal(user?.callId ?? null, null, "messages carry no call id");
});

await check("the hit cap resumes at the next session", async () => {
	const first = await call("/session-finder/search?q=" + encodeURIComponent("批量"));
	assert.equal(first.body.items.length, 40, "hit cap");
	assert.equal(first.body.truncated, true);
	assert.equal(first.body.hasOlder, true, "the sessions behind the cap are still reachable");
	assert.ok(first.body.nextOffset < first.body.totalSessions, "resume inside the page, not after it");
	const tail = await call("/session-finder/search?q=" + encodeURIComponent("批量") + "&offset=" + String(first.body.nextOffset));
	assert.equal(tail.body.offset, first.body.nextOffset);
	assert.equal(tail.body.hasOlder, false);
	assert.equal(first.body.items.length + tail.body.items.length, 50, "all 50 bulk sessions are reachable");
	assert.ok(tail.body.items.every((item) => item.snippet.includes("批量")));
});

await check("older page holds no 插件 hit", async () => {
	const older = await call("/session-finder/search?q=" + encodeURIComponent("插件") + "&offset=48");
	assert.equal(older.status, 200);
	assert.equal(older.body.hasOlder, false);
	assert.equal(older.body.items.length, 0);
});

await check("sessionId narrows the scan to one session", async () => {
	const scoped = await call("/session-finder/search?q=" + encodeURIComponent("插件") + "&sessionId=s-mid");
	assert.equal(scoped.status, 200);
	assert.equal(scoped.body.scope, "session");
	assert.equal(scoped.body.totalSessions, 1, "only the asked session counts");
	assert.equal(scoped.body.scanned, 1);
	assert.equal(scoped.body.hasOlder, false);
	assert.ok(scoped.body.items.length >= 2, "user and tool parts both match");
	assert.ok(scoped.body.items.every((item) => item.sessionId === "s-mid"));
	const unindexed = await call("/session-finder/search?q=" + encodeURIComponent("插件") + "&sessionId=s-old");
	assert.equal(unindexed.body.items.length, 0, "a session without the term stays empty");
});

await check("cwd narrows the scan to one project", async () => {
	const scoped = await call("/session-finder/search?q=" + encodeURIComponent("批量") + "&cwd=" + encodeURIComponent("C:\\proj\\beta"));
	assert.equal(scoped.status, 200);
	assert.equal(scoped.body.scope, "project");
	assert.equal(scoped.body.totalSessions, 52, "s-mid, s-old and the 50 bulk sessions");
	assert.equal(scoped.body.items.length, 40);
	const alpha = await call("/session-finder/search?q=" + encodeURIComponent("插件") + "&cwd=" + encodeURIComponent("C:\\proj\\alpha"));
	assert.equal(alpha.body.scope, "project");
	assert.equal(alpha.body.totalSessions, 1);
	assert.equal(alpha.body.items.length, 1);
	assert.equal(alpha.body.items[0].sessionId, "s-new");
	const unscoped = await call("/session-finder/search?q=" + encodeURIComponent("插件"));
	assert.equal(unscoped.body.scope, "all");
});

await check("short queries are rejected", async () => {
	const short = await call("/session-finder/search/a");
	assert.equal(short.status, 400);
	assert.equal(short.body.error.code, "query-too-short");
});

await check("rejected connections never reach the log reader", async () => {
	ctx.connection = { requestRejection: () => ({ code: "untrusted-connection" }) };
	try {
		const forbidden = await call("/session-finder/search?q=" + encodeURIComponent("插件"));
		assert.equal(forbidden.status, 403);
		assert.equal(forbidden.body.error.code, "forbidden");
	}
	finally {
		ctx.connection = undefined;
	}
});

process.stdout.write("dsh-session-finder route: " + String(checks) + " checks passed\n");