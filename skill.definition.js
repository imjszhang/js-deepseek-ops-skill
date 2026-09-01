'use strict';

const pkg = require('./package.json');
const { createDefinitionEnvelope } = require('@js-eyes/skill-scaffold');
const { BrowserAutomation } = require('./lib/js-eyes-client');
const { runTool } = require('./lib/runTool');
const { Session } = require('./lib/session');
const { resolveRuntimeConfig } = require('./lib/runtimeConfig');
const { PAGE_PROFILES } = require('./lib/config');
const targets = require('./lib/toolTargets');
const {
  buildGetSessionTransform,
  buildGetMessageTransform,
  buildListMessagesTransform,
  buildGetSessionTreeTransform,
  buildGetBranchPathTransform,
  buildListBranchPointsTransform,
} = require('./lib/redact');
const { ensureSkillRecordsReadme } = require('./lib/skillRecordsReadme');
const { assertAllowedUserSettings, resolveAllowedUserSettingKeys } = require('./lib/settingsPolicy');
const { hardenToolSchema } = require('./lib/toolSchema');

const BRIDGE_CAPS = Object.freeze([
  'browser.tabs.read',
  'browser.page.read',
  'browser.navigation',
  'browser.script.execute',
  'filesystem.skillData',
]);

function finalizeTools(tools) {
  return tools.map((tool) => {
    if (!tool.risk) throw new Error(`${tool.name}: missing risk (TOOL_DEFINITIONS is SSOT)`);
    return {
      ...tool,
      capabilities: tool.capabilities && tool.capabilities.length ? tool.capabilities : BRIDGE_CAPS.slice(),
      parameters: hardenToolSchema(tool.name, tool.parameters),
    };
  });
}

const CLI_COMMANDS = [
  { name: 'doctor', description: '连通性 + 登录态 + bridge 注入 + probe + state 汇总' },
  { name: 'probe', description: '采集页面指纹（按 page profile）' },
  { name: 'state', description: '读取当前 page profile 状态' },
  { name: 'session-state', description: '读取登录态' },
  { name: 'list-sessions', description: '列出历史会话（标题 / 时间 / 模型类型，不含正文）' },
  { name: 'get-session', description: '读取单个会话消息历史（默认 redact=off）' },
  { name: 'chat-page-state', description: '读取当前 chat 页 UI 状态快照' },
  { name: 'list-messages', description: '列出当前会话的消息元数据（永不含正文）' },
  { name: 'get-message', description: '读取单条消息（默认 redact=off）' },
  { name: 'get-session-tree', description: '读取会话全分支树（含被埋藏的旧分支兄弟）' },
  { name: 'list-branch-points', description: '仅列出会话中的分支点 + 每分支 children 摘要（轻量）' },
  { name: 'get-branch-path', description: '从指定 leaf messageId 反推 root 的线性路径（默认 leaf=current）' },
  { name: 'streaming-status', description: '一次性观察 assistant 是否在产出' },
  { name: 'chat-settings-view', description: '只读拉 /api/v0/client/settings' },
  { name: 'navigate-home', description: '导航到 / （INTERACTIVE）' },
  { name: 'navigate-session', description: '导航到 /a/chat/s/<id> （INTERACTIVE）' },
  { name: 'navigate-new-chat', description: '导航到 / 起新对话（INTERACTIVE）' },
  // DESTRUCTIVE
  { name: 'create-session', description: '[DESTRUCTIVE] 创建新会话，返回 sessionId' },
  { name: 'rename-session', description: '[DESTRUCTIVE] 重命名会话标题' },
  { name: 'pin-session', description: '[DESTRUCTIVE] 置顶会话' },
  { name: 'unpin-session', description: '[DESTRUCTIVE] 取消置顶会话' },
  { name: 'feedback-message', description: '[DESTRUCTIVE] 对单条消息发反馈（赞/踩/取消）' },
  { name: 'stop-stream', description: '[DESTRUCTIVE] 停止当前流式生成' },
  { name: 'send-message', description: '[DESTRUCTIVE,COST] 发消息触发流式生成（含 PoW）' },
  { name: 'edit-message', description: '[DESTRUCTIVE,COST] 编辑用户消息并重生（含 PoW）' },
  { name: 'regenerate-message', description: '[DESTRUCTIVE,COST] 基于 parent 重生 assistant 回复（含 PoW）' },
  { name: 'upload-file', description: '[DESTRUCTIVE] 上传文件（base64 输入）' },
  { name: 'list-files', description: '[READ] 列出当前账号上传的文件' },
  { name: 'share-session', description: '[DESTRUCTIVE] 创建分享链接' },
  { name: 'unshare-session', description: '[DESTRUCTIVE,IRREVERSIBLE] 删除分享链接' },
  { name: 'list-shares', description: '[READ] 列出当前账号的分享链接' },
  { name: 'update-user-settings', description: '[DESTRUCTIVE] 更新账号设置（白名单字段）' },
  { name: 'export-session-local', description: '[本地] 把单个会话导出为本地 JSON / Markdown' },
];

function makeLogger(logger) {
  return {
    info: typeof logger?.info === 'function' ? logger.info.bind(logger) : console.log.bind(console),
    warn: typeof logger?.warn === 'function' ? logger.warn.bind(logger) : console.warn.bind(console),
    error: typeof logger?.error === 'function' ? logger.error.bind(logger) : console.error.bind(console),
  };
}

