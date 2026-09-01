// lib/composerOptions.js
// ---------------------------------------------------------------------------
// 新对话 composer 参数归一化（dual-mode）：
//   - Node：require 后单测 / CLI
//   - Browser：bridges 通过 // @@include ../lib/composerOptions.js 嵌入 IIFE
// 缺省字段保持 undefined，表示「不改页面当前状态」。
// ---------------------------------------------------------------------------

const COMPOSER_MODE_ALIASES = {
  default: 'default',
  fast: 'default',
  '快速': 'default',
  '快速模式': 'default',
  expert: 'expert',
  '专家': 'expert',
  '专家模式': 'expert',
  vision: 'vision',
  '识图': 'vision',
  '识图模式': 'vision',
};

const COMPOSER_MODE_LABELS = {
  default: '快速模式',
  expert: '专家模式',
  vision: '识图模式',
};

function resolveComposerMode(raw) {
  if (raw == null) return undefined;
  const key = String(raw).trim();
  if (!key) return undefined;
  const hit = COMPOSER_MODE_ALIASES[key] || COMPOSER_MODE_ALIASES[key.toLowerCase()];
  return hit || null;
}

/**
 * @param {object} args
 * @returns {{ ok: true, value: { mode?: string, thinking?: boolean, search?: boolean } } | { ok: false, error: string, raw?: any }}
 */
function normalizeComposerArgs(args) {
  const src = args && typeof args === 'object' ? args : {};
  const value = {};
  if (src.mode != null && src.mode !== '') {
    const mode = resolveComposerMode(src.mode);
    if (!mode) return { ok: false, error: 'unknown_mode', raw: src.mode };
    value.mode = mode;
  }
  if (src.thinking !== undefined && src.thinking !== null) value.thinking = !!src.thinking;
  if (src.search !== undefined && src.search !== null) value.search = !!src.search;
  return { ok: true, value };
}

/**
 * @param {{ mode?: string, thinking?: boolean, search?: boolean }} opts
 * @returns {{ ok: true } | { ok: false, error: string, mode?: string }}
 */
function assertComposerOptions(opts) {
  const o = opts || {};
  if (o.mode === 'expert' && o.search === true) {
    return { ok: false, error: 'search_not_available_in_mode', mode: 'expert' };
  }
  return { ok: true };
}

function hasComposerApply(opts) {
  const o = opts || {};
  return o.mode !== undefined || o.thinking !== undefined || o.search !== undefined;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    COMPOSER_MODE_ALIASES,
    COMPOSER_MODE_LABELS,
    resolveComposerMode,
    normalizeComposerArgs,
    assertComposerOptions,
    hasComposerApply,
  };
}
