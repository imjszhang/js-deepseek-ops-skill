// bridges/common.js
// ---------------------------------------------------------------------------
// 本文件是纯浏览器代码，不要被 Node require。
// 每个 bridge 文件的顶部包含一行：
//   // @@include ./common.js
// session.js 在注入 bridge 前会把这一行替换为本文件全部内容，
// 从而实现 helpers 单一来源（不依赖运行时 module resolution）。
//
// 设计取舍：
// - READ 数据走 DeepSeek 私有 JSON 端点（与浏览器同源，credentials:'include'
//   复用 cookie；额外从 localStorage 取 userToken.value 作为 Authorization
//   Bearer，DeepSeek 需要这个头）。
// - bridge 永不订阅 SSE / EventSource / chat completion stream，避免长生命
//   周期 listener 挂在页面。
// - navigateLocation 硬约束：跨域 URL 一律拒绝（cross_origin_navigation_forbidden）。
// ---------------------------------------------------------------------------

const __jseDeepseekCache = {
  meHref: null,
  me: null,
};

function clampLimit(value, defaultValue, maxValue) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return defaultValue;
  return Math.min(Math.floor(n), maxValue);
}

function shortText(value, maxLen) {
  const text = String(value == null ? '' : value);
  const limit = clampLimit(maxLen, 4000, 100000);
  if (text.length <= limit) return { text, truncated: false, length: text.length };
  return { text: text.slice(0, limit), truncated: true, length: text.length };
}

function unixToIso(secs) {
  if (typeof secs !== 'number' || !Number.isFinite(secs)) return '';
  try { return new Date(secs * 1000).toISOString(); } catch (_) { return ''; }
}

function readUserToken() {
  try {
    const raw = localStorage.getItem('userToken');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.value === 'string' ? parsed.value : null;
  } catch (_) { return null; }
}

/**
 * readDeviceId - 从 localStorage 读 DeepSeek 设备 id，给 /api/v0/client/settings 用。
 * 实测 key 是 `__ds_remote_feature_did`（uuid 形式）。读不到回 null，
 * 调用方通常应判 null 后回 missing_device_id。
 *
 * @returns {string|null}
 */
function readDeviceId() {
  try {
    const v = localStorage.getItem('__ds_remote_feature_did');
    return v && typeof v === 'string' ? v : null;
  } catch (_) { return null; }
}

function buildDeepseekUrl(path) {
  // 强制使用绝对 URL：扩展隔离上下文里相对 URL 会抛 "... is not a valid URL"。
  let origin = 'https://chat.deepseek.com';
  try {
    if (location.origin && /^chat\.deepseek\.com$/i.test(location.hostname)) {
      origin = location.origin;
    }
  } catch (_) {}
  if (!path) return origin + '/';
  return origin + (path.startsWith('/') ? path : '/' + path);
}

async function fetchDeepseekJson(path, options) {
  options = options || {};
  const url = buildDeepseekUrl(path);
  const token = readUserToken();
  const headers = Object.assign({
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  }, options.headers || {});
  if (token && !headers.Authorization) {
    headers['Authorization'] = 'Bearer ' + token;
  }
  let res = null;
  let data = null;
  try {
    const init = {
      method: options.method || 'GET',
      credentials: 'include',
      headers,
      redirect: 'follow',
    };
    if (options.body !== undefined) init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    res = await fetch(url, init);
    const contentType = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
    if (/json/i.test(contentType)) {
      data = await res.json();
    } else {
      const snippet = shortText(await res.text(), options.textLimit || 800);
      data = {
        _nonJson: true,
        contentType,
        text: snippet.text,
        truncated: snippet.truncated,
        length: snippet.length,
      };
    }
  } catch (e) {
    return { ok: false, error: 'network_error', message: String((e && e.message) || e), url };
  }
  return { ok: !!(res && res.ok), httpStatus: res ? res.status : null, url, data };
}

/**
 * unwrapDeepseekResponse - 把 DeepSeek 统一壳子展开。
 *
 * 接口响应都是：
 *   { code: 0, msg: '', data: { biz_code, biz_msg, biz_data } }
 *
 * 只有 code=0 且 biz_code=0 才算业务成功。
 *
 * @returns {{ok:true, biz:any, data:object}|{ok:false, error:string, code?:number, bizCode?:number, bizMsg?:string, raw?:any}}
 */
