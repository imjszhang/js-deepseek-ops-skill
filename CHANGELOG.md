# Changelog

本仓库的版本历史与根因索引。SKILL.md 只保留前向规划，所有"已发生"的变更与事故复盘都迁到这里。

## v0.8.0 — 历史会话增量同步（2026-09-01）

本地水位索引 + 按脏会话拉历史。权威数据仍在 DeepSeek；`get_session` 默认行为不变。

### 新增

- READ `deepseek_sync_sessions` / CLI `sync-sessions [--full]`：翻 `fetch_page`，写 `{skillDir}/sync/index.json`
- READ `deepseek_sync_session` / CLI `sync-session [--force] [--store-tree]`：version 短路或合并 `meta.json`
- `lib/sync/`：store / diffSessions / mergeMessages / interpretHistory / runSync
- ADR-002、`docs/dev/cache-version-scout.md`（L1 合同未填完前空数组不当 not-modified）

### 行为

- 存储不走框架 cache（`noCache: true` 仍在）。目录 `0700`、文件 `0600`。title 落盘只存 length+sha256
- 两级 version：`listVersion`（列表）与 `syncedVersion`（已拉历史），避免 list 同步后误跳过
- STREAMING/WIP/PENDING 标 `pending`，不抬 syncedVersion
- L1 只认 HTTP 304 / `biz.not_modified` / `cache_valid`；`cache_reset_at` 变化按 reset 删幽灵 id
- `--store-tree` 才写 `tree.json`；工具返回永不带正文
- home-bridge `0.3.6` → `0.3.7`（`getSessionForSync`）；chat-bridge `0.3.17` → `0.3.18`（`fetchHistoryMessagesRaw` 抽到 common.js）

### 不做的事

- 不改 `get_session` / `get_session_tree` 读本地
- 不实现 delete_session
- 不把空 `chat_messages` 猜成 not-modified（等踊点合同）

## v0.7.0 — 新对话 composer chrome（2026-09-01）

- `chat_page_state` 增加只读 `chrome`：`modelType` / `modelLabel` / `thinkingEnabled` / `searchEnabled` / `attachVisible` / 精简 `models`。
- `dom_send_message` 可选 `mode`（`default|expert|vision`）、`thinking`、`search`。未指定字段不改页面现状；专家模式显式 `search=true` 回 `search_not_available_in_mode`。
- CLI：`--mode`；`--thinking`/`--search` 与 `--no-thinking`/`--no-search`。省略 flag 不再把开关当成 false。
- audit 脱敏对 `thinking: undefined`（未指定开关）不再抛错。
- 共享逻辑：`lib/composerOptions.js` + `readComposerChrome` / `applyComposerChrome`。home-bridge `0.3.5` → `0.3.6`，chat-bridge `0.3.16` → `0.3.17`。
- 本期不做：API `create_session`/`completion` 的 `model_type`、DOM 选文件、发送后拨回原模式、`chat_settings_view` 的 `SETTINGS_NOT_FOUND`。

## v0.6.0 — 对齐 js-eyes 2.10.0 skill-scaffold（2026-09-01）

- `@js-eyes/client-sdk` / `config` / `skill-recording` / `runtime-paths` 升到 `^2.10.0`，新增 `@js-eyes/skill-scaffold`。
- `skill.contract.js` 重命名为 `skill.definition.js`：每个工具自带 `risk` + `capabilities`，导出改用 `createDefinitionEnvelope`；删除 `createOpenClawAdapter`。
- `skill.entry.js` 用 `createNativeHandlers`，仍保留 scoped storage / 设置 allowlist 桥接。
- `skill.manifest.json` 由 scaffold `writeSkillManifest` 从 definition 生成；闭合 schema 在 definition 内先硬化。
- `lib/runContext.js` 改用 `createUrlSkillRunContext`。宿主下限仍为 JS Eyes 2.8.5。
- 兼容 DeepSeek 2026-09 composer：发送按钮改为 `ds-button--primary` 圆形按钮；`findComposerSendButton` / `findComposerStopButton` 同时认新旧选择器。home-bridge `0.3.4` → `0.3.5`，chat-bridge `0.3.15` → `0.3.16`。

