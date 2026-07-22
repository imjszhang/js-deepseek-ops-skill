# DeepSeek Chat 内部 API 端点（踩点结果）

> 本文档列出本 skill 实际消费 / 已观察的 `/api/v0/*` 端点。
>
> **数据样例（用户 / 会话标题 / 消息正文）绝不贴入本文档；只记字段名 + 典型类型。**
>
> v0.3 BREAKING：从只读 skill 反转为全量 ops，DESTRUCTIVE 端点也启用。
> 安全语义改由 Node 端 `lib/runTool.js` destructive 分支 + `lib/audit.js` 提供
> （详见 [`SKILL.md`](../../SKILL.md)）。

---

## 通用响应壳

```json
{ "code": 0, "msg": "", "data": { "biz_code": 0, "biz_msg": "", "biz_data": <真正业务数据> } }
```

判定：`code === 0` 且 `data.biz_code === 0` 才算业务成功。
实现 → `bridges/common.js::unwrapDeepseekResponse`。

## 鉴权

- **首选**：`Authorization: Bearer <token>` —— `localStorage.userToken` parse JSON 取 `.value`
- 兜底：`credentials: 'include'`（cookie 同源）
- 实现 → `bridges/common.js::readUserToken` + `fetchDeepseekJson`

## 端点全景表（v0.3 webpack scan）

下表来自 `bridges/chat-bridge.js` 注释的"端点目录"，从首屏 5 个 webpack 主 bundle
里 `RegExp(/\/api\/v0\/[\w\/]+/g)` 提取（共 36 项）：

| 类别 | 端点 | 方法 | 用途 | 本 skill 工具 |
|---|---|---|---|---|
| **READ** | `/api/v0/users/current` | GET | 登录态 / 账户基本信息 | `session_state` |
| READ | `/api/v0/chat_session/fetch_page` | GET | 历史会话列表（分页） | `list_sessions` |
| READ | `/api/v0/chat/history_messages` | GET | 单会话**全分支**消息（含 active path 与所有兄弟分支） | `get_session` / `list_messages` / `get_message` / `streaming_status` / `get_session_tree` / `list_branch_points` / `get_branch_path` |
| READ | `/api/v0/client/settings` | GET | model 列表 / feature flag | `chat_settings_view` |
| READ | `/api/v0/file/fetch_files` | GET | 当前账号上传的文件 | `list_files` |
| READ | `/api/v0/share/list` | GET (`?count=N`) | 分享列表 | `list_shares` |
| READ | `/api/v0/users/settings` | GET | 账号设置 | （未单列） |
| READ | `/api/v0/share/content` | GET | 单个分享内容 | （未实现） |
| **DESTRUCTIVE,reversible** | `/api/v0/chat_session/create` | POST `{}` | 创建新会话 | `create_session` |
| DESTRUCTIVE,reversible | `/api/v0/chat_session/update_title` | POST `{chat_session_id, title}` | 重命名 | `rename_session` |
| DESTRUCTIVE,reversible | `/api/v0/chat_session/update_pinned` | POST `{chat_session_id, pinned}` | 置顶 / 取消置顶 | `pin_session` / `unpin_session` |
| DESTRUCTIVE,reversible | `/api/v0/chat/message_feedback` | POST `{chat_session_id, message_id, feedback_type, feedback_tag, description}` | 消息反馈 | `feedback_message` |
| DESTRUCTIVE,reversible | `/api/v0/chat/stop_stream` | POST | 停止当前流 | `stop_stream` |
| DESTRUCTIVE,reversible | `/api/v0/share/create` | POST `{chat_session_id, title?, message_ids?}` | 创建分享 | `share_session` |
| DESTRUCTIVE,reversible | `/api/v0/file/upload_file` | POST multipart | 上传文件 | `upload_file` |
| ADMINISTRATIVE,reversible | `/api/v0/users/update_settings` | POST `{...}` | 更新账号设置；仅允许管理员配置的字段 | `update_user_settings` |
| DESTRUCTIVE,irreversible | `/api/v0/chat_session/delete` | POST `{chat_session_id}` | 删除会话 | （**v0.3.3 起永不实现**：不可逆且 backup 无法恢复服务端真实数据） |
| DESTRUCTIVE,irreversible | `/api/v0/chat_session/delete_all` | POST | 删除所有会话 | （**永不实现**） |
| DESTRUCTIVE,irreversible | `/api/v0/share/delete` | POST `{share_id}` | 删除分享 | `unshare_session` |
| **DESTRUCTIVE,cost** | `/api/v0/chat/completion` | POST → SSE | 发消息（PoW 必需） | `send_message` |
| DESTRUCTIVE,cost | `/api/v0/chat/edit_message` | POST → SSE | 编辑消息并重生 | `edit_message` |
| DESTRUCTIVE,cost | `/api/v0/chat/regenerate` | POST → SSE | 重生 assistant 回复 | `regenerate_message` |
| DESTRUCTIVE,cost | `/api/v0/chat/continue` | POST → SSE | 续写 | （未实现） |
| DESTRUCTIVE,cost | `/api/v0/chat/resume_stream` | POST | 恢复中断流 | （未实现） |
| 辅助 | `/api/v0/chat/create_pow_challenge` | POST `{target_path}` | 拿 PoW challenge | bridge 内部 |
| 辅助 | `/api/v0/file/fork_file_task` | POST | 文件 task 复制 | （未实现） |
| 辅助 | `/api/v0/share/fork` | POST | 分享 fork | （未实现） |
| 辅助 | `/api/v0/users` | POST | 用户 CRUD | （未实现） |
| 辅助 | `/api/v0/users/create_email_verification_code` | POST | 验证码 | （永不实现） |
| 辅助 | `/api/v0/users/create_sms_verification_code` | POST | 验证码 | （永不实现） |
| 辅助 | `/api/v0/users/create_guest_challenge` | POST | guest PoW | （永不实现） |
| 辅助 | `/api/v0/users/logout_all_sessions` | POST | 登出所有会话 | （永不实现，用户级危险） |
| 辅助 | `/api/v0/users/set_birthday` | POST | 补生日 | （未实现） |
| 辅助 | `/api/v0/download_export_history` | - | 历史导出（本地） | 见 `export_session_local` |
| 辅助 | `/api/v0/export_all` | - | 全量导出 | （未实现） |
| 辅助 | `/api/v0/client/span` | POST | 客户端埋点 | （永不实现） |
| 辅助 | `/api/v0/client/wechat_js_sdk_signature` | GET | 微信 SDK | （永不实现） |

