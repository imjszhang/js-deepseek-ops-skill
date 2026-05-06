// bridges/chat-bridge.js
// ---------------------------------------------------------------------------
// DeepSeek Chat 单会话页 bridge（v0.2.0）。
//
// 暴露 window.__jse_deepseek_chat__ API：
//   __meta = { version, name }
//   probe() / state() / sessionState()
//   chatPageState()                 // 当前 chat 页 UI 状态快照（DOM 一次性）
//   getSession({ sessionId?, limit?, contentMaxLen? })
//   listMessages({ sessionId?, limit?, contentMaxLen? })  // 仅 metadata，永不出正文
//   getMessage({ sessionId?, messageId, contentMaxLen? }) // 单条详情
//   streamingStatus({ sessionId? })                       // 一次性观察，无 listener
//   chatSettingsView()                                    // /api/v0/client/settings 只读
//   navigateSession({ sessionId } | { url })
//   navigateHome()
//
// 安全红线（chat 页是高敏区，必须硬守）：
//   - 不模拟点击；不订阅 SSE / EventSource；不 hook fetch / XMLHttpRequest
//   - 不发消息 / 不停 / 不编辑 / 不重生 / 不删 / 不切 model / 不切 toggle / 不上传
//   - 不读 composer 草稿原文（只回 length + sha256）
//   - bridge 端 contentMaxLen 仅做"防超大跨进程传递"截断；
//     真正的隐私 redact 由 Node 端 lib/redact.js 处理
//
// 修改任意方法后请 bump VERSION，下次 session.ensureBridge 自动重装。
// ---------------------------------------------------------------------------

