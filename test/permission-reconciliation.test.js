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
  let failNextSessionStorageWrite = false;
  const writeSessionStorage = session.set.bind(session);
  session.set = async values => {
    if (
      failNextSessionStorageWrite &&
      Object.hasOwn(values, 'filteringModeDetails')
    ) {
      failNextSessionStorageWrite = false;
      throw new Error('simulated session storage write failure');
    }
    await writeSessionStorage(values);
  };
  let dynamicRules = [];
  let sessionRules = [];
  let failNextDynamicUpdate = true;
  let failNextSessionUpdate = false;
  let dynamicUpdateCount = 0;
  let sessionUpdateCount = 0;
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
      dynamicUpdateCount += 1;
      if (failNextDynamicUpdate) {
        failNextDynamicUpdate = false;
        throw new Error('simulated DNR write failure');
      }
      dynamicRules = updateRules(dynamicRules, update);
    },
    async updateSessionRules(update) {
      sessionUpdateCount += 1;
      if (failNextSessionUpdate) {
        failNextSessionUpdate = false;
        throw new Error('simulated session DNR write failure');
      }
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

  const dynamicRulesBeforeBrowserRestart = clone(dynamicRules);
  const dynamicUpdateCountBeforeBrowserRestart = dynamicUpdateCount;
  const sessionUpdateCountBeforeBrowserRestart = sessionUpdateCount;
  delete sessionData.filteringModeDetails;
  sessionRules = [];
  readFilteringModeDetails.cache = undefined;
  readFilteringModeDetails.userCache = undefined;
  failNextSessionUpdate = true;

  await assert.rejects(
    () => readFilteringModeDetails(),
    /simulated session DNR write failure/
  );
  assert.deepEqual(dynamicRules, dynamicRulesBeforeBrowserRestart);
  assert.equal(dynamicUpdateCount, dynamicUpdateCountBeforeBrowserRestart);
  assert.equal(sessionUpdateCount, sessionUpdateCountBeforeBrowserRestart + 1);
  assert.deepEqual(sessionData.filteringModeDetails, validSessionModes);
  assert.equal(localData[FILTERING_MODE_DNR_DIRTY_KEY], true);
  assert.equal(sessionRules.some(rule => rule.id === 8000001), false);

  await readFilteringModeDetails(true);
  assert.deepEqual(dynamicRules, dynamicRulesBeforeBrowserRestart);
  assert.equal(
    dynamicUpdateCount,
    dynamicUpdateCountBeforeBrowserRestart,
    'browser-session repair must not rewrite an already-matching dynamic rule'
  );
  assert.equal(sessionUpdateCount, sessionUpdateCountBeforeBrowserRestart + 2);
  assert.equal(sessionRules.some(rule => rule.id === 8000001), true);
  assert.equal(localData[FILTERING_MODE_DNR_DIRTY_KEY], undefined);

  for (const key of Object.keys(localData)) delete localData[key];
  for (const key of Object.keys(sessionData)) delete sessionData[key];
  dynamicRules = [];
  sessionRules = [];
  readFilteringModeDetails.cache = undefined;
  readFilteringModeDetails.userCache = undefined;
  failNextSessionStorageWrite = true;

  await assert.rejects(
    () => readFilteringModeDetails(true),
    /simulated session storage write failure/
  );
  assert.deepEqual(localData.filteringModeDetails, {
    configRevision: 0,
    none: [],
    basic: [],
    optimal: ['all-urls'],
    complete: [],
  });
  assert.equal(localData[FILTERING_MODE_DNR_DIRTY_KEY], true);
  assert.equal(sessionData.filteringModeDetails, undefined);

  await readFilteringModeDetails(true);
  assert.deepEqual(
    sessionData.filteringModeDetails,
    localData.filteringModeDetails
  );
  assert.equal(dynamicRules.some(rule => rule.id === 8000000), true);
  assert.equal(sessionRules.some(rule => rule.id === 8000001), true);
  assert.equal(localData[FILTERING_MODE_DNR_DIRTY_KEY], undefined);
});
