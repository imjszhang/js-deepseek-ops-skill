'use strict';

const { PAGE_PROFILES, DEFAULT_PAGE } = require('./config');
const targets = require('./toolTargets');

/**
 * COMMANDS 表
 *
 * kind:
 *   - 'special':  在 cli/index.js 单独处理（doctor / dom-dump / xhr-log）
 *   - 'call':     直接翻译为 `session.callApi(api, toArgs(opts, positional))`
 *   - 'tool':     走 lib/runTool.js，进 history + debug bundle
 *   - 'navigate': INTERACTIVE 档，走 callApi(navigateXxx) + awaitBridgeAfterNav
 */
const COMMANDS = {
  doctor: {
    kind: 'special',
    argSpec: [],
    pages: Object.keys(PAGE_PROFILES),
    help: '连通性 + 登录态 + bridge 注入 + probe + state 汇总（诊断）',
  },
  probe: {
    kind: 'call',
    api: 'probe',
    argSpec: [],
    toArgs: () => [],
    pages: Object.keys(PAGE_PROFILES),
    defaultPage: DEFAULT_PAGE,
    help: '采集页面指纹（按 page profile）',
  },
  state: {
    kind: 'call',
    api: 'state',
    argSpec: [],
    toArgs: () => [],
    pages: Object.keys(PAGE_PROFILES),
    defaultPage: DEFAULT_PAGE,
    help: '读取当前 page profile 状态',
  },
  'session-state': {
    kind: 'tool',
    toolName: 'deepseek_session_state',
    api: 'sessionState',
    pages: ['home'],
    defaultPage: 'home',
    argSpec: [],
    toArgs: () => [{}],
    targetUrl: () => null,
    help: '读取登录态（/api/v0/users/current，未登录回 {loggedIn:false}）',
  },
  'list-sessions': {
    kind: 'tool',
    toolName: 'deepseek_list_sessions',
    api: 'listSessions',
    pages: ['home'],
    defaultPage: 'home',
    argSpec: [],
    toArgs: (opts) => [{
      limit: opts.limit ? Number(opts.limit) : undefined,
      beforeSeqId: opts.before || undefined,
    }],
    targetUrl: () => targets.homeUrl(),
    help: '列出历史会话：list-sessions [--limit N] [--before <seqId>]',
  },
  'get-session': {
    kind: 'tool',
    toolName: 'deepseek_get_session',
    api: 'getSession',
    pages: ['chat'],
    defaultPage: 'chat',
    argSpec: [{ name: 'sessionId', required: true }],
    // get-session 在 cli 层做 redact transform，所以不能直接用通用 runTool；
    // 在 cli/index.js 里有针对此命令的 special 分支。
    toArgs: (opts, positional) => [{
      sessionId: positional[0],
      limit: opts.limit ? Number(opts.limit) : undefined,
      contentMaxLen: opts.contentMaxLen ? Number(opts.contentMaxLen) : undefined,
    }],
    targetUrl: (opts, positional) => targets.chatSessionUrl({ sessionId: positional[0] }),
    help: '读取单会话消息：get-session <sessionId> [--limit N] [--redact off|trunc|full] [--trunc-len 200]',
  },
  'navigate-home': {
    kind: 'navigate',
    toolName: 'deepseek_navigate_home',
    api: 'navigateHome',
    pages: ['home'],
    defaultPage: 'home',
    argSpec: [],
    toNavArgs: () => ({}),
    help: '导航到 / （仅 location.assign）',
  },
  'navigate-session': {
    kind: 'navigate',
    toolName: 'deepseek_navigate_session',
    api: 'navigateSession',
    pages: ['chat'],
    defaultPage: 'chat',
    argSpec: [{ name: 'sessionId', required: false }],
    toNavArgs: (opts, positional) => ({
      sessionId: positional[0] || undefined,
      url: opts.url || undefined,
    }),
    help: '导航到 /a/chat/s/<id>：navigate-session <sessionId> 或 --url <full-url>',
  },

  // ---- 内部踩点 CLI（不进 TOOL_DEFINITIONS，不暴露给 AI）----
  'dom-dump': {
    kind: 'special',
    argSpec: [],
    pages: Object.keys(PAGE_PROFILES),
    defaultPage: DEFAULT_PAGE,
    help: '[内部] 当前 deepseek 页面关键节点 outline（[data-testid] / a[href*="/a/chat/s/"] / nav / aside）；--anchors 加 a[href]',
  },
  'xhr-log': {
    kind: 'special',
    argSpec: [],
    pages: Object.keys(PAGE_PROFILES),
    defaultPage: DEFAULT_PAGE,
    help: '[内部] performance.getEntriesByType("resource") 中匹配 deepseek.com/api 的请求；--filter <regex> 自定义过滤',
  },
};

