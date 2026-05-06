---
name: js-deepseek-ops-skill
description: DeepSeek Chat 全量自动化 skill：READ + INTERACTIVE + DESTRUCTIVE 三档；登录态 / 历史会话 / 单会话历史 / chat 页深度只读 + 创建/重命名/置顶/删除会话 / 反馈 / 上传 / 分享 / 账号设置 / 发消息（SSE + PoW，骨架已就绪）。所有 destructive 调用强制写 audit.jsonl，irreversible 调用前自动 backup。
version: 0.3.0
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

面向 `chat.deepseek.com` 的**全量自动化** skill，对标 [`js-reddit-ops-skill`](../js-reddit-ops-skill/SKILL.md) 的 `PAGE_PROFILES + Bridges + Session` 架构。

**v0.3 BREAKING — 安全姿态反转**：从只读 skill 升级为**完整 ops** skill。
- v0.2 之前的"明确不做的事"段已废弃；DESTRUCTIVE 工具（发消息 / 删会话 / 改设置 / 上传 / 分享）全部启用
- 不再做调用前 confirm；改为 **audit 模式**：destructive 调用直接执行，但完整请求体 + 响应强制写入 `~/.js-eyes/skill-records/<skill>/audit/audit.jsonl`
- `delete_session` / `unshare_session` 等真正不可逆操作前自动写 backup 到 `~/.js-eyes/skill-records/<skill>/backups/<resource>-<id>-<ts>.json`
- 这是**会改用户真实数据**的 skill；建议测试只在专用 TEST_SID 内做

## 依赖与前置

- **JS Eyes Server** 已启动（`js-eyes server start`）
- **浏览器扩展**已安装并连上 server
- **登录态**：浏览器里已人工登录 `chat.deepseek.com`；`localStorage.userToken` 必须有效
- **任意 chat.deepseek.com tab 即可**：所有工具默认 `navigateOnReuse=false / reuseAnyDeepseekTab=true`，bridge 在任意 chat.deepseek.com tab 里 fetch 同源 JSON 端点
- **双侧 `allowRawEval`**：bridge 首次注入走 `bot.executeScript(rawSource)`
  - 宿主：`~/.js-eyes/config/config.json` 里 `security.allowRawEval: true`
  - 扩展：js-eyes popup 里 `Allow Raw Eval` 打开

## 安全分级（v0.3）

### READ（默认档）

纯读，不改 DOM / URL / 业务数据。

- 走 `fetchDeepseekJson(path, options)` 调 DeepSeek 同源 GET / POST(read-like) 端点
- 工具：`deepseek_session_state` / `deepseek_list_sessions` / `deepseek_get_session` / `deepseek_chat_page_state` / `deepseek_list_messages` / `deepseek_get_message` / `deepseek_streaming_status` / `deepseek_chat_settings_view` / `deepseek_list_files` / `deepseek_list_shares`
- `get_session` / `get_message` 默认 `redact='off'`：`messages[].content` 替换为 `{contentHash:sha256, contentLength}`，正文不出
- `list_messages` 永远只回元数据；额外 Node 端 `buildListMessagesTransform` 防漏断言

### INTERACTIVE

仅改自身浏览器 URL（`location.assign`），不模拟点击 / 不改 DOM / 不写业务数据。

- 跨域 URL 在 bridge `navigateLocation` 端硬卡 `(?:^|\.)deepseek\.com$`
- 工具：`deepseek_navigate_home` / `deepseek_navigate_session` / `deepseek_navigate_new_chat`

### DESTRUCTIVE（v0.3 解锁）

会改 DeepSeek 业务数据 / 扣 token / 改账户设置。**调用即生效，无 confirm**。

| sideEffect | 含义 | 行为 |
|---|---|---|
| `reversible` | 可还原（重命名 / 置顶 / 反馈 / 分享 / 上传） | 直接调用；audit 落盘 |
| `irreversible` | 不可还原（删会话 / 删分享） | 调用前 `prefetchBackup` 写 snapshot 到 backups/；audit 落盘 |
| `cost` | 消耗 token（发消息 / 编辑 / 重生） | 直接调用；prompt 原文落 audit；返回默认仅 sha256+length（`includeContent=true` 才回正文） |

**审计落盘**：每个 destructive 调用产生一行 `audit.jsonl`，含 `tool / method / sideEffect / args（含 prompt 原文） / result（bridge 完整响应） / backup_path / target_url / bridge`。是 destructive 操作的事后凭证。

**Backup 文件**：`backups/session-<sid>-<ISO ts>.json`，包含会话标题 / 消息元数据 / 每条 sha256+length（不含正文）。

## 工具清单（共 24 个）

### READ（10 个）