---

## 字段细节

### `/api/v0/chat_session/fetch_page?count=N[&before_seq_id=<seqId>]`

`biz_data.chat_sessions[]` 字段：`id` / `seq_id` / `title` / `title_type` / `updated_at` /
`inserted_at` / `pinned` / `model_type` / `agent` / `version` / `current_message_id`，
另带 `has_more`。分页用上一页最后一条的 `seq_id` 作为 `before_seq_id`。

### `/api/v0/chat/history_messages?chat_session_id=<uuid>[&cache_version=<n>&cache_reset_at=<ts>]`

`biz_data.chat_session` 同 fetch_page 字段集 + `is_empty` + `current_message_id`（active leaf 的 messageId）。

`biz_data.chat_messages[]` **是会话全树节点的并集**（含 active path 与所有被埋藏的旧分支兄弟）—— v0.4.0 踩点结论（详见 [`branch-scout.md`](./branch-scout.md)）。每个节点：
`message_id` / `parent_id` / `model` / `role` (`USER`/`ASSISTANT`/`SYSTEM`) /
`status` (`FINISHED`/`STREAMING`/`INTERRUPTED`/`CONTENT_FILTER`/...) / `thinking_enabled` / `search_enabled` /
`ban_edit` / `ban_regenerate` / `accumulated_token_usage` / `inserted_at` / `content` /
`thinking_content` / `thinking_elapsed_secs` / `incomplete_message` / `feedback` /
`files[]` / `search_results[]` / `search_status` / `tips[]`。

**关键性质**：
- 节点不带 `branch_id` / `sibling_index` / `is_current` 等专用字段；分支信息**完全靠 `parent_id` 树形结构表达**（同 parent_id 出现多次 = 分支点）
- active path（UI 上当前可见的对话流）= 从 `current_message_id` 沿 `parent_id` 反推到 root
- 服务端不返 children 反向索引，需要客户端构建（见 `bridges/chat-bridge.js::buildSessionTree`）

