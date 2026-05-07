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
    '  index-html [--out <path>]                Generate workspace index HTML',
    '',
    'Options:',
    '  --workdir <path>         Local branch workspace (default: .deepseek-branches)',
    '  --redact trunc|full|off  scan content mode (default: full)',
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
    redact: 'full',
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
    reportFile: (sessionId) => path.join(root, 'exports', sessionId, 'report.html'),
    indexHtmlFile: () => path.join(root, 'index.html'),
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
  const args = ['get-session-tree', sessionId, '--redact', opts.redact || 'full', '--pretty'];
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
:root { color-scheme: light dark; --bg:#0b1020; --surface:#101827; --panel:#111827; --panel2:#172033; --soft:#1f2a44; --text:#eef2ff; --muted:#9aa7bd; --line:#26334d; --accent:#8b5cf6; --accent2:#60a5fa; --ok:#34d399; --warn:#fbbf24; --danger:#fb7185; --shadow:0 24px 80px rgba(0,0,0,.35); }
@media (prefers-color-scheme: light) { :root { --bg:#f4f7fb; --surface:#eef2ff; --panel:#ffffff; --panel2:#f8fafc; --soft:#eef2ff; --text:#101827; --muted:#64748b; --line:#dde6f3; --accent:#6d28d9; --accent2:#2563eb; --ok:#059669; --warn:#b45309; --danger:#e11d48; --shadow:0 24px 70px rgba(15,23,42,.12); } }
* { box-sizing: border-box; }
body { margin:0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:radial-gradient(circle at top left, rgba(139,92,246,.18), transparent 34%), var(--bg); color:var(--text); }
button, input { font: inherit; }
button { color:inherit; }
.app { display:grid; grid-template-columns: 340px minmax(460px, 1fr) 360px; height:100vh; gap:16px; padding:16px; }
.pane { background:color-mix(in srgb, var(--panel) 94%, transparent); border:1px solid var(--line); border-radius:24px; box-shadow:var(--shadow); overflow:auto; }
.left, .right { padding:18px; }
.main { padding:0; }
.main-inner { max-width:980px; margin:0 auto; padding:18px 22px 32px; }
.path-header { position:sticky; top:0; z-index:5; padding:18px 22px 14px; background:linear-gradient(180deg, var(--panel) 84%, color-mix(in srgb, var(--panel) 0%, transparent)); border-bottom:1px solid var(--line); backdrop-filter: blur(16px); }
h1, h2, h3, p { margin:0; }
h1 { font-size:19px; line-height:1.35; letter-spacing:-.02em; }
h2 { font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.09em; margin:22px 0 10px; }
.muted { color:var(--muted); }
.hero { padding:14px; border-radius:20px; background:linear-gradient(135deg, color-mix(in srgb, var(--accent) 18%, var(--panel2)), var(--panel2)); border:1px solid color-mix(in srgb, var(--accent) 28%, var(--line)); }
.session-id { margin-top:8px; font-size:12px; color:var(--muted); word-break:break-all; }
.stats { display:grid; grid-template-columns: 1fr 1fr; gap:10px; margin:14px 0; }
.stat { border:1px solid var(--line); border-radius:16px; padding:12px; background:var(--panel2); }
.stat strong { display:block; font-size:22px; letter-spacing:-.03em; }
.tabs { display:grid; grid-template-columns: repeat(3, 1fr); gap:6px; padding:5px; border:1px solid var(--line); border-radius:16px; background:var(--panel2); margin:12px 0; position:sticky; top:0; z-index:4; }
.tab { border:0; border-radius:12px; padding:8px 6px; background:transparent; cursor:pointer; color:var(--muted); }
.tab.active { background:var(--soft); color:var(--text); box-shadow:0 1px 8px rgba(0,0,0,.08); }
.panel-section { display:none; }
.panel-section.active { display:block; }
.list { display:flex; flex-direction:column; gap:9px; }
.item { width:100%; border:1px solid transparent; border-radius:16px; padding:12px; background:var(--panel2); color:var(--text); text-align:left; cursor:pointer; transition:.15s ease; }
.item:hover { transform:translateY(-1px); border-color:color-mix(in srgb, var(--accent2) 40%, var(--line)); }
.item.selected { border-color:var(--accent); box-shadow:0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent); }
.item-title { display:flex; justify-content:space-between; gap:8px; font-weight:700; }
.item-sub { margin-top:5px; font-size:12px; color:var(--muted); }
.pills { margin-top:8px; }
.badge { display:inline-flex; align-items:center; border:1px solid var(--line); border-radius:999px; padding:3px 8px; margin:2px 4px 2px 0; color:var(--muted); font-size:11px; line-height:1.2; background:color-mix(in srgb, var(--panel2) 70%, transparent); }
.badge.active { color:var(--ok); border-color:color-mix(in srgb, var(--ok) 55%, var(--line)); }
.badge.warn { color:var(--warn); border-color:color-mix(in srgb, var(--warn) 55%, var(--line)); }
.badge.branch { color:var(--accent2); border-color:color-mix(in srgb, var(--accent2) 55%, var(--line)); }
.search { width:100%; border:1px solid var(--line); background:var(--panel2); color:var(--text); padding:11px 12px; border-radius:14px; margin:4px 0 12px; outline:none; }
.search:focus { border-color:var(--accent); box-shadow:0 0 0 3px color-mix(in srgb, var(--accent) 16%, transparent); }
.path-actions { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-top:10px; }
.message { border:1px solid var(--line); border-radius:22px; padding:16px; margin:14px 0; background:var(--panel); transition:.15s ease; }
.message.USER { margin-left:auto; max-width:86%; background:linear-gradient(135deg, color-mix(in srgb, var(--accent2) 16%, var(--panel2)), var(--panel2)); }
.message.ASSISTANT { margin-right:auto; max-width:94%; }
.message.selected { border-color:var(--accent); box-shadow:0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent); }
.msg-head { display:flex; flex-wrap:wrap; justify-content:space-between; gap:8px; align-items:center; }
.role { font-weight:750; letter-spacing:-.01em; }
.content { white-space:pre-wrap; line-height:1.68; margin-top:12px; font-size:14px; }
.content.collapsed { max-height:360px; overflow:hidden; position:relative; }
.content.collapsed:after { content:""; position:absolute; left:0; right:0; bottom:0; height:72px; background:linear-gradient(transparent, var(--panel)); }
.message.USER .content.collapsed:after { background:linear-gradient(transparent, var(--panel2)); }
.show-more { border:0; background:transparent; color:var(--accent2); padding:8px 0 0; cursor:pointer; font-weight:650; }
.fork { border:1px solid color-mix(in srgb, var(--accent) 40%, var(--line)); margin:16px 0 20px; padding:14px; border-radius:18px; background:linear-gradient(135deg, color-mix(in srgb, var(--accent) 12%, var(--panel2)), var(--panel2)); }
.fork-title { display:flex; align-items:center; justify-content:space-between; gap:8px; font-weight:750; }
.choices { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; }
.choice { border:1px solid var(--line); border-radius:999px; padding:7px 11px; background:var(--panel); color:var(--text); cursor:pointer; }
.choice.active { border-color:var(--ok); color:var(--ok); background:color-mix(in srgb, var(--ok) 10%, var(--panel)); }
.detail { border:1px solid var(--line); border-radius:18px; padding:14px; margin:10px 0; background:var(--panel2); }
.kv { display:grid; grid-template-columns:110px 1fr; gap:8px; padding:7px 0; border-bottom:1px solid color-mix(in srgb, var(--line) 55%, transparent); }
.kv:last-child { border-bottom:0; }
.cmd { width:100%; border:1px solid var(--line); border-radius:16px; padding:12px; background:var(--panel2); color:var(--text); text-align:left; margin:9px 0; word-break:break-all; cursor:pointer; transition:.15s ease; }
.cmd:hover { border-color:var(--accent2); }
.cmd.copied { border-color:var(--ok); color:var(--ok); }
.empty { color:var(--muted); border:1px dashed var(--line); border-radius:16px; padding:14px; }
@media (max-width: 1180px) { .app { grid-template-columns:1fr; height:auto; } .pane { min-height:30vh; } .path-header { position:relative; } }
</style>
</head>
<body>
<div class="app">
  <aside class="pane left">
    <div class="hero">
      <h1 id="title"></h1>
      <div class="session-id" id="session-meta"></div>
    </div>
    <div class="stats" id="stats"></div>
    <div class="tabs">
      <button class="tab active" data-tab="leaves">Leaves</button>
      <button class="tab" data-tab="branches">Branches</button>
      <button class="tab" data-tab="tags">Tags</button>
    </div>
    <input class="search" id="leaf-filter" placeholder="Filter leaf / tag">
    <section class="panel-section active" id="panel-leaves"><div class="list" id="leaves"></div></section>
    <section class="panel-section" id="panel-branches"><div class="list" id="branch-points"></div></section>
    <section class="panel-section" id="panel-tags"><div class="list" id="tags"></div></section>
  </aside>
  <main class="pane main">
    <div class="path-header">
      <h1 id="path-title"></h1>
      <div class="muted" id="path-meta"></div>
      <div class="path-actions" id="path-actions"></div>
    </div>
    <div class="main-inner" id="path"></div>
  </main>
  <aside class="pane right">
    <h1>Inspector</h1>
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
  var activeTab = 'leaves';

  function byId(id){ return document.getElementById(id); }
  function node(id){ return nodes[String(id)] || null; }
  function make(tag, className, text){
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = String(text);
    return el;
  }
  function clear(el){ while (el.firstChild) el.removeChild(el.firstChild); }
  function shortDate(value){
    if (!value) return '';
    return String(value).replace('T', ' ').replace(/\\.\\d+Z$/, 'Z');
  }
  function descendantsCount(startId){
    var count = 0, stack = [Number(startId)], seen = {};
    while (stack.length) {
      var id = stack.pop();
      if (seen[String(id)]) continue;
      seen[String(id)] = true;
      count += 1;
      var n = node(id);
      (n && n.childrenIds || []).forEach(function(cid){ stack.push(cid); });
    }
    return Math.max(0, count - 1);
  }
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
    if (!names.length) { box.appendChild(make('div','empty','No tags yet.')); return; }
    names.forEach(function(name){
      var tag = annotations.tags[name];
      var btn = make('button','item');
      btn.appendChild(make('div','item-title', name));
      btn.appendChild(make('div','item-sub','leaf ' + tag.leafMessageId + (tag.note ? ' · ' + tag.note : '')));
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
      var title = make('div','item-title');
      title.appendChild(make('span','', 'Leaf ' + id));
      title.appendChild(make('span','muted', String(leaf.pathLength) + ' msgs'));
      btn.appendChild(title);
      btn.appendChild(make('div','item-sub', shortDate(leaf.lastInsertedAt) + ' · ' + (leaf.branchTrail || []).length + ' decisions'));
      var pills = make('div','pills');
      if (leaf.isActiveLeaf) pills.appendChild(make('span','badge active','active'));
      if (leaf.hasIncomplete) pills.appendChild(make('span','badge warn','incomplete'));
      (tagMap[id] || []).forEach(function(t){ pills.appendChild(make('span','badge', t)); });
      btn.appendChild(pills);
      btn.onclick = function(){ selectLeaf(leaf.leafMessageId); };
      box.appendChild(btn);
    });
  }
  function renderBranchPoints(){
    var box = byId('branch-points'); clear(box);
    (summary.branchPoints || []).forEach(function(bp){
      var btn = make('button','item');
      var title = make('div','item-title');
      title.appendChild(make('span','', 'Decision ' + bp.messageId));
      title.appendChild(make('span','badge branch', bp.childrenCount + ' choices'));
      btn.appendChild(title);
      btn.appendChild(make('div','item-sub','depth ' + bp.depth + (bp.activeChildId ? ' · active child ' + bp.activeChildId : '')));
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
    var header = make('div','fork-title');
    header.appendChild(make('span','', 'Decision point #' + n.messageId));
    header.appendChild(make('span','badge branch', (n.childrenIds || []).length + ' choices'));
    div.appendChild(header);
    var choices = make('div','choices');
    (n.childrenIds || []).forEach(function(cid){
      var child = node(cid);
      var b = make('button','choice' + (Number(cid) === Number(currentChildId) ? ' active' : ''), 'child ' + cid + ' · +' + descendantsCount(cid) + ' · ' + ((child && child.status) || 'UNKNOWN'));
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
    byId('path-meta').textContent = path.length + ' messages · redaction ' + detectRedactionMode() + ' · ' + (pathForks(path).length) + ' decisions';
    renderPathActions(path);
    for (var i = 0; i < path.length; i += 1) {
      var n = node(path[i]);
      if (!n) continue;
      var card = make('section','message ' + (n.role || 'UNKNOWN') + (Number(selectedMessage) === Number(n.messageId) ? ' selected' : ''));
      card.onclick = (function(id){ return function(){ selectMessage(id); }; })(n.messageId);
      var head = make('div','msg-head');
      head.appendChild(make('div','role', (n.role || '?') + ' · msg ' + n.messageId));
      head.appendChild(make('div','muted', (n.status || 'UNKNOWN') + ' · ' + shortDate(n.insertedAt)));
      card.appendChild(head);
      card.appendChild(make('div','muted','chars ' + (n.contentLength == null ? '-' : n.contentLength)));
      var text = typeof n.content === 'string' ? n.content : '[content unavailable: ' + (n.contentRedactedMode || 'unknown') + ']';
      var content = make('div','content' + (text.length > 1200 ? ' collapsed' : ''), text);
      card.appendChild(content);
      if (text.length > 1200) {
        var more = make('button','show-more','Show more');
        more.onclick = (function(el, btn){ return function(ev){ ev.stopPropagation(); el.classList.toggle('collapsed'); btn.textContent = el.classList.contains('collapsed') ? 'Show more' : 'Show less'; }; })(content, more);
        card.appendChild(more);
      }
      if (n.contentPreviewTruncated) card.appendChild(make('div','badge warn','preview truncated'));
      box.appendChild(card);
      if (n.childrenIds && n.childrenIds.length > 1) {
        box.appendChild(renderFork(n, path[i + 1]));
      }
    }
  }
  function pathForks(path){
    return path.filter(function(id){ var n = node(id); return n && n.childrenIds && n.childrenIds.length > 1; });
  }
  function renderPathActions(path){
    var box = byId('path-actions'); clear(box);
    var tagMap = tagsByLeaf();
    (tagMap[String(selectedLeaf)] || []).forEach(function(t){ box.appendChild(make('span','badge', t)); });
    if (Number(selectedLeaf) === Number(tree.currentMessageId)) box.appendChild(make('span','badge active','active leaf'));
    box.appendChild(make('span','badge branch', pathForks(path).length + ' decisions'));
    var copy = make('button','choice','Copy export command');
    copy.onclick = function(){ copyCommand('node scripts/deepseek-branch-manager.js export ' + data.sessionId + ' --leaf ' + selectedLeaf + ' --format api-json', copy); };
    box.appendChild(copy);
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
      var row = make('div','kv');
      row.appendChild(make('span','muted', pair[0] + ': '));
      row.appendChild(make('span','', pair[1] == null ? '-' : pair[1]));
      box.appendChild(row);
    });
  }
  function commandButton(text){
    var btn = make('button','cmd', text);
    btn.onclick = function(){ copyCommand(text, btn); };
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
  function copyCommand(text, button){
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function(){
        if (!button) return;
        var old = button.textContent;
        button.classList.add('copied');
        button.textContent = 'Copied: ' + old;
        setTimeout(function(){ button.classList.remove('copied'); button.textContent = old; }, 1200);
      }).catch(function(){});
    }
  }
  function syncHash(){
    try { location.hash = 'leaf=' + encodeURIComponent(selectedLeaf) + '&msg=' + encodeURIComponent(selectedMessage || ''); } catch (_) {}
  }
  function restoreHash(){
    var raw = String(location.hash || '').replace(/^#/, '');
    if (!raw) return;
    var params = {};
    raw.split('&').forEach(function(part){
      var bits = part.split('=');
      params[decodeURIComponent(bits[0] || '')] = decodeURIComponent(bits[1] || '');
    });
    if (params.leaf && node(Number(params.leaf))) selectedLeaf = Number(params.leaf);
    if (params.msg && node(Number(params.msg))) selectedMessage = Number(params.msg);
  }
  function setTab(name){
    activeTab = name;
    Array.from(document.querySelectorAll('.tab')).forEach(function(tab){ tab.classList.toggle('active', tab.getAttribute('data-tab') === name); });
    ['leaves','branches','tags'].forEach(function(key){ byId('panel-' + key).classList.toggle('active', key === name); });
    byId('leaf-filter').style.display = name === 'leaves' ? '' : 'none';
  }
  function selectLeaf(leafId){
    selectedLeaf = Number(leafId);
    selectedMessage = selectedLeaf;
    renderLeaves();
    renderPath();
    renderDetails();
    renderCommands();
    syncHash();
  }
  function selectMessage(messageId){
    selectedMessage = Number(messageId);
    renderPath();
    renderDetails();
    renderCommands();
    syncHash();
  }
  byId('leaf-filter').addEventListener('input', function(ev){
    leafFilter = ev.target.value || '';
    renderLeaves();
  });
  Array.from(document.querySelectorAll('.tab')).forEach(function(tab){
    tab.addEventListener('click', function(){ setTab(tab.getAttribute('data-tab')); });
  });
  restoreHash();
  renderHeader();
  renderTags();
  renderBranchPoints();
  setTab(activeTab);
  if (selectedMessage) { selectLeaf(selectedLeaf); selectMessage(selectedMessage); }
  else selectLeaf(selectedLeaf);
})();
</script>
</body>
</html>
`;
}

function listWorkspaceSessions(opts) {
  const ws = workspace(opts);
  const indexesDir = path.join(ws.root, 'indexes');
  if (!fs.existsSync(indexesDir)) return [];
  const sessionIds = fs.readdirSync(indexesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const sessions = [];
  for (const sessionId of sessionIds) {
    const summaryFile = ws.summaryFile(sessionId);
    if (!fs.existsSync(summaryFile)) continue;
    let summary;
    try { summary = readJson(summaryFile); } catch (_) { continue; }
    const annotations = loadAnnotations(sessionId, opts);
    const reportFile = ws.reportFile(sessionId);
    const tagNames = Object.keys(annotations.tags || {});
    const activeLeaf = (summary.leaves || []).find((leaf) => leaf.isActiveLeaf) || null;
    sessions.push({
      sessionId,
      title: (summary.session && summary.session.title) || sessionId,
      updatedAt: summary.session && summary.session.updatedAt,
      createdAt: summary.session && summary.session.createdAt,
      modelType: summary.session && summary.session.modelType,
      agent: summary.session && summary.session.agent,
      stats: summary.stats || {},
      currentMessageId: summary.currentMessageId,
      activeLeafMessageId: activeLeaf ? activeLeaf.leafMessageId : summary.currentMessageId,
      tags: tagNames.map((name) => Object.assign({ name }, annotations.tags[name] || {})),
      hasReport: fs.existsSync(reportFile),
      reportHref: path.relative(ws.root, reportFile).replace(/\\/g, '/'),
      summaryHref: path.relative(ws.root, summaryFile).replace(/\\/g, '/'),
      generatedAt: summary.generatedAt || null,
    });
  }
  sessions.sort((a, b) => {
    const at = Date.parse(a.updatedAt || a.generatedAt || '') || 0;
    const bt = Date.parse(b.updatedAt || b.generatedAt || '') || 0;
    return bt - at;
  });
  return sessions;
}

function buildIndexHtmlPayload(opts) {
  const ws = workspace(opts);
  const sessions = listWorkspaceSessions(opts);
  return {
    generatedAt: new Date().toISOString(),
    workdir: ws.root,
    sessions,
    stats: {
      sessionCount: sessions.length,
      reportCount: sessions.filter((s) => s.hasReport).length,
      totalMessages: sessions.reduce((sum, s) => sum + Number(s.stats.totalMessages || 0), 0),
      totalLeaves: sessions.reduce((sum, s) => sum + Number(s.stats.leafCount || 0), 0),
      totalBranchPoints: sessions.reduce((sum, s) => sum + Number(s.stats.branchPointCount || 0), 0),
    },
  };
}

function renderWorkspaceIndexHtml(payload) {
  const dataJson = escapeJsonForScript(payload);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DeepSeek Branch Workspace</title>
<style>
:root { color-scheme: light dark; --bg:#0b1020; --panel:#111827; --panel2:#172033; --text:#eef2ff; --muted:#9aa7bd; --line:#26334d; --accent:#8b5cf6; --accent2:#60a5fa; --ok:#34d399; --warn:#fbbf24; --shadow:0 24px 80px rgba(0,0,0,.35); }
@media (prefers-color-scheme: light) { :root { --bg:#f4f7fb; --panel:#ffffff; --panel2:#f8fafc; --text:#101827; --muted:#64748b; --line:#dde6f3; --accent:#6d28d9; --accent2:#2563eb; --ok:#059669; --warn:#b45309; --shadow:0 24px 70px rgba(15,23,42,.12); } }
* { box-sizing:border-box; }
body { margin:0; font-family:Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:radial-gradient(circle at top left, rgba(139,92,246,.18), transparent 34%), var(--bg); color:var(--text); }
a { color:inherit; text-decoration:none; }
.wrap { max-width:1180px; margin:0 auto; padding:28px 20px 44px; }
.hero { display:grid; grid-template-columns:1fr auto; gap:18px; align-items:end; padding:22px; border:1px solid var(--line); border-radius:26px; background:linear-gradient(135deg, color-mix(in srgb, var(--accent) 18%, var(--panel2)), var(--panel)); box-shadow:var(--shadow); }
h1 { margin:0; font-size:28px; letter-spacing:-.04em; }
.muted { color:var(--muted); }
.stats { display:grid; grid-template-columns:repeat(5, minmax(120px, 1fr)); gap:12px; margin:18px 0; }
.stat { border:1px solid var(--line); border-radius:18px; padding:14px; background:var(--panel); }
.stat strong { display:block; font-size:24px; letter-spacing:-.03em; }
.toolbar { position:sticky; top:0; z-index:4; display:flex; gap:10px; align-items:center; margin:18px 0; padding:12px; border:1px solid var(--line); border-radius:18px; background:color-mix(in srgb, var(--panel) 92%, transparent); backdrop-filter:blur(14px); }
.search { flex:1; border:1px solid var(--line); background:var(--panel2); color:var(--text); padding:12px 14px; border-radius:14px; outline:none; }
.search:focus { border-color:var(--accent); box-shadow:0 0 0 3px color-mix(in srgb, var(--accent) 16%, transparent); }
.toggle { border:1px solid var(--line); border-radius:999px; padding:9px 12px; background:var(--panel2); color:var(--text); cursor:pointer; }
.toggle.active { border-color:var(--ok); color:var(--ok); }
.grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(340px, 1fr)); gap:14px; }
.card { border:1px solid var(--line); border-radius:22px; padding:16px; background:var(--panel); box-shadow:0 12px 40px rgba(0,0,0,.12); transition:.15s ease; }
.card:hover { transform:translateY(-2px); border-color:color-mix(in srgb, var(--accent2) 45%, var(--line)); }
.title { font-weight:780; font-size:17px; letter-spacing:-.02em; }
.sid { margin-top:6px; font-size:12px; color:var(--muted); word-break:break-all; }
.meta { margin-top:10px; color:var(--muted); font-size:13px; }
.pills { margin:12px 0 4px; }
.pill { display:inline-flex; align-items:center; border:1px solid var(--line); border-radius:999px; padding:4px 9px; margin:2px 4px 2px 0; color:var(--muted); font-size:12px; background:var(--panel2); }
.pill.ok { color:var(--ok); border-color:color-mix(in srgb, var(--ok) 55%, var(--line)); }
.pill.warn { color:var(--warn); border-color:color-mix(in srgb, var(--warn) 55%, var(--line)); }
.actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:14px; }
.btn { border:1px solid var(--line); border-radius:12px; padding:9px 10px; background:var(--panel2); cursor:pointer; }
.btn.primary { border-color:var(--accent2); color:var(--accent2); }
.empty { border:1px dashed var(--line); border-radius:22px; padding:22px; color:var(--muted); background:var(--panel); }
@media (max-width:760px){ .hero { grid-template-columns:1fr; } .stats { grid-template-columns:1fr 1fr; } .toolbar { flex-wrap:wrap; } }
</style>
</head>
<body>
<div class="wrap">
  <section class="hero">
    <div>
      <h1>DeepSeek Branch Workspace</h1>
      <p class="muted">搜索本地分支索引、标签，并跳转到已导出的单会话报告。</p>
      <p class="muted" id="workdir"></p>
    </div>
    <div class="muted" id="generated"></div>
  </section>
  <section class="stats" id="stats"></section>
  <section class="toolbar">
    <input class="search" id="search" placeholder="Search title, sessionId, tag, leaf...">
    <button class="toggle" id="reports-only">Reports only</button>
  </section>
  <section class="grid" id="cards"></section>
</div>
<script type="application/json" id="workspace-data">${dataJson}</script>
<script>
(function(){
  'use strict';
  var data = JSON.parse(document.getElementById('workspace-data').textContent);
  var query = '';
  var reportsOnly = false;
  function byId(id){ return document.getElementById(id); }
  function make(tag, className, text){
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = String(text);
    return el;
  }
  function clear(el){ while (el.firstChild) el.removeChild(el.firstChild); }
  function shortDate(value){ return value ? String(value).replace('T',' ').replace(/\\.\\d+Z$/, 'Z') : ''; }
  function copy(text, button){
    if (!navigator.clipboard || !navigator.clipboard.writeText) return;
    navigator.clipboard.writeText(text).then(function(){
      var old = button.textContent;
      button.textContent = 'Copied';
      setTimeout(function(){ button.textContent = old; }, 1000);
    }).catch(function(){});
  }
  function haystack(session){
    return [
      session.title, session.sessionId, session.activeLeafMessageId, session.currentMessageId,
      (session.tags || []).map(function(t){ return t.name + ' ' + t.leafMessageId + ' ' + (t.note || ''); }).join(' ')
    ].join(' ').toLowerCase();
  }
  function renderStats(){
    var box = byId('stats'); clear(box);
    [['Sessions', data.stats.sessionCount], ['Reports', data.stats.reportCount], ['Messages', data.stats.totalMessages], ['Leaves', data.stats.totalLeaves], ['Branches', data.stats.totalBranchPoints]].forEach(function(pair){
      var card = make('div','stat');
      card.appendChild(make('strong','', pair[1] == null ? '-' : pair[1]));
      card.appendChild(make('span','muted', pair[0]));
      box.appendChild(card);
    });
  }
  function renderCards(){
    var box = byId('cards'); clear(box);
    var sessions = (data.sessions || []).filter(function(s){
      if (reportsOnly && !s.hasReport) return false;
      if (!query) return true;
      return haystack(s).indexOf(query.toLowerCase()) !== -1;
    });
    if (!sessions.length) {
      box.appendChild(make('div','empty','没有匹配的本地会话索引。'));
      return;
    }
    sessions.forEach(function(s){
      var card = make('article','card');
      card.appendChild(make('div','title', s.title || s.sessionId));
      card.appendChild(make('div','sid', s.sessionId));
      card.appendChild(make('div','meta', 'updated ' + shortDate(s.updatedAt) + ' · active leaf ' + (s.activeLeafMessageId || '-')));
      var pills = make('div','pills');
      pills.appendChild(make('span','pill', (s.stats.totalMessages || 0) + ' messages'));
      pills.appendChild(make('span','pill', (s.stats.leafCount || 0) + ' leaves'));
      pills.appendChild(make('span','pill', (s.stats.branchPointCount || 0) + ' branches'));
      if (s.hasReport) pills.appendChild(make('span','pill ok','report'));
      else pills.appendChild(make('span','pill warn','no report'));
      (s.tags || []).forEach(function(t){ pills.appendChild(make('span','pill', t.name)); });
      card.appendChild(pills);
      var actions = make('div','actions');
      if (s.hasReport) {
        var link = make('a','btn primary','Open report');
        link.href = s.reportHref;
        actions.appendChild(link);
      }
      var htmlCmd = 'node scripts/deepseek-branch-manager.js html ' + s.sessionId + ' --force';
      var htmlBtn = make('button','btn','Copy html command');
      htmlBtn.onclick = function(){ copy(htmlCmd, htmlBtn); };
      actions.appendChild(htmlBtn);
      var scanCmd = 'node scripts/deepseek-branch-manager.js scan ' + s.sessionId;
      var scanBtn = make('button','btn','Copy scan command');
      scanBtn.onclick = function(){ copy(scanCmd, scanBtn); };
      actions.appendChild(scanBtn);
      card.appendChild(actions);
      box.appendChild(card);
    });
  }
  byId('workdir').textContent = data.workdir;
  byId('generated').textContent = 'Generated ' + data.generatedAt;
  byId('search').addEventListener('input', function(ev){ query = ev.target.value || ''; renderCards(); });
  byId('reports-only').addEventListener('click', function(){
    reportsOnly = !reportsOnly;
    byId('reports-only').classList.toggle('active', reportsOnly);
    renderCards();
  });
  renderStats();
  renderCards();
})();
</script>
</body>
</html>
`;
}

function cmdIndexHtml(opts) {
  const payload = buildIndexHtmlPayload(opts);
  const body = renderWorkspaceIndexHtml(payload);
  const outPath = path.resolve(opts.out || workspace(opts).indexHtmlFile());
  if (fs.existsSync(outPath) && !opts.force) {
    throw new Error(`output exists; pass --force to overwrite: ${outPath}`);
  }
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, body, 'utf8');
  return {
    ok: true,
    path: outPath,
    sessions: payload.stats.sessionCount,
    reports: payload.stats.reportCount,
  };
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
  if (command === 'index-html') {
    printJson(cmdIndexHtml(opts), opts);
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
  buildIndexHtmlPayload,
  renderWorkspaceIndexHtml,
};
