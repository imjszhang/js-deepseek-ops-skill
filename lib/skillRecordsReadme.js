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
const os = require('os');

const SKILL_ID = 'js-deepseek-ops-skill';
let ensured = false;

function getRecordsDir() {
  return path.join(os.homedir(), '.js-eyes', 'skill-records', SKILL_ID);
}

function getTemplatePath() {
  return path.join(__dirname, '..', 'docs', 'skill-records-README.template.md');
}

/**
 * 确保 skill-records 目录下存在 README.md 警示文件。
 * 该函数 idempotent，进程内只跑一次。
 */
function ensureSkillRecordsReadme() {
  if (ensured) return;
  ensured = true;
  try {
    const dir = getRecordsDir();
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'README.md');
    if (!fs.existsSync(target)) {
      const tmpl = getTemplatePath();
      if (fs.existsSync(tmpl)) {
        const content = fs.readFileSync(tmpl, 'utf8');
        fs.writeFileSync(target, content, 'utf8');
      }
    }
  } catch (_) {
    /* best-effort */
  }
}

module.exports = { ensureSkillRecordsReadme, getRecordsDir };
