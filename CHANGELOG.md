# Changelog

本仓库的版本历史与根因索引。SKILL.md 只保留前向规划，所有"已发生"的变更与事故复盘都迁到这里。

## v0.2.1 — `chat_settings_view` did 参数 + 已知限制

联机烟测发现 `/api/v0/client/settings` 实际请求需要 `did=<deviceId>` 参数（`xhr-log` 抓出真实形态），bridge v0.2.0 漏带。

- **`bridges/common.js`** 加 `readDeviceId()`：从 `localStorage.__ds_remote_feature_did` 读 device id。
- **`bridges/chat-bridge.js`** VERSION `0.2.0 → 0.2.1`：`chatSettingsView` 自动从 localStorage 取 `did`，未设置时返回 `missing_device_id`；URL 拼接 `?did=<>&scope=<>`；response 多回 `did` 字段方便审计。

### 已知限制（非 bug）

即便带齐 `did + Bearer + cookie`，扩展 isolated world 的 `fetch('/api/v0/client/settings')` 仍可能被 DeepSeek 当 anonymous 处理，返回 `biz_error: SETTINGS_NOT_FOUND`（同 reddit v3.6.1 在 firefox 上的 cookie partitioning 现象）。本 skill 不为此引入 page-world 注入（避免向 DESTRUCTIVE 滑坡），工具会优雅降级返回 `biz_error` + 原始 `bizMsg`，调用方应据此判断而非反复重试。

> 浏览器自身请求该接口能拿到 11.7KB 完整 model 列表（已用 `xhr-log` 验证）。本 skill 暂不复刻该路径。

## v0.2.0 — chat 页深度只读

聚焦 `/a/chat/s/<uuid>` 单会话页：在不新增 page profile、不破任何安全红线的前提下，把 `chat-bridge` 从"几乎只有 `getSession`"扩成"chat 页五件套 + 1 INTERACTIVE 别名"。

### 新增 AI 工具（5 READ + 1 INTERACTIVE）

- READ `deepseek_chat_page_state` —— 当前 chat 页 UI 状态快照：`sessionId / title / composer 草稿的 {length, sha256} / 是否流式中 / scroll 是否到底 / 可见消息数`。**composer 草稿原文绝不返回**。
- READ `deepseek_list_messages` —— 当前会话的消息**元数据**列表（`messageId / role / status / contentLength / contentHash / hasThinking / 附件数 / 搜索结果数`）。永不返回 `content / thinkingContent`，bridge 端硬剥 + Node 端 `buildListMessagesTransform` 双重断言。
- READ `deepseek_get_message` —— 单条消息详情，`{sessionId, messageId}` 必填；正文走与 `get_session` 一致的 `redact off/trunc/full` 政策。强校验 `sessionId` 与当前 URL 一致，避免跨会话 ref。
- READ `deepseek_streaming_status` —— 一次性观察 assistant 是否在产出（`history_messages` 里 `status==='STREAMING'` + DOM 上 streaming 节点双侧确认）。**永不订阅 SSE / EventSource，无任何 listener**。
- READ `deepseek_chat_settings_view` —— 只读拉 `/api/v0/client/settings?scope=main|model`，回 model 列表 / feature flags / 默认 toggle 状态。本工具永不写任何 toggle。
- INTERACTIVE `deepseek_navigate_new_chat` —— `location.assign('/')` 起新对话；不调用 `chat_session/create`，DeepSeek 是首次发消息才落 sessionId，本调用无副作用。

### 架构改动

- **`bridges/common.js`** 新增 5 个纯浏览器 helper：`parseChatSessionIdStrict` / `digestText`（`crypto.subtle` SHA-256 摘要）/ `pickLatestStreamingMessage` / `summarizeMessageMeta` / `readChatPageDom`（一次性 DOM 读 composer/streaming/scroll/title）。
- **`bridges/chat-bridge.js`** VERSION `0.1.0` → `0.2.0`，挂上 `chatPageState / listMessages / getMessage / streamingStatus / chatSettingsView / navigateNewChat`；新增内部 `fetchHistoryMessagesRaw + mapHistoryError` 抽出 `getSession / listMessages / getMessage / streamingStatus` 共享的拉取与错误分支。chat-bridge 顶部注释加固红线。
- **`bridges/home-bridge.js`** VERSION `0.1.0` → `0.2.0`，加 `navigateNewChat`（与 `navigateHome` 同 URL，仅语义别名）。
- **`lib/redact.js`** 新增 `redactGetMessageResult / buildGetMessageTransform`，新增 `buildListMessagesTransform`（防漏断言：若结果里出现 `content` 字段则硬剥并 stderr warn）。
- **`lib/toolTargets.js`** 加 `chatNewUrl`（语义别名，与 `homeUrl` 同 URL）。
- **`skill.contract.js`** 新增 6 个 `TOOL_DEFINITIONS`，`get_message` execute 复制 `get_session` 模式（绑定 `buildGetMessageTransform`），`list_messages` 强制套 `buildListMessagesTransform`。CLI_COMMANDS 表同步追加。
- **CLI**：`lib/commands.js` + `cli/index.js` 加 6 条命令（`chat-page-state` / `list-messages` / `get-message` / `streaming-status` / `chat-settings-view` / `navigate-new-chat`），新增 `--scope` 选项给 `chat-settings-view`。

### 安全红线复检（v0.2 仍然不做）

- 不模拟点击；不订阅 SSE / EventSource；不 hook fetch / XMLHttpRequest
- 不发消息 / 不停 / 不编辑 / 不重生 / 不删 / 不切 model / 不切 toggle / 不上传
- **不读 composer 草稿原文**（v0.2 新明确）：`chatPageState` 的 composer 字段只回 `{length, sha256, present}`
- 跨会话 `messageId` 引用直接拒绝（`session_id_mismatch`）

## v0.1.0 — MVP

`PAGE_PROFILES + Bridges + Session` 架构落地：

- 2 个 page profile：`home`（`/`）/ `chat`（`/a/chat/s/<uuid>`）
- 5 个 AI 工具：`deepseek_session_state` / `deepseek_list_sessions` / `deepseek_get_session` / `deepseek_navigate_home` / `deepseek_navigate_session`
- READ + INTERACTIVE 两档；DESTRUCTIVE 永不做
- `lib/redact.js`：`get_session` 默认 `redact=off`（正文 → `{length, sha256}`），`full` 仅 `--debug-recording` 模式生效
- bridge 端 `contentMaxLen` 硬上限 60000，防 SSE 残留 chunk 巨长
- 不接 cache（私密数据不应落盘到 cache）
- 内部踩点 CLI：`dom-dump` / `xhr-log`
- `docs/dev/api-endpoints.md` 落踩点结果（仅字段类型，不贴样本）