| 工具 | 说明 |
|---|---|
| `deepseek_session_state` | 登录态 / 用户基本信息 |
| `deepseek_list_sessions` | 历史会话列表（标题 / 时间，不含正文） |
| `deepseek_get_session` | 单会话消息历史（默认 redact off） |
| `deepseek_chat_page_state` | 当前 chat 页 UI 状态（composer 仅 sha256） |
| `deepseek_list_messages` | 消息元数据（永不出正文） |
| `deepseek_get_message` | 单条消息详情（默认 redact off） |
| `deepseek_streaming_status` | 是否在流式（一次性观察，不订阅 SSE） |
| `deepseek_chat_settings_view` | model 列表 / feature flag |
| `deepseek_list_files` | 已上传文件列表 |
| `deepseek_list_shares` | 分享链接列表 |

### INTERACTIVE（3 个）

| 工具 | 说明 |
|---|---|
| `deepseek_navigate_home` | 导航到 / |
| `deepseek_navigate_session` | 导航到 /a/chat/s/\<id\> |
| `deepseek_navigate_new_chat` | 导航到 / 起新对话（不创建 sessionId） |

### DESTRUCTIVE（15 个）

| 工具 | sideEffect | 说明 |
|---|---|---|
| `deepseek_create_session` | reversible | 创建新会话；返回 sessionId |
| `deepseek_rename_session` | reversible | 重命名会话标题 |
| `deepseek_pin_session` / `deepseek_unpin_session` | reversible | 置顶 / 取消 |
| `deepseek_delete_session` | **irreversible** | 删会话；auto-backup |
| `deepseek_feedback_message` | reversible | 消息反馈（GOOD / BAD / null） |
| `deepseek_stop_stream` | reversible | 停止当前流式生成 |
| `deepseek_send_message` | **cost** | 发消息（PoW 必需，**bridge 不实现 wasm solver，会回 `pow_required`** — 改用下面 DOM 版） |
| `deepseek_edit_message` | cost | 编辑用户消息并重生（同上 PoW 限制） |
| `deepseek_regenerate_message` | cost | 基于 parent 重生 assistant（同上 PoW 限制） |
| `deepseek_dom_send_message` | **cost** | **DOM 模式发消息**：在 composer 输入并点击发送，绕开 PoW；在 `/` 自动创建可见会话 |
| `deepseek_dom_edit_message` | **cost** | **DOM 模式编辑**：USER 消息本身是 inline textarea，直接 setReactInputValue + 点击"发送"。target=`lastUser` |
| `deepseek_dom_regenerate_message` | **cost** | **DOM 模式重生**：定位 ASSISTANT 行 action 按钮组中的"重新生成"。target=`lastAssistant` |
| `deepseek_dom_stop_stream` | reversible | DOM 模式停止流（点击 composer 行最右按钮） |
| `deepseek_upload_file` | reversible | 上传文件（base64） |
| `deepseek_share_session` | reversible | 创建分享链接 |
| `deepseek_unshare_session` | irreversible | 删分享链接 |
| `deepseek_update_user_settings` | reversible | 更新账号设置 |

## 已知限制

- **PoW solver 未实现（已通过 DOM 模式绕开）**：`/api/v0/chat/completion` 等需要 `X-DS-PoW-Response`（基于 `static/sha3_wasm_bg.*.wasm` worker 的 `DeepSeekHashV1`），bridge 端复刻成本高，当前透传 `answer:0`，服务端回 `40301 INVALID_POW_RESPONSE` → 工具返回 `error.code='pow_required'`
  - **推荐**：用 `deepseek_dom_send_message` / `deepseek_dom_edit_message` / `deepseek_dom_regenerate_message`；浏览器自己解 PoW
  - 未来 1：在 bridge 端 fetch wasm 并实例化（待研究）
  - 未来 2：hook DeepSeek 自带的 `useProofOfWorkStore` zustand store，复用其缓存的 `pair.answer`
- **DOM 选择器易碎**（关键定位逻辑见 `bridges/common.js`）：
  - `findComposerSendButton`：composer 行 `.ds-icon-button--l` 最右、enabled
  - `findMessageActionRows`：`.ds-icon-button--m` 按 y 聚类，2 个=USER、≥4 个=ASSISTANT
  - `domEditMessage` 直接定位 last user `<textarea>`（非 readonly + 非空），改值后 DeepSeek 自动渲染"发送"按钮
- **target 选择**：`dom_edit_message` / `dom_regenerate_message` 支持 `target=lastUser`/`lastAssistant`（默认）和 `target=byMessageId` + `messageId`。后者通过 `_locateMessageInVirtualList` 滚动虚拟列表 + 内容指纹定位历史消息（见 `bridges/chat-bridge.js` 同名函数）。**注意**：DeepSeek 编辑会创建新分支，已被替换的旧分支消息不在 UI 中渲染，对其调用会返回 `message_not_in_current_branch_or_dom` + 友好 hint
- **同内容歧义**：当会话里多条同 role 消息内容完全相同时（如多次 regen 产生同样输出），content fingerprint 无法区分，会命中 DOM 中现存的任意一个。实际场景中消息内容差异大，几乎不会触发；如要绝对精确，可改用 messageId 在响应里反查 `resolvedTargetMessageId` 做事后核对
- **`stop_stream` schema 待补**：bridge 已注册端点；422 表明缺字段，需要在有 active stream 时踩点完整 body
- **平台子域 API key**：`platform.deepseek.com` 子域的 API key 管理未实现（需要新增 page profile + bridge）
- **空会话约束**：`update_title` / `update_pinned` 对完全无消息的会话回 `EMPTY_CHAT_SESSION`，是服务端业务约束
- **扩展隔离上下文 fetch**：`/api/v0/client/settings` 偶现 `SETTINGS_NOT_FOUND`（同 reddit skill v3.6.1 cookie 分区现象），bridge 优雅降级

