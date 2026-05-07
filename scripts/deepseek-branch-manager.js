'use strict';

const fs = require('fs');
const path = require('path');

const { runCliToFile } = require('../lib/runCliToFile');

const SKILL_DIR = path.resolve(__dirname, '..');
const DEFAULT_WORKDIR = path.join(SKILL_DIR, '.deepseek-branches');
const API_ROLES = new Set(['USER', 'ASSISTANT']);

function usage() {
  return [
    'Usage: node scripts/deepseek-branch-manager.js <command> <sessionId> [options]',
    '',
    'Commands:',
    '  scan <sessionId>                         Fetch and index a session tree',
    '  summary <sessionId>                      Print indexed session stats',
    '  leaves <sessionId>                       List leaf paths from the local index',
    '  branch-points <sessionId>                List branch points from the local index',
    '  path <sessionId> --leaf <id|tag>         Print root-to-leaf path summary',
    '  diff <sessionId> --a <id|tag> --b <id|tag>  Compare two leaf paths',
    '  tag <sessionId> --leaf <id> --name <tag> [--note <text>]',
    '  export <sessionId> --leaf <id|tag> --format api-json|md [--out <path>]',
    '  html <sessionId> [--leaf <id|tag>] [--out <path>]  Generate a static HTML report',
    '',
    'Options:',
    '  --workdir <path>         Local branch workspace (default: .deepseek-branches)',
    '  --redact trunc|full|off  scan content mode (default: trunc)',
    '  --trunc-len <n>          truncation length for scan',
    '  --content-max-len <n>    bridge hard content limit for scan',
    '  --from <messageId>       export a suffix of the selected path',
    '  --max-chars <n>          export content budget',
    '  --max-preview-chars <n>  per-message preview budget in HTML reports',
    '  --pretty                 pretty JSON output',
    '  --force                  allow overwriting export files',
  ].join('\n');
}

function parseArgv(argv) {
  const opts = {
    workdir: DEFAULT_WORKDIR,
    redact: 'trunc',
    truncLen: null,
    contentMaxLen: null,
    pretty: false,
    force: false,
    leaf: null,
    name: null,
    note: '',
    a: null,
    b: null,
    format: null,
    out: null,
    from: null,
    maxChars: null,
    maxPreviewChars: null,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eat = (key) => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${arg}`);
      opts[key] = argv[i];
    };
    const eatEq = (key, prefix) => { opts[key] = arg.slice(prefix.length); };
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--pretty') opts.pretty = true;
    else if (arg === '--force') opts.force = true;
    else if (arg === '--workdir') eat('workdir');
    else if (arg.startsWith('--workdir=')) eatEq('workdir', '--workdir=');
    else if (arg === '--redact') eat('redact');
    else if (arg.startsWith('--redact=')) eatEq('redact', '--redact=');
    else if (arg === '--trunc-len') eat('truncLen');
    else if (arg.startsWith('--trunc-len=')) eatEq('truncLen', '--trunc-len=');
    else if (arg === '--content-max-len') eat('contentMaxLen');
    else if (arg.startsWith('--content-max-len=')) eatEq('contentMaxLen', '--content-max-len=');
    else if (arg === '--leaf' || arg === '--leaf-message-id') eat('leaf');
    else if (arg.startsWith('--leaf=')) eatEq('leaf', '--leaf=');
    else if (arg === '--name') eat('name');
    else if (arg.startsWith('--name=')) eatEq('name', '--name=');
    else if (arg === '--note') eat('note');
    else if (arg.startsWith('--note=')) eatEq('note', '--note=');
    else if (arg === '--a') eat('a');
    else if (arg.startsWith('--a=')) eatEq('a', '--a=');
    else if (arg === '--b') eat('b');
    else if (arg.startsWith('--b=')) eatEq('b', '--b=');
    else if (arg === '--format') eat('format');
    else if (arg.startsWith('--format=')) eatEq('format', '--format=');
    else if (arg === '--out') eat('out');
    else if (arg.startsWith('--out=')) eatEq('out', '--out=');
    else if (arg === '--from') eat('from');
    else if (arg.startsWith('--from=')) eatEq('from', '--from=');
    else if (arg === '--max-chars') eat('maxChars');
    else if (arg.startsWith('--max-chars=')) eatEq('maxChars', '--max-chars=');
    else if (arg === '--max-preview-chars') eat('maxPreviewChars');
    else if (arg.startsWith('--max-preview-chars=')) eatEq('maxPreviewChars', '--max-preview-chars=');
    else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    else positional.push(arg);
  }
  return { opts, positional };
}

function printJson(value, opts) {
  process.stdout.write(JSON.stringify(value, null, opts.pretty ? 2 : 0) + '\n');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function workspace(opts) {
  const root = path.resolve(opts.workdir || DEFAULT_WORKDIR);
  return {
    root,
    indexDir: (sessionId) => path.join(root, 'indexes', sessionId),
    treeFile: (sessionId) => path.join(root, 'indexes', sessionId, 'tree.json'),
    summaryFile: (sessionId) => path.join(root, 'indexes', sessionId, 'summary.json'),
    annotationFile: (sessionId) => path.join(root, 'annotations', `${sessionId}.json`),
    exportDir: (sessionId) => path.join(root, 'exports', sessionId),
  };
}

function requireSessionId(positional) {
  const sessionId = positional[1];
  if (!sessionId) throw new Error('missing <sessionId>');
  return sessionId;
}

function loadTreeDoc(sessionId, opts) {
  const ws = workspace(opts);
  const file = ws.treeFile(sessionId);
  if (!fs.existsSync(file)) {
    throw new Error(`missing index: run scan first (${file})`);
  }
  const doc = readJson(file);
  const tree = doc.tree || doc.result || doc;
  if (!tree || !tree.nodes) throw new Error(`invalid tree index: ${file}`);
  return { doc, tree, file };
}

function loadAnnotations(sessionId, opts) {
  const ws = workspace(opts);
  const file = ws.annotationFile(sessionId);
  if (!fs.existsSync(file)) {
    return { sessionId, updatedAt: null, tags: {}, notes: {}, packs: {} };
  }
  const value = readJson(file);
  return Object.assign({ sessionId, updatedAt: null, tags: {}, notes: {}, packs: {} }, value);
}

function saveAnnotations(sessionId, opts, annotations) {
  const ws = workspace(opts);
  annotations.sessionId = sessionId;
  annotations.updatedAt = new Date().toISOString();
  writeJson(ws.annotationFile(sessionId), annotations);
}

function nodeOf(tree, id) {
  return tree.nodes[String(id)] || null;
}

function toMessageId(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${label} must be a positive message id`);
  }
  return n;
}

