// lib/sessionTree.js
// ---------------------------------------------------------------------------
// 全分支树重建（v0.4.0 引入；v0.4.1 抽出为单一来源 + 可单测）
//
// 这是个 dual-mode 文件：
//   - Node 端：CommonJS module，`require('./lib/sessionTree')` 拿到 exports（用于
//     单元测试、未来的 home-bridge 镜像、CLI 后处理等）
//   - Browser 端：被 bridges/chat-bridge.js 通过 `// @@include ../lib/sessionTree.js`
//     文本嵌入到 IIFE scope，函数声明直接可用；末尾的 module 守卫跳过
//
// 依赖：clampLimit / normalizeChatMessage / normalizeChatSessionItem。
// 这些函数在两侧来源不同：
//   - Browser：从 IIFE scope（bridges/common.js 已通过 @@include 注入）直接拿
//   - Node 测试：通过 `loadBridgeNormalizers()` 用 vm sandbox 从 bridges/common.js
//     提取真实代码后传入
// 因此 buildSessionTree 改为「依赖注入式」：第 4 个参数 deps 必须包含上述 3 个函数。
//
// 详见 docs/dev/session-tree-schema.md 与 docs/dev/adr-001-branch-tree-route.md。
// ---------------------------------------------------------------------------

const DEFAULT_TREE_CONTENT_MAX_LEN = 60000;

function _emptyTreeStats() {
  return {
    totalMessages: 0, branchPointCount: 0, leafCount: 0, maxDepth: 0,
    activePathLength: 0, inactiveMessageCount: 0,
    orphanIds: [], warnings: [],
  };
}

/**
 * buildSessionTree(rawSession, rawMessages, options, deps) -> SessionTree
 *
 * 不变量：
 *   - rootMessageIds[].every(id => nodes[id].parentId === null)
 *   - branchPointIds[].every(id => nodes[id].childrenIds.length >= 2)
 *   - 反向一致：父的 childrenIds 包含每个 child；每个 child 的 parentId 等于父
 *   - activePathIds[0] === root（若 currentMessageId 在树中）
 *   - siblingIndex < siblingCount，且同 parent 下 children 的 siblingIndex 互不相同
 *
 * @param {Object} rawSession      `biz.chat_session` 原始对象
 * @param {Array}  rawMessages     `biz.chat_messages[]` 原始数组
 * @param {Object} [options]       { contentMaxLen?: number }
 * @param {Object} deps            { normalizeChatMessage, normalizeChatSessionItem, clampLimit }
 * @returns {Object}               SessionTree
 */
function buildSessionTree(rawSession, rawMessages, options, deps) {
  options = options || {};
  if (!deps || typeof deps.normalizeChatMessage !== 'function' || typeof deps.normalizeChatSessionItem !== 'function' || typeof deps.clampLimit !== 'function') {
    throw new Error('buildSessionTree: deps must contain normalizeChatMessage, normalizeChatSessionItem, clampLimit');
  }
  const { normalizeChatMessage, normalizeChatSessionItem, clampLimit } = deps;
  const contentMaxLen = clampLimit(options.contentMaxLen, DEFAULT_TREE_CONTENT_MAX_LEN, 200000);
  const session = normalizeChatSessionItem(rawSession) || null;
  const list = Array.isArray(rawMessages) ? rawMessages : [];
  const stats = _emptyTreeStats();

  const nodes = Object.create(null);
  for (const m of list) {
    const norm = normalizeChatMessage(m, { contentMaxLen });
    if (!norm || typeof norm.messageId !== 'number') continue;
    norm.childrenIds = [];
    norm.depth = 0;
    norm.siblingIndex = 0;
    norm.siblingCount = 1;
    norm.isOnActivePath = false;
    norm.isBranchPoint = false;
    norm.isLeaf = true;
    nodes[String(norm.messageId)] = norm;
  }

  const rootIds = [];
  const orphanIds = [];
  for (const key in nodes) {
    const n = nodes[key];
    if (n.parentId == null) {
      rootIds.push(n.messageId);
      continue;
    }
    const parent = nodes[String(n.parentId)];
    if (!parent) {
      orphanIds.push(n.messageId);
      continue;
    }
    parent.childrenIds.push(n.messageId);
  }

  function _sortChildren(ids) {
    ids.sort((a, b) => {
      const na = nodes[String(a)];
      const nb = nodes[String(b)];
      const ta = na && na.insertedAt ? Date.parse(na.insertedAt) || 0 : 0;
      const tb = nb && nb.insertedAt ? Date.parse(nb.insertedAt) || 0 : 0;
      if (ta !== tb) return ta - tb;
      return a - b;
    });
  }
  _sortChildren(rootIds);
  for (const key in nodes) _sortChildren(nodes[key].childrenIds);

  const branchPointIds = [];
  let leafCount = 0;
  let maxDepth = 0;
  const queue = rootIds.map((id) => ({ id, depth: 0, parentChildren: rootIds }));
  while (queue.length) {
    const cur = queue.shift();
    const n = nodes[String(cur.id)];
    if (!n) continue;
    n.depth = cur.depth;
    const sibs = cur.parentChildren;
    n.siblingCount = sibs.length;
    n.siblingIndex = sibs.indexOf(cur.id);
    n.isLeaf = n.childrenIds.length === 0;
    n.isBranchPoint = n.childrenIds.length >= 2;
    if (n.isBranchPoint) branchPointIds.push(n.messageId);
    if (n.isLeaf) leafCount += 1;
    if (cur.depth > maxDepth) maxDepth = cur.depth;
    for (const cid of n.childrenIds) {
      queue.push({ id: cid, depth: cur.depth + 1, parentChildren: n.childrenIds });
    }
  }
  branchPointIds.sort((a, b) => a - b);

  const currentMessageId = session && typeof session.currentMessageId === 'number'
    ? session.currentMessageId
    : null;
  const activePathIds = [];
  const warnings = [];
  if (currentMessageId == null) {
    warnings.push('current_message_id_missing');
  } else if (!nodes[String(currentMessageId)]) {
    warnings.push('current_message_not_in_tree');
  } else {
    let cur = currentMessageId;
    const seen = Object.create(null);
    while (cur != null && nodes[String(cur)] && !seen[String(cur)]) {
      seen[String(cur)] = true;
      activePathIds.unshift(cur);
      const p = nodes[String(cur)].parentId;
      cur = (p == null) ? null : p;
    }
  }
  for (const id of activePathIds) {
    const n = nodes[String(id)];
    if (n) n.isOnActivePath = true;
  }

  stats.totalMessages = Object.keys(nodes).length;
  stats.branchPointCount = branchPointIds.length;
  stats.leafCount = leafCount;
  stats.maxDepth = stats.totalMessages > 0 ? maxDepth + 1 : 0;
  stats.activePathLength = activePathIds.length;
  stats.inactiveMessageCount = stats.totalMessages - activePathIds.length;
  stats.orphanIds = orphanIds.sort((a, b) => a - b);
  stats.warnings = warnings;
  if (rootIds.length > 1) stats.warnings.push('multi_root');

  return {
    session: session || { id: null },
    rootMessageIds: rootIds,
    currentMessageId,
    activePathIds,
    branchPointIds,
    nodes,
    stats,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildSessionTree, _emptyTreeStats, DEFAULT_TREE_CONTENT_MAX_LEN };
}
