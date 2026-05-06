// tests/buildSessionTree.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildSessionTree } = require('../lib/sessionTree');
const { loadBridgeNormalizers } = require('./helpers/loadBridgeNormalizers');

const deps = loadBridgeNormalizers();
const DEPS = {
  normalizeChatMessage: deps.normalizeChatMessage,
  normalizeChatSessionItem: deps.normalizeChatSessionItem,
  clampLimit: deps.clampLimit,
};

function mkMsg(id, parentId, extra) {
  return Object.assign({
    message_id: id,
    parent_id: parentId,
    model: 'deepseek-chat',
    role: id % 2 === 1 ? 'USER' : 'ASSISTANT',
    status: 'FINISHED',
    content: `m${id}`,
    inserted_at: 1700000000 + id,
  }, extra || {});
}

function mkSession(currentMessageId, overrides) {
  return Object.assign({
    id: 'sess-test',
    seq_id: 1,
    title: 't',
    title_type: 'auto',
    pinned: false,
    model_type: 'deepseek-chat',
    agent: '',
    version: 1,
    current_message_id: currentMessageId,
    updated_at: 1700000999,
    inserted_at: 1700000000,
  }, overrides || {});
}

// ---- Group A: 手写小树 ----
//
//        1 (root, USER)
//        |
//        2 (ASSISTANT, branch point)
//       / \
//      3   4 (sibling branch)
//      |   |
//      5   6
//          |
//          7
// currentMessageId = 5  -> active path = [1,2,3,5]

test('A. 手写小树：基础不变量', () => {
  const messages = [
    mkMsg(1, null), mkMsg(2, 1), mkMsg(3, 2), mkMsg(4, 2),
    mkMsg(5, 3), mkMsg(6, 4), mkMsg(7, 6),
  ];
  const session = mkSession(5);
  const tree = buildSessionTree(session, messages, {}, DEPS);

  assert.deepEqual(tree.rootMessageIds, [1]);
  assert.equal(tree.currentMessageId, 5);
  assert.deepEqual(tree.activePathIds, [1, 2, 3, 5]);
  assert.deepEqual(tree.branchPointIds, [2]);
  assert.equal(tree.stats.totalMessages, 7);
  assert.equal(tree.stats.branchPointCount, 1);
  assert.equal(tree.stats.leafCount, 2); // 5 and 7
  assert.equal(tree.stats.activePathLength, 4);
  assert.equal(tree.stats.inactiveMessageCount, 3); // 4,6,7
  assert.equal(tree.stats.maxDepth, 5); // depths 0..4
});

test('A. 手写小树：active path 节点标记 + 反向索引一致', () => {
  const messages = [
    mkMsg(1, null), mkMsg(2, 1), mkMsg(3, 2), mkMsg(4, 2),
    mkMsg(5, 3), mkMsg(6, 4), mkMsg(7, 6),
  ];
  const tree = buildSessionTree(mkSession(5), messages, {}, DEPS);

  for (const id of [1, 2, 3, 5]) {
    assert.equal(tree.nodes[String(id)].isOnActivePath, true, `msg ${id} should be on active path`);
  }
  for (const id of [4, 6, 7]) {
    assert.equal(tree.nodes[String(id)].isOnActivePath, false, `msg ${id} should NOT be on active path`);
  }

  // 反向一致：父的 childrenIds 包含每个 child；child.parentId 等于父
  for (const key of Object.keys(tree.nodes)) {
    const n = tree.nodes[key];
    if (n.parentId == null) continue;
    const parent = tree.nodes[String(n.parentId)];
    assert.ok(parent, `parent ${n.parentId} must exist for ${n.messageId}`);
    assert.ok(parent.childrenIds.includes(n.messageId), `parent.childrenIds must include child ${n.messageId}`);
  }

  // siblingIndex 互不相同；< siblingCount
  for (const key of Object.keys(tree.nodes)) {
    const n = tree.nodes[key];
    assert.ok(n.siblingIndex < n.siblingCount, `siblingIndex < siblingCount for ${n.messageId}`);
    assert.ok(n.siblingIndex >= 0);
  }
  assert.equal(tree.nodes['2'].isBranchPoint, true);
  assert.equal(tree.nodes['2'].childrenIds.length, 2);
});

