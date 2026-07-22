'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writeAuditEntry, writeBackup } = require('../lib/audit');
const { hardenRecordsPermissions } = require('../lib/skillRecordsReadme');
const { redactGetSessionResult } = require('../lib/redact');
const { assertAllowedUserSettings, resolveAllowedUserSettingKeys } = require('../lib/settingsPolicy');
const { hardenToolSchema } = require('../lib/toolSchema');
const { prefetchShareBackup } = require('../skill.contract');
const { bridgeRuntime } = require('../skill.entry');
const { createRunContext } = require('../lib/runContext');
const { appendHistory } = require('../lib/history');
const { writeDebugBundle } = require('../lib/debug');
const { runCliToFile } = require('../lib/runCliToFile');
const { parseArgv: parseBranchManagerArgv } = require('../scripts/deepseek-branch-manager');

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}

test('audit 与 backup 默认脱敏并使用私有权限', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-audit-'));
  const oldHome = process.env.JS_EYES_HOME;
  process.env.JS_EYES_HOME = temp;
  try {
    const context = { skillId: 'js-deepseek-ops-skill', skillVersion: 'test', runId: 'run-1' };
    const auditPath = writeAuditEntry(context, {
      tool: 'deepseek_send_message',
      args: {
        prompt: 'private prompt', sessionId: 'safe-id', title: 'private title',
        nested: { authorization: 'Bearer abc', body: { arbitrary: 'private body' } },
      },
      result: { content: 'private answer', ok: true },
    });
    const backupPath = writeBackup(context, {
      resource: 'share', id: 'share-1', snapshot: { body: 'private snapshot', state: 'active' },
    });
    const combined = fs.readFileSync(auditPath, 'utf8') + fs.readFileSync(backupPath, 'utf8');
    assert.doesNotMatch(combined, /private prompt|private answer|private title|Bearer abc|private body|private snapshot/);
    assert.match(combined, /"sha256"/);
    assert.equal(mode(auditPath), 0o600);
    assert.equal(mode(backupPath), 0o600);
    assert.equal(mode(path.dirname(auditPath)), 0o700);
  } finally {
    if (oldHome == null) delete process.env.JS_EYES_HOME;
    else process.env.JS_EYES_HOME = oldHome;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('已有记录权限会递归收紧，符号链接不会跟随', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-perms-'));
  try {
    const nested = path.join(temp, 'audit');
    fs.mkdirSync(nested, { mode: 0o755 });
    const file = path.join(nested, 'audit.jsonl');
    fs.writeFileSync(file, '{}\n', { mode: 0o644 });
    hardenRecordsPermissions(temp);
    if (process.platform !== 'win32') {
      assert.equal(mode(temp), 0o700);
      assert.equal(mode(nested), 0o700);
      assert.equal(mode(file), 0o600);
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('V2 使用宿主 scoped storage，history/debug 新文件保持私有', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-v2-storage-'));
  const skillRoot = path.join(temp, 'js-deepseek-ops-skill');
  try {
    const runtime = bridgeRuntime({
      config: { recording: { mode: 'debug' } }, storage: { root: skillRoot },
      logger: { info() {}, warn() {}, error() {} }, browser: {},
    });
    assert.equal(runtime.config.skillDataRoot, skillRoot);
    assert.equal(runtime.config.recording.baseDir, temp);
    const context = createRunContext({
      skillId: 'js-deepseek-ops-skill', skillVersion: 'test', scrapeType: 'test',
      url: 'deepseek-tool://test/', recording: runtime.config.recording, debugRecording: true,
    });
    const historyPath = appendHistory(context, { status: 'success' });
    const debugPath = writeDebugBundle(context, { meta: {}, steps: [], result: {} });
    assert.ok(historyPath.startsWith(skillRoot));
    assert.ok(debugPath.startsWith(skillRoot));
    if (process.platform !== 'win32') {
      assert.equal(mode(historyPath), 0o600);
      assert.equal(mode(path.join(debugPath, 'result.json')), 0o600);
      assert.equal(mode(path.dirname(historyPath)), 0o700);
      assert.equal(mode(debugPath), 0o700);
    }
    runtime.dispose();
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('本地归档文件使用私有权限，branch-manager 默认不读取正文', async () => {
  assert.equal(parseBranchManagerArgv(['scan', 'session-1']).opts.redact, 'off');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-cli-file-'));
  try {
    fs.writeFileSync(path.join(temp, 'print.js'), "process.stdout.write('private output')\n");
    const output = path.join(temp, 'nested', 'result.json');
    const run = await runCliToFile({ skillDir: temp, entry: 'print.js', args: [], outFile: output });
    assert.equal(run.code, 0);
    assert.equal(fs.readFileSync(output, 'utf8'), 'private output');
    if (process.platform !== 'win32') assert.equal(mode(output), 0o600);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('消息正文默认 off，只有显式 full 才返回原文', () => {
  const source = { messages: [{ content: 'secret', thinkingContent: 'thought' }] };
  const safe = redactGetSessionResult(source, {});
  assert.equal(safe.messages[0].content, null);
  assert.equal(safe.messages[0].thinkingContent, null);
  assert.equal(safe.redact.mode, 'off');
  assert.equal(safe.messages[0].contentHash.length, 64);
  const full = redactGetSessionResult(source, { mode: 'full' });
  assert.equal(full.messages[0].content, 'secret');
});

test('账号设置默认拒绝，且只允许管理员声明的键', () => {
  assert.deepEqual(resolveAllowedUserSettingKeys({}), []);
  assert.throws(() => assertAllowedUserSettings({ theme: 'dark' }, {}), { code: 'E_SETTING_KEY_DENIED' });
  const config = { allowedUserSettingKeys: ['theme', 'theme', 'bad-key'] };
  assert.deepEqual(resolveAllowedUserSettingKeys(config), ['theme']);
  assert.deepEqual(assertAllowedUserSettings({ theme: 'dark' }, config), { theme: 'dark' });
  assert.throws(() => assertAllowedUserSettings({ theme: 'dark', role: 'admin' }, config), { code: 'E_SETTING_KEY_DENIED' });
});

test('工具 schema 拒绝额外字段并约束高风险输入', () => {
  const schema = hardenToolSchema('deepseek_send_message', {
    type: 'object', properties: { prompt: { type: 'string' }, timeoutMs: { type: 'number' } }, required: ['prompt'],
  });
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.prompt.maxLength, 50000);
  assert.equal(schema.properties.timeoutMs.type, 'integer');
  assert.equal(schema.properties.timeoutMs.maximum, 300000);
  const nav = hardenToolSchema('deepseek_navigate_session', {
    type: 'object', properties: { sessionId: { type: 'string' }, url: { type: 'string' } },
  });
  assert.deepEqual(nav.anyOf, [{ required: ['sessionId'] }, { required: ['url'] }]);
});

test('删除分享前必须成功取得分享列表快照', async () => {
  const calls = [];
  const backup = await prefetchShareBackup({
    async callApi(method, args) {
      calls.push({ method, args });
      return { ok: true, data: { shares: [{ id: 'share-1' }] } };
    },
  }, { shareId: 'share-1' });
  assert.equal(backup.resource, 'share');
  assert.equal(backup.id, 'share-1');
  assert.deepEqual(calls[0].args, [{ count: 100 }]);
  await assert.rejects(
    () => prefetchShareBackup({ async callApi() { return { ok: false, error: 'offline' }; } }, { shareId: 'share-1' }),
    { code: 'E_BACKUP_SOURCE_UNAVAILABLE' },
  );
});
