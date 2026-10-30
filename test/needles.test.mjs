/**
 * Unit checks for the pure text logic of dsh-session-finder.
 *
 * The browser half is a module-loader bundle, so it is evaluated here with a
 * stub loader: only `buildNeedles` and `normalizeText` are exercised, and both
 * are pure string functions — no DOM is touched.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "lib", "client.js"), "utf8");

let spec;
const window = {
	__ModuleLoader__: {
		load: (value) => {
			spec = value;
		}
	}
};

new Function("window", source)(window);
assert.equal(spec.id, "dsh-session-finder");
const exported = spec.factory(() => {
	throw new Error("the client half must not require anything at load time");
});
assert.equal(typeof exported.apply, "function");
assert.deepEqual(exported.inject, ["sessions", "uiWorkspace"]);

const { buildNeedles, normalizeText } = exported;

assert.equal(normalizeText("  a \n b\t c  "), "a b c");
assert.equal(normalizeText(undefined), "");

assert.deepEqual(buildNeedles(""), []);
assert.deepEqual(buildNeedles("短"), []);

// A plain match: the whole snippet is one fragment.
const plain = buildNeedles("这一段是完整命中的正文内容，长度够用");
assert.equal(plain.length, 1);
assert.equal(plain[0], "这一段是完整命中的正文内容，长度够用");

// Host snippets elide both sides with U+2026: the middle fragment wins.
const elided = buildNeedles("…前面的内容…这一段才是命中的关键词所在的位置内容…后面的内容…");
assert.ok(elided.length >= 1);
assert.ok(elided[0].startsWith("这一段才是命中"), "longest fragment comes first: " + elided[0]);
assert.ok(elided.every((needle) => !needle.includes("\u2026")));

// Very long fragments also yield shorter fallbacks, longest first.
const long = "甲".repeat(120);
const fallbacks = buildNeedles(long);
assert.ok(fallbacks.length >= 3);
assert.deepEqual([...fallbacks].sort((a, b) => b.length - a.length), fallbacks);
assert.equal(fallbacks[0].length, 120);

// Duplicates collapse: no needle is repeated.
const deduped = buildNeedles("…abcdefgh…");
assert.equal(new Set(deduped).size, deduped.length);

console.log("dsh-session-finder: " + String(6) + " checks passed");