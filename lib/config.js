'use strict';

const path = require('path');

const DEFAULT_WS_ENDPOINT = process.env.JS_EYES_SERVER_URL
  || process.env.JS_EYES_WS_URL
  || (process.env.JS_EYES_SERVER_HOST || process.env.JS_EYES_SERVER_PORT
        ? `ws://${process.env.JS_EYES_SERVER_HOST || 'localhost'}:${process.env.JS_EYES_SERVER_PORT || 18080}`
        : 'ws://localhost:18080');

const DEFAULT_PAGE = process.env.JS_DEEPSEEK_DEFAULT_PAGE || 'home';

// 路径正则按踩点结果（v0.1）：
//   - chat 单会话：/a/chat/s/<uuid>
//   - home / 新对话：/  或者 /a (登录态后默认会重定向)
const CHAT_PATH_RE = /^\/a\/chat\/s\/[\w-]+\/?(?:$|\?|#)/i;
const HOME_PATH_RE = /^\/(?:a\/?)?(?:$|\?|#)/i;
const DEEPSEEK_HOST_RE = /(?:^|\.)deepseek\.com$/i;

function _activeBoost(tab) { return tab && tab.is_active ? 1000 : 0; }

function _deepseekPath(tab) {
  try {
    const u = new URL((tab && tab.url) || '');
    if (!DEEPSEEK_HOST_RE.test(u.hostname)) return null;
    // 仅 chat.deepseek.com 子域命中（排除 cdn / fe-static / api 等）
    if (!/^chat\.deepseek\.com$/i.test(u.hostname)) return null;
    return { url: u, path: u.pathname };
  } catch (_) { return null; }
}

const PAGE_PROFILES = {
  home: {
    name: 'home',
    targetUrlFragment: 'chat.deepseek.com/',
    bridgePath: path.join(__dirname, '..', 'bridges', 'home-bridge.js'),
    bridgeGlobal: '__jse_deepseek_home__',
    routeLabel: '/ (新对话 / 着陆页)',
    description: 'DeepSeek Chat 着陆页 / 新对话页',
    score(tab) {
      const r = _deepseekPath(tab);
      if (!r) return 0;
      let s = 0;
      if (HOME_PATH_RE.test(r.path) && !CHAT_PATH_RE.test(r.path)) s += 500;
      else s += 50;
      s += _activeBoost(tab);
      return s;
    },
  },
  chat: {
    name: 'chat',
    targetUrlFragment: 'chat.deepseek.com/a/chat/s/<id>',
    bridgePath: path.join(__dirname, '..', 'bridges', 'chat-bridge.js'),
    bridgeGlobal: '__jse_deepseek_chat__',
    routeLabel: '/a/chat/s/<sessionId>',
    description: 'DeepSeek Chat 单会话页',
    score(tab) {
      const r = _deepseekPath(tab);
      if (!r) return 0;
      let s = 0;
      if (CHAT_PATH_RE.test(r.path)) s += 500;
      else s += 50;
      s += _activeBoost(tab);
      return s;
    },
  },
};

function getPageProfile(name) {
  const key = name || DEFAULT_PAGE;
  const profile = PAGE_PROFILES[key];
  if (!profile) {
    const err = new Error(
      `未知 page profile: ${key}；可选: ${Object.keys(PAGE_PROFILES).join(' | ')}`,
    );
    err.code = 'E_BAD_ARG';
    throw err;
  }
  return profile;
}

module.exports = {
  DEFAULT_WS_ENDPOINT,
  DEFAULT_PAGE,
  PAGE_PROFILES,
  getPageProfile,
  DEEPSEEK_HOST_RE,
  CHAT_PATH_RE,
  HOME_PATH_RE,
};
