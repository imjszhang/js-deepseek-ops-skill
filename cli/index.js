'use strict';

const { Session } = require('../lib/session');
const { COMMANDS, parseArgv, printHelp } = require('../lib/commands');
const { PAGE_PROFILES, DEFAULT_PAGE } = require('../lib/config');
const { resolveRuntimeConfig } = require('../lib/runtimeConfig');
const { BrowserAutomation } = require('../lib/js-eyes-client');
const { runTool } = require('../lib/runTool');
const {
  buildGetSessionTransform,
  buildGetMessageTransform,
  buildListMessagesTransform,
  buildGetSessionTreeTransform,
  buildGetBranchPathTransform,
  buildListBranchPointsTransform,
} = require('../lib/redact');
const { formatAsMermaid, formatAsAscii } = require('../lib/treeFormat');
const { ensureSkillRecordsReadme } = require('../lib/skillRecordsReadme');
const { assertAllowedUserSettings } = require('../lib/settingsPolicy');
const { prefetchShareBackup } = require('../skill.definition');
const fs = require('fs');

function writePrivateFile(filePath, contents) {
  fs.writeFileSync(filePath, contents, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') {
    try { fs.chmodSync(filePath, 0o600); } catch {}
  }
}

function pickPage(commandName, opts) {
  if (opts.page) return opts.page;
  const def = COMMANDS[commandName];
  if (def && def.defaultPage) return def.defaultPage;
  if (def && def.pages && def.pages.length === 1) return def.pages[0];
  return DEFAULT_PAGE;
}

function printJson(value, opts) {
  const indent = opts.pretty ? 2 : 0;
  process.stdout.write(JSON.stringify(value, null, indent) + '\n');
}

function buildSessionOpts(commandName, opts, extra = {}) {
  return {
    page: pickPage(commandName, opts),
    tab: opts.tab,
    verbose: opts.verbose,
    wsEndpoint: opts.wsEndpoint,
    targetUrl: extra.targetUrl || null,
    createIfMissing: extra.createIfMissing !== false,
  };
}

async function runCallCommand(commandName, def, opts, positional) {
  const session = new Session({ opts: buildSessionOpts(commandName, opts) });
  try {
    await session.connect();
    await session.resolveTarget();
    await session.ensureBridge();
    const args = def.toArgs ? def.toArgs(opts, positional) : (positional || []);
    const response = await session.callApi(def.api, args);
    printJson(response, opts);
    return response && response.ok === false ? 1 : 0;
  } finally {
    await session.close();
  }
}

function validateRequiredArgs(def, positional) {
  const required = (def.argSpec || []).filter((s) => s.required);
  for (let i = 0; i < required.length; i++) {
    if (positional[i] == null || positional[i] === '') {
      const err = new Error(`参数缺失: <${required[i].name}>。${def.help || ''}`);
      err.code = 'E_BAD_ARG';
      throw err;
    }
  }
}

async function runDestructiveCommand(commandName, def, opts, positional) {
  validateRequiredArgs(def, positional);
  const args = def.toArgs ? def.toArgs(opts, positional) : [{}];
  const targetUrl = typeof def.targetUrl === 'function' ? def.targetUrl(opts, positional) : null;
  const runtimeConfig = resolveRuntimeConfig({
    browserServer: opts.wsEndpoint || process.env.JS_EYES_WS_URL,
    recording: {
      ...(opts.recordingMode ? { mode: opts.recordingMode } : {}),
      ...(opts.recordingBaseDir ? { baseDir: opts.recordingBaseDir } : {}),
    },
  });
  const browser = new BrowserAutomation(runtimeConfig.serverUrl, opts.verbose ? {} : {
    logger: { info: () => {}, warn: (...a) => console.error(...a), error: (...a) => console.error(...a) },
  });
  const argsObj = (args && args[0]) || {};
  let prefetchBackup = null;
  if (def.prefetchBackup === true) {
    prefetchBackup = async function (session, a) {
      const snap = await session.callApi('getSessionSnapshot', [{ sessionId: a.sessionId }], { timeoutMs: 30000 });
      if (snap && snap.ok && snap.data) return { resource: 'session', id: a.sessionId, snapshot: snap.data };
      const error = new Error(`Unable to snapshot session before deletion: ${snap?.error || 'unknown error'}`);
      error.code = 'E_BACKUP_SOURCE_UNAVAILABLE';
      throw error;
    };
  } else if (def.prefetchBackup === 'share') {
    prefetchBackup = prefetchShareBackup;
  }
  if (def.toolName === 'deepseek_update_user_settings') {
    assertAllowedUserSettings(argsObj.settings, runtimeConfig.globalConfig);
  }
  try {
    const response = await runTool(browser, {
      toolName: def.toolName,
      pageKey: pickPage(commandName, opts),
      method: def.api,
      args: argsObj,
      targetUrl,
      destructive: true,
      sideEffect: def.sideEffect || 'reversible',
      prefetchBackup,
      options: {
        verbose: opts.verbose,
        tab: opts.tab,
        wsEndpoint: runtimeConfig.serverUrl,
        recording: runtimeConfig.recording,
        recordingMode: opts.recordingMode,
        debugRecording: opts.debugRecording,
        runId: opts.runId,
        navigateOnReuse: false,
        reuseAnyDeepseekTab: true,
        createUrl: targetUrl || 'https://chat.deepseek.com/',
        timeoutMs: ['sendMessage', 'editMessage', 'regenerateMessage', 'domSendMessage', 'domEditMessage', 'domRegenerateMessage'].includes(def.api) ? 180000 : 60000,
      },
    });
    printJson(response, opts);
    return response && response.ok === false ? 1 : 0;
  } finally {
    try { browser.disconnect(); } catch (_) {}
  }
}

