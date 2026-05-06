# Bridges 速查表（v0.1）

给本仓库开发者的「踩坑提示 + 接口契约」速查表。完整设计见 [`SKILL.md`](../../SKILL.md) 与 [`api-endpoints.md`](./api-endpoints.md)。

## 三个一定会踩的坑

### 1. `fetch` 必须用绝对 URL

bridge 跑在浏览器扩展的隔离上下文里。**相对 URL** 在隔离上下文里会抛 `... is not a valid URL`，跟 page context 行为不同。

```js
// BAD
await fetch('/api/v0/users/current');

// GOOD：buildDeepseekUrl 已经处理了 origin
await fetchDeepseekJson('/api/v0/users/current');
```

### 2. bridge VERSION 必须 bump

`session.ensureBridge()` 用 `__meta.version` 判断是否重注。**改了 bridge 的任意方法 / common.js 之后忘记 bump，下次调用会拿到旧 bridge**——非常隐蔽。

```js
// bridges/home-bridge.js
const VERSION = '0.1.0';   // 改了这里任意方法都要 bump 这个字符串
```

### 3. `navigateLocation` 跨域硬约束

`bridges/common.js::navigateLocation` 写死只接受 `*.deepseek.com`：

```js
if (!/(?:^|\.)deepseek\.com$/i.test(parsed.hostname)) {
  return errResult('cross_origin_navigation_forbidden', { hostname: parsed.hostname });
}
```

不要尝试在外面绕开（比如先 `history.pushState` 再 `location.assign`），会把 INTERACTIVE 档玩成 DESTRUCTIVE。

## 五件套契约

每个 bridge（`home-bridge.js` / `chat-bridge.js`）都必须暴露：

```js
window.__jse_deepseek_<name>__ = {
  __meta: { version, name },
  async probe(),       // 页面指纹 + 登录态 + bridge 自描述
  async state(),       // 当前页是否 ready（ready=true 才能跑业务方法）
  async sessionState(),// 全局登录态（与 home-bridge 一致即可）
  navigateXxx(args),   // 仅 location.assign，跨域被拒
  // ...各 profile 自己的业务方法
};
```

返回值统一用 `okResult(data)` / `errResult(code, extra)`。

## 实用工具（lib/）

| 文件 | 作用 |
|---|---|
| `lib/session.js::Session` | bridge 注入 / 调用的最小生命周期；`callApi(method, args)` 是日常入口 |
| `lib/runTool.js::runTool` | READ 工具公共流（history + debug，**不走 cache**），支持 `transformResult` hook |
| `lib/redact.js::buildGetSessionTransform` | 给 `deepseek_get_session` 用的 redact transform，会装进 `runTool` 的 `options.transformResult` |
| `lib/redact.js::buildGetSessionTreeTransform` / `buildGetBranchPathTransform` / `buildListBranchPointsTransform` | v0.4.0 全分支树工具的 redact transforms |
| `lib/sessionTree.js::buildSessionTree(rawSession, rawMessages, options, deps)` | **v0.4.1 起**单一来源（v0.4.0 之前内联在 chat-bridge.js）。dual-mode：Node 端 `require` 直用，Browser 端通过 `// @@include ../lib/sessionTree.js` 嵌入 IIFE。是 `getSessionTree` / `listBranchPoints` / `getBranchPath` 的共享内核。`deps` 必须包含 `{ normalizeChatMessage, normalizeChatSessionItem, clampLimit }`（依赖注入）。详见 [`session-tree-schema.md`](./session-tree-schema.md) |
| `lib/treeFormat.js::formatAsMermaid` / `formatAsAscii` | **v0.4.1**：SessionTree 可视化纯函数，输出 mermaid flowchart / ascii 缩进树。CLI `--format mermaid\|ascii` 走它 |
| `lib/runCliToFile.js::runCliToFile` | 跑 `node index.js <args>` 把 stdout 直写到文件（绕开 Node `>64KB` `child.stdout.pipe()` 截断坑） |
| `lib/toolTargets.js::homeUrl/chatSessionUrl` | 拼 navigate 目标 URL，避免硬编码 origin |

## `@@include` 文本预处理（v0.4.1 起）

`lib/session.js::expandBridgeSource` 在注入 bridge 前做一次性文本展开：

- `// @@include ./common.js`：嵌入 [`bridges/common.js`](../../bridges/common.js)（向后兼容）
- `// @@include ../lib/sessionTree.js`：v0.4.1 新增，把纯逻辑模块嵌入到 IIFE scope

支持任意相对路径，`baseDir` 默认 = `bridges/`。**不递归**：被嵌入文件中的 `@@include`
不再展开（避免环依赖，目前只需要一层）。读不到文件时抛带 `baseDir + relPath` 的清晰错误。

被嵌入的模块文件必须在末尾用 `if (typeof module !== 'undefined' && module.exports)`
守卫：Node 端走 export 路径；Browser 端 `module` 未定义、跳过 export，函数声明已在
IIFE scope 可见。

## 改 bridge 的 checklist

1. 读 `docs/dev/api-endpoints.md` 确认要用的端点已经有踩点结果
2. 跑 `node index.js xhr-log --filter "deepseek\\.com/api/v0/<your_endpoint>"` 验真
3. 改 `bridges/<x>-bridge.js` 或 `bridges/common.js`
4. **bump `bridges/<x>-bridge.js` 顶部的 `VERSION`**（漏 bump = 老 bridge 跑你的新代码）
5. 跑 `node index.js doctor` 验证整体连通
6. 跑相关 CLI 命令验证业务方法
7. 业务方法返回字段稳定后再加进 `skill.contract.js`

## 常见错误码（业务侧）

| `error` | 触发条件 | 含义 |
|---|---|---|
| `not_logged_in` | httpStatus 401/403 | `userToken` 失效 / 未登录；优雅返回，不抛 |
| `session_not_found` | httpStatus 404 | 会话已删除 / id 拼错 |
| `top_level_error` | `code !== 0` | DeepSeek 协议层错误，看 `msg` 字段 |
| `biz_error` | `biz_code !== 0` | DeepSeek 业务层错误，看 `bizMsg` |
| `network_error` | `fetch` 抛错 | 网络故障 |
| `non_json_response` | content-type 非 JSON | 通常是被风控拦截到登录页 |
| `cross_origin_navigation_forbidden` | navigate 传了非 deepseek.com URL | 硬约束，绝不放行 |
| `missing_session_id` | `getSession` / `navigateSession` 缺 sessionId | 入参错误 |
| `branch_leaf_not_found` | `getBranchPath` 传的 `leafMessageId` 不在树里 | 拼错或该消息已被服务端真删（罕见） |

## 故障排查（开发侧）

| 症状 | 排查方向 |
|---|---|
| `bridge_not_installed` | `__meta.version` 没找到。看 ensureBridge 是否真的注入；看 `Allow Raw Eval` 双侧是否都开 |
| `method_not_found` | bridge 改了方法但 VERSION 没 bump，老 bridge 仍在；强制 bump VERSION |
| stdout 被截断 | 改用 `lib/runCliToFile.js`，不要用 `child.stdout.pipe(fs.createWriteStream)` |
| `fetch_failed` 反复 401 | `userToken` 在 localStorage 里过期；浏览器重新登录一次 |
| 单会话历史消息很慢 / 巨大 | bridge 端 `contentMaxLen` 默认 60000；如确实需要可传 `--content-max-len 200000` |