function pathIdsForLeaf(tree, leafMessageId) {
  if (!nodeOf(tree, leafMessageId)) throw new Error(`message not found: ${leafMessageId}`);
  const out = [];
  const seen = new Set();
  let cur = leafMessageId;
  while (cur != null) {
    if (seen.has(cur)) throw new Error(`cycle detected at message ${cur}`);
    seen.add(cur);
    const n = nodeOf(tree, cur);
    if (!n) break;
    out.unshift(cur);
    cur = n.parentId == null ? null : n.parentId;
  }
  return out;
}

function resolveLeaf(tree, annotations, raw) {
  if (raw == null || raw === '') throw new Error('missing --leaf');
  if (/^\d+$/.test(String(raw))) return toMessageId(raw, '--leaf');
  const tag = annotations.tags && annotations.tags[String(raw)];
  if (!tag) throw new Error(`unknown tag: ${raw}`);
  return toMessageId(tag.leafMessageId, `tag ${raw}`);
}

function summarizeNode(n) {
  if (!n) return null;
  return {
    messageId: n.messageId,
    parentId: n.parentId,
    role: n.role,
    status: n.status,
    depth: n.depth,
    insertedAt: n.insertedAt,
    contentLength: n.contentLength,
    contentRedactedMode: n.contentRedactedMode || null,
    contentRedactedTruncated: !!n.contentRedactedTruncated,
    isOnActivePath: !!n.isOnActivePath,
    isBranchPoint: !!n.isBranchPoint,
    isLeaf: !!n.isLeaf,
    siblingIndex: n.siblingIndex,
    siblingCount: n.siblingCount,
  };
}

