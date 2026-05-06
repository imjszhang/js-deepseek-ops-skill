# ADR-001：DeepSeek 全分支树拉取的实现路线

> 日期：2026-05-07
> 状态：Accepted（待二期实施验证）
> 决策者：当前 skill 维护者
> 关联：[branch-scout.md](./branch-scout.md) / [session-tree-schema.md](./session-tree-schema.md) / [tools-tree-draft.md](./tools-tree-draft.md)

---

## 上下文

`deepseek_get_session` 当前返回 `messages[]` 是 `chat_messages[]` 的直接映射，但其语义被 `docs/dev/api-endpoints.md` 误描述为"当前主干"。踩点（[branch-scout.md](./branch-scout.md)）证实 `/api/v0/chat/history_messages` **单次响应即返回会话全树节点的并集**，含 active path + 所有兄弟分支。在测试 session 上，全树 292 节点中 166 条（57%）不在 active path 上。

LLM 直接消费 messages[] 平铺数组无法识别分支结构，需要由 bridge 端构建反向索引、active path、分支点列表，并以稳定的 `SessionTree` 数据结构对外暴露。

## 决策

采用**路线 A0：客户端树重建**（不需要新 API、不需要 destructive 操作、不需要前端 store hook）。

```mermaid
flowchart LR
    Caller[CLI / LLM] --> Tool[deepseek_get_session_tree]
    Tool --> Bridge[bridges/chat-bridge.js]
    Bridge --> API["/api/v0/chat/history_messages?chat_session_id=sid"]
    API -->|chat_messages[全树并集]| Bridge
    Bridge --> Build[buildSessionTree<br/>parent_id 反向索引 + activePath + branchPoints]
    Build --> Out[SessionTree]
    Out --> Tool
```

## 备选项与拒绝理由

| 路线 | 描述 | 拒绝理由 |
|---|---|---|
| **路线 A**（标准 API 路线，假设需 tip 参数） | bridge 多次调用 `history_messages?tip=<id>` 合并 | 踩点证明无需 tip 参数，单次即可拿全树；无理由多次调用 |
| **路线 B**（destructive 遍历切 current） | 切 `current_message_id` 遍历再还原 | 不需要：API 直接给全树；写操作徒增风险与 audit 噪声 |
| **路线 C**（前端 store / React fiber hook） | 注入读 zustand / React state | 不需要且更脆弱：DeepSeek webpack 升级即失效；当前 API 完全够用 |
| **路线 D**（混合 fallback 链） | A0 失败回退 store hook | 过度设计：A0 仅依赖一个稳定 GET 端点，无 fallback 必要 |

## 选择 A0 的理由

1. **零写操作**：纯 READ，与 v0.3 安全分级中的 READ 档完全一致，无需 audit / backup / sideEffect 标识
2. **零新端点**：复用现有 `bridges/chat-bridge.js::fetchHistoryMessagesRaw`
3. **数据完备**：踩点确认全树都在响应里
4. **维护成本低**：纯函数式树构建，无外部状态、无脆弱选择器

## 已知风险与缓解

| 风险 | 概率 | 缓解 |
|---|---|---|
| 单 session 全树消息巨多（>1000）导致响应体过大 / Node 序列化截断 | 低（实测 292 已 OK） | 沿用 `contentMaxLen` 截断；仅元数据接口 `list_branch_points` 不带正文 |
| `parent_id` 出现指向不存在节点（孤儿） | 极低 | bridge 构建时检测 + 在 `SessionTree.stats.orphans[]` 暴露 |
| 多 root（`parent_id=null` 出现多次） | 极低 | schema 已设计 `rootMessageIds[]`（数组）兼容；正常单 root |
| 流式中（status=STREAMING）拉树拿到半成品节点 | 中 | 节点 status 直接透传；上层可决定是否轮询 |
| 服务端将来改为只返 active path（破坏性变更） | 极低 | bridge 检测 `messageCount` < 期望（如等于 active path 长）时降级为旧行为；写到 stats.diagnostics |
| `current_message_id` 不在树中（指向已被回收 / 异常） | 低 | activePath 计算允许"短路径"+ stats.warnings 标识 |

## 影响

- **正向**：解锁 LLM 对会话历史完整理解（含被埋藏分支），降低误删 / 误编辑风险
- **零兼容损失**：现有 `get_session` / `list_messages` / `get_message` 完全不动；新工具走全新命名空间
- **文档负债**：`docs/dev/api-endpoints.md` 中关于 history_messages 的描述需修订（二期一并处理）

---

## 二期 Roadmap 检查单

> 一期不做，二期对照执行。每项打勾即完成。

