# dsh-session-finder v0.7.0 (2026-10-30)

[English](README.en.md) · [中文](README.md)

Full-text search across every DSH chat session, then **jump to the message that matched**.

DSH's own search opens the session but does not scroll to the hit: its response only carries `{ sessionId, snippet }`, with no event coordinates. This plugin supplies the missing hop — open the session, bring the matching event into the loaded window, then anchor, scroll and outline it.

It brings its own search route instead of calling the host's `sessions.search`, because some deployments configure the session index with `openAt: "never"` and that RPC always answers `SESSION_QUERY_SEARCH_DISABLED`. The host half reads session logs directly through `ctx.sessionPersistence`.

![Search overlay: one hit with the matched phrase highlighted, a scope selector and prev/next controls](docs/screenshot-results.png)

![After clicking a hit: the message is outlined, the sidebar row is marked, the panel collapses to paging controls](docs/screenshot-located.png)

Both screenshots come from the fixture harness (`test/fixture.html`) with fake sessions — not from a real conversation. The Chinese README keeps the per-version screenshots under `docs/`.

## Install

```powershell
# from npm
dsh plugin add dsh-session-finder

# or straight from GitHub
dsh plugin add github:Aizai9527/dsh-session-finder
```

Restart the desktop app afterwards: both the host half and the client bundle load at startup. There is no build step — `lib/*.js` is the shipped artifact. The plugin is listed in the DSH plugin market (awesome-dsh-plugin index).

## Usage