function createRuntime(config = {}, logger) {
  ensureSkillRecordsReadme(config.skillDataRoot);
  const resolvedConfig = resolveRuntimeConfig(config);
  const runtimeConfig = {
    serverUrl: resolvedConfig.serverUrl,
    recording: resolvedConfig.recording,
    pages: Object.keys(PAGE_PROFILES),
    allowedUserSettingKeys: resolveAllowedUserSettingKeys(config),
    skillDataRoot: config.skillDataRoot || null,
  };
  const resolvedLogger = makeLogger(logger);
  let bot = null;
  return {
    config: runtimeConfig,
    logger: resolvedLogger,
    ensureBot() {
      if (!bot) bot = new BrowserAutomation(runtimeConfig.serverUrl, { logger: resolvedLogger });
      return bot;
    },
    textResult(text) { return { content: [{ type: 'text', text }] }; },
    jsonResult(value) { return this.textResult(JSON.stringify(value, null, 2)); },
    dispose() {
      if (bot && typeof bot.disconnect === 'function') { try { bot.disconnect(); } catch {} }
      bot = null;
    },
  };
}

function makeReadToolExecutor({ pageKey, method, toolName, buildTargetUrl, transformResult }) {
  return async function execute(runtime, params, context = {}) {
    const targetUrl = typeof buildTargetUrl === 'function' ? buildTargetUrl(params || {}) : null;
    return runTool(runtime.ensureBot(), {
      toolName, pageKey, method,
      args: params || {},
      targetUrl,
      options: {
        wsEndpoint: runtime.config.serverUrl,
        recording: runtime.config.recording,
        runId: context.toolCallId,
        navigateOnReuse: false,
        reuseAnyDeepseekTab: true,
        createUrl: targetUrl || 'https://chat.deepseek.com/',
        transformResult,
      },
    });
  };
}

/**
 * makeDestructiveExecutor - DESTRUCTIVE 工具统一执行器。
 * 强制走 runTool destructive 分支：写 audit；sideEffect=irreversible 时调
 * prefetchBackup 拿当前 snapshot 落盘。
 */
function makeDestructiveExecutor({ pageKey, method, toolName, sideEffect, buildTargetUrl, prefetchBackup }) {
  return async function execute(runtime, params, context = {}) {
    const targetUrl = typeof buildTargetUrl === 'function' ? buildTargetUrl(params || {}) : null;
    return runTool(runtime.ensureBot(), {
      toolName, pageKey, method,
      args: params || {},
      targetUrl,
      destructive: true,
      sideEffect: sideEffect || 'reversible',
      prefetchBackup,
      options: {
        wsEndpoint: runtime.config.serverUrl,
        recording: runtime.config.recording,
        runId: context.toolCallId,
        navigateOnReuse: false,
        reuseAnyDeepseekTab: true,
        createUrl: targetUrl || 'https://chat.deepseek.com/',
        timeoutMs:
          method === 'sendMessage' || method === 'editMessage' || method === 'regenerateMessage' ? 180000
          : method === 'domSendMessage' || method === 'domEditMessage' || method === 'domRegenerateMessage' ? 180000
          : 60000,
      },
    });
  };
}

async function prefetchShareBackup(session, args = {}) {
  const snapshot = await session.callApi('listShares', [{ count: 100 }], { timeoutMs: 30000 });
  if (!snapshot?.ok) {
    const error = new Error(`Unable to list shares before deletion: ${snapshot?.error || 'unknown error'}`);
    error.code = 'E_BACKUP_SOURCE_UNAVAILABLE';
    throw error;
  }
  return {
    resource: 'share',
    id: args.shareId,
    snapshot: { shareId: args.shareId, shares: snapshot.data?.shares || snapshot.data || null },
  };
}

function makeNavigateToolExecutor({ pageKey, method, toolName }) {
  return async function execute(runtime, params, context = {}) {
    const startedAt = Date.now();
    const session = new Session({
      opts: {
        page: pageKey, bot: runtime.ensureBot(), verbose: false,
        wsEndpoint: runtime.config.serverUrl,
        createIfMissing: true, navigateOnReuse: false,
        reuseAnyDeepseekTab: true, createUrl: 'https://chat.deepseek.com/',
      },
    });
    try {
      await session.connect();
      await session.resolveTarget();
      await session.ensureBridge();
      const navResp = await session.callApi(method, [params || {}]);
      if (!navResp || !navResp.ok) {
        return {
          platform: 'deepseek', toolName, pageKey, method, ok: false,
          interactive: true, destructive: false,
          run: { durationMs: Date.now() - startedAt, runId: context.toolCallId || null },
          nav: navResp || null, postState: null,
        };
      }
      const noop = navResp.data && navResp.data.noop === true;
      const fromUrl = navResp.data && navResp.data.from && navResp.data.from.url;
      const expectedUrl = navResp.data && navResp.data.to && navResp.data.to.url;
      const postState = noop
        ? { ready: true, attempts: 0, currentUrl: fromUrl || null, state: null, skipped: 'noop' }
        : await session.awaitBridgeAfterNav({ timeoutMs: 20000, intervalMs: 500, initialDelayMs: 400, fromUrl: fromUrl || null, expectedUrl: expectedUrl || null });
      return {
        platform: 'deepseek', toolName, pageKey, method,
        ok: !!postState.ready, interactive: true, destructive: false,
        run: { durationMs: Date.now() - startedAt, runId: context.toolCallId || null },
        nav: navResp, postState,
      };
    } finally { await session.close(); }
  };
}

