'use strict';

/**
 * lib/audit.js
 *
 * DESTRUCTIVE 工具的审计落盘：
 * - writeAuditEntry：把 destructive 调用的上下文写入 audit.jsonl；prompt、正文、
 *   token、cookie 等敏感字符串只保留 length + sha256。
 * - writeBackup：在 sideEffect='irreversible' 调用前，把目标对象的当前 snapshot
 *   写入 `<records>/backups/<resource>-<id>-<ts>.json`，方便人肉回滚。
 *
 * 与 history.jsonl 不同：history.jsonl 只记 status/duration，不写 result；audit.jsonl
 * 是面向 destructive 调用的最小化复盘记录，写入脱敏 args/result + tool 上下文。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chmodBestEffort, getSkillRecordPaths } = require('@js-eyes/runtime-paths');

const SENSITIVE_KEY = /(prompt|content|thinking|token|authorization|cookie|secret|password|base64|body|settings|title|comment|filename)/i;

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodBestEffort(dir, 0o700);
  } catch (_) {}
}

function recordsRoot(skillId, explicitRoot) {
  return explicitRoot ? path.resolve(explicitRoot) : getSkillRecordPaths(skillId).skillDir;
}

function redactSensitiveValue(value) {
  let serialized;
  if (typeof value === 'string') serialized = value;
  else {
    try { serialized = JSON.stringify(value); } catch { serialized = String(value); }
  }
  return {
    redacted: true,
    length: serialized.length,
    sha256: crypto.createHash('sha256').update(serialized, 'utf8').digest('hex'),
  };
}

function sanitizeAuditValue(value, key = '', depth = 0) {
  if (depth > 12) return { redacted: true, reason: 'max-depth' };
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (SENSITIVE_KEY.test(key)) return redactSensitiveValue(value);
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => sanitizeAuditValue(item, key, depth + 1));
  if (typeof value !== 'object') return String(value);
  return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
    childKey,
    SENSITIVE_KEY.test(childKey)
      ? redactSensitiveValue(childValue)
      : sanitizeAuditValue(childValue, childKey, depth + 1),
  ]));
}

function appendPrivateJsonLine(filePath, value) {
  ensureDir(path.dirname(filePath));
  const fd = fs.openSync(filePath, 'a', 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(value)}\n`, null, 'utf8');
    try { fs.fchmodSync(fd, 0o600); } catch {}
  } finally {
    fs.closeSync(fd);
  }
  chmodBestEffort(filePath, 0o600);
}

function auditFilePath(skillId, explicitRoot) {
  const dir = path.join(recordsRoot(skillId, explicitRoot), 'audit');
  ensureDir(dir);
  return path.join(dir, 'audit.jsonl');
}

function backupDir(skillId, explicitRoot) {
  const dir = path.join(recordsRoot(skillId, explicitRoot), 'backups');
  ensureDir(dir);
  return dir;
}

/**
 * writeAuditEntry - destructive 工具调用一律走这里，且默认执行深度敏感字段脱敏。
 *
 * @param {object} runContext     createRunContext 返回
 * @param {object} entry
 * @param {string} entry.tool     工具名（如 deepseek_send_message）
 * @param {string} entry.method   bridge 方法名（如 sendMessage）
 * @param {object} entry.args     调用参数
 * @param {object} entry.result   bridge 返回结果
 * @param {string} entry.sideEffect 'reversible' | 'irreversible' | 'cost'
 * @param {string} [entry.backupPath]  irreversible 时写下的 backup 文件路径
 * @returns {string} 实际写入的 audit 文件路径
 */
function writeAuditEntry(runContext, entry) {
  const filePath = auditFilePath(runContext.skillId, runContext.paths?.skillDir);
  const line = {
    ts: new Date().toISOString(),
    run_id: runContext.runId,
    skill_id: runContext.skillId,
    skill_version: runContext.skillVersion || null,
    tool: entry.tool || null,
    method: entry.method || null,
    side_effect: entry.sideEffect || 'reversible',
    args: sanitizeAuditValue(entry.args == null ? {} : entry.args),
    result: sanitizeAuditValue(entry.result == null ? null : entry.result),
    backup_path: entry.backupPath || null,
    target_url: entry.targetUrl || null,
    bridge: entry.bridge || null,
  };
  try {
    appendPrivateJsonLine(filePath, line);
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
  const dir = backupDir(runContext.skillId, runContext.paths?.skillDir);
  const safeId = String(spec.id).replace(/[^\w.-]/g, '_').slice(0, 80);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(dir, `${spec.resource}-${safeId}-${ts}.json`);
  try {
    const payload = JSON.stringify({
      ts: new Date().toISOString(),
      run_id: runContext.runId,
      skill_id: runContext.skillId,
      resource: spec.resource,
      id: spec.id,
      snapshot: sanitizeAuditValue(spec.snapshot == null ? null : spec.snapshot),
    }, null, 2);
    const fd = fs.openSync(filePath, 'w', 0o600);
    try {
      fs.writeSync(fd, payload, null, 'utf8');
      try { fs.fchmodSync(fd, 0o600); } catch {}
    } finally {
      fs.closeSync(fd);
    }
    chmodBestEffort(filePath, 0o600);
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
  sanitizeAuditValue,
};
