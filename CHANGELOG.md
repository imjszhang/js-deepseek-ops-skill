# Changelog

## v0.1.0 (首发) — 2026-04-28

MVP，对标 [`js-reddit-ops-skill`](../js-reddit-ops-skill/) v3.x 的架构，但因 DeepSeek 是对话 SaaS、私聊正文敏感，安全 / 隐私设定更严：

### 架构

- `PAGE_PROFILES + Bridges + Session` 复用 reddit skill 模式
- 两个 page profile：`home`（`/`）+ `chat`（`/a/chat/s/<uuid>`）
- 两个 bridge：`bridges/home-bridge.js` / `bridges/chat-bridge.js`，共享 `bridges/common.js`（`@@include` 注入前内联）
- `lib/session.js` / `lib/js-eyes-client.js`（含 v3.4.1 token 解析四档）/ `lib/runTool.js` / `lib/runCliToFile.js`（v3.4.2 绕 64KB stdout 截断）从 reddit skill 复刻，做必要 platform/skill 改名

### 工具（5 个）

- READ × 3：`deepseek_session_state` / `deepseek_list_sessions` / `deepseek_get_session`
- INTERACTIVE × 2：`deepseek_navigate_home` / `deepseek_navigate_session`
- CLI 10 条命令（含内部踩点 `dom-dump` / `xhr-log`）

### 隐私加固

- **不复刻 cache**：reddit skill 的 `lib/cache.js` 不进 v0.1，避免私聊正文落 cache
- `lib/redact.js`：默认 `redact='off'`，`messages[].content` / `thinkingContent` 替换为 `{contentHash:sha256, contentLength}`
- `redact='full'` 仅在 `--debug-recording` 模式下生效，否则静默降级到 `trunc`
- bridge 端额外有 `contentMaxLen` 硬上限（默认 60000），避免 SSE 残留 chunk 导致超大跨进程传递
- history.jsonl 不写 result 字段，正文不会落 history
- `runTool` 加 `transformResult` hook，redact 在写 debug bundle 与构造对外响应前都套用

### 安全分级

- **不做 DESTRUCTIVE**：永不发消息（`/api/v0/chat/completion`）/ 切换模型 / 开关"深度思考" / 开关"联网搜索" / 删除会话 / 上传文件 / 创建 API key / 登录自动化
- **不订阅 SSE**：bridge 永不挂 `EventSource` / `addEventListener('message')`
- INTERACTIVE 档 `navigateLocation` 硬卡 `(?:^|\.)deepseek\.com$`，跨域 URL 拒绝

### 接口（API-first）

接口与字段子集（已实地踩点 + 调通）：

- `GET /api/v0/users/current` — 登录态 / 用户信息
- `GET /api/v0/chat_session/fetch_page?count=N&before_seq_id=<seqId>` — 历史会话列表（POST 返回 405）
- `GET /api/v0/chat/history_messages?chat_session_id=<uuid>` — 单会话历史消息
- 鉴权：`Authorization: Bearer <token>`（token 取自 `localStorage.userToken.value`）+ `credentials: 'include'`

详见 [`docs/dev/api-endpoints.md`](docs/dev/api-endpoints.md)。

### 文档

- `SKILL.md`：依赖前置 / 安全红线 / 工具表 / CLI / 架构 / 明确不做的事 / 路线图 / 故障排查
- `docs/dev/api-endpoints.md`：踩点结果（路径 + 字段子集，不贴正文样例）
- `docs/dev/bridges-cheatsheet.md`：fetch 绝对 URL / VERSION bump / 跨域拒绝三个坑速查

### 路线图

- v0.2：`current_chat_state` / `list_models` / `quota_state`；分页游标补全；`lib/deepseekUtils.js` cheerio DOM fallback
- v0.3：业务脚本 `aggregate-sessions.js` / `dump-session.js`（默认 redact，需 `--allow-raw-output`）
- v0.4：`scripts/_dev/diff-schema.js` schema 退化检测
