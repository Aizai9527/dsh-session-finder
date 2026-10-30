// Guards for the three header buttons (GitHub / 问题反馈 / 检查更新) and the
// version string they print: a stale VERSION or a rate-limited endpoint would
// only show up as a wrong toast in the real app, so assert both here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "lib", "client.js"), "utf8");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const checks = [];
function check(name, run) {
	run();
	checks.push(name);
}

/** Slice out one top-level function so it can be executed in isolation. */
function extract(signature) {
	const start = source.indexOf(signature);
	assert.notEqual(start, -1, "missing " + signature);
	const end = source.indexOf("\n\t\t}", start);
	assert.notEqual(end, -1, "unterminated " + signature);
	return source.slice(start, end + 4);
}

check("header links point at the published repository", () => {
	assert.match(source, /const REPO_URL = "https:\/\/github\.com\/Aizai9527\/dsh-session-finder";/);
	assert.match(source, /const ISSUES_URL = REPO_URL \+ "\/issues\/new";/);
	assert.match(source, /const LATEST_URL = "https:\/\/raw\.githubusercontent\.com\/Aizai9527\/dsh-session-finder\/main\/package\.json";/);
});

check("the printed version tracks package.json", () => {
	const match = source.match(/const VERSION = "([^"]+)";/);
	assert.ok(match, "VERSION constant missing");
	assert.equal(match[1], manifest.version);
});

check("all three buttons render in the header row", () => {
	// The markup is a JS string literal: drop its escaped quotes before matching.
	const flat = source.split('\\"').join('"');
	assert.ok(flat.includes('"<div class="sf-tools">"'), "header row missing");
	assert.ok(flat.includes('"<a class="sf-tool" href="" + REPO_URL + "" target="_blank" rel="noopener noreferrer"'), "GitHub link missing or unsafe");
	assert.ok(flat.includes('"<a class="sf-tool" href="" + ISSUES_URL + "" target="_blank" rel="noopener noreferrer"'), "issue link missing or unsafe");
	assert.ok(flat.includes('"<button class="sf-tool sf-check" type="button"'), "check button missing");
	assert.ok(flat.includes('"<span class="sf-ver">v" + VERSION + "</span>"'), "version label missing");
	assert.match(source, /toolsGithub: "GitHub"/);
	assert.match(source, /toolsIssues: "问题反馈"/);
	assert.match(source, /toolsCheck: "检查更新"/);
});

check("the update check reads the raw manifest, never the rate-limited API", () => {
	assert.doesNotMatch(source, /api\.github\.com/);
	const body = extract("async function checkUpdates(button)");
	assert.match(body, /fetch\(LATEST_URL/);
	assert.match(body, /cache: "no-store"/);
	assert.match(body, /UPDATE_TIMEOUT_MS/);
	assert.match(body, /TEXT\.updateFound\(latest, VERSION\)/);
	assert.match(body, /TEXT\.updateLatest\(VERSION\)/);
	assert.match(body, /button\.disabled = false;/);
});

check("isNewer compares numeric segments and tolerates v prefixes", () => {
	const isNewer = new Function("return (" + extract("function isNewer(candidate, current)") + ");")();
	assert.equal(isNewer("0.8.0", "0.7.2"), true);
	assert.equal(isNewer("0.7.2", "0.7.2"), false);
	assert.equal(isNewer("0.7.2.0", "0.7.2"), false);
	assert.equal(isNewer("v0.10.0", "0.9.9"), true);
	assert.equal(isNewer("0.7.1", "0.7.2"), false);
	assert.equal(isNewer("junk", "0.7.2"), false);
});

check("a newer manifest reports the found version, an older one reports up to date", async () => {
	const TEXT = {
		checking: "checking",
		updateFound: (latest, current) => "found " + latest + " over " + current,
		updateLatest: (version) => "latest " + version,
		updateFailed: "failed"
	};
	const statuses = [];
	const build = () => new Function(
		"fetch", "setStatus", "TEXT", "LATEST_URL", "VERSION", "UPDATE_TIMEOUT_MS",
		extract("function isNewer(candidate, current)") + "\nreturn (" + extract("async function checkUpdates(button)") + ");"
	);
	const button = { disabled: false, setAttribute() {}, removeAttribute() {} };
	await build()(
		async () => ({ ok: true, json: async () => ({ version: "0.9.0" }) }),
		(text) => statuses.push(text), TEXT, "https://example.test/package.json", "0.7.2", 1000
	)(button);
	assert.equal(statuses.at(-1), "found 0.9.0 over 0.7.2");
	assert.equal(button.disabled, false, "button must come back enabled");

	statuses.length = 0;
	const same = { disabled: false, setAttribute() {}, removeAttribute() {} };
	await build()(
		async () => ({ ok: true, json: async () => ({ version: "0.7.2" }) }),
		(text) => statuses.push(text), TEXT, "https://example.test/package.json", "0.7.2", 1000
	)(same);
	assert.equal(statuses.at(-1), "latest 0.7.2");

	statuses.length = 0;
	const broken = { disabled: false, setAttribute() {}, removeAttribute() {} };
	await build()(
		async () => ({ ok: false, status: 404, json: async () => ({}) }),
		(text) => statuses.push(text), TEXT, "https://example.test/package.json", "0.7.2", 1000
	)(broken);
	assert.equal(statuses.at(-1), "failed");
	assert.equal(broken.disabled, false);
});

console.log(checks.map((name) => "ok " + name).join("\n"));
console.log("dsh-session-finder client tools: " + String(checks.length) + " checks passed");
