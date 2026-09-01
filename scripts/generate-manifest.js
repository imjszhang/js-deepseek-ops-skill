'use strict';

const fs = require('fs');
const path = require('path');
const { writeSkillManifest } = require('@js-eyes/skill-scaffold');

const ROOT = path.resolve(__dirname, '..');
const VERIFY = process.argv.includes('--check');

const { manifestPath, expected } = writeSkillManifest(ROOT, { dryRun: true });
const current = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, 'utf8') : '';
if (current !== expected) {
  if (VERIFY) {
    process.stderr.write('skill.manifest.json is stale; run npm run manifest\n');
    process.exitCode = 1;
  } else {
    fs.writeFileSync(manifestPath, expected);
  }
}
