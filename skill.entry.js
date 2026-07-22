'use strict';

const path = require('path');
const { TOOL_DEFINITIONS, createRuntime } = require('./skill.contract');

function bridgeRuntime(context) {
  const skillDataRoot = context.storage?.root || null;
  const config = {
    ...context.config,
    ...(skillDataRoot ? {
      skillDataRoot,
      recording: { ...(context.config?.recording || {}), baseDir: path.dirname(skillDataRoot) },
    } : {}),
  };
  const legacy = createRuntime(config, context.logger);
  return Object.freeze({
    ...legacy,
    config: legacy.config || context.config,
    logger: legacy.logger || context.logger,
    ensureBot: () => context.browser,
    dispose() {},
  });
}

module.exports = {
  bridgeRuntime,
  handlers: Object.fromEntries(TOOL_DEFINITIONS.map((tool) => [
    tool.name,
    async (context, input) => tool.execute(bridgeRuntime(context), input || {}, {
      toolCallId: context.toolCallId,
      invocationId: context.invocationId,
      signal: context.signal,
      source: context.source,
    }),
  ])),
};
