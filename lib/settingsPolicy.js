'use strict';

const SKILL_ID = 'js-deepseek-ops-skill';

function resolveAllowedUserSettingKeys(config = {}) {
  const nested = config.skills?.[SKILL_ID]?.config || {};
  const value = config.allowedUserSettingKeys ?? nested.allowedUserSettingKeys;
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((key) => (
    typeof key === 'string' && /^[a-z][a-z0-9_]{0,63}$/i.test(key)
  ))));
}

function assertAllowedUserSettings(settings, config = {}) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    const error = new Error('settings must be an object');
    error.code = 'E_BAD_ARG';
    throw error;
  }
  const keys = Object.keys(settings);
  const allowed = new Set(resolveAllowedUserSettingKeys(config));
  const denied = keys.filter((key) => !allowed.has(key));
  if (denied.length > 0 || keys.length === 0) {
    const error = new Error(
      denied.length > 0
        ? `User setting keys are not allowed: ${denied.join(', ')}`
        : 'settings must contain at least one approved key',
    );
    error.code = 'E_SETTING_KEY_DENIED';
    error.safeDetails = { denied, allowed: [...allowed] };
    throw error;
  }
  return settings;
}

module.exports = {
  SKILL_ID,
  assertAllowedUserSettings,
  resolveAllowedUserSettingKeys,
};