function unwrapDeepseekResponse(resp) {
  if (!resp) return { ok: false, error: 'empty_response' };
  if (!resp.ok) {
    return {
      ok: false,
      error: 'http_error',
      httpStatus: resp.httpStatus || null,
      raw: resp.data || null,
    };
  }
  const top = resp.data;
  if (!top || typeof top !== 'object') {
    return { ok: false, error: 'malformed_response', raw: top };
  }
  if (top._nonJson) {
    return { ok: false, error: 'non_json_response', raw: top };
  }
  const code = top.code;
  if (code !== 0) {
    return { ok: false, error: 'top_level_error', code, msg: top.msg || '', raw: top };
  }
  const inner = top.data || {};
  const bizCode = inner.biz_code;
  if (bizCode !== 0 && bizCode !== undefined) {
    return { ok: false, error: 'biz_error', bizCode, bizMsg: inner.biz_msg || '', raw: top };
  }
  return { ok: true, biz: inner.biz_data == null ? null : inner.biz_data, data: inner };
}

async function readMeViaApi(force) {
  const href = location.href;
  if (!force && __jseDeepseekCache.meHref === href && __jseDeepseekCache.me) return __jseDeepseekCache.me;
  let info = { loggedIn: false, name: null, email: null, mobile: null, picture: null, source: 'api' };
  try {
    const resp = await fetchDeepseekJson('/api/v0/users/current', { textLimit: 256 });
    const u = unwrapDeepseekResponse(resp);
    if (u.ok && u.biz && typeof u.biz === 'object') {
      const profile = (u.biz.id_profile && typeof u.biz.id_profile === 'object') ? u.biz.id_profile : {};
      info = {
        loggedIn: !!u.biz.id,
        userId: u.biz.id || null,
        name: profile.name || null,
        provider: profile.provider || null,
        picture: profile.picture || null,
        locale: profile.locale || null,
        email: u.biz.email || null,
        mobile: u.biz.mobile_number || null,
        areaCode: u.biz.area_code || null,
        chatMuted: u.biz.chat && u.biz.chat.is_muted ? !!u.biz.chat.is_muted : false,
        hasLegacyChatHistory: !!u.biz.has_legacy_chat_history,
        source: 'api',
      };
    } else if (u.ok && u.biz === null) {
      info = { loggedIn: false, name: null, source: 'api_anon' };
    } else {
      info = { loggedIn: false, name: null, source: 'api_error', error: u.error, httpStatus: resp.httpStatus || null };
    }
  } catch (_) { /* ignore */ }
  __jseDeepseekCache.meHref = href;
  __jseDeepseekCache.me = info;
  return info;
}

function readLoginStateDom() {
  try {
    // DeepSeek 主站 sidebar 里登录后会出现 user-avatar 链接。未登录时 sidebar
    // 入口是登录按钮。这里用粗粒度判断作为 API 不可达时的兜底。
    const userAvatar = document.querySelector('img[src*="/user-avatar/"]');
    if (userAvatar) {
      return { loggedIn: true, name: null, source: 'dom-avatar' };
    }
    // 登录按钮通常带 "登录" / "Sign in" 文案。这里只判断"未明确登录"时算
    // 未登录，避免误判。
    return { loggedIn: false, name: null, source: 'dom-unknown' };
  } catch (_) {}
  return { loggedIn: false, name: null, source: 'unknown' };
}

async function sessionStateCommon() {
  let me = { loggedIn: false, name: null, source: 'api' };
  try { me = await readMeViaApi(false); } catch (_) {}
  const dom = readLoginStateDom();
  return okResult({
    loggedIn: !!(me.loggedIn || dom.loggedIn),
    name: me.name || null,
    userId: me.userId || null,
    provider: me.provider || null,
    picture: me.picture || null,
    email: me.email || null,
    mobile: me.mobile || null,
    areaCode: me.areaCode || null,
    chatMuted: !!me.chatMuted,
    hasLegacyChatHistory: !!me.hasLegacyChatHistory,
    source: me.loggedIn ? 'api' : (dom.loggedIn ? 'dom' : 'none'),
    api: me,
    dom,
    url: location.href,
    timestamp: new Date().toISOString(),
  });
}

/**
 * navigateLocation - INTERACTIVE 档位通用导航：仅 location.assign，绝不模拟点击。
 *
 * 安全约束：
 *   - 必须是 *.deepseek.com（v0.1 实际只允许 chat.deepseek.com，但保留 cdn /
 *     status 等同域弹性）
 *   - 跨域直接 errResult
 *   - to === fromUrl 时返回 noop（不重新触发 reload）
 *
 * @param {string} targetUrl
 * @returns {{ok:true, data:{noop:boolean, from:{url:string}, to:{url:string}, hint:string}}|{ok:false,error:string}}
 */