function statusCountsForPath(tree, ids) {
  const counts = {};
  for (const id of ids) {
    const status = (nodeOf(tree, id) && nodeOf(tree, id).status) || 'UNKNOWN';
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

function pathHasIncomplete(tree, ids) {
  return ids.some((id) => {
    const n = nodeOf(tree, id);
    return n && (n.status === 'INCOMPLETE' || n.incompleteMessage === true);
  });
}

function branchTrailForPath(tree, ids) {
  const set = new Set(ids);
  const trail = [];
  for (let i = 0; i < ids.length - 1; i += 1) {
    const n = nodeOf(tree, ids[i]);
    const child = nodeOf(tree, ids[i + 1]);
    if (!n || !child || !Array.isArray(n.childrenIds) || n.childrenIds.length < 2) continue;
    trail.push({
      branchPointId: n.messageId,
      depth: n.depth,
      childId: child.messageId,
      siblingIndex: child.siblingIndex,
      siblingCount: child.siblingCount,
      isActiveChoice: !!child.isOnActivePath,
      inactiveSiblingIds: n.childrenIds.filter((id) => !set.has(id)),
    });
  }
  return trail;
}

function collectLeaves(tree) {
  const leaves = [];
  for (const key of Object.keys(tree.nodes || {})) {
    const n = tree.nodes[key];
    if (!n || !(n.isLeaf || !n.childrenIds || n.childrenIds.length === 0)) continue;
    const ids = pathIdsForLeaf(tree, n.messageId);
    leaves.push({
      leafMessageId: n.messageId,
      pathLength: ids.length,
      isActiveLeaf: n.messageId === tree.currentMessageId,
      isOnActivePath: !!n.isOnActivePath,
      lastInsertedAt: n.insertedAt,
      statusCounts: statusCountsForPath(tree, ids),
      hasIncomplete: pathHasIncomplete(tree, ids),
      branchTrail: branchTrailForPath(tree, ids),
    });
  }
  leaves.sort((a, b) => {
    if (a.isActiveLeaf !== b.isActiveLeaf) return a.isActiveLeaf ? -1 : 1;
    const at = Date.parse(a.lastInsertedAt || '') || 0;
    const bt = Date.parse(b.lastInsertedAt || '') || 0;
    if (at !== bt) return bt - at;
    return a.leafMessageId - b.leafMessageId;
  });
  return leaves;
}

function collectBranchPoints(tree) {
  const activeSet = new Set(tree.activePathIds || []);
  return (tree.branchPointIds || []).map((id) => {
    const n = nodeOf(tree, id);
    const activeChildId = (n.childrenIds || []).find((cid) => activeSet.has(cid)) || null;
    return {
      messageId: n.messageId,
      role: n.role,
      depth: n.depth,
      isOnActivePath: !!n.isOnActivePath,
      childrenCount: (n.childrenIds || []).length,
      activeChildId,
      children: (n.childrenIds || []).map((cid) => summarizeNode(nodeOf(tree, cid))),
    };
  });
}

function buildSummary(tree) {
  return {
    session: tree.session || { id: null },
    currentMessageId: tree.currentMessageId,
    activePathLength: Array.isArray(tree.activePathIds) ? tree.activePathIds.length : null,
    stats: tree.stats || {},
    leaves: collectLeaves(tree),
    branchPoints: collectBranchPoints(tree),
    generatedAt: new Date().toISOString(),
  };
}

async function cmdScan(sessionId, opts) {
  const ws = workspace(opts);
  const indexDir = ws.indexDir(sessionId);
  ensureDir(indexDir);
  const tmpFile = path.join(indexDir, 'tree.raw.json');
  const args = ['get-session-tree', sessionId, '--redact', opts.redact || 'trunc', '--pretty'];
  if (opts.truncLen) args.push('--trunc-len', String(opts.truncLen));
  if (opts.contentMaxLen) args.push('--content-max-len', String(opts.contentMaxLen));

  const run = await runCliToFile({
    skillDir: SKILL_DIR,
    args,
    outFile: tmpFile,
    timeoutMs: 120000,
  });
  if (run.code !== 0) {
    throw new Error(`get-session-tree failed: code=${run.code} stderr=${run.stderr}`);
  }
  const payload = readJson(tmpFile);
  try { fs.unlinkSync(tmpFile); } catch (_) {}
  if (!payload || !payload.ok || !payload.result) {
    throw new Error(`get-session-tree returned non-ok payload: ${JSON.stringify(payload && payload.error)}`);
  }
  const treeDoc = {
    scannedAt: new Date().toISOString(),
    sessionId,
    sourceCommand: ['node', 'index.js', ...args],
    run: payload.run || null,
    sourceUrl: payload.sourceUrl || null,
    bridge: payload.bridge || null,
    tree: payload.result,
  };
  const summary = buildSummary(payload.result);
  writeJson(ws.treeFile(sessionId), treeDoc);
  writeJson(ws.summaryFile(sessionId), summary);
  return {
    ok: true,
    sessionId,
    treeFile: ws.treeFile(sessionId),
    summaryFile: ws.summaryFile(sessionId),
    stats: summary.stats,
    leaves: summary.leaves.length,
    branchPoints: summary.branchPoints.length,
  };
}

function cmdSummary(sessionId, opts) {
  const ws = workspace(opts);
  const file = ws.summaryFile(sessionId);
  if (fs.existsSync(file)) return readJson(file);
  const { tree } = loadTreeDoc(sessionId, opts);
  const summary = buildSummary(tree);
  writeJson(file, summary);
  return summary;
}

function cmdLeaves(sessionId, opts) {
  const summary = cmdSummary(sessionId, opts);
  const annotations = loadAnnotations(sessionId, opts);
  const tagsByLeaf = {};
  for (const [name, tag] of Object.entries(annotations.tags || {})) {
    const id = String(tag.leafMessageId);
    if (!tagsByLeaf[id]) tagsByLeaf[id] = [];
    tagsByLeaf[id].push(name);
  }
  return {
    ok: true,
    session: summary.session,
    leaves: (summary.leaves || []).map((leaf) => Object.assign({}, leaf, {
      tags: tagsByLeaf[String(leaf.leafMessageId)] || [],
    })),
  };
}

function cmdBranchPoints(sessionId, opts) {
  const summary = cmdSummary(sessionId, opts);
  return {
    ok: true,
    session: summary.session,
    branchPointCount: (summary.branchPoints || []).length,
    branchPoints: summary.branchPoints || [],
  };
}

function cmdPath(sessionId, opts) {
  const { tree } = loadTreeDoc(sessionId, opts);
  const annotations = loadAnnotations(sessionId, opts);
  const leafMessageId = resolveLeaf(tree, annotations, opts.leaf);
  const ids = pathIdsForLeaf(tree, leafMessageId);
  return {
    ok: true,
    session: tree.session,
    leafMessageId,
    pathLength: ids.length,
    branchTrail: branchTrailForPath(tree, ids),
    messages: ids.map((id) => summarizeNode(nodeOf(tree, id))),
  };
}

function cmdDiff(sessionId, opts) {
  const { tree } = loadTreeDoc(sessionId, opts);
  const annotations = loadAnnotations(sessionId, opts);
  const aLeaf = resolveLeaf(tree, annotations, opts.a);
  const bLeaf = resolveLeaf(tree, annotations, opts.b);
  const aPath = pathIdsForLeaf(tree, aLeaf);
  const bPath = pathIdsForLeaf(tree, bLeaf);
  let commonLength = 0;
  while (commonLength < aPath.length && commonLength < bPath.length && aPath[commonLength] === bPath[commonLength]) {
    commonLength += 1;
  }
  const forkMessageId = commonLength > 0 ? aPath[commonLength - 1] : null;
  return {
    ok: true,
    session: tree.session,
    a: { leafMessageId: aLeaf, pathLength: aPath.length },
    b: { leafMessageId: bLeaf, pathLength: bPath.length },
    commonPrefixLength: commonLength,
    forkMessageId,
    aAfterFork: aPath.slice(commonLength).map((id) => summarizeNode(nodeOf(tree, id))),
    bAfterFork: bPath.slice(commonLength).map((id) => summarizeNode(nodeOf(tree, id))),
  };
}

function cmdTag(sessionId, opts) {
  if (!opts.name) throw new Error('missing --name');
  const leafMessageId = toMessageId(opts.leaf, '--leaf');
  const { tree } = loadTreeDoc(sessionId, opts);
  const n = nodeOf(tree, leafMessageId);
  if (!n) throw new Error(`message not found: ${leafMessageId}`);
  if (!(n.isLeaf || !n.childrenIds || n.childrenIds.length === 0)) {
    throw new Error(`message is not a leaf: ${leafMessageId}`);
  }
  const annotations = loadAnnotations(sessionId, opts);
  annotations.tags = annotations.tags || {};
  annotations.tags[opts.name] = {
    leafMessageId,
    note: opts.note || '',
    createdAt: (annotations.tags[opts.name] && annotations.tags[opts.name].createdAt) || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveAnnotations(sessionId, opts, annotations);
  return { ok: true, sessionId, tag: opts.name, leafMessageId, annotationFile: workspace(opts).annotationFile(sessionId) };
}

function selectedPathNodes(tree, leafMessageId, fromMessageId) {
  const ids = pathIdsForLeaf(tree, leafMessageId);
  let selectedIds = ids;
  if (fromMessageId != null) {
    const from = toMessageId(fromMessageId, '--from');
    const idx = ids.indexOf(from);
    if (idx === -1) throw new Error(`--from message is not on selected path: ${from}`);
    selectedIds = ids.slice(idx);
  }
  return selectedIds.map((id) => nodeOf(tree, id));
}

function exportApiJson(tree, nodes, opts) {
  const messages = [];
  let totalChars = 0;
  for (const n of nodes) {
    if (!n || !API_ROLES.has(n.role)) continue;
    if (typeof n.content !== 'string') {
      throw new Error(`message ${n.messageId} has no exportable content; rescan with --redact trunc or --redact full`);
    }
    totalChars += n.content.length;
    messages.push({
      role: n.role.toLowerCase(),
      content: n.content,
    });
  }
  if (opts.maxChars && totalChars > Number(opts.maxChars)) {
    throw new Error(`export content exceeds --max-chars (${totalChars} > ${opts.maxChars})`);
  }
  return {
    session: tree.session,
    currentMessageId: tree.currentMessageId,
    messages,
    meta: {
      exportedAt: new Date().toISOString(),
      messageCount: messages.length,
      totalChars,
      redacted: nodes.some((n) => n && n.contentRedactedMode && n.contentRedactedMode !== 'full'),
    },
  };
}

function exportMarkdown(tree, nodes, opts) {
  let totalChars = 0;
  const lines = [`# ${(tree.session && tree.session.title) || tree.session.id || 'DeepSeek branch'}`, ''];
  for (const n of nodes) {
    if (!n || !API_ROLES.has(n.role)) continue;
    const content = typeof n.content === 'string' ? n.content : '';
    totalChars += content.length;
    lines.push(`## ${n.role} (msg ${n.messageId}, ${n.status || 'UNKNOWN'}) - ${n.insertedAt || ''}`, '');
    lines.push(content, '');
  }
  if (opts.maxChars && totalChars > Number(opts.maxChars)) {
    throw new Error(`export content exceeds --max-chars (${totalChars} > ${opts.maxChars})`);
  }
  return lines.join('\n');
}

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'branch';
}

function cmdExport(sessionId, opts) {
  const format = (opts.format || 'api-json').toLowerCase();
  if (format !== 'api-json' && format !== 'md') throw new Error('--format must be api-json or md');
  const { tree } = loadTreeDoc(sessionId, opts);
  const annotations = loadAnnotations(sessionId, opts);
  const rawLeaf = opts.leaf;
  const leafMessageId = resolveLeaf(tree, annotations, rawLeaf);
  const nodes = selectedPathNodes(tree, leafMessageId, opts.from);
  const exported = format === 'api-json' ? exportApiJson(tree, nodes, opts) : null;
  const body = format === 'api-json'
    ? JSON.stringify(exported, null, 2) + '\n'
    : exportMarkdown(tree, nodes, opts);
  const ext = format === 'md' ? 'md' : 'json';
  const label = /^\d+$/.test(String(rawLeaf)) ? `leaf-${leafMessageId}` : safeName(rawLeaf);
  const outPath = path.resolve(opts.out || path.join(workspace(opts).exportDir(sessionId), `${label}.${ext}`));
  if (fs.existsSync(outPath) && !opts.force) {
    throw new Error(`output exists; pass --force to overwrite: ${outPath}`);
  }
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, body, 'utf8');
  return {
    ok: true,
    sessionId,
    leafMessageId,
    format,
    path: outPath,
    messages: exported ? exported.messages.length : nodes.filter((n) => n && API_ROLES.has(n.role)).length,
  };
}

function previewText(value, maxChars) {
  if (typeof value !== 'string') return { value, truncated: false };
  if (!Number.isFinite(maxChars) || maxChars <= 0 || value.length <= maxChars) {
    return { value, truncated: false };
  }
  return { value: value.slice(0, maxChars) + '...', truncated: true };
}

function cloneTreeForHtml(tree, opts) {
  const maxPreviewChars = opts.maxPreviewChars
    ? Number(opts.maxPreviewChars)
    : (opts.maxChars ? Number(opts.maxChars) : 4000);
  const nodes = {};
  for (const [key, node] of Object.entries(tree.nodes || {})) {
    const content = previewText(node.content, maxPreviewChars);
    const thinking = previewText(node.thinkingContent, maxPreviewChars);
    nodes[key] = Object.assign({}, node, {
      content: content.value,
      contentPreviewTruncated: content.truncated || !!node.contentRedactedTruncated,
      thinkingContent: thinking.value,
      thinkingPreviewTruncated: thinking.truncated || !!node.thinkingContentRedactedTruncated,
    });
  }
  return Object.assign({}, tree, { nodes });
}

function pickDefaultLeaf(tree, summary, annotations, opts) {
  if (opts.leaf) return resolveLeaf(tree, annotations, opts.leaf);
  const leaves = summary.leaves || [];
  const active = leaves.find((leaf) => leaf.isActiveLeaf);
  if (active) return active.leafMessageId;
  if (tree.currentMessageId && nodeOf(tree, tree.currentMessageId)) return tree.currentMessageId;
  if (leaves[0]) return leaves[0].leafMessageId;
  return null;
}

function buildHtmlReportPayload(sessionId, opts) {
  const { doc, tree } = loadTreeDoc(sessionId, opts);
  const summary = cmdSummary(sessionId, opts);
  const annotations = loadAnnotations(sessionId, opts);
  const defaultLeafMessageId = pickDefaultLeaf(tree, summary, annotations, opts);
  return {
    generatedAt: new Date().toISOString(),
    sessionId,
    workdir: path.resolve(opts.workdir || DEFAULT_WORKDIR),
    source: {
      treeFile: workspace(opts).treeFile(sessionId),
      summaryFile: workspace(opts).summaryFile(sessionId),
      annotationFile: workspace(opts).annotationFile(sessionId),
      scannedAt: doc.scannedAt || null,
    },
    defaultLeafMessageId,
    tree: cloneTreeForHtml(tree, opts),
    summary,
    annotations,
  };
}

function escapeJsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function renderStaticHtml(payload) {
  const title = (payload.summary.session && payload.summary.session.title) || payload.sessionId;
  const dataJson = escapeJsonForScript(payload);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DeepSeek Branch Report - ${title.replace(/[<>&"]/g, '')}</title>
<style>
:root { color-scheme: light dark; --bg:#0f1115; --panel:#171a21; --muted:#9aa4b2; --text:#e8edf3; --line:#303645; --accent:#7aa2ff; --ok:#68d391; --warn:#f6ad55; }
@media (prefers-color-scheme: light) { :root { --bg:#f6f7fb; --panel:#ffffff; --muted:#5c6675; --text:#18202f; --line:#dde3ee; --accent:#2458d3; --ok:#168a45; --warn:#a15c00; } }
* { box-sizing: border-box; }
body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--bg); color:var(--text); }
button, input { font: inherit; }
.app { display:grid; grid-template-columns: 320px minmax(420px, 1fr) 360px; height:100vh; gap:1px; background:var(--line); }
.pane { background:var(--panel); overflow:auto; }
.left, .right { padding:16px; }
.main { padding:20px; }
h1, h2, h3 { margin:0 0 10px; }
h1 { font-size:18px; line-height:1.35; }
h2 { font-size:14px; color:var(--muted); text-transform:uppercase; letter-spacing:.06em; margin-top:22px; }
.muted { color:var(--muted); }
.stats { display:grid; grid-template-columns: 1fr 1fr; gap:8px; margin:14px 0; }
.stat { border:1px solid var(--line); border-radius:10px; padding:10px; }
.stat strong { display:block; font-size:20px; }
.list { display:flex; flex-direction:column; gap:8px; }
.item { width:100%; border:1px solid var(--line); border-radius:10px; padding:10px; background:transparent; color:var(--text); text-align:left; cursor:pointer; }
.item:hover, .item.selected { border-color:var(--accent); }
.badge { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:2px 7px; margin:2px 4px 2px 0; color:var(--muted); font-size:12px; }
.badge.active { color:var(--ok); border-color:var(--ok); }
.badge.warn { color:var(--warn); border-color:var(--warn); }
.message { border:1px solid var(--line); border-radius:14px; padding:14px; margin:12px 0; background:rgba(127,127,127,.04); }
.message.selected { border-color:var(--accent); }
.role { font-weight:700; }
.content { white-space:pre-wrap; line-height:1.55; margin-top:10px; }
.fork { border-left:3px solid var(--accent); margin:12px 0 18px; padding:10px 0 10px 12px; }
.choices { display:flex; flex-wrap:wrap; gap:8px; margin-top:8px; }
.choice { border:1px solid var(--line); border-radius:999px; padding:6px 10px; background:transparent; color:var(--text); cursor:pointer; }
.choice.active { border-color:var(--ok); color:var(--ok); }
.detail { border:1px solid var(--line); border-radius:12px; padding:12px; margin:10px 0; }
.cmd { width:100%; border:1px solid var(--line); border-radius:10px; padding:10px; background:rgba(127,127,127,.08); color:var(--text); text-align:left; margin:8px 0; word-break:break-all; cursor:pointer; }
.search { width:100%; border:1px solid var(--line); background:transparent; color:var(--text); padding:10px; border-radius:10px; margin:8px 0 12px; }
@media (max-width: 1100px) { .app { grid-template-columns:1fr; height:auto; } .pane { min-height:30vh; } }
</style>
</head>
<body>
<div class="app">
  <aside class="pane left">
    <h1 id="title"></h1>
    <div class="muted" id="session-meta"></div>
    <div class="stats" id="stats"></div>
    <h2>Tags</h2>
    <div class="list" id="tags"></div>
    <h2>Leaves</h2>
    <input class="search" id="leaf-filter" placeholder="Filter leaf / tag">
    <div class="list" id="leaves"></div>
    <h2>Branch Points</h2>
    <div class="list" id="branch-points"></div>
  </aside>
  <main class="pane main">
    <h1 id="path-title"></h1>
    <div class="muted" id="path-meta"></div>
    <div id="path"></div>
  </main>
  <aside class="pane right">
    <h1>Details</h1>
    <div id="details" class="detail muted">选择一条消息查看详情。</div>
    <h2>Copy Commands</h2>
    <div id="commands"></div>
  </aside>
</div>
<script type="application/json" id="branch-data">${dataJson}</script>
<script>
(function(){
  'use strict';
  var data = JSON.parse(document.getElementById('branch-data').textContent);
  var tree = data.tree || {};
  var summary = data.summary || {};
  var annotations = data.annotations || { tags: {} };
  var nodes = tree.nodes || {};
  var selectedLeaf = data.defaultLeafMessageId;
  var selectedMessage = null;
  var leafFilter = '';

  function byId(id){ return document.getElementById(id); }
  function node(id){ return nodes[String(id)] || null; }
  function make(tag, className, text){
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = String(text);
    return el;
  }
  function clear(el){ while (el.firstChild) el.removeChild(el.firstChild); }
  function pathIdsForLeaf(leafId){
    var ids = [], seen = {}, cur = Number(leafId);
    while (cur != null && node(cur) && !seen[String(cur)]) {
      seen[String(cur)] = true;
      ids.unshift(cur);
      var n = node(cur);
      cur = n.parentId == null ? null : n.parentId;
    }
    return ids;
  }
  function findLeafFrom(startId){
    var cur = Number(startId);
    var guard = 0;
    while (node(cur) && guard < 10000) {
      var n = node(cur);
      if (!n.childrenIds || n.childrenIds.length === 0) return cur;
      var active = n.childrenIds.find(function(cid){ return node(cid) && node(cid).isOnActivePath; });
      cur = active || n.childrenIds[0];
      guard += 1;
    }
    return Number(startId);
  }
  function tagsByLeaf(){
    var out = {};
    Object.keys(annotations.tags || {}).forEach(function(name){
      var tag = annotations.tags[name];
      var id = String(tag.leafMessageId);
      if (!out[id]) out[id] = [];
      out[id].push(name);
    });
    return out;
  }
  function renderHeader(){
    var session = summary.session || {};
    byId('title').textContent = session.title || data.sessionId;
    byId('session-meta').textContent = 'session ' + data.sessionId + ' · generated ' + data.generatedAt;
    var stats = summary.stats || {};
    var box = byId('stats'); clear(box);
    [['Messages', stats.totalMessages], ['Leaves', stats.leafCount], ['Branches', stats.branchPointCount], ['Active path', stats.activePathLength]].forEach(function(pair){
      var s = make('div','stat');
      s.appendChild(make('strong','', pair[1] == null ? '-' : pair[1]));
      s.appendChild(make('span','muted', pair[0]));
      box.appendChild(s);
    });
  }
  function renderTags(){
    var box = byId('tags'); clear(box);
    var names = Object.keys(annotations.tags || {});
    if (!names.length) { box.appendChild(make('div','muted','No tags yet.')); return; }
    names.forEach(function(name){
      var tag = annotations.tags[name];
      var btn = make('button','item', name + ' · leaf ' + tag.leafMessageId);
      btn.onclick = function(){ selectLeaf(tag.leafMessageId); };
      box.appendChild(btn);
    });
  }
  function renderLeaves(){
    var box = byId('leaves'); clear(box);
    var tagMap = tagsByLeaf();
    (summary.leaves || []).filter(function(leaf){
      if (!leafFilter) return true;
      var hay = String(leaf.leafMessageId) + ' ' + (tagMap[String(leaf.leafMessageId)] || []).join(' ');
      return hay.toLowerCase().indexOf(leafFilter.toLowerCase()) !== -1;
    }).forEach(function(leaf){
      var id = String(leaf.leafMessageId);
      var btn = make('button','item' + (Number(id) === Number(selectedLeaf) ? ' selected' : ''));
      btn.appendChild(make('div','role','leaf ' + id));
      btn.appendChild(make('div','muted','path ' + leaf.pathLength + ' · ' + (leaf.lastInsertedAt || '')));
      if (leaf.isActiveLeaf) btn.appendChild(make('span','badge active','active'));
      if (leaf.hasIncomplete) btn.appendChild(make('span','badge warn','incomplete'));
      (tagMap[id] || []).forEach(function(t){ btn.appendChild(make('span','badge', t)); });
      btn.onclick = function(){ selectLeaf(leaf.leafMessageId); };
      box.appendChild(btn);
    });
  }
  function renderBranchPoints(){
    var box = byId('branch-points'); clear(box);
    (summary.branchPoints || []).forEach(function(bp){
      var btn = make('button','item');
      btn.appendChild(make('div','role','msg ' + bp.messageId + ' · ' + bp.childrenCount + ' choices'));
      btn.appendChild(make('div','muted','depth ' + bp.depth + (bp.activeChildId ? ' · active child ' + bp.activeChildId : '')));
      btn.onclick = function(){
        var leaf = bp.activeChildId ? findLeafFrom(bp.activeChildId) : findLeafFrom((bp.children && bp.children[0] && bp.children[0].messageId) || bp.messageId);
        selectLeaf(leaf);
        selectMessage(bp.messageId);
      };
      box.appendChild(btn);
    });
  }
  function renderFork(n, currentChildId){
    var div = make('div','fork');
    div.appendChild(make('div','role','Branch point at msg ' + n.messageId));
    var choices = make('div','choices');
    (n.childrenIds || []).forEach(function(cid){
      var child = node(cid);
      var b = make('button','choice' + (Number(cid) === Number(currentChildId) ? ' active' : ''), 'child ' + cid + ' · ' + ((child && child.status) || 'UNKNOWN'));
      b.onclick = function(){ selectLeaf(findLeafFrom(cid)); };
      choices.appendChild(b);
    });
    div.appendChild(choices);
    return div;
  }
  function renderPath(){
    var path = pathIdsForLeaf(selectedLeaf);
    var box = byId('path'); clear(box);
    byId('path-title').textContent = 'Leaf ' + selectedLeaf;
    byId('path-meta').textContent = path.length + ' messages · redaction ' + detectRedactionMode();
    for (var i = 0; i < path.length; i += 1) {
      var n = node(path[i]);
      if (!n) continue;
      var card = make('section','message' + (Number(selectedMessage) === Number(n.messageId) ? ' selected' : ''));
      card.onclick = (function(id){ return function(){ selectMessage(id); }; })(n.messageId);
      card.appendChild(make('div','role', (n.role || '?') + ' · msg ' + n.messageId + ' · ' + (n.status || 'UNKNOWN')));
      card.appendChild(make('div','muted', (n.insertedAt || '') + ' · chars ' + (n.contentLength == null ? '-' : n.contentLength)));
      var content = make('div','content', typeof n.content === 'string' ? n.content : '[content unavailable: ' + (n.contentRedactedMode || 'unknown') + ']');
      card.appendChild(content);
      if (n.contentPreviewTruncated) card.appendChild(make('div','badge warn','preview truncated'));
      box.appendChild(card);
      if (n.childrenIds && n.childrenIds.length > 1) {
        box.appendChild(renderFork(n, path[i + 1]));
      }
    }
  }
  function detectRedactionMode(){
    var keys = Object.keys(nodes);
    for (var i = 0; i < keys.length; i += 1) {
      var mode = nodes[keys[i]].contentRedactedMode;
      if (mode) return mode;
    }
    return 'unknown';
  }
  function renderDetails(){
    var box = byId('details'); clear(box);
    var n = selectedMessage ? node(selectedMessage) : null;
    if (!n) { box.appendChild(make('div','muted','选择一条消息查看详情。')); return; }
    [
      ['messageId', n.messageId], ['parentId', n.parentId], ['role', n.role],
      ['status', n.status], ['depth', n.depth], ['sibling', String(n.siblingIndex) + '/' + String(n.siblingCount)],
      ['contentLength', n.contentLength], ['insertedAt', n.insertedAt]
    ].forEach(function(pair){
      var row = make('div','');
      row.appendChild(make('span','muted', pair[0] + ': '));
      row.appendChild(make('span','', pair[1] == null ? '-' : pair[1]));
      box.appendChild(row);
    });
  }
  function commandButton(text){
    var btn = make('button','cmd', text);
    btn.onclick = function(){ copyCommand(text); };
    return btn;
  }
  function renderCommands(){
    var box = byId('commands'); clear(box);
    box.appendChild(commandButton('node scripts/deepseek-branch-manager.js tag ' + data.sessionId + ' --leaf ' + selectedLeaf + ' --name <name>'));
    box.appendChild(commandButton('node scripts/deepseek-branch-manager.js export ' + data.sessionId + ' --leaf ' + selectedLeaf + ' --format api-json'));
    if (selectedMessage) {
      box.appendChild(commandButton('node scripts/deepseek-branch-manager.js path ' + data.sessionId + ' --leaf ' + selectedLeaf));
    }
  }
  function copyCommand(text){
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function(){});
    }
  }
  function selectLeaf(leafId){
    selectedLeaf = Number(leafId);
    selectedMessage = selectedLeaf;
    renderLeaves();
    renderPath();
    renderDetails();
    renderCommands();
  }
  function selectMessage(messageId){
    selectedMessage = Number(messageId);
    renderPath();
    renderDetails();
    renderCommands();
  }
  byId('leaf-filter').addEventListener('input', function(ev){
    leafFilter = ev.target.value || '';
    renderLeaves();
  });
  renderHeader();
  renderTags();
  renderBranchPoints();
  selectLeaf(selectedLeaf);
})();
</script>
</body>
</html>
`;
}

function cmdHtml(sessionId, opts) {
  const payload = buildHtmlReportPayload(sessionId, opts);
  const body = renderStaticHtml(payload);
  const outPath = path.resolve(opts.out || path.join(workspace(opts).exportDir(sessionId), 'report.html'));
  if (fs.existsSync(outPath) && !opts.force) {
    throw new Error(`output exists; pass --force to overwrite: ${outPath}`);
  }
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, body, 'utf8');
  return {
    ok: true,
    sessionId,
    path: outPath,
    defaultLeafMessageId: payload.defaultLeafMessageId,
    leaves: (payload.summary.leaves || []).length,
    branchPoints: (payload.summary.branchPoints || []).length,
  };
}

async function main(argv) {
  const parsed = parseArgv(argv);
  const { opts, positional } = parsed;
  const command = positional[0];
  if (!command || opts.help) {
    process.stdout.write(usage() + '\n');
    return 0;
  }
  const sessionId = requireSessionId(positional);
  let result;
  if (command === 'scan') result = await cmdScan(sessionId, opts);
  else if (command === 'summary') result = cmdSummary(sessionId, opts);
  else if (command === 'leaves') result = cmdLeaves(sessionId, opts);
  else if (command === 'branch-points') result = cmdBranchPoints(sessionId, opts);
  else if (command === 'path') result = cmdPath(sessionId, opts);
  else if (command === 'diff') result = cmdDiff(sessionId, opts);
  else if (command === 'tag') result = cmdTag(sessionId, opts);
  else if (command === 'export') result = cmdExport(sessionId, opts);
  else if (command === 'html') result = cmdHtml(sessionId, opts);
  else throw new Error(`unknown command: ${command}`);
  printJson(result, opts);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((err) => {
    process.stderr.write(`ERROR: ${err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildSummary,
  collectLeaves,
  collectBranchPoints,
  pathIdsForLeaf,
  buildHtmlReportPayload,
  renderStaticHtml,
};