## v0.5.0 — Skill Runtime V2 与安全收敛（2026-07-22）

- 新增静态 `skill.manifest.json`、`skill.entry.js` 与生成/漂移检查脚本；33 个工具可由
  JS Eyes >=2.8.5 作为外部 V2 skill 在 Worker 中加载。
- 为每个工具声明风险、闭合输入 schema 与最小能力；账号设置工具标为
  `administrative`，并增加默认拒绝的字段 allowlist。
- 复用 `@js-eyes/client-sdk`，删除仓库内 457 行旧客户端副本；升级 Node 下限至 22。
- audit/backup 默认深度脱敏，POSIX 目录/文件权限收紧至 `0700/0600`；history 不再
  把完整参数编码进伪 URL。
- V2 history/debug/audit/backup 统一写入宿主分配的 scoped skill storage，不再依赖
  Worker 的用户主目录；每次新建 history/debug 后再次强制私有权限。
- CLI export、树形输出和 branch-manager 工作区文件统一使用 `0600`；branch-manager
  scan 默认从 `full` 改为 `off`。
- `unshare_session` 补齐分享列表快照，任何不可逆工具在快照读取或落盘失败时都拒绝执行。
- 新增 V2 manifest、脱敏、权限、设置 allowlist、schema、共享 SDK 与 backup 单测。

> 本节的安全语义取代下方 v0.3 历史条目中“无 confirm / audit 保存完整原文”的旧设计。

## v0.4.1 — 测试基础设施 + 树形可视化（2026-05-07）

v0.4.0 的内部巩固版本：把 `buildSessionTree` 抽到独立的 `lib/sessionTree.js`，引入
`node:test` 单测基础设施，并新增 mermaid / ascii 树形输出。零新依赖、零 destructive、
零回归。

### 新增

- [`lib/sessionTree.js`](lib/sessionTree.js)：`buildSessionTree` + `_emptyTreeStats`
  的**唯一**定义；改为「依赖注入式」纯函数（`deps = { normalizeChatMessage,
  normalizeChatSessionItem, clampLimit }`）。dual-mode：Node 端 `require` 直用，
  Browser 端通过 `// @@include ../lib/sessionTree.js` 文本嵌入到 IIFE scope。
- [`lib/treeFormat.js`](lib/treeFormat.js)：`formatAsMermaid` / `formatAsAscii`
  纯函数；active path 用粗边 / `*` 前缀标记；`maxNodes` 截断（默认 200）。
- [`tests/`](tests/) 目录 + `npm test`（基于 Node 内置 `node:test`，无新依赖）：
  - `tests/buildSessionTree.test.js`：手写小树 + 异常 fixture（multi-root / 孤儿 /
    currentMessageId 不在树 / 空树 / deps 缺失）+ 真实 session-292 fixture（存在时跑）
  - `tests/loaderExpand.test.js`：验证 `@@include` 扩展行为
  - `tests/helpers/loadBridgeNormalizers.js`：vm sandbox 加载 `bridges/common.js`
    提取真实 normalizer，单一来源零副本
- CLI：`get-session-tree` / `get-branch-path` 新增 `--format mermaid|ascii`
  和 `--out <path>`；JSON 仍是默认。

### 修改

- [`lib/session.js::expandBridgeSource`](lib/session.js)：`@@include` 现支持任意
  相对路径（向后兼容 `@@include ./common.js`）；新增 `opts.baseDir`；不递归。
- [`bridges/chat-bridge.js`](bridges/chat-bridge.js)：删 130 行内联
  `buildSessionTree`，改为 `@@include ../lib/sessionTree.js`；调用处显式传 deps。
  VERSION `0.3.14` → `0.3.15`。
- [`package.json`](package.json)：`engines.node` `>=16.0.0` → `>=18.0.0`（`node:test`
  内置稳定）；新增 `scripts.test`；version `0.4.0` → `0.4.1`。

### 不做的事

