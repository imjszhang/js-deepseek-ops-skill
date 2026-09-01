'use strict';

const crypto = require('crypto');
const pkg = require('../../package.json');
const { Session } = require('../session');
const { createRunContext } = require('../runContext');
const { appendHistory } = require('../history');
const { writeDebugBundle } = require('../debug');
const targets = require('../toolTargets');
const {
  resolveSkillDir,
  indexPath,
  readIndex,
  writeIndex,
  readSessionMeta,
  writeSessionMeta,
  writeSessionTree,
  treeExists,
  upsertIndexItemFromList,
  applyMessageSyncToIndex,
} = require('./store');
const { diffPage, shouldContinuePaging, markDisappeared, summarizeRemote } = require('./diffSessions');
const { mergeMeta, shouldSkipSessionSync, buildStoredTree } = require('./mergeMessages');
const { interpretHistory } = require('./interpretHistory');

const SKILL_ID = pkg.name;
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGES = 200;

function clampLimit(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function wrapToolResponse({ options, toolName, method, args, startedAt, payload, bridgeMeta, target }) {
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
  const durationMs = Date.now() - startedAt;
  const ok = !!(payload && payload.ok);
  let debugBundlePath = '';
  const response = {
    platform: 'deepseek',
    toolName,
    pageKey: 'home',
    method,
    timestamp: new Date().toISOString(),
    sourceUrl: (target && target.url) || targets.homeUrl(),
    destructive: false,
    sideEffect: null,
    ok,
    result: ok ? (payload.result == null ? null : payload.result) : null,
    error: ok ? null : (payload && payload.error) || { code: 'unknown' },
    run: {
      id: runContext.runId,
      durationMs,
      recordingMode: runContext.recording.mode,
      target: target || null,
    },
    bridge: bridgeMeta || null,
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
      steps: [{ stage: ok ? 'tool_called' : 'tool_failed', durationMs }],
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
    error_summary: ok ? '' : ((response.error && (response.error.code || response.error.message)) || ''),
  });
  return response;
}

async function openHomeSession(options) {
  const session = new Session({
    opts: {
      page: 'home',
      bot: options.bot,
      targetUrl: targets.homeUrl(),
      verbose: !!options.verbose,
      tab: options.tab != null ? options.tab : null,
      wsEndpoint: options.wsEndpoint || null,
      createIfMissing: options.createIfMissing !== false,
      navigateOnReuse: false,
      reuseAnyDeepseekTab: true,
      createUrl: 'https://chat.deepseek.com/',
    },
  });
  await session.connect();
  await session.resolveTarget();
  const bridgeMeta = await session.ensureBridge();
  return { session, bridgeMeta };
}

function failPayload(code, extra) {
  return { ok: false, error: Object.assign({ code }, extra || {}) };
}

async function runSyncSessions(options = {}) {
  const args = options.args || {};
  const startedAt = Date.now();
  const skillDir = resolveSkillDir(options);
  const full = !!args.full;
  const limit = clampLimit(args.limit, DEFAULT_PAGE_LIMIT, 100);
  let session = null;
  let bridgeMeta = null;
  let payload;
  try {
    const opened = await openHomeSession(options);
    session = opened.session;
    bridgeMeta = opened.bridgeMeta;
    const index = readIndex(skillDir);
    const created = [];
    const updated = [];
    let unchangedCount = 0;
    const seen = new Set();
    let pagesFetched = 0;
    let beforeSeqId = args.beforeSeqId != null ? String(args.beforeSeqId) : null;

    while (pagesFetched < MAX_PAGES) {
      const resp = await session.callApi('listSessions', [{ limit, beforeSeqId }], { timeoutMs: 60000 });
      if (!resp || !resp.ok) {
        payload = failPayload((resp && resp.error) || 'fetch_failed', { detail: resp || null });
        break;
      }
      const data = resp.data || {};
      const items = Array.isArray(data.items) ? data.items : [];
      pagesFetched += 1;
      const pageDiff = diffPage(items, index.items);
      for (const row of pageDiff.created) created.push(row);
      for (const row of pageDiff.updated) updated.push(row);
      unchangedCount += pageDiff.unchanged.length;
      for (const it of items) {
        if (it && it.id) {
          seen.add(it.id);
          upsertIndexItemFromList(index, it);
        }
      }
      const hasMore = !!data.hasMore;
      if (!shouldContinuePaging({ pageDiff, hasMore, full })) break;
      beforeSeqId = data.cursor && data.cursor.beforeSeqId != null ? String(data.cursor.beforeSeqId) : null;
      if (!beforeSeqId) break;
    }

    if (!payload) {
      const now = new Date().toISOString();
      if (full) {
        index.disappeared = markDisappeared(index.items, seen, now);
      }
      index.syncedAt = now;
      index.fullScan = full;
      writeIndex(skillDir, index);
      payload = {
        ok: true,
        result: {
          created,
          updated,
          unchangedCount,
          disappeared: Object.keys(index.disappeared || {}),
          pagesFetched,
          dirtySessionIds: created.concat(updated).map((row) => row.id),
          indexPath: indexPath(skillDir),
          syncedAt: now,
          fullScan: full,
        },
      };
    }
  } catch (err) {
    payload = failPayload('sync_failed', { message: err && err.message });
  } finally {
    if (session) {
      try { await session.close(); } catch {}
    }
  }
  return wrapToolResponse({
    options,
    toolName: 'deepseek_sync_sessions',
    method: 'syncSessions',
    args,
    startedAt,
    payload,
    bridgeMeta,
    target: session && session.target,
  });
}

