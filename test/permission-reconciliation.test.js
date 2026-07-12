import test from 'node:test';
import assert from 'node:assert/strict';

const clone = value => value === undefined ? undefined : structuredClone(value);

const createStorageArea = data => ({
  async get(keys) {
    if (keys === null) return clone(data);
    if (Array.isArray(keys)) {
      return Object.fromEntries(keys
        .filter(key => Object.hasOwn(data, key))
        .map(key => [key, clone(data[key])]));
    }
    if (typeof keys === 'object') {
      const out = clone(keys);
      for (const key of Object.keys(keys)) {
        if (Object.hasOwn(data, key)) out[key] = clone(data[key]);
      }
      return out;
    }
    return Object.hasOwn(data, keys) ? { [keys]: clone(data[keys]) } : {};
  },
  async set(values) {
    Object.assign(data, clone(values));
  },
  async remove(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
  },
});

test('filtering-mode intent survives DNR failure and read retry repairs before permission snapshot advances', async () => {
  const initialModes = {
    configRevision: 0,
    none: ['trusted.example'],
    basic: ['all-urls'],
    optimal: [],
    complete: [],
  };
  const localData = {
    filteringModeDetails: clone(initialModes),
  };
  const sessionData = {
    filteringModeDetails: clone(initialModes),
  };
  const local = createStorageArea(localData);
  const session = createStorageArea(sessionData);
  let dynamicRules = [];
  let sessionRules = [];
  let failNextDynamicUpdate = true;
  const selectRules = (rules, options) => {
    const ids = options?.ruleIds;
    return clone(Array.isArray(ids)
      ? rules.filter(rule => ids.includes(rule.id))
      : rules);
  };
  const updateRules = (before, update) => {
    const removed = new Set(update.removeRuleIds || []);
    return [
      ...before.filter(rule => removed.has(rule.id) === false),
      ...clone(update.addRules || []),
    ];
  };
  const dnr = {
    MAX_NUMBER_OF_DYNAMIC_RULES: 5000,
    MAX_NUMBER_OF_REGEX_RULES: 1000,
    RuleConditionKeys: {},
    async getDynamicRules(options) {
      return selectRules(dynamicRules, options);
    },
    async getSessionRules(options) {
      return selectRules(sessionRules, options);
    },
    async updateDynamicRules(update) {
      if (failNextDynamicUpdate) {
        failNextDynamicUpdate = false;
        throw new Error('simulated DNR write failure');
      }
      dynamicRules = updateRules(dynamicRules, update);
    },
    async updateSessionRules(update) {
      sessionRules = updateRules(sessionRules, update);
    },
  };
  const browserStub = {
    declarativeNetRequest: dnr,
    permissions: {
      async getAll() {
        return { origins: ['*://*.newly-granted.example/*'] };
      },
    },
    runtime: {
      id: 'talon-permission-reconciliation-test',
      getManifest() {
        return { permissions: [], declarative_net_request: { rule_resources: [] } };
      },
      getURL(path = '') {
        return new URL(path, 'chrome-extension://talon-permission-reconciliation-test/').toString();
      },
    },
    storage: {
      local,
      session,
      managed: {
        async get() { return {}; },
      },
    },
    tabs: { TAB_ID_NONE: -1 },
  };
  globalThis.self = globalThis;
  globalThis.browser = browserStub;
  globalThis.chrome = browserStub;
  globalThis.BroadcastChannel = class {
    postMessage() {}
  };

  const {
    FILTERING_MODE_DNR_DIRTY_KEY,
    readFilteringModeDetails,
    syncWithBrowserPermissions,
  } = await import('../js/mode-manager.js');

  await assert.rejects(
    () => syncWithBrowserPermissions(),
    /simulated DNR write failure/
  );
  assert.equal(localData['permissions.hostnames'], undefined);
  assert.deepEqual(
    localData.filteringModeDetails.optimal,
    ['newly-granted.example']
  );
  assert.deepEqual(
    sessionData.filteringModeDetails,
    localData.filteringModeDetails
  );
  assert.equal(localData[FILTERING_MODE_DNR_DIRTY_KEY], true);

  await syncWithBrowserPermissions();
  assert.deepEqual(
    localData['permissions.hostnames'],
    ['newly-granted.example']
  );
  assert.deepEqual(
    localData.filteringModeDetails.optimal,
    ['newly-granted.example']
  );
  assert.equal(localData[FILTERING_MODE_DNR_DIRTY_KEY], undefined);
  assert.equal(dynamicRules.some(rule => rule.id === 8000000), true);
  assert.equal(sessionRules.some(rule => rule.id === 8000001), true);

  const validLocalModes = clone(localData.filteringModeDetails);
  const validSessionModes = clone(sessionData.filteringModeDetails);
  const dynamicRulesBeforeCorruption = clone(dynamicRules);
  const sessionRulesBeforeCorruption = clone(sessionRules);

  localData.filteringModeDetails = [];
  await assert.rejects(
    () => readFilteringModeDetails(true),
    /invalid local filteringModeDetails record/
  );
  assert.deepEqual(sessionData.filteringModeDetails, validSessionModes);
  assert.deepEqual(dynamicRules, dynamicRulesBeforeCorruption);
  assert.deepEqual(sessionRules, sessionRulesBeforeCorruption);

  localData.filteringModeDetails = clone(validLocalModes);
  sessionData.filteringModeDetails = 'corrupt-session-modes';
  await assert.rejects(
    () => readFilteringModeDetails(true),
    /invalid session filteringModeDetails record/
  );
  assert.deepEqual(localData.filteringModeDetails, validLocalModes);
  assert.deepEqual(dynamicRules, dynamicRulesBeforeCorruption);
  assert.deepEqual(sessionRules, sessionRulesBeforeCorruption);

  sessionData.filteringModeDetails = clone(validSessionModes);
  await readFilteringModeDetails(true);
});
