---
name: js-deepseek-ops-skill
description: DeepSeek Chat 内容只读 + 浏览器导航 skill：登录态 / 历史会话列表 / 单会话历史 / chat 页深度只读（消息元数据 / 单条消息 / 流式状态 / 设置快照），全部走 chat.deepseek.com 内部 JSON 端点，浏览器侧仅 location.assign 改 URL；私聊正文默认 redact=off（仅出 sha256 摘要），composer 草稿原文绝不返回。
version: 0.2.0
metadata:
  openclaw:
    emoji: "\U0001F9E0"
    homepage: https://github.com/imjszhang/js-eyes
    requires:
      skills:
        - js-eyes
      bins:
        - node
    platforms:
      - chat.deepseek.com
---

# js-deepseek-ops-skill

面向 `chat.deepseek.com` 的**只读 + 仅改自身浏览器 URL**的 skill，对标 [`js-reddit-ops-skill`](../js-reddit-ops-skill/SKILL.md) 的 `PAGE_PROFILES + Bridges + Session` 架构，但因 DeepSeek 是对话 SaaS、数据私密度更高，安全 / 隐私设定比 reddit 严：

- **数据获取**：bridge 内 `fetch('/api/v0/...', { credentials:'include' })` + `Authorization: Bearer <token>`（token 从 `localStorage.userToken` 读）。所有 READ 工具走同源接口，复用浏览器登录态
- **隐私加固**：DeepSeek 会话内容是用户私聊；本 skill 默认 `redact=off`，`messages[].content` / `thinkingContent` 在返回前替换为 `{length, sha256}` 摘要。需要原文必须显式 `--redact full --debug-recording`
- **不做 cache**：reddit skill 的 `lib/cache.js` 没有复刻；私密数据不应落盘到 cache
- **流式 SSE 不订阅**：bridge 永不挂 `EventSource` / `addEventListener('message')`
- **安全分级**：只做 READ + INTERACTIVE 两档，**永不**做 DESTRUCTIVE（不发消息 / 不切模型 / 不删会话 / 不上传文件 / 不创建 API key）

## 依赖与前置

- **JS Eyes Server**：已启动（`js-eyes server start`）
- **浏览器扩展**：已安装并连上 server
- **登录态**：浏览器里已经人工登录 `chat.deepseek.com`（本 skill 不做任何登录自动化）；`userToken` 必须在 localStorage 里有效，否则所有接口会被 401
- **任意 chat.deepseek.com tab 即可**：READ 工具默认 `navigateOnReuse=false / reuseAnyDeepseekTab=true`，bridge 在任意 chat.deepseek.com tab 里 fetch 同源 JSON 端点；用户当前 tab 不会被切走
- **双侧 `allowRawEval`**：bridge 首次注入会走一次 `bot.executeScript(rawSource)`；之后每次工具调用只执行 `window.__jse_deepseek_*__.<method>()`
  - 宿主：`~/.js-eyes/config/config.json` 里 `security.allowRawEval: true`
  - 扩展：js-eyes 扩展 popup 里 `Allow Raw Eval` 打开
  - 少一侧会返回 `RAW_EVAL_DISABLED`

## 安全红线（READ / INTERACTIVE / DESTRUCTIVE）

本 skill 的所有工具都会被归入以下三档之一。审计界线按「是否改 DeepSeek 业务数据 / 是否扣 token / 是否改账户配置」来划：

### READ（默认档）

纯读，不改任何 DOM、不改 URL、不触发任何业务写操作。

- 走 `fetchDeepseekJson(path, options)` 调 DeepSeek 同源 JSON 端点（GET，复用浏览器同源 cookie + Bearer）
- 工具：`deepseek_session_state` / `deepseek_list_sessions` / `deepseek_get_session`
- `get_session` 默认 `redact='off'`：返回结果里 `messages[].content` 是 `null`，配合 `contentHash` (sha256) + `contentLength` 一起出，避免私聊正文被 LLM / 日志看到