function navigateLocation(targetUrl) {
  const fromUrl = location.href;
  if (typeof targetUrl !== 'string' || !targetUrl) {
    return errResult('missing_target_url');
  }
  let parsed;
  try { parsed = new URL(targetUrl, location.href); } catch (_) {
    return errResult('invalid_target_url', { targetUrl });
  }
  if (!/(?:^|\.)deepseek\.com$/i.test(parsed.hostname)) {
    return errResult('cross_origin_navigation_forbidden', { hostname: parsed.hostname });
  }
  const to = parsed.toString();
  if (to === fromUrl) {
    return okResult({ noop: true, from: { url: fromUrl }, to: { url: to }, hint: 'already_at_target' });
  }
  try {
    location.assign(to);
  } catch (e) {
    return errResult('location_assign_threw', {
      message: String((e && e.message) || e),
      from: { url: fromUrl },
      to: { url: to },
    });
  }
  return okResult({ noop: false, from: { url: fromUrl }, to: { url: to }, hint: 'page_will_reload' });
}

function parseChatSessionId(url) {
  try {
    const u = new URL(url || location.href);
    const m = /^\/a\/chat\/s\/([\w-]+)/i.exec(u.pathname);
    return m ? m[1] : null;
  } catch (_) { return null; }
}

/**
 * parseChatSessionIdStrict - 严格匹配 /a/chat/s/<uuid>，不允许任何后缀路径段。
 * INTERACTIVE 校验 / sessionId 与 URL 一致性校验用，避免被 /a/chat/s/<id>/foo 这种
 * 形态误判为同一会话。
 *
 * @param {string} url
 * @returns {string|null}
 */
function parseChatSessionIdStrict(url) {
  try {
    const u = new URL(url || location.href);
    const m = /^\/a\/chat\/s\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i.exec(u.pathname);
    return m ? m[1] : null;
  } catch (_) { return null; }
}

/**
 * digestText - 对 composer 草稿等敏感文本做 SHA-256 摘要，永不出原文。
 * 异步包装 crypto.subtle；不可用时 fallback 到 length-only。
 *
 * @param {string} text
 * @returns {Promise<{length:number, sha256:string|null}>}
 */
async function digestText(text) {
  const s = String(text == null ? '' : text);
  const length = s.length;
  try {
    if (typeof crypto !== 'undefined' && crypto.subtle && typeof TextEncoder !== 'undefined') {
      const buf = new TextEncoder().encode(s);
      const hash = await crypto.subtle.digest('SHA-256', buf);
      const bytes = new Uint8Array(hash);
      let hex = '';
      for (let i = 0; i < bytes.length; i++) {
        const h = bytes[i].toString(16);
        hex += h.length === 1 ? '0' + h : h;
      }
      return { length, sha256: hex };
    }
  } catch (_) {}
  return { length, sha256: null };
}

/**
 * pickLatestStreamingMessage - 从 chat_messages[] 找 status='STREAMING' 的最近一条。
 * 注意：传入的是已 normalize 过的列表（字段是 status / messageId / role / insertedAt）。
 *
 * @param {Array} messages
 * @returns {{messageId:number|null, role:string, insertedAt:string}|null}
 */
function pickLatestStreamingMessage(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  let chosen = null;
  for (const m of messages) {
    if (!m || m.status !== 'STREAMING') continue;
    if (!chosen) { chosen = m; continue; }
    const a = chosen.messageId == null ? -1 : chosen.messageId;
    const b = m.messageId == null ? -1 : m.messageId;
    if (b > a) chosen = m;
  }
  if (!chosen) return null;
  return {
    messageId: chosen.messageId,
    role: chosen.role,
    insertedAt: chosen.insertedAt,
  };
}

/**
 * summarizeMessageMeta - 把 normalizeChatMessage 的输出剥掉 content / thinkingContent
 * 两个字段，list_messages 专用，避免任何正文跨进程传递。
 *
 * @param {object} m  normalizeChatMessage(...) 的返回
 * @returns {object|null}
 */
function summarizeMessageMeta(m) {
  if (!m || typeof m !== 'object') return null;
  return {
    messageId: m.messageId,
    parentId: m.parentId,
    model: m.model,
    role: m.role,
    status: m.status,
    thinkingEnabled: m.thinkingEnabled,
    searchEnabled: m.searchEnabled,
    banEdit: m.banEdit,
    banRegenerate: m.banRegenerate,
    accumulatedTokenUsage: m.accumulatedTokenUsage,
    files: m.files,
    feedback: m.feedback,
    insertedAt: m.insertedAt,
    contentLength: m.contentLength,
    contentTruncated: m.contentTruncated,
    hasThinking: !!(m.thinkingContent || m.thinkingContentLength > 0),
    thinkingContentLength: m.thinkingContentLength,
    thinkingContentTruncated: m.thinkingContentTruncated,
    thinkingElapsedSecs: m.thinkingElapsedSecs,
    searchStatus: m.searchStatus,
    searchResultsCount: m.searchResultsCount,
  };
}

