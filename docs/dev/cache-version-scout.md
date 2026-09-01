# DeepSeek `cache_version` / `cache_reset_at` 踊点清单

> 日期：2026-09-01
> 状态：未完成（L1 解释器未确认前只认明确信号，其余 fallback 全量）
> 关联：[adr-002-incremental-sync.md](./adr-002-incremental-sync.md) / [branch-scout.md](./branch-scout.md)

---

## 已知（已观察，未验证语义）

刷新 chat 页时官方请求形如：

```
GET /api/v0/chat/history_messages
  ?chat_session_id=<sid>
  &cache_version=292
  &cache_reset_at=1778079684
```

- 不带这两个参数 → 服务端返回全量 `chat_messages[]`
- 踩点样本里 `session.version === currentMessageId`（292），像「每多一条消息 +1」
- `cache_reset_at` 像 unix 秒级失效锚点；**响应体哪一字段回传它尚未确认**

bridge 现已能把这两个 query 传出去（`bridges/common.js::fetchHistoryMessagesRaw`）。
[`lib/sync/interpretHistory.js`](../../lib/sync/interpretHistory.js) **禁止**把「空
`chat_messages`」猜成 not-modified。

当前承认的 not-modified 信号（确认前即可实现）：

1. HTTP `304`
2. `biz_data.not_modified === true` 或 `biz_data.cache_valid === true`

其它形状 → `kind: 'full'`。`cache_reset_at` 与本地不同 → `kind: 'reset'`（丢本地 message
id 再按远端并集重建）。

## 待确认（人工，不进 CI）

准备：已登录的 DeepSeek tab + 一个稳定测试会话。工具：

```bash
node index.js xhr-log --filter "/api/v0/chat/history_messages" --limit 50
node index.js list-sessions --limit 5 --pretty
node index.js get-session <sid> --redact off --pretty
```

对照同一 `sid` 打以下请求（可在已注入 bridge 的页上 `callRaw`，或看官方自己的 XHR）：

| # | 操作 | 要记录的响应 |
|---|---|---|
| 1 | 不带 cache 参数 | `httpStatus`、`chat_messages.length`、`session.version`、是否有 `cache_reset_at` |
| 2 | `cache_version` = 当前 `session.version`，带上次看到的 `cache_reset_at` | 是 304、空数组、全量，还是带 flag？ |
| 3 | `cache_version` = 当前 version − 1 | delta 还是全量？ |
| 4 | 流式生成中重复 #2 | 同一 `messageId` 的 content 变时 version 动不动？ |
| 5 | 只改标题 / 只置顶 / 只点 feedback | `fetch_page.version` 与 `history_messages.session.version` 涨不涨？ |
| 6 | 观察 `cache_reset_at` 何时变化 | 从 query、响应 `biz`、还是 `chat_session` 字段读取？ |

把结论填进本文件「合同」段，并修订 [api-endpoints.md](./api-endpoints.md) 的
`history_messages` 段。填完之前不要把空数组解释成 not-modified。

## 合同（踊点后填写）

- version 未变时的响应：_待填_
- version 变了时的响应：_待填_
- 流式中：_待填_
- 标题 / 置顶 / feedback：_待填_
- `cache_reset_at` 来源与失效条件：_待填_
