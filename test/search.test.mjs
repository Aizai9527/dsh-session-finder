/**
 * Host-half unit checks: visible-text extraction, snippet shaping, ranking, and
 * the revision cache. Run with `npm test` (`node test/search.test.mjs`).
 */

import assert from "node:assert/strict";
import { rank, parseOffset } from "../lib/index.js";
import { blocksText, clearTextCache, eventText, normalizeQuery, normalizeText, snippetOf, stripInjected, termsOf, textsOf } from "../lib/search.js";

let checks = 0;

/** @param {string} label @param {() => unknown | Promise<unknown>} body */
async function check(label, body) {
	await body();
	checks += 1;
	process.stdout.write("ok " + label + "\n");
}

/** @param {unknown[]} events @returns a persistence double over one session. */
function fakePersistence(events) {
	return {
		async open() {
			return {
				async read() { return { events }; },
				async close() { /* idempotent */ }
			};
		}
	};
}

const snapshot = { header: { id: "s-1", createdAt: 1 }, revision: "r1" };

await check("normalizeText collapses whitespace", () => {
	assert.equal(normalizeText("  a\n\n  b\tc  "), "a b c");
	assert.equal(normalizeText(undefined), "");
});

await check("normalizeQuery lowercases", () => {
	assert.equal(normalizeQuery("  PNPM   Store "), "pnpm store");
});

await check("termsOf dedupes and orders longest first", () => {
	assert.deepEqual(termsOf("pnpm  lockfile pnpm a"), ["lockfile", "pnpm", "a"]);
});

await check("blocksText keeps text blocks and drops reasoning and images", () => {
	const content = [
		{ type: "reasoning", text: "hidden chain of thought" },
		{ type: "text", text: "visible answer" },
		{ type: "image_url", image_url: { url: "data:..." } }
	];
	assert.equal(blocksText(content), "visible answer");
	assert.equal(blocksText("plain string"), "plain string");
});

await check("eventText reads the real event shapes", () => {
	assert.equal(eventText({ type: "user/message", seq: 1, data: { content: [{ type: "text", text: "用户输入" }] } }), "用户输入");
	const assistant = {
		type: "assistant/message",
		seq: 2,
		data: {
			message: { content: [{ type: "reasoning", text: "思维链" }, { type: "text", text: "最终回答" }] },
			stream: { chunks: [{ type: "text", text: "碎片" }] }
		}
	};
	assert.equal(eventText(assistant), "最终回答", "reasoning and stream chunks are not indexed");
	assert.equal(eventText({ type: "system/message", seq: 0, data: { message: { content: [{ type: "text", text: "系统提示" }] } } }), "", "system prompt is not indexed");
	assert.equal(eventText({ type: "tool/call", seq: 3, data: { name: "bash", arguments: "{\"cmd\":\"ls\"}" } }), "bash\n{\"cmd\":\"ls\"}");
});

await check("snippetOf marks both cut sides", () => {
	const text = "a".repeat(100) + "needle" + "b".repeat(200);
	const snippet = snippetOf(text, 100, 6);
	assert.ok(snippet.startsWith("\u2026"), "leading ellipsis");
	assert.ok(snippet.endsWith("\u2026"), "trailing ellipsis");
	assert.ok(snippet.includes("needle"));
});

await check("snippetOf leaves short text intact", () => {
	assert.equal(snippetOf("needle here", 0, 6), "needle here");
});

await check("stripInjected drops reminder blocks and keeps the user's words", () => {
	const text = "请修复这个问题 <system-reminder>\n# Rules\n安装插件要小心\n</system-reminder> 谢谢";
	assert.equal(stripInjected(text), "请修复这个问题   谢谢");
	assert.equal(stripInjected("没有提醒"), "没有提醒");
	assert.ok(!stripInjected("前缀 <system-reminder> 未闭合").includes("system-reminder"), "unterminated block dropped");
});

await check("rank requires every term and prefers the contiguous phrase", () => {
	const loose = rank("how do i search the session log", "search log", ["search", "log"]);
	assert.ok(loose !== null, "all terms present matches");
	assert.equal(loose.score, 1);
	const phrase = rank("please search log now", "search log", ["search", "log"]);
	assert.equal(phrase.score, 2, "contiguous phrase wins");
	assert.equal(phrase.at, 7);
	assert.equal(rank("only one term", "search log", ["search", "log"]), null, "a missing term rejects the part");
});

await check("parseOffset clamps garbage to zero", () => {
	assert.equal(parseOffset(undefined), 0);
	assert.equal(parseOffset("-5"), 0);
	assert.equal(parseOffset("48"), 48);
	assert.equal(parseOffset("abc"), 0);
});

await check("textsOf indexes only visible conversation events", async () => {
	clearTextCache();
	const events = [
		{ type: "request/header", seq: 0, data: { prompt: "needle in a prompt snapshot" } },
		{ type: "system/message", seq: 1, data: { message: { content: [{ type: "text", text: "needle in the shared system prompt" }] } } },
		{
			type: "assistant/message",
			seq: 2,
			data: {
				message: { content: [{ type: "reasoning", text: "needle in reasoning" }, { type: "text", text: "needle in the answer" }] },
				stream: { chunks: [{ type: "text", text: "needle in a stream chunk" }] }
			}
		},
		{ type: "user/message", seq: 3, data: { content: [{ type: "text", text: "needle in the real message" }] } }
	];
	const entry = await textsOf(fakePersistence(events), snapshot);
	assert.equal(entry.parts.length, 2, "system, header and reasoning events are not indexed");
	assert.equal(entry.parts[0].seq, 2);
	assert.equal(entry.parts[0].text, "needle in the answer");
	assert.equal(entry.parts[0].role, "assistant");
	assert.equal(entry.parts[1].seq, 3);
	assert.equal(entry.parts[1].role, "user");
	assert.equal(entry.parts[0].lower, "needle in the answer");
});

await check("textsOf reads once and reuses the cache until the revision moves", async () => {
	clearTextCache();
	let opens = 0;
	const persistence = {
		async open() {
			opens += 1;
			return {
				async read() { return { events: [{ type: "user/message", seq: 0, data: { content: [{ type: "text", text: "第一行 内容" }] } }] }; },
				async close() { /* idempotent */ }
			};
		}
	};
	const first = await textsOf(persistence, { header: { id: "s-2", createdAt: 1 }, revision: "r1" });
	assert.equal(first.parts.length, 1);
	const second = await textsOf(persistence, { header: { id: "s-2", createdAt: 1 }, revision: "r1" });
	assert.equal(second, first, "same revision returns the cached entry");
	assert.equal(opens, 1, "one log read for two searches");
	await textsOf(persistence, { header: { id: "s-2", createdAt: 1 }, revision: "r2" });
	assert.equal(opens, 2, "a new revision re-reads");
});

process.stdout.write("dsh-session-finder host: " + String(checks) + " checks passed\n");