// 注：v0.3.3 移除 delete_session 工具与 prefetchSessionBackup helper —
// 删除会话被认定为高危且无可逆补偿（即便 backup 也无法恢复 server-side
// 真实数据）。如需清理测试数据，请走 DeepSeek 官方 UI 手动删除。
// `getSessionSnapshot` bridge 方法保留供未来 export 等读路径复用。

const TOOL_DEFINITIONS = finalizeTools([
  // ===== READ =====
  {
    name: 'deepseek_session_state',
    label: 'DeepSeek Ops: Session State',
    description: '读取当前浏览器中 DeepSeek Chat 的登录态（/api/v0/users/current）',
    parameters: { type: 'object', properties: {}, required: [] },
    risk: 'read', optional: true, interactive: false, destructive: false, sideEffect: null,
    pageKey: 'home', method: 'sessionState',
    execute: makeReadToolExecutor({ toolName: 'deepseek_session_state', pageKey: 'home', method: 'sessionState', buildTargetUrl: () => null }),
  },
  {
    name: 'deepseek_list_sessions',
    label: 'DeepSeek Ops: List Sessions',
    description: '列出历史会话（标题 / 时间 / 模型类型），不含消息正文',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '默认 25，上限 100' },
        beforeSeqId: { type: 'string', description: '分页游标' },
      }, required: [],
    },
    risk: 'read', optional: true, interactive: false, destructive: false, sideEffect: null,
    pageKey: 'home', method: 'listSessions',
    execute: makeReadToolExecutor({ toolName: 'deepseek_list_sessions', pageKey: 'home', method: 'listSessions', buildTargetUrl: () => targets.homeUrl() }),
  },
  {
    name: 'deepseek_get_session',
    label: 'DeepSeek Ops: Get Session',
    description: '读取单个会话的消息历史。默认 redact="off"：messages[].content 替换为 sha256+length',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' }, limit: { type: 'number' },
        redact: { type: 'string', enum: ['off', 'trunc', 'full'], default: 'off' },
        truncLen: { type: 'number' }, contentMaxLen: { type: 'number' },
      }, required: ['sessionId'],
    },
    risk: 'read', optional: true, interactive: false, destructive: false, sideEffect: null,
    pageKey: 'chat', method: 'getSession',
    execute(runtime, params, context = {}) {
      const p = params || {};
      const transform = buildGetSessionTransform({ mode: p.redact || 'off', truncLen: p.truncLen });
      const targetUrl = p.sessionId ? targets.chatSessionUrl({ sessionId: p.sessionId }) : null;
      return runTool(runtime.ensureBot(), {
        toolName: 'deepseek_get_session', pageKey: 'chat', method: 'getSession',
        args: { sessionId: p.sessionId, limit: p.limit, contentMaxLen: p.contentMaxLen },
        targetUrl,
        options: {
          wsEndpoint: runtime.config.serverUrl, recording: runtime.config.recording,
          runId: context.toolCallId, navigateOnReuse: false, reuseAnyDeepseekTab: true,
          createUrl: targetUrl || 'https://chat.deepseek.com/', transformResult: transform,
        },
      });
    },
  },
  {
    name: 'deepseek_chat_page_state',
    label: 'DeepSeek Ops: Chat Page State',
    description: '读取当前 chat 页 UI 状态快照（composer 草稿仅出 length+sha256；另含模式/思考/搜索/附件 chrome）',
    parameters: { type: 'object', properties: {}, required: [] },
    risk: 'read', optional: true, interactive: false, destructive: false, sideEffect: null,
    pageKey: 'chat', method: 'chatPageState',
    execute: makeReadToolExecutor({ toolName: 'deepseek_chat_page_state', pageKey: 'chat', method: 'chatPageState', buildTargetUrl: () => null }),
  },
  {
    name: 'deepseek_list_messages',
    label: 'DeepSeek Ops: List Messages',
    description: '列出指定会话的消息元数据。永不返回 content / thinkingContent 正文',
    parameters: {
      type: 'object',
      properties: { sessionId: { type: 'string' }, limit: { type: 'number' }, contentMaxLen: { type: 'number' } },
      required: ['sessionId'],
    },
    risk: 'read', optional: true, interactive: false, destructive: false, sideEffect: null,
    pageKey: 'chat', method: 'listMessages',
    execute(runtime, params, context = {}) {
      const p = params || {};
      const transform = buildListMessagesTransform();
      const targetUrl = p.sessionId ? targets.chatSessionUrl({ sessionId: p.sessionId }) : null;
      return runTool(runtime.ensureBot(), {
        toolName: 'deepseek_list_messages', pageKey: 'chat', method: 'listMessages',
        args: { sessionId: p.sessionId, limit: p.limit, contentMaxLen: p.contentMaxLen },
        targetUrl,
        options: {
          wsEndpoint: runtime.config.serverUrl, recording: runtime.config.recording,
          runId: context.toolCallId, navigateOnReuse: false, reuseAnyDeepseekTab: true,
          createUrl: targetUrl || 'https://chat.deepseek.com/', transformResult: transform,
        },
      });
    },
  },
  {
    name: 'deepseek_get_message',
    label: 'DeepSeek Ops: Get Message',
    description: '读取单条消息详情。默认 redact="off"',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' }, messageId: { type: 'number' },
        redact: { type: 'string', enum: ['off', 'trunc', 'full'], default: 'off' },
        truncLen: { type: 'number' }, contentMaxLen: { type: 'number' },
      },
      required: ['sessionId', 'messageId'],
    },
    risk: 'read', optional: true, interactive: false, destructive: false, sideEffect: null,
    pageKey: 'chat', method: 'getMessage',
    execute(runtime, params, context = {}) {
      const p = params || {};
      const transform = buildGetMessageTransform({ mode: p.redact || 'off', truncLen: p.truncLen });
      const targetUrl = p.sessionId ? targets.chatSessionUrl({ sessionId: p.sessionId }) : null;
      return runTool(runtime.ensureBot(), {
        toolName: 'deepseek_get_message', pageKey: 'chat', method: 'getMessage',
        args: { sessionId: p.sessionId, messageId: p.messageId, contentMaxLen: p.contentMaxLen },
        targetUrl,
        options: {
          wsEndpoint: runtime.config.serverUrl, recording: runtime.config.recording,
          runId: context.toolCallId, navigateOnReuse: false, reuseAnyDeepseekTab: true,
          createUrl: targetUrl || 'https://chat.deepseek.com/', transformResult: transform,
        },
      });
    },
  },
  {
    name: 'deepseek_get_session_tree',
    label: 'DeepSeek Ops: Get Session Tree',
    description: '读取会话全分支树（含被埋藏的旧分支兄弟）。返回 SessionTree（nodes map + activePathIds + branchPointIds + stats）。默认 redact="off"。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        redact: { type: 'string', enum: ['off', 'trunc', 'full'], default: 'off' },
        truncLen: { type: 'number' },
        contentMaxLen: { type: 'number' },
        limit: { type: 'number', description: '节点上限，0=不限；超限按 messageId 倒序保留最新' },
      },
      required: ['sessionId'],
    },
    risk: 'read', optional: true, interactive: false, destructive: false, sideEffect: null,
    pageKey: 'chat', method: 'getSessionTree',
    execute(runtime, params, context = {}) {
      const p = params || {};
      const transform = buildGetSessionTreeTransform({ mode: p.redact || 'off', truncLen: p.truncLen });
      const targetUrl = p.sessionId ? targets.chatSessionUrl({ sessionId: p.sessionId }) : null;
      return runTool(runtime.ensureBot(), {
        toolName: 'deepseek_get_session_tree', pageKey: 'chat', method: 'getSessionTree',
        args: { sessionId: p.sessionId, contentMaxLen: p.contentMaxLen, limit: p.limit },
        targetUrl,
        options: {
          wsEndpoint: runtime.config.serverUrl, recording: runtime.config.recording,
          runId: context.toolCallId, navigateOnReuse: false, reuseAnyDeepseekTab: true,
          createUrl: targetUrl || 'https://chat.deepseek.com/', transformResult: transform,
        },
      });
    },
  },
  {
    name: 'deepseek_list_branch_points',
    label: 'DeepSeek Ops: List Branch Points',
    description: '仅列出会话中的分支点（同 parent 下 children >= 2 的节点）+ 每分支的 children 元数据。轻量发现工具，永不返回正文。',
    parameters: {
      type: 'object',
      properties: { sessionId: { type: 'string' } },
      required: ['sessionId'],
    },
    risk: 'read', optional: true, interactive: false, destructive: false, sideEffect: null,
    pageKey: 'chat', method: 'listBranchPoints',
    execute(runtime, params, context = {}) {
      const p = params || {};
      const transform = buildListBranchPointsTransform();
      const targetUrl = p.sessionId ? targets.chatSessionUrl({ sessionId: p.sessionId }) : null;
      return runTool(runtime.ensureBot(), {
        toolName: 'deepseek_list_branch_points', pageKey: 'chat', method: 'listBranchPoints',
        args: { sessionId: p.sessionId },
        targetUrl,
        options: {
          wsEndpoint: runtime.config.serverUrl, recording: runtime.config.recording,
          runId: context.toolCallId, navigateOnReuse: false, reuseAnyDeepseekTab: true,
          createUrl: targetUrl || 'https://chat.deepseek.com/', transformResult: transform,
        },
      });
    },
  },
  {
    name: 'deepseek_get_branch_path',
    label: 'DeepSeek Ops: Get Branch Path',
    description: '返回从 root 到指定 leaf messageId 的线性 messages[]，schema 与 deepseek_get_session 兼容。leaf 省略时等价于 active path（current_message_id）。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        leafMessageId: { type: 'number', description: '目标分支末端 messageId；省略则用 session.current_message_id' },
        redact: { type: 'string', enum: ['off', 'trunc', 'full'], default: 'off' },
        truncLen: { type: 'number' },
        contentMaxLen: { type: 'number' },
        limit: { type: 'number' },
      },
      required: ['sessionId'],
    },
    risk: 'read', optional: true, interactive: false, destructive: false, sideEffect: null,
    pageKey: 'chat', method: 'getBranchPath',
    execute(runtime, params, context = {}) {
      const p = params || {};
      const transform = buildGetBranchPathTransform({ mode: p.redact || 'off', truncLen: p.truncLen });
      const targetUrl = p.sessionId ? targets.chatSessionUrl({ sessionId: p.sessionId }) : null;
      return runTool(runtime.ensureBot(), {
        toolName: 'deepseek_get_branch_path', pageKey: 'chat', method: 'getBranchPath',
        args: { sessionId: p.sessionId, leafMessageId: p.leafMessageId, contentMaxLen: p.contentMaxLen, limit: p.limit },
        targetUrl,
        options: {
          wsEndpoint: runtime.config.serverUrl, recording: runtime.config.recording,
          runId: context.toolCallId, navigateOnReuse: false, reuseAnyDeepseekTab: true,
          createUrl: targetUrl || 'https://chat.deepseek.com/', transformResult: transform,
        },
      });
    },
  },
  {
    name: 'deepseek_streaming_status',
    label: 'DeepSeek Ops: Streaming Status',
    description: '一次性观察 chat 页 streaming 状态（不订阅 SSE）',
    parameters: { type: 'object', properties: { sessionId: { type: 'string' } }, required: [] },
    risk: 'read', optional: true, interactive: false, destructive: false, sideEffect: null,
    pageKey: 'chat', method: 'streamingStatus',
    execute: makeReadToolExecutor({ toolName: 'deepseek_streaming_status', pageKey: 'chat', method: 'streamingStatus', buildTargetUrl: (p) => p.sessionId ? targets.chatSessionUrl({ sessionId: p.sessionId }) : null }),
  },
  {
    name: 'deepseek_chat_settings_view',
    label: 'DeepSeek Ops: Chat Settings View',
    description: '只读 /api/v0/client/settings（model 列表 / feature flags）',
    parameters: { type: 'object', properties: { scope: { type: 'string', enum: ['main', 'model'], default: 'main' } }, required: [] },
    risk: 'read', optional: true, interactive: false, destructive: false, sideEffect: null,
    pageKey: 'chat', method: 'chatSettingsView',
    execute: makeReadToolExecutor({ toolName: 'deepseek_chat_settings_view', pageKey: 'chat', method: 'chatSettingsView', buildTargetUrl: () => null }),
  },
  {
    name: 'deepseek_list_files',
    label: 'DeepSeek Ops: List Files',
    description: '列出当前账号上传的文件',
    parameters: { type: 'object', properties: { sessionId: { type: 'string' } }, required: [] },
    risk: 'read', optional: true, interactive: false, destructive: false, sideEffect: null,
    pageKey: 'chat', method: 'listFiles',
    execute: makeReadToolExecutor({ toolName: 'deepseek_list_files', pageKey: 'chat', method: 'listFiles', buildTargetUrl: () => null }),
  },
  {
    name: 'deepseek_list_shares',
    label: 'DeepSeek Ops: List Shares',
    description: '列出当前账号的分享链接',
    parameters: { type: 'object', properties: {}, required: [] },
    risk: 'read', optional: true, interactive: false, destructive: false, sideEffect: null,
    pageKey: 'home', method: 'listShares',
    execute: makeReadToolExecutor({ toolName: 'deepseek_list_shares', pageKey: 'home', method: 'listShares', buildTargetUrl: () => null }),
  },

  // ===== INTERACTIVE =====
  {
    name: 'deepseek_navigate_home',
    label: 'DeepSeek Ops: Navigate To Home',
    description: '把浏览器导航到 / （仅 location.assign）',
    parameters: { type: 'object', properties: {}, required: [] },
    risk: 'interactive', optional: true, interactive: true, destructive: false, sideEffect: null,
    pageKey: 'home', method: 'navigateHome',
    execute: makeNavigateToolExecutor({ toolName: 'deepseek_navigate_home', pageKey: 'home', method: 'navigateHome' }),
  },
  {
    name: 'deepseek_navigate_session',
    label: 'DeepSeek Ops: Navigate To Session',
    description: '把浏览器导航到 /a/chat/s/<id> （仅 location.assign）',
    parameters: { type: 'object', properties: { sessionId: { type: 'string' }, url: { type: 'string' } }, required: [] },
    risk: 'interactive', optional: true, interactive: true, destructive: false, sideEffect: null,
    pageKey: 'chat', method: 'navigateSession',
    execute: makeNavigateToolExecutor({ toolName: 'deepseek_navigate_session', pageKey: 'chat', method: 'navigateSession' }),
  },
  {
    name: 'deepseek_navigate_new_chat',
    label: 'DeepSeek Ops: Navigate To New Chat',
    description: '导航到 / 起新对话',
    parameters: { type: 'object', properties: {}, required: [] },
    risk: 'interactive', optional: true, interactive: true, destructive: false, sideEffect: null,
    pageKey: 'home', method: 'navigateNewChat',
    execute: makeNavigateToolExecutor({ toolName: 'deepseek_navigate_new_chat', pageKey: 'home', method: 'navigateNewChat' }),
  },

  // ===== DESTRUCTIVE: 会话管理 =====
  {
    name: 'deepseek_create_session',
    label: 'DeepSeek Ops: Create Session',
    description: '[DESTRUCTIVE,reversible] 创建新会话；返回 sessionId 用于后续 send_message 等',
    parameters: { type: 'object', properties: { agent: { type: 'string', description: 'default: chat' }, character_id: { type: 'string' } }, required: [] },
    risk: 'destructive', optional: true, interactive: false, destructive: true, sideEffect: 'reversible',
    pageKey: 'home', method: 'createSession',
    execute: makeDestructiveExecutor({ toolName: 'deepseek_create_session', pageKey: 'home', method: 'createSession', sideEffect: 'reversible', buildTargetUrl: () => null }),
  },
  {
    name: 'deepseek_rename_session',
    label: 'DeepSeek Ops: Rename Session',
    description: '[DESTRUCTIVE,reversible] 重命名会话标题（最大 200 字）',
    parameters: { type: 'object', properties: { sessionId: { type: 'string' }, title: { type: 'string' } }, required: ['sessionId', 'title'] },
    risk: 'destructive', optional: true, interactive: false, destructive: true, sideEffect: 'reversible',
    pageKey: 'home', method: 'renameSession',
    execute: makeDestructiveExecutor({ toolName: 'deepseek_rename_session', pageKey: 'home', method: 'renameSession', sideEffect: 'reversible', buildTargetUrl: () => null }),
  },
  {
    name: 'deepseek_pin_session',
    label: 'DeepSeek Ops: Pin Session',
    description: '[DESTRUCTIVE,reversible] 把会话置顶',
    parameters: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] },
    risk: 'destructive', optional: true, interactive: false, destructive: true, sideEffect: 'reversible',
    pageKey: 'home', method: 'pinSession',
    execute: makeDestructiveExecutor({ toolName: 'deepseek_pin_session', pageKey: 'home', method: 'pinSession', sideEffect: 'reversible', buildTargetUrl: () => null }),
  },
  {
    name: 'deepseek_unpin_session',
    label: 'DeepSeek Ops: Unpin Session',
    description: '[DESTRUCTIVE,reversible] 取消会话置顶',
    parameters: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] },
    risk: 'destructive', optional: true, interactive: false, destructive: true, sideEffect: 'reversible',
    pageKey: 'home', method: 'unpinSession',
    execute: makeDestructiveExecutor({ toolName: 'deepseek_unpin_session', pageKey: 'home', method: 'unpinSession', sideEffect: 'reversible', buildTargetUrl: () => null }),
  },
  // 注：v0.3.3 移除 deepseek_delete_session（删除会话不可逆且服务端真实数据
  // 无法通过本地 backup 恢复）；如需清理，请走 DeepSeek 官方 UI 操作。

  // ===== DESTRUCTIVE: 消息反馈 / 停流 =====
  {
    name: 'deepseek_feedback_message',
    label: 'DeepSeek Ops: Feedback Message',
    description: '[DESTRUCTIVE,reversible] 给单条消息打反馈：feedback ∈ {-1=踩, 0=取消, 1=赞}',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' }, messageId: { type: 'number' },
        feedback: { type: 'number', enum: [-1, 0, 1] },
        reasons: { type: 'array', items: { type: 'string' } },
        comment: { type: 'string' },
      },
      required: ['sessionId', 'messageId', 'feedback'],
    },
    risk: 'destructive', optional: true, interactive: false, destructive: true, sideEffect: 'reversible',
    pageKey: 'chat', method: 'feedbackMessage',
    execute: makeDestructiveExecutor({
      toolName: 'deepseek_feedback_message', pageKey: 'chat', method: 'feedbackMessage',
      sideEffect: 'reversible', buildTargetUrl: (p) => p.sessionId ? targets.chatSessionUrl({ sessionId: p.sessionId }) : null,
    }),
  },
  {
    name: 'deepseek_stop_stream',
    label: 'DeepSeek Ops: Stop Stream',
    description: '[DESTRUCTIVE,reversible] 停止当前会话的流式生成',
    parameters: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] },
    risk: 'destructive', optional: true, interactive: false, destructive: true, sideEffect: 'reversible',
    pageKey: 'chat', method: 'stopStream',
    execute: makeDestructiveExecutor({
      toolName: 'deepseek_stop_stream', pageKey: 'chat', method: 'stopStream',
      sideEffect: 'reversible', buildTargetUrl: (p) => p.sessionId ? targets.chatSessionUrl({ sessionId: p.sessionId }) : null,
    }),
  },

  // ===== DESTRUCTIVE: 发消息核心 =====
  {
    name: 'deepseek_send_message',
    label: 'DeepSeek Ops: Send Message',
    description: '[DESTRUCTIVE,COST] 发消息触发流式生成（消耗 token）。bridge 自动取 PoW；prompt 完整记入 audit.jsonl',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        prompt: { type: 'string' },
        parentMessageId: { type: 'number', description: '默认 null（首条消息）' },
        thinking: { type: 'boolean', default: false },
        search: { type: 'boolean', default: false },
        refFileIds: { type: 'array', items: { type: 'string' } },
        includeContent: { type: 'boolean', default: false, description: '是否在响应里返回 assistant 全文（默认只返回 sha256+length）' },
        timeoutMs: { type: 'number', description: 'SSE 流读硬超时；默认 120000' },
      },
      required: ['sessionId', 'prompt'],
    },
    risk: 'destructive', optional: true, interactive: false, destructive: true, sideEffect: 'cost',
    pageKey: 'chat', method: 'sendMessage',
    execute: makeDestructiveExecutor({
      toolName: 'deepseek_send_message', pageKey: 'chat', method: 'sendMessage',
      sideEffect: 'cost', buildTargetUrl: (p) => p.sessionId ? targets.chatSessionUrl({ sessionId: p.sessionId }) : null,
    }),
  },
  {
    name: 'deepseek_edit_message',
    label: 'DeepSeek Ops: Edit Message',
    description: '[DESTRUCTIVE,COST] 编辑指定 user 消息并触发重生',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' }, messageId: { type: 'number' }, prompt: { type: 'string' },
        thinking: { type: 'boolean', default: false }, search: { type: 'boolean', default: false },
        refFileIds: { type: 'array', items: { type: 'string' } },
        includeContent: { type: 'boolean', default: false },
      },
      required: ['sessionId', 'messageId', 'prompt'],
    },
    risk: 'destructive', optional: true, interactive: false, destructive: true, sideEffect: 'cost',
    pageKey: 'chat', method: 'editMessage',
    execute: makeDestructiveExecutor({
      toolName: 'deepseek_edit_message', pageKey: 'chat', method: 'editMessage',
      sideEffect: 'cost', buildTargetUrl: (p) => p.sessionId ? targets.chatSessionUrl({ sessionId: p.sessionId }) : null,
    }),
  },
  {
    name: 'deepseek_regenerate_message',
    label: 'DeepSeek Ops: Regenerate Message',
    description: '[DESTRUCTIVE,COST] 基于 parent_message_id 重生 assistant 回复',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' }, parentMessageId: { type: 'number' },
        thinking: { type: 'boolean', default: false }, search: { type: 'boolean', default: false },
        includeContent: { type: 'boolean', default: false },
      },
      required: ['sessionId', 'parentMessageId'],
    },
    risk: 'destructive', optional: true, interactive: false, destructive: true, sideEffect: 'cost',
    pageKey: 'chat', method: 'regenerateMessage',
    execute: makeDestructiveExecutor({
      toolName: 'deepseek_regenerate_message', pageKey: 'chat', method: 'regenerateMessage',
      sideEffect: 'cost', buildTargetUrl: (p) => p.sessionId ? targets.chatSessionUrl({ sessionId: p.sessionId }) : null,
    }),
  },

  // ===== DESTRUCTIVE: DOM 模式（绕开 PoW） =====
  // sendMessage 走 /api/v0/chat/completion 必须 PoW（DeepSeekHashV1，WASM
  // worker），bridge 不复刻；改让浏览器自己解：在 composer 里输入并点击发送。
  // 同时副作用：API 直创的会话标题未生成时不出现在 UI 侧栏；DOM 模式
  // 永远会让会话出现（因为有首条消息）。
  {
    name: 'deepseek_dom_send_message',
    label: 'DeepSeek Ops: Send Message via UI (DOM)',
    description: '[DESTRUCTIVE,COST] DOM 模式：可选先切快速/专家/识图与深度思考/智能搜索，再在 composer 输入并点击发送。未指定控件则保持页面现状。在 / 上自动创建可见会话；在已有会话页则追加发言。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '要发送的消息文本' },
        mode: { type: 'string', enum: ['default', 'expert', 'vision'], description: '新对话模式：快速/专家/识图；省略则不改页面当前模式' },
        thinking: { type: 'boolean', description: '是否打开深度思考；省略则不改页面当前开关' },
        search: { type: 'boolean', description: '是否打开智能搜索；省略则不改。专家模式显式 true 会失败' },
        waitForFinish: { type: 'boolean', default: true, description: '是否轮询 history_messages 直到末条 ASSISTANT 不再 STREAMING/WIP' },
        sessionIdTimeoutMs: { type: 'number', description: '从 / 创建后等待 sessionId 出现的超时；默认 20000' },
        finishTimeoutMs: { type: 'number', description: '等流式结束的超时；默认 90000' },
      },
      required: ['prompt'],
    },
    risk: 'destructive', optional: true, interactive: false, destructive: true, sideEffect: 'cost',
    pageKey: 'chat', method: 'domSendMessage',
    execute: makeDestructiveExecutor({
      toolName: 'deepseek_dom_send_message', pageKey: 'chat', method: 'domSendMessage',
      sideEffect: 'cost', buildTargetUrl: () => null,
    }),
  },
  {
    name: 'deepseek_dom_edit_message',
    label: 'DeepSeek Ops: Edit Message via UI (DOM)',
    description: '[DESTRUCTIVE,COST] DOM 模式编辑 USER 消息。target=lastUser 直接走最后一条；target=byMessageId + messageId 通过滚动虚拟列表 + 内容指纹定位历史消息（必要时点击 [edit] 按钮转气泡为 textarea）。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '替换后的 user 消息内容' },
        target: { type: 'string', enum: ['lastUser', 'byMessageId'], default: 'lastUser' },
        messageId: { type: 'number', description: 'target=byMessageId 时必填' },
        waitForFinish: { type: 'boolean', default: true },
        finishTimeoutMs: { type: 'number' },
      },
      required: ['prompt'],
    },
    risk: 'destructive', optional: true, interactive: false, destructive: true, sideEffect: 'cost',
    pageKey: 'chat', method: 'domEditMessage',
    execute: makeDestructiveExecutor({
      toolName: 'deepseek_dom_edit_message', pageKey: 'chat', method: 'domEditMessage',
      sideEffect: 'cost', buildTargetUrl: () => null,
    }),
  },
  {
    name: 'deepseek_dom_regenerate_message',
    label: 'DeepSeek Ops: Regenerate Message via UI (DOM)',
    description: '[DESTRUCTIVE,COST] DOM 模式重生 ASSISTANT 消息。target=lastAssistant 直接最后一条；target=byMessageId + messageId 通过滚动虚拟列表 + 内容指纹定位历史消息后点 [regenerate]。',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['lastAssistant', 'byMessageId'], default: 'lastAssistant' },
        messageId: { type: 'number', description: 'target=byMessageId 时必填' },
        waitForFinish: { type: 'boolean', default: true },
        finishTimeoutMs: { type: 'number' },
      },
    },
    risk: 'destructive', optional: true, interactive: false, destructive: true, sideEffect: 'cost',
    pageKey: 'chat', method: 'domRegenerateMessage',
    execute: makeDestructiveExecutor({
      toolName: 'deepseek_dom_regenerate_message', pageKey: 'chat', method: 'domRegenerateMessage',
      sideEffect: 'cost', buildTargetUrl: () => null,
    }),
  },
  {
    name: 'deepseek_dom_stop_stream',
    label: 'DeepSeek Ops: Stop Stream via UI (DOM)',
    description: '[DESTRUCTIVE,reversible] DOM 模式：在流式中点击停止按钮。需在 chat 页且当前正在流式。',
    parameters: { type: 'object', properties: {} },
    risk: 'destructive', optional: true, interactive: false, destructive: true, sideEffect: 'reversible',
    pageKey: 'chat', method: 'domStopStream',
    execute: makeDestructiveExecutor({
      toolName: 'deepseek_dom_stop_stream', pageKey: 'chat', method: 'domStopStream',
      sideEffect: 'reversible', buildTargetUrl: () => null,
    }),
  },

  // ===== DESTRUCTIVE: 文件 / 分享 / 设置 =====
  {
    name: 'deepseek_upload_file',
    label: 'DeepSeek Ops: Upload File',
    description: '[DESTRUCTIVE,reversible] 上传文件（base64 编码内容）',
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string' }, mime: { type: 'string' },
        contentBase64: { type: 'string', description: 'base64 编码的文件内容' },
        sessionId: { type: 'string' },
      },
      required: ['filename', 'contentBase64'],
    },
    risk: 'destructive', optional: true, interactive: false, destructive: true, sideEffect: 'reversible',
    pageKey: 'chat', method: 'uploadFile',
    execute: makeDestructiveExecutor({ toolName: 'deepseek_upload_file', pageKey: 'chat', method: 'uploadFile', sideEffect: 'reversible', buildTargetUrl: () => null }),
  },
  {
    name: 'deepseek_share_session',
    label: 'DeepSeek Ops: Share Session',
    description: '[DESTRUCTIVE,reversible] 创建会话分享链接',
    parameters: { type: 'object', properties: { sessionId: { type: 'string' }, title: { type: 'string' }, message_ids: { type: 'array', items: { type: 'number' } } }, required: ['sessionId'] },
    risk: 'destructive', optional: true, interactive: false, destructive: true, sideEffect: 'reversible',
    pageKey: 'home', method: 'shareSession',
    execute: makeDestructiveExecutor({ toolName: 'deepseek_share_session', pageKey: 'home', method: 'shareSession', sideEffect: 'reversible', buildTargetUrl: () => null }),
  },
  {
    name: 'deepseek_unshare_session',
    label: 'DeepSeek Ops: Unshare Session',
    description: '[DESTRUCTIVE,IRREVERSIBLE] 删除分享链接',
    parameters: { type: 'object', properties: { shareId: { type: 'string' } }, required: ['shareId'] },
    risk: 'destructive', optional: true, interactive: false, destructive: true, sideEffect: 'irreversible',
    pageKey: 'home', method: 'unshareSession',
    execute: makeDestructiveExecutor({
      toolName: 'deepseek_unshare_session', pageKey: 'home', method: 'unshareSession',
      sideEffect: 'irreversible', buildTargetUrl: () => null, prefetchBackup: prefetchShareBackup,
    }),
  },
  {
    name: 'deepseek_update_user_settings',
    label: 'DeepSeek Ops: Update User Settings',
    description: '[DESTRUCTIVE,reversible] 更新账号设置（settings 字段透传给 /api/v0/users/update_settings）',
    parameters: { type: 'object', properties: { settings: { type: 'object' } }, required: ['settings'] },
    risk: 'administrative', optional: true, interactive: false, destructive: true, sideEffect: 'reversible',
    pageKey: 'home', method: 'updateUserSettings',
    async execute(runtime, params, context = {}) {
      assertAllowedUserSettings(params?.settings, runtime.config);
      return makeDestructiveExecutor({
        toolName: 'deepseek_update_user_settings', pageKey: 'home', method: 'updateUserSettings',
        sideEffect: 'reversible', buildTargetUrl: () => null,
      })(runtime, params, context);
    },
  },
]);

module.exports = createDefinitionEnvelope({
  pkg,
  displayName: 'JS DeepSeek Ops Skill',
  capabilities: {
    browser: ['tabs.read', 'page.read', 'navigation', 'script.execute'],
    network: { direct: false, hosts: [] },
    filesystem: ['skillData'],
    process: [],
    secrets: [],
    background: false,
  },
  requirements: {
    server: true,
    browserExtension: true,
    login: true,
    platforms: ['chat.deepseek.com'],
  },
  runtime: {
    requiresServer: true,
    requiresBrowserExtension: true,
    platforms: ['chat.deepseek.com'],
    pageProfiles: Object.keys(PAGE_PROFILES),
  },
  tools: TOOL_DEFINITIONS,
  cli: { entry: './cli/index.js', commands: CLI_COMMANDS },
  extra: {
    publisher: 'imjszhang',
    createRuntime,
    prefetchShareBackup,
  },
});
