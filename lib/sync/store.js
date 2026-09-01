'use strict';

/**
 * 本地增量同步存储（{skillDir}/sync/）。
 * 不走 @js-eyes/skill-recording 的 cache API。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chmodBestEffort, getSkillRecordPaths } = require('@js-eyes/runtime-paths');

const SKILL_ID = 'js-deepseek-ops-skill';
const SCHEMA_VERSION = 1;

function resolveSkillDir(options = {}) {
  if (options.skillDir) return path.resolve(options.skillDir);
  if (options.recording && options.recording.baseDir) {
    return getSkillRecordPaths(SKILL_ID, { recordingBaseDir: options.recording.baseDir }).skillDir;
  }
  return getSkillRecordPaths(SKILL_ID).skillDir;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodBestEffort(dir, 0o700);
}

function writePrivateJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  const body = JSON.stringify(value, null, 2);
  const fd = fs.openSync(filePath, 'w', 0o600);
  try {
    fs.writeSync(fd, body, null, 'utf8');
    try { fs.fchmodSync(fd, 0o600); } catch {}
  } finally {
    fs.closeSync(fd);
  }
  chmodBestEffort(filePath, 0o600);
  return filePath;
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function syncDir(skillDir) {
  return path.join(skillDir, 'sync');
}

function indexPath(skillDir) {
  return path.join(syncDir(skillDir), 'index.json');
}

function safeSid(sid) {
  return String(sid || '').replace(/[^0-9a-zA-Z._-]/g, '_').slice(0, 80);
}

function sessionDir(skillDir, sessionId) {
  return path.join(syncDir(skillDir), 'sessions', safeSid(sessionId));
}

function sessionMetaPath(skillDir, sessionId) {
  return path.join(sessionDir(skillDir, sessionId), 'meta.json');
}

function sessionTreePath(skillDir, sessionId) {
  return path.join(sessionDir(skillDir, sessionId), 'tree.json');
}

function digestTitle(title) {
  const text = typeof title === 'string' ? title : '';
  return {
    length: text.length,
    sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
  };
}

function emptyIndex() {
  return {
    schemaVersion: SCHEMA_VERSION,
    syncedAt: null,
    fullScan: false,
    items: {},
    disappeared: {},
  };
}

function readIndex(skillDir) {
  const data = readJson(indexPath(skillDir), null);
  if (!data || typeof data !== 'object' || !data.items || typeof data.items !== 'object') {
    return emptyIndex();
  }
  if (!data.disappeared || typeof data.disappeared !== 'object') data.disappeared = {};
  return data;
}

function writeIndex(skillDir, index) {
  const next = {
    schemaVersion: SCHEMA_VERSION,
    syncedAt: index.syncedAt || new Date().toISOString(),
    fullScan: !!index.fullScan,
    items: index.items || {},
    disappeared: index.disappeared || {},
  };
  writePrivateJson(indexPath(skillDir), next);
  return next;
}

function readSessionMeta(skillDir, sessionId) {
  return readJson(sessionMetaPath(skillDir, sessionId), null);
}

function writeSessionMeta(skillDir, sessionId, meta) {
  return writePrivateJson(sessionMetaPath(skillDir, sessionId), meta);
}

function writeSessionTree(skillDir, sessionId, tree) {
  return writePrivateJson(sessionTreePath(skillDir, sessionId), tree);
}

function treeExists(skillDir, sessionId) {
  return fs.existsSync(sessionTreePath(skillDir, sessionId));
}

function upsertIndexItemFromList(index, remote) {
  const id = remote && remote.id;
  if (!id) return null;
  const prev = index.items[id] || {};
  const rec = {
    seqId: remote.seqId != null ? remote.seqId : prev.seqId,
    listVersion: remote.version != null ? remote.version : prev.listVersion,
    listUpdatedAt: remote.updatedAt || null,
    pinned: !!remote.pinned,
    currentMessageId: remote.currentMessageId != null ? remote.currentMessageId : (prev.currentMessageId != null ? prev.currentMessageId : null),
    title: digestTitle(remote.title),
    syncedVersion: prev.syncedVersion != null ? prev.syncedVersion : null,
    cacheResetAt: prev.cacheResetAt != null ? prev.cacheResetAt : null,
    pending: !!prev.pending,
    lastSync: prev.lastSync || 'listed',
    messageCount: prev.messageCount != null ? prev.messageCount : 0,
    hasTree: !!prev.hasTree,
    lastSyncAt: prev.lastSyncAt || null,
  };
  index.items[id] = rec;
  if (index.disappeared && index.disappeared[id]) delete index.disappeared[id];
  return rec;
}

function applyMessageSyncToIndex(index, sid, patch) {
  const prev = index.items[sid] || {};
  const remoteVersion = patch.session && patch.session.version != null
    ? patch.session.version
    : (prev.listVersion != null ? prev.listVersion : null);
  const pending = !!patch.pending;
  index.items[sid] = {
    ...prev,
    seqId: patch.session && patch.session.seqId != null ? patch.session.seqId : prev.seqId,
    listVersion: remoteVersion,
    listUpdatedAt: (patch.session && patch.session.updatedAt) || prev.listUpdatedAt || null,
    pinned: patch.session && patch.session.pinned != null ? !!patch.session.pinned : !!prev.pinned,
    currentMessageId: patch.session && patch.session.currentMessageId != null
      ? patch.session.currentMessageId
      : prev.currentMessageId,
    syncedVersion: pending
      ? (prev.syncedVersion != null ? prev.syncedVersion : null)
      : remoteVersion,
    cacheResetAt: patch.cacheResetAt != null ? patch.cacheResetAt : prev.cacheResetAt,
    pending,
    lastSync: patch.lastSync || prev.lastSync || 'listed',
    messageCount: patch.messageCount != null ? patch.messageCount : prev.messageCount,
    hasTree: patch.hasTree != null ? !!patch.hasTree : !!prev.hasTree,
    lastSyncAt: patch.now || new Date().toISOString(),
  };
  return index.items[sid];
}

module.exports = {
  SKILL_ID,
  SCHEMA_VERSION,
  resolveSkillDir,
  ensureDir,
  writePrivateJson,
  syncDir,
  indexPath,
  sessionDir,
  sessionMetaPath,
  sessionTreePath,
  digestTitle,
  emptyIndex,
  readIndex,
  writeIndex,
  readSessionMeta,
  writeSessionMeta,
  writeSessionTree,
  treeExists,
  upsertIndexItemFromList,
  applyMessageSyncToIndex,
};
