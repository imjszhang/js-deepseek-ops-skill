'use strict';

const pkg = require('./package.json');
const { BrowserAutomation } = require('./lib/js-eyes-client');
const { runTool } = require('./lib/runTool');
const { Session } = require('./lib/session');
const { resolveRuntimeConfig } = require('./lib/runtimeConfig');
const { PAGE_PROFILES } = require('./lib/config');
const targets = require('./lib/toolTargets');
const { buildGetSessionTransform } = require('./lib/redact');
const { ensureSkillRecordsReadme } = require('./lib/skillRecordsReadme');

const CLI_COMMANDS = [
  { name: 'doctor', description: '连通性 + 登录态 + bridge 注入 + probe + state 汇总' },
  { name: 'probe', description: '采集页面指纹（按 page profile）' },
  { name: 'state', description: '读取当前 page profile 状态' },
  { name: 'session-state', description: '读取登录态' },
  { name: 'list-sessions', description: '列出历史会话（标题 / 时间 / 模型类型，不含正文）' },
  { name: 'get-session', description: '读取单个会话消息历史（默认 redact=off，正文以 sha256 摘要呈现）' },
  { name: 'navigate-home', description: '导航到 / （INTERACTIVE）' },
  { name: 'navigate-session', description: '导航到 /a/chat/s/<id> （INTERACTIVE）' },
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
      if (!bot) {
        bot = new BrowserAutomation(runtimeConfig.serverUrl, { logger: resolvedLogger });
      }
      return bot;
    },
    textResult(text) { return { content: [{ type: 'text', text }] }; },
    jsonResult(value) { return this.textResult(JSON.stringify(value, null, 2)); },
    dispose() {
      if (bot && typeof bot.disconnect === 'function') {
        try { bot.disconnect(); } catch {}
      }
      bot = null;
    },
  };
}

/**
 * 通用 READ 工具 execute：把 params 传给 lib/runTool.js。
 * 默认 navigateOnReuse=false / reuseAnyDeepseekTab=true：
 *   任意 chat.deepseek.com tab 都能跑（不会切走用户当前 tab）。
 */
