'use strict';

/**
 * lib/audit.js
 *
 * DESTRUCTIVE 工具的审计落盘：
 * - writeAuditEntry：把 destructive 调用的完整上下文（含 prompt 原文、完整 request
 *   body）以 jsonl 一行写入 `~/.js-eyes/skill-records/<skill>/audit/audit.jsonl`，
 *   作为"无 confirm"模式下的事后凭证。
 * - writeBackup：在 sideEffect='irreversible' 调用前，把目标对象的当前 snapshot
 *   写入 `<records>/backups/<resource>-<id>-<ts>.json`，方便人肉回滚。
 *
 * 与 history.jsonl 不同：history.jsonl 只记 status/duration，不写 result；audit.jsonl
 * 是面向 destructive 调用的"完整复盘库"，写入 input args + result.error + tool 上下文。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
}

function recordsRoot(skillId) {
  const home = os.homedir();
  return path.join(home, '.js-eyes', 'skill-records', skillId);
}

function auditFilePath(skillId) {
  const dir = path.join(recordsRoot(skillId), 'audit');
  ensureDir(dir);
  return path.join(dir, 'audit.jsonl');
}

function backupDir(skillId) {
  const dir = path.join(recordsRoot(skillId), 'backups');
  ensureDir(dir);
  return dir;
}

/**
 * writeAuditEntry - destructive 工具调用一律走这里，不依赖 redact，原文 / 完整 body 全保留。
 *
 * @param {object} runContext     createRunContext 返回
 * @param {object} entry
 * @param {string} entry.tool     工具名（如 deepseek_send_message）
 * @param {string} entry.method   bridge 方法名（如 sendMessage）
 * @param {object} entry.args     调用参数（含 prompt 原文）
 * @param {object} entry.result   bridge 返回的完整结果（含响应 body）
 * @param {string} entry.sideEffect 'reversible' | 'irreversible' | 'cost'
 * @param {string} [entry.backupPath]  irreversible 时写下的 backup 文件路径
 * @returns {string} 实际写入的 audit 文件路径
 */
function writeAuditEntry(runContext, entry) {
  const filePath = auditFilePath(runContext.skillId);
  const line = {
    ts: new Date().toISOString(),
    run_id: runContext.runId,
    skill_id: runContext.skillId,
    skill_version: runContext.skillVersion || null,
    tool: entry.tool || null,
    method: entry.method || null,
    side_effect: entry.sideEffect || 'reversible',
    args: entry.args == null ? {} : entry.args,
    result: entry.result == null ? null : entry.result,
    backup_path: entry.backupPath || null,
    target_url: entry.targetUrl || null,
    bridge: entry.bridge || null,
  };
  try {
    fs.appendFileSync(filePath, JSON.stringify(line) + '\n', 'utf8');
  } catch (e) {
    process.stderr.write(`[deepseek-audit] writeAuditEntry failed: ${e && e.message}\n`);
  }
  return filePath;
}

/**
 * writeBackup - 在 irreversible 操作前落盘当前快照。
 *
 * @param {object} runContext
 * @param {object} spec
 * @param {string} spec.resource    'session' | 'message' | 'api_key' | 'file' | ...
 * @param {string} spec.id
 * @param {object} spec.snapshot    任意可序列化对象
 * @returns {string} 写入文件路径（失败时返回空字符串）
 */
function writeBackup(runContext, spec) {
  if (!spec || !spec.resource || !spec.id) return '';
  const dir = backupDir(runContext.skillId);
  const safeId = String(spec.id).replace(/[^\w.-]/g, '_').slice(0, 80);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(dir, `${spec.resource}-${safeId}-${ts}.json`);
  try {
    fs.writeFileSync(filePath, JSON.stringify({
      ts: new Date().toISOString(),
      run_id: runContext.runId,
      skill_id: runContext.skillId,
      resource: spec.resource,
      id: spec.id,
      snapshot: spec.snapshot == null ? null : spec.snapshot,
    }, null, 2), 'utf8');
    return filePath;
  } catch (e) {
    process.stderr.write(`[deepseek-audit] writeBackup failed: ${e && e.message}\n`);
    return '';
  }
}

module.exports = {
  writeAuditEntry,
  writeBackup,
  auditFilePath,
  backupDir,
  recordsRoot,
};
