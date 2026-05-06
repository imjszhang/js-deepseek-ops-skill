// bridges/home-bridge.js
// ---------------------------------------------------------------------------
// DeepSeek Chat 主页（着陆页 / 新对话页）bridge。
//
// 暴露 window.__jse_deepseek_home__ API：
//   __meta = { version, name }
//   probe() / state() / sessionState()
//   listSessions({ limit?, beforeSeqId? })
//   navigateHome()
//   navigateSession({ sessionId } | { url })   // 仍允许从 home 跳到具体会话
//
// 数据获取：
//   - listSessions: GET /api/v0/chat_session/fetch_page?count=N
//     可选 before_seq_id 作为分页游标（v0.1 仅做最简实现，分页在 v0.2 完善）
//   - sessionState: GET /api/v0/users/current
//
// 修改任意方法后请 bump VERSION，下次 session.ensureBridge 自动重装。
// ---------------------------------------------------------------------------

(function install() {
  'use strict';
  const VERSION = '0.2.0';

  // @@include ./common.js

  const DEFAULT_LIST_LIMIT = 25;
  const MAX_LIST_LIMIT = 100;

  async function probe() {
    const url = location.href;
    let me = { loggedIn: false, name: null, source: 'api' };
    try { me = await readMeViaApi(false); } catch (_) {}
    const dom = readLoginStateDom();
    return okResult({
      url,
      pathname: location.pathname,
      login: { api: me, dom, loggedIn: !!(me.loggedIn || dom.loggedIn) },
      timestamp: new Date().toISOString(),
      bridge: { version: VERSION, name: 'home-bridge' },
    });
  }

  async function state() {
    const url = location.href;
    const path = location.pathname;
    // home 状态判定：在 chat.deepseek.com 域内、不在 /a/chat/s/<id> 上即可
    const onHome = !/^\/a\/chat\/s\//i.test(path);
    return okResult({
      ready: onHome,
      reason: onHome ? null : 'not_on_home_page',
      url,
      pathname: path,
      bridge: { version: VERSION, name: 'home-bridge' },
    });
  }

  async function sessionState() {
    return sessionStateCommon();
  }

  async function listSessions(args) {
    args = args || {};
    const limit = clampLimit(args.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const beforeSeqId = args.beforeSeqId != null ? String(args.beforeSeqId) : null;
    let path = '/api/v0/chat_session/fetch_page?count=' + encodeURIComponent(limit);
    if (beforeSeqId) path += '&before_seq_id=' + encodeURIComponent(beforeSeqId);
    const resp = await fetchDeepseekJson(path, { textLimit: 800 });
    const u = unwrapDeepseekResponse(resp);
    if (!u.ok) {
      // 401 / 未登录优雅降级
      if (resp && (resp.httpStatus === 401 || resp.httpStatus === 403)) {
        return errResult('not_logged_in', { httpStatus: resp.httpStatus });
      }
      return errResult(u.error || 'fetch_failed', {
        httpStatus: resp ? resp.httpStatus : null,
        bizCode: u.bizCode,
        bizMsg: u.bizMsg,
      });
    }
    const biz = u.biz || {};
    const rawList = Array.isArray(biz.chat_sessions) ? biz.chat_sessions : [];
    const items = rawList.map(normalizeChatSessionItem).filter(Boolean);
    return okResult({
      items,
      hasMore: !!biz.has_more,
      returnedCount: items.length,
      requestedLimit: limit,
      cursor: items.length ? { beforeSeqId: items[items.length - 1].seqId } : null,
      sourceUrl: resp.url,
      timestamp: new Date().toISOString(),
    });
  }

  function navigateHome() {
    return navigateLocation(buildDeepseekUrl('/'));
  }

  /**
   * navigateNewChat - INTERACTIVE 别名：与 navigateHome 同 URL，仅语义不同。
   * 不调用 chat_session/create；DeepSeek 是首次发消息才落 sessionId，无副作用。
   */
  function navigateNewChat() {
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
    __meta: { version: VERSION, name: 'home-bridge' },
    probe,
    state,
    sessionState,
    listSessions,
    navigateHome,
    navigateNewChat,
    navigateSession,
  };

  try {
    Object.defineProperty(window, '__jse_deepseek_home__', { value: api, writable: true, configurable: true });
  } catch (_) {
    window.__jse_deepseek_home__ = api;
  }
  return { ok: true, version: VERSION, name: 'home-bridge' };
})();
