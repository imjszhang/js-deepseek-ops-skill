'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { interpretHistory } = require('../lib/sync/interpretHistory');

test('HTTP 304 与显式 flag 才是 not_modified', () => {
  assert.deepEqual(interpretHistory({ httpStatus: 304, ok: true }), { kind: 'not_modified', reason: 'http_304' });
  assert.deepEqual(
    interpretHistory({ httpStatus: 200, ok: true, notModified: true }),
    { kind: 'not_modified', reason: 'explicit_not_modified' },
  );
  assert.deepEqual(
    interpretHistory({ httpStatus: 200, ok: true, bizFlags: { cache_valid: true } }),
    { kind: 'not_modified', reason: 'biz_flag' },
  );
});

test('空 messages 不能当成 not_modified', () => {
  const r = interpretHistory({
    httpStatus: 200,
    ok: true,
    messages: [],
    sentCacheParams: true,
    local: { cacheResetAt: 1 },
    cacheResetAt: 1,
  });
  assert.equal(r.kind, 'full');
  assert.equal(r.reason, 'cache_params_unconfirmed_fallback_full');
});

test('未知形状 fallback 全量', () => {
  assert.equal(interpretHistory({ httpStatus: 200, ok: true }).kind, 'full');
  assert.equal(interpretHistory({}).kind, 'full');
});

test('cache_reset_at 变化 → reset', () => {
  const r = interpretHistory({
    httpStatus: 200,
    ok: true,
    cacheResetAt: 99,
    local: { cacheResetAt: 10 },
  });
  assert.deepEqual(r, { kind: 'reset', reason: 'cache_reset_at_changed' });
});

test('fetch 失败 → error', () => {
  assert.deepEqual(interpretHistory({ ok: false, httpStatus: 500 }), { kind: 'error', reason: 'fetch_failed' });
});
