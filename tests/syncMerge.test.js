'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { mergeMeta, shouldSkipSessionSync, hasPendingMessages, buildStoredTree } = require('../lib/sync/mergeMessages');

function msg(id, extra = {}) {
  return Object.assign({
    messageId: id,
    role: 'USER',
    status: 'FINISHED',
    parentId: id === 1 ? null : id - 1,
    contentHash: `h${id}`,
    contentLength: 3,
    thinkingHash: null,
    thinkingLength: 0,
    feedback: null,
  }, extra);
}

test('shouldSkipSessionSync：version 相同且非 pending 才跳过', () => {
  assert.equal(shouldSkipSessionSync({ force: false, pending: false, remoteVersion: 3, syncedVersion: 3 }), true);
  assert.equal(shouldSkipSessionSync({ force: true, pending: false, remoteVersion: 3, syncedVersion: 3 }), false);
  assert.equal(shouldSkipSessionSync({ force: false, pending: true, remoteVersion: 3, syncedVersion: 3 }), false);
  assert.equal(shouldSkipSessionSync({ force: false, pending: false, remoteVersion: 4, syncedVersion: 3 }), false);
  assert.equal(shouldSkipSessionSync({ force: false, pending: false, remoteVersion: 3, syncedVersion: null }), false);
});

test('mergeMeta 插入新 id、覆盖 hash/status/feedback', () => {
  const local = {
    sessionId: 's',
    version: 1,
    cacheResetAt: 10,
    messages: { 1: msg(1) },
  };
  const merged = mergeMeta({
    localMeta: local,
    remoteMessages: [msg(1, { contentHash: 'h1-new' }), msg(2)],
    remoteSession: { id: 's', version: 2, currentMessageId: 2 },
    cacheResetAt: 10,
    previousCacheResetAt: 10,
  });
  assert.equal(merged.inserted, 1);
  assert.equal(merged.updated, 1);
  assert.equal(merged.removed, 0);
  assert.equal(merged.reset, false);
  assert.equal(merged.pending, false);
  assert.equal(merged.meta.version, 2);
  assert.equal(merged.meta.messages['1'].contentHash, 'h1-new');
  assert.equal(merged.meta.messages['2'].messageId, 2);
});

test('cacheResetAt 变化才删幽灵 id', () => {
  const local = {
    sessionId: 's',
    version: 2,
    cacheResetAt: 10,
    messages: { 1: msg(1), 99: msg(99) },
  };
  const noReset = mergeMeta({
    localMeta: local,
    remoteMessages: [msg(1)],
    remoteSession: { id: 's', version: 3 },
    cacheResetAt: 10,
    previousCacheResetAt: 10,
  });
  assert.ok(noReset.meta.messages['99']);
  assert.equal(noReset.removed, 0);

  const reset = mergeMeta({
    localMeta: local,
    remoteMessages: [msg(1)],
    remoteSession: { id: 's', version: 3 },
    cacheResetAt: 20,
    previousCacheResetAt: 10,
  });
  assert.equal(reset.reset, true);
  assert.equal(reset.removed, 1);
  assert.equal(reset.meta.messages['99'], undefined);
  assert.ok(reset.meta.messages['1']);
});

test('STREAMING 标 pending 且不抬 version', () => {
  const local = { sessionId: 's', version: 5, cacheResetAt: 1, messages: {} };
  const merged = mergeMeta({
    localMeta: local,
    remoteMessages: [msg(1), msg(2, { role: 'ASSISTANT', status: 'STREAMING', contentHash: 'partial' })],
    remoteSession: { id: 's', version: 8, currentMessageId: 2 },
    cacheResetAt: 1,
    previousCacheResetAt: 1,
  });
  assert.equal(merged.pending, true);
  assert.equal(merged.meta.version, 5);
  assert.equal(merged.meta.messages['2'].status, 'STREAMING');
  assert.equal(hasPendingMessages([{ status: 'WIP' }]), true);
  assert.equal(hasPendingMessages([{ status: 'FINISHED' }]), false);
});

test('buildStoredTree 保留正文供 opt-in 落盘', () => {
  const tree = buildStoredTree({ id: 's' }, [msg(1, { content: 'hello', thinkingContent: 't' })]);
  assert.equal(tree.messages[0].content, 'hello');
  assert.equal(tree.messages[0].thinkingContent, 't');
});