**可选 query 参数**（v0.4.0 bridge 当前未传，留作未来增量同步优化）：
- `cache_version`：与 `session.version` / `current_message_id` 一致；客户端缓存有效性校验
- `cache_reset_at`：unix 秒级时间戳；缓存失效锚点

### `/api/v0/chat_session/create` (POST)

请求体可空 `{}`；可选 `agent` / `character_id`。
返回 `biz_data` 即新 session 对象（`id` / `seq_id` / `agent` / `model_type` / `title=null` /
`title_type='WIP'` / `pinned=false` / 时间戳 / 等）。

### `/api/v0/chat_session/update_title` (POST)

`{chat_session_id, title}`。空会话（无任何消息）会回 `biz_code=5 EMPTY_CHAT_SESSION`。
`title` 服务端最大长度未严测，bridge 端硬截到 200 字。

### `/api/v0/chat_session/update_pinned` (POST)

`{chat_session_id, pinned}`。同样空会话回 EMPTY_CHAT_SESSION。

### `/api/v0/chat_session/delete` (POST)

`{chat_session_id}`。空会话也可删；`biz_data` 为 `null`。
**v0.3.3 起本 skill 不再封装此端点**：删除会话是真正不可逆的操作，本地
`getSessionSnapshot` backup 只能记录元数据 + content hash，无法还原服务端
真实数据；为避免误调用，已从 contract / CLI / bridge 中整体下线。如需清理，
请在 DeepSeek Web UI 手动操作。

### `/api/v0/chat/message_feedback` (POST)

```json
{
  "chat_session_id": "<uuid>",
  "message_id": <int>,
  "feedback_type": "GOOD" | "BAD" | null,
  "feedback_tag": null,
  "description": <string|null>
}
```

`feedback_type` 是 `MessageFeedbackType` enum：`LIKE → "GOOD"`、`DISLIKE → "BAD"`、
取消反馈传 `null`。CLI 兼容数值 `1/-1/0`。

### `/api/v0/chat/completion` (POST → SSE)

```json
{
  "chat_session_id": "<uuid>",
  "parent_message_id": <int|null>,
  "prompt": "...",
  "ref_file_ids": [],
  "thinking_enabled": <bool>,
  "search_enabled": <bool>
}
```

**必需 header**：`X-DS-PoW-Response: <base64(JSON({algorithm, challenge, salt, answer, signature, target_path}))>`
- challenge 由 `/api/v0/chat/create_pow_challenge` 拿到
- `answer` 是计算结果，需要跑 `DeepSeekHashV1`（基于 `static/sha3_wasm_bg.*.wasm` 的 worker）
- bridge 端**不实现** PoW 求解（wasm worker 复刻成本高），透传 `answer:0`，
  服务端会回 `code=40301 INVALID_POW_RESPONSE`，工具返回 `error.code='pow_required'`，
  让上层走 UI 通道（非本 skill 范畴）

SSE 格式（每个 event 形如 `data: <json>\n\n`，结尾 `data: [DONE]`）：
- `{"v": "字"}` 或 `{"v": "字", "p": "response/thinking_content"}`
- `{"v": {"content": "...", "thinking_content": "...", "message_id": N, "model": "...", "usage": {...}, "finish_reason": "stop"}}`

bridge 内 `_completionLike` 聚合所有 chunk 后一次性回 `{messageId, contentLength,
contentSha256, usage, chunkCount, ...}`，默认不返正文（`includeContent=true` 时回原文）。

### `/api/v0/chat/edit_message` / `regenerate` (POST → SSE)

参考 completion，`edit_message` 多带 `message_id`，`regenerate` 多带 `parent_message_id`。
PoW header 同样必需，同样状态。

### `/api/v0/chat/stop_stream` (POST)

需要传当前正在流的 message_id 等额外字段，bridge 当前 schema 不完整，
v0.3 标记为"已注册但 schema 待补"。

### `/api/v0/chat/create_pow_challenge` (POST)

`{target_path: <api path>}`。返回：

