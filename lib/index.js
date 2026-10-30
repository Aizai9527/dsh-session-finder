/**
 * dsh-session-finder — host half.
 *
 * The client half cannot rely on the shipped `sessions.search` RPC everywhere:
 * that path resolves to `ctx.sessionQuery`, and a deployment may mount the
 * index with `openAt: "never"`, so every search answers
 * `SESSION_QUERY_SEARCH_DISABLED`. The persistence seam has no such switch, so
 * this half answers one read-only HTTP route by reading stored session logs:
 *
 *   GET /session-finder/search?q=<text>&offset=<n>[&sessionId=<id>|&cwd=<path>]
 *   -> { query, terms, scope, items: [{ sessionId, seq, role, time, callId, turn, snippet }],
 *        scanned, totalSessions, offset, nextOffset, hasOlder, truncated }
 *
 * `callId` is set for tool call/result hits: the chat renders tool rows with
 * `data-chat-call-id`, which lets the client jump to the exact row instead of
 * matching text that a folded row hides.
 *
 * `turn` is the turn number the hit belongs to (own `data.turn`, or the latest
 * `turn/start` for user messages). The chat renders rows with
 * `data-chat-turn`, so a hit can still be anchored when its own text is folded
 * into a collapsed row and never appears as text nodes.
 *
 * `sessionId` narrows the scan to one session and `cwd` to one project; both are
 * applied before paging, so a narrow scope starts at its own offset 0.
 *
 * Matching is "all terms present" (空格分词), with the exact phrase ranked
 * first inside each session. Nothing is written: sessions are opened `'read'`,
 * scanned in memory, and extracted text stays cached by (id, revision) until
 * the plugin unloads. Bounded on every axis — newest 150 sessions per page,
 * 3 hits each, 40 hits total, 2.5s, six sessions read at once — and
 * `nextOffset` walks further back.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { callIdOf, clearTextCache, isCached, normalizeQuery, snippetOf, termsOf, textsOf, useDiskCache } from "./search.js";

/** Cordis plugin name, matching the id in `cordis.patch.yml`. */
export const name = "session-finder";

/** The host route table this half registers on. */
export const inject = ["webServer"];

/** Sessions examined per page, newest first. */
const MAX_SESSIONS = 150;
/** Hits returned per request. */
const MAX_HITS = 40;
/** Hits reported per session, so one long log cannot crowd out the rest. */
const HITS_PER_SESSION = 3;
/** Wall-clock budget for one request; the client surfaces `truncated`. */
const TIME_BUDGET_MS = 2500;
/** Sessions read at once: enough to hide per-file latency without thrashing. */
const CONCURRENCY = 6;
/** The warm-up pass idles while a search is this recent, in milliseconds. */
const WARM_IDLE_MS = 800;
/** Query strings shorter than this are rejected instead of scanned. */
const MIN_QUERY_LENGTH = 2;
/** The route this half owns. */
const ROUTE_PATH = "/session-finder/search";
/** Where the extraction cache lives across restarts ("" when disabled). */
const CACHE_DIR = process.env.DSH_SESSION_FINDER_NO_DISK === "1"
	? ""
	: join(homedir(), ".dsh", "cache", "dsh-session-finder");

/**
 * Score one text part against a query.
 *
 * Every term must occur somewhere in the part. A contiguous occurrence of the
 * whole query scores 2, loose terms score 1, so the exact phrase is listed
 * first inside a session.
 * @param lower - the part's lowercased text.
 * @param query - normalised query.
 * @param terms - the query's unique terms.
 * @returns `{ at, length, score }` or null.
 */
function rank(lower, query, terms) {
	let first = Number.POSITIVE_INFINITY;
	for (const term of terms) {
		const index = lower.indexOf(term);
		if (index < 0) return null;
		if (index < first) first = index;
	}
	const phrase = terms.length > 1 ? lower.indexOf(query) : first;
	if (phrase >= 0) {
		return { at: phrase, length: query.length, score: 2 };
	}
	let length = 0;
	for (const term of terms) length = Math.max(length, term.length);
	return { at: first, length, score: 1 };
}

/**
 * How much a role's text matters when several parts of one session match.
 * Tool logs dominate raw counts, so prose always outranks them.
 * @param role - part role.
 * @returns the weight.
 */
function roleWeight(role) {
	if (role === "user") return 3;
	if (role === "assistant") return 2;
	return 1;
}

/**
 * Read a non-negative integer query parameter.
 * @param value - raw parameter.
 * @returns the parsed offset, 0 when absent or invalid.
 */
function parseOffset(value) {
	const parsed = Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 1_000_000) : 0;
}

