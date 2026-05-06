// lib/treeFormat.js
// ---------------------------------------------------------------------------
// SessionTree 可视化（v0.4.1）：纯函数，输入 buildSessionTree 的产物，输出字符串。
//
// 两种模式：
//   - mermaid：flowchart TD；active path 用粗边 `==>`，非 active 用虚线 `-.->`
//   - ascii：缩进树；active path 节点前加 `*` 前缀；分支点标 [branch:N]
//
// 设计取舍：
//   - 不引入任何渲染依赖；只输出文本。消费方（终端 / Markdown 渲染器）自己处理。
//   - 不对 SessionTree 节点做正文输出（label 只用 messageId/role/status/branch 标签）。
//     正文展示交给 get-session / get-message 工具，遵守 redact 策略。
//   - maxNodes 截断：BFS 顺序保留，过载时尾部用 `[truncated +N]` 一行标记。
// ---------------------------------------------------------------------------

const DEFAULT_MAX_NODES = 200;

function _shortRole(role) {
  if (role === 'USER') return 'U';
  if (role === 'ASSISTANT') return 'A';
  if (role === 'SYSTEM') return 'S';
  return role || '?';
}

function _label(node) {
  const parts = [`msg ${node.messageId}`, _shortRole(node.role)];
  if (node.parentId == null) parts.push('root');
  if (node.isBranchPoint) parts.push(`branch:${node.childrenIds.length}`);
  if (node.status && node.status !== 'FINISHED') parts.push(node.status);
  return parts.join(' ');
}

function _bfsOrder(tree, maxNodes) {
  const order = [];
  const queue = (tree.rootMessageIds || []).slice();
  const seen = Object.create(null);
  while (queue.length && order.length < maxNodes) {
    const id = queue.shift();
    if (seen[String(id)]) continue;
    seen[String(id)] = true;
    const n = tree.nodes[String(id)];
    if (!n) continue;
    order.push(id);
    for (const cid of n.childrenIds || []) queue.push(cid);
  }
  return { order, total: Object.keys(tree.nodes || {}).length };
}

/**
 * formatAsMermaid(tree, opts?) -> string
 *
 * 输出 ```mermaid``` 代码块外层不加；调用方自己包。
 * opts.maxNodes 默认 200；超出 BFS 截断 + 末尾标 `%% truncated +N`。
 */
function formatAsMermaid(tree, opts) {
  opts = opts || {};
  const maxNodes = Math.max(1, opts.maxNodes || DEFAULT_MAX_NODES);
  const { order, total } = _bfsOrder(tree, maxNodes);
  const included = new Set(order.map((id) => String(id)));

  const lines = ['flowchart TD'];
  for (const id of order) {
    const n = tree.nodes[String(id)];
    const label = _label(n).replace(/"/g, "'");
    lines.push(`    msg${id}["${label}"]`);
  }
  for (const id of order) {
    const n = tree.nodes[String(id)];
    for (const cid of n.childrenIds || []) {
      if (!included.has(String(cid))) continue;
      const child = tree.nodes[String(cid)];
      const isActiveEdge = !!(n.isOnActivePath && child && child.isOnActivePath);
      const arrow = isActiveEdge ? '==>' : '-.->';
      const tag = isActiveEdge ? '|active|' : '|branch|';
      lines.push(`    msg${id} ${arrow}${tag} msg${cid}`);
    }
  }
  if (order.length < total) {
    lines.push(`    %% truncated +${total - order.length} nodes (maxNodes=${maxNodes})`);
  }
  return lines.join('\n') + '\n';
}

/**
 * formatAsAscii(tree, opts?) -> string
 *
 * 缩进树；active path 节点前加 `*`，非 active 节点空格占位。优先列 active 子树。
 */
function formatAsAscii(tree, opts) {
  opts = opts || {};
  const maxNodes = Math.max(1, opts.maxNodes || DEFAULT_MAX_NODES);
  const lines = [];
  let count = 0;

  function visit(id, prefix, isLast, isRoot) {
    if (count >= maxNodes) return;
    const n = tree.nodes[String(id)];
    if (!n) return;
    count += 1;
    const marker = n.isOnActivePath ? '*' : ' ';
    const branch = isRoot ? '' : (isLast ? '└── ' : '├── ');
    const tail = n.isOnActivePath && !isRoot ? '  ← active' : (n.isOnActivePath ? '  (active root)' : '');
    lines.push(`${prefix}${branch}${marker} ${_label(n)}${tail}`);
    const children = (n.childrenIds || []).slice();
    children.sort((a, b) => {
      const na = tree.nodes[String(a)];
      const nb = tree.nodes[String(b)];
      const aa = na && na.isOnActivePath ? 0 : 1;
      const bb = nb && nb.isOnActivePath ? 0 : 1;
      if (aa !== bb) return aa - bb;
      return a - b;
    });
    const childPrefix = isRoot ? '' : (isLast ? '    ' : '│   ');
    for (let i = 0; i < children.length; i += 1) {
      visit(children[i], prefix + childPrefix, i === children.length - 1, false);
    }
  }

  const roots = tree.rootMessageIds || [];
  for (let i = 0; i < roots.length; i += 1) {
    visit(roots[i], '', true, true);
  }
  const total = Object.keys(tree.nodes || {}).length;
  if (count < total) {
    lines.push(`... [truncated +${total - count} nodes (maxNodes=${maxNodes})]`);
  }
  return lines.join('\n') + '\n';
}

module.exports = { formatAsMermaid, formatAsAscii, DEFAULT_MAX_NODES };