### INTERACTIVE

**只改浏览器自己的 URL**，不改 DeepSeek 侧任何业务数据。实现硬约束：

- 仅 `location.assign(newUrl)`，**禁止模拟点击任何 DOM CTA**
- bridge 端 `navigateLocation()` 拒绝跨域 URL（必须是 `*.deepseek.com`）
- 调用返回 `{from, to, hint}`，CLI 端 `awaitBridgeAfterNav` 重注 bridge + state 自校验
- `skill.contract.js` 里带 `interactive: true` / `destructive: false`
- 工具：`deepseek_navigate_home` / `deepseek_navigate_session`

### DESTRUCTIVE（永不做）

任何改 DeepSeek 业务数据 / 触发账户变更 / 扣 token 的操作，从 v0.1 起一直不会做：

- **发消息相关**：不发消息（`/api/v0/chat/completion`）/ 不重新生成 / 不停止流（`stop_stream`）/ 不编辑用户消息（`edit_message`）/ 不创建 PoW 挑战
- **会话管理**：不创建（`chat_session/create`）/ 不删除 / 不重命名 / 不归档 / 不置顶
- **设置与开关**：**不切换模型 / 不开关"深度思考" / 不开关"联网搜索"**——这些 toggle 改的是下一次请求语义和计费模型，所以归入 DESTRUCTIVE 而不是 INTERACTIVE
- **附件 / API key**：不上传文件 / 不创建 / 撤销 API key / 不改账户设置（昵称、密码、订阅、绑定）
- **登录自动化**：不实现登录自动化 / 不注入 cookie / 不伪造 token
- **数据导出**：不主动批量拉所有会话正文落盘（业务脚本 `dump-session.js` 只在 v0.3 路线图，且要显式 `--allow-raw-output`）
- **composer 草稿原文**：v0.2 起 `chat_page_state` 只回 composer 的 `{length, sha256, present}`，**永不**返回原文（草稿可能含密码 / 邮箱 / 未发布 prompt）
- **跨会话 messageId 引用**：`get_message` 强校验 `sessionId` 与当前 URL 一致，避免借 chat 页拉别的会话的消息

如果未来真的要做某个 DESTRUCTIVE，将在 `skill.contract.js` 里把该工具标记 `destructive: true`，并要求调用方显式 `--confirm` 走 Safe Default Mode consent 流程。

## 提供的 AI 工具

| 档位 | 工具 | 页面 | 说明 |
|---|---|---|---|
| READ | `deepseek_session_state` | 任意 deepseek tab | 登录态：`/api/v0/users/current` 优先 + DOM 兜底，回 `{loggedIn, name, userId, mobile?, email?, picture, ...}` |
| READ | `deepseek_list_sessions` | `/` | 列出历史会话；`limit` 默认 25 / 上限 100，`beforeSeqId` 游标分页；返回 `{ items[]:{id,title,modelType,updatedAt,createdAt,...}, hasMore, cursor }` |
| READ | `deepseek_get_session` | `/a/chat/s/<id>` | 单会话历史消息；`sessionId` 必填，`limit` 保留最近 N 条，`redact` ∈ `off`/`trunc`/`full`（默认 off）；返回 `{ session, messages[]:{messageId,role,content,contentHash,contentLength,thinkingContent,...}, redact:{mode,...} }` |
| READ | `deepseek_chat_page_state` | `/a/chat/s/<id>` | chat 页 UI 状态快照：`{onChatPage, sessionId, title, composer:{length,sha256,present}, streamingDom, scrollAtBottom, visibleMessageCount}`；composer 草稿原文绝不返回 |
| READ | `deepseek_list_messages` | `/a/chat/s/<id>` | 当前会话消息**元数据**列表；`sessionId` 必填；返回 `{ session, messages[]:{messageId, role, status, contentLength, contentHash, hasThinking, thinkingContentLength, files, ...} }`，**永不出 content / thinkingContent 正文** |
| READ | `deepseek_get_message` | `/a/chat/s/<id>` | 单条消息详情；`sessionId + messageId` 必填，`redact` 政策与 `get_session` 一致；强校验 `sessionId` 与当前 URL 一致 |
| READ | `deepseek_streaming_status` | `/a/chat/s/<id>` | 一次性观察 assistant 是否在产出（API status + DOM 双侧确认）；返回 `{streaming, currentMessageId, role, lastUpdatedAt}`；**不订阅 SSE / 无任何 listener / 无内容** |
| READ | `deepseek_chat_settings_view` | 任意 deepseek tab | 只读 `/api/v0/client/settings?scope=main\|model`，回 model 列表 / feature flags / 默认 toggle 状态；`readOnly: true`，永不写 |
| INTERACTIVE | `deepseek_navigate_home` | `/` | 仅 `location.assign` 跳到主页 |
| INTERACTIVE | `deepseek_navigate_session` | `/a/chat/s/<id>` | 仅 `location.assign` 跳到指定会话 |
| INTERACTIVE | `deepseek_navigate_new_chat` | `/` | 仅 `location.assign` 起新对话；不调用 `chat_session/create`，DeepSeek 是首次发消息才落 sessionId，本调用无副作用 |

