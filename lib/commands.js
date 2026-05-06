'use strict';

const { PAGE_PROFILES, DEFAULT_PAGE } = require('./config');
const targets = require('./toolTargets');

/**
 * COMMANDS 表
 *
 * kind:
 *   - 'special':     在 cli/index.js 单独处理（doctor / dom-dump / xhr-log / export-session-local）
 *   - 'call':        直接翻译为 `session.callApi(api, toArgs(opts, positional))`
 *   - 'tool':        走 lib/runTool.js（READ + transform）
 *   - 'destructive': 走 lib/runTool.js destructive 分支（audit + 可选 backup）
 *   - 'navigate':    INTERACTIVE 档，走 callApi(navigateXxx) + awaitBridgeAfterNav
 */
const COMMANDS = {
  doctor: {
    kind: 'special', argSpec: [], pages: Object.keys(PAGE_PROFILES),
    help: '连通性 + 登录态 + bridge 注入 + probe + state 汇总（诊断）',
  },
  probe: {
    kind: 'call', api: 'probe', argSpec: [], toArgs: () => [],
    pages: Object.keys(PAGE_PROFILES), defaultPage: DEFAULT_PAGE,
    help: '采集页面指纹（按 page profile）',
  },
  state: {
    kind: 'call', api: 'state', argSpec: [], toArgs: () => [],
    pages: Object.keys(PAGE_PROFILES), defaultPage: DEFAULT_PAGE,
    help: '读取当前 page profile 状态',
  },
  'session-state': {
    kind: 'tool', toolName: 'deepseek_session_state', api: 'sessionState',
    pages: ['home'], defaultPage: 'home',
    argSpec: [], toArgs: () => [{}], targetUrl: () => null,
    help: '读取登录态',
  },
  'list-sessions': {
    kind: 'tool', toolName: 'deepseek_list_sessions', api: 'listSessions',
    pages: ['home'], defaultPage: 'home',
    argSpec: [],
    toArgs: (opts) => [{ limit: opts.limit ? Number(opts.limit) : undefined, beforeSeqId: opts.before || undefined }],
    targetUrl: () => targets.homeUrl(),
    help: '列出历史会话：list-sessions [--limit N] [--before <seqId>]',
  },
  'get-session': {
    kind: 'tool', toolName: 'deepseek_get_session', api: 'getSession',
    pages: ['chat'], defaultPage: 'chat',
    argSpec: [{ name: 'sessionId', required: true }],
    toArgs: (opts, positional) => [{ sessionId: positional[0], limit: opts.limit ? Number(opts.limit) : undefined, contentMaxLen: opts.contentMaxLen ? Number(opts.contentMaxLen) : undefined }],
    targetUrl: (opts, positional) => targets.chatSessionUrl({ sessionId: positional[0] }),
    help: '读取单会话消息：get-session <sessionId> [--limit N] [--redact off|trunc|full]',
  },
  'chat-page-state': {
    kind: 'tool', toolName: 'deepseek_chat_page_state', api: 'chatPageState',
    pages: ['chat'], defaultPage: 'chat',
    argSpec: [], toArgs: () => [{}], targetUrl: () => null,
    help: '读取当前 chat 页 UI 状态',
  },
  'list-messages': {
    kind: 'tool', toolName: 'deepseek_list_messages', api: 'listMessages',
    pages: ['chat'], defaultPage: 'chat',
    argSpec: [{ name: 'sessionId', required: true }],
    toArgs: (opts, positional) => [{ sessionId: positional[0], limit: opts.limit ? Number(opts.limit) : undefined, contentMaxLen: opts.contentMaxLen ? Number(opts.contentMaxLen) : undefined }],
    targetUrl: (opts, positional) => targets.chatSessionUrl({ sessionId: positional[0] }),
    help: '列出消息元数据：list-messages <sessionId> [--limit N]',
  },
  'get-message': {
    kind: 'tool', toolName: 'deepseek_get_message', api: 'getMessage',
    pages: ['chat'], defaultPage: 'chat',
    argSpec: [{ name: 'sessionId', required: true }, { name: 'messageId', required: true }],
    toArgs: (opts, positional) => [{ sessionId: positional[0], messageId: Number(positional[1]), contentMaxLen: opts.contentMaxLen ? Number(opts.contentMaxLen) : undefined }],
    targetUrl: (opts, positional) => targets.chatSessionUrl({ sessionId: positional[0] }),
    help: '读取单条消息：get-message <sessionId> <messageId> [--redact off|trunc|full]',
  },
  'get-session-tree': {
    kind: 'tool', toolName: 'deepseek_get_session_tree', api: 'getSessionTree',
    pages: ['chat'], defaultPage: 'chat',
    argSpec: [{ name: 'sessionId', required: true }],
    toArgs: (opts, positional) => [{
      sessionId: positional[0],
      contentMaxLen: opts.contentMaxLen ? Number(opts.contentMaxLen) : undefined,
      limit: opts.limit ? Number(opts.limit) : undefined,
    }],
    targetUrl: (opts, positional) => targets.chatSessionUrl({ sessionId: positional[0] }),
    help: '读取会话全分支树：get-session-tree <sessionId> [--limit N] [--redact off|trunc|full]',
  },
  'list-branch-points': {
    kind: 'tool', toolName: 'deepseek_list_branch_points', api: 'listBranchPoints',
    pages: ['chat'], defaultPage: 'chat',
    argSpec: [{ name: 'sessionId', required: true }],
    toArgs: (opts, positional) => [{ sessionId: positional[0] }],
    targetUrl: (opts, positional) => targets.chatSessionUrl({ sessionId: positional[0] }),
    help: '列出分支点：list-branch-points <sessionId>',
  },
  'get-branch-path': {
    kind: 'tool', toolName: 'deepseek_get_branch_path', api: 'getBranchPath',
    pages: ['chat'], defaultPage: 'chat',
    argSpec: [{ name: 'sessionId', required: true }],
    toArgs: (opts, positional) => [{
      sessionId: positional[0],
      leafMessageId: opts.leaf != null ? Number(opts.leaf) : undefined,
      contentMaxLen: opts.contentMaxLen ? Number(opts.contentMaxLen) : undefined,
      limit: opts.limit ? Number(opts.limit) : undefined,
    }],
    targetUrl: (opts, positional) => targets.chatSessionUrl({ sessionId: positional[0] }),
    help: '从指定 leaf 反推 root 路径：get-branch-path <sessionId> [--leaf N] [--redact off|trunc|full]',
  },
  'streaming-status': {
    kind: 'tool', toolName: 'deepseek_streaming_status', api: 'streamingStatus',
    pages: ['chat'], defaultPage: 'chat',
    argSpec: [{ name: 'sessionId', required: false }],
    toArgs: (opts, positional) => [{ sessionId: positional[0] || undefined }],
    targetUrl: (opts, positional) => (positional[0] ? targets.chatSessionUrl({ sessionId: positional[0] }) : null),
    help: '观察 assistant 是否在产出：streaming-status [<sessionId>]',
  },
  'chat-settings-view': {
    kind: 'tool', toolName: 'deepseek_chat_settings_view', api: 'chatSettingsView',
    pages: ['chat'], defaultPage: 'chat',
    argSpec: [],
    toArgs: (opts) => [{ scope: opts.scope || 'main' }],
    targetUrl: () => null,
    help: '只读 /api/v0/client/settings：chat-settings-view [--scope main|model]',
  },
  'list-files': {
    kind: 'tool', toolName: 'deepseek_list_files', api: 'listFiles',
    pages: ['chat'], defaultPage: 'chat',
    argSpec: [],
    toArgs: (opts) => [{ sessionId: opts.session || undefined }],
    targetUrl: () => null,
    help: '列出已上传文件：list-files [--session <sid>]',
  },
  'list-shares': {
    kind: 'tool', toolName: 'deepseek_list_shares', api: 'listShares',
    pages: ['home'], defaultPage: 'home',
    argSpec: [], toArgs: () => [{}], targetUrl: () => null,
    help: '列出分享链接',
  },
  'navigate-home': {
    kind: 'navigate', toolName: 'deepseek_navigate_home', api: 'navigateHome',
    pages: ['home'], defaultPage: 'home',
    argSpec: [], toNavArgs: () => ({}),
    help: '导航到 / （仅 location.assign）',
  },
  'navigate-session': {
    kind: 'navigate', toolName: 'deepseek_navigate_session', api: 'navigateSession',
    pages: ['chat'], defaultPage: 'chat',
    argSpec: [{ name: 'sessionId', required: false }],
    toNavArgs: (opts, positional) => ({ sessionId: positional[0] || undefined, url: opts.url || undefined }),
    help: '导航到 /a/chat/s/<id>',
  },
  'navigate-new-chat': {
    kind: 'navigate', toolName: 'deepseek_navigate_new_chat', api: 'navigateNewChat',
    pages: ['home'], defaultPage: 'home',
    argSpec: [], toNavArgs: () => ({}),
    help: '导航到 / 起新对话',
  },

  // ===== DESTRUCTIVE =====
  'create-session': {
    kind: 'destructive', toolName: 'deepseek_create_session', api: 'createSession',
    pages: ['home'], defaultPage: 'home',
    sideEffect: 'reversible',
    argSpec: [], toArgs: (opts) => [{ agent: opts.agent || undefined }],
    targetUrl: () => null,
    help: '[DESTRUCTIVE] 创建新会话：create-session [--agent chat]',
  },
  'rename-session': {
    kind: 'destructive', toolName: 'deepseek_rename_session', api: 'renameSession',
    pages: ['home'], defaultPage: 'home',
    sideEffect: 'reversible',
    argSpec: [{ name: 'sessionId', required: true }, { name: 'title', required: true }],
    toArgs: (opts, positional) => [{ sessionId: positional[0], title: positional.slice(1).join(' ') }],
    targetUrl: () => null,
    help: '[DESTRUCTIVE] 重命名会话：rename-session <sessionId> <title...>',
  },
  'pin-session': {
    kind: 'destructive', toolName: 'deepseek_pin_session', api: 'pinSession',
    pages: ['home'], defaultPage: 'home', sideEffect: 'reversible',
    argSpec: [{ name: 'sessionId', required: true }],
    toArgs: (opts, positional) => [{ sessionId: positional[0] }], targetUrl: () => null,
    help: '[DESTRUCTIVE] 置顶会话：pin-session <sessionId>',
  },
  'unpin-session': {
    kind: 'destructive', toolName: 'deepseek_unpin_session', api: 'unpinSession',
    pages: ['home'], defaultPage: 'home', sideEffect: 'reversible',
    argSpec: [{ name: 'sessionId', required: true }],
    toArgs: (opts, positional) => [{ sessionId: positional[0] }], targetUrl: () => null,
    help: '[DESTRUCTIVE] 取消置顶：unpin-session <sessionId>',
  },
  // 注：v0.3.3 移除 delete-session（删除会话不可逆且无可靠补偿，本地 backup
  // 也无法恢复 server 数据）。如需清理，请走 DeepSeek 官方 UI。
  'feedback-message': {
    kind: 'destructive', toolName: 'deepseek_feedback_message', api: 'feedbackMessage',
    pages: ['chat'], defaultPage: 'chat', sideEffect: 'reversible',
    argSpec: [{ name: 'sessionId', required: true }, { name: 'messageId', required: true }, { name: 'feedback', required: true }],
    toArgs: (opts, positional) => [{
      sessionId: positional[0],
      messageId: Number(positional[1]),
      feedback: Number(positional[2]),
      comment: opts.comment || undefined,
    }],
    targetUrl: (opts, positional) => targets.chatSessionUrl({ sessionId: positional[0] }),
    help: '[DESTRUCTIVE] 消息反馈：feedback-message <sessionId> <messageId> <-1|0|1> [--comment "..."]',
  },
  'stop-stream': {
    kind: 'destructive', toolName: 'deepseek_stop_stream', api: 'stopStream',
    pages: ['chat'], defaultPage: 'chat', sideEffect: 'reversible',
    argSpec: [{ name: 'sessionId', required: true }],
    toArgs: (opts, positional) => [{ sessionId: positional[0] }],
    targetUrl: (opts, positional) => targets.chatSessionUrl({ sessionId: positional[0] }),
    help: '[DESTRUCTIVE] 停止流式生成：stop-stream <sessionId>',
  },
  'send-message': {
    kind: 'destructive', toolName: 'deepseek_send_message', api: 'sendMessage',
    pages: ['chat'], defaultPage: 'chat', sideEffect: 'cost',
    argSpec: [{ name: 'sessionId', required: true }, { name: 'prompt', required: true }],
    toArgs: (opts, positional) => [{
      sessionId: positional[0],
      prompt: positional.slice(1).join(' '),
      parentMessageId: opts.parent != null ? Number(opts.parent) : undefined,
      thinking: !!opts.thinking,
      search: !!opts.search,
      includeContent: !!opts.includeContent,
      timeoutMs: opts.timeout ? Number(opts.timeout) : undefined,
    }],
    targetUrl: (opts, positional) => targets.chatSessionUrl({ sessionId: positional[0] }),
    help: '[DESTRUCTIVE,COST] 发消息：send-message <sessionId> <prompt...> [--parent N] [--thinking] [--search] [--include-content]',
  },
  'dom-send-message': {
    kind: 'destructive', toolName: 'deepseek_dom_send_message', api: 'domSendMessage',
    pages: ['chat'], defaultPage: 'chat', sideEffect: 'cost',
    argSpec: [{ name: 'prompt', required: true }],
    toArgs: (opts, positional) => [{
      prompt: positional.join(' '),
      waitForFinish: opts.noWait ? false : true,
      sessionIdTimeoutMs: opts.sidTimeout ? Number(opts.sidTimeout) : undefined,
      finishTimeoutMs: opts.finishTimeout ? Number(opts.finishTimeout) : undefined,
    }],
    targetUrl: (opts) => opts.sessionId ? targets.chatSessionUrl({ sessionId: opts.sessionId }) : targets.homeUrl(),
    help: '[DESTRUCTIVE,COST] DOM 模式发消息（绕开 PoW）：dom-send-message <prompt...> [--session <sid>] [--no-wait]',
  },
  'dom-edit-message': {
    kind: 'destructive', toolName: 'deepseek_dom_edit_message', api: 'domEditMessage',
    pages: ['chat'], defaultPage: 'chat', sideEffect: 'cost',
    argSpec: [{ name: 'prompt', required: true }],
    toArgs: (opts, positional) => [{
      prompt: positional.join(' '),
      target: opts.messageId != null ? 'byMessageId' : 'lastUser',
      messageId: opts.messageId != null ? Number(opts.messageId) : undefined,
      waitForFinish: opts.noWait ? false : true,
      finishTimeoutMs: opts.finishTimeout ? Number(opts.finishTimeout) : undefined,
    }],
    targetUrl: (opts) => opts.session ? targets.chatSessionUrl({ sessionId: opts.session }) : null,
    help: '[DESTRUCTIVE,COST] DOM 编辑 USER 消息：dom-edit-message <prompt...> [--session <sid>] [--message-id <N>] [--no-wait]',
  },
  'dom-regenerate-message': {
    kind: 'destructive', toolName: 'deepseek_dom_regenerate_message', api: 'domRegenerateMessage',
    pages: ['chat'], defaultPage: 'chat', sideEffect: 'cost',
    argSpec: [],
    toArgs: (opts) => [{
      target: opts.messageId != null ? 'byMessageId' : 'lastAssistant',
      messageId: opts.messageId != null ? Number(opts.messageId) : undefined,
      waitForFinish: opts.noWait ? false : true,
      finishTimeoutMs: opts.finishTimeout ? Number(opts.finishTimeout) : undefined,
    }],
    targetUrl: (opts) => opts.session ? targets.chatSessionUrl({ sessionId: opts.session }) : null,
    help: '[DESTRUCTIVE,COST] DOM 重生 ASSISTANT 消息：dom-regenerate-message [--session <sid>] [--message-id <N>] [--no-wait]',
  },
  'dom-stop-stream': {
    kind: 'destructive', toolName: 'deepseek_dom_stop_stream', api: 'domStopStream',
    pages: ['chat'], defaultPage: 'chat', sideEffect: 'reversible',
    argSpec: [],
    toArgs: () => [{}],
    targetUrl: (opts) => opts.sessionId ? targets.chatSessionUrl({ sessionId: opts.sessionId }) : null,
    help: '[DESTRUCTIVE,reversible] DOM 模式停止流：dom-stop-stream --session <sid>',
  },
  'edit-message': {
    kind: 'destructive', toolName: 'deepseek_edit_message', api: 'editMessage',
    pages: ['chat'], defaultPage: 'chat', sideEffect: 'cost',
    argSpec: [{ name: 'sessionId', required: true }, { name: 'messageId', required: true }, { name: 'prompt', required: true }],
    toArgs: (opts, positional) => [{
      sessionId: positional[0], messageId: Number(positional[1]),
      prompt: positional.slice(2).join(' '),
      thinking: !!opts.thinking, search: !!opts.search, includeContent: !!opts.includeContent,
    }],
    targetUrl: (opts, positional) => targets.chatSessionUrl({ sessionId: positional[0] }),
    help: '[DESTRUCTIVE,COST] 编辑消息并重生：edit-message <sessionId> <messageId> <prompt...>',
  },
  'regenerate-message': {
    kind: 'destructive', toolName: 'deepseek_regenerate_message', api: 'regenerateMessage',
    pages: ['chat'], defaultPage: 'chat', sideEffect: 'cost',
    argSpec: [{ name: 'sessionId', required: true }, { name: 'parentMessageId', required: true }],
    toArgs: (opts, positional) => [{
      sessionId: positional[0], parentMessageId: Number(positional[1]),
      thinking: !!opts.thinking, search: !!opts.search, includeContent: !!opts.includeContent,
    }],
    targetUrl: (opts, positional) => targets.chatSessionUrl({ sessionId: positional[0] }),
    help: '[DESTRUCTIVE,COST] 重生回复：regenerate-message <sessionId> <parentMessageId>',
  },
  'upload-file': {
    kind: 'destructive', toolName: 'deepseek_upload_file', api: 'uploadFile',
    pages: ['chat'], defaultPage: 'chat', sideEffect: 'reversible',
    argSpec: [{ name: 'filename', required: true }, { name: 'localPath', required: true }],
    toArgs: (opts, positional) => {
      const fs = require('fs');
      const buf = fs.readFileSync(positional[1]);
      return [{
        filename: positional[0],
        contentBase64: buf.toString('base64'),
        mime: opts.mime || 'application/octet-stream',
        sessionId: opts.session || undefined,
      }];
    },
    targetUrl: () => null,
    help: '[DESTRUCTIVE] 上传本地文件：upload-file <filename> <localPath> [--mime ...] [--session <sid>]',
  },
  'share-session': {
    kind: 'destructive', toolName: 'deepseek_share_session', api: 'shareSession',
    pages: ['home'], defaultPage: 'home', sideEffect: 'reversible',
    argSpec: [{ name: 'sessionId', required: true }],
    toArgs: (opts, positional) => [{ sessionId: positional[0], title: opts.title || undefined }],
    targetUrl: () => null,
    help: '[DESTRUCTIVE] 创建分享链接：share-session <sessionId> [--title "..."]',
  },
  'unshare-session': {
    kind: 'destructive', toolName: 'deepseek_unshare_session', api: 'unshareSession',
    pages: ['home'], defaultPage: 'home', sideEffect: 'irreversible',
    argSpec: [{ name: 'shareId', required: true }],
    toArgs: (opts, positional) => [{ shareId: positional[0] }],
    targetUrl: () => null,
    help: '[DESTRUCTIVE,IRREVERSIBLE] 删除分享链接：unshare-session <shareId>',
  },
  'update-user-settings': {
    kind: 'destructive', toolName: 'deepseek_update_user_settings', api: 'updateUserSettings',
    pages: ['home'], defaultPage: 'home', sideEffect: 'reversible',
    argSpec: [{ name: 'jsonString', required: true }],
    toArgs: (opts, positional) => [{ settings: JSON.parse(positional[0]) }],
    targetUrl: () => null,
    help: '[DESTRUCTIVE] 更新账号设置：update-user-settings \'{"key":"value"}\'',
  },

  'export-session-local': {
    kind: 'special', argSpec: [{ name: 'sessionId', required: true }],
    pages: ['chat'], defaultPage: 'chat',
    help: '[本地] 导出会话到本地：export-session-local <sessionId> [--format json|md] [--out path]',
  },

  // ---- 内部踩点 ----
  'dom-dump': { kind: 'special', argSpec: [], pages: Object.keys(PAGE_PROFILES), defaultPage: DEFAULT_PAGE, help: '[内部] DOM 节点 outline' },
  'xhr-log': { kind: 'special', argSpec: [], pages: Object.keys(PAGE_PROFILES), defaultPage: DEFAULT_PAGE, help: '[内部] performance.getEntriesByType resource 抓取' },
};