/**
 * readChatPageDom - 一次性 querySelector，读 chat 页 UI 状态。
 * 永不回 composer 原文：textarea 的 value 仅取 length + sha256。
 *
 * 注意：实际 selector 可能随 DeepSeek 改版漂移，所有 selector 都是宽容失败的，
 * 找不到时对应字段回 null / 0 / false。
 *
 * @returns {Promise<{
 *   composer:{length:number, sha256:string|null, present:boolean},
 *   streamingDom:boolean,
 *   scrollAtBottom:boolean,
 *   titleText:string|null,
 *   visibleMessageCount:number
 * }>}
 */
async function readChatPageDom() {
  let composerLen = 0;
  let composerSha = null;
  let composerPresent = false;
  try {
    const ta = document.querySelector('textarea');
    if (ta) {
      composerPresent = true;
      const d = await digestText(ta.value || '');
      composerLen = d.length;
      composerSha = d.sha256;
    }
  } catch (_) {}

  let streamingDom = false;
  try {
    if (document.querySelector('[data-status="STREAMING"], [data-message-status="STREAMING"], .ds-streaming, .is-streaming')) {
      streamingDom = true;
    }
  } catch (_) {}

  let scrollAtBottom = false;
  try {
    const scroller = document.querySelector('[class*="scroll"], main, [role="main"]');
    if (scroller) {
      const slack = 8;
      scrollAtBottom = (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight) <= slack;
    }
  } catch (_) {}

  let titleText = null;
  try { titleText = (document.title || '').trim() || null; } catch (_) {}

  let visibleMessageCount = 0;
  try {
    const nodes = document.querySelectorAll('[data-message-id], [data-msg-id], [class*="message-item"]');
    visibleMessageCount = nodes ? nodes.length : 0;
  } catch (_) {}

  return {
    composer: { length: composerLen, sha256: composerSha, present: composerPresent },
    streamingDom,
    scrollAtBottom,
    titleText,
    visibleMessageCount,
  };
}

function normalizeChatSessionItem(s) {
  if (!s || typeof s !== 'object') return null;
  return {
    id: s.id || '',
    seqId: typeof s.seq_id === 'number' ? s.seq_id : null,
    title: typeof s.title === 'string' ? s.title : '',
    titleType: typeof s.title_type === 'string' ? s.title_type : '',
    pinned: !!s.pinned,
    modelType: typeof s.model_type === 'string' ? s.model_type : '',
    agent: typeof s.agent === 'string' ? s.agent : '',
    version: typeof s.version === 'number' ? s.version : null,
    currentMessageId: typeof s.current_message_id === 'number' ? s.current_message_id : null,
    updatedAt: unixToIso(s.updated_at),
    createdAt: unixToIso(s.inserted_at),
  };
}

/**
 * normalizeChatMessage - 标准化单条聊天消息。
 *
 * options.contentMaxLen 控制 bridge 端的截断（避免超大正文跨进程传到 Node
 * 端被序列化截断）。这里 bridge 永远只做一次"防超大"截断；
 * 真正的 redact / hash 由 Node 端 lib/redact.js 处理。
 */
function normalizeChatMessage(m, options) {
  if (!m || typeof m !== 'object') return null;
  options = options || {};
  const contentMaxLen = options.contentMaxLen || 60000;
  const c = shortText(m.content, contentMaxLen);
  const t = m.thinking_content == null ? null : shortText(m.thinking_content, contentMaxLen);
  return {
    messageId: typeof m.message_id === 'number' ? m.message_id : null,
    parentId: m.parent_id == null ? null : (typeof m.parent_id === 'number' ? m.parent_id : null),
    model: typeof m.model === 'string' ? m.model : '',
    role: typeof m.role === 'string' ? m.role : '',
    status: typeof m.status === 'string' ? m.status : '',
    thinkingEnabled: !!m.thinking_enabled,
    searchEnabled: !!m.search_enabled,
    banEdit: !!m.ban_edit,
    banRegenerate: !!m.ban_regenerate,
    accumulatedTokenUsage: typeof m.accumulated_token_usage === 'number' ? m.accumulated_token_usage : null,
    files: Array.isArray(m.files) ? m.files.length : 0,
    feedback: m.feedback == null ? null : (typeof m.feedback === 'object' ? Object.keys(m.feedback).length > 0 : true),
    insertedAt: unixToIso(m.inserted_at),
    content: c.text,
    contentLength: c.length,
    contentTruncated: c.truncated,
    thinkingContent: t ? t.text : null,
    thinkingContentLength: t ? t.length : 0,
    thinkingContentTruncated: t ? t.truncated : false,
    thinkingElapsedSecs: typeof m.thinking_elapsed_secs === 'number' ? m.thinking_elapsed_secs : null,
    searchStatus: m.search_status || null,
    searchResultsCount: Array.isArray(m.search_results) ? m.search_results.length : (m.search_results == null ? 0 : -1),
  };
}

function okResult(data) { return { ok: true, data }; }
function errResult(error, extra) { return Object.assign({ ok: false, error: String(error) }, extra || {}); }
