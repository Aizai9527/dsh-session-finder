/**
 * dsh-session-finder — browser half.
 *
 * The shipped sidebar search already looks inside message content across every
 * session, but a hit is only a summary: clicking it opens the session and stops
 * there, because the search wire (`{ sessionId, snippet }`) carries no event
 * coordinate to jump to. This half adds the missing last hop.
 *
 * Flow: a search overlay asks this plugin's own host route
 * (`session-finder/search?q=…`, answered by `lib/index.js` from the persistence
 * seam), then for the chosen hit it opens the session through
 * `ctx.uiWorkspace.openSession(id)` and finds the message whose rendered text
 * still contains the snippet. Chat nodes carry `data-chat-turn` /
 * `data-chat-node-key` / `data-chat-call-id`, and folded ancestors listen for a
 * `beforematch` event, so the match is unfolded, scrolled into the middle of
 * the viewport and outlined for a moment.
 *
 * v0.2.0 — the shipped `sessions.search` RPC is NOT used: a deployment may
 * mount the session-query index with `openAt: "never"`, which rejects every
 * search with `SESSION_QUERY_SEARCH_DISABLED`. The host route reads the same
 * stored logs through `ctx.sessionPersistence` and needs no index.
 * Read-only: nothing is written to session files. A hit whose message has not
 * been rendered yet (long history) is reached by asking the conversation view
 * to load earlier pages.
 */