- 不做增量同步（`cache_version` / `cache_reset_at`）
- 不做本地树缓存
- 不做 home-bridge 镜像（推迟 v0.4.2）
- 不做 diff-branches（推迟 v0.4.2）

## v0.4.0 — 全分支树读取（2026-05-07）

DeepSeek 单会话内"上一个分支 / 下一个分支"切换器背后的完整消息树首次对外暴露。
核心发现：`/api/v0/chat/history_messages` **单次响应即返回会话全树节点的并集**
（含被埋藏的旧分支兄弟），并非此前文档里描述的"当前主干"。详见踩点报告
[`docs/dev/branch-scout.md`](docs/dev/branch-scout.md) 与决策记录
[`docs/dev/adr-001-branch-tree-route.md`](docs/dev/adr-001-branch-tree-route.md)。

实测对照：测试 session `d54aadf1-...` 全树 292 节点，17 个分支点（最多 4 children），
active path 长度 126，**166 条（57%）消息在 UI 上看不到** —— 全部由 v0.4.0 的新工具
还原。

### 新增工具（READ，3 个）

- `deepseek_get_session_tree`：返回 SessionTree（`nodes` map + `activePathIds` +
  `branchPointIds` + `stats`），每节点带 `childrenIds` / `siblingIndex` /
  `isOnActivePath` / `isBranchPoint` / `isLeaf` / `depth` 等树重建字段
- `deepseek_list_branch_points`：仅列分叉点 + children 摘要（轻量发现，永不带正文）
- `deepseek_get_branch_path`：从指定 `leafMessageId` 反推 root 的线性 messages[]，
  schema 与 `deepseek_get_session` 兼容（drop-in）；leaf 省略时等价于 active path

CLI：`get-session-tree` / `list-branch-points` / `get-branch-path`（后者支持
`--leaf <messageId>`）。

### 新增 / 修改

- `bridges/chat-bridge.js`：新增纯函数 `buildSessionTree(rawSession, rawMessages, options)`
  + 3 个 READ 方法；VERSION 升到 `0.3.14`
- `lib/redact.js`：新增 `redactSessionTreeResult` 与三个 transform 工厂
  （`buildGetSessionTreeTransform` / `buildGetBranchPathTransform` /
  `buildListBranchPointsTransform`）；list_branch_points 沿用 list_messages 的"防漏
  断言"模式
- `skill.contract.js`：`TOOL_DEFINITIONS` +3（READ 段，自定义 `execute` 套 transform，
  与 `deepseek_get_session` 同模式）
- `lib/commands.js`：`COMMANDS` +3，`parseArgv` 增 `--leaf` / `--leaf-message-id`
- 文档：`SKILL.md` 工具清单更新；`docs/dev/api-endpoints.md` 修正
  `history_messages` 段（"chat_messages[] 是全树并集"）；`docs/dev/bridges-cheatsheet.md`
  补 `buildSessionTree` 入口

### 安全与兼容

- 全部 READ 档：**零 destructive、零 audit、零 backup**；redact 默认 `off`，与
  `get_session` 一致
- 完全 additive：`get_session` / `list_messages` / `get_message` 行为不变；
  仅补强 `docs/dev/api-endpoints.md` 描述
- 仍走 chat 页 bridge（pageKey: `chat`）；home-bridge 未镜像（与 `get_session` 一致）

### 不做的事（推迟到后续小版本）

- mermaid / graphviz 树形可视化输出（CLI `--format mermaid`）
- 增量同步（利用观察到的 `cache_version` / `cache_reset_at` query 参数）
- 本地树缓存（`~/.js-eyes/skill-records/.../cache/tree-<sid>.json`）
- home-bridge 镜像 3 工具

## v0.3.3 — 下线 delete_session（2026-05-07）

按用户要求移除"删除会话"工具。删除会话是真正不可逆操作，本地
`getSessionSnapshot` backup 只能记录元数据 + content hash，无法还原服务端
真实数据，"自动 backup"给出的安全感是虚的。为避免被 LLM 在多步任务中
误调用，整体下线，不再保留 dry-run 入口。如需清理测试会话，请走 DeepSeek
官方 Web UI 手动删除。

