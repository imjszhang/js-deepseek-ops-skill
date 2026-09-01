# js-deepseek-ops-skill — Skill Records 目录

> 这个目录由 [`js-deepseek-ops-skill`](https://github.com/imjszhang/js-eyes) 的工具调用自动写入。

## 注意：这里可能包含私密对话内容

`js-deepseek-ops-skill` 默认走严格隐私设置：

- `history/`：按月滚动的 `tool_calls.jsonl`，**只记 metadata**（工具名 / 时间戳 / duration / runId / cache_key），**不含正文**
- `audit/`：写操作审计；prompt、正文、token、cookie、请求 body 等敏感字符串仅保存 `length + sha256`
- `backups/`：不可逆操作前的脱敏快照；快照写入失败时操作不会执行
- `debug/`：仅在 `--debug-recording` 模式下生成；包含步骤时间线 / target meta / bridge meta / **result 快照**
  - 即便 debug 模式开启，`deepseek_get_session` 的 `messages[].content` / `thinkingContent` 默认仍被 redact 成 `{length, sha256}` 摘要
  - 只有同时传 `--redact full --debug-recording` 才会落正文
- `sync/`：增量同步水位（`deepseek_sync_sessions` / `deepseek_sync_session`）
  - `index.json` / `sessions/<id>/meta.json` **只含元数据与 content hash**，不含正文
  - 仅当显式 `storeTree=true` / `--store-tree` 时才会写 `sessions/<id>/tree.json`（**含私聊正文**，0600）

但如果你显式传 `--redact full --debug-recording`，**debug 目录会包含原文 DeepSeek 私聊**。
POSIX 上根目录/子目录会收紧为 `0700`，记录文件会收紧为 `0600`。

## 建议

1. **不要把这个目录提交到 git**：建议在 `~/.gitignore_global` 里加上：
   ```
   /.js-eyes/skill-records/
   ```
   或更精确：
   ```
   /.js-eyes/skill-records/js-deepseek-ops-skill/
   ```
2. **不要把这个目录上传到云盘 / 对象存储 / 同步盘**
3. **定期清理**：保留必要 debug bundle 后，可以全量清理：
   ```bash
   rm -rf ~/.js-eyes/skill-records/js-deepseek-ops-skill/
   ```
4. 平时使用建议保持默认 `redact='off'`，需要原文时显式按需打开

## 目录结构（参考）

```text
~/.js-eyes/skill-records/js-deepseek-ops-skill/
├── README.md                         <- 本文件
├── history/
│   └── tool_calls-2026-04.jsonl      <- metadata only
├── audit/
│   └── audit.jsonl                   <- 默认脱敏的写操作审计
├── backups/
│   └── share-<id>-<timestamp>.json   <- 不可逆操作前的脱敏快照
├── sync/
│   ├── index.json                    <- 会话列表水位（title 仅 length+sha256）
│   └── sessions/<sid>/
│       ├── meta.json                 <- messageId→hash
│       └── tree.json                 <- 仅 --store-tree，含正文
└── debug/
    └── <runId>/
        ├── meta.json
        ├── steps.jsonl
        └── result.json               <- 已 redact 处理的结果
```

详细策略见 [`SKILL.md`](https://github.com/imjszhang/js-eyes/blob/main/skills/js-deepseek-ops-skill/SKILL.md) 的「Recording」章节。