window.__ModuleLoader__.load({
	id: "dsh-session-finder",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/** Root id of everything this half owns in the document. */
		const ROOT_ID = "dsh-session-finder";
		/** Attribute set on the element that is currently highlighted. */
		const HIT_ATTRIBUTE = "data-session-finder-hit";
		/** Attribute marking a rendered row, keyed by its session id. */
		const ROW_ATTRIBUTE = "data-session-finder-row";
		/** Attribute set on the exact text run that matched. */
		const EXACT_ATTRIBUTE = HIT_ATTRIBUTE + "-exact";
		/** Attribute set on the sidebar row of the session being shown. */
		const TARGET_ATTRIBUTE = "data-session-finder-target";
		/** Attribute the chat puts on every tool row, keyed by its tool call id. */
		const CALL_ATTRIBUTE = "data-chat-call-id";
		/** Attribute the chat puts on every turn row, keyed by the turn number. */
		const TURN_ATTRIBUTE = "data-chat-turn";
		/** Minimum query length worth sending to the host index. */
		const MIN_QUERY_LENGTH = 2;
		/** Wait between two attempts to find the snippet in the rendered chat. */
		const POLL_MS = 120;
		/** Attempts before the first "load earlier history" nudge. */
		const ATTEMPTS_BEFORE_SCROLL = 24;
		/** Total attempts before reporting that the message was not rendered. */
		const POLL_ATTEMPTS = 150;
		/** Times `loadThrough(seq)` is re-asked before giving up on coverage. */
		const REACH_ROUNDS = 10;
		/** Poll ticks between two `loadThrough()` rounds (the first call on a
		 * closing/closing session is a no-op, so this must be retried). */
		const REACH_EVERY = 6;
		/** Debounce for typing in the search box. */
		const DEBOUNCE_MS = 220;
		/** Session pages read in one query while older history is still unsearched. */
		const MAX_AUTO_PAGES = 4;
		/** Wall-clock ceiling for one auto-paged query before it hands back to the reader. */
		const AUTO_SEARCH_BUDGET_MS = 20000;
		/** Pointer dwell before a row warms its history: sweeping across the list
		 * must not queue a page per row the pointer happens to cross. */
		const PREFETCH_DELAY_MS = 400;
		/** Plugin page: the header links point here. */
		const REPO_URL = "https://github.com/Aizai9527/dsh-session-finder";
		/** New-issue page behind the "问题反馈" button. */
		const ISSUES_URL = REPO_URL + "/issues/new";
		/** Published manifest: the only place a newer version can show up. */
		const LATEST_URL = "https://raw.githubusercontent.com/Aizai9527/dsh-session-finder/main/package.json";
		/** Version printed in the header; the guard test keeps it equal to package.json. */
		const VERSION = "0.7.2";
		/** Give up on the update check after this long. */
		const UPDATE_TIMEOUT_MS = 8000;

		/** Inline 16px glyphs for the three header buttons. */
		const ICONS = {
			github: "<svg viewBox=\"0 0 16 16\" aria-hidden=\"true\"><path fill=\"currentColor\" d=\"M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z\"/></svg>",
			issue: "<svg viewBox=\"0 0 16 16\" aria-hidden=\"true\"><path fill=\"currentColor\" d=\"M3.2 2.6h9.6a1.6 1.6 0 0 1 1.6 1.6v5.4a1.6 1.6 0 0 1-1.6 1.6H7.4l-3 2.3v-2.3H3.2a1.6 1.6 0 0 1-1.6-1.6V4.2a1.6 1.6 0 0 1 1.6-1.6z\"/></svg>",
			refresh: "<svg viewBox=\"0 0 16 16\" aria-hidden=\"true\"><path fill=\"currentColor\" d=\"M8 2.2a5.8 5.8 0 1 0 5.5 7.6h-1.7A4.1 4.1 0 1 1 8 3.9c1.1 0 2.1.4 2.8 1.1L9 6.8h4.9V2.1l-1.7 1.7A5.8 5.8 0 0 0 8 2.2z\"/></svg>"
		};

		/** Plugin-local copy: this overlay owns its own strings. */
		const TEXT = {
			open: "搜索聊天记录",
			title: "搜索聊天记录",
			close: "关闭",
			placeholder: "搜索所有会话里的消息内容，空格分隔多个关键词，回车定位（Ctrl+Shift+F）",
			hint: "↑↓ 选择，回车定位；F3 / Shift+F3 到下一处 / 上一处；Esc 关闭",
			empty: "没有命中：换个更短的关键词再试",
			noHitOlder: "没有命中：本页没有，下面还有更早的会话可以继续搜",
			tooShort: "至少输入 " + String(MIN_QUERY_LENGTH) + " 个字符",
			searching: "正在搜索…",
			loadingMore: "正在加载更早的会话…",
			failed: "搜索没有成功",
			unavailable: "这个安装没有挂载会话存储服务",
			routeMissing: "搜索服务没有响应（插件宿主半未加载，重启 DSH 后重试）",
			count: (value) => "命中 " + String(value) + " 条消息",
			scope: (scanned, total) => " · 扫描 " + String(scanned) + "/" + String(total) + " 个会话",
			truncated: "（已到单次上限）",
			took: (seconds) => " · 用时 " + seconds.toFixed(2) + " s",
			partial: (value) => " · 另有 " + String(value) + " 个超长会话只扫描了前段",
			more: "加载更早的会话",
			moreOlder: "继续搜索更早的会话",
			jumping: "正在打开会话并定位…",
			jumpingDeep: "正在跳到对应位置（可能要先加载更早的历史）…",
			locatingLong: "仍在定位：正在向上加载更早的消息…",
			found: "已定位到命中位置",
			revealRound: (round, total) => "正在自动加载更早的历史（第 " + String(round) + "/" + String(total) + " 轮）…",
			notRendered: "已自动加载到该位置附近，但这段内容仍未渲染：可在左侧确认该会话已打开后再点一次",
			noWorkspace: "无法自动切换会话，请在左侧点开命中的会话",
			sidebarMiss: "已切到会话，但左侧列表没找到对应会话行（可能折叠在分组里）",
			noopened: "打开会话失败",
			toolsGithub: "GitHub",
			toolsIssues: "问题反馈",
			toolsCheck: "检查更新",
			checking: "正在检查更新…",
			updateLatest: (version) => "已是最新版本 " + version,
			updateFound: (latest, current) => "发现新版本 " + latest + "（当前 " + current + "）：运行 dsh plugin add dsh-session-finder 更新",
			updateFailed: "检查更新失败：无法访问 GitHub",
			navPrev: "↑ 上一处",
			navNext: "↓ 下一处",
			collapseList: "收起列表",
			expandList: "展开列表",
			located: (index, total) => "已定位第 " + String(index) + "/" + String(total) + " 处 · 可继续点上一处 / 下一处",
			alpha: "面板不透明度（100% 完全不透明）",
			alphaShort: "不透明度",
			alphaValue: (value) => String(value) + "%",
			scopeLabel: "搜索范围",
			scopeAll: "全部会话",
			scopeCurrent: "当前会话",
			scopeProject: (name) => "项目：" + name,
			scopeNoCurrent: "还没识别出当前会话，这次按全部会话搜索",
			historyLabel: "搜索历史",
			historyClear: "清空历史",
			historyEmpty: "还没有搜索历史"
		};

		/** Chinese labels for the role that produced a hit. */
		const ROLE_LABELS = { user: "你", assistant: "助手", tool: "工具" };

		/** Inline magnifier glyph for the trigger; static markup, no user data. */
		const ICON = "<svg viewBox=\"0 0 16 16\" width=\"14\" height=\"14\" aria-hidden=\"true\" focusable=\"false\"><path fill=\"currentColor\" d=\"M7 1.5a5.5 5.5 0 1 0 3.4 9.83l3.13 3.14a.75.75 0 1 0 1.06-1.06l-3.13-3.14A5.5 5.5 0 0 0 7 1.5Zm0 1.5a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z\"/></svg>";

		/** Panel opacity bounds; 100% keeps the conversation fully hidden behind it. */
		const OPACITY_MIN = 45;
		const OPACITY_MAX = 100;
		const OPACITY_DEFAULT = 100;
		/** Where the dragged panel position is remembered. */
		const PANEL_KEY = "dsh-session-finder:panel";
		/** Where successful queries are remembered; only the strings, no session data. */
		const HISTORY_KEY = "dsh-session-finder:history";
		/** How many past queries the list keeps. */
		const HISTORY_LIMIT = 10;
		/** Pointer travel below this is a click, not a drag. */
		const DRAG_THRESHOLD = 4;

		/** Overlay state; one instance per page, recreated after a plugin reload. */
		const state = {
			ctx: null,
			visible: false,
			query: "",
			items: [],
			active: -1,
			collapsed: false,
			hasOlder: false,
			nextOffset: 0,
			baseColor: "#1b1d23",
			opacity: OPACITY_DEFAULT,
			/** One of "all", "session", "project". */
			scope: "all",
			scopeSessionId: null,
			scopeCwd: null,
			/** Last session this overlay opened; a hint for the "current session" scope. */
			lastOpened: null,
			/** True once the reader picked a scope, so re-opening keeps their choice. */
			scopeTouched: false,
			/** Rows this query already jumped to, so several hits never share one anchor. */
			claims: new Set(),
			/** Bumped on every jump; a poll loop from an older jump stops instead of marking late. */
			jumpId: 0,
			/** `session:seq` pairs this query already warmed while the pointer rested on them. */
			prefetched: new Set(),
			/** Remembered queries, newest first; mirrored into localStorage. */
			history: [],
			/** True after Escape dismissed the history list, until the reader types again. */
			historyHidden: false,
			pending: null,
			timer: null,
			toastTimer: null,
			nodes: null
		};

		/**
		 * What is currently highlighted: the message block, the exact text run,
		 * and the sidebar row of the session being shown. Kept until the next
		 * jump or until the overlay closes, so the user still sees the hit after
		 * walking away from the search box.
		 */
		const marks = {
			block: null,
			exact: null,
			row: null,
			rows: [],
			session: null
		};

		/** CSS injected once; colours come from the app's real alias tokens. */
		const CSS = `
			#${ROOT_ID}-trigger{position:fixed;z-index:2147483000;display:flex;align-items:center;gap:6px;height:32px;max-width:calc(100vw - 24px);padding:0 12px;border-radius:16px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));background:var(--dsw-alias-bg-module-platform,#f4f5f7);color:var(--dsw-alias-label-secondary,var(--sf-fg-2,#5c6370));font-size:12px;line-height:16px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.14);font-family:inherit;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;touch-action:none;user-select:none}
			#${ROOT_ID}-trigger:hover{color:var(--dsw-alias-label-primary,var(--sf-fg,#1a1c22));background:var(--dsw-alias-interactive-bg-hover,var(--sf-hover,rgba(127,127,127,.14)))}
			#${ROOT_ID}-trigger[data-dragging="true"]{cursor:grabbing;opacity:.85}
			#${ROOT_ID}-trigger svg{flex:none;width:14px;height:14px;pointer-events:none}
			#${ROOT_ID}{position:fixed;inset:0;z-index:2147483100;display:none;background:rgba(0,0,0,.45)}
			#${ROOT_ID}[data-open="true"]{display:block}
			#${ROOT_ID} .sf-panel{position:absolute;top:12vh;left:50%;transform:translateX(-50%);width:min(720px,calc(100vw - 32px));max-height:72vh;display:flex;flex-direction:column;border-radius:12px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));background-color:var(--sf-solid-bg,#1b1d23);color:var(--dsw-alias-label-primary,var(--sf-fg,#f2f3f5));box-shadow:0 18px 48px rgba(0,0,0,.45);overflow:hidden;font-family:inherit}
			#${ROOT_ID} .sf-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));cursor:grab;touch-action:none}
			#${ROOT_ID} .sf-tools{display:flex;align-items:center;flex-wrap:wrap;gap:6px;padding:6px 14px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));background-color:var(--dsw-alias-bg-l2,rgba(127,127,127,.05))}
			#${ROOT_ID} .sf-tool{display:inline-flex;align-items:center;gap:5px;box-sizing:border-box;height:24px;padding:0 9px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));background-color:transparent;color:var(--dsw-alias-label-secondary,var(--sf-fg-2,#c8ccd4));font-size:11px;line-height:1;text-decoration:none;cursor:pointer;font-family:inherit;white-space:nowrap}
			#${ROOT_ID} .sf-tool:hover{background-color:var(--dsw-alias-interactive-bg-hover,var(--sf-hover,rgba(127,127,127,.14)));color:var(--dsw-alias-label-primary,var(--sf-fg,#f2f3f5))}
			#${ROOT_ID} .sf-tool[aria-busy="true"],#${ROOT_ID} .sf-tool:disabled{opacity:.55;cursor:progress}
			#${ROOT_ID} .sf-tool svg{flex:none;width:12px;height:12px}
			#${ROOT_ID} .sf-ver{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-tertiary,var(--sf-fg-3,#8a909c))}
			#${ROOT_ID} .sf-head[data-dragging="true"]{cursor:grabbing}
			#${ROOT_ID} .sf-head .sf-input,#${ROOT_ID} .sf-head .sf-toggle,#${ROOT_ID} .sf-head .sf-close{cursor:auto}
			#${ROOT_ID} .sf-head .sf-toggle,#${ROOT_ID} .sf-head .sf-close{cursor:pointer}
			#${ROOT_ID} .sf-close{flex:none;display:grid;place-items:center;width:26px;height:26px;padding:0;border-radius:6px;border:none;background:transparent;color:var(--dsw-alias-label-tertiary,var(--sf-fg-3,#8a909c));font-size:16px;line-height:1;cursor:pointer;font-family:inherit}
			#${ROOT_ID} .sf-close:hover{background:var(--dsw-alias-interactive-bg-hover,var(--sf-hover,rgba(127,127,127,.14)));color:var(--dsw-alias-label-primary,var(--sf-fg,#f2f3f5))}
			#${ROOT_ID} .sf-toggle{flex:none;height:26px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));background:transparent;color:var(--dsw-alias-label-tertiary,var(--sf-fg-3,#8a909c));font-size:11px;line-height:16px;cursor:pointer;font-family:inherit;white-space:nowrap}
			#${ROOT_ID} .sf-toggle:hover{background:var(--dsw-alias-interactive-bg-hover,var(--sf-hover,rgba(127,127,127,.14)));color:var(--dsw-alias-label-primary,var(--sf-fg,#1a1c22))}
			#${ROOT_ID} .sf-panel[data-collapsed="true"]{top:8vh;max-height:none}
			#${ROOT_ID} .sf-panel[data-docked="bottom"]{top:auto;bottom:96px}
			#${ROOT_ID} .sf-panel[data-collapsed="true"] .sf-list{display:none}
			#${ROOT_ID} .sf-panel[data-collapsed="true"] .sf-foot{display:none}
			#${ROOT_ID} .sf-input{flex:1;min-width:0;height:32px;border:none;outline:none;background:transparent;color:var(--dsw-alias-label-primary,var(--sf-fg,#1a1c22));font-size:14px;line-height:22px;font-family:inherit}
			#${ROOT_ID} .sf-input::placeholder{color:var(--dsw-alias-label-tertiary,var(--sf-fg-3,#8a909c))}
			#${ROOT_ID} .sf-status{padding:8px 14px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,var(--sf-fg-3,#8a909c));border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18))}
			#${ROOT_ID} .sf-status[data-tone="error"]{color:var(--dsw-alias-state-error-primary,#d92d20)}
			#${ROOT_ID} .sf-history{display:none;flex-direction:column;gap:2px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));max-height:232px;overflow:auto}
			#${ROOT_ID} .sf-history[data-open="true"]{display:flex}
			#${ROOT_ID} .sf-history-item{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,var(--sf-fg,#1a1c22));font-size:13px;line-height:18px;text-align:left;cursor:pointer;font-family:inherit}
			#${ROOT_ID} .sf-history-item:hover{background:var(--dsw-alias-interactive-bg-hover,var(--sf-hover,rgba(127,127,127,.14)))}
			#${ROOT_ID} .sf-history-item span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
			#${ROOT_ID} .sf-history-item i{flex:none;font-style:normal;font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption,var(--sf-fg-3,#98a0ac))}
			#${ROOT_ID} .sf-history-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:2px 8px 0}
			#${ROOT_ID} .sf-history-foot small{font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption,var(--sf-fg-3,#98a0ac))}
			#${ROOT_ID} .sf-history-clear{flex:none;height:22px;padding:0 8px;border-radius:5px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));background:transparent;color:var(--dsw-alias-label-secondary,var(--sf-fg-2,#5c6370));font-size:11px;line-height:16px;cursor:pointer;font-family:inherit}
			#${ROOT_ID} .sf-history-clear:hover{background:var(--dsw-alias-interactive-bg-hover,var(--sf-hover,rgba(127,127,127,.14)));color:var(--dsw-alias-label-primary,var(--sf-fg,#1a1c22))}
			#${ROOT_ID} .sf-nav{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18))}
			#${ROOT_ID} .sf-nav-btn{flex:none;display:inline-flex;align-items:center;justify-content:center;height:26px;padding:0 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));background:transparent;color:var(--dsw-alias-label-secondary,var(--sf-fg-2,#5c6370));font-size:12px;line-height:16px;cursor:pointer;font-family:inherit;white-space:nowrap}
			#${ROOT_ID} .sf-nav-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--sf-hover,rgba(127,127,127,.14)));color:var(--dsw-alias-label-primary,var(--sf-fg,#1a1c22))}
			#${ROOT_ID} .sf-nav-btn:disabled{opacity:.45;cursor:default}
			#${ROOT_ID} .sf-nav-count{flex:1;min-width:0;text-align:center;font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption,var(--sf-fg-3,#98a0ac));font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
			#${ROOT_ID}[data-navigating="true"]{background:transparent;pointer-events:none}
			#${ROOT_ID}[data-navigating="true"] .sf-panel{pointer-events:auto}
			#${ROOT_ID} .sf-list{flex:1;min-height:0;overflow:auto;padding:6px}
			#${ROOT_ID} .sf-row{display:block;width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:none;background:transparent;text-align:left;color:var(--dsw-alias-label-primary,var(--sf-fg,#1a1c22));cursor:pointer;font-family:inherit}
			#${ROOT_ID} .sf-row:hover{background:var(--dsw-alias-interactive-bg-hover,var(--sf-hover,rgba(127,127,127,.14)))}
			#${ROOT_ID} .sf-row[data-active="true"]{background:var(--dsw-alias-interactive-bg-hover-solid,rgba(127,127,127,.2));box-shadow:inset 2px 0 0 var(--dsw-alias-state-business-primary,#4c7dff)}
			#${ROOT_ID} .sf-title{font-size:13px;line-height:19px;font-weight:600;color:var(--dsw-alias-label-primary,var(--sf-fg,#1a1c22));overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
			#${ROOT_ID} .sf-snippet{margin-top:3px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,var(--sf-fg-2,#5c6370));display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
			#${ROOT_ID} .sf-snippet mark{background:var(--dsw-alias-state-business-primary,#4c7dff);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4c7dff) 26%,transparent);color:var(--dsw-alias-label-primary,var(--sf-fg,#1a1c22));border-radius:3px;padding:0 1px}
			#${ROOT_ID} .sf-meta{margin-top:4px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption,var(--sf-fg-3,#98a0ac))}
			#${ROOT_ID} .sf-more{display:block;width:calc(100% - 8px);margin:4px;padding:8px 10px;border-radius:8px;border:1px dashed var(--dsw-alias-border-l2,rgba(127,127,127,.28));background:transparent;color:var(--dsw-alias-label-secondary,var(--sf-fg-2,#5c6370));font-size:12px;line-height:18px;cursor:pointer;font-family:inherit;text-align:center}
			#${ROOT_ID} .sf-more:hover{background:var(--dsw-alias-interactive-bg-hover,var(--sf-hover,rgba(127,127,127,.14)));color:var(--dsw-alias-label-primary,var(--sf-fg,#1a1c22))}
			#${ROOT_ID} .sf-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 14px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-caption,var(--sf-fg-3,#98a0ac));border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18))}
			#${ROOT_ID} .sf-foot-hint{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
			#${ROOT_ID} .sf-scope{flex:none;max-width:40%;height:24px;padding:0 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));background:var(--sf-solid-bg,transparent);color:var(--dsw-alias-label-secondary,var(--sf-fg-2,#5c6370));font-size:11px;line-height:16px;font-family:inherit;cursor:pointer}
			#${ROOT_ID} .sf-scope:hover{background:var(--dsw-alias-interactive-bg-hover,var(--sf-hover,rgba(127,127,127,.14)))}
			#${ROOT_ID} .sf-alpha{flex:none;display:flex;align-items:center;gap:6px;white-space:nowrap}
			#${ROOT_ID} .sf-alpha input{width:84px;height:14px;margin:0;cursor:pointer;accent-color:var(--dsw-alias-state-business-primary,#4c7dff)}
			#${ROOT_ID} .sf-alpha output{min-width:32px;text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary,var(--sf-fg-3,#8a909c))}
			#${ROOT_ID}-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483200;max-width:min(560px,calc(100vw - 40px));padding:9px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));background:var(--dsw-alias-bg-module-platform,#f4f5f7);color:var(--dsw-alias-label-primary,var(--sf-fg,#1a1c22));font-size:12px;line-height:18px;box-shadow:0 8px 24px rgba(0,0,0,.24);opacity:0;transition:opacity .18s ease;pointer-events:none;font-family:inherit}
			#${ROOT_ID}-toast[data-show="true"]{opacity:1}
			[${HIT_ATTRIBUTE}]{outline:2px solid var(--dsw-alias-state-business-primary,#4c7dff);outline-offset:4px;border-radius:8px;background:var(--dsw-alias-state-business-primary,#4c7dff);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4c7dff) 16%,transparent);transition:background .5s ease}
			[${EXACT_ATTRIBUTE}]{outline:2px solid var(--dsw-alias-state-business-primary,#4c7dff);outline-offset:2px;border-radius:4px;background:var(--dsw-alias-state-business-primary,#4c7dff);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4c7dff) 34%,transparent)}
			[${TARGET_ATTRIBUTE}]{box-shadow:inset 0 0 0 2px var(--dsw-alias-state-business-primary,#4c7dff);outline:2px solid var(--dsw-alias-state-business-primary,#4c7dff);outline-offset:1px;border-radius:8px;background:var(--dsw-alias-state-business-primary,#4c7dff);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4c7dff) 22%,transparent)}
		`;

		/** @returns the message from any thrown value. */
		function messageOf(error) {
			return error instanceof Error ? error.message : String(error);
		}

		/** @returns a promise that resolves after the given delay. */
		function sleep(ms) {
			return new Promise((resolve) => setTimeout(resolve, ms));
		}

		/**
		 * Wait for the chat column to change, or for `ms`, whichever comes first.
		 *
		 * A fixed sleep always pays the worst case; this pays nothing when the new
		 * turn or call row is already on screen.
		 * @param root - the main chat column.
		 * @param ms - upper bound in milliseconds.
		 * @returns a promise that resolves on the first change or the timeout.
		 */
		function waitForChange(root, ms) {
			return new Promise((resolve) => {
				let done = false;
				let timer = 0;
				let observer = null;
				const finish = () => {
					if (done) return;
					done = true;
					if (observer !== null) observer.disconnect();
					clearTimeout(timer);
					resolve();
				};
				observer = new MutationObserver(finish);
				observer.observe(root, {
					childList: true,
					subtree: true,
					attributes: true,
					attributeFilter: [TURN_ATTRIBUTE, CALL_ATTRIBUTE]
				});
				timer = setTimeout(finish, ms);
			});
		}

		/**
		 * Collapse whitespace so rendered text and snippets compare by words only.
		 * @param value - any text.
		 * @returns the normalized string.
		 */
		function normalizeText(value) {
			return String(value ?? "").replace(/\s+/gu, " ").trim();
		}

		/**
		 * Format a hit timestamp for the result row.
		 * @param time - epoch milliseconds, 0 when unknown.
		 * @returns `YYYY-MM-DD HH:mm`, or an empty string.
		 */
		function formatTime(time) {
			if (typeof time !== "number" || !(time > 0)) return "";
			const date = new Date(time);
			if (Number.isNaN(date.getTime())) return "";
			const pad = (value) => String(value).padStart(2, "0");
			return String(date.getFullYear()) + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
		}

		/**
		 * Split a query into unique highlight terms, longest first.
		 * @param query - what the user typed.
		 * @returns lowercased terms; empty for a blank query.
		 */
		function splitTerms(query) {
			const terms = normalizeText(query).toLowerCase().split(" ").filter((term) => term !== "");
			return [...new Set(terms)].sort((left, right) => right.length - left.length);
		}

		/**
		 * Turn a host snippet into the longest plain fragments worth searching for.
		 *
		 * A snippet is built by the host as `…before…after…` (the match is trimmed
		 * and the rest is elided with U+2026), so the fragments are the exact text
		 * that was matched. Ordered longest first, bounded in count, so a DOM walk
		 * stays cheap and the most distinctive fragment wins.
		 * @param snippet - the hit's snippet.
		 * @returns candidate needles, longest first; empty when nothing usable.
		 */
		function buildNeedles(snippet) {
			const fragments = String(snippet ?? "")
				.split(/\u2026|\.{3}/u)
				.map(normalizeText)
				.filter((fragment) => fragment.length > 0)
				.sort((left, right) => right.length - left.length);
			if (fragments.length === 0) return [];
			const longest = fragments[0];
			const needles = [];
			const push = (value) => {
				const needle = normalizeText(value);
				if (needle.length >= 8 && !needles.includes(needle)) needles.push(needle);
			};
			push(longest);
			push(longest.slice(0, 80));
			push(longest.slice(0, 48));
			if (longest.length > 96) {
				const middle = Math.floor(longest.length / 2);
				push(longest.slice(Math.max(0, middle - 24), middle + 24));
			}
			// Short messages (common in Chinese chat) fall below the 8-char floor;
			// fall back to the whole fragment so a two-character hit still locates.
			if (needles.length === 0 && longest.length >= 2) needles.push(longest);
			return needles;
		}

		/** @returns the app's main conversation flow column, never a nested sidebar chat. */
		function chatRoot() {
			const roots = [...document.querySelectorAll("[data-slot=\"main.conversation\"] [data-slot=\"conversation.view\"] [data-chat-flow]")];
			return roots.find((element) => element.isConnected && element.closest("[data-sidebar-right-session], [data-step-process-body]") === null);
		}

		/**
		 * Drop whitespace and punctuation so rendered markdown cannot hide a match.
		 *
		 * A host snippet is plain text, but the DOM splits it across inline elements
		 * (bold runs, links, code spans) and keeps list markers and quotes in between.
		 * Comparing the squeezed forms finds those matches without widening the needle.
		 * @param value - any text.
		 * @returns the text with whitespace and punctuation removed, lowercased.
		 */
		function compactText(value) {
			return String(value ?? "")
				.toLowerCase()
				.replace(/[\s\u3000-\u303f\uff00-\uffef\u2010-\u2027\u2030-\u203b!-\/:-@\[-`{-~]+/gu, "");
		}

		/**
		 * The chat row a small element belongs to.
		 *
		 * Folding and grouping mean the same sentence can appear in several rows;
		 * returning the row (not the inline element) lets callers dedupe by anchor.
		 * @param element - a node inside the chat column.
		 * @param root - the main chat column.
		 * @returns the owning row, or the element itself when nothing wraps it.
		 */
		function owningBlock(element, root) {
			const block = element.closest("[data-chat-turn], [data-chat-node-key], [" + CALL_ATTRIBUTE + "], [data-chat-group-key]");
			return block !== null && block !== root && root.contains(block) ? block : element;
		}

		/**
		 * The tool row the chat renders for one tool call id.
		 * @param root - the main chat column.
		 * @param callId - the hit's tool call id.
		 * @returns the row, or null when that call is not rendered yet.
		 */
		function callRowOf(root, callId) {
			if (typeof callId !== "string" || callId === "") return null;
			const rows = root.querySelectorAll("[" + CALL_ATTRIBUTE + "]");
			for (const row of rows) if (row.getAttribute(CALL_ATTRIBUTE) === callId) return row;
			return null;
		}

		/**
		 * The chat row the chat rendered for one turn number.
		 *
		 * A turn row is the widest anchor that survives folding: a tool result
		 * whose text never appears as a text node still has its turn painted, so
		 * landing on the turn is better than reporting "not rendered". The
		 * smallest painted row is used, because nested groups repeat the number.
		 * @param root - the main chat column.
		 * @param turn - 1-based turn number from the session log.
		 * @returns the row to reveal, or null when that turn is not on screen.
		 */
		function turnRowOf(root, turn) {
			if (typeof turn !== "number" || turn <= 0) return null;
			const wanted = String(turn);
			let best = null;
			let bestLength = Number.POSITIVE_INFINITY;
			let any = null;
			for (const row of root.querySelectorAll("[" + TURN_ATTRIBUTE + "]")) {
				if (row.getAttribute(TURN_ATTRIBUTE) !== wanted) continue;
				if (any === null) any = row;
				if (row.getClientRects().length === 0) continue;
				const length = normalizeText(row.textContent).length;
				if (length >= bestLength) continue;
				best = row;
				bestLength = length;
			}
			return best ?? any;
		}

		/**
		 * Find the rendered element whose text still contains one of the needles.
		 * Text nodes are tried first (precise), then message-shaped containers
		 * (a markdown match may be split across inline elements).
		 * @param root - the main chat column.
		 * @param needles - candidate fragments, longest first.
		 * @param claimed - rows already used by another hit of this query.
		 * @returns the element to reveal, or null when this page does not hold it.
		 */
		function findMatch(root, needles, claimed) {
			if (needles.length === 0) return null;
			const squeezed = needles
				.map(compactText)
				.filter((needle) => needle.length >= 2)
				.sort((left, right) => right.length - left.length);
			const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
			const usable = (element) => {
				const block = owningBlock(element, root);
				return claimed === undefined || !claimed.has(block) ? block : null;
			};
			let node = walker.nextNode();
			while (node !== null) {
				const text = normalizeText(node.nodeValue);
				if (text !== "") {
					const plain = needles.some((needle) => text.includes(needle));
					let compact = false;
					if (!plain && squeezed.length > 0) {
						const squeezedText = compactText(text);
						compact = squeezed.some((needle) => squeezedText.includes(needle));
					}
					if (plain || compact) {
						const candidate = usable(node.parentElement);
						if (candidate !== null) return candidate;
					}
				}
				node = walker.nextNode();
			}
			const blocks = [...root.querySelectorAll("[data-chat-turn], [data-chat-node-key], [" + CALL_ATTRIBUTE + "], [data-chat-group-key]")];
			let best = null;
			let bestLength = Number.POSITIVE_INFINITY;
			for (const block of blocks) {
				if (claimed !== undefined && claimed.has(block)) continue;
				const text = normalizeText(block.textContent);
				if (text.length === 0 || text.length >= bestLength) continue;
				const hit = needles.some((needle) => text.includes(needle))
					|| (squeezed.length > 0 && (() => {
						const compact = compactText(text);
						return squeezed.some((needle) => compact.includes(needle));
					})());
				if (!hit) continue;
				best = block;
				bestLength = text.length;
			}
			return best;
		}

		/**
		 * Unfold every hidden ancestor so the located element is actually painted.
		 * Chat folds listen for `beforematch`; dispatching innermost first yields
		 * the same order the browser's own find-in-page produces.
		 * @param element - the located element.
		 * @param root - the main chat column.
		 * @returns how many folded ancestors were asked to open.
		 */
		function revealAncestors(element, root) {
			const folded = [];
			for (let current = element; current !== null && current !== root.parentElement; current = current.parentElement) {
				if (current.hasAttribute("hidden") || current.dataset.chatMotion === "collapse") folded.push(current);
			}
			const scroll = element.closest("[data-conversation-scroll]");
			if (scroll !== null) {
				try { scroll.dispatchEvent(new Event("beforematch")); } catch (error) { void error; }
			}
			for (const current of folded.reverse()) {
				try { current.dispatchEvent(new Event("beforematch")); } catch (error) { void error; }
			}
			return folded.length;
		}

		/**
		 * Unfold, scroll to and flash one located element.
		 *
		 * A text-node parent inside a collapsed process row is not painted until its
		 * `hidden="until-found"` ancestor receives `beforematch`; when even that leaves
		 * no box, the scrollport gets the same event and the target is scrolled once
		 * more. The outermost `[data-chat-node-key]` box is flashed so the hit is
		 * visible against a whole message rather than one inline run.
		 * @param target - the located element.
		 * @param root - the main chat column.
		 * @returns whether the hit ended up painted on screen.
		 */
		/**
		 * Nudge the conversation so the located block is not hidden behind the open panel.
		 * @param block - the highlighted message block.
		 * @param root - the main chat column.
		 */
		async function keepClearOfPanel(block, root) {
			const panel = state.nodes?.panel ?? null;
			if (panel === null || state.visible !== true) return;
			const scroll = root.closest("[data-conversation-scroll]");
			if (scroll === null) return;
			const viewport = window.innerHeight;
			// A collapsed panel covers one short strip, so one quick correction is
			// enough; waiting out the two animation rounds only delayed the paint.
			const passes = state.collapsed === true ? 1 : 2;
			for (let pass = 0; pass < passes; pass += 1) {
				await sleep(state.collapsed === true ? 60 : pass === 0 ? 200 : 420);
				const box = block.getBoundingClientRect();
				const panelBox = panel.getBoundingClientRect();
				const covered = box.top < panelBox.bottom + 16 && box.bottom > panelBox.top;
				const tooLow = box.top > viewport - 96;
				if (!covered && !tooLow) return;
				// Fold the list away first; the panel then occupies much less of the column.
				if (covered && state.collapsed === false) setCollapsed(true);
				const shift = covered ? -(panelBox.bottom + 16 - box.top) : box.top - (viewport - 96);
				if (Math.abs(shift) < 4) break;
				// The first correction animates; the second one lands exactly, in case late
				// content pushed the block back under the panel.
				const behavior = pass === 0 ? "smooth" : "auto";
				if (typeof scroll.scrollBy === "function") scroll.scrollBy({ top: shift, behavior });
				else scroll.scrollTop += shift;
			}
			// The column is already at its top (or cannot scroll further) and the block is
			// still under the panel: move the panel out of the way instead of the content.
			const box = block.getBoundingClientRect();
			const panelBox = panel.getBoundingClientRect();
			if (box.top < panelBox.bottom + 16 && box.bottom > panelBox.top) {
				panel.dataset.docked = "bottom";
				await sleep(state.collapsed === true ? 120 : 260);
			}
		}

		async function focusTarget(target, root) {
			const block = target.closest("[data-chat-node-key], [data-chat-call-id], [data-chat-turn]") ?? target;
			for (let pass = 0; pass < 2; pass += 1) {
				revealAncestors(target, root);
				await sleep(90);
				if (block.getClientRects().length === 0) {
					const scroll = root.closest("[data-conversation-scroll]");
					if (scroll !== null) {
						try { scroll.dispatchEvent(new Event("beforematch")); } catch (error) { void error; }
					}
					block.scrollIntoView({ block: "center" });
					await sleep(120);
				}
				if (block.getClientRects().length > 0 || pass === 1) break;
			}
			const painted = block.getClientRects().length > 0;
			if (!painted) return false;
			block.scrollIntoView({ block: "center", behavior: "smooth" });
			await keepClearOfPanel(block, root);
			block.setAttribute(HIT_ATTRIBUTE, "");
			target.setAttribute(EXACT_ATTRIBUTE, "");
			marks.block = block;
			marks.exact = target;
			return true;
		}

		/** Drop every highlight this overlay owns, here and in the sidebar. */
		function clearHighlight() {
			if (marks.block !== null) marks.block.removeAttribute(HIT_ATTRIBUTE);
			if (marks.exact !== null) marks.exact.removeAttribute(EXACT_ATTRIBUTE);
			if (marks.row !== null) marks.row.removeAttribute(TARGET_ATTRIBUTE);
			for (const row of marks.rows) row.removeAttribute(TARGET_ATTRIBUTE);
			// The sidebar may have re-rendered between jumps; sweep any stragglers.
			for (const row of document.querySelectorAll("[" + TARGET_ATTRIBUTE + "]")) {
				row.removeAttribute(TARGET_ATTRIBUTE);
			}
			marks.block = null;
			marks.exact = null;
			marks.row = null;
			marks.rows = [];
		}

		/** @returns the sidebar column candidates in the current document. */
		function sidebarRoots() {
			const selectors = [
				'[data-slot*="sidebar" i]',
				'[class*="sidebar" i]',
				'[class*="session-list" i]',
				'[class*="sessionlist" i]',
				"aside",
				"nav"
			];
			return Array.from(document.querySelectorAll(selectors.join(",")));
		}

		/**
		 * Collect the sidebar rows that list one session.
		 *
		 * The app's rows are plain `div`s wired with React click handlers, so they carry no
		 * `role` and no session id attribute: matching has to go through the title text.
		 * A row's text is the title plus a relative timestamp ("32 分钟", "3 天"), so the
		 * needle match allows a short suffix and the deepest match wins over its containers.
		 * @param sessionId - the session to look for.
		 * @returns up to three rows, most specific first.
		 */
		function findSidebarRows(sessionId) {
			const title = compactText(titleOf(sessionId));
			if (title.length < 2) return [];
			const needle = title.slice(0, 24);
			const limit = needle.length + 14;
			const matches = [];
			for (const root of sidebarRoots()) {
				for (const candidate of root.querySelectorAll("div, li, a, button, [role]")) {
					const text = compactText(candidate.textContent ?? "");
					if (text.length < needle.length || text.length > limit) continue;
					if (!text.includes(needle)) continue;
					// A row inside a collapsed group still has text; marking it would paint
					// nothing, so only rows the user can actually see count.
					if (candidate.getClientRects().length === 0) continue;
					if (candidate.parentElement !== null && candidate.parentElement.closest("[" + TARGET_ATTRIBUTE + "]") !== null) continue;
					matches.push(candidate);
				}
				if (matches.length > 0) break;
			}
			// Keep the deepest row of each branch: a container that also matches must not win.
			const deepest = matches.filter((node) => !matches.some((other) => other !== node && node.contains(other)));
			return deepest.slice(0, 3);
		}

		/**
		 * Mark and scroll to the sidebar row of the session we just opened.
		 * The row may mount a few frames after openSession, so retry briefly.
		 * @param sessionId - the session being shown.
		 * @returns the marked row, or null when the list hides it.
		 */
		async function markSidebar(sessionId) {
			let expanded = false;
			for (let attempt = 0; attempt < 8; attempt += 1) {
				if (attempt > 0) await sleep(140);
				if (marks.session !== sessionId) return null;
				const rows = findSidebarRows(sessionId);
				if (rows.length === 0) {
					// Grouped lists hide older sessions behind "展开其余 N 个会话"; open it once.
					if (expanded === false) {
						expanded = true;
						const opener = findGroupOpener();
						if (opener !== null) {
							try { opener.click(); } catch (error) { void error; }
							await sleep(180);
							continue;
						}
					}
					continue;
				}
				for (const row of marks.rows) {
					if (!rows.includes(row)) row.removeAttribute(TARGET_ATTRIBUTE);
				}
				for (const row of rows) row.setAttribute(TARGET_ATTRIBUTE, sessionId);
				marks.row = rows[0];
				marks.rows = rows;
				try { rows[0].scrollIntoView({ block: "nearest" }); } catch (error) { void error; }
				return rows[0];
			}
			return null;
		}

		/**
		 * Find the "展开其余 N 个会话" control of a collapsed session group.
		 * @returns the clickable opener, or null when no group is collapsed.
		 */
		function findGroupOpener() {
			for (const root of sidebarRoots()) {
				for (const node of root.querySelectorAll("button, [role=\"button\"], a")) {
					const text = compactText(node.textContent ?? "");
					if (text.length > 24) continue;
					if (!/展开其余|展开更多|显示更多/u.test(text)) continue;
					return node;
				}
			}
			return null;
		}

		/**
		 * Ask the conversation view for an older page of history.
		 * @param root - the main chat column.
		 * @returns whether a scrollable history container was found.
		 */
		async function loadEarlier(root) {
			const scroll = root.closest("[data-conversation-scroll]") ?? root.parentElement;
			if (scroll === null) return false;
			if (scroll.scrollHeight <= scroll.clientHeight) return false;
			scroll.scrollTop = 0;
			await sleep(320);
			return true;
		}

		/** Show one transient notice under the overlay. */
		function toast(text) {
			const element = document.getElementById(ROOT_ID + "-toast");
			if (element === null) return;
			element.textContent = text;
			element.dataset.show = "true";
			if (state.toastTimer !== null) clearTimeout(state.toastTimer);
			state.toastTimer = setTimeout(() => {
				element.dataset.show = "false";
				state.toastTimer = null;
			}, 3600);
		}

		/** Where the trigger pill remembers its own position. */
		const TRIGGER_KEY = "dsh-session-finder:trigger";

		/**
		 * Read a CSS colour's alpha channel.
		 * Accepts `rgb()/rgba()`, space-separated `rgb()` with `/ alpha`, `color()`.
		 * @param color - computed colour string.
		 * @returns alpha in 0..1; 1 for opaque keywords and hex.
		 */
		function alphaOf(color) {
			if (typeof color !== "string" || color === "" || color === "transparent") return 0;
			const open = color.lastIndexOf("(");
			if (open < 0) return 1;
			const parts = color.slice(open + 1, -1).split(/[\s,/]+/u).filter((part) => part !== "");
			if (parts.length < 4) return 1;
			const raw = parts[3];
			const value = Number.parseFloat(raw);
			if (!Number.isFinite(value)) return 1;
			const alpha = raw.endsWith("%") ? value / 100 : value;
			return Math.min(1, Math.max(0, alpha));
		}

		/**
		 * Split a computed `rgb()`/`rgba()` colour into its channels.
		 * @param color - computed colour string.
		 * @returns the 0..255 channels, or `null` when it cannot be parsed.
		 */
		function channelsOf(color) {
			const value = typeof color === "string" ? color.trim() : "";
			const hex = /^#([0-9a-f]{6})$/iu.exec(value);
			if (hex !== null) {
				const digits = hex[1];
				return [0, 2, 4].map((offset) => Number.parseInt(digits.slice(offset, offset + 2), 16));
			}
			const match = /^rgba?\(([^)]+)\)$/iu.exec(value);
			if (match === null) return null;
			const parts = match[1].split(/[\s,/]+/u).filter((part) => part !== "").slice(0, 3);
			if (parts.length < 3) return null;
			const channels = parts.map((part) => Number.parseFloat(part));
			return channels.every((channel) => Number.isFinite(channel)) ? channels : null;
		}

		/**
		 * Whether a colour is close to grey, so painting the panel with it cannot
		 * tint the whole overlay.
		 * @param color - computed colour string.
		 * @returns `true` for greyish colours within 32 of full saturation.
		 */
		function isNeutral(color) {
			const channels = channelsOf(color);
			if (channels === null) return false;
			return Math.max(...channels) - Math.min(...channels) <= 32;
		}

		/** Whether the page is using its dark theme. */
		function isDarkTheme() {
			return document.documentElement.dataset.dsDarkTheme !== undefined
				|| document.body?.dataset.dsDarkTheme !== undefined
				|| (typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches);
		}

		/**
		 * A solid colour to paint the panel with.
		 *
		 * Theme aliases may resolve to a translucent surface (glass panels), and an
		 * unresolved alias makes the declaration invalid, which paints nothing at all
		 * — both leave the conversation readable through the panel. So use the page's
		 * own background when it is a usable surface: opaque and grey. A saturated
		 * page colour (the app paints its canvas with a brand tone) must be skipped,
		 * otherwise the whole panel gets tinted. The canvas colour of `<html>` is
		 * skipped as well: it is white by default, not a surface.
		 * @returns an opaque CSS colour.
		 */
		function solidBackground() {
			const page = document.body === null ? "" : getComputedStyle(document.body).backgroundColor;
			if (alphaOf(page) >= 0.99 && isNeutral(page)) return page;
			return isDarkTheme() ? "rgb(24,24,27)" : "rgb(255,255,255)";
		}

		/** Where the panel remembers its own opacity, in percent. */
		const OPACITY_KEY = "dsh-session-finder:opacity";

		/**
		 * Give an opaque CSS colour an alpha channel.
		 * @param color - computed `rgb()`/`rgba()` colour.
		 * @param alpha - 0..1 alpha to apply.
		 * @returns an `rgba()` colour, or the input when it cannot be parsed.
		 */
		function withAlpha(color, alpha) {
			const match = /^rgba?\(([^)]+)\)$/iu.exec(typeof color === "string" ? color.trim() : "");
			if (match === null) return color;
			const channels = match[1].split(/[\s,/]+/u).filter((part) => part !== "").slice(0, 3);
			if (channels.length < 3) return color;
			return "rgba(" + channels.join(",") + "," + String(alpha) + ")";
		}

		/**
		 * Relative luminance of a computed colour, 0 (black) through 1 (white).
		 * @param color - computed `rgb()`/`rgba()` colour.
		 * @returns the luminance, or 0 when the colour cannot be parsed.
		 */
		function luminanceOf(color) {
			const channels = channelsOf(color) ?? [0, 0, 0];
			const factors = [0.2126, 0.7152, 0.0722];
			let weight = 0;
			channels.forEach((value, index) => {
				const channel = Math.min(255, Math.max(0, value)) / 255;
				weight += factors[index] * channel;
			});
			return weight;
		}

		/**
		 * Foreground colours that stay readable on the panel's own background.
		 * Theme aliases win when they resolve; these only cover hosts without them.
		 */
		function applyPalette() {
			if (state.nodes === null) return;
			const dark = luminanceOf(state.baseColor) < 0.5;
			const style = state.nodes.overlay.style;
			style.setProperty("--sf-fg", dark ? "#eef0f3" : "#1a1c22");
			style.setProperty("--sf-fg-2", dark ? "#c3c8d1" : "#4b515c");
			style.setProperty("--sf-fg-3", dark ? "#8f96a3" : "#6f7683");
			style.setProperty("--sf-hover", dark ? "rgba(255,255,255,.1)" : "rgba(0,0,0,.06)");
		}

		/**
		 * Read the stored panel opacity.
		 * @returns a percentage inside the allowed range.
		 */
		function readOpacity() {
			let stored = Number.NaN;
			try {
				stored = Number.parseFloat(localStorage.getItem(OPACITY_KEY) ?? "");
			}
			catch {
				stored = Number.NaN;
			}
			if (!Number.isFinite(stored)) return OPACITY_DEFAULT;
			return Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, Math.round(stored)));
		}

		/**
		 * Paint the panel with the current base colour and opacity.
		 * @param percent - opacity percentage; reads the stored value when omitted.
		 */
		function applyOpacity(percent) {
			if (state.nodes === null) return;
			const value = percent ?? readOpacity();
			state.opacity = Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, Math.round(value)));
			state.nodes.overlay.style.setProperty("--sf-solid-bg", withAlpha(state.baseColor, state.opacity / 100));
			applyPalette();
			const slider = state.nodes.alpha;
			const output = state.nodes.alphaValue;
			if (slider !== null) slider.value = String(state.opacity);
			if (output !== null) output.textContent = TEXT.alphaValue(state.opacity);
		}

		/**
		 * Move the trigger inside the viewport, keeping a small margin.
		 * @param left - desired viewport x of the pill's left edge.
		 * @param top - desired viewport y of the pill's top edge.
		 */
		function placeTrigger(left, top) {
			if (state.nodes === null) return;
			const trigger = state.nodes.trigger;
			const width = trigger.offsetWidth;
			const height = trigger.offsetHeight;
			const maxLeft = Math.max(8, window.innerWidth - width - 8);
			const maxTop = Math.max(8, window.innerHeight - height - 8);
			trigger.style.left = String(Math.round(Math.min(maxLeft, Math.max(8, left)))) + "px";
			trigger.style.top = String(Math.round(Math.min(maxTop, Math.max(8, top)))) + "px";
			trigger.style.right = "auto";
			trigger.style.bottom = "auto";
		}

		/** @param remember - whether to persist the resulting position. */
		function restoreTrigger(remember) {
			if (state.nodes === null) return;
			let saved = null;
			try {
				saved = JSON.parse(localStorage.getItem(TRIGGER_KEY) ?? "null");
			}
			catch (error) {
				void error;
			}
			if (saved !== null && typeof saved === "object" && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
				placeTrigger(saved.left, saved.top);
				return;
			}
			placeTrigger(window.innerWidth - state.nodes.trigger.offsetWidth - 16, window.innerHeight - state.nodes.trigger.offsetHeight - 16);
			if (remember === true) saveTrigger();
		}

		/** Persist the trigger's current position. */
		function saveTrigger() {
			if (state.nodes === null) return;
			const rect = state.nodes.trigger.getBoundingClientRect();
			try {
				localStorage.setItem(TRIGGER_KEY, JSON.stringify({ left: Math.round(rect.left), top: Math.round(rect.top) }));
			}
			catch (error) {
				void error;
			}
		}

		/**
		 * Let the user drag the trigger anywhere; a drag never opens the overlay.
		 * @param element - the trigger button.
		 */
		function bindTriggerDrag(element) {
			let startX = 0;
			let startY = 0;
			let originLeft = 0;
			let originTop = 0;
			let moved = false;
			let active = false;
			element.addEventListener("pointerdown", (event) => {
				if (event.button !== 0) return;
				const rect = element.getBoundingClientRect();
				active = true;
				moved = false;
				startX = event.clientX;
				startY = event.clientY;
				originLeft = rect.left;
				originTop = rect.top;
				try { element.setPointerCapture(event.pointerId); } catch (error) { void error; }
			});
			element.addEventListener("pointermove", (event) => {
				if (!active) return;
				const dx = event.clientX - startX;
				const dy = event.clientY - startY;
				if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
				moved = true;
				element.dataset.dragging = "true";
				placeTrigger(originLeft + dx, originTop + dy);
			});
			const finish = (event) => {
				if (!active) return;
				active = false;
				element.dataset.dragging = "false";
				try { element.releasePointerCapture(event.pointerId); } catch (error) { void error; }
				if (moved) saveTrigger();
			};
			element.addEventListener("pointerup", finish);
			element.addEventListener("pointercancel", finish);
			element.addEventListener("click", (event) => {
				if (!moved) return;
				moved = false;
				event.preventDefault();
				event.stopImmediatePropagation();
			}, true);
		}

		/**
		 * Move the panel to a viewport position, dropping the centring transform.
		 * @param left - desired left edge in viewport pixels.
		 * @param top - desired top edge in viewport pixels.
		 */
		function placePanel(left, top) {
			const panel = state.nodes?.panel;
			if (panel === null || panel === undefined) return;
			const width = panel.offsetWidth;
			const height = panel.offsetHeight;
			const maxLeft = Math.max(8, window.innerWidth - width - 8);
			const maxTop = Math.max(8, window.innerHeight - height - 8);
			panel.style.transform = "none";
			panel.style.left = String(Math.round(Math.min(maxLeft, Math.max(8, left)))) + "px";
			panel.style.top = String(Math.round(Math.min(maxTop, Math.max(8, top)))) + "px";
		}

		/** @returns the saved panel position, or null. */
		function readPanelPosition() {
			try {
				const saved = JSON.parse(localStorage.getItem(PANEL_KEY) ?? "null");
				if (saved !== null && typeof saved === "object" && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
					return { left: saved.left, top: saved.top };
				}
			}
			catch (error) {
				void error;
			}
			return null;
		}

		/** @returns the remembered queries, newest first, cleaned of junk. */
		function readHistory() {
			try {
				const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
				if (!Array.isArray(saved)) return [];
				const seen = new Set();
				const list = [];
				for (const entry of saved) {
					if (typeof entry !== "string") continue;
					const text = entry.trim();
					if (text.length < MIN_QUERY_LENGTH || seen.has(text)) continue;
					seen.add(text);
					list.push(text);
					if (list.length >= HISTORY_LIMIT) break;
				}
				return list;
			}
			catch (error) {
				void error;
				return [];
			}
		}

		/** @param list - the queries to persist. */
		function writeHistory(list) {
			try {
				localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
			}
			catch (error) {
				void error;
			}
		}

		/**
		 * Put a query at the top of the list, newest first, without duplicates.
		 * @param query - the query that just produced a search.
		 */
		function rememberQuery(query) {
			const text = query.trim();
			if (text.length < MIN_QUERY_LENGTH) return;
			const next = [text];
			for (const entry of state.history) {
				if (entry !== text) next.push(entry);
				if (next.length >= HISTORY_LIMIT) break;
			}
			state.history = next;
			writeHistory(next);
		}

		/** Drop every remembered query, in storage and on screen. */
		function clearHistory() {
			state.history = [];
			try {
				localStorage.removeItem(HISTORY_KEY);
			}
			catch (error) {
				void error;
			}
			renderHistory();
			toast(TEXT.historyEmpty);
		}

		/**
		 * Paint the history list. It shows only while the box is empty, so it never
		 * covers results the reader is about to click.
		 */
		function renderHistory() {
			const box = state.nodes?.history;
			const input = state.nodes?.input;
			if (box === null || box === undefined || input === null || input === undefined) return;
			box.textContent = "";
			const open = state.history.length > 0 && input.value.trim() === "" && state.historyHidden !== true;
			box.dataset.open = open ? "true" : "false";
			if (!open) return;
			for (const entry of state.history) {
				const item = document.createElement("button");
				item.type = "button";
				item.className = "sf-history-item";
				item.dataset.value = entry;
				item.title = entry;
				const label = document.createElement("span");
				label.textContent = entry;
				item.appendChild(label);
				const arrow = document.createElement("i");
				arrow.setAttribute("aria-hidden", "true");
				arrow.textContent = "\u21b5";
				item.appendChild(arrow);
				item.addEventListener("click", () => { useHistory(entry); });
				box.appendChild(item);
			}
			const foot = document.createElement("div");
			foot.className = "sf-history-foot";
			const hint = document.createElement("small");
			hint.textContent = TEXT.historyLabel;
			foot.appendChild(hint);
			const clear = document.createElement("button");
			clear.type = "button";
			clear.className = "sf-history-clear";
			clear.textContent = TEXT.historyClear;
			clear.addEventListener("click", () => { clearHistory(); });
			foot.appendChild(clear);
			box.appendChild(foot);
		}

		/**
		 * Re-run a remembered query.
		 * @param entry - the query text taken from the history list.
		 */
		function useHistory(entry) {
			const input = state.nodes?.input;
			if (input !== undefined && input !== null) {
				input.value = entry;
				input.focus();
			}
			state.query = entry;
			state.historyHidden = false;
			renderHistory();
			void runSearch(entry, false);
		}

		/**
		 * Move focus from the box into the history list.
		 * @param direction - 1 focuses the newest entry, -1 the oldest control.
		 */
		function focusHistory(direction) {
			const box = state.nodes?.history;
			if (box === null || box === undefined) return;
			const buttons = Array.from(box.querySelectorAll("button"));
			if (buttons.length === 0) return;
			const target = direction < 0 ? buttons[buttons.length - 1] : buttons[0];
			target.focus();
		}

		/** Arrow keys inside the history list, Escape back to the box. */
		function onHistoryKeydown(event) {
			if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Escape") return;
			event.preventDefault();
			// Keep the overlay's own Escape handler from closing the whole panel.
			event.stopPropagation();
			const box = state.nodes?.history;
			if (box === null || box === undefined) return;
			if (event.key === "Escape") {
				// Hide first, then re-focus on the next task: the browser drops
				// focus onto <body> when the focused item becomes display:none.
				state.historyHidden = true;
				renderHistory();
				const target = state.nodes?.input;
				if (target !== undefined && target !== null) {
					window.setTimeout(() => { target.focus(); }, 0);
				}
				return;
			}
			const buttons = Array.from(box.querySelectorAll("button"));
			const at = buttons.indexOf(event.target);
			const step = event.key === "ArrowDown" ? 1 : -1;
			const next = buttons[Math.max(0, Math.min(buttons.length - 1, at + step))];
			if (next !== undefined) next.focus();
		}

		/** Persist where the user left the panel. */		function savePanelPosition() {
			const panel = state.nodes?.panel;
			if (panel === null || panel === undefined) return;
			const rect = panel.getBoundingClientRect();
			try {
				localStorage.setItem(PANEL_KEY, JSON.stringify({ left: Math.round(rect.left), top: Math.round(rect.top) }));
			}
			catch (error) {
				void error;
			}
		}

		/**
		 * Let the user drag the panel by its header; controls inside stay clickable.
		 * @param panel - the panel element.
		 * @param head - the header that starts a drag.
		 */
		function bindPanelDrag(panel, head) {
			if (panel === null || panel === undefined || head === null || head === undefined) return;
			let active = false;
			let moved = false;
			let startX = 0;
			let startY = 0;
			let originLeft = 0;
			let originTop = 0;
			head.addEventListener("pointerdown", (event) => {
				if (event.button !== 0) return;
				if (event.target instanceof Element && event.target.closest("button, input, select, a, textarea") !== null) return;
				const rect = panel.getBoundingClientRect();
				active = true;
				moved = false;
				startX = event.clientX;
				startY = event.clientY;
				originLeft = rect.left;
				originTop = rect.top;
				try { head.setPointerCapture(event.pointerId); } catch (error) { void error; }
			});
			head.addEventListener("pointermove", (event) => {
				if (!active) return;
				const dx = event.clientX - startX;
				const dy = event.clientY - startY;
				if (!moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
				moved = true;
				head.dataset.dragging = "true";
				placePanel(originLeft + dx, originTop + dy);
			});
			const finish = (event) => {
				if (!active) return;
				active = false;
				head.dataset.dragging = "false";
				try { head.releasePointerCapture(event.pointerId); } catch (error) { void error; }
				if (moved) savePanelPosition();
			};
			head.addEventListener("pointerup", finish);
			head.addEventListener("pointercancel", finish);
		}

		/** @returns the last path segment of a project directory. */
		function baseName(path) {
			const parts = String(path ?? "").split(/[\\/]/u).filter((part) => part !== "");
			return parts.length === 0 ? String(path ?? "") : parts[parts.length - 1];
		}

		/**
		 * Session titles and project directories known to the client, keyed by id.
		 * @returns a Map of session id → `{ title, cwd }`.
		 */
		function sessionIndex() {
			const map = new Map();
			let byId = null;
			try {
				byId = state.ctx?.sessions?.list?.getSnapshot?.()?.byId ?? null;
			}
			catch (error) {
				void error;
			}
			if (byId === null || typeof byId !== "object") return map;
			for (const [id, summary] of Object.entries(byId)) {
				if (summary === null || typeof summary !== "object") continue;
				const title = normalizeText(summary.displayTitle ?? summary.title ?? "");
				const cwd = typeof summary.cwd === "string" ? summary.cwd : "";
				map.set(String(id), { title, cwd });
			}
			return map;
		}

		/**
		 * Which session is on screen right now.
		 *
		 * The app keeps no session id in the DOM and no service exposes the selection,
		 * so this reads the row the workspace sidebar marked `selected` and matches its
		 * title against the session list. The last session this overlay opened wins,
		 * because that is by definition what the user is looking at.
		 * @returns the current session id, or null when it cannot be told.
		 */
		function currentSessionId() {
			if (typeof state.lastOpened === "string" && state.lastOpened !== "") return state.lastOpened;
			const selected = document.querySelector("[class*=\"_sessionRow\"][class*=\"_selected\"], [class*=\"_sessionRow\"][aria-selected=\"true\"]");
			if (selected === null) return null;
			const text = compactText(selected.textContent ?? "");
			if (text.length < 2) return null;
			for (const [id, summary] of sessionIndex()) {
				const title = compactText(summary.title);
				if (title.length >= 2 && text.includes(title.slice(0, 24))) return id;
			}
			return null;
		}

		/**
		 * The search scopes offered in the footer.
		 * @returns `[{ value, label, kind, sessionId?, cwd? }]`.
		 */
		function scopeChoices() {
			const choices = [{ value: "all", label: TEXT.scopeAll, kind: "all" }];
			const current = currentSessionId();
			if (current !== null) choices.push({ value: "session:" + current, label: TEXT.scopeCurrent, kind: "session", sessionId: current });
			const projects = new Map();
			for (const summary of sessionIndex().values()) {
				if (summary.cwd === "") continue;
				projects.set(summary.cwd, (projects.get(summary.cwd) ?? 0) + 1);
			}
			const ordered = [...projects.entries()].sort((left, right) => right[1] - left[1]);
			for (const [cwd] of ordered.slice(0, 12)) {
				choices.push({ value: "cwd:" + cwd, label: TEXT.scopeProject(baseName(cwd)), kind: "project", cwd });
			}
			return choices;
		}

		/** Rebuild the scope selector from the sessions the client can see. */
		function fillScope() {
			const select = state.nodes?.scope;
			if (select === null || select === undefined) return;
			const choices = scopeChoices();
			const wanted = state.scope === "session" && state.scopeSessionId !== null
				? "session:" + state.scopeSessionId
				: state.scope === "project" && state.scopeCwd !== null
					? "cwd:" + state.scopeCwd
					: "all";
			select.textContent = "";
			for (const choice of choices) {
				const option = document.createElement("option");
				option.value = choice.value;
				option.textContent = choice.label;
				select.appendChild(option);
			}
			const known = choices.some((choice) => choice.value === wanted);
			if (!known) {
				state.scope = "all";
				state.scopeSessionId = null;
				state.scopeCwd = null;
			}
			select.value = known ? wanted : "all";
			select.title = TEXT.scopeLabel;
		}

		/**
		 * Apply a scope picked from the selector and re-run the current query.
		 * @param value - one of `all`, `session:<id>`, `cwd:<path>`.
		 */
		function applyScopeChoice(value) {
			const text = String(value ?? "");
			state.scopeTouched = true;
			if (text.startsWith("session:")) {
				state.scope = "session";
				state.scopeSessionId = text.slice("session:".length);
				state.scopeCwd = null;
			}
			else if (text.startsWith("cwd:")) {
				state.scope = "project";
				state.scopeCwd = text.slice("cwd:".length);
				state.scopeSessionId = null;
			}
			else {
				state.scope = "all";
				state.scopeSessionId = null;
				state.scopeCwd = null;
			}
			if (state.query.trim().length >= MIN_QUERY_LENGTH) void runSearch(state.query, false);
			else setStatus(TEXT.tooShort);
		}

		/**
		 * Session filters for the host route.
		 * @returns `{}`, `{ sessionId }` or `{ cwd }`.
		 */
		function scopeQuery() {
			if (state.scope === "session" && typeof state.scopeSessionId === "string" && state.scopeSessionId !== "") return { sessionId: state.scopeSessionId };
			if (state.scope === "project" && typeof state.scopeCwd === "string" && state.scopeCwd !== "") return { cwd: state.scopeCwd };
			return {};
		}

		/** True when `candidate` names a version newer than `current`; missing
		 * segments count as zero, so 0.7.1 and 0.7.1.0 are the same version. */
		function isNewer(candidate, current) {
			const left = String(candidate).replace(/^v/i, "").split(".");
			const right = String(current).replace(/^v/i, "").split(".");
			const size = Math.max(left.length, right.length);
			for (let index = 0; index < size; index += 1) {
				const a = Number.parseInt(left[index] ?? "0", 10);
				const b = Number.parseInt(right[index] ?? "0", 10);
				const x = Number.isFinite(a) ? a : 0;
				const y = Number.isFinite(b) ? b : 0;
				if (x !== y) return x > y;
			}
			return false;
		}

		/** Read the published manifest and report the answer in the status line.
		 * No rate-limit surface: it fetches the raw file, not the GitHub API. */
		async function checkUpdates(button) {
			if (button.disabled) return;
			button.disabled = true;
			button.setAttribute("aria-busy", "true");
			setStatus(TEXT.checking);
			const controller = new AbortController();
			const stop = setTimeout(() => controller.abort(), UPDATE_TIMEOUT_MS);
			try {
				const response = await fetch(LATEST_URL + "?t=" + String(Date.now()), { cache: "no-store", signal: controller.signal });
				if (!response.ok) throw new Error("http " + String(response.status));
				const body = await response.json();
				const latest = typeof body.version === "string" ? body.version.trim() : "";
				if (latest === "") throw new Error("no version");
				setStatus(isNewer(latest, VERSION) ? TEXT.updateFound(latest, VERSION) : TEXT.updateLatest(VERSION));
			}
			catch (error) {
				void error;
				setStatus(TEXT.updateFailed);
			}
			finally {
				clearTimeout(stop);
				button.disabled = false;
				button.removeAttribute("aria-busy");
			}
		}

		/** Build the overlay, the trigger pill and their styles; idempotent per document. */
		function mount() {
			if (document.getElementById(ROOT_ID) !== null) return;
			const style = document.createElement("style");
			style.dataset.plugin = "dsh-session-finder";
			style.textContent = CSS;
			document.head.appendChild(style);

			const overlay = document.createElement("div");
			overlay.id = ROOT_ID;
			overlay.dataset.open = "false";
			overlay.innerHTML = [
				"<div class=\"sf-panel\" role=\"dialog\" aria-label=\"" + TEXT.title + "\">",
				"<div class=\"sf-head\"><input class=\"sf-input\" type=\"text\" spellcheck=\"false\" autocomplete=\"off\"><button class=\"sf-toggle\" type=\"button\"></button><button class=\"sf-close\" type=\"button\" aria-label=\"" + TEXT.close + "\" title=\"" + TEXT.close + "\">\u00d7</button></div>",
				"<div class=\"sf-history\" role=\"listbox\" aria-label=\"" + TEXT.historyLabel + "\"></div>",
				"<div class=\"sf-status\"></div>",
				"<div class=\"sf-nav\">"
					+ "<button class=\"sf-nav-btn sf-nav-prev\" type=\"button\">" + TEXT.navPrev + "</button>"
					+ "<span class=\"sf-nav-count\" aria-live=\"polite\"></span>"
					+ "<button class=\"sf-nav-btn sf-nav-next\" type=\"button\">" + TEXT.navNext + "</button>"
					+ "</div>",
				"<div class=\"sf-list\" role=\"listbox\"></div>",
				"<div class=\"sf-foot\"><select class=\"sf-scope\" aria-label=\"" + TEXT.scopeLabel + "\"></select><span class=\"sf-foot-hint\">" + TEXT.hint + "</span>"
					+ "<label class=\"sf-alpha\" title=\"" + TEXT.alpha + "\"><span aria-hidden=\"true\">" + TEXT.alphaShort + "</span>"
					+ "<input class=\"sf-alpha-input\" type=\"range\" min=\"" + String(OPACITY_MIN) + "\" max=\"" + String(OPACITY_MAX) + "\" step=\"1\" aria-label=\"" + TEXT.alpha + "\">"
					+ "<output class=\"sf-alpha-value\"></output></label></div>",
				"<div class=\"sf-tools\">"
					+ "<a class=\"sf-tool\" href=\"" + REPO_URL + "\" target=\"_blank\" rel=\"noopener noreferrer\" title=\"" + REPO_URL + "\">" + ICONS.github + TEXT.toolsGithub + "</a>"
					+ "<a class=\"sf-tool\" href=\"" + ISSUES_URL + "\" target=\"_blank\" rel=\"noopener noreferrer\" title=\"" + TEXT.toolsIssues + "\">" + ICONS.issue + TEXT.toolsIssues + "</a>"
					+ "<button class=\"sf-tool sf-check\" type=\"button\" title=\"" + TEXT.toolsCheck + "\">" + ICONS.refresh + TEXT.toolsCheck + "</button>"
					+ "<span class=\"sf-ver\">v" + VERSION + "</span>"
					+ "</div>",
				"</div>"
			].join("");
			document.body.appendChild(overlay);

			const trigger = document.createElement("button");
			trigger.id = ROOT_ID + "-trigger";
			trigger.type = "button";
			trigger.title = TEXT.placeholder;
			const icon = document.createElement("span");
			icon.setAttribute("aria-hidden", "true");
			icon.innerHTML = ICON;
			trigger.appendChild(icon);
			trigger.appendChild(document.createTextNode(TEXT.open));
			document.body.appendChild(trigger);

			const notice = document.createElement("div");
			notice.id = ROOT_ID + "-toast";
			document.body.appendChild(notice);

			state.nodes = {
				overlay,
				panel: overlay.querySelector(".sf-panel"),
				head: overlay.querySelector(".sf-head"),
				trigger,
				notice,
				input: overlay.querySelector(".sf-input"),
				status: overlay.querySelector(".sf-status"),
				history: overlay.querySelector(".sf-history"),
				navPrev: overlay.querySelector(".sf-nav-prev"),
				navNext: overlay.querySelector(".sf-nav-next"),
				navCount: overlay.querySelector(".sf-nav-count"),
				toggle: overlay.querySelector(".sf-toggle"),
				list: overlay.querySelector(".sf-list"),
				scope: overlay.querySelector(".sf-scope"),
				alpha: overlay.querySelector(".sf-alpha-input"),
				alphaValue: overlay.querySelector(".sf-alpha-value")
			};

			bindTriggerDrag(trigger);
			restoreTrigger(false);
			trigger.addEventListener("click", () => open());
			bindPanelDrag(state.nodes.panel, state.nodes.head);
			if (state.nodes.scope !== null) {
				state.nodes.scope.addEventListener("change", () => { applyScopeChoice(state.nodes.scope.value); });
			}
			overlay.querySelector(".sf-close").addEventListener("click", () => close());
			overlay.querySelector(".sf-check").addEventListener("click", (event) => {
				void checkUpdates(/** @type {HTMLButtonElement} */ (event.currentTarget));
			});
			overlay.querySelector(".sf-nav-prev").addEventListener("click", () => { void step(-1); });
			overlay.querySelector(".sf-nav-next").addEventListener("click", () => { void step(1); });
			overlay.querySelector(".sf-toggle").addEventListener("click", () => { setCollapsed(!state.collapsed); });
			overlay.addEventListener("mousedown", (event) => {
				if (event.target === overlay) close();
			});
			const input = state.nodes.input;
			input.placeholder = TEXT.placeholder;
			state.history = readHistory();
			input.addEventListener("input", () => {
				// Typing during navigation means a new search; show the list again.
				if (state.collapsed) setCollapsed(false);
				state.historyHidden = false;
				renderHistory();
				schedule(input.value);
			});
			input.addEventListener("focus", () => { renderHistory(); });
			input.addEventListener("keydown", onInputKeydown);
			if (state.nodes.history !== null) state.nodes.history.addEventListener("keydown", onHistoryKeydown);
			renderHistory();

			const alpha = state.nodes.alpha;
			if (alpha !== null) {
				alpha.value = String(readOpacity());
				alpha.addEventListener("input", () => {
					applyOpacity(Number.parseFloat(alpha.value));
					try {
						localStorage.setItem(OPACITY_KEY, String(state.opacity));
					}
					catch {
						/* Storage can be unavailable; the panel still works without it. */
					}
				});
			}
		}

		/** @returns whether the overlay is currently shown. */
		function isOpen() {
			return state.visible;
		}

		/** Show the overlay and focus its input. */
		function open() {
			mount();
			if (state.nodes === null) return;
			state.visible = true;
			state.baseColor = solidBackground();
			applyOpacity();
			state.nodes.overlay.dataset.open = "true";
			state.nodes.overlay.dataset.navigating = "false";
			setCollapsed(false);
			// "当前会话" is the default scope, so the first search starts narrow.
			if (state.scopeTouched !== true) {
				const current = currentSessionId();
				state.scope = current === null ? "all" : "session";
				state.scopeSessionId = current;
				state.scopeCwd = null;
			}
			fillScope();
			const saved = readPanelPosition();
			if (saved !== null) placePanel(saved.left, saved.top);
			updateNav();
			state.historyHidden = false;
			renderHistory();
			state.nodes.input.focus();
			state.nodes.input.select();
			if (state.items.length === 0) setStatus(TEXT.tooShort);
		}

		/** Hide the overlay and cancel any in-flight search. */
		function close() {
			state.visible = false;
			state.jumpId += 1;
			marks.session = null;
			clearHighlight();
			if (state.nodes !== null) {
				state.nodes.overlay.dataset.open = "false";
				state.nodes.overlay.dataset.navigating = "false";
			}
			if (state.pending !== null) {
				try { state.pending.abort(); } catch (error) { void error; }
				state.pending = null;
			}
			if (state.timer !== null) {
				clearTimeout(state.timer);
				state.timer = null;
			}
		}

		/** Toggle the overlay from the keyboard shortcut. */
		function toggle() {
			if (isOpen()) close();
			else open();
		}

		/**
		 * Replace the status line above the results.
		 * @param text - message shown in the status line.
		 */
		function setStatus(text, tone) {
			if (state.nodes === null) return;
			state.nodes.status.textContent = text;
			state.nodes.status.dataset.tone = tone === "error" ? "error" : "";
		}

		/**
		 * Debounce typing into one host search per quiet period.
		 * @param value - the input's current value.
		 */
		function schedule(value) {
			state.query = value;
			if (state.timer !== null) clearTimeout(state.timer);
			state.timer = null;
			const query = normalizeText(value);
			if (query.length < MIN_QUERY_LENGTH) {
				state.items = [];
				state.active = -1;
				state.hasOlder = false;
				state.nextOffset = 0;
				renderRows();
				setStatus(TEXT.tooShort);
				return;
			}
			state.timer = setTimeout(() => {
				state.timer = null;
				void runSearch(query);
			}, DEBOUNCE_MS);
		}

		/** Placeholder origin for URL resolution when the page has no usable base. */
		const PLACEHOLDER_ORIGIN = "http://dsh.internal/";

		/**
		 * Turn the page base into a directory base: drop the query (the launch
		 * token rides there) and the hash, then force a trailing slash so a
		 * relative route appends instead of replacing the last segment.
		 * @param baseUrl - `document.baseURI` or the placeholder.
		 * @returns an absolute directory URL.
		 */
		function directoryBase(baseUrl) {
			const url = new URL(baseUrl === "" ? PLACEHOLDER_ORIGIN : baseUrl, PLACEHOLDER_ORIGIN);
			url.search = "";
			url.hash = "";
			if (!url.pathname.endsWith("/")) url.pathname += "/";
			return url.href;
		}

		/**
		 * Resolve this plugin's host route against the PAGE base, not the injected
		 * transport origin: the desktop shell forwards `dsh-app://app/<path>` to the
		 * Host same-origin, while the Host's plugin routes answer no CORS headers.
		 * A leading slash would also escape a reverse-proxy directory prefix.
		 * @param path - the route, with or without a leading slash.
		 * @returns the absolute URL.
		 */
		function hostRoute(path) {
			const base = typeof document !== "undefined" && typeof document.baseURI === "string" && document.baseURI !== "" ? document.baseURI : PLACEHOLDER_ORIGIN;
			return new URL(String(path).replace(/^\/+/, ""), directoryBase(base));
		}

		/**
		 * Ask this plugin's host half for hits.
		 * @param query - the trimmed, lowercased query.
		 * @param offset - how many sessions to skip, walking newest first.
		 * @param signal - abort signal for the in-flight request.
		 * @returns `{ items, terms, truncated, hasOlder, nextOffset, scanned, totalSessions, partialSessions }`.
		 */
		async function searchHost(query, offset, signal) {
			const url = hostRoute("session-finder/search");
			url.searchParams.set("q", query);
			if (offset > 0) url.searchParams.set("offset", String(offset));
			const scope = scopeQuery();
			if (typeof scope.sessionId === "string") url.searchParams.set("sessionId", scope.sessionId);
			else if (typeof scope.cwd === "string") url.searchParams.set("cwd", scope.cwd);
			let response;
			try {
				response = await fetch(url.href, { method: "GET", signal, headers: { accept: "application/json" } });
			}
			catch (error) {
				if (error !== null && typeof error === "object" && error.name === "AbortError") throw error;
				throw new Error(TEXT.routeMissing);
			}
			let body = null;
			try {
				body = await response.json();
			}
			catch (error) {
				body = null;
			}
			if (response.status === 404) throw new Error(TEXT.routeMissing);
			if (body !== null && body !== undefined && body.error !== undefined) throw new Error(String(body.error.message ?? body.error.code ?? response.status));
			if (!response.ok) throw new Error("HTTP " + String(response.status));
			const items = Array.isArray(body?.items) ? body.items : [];
			return {
				items: items.map((item) => ({
					sessionId: String(item.sessionId),
					seq: typeof item.seq === "number" ? item.seq : -1,
					role: typeof item.role === "string" ? item.role : "",
					time: typeof item.time === "number" ? item.time : 0,
					callId: typeof item.callId === "string" && item.callId !== "" ? item.callId : null,
					turn: typeof item.turn === "number" && item.turn > 0 ? item.turn : null,
					snippet: String(item.snippet ?? "")
				})),
				terms: Array.isArray(body?.terms) ? body.terms.map(String) : [],
				truncated: body?.truncated === true,
				hasOlder: body?.hasOlder === true,
				nextOffset: typeof body?.nextOffset === "number" ? body.nextOffset : offset + 48,
				scanned: typeof body?.scanned === "number" ? body.scanned : 0,
				totalSessions: typeof body?.totalSessions === "number" ? body.totalSessions : 0,
				partialSessions: typeof body?.partialSessions === "number" ? body.partialSessions : 0
			};
		}

		/**
		 * Ask the host, walking older pages while nothing has been found yet.
		 *
		 * A query that exists only late in a long history would otherwise answer
		 * "没有命中" until the reader clicked through every page by hand.
		 * @param query - the trimmed query.
		 * @param offset - first session page to read.
		 * @param signal - abort signal for the in-flight request.
		 * @returns the merged pages, shaped like one `searchHost` answer.
		 */
		async function searchPages(query, offset, signal) {
			const merged = {
				items: [],
				terms: [],
				truncated: false,
				hasOlder: false,
				nextOffset: offset,
				scanned: 0,
				totalSessions: 0,
				partialSessions: 0
			};
			let at = offset;
			const startedAt = Date.now();
			for (let page = 0; page < MAX_AUTO_PAGES; page += 1) {
				const part = await searchHost(query, at, signal);
				merged.items = merged.items.concat(part.items);
				merged.terms = part.terms.length > 0 ? part.terms : merged.terms;
				merged.truncated = merged.truncated || part.truncated;
				merged.scanned += part.scanned;
				merged.totalSessions = part.totalSessions;
				merged.partialSessions += part.partialSessions;
				merged.hasOlder = part.hasOlder;
				merged.nextOffset = part.nextOffset;
				if (merged.items.length > 0) break;
				if (part.hasOlder !== true || part.nextOffset <= at) break;
				if (Date.now() - startedAt > AUTO_SEARCH_BUDGET_MS) break;
				at = part.nextOffset;
				setStatus(TEXT.loadingMore);
			}
			return merged;
		}

		/**
		 * Ask the host half for hits and render them.
		 * @param query - the trimmed query.
		 * @param append - true to load the next page of older sessions.
		 */
		async function runSearch(query, append = false) {
			if (state.pending !== null) {
				try { state.pending.abort(); } catch (error) { void error; }
				state.pending = null;
			}
			const controller = typeof AbortController === "function" ? new AbortController() : null;
			state.pending = controller;
			state.query = query;
			if (!append) {
				// A new query is remembered, and it invalidates any jump still
				// polling for the old hits.
				rememberQuery(query);
				renderHistory();
				state.jumpId += 1;
				state.hasOlder = false;
				state.nextOffset = 0;
				state.claims.clear();
				renderRows();
			}
			setStatus(append ? TEXT.loadingMore : TEXT.searching);
			const offset = append ? state.nextOffset : 0;
			const startedAt = Date.now();
			try {
				const result = await searchPages(query, offset, controller?.signal);
				const took = TEXT.took((Date.now() - startedAt) / 1000);
				if (state.pending !== controller) return;
				state.pending = null;
				state.items = append ? state.items.concat(result.items) : result.items;
				if (append === false) state.prefetched.clear();
				state.hasOlder = result.hasOlder;
				state.nextOffset = result.nextOffset;
				if (state.items.length > 0 && (append === false || (state.active < 0 && result.items.length > 0))) state.active = append ? state.items.length - result.items.length : 0;
				renderRows();
				if (state.items.length === 0) {
					setStatus((result.hasOlder ? TEXT.noHitOlder : TEXT.empty) + TEXT.scope(result.scanned, result.totalSessions) + (result.partialSessions > 0 ? TEXT.partial(result.partialSessions) : "") + took);
					return;
				}
				setStatus(TEXT.count(state.items.length) + TEXT.scope(result.scanned, result.totalSessions) + (result.truncated ? TEXT.truncated : "") + (result.partialSessions > 0 ? TEXT.partial(result.partialSessions) : "") + took);
			}
			catch (error) {
				if (controller !== null && controller.signal.aborted) return;
				state.pending = null;
				if (!append) {
					state.items = [];
					state.hasOlder = false;
					state.nextOffset = 0;
					state.active = -1;
					renderRows();
				}
				setStatus(TEXT.failed + "：" + messageOf(error), "error");
			}
		}

		/**
		 * Cut a title down for the result row.
		 * @param sessionId - the hit's session.
		 * @returns the display title, falling back to a shortened id.
		 */
		function titleOf(sessionId) {
			const list = state.ctx?.sessions?.list;
			const summary = list?.getSnapshot?.()?.byId?.[sessionId];
			const title = summary?.displayTitle ?? summary?.title;
			if (typeof title === "string" && title.trim() !== "") return title.trim();
			return "会话 " + sessionId.slice(0, 8);
		}

		/**
		 * Render the current hit list, marking the active row.
		 * A row is a button so it is clickable and reachable by keyboard.
		 */
		function renderRows() {
			if (state.nodes === null) return;
			const list = state.nodes.list;
			list.textContent = "";
			state.items.forEach((item, index) => {
				const row = document.createElement("button");
				row.type = "button";
				row.className = "sf-row";
				row.setAttribute(ROW_ATTRIBUTE, item.sessionId);
				row.dataset.active = index === state.active ? "true" : "false";
				row.setAttribute("role", "option");
				row.setAttribute("aria-selected", index === state.active ? "true" : "false");

				const title = document.createElement("div");
				title.className = "sf-title";
				title.textContent = titleOf(item.sessionId);
				row.appendChild(title);

				const snippet = document.createElement("div");
				snippet.className = "sf-snippet";
				appendHighlighted(snippet, item.snippet, state.query);
				row.appendChild(snippet);

				const meta = document.createElement("div");
				meta.className = "sf-meta";
				meta.textContent = metaOf(item);
				row.appendChild(meta);

				row.addEventListener("mouseenter", () => {
					if (state.active === index) return;
					state.active = index;
					markActive();
				});
				// Warm the history while the pointer rests on a row: the click then
				// finds the page already loaded instead of waiting for it. Dwell on
				// purpose — a row that merely appears under the cursor must not start
				// a history load that competes with the next search.
				row.addEventListener("pointerenter", () => {
					schedulePrefetch(state.items[index]);
				});
				row.addEventListener("pointerleave", () => {
					cancelPrefetch();
				});
				row.addEventListener("click", () => { void choose(index); });
				list.appendChild(row);
			});
			if (state.hasOlder) {
				const more = document.createElement("button");
				more.type = "button";
				more.className = "sf-more";
				more.textContent = state.items.length === 0 ? TEXT.moreOlder : TEXT.more;
				more.addEventListener("click", (event) => {
					event.stopPropagation();
					void runSearch(state.query, true);
				});
				list.appendChild(more);
			}
			updateNav();
		}

		/** @param item - one hit. @returns its role and time label. */
		function metaOf(item) {
			const role = ROLE_LABELS[item.role] ?? item.role;
			if (role === undefined || role === "") return formatTime(item.time);
			return item.time > 0 ? role + " · " + formatTime(item.time) : role;
		}

		/**
		 * Append snippet text with the typed query wrapped in `<mark>`.
		 * Text is written with `textContent` only — the snippet is host data.
		 * @param target - the snippet element.
		 * @param snippet - the hit's snippet.
		 * @param query - what the user typed.
		 */
		function appendHighlighted(target, snippet, query) {
			const terms = splitTerms(query);
			if (terms.length === 0) {
				target.textContent = snippet;
				return;
			}
			const lower = snippet.toLowerCase();
			const spans = [];
			for (const term of terms) {
				let from = 0;
				let at = lower.indexOf(term, from);
				while (at >= 0 && spans.length < 200) {
					spans.push([at, at + term.length]);
					from = at + term.length;
					at = lower.indexOf(term, from);
				}
			}
			if (spans.length === 0) {
				target.textContent = snippet;
				return;
			}
			spans.sort((left, right) => left[0] - right[0] || right[1] - left[1]);
			const merged = [];
			for (const span of spans) {
				const last = merged[merged.length - 1];
				if (last !== undefined && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
				else merged.push([span[0], span[1]]);
			}
			let cursor = 0;
			for (const [start, end] of merged) {
				if (start > cursor) target.appendChild(document.createTextNode(snippet.slice(cursor, start)));
				const mark = document.createElement("mark");
				mark.textContent = snippet.slice(start, end);
				target.appendChild(mark);
				cursor = end;
			}
			if (cursor < snippet.length) target.appendChild(document.createTextNode(snippet.slice(cursor)));
		}

		/** Repaint only the active-row markers. */
		function markActive() {
			if (state.nodes === null) return;
			const rows = [...state.nodes.list.querySelectorAll("[data-session-finder-row]")];
			rows.forEach((row, index) => {
				const active = index === state.active ? "true" : "false";
				row.dataset.active = active;
				row.setAttribute("aria-selected", active);
			});
			const current = rows[state.active];
			if (current !== undefined) current.scrollIntoView({ block: "nearest" });
			updateNav();
		}

		/** @param step - +1 or -1 to move the active row. */
		function moveActive(step) {
			if (state.items.length === 0) return;
			const next = state.active + step;
			state.active = next < 0 ? state.items.length - 1 : next >= state.items.length ? 0 : next;
			markActive();
		}

		/** Keyboard handling inside the search input. */
		function onInputKeydown(event) {
			// While the history list is showing, arrows walk it and Enter replays.
			const box = state.nodes?.history;
			if (box?.dataset.open === "true") {
				// These keys belong to the list; the overlay's Escape must not fire.
				event.stopPropagation();
				if (event.key === "ArrowDown" || event.key === "ArrowUp") {
					event.preventDefault();
					focusHistory(event.key === "ArrowUp" ? -1 : 1);
					return;
				}
				if (event.key === "Enter") {
					event.preventDefault();
					const first = state.history[0];
					if (first !== undefined) useHistory(first);
					return;
				}
			}
			if (event.key === "F3") {
				event.preventDefault();
				void step(event.shiftKey ? -1 : 1);
				return;
			}
			if (event.altKey && event.key === "ArrowDown") {
				event.preventDefault();
				void step(1);
				return;
			}
			if (event.altKey && event.key === "ArrowUp") {
				event.preventDefault();
				void step(-1);
				return;
			}
			if (event.key === "ArrowDown") {
				event.preventDefault();
				moveActive(1);
				return;
			}
			if (event.key === "ArrowUp") {
				event.preventDefault();
				moveActive(-1);
				return;
			}
			if (event.key === "Enter") {
				event.preventDefault();
				void choose(state.active);
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				close();
			}
		}

		/**
		 * The live session face the chat view already holds for this session.
		 *
		 * `ISession.loadThrough(seq)` is the app's own "jump loader": it pages
		 * backwards until the event window covers that seq, which is exactly what a
		 * hit deep in a long history needs. It only exists while the conversation is
		 * open, so callers retry until the binding appears.
		 * @param sessionId - the session to reach.
		 * @returns the session face, or null when the view has not opened it yet.
		 */
		function sessionFaceOf(sessionId) {
			const sessions = state.ctx?.sessions;
			if (sessions === undefined || sessions === null) return null;
			try {
				const binding = typeof sessions.binding === "function" ? sessions.binding(sessionId) : undefined;
				if (binding !== undefined && binding !== null && binding.session !== undefined) return binding.session;
			}
			catch (error) {
				void error;
			}
			return null;
		}

		/** Pending warm-up timer for the row the pointer is resting on. */
		let prefetchTimer = 0;

		/**
		 * Arm a warm-up for one hit once the pointer has settled on its row.
		 * @param hit - row under the pointer.
		 */
		function schedulePrefetch(hit) {
			window.clearTimeout(prefetchTimer);
			prefetchTimer = window.setTimeout(() => {
				prefetch(hit);
			}, PREFETCH_DELAY_MS);
		}

		/** Drop an armed warm-up: the pointer left, or the page re-rendered. */
		function cancelPrefetch() {
			window.clearTimeout(prefetchTimer);
			prefetchTimer = 0;
		}

		/**
		 * Warm one hit's history without opening or marking anything.
		 *
		 * Only works for a session the chat view already holds (the one on screen
		 * or the one this query just opened). Each `session:seq` warms once, so
		 * sweeping the pointer across the list cannot queue a page per row.
		 * @param hit - one search hit.
		 */
		/** @param hit - one search hit. */
		function prefetch(hit) {
			if (hit === undefined || typeof hit.seq !== "number" || hit.seq < 0) return;
			if (state.pending !== null) return;
			const key = hit.sessionId + ":" + String(hit.seq);
			if (state.prefetched.has(key)) return;
			const face = sessionFaceOf(hit.sessionId);
			if (face === null || typeof face.loadThrough !== "function") return;
			if (typeof face.baseSeq === "number" && face.baseSeq <= hit.seq) return;
			state.prefetched.add(key);
			try {
				void face.loadThrough(hit.seq);
			}
			catch (error) {
				void error;
			}
		}

		/**
		 * Page history back until the chat view's window covers `seq`.
		 *
		 * `loadThrough(seq)` resolves immediately when the controller is not open
		 * yet — right after a session switch it usually is not — so one call is not
		 * enough for long histories. This retries, verifies real coverage through
		 * the face's own `baseSeq`/`hasMore`, and reports each round so the reader
		 * can see the jump is still working instead of stalled.
		 * @param sessionId - session that should be open.
		 * @param seq - event seq the chat has to reach.
		 * @param ticket - jump id; a superseded jump stops paging at once.
		 * @param onRound - progress callback, 1-based.
		 * @param stopped - returns true once the jump is decided, so the loader stops.
		 * @returns "covered" | "given" (cannot page further) | "stale".
		 */
		async function reachSeq(sessionId, seq, ticket, onRound, stopped) {
			let lastBase = null;
			for (let round = 1; round <= REACH_ROUNDS; round += 1) {
				if (state.jumpId !== ticket) return "stale";
				if (stopped !== undefined && stopped()) return "given";
				const face = sessionFaceOf(sessionId);
				if (face !== null) {
					const base = typeof face.baseSeq === "number" ? face.baseSeq : null;
					if (base !== null && base <= seq) return "covered";
					if (face.hasMore === false && base !== null) return "given";
					// No movement since the last round means the controller is still
					// opening or already busy: wait instead of queueing another page.
					if (base !== null && base === lastBase) {
						await sleep(POLL_MS * 3);
						continue;
					}
					if (face.openState === undefined || face.openState === "open") {
						if (onRound !== undefined) onRound(round);
						if (typeof face.loadThrough === "function") {
							try {
								await face.loadThrough(seq);
							}
							catch (error) {
								void error;
							}
						}
						lastBase = base;
						const after = sessionFaceOf(sessionId);
						if (after !== null && typeof after.baseSeq === "number" && after.baseSeq <= seq) return "covered";
					}
				}
				await sleep(POLL_MS * 2);
			}
			return state.jumpId === ticket ? "given" : "stale";
		}

		/**
		 * Open one hit's session and locate its message.
		 * @param index - index into the current hit list.
		 */
		async function choose(index) {
			const hit = state.items[index];
			if (hit === undefined) return false;
			// Any newer jump, search or close makes this one stale; it must not mark
			// late and make two hits look like they landed in the same place.
			const ticket = (state.jumpId += 1);
			const nodes = state.nodes;
			const needles = buildNeedles(hit.snippet);
			// A tool row hides its arguments until unfolded, so its snippet never
			// matches rendered text; the call id is the exact anchor instead.
			const callId = typeof hit.callId === "string" ? hit.callId : "";
			if (callId === "") {
				for (const term of splitTerms(state.query)) {
					if (term.length >= 2 && !needles.includes(term)) needles.push(term);
				}
			}
			const workspace = state.ctx?.uiWorkspace ?? state.ctx?.root?.uiWorkspace;
			if (workspace === undefined || typeof workspace.openSession !== "function") {
				toast(TEXT.noWorkspace);
				return false;
			}
			state.active = index;
			state.lastOpened = hit.sessionId;
			markActive();
			setCollapsed(true);
			updateNav();
			// Previous highlight belongs to another hit: drop it before repainting.
			clearHighlight();
			marks.session = hit.sessionId;
			// The panel stays open so the arrows can walk the remaining hits.
			if (nodes !== null) nodes.overlay.dataset.navigating = "true";
			setStatus(TEXT.jumping);
			try {
				workspace.openSession(hit.sessionId);
			}
			catch (error) {
				setStatus(TEXT.noopened + "：" + messageOf(error), "error");
				toast(TEXT.noopened + "：" + messageOf(error));
				return false;
			}
			// The sidebar re-renders after the switch; mark its row in the background.
			void markSidebar(hit.sessionId).then((row) => {
				if (state.jumpId !== ticket) return;
				if (row === null) toast(TEXT.sidebarMiss);
			});
			let announced = false;
			// A single loadThrough() right after the switch is a no-op (the
			// controller is not open yet), so the jump keeps re-asking in the
			// background while this loop waits for the text to appear.
			let reaching = null;
			// Set once this jump is decided; the background loader must then stop
			// narrating rounds over the final "located" status.
			let settled = false;
			const startReach = (attempt) => {
				// The first tick starts the loader immediately: waiting six ticks only
				// gave the chat view free time before the first page request.
				if (settled || hit.seq < 0 || reaching !== null) return;
				if (attempt !== 0 && attempt % REACH_EVERY !== 0) return;
				reaching = reachSeq(hit.sessionId, hit.seq, ticket, (round) => {
					if (settled || state.jumpId !== ticket) return;
					setStatus(TEXT.revealRound(round, REACH_ROUNDS));
				}, () => settled).then((outcome) => {
					reaching = null;
					return outcome;
				}, () => {
					reaching = null;
					return "given";
				});
				void reaching;
			};
			for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
				const watched = chatRoot();
				await (watched === undefined ? sleep(POLL_MS) : waitForChange(watched, POLL_MS));
				if (state.jumpId !== ticket) return false;
				startReach(attempt);
				if (!announced && attempt === 12) {
					announced = true;
					setStatus(TEXT.locatingLong);
				}
				const root = chatRoot();
				if (root === undefined) continue;
				const row = callId === "" ? null : callRowOf(root, callId);
				if (row !== null && await focusTarget(row, root)) {
					if (state.jumpId !== ticket) return false;
					state.claims.add(row);
					settled = true;
					setStatus(TEXT.located(index + 1, state.items.length));
					return true;
				}
				// The turn is a wider anchor than text: a folded tool output renders
				// no text node at all, yet its turn row is on screen and correct.
				const turned = turnRowOf(root, hit.turn);
				if (turned !== null) {
					const inner = findMatch(turned, needles, undefined);
					if (await focusTarget(inner ?? turned, root)) {
						if (state.jumpId !== ticket) return false;
						settled = true;
					setStatus(TEXT.located(index + 1, state.items.length));
						return true;
					}
				}
				const target = findMatch(root, needles, state.claims);
				if (target !== null && await focusTarget(target, root)) {
					if (state.jumpId !== ticket) return false;
					state.claims.add(target);
					settled = true;
					setStatus(TEXT.located(index + 1, state.items.length));
					return true;
				}
				// Only fall back to "scroll to the top and hope" when the chat view
				// exposed no session face; otherwise real paging is already running.
				const paging = sessionFaceOf(hit.sessionId) !== null;
				if (!paging && attempt >= ATTEMPTS_BEFORE_SCROLL && (attempt - ATTEMPTS_BEFORE_SCROLL) % 16 === 0) {
					await loadEarlier(root);
				}
			}
			settled = true;
			setStatus(TEXT.notRendered);
			toast(TEXT.notRendered);
			return false;
		}

		/**
		 * Walk to the next or previous hit while keeping the search box open.
		 * @param delta - +1 for the next hit, -1 for the previous one.
		 */
		async function step(delta) {
			if (state.items.length === 0) {
				toast(TEXT.empty);
				return;
			}
			let next = state.active + delta;
			if (next >= state.items.length && state.hasOlder) {
				await runSearch(state.query, true);
				if (next >= state.items.length) next = state.items.length - 1;
			}
			next = Math.max(0, Math.min(state.items.length - 1, next));
			if (next === state.active && delta !== 0) {
				updateNav();
				return;
			}
			await choose(next);
		}

		/**
		 * Fold the result list away so the located message is not hidden behind the panel.
		 * @param value - true to keep only the input, status and arrows on screen.
		 */
		function setCollapsed(value) {
			state.collapsed = value === true;
			const nodes = state.nodes;
			if (nodes === null) return;
			if (nodes.panel !== null) nodes.panel.dataset.collapsed = state.collapsed ? "true" : "false";
			// Only the navigating state ever docks the panel at the bottom; leaving it would
			// make the next full search open somewhere unexpected.
			if (nodes.panel !== null && state.collapsed === false) delete nodes.panel.dataset.docked;
			if (nodes.toggle !== null) nodes.toggle.textContent = state.collapsed ? TEXT.expandList : TEXT.collapseList;
		}

		/** Repaint the position counter and the arrow disabled states. */
		function updateNav() {
			const nodes = state.nodes;
			if (nodes === null) return;
			const total = state.items.length;
			const position = total === 0 || state.active < 0 ? 0 : state.active + 1;
			if (nodes.navCount !== null) {
				nodes.navCount.textContent = total === 0 ? "" : String(position) + " / " + String(total);
			}
			if (nodes.navPrev !== null) nodes.navPrev.disabled = total === 0 || state.active <= 0;
			if (nodes.navNext !== null) nodes.navNext.disabled = total === 0 || (state.active >= total - 1 && state.hasOlder === false);
		}

		/** Page-wide keyboard: Ctrl/Cmd+Shift+F opens, Esc closes. */
		function onDocumentKeydown(event) {
			const withModifier = (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey;
			if (withModifier && (event.key === "F" || event.key === "f")) {
				event.preventDefault();
				toggle();
				return;
			}
			if (event.key === "Escape" && isOpen()) {
				// First Escape hides the history list; a second one closes the panel.
				const box = state.nodes?.history;
				if (box?.dataset.open === "true") {
					event.preventDefault();
					event.stopPropagation();
					state.historyHidden = true;
					renderHistory();
					// The browser drops focus onto <body> once the focused item is
					// hidden, so re-focus the box on the next task.
					const target = state.nodes?.input;
					if (target !== undefined && target !== null) {
						window.setTimeout(() => { target.focus(); }, 0);
					}
					return;
				}
				event.preventDefault();
				close();
				return;
			}
			if (event.key === "F3" && isOpen()) {
				event.preventDefault();
				void step(event.shiftKey ? -1 : 1);
				return;
			}
			// Arrow keys and Enter belong to the opacity slider while it has focus.
			const target = event.target;
			if (target instanceof Element && target.closest(".sf-alpha") !== null) return;
		}

		/** Client services this plugin reads. */
		const inject = ["sessions", "uiWorkspace"];

		/**
		 * Mount the overlay for the lifetime of the plugin.
		 * @param ctx - client plugin context.
		 */
		function apply(ctx) {
			state.ctx = ctx;
			ctx.effect(() => {
				if (typeof document === "undefined") return () => {};
				mount();
				const onResize = () => { restoreTrigger(false); };
				window.addEventListener("resize", onResize);
				document.addEventListener("keydown", onDocumentKeydown, true);
				return () => {
					window.removeEventListener("resize", onResize);
					document.removeEventListener("keydown", onDocumentKeydown, true);
					close();
					for (const element of [document.getElementById(ROOT_ID), document.getElementById(ROOT_ID + "-trigger"), document.getElementById(ROOT_ID + "-toast")]) {
						if (element !== null) element.remove();
					}
					state.nodes = null;
					state.items = [];
					state.query = "";
				};
			}, "session-finder: overlay");
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.buildNeedles = buildNeedles;
		exports.normalizeText = normalizeText;
		exports.finderState = state;
		exports.open = open;
		exports.close = close;
		return module.exports;
	}
});