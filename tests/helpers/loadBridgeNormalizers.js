// tests/helpers/loadBridgeNormalizers.js
// ---------------------------------------------------------------------------
// 通过 vm sandbox 加载 lib/composerOptions.js + bridges/common.js（纯浏览器代码），从中取出归一化函数。
// 这样测试用的就是真实生产代码、零副本（保持单一来源不漂移）。
//
// common.js 是顶层函数声明（无 IIFE 包裹），但里面有些函数会引用
// browser globals（localStorage / window / document / fetch 等）。这些 globals
// 只在函数被调用时才会触发解引用——本 helper 只关心 normalizeChatMessage /
// normalizeChatSessionItem / clampLimit / shortText / unixToIso，它们全部纯逻辑、
// 不触碰 globals。为了让 common.js 解析成功，sandbox 给空 stub 即可。
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const COMPOSER_OPTS_PATH = path.join(__dirname, '..', '..', 'lib', 'composerOptions.js');
const COMMON_BRIDGE_PATH = path.join(__dirname, '..', '..', 'bridges', 'common.js');

let _cached = null;

function loadBridgeNormalizers() {
  if (_cached) return _cached;
  const src = fs.readFileSync(COMPOSER_OPTS_PATH, 'utf8') + '\n' + fs.readFileSync(COMMON_BRIDGE_PATH, 'utf8');
  const sandbox = {
    window: {},
    document: { querySelector: () => null, querySelectorAll: () => [] },
    location: { href: '', origin: '' },
    localStorage: { getItem: () => null, setItem: () => {} },
    navigator: { userAgent: 'node-test' },
    fetch: () => Promise.reject(new Error('fetch is not available in test sandbox')),
    crypto: undefined,
    console,
    module: { exports: {} },
  };
  sandbox.globalThis = sandbox;
  const tail = '\n;module.exports = { clampLimit, shortText, unixToIso, normalizeChatMessage, normalizeChatSessionItem, summarizeMessageMeta };';
  vm.runInNewContext(src + tail, sandbox, { filename: 'bridges/common.js' });
  _cached = sandbox.module.exports;
  return _cached;
}

module.exports = { loadBridgeNormalizers };
