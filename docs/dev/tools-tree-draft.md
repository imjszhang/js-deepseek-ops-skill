# 全分支树工具 contract 草稿（v0.4.0 候选）

> 日期：2026-05-07
> 状态：Draft（不要复制到 [skill.contract.js](../../skill.contract.js)；二期照此实施）
> 关联：[adr-001-branch-tree-route.md](./adr-001-branch-tree-route.md) / [session-tree-schema.md](./session-tree-schema.md)

本文档定义二期将注册到 `TOOL_DEFINITIONS` 的 3 个新工具的契约。一期**不动 contract / lib/commands / cli**。

---

## 总体约定

- 全部 **READ** 档：`destructive: false`，无 `sideEffect`，不写 audit
- pageKey 统一 `chat`（依赖 `current_message_id` 从 chat 页 bridge 拿；home-bridge 端可后续补一份只读封装，二期可选）
- 错误码与现有 `deepseek_get_session` 对齐：`missing_session_id` / `session_not_found` / `not_logged_in` / `fetch_failed`
- redact 策略与 `deepseek_get_session` / `deepseek_get_message` 一致：`off`（默认，仅 sha256+length） / `trunc` / `full`

---

## 工具 1：`deepseek_get_session_tree`

> 拉取会话全分支树（含被埋藏的旧分支兄弟），返回 `SessionTree`。

### 用途
- LLM 拿到会话完整结构，识别分支点 / 选择路径
- 本地导出全树 markdown / mermaid 用

### inputSchema

```jsonc
{
  "type": "object",
  "properties": {
    "sessionId": {
      "type": "string",
      "description": "目标会话 id；省略则用当前 chat 页 URL 解析"
    },
    "includeContent": {
      "type": "boolean",
      "default": false,
      "description": "true 等价于 redact='full'；与 redact 同时传时 redact 优先"
    },
    "redact": {
      "type": "string",
      "enum": ["off", "trunc", "full"],
      "default": "off"
    },
    "truncLen": {
      "type": "integer",
      "minimum": 1,
      "description": "redact='trunc' 时每条 content 保留长度，默认 200"
    },
    "contentMaxLen": {
      "type": "integer",
      "minimum": 200,
      "maximum": 200000,
      "default": 60000,
      "description": "bridge 端硬上限"
    },
    "limit": {
      "type": "integer",
      "minimum": 0,
      "default": 0,
      "description": "节点上限，0 = 不限；超限按 messageId 倒序保留最新（标 truncatedToLimit=true）"
    }
  },
  "required": []
}
```

### outputSchema

`SessionTree`（详见 [session-tree-schema.md](./session-tree-schema.md)）。

### 错误
- `missing_session_id`
- `session_not_found`（404）
- `not_logged_in`（401/403）
- `fetch_failed`（其他）

### 安全
- READ；无 audit；无 backup
- bridge 端 `contentMaxLen` 截断保护跨进程 JSON

---

## 工具 2：`deepseek_list_branch_points`

> 仅返回分支点元数据（不带正文、不带全部节点），轻量发现工具。

### 用途
- LLM 快速扫描"这个会话在哪儿分了叉，每个分叉有几个 child"，决定是否进一步拉某条分支
- 极小响应体（17 个分支点 ≈ 几 KB）

### inputSchema

```jsonc
{
  "type": "object",
  "properties": {
    "sessionId": { "type": "string" }
  },
  "required": []
}
```

### outputSchema

```jsonc
{
  "session": "<ChatSessionMeta>",
  "currentMessageId": 292,
  "activePathLength": 126,
  "totalMessages": 292,
  "branchPoints": [
    {
      "messageId": 18,
      "role": "ASSISTANT",
      "depth": 8,
      "isOnActivePath": true,
      "childrenCount": 4,
      "children": [
        { "messageId": 19, "role": "USER", "isOnActivePath": false, "insertedAt": "...", "contentLength": 14, "contentHash": "..." },
        { "messageId": 21, "role": "USER", "isOnActivePath": false, "insertedAt": "...", "contentLength": 43, "contentHash": "..." }
      ]
    }
  ],
  "sourceUrl": "...",
  "timestamp": "..."
}
```

