'use strict';

/**
 * 会话列表脏检测与停页（纯函数）。
 *
 * 比较远端 fetch_page 项与本地 index 的 listVersion / listUpdatedAt / pinned。
 * 不比较 title 明文（磁盘只存 hash）；标题变更通常会带 updatedAt/version。
 */

function classifyRemoteItem(remote, localItem) {
  if (!remote || !remote.id) return null;
  if (!localItem) return 'created';
  const localVersion = localItem.listVersion != null ? localItem.listVersion : localItem.version;
  const localUpdated = localItem.listUpdatedAt != null ? localItem.listUpdatedAt : (localItem.updatedAt || null);
  if (
    localVersion !== remote.version
    || (localUpdated || null) !== (remote.updatedAt || null)
    || !!localItem.pinned !== !!remote.pinned
  ) {
    return 'updated';
  }
  return 'unchanged';
}

function summarizeRemote(remote) {
  return {
    id: remote.id,
    version: remote.version != null ? remote.version : null,
    updatedAt: remote.updatedAt || null,
    pinned: !!remote.pinned,
    title: typeof remote.title === 'string' ? remote.title : '',
    currentMessageId: remote.currentMessageId != null ? remote.currentMessageId : null,
    seqId: remote.seqId != null ? remote.seqId : null,
  };
}

function diffPage(remoteItems, indexItems) {
  const created = [];
  const updated = [];
  const unchanged = [];
  const dirty = [];
  for (const remote of remoteItems || []) {
    const kind = classifyRemoteItem(remote, indexItems && remote && remote.id ? indexItems[remote.id] : null);
    if (!kind) continue;
    const row = summarizeRemote(remote);
    if (kind === 'created') {
      created.push(row);
      dirty.push(row);
    } else if (kind === 'updated') {
      updated.push(row);
      dirty.push(row);
    } else {
      unchanged.push(row);
    }
  }
  return { created, updated, unchanged, dirty };
}

/**
 * 默认增量：整页都 unchanged 则停（即便 hasMore）。
 * --full：有下一页就继续。
 * 置顶占页头时，只要本页仍有 dirty 就必须继续，不能只看第一条 seqId。
 */
function shouldContinuePaging({ pageDiff, hasMore, full }) {
  if (!hasMore) return false;
  if (full) return true;
  return !!(pageDiff && pageDiff.dirty && pageDiff.dirty.length > 0);
}

function markDisappeared(indexItems, seenIds, nowIso) {
  const disappeared = {};
  for (const id of Object.keys(indexItems || {})) {
    if (seenIds.has(id)) continue;
    const prev = indexItems[id] || {};
    disappeared[id] = {
      lastSeenAt: prev.lastSyncAt || null,
      markedAt: nowIso,
    };
  }
  return disappeared;
}

module.exports = {
  classifyRemoteItem,
  summarizeRemote,
  diffPage,
  shouldContinuePaging,
  markDisappeared,
};
