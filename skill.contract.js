'use strict';

const pkg = require('./package.json');
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
} = require('./lib/redact');
const { ensureSkillRecordsReadme } = require('./lib/skillRecordsReadme');

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
  { name: 'delete-session', description: '[DESTRUCTIVE,IRREVERSIBLE] 删除会话（自动备份）' },
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
  ensureSkillRecordsReadme();
  const resolvedConfig = resolveRuntimeConfig(config);
  const runtimeConfig = {
    serverUrl: resolvedConfig.serverUrl,
    recording: resolvedConfig.recording,
    pages: Object.keys(PAGE_PROFILES),
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
        timeoutMs: method === 'sendMessage' || method === 'editMessage' || method === 'regenerateMessage' ? 180000 : 60000,
      },
    });
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

/**
 * prefetchSessionBackup - delete_session 前先调 home/chat bridge 的 getSessionSnapshot
 * 拿当前会话快照（标题 / 消息元数据 / 每条 sha256+length），用于 lib/audit.writeBackup。
 */
async function prefetchSessionBackup(session, args) {
  try {
    const snap = await session.callApi('getSessionSnapshot', [{ sessionId: args.sessionId }], { timeoutMs: 30000 });
    if (snap && snap.ok && snap.data) {
      return { resource: 'session', id: args.sessionId, snapshot: snap.data };
    }
    return { resource: 'session', id: args.sessionId, snapshot: { unavailable: true, error: snap && snap.error } };
  } catch (e) {
    return { resource: 'session', id: args.sessionId, snapshot: { unavailable: true, message: String(e && e.message) } };
  }
}

