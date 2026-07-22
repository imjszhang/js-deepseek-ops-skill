'use strict';

/**
 * lib/skillRecordsReadme.js
 *
 * 在首次工具调用前确保 ~/.js-eyes/skill-records/js-deepseek-ops-skill/ 目录下
 * 有一份 README.md 警示文件，说明这里可能含私密对话内容、不应提交 git、建议
 * 定期清理。
 *
 * 设计取舍：
 * - 全是 best-effort：任何 IO 异常都吞掉，不能阻断工具调用主流程
 * - 进程内只判断/复制一次（CACHE flag），避免每次工具调用都 stat
 * - 模板从 skill 包内 docs/skill-records-README.template.md 复制
 */

const fs = require('fs');
const path = require('path');
const { chmodBestEffort, getSkillRecordPaths } = require('@js-eyes/runtime-paths');

const SKILL_ID = 'js-deepseek-ops-skill';
let ensured = false;

function getRecordsDir() {
  return getSkillRecordPaths(SKILL_ID).skillDir;
}

function hardenRecordsPermissions(root = getRecordsDir()) {
  if (!fs.existsSync(root)) return;
  const visit = (target) => {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      chmodBestEffort(target, 0o700);
      for (const name of fs.readdirSync(target)) visit(path.join(target, name));
    } else if (stat.isFile()) {
      chmodBestEffort(target, 0o600);
    }
  };
  visit(root);
}

function getTemplatePath() {
  return path.join(__dirname, '..', 'docs', 'skill-records-README.template.md');
}

/**
 * 确保 skill-records 目录下存在 README.md 警示文件。
 * 该函数 idempotent，进程内只跑一次。
 */
function ensureSkillRecordsReadme(root) {
  if (ensured) return;
  ensured = true;
  try {
    const dir = root ? path.resolve(root) : getRecordsDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = path.join(dir, 'README.md');
    if (!fs.existsSync(target)) {
      const tmpl = getTemplatePath();
      if (fs.existsSync(tmpl)) {
        const content = fs.readFileSync(tmpl, 'utf8');
        fs.writeFileSync(target, content, { encoding: 'utf8', mode: 0o600 });
      }
    }
    hardenRecordsPermissions(dir);
  } catch (_) {
    /* best-effort */
  }
}

module.exports = { ensureSkillRecordsReadme, getRecordsDir, hardenRecordsPermissions };
