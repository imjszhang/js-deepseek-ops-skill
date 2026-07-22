'use strict';

const recording = require('@js-eyes/skill-recording');
const { hardenRecordsPermissions } = require('./skillRecordsReadme');

function writeDebugBundle(runContext, payload) {
  const bundlePath = recording.writeDebugBundle(runContext, payload);
  if (bundlePath) hardenRecordsPermissions(runContext.paths?.skillDir);
  return bundlePath;
}

module.exports = { writeDebugBundle };
