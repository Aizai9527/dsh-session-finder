# dsh-session-finder v0.7.2（2026-10-30）

[English](README.en.md) · **中文**

跨会话搜索 DSH 聊天记录，并**跳转到命中的那条消息**。

DSH 自带的搜索会打开会话但不滚动到命中位置，因为搜索响应里只有 `{ sessionId, snippet }`，没有事件坐标。这个插件补上最后一跳：打开会话后，用命中片段在已渲染的聊天 DOM 里找回那条消息，展开折叠节点、滚到视口中间并高亮几秒。

插件自带搜索通道，不走宿主 `sessions.search`——部分部署把会话索引配成 `openAt: "never"`，那条 RPC 一律报 `SESSION_QUERY_SEARCH_DISABLED`；改为在宿主半通过 `ctx.sessionPersistence` 直接读会话日志。

提取结果按「会话 id + revision」缓存在内存与 `~/.dsh/cache/dsh-session-finder`，启动后在空闲时预热，宽范围搜索不必每次重读几十 M 字符；命中后由会话视图自己的 `ISession.loadThrough(seq)` 把内容加载出来再定位。细节见下文「行为边界」，各版本改了什么见文末「版本」。

## 安装

```powershell
# 从 npm
dsh plugin add dsh-session-finder

# 或直接从 GitHub
dsh plugin add github:Aizai9527/dsh-session-finder
```

装完重启桌面端：宿主半与客户端半都在启动时加载。仓库没有构建步骤，`lib/*.js` 就是分发产物。已在 DSH 插件市场（`awesome-dsh-plugin` 清单）登记。

本机目前是 `link` 安装（`C:\Users\Admin\.dsh\profiles\desktop` 的 `dependencies.dsh-session-finder` + `dsh.profile.bundles`）。**在插件市场里安装/更新任意插件可能把这两项摘掉**，插件随即从界面消失，此时跑 `.\relink.ps1 -Check` 体检、`.\relink.ps1` 修复。改 `package.json` 不要用会写 BOM 的方式（PowerShell 5.1 的 `Set-Content -Encoding utf8` 会），市场读清单不剥 BOM，只会报「包不可用」。

## 用法

1. `Ctrl+Shift+F`（macOS 为 `Cmd+Shift+F`），或点右下角按钮；按钮可按住拖到任意位置并记住。
2. 输入至少 2 个字符；多个关键词用空格分隔（要求同时出现），完全连写的短语排在同会话最前。
3. 底部「搜索范围」：**当前会话**（默认，跟随左侧选中行或上次跳转到的会话）、全部会话、或某个项目，切换即用当前关键词重搜。
4. 结果按消息列出，含角色、时间与命中片段；同一会话最多 3 条，用户消息 > 助手回复 > 工具调用。
5. `↑` `↓` 选择，`Enter` 定位；`Esc` 先收起历史列表，再按一次关闭浮层。
6. 定位后面板自动收成导航条，不挡内容：`↑ 上一处` / `↓ 下一处`、`F3` / `Shift+F3`、`Alt+↑` / `Alt+↓` 继续跳；到本页末尾且还有更早会话时自动续页。
7. 命中的消息块与其内的命中文字各有一层描边，左侧列表对应的会话行也会被标出（折叠分组会先自动展开）；标记保留到下次跳转或关闭浮层。
8. 每个会话最多索引 8 M 字符；本页没有命中会自动读更早一页（最多 4 页 / 20 秒），全都没有才说「没有命中」。
9. 输入框为空时列出最近 10 次查询：点一条重搜，`↑` `↓` 移动、`Enter` 取用，底部「清空历史」清空全部。
10. 底部「不透明度」可调 45%–100%（默认 100%），设置会记住。
11. 状态行末尾显示本次查询耗时（如 `· 用时 0.13 s`），据此判断是缓存冷启动还是别的问题。
12. 面板最底部一行是 **GitHub**、**问题反馈**、**检查更新** 三个按钮，右侧显示当前版本；「检查更新」只读仓库里的 `package.json`，不碰限流接口。

## 行为边界