function pickRemoteVersion(args, indexItem) {
  if (args.version != null) return args.version;
  if (indexItem && indexItem.listVersion != null) return indexItem.listVersion;
  return null;
}

function pickSyncedVersion(meta, indexItem) {
  if (meta && meta.version != null) return meta.version;
  if (indexItem && indexItem.syncedVersion != null) return indexItem.syncedVersion;
  return null;
}

async function runSyncSession(options = {}) {
  const args = options.args || {};
  const startedAt = Date.now();
  const skillDir = resolveSkillDir(options);
  const sid = args.sessionId;
  const force = !!args.force;
  const storeTree = !!args.storeTree;
  let session = null;
  let bridgeMeta = null;
  let payload;
  try {
    if (!sid) {
      payload = failPayload('missing_session_id');
    } else {
      const opened = await openHomeSession(options);
      session = opened.session;
      bridgeMeta = opened.bridgeMeta;
      const index = readIndex(skillDir);
      const indexItem = index.items[sid] || null;
      const meta = readSessionMeta(skillDir, sid);
      const pending = !!(meta && meta.pending) || !!(indexItem && indexItem.pending);
      const remoteVersion = pickRemoteVersion(args, indexItem);
      const syncedVersion = pickSyncedVersion(meta, indexItem);
      const needTree = storeTree && !treeExists(skillDir, sid);
      const skip = shouldSkipSessionSync({
        force: force || needTree,
        pending,
        remoteVersion,
        syncedVersion,
      });

      if (skip) {
        const now = new Date().toISOString();
        applyMessageSyncToIndex(index, sid, {
          session: { version: remoteVersion, currentMessageId: indexItem && indexItem.currentMessageId },
          pending: false,
          lastSync: 'skipped',
          messageCount: meta && meta.messageCount != null ? meta.messageCount : (indexItem && indexItem.messageCount),
          hasTree: treeExists(skillDir, sid),
          cacheResetAt: (meta && meta.cacheResetAt) || (indexItem && indexItem.cacheResetAt),
          now,
        });
        index.syncedAt = now;
        writeIndex(skillDir, index);
        payload = {
          ok: true,
          result: {
            sessionId: sid,
            sync: 'skipped',
            pending: false,
            version: remoteVersion,
            messageCount: (meta && meta.messageCount) || 0,
            hasTree: treeExists(skillDir, sid),
            indexPath: indexPath(skillDir),
          },
        };
      } else {
        const localReset = (meta && meta.cacheResetAt) || (indexItem && indexItem.cacheResetAt) || null;
        const sentCacheParams = syncedVersion != null || localReset != null;
        const fetchArgs = {
          sessionId: sid,
          includeContent: storeTree,
          cacheVersion: sentCacheParams && syncedVersion != null ? syncedVersion : undefined,
          cacheResetAt: sentCacheParams && localReset != null ? localReset : undefined,
        };
        const resp = await session.callApi('getSessionForSync', [fetchArgs], { timeoutMs: 90000 });
        if (!resp || !resp.ok) {
          payload = failPayload((resp && resp.error) || 'fetch_failed', { detail: resp || null, sessionId: sid });
        } else {
          const data = resp.data || {};
          const remoteSession = data.session || { id: sid };
          const messages = Array.isArray(data.messages) ? data.messages : [];
          const cacheResetAt = data.cacheResetAt != null ? data.cacheResetAt : null;
          const decision = interpretHistory({
            httpStatus: data.httpStatus,
            ok: true,
            notModified: !!data.notModified,
            bizFlags: data.bizFlags || {},
            cacheResetAt,
            local: { cacheResetAt: localReset },
            sentCacheParams,
          });

          if (decision.kind === 'error') {
            payload = failPayload('fetch_failed', { reason: decision.reason, sessionId: sid });
          } else if (decision.kind === 'not_modified') {
            const now = new Date().toISOString();
            const nextMeta = meta || {
              sessionId: sid,
              version: remoteVersion,
              cacheResetAt: localReset,
              currentMessageId: remoteSession.currentMessageId || null,
              pending: false,
              messageCount: 0,
              messages: {},
              mergedAt: now,
            };
            if (!meta) writeSessionMeta(skillDir, sid, nextMeta);
            applyMessageSyncToIndex(index, sid, {
              session: remoteSession.version != null ? remoteSession : { id: sid, version: remoteVersion },
              pending: false,
              lastSync: 'not_modified',
              messageCount: nextMeta.messageCount,
              hasTree: treeExists(skillDir, sid),
              cacheResetAt: nextMeta.cacheResetAt,
              now,
            });
            index.syncedAt = now;
            writeIndex(skillDir, index);
            payload = {
              ok: true,
              result: {
                sessionId: sid,
                sync: 'not_modified',
                pending: false,
                version: pickSyncedVersion(nextMeta, index.items[sid]),
                messageCount: nextMeta.messageCount,
                hasTree: treeExists(skillDir, sid),
                interpret: decision,
                indexPath: indexPath(skillDir),
              },
            };
          } else {
            const merged = mergeMeta({
              localMeta: meta,
              remoteMessages: messages,
              remoteSession,
              cacheResetAt,
              previousCacheResetAt: localReset,
            });
            writeSessionMeta(skillDir, sid, merged.meta);
            let hasTree = treeExists(skillDir, sid);
            if (storeTree) {
              writeSessionTree(skillDir, sid, buildStoredTree(remoteSession, messages));
              hasTree = true;
            }
            const now = new Date().toISOString();
            const lastSync = merged.reset ? 'full' : 'merged';
            applyMessageSyncToIndex(index, sid, {
              session: remoteSession,
              pending: merged.pending,
              lastSync: merged.pending ? 'pending' : lastSync,
              messageCount: merged.meta.messageCount,
              hasTree,
              cacheResetAt: merged.meta.cacheResetAt,
              now,
            });
            index.syncedAt = now;
            writeIndex(skillDir, index);
            payload = {
              ok: true,
              result: {
                sessionId: sid,
                sync: merged.pending ? 'pending' : lastSync,
                pending: merged.pending,
                version: merged.meta.version,
                messageCount: merged.meta.messageCount,
                inserted: merged.inserted,
                updated: merged.updated,
                removed: merged.removed,
                reset: merged.reset,
                hasTree,
                interpret: decision,
                indexPath: indexPath(skillDir),
                session: summarizeRemote(remoteSession),
              },
            };
          }
        }
      }
    }
  } catch (err) {
    payload = failPayload('sync_failed', { message: err && err.message, sessionId: sid || null });
  } finally {
    if (session) {
      try { await session.close(); } catch {}
    }
  }
  return wrapToolResponse({
    options,
    toolName: 'deepseek_sync_session',
    method: 'syncSession',
    args,
    startedAt,
    payload,
    bridgeMeta,
    target: session && session.target,
  });
}

module.exports = {
  runSyncSessions,
  runSyncSession,
  clampLimit,
};
