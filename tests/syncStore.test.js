'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  resolveSkillDir,
  indexPath,
  sessionTreePath,
  emptyIndex,
  readIndex,
  writeIndex,
  writeSessionMeta,
  readSessionMeta,
  writeSessionTree,
  treeExists,
  upsertIndexItemFromList,
  applyMessageSyncToIndex,
  digestTitle,
} = require('../lib/sync/store');

function mode(p) {
  return fs.statSync(p).mode & 0o777;
}

test('digestTitle 只存 length+sha256', () => {
  const d = digestTitle('你好');
  assert.equal(d.length, 2);
  assert.equal(typeof d.sha256, 'string');
  assert.equal(d.sha256.length, 64);
});

test('store 写入 index/meta 用 0700/0600，默认不写 tree.json', () => {
  const skillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-sync-'));
  try {
    const index = emptyIndex();
    upsertIndexItemFromList(index, {
      id: 'sid-1', version: 3, updatedAt: '2026-01-01T00:00:00.000Z', pinned: false, title: '秘密标题',
    });
    writeIndex(skillDir, index);
    writeSessionMeta(skillDir, 'sid-1', { sessionId: 'sid-1', version: 3, messages: {} });
    assert.equal(treeExists(skillDir, 'sid-1'), false);
    assert.ok(!fs.existsSync(sessionTreePath(skillDir, 'sid-1')));
    const disk = JSON.parse(fs.readFileSync(indexPath(skillDir), 'utf8'));
    assert.equal(disk.items['sid-1'].listVersion, 3);
    assert.equal(disk.items['sid-1'].title.length, 4);
    assert.ok(disk.items['sid-1'].title.sha256);
    assert.equal(typeof disk.items['sid-1'].title, 'object');
    if (process.platform !== 'win32') {
      assert.equal(mode(path.join(skillDir, 'sync')), 0o700);
      assert.equal(mode(indexPath(skillDir)), 0o600);
      assert.equal(mode(path.join(skillDir, 'sync', 'sessions', 'sid-1', 'meta.json')), 0o600);
      assert.ok(fs.existsSync(path.join(skillDir, 'sync', 'sessions', 'sid-1', 'meta.json')));
    }
  } finally {
    fs.rmSync(skillDir, { recursive: true, force: true });
  }
});

test('storeTree 才写 tree.json', () => {
  const skillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-sync-tree-'));
  try {
    writeSessionTree(skillDir, 'abc', { session: { id: 'abc' }, messages: [{ content: '正文' }] });
    assert.equal(treeExists(skillDir, 'abc'), true);
    if (process.platform !== 'win32') {
      assert.equal(mode(sessionTreePath(skillDir, 'abc')), 0o600);
    }
  } finally {
    fs.rmSync(skillDir, { recursive: true, force: true });
  }
});

test('upsert 更新 listVersion 但不抬 syncedVersion；applyMessageSync 才抬', () => {
  const index = emptyIndex();
  upsertIndexItemFromList(index, { id: 's', version: 10, updatedAt: 't1', pinned: false, title: 'a' });
  assert.equal(index.items.s.listVersion, 10);
  assert.equal(index.items.s.syncedVersion, null);
  applyMessageSyncToIndex(index, 's', {
    session: { id: 's', version: 10 },
    pending: false,
    lastSync: 'merged',
    messageCount: 4,
    hasTree: false,
    now: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(index.items.s.syncedVersion, 10);
  assert.equal(index.items.s.lastSync, 'merged');
});

test('pending 不抬 syncedVersion', () => {
  const index = emptyIndex();
  index.items.s = { listVersion: 11, syncedVersion: 8, pending: false };
  applyMessageSyncToIndex(index, 's', {
    session: { id: 's', version: 11 },
    pending: true,
    lastSync: 'pending',
    messageCount: 5,
    now: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(index.items.s.syncedVersion, 8);
  assert.equal(index.items.s.pending, true);
});

test('resolveSkillDir 优先显式 skillDir', () => {
  assert.equal(resolveSkillDir({ skillDir: '/tmp/explicit-root' }), path.resolve('/tmp/explicit-root'));
});

test('readIndex 缺文件返回空骨架', () => {
  const skillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-sync-empty-'));
  try {
    const idx = readIndex(skillDir);
    assert.equal(idx.schemaVersion, 1);
    assert.deepEqual(idx.items, {});
  } finally {
    fs.rmSync(skillDir, { recursive: true, force: true });
  }
});

test('readSessionMeta 往返', () => {
  const skillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-sync-meta-'));
  try {
    writeSessionMeta(skillDir, 'sid', { sessionId: 'sid', version: 2, messages: { 1: { messageId: 1 } } });
    const meta = readSessionMeta(skillDir, 'sid');
    assert.equal(meta.version, 2);
    assert.equal(meta.messages['1'].messageId, 1);
  } finally {
    fs.rmSync(skillDir, { recursive: true, force: true });
  }
});