全部工具都是 `optional: true`（按需加载），入参详见 `skill.contract.js::TOOL_DEFINITIONS`。

### 内部踩点 CLI（不进 `skill.contract.js`，仅供本仓库开发者排查）

下面两条只在 CLI 暴露、不暴露给 AI tool 列表，用于改版后定位 DOM 结构变化或抓 XHR 形态：

| CLI | 用途 |
|---|---|
| `node index.js dom-dump [--anchors] [--limit N]` | 一次性 snapshot 当前 deepseek tab 上的关键 DOM 节点（`[data-testid]` / `[role=listitem]` / `nav` / `aside` / `a[href*="/a/chat/s/"]`），输出 tag/id/class/testid + text outline；`--anchors` 加所有 `a[href]` |
| `node index.js xhr-log [--filter <regex>] [--limit N]` | 读 `performance.getEntriesByType('resource')`，过滤 `deepseek.com` 命中条目，按 pathname 聚合；不写 listener / 不挂 hook，纯读浏览器 buffer |

这两条不写 listener、不挂 hook，纯靠浏览器内置 buffer，可放心反复跑。

## CLI

```bash
cd /Volumes/home_x/github/my/js-deepseek-ops-skill
npm install

# 通路 + 登录态 + bridge 注入 + probe + state 一站诊断
node index.js doctor

# READ：登录态
node index.js session-state

# READ：历史会话列表
node index.js list-sessions --limit 25 --pretty
node index.js list-sessions --limit 25 --before 199549139   # 翻页

# READ：单会话历史（默认 redact=off，正文以 sha256 摘要呈现）
node index.js get-session <sessionId> --limit 20 --pretty
node index.js get-session <sessionId> --limit 50 --redact trunc --trunc-len 200 --pretty
node index.js get-session <sessionId> --redact full --debug-recording   # 显式拿原文

# READ：chat 页深度只读（v0.2+）
node index.js chat-page-state --pretty                                  # composer 仅 sha256
node index.js list-messages <sessionId> --limit 20 --pretty             # 永不出正文
node index.js get-message <sessionId> <messageId> --pretty              # 默认 redact=off
node index.js get-message <sessionId> <messageId> --redact trunc --trunc-len 200
node index.js streaming-status                                          # 一次性观察，不订阅 SSE
node index.js chat-settings-view --scope main --pretty                  # 只读 model 列表
node index.js chat-settings-view --scope model --pretty

# INTERACTIVE：仅 location.assign，不模拟点击
node index.js navigate-home
node index.js navigate-session <sessionId>
node index.js navigate-new-chat                                         # 起新对话（无副作用）

# 内部踩点（仅本仓库开发者用）
node index.js dom-dump --limit 80
node index.js xhr-log --filter "deepseek\\.com/api" --limit 200

# 也可通过 js-eyes 统一入口
js-eyes skill run js-deepseek-ops-skill doctor
```