(function install() {
  'use strict';
  const VERSION = '0.2.1';

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

  // ---- 内部：拉取 history_messages，五个 READ 共享 ----
  async function fetchHistoryMessagesRaw(sid) {
    const path = '/api/v0/chat/history_messages?chat_session_id=' + encodeURIComponent(String(sid));
    const resp = await fetchDeepseekJson(path, { textLimit: 800 });
    const u = unwrapDeepseekResponse(resp);
    return { resp, unwrapped: u };
  }

  function mapHistoryError(resp, u, sid) {
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

  async function getSession(args) {
    args = args || {};
    const sid = args.sessionId || parseChatSessionId(location.href);
    if (!sid) {
      return errResult('missing_session_id', { hint: 'pass {sessionId} or open /a/chat/s/<id> first' });
    }
    const { resp, unwrapped: u } = await fetchHistoryMessagesRaw(sid);
    if (!u.ok) return mapHistoryError(resp, u, sid);
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

  /**
   * listMessages - 仅 metadata，永不返回 content / thinkingContent。
   * 防御：bridge 端硬剥；Node 端 buildListMessagesTransform 还会再断言一次。
   */
  async function listMessages(args) {
    args = args || {};
    const sid = args.sessionId || parseChatSessionId(location.href);
    if (!sid) {
      return errResult('missing_session_id', { hint: 'pass {sessionId} or open /a/chat/s/<id> first' });
    }
    const { resp, unwrapped: u } = await fetchHistoryMessagesRaw(sid);
    if (!u.ok) return mapHistoryError(resp, u, sid);
    const biz = u.biz || {};
    const sess = normalizeChatSessionItem(biz.chat_session) || { id: sid };
    const rawMsgs = Array.isArray(biz.chat_messages) ? biz.chat_messages : [];
    const contentMaxLen = clampLimit(args.contentMaxLen, DEFAULT_CONTENT_MAX_LEN, 200000);
    // 复用 normalizeChatMessage 拿到 contentLength 等元字段，再 summarizeMessageMeta 剥正文
    let metas = rawMsgs
      .map((m) => normalizeChatMessage(m, { contentMaxLen }))
      .map(summarizeMessageMeta)
      .filter(Boolean);
    let truncatedToLimit = false;
    const limit = clampLimit(args.limit, 0, 1000);
    if (limit > 0 && metas.length > limit) {
      metas = metas.slice(-limit);
      truncatedToLimit = true;
    }
    return okResult({
      session: sess,
      messages: metas,
      messageCount: rawMsgs.length,
      returnedCount: metas.length,
      truncatedToLimit,
      contentMaxLen,
      sourceUrl: resp.url,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * getMessage - 单条消息详情，正文走 Node 端 redact。
   * 强校验：传入 sessionId 必须与解析出的 URL sessionId 一致（如果 URL 在 chat 页）。
   */
  async function getMessage(args) {
    args = args || {};
    const urlSid = parseChatSessionId(location.href);
    const sid = args.sessionId || urlSid;
    if (!sid) {
      return errResult('missing_session_id', { hint: 'pass {sessionId} or open /a/chat/s/<id> first' });
    }
    if (args.sessionId && urlSid && String(args.sessionId) !== String(urlSid)) {
      return errResult('session_id_mismatch', {
        hint: 'sessionId param differs from current chat page; navigate first or omit sessionId',
        urlSid,
        argSid: String(args.sessionId),
      });
    }
    const messageIdRaw = args.messageId;
    const messageId = Number(messageIdRaw);
    if (!Number.isFinite(messageId)) {
      return errResult('missing_message_id', { hint: 'pass numeric {messageId}' });
    }
    const { resp, unwrapped: u } = await fetchHistoryMessagesRaw(sid);
    if (!u.ok) return mapHistoryError(resp, u, sid);
    const biz = u.biz || {};
    const sess = normalizeChatSessionItem(biz.chat_session) || { id: sid };
    const rawMsgs = Array.isArray(biz.chat_messages) ? biz.chat_messages : [];
    const contentMaxLen = clampLimit(args.contentMaxLen, DEFAULT_CONTENT_MAX_LEN, 200000);
    let hit = null;
    for (const m of rawMsgs) {
      if (m && Number(m.message_id) === messageId) { hit = m; break; }
    }
    if (!hit) {
      return errResult('message_not_found', { sessionId: sid, messageId });
    }
    const message = normalizeChatMessage(hit, { contentMaxLen });
    return okResult({
      session: sess,
      message,
      contentMaxLen,
      sourceUrl: resp.url,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * streamingStatus - 一次性观察当前是否有 assistant 在产出。
   * 双侧确认：history_messages 里 status=STREAMING 的最近一条 + DOM 上是否有 streaming 节点。
   * 永远不订阅 SSE / 不挂 listener / 不返回任何正文。
   */
  async function streamingStatus(args) {
    args = args || {};
    const sid = args.sessionId || parseChatSessionId(location.href);
    if (!sid) {
      return errResult('missing_session_id', { hint: 'pass {sessionId} or open /a/chat/s/<id> first' });
    }
    const { resp, unwrapped: u } = await fetchHistoryMessagesRaw(sid);
    if (!u.ok) return mapHistoryError(resp, u, sid);
    const biz = u.biz || {};
    const rawMsgs = Array.isArray(biz.chat_messages) ? biz.chat_messages : [];
    // normalize 但不带正文：只为拿 status / messageId / role / insertedAt
    const metas = rawMsgs.map((m) => normalizeChatMessage(m, { contentMaxLen: 1 })).filter(Boolean);
    const apiStreaming = pickLatestStreamingMessage(metas);
    let dom = null;
    try { dom = await readChatPageDom(); } catch (_) {}
    const streaming = !!(apiStreaming || (dom && dom.streamingDom));
    return okResult({
      streaming,
      currentMessageId: apiStreaming ? apiStreaming.messageId : null,
      role: apiStreaming ? apiStreaming.role : null,
      lastUpdatedAt: apiStreaming ? apiStreaming.insertedAt : null,
      apiStreaming: !!apiStreaming,
      domStreaming: !!(dom && dom.streamingDom),
      sessionId: sid,
      sourceUrl: resp.url,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * chatPageState - chat 页元状态一次性快照。
   * 全部走 DOM querySelector，无任何 listener / hook。
   * composer 的草稿仅出 length + sha256，绝不出原文。
   */
  async function chatPageState() {
    const url = location.href;
    const sid = parseChatSessionId(url);
    const onChatPage = !!sid;
    let dom = null;
    try { dom = await readChatPageDom(); } catch (_) {}
    return okResult({
      onChatPage,
      sessionId: sid,
      url,
      pathname: location.pathname,
      title: dom ? dom.titleText : null,
      composer: dom ? dom.composer : { length: 0, sha256: null, present: false },
      streamingDom: !!(dom && dom.streamingDom),
      scrollAtBottom: !!(dom && dom.scrollAtBottom),
      visibleMessageCount: dom ? dom.visibleMessageCount : 0,
      timestamp: new Date().toISOString(),
      bridge: { version: VERSION, name: 'chat-bridge' },
    });
  }

  /**
   * chatSettingsView - 只读拉 /api/v0/client/settings。
   * 该接口提供 model 列表 / feature flag 等元数据；本工具永不写。
   */
  async function chatSettingsView(args) {
    args = args || {};
    const scope = args.scope === 'model' ? 'model' : 'main';
    const did = args.did || readDeviceId();
    if (!did) {
      return errResult('missing_device_id', {
        hint: 'localStorage.__ds_remote_feature_did 未设置；通常打开过 chat 页就会自动写入',
      });
    }
    const path = '/api/v0/client/settings?did=' + encodeURIComponent(did) + '&scope=' + encodeURIComponent(scope);
    const resp = await fetchDeepseekJson(path, { textLimit: 800 });
    const u = unwrapDeepseekResponse(resp);
    if (!u.ok) {
      if (resp && (resp.httpStatus === 401 || resp.httpStatus === 403)) {
        return errResult('not_logged_in', { httpStatus: resp.httpStatus });
      }
      // SETTINGS_NOT_FOUND 等业务错误直接透传（scope=main 在某些账号下也会返回这个）
      return errResult(u.error || 'fetch_failed', {
        httpStatus: resp ? resp.httpStatus : null,
        bizCode: u.bizCode,
        bizMsg: u.bizMsg,
        scope,
      });
    }
    return okResult({
      readOnly: true,
      scope,
      did,
      settings: u.biz || null,
      sourceUrl: resp.url,
      timestamp: new Date().toISOString(),
    });
  }

  function navigateHome() {
    return navigateLocation(buildDeepseekUrl('/'));
  }

  /**
   * navigateNewChat - INTERACTIVE 别名：与 navigateHome 同 URL，仅语义不同。
   * 不调用任何 chat_session/create；DeepSeek 是首次发消息才落 sessionId，本调用无副作用。
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
    __meta: { version: VERSION, name: 'chat-bridge' },
    probe,
    state,
    sessionState,
    chatPageState,
    getSession,
    listMessages,
    getMessage,
    streamingStatus,
    chatSettingsView,
    navigateHome,
    navigateNewChat,
    navigateSession,
  };

  try {
    Object.defineProperty(window, '__jse_deepseek_chat__', { value: api, writable: true, configurable: true });
  } catch (_) {
    window.__jse_deepseek_chat__ = api;
  }
  return { ok: true, version: VERSION, name: 'chat-bridge' };
})();
