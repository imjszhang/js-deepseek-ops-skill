# ADR-002：历史会话增量同步

> 日期：2026-09-01
> 状态：Accepted
> 决策者：当前 skill 维护者
> 关联：[cache-version-scout.md](./cache-version-scout.md) / [api-endpoints.md](./api-endpoints.md) / [adr-001-branch-tree-route.md](./adr-001-branch-tree-route.md)

---

## 上下文

`deepseek_list_sessions` / `deepseek_get_session` 每次都现场打官方 API。会话一多，全树
`history_messages` 的成本明显高于列表页。官方请求里观察过
`cache_version` / `cache_reset_at`（见 [branch-scout.md](./branch-scout.md)），但**响应合同未验证**。

本 skill 需要一层本地水位：用列表 `version` 找出脏会话，再按需拉历史。权威数据仍在
DeepSeek，本地不是第二份会话库。

## 决策

1. **Node 编排，不是单个 bridge 方法。** Bridge 只负责带可选缓存参数拉 API；脏检测、
   merge、落盘全在 `lib/sync/`。
2. **本地状态写 `{skillDir}/sync/`，禁止走框架 cache。** [`lib/runTool.js`](../../lib/runTool.js)
   对 READ 设了 `noCache: true`，不得调用 `@js-eyes/skill-recording` 的 `writeCacheEntry`。
3. **默认只存元数据 + content hash。** `--store-tree` 才写 `tree.json`；工具返回永不带正文。
4. **不改 `get_session` / `get_session_tree` 默认语义。** 它们继续现场全量，不加
   `useLocalIfFresh`。
5. **两个同步工具都走 home 页。** `listSessions` 与 `history_messages` 都不依赖 chat URL，
   避免为同步去 `navigate_session`。
6. **L1（官方 not-modified）有踊点门禁。** 未写入 [cache-version-scout.md](./cache-version-scout.md)
   的确认合同前，解释器只承认明确信号（HTTP 304 / `biz.not_modified`）；其余一律当全量。
   空 `chat_messages` **不**当成 not-modified。

## 备选项与拒绝理由

| 路线 | 拒绝理由 |
|---|---|
| 复用框架 `cache/{cacheKey}.json` | 与 `noCache: true` 和「私聊不进 cache」冲突 |
| 复用 `.deepseek-branches/` | 那是 `deepseek-branch-manager` 的独立工作区，职责不同 |
| 把同步做成 `kind: 'tool'` 单次 `runTool` | 一次调用要翻多页 + 读写本地，超出单 API 模型 |
| `get_session` 静默改读本地 | 破坏现有 READ 合同，调用方无法区分新鲜度 |

## 存储

```text
{skillDir}/sync/
  index.json                 # 列表水位（title 只存 length+sha256）
  sessions/<sid>/meta.json   # version + messageId→hash
  sessions/<sid>/tree.json   # 仅 storeTree=true
```

`skillDir`：V2 用 `runtime.config.skillDataRoot`；CLI 默认
`getSkillRecordPaths('js-deepseek-ops-skill').skillDir`。

目录 `0700`、文件 `0600`。不封装 `delete_session`；`--full` 只把列表里消失的 id 标成
`disappeared`，不删本地 meta。

## 两级 version

`index.items[sid]` 同时记：

- `listVersion`：最近一次 `fetch_page` 看到的 `version`（L0 脏检测）
- `syncedVersion`：最近一次成功写入 `meta.json` 且非 pending 的 `version`

只更新 `listVersion` 而不抬 `syncedVersion`，否则 `sync-sessions` 之后
`sync-session` 会误判「已同步」而跳过拉历史。