- **只读会话，只写自己的缓存**：会话以 `read` 句柄打开，不写会话文件。提取结果按「会话 id + revision」缓存在宿主内存（≤64 M 字符）与 `~/.dsh/cache/dsh-session-finder`（gzip、≤240 个文件、按 mtime 淘汰）；`DSH_SESSION_FINDER_NO_DISK=1` 关闭磁盘缓存。
- **只索引看得见的文字**：`user/message`、`assistant/message` 仅取 `type: "text"` 块；不索引 `reasoning`、流式分块、`system/message`、`developer/message`。工具只索引名称、参数与输出文本，注入的 `<system-reminder>` 整块删除。
- **范围有界**：每页最新 150 个会话、每会话 3 条、共 40 条、2.5 秒、6 个会话并发。触顶时状态行提示「已到单次上限」，`nextOffset` 从触顶会话之后继续；选了范围先在宿主侧过滤再分页。
- **跳转靠会话自己的加载器**：命中未渲染时取 `ctx.sessions.binding(id).session.loadThrough(seq)`，反复加载直到 `baseSeq <= seq`，无进展就等待；跳转落定后后台停止。拿不到绑定则退回「滚到顶部 + 提示再点一次」。
- **三级锚点，由准到宽**：工具命中用 `data-chat-call-id`，其次用 `data-chat-turn` 落到那一轮，最后才按片段文字匹配。同一查询内已用过的行不重复占用，宁可报「还没渲染出来」也不乱跳。
- **历史只存查询串**：`localStorage` 的 `dsh-session-finder:history` 最多 10 条文本，不含会话 id、命中内容或时间，渲染走 `textContent`。

## 结构

| 文件 | 职责 |
| --- | --- |
| `lib/index.js` | 宿主半：只读路由 `GET /session-finder/search?q=&offset=[&sessionId=\|&cwd=]`、并发打分、分页、空闲预热 |
| `lib/search.js` | 宿主半纯函数：按事件提取可见文本、剔除注入块、片段切分、内存 + 磁盘缓存 |
| `lib/client.js` | 浏览器半：浮层、范围下拉、搜索历史、结果列表、`loadThrough` 跳转与描边 |
| `test/*.test.mjs` | 10 组检查：needles、search、route、client-inject/nav/target/paging/scope/anchor/history |
| `test/fixture.html` | 浏览器半人工回归页（假聊天 DOM，含折叠、重复文本、工具行、轮次行） |
| `relink.ps1` | 被市场更新摘掉后恢复本地 link 挂载 |
| `cordis.patch.yml` | 插入 `session-finder` 行的 bundle patch |

## 自检

```powershell
npm run check   # node --check 三个入口
npm test        # 96 项检查
```

浏览器半的人工回归用 `test/fixture.html`（不依赖真实 DSH，直接打开即可）；各版本回归截图在 `docs/`。

## 版本

迭代发生在 2026-10-29 至 2026-10-30，按新到旧排列。

| 版本 | 变更 |
| --- | --- |
| v0.7.2 | 面板底部加 GitHub、问题反馈、检查更新三个按钮，右侧显示当前版本。 |
| v0.7.1 | 状态行显示查询耗时；行的历史预热改为指针停顿 400ms 后才触发（搜索进行中不预热），避免悬停与搜索互相抢 CPU；启动预热提前到 1.5 s 并逐会话让出事件循环，已缓存会话直接跳过。 |
| v0.7.0 | 缓存落盘与空闲预热，2.5 秒／150 会话／6 并发，定位去白等；宽范围 10.2 s → 1.7 s |
| v0.6.1 | `reachSeq()` 反复 `loadThrough` 到 `baseSeq <= seq`；新增 `turn` 锚点 |
| v0.6.0 | 搜索历史：最近 10 条、`↑↓`／`Enter`、清空，`Esc` 分两段 |
| v0.5.1 | 工具命中按 `callId` 锚定；同一查询不重复占行 |
| v0.5.0 | `loadThrough(seq)` 跳转、搜索范围、面板拖动 |
| v0.4.4 | 单会话上限 400k → 8M；无命中自动续读更早页 |
| v0.4.3 | 左侧会话行标记，折叠分组自动展开 |
| v0.4.2 | 高亮保留到下次跳转；`clearHighlight()` 统一清除 |
| v0.4.1 | 导航态收起为导航条；两轮避让校正 |
| v0.4.0 | 定位后不关浮层，改导航态与上下处 |
| v0.3.3 | 修面板染色与「点结果不跳转」 |
| v0.3.2 | 不透明度滑块；按底色亮度选前景色 |
| v0.3.1 | 按钮移到右下角可拖动；修 BOM「包不可用」 |
| v0.3.0 | 只索引可见文本；多关键词 AND；分页 |
| v0.2.0 | 改自建宿主路由，绕开被禁用的 `sessions.search` |
| v0.1.0 | 首版：搜索、打开会话、按片段定位 |

## 许可

MIT，见 [LICENSE](LICENSE)。
