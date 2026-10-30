/**
 * dsh-session-finder — host-side text extraction.
 *
 * Session logs are append-only event records, and a live event carries far more
 * than what the chat bubble shows: an assistant message stores its reasoning
 * blocks, the streamed chunk fragments, the usage counters and the replay
 * state next to the visible text. Indexing all of it produced two failures:
 * a search could match reasoning the chat never renders (so "open and locate"
 * arrived at a session with no such text), and the same answer was indexed once
 * per chunk. Extraction therefore reads named fields per event type and keeps
 * only text a reader can see.
 *
 * System and developer messages are deliberately NOT indexed: they hold the
 * model's system prompt, which is identical in every session, so any common
 * word would "hit" every conversation.
 *
 * Extracted text is cached per session revision; a rewritten log simply fails
 * the revision check and is read again.
 */

import { promises as fsp } from "node:fs";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { join } from "node:path";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** Most per-session index files kept on disk; older ones are pruned. */
const DISK_FILE_LIMIT = 240;
/** Sessions larger than this are not written to disk (keeps files sane). */
const DISK_ENTRY_CHARS = 8 * 1024 * 1024;
/** Directory holding the on-disk extraction cache; "" disables it. */
let diskDir = "";
/** Set once the directory exists, so every write does not retry `mkdir`. */
let diskReady = false;

/**
 * Point the extraction cache at a directory, or disable it.
 *
 * The cache mirrors the in-memory entries so a restart does not re-read 70 MB
 * of logs for one wide query. Files are named after the log revision, so a
 * session that grew simply misses and is read again.
 * @param dir - absolute directory, or "" to disable.
 */
export function useDiskCache(dir) {
	diskDir = typeof dir === "string" ? dir.trim() : "";
	diskReady = false;
}

/** Characters kept from one field, so a whole file body is not a hit source. */
const MAX_FIELD_CHARS = 200000;
/** Total extracted characters cached across sessions before eviction. */
const CACHE_CHAR_LIMIT = 64 * 1024 * 1024;
/**
 * Characters kept from one session before the rest is ignored.
 *
 * This used to be 400 000, which silently cut long-running sessions: a live
 * session here reached 6.5 M characters, so anything said late in it — the part
 * a reader is most likely to search for — was never indexed and the plugin
 * answered "没有命中" for text plainly visible on screen. Measured on this
 * machine, every session together is 71 M characters and reads in about five
 * seconds, so the cap only needs to stop a pathological file, not normal ones.
 */
const MAX_SESSION_CHARS = 8 * 1024 * 1024;

/** Event types that carry visible conversation content. */
const CONTENT_TYPES = new Set(["user/message", "assistant/message", "tool/call", "tool/result"]);

/**
 * Drop injected reminder blocks from an event's text.
 *
 * The runtime appends its rules and environment notes to the same text field a
 * user message lives in, so without this a search for a common word matches
 * every session through the boilerplate instead of through anything the user
 * wrote. An unterminated block is dropped to the end of the field.
 * @param text - the event's collected text.
 * @returns the text with `<system-reminder>` blocks removed.
 */
export function stripInjected(text) {
	if (typeof text !== "string" || !text.includes("<system-reminder>")) return text;
	const OPEN = "<system-reminder>";
	const CLOSE = "</system-reminder>";
	let out = text;
	for (;;) {
		const start = out.indexOf(OPEN);
		if (start < 0) break;
		const end = out.indexOf(CLOSE, start);
		out = end < 0 ? out.slice(0, start) : out.slice(0, start) + " " + out.slice(end + CLOSE.length);
	}
	return out;
}

/** @type {Map<string, { revision: string, parts: { seq: number, role: string, time: number, text: string, lower: string }[], chars: number }>} */
const cache = new Map();
let cachedChars = 0;

/**
 * Collapse runs of whitespace so a snippet reads as one line.
 * @param value - raw text.
 * @returns text with single spaces.
 */
export function normalizeText(value) {
	return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

/**
 * Normalise a user query for case-insensitive substring matching.
 * @param value - raw query.
 * @returns lowercase, whitespace-collapsed query.
 */
export function normalizeQuery(value) {
	return normalizeText(value).toLowerCase();
}

/**
 * Split a normalised query into the terms that must all be present.
 * @param query - normalised query (lowercase, single spaces).
 * @returns unique terms, longest first.
 */
export function termsOf(query) {
	const seen = new Set();
	const terms = [];
	for (const term of normalizeText(query).toLowerCase().split(" ")) {
		if (term === "" || seen.has(term)) continue;
		seen.add(term);
		terms.push(term);
	}
	return terms.sort((left, right) => right.length - left.length);
}

/**
 * Join the visible text blocks of a message's `content` array.
 *
 * Only `text` blocks count: reasoning, images, signatures and tool-addition
 * markers are skipped because the chat does not render them as prose.
 * @param content - `content` value, array or string.
 * @returns joined visible text.
 */
export function blocksText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) {
		if (typeof block === "string") {
			parts.push(block);
			continue;
		}
		if (block === null || typeof block !== "object") continue;
		if (block.type === "text" && typeof block.text === "string" && block.text !== "") parts.push(block.text);
	}
	return parts.join("\n");
}