1. Press `Ctrl+Shift+F` (`Cmd+Shift+F` on macOS) or click the "Search chats" pill in the bottom-right corner. The pill can be dragged anywhere and remembers its place (`localStorage` key `dsh-session-finder:trigger`).
2. Type at least two characters. **Separate several keywords with spaces — all of them must appear**; an exact phrase ranks first inside its session.
3. The **scope** selector at the bottom decides what gets scanned: **current session** (default; picked up from the selected row in the sidebar or the last session you jumped to), **all sessions**, or one **project**. Changing it re-runs the current query immediately.
4. Results are listed per matching message, with role, time and a snippet. At most three hits per session; user messages rank above assistant replies, and both above tool calls/results.
5. `↑` `↓` to move, `Enter` to open and locate. `Esc` first collapses the history list, a second `Esc` closes the overlay.
6. **After a jump the search box stays open and stays out of the way**: the panel collapses its result list, leaving the input, the status line and "Previous / Next"; the backdrop turns transparent so clicks pass through. Use **↑ Previous** / **↓ Next**, `F3` / `Shift+F3` or `Alt+↓` / `Alt+↑` to continue; the last hit on a page loads the next page of older sessions automatically.
7. **The panel is draggable**: hold the title bar (inputs, buttons and selects excepted), drop it anywhere, it is remembered (`dsh-session-finder:panel`). Dragging never triggers a search or closes the overlay.
8. **The whole session is searched, not just its tail**: up to 8M characters per session (it used to be 400k, so early content of long sessions was never indexed). Sessions longer than that are reported as "N oversized sessions were scanned only up to the cut".
9. **One query keeps paging until it finds something**: if the current page has no hit it reads one page of older sessions (max 4 pages / 20 seconds) and stops at the first hit. Only when everything was read does it say "no match"; the footer button then reads "Search older sessions" instead of pretending the scan is complete.
10. Collapsed, the top-right button reads **Show list**; editing the keyword while collapsed expands the list and searches again.
11. The target message is expanded, centred and outlined, and **the outline stays until the next jump or until you close the overlay**. If it would land behind the panel, the panel collapses and scrolls once more; when the conversation cannot scroll further, the panel docks to the bottom.
12. **Tool hits land on the tool row itself**: chat renders a tool call as one summary line, so the plugin matches the event's `callId` against `data-chat-call-id` on the row instead of guessing from command text. Rows already claimed by this query are not reused, so several results with identical text still land in different places.
13. **Search history**: with an empty input the last ten executed queries are listed (newest first, de-duplicated). Click one to search again, `↑` `↓` to walk the list, `Enter` to take it, `Esc` to collapse; "Clear history" at the bottom of the list removes them all. Only the query strings are stored.
14. The matched words get their own inner outline and tint, so you can see exactly which sentence matched.
15. The row of the session you just jumped to is marked in the left sidebar: inset outline (`box-shadow: inset`, so it cannot be clipped by the list's `overflow`) plus a deeper background, scrolled into view; a session folded inside a group is expanded once first; the mark is cleared when you switch sessions or close the overlay.

## How it works

- **Three-level anchors, precise to loose.** ① A tool hit goes to `[data-chat-call-id]` exactly. ② Any other hit first goes to its turn via `data-chat-turn` (folded tool output never becomes visible text, but the turn row is on screen), then the matching words are found inside that turn. ③ Only when neither is available does it fall back to matching the snippet text.
- **Jumping uses the chat view's own loader.** When the hit is not rendered yet, the plugin takes `ctx.sessions.binding(sessionId).session` after opening the session and calls the public `loadThrough(seq)` — the app's own "jump loader" that pages backwards until the event window covers that seq — retrying until `baseSeq <= seq`, then locating the text. Without a binding it falls back to "scroll to top and try again", and says so instead of failing silently.
- **Matching by snippet text.** The snippet is matched against rendered text nodes; when markdown splits it across elements the comparison ignores whitespace and punctuation, and short snippets (two CJK characters or more) are kept as a fallback.

## Limits and side effects

- **Read-only sessions, writes only its own cache.** Sessions are opened with a `read` handle; nothing is written to them. Extracted text is cached in the host process (64M characters) and mirrored to `~/.dsh/cache/dsh-session-finder` (gzipped JSON, at most 240 files, oldest pruned by mtime), so a wide search after a restart does not re-read 70M characters. Set `DSH_SESSION_FINDER_NO_DISK=1` to disable the disk cache.
- **Only visible text is indexed.** `user/message` and `assistant/message` contribute their `type: "text"` blocks; `reasoning` blocks and streaming `stream.chunks` are skipped — they never appear on screen, so a hit there could not be located. `system/message` and `developer/message` are not indexed at all: they are identical across sessions, so any common word would match everything.
- **Injected reminders are stripped.** The `<system-reminder>` block appended to user messages is removed before indexing.
- **Bounded work.** A search scans the newest 150 sessions, at most 3 hits per session and 40 in total, within 2.5 seconds, reading 6 sessions concurrently. When a limit is hit the status line says so and `nextOffset` continues after the last consumed session, so no session is skipped.
- **History stores query strings only.** `dsh-session-finder:history` holds at most ten queries — no session ids, no hit text, no timestamps. Entries are rendered with `textContent`, so angle brackets in a query cannot become HTML.
- **The overlay background comes from the page, not from theme tokens**: it accepts only an opaque, neutral background from `body` and falls back to a neutral dark/light colour when the page is tinted (for example a warm brand colour), so the panel never inherits the tint.

## Layout

| Path | Role |
| --- | --- |
| `lib/index.js` | Host half: read-only route `GET /session-finder/search?q=<query>&offset=<n>[&sessionId=…\|&cwd=…]`, log reading, scope filtering, scoring, paging, disk-cache warm-up |
| `lib/search.js` | Host half, pure functions: visible-text extraction per event type, reminder stripping, snippet slicing, revision-keyed memory + disk cache (`useDiskCache()`) |
| `lib/client.js` | Browser half: the draggable overlay, scope selector, search history, result list, "load older", `loadThrough` jumping and outlining |
| `test/*.test.mjs` | Node checks: snippet logic, host extraction/scoring/paging, route end-to-end, and static guards for every client behaviour fixed since v0.4.0 |
| `test/fixture.html` | Manual regression page for the browser half: fake chat DOM (split text, `hidden="until-found"` blocks, duplicate rows, tool rows with `data-chat-call-id`, a fake `loadThrough()`, a fake sidebar) — open it in a browser |
| `cordis.patch.yml` | Bundle patch that inserts the `session-finder` row |
| `relink.ps1` | Restores the local link mount if a plugin-market update drops it |

## Self-check

```powershell
npm run check   # node --check on the three entry points
npm test        # 96 checks: snippets, host half, route, client guards
```

Open `test/fixture.html` in a browser for the visual regression: pill placement and dragging, backdrop colour and opacity slider, search and jump, scope switching, deep-history hits that only exist after `loadThrough`, tool rows anchored by `callId`, folded output anchored by turn, duplicate-text rows, and the sidebar mark.

## Version history

- **v0.7.0** — speed. Disk-backed extraction cache plus idle warm-up: first wide search after a restart 10.2s → 1.7s, repeat 0.29s; a query now scans 150 sessions within 2.5s with 6 concurrent readers; the client starts `loadThrough` on click, skips the collapsed-state avoidance waits, waits with a `MutationObserver` instead of polling, and prefetches the history of the row under the pointer.
- **v0.6.1** — "the session opened but this part is not rendered yet". `loadThrough` was called once, before the session controller reached `openState === "open"`, and then never again; it now retries (up to 10 rounds, verified against `baseSeq`), stops as soon as the jump lands, and adds a turn anchor (`data-chat-turn`) for folded content.
- **v0.6.0** — search history with clear-all, keyboard navigation, and `Esc` that collapses the list before closing the overlay.
- **v0.5.1** — several results all landing on the same highlight: tool hits are now anchored by `callId` and rows already claimed by a query are not reused.
- **v0.5.0** — jump via `ISession.loadThrough(seq)`, search scope (current session / all / one project), draggable panel.
- **v0.4.x** — panel no longer closes or covers content after a jump, sidebar row marking, highlight that persists, paging that does not lie about coverage, 8M characters per session.
- **v0.3.x** — index only visible text, multi-keyword AND search, pagination, opaque panel with adjustable opacity, draggable trigger pill.
- **v0.2.0 / v0.1.0** — own host route (bypasses `openAt: "never"`), per-message results, first end-to-end jump.

## License

MIT — see [LICENSE](LICENSE).
