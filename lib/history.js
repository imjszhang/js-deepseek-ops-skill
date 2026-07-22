'use strict';

const recording = require('@js-eyes/skill-recording');
const { hardenRecordsPermissions } = require('./skillRecordsReadme');

function appendHistory(runContext, entry) {
  const filePath = recording.appendHistory(runContext, entry);
  if (filePath) hardenRecordsPermissions(runContext.paths?.skillDir);
  return filePath;
}

module.exports = { appendHistory, getHistoryFilePath: recording.getHistoryFilePath };