/**
 * Answer one search request.
 * @param ctx - host plugin context.
 * @param req - Node request.
 * @param res - Node response.
 */
async function handleSearch(ctx, req, res) {
	const raw = typeof req.url === "string" ? req.url : "/";
	const url = new URL(raw, "http://session-finder.invalid");
	let query = normalizeQuery(url.searchParams.get("q") ?? "");
	if (query === "") {
		const tail = url.pathname.startsWith(ROUTE_PATH) ? url.pathname.slice(ROUTE_PATH.length) : "";
		const encoded = tail.replace(/^\/+/, "");
		if (encoded !== "") {
			try {
				query = normalizeQuery(decodeURIComponent(encoded));
			}
			catch (error) {
				void error;
			}
		}
	}
	if (query.length < MIN_QUERY_LENGTH) {
		fail(res, 400, "query-too-short", "query needs at least " + String(MIN_QUERY_LENGTH) + " characters");
		return;
	}
	const terms = termsOf(query);
	const offset = parseOffset(url.searchParams.get("offset"));
	const persistence = ctx.get("sessionPersistence");
	if (persistence === undefined || typeof persistence.list !== "function" || typeof persistence.open !== "function") {
		fail(res, 503, "persistence-unavailable", "this deployment mounts no session persistence service");
		return;
	}
	const startedAt = Date.now();
	lastRequestAt = startedAt;
	let snapshots;
	try {
		snapshots = await persistence.list();
	}
	catch (error) {
		fail(res, 500, "list-failed", messageOf(error));
		return;
	}
	const ordered = [...snapshots]
		.filter((snapshot) => typeof snapshot?.header?.id === "string")
		.sort((left, right) => (right.header.createdAt ?? 0) - (left.header.createdAt ?? 0));
	// Narrow before paging: a scoped search must start at its own offset 0 and
	// must find its session even when that session is far down the global list.
	const askedSession = (url.searchParams.get("sessionId") ?? "").trim();
	const askedCwd = (url.searchParams.get("cwd") ?? "").trim();
	const scope = askedSession !== "" ? "session" : askedCwd !== "" ? "project" : "all";
	const scoped = scope === "session"
		? ordered.filter((snapshot) => snapshot.header.id === askedSession)
		: scope === "project"
			? ordered.filter((snapshot) => snapshot.header.cwd === askedCwd)
			: ordered;
	const page = scoped.slice(offset, offset + MAX_SESSIONS);
	// Read several sessions at once: each one waits on file I/O and zstd, so a
	// serial loop paid the sum of every wait while most of the pool sat idle.
	const entries = new Array(page.length);
	let nextIndex = 0;
	let scanned = 0;
	let partialSessions = 0;
	let timedOut = false;
	const reader = async () => {
		for (;;) {
			if (Date.now() - startedAt > TIME_BUDGET_MS) {
				timedOut = true;
				return;
			}
			const index = nextIndex;
			if (index >= page.length) return;
			nextIndex += 1;
			let entry;
			try {
				entry = await textsOf(persistence, page[index]);
			}
			catch (error) {
				void error;
				continue;
			}
			scanned += 1;
			if (entry.partial === true) partialSessions += 1;
			entries[index] = entry;
		}
	};
	const workers = [];
	for (let started = 0; started < Math.min(CONCURRENCY, page.length); started += 1) workers.push(reader());
	await Promise.all(workers);
	// Sessions still assemble in newest-first order, whatever order they finished in.
	const items = [];
	let truncated = timedOut;
	let examined = 0;
	for (let index = 0; index < page.length; index += 1) {
		examined = index + 1;
		const entry = entries[index];
		if (entry === undefined) continue;
		const snapshot = page[index];
		const sessionItems = [];
		for (const part of entry.parts) {
			const match = rank(part.lower, query, terms);
			if (match === null) continue;
			sessionItems.push({
				sessionId: snapshot.header.id,
				seq: part.seq,
				role: part.role,
				time: part.time,
				callId: part.callId === "" ? null : part.callId,
				turn: typeof part.turn === "number" && part.turn > 0 ? part.turn : null,
				snippet: snippetOf(part.text, match.at, match.length),
				score: roleWeight(part.role) * 10 + match.score
			});
		}
		sessionItems.sort((left, right) => right.score - left.score || left.seq - right.seq);
		for (const item of sessionItems.slice(0, HITS_PER_SESSION)) {
			items.push(item);
			if (items.length >= MAX_HITS) break;
		}
		if (items.length >= MAX_HITS) {
			truncated = true;
			break;
		}
	}
	// A timed-out page only got through the sessions the readers actually opened;
	// resume from there so the unread tail is not skipped.
	if (timedOut && nextIndex < examined) examined = nextIndex;
	const nextOffset = offset + (examined === 0 ? 0 : examined);
	const hasOlder = examined > 0 && nextOffset < scoped.length;
	respond(res, 200, {
		query,
		terms,
		scope,
		items: items.map((item) => ({
			sessionId: item.sessionId,
			seq: item.seq,
			role: item.role,
			time: item.time,
			callId: item.callId,
			turn: item.turn,
			snippet: item.snippet
		})),
		scanned,
		totalSessions: scoped.length,
		partialSessions,
		offset,
		nextOffset,
		hasOlder,
		truncated
	});
}