/**
 * Read one event's visible content, by event type.
 * @param event - one stored event.
 * @returns the visible text, or "" for bookkeeping events.
 */
export function eventText(event) {
	const type = typeof event?.type === "string" ? event.type : "";
	if (!CONTENT_TYPES.has(type)) return "";
	const data = event?.data ?? event ?? {};
	if (type === "tool/call") {
		const values = [];
		if (typeof data.name === "string" && data.name !== "") values.push(data.name);
		if (typeof data.arguments === "string" && data.arguments !== "") values.push(data.arguments);
		return values.join("\n");
	}
	if (type === "user/message") {
		const fromBlocks = blocksText(data.content);
		return fromBlocks !== "" ? fromBlocks : typeof data.text === "string" ? data.text : "";
	}
	if (type === "assistant/message") {
		const message = data.message ?? {};
		return blocksText(message.content);
	}
	const message = data.message ?? {};
	const fromBlocks = blocksText(message.content);
	return fromBlocks !== "" ? fromBlocks : typeof data.output === "string" ? data.output : "";
}

/**
 * The chat role a stored event belongs to.
 * @param type - event type.
 * @returns "user" | "assistant" | "tool".
 */
export function roleOf(type) {
	if (type === "user/message") return "user";
	if (type === "assistant/message") return "assistant";
	return "tool";
}

/**
 * The tool call id an event refers to, when it has one.
 *
 * The chat renders every tool row with `data-chat-call-id`, so a tool hit can be
 * anchored exactly instead of by matching text that the folded row hides.
 * @param event - one stored event.
 * @returns the call id, or "" when the event is not a tool call or result.
 */
export function callIdOf(event) {
	const type = typeof event?.type === "string" ? event.type : "";
	if (type !== "tool/call" && type !== "tool/result") return "";
	const data = event?.data ?? event ?? {};
	if (type === "tool/call") return typeof data.callId === "string" ? data.callId : "";
	const message = data.message ?? {};
	if (typeof message.toolCallId === "string") return message.toolCallId;
	const source = message.source ?? {};
	return typeof source.callId === "string" ? source.callId : "";
}

/**
 * The turn an event belongs to.
 *
 * `assistant/message`, `tool/call` and `tool/result` carry their own `turn`;
 * `user/message` does not, so it inherits the latest `turn/start`. The chat
 * renders every row with `data-chat-turn`, which lets a hit be anchored to the
 * right turn even when its own text is folded away.
 * @param event - one stored event.
 * @param current - turn reached so far in this session.
 * @returns the turn number, or `current` when the event has none.
 */
export function turnOf(event, current) {
	const own = event?.data?.turn;
	if (typeof own === "number" && own > 0) return own;
	return current;
}

/**
 * Build a one-line excerpt around one match.
 * @param text - the normalised event text.
 * @param index - match offset in `text`.
 * @param length - matched length.
 * @returns excerpt with ellipses where text was cut.
 */
export function snippetOf(text, index, length) {
	const start = Math.max(0, index - 40);
	const end = Math.min(text.length, index + length + 120);
	const head = start > 0 ? "\u2026" : "";
	const tail = end < text.length ? "\u2026" : "";
	return head + text.slice(start, end) + tail;
}

/**
 * Forget every cached extraction (plugin unload).
 */
export function clearTextCache() {
	cache.clear();
	cachedChars = 0;
}

/** @returns a filesystem-safe fragment of a session id or revision. */
function safeName(value) {
	return String(value).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "_";
}

/** @returns the disk file for one session revision. */
function diskPathFor(id, revision) {
	return join(diskDir, safeName(id) + "." + safeName(revision) + ".json.gz");
}

/**
 * Read one extraction from disk.
 * @param id - session id.
 * @param revision - log revision the entry was built from.
 * @returns the cached entry, or null when absent or unusable.
 */
async function readDisk(id, revision) {
	if (diskDir === "") return null;
	try {
		const raw = await fsp.readFile(diskPathFor(id, revision));
		const parsed = JSON.parse((await gunzipAsync(raw)).toString("utf8"));
		if (parsed === null || typeof parsed !== "object") return null;
		if (parsed.revision !== revision || Array.isArray(parsed.parts) !== true) return null;
		return {
			revision,
			parts: parsed.parts,
			chars: typeof parsed.chars === "number" ? parsed.chars : 0,
			partial: parsed.partial === true
		};
	}
	catch (error) {
		void error;
		return null;
	}
}