### 移除项

- contract：`deepseek_delete_session` 工具定义 + `prefetchSessionBackup` helper
- CLI：`delete-session` 命令、`--help` 示例、`package.json` script
- bridge：`bridges/chat-bridge.js` `deleteSession`（VERSION → 0.3.13）、`bridges/home-bridge.js` `deleteSession`（VERSION → 0.3.4）
- 文档：`SKILL.md` DESTRUCTIVE 工具计数 15 → 14、`docs/dev/api-endpoints.md` 把 `/api/v0/chat_session/delete` 标为"永不实现"

### 保留项

- `getSessionSnapshot` bridge 方法（chat + home）保留，未来 export / 备份场景仍可复用
- `lib/audit.js` 的 backup 写盘能力保留，仍服务于 `unshare_session` 等其它 irreversible 工具
- 端点本身在 DeepSeek 服务端依然存在，本仓库只是不再封装

## v0.3.2 — DOM 模式 byMessageId（解锁虚拟化历史消息）

v0.3.1 的 `dom_edit_message` / `dom_regenerate_message` 仅支持 `lastUser` / `lastAssistant`，因 `.ds-virtual-list` 离屏剔除 + DeepSeek 无 `data-message-id` 锚点。本版补齐 `target=byMessageId` 支持，可对会话内任意消息（含远 offscreen 历史）操作。

### 新增能力

- `deepseek_dom_edit_message` / `deepseek_dom_regenerate_message` 增 `target: 'byMessageId' | 'lastUser' | 'lastAssistant'` + `messageId` 参数
- CLI 增 `--message-id <N>`（也接受 `--msg-id`）

### 关键算法 `_locateMessageInVirtualList`（chat-bridge）

1. 从 `history_messages` API 拉 target 消息，取 content head：短内容（≤8 字符）整段当指纹，长内容取前 30 字
2. **role 反推**：`.ds-message` 气泡 + `findMessageActionRows()` 聚类。每个气泡找 `bubble.bottom` **下方**最近的 action row，其 role 即为该气泡的 role。**坑**：最初用 `abs(y)` 最近会把高 ASSISTANT 气泡误配到上方 USER row（USER row y=144 离 ASSISTANT bubble y=188 比 ASSISTANT row y=331 还近 100px），改为"bubble.bottom 之下"才正确
3. **内容匹配 + 滚动 sweep**：当前 viewport 找不到 → 从 0 按 `clientHeight - 100` 步长扫到底，直到匹配
4. **Edit 历史 USER 路径**：定位到 `.ds-message` 气泡后，找气泡邻近 USER action row，点 `buttons[1]`（编辑按钮），等内联 textarea 出现，setReactInputValue + 点"发送"
5. **Edit 最后 USER 路径**（沿用 v0.3.1）：直接在天然 textarea 上 setReactInputValue
6. **死分支检测**：DeepSeek edit 会 fork 新分支，旧分支消息不在 DOM。返回 `message_not_in_current_branch_or_dom` + 友好 hint

### 验证记录（2026-05-06，全部已 cleanup）

| 场景 | 工具 | messageId | usedPath | 耗时 | 结果 |
|---|---|---|---|---|---|
| 编辑最早历史 USER | `dom-edit-message` | msg1 | `byMessageId_via_edit_button` | 11.6s | 新分支 msg7+8 |
| 重生当前分支 ASSISTANT | `dom-regenerate-message` | msg8 | `byMessageId` | 6.4s | msg9 新生 |
| 重生**死分支** ASSISTANT | `dom-regenerate-message` | msg2 | n/a | 立刻 | `message_not_in_current_branch_or_dom` |
| 编辑**远 offscreen** USER (y=-5288) | `dom-edit-message` | msg7 | `byMessageId_via_edit_button` | 3.9s | 自动滚虚拟列表后 fork 新分支 msg14+15 |

第二批多轮对话回归（4 轮 / 6 消息会话上验证 byMessageId + 默认路径互通）：

