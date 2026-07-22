'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const pkg = require('../package.json');
const manifest = require('../skill.manifest.json');
const entry = require('../skill.entry');
const contract = require('../skill.contract');

test('V2 manifest 与 contract/entry 保持一一对应', () => {
  assert.equal(manifest.manifestVersion, 2);
  assert.equal(manifest.id, pkg.name);
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.entry, './skill.entry.js');
  assert.equal(manifest.tools.length, 33);
  assert.equal(new Set(manifest.tools.map((tool) => tool.name)).size, manifest.tools.length);
  assert.deepEqual(
    manifest.tools.map((tool) => tool.name),
    contract.TOOL_DEFINITIONS.map((tool) => tool.name),
  );
  assert.deepEqual(Object.keys(entry.handlers), manifest.tools.map((tool) => tool.name));
});

test('V2 manifest 声明最小能力、风险和闭合输入 schema', () => {
  assert.deepEqual(manifest.capabilities.network, { direct: false, hosts: [] });
  assert.deepEqual(manifest.capabilities.process, []);
  assert.deepEqual(manifest.capabilities.secrets, []);
  const risks = manifest.tools.reduce((acc, tool) => {
    acc[tool.risk] = (acc[tool.risk] || 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(risks, { read: 13, interactive: 3, destructive: 16, administrative: 1 });
  for (const tool of manifest.tools) {
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.ok(tool.capabilities.includes('browser.script.execute'), tool.name);
  }
});

test('浏览器客户端只复用官方共享 SDK', () => {
  const facade = require('../lib/js-eyes-client');
  const sdk = require('@js-eyes/client-sdk');
  assert.equal(facade.BrowserAutomation, sdk.BrowserAutomation);
});
