/**
 * Guards for the latency work: the overlay must not slow a search down for the
 * sake of warming history, and the status line must report how long a query took.
 */
import { readFileSync } from "node:fs";

const here = new URL(".", import.meta.url);
const clientSource = readFileSync(new URL("../lib/client.js", here), "utf8");
const hostSource = readFileSync(new URL("../lib/index.js", here), "utf8");
const searchSource = readFileSync(new URL("../lib/search.js", here), "utf8");

let failures = 0;
function check(name, condition) {
	if (condition) console.log("ok " + name);
	else {
		failures += 1;
		console.log("FAIL " + name);
	}
}

check("a row warms history only after the pointer settles", clientSource.includes("const PREFETCH_DELAY_MS = 400;")
	&& clientSource.includes("function schedulePrefetch(hit)")
	&& clientSource.includes("function cancelPrefetch()")
	&& clientSource.includes("schedulePrefetch(state.items[index]);")
	&& clientSource.includes("cancelPrefetch();"));

check("warming never competes with a query in flight", clientSource.includes("if (state.pending !== null) return;"));

check("the status line reports how long the query took", clientSource.includes("took: (seconds) => \" · 用时 \"")
	&& clientSource.includes("const startedAt = Date.now();")
	&& clientSource.includes("const took = TEXT.took((Date.now() - startedAt) / 1000);"));

check("the warm-up pass yields between sessions and skips what it already holds", hostSource.includes("if (isCached(snapshot)) continue;")
	&& hostSource.includes("setTimeout(resolve, 40)")
	&& hostSource.includes("const WARM_IDLE_MS = 800;"));

check("isCached reads the memory cache only", searchSource.includes("export function isCached(snapshot)")
	&& searchSource.includes("cached !== undefined && cached.revision === String(snapshot.revision ?? \"\")"));

if (failures > 0) {
	console.log("dsh-session-finder perf: " + failures + " check(s) failed");
	process.exit(1);
}
console.log("dsh-session-finder perf: 5 checks passed");