| 场景 | usedPath | 耗时 | 备注 |
|---|---|---|---|
| 历史 ASSIST regen by id | `byMessageId` | 3.8s | 创建兄弟 regen msg7 |
| 历史 USER edit by id | `byMessageId_via_edit_button` | 5.0s | fork msg8+9 |
| 当前分支 last USER edit by id | `byMessageId_via_edit_button` (`isLast=true` 自动检测) | 5.0s | fork msg10+11 |
| `lastAssistant` 默认路径 regen | `lastAssistant` | 3.8s | msg12 兄弟 regen |
| 同内容歧义场景（多个 "R1" 气泡）| 命中任一 R1 ASSIST | — | content fingerprint 不区分相同内容；可用 `resolvedTargetMessageId` 事后核对 |

### 基础设施

- `bridges/chat-bridge.js` VERSION `0.3.9 → 0.3.12`：`_locateMessageInVirtualList`、`_findEditSendButton`、`domEditMessage` / `domRegenerateMessage` 加 `byMessageId` 分支
- `skill.contract.js`：参数 schema 加 `target` enum 和 `messageId`
- `lib/commands.js`：`parseArgv` 加 `--message-id` / `--msg-id`，CLI toArgs 自动 `target` 切换

---

## v0.3.1 — DOM 模式（绕开 PoW 限制）

`/api/v0/chat/completion` / `edit_message` / `regenerate` 三个端点都强制 PoW（DeepSeekHashV1 / WASM 实现），bridge 内复刻代价过高，导致 v0.3.0 的对应工具在生产环境只能拿到 `pow_required`。同时 API 直创的会话在标题未生成前不会显示在 UI 侧栏，对人工/agent 协作不友好。本版引入 DOM 模式，让浏览器自己解 PoW、自己渲染会话。

### 新增 AI 工具（共 4 个，全部 DESTRUCTIVE）

- **`deepseek_dom_send_message`** [COST]：在 composer 输入并点击发送。在 `/` 上自动创建可见会话；在 `/a/chat/s/<sid>` 上则追加发言。返回 `{sessionId, isNewSession, waitedFinish, messageCount, lastMessage}`，可选 `waitForFinish=false` 跳过流式等待
- **`deepseek_dom_edit_message`** [COST]：编辑最后一条 USER 消息。**关键发现**：DeepSeek 把每条 USER 消息渲染为 inline `<textarea>`（非 readonly），直接 `setReactInputValue(userTa, newPrompt)` 后 UI 自动出现 `[取消, 发送]` 按钮 —— 因此不需要点击任何"编辑"action button。等待新生消息 messageId > beforeMaxId
- **`deepseek_dom_regenerate_message`** [COST]：重生最后一条 ASSISTANT 消息。定位策略：`findMessageActionRows()` 把 `.ds-icon-button--m` 按 y 聚类成行（USER=2、ASSISTANT=5 个按钮），ASSISTANT 行索引 1 = 重新生成
- **`deepseek_dom_stop_stream`** [reversible]：流式中点击 composer 行最右按钮（停止与发送 UI 占同一槽位）

### 基础设施

- **`bridges/common.js`** 加 helper：
  - `setReactInputValue`（受控输入必走 prototype setter + `input`/`change` 事件）
  - `findComposerSendButton`（兼容 `<button>` / `<div role=button>` / 纯 `<div class=ds-icon-button>` 三种实测形态；过滤 `--disabled` cls）
  - `findComposerStopButton`（同位置但流式中也算 enabled）
  - `findMessageActionRows`（按 y 聚类 `.ds-icon-button--m`，2=USER / ≥4=ASSISTANT；为虚拟列表外消息留 caveat）
  - `waitFor`（通用轮询，支持 initialDelayMs）
