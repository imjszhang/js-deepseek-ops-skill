'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyRemoteItem, diffPage, shouldContinuePaging, markDisappeared } = require('../lib/sync/diffSessions');
const { parseArgv } = require('../lib/commands');

test('classify：无本地 = created；version/updatedAt/pinned 变 = updated', () => {
  const remote = { id: 'a', version: 2, updatedAt: 't2', pinned: false, title: 'x' };
  assert.equal(classifyRemoteItem(remote, null), 'created');
  assert.equal(classifyRemoteItem(remote, { listVersion: 2, listUpdatedAt: 't2', pinned: false }), 'unchanged');
  assert.equal(classifyRemoteItem(remote, { listVersion: 1, listUpdatedAt: 't2', pinned: false }), 'updated');
  assert.equal(classifyRemoteItem(remote, { listVersion: 2, listUpdatedAt: 't1', pinned: false }), 'updated');
  assert.equal(classifyRemoteItem(remote, { listVersion: 2, listUpdatedAt: 't2', pinned: true }), 'updated');
});

test('diffPage 拆 created/updated/unchanged', () => {
  const indexItems = {
    old: { listVersion: 1, listUpdatedAt: 't1', pinned: false },
    same: { listVersion: 5, listUpdatedAt: 't5', pinned: true },
  };
  const page = [
    { id: 'new', version: 1, updatedAt: 't9', pinned: false, title: 'n' },
    { id: 'old', version: 2, updatedAt: 't2', pinned: false, title: 'o' },
    { id: 'same', version: 5, updatedAt: 't5', pinned: true, title: 's' },
  ];
  const d = diffPage(page, indexItems);
  assert.deepEqual(d.created.map((x) => x.id), ['new']);
  assert.deepEqual(d.updated.map((x) => x.id), ['old']);
  assert.deepEqual(d.unchanged.map((x) => x.id), ['same']);
  assert.equal(d.dirty.length, 2);
});

test('默认停页：整页 unchanged 即使 hasMore', () => {
  const unchangedPage = diffPage(
    [{ id: 'a', version: 1, updatedAt: 't', pinned: false, title: '' }],
    { a: { listVersion: 1, listUpdatedAt: 't', pinned: false } },
  );
  assert.equal(shouldContinuePaging({ pageDiff: unchangedPage, hasMore: true, full: false }), false);
  assert.equal(shouldContinuePaging({ pageDiff: unchangedPage, hasMore: true, full: true }), true);
  assert.equal(shouldContinuePaging({ pageDiff: unchangedPage, hasMore: false, full: true }), false);
});

test('置顶页头仍因后页脏项继续翻', () => {
  const page = [
    { id: 'pin', version: 1, updatedAt: 't', pinned: true, title: 'p' },
    { id: 'new', version: 9, updatedAt: 't9', pinned: false, title: 'n' },
  ];
  const d = diffPage(page, { pin: { listVersion: 1, listUpdatedAt: 't', pinned: true } });
  assert.equal(d.dirty.length, 1);
  assert.equal(shouldContinuePaging({ pageDiff: d, hasMore: true, full: false }), true);
});

test('--full 标记 disappeared，不删 index items', () => {
  const items = { gone: { lastSyncAt: 'old' }, keep: { lastSyncAt: 'k' } };
  const seen = new Set(['keep']);
  const gone = markDisappeared(items, seen, 'now');
  assert.deepEqual(Object.keys(gone), ['gone']);
  assert.equal(gone.gone.markedAt, 'now');
  assert.equal(items.gone.lastSyncAt, 'old');
});

test('parseArgv 识别 --full / --store-tree / --force', () => {
  const { opts } = parseArgv(['sync-session', 'sid', '--store-tree', '--force']);
  assert.equal(opts.storeTree, true);
  assert.equal(opts.force, true);
  const list = parseArgv(['sync-sessions', '--full', '--limit', '50']);
  assert.equal(list.opts.full, true);
  assert.equal(list.opts.limit, '50');
});
