// bridges/chat-bridge.js
// ---------------------------------------------------------------------------
// DeepSeek Chat 单会话页 bridge（v0.3.0 — DESTRUCTIVE 解锁）。
//
// 暴露 window.__jse_deepseek_chat__ API：
//   READ:
//     probe / state / sessionState
//     chatPageState / getSession / listMessages / getMessage
//     streamingStatus / chatSettingsView
//     getSessionSnapshot                 // 内部备份用，永远走 redact-off + 元数据
//   INTERACTIVE (location.assign only):
//     navigateHome / navigateNewChat / navigateSession
//   DESTRUCTIVE (POST，写业务数据；调用前由 Node 端做 audit + 可选 backup):
//     createSession                      reversible
//     renameSession                      reversible
//     pinSession / unpinSession          reversible
//     feedbackMessage                    reversible
//     stopStream                         reversible（终止当前流）
//     sendMessage                        cost（消耗 token，PoW 自动完成）
//     editMessage                        cost
//     regenerateMessage                  cost
//     uploadFile                         reversible（multipart）
//     deleteFile                         reversible
//     shareSession / unshareSession      reversible
//     exportSessionLocal                 仅本地（DESTRUCTIVE 标记保留以走 audit）
//     updateUserSettings                 reversible
//
// DESTRUCTIVE 档位约定（v0.3.0 BREAKING）：
//   - bridge 端永远不做 confirm；安全语义由 Node 端 runTool destructive 分支 +
//     lib/audit.js 强制 audit 提供。bridge 只负责忠实把请求发出去。
//   - 不模拟点击；所有写动作走 fetchDeepseekJson(POST) 或 SSE stream（completion）
//   - bridge 端永不 hook fetch / XMLHttpRequest（避免污染页面其他业务）
//   - composer 草稿仍只回 length+sha256
//   - navigateLocation 仍只允许 *.deepseek.com（与 destructive 解锁正交）
//
// 修改任意方法后请 bump VERSION，下次 session.ensureBridge 自动重装。
// ---------------------------------------------------------------------------

