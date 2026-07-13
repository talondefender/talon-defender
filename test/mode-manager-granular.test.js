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
    return Object.hasOwn(data, keys) ? { [keys]: clone(data[keys]) } : {};
  },
  async set(values) {
    Object.assign(data, clone(values));
  },
  async remove(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
  },
});

test('granular permission reconciliation preserves Complete sites covered by exact or parent grants', async () => {
  const initialModes = {
    configRevision: 0,
    none: [],
    basic: [],
    optimal: ['all-urls'],
    complete: [],
  };
  const localData = { filteringModeDetails: clone(initialModes) };
  const sessionData = { filteringModeDetails: clone(initialModes) };
  const browserStub = {
    declarativeNetRequest: {
      MAX_NUMBER_OF_DYNAMIC_RULES: 5000,
      MAX_NUMBER_OF_REGEX_RULES: 1000,
      RuleConditionKeys: {},
      async getDynamicRules() { return []; },
      async getSessionRules() { return []; },
      async updateDynamicRules() {},
      async updateSessionRules() {},
    },
    permissions: {
      async getAll() { return { origins: [] }; },
    },
    runtime: {
      id: 'talon-mode-manager-granular-test',
      getManifest() {
        return { permissions: [], declarative_net_request: { rule_resources: [] } };
      },
      getURL(path = '') {
        return new URL(
          path,
          'chrome-extension://talon-mode-manager-granular-test/'
        ).toString();
      },
    },
    storage: {
      local: createStorageArea(localData),
      session: createStorageArea(sessionData),
      managed: { async get() { return {}; } },
    },
    tabs: { TAB_ID_NONE: -1 },
  };
  globalThis.self = globalThis;
  globalThis.browser = browserStub;
  globalThis.chrome = browserStub;
  globalThis.BroadcastChannel = class { postMessage() {} };

  const {
    MODE_BASIC,
    MODE_OPTIMAL,
    applyEffectiveModeDeltaToUser,
    applyManagedFilteringModes,
    reconcileGranularPermissionModes,
    setFilteringModeDetails,
  } = await import('../js/mode-manager.js');
  const filteringModes = {
    none: new Set(),
    basic: new Set(['all-urls']),
    optimal: new Set(),
    complete: new Set([
      'exact.example',
      'child.parent.example',
      'revoked.example',
    ]),
  };
  const modified = reconcileGranularPermissionModes({
    filteringModes,
    beforeAllowedHostnames: new Set([
      'exact.example',
      'parent.example',
      'revoked.example',
    ]),
    afterAllowedHostnames: new Set([
      'exact.example',
      'parent.example',
      'new.example',
    ]),
    fallbackMode: MODE_BASIC,
  });

  assert.equal(modified, true);
  assert.equal(filteringModes.complete.has('exact.example'), true);
  assert.equal(filteringModes.complete.has('child.parent.example'), true);
  assert.equal(filteringModes.complete.has('revoked.example'), false);
  assert.equal(filteringModes.optimal.has('new.example'), true);
  assert.equal(MODE_OPTIMAL, 2);

  assert.equal(reconcileGranularPermissionModes({
    filteringModes,
    beforeAllowedHostnames: new Set([
      'exact.example',
      'parent.example',
      'new.example',
    ]),
    afterAllowedHostnames: new Set([
      'exact.example',
      'parent.example',
      'new.example',
    ]),
    fallbackMode: MODE_BASIC,
  }), false);

  const rawUserModes = {
    none: new Set(),
    basic: new Set(),
    optimal: new Set(['all-urls']),
    complete: new Set(['user-complete.example']),
  };
  const managedEffectiveModes = applyManagedFilteringModes(
    rawUserModes,
    'complete',
    ['managed-none.example']
  );
  const desiredEffectiveModes = {
    none: new Set(managedEffectiveModes.none),
    basic: new Set(managedEffectiveModes.basic),
    optimal: new Set(managedEffectiveModes.optimal),
    complete: new Set(managedEffectiveModes.complete),
  };
  desiredEffectiveModes.basic.add('user-basic.example');
  const updatedRawUserModes = {
    none: new Set(rawUserModes.none),
    basic: new Set(rawUserModes.basic),
    optimal: new Set(rawUserModes.optimal),
    complete: new Set(rawUserModes.complete),
  };
  applyEffectiveModeDeltaToUser(
    updatedRawUserModes,
    managedEffectiveModes,
    desiredEffectiveModes
  );

  assert.equal(updatedRawUserModes.optimal.has('all-urls'), true);
  assert.equal(updatedRawUserModes.complete.has('all-urls'), false);
  assert.equal(updatedRawUserModes.none.has('managed-none.example'), false);
  assert.equal(updatedRawUserModes.basic.has('user-basic.example'), true);
  const reappliedEffectiveModes = applyManagedFilteringModes(
    updatedRawUserModes,
    'complete',
    ['managed-none.example']
  );
  assert.equal(reappliedEffectiveModes.complete.has('all-urls'), true);
  assert.equal(reappliedEffectiveModes.none.has('managed-none.example'), true);

  let staleError;
  try {
    await setFilteringModeDetails(rawUserModes, 999);
  } catch (error) {
    staleError = error;
  }
  assert.equal(staleError?.code, 'stale_filtering_mode_revision');
  assert.equal(staleError?.currentDetails?.configRevision, 0);
  assert.deepEqual(staleError?.currentDetails?.optimal, ['all-urls']);
  const storedAfterConflict = await browserStub.storage.local.get(
    'filteringModeDetails'
  );
  assert.equal(storedAfterConflict.filteringModeDetails.configRevision, 0);
});
