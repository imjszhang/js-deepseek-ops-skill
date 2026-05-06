# DeepSeek Chat 内部 API 端点（踩点结果）

> 本文档仅列**实际在浏览器里观察到的**端点 + 用到的字段子集。
>
> 凡是没在 `xhr-log` / `dom-dump` 里实际触发过的端点，**严禁**写进 bridge 主路径——
> 这条规则与 [`js-reddit-ops-skill`](../../../js-reddit-ops-skill/SKILL.md) 的「明确不做的事」一致。
>
> 数据样例（用户 / 会话标题 / 消息正文）**绝不**贴进本文档；只记录字段名与典型类型。

---

## 通用响应壳

DeepSeek 的所有 `/api/v0/*` 接口返回统一壳子：

```json
{
  "code": 0,
  "msg": "",
  "data": {
    "biz_code": 0,
    "biz_msg": "",
    "biz_data": <真正的业务数据>
  }
}
```

判定规则：

- `code === 0` 才算 HTTP 层 + 协议层 OK
- `data.biz_code === 0`（或 `undefined`）才算业务层 OK
- `biz_code !== 0` 时 `biz_msg` 是错误码字符串（如 `SETTINGS_NOT_FOUND`）

实现见 `bridges/common.js::unwrapDeepseekResponse`。

## 鉴权

- **首选**：`Authorization: Bearer <token>` —— `token` 从 `localStorage.getItem('userToken')` parse JSON 取 `.value` 字段
- 兜底：`credentials: 'include'`（cookie 同源）
- 实现见 `bridges/common.js::readUserToken` + `fetchDeepseekJson`

## 接口表（v0.1 用到的）

### `GET /api/v0/users/current` —— 登录态

用途：登录态判定、用户基本信息。

`biz_data` 字段（实际观察到的，类型已验证）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string (uuid) | 用户 id |
| `email` | string | 已 mask 形式（如 `21****77@qq.com`） |
| `mobile_number` | string | 已 mask 形式（如 `135******61`） |
| `area_code` | string | 区号（如 `+86`） |
| `status` | number | 账户状态 |
| `id_profile.provider` | string | `WECHAT` / `EMAIL` / ... |
| `id_profile.id` | string | 第三方 id |
| `id_profile.name` | string | 显示名 |
| `id_profile.picture` | string (url) | 头像 URL（`https://static.deepseek.com/user-avatar/...`） |
| `id_profile.locale` | string | `zh_CN` / ... |
| `id_profiles[]` | array | 全部已绑定的 provider 列表 |
| `chat.is_muted` | number | 是否被静音 |
| `chat.mute_until` | number? | 静音到期时间戳 |
| `has_legacy_chat_history` | boolean | 是否存在旧版历史 |
| `need_birthday` | boolean | 是否需要补生日 |

未登录时该接口返回 401（HTTP 层），bridge 优雅降级为 `{loggedIn:false}`。

### `GET /api/v0/chat_session/fetch_page?count=N[&before_seq_id=<seqId>]` —— 历史会话列表

> 注：服务端只接受 GET，POST 会返回 405 Method Not Allowed（已实测）。

`biz_data` 字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `chat_sessions[]` | array | 会话列表，每条含下方子字段 |
| `chat_sessions[].id` | string (uuid) | 会话 id |
| `chat_sessions[].seq_id` | number | 服务器侧排序键 / 分页游标 |
| `chat_sessions[].title` | string | 会话标题（系统生成或用户重命名） |
| `chat_sessions[].title_type` | string | `SYSTEM` / `USER` |
| `chat_sessions[].updated_at` | number (unix sec, float) | 最近更新时间戳 |
| `chat_sessions[].inserted_at` | number (unix sec, float) | 创建时间戳 |
| `chat_sessions[].pinned` | boolean | 是否置顶 |
| `chat_sessions[].model_type` | string | `default` / `expert` / ... |
| `chat_sessions[].agent` | string | 通常为 `chat` |
| `chat_sessions[].version` | number | 内部版本号 |
| `chat_sessions[].current_message_id` | number | 当前消息计数 |
| `has_more` | boolean | 是否还有下一页 |

分页：用最后一条的 `seq_id` 作为下次的 `before_seq_id`（v0.1 实现见 `home-bridge.js::listSessions` 末尾的 `cursor` 字段）。