(function install() {
  'use strict';
  const VERSION = '0.3.15';

  // @@include ./common.js
  // @@include ../lib/sessionTree.js

  const DEFAULT_CONTENT_MAX_LEN = 60000;

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

  async function sessionState() { return sessionStateCommon(); }

  // ---- READ helpers ----
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
    if (!sid) return errResult('missing_session_id');
    const { resp, unwrapped: u } = await fetchHistoryMessagesRaw(sid);
    if (!u.ok) return mapHistoryError(resp, u, sid);
    const biz = u.biz || {};
    const sess = normalizeChatSessionItem(biz.chat_session) || { id: sid };
    const rawMsgs = Array.isArray(biz.chat_messages) ? biz.chat_messages : [];
    const contentMaxLen = clampLimit(args.contentMaxLen, DEFAULT_CONTENT_MAX_LEN, 200000);
    let msgs = rawMsgs.map((m) => normalizeChatMessage(m, { contentMaxLen })).filter(Boolean);
    let truncatedToLimit = false;
    const limit = clampLimit(args.limit, 0, 1000);
    if (limit > 0 && msgs.length > limit) { msgs = msgs.slice(-limit); truncatedToLimit = true; }
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

  async function listMessages(args) {
    args = args || {};
    const sid = args.sessionId || parseChatSessionId(location.href);
    if (!sid) return errResult('missing_session_id');
    const { resp, unwrapped: u } = await fetchHistoryMessagesRaw(sid);
    if (!u.ok) return mapHistoryError(resp, u, sid);
    const biz = u.biz || {};
    const sess = normalizeChatSessionItem(biz.chat_session) || { id: sid };
    const rawMsgs = Array.isArray(biz.chat_messages) ? biz.chat_messages : [];
    const contentMaxLen = clampLimit(args.contentMaxLen, DEFAULT_CONTENT_MAX_LEN, 200000);
    let metas = rawMsgs.map((m) => normalizeChatMessage(m, { contentMaxLen })).map(summarizeMessageMeta).filter(Boolean);
    let truncatedToLimit = false;
    const limit = clampLimit(args.limit, 0, 1000);
    if (limit > 0 && metas.length > limit) { metas = metas.slice(-limit); truncatedToLimit = true; }
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

  async function getMessage(args) {
    args = args || {};
    const urlSid = parseChatSessionId(location.href);
    const sid = args.sessionId || urlSid;
    if (!sid) return errResult('missing_session_id');
    if (args.sessionId && urlSid && String(args.sessionId) !== String(urlSid)) {
      return errResult('session_id_mismatch', { urlSid, argSid: String(args.sessionId) });
    }
    const messageId = Number(args.messageId);
    if (!Number.isFinite(messageId)) return errResult('missing_message_id');
    const { resp, unwrapped: u } = await fetchHistoryMessagesRaw(sid);
    if (!u.ok) return mapHistoryError(resp, u, sid);
    const biz = u.biz || {};
    const sess = normalizeChatSessionItem(biz.chat_session) || { id: sid };
    const rawMsgs = Array.isArray(biz.chat_messages) ? biz.chat_messages : [];
    const contentMaxLen = clampLimit(args.contentMaxLen, DEFAULT_CONTENT_MAX_LEN, 200000);
    let hit = null;
    for (const m of rawMsgs) { if (m && Number(m.message_id) === messageId) { hit = m; break; } }
    if (!hit) return errResult('message_not_found', { sessionId: sid, messageId });
    return okResult({
      session: sess,
      message: normalizeChatMessage(hit, { contentMaxLen }),
      contentMaxLen,
      sourceUrl: resp.url,
      timestamp: new Date().toISOString(),
    });
  }

  async function streamingStatus(args) {
    args = args || {};
    const sid = args.sessionId || parseChatSessionId(location.href);
    if (!sid) return errResult('missing_session_id');
    const { resp, unwrapped: u } = await fetchHistoryMessagesRaw(sid);
    if (!u.ok) return mapHistoryError(resp, u, sid);
    const biz = u.biz || {};
    const rawMsgs = Array.isArray(biz.chat_messages) ? biz.chat_messages : [];
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

  async function chatSettingsView(args) {
    args = args || {};
    const scope = args.scope === 'model' ? 'model' : 'main';
    const did = args.did || readDeviceId();
    if (!did) return errResult('missing_device_id');
    const path = '/api/v0/client/settings?did=' + encodeURIComponent(did) + '&scope=' + encodeURIComponent(scope);
    const resp = await fetchDeepseekJson(path, { textLimit: 800 });
    const u = unwrapDeepseekResponse(resp);
    if (!u.ok) {
      if (resp && (resp.httpStatus === 401 || resp.httpStatus === 403)) {
        return errResult('not_logged_in', { httpStatus: resp.httpStatus });
      }
      return errResult(u.error || 'fetch_failed', {
        httpStatus: resp ? resp.httpStatus : null,
        bizCode: u.bizCode, bizMsg: u.bizMsg, scope,
      });
    }
    return okResult({ readOnly: true, scope, did, settings: u.biz || null, sourceUrl: resp.url, timestamp: new Date().toISOString() });
  }

  /**
   * getSessionSnapshot - 内部 backup 用。返回 {session, messages: [{role, status, contentLength, contentHash}]}，
   * 不含正文，但保留每条 sha256 + length，足够事后比对。
   */
  async function getSessionSnapshot(args) {
    args = args || {};
    const sid = args.sessionId || parseChatSessionId(location.href);
    if (!sid) return errResult('missing_session_id');
    const { resp, unwrapped: u } = await fetchHistoryMessagesRaw(sid);
    if (!u.ok) return mapHistoryError(resp, u, sid);
    const biz = u.biz || {};
    const sess = normalizeChatSessionItem(biz.chat_session) || { id: sid };
    const rawMsgs = Array.isArray(biz.chat_messages) ? biz.chat_messages : [];
    const out = [];
    for (const m of rawMsgs) {
      const norm = normalizeChatMessage(m, { contentMaxLen: 200000 });
      if (!norm) continue;
      const dc = await digestText(norm.content || '');
      const dt = norm.thinkingContent ? await digestText(norm.thinkingContent) : null;
      out.push({
        messageId: norm.messageId,
        role: norm.role,
        status: norm.status,
        parentId: norm.parentId,
        model: norm.model,
        insertedAt: norm.insertedAt,
        contentLength: dc.length,
        contentHash: dc.sha256,
        thinkingLength: dt ? dt.length : 0,
        thinkingHash: dt ? dt.sha256 : null,
        files: norm.files,
        feedback: norm.feedback,
      });
    }
    return okResult({
      session: sess,
      messages: out,
      messageCount: out.length,
      sourceUrl: resp.url,
      timestamp: new Date().toISOString(),
    });
  }

  // ---- READ: 全分支树（v0.4.0） ----
  //
  // 踩点结论（docs/dev/branch-scout.md）：/api/v0/chat/history_messages 单次响应即返回
  // 整棵会话树的所有节点（含被埋藏的旧分支兄弟）。服务端不返 children 反向索引也
  // 不返 branch 标识，全靠 parent_id 指针重建。buildSessionTree 是纯函数：输入
  // {session, chat_messages}，输出 SessionTree（详见 docs/dev/session-tree-schema.md）。
  //
  // 三个对外方法 getSessionTree / listBranchPoints / getBranchPath 都是 buildSessionTree
  // 的 view —— 后两者基于全树派生轻量结果。
  //
  // v0.4.1 起：buildSessionTree + _emptyTreeStats 的实现已抽到 lib/sessionTree.js，
  // 通过顶部 `// @@include ../lib/sessionTree.js` 文本嵌入到本 IIFE scope。
  // 调用处需把 IIFE scope 内的 normalizer 作为 deps 显式传入（依赖注入）。

  // 注：_emptyTreeStats / buildSessionTree 由 lib/sessionTree.js 通过文件顶部的
  // `// @@include ../lib/sessionTree.js` 文本嵌入到本 IIFE scope。
  // 调用时把 IIFE scope 内的 normalizer 作为 deps 显式传入：
  //   buildSessionTree(session, messages, opts, { normalizeChatMessage, normalizeChatSessionItem, clampLimit })

  const __TREE_DEPS = { normalizeChatMessage, normalizeChatSessionItem, clampLimit };

  async function getSessionTree(args) {
    args = args || {};
    const sid = args.sessionId || parseChatSessionId(location.href);
    if (!sid) return errResult('missing_session_id');
    const { resp, unwrapped: u } = await fetchHistoryMessagesRaw(sid);
    if (!u.ok) return mapHistoryError(resp, u, sid);
    const biz = u.biz || {};
    const contentMaxLen = clampLimit(args.contentMaxLen, DEFAULT_CONTENT_MAX_LEN, 200000);
    const tree = buildSessionTree(biz.chat_session, biz.chat_messages, { contentMaxLen }, __TREE_DEPS);

    // limit：仅在节点数超限时按 messageId 倒序保留最新
    const limit = clampLimit(args.limit, 0, 5000);
    let truncatedToLimit = false;
    if (limit > 0 && tree.stats.totalMessages > limit) {
      const ids = Object.keys(tree.nodes).map((k) => Number(k)).sort((a, b) => b - a).slice(0, limit);
      const keep = Object.create(null);
      for (const id of ids) keep[String(id)] = true;
      const filtered = Object.create(null);
      for (const k in tree.nodes) if (keep[k]) filtered[k] = tree.nodes[k];
      tree.nodes = filtered;
      tree.activePathIds = tree.activePathIds.filter((id) => keep[String(id)]);
      tree.branchPointIds = tree.branchPointIds.filter((id) => keep[String(id)]);
      tree.rootMessageIds = tree.rootMessageIds.filter((id) => keep[String(id)]);
      tree.stats.totalMessages = ids.length;
      tree.stats.warnings.push('truncated_to_limit');
      truncatedToLimit = true;
    }

    return okResult(Object.assign({}, tree, {
      contentMaxLen,
      truncatedToLimit,
      sourceUrl: resp.url,
      timestamp: new Date().toISOString(),
    }));
  }

  async function listBranchPoints(args) {
    args = args || {};
    const sid = args.sessionId || parseChatSessionId(location.href);
    if (!sid) return errResult('missing_session_id');
    const { resp, unwrapped: u } = await fetchHistoryMessagesRaw(sid);
    if (!u.ok) return mapHistoryError(resp, u, sid);
    const biz = u.biz || {};
    const tree = buildSessionTree(biz.chat_session, biz.chat_messages, { contentMaxLen: 1 }, __TREE_DEPS);
    const branchPoints = tree.branchPointIds.map((id) => {
      const n = tree.nodes[String(id)];
      const children = (n.childrenIds || []).map((cid) => {
        const c = tree.nodes[String(cid)];
        if (!c) return { messageId: cid, missing: true };
        return {
          messageId: c.messageId,
          role: c.role,
          insertedAt: c.insertedAt,
          contentLength: c.contentLength,
          // bridge 端不算 sha256 同步成本（avoid await）；正文 hash 留给 redact 层补
          isOnActivePath: c.isOnActivePath,
          isLeaf: c.isLeaf,
          isBranchPoint: c.isBranchPoint,
          status: c.status,
          siblingIndex: c.siblingIndex,
        };
      });
      return {
        messageId: n.messageId,
        role: n.role,
        depth: n.depth,
        isOnActivePath: n.isOnActivePath,
        childrenCount: n.childrenIds.length,
        children,
      };
    });
    return okResult({
      session: tree.session,
      currentMessageId: tree.currentMessageId,
      activePathLength: tree.activePathIds.length,
      totalMessages: tree.stats.totalMessages,
      branchPointCount: branchPoints.length,
      branchPoints,
      sourceUrl: resp.url,
      timestamp: new Date().toISOString(),
    });
  }

  async function getBranchPath(args) {
    args = args || {};
    const sid = args.sessionId || parseChatSessionId(location.href);
    if (!sid) return errResult('missing_session_id');
    const { resp, unwrapped: u } = await fetchHistoryMessagesRaw(sid);
    if (!u.ok) return mapHistoryError(resp, u, sid);
    const biz = u.biz || {};
    const contentMaxLen = clampLimit(args.contentMaxLen, DEFAULT_CONTENT_MAX_LEN, 200000);
    const tree = buildSessionTree(biz.chat_session, biz.chat_messages, { contentMaxLen }, __TREE_DEPS);

    const requested = (args.leafMessageId == null) ? null : Number(args.leafMessageId);
    let leafResolved;
    if (requested == null) {
      leafResolved = tree.currentMessageId;
    } else if (!tree.nodes[String(requested)]) {
      return errResult('branch_leaf_not_found', { sessionId: sid, leafMessageId: requested });
    } else {
      leafResolved = requested;
    }

    const warnings = [];
    if (leafResolved == null) {
      return errResult('branch_leaf_not_found', { sessionId: sid, leafMessageId: null, hint: 'session.current_message_id is null and no explicit leaf provided' });
    }
    const leafNode = tree.nodes[String(leafResolved)];
    if (leafNode && leafNode.childrenIds && leafNode.childrenIds.length > 0) {
      warnings.push('leaf_has_children');
    }

    // 反向走 parent 收集，stripping tree-extension fields 以兼容 getSession.messages[] schema
    const path = [];
    let cur = leafResolved;
    const seen = Object.create(null);
    while (cur != null && tree.nodes[String(cur)] && !seen[String(cur)]) {
      seen[String(cur)] = true;
      const n = tree.nodes[String(cur)];
      const flat = Object.assign({}, n);
      delete flat.childrenIds;
      delete flat.depth;
      delete flat.siblingIndex;
      delete flat.siblingCount;
      delete flat.isOnActivePath;
      delete flat.isBranchPoint;
      delete flat.isLeaf;
      path.unshift(flat);
      cur = n.parentId;
    }

    let messages = path;
    let truncatedToLimit = false;
    const limit = clampLimit(args.limit, 0, 5000);
    if (limit > 0 && messages.length > limit) {
      messages = messages.slice(-limit);
      truncatedToLimit = true;
    }

    return okResult({
      session: tree.session,
      messages,
      messageCount: path.length,
      returnedCount: messages.length,
      leafMessageId: requested,
      leafResolved,
      isOnActivePath: leafResolved === tree.currentMessageId,
      truncatedToLimit,
      contentMaxLen,
      warnings,
      sourceUrl: resp.url,
      timestamp: new Date().toISOString(),
    });
  }

  // ---- DESTRUCTIVE: 会话管理 ----

  async function createSession(args) {
    args = args || {};
    const body = {};
    if (args.agent) body.agent = String(args.agent);
    if (args.character_id) body.character_id = String(args.character_id);
    const resp = await fetchDeepseekJson('/api/v0/chat_session/create', { method: 'POST', body, textLimit: 800 });
    const u = unwrapDeepseekResponse(resp);
    if (!u.ok) {
      return errResult(u.error || 'fetch_failed', { httpStatus: resp.httpStatus, bizCode: u.bizCode, bizMsg: u.bizMsg });
    }
    const sess = normalizeChatSessionItem(u.biz) || (u.biz && { id: u.biz.id });
    return okResult({
      session: sess,
      sessionId: (sess && sess.id) || null,
      raw: u.biz,
      sourceUrl: resp.url,
      timestamp: new Date().toISOString(),
    });
  }

  async function renameSession(args) {
    args = args || {};
    const sid = args.sessionId;
    const title = args.title;
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

  // 注：v0.3.3 移除 deleteSession（删除会话不可逆）；端点 /api/v0/chat_session/delete
  // 仍存在于 DeepSeek，bridge 端不再封装，避免被误调用。

  async function feedbackMessage(args) {
    args = args || {};
    const sid = args.sessionId;
    const messageId = Number(args.messageId);
    if (!sid) return errResult('missing_session_id');
    if (!Number.isFinite(messageId)) return errResult('missing_message_id');
    // 真实 schema：feedback_type ∈ {'GOOD','BAD',null} + feedback_tag + description
    // 兼容传入 feedback ∈ {-1, 0, 1}（踩 / 取消 / 赞）映射到 BAD / null / GOOD
    let ft = args.feedback_type;
    if (ft === undefined) {
      const n = Number(args.feedback);
      ft = n === 1 ? 'GOOD' : n === -1 ? 'BAD' : null;
    }
    if (ft !== 'GOOD' && ft !== 'BAD' && ft !== null) {
      return errResult('invalid_feedback_type', { hint: "use 'GOOD' | 'BAD' | null (or feedback ∈ {-1,0,1})" });
    }
    const body = {
      chat_session_id: String(sid),
      message_id: messageId,
      feedback_type: ft,
      feedback_tag: args.feedback_tag == null ? null : args.feedback_tag,
      description: typeof args.description === 'string' ? args.description.slice(0, 1000)
        : (typeof args.comment === 'string' ? args.comment.slice(0, 1000) : null),
    };
    const resp = await fetchDeepseekJson('/api/v0/chat/message_feedback', { method: 'POST', body, textLimit: 600 });
    const u = unwrapDeepseekResponse(resp);
    if (!u.ok) return errResult(u.error || 'fetch_failed', { httpStatus: resp.httpStatus, bizCode: u.bizCode, bizMsg: u.bizMsg });
    return okResult({ sessionId: sid, messageId, feedback_type: ft, raw: u.biz, sourceUrl: resp.url, timestamp: new Date().toISOString() });
  }

  async function stopStream(args) {
    args = args || {};
    const sid = args.sessionId || parseChatSessionId(location.href);
    if (!sid) return errResult('missing_session_id');
    const body = { chat_session_id: String(sid) };
    const resp = await fetchDeepseekJson('/api/v0/chat/stop_stream', { method: 'POST', body, textLimit: 600 });
    const u = unwrapDeepseekResponse(resp);
    if (!u.ok) return errResult(u.error || 'fetch_failed', { httpStatus: resp.httpStatus, bizCode: u.bizCode, bizMsg: u.bizMsg });
    return okResult({ sessionId: sid, stopped: true, raw: u.biz, sourceUrl: resp.url, timestamp: new Date().toISOString() });
  }

  // ---- DESTRUCTIVE: 发消息 / 编辑 / 重生 ----

  /**
   * solvePowChallenge - DeepSeek 的 PoW 用 sha3 wasm worker 求解（webpack 内部模块），
   * bridge 端无法独立复刻。
   *
   * 当前策略：
   *   1) 调 /api/v0/chat/create_pow_challenge 拿 challenge；
   *   2) 不实算 answer——直接 base64(JSON({algorithm,challenge,salt,signature,target_path,answer:0}))
   *      作为 X-DS-PoW-Response 透传；
   *   3) 服务端校验失败会返回 PROOF_OF_WORK 类错误，上层把 error.code='pow_required'
   *      暴露给 LLM 作为 "需要走 UI 通道" 的信号；
   *   4) 如未来在页面上拿到自带 solver hook（zustand `useProofOfWorkStore` 缓存的
   *      pair.answer），优先取缓存。
   *
   * @param {string} targetPath
   * @returns {Promise<{header:string|null, challenge:any, source:string}|null>}
   */
  async function solvePowChallenge(targetPath) {
    try {
      const body = { target_path: targetPath || '/api/v0/chat/completion' };
      const resp = await fetchDeepseekJson('/api/v0/chat/create_pow_challenge', { method: 'POST', body, textLimit: 800 });
      const u = unwrapDeepseekResponse(resp);
      if (!u.ok || !u.biz) return null;
      const challenge = u.biz.challenge || u.biz;
      const payload = {
        algorithm: challenge.algorithm,
        challenge: challenge.challenge,
        salt: challenge.salt,
        answer: 0,
        signature: challenge.signature,
        target_path: targetPath || '/api/v0/chat/completion',
      };
      let header = null;
      try { header = btoa(unescape(encodeURIComponent(JSON.stringify(payload)))); } catch (_) {}
      return { header, challenge, source: 'unsolved_passthrough' };
    } catch (_) { return null; }
  }

  /**
   * sendMessage - POST /api/v0/chat/completion，SSE 流式响应。
   * 实现策略：
   *   1) 先调 create_pow_challenge 拿 challenge；
   *   2) 发起 fetch（headers 含 X-Ds-Pow-Response），SSE 流式读完；
   *   3) 把 chunks 累积成 finalContent / finalThinking / messageId / usage 一次性返回。
   * 不做边收边转发（避免长生命周期跨进程通信复杂度）。
   *
   * 注：bridge 端永不返回 prompt 原文（args.prompt 由 Node audit 层负责落盘）。
   */
  async function sendMessage(args) {
    args = args || {};
    const sid = args.sessionId || parseChatSessionId(location.href);
    if (!sid) return errResult('missing_session_id');
    const prompt = String(args.prompt == null ? '' : args.prompt);
    if (!prompt.length) return errResult('missing_prompt');
    const tok = readUserToken();
    if (!tok) return errResult('not_logged_in');
    const parentMessageId = args.parentMessageId == null ? null : Number(args.parentMessageId);
    const body = {
      chat_session_id: String(sid),
      parent_message_id: parentMessageId,
      prompt,
      ref_file_ids: Array.isArray(args.refFileIds) ? args.refFileIds.map(String) : [],
      thinking_enabled: !!args.thinking,
      search_enabled: !!args.search,
    };
    if (args.challenge_response) body.challenge_response = args.challenge_response;
    const pow = await solvePowChallenge('/api/v0/chat/completion');
    const headers = {
      'Authorization': 'Bearer ' + tok,
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream,application/json',
    };
    if (pow && pow.header) headers['X-DS-PoW-Response'] = pow.header;
    const url = buildDeepseekUrl('/api/v0/chat/completion');
    let res = null;
    try {
      res = await fetch(url, { method: 'POST', credentials: 'include', headers, body: JSON.stringify(body) });
    } catch (e) {
      return errResult('network_error', { message: String((e && e.message) || e) });
    }
    const ct = res.headers && res.headers.get && res.headers.get('content-type') || '';
    if (!res.ok || /application\/json/i.test(ct)) {
      let snippet = '';
      try { snippet = (await res.text()).slice(0, 800); } catch (_) {}
      let bodyJson = null;
      try { bodyJson = JSON.parse(snippet); } catch (_) {}
      const isPowMissing = bodyJson && (bodyJson.code === 40300 || /POW|PROOF|HEADER/i.test(bodyJson.msg || ''));
      return errResult(isPowMissing ? 'pow_required' : 'http_error', {
        httpStatus: res.status, snippet, contentType: ct,
        hint: isPowMissing ? 'PoW solver not implemented in bridge; use UI to send instead' : undefined,
        powSource: pow && pow.source,
      });
    }
    // SSE 流式读
    const reader = res.body && res.body.getReader ? res.body.getReader() : null;
    if (!reader) {
      try {
        const text = await res.text();
        return errResult('non_streaming_response', { snippet: text.slice(0, 800) });
      } catch (e) {
        return errResult('stream_unavailable', { message: String(e && e.message) });
      }
    }
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let finalContent = '';
    let finalThinking = '';
    let messageId = null;
    let parentId = parentMessageId;
    let model = null;
    let usage = null;
    let finishReason = null;
    let chunkCount = 0;
    const startTs = Date.now();
    const HARD_TIMEOUT_MS = Math.max(5000, Number(args.timeoutMs) || 120000);
    while (true) {
      if (Date.now() - startTs > HARD_TIMEOUT_MS) break;
      let read;
      try { read = await reader.read(); } catch (e) { break; }
      if (read.done) break;
      buffer += decoder.decode(read.value, { stream: true });
      // SSE: events split by \n\n
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const evt = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of evt.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          chunkCount++;
          let obj;
          try { obj = JSON.parse(payload); } catch (_) { continue; }
          // 多种 chunk 形态：{v: "字"} 或 {v: {content: "..."}} 或 {p: "...", v: ...}
          // 统一抓 v.content / v.thinking_content / message_id / model / usage
          try {
            if (obj.v != null) {
              if (typeof obj.v === 'string') {
                if (obj.p === 'response/thinking_content') finalThinking += obj.v;
                else finalContent += obj.v;
              } else if (typeof obj.v === 'object') {
                if (typeof obj.v.content === 'string') finalContent += obj.v.content;
                if (typeof obj.v.thinking_content === 'string') finalThinking += obj.v.thinking_content;
                if (obj.v.message_id != null) messageId = Number(obj.v.message_id);
                if (obj.v.parent_id != null) parentId = Number(obj.v.parent_id);
                if (obj.v.model) model = obj.v.model;
                if (obj.v.usage) usage = obj.v.usage;
                if (obj.v.finish_reason) finishReason = obj.v.finish_reason;
              }
            }
            if (obj.message_id != null && messageId == null) messageId = Number(obj.message_id);
            if (obj.usage && !usage) usage = obj.usage;
            if (obj.finish_reason && !finishReason) finishReason = obj.finish_reason;
          } catch (_) {}
        }
      }
    }
    try { reader.cancel && reader.cancel(); } catch (_) {}
    const elapsedMs = Date.now() - startTs;
    return okResult({
      sessionId: sid,
      messageId,
      parentId,
      model,
      finishReason,
      contentLength: finalContent.length,
      contentSha256: (await digestText(finalContent)).sha256,
      thinkingContentLength: finalThinking.length,
      thinkingContentSha256: finalThinking ? (await digestText(finalThinking)).sha256 : null,
      // 默认不返回正文；如需正文，调用方在 audit 之后用 get_message 拿
      content: args.includeContent ? finalContent : null,
      thinkingContent: args.includeContent ? finalThinking : null,
      usage,
      chunkCount,
      elapsedMs,
      pow: !!pow,
      sourceUrl: url,
      timestamp: new Date().toISOString(),
    });
  }

  async function editMessage(args) {
    args = args || {};
    const sid = args.sessionId || parseChatSessionId(location.href);
    if (!sid) return errResult('missing_session_id');
    const messageId = Number(args.messageId);
    if (!Number.isFinite(messageId)) return errResult('missing_message_id');
    const prompt = String(args.prompt == null ? '' : args.prompt);
    if (!prompt.length) return errResult('missing_prompt');
    // edit_message 走 SSE，参考 sendMessage 但额外带 message_id
    const fakeArgs = Object.assign({}, args, { _editTarget: messageId });
    // 复用 sendMessage 的 SSE 解析路径，但端点改为 edit_message
    return _completionLike(fakeArgs, '/api/v0/chat/edit_message', {
      chat_session_id: String(sid),
      message_id: messageId,
      prompt,
      ref_file_ids: Array.isArray(args.refFileIds) ? args.refFileIds.map(String) : [],
      thinking_enabled: !!args.thinking,
      search_enabled: !!args.search,
    });
  }

  async function regenerateMessage(args) {
    args = args || {};
    const sid = args.sessionId || parseChatSessionId(location.href);
    if (!sid) return errResult('missing_session_id');
    const parentMessageId = Number(args.parentMessageId);
    if (!Number.isFinite(parentMessageId)) return errResult('missing_parent_message_id');
    return _completionLike(args, '/api/v0/chat/regenerate', {
      chat_session_id: String(sid),
      parent_message_id: parentMessageId,
      thinking_enabled: !!args.thinking,
      search_enabled: !!args.search,
    });
  }

  async function _completionLike(args, endpoint, body) {
    const tok = readUserToken();
    if (!tok) return errResult('not_logged_in');
    const pow = await solvePowChallenge(endpoint);
    const headers = {
      'Authorization': 'Bearer ' + tok,
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream,application/json',
    };
    if (pow && pow.header) headers['X-DS-PoW-Response'] = pow.header;
    const url = buildDeepseekUrl(endpoint);
    let res;
    try {
      res = await fetch(url, { method: 'POST', credentials: 'include', headers, body: JSON.stringify(body) });
    } catch (e) {
      return errResult('network_error', { message: String((e && e.message) || e) });
    }
    const ct = res.headers && res.headers.get && res.headers.get('content-type') || '';
    if (!res.ok || /application\/json/i.test(ct)) {
      let snippet = '';
      try { snippet = (await res.text()).slice(0, 800); } catch (_) {}
      let bodyJson = null;
      try { bodyJson = JSON.parse(snippet); } catch (_) {}
      const isPowMissing = bodyJson && (bodyJson.code === 40300 || /POW|PROOF|HEADER/i.test(bodyJson.msg || ''));
      return errResult(isPowMissing ? 'pow_required' : 'http_error', {
        httpStatus: res.status, snippet, contentType: ct, endpoint,
        hint: isPowMissing ? 'PoW solver not implemented in bridge' : undefined,
      });
    }
    const reader = res.body && res.body.getReader ? res.body.getReader() : null;
    if (!reader) return errResult('stream_unavailable');
    const decoder = new TextDecoder('utf-8');
    let buffer = '', finalContent = '', finalThinking = '', messageId = null, model = null, usage = null, finishReason = null, chunkCount = 0;
    const startTs = Date.now();
    const HARD_TIMEOUT_MS = Math.max(5000, Number(args.timeoutMs) || 120000);
    while (true) {
      if (Date.now() - startTs > HARD_TIMEOUT_MS) break;
      let read;
      try { read = await reader.read(); } catch (_) { break; }
      if (read.done) break;
      buffer += decoder.decode(read.value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const evt = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of evt.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          chunkCount++;
          let obj;
          try { obj = JSON.parse(payload); } catch (_) { continue; }
          try {
            if (obj.v != null) {
              if (typeof obj.v === 'string') {
                if (obj.p === 'response/thinking_content') finalThinking += obj.v;
                else finalContent += obj.v;
              } else if (typeof obj.v === 'object') {
                if (typeof obj.v.content === 'string') finalContent += obj.v.content;
                if (typeof obj.v.thinking_content === 'string') finalThinking += obj.v.thinking_content;
                if (obj.v.message_id != null) messageId = Number(obj.v.message_id);
                if (obj.v.model) model = obj.v.model;
                if (obj.v.usage) usage = obj.v.usage;
                if (obj.v.finish_reason) finishReason = obj.v.finish_reason;
              }
            }
            if (obj.message_id != null && messageId == null) messageId = Number(obj.message_id);
            if (obj.usage && !usage) usage = obj.usage;
            if (obj.finish_reason && !finishReason) finishReason = obj.finish_reason;
          } catch (_) {}
        }
      }
    }
    try { reader.cancel && reader.cancel(); } catch (_) {}
    return okResult({
      endpoint,
      messageId,
      model,
      finishReason,
      contentLength: finalContent.length,
      contentSha256: (await digestText(finalContent)).sha256,
      thinkingContentLength: finalThinking.length,
      content: args.includeContent ? finalContent : null,
      thinkingContent: args.includeContent ? finalThinking : null,
      usage,
      chunkCount,
      elapsedMs: Date.now() - startTs,
      pow: !!pow,
      sourceUrl: url,
      timestamp: new Date().toISOString(),
    });
  }

  // ---- DESTRUCTIVE: 文件 / 分享 / 设置 ----

  async function uploadFile(args) {
    args = args || {};
    // multipart 上传：从 page 上现成的 input[type=file] 不可控；这里走 base64
    const filename = String(args.filename || 'upload.txt');
    const contentBase64 = String(args.contentBase64 || '');
    const mime = String(args.mime || 'application/octet-stream');
    if (!contentBase64) return errResult('missing_content_base64');
    let bin;
    try {
      const raw = atob(contentBase64);
      const len = raw.length;
      bin = new Uint8Array(len);
      for (let i = 0; i < len; i++) bin[i] = raw.charCodeAt(i);
    } catch (e) { return errResult('invalid_base64'); }
    const tok = readUserToken();
    if (!tok) return errResult('not_logged_in');
    const fd = new FormData();
    fd.append('file', new Blob([bin], { type: mime }), filename);
    if (args.session_id) fd.append('session_id', String(args.session_id));
    const url = buildDeepseekUrl('/api/v0/file/upload_file');
    let res;
    try {
      res = await fetch(url, { method: 'POST', credentials: 'include', headers: { 'Authorization': 'Bearer ' + tok }, body: fd });
    } catch (e) { return errResult('network_error', { message: String(e && e.message) }); }
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) return errResult('http_error', { httpStatus: res.status, raw: data });
    const top = data || {};
    if (top.code !== 0) return errResult('top_level_error', { code: top.code, msg: top.msg, raw: top });
    const inner = top.data || {};
    if (inner.biz_code !== 0 && inner.biz_code !== undefined) {
      return errResult('biz_error', { bizCode: inner.biz_code, bizMsg: inner.biz_msg, raw: top });
    }
    return okResult({ uploaded: true, filename, mime, size: bin.length, biz: inner.biz_data, sourceUrl: url, timestamp: new Date().toISOString() });
  }

  async function listFiles(args) {
    args = args || {};
    const sid = args.sessionId || null;
    const path = '/api/v0/file/fetch_files' + (sid ? ('?chat_session_id=' + encodeURIComponent(sid)) : '');
    const resp = await fetchDeepseekJson(path, { textLimit: 800 });
    const u = unwrapDeepseekResponse(resp);
    if (!u.ok) return errResult(u.error || 'fetch_failed', { httpStatus: resp.httpStatus, bizCode: u.bizCode, bizMsg: u.bizMsg });
    return okResult({ files: u.biz, sourceUrl: resp.url, timestamp: new Date().toISOString() });
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
    const body = { share_id: String(shareId) };
    const resp = await fetchDeepseekJson('/api/v0/share/delete', { method: 'POST', body, textLimit: 600 });
    const u = unwrapDeepseekResponse(resp);
    if (!u.ok) return errResult(u.error || 'fetch_failed', { httpStatus: resp.httpStatus, bizCode: u.bizCode, bizMsg: u.bizMsg });
    return okResult({ shareId, deleted: true, raw: u.biz, sourceUrl: resp.url, timestamp: new Date().toISOString() });
  }

  async function listShares(args) {
    args = args || {};
    const count = clampLimit(args.count, 20, 100);
    const resp = await fetchDeepseekJson('/api/v0/share/list?count=' + encodeURIComponent(count), { textLimit: 1500 });
    const u = unwrapDeepseekResponse(resp);
    if (!u.ok) return errResult(u.error || 'fetch_failed', { httpStatus: resp.httpStatus, bizCode: u.bizCode, bizMsg: u.bizMsg });
    return okResult({ shares: u.biz, sourceUrl: resp.url, timestamp: new Date().toISOString() });
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

  // ---------------------------------------------------------------------------
  // DOM 模式：模拟用户输入 + 点击发送
  // ---------------------------------------------------------------------------
  // 为什么需要：DeepSeek `/api/v0/chat/completion` 强制 PoW（DeepSeekHashV1，
  // 在 sha3 WASM worker 里跑），bridge 内复刻不现实；同时 API 直创的会话
  // 在标题尚未生成前不会出现在 UI 侧栏。走 DOM 让浏览器自己解 PoW，
  // 既能创建可见会话也能在已有会话里发消息。
  //
  // 工作流：
  //   1. 在 / 或已有会话页都成立：找到唯一 textarea
  //   2. setReactInputValue 写入 prompt（受控输入必须走 prototype setter）
  //   3. 等发送按钮 enabled，click()
  //   4. 若起始在 /，轮询 location.pathname 等 sessionId 出现
  //   5. （可选）轮询 history_messages 直到末条 ASSISTANT 不再 WIP/STREAMING

  async function domSendMessage(args) {
    args = args || {};
    const prompt = String(args.prompt || '');
    if (!prompt.length) return errResult('missing_prompt');
    if (prompt.length > 50000) return errResult('prompt_too_long', { length: prompt.length });

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const beforeUrl = location.href;
    const beforeSid = parseChatSessionId(beforeUrl);

    const ta = document.querySelector('textarea');
    if (!ta) return errResult('no_composer_textarea', { url: beforeUrl });

    setReactInputValue(ta, prompt);
    await sleep(120);

    const btnWait = await waitFor(() => findComposerSendButton(ta), { timeoutMs: 5000, intervalMs: 150 });
    if (!btnWait.ok) {
      return errResult('send_button_not_enabled', {
        composerLen: ta.value.length,
        attempts: btnWait.attempts,
        elapsedMs: btnWait.elapsedMs,
      });
    }
    const sendBtn = btnWait.value;
    sendBtn.click();

    const sidTimeoutMs = Math.max(2000, Number(args.sessionIdTimeoutMs) || 20000);
    let sid = beforeSid;
    let isNewSession = false;
    if (!sid) {
      isNewSession = true;
      const sidPattern = /\/a\/chat\/s\/([0-9a-f-]{36})/i;
      const sidWait = await waitFor(() => {
        const m = sidPattern.exec(location.href);
        return m ? m[1] : null;
      }, { timeoutMs: sidTimeoutMs, intervalMs: 250, initialDelayMs: 300 });
      if (!sidWait.ok) {
        return errResult('session_id_did_not_appear', {
          beforeUrl,
          afterUrl: location.href,
          composerStillFilled: !!(ta.value && ta.value.length),
        });
      }
      sid = sidWait.value;
    }

    let waitedFinish = false;
    let finishElapsedMs = 0;
    let messages = null;
    if (args.waitForFinish !== false) {
      const finishTimeoutMs = Math.max(5000, Number(args.finishTimeoutMs) || 90000);
      const finishWait = await waitFor(async () => {
        const r = await fetchHistoryMessagesRaw(sid);
        const u = r.unwrapped;
        if (!u || !u.ok) return null;
        const raw = (u.biz && u.biz.chat_messages) || [];
        if (!raw.length) return null;
        const last = raw[raw.length - 1];
        const role = String(last.role || '').toUpperCase();
        const status = String(last.status || '').toUpperCase();
        if (role !== 'ASSISTANT') return null;
        if (status === 'WIP' || status === 'STREAMING' || status === 'PENDING') return null;
        return raw;
      }, { timeoutMs: finishTimeoutMs, intervalMs: 800, initialDelayMs: 500 });
      waitedFinish = finishWait.ok;
      finishElapsedMs = finishWait.elapsedMs;
      if (finishWait.ok) {
        messages = finishWait.value
          .map((m) => normalizeChatMessage(m, { contentMaxLen: 1 }))
          .map(summarizeMessageMeta)
          .filter(Boolean);
      }
    }

    return okResult({
      sessionId: sid,
      isNewSession,
      beforeUrl,
      afterUrl: location.href,
      sendButton: { className: sendBtn.className || null },
      promptLength: prompt.length,
      promptPreview: prompt.slice(0, 80),
      waitedFinish,
      finishElapsedMs,
      messageCount: messages ? messages.length : null,
      lastMessage: messages ? messages[messages.length - 1] : null,
      timestamp: new Date().toISOString(),
    });
  }

  // ---------------------------------------------------------------------------
  // domEditMessage / domRegenerateMessage
  // ---------------------------------------------------------------------------
  // 与 domSendMessage 同源动机：completion / edit / regenerate 都强制 PoW，
  // 让浏览器自己点对应的 message-action 按钮即可绕开。
  //
  // 定位策略：findMessageActionRows() 把 .ds-icon-button--m 按 y 聚类成"行"，
  // 行按时序排列；按钮数量 2=USER、≥4=ASSISTANT。target 当前仅支持
  // 'lastUser' / 'lastAssistant'（满足 95% 实际需求；针对历史早期消息需要
  // 自动滚动到 row 位置，留给后续）。
  //
  // 按钮槽位（实测 2026-05）：
  //   USER 行: [0]=复制, [1]=编辑
  //   ASSISTANT 行: [0]=复制, [1]=重新生成, [2]=喜欢, [3]=不喜欢, [4]=分享/引用

  // ---------------------------------------------------------------------------
  // _locateMessageInVirtualList
  //
  // 解决 ds-virtual-list 离屏剔除问题：通过滚动 + 内容匹配定位任意 messageId。
  //
  // 算法：
  //   1. 从 history_messages API 拿 target.content 和 role
  //   2. 取 content 前 15 字符做 head 指纹
  //   3. 在当前 viewport 内找匹配（USER 优先 textarea，其次 .ds-message 气泡；
  //      ASSISTANT 找最小的 textContent.includes(head) 容器）
  //   4. 若未命中，从顶部按 (clientHeight - 100) 步长扫到底
  //
  // 返回 { ok, found:{mode:'textarea'|'bubble', el}, target, role } 或 { error }
  async function _locateMessageInVirtualList(sid, messageId) {
    const fetched = await fetchHistoryMessagesRaw(sid);
    const all = (fetched.unwrapped && fetched.unwrapped.biz && fetched.unwrapped.biz.chat_messages) || [];
    const target = all.find((m) => Number(m.message_id) === Number(messageId));
    if (!target) return { error: 'message_id_not_in_session', messageId };
    const role = String(target.role || '').toUpperCase();
    const content = String(target.content || '').replace(/\s+/g, ' ').trim();
    if (!content.length) return { error: 'message_has_no_content_to_match', messageId, role, status: target.status };
    // 内容短时整段当 head（避免 "A1" 这样 2 字符指纹歧义；不超过 30 字防止过长）
    const head = content.length <= 8 ? content : content.slice(0, 30);

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const vl = document.querySelector('.ds-virtual-list');
    if (!vl) return { error: 'no_virtual_list' };

    // 通过 action row 聚类反推 bubble 的 role。
    // 关键观察：DeepSeek 把 action row 放在 bubble 下方（USER 紧贴底；ASSISTANT
    // 在 markdown 内容下方）。所以"取 bubble.bottom 之下、最近的下一行"才对。
    // 简单 abs(y) 最近会把高 ASSISTANT bubble 错配到上方 USER 的 action row。
    function bubbleRole(bubble, rows) {
      const r = bubble.getBoundingClientRect();
      const sorted = rows.slice().sort((a, b) => a.y - b.y);
      for (const row of sorted) {
        if (row.y >= r.bottom - 40) return row.role;
      }
      return null;
    }

    function tryFind() {
      const rows = findMessageActionRows();
      // .ds-message 是气泡容器（USER + ASSISTANT 都用），role 靠邻近 action row 反推
      const bubbles = Array.from(document.querySelectorAll('.ds-message')).filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      const matches = bubbles.filter((b) => {
        const t = (b.textContent || '').replace(/\s+/g, ' ').trim();
        if (!t.includes(head)) return false;
        return bubbleRole(b, rows) === role;
      });
      // 取 textContent 最长的 → 完整 bubble 而不是其中某个内联 span
      matches.sort((a, b) => (b.textContent || '').length - (a.textContent || '').length);
      // 但若过长（远超 content），降级取最短匹配
      const reasonable = matches.find((m) => (m.textContent || '').length <= Math.max(800, content.length * 5 + 400));
      if (reasonable) return { mode: 'bubble', el: reasonable };
      if (matches[0]) return { mode: 'bubble', el: matches[0] };

      // USER 兜底：last user textarea
      if (role === 'USER') {
        const tas = Array.from(document.querySelectorAll('textarea'))
          .filter((t) => !t.readOnly && !t.disabled && t.value && t.value.includes(head));
        if (tas[0]) return { mode: 'textarea', el: tas[0] };
      }
      return null;
    }

    let found = tryFind();
    if (found) return { ok: true, found, target, role, scrollTopUsed: vl.scrollTop };

    const step = Math.max(200, vl.clientHeight - 100);
    const positions = [0];
    for (let s = step; s < vl.scrollHeight; s += step) positions.push(s);
    positions.push(vl.scrollHeight);
    for (const sT of positions) {
      vl.scrollTop = sT;
      await sleep(350);
      found = tryFind();
      if (found) return { ok: true, found, target, role, scrollTopUsed: sT };
    }
    return {
      error: 'message_not_in_current_branch_or_dom',
      hint: '若该 messageId 属于已被 edit 替换的旧分支，UI 不再显示，DOM 找不到对应气泡',
      sH: vl.scrollHeight, cH: vl.clientHeight, headTried: head, role,
    };
  }

  async function _findActionRow(target, opts) {
    opts = opts || {};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let rows = [];
    for (let i = 0; i < 12; i++) {
      rows = findMessageActionRows();
      if (rows.length) break;
      await sleep(200);
    }
    if (!rows.length) return { error: 'no_message_rows_found' };
    function pickRow(rowsArr) {
      if (target === 'lastUser') {
        const u = rowsArr.filter((r) => r.role === 'USER');
        return u[u.length - 1] || null;
      }
      if (target === 'lastAssistant') {
        const a = rowsArr.filter((r) => r.role === 'ASSISTANT');
        return a[a.length - 1] || null;
      }
      return null;
    }
    let row = pickRow(rows);
    if (!row) return { error: 'no_target_row_found', target, rowsTotal: rows.length };

    // 滚到目标按钮可见 — 长 assistant 回复会把 user 行挤出视口
    if (opts.scrollIntoView !== false) {
      const btn = row.buttons[0];
      try { btn.scrollIntoView({ block: 'center', behavior: 'instant' }); }
      catch (_) { try { btn.scrollIntoView(true); } catch (_) {} }
      await sleep(400);
      // 滚动后 virtual list 可能重渲，重新聚类拿 fresh 引用
      rows = findMessageActionRows();
      const fresh = pickRow(rows);
      if (fresh) row = fresh;
    }
    return { row, rowsSummary: rows.map((r) => ({ y: Math.round(r.y), role: r.role, btnCount: r.buttons.length })) };
  }

  // ---------------------------------------------------------------------------
  // _findEditSendButton - 编辑模式 textarea 下方的"发送"按钮（class 含
  // ds-basic-button--primary 或文本含发送）。USER 编辑 textarea 与 composer
  // textarea 都用同一种按钮，靠 y-邻近度区分。
  function _findEditSendButton(taEl) {
    const taRect = taEl.getBoundingClientRect();
    const cands = Array.from(document.querySelectorAll('.ds-basic-button, button, [role="button"]'))
      .filter((b) => {
        if (b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
        const r = b.getBoundingClientRect();
        if (r.width === 0) return false;
        return r.y >= taRect.bottom - 30 && r.y <= taRect.bottom + 220;
      });
    const byCls = cands.find((b) => b.className && b.className.includes && b.className.includes('ds-basic-button--primary'));
    if (byCls) return byCls;
    return cands.find((b) => /发送|确认|Send|Confirm|提交/i.test(b.textContent || '')) || null;
  }

  async function domEditMessage(args) {
    args = args || {};
    const prompt = String(args.prompt || '');
    if (!prompt.length) return errResult('missing_prompt');
    if (prompt.length > 50000) return errResult('prompt_too_long', { length: prompt.length });
    const target = args.target || 'lastUser';
    if (target !== 'lastUser' && target !== 'byMessageId') return errResult('unsupported_target', { target });
    if (target === 'byMessageId' && args.messageId == null) return errResult('missing_message_id_for_byMessageId');

    const sid = parseChatSessionId(location.href);
    if (!sid) return errResult('not_on_chat_session_page');

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const beforeFetch = await fetchHistoryMessagesRaw(sid);
    const beforeMessages = ((beforeFetch.unwrapped && beforeFetch.unwrapped.biz && beforeFetch.unwrapped.biz.chat_messages) || [])
      .map((m) => normalizeChatMessage(m, { contentMaxLen: 1 })).map(summarizeMessageMeta).filter(Boolean);
    const beforeLastUser = [...beforeMessages].reverse().find((m) => m.role === 'USER');
    const beforeMaxId = beforeMessages.reduce((m, x) => Math.max(m, Number(x.messageId) || 0), 0);

    // 路径选择：lastUser 走原来直接 textarea；byMessageId 走 _locateMessageInVirtualList
    let editTa = null;
    let usedPath = null;
    let resolvedTargetMsgId = null;
    let resolvedIsLast = false;

    if (target === 'lastUser') {
      // 直接路径：找当前 viewport 中能被 setter 写入的 user textarea（取最后一个）
      const tas = Array.from(document.querySelectorAll('textarea')).filter((t) => {
        const r = t.getBoundingClientRect();
        return r.width > 0 && !t.disabled && !t.readOnly && t.value && t.value.length > 0;
      });
      if (!tas.length) {
        const vl = document.querySelector('.ds-virtual-list');
        if (vl) { vl.scrollTop = Math.max(0, vl.scrollHeight - vl.clientHeight - 200); await sleep(500); }
        const tas2 = Array.from(document.querySelectorAll('textarea')).filter((t) => {
          const r = t.getBoundingClientRect();
          return r.width > 0 && !t.disabled && !t.readOnly && t.value && t.value.length > 0;
        });
        if (!tas2.length) return errResult('no_user_textarea_in_dom');
        tas.push(...tas2);
      }
      editTa = tas[tas.length - 1];
      usedPath = 'direct_textarea';
      resolvedIsLast = true;
      resolvedTargetMsgId = beforeLastUser ? beforeLastUser.messageId : null;
    } else {
      // byMessageId：定位 → 视情况点 edit 按钮转气泡为 textarea
      const loc = await _locateMessageInVirtualList(sid, args.messageId);
      if (loc.error) return errResult(loc.error, { detail: loc });
      if (loc.role !== 'USER') return errResult('target_message_not_user', { role: loc.role });
      resolvedTargetMsgId = Number(args.messageId);
      // 是否是最后一条 USER：与 beforeLastUser.messageId 比对
      resolvedIsLast = beforeLastUser && beforeLastUser.messageId === resolvedTargetMsgId;

      const { mode, el } = loc.found;
      try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (_) {}
      await sleep(300);

      if (mode === 'textarea') {
        editTa = el;
        usedPath = 'byMessageId_textarea';
      } else {
        // 气泡 → 点击同行 USER action 按钮 [1]=编辑
        const bubY = el.getBoundingClientRect().y;
        const rows = findMessageActionRows();
        const userRows = rows.filter((r) => r.role === 'USER');
        if (!userRows.length) return errResult('no_user_action_rows_after_locate', { bubY });
        userRows.sort((a, b) => Math.abs(a.y - bubY) - Math.abs(b.y - bubY));
        const row = userRows[0];
        if (!row || row.buttons.length < 2) return errResult('user_row_missing_edit_button', { rowY: row && row.y, btnCount: row ? row.buttons.length : 0 });
        if (Math.abs(row.y - bubY) > 250) return errResult('nearest_user_row_too_far_from_bubble', { rowY: row.y, bubY });
        row.buttons[1].click();
        await sleep(400);
        // 等内联 textarea 出现（在 bubble 附近，且新出现）
        const taWait = await waitFor(() => {
          const tas = Array.from(document.querySelectorAll('textarea')).filter((t) => {
            if (t.readOnly || t.disabled || !t.value) return false;
            const r = t.getBoundingClientRect();
            return r.width > 0 && Math.abs(r.y - bubY) < 300;
          });
          return tas[0] || null;
        }, { timeoutMs: 4000, intervalMs: 200 });
        if (!taWait.ok) return errResult('inline_edit_textarea_did_not_appear');
        editTa = taWait.value;
        usedPath = 'byMessageId_via_edit_button';
      }
    }

    editTa.scrollIntoView({ block: 'center', behavior: 'instant' });
    await sleep(200);
    editTa.focus();
    setReactInputValue(editTa, prompt);
    await sleep(200);

    const sendBtnWait = await waitFor(() => _findEditSendButton(editTa), { timeoutMs: 4000, intervalMs: 200 });
    if (!sendBtnWait.ok) return errResult('edit_send_button_not_appeared', { usedPath });
    sendBtnWait.value.click();

    let waitedFinish = false;
    let finishElapsedMs = 0;
    let messages = null;
    if (args.waitForFinish !== false) {
      const finishTimeoutMs = Math.max(5000, Number(args.finishTimeoutMs) || 90000);
      const finishWait = await waitFor(async () => {
        const r = await fetchHistoryMessagesRaw(sid);
        const u = r.unwrapped;
        if (!u || !u.ok) return null;
        const raw = (u.biz && u.biz.chat_messages) || [];
        if (!raw.length) return null;
        const last = raw[raw.length - 1];
        const role = String(last.role || '').toUpperCase();
        const status = String(last.status || '').toUpperCase();
        if (role !== 'ASSISTANT') return null;
        if (status === 'WIP' || status === 'STREAMING' || status === 'PENDING') return null;
        // 必须是编辑后新生的消息（messageId 严格大于编辑前最大值）
        const lastId = Number(last.message_id) || 0;
        if (lastId <= beforeMaxId) return null;
        return raw;
      }, { timeoutMs: finishTimeoutMs, intervalMs: 800, initialDelayMs: 800 });
      waitedFinish = finishWait.ok;
      finishElapsedMs = finishWait.elapsedMs;
      if (finishWait.ok) {
        messages = finishWait.value
          .map((m) => normalizeChatMessage(m, { contentMaxLen: 1 }))
          .map(summarizeMessageMeta).filter(Boolean);
      }
    }

    return okResult({
      sessionId: sid,
      target,
      resolvedTargetMessageId: resolvedTargetMsgId,
      resolvedIsLastUser: !!resolvedIsLast,
      usedPath,
      editedUserMessageBefore: beforeLastUser,
      promptLength: prompt.length,
      promptPreview: prompt.slice(0, 80),
      waitedFinish, finishElapsedMs,
      messageCount: messages ? messages.length : null,
      lastMessage: messages ? messages[messages.length - 1] : null,
      timestamp: new Date().toISOString(),
    });
  }

  async function domRegenerateMessage(args) {
    args = args || {};
    const target = args.target || 'lastAssistant';
    if (target !== 'lastAssistant' && target !== 'byMessageId') return errResult('unsupported_target', { target });
    if (target === 'byMessageId' && args.messageId == null) return errResult('missing_message_id_for_byMessageId');

    const sid = parseChatSessionId(location.href);
    if (!sid) return errResult('not_on_chat_session_page');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const beforeFetch = await fetchHistoryMessagesRaw(sid);
    const beforeMessages = ((beforeFetch.unwrapped && beforeFetch.unwrapped.biz && beforeFetch.unwrapped.biz.chat_messages) || [])
      .map((m) => normalizeChatMessage(m, { contentMaxLen: 1 })).map(summarizeMessageMeta).filter(Boolean);
    const beforeLastAssistant = [...beforeMessages].reverse().find((m) => m.role === 'ASSISTANT');

    let row = null;
    let resolvedTargetMsgId = null;
    let usedPath = null;
    if (target === 'lastAssistant') {
      const found = await _findActionRow('lastAssistant');
      if (found.error) return errResult(found.error, { rowsSummary: found.rowsSummary });
      row = found.row;
      resolvedTargetMsgId = beforeLastAssistant ? beforeLastAssistant.messageId : null;
      usedPath = 'lastAssistant';
    } else {
      const loc = await _locateMessageInVirtualList(sid, args.messageId);
      if (loc.error) return errResult(loc.error, { detail: loc });
      if (loc.role !== 'ASSISTANT') return errResult('target_message_not_assistant', { role: loc.role });
      try { loc.found.el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (_) {}
      await sleep(350);
      const bubBottom = loc.found.el.getBoundingClientRect().bottom;
      const rows = findMessageActionRows();
      const aRows = rows.filter((r) => r.role === 'ASSISTANT');
      if (!aRows.length) return errResult('no_assistant_action_rows_after_locate', { bubBottom });
      // ASSISTANT action row 通常在内容下方 → 选 y > bubble.top - 50 且最接近 bubBottom 的一行
      const bubTop = loc.found.el.getBoundingClientRect().top;
      aRows.sort((a, b) => Math.abs(a.y - bubBottom) - Math.abs(b.y - bubBottom));
      row = aRows[0];
      if (!row) return errResult('assistant_action_row_pick_failed');
      if (row.y < bubTop - 100) return errResult('nearest_assistant_row_above_bubble', { rowY: row.y, bubTop, bubBottom });
      resolvedTargetMsgId = Number(args.messageId);
      usedPath = 'byMessageId';
    }
    if (row.buttons.length < 2) return errResult('assistant_row_missing_regen_button', { btnCount: row.buttons.length });
    const regenBtn = row.buttons[1];

    regenBtn.click();

    let waitedFinish = false;
    let finishElapsedMs = 0;
    let messages = null;
    if (args.waitForFinish !== false) {
      const finishTimeoutMs = Math.max(5000, Number(args.finishTimeoutMs) || 90000);
      const finishWait = await waitFor(async () => {
        const r = await fetchHistoryMessagesRaw(sid);
        const u = r.unwrapped;
        if (!u || !u.ok) return null;
        const raw = (u.biz && u.biz.chat_messages) || [];
        if (!raw.length) return null;
        const last = raw[raw.length - 1];
        const role = String(last.role || '').toUpperCase();
        const status = String(last.status || '').toUpperCase();
        if (role !== 'ASSISTANT') return null;
        if (status === 'WIP' || status === 'STREAMING' || status === 'PENDING') return null;
        // 检查是否真的更换了内容（msgId 应该不同 / 或 inserted_at 更新）
        const prevId = beforeLastAssistant && beforeLastAssistant.messageId;
        const lastNorm = summarizeMessageMeta(normalizeChatMessage(last, { contentMaxLen: 1 }));
        if (prevId && lastNorm.messageId === prevId &&
            beforeLastAssistant.insertedAt === lastNorm.insertedAt) return null;
        return raw;
      }, { timeoutMs: finishTimeoutMs, intervalMs: 800, initialDelayMs: 800 });
      waitedFinish = finishWait.ok;
      finishElapsedMs = finishWait.elapsedMs;
      if (finishWait.ok) {
        messages = finishWait.value
          .map((m) => normalizeChatMessage(m, { contentMaxLen: 1 }))
          .map(summarizeMessageMeta).filter(Boolean);
      }
    }

    return okResult({
      sessionId: sid,
      target,
      resolvedTargetMessageId: resolvedTargetMsgId,
      usedPath,
      regeneratedAssistantBefore: beforeLastAssistant,
      buttonClass: regenBtn.className || null,
      waitedFinish, finishElapsedMs,
      messageCount: messages ? messages.length : null,
      lastMessage: messages ? messages[messages.length - 1] : null,
      timestamp: new Date().toISOString(),
    });
  }

  async function domStopStream() {
    const ta = document.querySelector('textarea');
    const btn = findComposerStopButton(ta);
    if (!btn) return errResult('stop_button_not_found');
    const cls = btn.className || '';
    btn.click();
    return okResult({ clicked: true, buttonClass: cls, timestamp: new Date().toISOString() });
  }

  // ---- INTERACTIVE ----
  function navigateHome() { return navigateLocation(buildDeepseekUrl('/')); }
  function navigateNewChat() { return navigateLocation(buildDeepseekUrl('/')); }
  function navigateSession(args) {
    args = args || {};
    if (args.url) return navigateLocation(String(args.url));
    const sid = args.sessionId || args.id;
    if (!sid) return errResult('missing_session_id');
    return navigateLocation(buildDeepseekUrl('/a/chat/s/' + encodeURIComponent(String(sid).replace(/^\/+|\/+$/g, ''))));
  }

  const api = {
    __meta: { version: VERSION, name: 'chat-bridge' },
    // READ
    probe, state, sessionState, chatPageState,
    getSession, listMessages, getMessage,
    streamingStatus, chatSettingsView, getSessionSnapshot,
    getSessionTree, listBranchPoints, getBranchPath,
    // INTERACTIVE
    navigateHome, navigateNewChat, navigateSession,
    // DESTRUCTIVE
    createSession, renameSession, pinSession, unpinSession,
    feedbackMessage, stopStream,
    sendMessage, editMessage, regenerateMessage,
    domSendMessage, domEditMessage, domRegenerateMessage, domStopStream,
    uploadFile, listFiles,
    shareSession, unshareSession, listShares,
    updateUserSettings,
  };

  try {
    Object.defineProperty(window, '__jse_deepseek_chat__', { value: api, writable: true, configurable: true });
  } catch (_) {
    window.__jse_deepseek_chat__ = api;
  }
  return { ok: true, version: VERSION, name: 'chat-bridge' };
})();