async function runExportSessionLocal(opts, positional) {
  const fs = require('fs');
  const path = require('path');
  const sessionId = positional[0];
  if (!sessionId) {
    process.stderr.write('export-session-local: 缺少 <sessionId>\n');
    return 2;
  }
  const format = (opts.format || 'json').toLowerCase();
  const session = new Session({
    opts: Object.assign(buildSessionOpts('export-session-local', opts), {
      reuseAnyDeepseekTab: true, navigateOnReuse: false, createIfMissing: false,
    }),
  });
  let payload = null;
  try {
    await session.connect();
    await session.resolveTarget();
    await session.ensureBridge();
    payload = await session.callApi('getSession', [{ sessionId, limit: opts.limit ? Number(opts.limit) : undefined, contentMaxLen: 200000 }], { timeoutMs: 60000 });
  } finally { await session.close(); }
  if (!payload || !payload.ok) {
    printJson({ ok: false, error: 'export_failed', detail: payload }, opts);
    return 1;
  }
  const data = payload.data || {};
  const outPath = opts.out || `./deepseek-session-${sessionId}.${format === 'md' ? 'md' : 'json'}`;
  let body;
  if (format === 'md') {
    const lines = [`# ${(data.session && data.session.title) || sessionId}`, ''];
    for (const m of (data.messages || [])) {
      lines.push(`## ${m.role || 'unknown'} (msg ${m.messageId}, ${m.status}) — ${m.insertedAt}`);
      if (m.thinkingContent) { lines.push('', '<thinking>', m.thinkingContent, '</thinking>'); }
      lines.push('', m.content || '', '');
    }
    body = lines.join('\n');
  } else {
    body = JSON.stringify(data, null, 2);
  }
  writePrivateFile(path.resolve(outPath), body);
  printJson({ ok: true, exported: true, path: path.resolve(outPath), format, messages: (data.messages || []).length }, opts);
  return 0;
}

