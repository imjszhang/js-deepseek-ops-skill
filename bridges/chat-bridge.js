// bridges/chat-bridge.js
// ---------------------------------------------------------------------------
// DeepSeek Chat 单会话页 bridge。
//
// 暴露 window.__jse_deepseek_chat__ API：
//   __meta = { version, name }
//   probe() / state() / sessionState()
//   getSession({ sessionId?, limit?, contentMaxLen? })
//     - 不传 sessionId 时从 location.pathname 解析当前 chat 页的 id
//     - bridge 端 contentMaxLen 仅做"防超大跨进程传递"截断，真正的隐私
//       redact 由 Node 端 lib/redact.js 处理
//   navigateSession({ sessionId } | { url })
//   navigateHome()
//
// 数据获取：
//   - getSession: GET /api/v0/chat/history_messages?chat_session_id=<uuid>
//
// 修改任意方法后请 bump VERSION，下次 session.ensureBridge 自动重装。
// ---------------------------------------------------------------------------

(function install() {
  'use strict';
  const VERSION = '0.1.0';

  // @@include ./common.js

  const DEFAULT_CONTENT_MAX_LEN = 60000; // 单条消息正文上限（避免 SSE 残留 chunk 巨长）

  async function probe() {
    const url = location.href;
    const sid = parseChatSessionId(url);
    let me = { loggedIn: false, name: null, source: 'api' };
    try { me = await readMeViaApi(false); } catch (_) {}
    const dom = readLoginStateDom();
    return okResult({
      url,
      pathname: location.pathname,
      sessionId: sid,
      login: { api: me, dom, loggedIn: !!(me.loggedIn || dom.loggedIn) },
      timestamp: new Date().toISOString(),
      bridge: { version: VERSION, name: 'chat-bridge' },
    });
  }

  async function state() {
    const url = location.href;
    const sid = parseChatSessionId(url);
    const ready = !!sid;
    return okResult({
      ready,
      reason: ready ? null : 'not_on_chat_page',
      url,
      pathname: location.pathname,
      sessionId: sid,
      bridge: { version: VERSION, name: 'chat-bridge' },
    });
  }

  async function sessionState() {
    return sessionStateCommon();
  }

  async function getSession(args) {
    args = args || {};
    const sid = args.sessionId || parseChatSessionId(location.href);
    if (!sid) {
      return errResult('missing_session_id', { hint: 'pass {sessionId} or open /a/chat/s/<id> first' });
    }
    const path = '/api/v0/chat/history_messages?chat_session_id=' + encodeURIComponent(String(sid));
    const resp = await fetchDeepseekJson(path, { textLimit: 800 });
    const u = unwrapDeepseekResponse(resp);
    if (!u.ok) {
      if (resp && (resp.httpStatus === 401 || resp.httpStatus === 403)) {
        return errResult('not_logged_in', { httpStatus: resp.httpStatus });
      }
      if (resp && resp.httpStatus === 404) {
        return errResult('session_not_found', { httpStatus: resp.httpStatus, sessionId: sid });
      }
      return errResult(u.error || 'fetch_failed', {
        httpStatus: resp ? resp.httpStatus : null,
        bizCode: u.bizCode,
        bizMsg: u.bizMsg,
      });
    }
    const biz = u.biz || {};
    const sess = normalizeChatSessionItem(biz.chat_session) || { id: sid };
    const rawMsgs = Array.isArray(biz.chat_messages) ? biz.chat_messages : [];
    const contentMaxLen = clampLimit(args.contentMaxLen, DEFAULT_CONTENT_MAX_LEN, 200000);
    let msgs = rawMsgs.map((m) => normalizeChatMessage(m, { contentMaxLen })).filter(Boolean);
    let truncatedToLimit = false;
    const limit = clampLimit(args.limit, 0, 1000);
    if (limit > 0 && msgs.length > limit) {
      // 保留最后 limit 条（最近的）
      msgs = msgs.slice(-limit);
      truncatedToLimit = true;
    }
    return okResult({
      session: sess,
      messages: msgs,
      messageCount: rawMsgs.length,
      returnedCount: msgs.length,
      truncatedToLimit,
      contentMaxLen,
      sourceUrl: resp.url,
      timestamp: new Date().toISOString(),
    });
  }

  function navigateHome() {
    return navigateLocation(buildDeepseekUrl('/'));
  }

  function navigateSession(args) {
    args = args || {};
    if (args.url) return navigateLocation(String(args.url));
    const sid = args.sessionId || args.id;
    if (!sid) return errResult('missing_session_id');
    return navigateLocation(buildDeepseekUrl('/a/chat/s/' + encodeURIComponent(String(sid).replace(/^\/+|\/+$/g, ''))));
  }

  const api = {
    __meta: { version: VERSION, name: 'chat-bridge' },
    probe,
    state,
    sessionState,
    getSession,
    navigateHome,
    navigateSession,
  };

  try {
    Object.defineProperty(window, '__jse_deepseek_chat__', { value: api, writable: true, configurable: true });
  } catch (_) {
    window.__jse_deepseek_chat__ = api;
  }
  return { ok: true, version: VERSION, name: 'chat-bridge' };
})();
