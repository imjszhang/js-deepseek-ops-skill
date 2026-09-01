'use strict';

/**
 * L1 响应解释。未知形状一律 full，禁止把空 chat_messages 猜成 not-modified。
 * 合同见 docs/dev/cache-version-scout.md。
 */

function interpretHistory(input) {
  const {
    httpStatus,
    ok,
    notModified,
    bizFlags,
    cacheResetAt,
    local,
    sentCacheParams,
  } = input || {};

  if (httpStatus === 304 || notModified === true) {
    return { kind: 'not_modified', reason: httpStatus === 304 ? 'http_304' : 'explicit_not_modified' };
  }

  const flags = bizFlags || {};
  if (flags.not_modified === true || flags.cache_valid === true || flags.notModified === true) {
    return { kind: 'not_modified', reason: 'biz_flag' };
  }

  const localReset = local && local.cacheResetAt != null ? Number(local.cacheResetAt) : null;
  const remoteReset = cacheResetAt != null ? Number(cacheResetAt) : null;
  if (localReset != null && remoteReset != null && localReset !== remoteReset) {
    return { kind: 'reset', reason: 'cache_reset_at_changed' };
  }

  if (ok === false) {
    return { kind: 'error', reason: 'fetch_failed' };
  }

  return {
    kind: 'full',
    reason: sentCacheParams ? 'cache_params_unconfirmed_fallback_full' : 'no_cache_params',
  };
}

module.exports = { interpretHistory };