function parseArgv(argv) {
  const opts = {
    tab: null,
    page: null,
    json: false,
    pretty: false,
    verbose: false,
    help: false,
    wsEndpoint: null,
    recordingMode: null,
    recordingBaseDir: null,
    runId: null,
    debugRecording: false,
    limit: null,
    before: null,
    redact: null,
    truncLen: null,
    contentMaxLen: null,
    url: null,
    anchors: false,
    filter: null,
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
    else if (a === '--filter') eat('filter');
    else if (a.startsWith('--filter=')) eatEq('filter', '--filter=');
    else if (a === '--tab') eat('tab');
    else if (a.startsWith('--tab=')) eatEq('tab', '--tab=');
    else if (a === '--page') eat('page');
    else if (a.startsWith('--page=')) eatEq('page', '--page=');
    else if (a === '--server' || a === '--ws-endpoint' || a === '--browser-server') eat('wsEndpoint');
    else if (a.startsWith('--server=') || a.startsWith('--ws-endpoint=') || a.startsWith('--browser-server=')) {
      opts.wsEndpoint = a.slice(a.indexOf('=') + 1);
    } else if (a === '--recording-mode') eat('recordingMode');
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
    else if (a.startsWith('-')) {
      const err = new Error(
        `unknown option: ${a}（运行 \`node index.js --help\` 查看可用选项）`,
      );
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
    'js-deepseek-ops-skill - DeepSeek Chat 内容只读 + 浏览器导航（READ + INTERACTIVE，不写任何业务数据）',
    '',
    'Usage: node index.js <command> [args] [options]',
    '',
    'Commands:',
  ];
  for (const [name, def] of Object.entries(COMMANDS)) {
    const args = (def.argSpec || []).map((s) => (s.required ? `<${s.name}>` : `[${s.name}]`)).join(' ');
    const pageHint = def.defaultPage
      ? ` [page=${def.defaultPage}]`
      : (def.pages && def.pages.length === 1 ? ` [page=${def.pages[0]}]` : '');
    lines.push(`  ${name.padEnd(18)} ${args.padEnd(14)} ${(def.help || '') + pageHint}`);
  }
  lines.push(
    '',
    'Options:',
    `  --page <name>            page profile (${pageList}; 默认按 command 推导，fallback 到 ${DEFAULT_PAGE})`,
    '  --tab <id>               强制指定浏览器 tab id（默认按 page profile 评分匹配）',
    '  --limit <n>              列表条数 / 单会话保留最近 N 条消息',
    '  --before <seqId>         list-sessions 分页游标（上一页最后一条的 seqId）',
    '  --redact off|trunc|full  get-session 正文呈现方式（默认 off=只出 sha256 摘要）',
    '  --trunc-len <n>          --redact=trunc 时单条正文保留长度，默认 200',
    '  --content-max-len <n>    bridge 端正文硬上限，默认 60000（防 SSE 残留）',
    '  --url <url>              navigate-session 直接传 URL（仅 *.deepseek.com）',
    '  --pretty                 JSON 缩进 2 空格输出',
    '  -v, --verbose            session 流转日志输出到 stderr',
    '  --server <ws-url>        js-eyes WS endpoint（默认 ws://localhost:18080，可用 JS_EYES_SERVER_URL 覆盖）',
    '  --recording-mode <mode>  off|history|standard|debug',
    '  --debug-recording        强制写 debug bundle（也是 --redact=full 生效的前提）',
    '  -h, --help               显示帮助',
    '',
    '示例:',
    '  node index.js doctor',
    '  node index.js session-state',
    '  node index.js list-sessions --limit 25',
    '  node index.js list-sessions --limit 25 --before 199549139',
    '  node index.js get-session d54aadf1-9f49-4f16-a8ee-a6aae6843f3a --limit 20',
    '  node index.js get-session d54aadf1-9f49-4f16-a8ee-a6aae6843f3a --limit 50 --redact trunc --trunc-len 200 --pretty',
    '  node index.js navigate-home',
    '  node index.js navigate-session d54aadf1-9f49-4f16-a8ee-a6aae6843f3a',
    '  # 内部踩点',
    '  node index.js dom-dump --limit 80',
    '  node index.js xhr-log --filter "deepseek\\.com/api" --limit 200',
    '',
    '注意:',
    '  * READ 档不模拟点击 / 不改 DOM；INTERACTIVE 档只通过 location.assign 改 URL',
    '  * 永不执行 send_message / regenerate / stop_stream / 切换模型 / 删除会话 / 上传文件 / 创建 API key',
    '  * 私聊正文默认走 redact=off（sha256 摘要），需要原文请显式传 --redact full --debug-recording',
    '  * 设 JS_DEEPSEEK_DEBUG=1 让错误打印 stack',
  );
  process.stdout.write(lines.join('\n') + '\n');
}

module.exports = { COMMANDS, parseArgv, printHelp };