- **`bridges/chat-bridge.js`** VERSION `0.3.4 → 0.3.9`：加 `domSendMessage` / `domEditMessage` / `domRegenerateMessage` / `domStopStream`，加 `_findActionRow` 内部 helper（含 scrollIntoView）
- **`bridges/home-bridge.js`** VERSION `0.3.2 → 0.3.3`：镜像加 `domSendMessage`（home 页 composer 同形态）
- **`lib/commands.js`** 加 4 个 CLI：`dom-send-message` / `dom-edit-message` / `dom-regenerate-message` / `dom-stop-stream`；新增 `--no-wait` / `--sid-timeout` / `--finish-timeout` 选项
- **`skill.contract.js`** `makeDestructiveExecutor` 给 `domSendMessage` / `domEditMessage` / `domRegenerateMessage` 单独配 180s timeout
- **`cli/index.js`** 同步 timeout 白名单

### 验证记录（2026-05-06，全部已 cleanup）

| 场景 | 工具 | 起始 | 耗时 | 结果 |
|---|---|---|---|---|
| 已有会话内追问 | `dom-send-message` | `/a/chat/s/<sid>` (12 字符 prompt) | 11.5s 流式完成 | 新增 USER+ASSISTANT 两条 |
| 从 `/` 创建可见会话 | `dom-send-message` | `/` | sid <0.5s + finish 2.2s | 新会话 + assistant "ok" |
| 编辑最后 USER 消息 | `dom-edit-message` | 含 1033 char assistant 的会话 | 3.8s 完成 | 新生 user msgId+1, assistant msgId+2 |
| 重生最后 ASSISTANT | `dom-regenerate-message` | 同上 | 5.2s 完成 | assistant msgId 增长 |

回归：DOM 创建的会话上跑了曾因 `EMPTY_CHAT_SESSION` 失败的 `rename-session` / `pin-session` / `feedback-message` / `unpin-session`，**全部 `ok=true`**，确认空会话约束属服务端业务规则，DOM 模式注入首条消息后即解除。所有测试会话已 `delete-session` 清理（含自动 backup）。

### 探针发现的关键 UI 行为（写给后人）

1. **USER 消息天然是 textarea**：DeepSeek 把每条 user 消息渲染成 `<textarea class="ds-textarea__textarea ...">` 且非 readonly。修改其 value（必须走 React setter） 会让 UI 自动出现 `[取消, 发送]` 按钮。这是 `domEditMessage` 极其简洁的根因。
2. **action 按钮其实不是 `<button>`**：实测多为 `<div class="ds-icon-button ...">`，无 `role="button"`。所以选择器必须用 `.ds-icon-button` 而非 `button.ds-icon-button`。
3. **虚拟列表会移除离屏消息**：`.ds-virtual-list` 仅渲染 viewport 附近行，离屏消息及其按钮都不在 DOM。导致 `domEditMessage` 在 assistant 长回复 + USER 上滚出视口的会话上需要 `scrollIntoView`。
4. **assistant 行 5 个按钮的槽位**（实测 path d 排列）：`[0]复制, [1]重新生成, [2]喜欢, [3]不喜欢, [4]分享/引用`。USER 行 2 个：`[0]复制, [1]编辑`，但编辑路径不必走它。

---

## v0.3.0 — **BREAKING：安全姿态反转，DESTRUCTIVE 全量解锁**

把 skill 从只读升级为完整 ops 工具。`SKILL.md` 的"明确不做的事"段整段废弃；不再做调用前 confirm；改为 **audit 模式**：destructive 调用直接执行，但完整请求体 + 响应强制写入 `audit.jsonl`；`delete_session` / `unshare_session` 等不可逆操作前自动 backup。

### 新增 AI 工具（共 14 个，3 READ + 11 DESTRUCTIVE）

**READ**：`deepseek_list_files` / `deepseek_list_shares`，外加 `chat_page_state` 等已有

**DESTRUCTIVE,reversible**：`deepseek_create_session` / `deepseek_rename_session` / `deepseek_pin_session` / `deepseek_unpin_session` / `deepseek_feedback_message` / `deepseek_stop_stream` / `deepseek_upload_file` / `deepseek_share_session` / `deepseek_update_user_settings`

**DESTRUCTIVE,irreversible**：`deepseek_delete_session`（auto-backup） / `deepseek_unshare_session`

**DESTRUCTIVE,cost**：`deepseek_send_message` / `deepseek_edit_message` / `deepseek_regenerate_message`

### 新增基础设施