function makeReadToolExecutor({ pageKey, method, toolName, buildTargetUrl, transformResult }) {
  return async function execute(runtime, params, context = {}) {
    const targetUrl = typeof buildTargetUrl === 'function' ? buildTargetUrl(params || {}) : null;
    return runTool(runtime.ensureBot(), {
      toolName,
      pageKey,
      method,
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
 * INTERACTIVE 工具 execute：先 ensureBridge，调 bridge.navigateXxx，
 * 然后 awaitBridgeAfterNav 自校验 state.ready。
 *
 * 安全约束：
 *   - 仅使用 location.assign，不模拟点击
 *   - 不带任何写参数（不会触发 send_message / set_model / toggle 等业务动作）
 *   - 跨域 URL 在 bridge 端被 navigateLocation 拒绝（仅 *.deepseek.com）
 */
function makeNavigateToolExecutor({ pageKey, method, toolName }) {
  return async function execute(runtime, params, context = {}) {
    const startedAt = Date.now();
    const session = new Session({
      opts: {
        page: pageKey,
        bot: runtime.ensureBot(),
        verbose: false,
        wsEndpoint: runtime.config.serverUrl,
        createIfMissing: true,
        navigateOnReuse: false,
        reuseAnyDeepseekTab: true,
        createUrl: 'https://chat.deepseek.com/',
      },
    });
    try {
      await session.connect();
      await session.resolveTarget();
      await session.ensureBridge();
      const navResp = await session.callApi(method, [params || {}]);
      if (!navResp || !navResp.ok) {
        return {
          platform: 'deepseek',
          toolName,
          pageKey,
          method,
          ok: false,
          interactive: true,
          destructive: false,
          run: { durationMs: Date.now() - startedAt, runId: context.toolCallId || null },
          nav: navResp || null,
          postState: null,
        };
      }
      const noop = navResp.data && navResp.data.noop === true;
      const fromUrl = navResp.data && navResp.data.from && navResp.data.from.url;
      const expectedUrl = navResp.data && navResp.data.to && navResp.data.to.url;
      const postState = noop
        ? { ready: true, attempts: 0, currentUrl: fromUrl || null, state: null, skipped: 'noop' }
        : await session.awaitBridgeAfterNav({
            timeoutMs: 20000,
            intervalMs: 500,
            initialDelayMs: 400,
            fromUrl: fromUrl || null,
            expectedUrl: expectedUrl || null,
          });
      return {
        platform: 'deepseek',
        toolName,
        pageKey,
        method,
        ok: !!postState.ready,
        interactive: true,
        destructive: false,
        run: { durationMs: Date.now() - startedAt, runId: context.toolCallId || null },
        nav: navResp,
        postState,
      };
    } finally {
      await session.close();
    }
  };
}

const TOOL_DEFINITIONS = [
  {
    name: 'deepseek_session_state',
    label: 'DeepSeek Ops: Session State',
    description: '读取当前浏览器中 DeepSeek Chat 的登录态（/api/v0/users/current，未登录回 {loggedIn:false}）',
    parameters: { type: 'object', properties: {}, required: [] },
    optional: true,
    interactive: false,
    destructive: false,
    pageKey: 'home',
    method: 'sessionState',
    execute: makeReadToolExecutor({
      toolName: 'deepseek_session_state',
      pageKey: 'home',
      method: 'sessionState',
      buildTargetUrl: () => null,
    }),
  },
  {
    name: 'deepseek_list_sessions',
    label: 'DeepSeek Ops: List Sessions',
    description: '列出历史会话（标题 / 创建时间 / 更新时间 / 模型类型），不含消息正文。分页用 beforeSeqId 游标',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '默认 25，上限 100' },
        beforeSeqId: { type: 'string', description: '分页游标（上一页最后一条的 seqId）' },
      },
      required: [],
    },
    optional: true,
    interactive: false,
    destructive: false,
    pageKey: 'home',
    method: 'listSessions',
    execute: makeReadToolExecutor({
      toolName: 'deepseek_list_sessions',
      pageKey: 'home',
      method: 'listSessions',
      buildTargetUrl: () => targets.homeUrl(),
    }),
  },
  {
    name: 'deepseek_get_session',
    label: 'DeepSeek Ops: Get Session',
    description: '读取单个会话的消息历史。默认 redact="off"：messages[].content 替换为 sha256+length 摘要，不返回正文；redact="trunc" 截前 200 字；redact="full" 仅在 --debug-recording 模式下生效',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 UUID（来自 deepseek_list_sessions 的 items[].id）' },
        limit: { type: 'number', description: '保留最近 N 条消息（0 或不传 = 不截断）' },
        redact: { type: 'string', enum: ['off', 'trunc', 'full'], default: 'off', description: 'off=隐藏正文(默认), trunc=截短, full=原文(仅 debug 模式)' },
        truncLen: { type: 'number', description: 'redact=trunc 时单条正文保留长度，默认 200' },
        contentMaxLen: { type: 'number', description: 'bridge 端正文硬上限，避免 SSE 残留导致超大跨进程传递；默认 60000' },
      },
      required: ['sessionId'],
    },
    optional: true,
    interactive: false,
    destructive: false,
    pageKey: 'chat',
    method: 'getSession',
    execute(runtime, params, context = {}) {
      const p = params || {};
      const sessionId = p.sessionId;
      const transform = buildGetSessionTransform({ mode: p.redact || 'off', truncLen: p.truncLen });
      const targetUrl = sessionId ? targets.chatSessionUrl({ sessionId }) : null;
      return runTool(runtime.ensureBot(), {
        toolName: 'deepseek_get_session',
        pageKey: 'chat',
        method: 'getSession',
        args: {
          sessionId,
          limit: p.limit,
          contentMaxLen: p.contentMaxLen,
        },
        targetUrl,
        options: {
          wsEndpoint: runtime.config.serverUrl,
          recording: runtime.config.recording,
          runId: context.toolCallId,
          navigateOnReuse: false,
          reuseAnyDeepseekTab: true,
          createUrl: targetUrl || 'https://chat.deepseek.com/',
          transformResult: transform,
        },
      });
    },
  },

  // ---- INTERACTIVE 档（仅 location.assign，不模拟点击，不写任何业务数据）----
  {
    name: 'deepseek_navigate_home',
    label: 'DeepSeek Ops: Navigate To Home',
    description: '把浏览器导航到 chat.deepseek.com/ （仅 location.assign）',
    parameters: { type: 'object', properties: {}, required: [] },
    optional: true,
    interactive: true,
    destructive: false,
    pageKey: 'home',
    method: 'navigateHome',
    execute: makeNavigateToolExecutor({
      toolName: 'deepseek_navigate_home',
      pageKey: 'home',
      method: 'navigateHome',
    }),
  },
  {
    name: 'deepseek_navigate_session',
    label: 'DeepSeek Ops: Navigate To Session',
    description: '把浏览器导航到指定会话页 /a/chat/s/<id> （仅 location.assign，跨域 URL 被 bridge 拒绝）',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 UUID（来自 deepseek_list_sessions）' },
        url: { type: 'string', description: '完整 URL（与 sessionId 二选一；仅 *.deepseek.com 接受）' },
      },
      required: [],
    },
    optional: true,
    interactive: true,
    destructive: false,
    pageKey: 'chat',
    method: 'navigateSession',
    execute: makeNavigateToolExecutor({
      toolName: 'deepseek_navigate_session',
      pageKey: 'chat',
      method: 'navigateSession',
    }),
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
  cli: {
    entry: './cli/index.js',
    commands: CLI_COMMANDS,
  },
  openclaw: {
    tools: TOOL_DEFINITIONS.map(projectTool),
  },
  createRuntime,
  createOpenClawAdapter,
};