### 1. bridge 实现（`bridges/chat-bridge.js`）

- [ ] 新增 `function buildSessionTree(rawSession, rawMessages, options)` 纯函数（可单元测试）
  - 输入：`biz.chat_session` + `biz.chat_messages[]` + `{ contentMaxLen }`
  - 输出：`SessionTree`（schema 见 [session-tree-schema.md](./session-tree-schema.md)）
  - 实现要点：单遍 build `byId` + `byParent`；BFS 计算 `depth`；从 `currentMessageId` 反推 `activePathIds`；标记 `isOnActivePath`、`siblingIndex/Count`；汇总 `branchPointIds`、`stats`
- [ ] 新增 bridge 方法 `getSessionTree(args)`：复用 `fetchHistoryMessagesRaw`，调用 `buildSessionTree`
- [ ] 新增 bridge 方法 `listBranchPoints(args)`：基于 `getSessionTree` 输出，仅回 `branchPointIds[] + 每分支点的 children 摘要`
- [ ] 新增 bridge 方法 `getBranchPath(args)`：基于 `byParent` 反向遍历指定 leaf 到 root，返回 `messages[]`（沿用 `normalizeChatMessage` 输出 schema 兼容 `get_session`）
- [ ] 注册到 `BRIDGE_METHODS` 调度表
- [ ] 错误码与 `get_session` 一致：`session_not_found` / `not_logged_in` / `fetch_failed`

### 2. contract（`skill.contract.js`）

- [ ] 注册 `deepseek_get_session_tree`（READ）
- [ ] 注册 `deepseek_list_branch_points`（READ）
- [ ] 注册 `deepseek_get_branch_path`（READ）
- [ ] 三个工具均 `destructive: false`，无 `sideEffect`
- [ ] inputSchema / outputSchema 与 [tools-tree-draft.md](./tools-tree-draft.md) 一致

### 3. CLI（`lib/commands.js` + `cli/index.js`）

- [ ] `node index.js get-session-tree <sid> [--include-content] [--content-max-len N] [--format json|md|mermaid]`
- [ ] `node index.js list-branch-points <sid>`
- [ ] `node index.js get-branch-path <sid> <leafMessageId> [--redact off|trunc|full]`
- [ ] mermaid 格式输出：每分支点画 fork，active path 高亮（仅文本注释，因为 mermaid 主题不允许显式色）

### 4. redact / audit 集成

- [ ] `lib/redact.js` 增加 `redactSessionTree(tree, mode)`：递归对每个 node 走现有 `redactMessage`
- [ ] `lib/runTool.js` 在 transformResult 阶段调 `redactSessionTree`
- [ ] 三个工具默认 `redact='off'`（仅 sha256 + length），与 `get_session` 一致
- [ ] 审计：READ 工具不写 audit.jsonl（与现有 READ 一致）

### 5. 测试

- [ ] 在 TEST_SID 上手动构造分支：1 个 user 编辑 2 次 + 1 个 assistant 重生 2 次（共 3 个分支点）
- [ ] `get-session-tree` 输出验证：`branchPointIds.length == 3`；`activePathIds.length` 等于 UI 当前可见消息数
- [ ] `get-branch-path` 在被埋藏分支 leaf 上能正确还原路径
- [ ] 单元测试 `buildSessionTree` 纯函数（fixture：手写一个 7 节点树 + 2 分支点）
- [ ] 多 root 异常 fixture / 孤儿节点 fixture / 空树 fixture
- [ ] 真实测试 session（292 节点）的 snapshot 测试（保留 `result.json` 当 fixture）

### 6. 文档

- [ ] 修订 [docs/dev/api-endpoints.md](./api-endpoints.md) 中 `history_messages` 段落（"chat_messages[] 是全树并集"）
- [ ] [SKILL.md](../../SKILL.md) 工具清单 +3 行（READ 13 个）
- [ ] [SKILL.md](../../SKILL.md) "常用 CLI 示例" 加 get-session-tree
- [ ] [docs/dev/bridges-cheatsheet.md](./bridges-cheatsheet.md) 新增 `buildSessionTree` 入口

### 7. CHANGELOG

- [ ] 新版本 `v0.4.0`（minor，新增能力，无破坏）
- [ ] 描述格式参考 v0.3.x：列出新工具 / 新文档 / 修订项

---

## 后续可选（二期+）

- mermaid 输出可点击导航（chat 页 SPA）：当前 mermaid 不允许 `click`，可考虑生成 graphviz 替代
- 增量同步：使用 `cache_version` / `cache_reset_at` 减少全量拉取
- 分支命名 / 标记：在本地 cache 给分支点起人类可读 alias（不写回服务端）
