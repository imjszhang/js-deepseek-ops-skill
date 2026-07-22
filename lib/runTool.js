'use strict';

const crypto = require('crypto');
const pkg = require('../package.json');
const { Session } = require('./session');
const { createRunContext } = require('./runContext');
const { appendHistory } = require('./history');
const { writeDebugBundle } = require('./debug');
const { writeAuditEntry, writeBackup } = require('./audit');

const SKILL_ID = pkg.name;

/**
 * runTool - 通用工具调度器（READ + DESTRUCTIVE 共用骨架）
 *
 *   - 不做 cache：DeepSeek 数据私密度高，全程不启用 cache
 *   - history.jsonl 记一行（status / duration），不写 result
 *   - --debug-recording 时写 debug bundle
 *
 *   READ 分支：
 *     - 走 transformResult 把私聊正文换 sha256 摘要再返回 / 写 debug bundle
 *
 *   DESTRUCTIVE 分支（spec.destructive === true）：
 *     - sideEffect === 'irreversible' 时必须先成功写入 backup，否则终止调用
 *     - 调用后强制 writeAuditEntry；敏感字段只保存长度与 sha256
 */
async function runTool(browser, spec) {
  const {
    toolName,
    pageKey,
    method,
    args = {},
    targetUrl = null,
    options = {},
    destructive = false,
    sideEffect = 'reversible',
    prefetchBackup = null,
  } = spec || {};

  if (!toolName || !pageKey || !method) {
    throw new Error('runTool: toolName/pageKey/method are required');
  }

  const argsDigest = crypto.createHash('sha256')
    .update(JSON.stringify(args || {}), 'utf8')
    .digest('hex');
  const fakeUrl = `deepseek-tool://${toolName}/?args_sha256=${argsDigest}`;
  const runContext = createRunContext({
    skillId: SKILL_ID,
    scrapeType: toolName,
    skillVersion: pkg.version,
    url: fakeUrl,
    runId: options.runId,
    recording: options.recording,
    recordingMode: options.recordingMode,
    debugRecording: options.debugRecording,
    noCache: true,
  });

  const startedAt = Date.now();
  let response = null;
  let debugBundlePath = '';
  let bridgeMeta = null;
  let target = null;
  let resp = null;
  let backupPath = '';

  const session = new Session({
    opts: {
      page: pageKey,
      bot: browser,
      targetUrl: targetUrl || null,
      verbose: !!options.verbose,
      tab: options.tab != null ? options.tab : null,
      wsEndpoint: options.wsEndpoint || null,
      createIfMissing: options.createIfMissing !== false,
      navigateOnReuse: options.navigateOnReuse === true,
      reuseAnyDeepseekTab: options.reuseAnyDeepseekTab !== false,
      createUrl: options.createUrl || 'https://chat.deepseek.com/',
    },
  });

  try {
    await session.connect();
    await session.resolveTarget();
    target = session.target;
    bridgeMeta = await session.ensureBridge();

    // DESTRUCTIVE + irreversible：备份是执行写操作的硬前置条件。
    if (destructive && sideEffect === 'irreversible') {
      if (typeof prefetchBackup !== 'function') {
        const error = new Error(`Irreversible tool ${toolName} has no prefetchBackup`);
        error.code = 'E_BACKUP_REQUIRED';
        throw error;
      }
      try {
        const snapshot = await prefetchBackup(session, args || {});
        if (!snapshot || !snapshot.resource || !snapshot.id) {
          throw new Error('prefetchBackup returned an invalid snapshot');
        }
        backupPath = writeBackup(runContext, snapshot);
        if (!backupPath) throw new Error('backup could not be persisted');
      } catch (e) {
        const error = new Error(`Backup failed; irreversible operation was not executed: ${e && e.message}`);
        error.code = 'E_BACKUP_FAILED';
        error.cause = e;
        throw error;
      }
    }

    resp = await session.callApi(method, [args || {}], {
      timeoutMs: options.timeoutMs || 90000,
    });
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    if (runContext.recording.debugEnabled) {
      debugBundlePath = writeDebugBundle(runContext, {
        meta: {
          runId: runContext.runId,
          skillId: runContext.skillId,
          scrapeType: toolName,
          sourceUrl: fakeUrl,
          args,
          target,
          bridge: bridgeMeta,
          destructive,
          sideEffect,
          error: error.message,
        },
        steps: [{ stage: 'tool_failed', durationMs, error: error.message }],
        result: { error: error.message },
      }) || '';
    }
    appendHistory(runContext, {
      run_id: runContext.runId,
      skill_id: runContext.skillId,
      tool_name: toolName,
      timestamp: new Date().toISOString(),
      input_url: fakeUrl,
      normalized_url: runContext.normalizedUrl,
      status: 'failed',
      duration_ms: durationMs,
      cache_hit: false,
      cache_key: runContext.cacheKey,
      debug_bundle_path: debugBundlePath,
      error_summary: error.message,
    });
    if (destructive) {
      writeAuditEntry(runContext, {
        tool: toolName,
        method,
        sideEffect,
        args,
        result: { ok: false, error: 'tool_threw', message: error.message },
        backupPath,
        targetUrl,
        bridge: bridgeMeta,
      });
    }
    throw error;
  } finally {
    await session.close();
  }

  const durationMs = Date.now() - startedAt;
  const ok = !!(resp && resp.ok);
  let resultData = ok ? (resp.data == null ? null : resp.data) : null;

  // DESTRUCTIVE 的业务返回保持原语义；audit 层会单独清理敏感字段。
  if (!destructive && ok && typeof options.transformResult === 'function') {
    try {
      resultData = options.transformResult(resultData, {
        toolName,
        pageKey,
        method,
        args,
        debugRecording: runContext.recording.debugEnabled,
      });
    } catch (err) {
      process.stderr.write(`[deepseek-runTool] transformResult threw: ${err && err.message}\n`);
    }
  }

  response = {
    platform: 'deepseek',
    toolName,
    pageKey,
    method,
    timestamp: new Date().toISOString(),
    sourceUrl: target && target.url ? target.url : (targetUrl || null),
    destructive: !!destructive,
    sideEffect: destructive ? sideEffect : null,
    backupPath: destructive && backupPath ? backupPath : null,
    run: {
      id: runContext.runId,
      durationMs,
      recordingMode: runContext.recording.mode,
      target,
    },
    bridge: bridgeMeta,
    ok,
    result: resultData,
    error: ok ? null : {
      code: (resp && resp.error) || 'unknown',
      message: (resp && resp.message) || null,
      detail: resp || null,
    },
  };

  if (runContext.recording.debugEnabled) {
    debugBundlePath = writeDebugBundle(runContext, {
      meta: {
        runId: runContext.runId,
        skillId: runContext.skillId,
        scrapeType: toolName,
        sourceUrl: fakeUrl,
        args,
        target,
        bridge: bridgeMeta,
        destructive,
        sideEffect: destructive ? sideEffect : null,
        backupPath: backupPath || null,
      },
      steps: [{ stage: 'tool_called', durationMs, bridge: bridgeMeta, target }],
      result: response,
    }) || '';
    response.debug = { bundlePath: debugBundlePath };
  }

  appendHistory(runContext, {
    run_id: runContext.runId,
    skill_id: runContext.skillId,
    tool_name: toolName,
    timestamp: new Date().toISOString(),
    input_url: fakeUrl,
    normalized_url: runContext.normalizedUrl,
    status: ok ? 'success' : 'failed',
    duration_ms: durationMs,
    cache_hit: false,
    cache_key: runContext.cacheKey,
    debug_bundle_path: debugBundlePath,
    error_summary: ok ? '' : ((response.error && response.error.code) || ''),
  });

  // DESTRUCTIVE：强制 audit；writeAuditEntry 会清理敏感字段。
  if (destructive) {
    writeAuditEntry(runContext, {
      tool: toolName,
      method,
      sideEffect,
      args,
      result: resp,
      backupPath,
      targetUrl: target && target.url ? target.url : (targetUrl || null),
      bridge: bridgeMeta,
    });
  }

  return response;
}

module.exports = { runTool };