async function runToolCommand(commandName, def, opts, positional) {
  validateRequiredArgs(def, positional);
  const args = def.toArgs ? def.toArgs(opts, positional) : [{}];
  const targetUrl = typeof def.targetUrl === 'function' ? def.targetUrl(opts, positional) : null;
  const runtimeConfig = resolveRuntimeConfig({
    browserServer: opts.wsEndpoint || process.env.JS_EYES_WS_URL,
    recording: {
      ...(opts.recordingMode ? { mode: opts.recordingMode } : {}),
      ...(opts.recordingBaseDir ? { baseDir: opts.recordingBaseDir } : {}),
    },
  });
  const browser = new BrowserAutomation(runtimeConfig.serverUrl, opts.verbose ? {} : {
    logger: { info: () => {}, warn: (...a) => console.error(...a), error: (...a) => console.error(...a) },
  });
  // 含正文的工具走 redact transform；list-messages 走防漏断言 transform
  let transformResult = undefined;
  if (commandName === 'get-session') {
    const mode = opts.redact || 'off';
    const truncLen = opts.truncLen ? Number(opts.truncLen) : undefined;
    transformResult = buildGetSessionTransform({ mode, truncLen });
  } else if (commandName === 'get-message') {
    const mode = opts.redact || 'off';
    const truncLen = opts.truncLen ? Number(opts.truncLen) : undefined;
    transformResult = buildGetMessageTransform({ mode, truncLen });
  } else if (commandName === 'list-messages') {
    transformResult = buildListMessagesTransform();
  } else if (commandName === 'get-session-tree') {
    const mode = opts.redact || 'off';
    const truncLen = opts.truncLen ? Number(opts.truncLen) : undefined;
    transformResult = buildGetSessionTreeTransform({ mode, truncLen });
  } else if (commandName === 'get-branch-path') {
    const mode = opts.redact || 'off';
    const truncLen = opts.truncLen ? Number(opts.truncLen) : undefined;
    transformResult = buildGetBranchPathTransform({ mode, truncLen });
  } else if (commandName === 'list-branch-points') {
    transformResult = buildListBranchPointsTransform();
  }
  try {
    const response = await runTool(browser, {
      toolName: def.toolName,
      pageKey: pickPage(commandName, opts),
      method: def.api,
      args: (args && args[0]) || {},
      targetUrl,
      options: {
        verbose: opts.verbose,
        tab: opts.tab,
        wsEndpoint: runtimeConfig.serverUrl,
        recording: runtimeConfig.recording,
        recordingMode: opts.recordingMode,
        debugRecording: opts.debugRecording,
        runId: opts.runId,
        navigateOnReuse: false,
        reuseAnyDeepseekTab: true,
        createUrl: targetUrl || 'https://chat.deepseek.com/',
        transformResult,
      },
    });
    // v0.4.1: --format mermaid|ascii 适用于 get-session-tree / get-branch-path
    const wantsTreeFormat = (opts.format === 'mermaid' || opts.format === 'ascii');
    if (wantsTreeFormat && (commandName === 'get-session-tree' || commandName === 'get-branch-path')
        && response && response.ok && response.result) {
      const tree = _resolveTreeForFormat(response.result, commandName);
      if (tree) {
        const text = opts.format === 'mermaid' ? formatAsMermaid(tree) : formatAsAscii(tree);
        if (opts.out) {
          writePrivateFile(opts.out, text);
          process.stderr.write(`tree written to ${opts.out}\n`);
        } else {
          process.stdout.write(text);
        }
        return 0;
      }
    }
    printJson(response, opts);
    return response && response.ok === false ? 1 : 0;
  } finally {
    try { browser.disconnect(); } catch (_) {}
  }
}

// 把不同工具的 result 形态统一成 SessionTree-like 结构供 formatter 消费。
function _resolveTreeForFormat(result, commandName) {
  if (commandName === 'get-session-tree') {
    if (result && result.nodes && result.rootMessageIds) return result;
    return null;
  }
  if (commandName === 'get-branch-path') {
    const msgs = Array.isArray(result.messages) ? result.messages : [];
    if (!msgs.length) return null;
    const nodes = Object.create(null);
    for (let i = 0; i < msgs.length; i += 1) {
      const m = msgs[i];
      const id = m.messageId;
      const parentId = i === 0 ? null : msgs[i - 1].messageId;
      nodes[String(id)] = {
        messageId: id, parentId,
        role: m.role || '', status: m.status || '',
        childrenIds: i === msgs.length - 1 ? [] : [msgs[i + 1].messageId],
        depth: i, siblingIndex: 0, siblingCount: 1,
        isOnActivePath: true, isBranchPoint: false,
        isLeaf: i === msgs.length - 1,
      };
    }
    return {
      session: result.session || { id: null },
      rootMessageIds: [msgs[0].messageId],
      currentMessageId: msgs[msgs.length - 1].messageId,
      activePathIds: msgs.map((m) => m.messageId),
      branchPointIds: [],
      nodes,
      stats: { totalMessages: msgs.length },
    };
  }
  return null;
}

// ---- 内部踩点：dom-dump / xhr-log（不注入 bridge，直接 callRaw）----

