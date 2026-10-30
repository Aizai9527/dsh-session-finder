/**
 * Static guard for the two post-locate affordances.
 *
 * After a hit is located the user must still see WHICH text matched inside the
 * conversation, and WHICH session the app switched to. Both used to be missing:
 * the outline was removed after 3.2 s, and the sidebar row of the opened session
 * was never marked. This checks the source for both behaviours.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("../lib/client.js", import.meta.url)), "utf8");

// 1. The keyword keeps a visible mark until the next jump or until the panel closes.
assert.match(source, /const EXACT_ATTRIBUTE = HIT_ATTRIBUTE \+ "-exact";/u, "the exact text run needs its own attribute");
assert.equal(/HIGHLIGHT_MS/u.test(source), false, "the highlight must not expire on a timer any more");
assert.equal(/setTimeout\(\(\) => \{\s*block\.removeAttribute/u.test(source), false, "focusTarget() must not schedule its own removal");

const focusStart = source.indexOf("async function focusTarget(");
const focusEnd = source.indexOf("function clearHighlight(");
assert.ok(focusStart > 0 && focusEnd > focusStart, "client.js must define focusTarget() followed by clearHighlight()");
const focusBody = source.slice(focusStart, focusEnd);
assert.match(focusBody, /marks\.block = block;/u, "focusTarget() must remember the highlighted block");
assert.match(focusBody, /marks\.exact = target;/u, "focusTarget() must remember the highlighted text run");

// 2. One place drops every mark, and it is called on the next jump and on close.
assert.match(source, /function clearHighlight\(\) \{/u, "client.js must centralise removal in clearHighlight()");
assert.match(source, /marks\.row\.removeAttribute\(TARGET_ATTRIBUTE\)/u, "clearHighlight() must unmark the sidebar row too");
assert.match(source, /querySelectorAll\("\[" \+ TARGET_ATTRIBUTE \+ "\]"\)/u, "clearHighlight() must sweep rows re-rendered behind its back");
const chooseStart = source.indexOf("async function choose(");
const chooseEnd = source.indexOf("async function step(");
const chooseBody = source.slice(chooseStart, chooseEnd);
assert.match(chooseBody, /clearHighlight\(\);/u, "a new jump must clear the previous highlight");
assert.match(chooseBody, /marks\.session = hit\.sessionId;/u, "choose() must record which session it is showing");
assert.match(chooseBody, /markSidebar\(/u, "choose() must mark the sidebar row of the opened session");
assert.match(chooseBody, /toast\(TEXT\.sidebarMiss\)/u, "a missing sidebar row must be reported, not swallowed");

const closeStart = source.indexOf("function close() {");
const closeBody = source.slice(closeStart, source.indexOf("function toggle()"));
assert.match(closeBody, /clearHighlight\(\);/u, "closing the overlay must drop the marks");

// 3. Rows are plain divs without role or id, so matching goes through the title text
//    and the deepest element wins over the containers that also contain it.
const markStart = source.indexOf("async function markSidebar(");
const markEnd = source.indexOf("function findGroupOpener(");
assert.ok(markStart > 0 && markEnd > markStart, "client.js must define markSidebar()");
const markBody = source.slice(markStart, markEnd);
assert.match(markBody, /for \(let attempt = 0; attempt < 8; attempt \+= 1\)/u, "the row may mount late, so markSidebar() retries");
assert.match(markBody, /rows\[0\]\.scrollIntoView\(\{ block: "nearest" \}\)/u, "the located session must be scrolled into view in the sidebar");
assert.match(markBody, /for \(const row of rows\) row\.setAttribute\(TARGET_ATTRIBUTE, sessionId\)/u, "every row showing the session must be marked");
assert.match(source, /"div, li, a, button, \[role\]"/u, "rows are matched as plain elements, because the app's rows carry no role");

const findStart = source.indexOf("function findSidebarRows(");
const findEnd = source.indexOf("async function markSidebar(");
assert.ok(findStart > 0 && findEnd > findStart, "client.js must define findSidebarRows()");
const findBody = source.slice(findStart, findEnd);
assert.match(findBody, /const limit = needle\.length \+ 14;/u, "a row is the title plus a short timestamp, not a whole subtree");
assert.match(findBody, /deepest\.slice\(0, 3\)/u, "the deepest matching rows must win over their containers");
assert.match(source, /\[data-slot\*="sidebar" i\]/u, "the sidebar column must be found by slot name too");

// 4. Grouped lists hide old sessions; the collapsed group is expanded once.
assert.match(source, /展开其余\|展开更多\|显示更多/u, "collapsed session groups must be opened to reveal the row");
assert.match(source, /let expanded = false;/u, "the group is expanded only once per jump");

// 5. The mark is visible and cannot be clipped by an overflow context.
assert.match(source, /\[\$\{TARGET_ATTRIBUTE\}\]\{box-shadow:inset 0 0 0 2px/u, "the sidebar mark needs an inset ring that survives overflow clipping");
assert.match(source, /\[\$\{EXACT_ATTRIBUTE\}\][^\n]*color-mix/u, "the exact run needs a background wash behind the keyword");

// 6. When the column cannot scroll any further, the panel moves instead of the content.
assert.match(source, /panel\.dataset\.docked = "bottom"/u, "an unreachable hit must dock the panel out of the way");
assert.match(source, /\[data-docked="bottom"\]\{top:auto;bottom:/u, "the docked panel needs a bottom placement rule");
assert.match(source, /delete nodes\.panel\.dataset\.docked/u, "leaving navigation must undock the panel");

console.log("dsh-session-finder target: 27 checks passed");
