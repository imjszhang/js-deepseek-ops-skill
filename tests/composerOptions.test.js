'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveComposerMode,
  normalizeComposerArgs,
  assertComposerOptions,
  hasComposerApply,
} = require('../lib/composerOptions');

test('模式别名归一到 default / expert / vision', () => {
  assert.equal(resolveComposerMode('default'), 'default');
  assert.equal(resolveComposerMode('fast'), 'default');
  assert.equal(resolveComposerMode('快速'), 'default');
  assert.equal(resolveComposerMode('快速模式'), 'default');
  assert.equal(resolveComposerMode('expert'), 'expert');
  assert.equal(resolveComposerMode('专家'), 'expert');
  assert.equal(resolveComposerMode('专家模式'), 'expert');
  assert.equal(resolveComposerMode('vision'), 'vision');
  assert.equal(resolveComposerMode('识图'), 'vision');
  assert.equal(resolveComposerMode('识图模式'), 'vision');
  assert.equal(resolveComposerMode('FAST'), 'default');
  assert.equal(resolveComposerMode(null), undefined);
  assert.equal(resolveComposerMode(''), undefined);
  assert.equal(resolveComposerMode('unknown-model'), null);
});

test('normalizeComposerArgs 缺省字段保持 undefined（不改页面）', () => {
  const empty = normalizeComposerArgs({});
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.value, {});
  assert.equal(empty.value.mode, undefined);
  assert.equal(empty.value.thinking, undefined);
  assert.equal(empty.value.search, undefined);

  const onlyPrompt = normalizeComposerArgs({ prompt: 'hi', waitForFinish: true });
  assert.equal(onlyPrompt.ok, true);
  assert.deepEqual(onlyPrompt.value, {});

  const mixed = normalizeComposerArgs({ mode: '专家', thinking: true });
  assert.equal(mixed.ok, true);
  assert.deepEqual(mixed.value, { mode: 'expert', thinking: true });
  assert.equal(mixed.value.search, undefined);

  const unknown = normalizeComposerArgs({ mode: 'turbo' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, 'unknown_mode');
  assert.equal(unknown.raw, 'turbo');
});

test('专家模式 + search=true 冲突', () => {
  const clash = assertComposerOptions({ mode: 'expert', search: true });
  assert.equal(clash.ok, false);
  assert.equal(clash.error, 'search_not_available_in_mode');
  assert.equal(clash.mode, 'expert');

  assert.equal(assertComposerOptions({ mode: 'expert' }).ok, true);
  assert.equal(assertComposerOptions({ mode: 'expert', search: false }).ok, true);
  assert.equal(assertComposerOptions({ mode: 'default', search: true }).ok, true);
  assert.equal(assertComposerOptions({ search: true }).ok, true);
});

test('hasComposerApply 仅在有指定控件时为真', () => {
  assert.equal(hasComposerApply({}), false);
  assert.equal(hasComposerApply({ mode: 'default' }), true);
  assert.equal(hasComposerApply({ thinking: false }), true);
  assert.equal(hasComposerApply({ search: true }), true);
});