## 架构概要

```text
CLI / AI Tool call
  └── skill.contract.js  (createRuntime / TOOL_DEFINITIONS)
        ├── lib/runTool.js      READ 工具入口（history + debug bundle，不走 cache；有 transformResult hook）
        ├── lib/redact.js       deepseek_get_session 专用：messages[].content -> {length, sha256}
        └── lib/session.js      Session（connect → resolveTarget → ensureBridge → callApi）
              ├── lib/config.js          PAGE_PROFILES + DEFAULT_WS_ENDPOINT
              ├── lib/js-eyes-client.js  BrowserAutomation
              └── bridges/*-bridge.js    + bridges/common.js (@@include)
                      └── fetchDeepseekJson('/api/v0/...')
```

### Page profiles

| profile | targetUrlFragment | bridgeGlobal | bridgePath |
|---|---|---|---|
| `home` | `chat.deepseek.com/` （根路径） | `__jse_deepseek_home__` | `bridges/home-bridge.js` |
| `chat` | `chat.deepseek.com/a/chat/s/<uuid>` | `__jse_deepseek_chat__` | `bridges/chat-bridge.js` |

URL 片段重叠由 `pickTabMatchingFragment` 评分函数解决；每个 profile 给自己最贴切的 path 加 +500 分，`is_active` 加 +1000。

### Bridge 热更新

每个 bridge 顶部维护 `const VERSION = 'x.y.z'`。`session.ensureBridge()` 会读当前 bridge 的 `__meta.version`，不一致时重注。共享 helpers 写在 `bridges/common.js`，通过 `// @@include ./common.js` 在注入前内联（不是运行时 require），所以所有 helpers 仍然是纯浏览器 JS。

每个 bridge 都暴露 `__meta = { version, name }` / `probe()` / `state()` / `sessionState()` / `navigateXxx()` 五件套，加上各自的 READ 主方法。

### 大响应保护与登录态判定

- **登录态**：`readMeViaApi()` 优先走 `/api/v0/users/current`；超时或非 JSON 时回退 `readLoginStateDom()`（DOM 看 `img[src*="/user-avatar/"]`）。任一失败返回 `{loggedIn:false}`，**绝不抛错**
- **会话列表分页**：`limit` 默认 25 / 上限 100，`beforeSeqId` 游标；返回 `{ items, hasMore, returnedCount, cursor }`
- **单会话消息**：`limit` 不传不截，传则保留最近 N 条；正文 bridge 端有 `contentMaxLen` 默认 60000 的硬上限（防 SSE 残留 chunk 巨长）
- **正文 redact**：bridge 端先做硬上限截断；Node 端 `lib/redact.js` 在写 debug bundle / 构造对外响应前再套一次政策（off/trunc/full）；history.jsonl 不写正文字段
- **非 JSON 响应**：bridge 端只回 `{_nonJson:true, contentType, text:snippet, truncated, length}`，避免大 HTML 跨进程传递

### 为什么 redact 默认 off

- DeepSeek 会话正文很容易包含工作 / 学习 / 个人秘密，不应在 LLM 上下文 / 终端 stdout / debug bundle / history.jsonl 里随便流通
- `off` 仍然能让上层 LLM 知道"有 N 条消息、role 分布如何、token 用量、思考过程开关、消息长度"——足够回答"我最近在和 DeepSeek 聊什么"这类**摘要类**问题
- 真要看具体正文，必须用户显式 `--redact full --debug-recording` 二选一组合，等同于显式承诺"我接受这次正文落盘"

## 启用方式

1. `cd /Volumes/home_x/github/my/js-deepseek-ops-skill && npm install`
2. `js-eyes skills link /Volumes/home_x/github/my/js-deepseek-ops-skill`
   - 会追加到 `~/.js-eyes/config/config.json` 的 `extraSkillDirs`
   - 会把 `skillsEnabled["js-deepseek-ops-skill"] = true`