const TOOL_DEFINITIONS = [
  // ===== READ =====
  {
    name: 'deepseek_session_state',
    label: 'DeepSeek Ops: Session State',
    description: '读取当前浏览器中 DeepSeek Chat 的登录态（/api/v0/users/current）',
    parameters: { type: 'object', properties: {}, required: [] },
    optional: true, interactive: false, destructive: false, sideEffect: null,
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
    optional: true, interactive: false, destructive: false, sideEffect: null,
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
    optional: true, interactive: false, destructive: false, sideEffect: null,
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
    description: '读取当前 chat 页 UI 状态快照（composer 草稿仅出 length+sha256）',
    parameters: { type: 'object', properties: {}, required: [] },
    optional: true, interactive: false, destructive: false, sideEffect: null,
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
    optional: true, interactive: false, destructive: false, sideEffect: null,
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
    optional: true, interactive: false, destructive: false, sideEffect: null,
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
    name: 'deepseek_streaming_status',
    label: 'DeepSeek Ops: Streaming Status',
    description: '一次性观察 chat 页 streaming 状态（不订阅 SSE）',
    parameters: { type: 'object', properties: { sessionId: { type: 'string' } }, required: [] },
    optional: true, interactive: false, destructive: false, sideEffect: null,
    pageKey: 'chat', method: 'streamingStatus',
    execute: makeReadToolExecutor({ toolName: 'deepseek_streaming_status', pageKey: 'chat', method: 'streamingStatus', buildTargetUrl: (p) => p.sessionId ? targets.chatSessionUrl({ sessionId: p.sessionId }) : null }),
  },
  {
    name: 'deepseek_chat_settings_view',
    label: 'DeepSeek Ops: Chat Settings View',
    description: '只读 /api/v0/client/settings（model 列表 / feature flags）',
    parameters: { type: 'object', properties: { scope: { type: 'string', enum: ['main', 'model'], default: 'main' } }, required: [] },
    optional: true, interactive: false, destructive: false, sideEffect: null,
    pageKey: 'chat', method: 'chatSettingsView',
    execute: makeReadToolExecutor({ toolName: 'deepseek_chat_settings_view', pageKey: 'chat', method: 'chatSettingsView', buildTargetUrl: () => null }),
  },
  {
    name: 'deepseek_list_files',
    label: 'DeepSeek Ops: List Files',
    description: '列出当前账号上传的文件',
    parameters: { type: 'object', properties: { sessionId: { type: 'string' } }, required: [] },
    optional: true, interactive: false, destructive: false, sideEffect: null,
    pageKey: 'chat', method: 'listFiles',
    execute: makeReadToolExecutor({ toolName: 'deepseek_list_files', pageKey: 'chat', method: 'listFiles', buildTargetUrl: () => null }),
  },
  {
    name: 'deepseek_list_shares',
    label: 'DeepSeek Ops: List Shares',
    description: '列出当前账号的分享链接',
    parameters: { type: 'object', properties: {}, required: [] },
    optional: true, interactive: false, destructive: false, sideEffect: null,
    pageKey: 'home', method: 'listShares',
    execute: makeReadToolExecutor({ toolName: 'deepseek_list_shares', pageKey: 'home', method: 'listShares', buildTargetUrl: () => null }),
  },

  // ===== INTERACTIVE =====
  {
    name: 'deepseek_navigate_home',
    label: 'DeepSeek Ops: Navigate To Home',
    description: '把浏览器导航到 / （仅 location.assign）',
    parameters: { type: 'object', properties: {}, required: [] },
    optional: true, interactive: true, destructive: false, sideEffect: null,
    pageKey: 'home', method: 'navigateHome',
    execute: makeNavigateToolExecutor({ toolName: 'deepseek_navigate_home', pageKey: 'home', method: 'navigateHome' }),
  },
  {
    name: 'deepseek_navigate_session',
    label: 'DeepSeek Ops: Navigate To Session',
    description: '把浏览器导航到 /a/chat/s/<id> （仅 location.assign）',
    parameters: { type: 'object', properties: { sessionId: { type: 'string' }, url: { type: 'string' } }, required: [] },
    optional: true, interactive: true, destructive: false, sideEffect: null,
    pageKey: 'chat', method: 'navigateSession',
    execute: makeNavigateToolExecutor({ toolName: 'deepseek_navigate_session', pageKey: 'chat', method: 'navigateSession' }),
  },
  {
    name: 'deepseek_navigate_new_chat',
    label: 'DeepSeek Ops: Navigate To New Chat',
    description: '导航到 / 起新对话',
    parameters: { type: 'object', properties: {}, required: [] },
    optional: true, interactive: true, destructive: false, sideEffect: null,
    pageKey: 'home', method: 'navigateNewChat',
    execute: makeNavigateToolExecutor({ toolName: 'deepseek_navigate_new_chat', pageKey: 'home', method: 'navigateNewChat' }),
  },

  // ===== DESTRUCTIVE: 会话管理 =====
  {
    name: 'deepseek_create_session',
    label: 'DeepSeek Ops: Create Session',
    description: '[DESTRUCTIVE,reversible] 创建新会话；返回 sessionId 用于后续 send_message 等',
    parameters: { type: 'object', properties: { agent: { type: 'string', description: 'default: chat' }, character_id: { type: 'string' } }, required: [] },
    optional: true, interactive: false, destructive: true, sideEffect: 'reversible',
    pageKey: 'home', method: 'createSession',
    execute: makeDestructiveExecutor({ toolName: 'deepseek_create_session', pageKey: 'home', method: 'createSession', sideEffect: 'reversible', buildTargetUrl: () => null }),
  },
  {
    name: 'deepseek_rename_session',
    label: 'DeepSeek Ops: Rename Session',
    description: '[DESTRUCTIVE,reversible] 重命名会话标题（最大 200 字）',
    parameters: { type: 'object', properties: { sessionId: { type: 'string' }, title: { type: 'string' } }, required: ['sessionId', 'title'] },
    optional: true, interactive: false, destructive: true, sideEffect: 'reversible',
    pageKey: 'home', method: 'renameSession',
    execute: makeDestructiveExecutor({ toolName: 'deepseek_rename_session', pageKey: 'home', method: 'renameSession', sideEffect: 'reversible', buildTargetUrl: () => null }),
  },
  {
    name: 'deepseek_pin_session',
    label: 'DeepSeek Ops: Pin Session',
    description: '[DESTRUCTIVE,reversible] 把会话置顶',
    parameters: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] },
    optional: true, interactive: false, destructive: true, sideEffect: 'reversible',
    pageKey: 'home', method: 'pinSession',
    execute: makeDestructiveExecutor({ toolName: 'deepseek_pin_session', pageKey: 'home', method: 'pinSession', sideEffect: 'reversible', buildTargetUrl: () => null }),
  },
  {
    name: 'deepseek_unpin_session',
    label: 'DeepSeek Ops: Unpin Session',
    description: '[DESTRUCTIVE,reversible] 取消会话置顶',
    parameters: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] },
    optional: true, interactive: false, destructive: true, sideEffect: 'reversible',
    pageKey: 'home', method: 'unpinSession',
    execute: makeDestructiveExecutor({ toolName: 'deepseek_unpin_session', pageKey: 'home', method: 'unpinSession', sideEffect: 'reversible', buildTargetUrl: () => null }),
  },
  {
    name: 'deepseek_delete_session',
    label: 'DeepSeek Ops: Delete Session',
    description: '[DESTRUCTIVE,IRREVERSIBLE] 删除会话；调用前自动写 backup 到 ~/.js-eyes/skill-records/<skill>/backups/',
    parameters: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] },
    optional: true, interactive: false, destructive: true, sideEffect: 'irreversible',
    pageKey: 'home', method: 'deleteSession',
    execute: makeDestructiveExecutor({ toolName: 'deepseek_delete_session', pageKey: 'home', method: 'deleteSession', sideEffect: 'irreversible', buildTargetUrl: () => null, prefetchBackup: prefetchSessionBackup }),
  },

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
    optional: true, interactive: false, destructive: true, sideEffect: 'reversible',
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
    optional: true, interactive: false, destructive: true, sideEffect: 'reversible',
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
    optional: true, interactive: false, destructive: true, sideEffect: 'cost',
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
    optional: true, interactive: false, destructive: true, sideEffect: 'cost',
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
    optional: true, interactive: false, destructive: true, sideEffect: 'cost',
    pageKey: 'chat', method: 'regenerateMessage',
    execute: makeDestructiveExecutor({
      toolName: 'deepseek_regenerate_message', pageKey: 'chat', method: 'regenerateMessage',
      sideEffect: 'cost', buildTargetUrl: (p) => p.sessionId ? targets.chatSessionUrl({ sessionId: p.sessionId }) : null,
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
    optional: true, interactive: false, destructive: true, sideEffect: 'reversible',
    pageKey: 'chat', method: 'uploadFile',
    execute: makeDestructiveExecutor({ toolName: 'deepseek_upload_file', pageKey: 'chat', method: 'uploadFile', sideEffect: 'reversible', buildTargetUrl: () => null }),
  },
  {
    name: 'deepseek_share_session',
    label: 'DeepSeek Ops: Share Session',
    description: '[DESTRUCTIVE,reversible] 创建会话分享链接',
    parameters: { type: 'object', properties: { sessionId: { type: 'string' }, title: { type: 'string' }, message_ids: { type: 'array', items: { type: 'number' } } }, required: ['sessionId'] },
    optional: true, interactive: false, destructive: true, sideEffect: 'reversible',
    pageKey: 'home', method: 'shareSession',
    execute: makeDestructiveExecutor({ toolName: 'deepseek_share_session', pageKey: 'home', method: 'shareSession', sideEffect: 'reversible', buildTargetUrl: () => null }),
  },
  {
    name: 'deepseek_unshare_session',
    label: 'DeepSeek Ops: Unshare Session',
    description: '[DESTRUCTIVE,IRREVERSIBLE] 删除分享链接',
    parameters: { type: 'object', properties: { shareId: { type: 'string' } }, required: ['shareId'] },
    optional: true, interactive: false, destructive: true, sideEffect: 'irreversible',
    pageKey: 'home', method: 'unshareSession',
    execute: makeDestructiveExecutor({ toolName: 'deepseek_unshare_session', pageKey: 'home', method: 'unshareSession', sideEffect: 'irreversible', buildTargetUrl: () => null }),
  },
  {
    name: 'deepseek_update_user_settings',
    label: 'DeepSeek Ops: Update User Settings',
    description: '[DESTRUCTIVE,reversible] 更新账号设置（settings 字段透传给 /api/v0/users/update_settings）',
    parameters: { type: 'object', properties: { settings: { type: 'object' } }, required: ['settings'] },
    optional: true, interactive: false, destructive: true, sideEffect: 'reversible',
    pageKey: 'home', method: 'updateUserSettings',
    execute: makeDestructiveExecutor({ toolName: 'deepseek_update_user_settings', pageKey: 'home', method: 'updateUserSettings', sideEffect: 'reversible', buildTargetUrl: () => null }),
  },
];

function projectTool(tool) {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    optional: tool.optional === true,
    interactive: tool.interactive === true,
    destructive: tool.destructive === true,
    sideEffect: tool.sideEffect || null,
  };
}

function createOpenClawAdapter(config = {}, logger) {
  const runtime = createRuntime(config, logger);
  return {
    runtime,
    tools: TOOL_DEFINITIONS.map((tool) => Object.assign(projectTool(tool), {
      async execute(toolCallId, params) {
        const result = await tool.execute(runtime, params, { toolCallId });
        return runtime.jsonResult(result);
      },
    })),
  };
}

module.exports = {
  id: pkg.name,
  name: 'JS DeepSeek Ops Skill',
  version: pkg.version,
  description: pkg.description,
  runtime: {
    requiresServer: true,
    requiresBrowserExtension: true,
    platforms: ['chat.deepseek.com'],
    pageProfiles: Object.keys(PAGE_PROFILES),
  },
  cli: { entry: './cli/index.js', commands: CLI_COMMANDS },
  openclaw: { tools: TOOL_DEFINITIONS.map(projectTool) },
  createRuntime,
  createOpenClawAdapter,
};