/**
 * Whether this request may use the route — the same fence the shipped plugins
 * apply, so a request the connection rejects never reaches the log reader.
 * @param ctx - host plugin context.
 * @param req - Node request.
 * @returns true when the request is acceptable.
 */
function accepted(ctx, req) {
	try {
		const connection = ctx.connection;
		if (connection === undefined || typeof connection.requestRejection !== "function") return true;
		return connection.requestRejection(req) === undefined;
	}
	catch (error) {
		return true;
	}
}

/** @returns the message from any thrown value. */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Write one JSON response.
 * @param res - Node response.
 * @param status - HTTP status code.
 * @param body - JSON-serialisable body.
 */
function respond(res, status, body) {
	if (res.writableEnded === true) return;
	const payload = Buffer.from(JSON.stringify(body), "utf8");
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": String(payload.byteLength),
		"cache-control": "no-store"
	});
	res.end(payload);
}

/**
 * Write one JSON error response.
 * @param res - Node response.
 * @param status - HTTP status code.
 * @param code - machine-readable reason.
 * @param message - human-readable detail.
 */
function fail(res, status, code, message) {
	respond(res, status, { error: { code, message } });
}

/** When the last search arrived, so the warm-up pass can yield to it. */
let lastRequestAt = 0;

/**
 * Fill the extraction cache while the app is idle.
 *
 * Extraction is CPU-bound (zstd + JSON per session), so this cannot make one
 * request faster; it makes the *first* search after a restart fast by writing
 * the disk cache in the background. The pass pauses whenever a search is
 * recent, so it never competes with the reader.
 * @param ctx - host plugin context.
 * @returns a stop function.
 */
function warmUp(ctx) {
	let stopped = false;
	let timer = null;
	const pass = async () => {
		timer = null;
		if (stopped) return;
		const persistence = ctx.get("sessionPersistence");
		if (persistence === undefined || typeof persistence.list !== "function") return;
		let snapshots;
		try {
			snapshots = await persistence.list();
		}
		catch (error) {
			void error;
			return;
		}
		const ordered = [...snapshots]
			.filter((snapshot) => typeof snapshot?.header?.id === "string")
			.sort((left, right) => (right.header.createdAt ?? 0) - (left.header.createdAt ?? 0));
		for (const snapshot of ordered) {
			if (stopped) return;
			if (isCached(snapshot)) continue;
			while (Date.now() - lastRequestAt < WARM_IDLE_MS) {
				if (stopped) return;
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
			try {
				await textsOf(persistence, snapshot);
			}
			catch (error) {
				void error;
			}
			// One session per tick: extraction is CPU-bound, so yielding keeps the
			// event loop free enough for a search typed while the pass runs.
			await new Promise((resolve) => setTimeout(resolve, 40));
		}
	};
	timer = setTimeout(() => {
		void pass();
	}, 1500);
	// Do not keep a process (or a test run) alive just for a warm-up that has
	// nothing to warm.
	if (typeof timer.unref === "function") timer.unref();
	return () => {
		stopped = true;
		if (timer !== null) clearTimeout(timer);
	};
}

/**
 * Register the search route for the lifetime of the plugin.
 * @param ctx - host plugin context.
 */
export function apply(ctx) {
	useDiskCache(CACHE_DIR);
	ctx.effect(() => {
		const stopWarmUp = warmUp(ctx);
		const dispose = ctx.webServer.register({
			kind: "prefix",
			path: ROUTE_PATH,
			handler: (req, res) => {
				if (!accepted(ctx, req)) {
					fail(res, 403, "forbidden", "this connection may not use plugin routes");
					return undefined;
				}
				return handleSearch(ctx, req, res).catch((error) => {
					fail(res, 500, "search-failed", messageOf(error));
				});
			}
		});
		return () => {
			stopWarmUp();
			clearTextCache();
			if (typeof dispose === "function") dispose();
		};
	}, "session-finder: host search route");
}

export { callIdOf, clearTextCache, normalizeQuery, parseOffset, rank, snippetOf, termsOf, textsOf, useDiskCache };