3. `js-eyes skills reload`（OpenClaw 插件 300ms 内热载）
4. `js-eyes skills list` 应看到 `Source: extra (...skills/js-deepseek-ops-skill)`
5. **浏览器里已登录 `chat.deepseek.com`**（READ 默认不会切走当前 tab；INTERACTIVE 会主动切到目标 URL）
6. `js-eyes doctor` 确认整体安全态

卸载：`js-eyes skills unlink /Volumes/home_x/github/my/js-deepseek-ops-skill`

## 明确不做的事

这些是 skill 在任何版本都不会做的事（DESTRUCTIVE 档位），避免后续补能力时跑偏：

- 不发消息（`POST /api/v0/chat/completion`）/ 不停止流（`stop_stream`）/ 不重新生成 / 不编辑用户消息（`edit_message`）
- 不创建 / 不删除 / 不重命名 / 不归档 / 不置顶 / 不分享会话
- 不切换模型 / 不开关"深度思考" / 不开关"联网搜索" toggle
- 不上传文件 / 附件 / 不创建 / 撤销 API key / 不改账户设置（昵称、密码、订阅、绑定、邮箱、手机）
- 不模拟点击任何 DOM CTA；所有 INTERACTIVE 都走 `location.assign`
- 不实现 OAuth / 验证码登录自动化、不注入 cookie、不伪造 Authorization Bearer
- 不订阅 SSE / EventSource / chat completion stream
- 不主动批量导出所有会话正文（v0.3 单会话导出脚本要显式 `--allow-raw-output`，且默认仍 redact）
- 不使用未在浏览器里实际发生过的 XHR 端点；改版前先用 `xhr-log` / `dom-dump` 踩点

## 路线图

> 历史版本变更与根因复盘见 [CHANGELOG.md](CHANGELOG.md)。

- **v0.2（当前版本）**：chat 页深度只读 —— 在不新增 page profile、不破任何安全红线的前提下，把 `chat-bridge` 扩成"五件套 + 1 INTERACTIVE 别名"：`chat_page_state` / `list_messages` / `get_message` / `streaming_status` / `chat_settings_view` + `navigate_new_chat`；`lib/redact.js` 加 `buildGetMessageTransform` + `buildListMessagesTransform`（防漏断言）；`bridges/common.js` 加 5 个纯浏览器 helper（含 `digestText` 给 composer 做 sha256 摘要）；composer 草稿原文写进"永不返回"红线
- **v0.3（计划）**：细粒度提取 —— `extract_citations`（公开 URL，可不 redact）/ `extract_code_blocks`（默认 sha，`--reveal-code` 才出）/ `list_attachments`（永不下载）/ `thinking_meta`；接 `safety:'sensitive-read'` 中间档 hook 进 OpenClaw consent
- **v0.4（计划）**：DOM/API 双路径裁剪版 —— 仅给 `get_message` / `list_messages` 加 DOM-fallback（API 401/风控时降级），response 加 `usedMethod / fallback / triedMethods`；`scripts/_dev/diff-schema.js` schema 退化检测
- **v0.5（计划）**：业务脚本 `scripts/aggregate-sessions.js`（仅 metadata）/ `scripts/dump-session.js <id>`（默认 redact，`--allow-raw-output` 才出原文）；`scripts/_templates/`
- **v0.6（计划）**：visual / 录像（chat 页强制 mask 模式）；`navigate_session_anchor` 加 `awaitBridgeAfterNav` 锚点等待
- **永不做**：见「明确不做的事」

## Recording

`js-deepseek-ops-skill` 全程接入 `@js-eyes/skill-recording`，每次工具调用都进 history + debug 流水（**不走 cache**——私密数据不应落 cache）。

