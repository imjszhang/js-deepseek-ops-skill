'use strict';

function clone(value) {
  return JSON.parse(JSON.stringify(value || { type: 'object', properties: {} }));
}

function tightenProperty(name, schema = {}) {
  const next = { ...schema };
  if (next.type === 'string') {
    if (next.minLength == null && !['mime'].includes(name)) next.minLength = 1;
    if (next.maxLength == null) {
      if (name === 'prompt') next.maxLength = 50000;
      else if (name === 'contentBase64') next.maxLength = 14000000;
      else if (name === 'title') next.maxLength = 200;
      else if (name === 'url') next.maxLength = 2048;
      else next.maxLength = 1000;
    }
  }
  if (next.type === 'number') {
    next.type = 'integer';
    if (next.minimum == null) next.minimum = name === 'feedback' ? -1 : 0;
    if (next.maximum == null) {
      if (/timeout/i.test(name)) next.maximum = 300000;
      else if (/limit|count/i.test(name)) next.maximum = 100;
      else if (name === 'contentMaxLen') next.maximum = 200000;
      else if (name === 'truncLen') next.maximum = 10000;
      else next.maximum = Number.MAX_SAFE_INTEGER;
    }
  }
  if (next.type === 'array' && next.maxItems == null) next.maxItems = 100;
  if (next.type === 'object' && next.maxProperties == null) next.maxProperties = 32;
  return next;
}

function hardenToolSchema(toolName, inputSchema) {
  const schema = clone(inputSchema);
  schema.type = 'object';
  schema.properties ||= {};
  schema.required ||= [];
  schema.additionalProperties = false;
  schema.properties = Object.fromEntries(
    Object.entries(schema.properties).map(([name, property]) => [name, tightenProperty(name, property)]),
  );
  if (toolName === 'deepseek_navigate_session') {
    schema.anyOf = [{ required: ['sessionId'] }, { required: ['url'] }];
  }
  if (['deepseek_dom_edit_message', 'deepseek_dom_regenerate_message'].includes(toolName)) {
    schema.allOf = [{
      if: { properties: { target: { const: 'byMessageId' } }, required: ['target'] },
      then: { required: ['messageId'] },
    }];
  }
  if (toolName === 'deepseek_update_user_settings' && schema.properties.settings) {
    schema.properties.settings = {
      ...schema.properties.settings,
      minProperties: 1,
      maxProperties: 16,
      propertyNames: { pattern: '^[a-zA-Z][a-zA-Z0-9_]{0,63}$' },
    };
  }
  return schema;
}

module.exports = { hardenToolSchema, tightenProperty };
