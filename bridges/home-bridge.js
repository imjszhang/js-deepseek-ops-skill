// bridges/home-bridge.js
// ---------------------------------------------------------------------------
// DeepSeek Chat 主页 bridge（v0.3.0 — DESTRUCTIVE 解锁）。
//
// 暴露 window.__jse_deepseek_home__ API：
//   READ: probe / state / sessionState / listSessions
//   INTERACTIVE: navigateHome / navigateNewChat / navigateSession
//   DESTRUCTIVE: createSession / renameSession / pinSession / unpinSession /
//                deleteSession / shareSession / unshareSession / listShares /
//                updateUserSettings
//
// home 与 chat bridge 共用大部分 destructive 实现（端点不依赖当前 URL）；
// 这里只重复 mass action 子集，避免 LLM 必须先 navigate 到会话页才能管理。
//
// DESTRUCTIVE 档位约定与 chat-bridge 一致（详见 chat-bridge.js）。
// ---------------------------------------------------------------------------

(function install() {
  'use strict';
  const VERSION = '0.3.2';

  // @@include ./common.js

  const DEFAULT_LIST_LIMIT = 25;
  const MAX_LIST_LIMIT = 100;

  async function probe() {
    const url = location.href;
    let me = { loggedIn: false, name: null, source: 'api' };
    try { me = await readMeViaApi(false); } catch (_) {}
    const dom = readLoginStateDom();
    return okResult({
      url, pathname: location.pathname,
      login: { api: me, dom, loggedIn: !!(me.loggedIn || dom.loggedIn) },
      timestamp: new Date().toISOString(),
      bridge: { version: VERSION, name: 'home-bridge' },
    });
  }

  async function state() {
    const url = location.href;
    const path = location.pathname;
    const onHome = !/^\/a\/chat\/s\//i.test(path);
    return okResult({ ready: onHome, reason: onHome ? null : 'not_on_home_page', url, pathname: path, bridge: { version: VERSION, name: 'home-bridge' } });
  }

  async function sessionState() { return sessionStateCommon(); }

  async function listSessions(args) {
    args = args || {};
    const limit = clampLimit(args.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const beforeSeqId = args.beforeSeqId != null ? String(args.beforeSeqId) : null;
    let path = '/api/v0/chat_session/fetch_page?count=' + encodeURIComponent(limit);
    if (beforeSeqId) path += '&before_seq_id=' + encodeURIComponent(beforeSeqId);
    const resp = await fetchDeepseekJson(path, { textLimit: 800 });
    const u = unwrapDeepseekResponse(resp);
    if (!u.ok) {
      if (resp && (resp.httpStatus === 401 || resp.httpStatus === 403)) {
        return errResult('not_logged_in', { httpStatus: resp.httpStatus });
      }
      return errResult(u.error || 'fetch_failed', { httpStatus: resp ? resp.httpStatus : null, bizCode: u.bizCode, bizMsg: u.bizMsg });
    }
    const biz = u.biz || {};
    const rawList = Array.isArray(biz.chat_sessions) ? biz.chat_sessions : [];
    const items = rawList.map(normalizeChatSessionItem).filter(Boolean);
    return okResult({
      items, hasMore: !!biz.has_more, returnedCount: items.length, requestedLimit: limit,
      cursor: items.length ? { beforeSeqId: items[items.length - 1].seqId } : null,
      sourceUrl: resp.url, timestamp: new Date().toISOString(),
    });
  }

  function navigateHome() { return navigateLocation(buildDeepseekUrl('/')); }
  function navigateNewChat() { return navigateLocation(buildDeepseekUrl('/')); }
  function navigateSession(args) {
    args = args || {};
    if (args.url) return navigateLocation(String(args.url));
    const sid = args.sessionId || args.id;
    if (!sid) return errResult('missing_session_id');
    return navigateLocation(buildDeepseekUrl('/a/chat/s/' + encodeURIComponent(String(sid).replace(/^\/+|\/+$/g, ''))));
  }

  // ---- DESTRUCTIVE（与 chat-bridge 对齐子集） ----

  async function createSession(args) {
    args = args || {};
    const body = {};
    if (args.agent) body.agent = String(args.agent);
    if (args.character_id) body.character_id = String(args.character_id);
    const resp = await fetchDeepseekJson('/api/v0/chat_session/create', { method: 'POST', body, textLimit: 800 });
    const u = unwrapDeepseekResponse(resp);
    if (!u.ok) return errResult(u.error || 'fetch_failed', { httpStatus: resp.httpStatus, bizCode: u.bizCode, bizMsg: u.bizMsg });
    const sess = normalizeChatSessionItem(u.biz) || (u.biz && { id: u.biz.id });
    return okResult({ session: sess, sessionId: (sess && sess.id) || null, raw: u.biz, sourceUrl: resp.url, timestamp: new Date().toISOString() });
  }

  async function renameSession(args) {
    args = args || {};
    const sid = args.sessionId; const title = args.title;
    if (!sid) return errResult('missing_session_id');
    if (typeof title !== 'string' || !title.length) return errResult('missing_title');
    const body = { chat_session_id: String(sid), title: String(title).slice(0, 200) };
    const resp = await fetchDeepseekJson('/api/v0/chat_session/update_title', { method: 'POST', body, textLimit: 600 });
    const u = unwrapDeepseekResponse(resp);
    if (!u.ok) return errResult(u.error || 'fetch_failed', { httpStatus: resp.httpStatus, bizCode: u.bizCode, bizMsg: u.bizMsg });
    return okResult({ sessionId: sid, title: body.title, raw: u.biz, sourceUrl: resp.url, timestamp: new Date().toISOString() });
  }

  async function pinSession(args) { return _setPinned(args, true); }
  async function unpinSession(args) { return _setPinned(args, false); }
  async function _setPinned(args, pinned) {
    args = args || {};
    const sid = args.sessionId;
    if (!sid) return errResult('missing_session_id');
    const body = { chat_session_id: String(sid), pinned: !!pinned };
    const resp = await fetchDeepseekJson('/api/v0/chat_session/update_pinned', { method: 'POST', body, textLimit: 600 });
    const u = unwrapDeepseekResponse(resp);
    if (!u.ok) return errResult(u.error || 'fetch_failed', { httpStatus: resp.httpStatus, bizCode: u.bizCode, bizMsg: u.bizMsg });
    return okResult({ sessionId: sid, pinned: !!pinned, raw: u.biz, sourceUrl: resp.url, timestamp: new Date().toISOString() });
  }

  async function deleteSession(args) {
    args = args || {};
    const sid = args.sessionId;
    if (!sid) return errResult('missing_session_id');
    const body = { chat_session_id: String(sid) };
    const resp = await fetchDeepseekJson('/api/v0/chat_session/delete', { method: 'POST', body, textLimit: 600 });
    const u = unwrapDeepseekResponse(resp);
    if (!u.ok) return errResult(u.error || 'fetch_failed', { httpStatus: resp.httpStatus, bizCode: u.bizCode, bizMsg: u.bizMsg });
    return okResult({ sessionId: sid, deleted: true, raw: u.biz, sourceUrl: resp.url, timestamp: new Date().toISOString() });
  }

  async function getSessionSnapshot(args) {
    // 与 chat-bridge 同名实现保持一致，便于 home 端 prefetchBackup 在不切 tab 的情况下取快照
    args = args || {};
    const sid = args.sessionId;
    if (!sid) return errResult('missing_session_id');
    const path = '/api/v0/chat/history_messages?chat_session_id=' + encodeURIComponent(String(sid));
    const resp = await fetchDeepseekJson(path, { textLimit: 800 });
    const u = unwrapDeepseekResponse(resp);
    if (!u.ok) return errResult(u.error || 'fetch_failed', { httpStatus: resp.httpStatus, bizCode: u.bizCode, bizMsg: u.bizMsg });
    const biz = u.biz || {};
    const sess = normalizeChatSessionItem(biz.chat_session) || { id: sid };
    const rawMsgs = Array.isArray(biz.chat_messages) ? biz.chat_messages : [];
    const out = [];
    for (const m of rawMsgs) {
      const norm = normalizeChatMessage(m, { contentMaxLen: 200000 });
      if (!norm) continue;
      const dc = await digestText(norm.content || '');
      out.push({
        messageId: norm.messageId, role: norm.role, status: norm.status,
        parentId: norm.parentId, model: norm.model, insertedAt: norm.insertedAt,
        contentLength: dc.length, contentHash: dc.sha256,
        files: norm.files, feedback: norm.feedback,
      });
    }
    return okResult({ session: sess, messages: out, messageCount: out.length, sourceUrl: resp.url, timestamp: new Date().toISOString() });
  }

  async function listShares(args) {
    args = args || {};
    const count = clampLimit(args.count, 20, 100);
    const resp = await fetchDeepseekJson('/api/v0/share/list?count=' + encodeURIComponent(count), { textLimit: 1500 });
    const u = unwrapDeepseekResponse(resp);
    if (!u.ok) return errResult(u.error || 'fetch_failed', { httpStatus: resp.httpStatus, bizCode: u.bizCode, bizMsg: u.bizMsg });
    return okResult({ shares: u.biz, sourceUrl: resp.url, timestamp: new Date().toISOString() });
  }

  async function shareSession(args) {
    args = args || {};
    const sid = args.sessionId;
    if (!sid) return errResult('missing_session_id');
    const body = { chat_session_id: String(sid) };
    if (args.title) body.title = String(args.title);
    if (Array.isArray(args.message_ids)) body.message_ids = args.message_ids.map(Number);
    const resp = await fetchDeepseekJson('/api/v0/share/create', { method: 'POST', body, textLimit: 800 });
    const u = unwrapDeepseekResponse(resp);
    if (!u.ok) return errResult(u.error || 'fetch_failed', { httpStatus: resp.httpStatus, bizCode: u.bizCode, bizMsg: u.bizMsg });
    return okResult({ sessionId: sid, share: u.biz, sourceUrl: resp.url, timestamp: new Date().toISOString() });
  }

  async function unshareSession(args) {
    args = args || {};
    const shareId = args.shareId;
    if (!shareId) return errResult('missing_share_id');
    const resp = await fetchDeepseekJson('/api/v0/share/delete', { method: 'POST', body: { share_id: String(shareId) }, textLimit: 600 });
    const u = unwrapDeepseekResponse(resp);
    if (!u.ok) return errResult(u.error || 'fetch_failed', { httpStatus: resp.httpStatus, bizCode: u.bizCode, bizMsg: u.bizMsg });
    return okResult({ shareId, deleted: true, raw: u.biz, sourceUrl: resp.url, timestamp: new Date().toISOString() });
  }

  async function updateUserSettings(args) {
    args = args || {};
    const body = Object.assign({}, args.settings || {});
    if (!Object.keys(body).length) return errResult('missing_settings');
    const resp = await fetchDeepseekJson('/api/v0/users/update_settings', { method: 'POST', body, textLimit: 600 });
    const u = unwrapDeepseekResponse(resp);
    if (!u.ok) return errResult(u.error || 'fetch_failed', { httpStatus: resp.httpStatus, bizCode: u.bizCode, bizMsg: u.bizMsg });
    return okResult({ updated: true, settings: body, raw: u.biz, sourceUrl: resp.url, timestamp: new Date().toISOString() });
  }

  const api = {
    __meta: { version: VERSION, name: 'home-bridge' },
    probe, state, sessionState, listSessions,
    navigateHome, navigateNewChat, navigateSession,
    createSession, renameSession, pinSession, unpinSession, deleteSession,
    getSessionSnapshot,
    shareSession, unshareSession, listShares,
    updateUserSettings,
  };

  try {
    Object.defineProperty(window, '__jse_deepseek_home__', { value: api, writable: true, configurable: true });
  } catch (_) {
    window.__jse_deepseek_home__ = api;
  }
  return { ok: true, version: VERSION, name: 'home-bridge' };
})();
