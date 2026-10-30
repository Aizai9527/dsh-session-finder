/**
 * Static guard for the hit-to-hit navigation.
 *
 * The search box must stay open after a hit is located so the player can walk the
 * remaining hits with 上一处 / 下一处. An earlier version called `close()` inside
 * `choose()`, which forced a full re-search for every hit. This checks the source
 * for that regression and for the controls the walking needs.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("../lib/client.js", import.meta.url)), "utf8");

const chooseStart = source.indexOf("async function choose(");
const chooseEnd = source.indexOf("async function step(");
assert.ok(chooseStart > 0 && chooseEnd > chooseStart, "client.js must define choose() followed by step()");
const chooseBody = source.slice(chooseStart, chooseEnd);

assert.equal(/^\s*close\(\);$/mu.test(chooseBody), false, "choose() must not close the overlay; the search box stays open");
assert.match(chooseBody, /dataset\.navigating = "true"/u, "choose() must switch the overlay to the see-through navigating state");

for (const selector of [".sf-nav-prev", ".sf-nav-next", ".sf-nav-count"]) {
	assert.ok(source.includes(selector), "client.js must render " + selector);
}
assert.match(source, /function updateNav\(\) \{/u, "client.js must keep the position counter in updateNav()");
assert.match(source, /function keepClearOfPanel\(/u, "located hits must be nudged clear of the open panel");
assert.match(source, /function setCollapsed\(/u, "the result list must be collapsible so the panel does not hide the located message");
assert.match(source, /dataset\.collapsed = state\.collapsed/u, "setCollapsed() must drive the collapsed panel state");
assert.match(source, /\.querySelector\("\.sf-toggle"\)\.addEventListener/u, "the panel must offer a control to fold and unfold the list");
assert.match(source, /setCollapsed\(true\);/u, "locating a hit must fold the list away");
assert.match(source, /\.sf-panel\[data-collapsed="true"\] \.sf-list\{display:none\}/u, "the collapsed panel must hide the result list via CSS");
assert.match(source, /state\.hasOlder\) \{\s*await runSearch\(state\.query, true\);/u, "stepping past the last loaded hit must load the next page");

console.log("dsh-session-finder nav: 11 checks passed");
