'use strict';

const pkg = require('../package.json');
const { Session } = require('./session');
const { createRunContext } = require('./runContext');
const { appendHistory } = require('./history');
const { writeDebugBundle } = require('./debug');

const SKILL_ID = pkg.name;

/**
 * runTool - 通用 READ 工具调度器（不含 cache，仅 history + debug bundle）
 *
 *   - 不做 cache（每次都打实际请求）；DeepSeek 数据私密度高，本 skill 全程不
 *     启用 cache，避免私聊正文落盘到 cache 文件。
 *   - history 记一行 jsonl，input_url=`deepseek-tool://<tool>/?args=<json>` 占位；
 *   - --debug-recording 时写 debug bundle；
 *   - 失败也走 history（status=failed），方便回查。
 *
 *   transformResult(result, ctx) 在写 debug bundle 与构造对外响应之前对 bridge
 *   原始 result 做一次转换，专门用于在 lib/redact.js 里把 chat 正文转换为
 *   `{length, sha256}` 摘要，避免私聊正文进入 debug bundle 与最终返回。
 *
 * @returns {Promise<{ok:boolean, ...}>}
 */
async function runTool(browser, spec) {
  const {
    toolName,
    pageKey,
    method,
    args = {},
    targetUrl = null,
    options = {},
  } = spec || {};

  if (!toolName || !pageKey || !method) {
    throw new Error('runTool: toolName/pageKey/method are required');
  }

  const fakeUrl = `deepseek-tool://${toolName}/?args=${encodeURIComponent(JSON.stringify(args || {}))}`;
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
    throw error;
  } finally {
    await session.close();
  }

  const durationMs = Date.now() - startedAt;
  const ok = !!(resp && resp.ok);
  let resultData = ok ? (resp.data == null ? null : resp.data) : null;
  if (ok && typeof options.transformResult === 'function') {
    try {
      resultData = options.transformResult(resultData, {
        toolName,
        pageKey,
        method,
        args,
        debugRecording: runContext.recording.debugEnabled,
      });
    } catch (err) {
      // transformResult 抛错不能阻断主流程，但记入 stderr 以便排查
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

  return response;
}

module.exports = { runTool };