function parseArgv(argv) {
  const opts = {
    tab: null, page: null, json: false, pretty: false, verbose: false, help: false,
    wsEndpoint: null, recordingMode: null, recordingBaseDir: null, runId: null,
    debugRecording: false, limit: null, before: null, redact: null, truncLen: null,
    contentMaxLen: null, url: null, anchors: false, filter: null, scope: null,
    agent: null, comment: null, parent: null, thinking: false, search: false,
    includeContent: false, timeout: null, mime: null, session: null, title: null,
    format: null, out: null,
    noWait: false, sidTimeout: null, finishTimeout: null, messageId: null,
    leaf: null,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eat = (key) => { opts[key] = argv[++i]; };
    const eatEq = (key, prefix) => { opts[key] = a.slice(prefix.length); };
    if (a === '--json') opts.json = true;
    else if (a === '--pretty') opts.pretty = true;
    else if (a === '-v' || a === '--verbose') opts.verbose = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--debug-recording') opts.debugRecording = true;
    else if (a === '--anchors') opts.anchors = true;
    else if (a === '--thinking') opts.thinking = true;
    else if (a === '--search') opts.search = true;
    else if (a === '--include-content') opts.includeContent = true;
    else if (a === '--filter') eat('filter');
    else if (a.startsWith('--filter=')) eatEq('filter', '--filter=');
    else if (a === '--tab') eat('tab');
    else if (a.startsWith('--tab=')) eatEq('tab', '--tab=');
    else if (a === '--page') eat('page');
    else if (a.startsWith('--page=')) eatEq('page', '--page=');
    else if (a === '--server' || a === '--ws-endpoint' || a === '--browser-server') eat('wsEndpoint');
    else if (a.startsWith('--server=') || a.startsWith('--ws-endpoint=') || a.startsWith('--browser-server=')) opts.wsEndpoint = a.slice(a.indexOf('=') + 1);
    else if (a === '--recording-mode') eat('recordingMode');
    else if (a.startsWith('--recording-mode=')) eatEq('recordingMode', '--recording-mode=');
    else if (a === '--recording-base-dir') eat('recordingBaseDir');
    else if (a.startsWith('--recording-base-dir=')) eatEq('recordingBaseDir', '--recording-base-dir=');
    else if (a === '--run-id') eat('runId');
    else if (a.startsWith('--run-id=')) eatEq('runId', '--run-id=');
    else if (a === '--limit') eat('limit');
    else if (a.startsWith('--limit=')) eatEq('limit', '--limit=');
    else if (a === '--before' || a === '--before-seq-id') eat('before');
    else if (a.startsWith('--before=')) eatEq('before', '--before=');
    else if (a === '--redact') eat('redact');
    else if (a.startsWith('--redact=')) eatEq('redact', '--redact=');
    else if (a === '--trunc-len') eat('truncLen');
    else if (a.startsWith('--trunc-len=')) eatEq('truncLen', '--trunc-len=');
    else if (a === '--content-max-len') eat('contentMaxLen');
    else if (a.startsWith('--content-max-len=')) eatEq('contentMaxLen', '--content-max-len=');
    else if (a === '--url') eat('url');
    else if (a.startsWith('--url=')) eatEq('url', '--url=');
    else if (a === '--scope') eat('scope');
    else if (a.startsWith('--scope=')) eatEq('scope', '--scope=');
    else if (a === '--agent') eat('agent');
    else if (a === '--comment') eat('comment');
    else if (a === '--parent') eat('parent');
    else if (a === '--timeout') eat('timeout');
    else if (a === '--mime') eat('mime');
    else if (a === '--session') eat('session');
    else if (a === '--title') eat('title');
    else if (a === '--format') eat('format');
    else if (a === '--out') eat('out');
    else if (a === '--no-wait') opts.noWait = true;
    else if (a === '--sid-timeout') eat('sidTimeout');
    else if (a === '--finish-timeout') eat('finishTimeout');
    else if (a === '--message-id' || a === '--msg-id') eat('messageId');
    else if (a.startsWith('--message-id=')) opts.messageId = a.slice('--message-id='.length);
    else if (a === '--leaf' || a === '--leaf-message-id') eat('leaf');
    else if (a.startsWith('--leaf=')) opts.leaf = a.slice('--leaf='.length);
    else if (a.startsWith('-')) {
      const err = new Error(`unknown option: ${a}`);
      err.code = 'E_BAD_ARG';
      throw err;
    } else {
      positional.push(a);
    }
  }
  return { opts, positional };
}

