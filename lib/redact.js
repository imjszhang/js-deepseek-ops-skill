'use strict';

/**
 * lib/redact.js
 *
 * 把 DeepSeek 私聊正文换成可控形态。仅对 deepseek_get_session 的结果套用：
 * - 'off'   （默认）：messages[].content / thinkingContent 替换为 {length, sha256}
 * - 'trunc' ：保留每条正文前 N 个字符（默认 200）+ 省略号
 * - 'full'  ：原样返回（仅 --debug-recording 模式下允许；非 debug 模式静默
 *             降级到 'trunc' 以避免误把整段对话灌进 history/debug bundle）
 *
 * 调用点：
 * - skill.contract.js 的 deepseek_get_session 把 redactMessages 作为
 *   runTool 的 transformResult 传入，所以 redact 同时影响：
 *     1. 写 debug bundle 时的 result 快照
 *     2. 工具最终返回给 LLM 的 result
 * - history.jsonl 不写 result 字段，所以正文本身永远不会进 history.jsonl。
 *
 * 注意：bridge 端 normalizeChatMessage 已经做了一次 shortText 截断（防超大跨
 * 进程传递），那里只是"硬上限"，redact 是在那之后做的"政策"截断/摘要。
 */

const crypto = require('crypto');

const DEFAULT_TRUNC = 200;
const ALLOWED_MODES = new Set(['off', 'trunc', 'full']);

function sha256(input) {
  if (input == null) return null;
  const h = crypto.createHash('sha256');
  h.update(typeof input === 'string' ? input : String(input), 'utf8');
  return h.digest('hex');
}

function resolveEffectiveMode(mode, ctx) {
  const requested = ALLOWED_MODES.has(mode) ? mode : 'off';
  if (requested === 'full' && !(ctx && ctx.debugRecording)) {
    // 非 debug 模式禁止 full，静默降级
    return 'trunc';
  }
  return requested;
}

/**
 * 单条 content 走 redact 策略
 * @param {string|null|undefined} content
 * @param {'off'|'trunc'|'full'} mode
 * @param {number} truncLen
 * @returns {{content:string|null, hash?:string, length:number, mode:string, truncated?:boolean}}
 */
function redactContent(content, mode, truncLen) {
  const effLen = Number.isFinite(truncLen) && truncLen > 0 ? truncLen : DEFAULT_TRUNC;
  if (content == null) {
    return { content: null, length: 0, mode };
  }
  const text = String(content);
  if (mode === 'full') {
    return { content: text, length: text.length, mode };
  }
  if (mode === 'trunc') {
    if (text.length <= effLen) return { content: text, length: text.length, mode, truncated: false };
    return {
      content: text.slice(0, effLen) + '…',
      length: text.length,
      mode,
      truncated: true,
    };
  }
  // 'off'
  return {
    content: null,
    length: text.length,
    mode,
    hash: sha256(text),
  };
}

/**
 * 对 getSession 返回的 messages 数组整体应用 redact。
 *
 * @param {Object} result   bridge 返回的 data 对象
 * @param {Object} options
 * @param {'off'|'trunc'|'full'} options.mode
 * @param {number} [options.truncLen=200]
 * @param {boolean} [options.debugRecording=false]
 * @returns {Object} 新对象，messages[] 中的 content / thinkingContent 已被替换
 */
function redactGetSessionResult(result, options) {
  if (!result || typeof result !== 'object') return result;
  options = options || {};
  const mode = resolveEffectiveMode(options.mode, { debugRecording: !!options.debugRecording });
  const truncLen = options.truncLen || DEFAULT_TRUNC;
  const messages = Array.isArray(result.messages) ? result.messages : [];
  const newMessages = messages.map((m) => {
    if (!m || typeof m !== 'object') return m;
    const c = redactContent(m.content, mode, truncLen);
    const t = redactContent(m.thinkingContent, mode, truncLen);
    return Object.assign({}, m, {
      content: c.content,
      contentHash: c.hash || null,
      contentRedactedMode: c.mode,
      contentRedactedTruncated: !!c.truncated,
      thinkingContent: t.content,
      thinkingContentHash: t.hash || null,
      thinkingContentRedactedMode: t.mode,
      thinkingContentRedactedTruncated: !!t.truncated,
    });
  });
  return Object.assign({}, result, {
    messages: newMessages,
    redact: {
      mode,
      requested: options.mode || 'off',
      truncLen: mode === 'trunc' ? truncLen : null,
      debugRecording: !!options.debugRecording,
      messageCount: newMessages.length,
    },
  });
}

/**
 * 工厂：返回一个 transformResult，喂给 runTool 即可。
 *
 * @param {Object} options
 * @param {'off'|'trunc'|'full'} options.mode
 * @param {number} [options.truncLen]
 * @returns {(result:any, ctx:any)=>any}
 */
function buildGetSessionTransform(options) {
  const opts = options || {};
  return function transformResult(result, ctx) {
    return redactGetSessionResult(result, {
      mode: opts.mode,
      truncLen: opts.truncLen,
      debugRecording: !!(ctx && ctx.debugRecording),
    });
  };
}

module.exports = {
  ALLOWED_MODES,
  DEFAULT_TRUNC,
  redactContent,
  redactGetSessionResult,
  buildGetSessionTransform,
  resolveEffectiveMode,
  sha256,
};
