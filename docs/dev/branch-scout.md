# DeepSeek 全分支树踩点报告

> 日期：2026-05-07
> 范围：踩点 `/api/v0/chat/history_messages` 是否能拿到全分支信息
> 测试 session：`d54aadf1-9f49-4f16-a8ee-a6aae6843f3a`（用户日常使用 session，非专属 TEST_SID；只调 READ 工具，不写入）
> 工具：`node index.js list-messages` / `xhr-log` / `get-message`

---

## TL;DR

**`/api/v0/chat/history_messages?chat_session_id=<sid>` 单次请求即返回会话的全分支节点并集**。`chat_messages[]` 不是"当前活动路径"，而是 root 起整棵树的所有 message。每个 message 的 `parent_id` 唯一指向其父；同一 `parent_id` 出现多次即为分支点。

> 这与之前 `docs/dev/api-endpoints.md` 中的描述（"chat_messages[] 是当前主干"）**不符**，需要在二期实施完成后修订该文档。

---

## 实测数据（测试 session）

来自 `node index.js list-messages d54aadf1-... --debug-recording` 的 `result.json`：

| 指标 | 值 |
|---|---|
| `session.version` | 292 |
| `session.currentMessageId` | 292 |
| `messageCount`（API 返回 `chat_messages[]` 长度） | **292** |
| 节点 messageId 范围 | 1 ~ 292（连续，无空洞） |
| 唯一 root（`parent_id == null`） | `[1]` |
| 分支点（同 `parent_id` 下 children ≥ 2） | **17 个** |
| 最大分支度（同 parent 下 children 数） | 4（在 `parent_id=276`） |
| 沿 `currentMessageId` 回溯 root 的 active path 长度 | 126 |
| 不在 active path 上的"被埋藏分支" | **166 条（占 57%）** |

分支点完整列表（`parent_id -> children 数`）：

```
2 -> 2     18 -> 2    28 -> 2    34 -> 2    66 -> 2
72 -> 2    80 -> 2    84 -> 2    118 -> 3   166 -> 2
194 -> 2   198 -> 3   206 -> 2   226 -> 3   244 -> 2
256 -> 3   276 -> 4
```

> 真实业务结论：用户每编辑 / 重生一次就产生一个新 child；同 parent 多 child 即历史分支兄弟。本 session 中 57% 的消息在 UI 上看不到（旧分支），但通过 API 已经返回。

---

## XHR 观察（参考 `xhr-log --filter "/api/v0/" --limit 100`）

刷新 chat 页时观察到的 history_messages 请求：

```
/api/v0/chat/history_messages?chat_session_id=d54aadf1-...&cache_version=292&cache_reset_at=1778079684
```

新增的两个 query 参数（当前 bridge 未传）：

| 参数 | 值含义 | 推测用途 |
|---|---|---|
| `cache_version` | 与 `session.version` / `currentMessageId` 一致 | 客户端缓存有效性校验；版本不变可不传响应体（增量） |
| `cache_reset_at` | unix 秒级时间戳 | 缓存失效时间锚点 |

bridge 当前调用未带这两个参数，服务端仍正常返回全量 → **二期不必跟进，留作未来增量同步优化**。

---

## 单条消息字段确认（`get-message <sid> 18`）

message 18（一个分支点的 ASSISTANT 节点）原始字段：

```
messageId / parentId / role / status / model
content / contentLength / contentHash
thinkingContent / thinkingContentLength / thinkingElapsedSecs
banEdit / banRegenerate
accumulatedTokenUsage / files / feedback / insertedAt
searchStatus / searchResultsCount
thinkingEnabled / searchEnabled
```

**没有 branch_id / branch_index / sibling_index / is_current 之类专用字段** —— 分支信息完全靠 `parent_id` 树形结构表达。

→ children 反向索引、siblingIndex、isOnActivePath 必须在 bridge 端计算，服务端不直接给。

---

## 关键确认事项（已勾选 = 已验证）

- [x] `/api/v0/chat/history_messages` 单次返回全树（不分页、不仅 active path）
- [x] 每个节点 `parent_id` 唯一且指向已存在节点（无悬挂引用）
- [x] 单 root（`parent_id=null`）—— 一般情况；多 root 暂未发现
- [x] `session.currentMessageId` 是 active leaf 的 messageId，沿 `parent_id` 回溯即得 active path
- [x] message 字段不含 branch 标识，需要客户端计算
- [ ] **未踩点**：流式中（status=`STREAMING`）时新 child 何时出现在 history_messages 响应里 —— 二期实测
- [ ] **未踩点**：被服务端"软删除"的分支是否被排除（看响应 = 全在；推测 DeepSeek 不软删分支）

---

## 端点全景表更新建议（二期）

`docs/dev/api-endpoints.md` 的 history_messages 段落需要修订：

- 把 "`chat_messages[]`：parent_id ..." 改为 "`chat_messages[]` **是会话全树节点的并集**（包括所有分支兄弟），按 `parent_id` 自行重建；服务端不返回 children 反向索引"
- 在 query 参数表里补 `cache_version` / `cache_reset_at`（可选，用于增量；本 skill 二期不强制传）

---

## 路线判定输入

按计划文档 `docs/dev/adr-001-branch-tree-route.md` 中的决策树：

> Q1: history_messages 支持 tip/branch 参数？

**答案修正**：根本不需要 tip/branch 参数 —— history_messages 默认就返回全树。原决策树 Q1/Q2/Q3 均不必走，直接进入 **路线 A 的简化变种**（命名为 **路线 A0**：纯 client-side 树重建）。详见 ADR。