- **`lib/audit.js`** （新）：`writeAuditEntry(runContext, {tool, args, result, sideEffect, backupPath})` 写完整请求体到 `~/.js-eyes/skill-records/<skill>/audit/audit.jsonl`；`writeBackup(runContext, {resource, id, snapshot})` 写到 `backups/<resource>-<id>-<ts>.json`
- **`lib/runTool.js`** 加 destructive 分支：调用前若 `sideEffect==='irreversible'` 跑 `prefetchBackup` 函数拿当前 snapshot 落盘；调用后强制 `writeAuditEntry`，**跳过 transformResult 的 redact**（destructive 调用的 prompt 原文必须保留作 audit 凭证）；response 多回 `destructive / sideEffect / backupPath` 字段
- **`skill.contract.js`** 加 `makeDestructiveExecutor` 与 `prefetchSessionBackup` 工厂；`TOOL_DEFINITIONS` 加 `destructive` / `sideEffect` 字段；`projectTool` 投射出新字段
- **`lib/commands.js`** 加 `kind: 'destructive'` 命令族，外加 `parseArgv` 新选项：`--thinking / --search / --include-content / --parent / --timeout / --comment / --mime / --session / --title / --format / --out / --agent`
- **`cli/index.js`** 加 `runDestructiveCommand`（携带 `prefetchBackup` 闭包）+ `runExportSessionLocal`（本地导出 JSON / Markdown）
- **`bridges/chat-bridge.js`** VERSION `0.2.1 → 0.3.4`：加 14+ destructive 方法；`fetchDeepseekJson` 已支持 POST/body；`solvePowChallenge` 调 `/api/v0/chat/create_pow_challenge`；`sendMessage` / `editMessage` / `regenerateMessage` 走原生 `fetch + ReadableStream` 解 SSE，聚合后一次性返回 `{messageId, contentLength, contentSha256, usage, chunkCount, ...}`，默认不返正文；新增 `getSessionSnapshot` 给 `delete_session` 的 prefetchBackup 用
- **`bridges/home-bridge.js`** VERSION `0.2.0 → 0.3.2`：镜像加上 `createSession / renameSession / pinSession / unpinSession / deleteSession / shareSession / unshareSession / listShares / updateUserSettings / getSessionSnapshot`，让 home 页也能跑会话管理而不需先 navigate
- **`package.json`** version `0.2.x → 0.3.0`，scripts 加 14+ 条新 CLI

### 端点踩点新发现

webpack scan 拿到完整端点目录（36 项），落 `docs/dev/api-endpoints.md` 全景表。Schema 试探确认：

- `chat_session/update_title` / `update_pinned` 对空会话回 `EMPTY_CHAT_SESSION`（服务端约束，非 bug）
- `chat/message_feedback` 真实 schema：`feedback_type ∈ {"GOOD", "BAD", null} + feedback_tag + description`，CLI 兼容数值 `1/-1/0`
- `chat/completion` 必需 `X-DS-PoW-Response` header（注意大小写）
- `share/list` 是 GET，必带 `?count=N`

### 已知限制（v0.3）

- **PoW solver 未实现**：`/chat/completion` 等需要 `DeepSeekHashV1` 算法（基于 `static/sha3_wasm_bg.*.wasm` worker）；bridge 端复刻成本高，当前透传 `answer:0`，server 回 `40301 INVALID_POW_RESPONSE`，工具返回 `error.code='pow_required'`，骨架 + audit 链路完整可用
- **`stop_stream` schema 待补**：bridge 已注册端点但请求体可能少字段，422 表明需要 active stream 时再踩
- **平台子域 API key**：`platform.deepseek.com` 子域工具未实现（需新增 page profile + bridge）

### 测试纪律

所有 destructive 测试在专属 TEST_SID 内做：
- 创建：`create_session` 拿到新 sessionId
- 修改：`rename_session` / `pin_session` / `feedback_message`
- 删除：`delete_session`（验证 backup 文件落盘）
- 真实 `delete_session` 调用 audit jsonl 实测含 `backup_path` 字段，backup 文件可读

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
