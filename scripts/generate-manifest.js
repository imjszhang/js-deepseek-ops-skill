'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const outputPath = path.join(ROOT, 'skill.manifest.json');
const pkg = require(path.join(ROOT, 'package.json'));
const contract = require(path.join(ROOT, 'skill.contract.js'));
const VERIFY = process.argv.includes('--check');
const TOOL_CAPABILITIES = Object.freeze([
  'browser.tabs.read',
  'browser.navigation',
  'browser.script.execute',
  'filesystem.skillData',
]);

function riskFor(tool) {
  if (tool.name === 'deepseek_update_user_settings') return 'administrative';
  if (tool.destructive === true) return 'destructive';
  if (tool.interactive === true) return 'interactive';
  return 'read';
}

const manifest = {
  manifestVersion: 2,
  id: pkg.name,
  name: contract.name,
  version: pkg.version,
  publisher: 'imjszhang',
  description: pkg.description,
  entry: './skill.entry.js',
  compatibility: {
    jsEyes: '>=2.8.5 <3',
    contractApi: '^2.0.0',
    runtimeApi: '^2.0.0',
    node: '>=22',
  },
  requirements: {
    server: true,
    browserExtension: true,
    login: true,
    platforms: ['chat.deepseek.com'],
  },
  capabilities: {
    browser: ['tabs.read', 'navigation', 'script.execute'],
    network: { direct: false, hosts: [] },
    filesystem: ['skillData'],
    process: [],
    secrets: [],
    background: false,
  },
  cli: contract.cli,
  tools: contract.TOOL_DEFINITIONS.map((tool) => {
    const projected = contract.projectTool(tool);
    return {
      name: projected.name,
      title: projected.label,
      description: projected.description,
      risk: riskFor(tool),
      capabilities: TOOL_CAPABILITIES,
      inputSchema: projected.parameters,
    };
  }),
};

const expected = `${JSON.stringify(manifest, null, 2)}\n`;
const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
if (current !== expected) {
  if (VERIFY) {
    process.stderr.write('skill.manifest.json is stale; run npm run manifest\n');
    process.exitCode = 1;
  } else {
    fs.writeFileSync(outputPath, expected);
  }
}