- 默认记录模式跟随 `js-eyes` 全局配置中的 `recording.mode`
- 可通过 CLI 覆盖：
  - `--recording-mode off|history|standard|debug`
  - `--debug-recording`（这是 `--redact full` 生效的硬前提）
  - `--recording-base-dir /absolute/path`
  - `--run-id custom-id`

默认按技能分目录落盘到 `~/.js-eyes/skill-records/js-deepseek-ops-skill/`：

- `history/`：按月滚动的 `tool_calls.jsonl`（**不写正文字段**，只记 metadata）
- `debug/`：调试模式下的步骤时间线、target / bridge meta 与 result 快照（**正文已被 redact 处理**）
- 该目录建议加进 `~/.gitignore_global`，避免误提交

## 故障排查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| `E_NO_TAB` | 浏览器没打开任何 chat.deepseek.com tab | 在浏览器里打开 `https://chat.deepseek.com/`；CLI 的 INTERACTIVE 命令默认会自动开新 tab，READ 命令带 `createIfMissing=true` 也会兜底 |
| `RAW_EVAL_DISABLED` | 一侧 `allowRawEval=false` | 宿主 `~/.js-eyes/config/config.json` 的 `security.allowRawEval` + 扩展 popup 的 `Allow Raw Eval` 都要打开 |
| `not_logged_in`（list-sessions / get-session） | 未登录或 `userToken` 过期 | 在浏览器里重新登录 deepseek；或先跑 `node index.js session-state` 自检 |
| `fetch_failed`（httpStatus=401） | Bearer 不带 / 失效 | 浏览器里点一下任意会话触发 token 刷新；如仍失败重新登录 |
| `session_not_found`（httpStatus=404） | 会话已被删除 / id 拼错 | 用 `list-sessions` 取最新 id 再试 |
| `message_not_found`（get-message） | messageId 不在该 sessionId 内 | 先跑 `list-messages <sid>` 看真实 messageId 列表 |
| `session_id_mismatch`（get-message） | 传入 sessionId 与当前 chat 页 URL 不一致 | 要么先 `navigate-session <sid>`，要么省略 sessionId 让 bridge 从 URL 解析 |
| `missing_device_id`（chat-settings-view） | `localStorage.__ds_remote_feature_did` 未设置 | 在浏览器里完整打开过任一 chat 页即可（DeepSeek 会自动写入） |
| `chat_settings_view` 永远返回 `biz_error: SETTINGS_NOT_FOUND` | 扩展 isolated world fetch 被 DeepSeek 当 anonymous 处理（同 reddit v3.6.1 cookie partitioning） | 已知限制，本 skill 不为此引入 page-world 注入；浏览器自身访问该接口仍能拿到 11.7KB model 列表，可临时手动看；未来若需要将做 v0.4 DOM-fallback 路径 |
| `cross_origin_navigation_forbidden` | INTERACTIVE 调用传了非 deepseek.com URL | 这是硬约束（`navigateLocation` 拒绝跨域）；只能传 `*.deepseek.com` |
| `bridge_not_installed` / `method_not_found` | bridge VERSION 可能未 bump | 改 bridge 后 bump VERSION，CLI 会自动重注；或 `JS_DEEPSEEK_DEBUG=1 node index.js probe -v` 看注入流程 |
| 正文返回为 null 但 contentHash 有值 | 正常：`redact=off`（默认） | 想看原文显式 `--redact trunc` 或 `--redact full --debug-recording` |
| `redact: full` 实际生效成 `trunc` | 没加 `--debug-recording` | 这是隐私默认：非 debug 模式拒绝 full；要么加 `--debug-recording`，要么接受 trunc |
| `awaitBridgeAfterNav` 超时 | navigate 之后页面 reload 慢 / state 长时间不 ready | 增大 `--verbose` 看 stderr；或先 `node index.js state` 看当前 bridge state.ready 字段 |
| 单会话 history_messages 返回不完整 | DeepSeek 端可能只返回最新 N 条 | v0.1 不实现 message 分页（业务里很少需要超过 200 条）；如必要请通过浏览器 UI 滚动加载 |
