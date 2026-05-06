'use strict';

/**
 * 把工具参数翻译成"理想的浏览器 URL"。
 *
 * 用途：
 *   1. INTERACTIVE 工具 navigate 时拼 location.assign 的目标 URL；
 *   2. READ 工具默认 navigateOnReuse=false，所以这些 URL 仅在用户没有任何
 *      deepseek tab 时被 createUrl 用来打开新 tab。
 *
 * 注意：v0.1 不暴露任何带 query 参数的导航（避免在 INTERACTIVE 档误改"深度
 * 思考"/"联网搜索"等 toggle 的 URL state，而这些 toggle 实际是改下一次请求
 * 语义，属 DESTRUCTIVE）。所以这里只有最干净的两种路径。
 */

const ORIGIN = 'https://chat.deepseek.com';

function safeSeg(value) {
  return encodeURIComponent(String(value || '').replace(/^\/+|\/+$/g, ''));
}

function homeUrl() {
  return `${ORIGIN}/`;
}

function chatSessionUrl(args) {
  const id = args && (args.sessionId || args.id);
  if (!id) return homeUrl();
  return `${ORIGIN}/a/chat/s/${safeSeg(id)}`;
}

/**
 * chatNewUrl - 新对话目标 URL。语义上区别于 homeUrl：
 *   homeUrl  → 主页（用户视角）
 *   chatNewUrl → 起新对话（AI/工具视角）
 * 两者实际指向同一 URL；DeepSeek 是首次发消息才落 sessionId，导航本身无副作用。
 */
function chatNewUrl() {
  return `${ORIGIN}/`;
}

module.exports = {
  ORIGIN,
  homeUrl,
  chatSessionUrl,
  chatNewUrl,
};