### `GET /api/v0/chat/history_messages?chat_session_id=<uuid>` —— 单会话历史消息

`biz_data` 字段：

#### `chat_session`（与 fetch_page 字段重叠 + 多了 `is_empty`）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` / `seq_id` / `title` / `title_type` / `model_type` / `pinned` / `agent` / `version` / `current_message_id` / `updated_at` / `inserted_at` | 同上 | |
| `is_empty` | boolean | 会话是否还没有消息 |

#### `chat_messages[]`

| 字段 | 类型 | 说明 |
|---|---|---|
| `message_id` | number | 同会话内自增 |
| `parent_id` | number? | 父消息 id（首条用户消息为 null） |
| `model` | string | 实际使用的模型，可能为 `''`（系统未填） |
| `role` | string | `USER` / `ASSISTANT` / `SYSTEM` |
| `status` | string | `FINISHED` / `INTERRUPTED` / `STREAMING` / ... |
| `thinking_enabled` | boolean | 是否开启了"深度思考" |
| `search_enabled` | boolean | 是否开启了"联网搜索" |
| `ban_edit` | boolean | 不可编辑（系统消息 / 已结算） |
| `ban_regenerate` | boolean | 不可重新生成 |
| `accumulated_token_usage` | number | 累计 token 用量 |
| `inserted_at` | number (unix sec, float) | 创建时间戳 |
| `content` | string | **正文** —— bridge 端 `contentMaxLen` 截断后再到 Node 端 `redact.js` 处理 |
| `incomplete_message` | string? | 流式中断时的残留 |
| `feedback` | object? | 用户对该回复的反馈 |
| `files[]` | array | 附件列表 |
| `thinking_content` | string? | "深度思考"内容 —— 同样走 redact |
| `thinking_elapsed_secs` | number? | 思考耗时 |
| `search_status` | object? | 搜索状态 |
| `search_results[]` | array? | 搜索结果数组 |
| `tips[]` | array | 小贴士 |

bridge 端 `normalizeChatMessage`（见 `bridges/common.js`）只输出业务必要字段；`files` 仅出 `length`，`feedback` 仅出 `boolean`，避免传超大对象。

### `GET /api/v0/client/settings?did=<deviceId>&scope=main|model` —— 客户端配置 / 模型列表

> v0.1 暂未消费此接口。v0.2 将基于此实现 `deepseek_list_models` / `current_chat_state`。

`biz_data` 在主页未登录时返回 `null`（`biz_code: 1, biz_msg: SETTINGS_NOT_FOUND`），登录态下返回模型 / feature flag 列表。

---

## 永不消费的端点（DESTRUCTIVE）

下列端点**已在浏览器里观察到**，但本 skill 永不调用（与 SKILL.md 的「明确不做的事」一一对应）：

| 端点 | 方法 | 危害 |
|---|---|---|
| `/api/v0/chat/completion` | POST | 发消息 / 触发流式生成 / 扣 token |
| `/api/v0/chat/stop_stream` | POST | 停止流（也算业务写） |
| `/api/v0/chat/edit_message` | POST | 编辑用户消息 |
| `/api/v0/chat/create_pow_challenge` | POST | 生成 PoW（发消息前置） |
| `/api/v0/chat_session/create` | POST | 新建会话 |
| `/api/v0/chat_session/delete` 或 `_archive`（推测） | POST | 删除 / 归档会话 |

`bridges/common.js::fetchDeepseekJson` 不做端点白名单（开放 GET / POST），但所有 bridge 方法只调上面 v0.1 三个 GET。**新增端点务必先经过 `xhr-log` 踩点 + 安全分级评审**。

---

## URL 路径模式（导航用）

| 路径 | 含义 | 用途 |
|---|---|---|
| `/` | 主页 / 新对话 | `deepseek_navigate_home` |
| `/a/chat/s/<uuid>` | 单会话页 | `deepseek_navigate_session` |
| `/sign_in` | 登录页 | 仅观察，不操作 |
| `/settings` 或类似 | 设置页 | v0.2 才考虑 |

`bridges/common.js::navigateLocation` 在跳转前硬卡 `(?:^|\.)deepseek\.com$`，跨域 URL 直接 `cross_origin_navigation_forbidden`。
