// tests/loaderExpand.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { expandBridgeSource } = require('../lib/session');

test('@@include ./common.js 仍工作（向后兼容）', () => {
  const src = '// header\n// @@include ./common.js\n// footer\n';
  const out = expandBridgeSource(src);
  assert.ok(out.includes('function clampLimit'), 'common.js 内容应被嵌入');
  assert.ok(out.includes('// header'));
  assert.ok(out.includes('// footer'));
});

test('@@include 多个相对路径都被替换', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jse-expand-'));
  try {
    fs.writeFileSync(path.join(tmp, 'a.js'), 'const A = 1;');
    fs.writeFileSync(path.join(tmp, 'b.js'), 'const B = 2;');
    const src = '// top\n// @@include ./a.js\n// mid\n// @@include ./b.js\n// end\n';
    const out = expandBridgeSource(src, { baseDir: tmp });
    assert.ok(out.includes('const A = 1;'));
    assert.ok(out.includes('const B = 2;'));
    assert.ok(!/@@include/.test(out), '不应残留 @@include 指令');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('@@include 不存在的相对路径报错并带文件名', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jse-expand-'));
  try {
    const src = '// @@include ./does-not-exist.js\n';
    assert.throws(
      () => expandBridgeSource(src, { baseDir: tmp }),
      (err) => /does-not-exist\.js/.test(err.message) && /baseDir=/.test(err.message),
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('@@include 不递归：被嵌入文件中的 @@include 不再展开', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jse-expand-'));
  try {
    fs.writeFileSync(path.join(tmp, 'inner.js'), '// @@include ./never.js\nconst INNER = 1;');
    const src = '// @@include ./inner.js\n';
    const out = expandBridgeSource(src, { baseDir: tmp });
    assert.ok(out.includes('const INNER = 1;'));
    // inner 文件中的 @@include 应原样保留（不递归）
    assert.ok(/@@include\s+\.\/never\.js/.test(out));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('@@include ../lib/sessionTree.js 能从 bridges/ 解析到 lib/', () => {
  const src = '// @@include ../lib/sessionTree.js\n';
  const out = expandBridgeSource(src);
  assert.ok(out.includes('function buildSessionTree'));
  assert.ok(out.includes('function _emptyTreeStats'));
});

test('home-bridge 展开后含共享 history 拉取与 getSessionForSync', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bridges', 'home-bridge.js'), 'utf8');
  const out = expandBridgeSource(src);
  assert.ok(out.includes('function fetchHistoryMessagesRaw'));
  assert.ok(out.includes('async function getSessionForSync'));
  assert.ok(!/^[ \t]*\/\/\s*@@include\s+/m.test(out));
});

test('chat-bridge 先嵌入 composerOptions 再嵌入 common', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bridges', 'chat-bridge.js'), 'utf8');
  const out = expandBridgeSource(src);
  assert.ok(!/^[ \t]*\/\/\s*@@include\s+/m.test(out), '不应残留 @@include 指令');
  const optsAt = out.indexOf('function normalizeComposerArgs');
  const chromeAt = out.indexOf('function readComposerChrome');
  const treeAt = out.indexOf('function buildSessionTree');
  assert.ok(optsAt !== -1 && chromeAt !== -1 && treeAt !== -1);
  assert.ok(optsAt < chromeAt, 'composerOptions 应在 common 之前');
  assert.ok(chromeAt < treeAt, 'common 应在 sessionTree 之前');
});