// ---- Group B: 异常 fixture ----

test('B. 多 root：warnings 含 multi_root', () => {
  const messages = [mkMsg(1, null), mkMsg(2, null), mkMsg(3, 1)];
  const tree = buildSessionTree(mkSession(3), messages, {}, DEPS);
  assert.equal(tree.rootMessageIds.length, 2);
  assert.ok(tree.stats.warnings.includes('multi_root'));
});

test('B. 孤儿节点：parent_id 指向不存在的 id', () => {
  const messages = [mkMsg(1, null), mkMsg(2, 1), mkMsg(99, 42 /* missing */)];
  const tree = buildSessionTree(mkSession(2), messages, {}, DEPS);
  assert.deepEqual(tree.stats.orphanIds, [99]);
  // 孤儿不影响主树
  assert.deepEqual(tree.rootMessageIds, [1]);
});

test('B. currentMessageId 不在树中', () => {
  const messages = [mkMsg(1, null), mkMsg(2, 1)];
  const tree = buildSessionTree(mkSession(9999), messages, {}, DEPS);
  assert.deepEqual(tree.activePathIds, []);
  assert.ok(tree.stats.warnings.includes('current_message_not_in_tree'));
});

test('B. 空树：无消息全默认', () => {
  const tree = buildSessionTree(mkSession(null), [], {}, DEPS);
  assert.equal(tree.stats.totalMessages, 0);
  assert.equal(tree.stats.branchPointCount, 0);
  assert.equal(tree.stats.leafCount, 0);
  assert.equal(tree.stats.maxDepth, 0);
  assert.deepEqual(tree.rootMessageIds, []);
  assert.deepEqual(tree.activePathIds, []);
});

test('B. deps 缺失抛错', () => {
  assert.throws(() => buildSessionTree(mkSession(null), [], {}, undefined),
    /deps must contain/);
  assert.throws(() => buildSessionTree(mkSession(null), [], {}, { clampLimit: () => 1 }),
    /deps must contain/);
});

// ---- Group C: 真实 fixture（如果存在）----
//
// 当 tests/fixtures/session-292.json 存在时验证 v0.4.0 实测的关键数值不漂移。
// 该 fixture 由 `node index.js get-session <sid> --debug-recording` 后从 result.json
// 提取 raw API response（biz.chat_session + biz.chat_messages），content/thinking
// 字段 redact 成 `<redacted-${sha256前8}>`。生成步骤详见 docs/dev/branch-scout.md。

test('C. 真实 session-292 fixture（如果存在）', { skip: !fs.existsSync(path.join(__dirname, 'fixtures', 'session-292.json')) }, () => {
  const fix = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'session-292.json'), 'utf8'));
  const tree = buildSessionTree(fix.chat_session, fix.chat_messages, { contentMaxLen: 100 }, DEPS);
  assert.equal(tree.stats.totalMessages, 292, 'totalMessages');
  assert.equal(tree.stats.branchPointCount, 17, 'branchPointCount');
  assert.equal(tree.stats.activePathLength, 126, 'activePathLength');
  assert.equal(tree.stats.inactiveMessageCount, 166, 'inactiveMessageCount');
  // 反向一致 0 mismatches
  let mismatches = 0;
  for (const k of Object.keys(tree.nodes)) {
    const n = tree.nodes[k];
    if (n.parentId == null) continue;
    const parent = tree.nodes[String(n.parentId)];
    if (!parent || !parent.childrenIds.includes(n.messageId)) mismatches += 1;
  }
  assert.equal(mismatches, 0, 'reverse-index consistency');
});
