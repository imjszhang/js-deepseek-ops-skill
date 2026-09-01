'use strict';

const path = require('path');
const { createNativeHandlers } = require('@js-eyes/skill-scaffold');
const { TOOL_DEFINITIONS, createRuntime } = require('./skill.definition');

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

const rawHandlers = createNativeHandlers(TOOL_DEFINITIONS);
const handlers = Object.fromEntries(Object.entries(rawHandlers).map(([name, handler]) => [
  name,
  (context, input) => {
    const runtime = bridgeRuntime(context);
    return handler({
      ...context,
      config: runtime.config,
      logger: runtime.logger,
      browser: context.browser,
    }, input);
  },
]));

module.exports = { bridgeRuntime, handlers };