### 错误
同工具 1。

### 安全
- READ；无 audit
- 永远不下发正文（即使调用方传 includeContent 也忽略）

---

## 工具 3：`deepseek_get_branch_path`

> 给定 leaf messageId，返回从 root 到该 leaf 的线性消息数组。schema 与 `deepseek_get_session` 完全兼容（drop-in 替换）。

### 用途
- 已知某分支 leaf id（来自 `list_branch_points` 或 `get_session_tree`），拉该分支完整对话流
- 复用 LLM 端处理 `messages[]` 的现有逻辑（不必学新 schema）

### inputSchema

```jsonc
{
  "type": "object",
  "properties": {
    "sessionId": { "type": "string" },
    "leafMessageId": {
      "type": "integer",
      "description": "目标分支末端的 messageId；省略则用 session.current_message_id（等价于 active path）"
    },
    "redact": { "type": "string", "enum": ["off", "trunc", "full"], "default": "off" },
    "truncLen": { "type": "integer", "minimum": 1 },
    "contentMaxLen": { "type": "integer", "minimum": 200, "maximum": 200000, "default": 60000 },
    "limit": { "type": "integer", "minimum": 0, "default": 0 }
  },
  "required": []
}
```

### outputSchema

复用 `deepseek_get_session` 的 outputSchema（`session` + `messages[]` + `messageCount` 等），messages 顺序为 root → leaf。

### 错误
- 上述通用错误
- `branch_leaf_not_found`：leafMessageId 不在树中
- `branch_leaf_not_a_leaf`：leaf 实际还有 children（**仅 warn**，不阻断；返回路径并在 stats.warnings 标记）

### 安全
- READ；无 audit

---

## CLI 草稿（二期落地）

```bash
node index.js get-session-tree <sid>
node index.js get-session-tree <sid> --redact trunc --trunc-len 200
node index.js get-session-tree <sid> --include-content --format mermaid
node index.js get-session-tree <sid> --format md --out ./tree.md

node index.js list-branch-points <sid>

node index.js get-branch-path <sid>                       # 等价 active path
node index.js get-branch-path <sid> --leaf 33             # 拉某条分支
node index.js get-branch-path <sid> --leaf 33 --redact full
```

---

## 注册到 `skill.contract.js` 的草稿（伪代码，二期实施）

```js
{
  name: 'deepseek_get_session_tree',
  description: '读取会话完整分支树（含被埋藏的旧分支兄弟）。返回 SessionTree（含 nodes map / activePathIds / branchPointIds / stats）。',
  page: 'chat',
  bridgeMethod: 'getSessionTree',
  destructive: false,
  inputSchema: { /* 见上 */ },
  // outputSchema 引用 SessionTree
},
{
  name: 'deepseek_list_branch_points',
  description: '仅列出会话中的分支点（children >= 2 的节点）+ 每个分支的 children 元数据。轻量发现工具。',
  page: 'chat',
  bridgeMethod: 'listBranchPoints',
  destructive: false,
  inputSchema: { /* 见上 */ },
},
{
  name: 'deepseek_get_branch_path',
  description: '返回从 root 到指定 leaf messageId 的线性 messages[]，schema 与 deepseek_get_session 兼容。leaf 省略时等价于 active path。',
  page: 'chat',
  bridgeMethod: 'getBranchPath',
  destructive: false,
  inputSchema: { /* 见上 */ },
}
```

---

## SKILL.md 工具清单更新（草稿）

| 工具 | 说明 |
|---|---|
| `deepseek_get_session_tree` | 会话全分支树 + active path 标识 |
| `deepseek_list_branch_points` | 仅分支点元数据（轻量） |
| `deepseek_get_branch_path` | 任意 leaf 到 root 的线性路径 |

→ READ 数量从 10 增到 13；总工具数 24 → 27。