const DOM_DUMP_FN_SRC = `function(args){
  args = args || {};
  const limit = Math.min(Math.max(parseInt(args.limit) || 80, 1), 300);
  const anchors = !!args.anchors;
  const out = [];
  const seen = new WeakSet();
  function dump(selector){
    let nodes;
    try { nodes = Array.from(document.querySelectorAll(selector)); } catch(_) { nodes = []; }
    for (let i = 0; i < nodes.length && out.length < limit; i++){
      const n = nodes[i];
      if (seen.has(n)) continue;
      seen.add(n);
      let rectTop = null;
      try { rectTop = Math.round(n.getBoundingClientRect().top); } catch(_) {}
      out.push({
        selector,
        tag: (n.tagName || '').toLowerCase(),
        id: n.id || '',
        cls: ((n.getAttribute && n.getAttribute('class')) || '').slice(0, 200),
        testid: (n.getAttribute && n.getAttribute('data-testid')) || '',
        role: (n.getAttribute && n.getAttribute('role')) || '',
        href: (n.getAttribute && n.getAttribute('href')) || '',
        ariaLabel: (n.getAttribute && n.getAttribute('aria-label')) || '',
        text: ((n.textContent || '').replace(/\\s+/g, ' ').trim()).slice(0, 160),
        rectTop,
      });
    }
  }
  dump('[data-testid]');
  dump('[role="listitem"]');
  dump('main');
  dump('nav');
  dump('aside');
  dump('header');
  dump('a[href*="/a/chat/s/"]');
  if (anchors) dump('a[href]');
  return { ok: true, data: { url: location.href, title: document.title, returnedCount: out.length, items: out.slice(0, limit) } };
}`;

const XHR_LOG_FN_SRC = `function(args){
  args = args || {};
  const filterRaw = args.filter || 'deepseek\\\\.com';
  let filterRegex;
  try { filterRegex = new RegExp(filterRaw); } catch(_) { filterRegex = /deepseek\\.com/; }
  const limit = Math.min(Math.max(parseInt(args.limit) || 200, 1), 800);
  let entries = [];
  try { entries = performance.getEntriesByType('resource') || []; } catch(_) {}
  const matched = entries.filter((e) => e && e.name && filterRegex.test(e.name));
  const tail = matched.slice(-limit);
  const byPath = {};
  const items = tail.map((e) => {
    let pathname = e.name;
    let host = '';
    try { const u = new URL(e.name); pathname = u.pathname + (u.search || ''); host = u.hostname; } catch(_) {}
    byPath[pathname] = (byPath[pathname] || 0) + 1;
    return {
      pathname,
      host,
      initiatorType: e.initiatorType || '',
      durationMs: Math.round(e.duration || 0),
      transferSize: typeof e.transferSize === 'number' ? e.transferSize : null,
      startTime: Math.round(e.startTime || 0),
    };
  });
  const byBase = {};
  Object.keys(byPath).forEach((p) => {
    const base = p.split('?')[0];
    byBase[base] = (byBase[base] || 0) + byPath[p];
  });
  return { ok: true, data: { url: location.href, totalMatched: matched.length, returnedCount: items.length, byBase, items } };
}`;

async function runDomDump(opts) {
  const session = new Session({
    opts: Object.assign(buildSessionOpts('dom-dump', opts), {
      reuseAnyDeepseekTab: true,
      navigateOnReuse: false,
      createIfMissing: false,
    }),
  });
  try {
    await session.connect();
    await session.resolveTarget();
    const args = JSON.stringify({ limit: opts.limit ? Number(opts.limit) : 80, anchors: !!opts.anchors });
    const code = `Promise.resolve((${DOM_DUMP_FN_SRC})(${args})).then(r => JSON.stringify(r)).catch(e => JSON.stringify({ ok:false, error: String((e && e.message) || e) }))`;
    const result = await session.callRaw(code);
    printJson(result, opts);
    return result && result.ok === false ? 1 : 0;
  } finally {
    await session.close();
  }
}

async function runXhrLog(opts) {
  const session = new Session({
    opts: Object.assign(buildSessionOpts('xhr-log', opts), {
      reuseAnyDeepseekTab: true,
      navigateOnReuse: false,
      createIfMissing: false,
    }),
  });
  try {
    await session.connect();
    await session.resolveTarget();
    const args = JSON.stringify({ filter: opts.filter || null, limit: opts.limit ? Number(opts.limit) : 200 });
    const code = `Promise.resolve((${XHR_LOG_FN_SRC})(${args})).then(r => JSON.stringify(r)).catch(e => JSON.stringify({ ok:false, error: String((e && e.message) || e) }))`;
    const result = await session.callRaw(code);
    printJson(result, opts);
    return result && result.ok === false ? 1 : 0;
  } finally {
    await session.close();
  }
}