function printHelp() {
  const pageList = Object.keys(PAGE_PROFILES).join(' | ');
  const lines = [
    'js-deepseek-ops-skill v0.3 - DeepSeek Chat 全量自动化（READ + INTERACTIVE + DESTRUCTIVE）',
    '',
    'Usage: node index.js <command> [args] [options]',
    '',
    'Commands:',
  ];
  for (const [name, def] of Object.entries(COMMANDS)) {
    const args = (def.argSpec || []).map((s) => (s.required ? `<${s.name}>` : `[${s.name}]`)).join(' ');
    const pageHint = def.defaultPage ? ` [page=${def.defaultPage}]` : (def.pages && def.pages.length === 1 ? ` [page=${def.pages[0]}]` : '');
    lines.push(`  ${name.padEnd(22)} ${args.padEnd(28)} ${(def.help || '') + pageHint}`);
  }
  lines.push(
    '',
    'Options:',
    `  --page <name>            page profile (${pageList})`,
    '  --tab <id>               浏览器 tab id',
    '  --limit <n>              列表条数',
    '  --before <seqId>         分页游标',
    '  --redact off|trunc|full  正文呈现方式',
    '  --trunc-len <n>          --redact=trunc 时保留长度',
    '  --content-max-len <n>    bridge 端硬上限',
    '  --scope main|model       chat-settings-view 作用域',
    '  --thinking / --search    send-message / edit / regenerate 默认选项',
    '  --parent <id>            send-message 的 parent_message_id',
    '  --include-content        send-message 等返回 assistant 全文（默认仅 sha256+length）',
    '  --timeout <ms>           SSE 流读硬超时',
    '  --comment "..."          feedback-message 评论',
    '  --mime / --session       upload-file 选项',
    '  --title "..."            share-session 标题',
    '  --format json|md         export-session-local 格式',
    '  --out <path>             export-session-local 输出路径',
    '  --pretty                 JSON 缩进 2 空格',
    '  -v, --verbose            session 流转日志',
    '  --server <ws-url>        js-eyes WS endpoint',
    '  --recording-mode <mode>  off|history|standard|debug',
    '  --debug-recording        强制写 debug bundle',
    '  -h, --help               显示帮助',
    '',
    '示例（READ）:',
    '  node index.js doctor',
    '  node index.js list-sessions --limit 25',
    '  node index.js get-session <sid> --limit 20',
    '',
    '示例（DESTRUCTIVE）:',
    '  node index.js create-session',
    '  node index.js rename-session <sid> "新标题"',
    '  node index.js pin-session <sid>',
    '  node index.js feedback-message <sid> 12 1',
    '  node index.js send-message <sid> "ping"      # 消耗 token',
    '  node index.js stop-stream <sid>',
    '  node index.js export-session-local <sid> --format md --out ./out.md',
    '',
    '注意:',
    '  * v0.3 起 BREAKING：destructive 工具不再有任何 confirm，调用即生效',
    '  * 所有 destructive 调用强制写 audit.jsonl（含 prompt 原文 / 完整请求体）',
    '  * irreversible 调用前自动 backup 到 ~/.js-eyes/skill-records/<skill>/backups/',
    '  * 测试请只用专属测试会话，不要直接对真实数据测试',
    '  * 设 JS_DEEPSEEK_DEBUG=1 让错误打印 stack',
  );
  process.stdout.write(lines.join('\n') + '\n');
}

module.exports = { COMMANDS, parseArgv, printHelp };