## 常用 CLI 示例

```bash
# READ
node index.js doctor
node index.js list-sessions --limit 25
node index.js get-session <sid> --limit 20 --pretty
node index.js list-messages <sid>
node index.js get-message <sid> 12 --redact trunc
node index.js chat-settings-view --scope model

# DESTRUCTIVE（reversible）
node index.js create-session                      # 返回新 sessionId
node index.js rename-session <sid> "新标题"
node index.js pin-session <sid>
node index.js feedback-message <sid> 12 1         # 1=GOOD, -1=BAD, 0=取消
node index.js share-session <sid> --title "..."

# DESTRUCTIVE（irreversible，auto-backup）
node index.js delete-session <sid>                # backups/session-<sid>-<ts>.json

# DESTRUCTIVE（cost，PoW 当前会失败回 pow_required）
node index.js send-message <sid> "ping"
node index.js edit-message <sid> 5 "改后内容"
node index.js regenerate-message <sid> 4

# DESTRUCTIVE（cost，DOM 模式 — 推荐，绕开 PoW）
node index.js navigate-home && node index.js dom-send-message "新会话第一条"   # 自动创建可见会话
node index.js dom-send-message "在当前会话追问"                                  # 当前 chat 页追加
node index.js dom-send-message "..." --no-wait                                   # 不等流式结束
node index.js dom-edit-message "改写后的 user 内容" --session <sid>              # 编辑最后 user 消息并重生
node index.js dom-edit-message "改写..." --session <sid> --message-id 7          # 编辑历史 user 消息（自动滚虚拟列表定位）
node index.js dom-regenerate-message --session <sid>                             # 重生最后 assistant 消息
node index.js dom-regenerate-message --session <sid> --message-id 8              # 重生历史 assistant 消息
node index.js dom-stop-stream --session <sid>                                    # 流式中点停止

# 本地导出（无副作用）
node index.js export-session-local <sid> --format md --out ./out.md

# 内部踩点（不暴露给 LLM）
node index.js dom-dump --limit 80
node index.js xhr-log --filter "/api/v0/" --limit 200
```

## 架构

```
┌─ skill.contract.js ─ TOOL_DEFINITIONS（24 个，含 destructive/sideEffect 字段）
│
├─ lib/
│   ├─ runTool.js          ← READ + DESTRUCTIVE 双分支（destructive 强制 audit + 可选 backup）
│   ├─ audit.js (新)        ← writeAuditEntry / writeBackup
│   ├─ redact.js            ← redact policy（off/trunc/full + sha256 摘要）
│   ├─ session.js           ← bridge 注入 / callApi / callRaw / awaitBridgeAfterNav
│   ├─ commands.js          ← CLI 命令注册（含 destructive kind）
│   └─ ...
│
├─ bridges/
│   ├─ common.js            ← 共享 helpers（fetchDeepseekJson POST/GET / digestText / readDeviceId / ...）
│   ├─ home-bridge.js       ← v0.3.2 — home 页 + DESTRUCTIVE 子集（create/rename/pin/delete/share/...）
│   └─ chat-bridge.js       ← v0.3.4 — chat 页全集（含 SSE / PoW solvePowChallenge）
│
└─ cli/index.js             ← runDestructiveCommand / runExportSessionLocal 等
```

## 数据流（destructive 工具）

```
LLM tool call
  ↓
skill.contract.js (TOOL_DEFINITIONS, destructive=true, sideEffect=...)
  ↓
lib/runTool.js destructive 分支
  ↓ (如果 sideEffect=irreversible) prefetchBackup → lib/audit.writeBackup
  ↓
session.callApi(method) → bridge POST /api/v0/...
  ↓
bridge response
  ↓ (跳过 transformResult 的 redact)
lib/audit.writeAuditEntry  ← 完整 args + result + backup_path 落 audit.jsonl
  ↓
返回给 LLM
```

详见 [`docs/dev/api-endpoints.md`](docs/dev/api-endpoints.md) 端点全景表。

## 落盘位置

- **history**：`~/.js-eyes/skill-records/js-deepseek-ops-skill/history/tool_calls.jsonl`
- **audit**（v0.3 新）：`~/.js-eyes/skill-records/js-deepseek-ops-skill/audit/audit.jsonl`
- **backup**（v0.3 新）：`~/.js-eyes/skill-records/js-deepseek-ops-skill/backups/<resource>-<id>-<ts>.json`
- **debug bundle**（`--debug-recording`）：`~/.js-eyes/skill-records/js-deepseek-ops-skill/debug/<run-id>/`
