'use strict';

const PENDING_STATUSES = new Set(['STREAMING', 'WIP', 'PENDING']);

function isPendingStatus(status) {
  return PENDING_STATUSES.has(String(status || '').toUpperCase());
}

function hasPendingMessages(messages) {
  return (messages || []).some((m) => isPendingStatus(m && m.status));
}

function shouldSkipSessionSync({ force, pending, remoteVersion, syncedVersion }) {
  if (force) return false;
  if (pending) return false;
  if (remoteVersion == null || syncedVersion == null) return false;
  return Number(syncedVersion) === Number(remoteVersion);
}

function toMetaRow(m) {
  return {
    messageId: m.messageId,
    role: m.role || '',
    status: m.status || '',
    parentId: m.parentId == null ? null : m.parentId,
    model: m.model || '',
    insertedAt: m.insertedAt || null,
    contentHash: m.contentHash || null,
    contentLength: typeof m.contentLength === 'number' ? m.contentLength : 0,
    thinkingHash: m.thinkingHash || null,
    thinkingLength: typeof m.thinkingLength === 'number' ? m.thinkingLength : 0,
    feedback: m.feedback == null ? null : m.feedback,
  };
}

function rowsEqual(a, b) {
  if (!a || !b) return false;
  return a.contentHash === b.contentHash
    && a.thinkingHash === b.thinkingHash
    && a.status === b.status
    && JSON.stringify(a.feedback) === JSON.stringify(b.feedback);
}

/**
 * 按 messageId 合并 meta。
 * 仅当 cacheResetAt 变化时删除「本地有、远端无」的 id。
 * pending 时仍写入最新 hash，但不抬 version 水位（由调用方读 pending 后决定）。
 */
function mergeMeta({ localMeta, remoteMessages, remoteSession, cacheResetAt, previousCacheResetAt }) {
  const pending = hasPendingMessages(remoteMessages);
  const prevReset = previousCacheResetAt != null ? Number(previousCacheResetAt) : null;
  const nextReset = cacheResetAt != null ? Number(cacheResetAt) : null;
  const reset = prevReset != null && nextReset != null && prevReset !== nextReset;
  const prevMessages = (localMeta && localMeta.messages && typeof localMeta.messages === 'object')
    ? localMeta.messages
    : {};
  const nextMessages = reset ? {} : { ...prevMessages };
  const remoteIds = new Set();
  let inserted = 0;
  let updated = 0;

  for (const m of remoteMessages || []) {
    if (!m || m.messageId == null) continue;
    const key = String(m.messageId);
    remoteIds.add(key);
    const row = toMetaRow(m);
    const prev = nextMessages[key];
    if (!prev) {
      nextMessages[key] = row;
      inserted += 1;
    } else if (!rowsEqual(prev, row)) {
      nextMessages[key] = row;
      updated += 1;
    }
  }

  let removed = 0;
  if (reset) {
    removed = Object.keys(prevMessages).filter((k) => !remoteIds.has(k)).length;
  }

  const remoteVersion = remoteSession && remoteSession.version != null ? remoteSession.version : null;
  const keptVersion = localMeta && localMeta.version != null ? localMeta.version : null;

  const meta = {
    sessionId: remoteSession && remoteSession.id ? remoteSession.id : (localMeta && localMeta.sessionId) || null,
    version: pending ? keptVersion : remoteVersion,
    cacheResetAt: nextReset != null ? nextReset : (localMeta && localMeta.cacheResetAt) || null,
    currentMessageId: remoteSession && remoteSession.currentMessageId != null
      ? remoteSession.currentMessageId
      : (localMeta && localMeta.currentMessageId) || null,
    pending,
    messageCount: Object.keys(nextMessages).length,
    messages: nextMessages,
    mergedAt: new Date().toISOString(),
  };

  return { meta, pending, reset, inserted, updated, removed };
}

function buildStoredTree(session, messages) {
  return {
    session: session || null,
    messages: (messages || []).map((m) => ({
      messageId: m.messageId,
      parentId: m.parentId == null ? null : m.parentId,
      role: m.role || '',
      status: m.status || '',
      model: m.model || '',
      insertedAt: m.insertedAt || null,
      content: m.content == null ? '' : m.content,
      thinkingContent: m.thinkingContent == null ? null : m.thinkingContent,
      contentHash: m.contentHash || null,
      contentLength: typeof m.contentLength === 'number' ? m.contentLength : 0,
      thinkingHash: m.thinkingHash || null,
      thinkingLength: typeof m.thinkingLength === 'number' ? m.thinkingLength : 0,
    })),
    storedAt: new Date().toISOString(),
  };
}

module.exports = {
  PENDING_STATUSES,
  isPendingStatus,
  hasPendingMessages,
  shouldSkipSessionSync,
  toMetaRow,
  mergeMeta,
  buildStoredTree,
};
