'use strict';

const {
  createRunId,
  createUrlSkillRunContext,
  resolveRecordingState,
} = require('@js-eyes/skill-recording');

/**
 * 把任意 deepseek URL（含工具占位 URL `deepseek-tool://...`）归一化为
 * cache-key / history input 的稳定形式：去 hash、去 utm_/ref 类追踪参数、
 * 去尾部多余的 `/`。其它 query 参数保留（list-sessions 的 cursor / count 是
 * 业务上可识别的）。
 */
function normalizeDeepseekUrl(inputUrl) {
  const url = new URL(inputUrl);
  url.hash = '';
  for (const key of Array.from(url.searchParams.keys())) {
    if (key.startsWith('utm_') || key === 'ref_source' || key === 'ref') {
      url.searchParams.delete(key);
    }
  }
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  url.pathname = pathname;
  return url.toString();
}

function createRunContext(options) {
  return createUrlSkillRunContext({
    ...options,
    normalizeUrl: normalizeDeepseekUrl,
  });
}

module.exports = {
  createRunContext,
  createRunId,
  normalizeDeepseekUrl,
  resolveRecordingState,
};