/**
 * Write one extraction to disk, pruning old files.
 *
 * Best effort and off the request path: a failed write only means the next
 * search reads the log again.
 * @param id - session id.
 * @param revision - log revision the entry was built from.
 * @param entry - the extraction.
 */
async function writeDisk(id, revision, entry) {
	if (diskDir === "" || entry.chars > DISK_ENTRY_CHARS) return;
	try {
		if (diskReady !== true) {
			await fsp.mkdir(diskDir, { recursive: true });
			diskReady = true;
		}
		const payload = JSON.stringify({ revision, chars: entry.chars, partial: entry.partial, parts: entry.parts });
		await fsp.writeFile(diskPathFor(id, revision), await gzipAsync(Buffer.from(payload, "utf8")));
		const names = await fsp.readdir(diskDir);
		if (names.length <= DISK_FILE_LIMIT) return;
		const stats = [];
		for (const name of names) {
			try {
				const info = await fsp.stat(join(diskDir, name));
				stats.push({ name, at: info.mtimeMs });
			}
			catch (error) {
				void error;
			}
		}
		stats.sort((left, right) => left.at - right.at);
		for (const stale of stats.slice(0, stats.length - DISK_FILE_LIMIT)) {
			try {
				await fsp.unlink(join(diskDir, stale.name));
			}
			catch (error) {
				void error;
			}
		}
	}
	catch (error) {
		void error;
	}
}

/**
 * Remember one extraction, evicting the oldest entries past the budget.
 * @param id - session id.
 * @param entry - cached entry.
 */
function remember(id, entry) {
	const previous = cache.get(id);
	if (previous !== undefined) {
		cachedChars -= previous.chars;
		cache.delete(id);
	}
	if (entry.chars > CACHE_CHAR_LIMIT / 4) return;
	cache.set(id, entry);
	cachedChars += entry.chars;
	while (cachedChars > CACHE_CHAR_LIMIT) {
		const oldest = cache.keys().next();
		if (oldest.done === true) break;
		const dropped = cache.get(oldest.value);
		cache.delete(oldest.value);
		if (dropped !== undefined) cachedChars -= dropped.chars;
	}
}

/**
 * Tell whether one session's parts are still in memory at this revision.
 *
 * The warm-up pass uses this to skip work it already did; a disk copy is not
 * counted, because reading it back is the cheap part.
 * @param snapshot - one `list()` snapshot.
 * @returns true when the in-memory cache already holds this revision.
 */
export function isCached(snapshot) {
	const cached = cache.get(snapshot.header.id);
	return cached !== undefined && cached.revision === String(snapshot.revision ?? "");
}

/**
 * Read one session's visible content, reusing the cache while its revision matches.
 * @param persistence - the `sessionPersistence` service.
 * @param snapshot - one `list()` snapshot (`{ header, revision }`).
 * @returns the extracted parts.
 */
export async function textsOf(persistence, snapshot) {
	const id = snapshot.header.id;
	const revision = String(snapshot.revision ?? "");
	const cached = cache.get(id);
	if (cached !== undefined && cached.revision === revision) return cached;
	const stored = await readDisk(id, revision);
	if (stored !== null) {
		remember(id, stored);
		return stored;
	}
	const handle = await persistence.open(id, "read");
	try {
		const read = await handle.read();
		const events = Array.isArray(read?.events) ? read.events : [];
		const parts = [];
		let chars = 0;
		let partial = false;
		let turn = 0;
		for (const event of events) {
			if (chars >= MAX_SESSION_CHARS) {
				partial = true;
				break;
			}
			const type = typeof event?.type === "string" ? event.type : "";
			if (type === "turn/start") {
				turn = turnOf(event, turn);
				continue;
			}
			if (!CONTENT_TYPES.has(type)) continue;
			const raw = eventText(event);
			if (raw === "") continue;
			const text = normalizeText(stripInjected(raw)).slice(0, MAX_FIELD_CHARS);
			if (text === "") continue;
			const seq = typeof event?.seq === "number" ? event.seq : -1;
			const time = typeof event?.time === "number" ? event.time : 0;
			const callId = callIdOf(event);
			// Chinese logs have no case at all, so `toLowerCase()` usually returns the
			// same text: keep one string instead of two copies of every byte.
			const folded = text.toLowerCase();
			parts.push({
				seq,
				role: roleOf(type),
				time,
				text,
				lower: folded === text ? text : folded,
				callId,
				turn: turnOf(event, turn)
			});
			chars += text.length;
		}
		const entry = { revision, parts, chars, partial };
		remember(id, entry);
		void writeDisk(id, revision, entry);
		return entry;
	}
	finally {
		try {
			await handle.close();
		}
		catch (error) {
			void error;
		}
	}
}