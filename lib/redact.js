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

// v0.4.2 起：默认 = 'full'，不再有"非 debug 静默降级到 trunc"的护栏。
// 本 skill 是单用户本地自用工具，输出由 caller 自己处理；user 显式要求关掉 guardrail。
// 'off' / 'trunc' 仍然按字面生效，便于调试与示例。
function resolveEffectiveMode(mode, _ctx) {
  return ALLOWED_MODES.has(mode) ? mode : 'full';
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

/**
 * 对 getMessage 返回的单条 message 应用 redact。
 *
 * @param {Object} result   bridge 返回的 data 对象，期望含 .message
 * @param {Object} options  与 redactGetSessionResult 相同
 * @returns {Object}
 */
function redactGetMessageResult(result, options) {
  if (!result || typeof result !== 'object') return result;
  options = options || {};
  const mode = resolveEffectiveMode(options.mode, { debugRecording: !!options.debugRecording });
  const truncLen = options.truncLen || DEFAULT_TRUNC;
  const m = result.message;
  if (!m || typeof m !== 'object') {
    return Object.assign({}, result, {
      redact: {
        mode,
        requested: options.mode || 'off',
        truncLen: mode === 'trunc' ? truncLen : null,
        debugRecording: !!options.debugRecording,
        messageCount: 0,
      },
    });
  }
  const c = redactContent(m.content, mode, truncLen);
  const t = redactContent(m.thinkingContent, mode, truncLen);
  const newMessage = Object.assign({}, m, {
    content: c.content,
    contentHash: c.hash || null,
    contentRedactedMode: c.mode,
    contentRedactedTruncated: !!c.truncated,
    thinkingContent: t.content,
    thinkingContentHash: t.hash || null,
    thinkingContentRedactedMode: t.mode,
    thinkingContentRedactedTruncated: !!t.truncated,
  });
  return Object.assign({}, result, {
    message: newMessage,
    redact: {
      mode,
      requested: options.mode || 'off',
      truncLen: mode === 'trunc' ? truncLen : null,
      debugRecording: !!options.debugRecording,
      messageCount: 1,
    },
  });
}

function buildGetMessageTransform(options) {
  const opts = options || {};
  return function transformResult(result, ctx) {
    return redactGetMessageResult(result, {
      mode: opts.mode,
      truncLen: opts.truncLen,
      debugRecording: !!(ctx && ctx.debugRecording),
    });
  };
}

/**
 * buildListMessagesTransform - no-op + 防漏断言。
 *
 * list_messages 永远不应包含 content / thinkingContent；如果未来 bridge 改动
 * 误把正文塞进 messages[]，这里会硬剥并打 warn 到 stderr，避免静默泄漏。
 */
function buildListMessagesTransform() {
  return function transformResult(result, _ctx) {
    if (!result || typeof result !== 'object') return result;
    const messages = Array.isArray(result.messages) ? result.messages : null;
    if (!messages) return result;
    let leaked = 0;
    const cleaned = messages.map((m) => {
      if (!m || typeof m !== 'object') return m;
      let copy = m;
      if (Object.prototype.hasOwnProperty.call(m, 'content') && m.content != null && m.content !== '') {
        leaked++;
        copy = Object.assign({}, copy);
        copy.content = null;
        copy._leakedContent = true;
      }
      if (Object.prototype.hasOwnProperty.call(m, 'thinkingContent') && m.thinkingContent != null && m.thinkingContent !== '') {
        leaked++;
        copy = copy === m ? Object.assign({}, copy) : copy;
        copy.thinkingContent = null;
        copy._leakedThinking = true;
      }
      return copy;
    });
    if (leaked > 0) {
      try {
        process.stderr.write(`[deepseek-redact] list_messages leaked ${leaked} content fields; bridge VERSION may need bump\n`);
      } catch (_) {}
    }
    return Object.assign({}, result, {
      messages: cleaned,
      redact: { mode: 'list_meta_only', leaked, requested: 'meta' },
    });
  };
}

/**
 * 对 getSessionTree 返回的全树 nodes map 应用 redact。
 *
 * v0.4.0：tree.nodes 是 { [messageId]: MessageNode }，每 node 含与 getSession
 * 同款 content / thinkingContent；这里复用 redactContent，逐 node 替换。
 */
function redactSessionTreeResult(result, options) {
  if (!result || typeof result !== 'object') return result;
  options = options || {};
  const mode = resolveEffectiveMode(options.mode, { debugRecording: !!options.debugRecording });
  const truncLen = options.truncLen || DEFAULT_TRUNC;
  const nodes = result.nodes && typeof result.nodes === 'object' ? result.nodes : null;
  if (!nodes) {
    return Object.assign({}, result, {
      redact: { mode, requested: options.mode || 'off', truncLen: mode === 'trunc' ? truncLen : null, debugRecording: !!options.debugRecording, messageCount: 0 },
    });
  }
  const newNodes = Object.create(null);
  let count = 0;
  for (const k in nodes) {
    const n = nodes[k];
    if (!n || typeof n !== 'object') { newNodes[k] = n; continue; }
    const c = redactContent(n.content, mode, truncLen);
    const t = redactContent(n.thinkingContent, mode, truncLen);
    newNodes[k] = Object.assign({}, n, {
      content: c.content,
      contentHash: c.hash || null,
      contentRedactedMode: c.mode,
      contentRedactedTruncated: !!c.truncated,
      thinkingContent: t.content,
      thinkingContentHash: t.hash || null,
      thinkingContentRedactedMode: t.mode,
      thinkingContentRedactedTruncated: !!t.truncated,
    });
    count++;
  }
  return Object.assign({}, result, {
    nodes: newNodes,
    redact: {
      mode, requested: options.mode || 'off',
      truncLen: mode === 'trunc' ? truncLen : null,
      debugRecording: !!options.debugRecording, messageCount: count,
    },
  });
}

function buildGetSessionTreeTransform(options) {
  const opts = options || {};
  return function transformResult(result, ctx) {
    return redactSessionTreeResult(result, {
      mode: opts.mode, truncLen: opts.truncLen,
      debugRecording: !!(ctx && ctx.debugRecording),
    });
  };
}

/**
 * getBranchPath 输出 schema 与 getSession 兼容（messages[]），直接复用。
 */
function buildGetBranchPathTransform(options) {
  return buildGetSessionTransform(options);
}

/**
 * listBranchPoints 永远不应包含正文。这里做防漏断言（同 buildListMessagesTransform）。
 * branchPoints[].children[] 上若意外出现 content / thinkingContent 则硬剥并 stderr warn。
 */
function buildListBranchPointsTransform() {
  return function transformResult(result, _ctx) {
    if (!result || typeof result !== 'object') return result;
    const bps = Array.isArray(result.branchPoints) ? result.branchPoints : null;
    if (!bps) return result;
    let leaked = 0;
    const cleaned = bps.map((bp) => {
      if (!bp || typeof bp !== 'object') return bp;
      const children = Array.isArray(bp.children) ? bp.children.map((c) => {
        if (!c || typeof c !== 'object') return c;
        let copy = c;
        if (Object.prototype.hasOwnProperty.call(c, 'content') && c.content != null && c.content !== '') {
          leaked++;
          copy = Object.assign({}, copy, { content: null, _leakedContent: true });
        }
        if (Object.prototype.hasOwnProperty.call(c, 'thinkingContent') && c.thinkingContent != null && c.thinkingContent !== '') {
          leaked++;
          copy = Object.assign({}, copy, { thinkingContent: null, _leakedThinking: true });
        }
        return copy;
      }) : bp.children;
      return Object.assign({}, bp, { children });
    });
    if (leaked > 0) {
      try {
        process.stderr.write(`[deepseek-redact] list_branch_points leaked ${leaked} content fields; bridge VERSION may need bump\n`);
      } catch (_) {}
    }
    return Object.assign({}, result, {
      branchPoints: cleaned,
      redact: { mode: 'list_meta_only', leaked, requested: 'meta' },
    });
  };
}

module.exports = {
  ALLOWED_MODES,
  DEFAULT_TRUNC,
  redactContent,
  redactGetSessionResult,
  redactGetMessageResult,
  redactSessionTreeResult,
  buildGetSessionTransform,
  buildGetMessageTransform,
  buildListMessagesTransform,
  buildGetSessionTreeTransform,
  buildGetBranchPathTransform,
  buildListBranchPointsTransform,
  resolveEffectiveMode,
  sha256,
};