async function runNavigateCommand(commandName, def, opts, positional) {
  validateRequiredArgs(def, positional);
  const navArgs = def.toNavArgs ? def.toNavArgs(opts, positional) : {};
  const session = new Session({
    opts: Object.assign(buildSessionOpts(commandName, opts), {
      createIfMissing: true,
      navigateOnReuse: false,
      reuseAnyDeepseekTab: true,
      createUrl: 'https://chat.deepseek.com/',
    }),
  });
  try {
    await session.connect();
    await session.resolveTarget();
    await session.ensureBridge();
    const navResp = await session.callApi(def.api, [navArgs]);
    if (!navResp || !navResp.ok) {
      printJson({ ok: false, nav: navResp, postState: null }, opts);
      return 1;
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
    printJson({ ok: !!postState.ready, nav: navResp, postState }, opts);
    return postState.ready ? 0 : 1;
  } finally {
    await session.close();
  }
}

async function runDoctor(opts) {
  const targetPages = opts.page ? [opts.page] : Object.keys(PAGE_PROFILES);
  const results = [];
  for (const pageName of targetPages) {
    const section = { page: pageName };
    const session = new Session({
      opts: Object.assign(buildSessionOpts('doctor', opts), {
        page: pageName,
        createIfMissing: false,
        reuseAnyDeepseekTab: true,
      }),
    });
    try {
      await session.connect();
      section.connected = true;
      try {
        await session.resolveTarget();
        section.target = session.target;
      } catch (err) {
        section.targetError = { code: err.code || null, message: err.message };
        results.push(section);
        continue;
      }
      try {
        section.bridge = await session.ensureBridge();
      } catch (err) {
        section.bridgeError = { code: err.code || null, message: err.message, detail: err.detail || null };
        results.push(section);
        continue;
      }
      try { section.probe = await session.callApi('probe'); } catch (err) { section.probeError = { message: err.message }; }
      try { section.state = await session.callApi('state'); } catch (err) { section.stateError = { message: err.message }; }
    } catch (err) {
      section.connectError = { code: err.code || null, message: err.message };
    } finally {
      await session.close();
    }
    results.push(section);
  }
  const summary = results.map((r) => ({
    page: r.page,
    connected: !!r.connected,
    tab: r.target ? r.target.id : null,
    bridgeVersion: r.bridge ? r.bridge.version : null,
    loggedIn: r.probe && r.probe.ok && r.probe.data && r.probe.data.login ? !!r.probe.data.login.loggedIn : null,
    stateReady: r.state && r.state.ok && r.state.data ? !!r.state.data.ready : null,
    error: r.connectError || r.targetError || r.bridgeError || null,
  }));
  const ok = results.every((r) => !r.connectError && !r.targetError && !r.bridgeError);
  printJson({ ok, summary, results }, opts);
  return ok ? 0 : 1;
}

async function main(argv) {
  ensureSkillRecordsReadme();
  let parsed;
  try {
    parsed = parseArgv(argv);
  } catch (err) {
    process.stderr.write(`ERROR: ${err.message}\n`);
    return 2;
  }
  const { opts, positional } = parsed;
  const command = positional.shift();
  if (!command || opts.help) {
    printHelp();
    return command ? 0 : 0;
  }
  const def = COMMANDS[command];
  if (!def) {
    process.stderr.write(`未知命令: ${command}\n`);
    printHelp();
    return 2;
  }
  if (command === 'doctor') return runDoctor(opts);
  if (command === 'dom-dump') return runDomDump(opts);
  if (command === 'xhr-log') return runXhrLog(opts);
  if (command === 'export-session-local') return runExportSessionLocal(opts, positional);
  if (def.kind === 'call') return runCallCommand(command, def, opts, positional);
  if (def.kind === 'tool') return runToolCommand(command, def, opts, positional);
  if (def.kind === 'destructive') return runDestructiveCommand(command, def, opts, positional);
  if (def.kind === 'navigate') return runNavigateCommand(command, def, opts, positional);
  throw new Error(`command kind 不支持: ${def.kind}`);
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code || 0)).catch((err) => {
    process.stderr.write(`ERROR: ${err.message}\n`);
    if (process.env.JS_DEEPSEEK_DEBUG) process.stderr.write((err.stack || '') + '\n');
    process.exit(1);
  });
}

module.exports = {
  main,
  runDoctor,
  runDomDump,
  runXhrLog,
  runCallCommand,
  runToolCommand,
  runDestructiveCommand,
  runNavigateCommand,
  runExportSessionLocal,
  printHelp,
};