```json
{
  "challenge": {
    "algorithm": "DeepSeekHashV1",
    "challenge": "<hex>",
    "salt": "<hex>",
    "signature": "<hex>",
    "difficulty": 144000,
    "expire_at": <ms>,
    "expire_after": 300000,
    "target_path": "/api/v0/chat/completion"
  }
}
```

### `/api/v0/file/upload_file` (POST multipart)

`form-data: file=<binary>, session_id=<uuid?>`。返回 `biz_data` 含上传后文件 id /
状态 / 解析进度等（未做强 schema）。

### `/api/v0/share/create` / `/api/v0/share/delete` / `/api/v0/share/list`

- `create`：`{chat_session_id, title?, message_ids?}` → 返回 `share_id` 等
- `delete`：`{share_id}`（**irreversible**，auto-backup 暂未实现，因为 share 数据本身可重建）
- `list`：GET `?count=N` → `{shares: [{share_id, hint, created_at, chat_session_id, ...}]}`

### `/api/v0/users/update_settings` (POST)

请求体直接是 `{<key>: <value>}` 字典；服务端按白名单接受。本工具不做 key 限制，
LLM 自负责传合法 key。

### `/api/v0/client/settings?did=<uuid>&scope=main|model`

`did` 来自 `localStorage.__ds_remote_feature_did`（chat 页加载后自动写入）。
返回 model 列表 / feature flag / 当前 chat 默认设置。
**已知限制**：浏览器扩展隔离上下文 fetch 偶现 `SETTINGS_NOT_FOUND`，bridge 优雅降级。

---

## DOM 模式（绕开 PoW，不走 API）

`/api/v0/chat/completion` 强制 `X-DS-PoW-Response`（DeepSeekHashV1 / WASM），bridge 不复刻。改让浏览器自己解：

| 阶段 | 实现 | 备注 |
|---|---|---|
| 1. 写入 prompt | `setReactInputValue(textarea, prompt)` | React 受控输入必须走 prototype `value` setter + `input`/`change` 事件 |
| 2. 等发送按钮 enabled | `waitFor(findComposerSendButton, ...)` | composer 行最右、enabled 的 `button.ds-icon-button--l`（实测 4 个：思考/搜索/上传/发送） |
| 3. 点击 | `sendBtn.click()` | 浏览器内部触发 PoW worker → fetch `/api/v0/chat/completion` |
| 4. 等 sessionId（仅 `/` 起始） | 轮询 `location.href.match(/\/a\/chat\/s\/([0-9a-f-]{36})/)` | SPA route 切换 |
| 5. 等流式完成（可选） | 轮询 `/api/v0/chat/history_messages?chat_session_id=<sid>`，末条 ASSISTANT 不再 `WIP/STREAMING/PENDING` | 默认 90s 超时 |

实测耗时（2026-05）：从 `/` 创建 → sessionId < 0.5s，"ok" 级回复完成总计 3.6s；已有会话内 12 字符问题 → 完成 12s。

详见 `bridges/common.js::findComposerSendButton` / `bridges/chat-bridge.js::domSendMessage`。

---

## URL 路径模式（导航用）

| 路径 | 含义 |
|---|---|
| `/` | 主页 / 新对话 |
| `/a/chat/s/<uuid>` | 单会话页 |
| `/sign_in` | 登录页（仅观察） |

`bridges/common.js::navigateLocation` 跳转前硬卡 `(?:^|\.)deepseek\.com$`，
跨域 URL 直接 `cross_origin_navigation_forbidden`（与 destructive 解锁正交）。

---

## 端点踩点方法

1. webpack scan：从 `document.scripts` 拉每个 bundle，`RegExp(/\/api\/v0\/[\w\/]+/g)` 提取
2. 手动操作 + `node index.js xhr-log --filter "/api/v0/"` 抓 request URL
3. 对未知 schema：bridge 端 `session.callRaw` 直接 `fetch(POST)` 试不同字段名 / 值，
   看 422 `{detail:[{loc:"body.<field>"}]}` 反推

DESTRUCTIVE 测试纪律：**只在专属 TEST_SID 内做**；测试结束后请在 DeepSeek
Web UI 手动删除测试会话（v0.3.3 起 skill 不再提供 `delete_session` 工具）。
