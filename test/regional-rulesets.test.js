import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

globalThis.self = globalThis;
globalThis.browser = {
  declarativeNetRequest: {},
  i18n: {
    async getAcceptLanguages() {
      return [];
    },
    getMessage(key) {
      return key === '@@ui_locale' ? 'en' : '';
    },
  },
  runtime: {
    getURL(path = '') {
      return `chrome-extension://talon-defender-test/${path}`;
    },
  },
  storage: {
    local: {},
    session: {},
  },
  tabs: {
    TAB_ID_NONE: -1,
  },
};
globalThis.chrome = globalThis.browser;

const {
  AUTO_REGIONAL_RULESET_IDS_STORAGE_KEY,
  REGIONAL_RULESET_OPT_OUT_STORAGE_KEY,
  getAutoRegionalRulesetIds,
  reconcileAutoRegionalRulesetPatch,
  reconcileRegionalRulesetOptOutPatch,
  resolvePreferredLanguageTags,
} = await import(new URL('../js/regional-rulesets.js', import.meta.url));

const backgroundSource = await readFile(
  new URL('../js/background.js', import.meta.url),
  'utf8'
);
const regionalBackgroundFunctionSource = backgroundSource.slice(
  backgroundSource.indexOf('async function patchAutoRegionalRulesets()'),
  backgroundSource.indexOf('function stopIsolatedRuntimeControllers()')
);

const createRegionalBackgroundHarness = ({
  enabledRulesets = ['ublock-filters'],
  autoRegionalRulesetIds = [],
  regionalRulesetOptOutIds = [],
  failReadKey = '',
} = {}) => {
  const clone = value => Array.isArray(value) ? value.slice() : value;
  const storage = new Map([
    [AUTO_REGIONAL_RULESET_IDS_STORAGE_KEY, clone(autoRegionalRulesetIds)],
    [REGIONAL_RULESET_OPT_OUT_STORAGE_KEY, clone(regionalRulesetOptOutIds)],
  ]);
  const writes = [];
  const rulesetConfig = {
    enabledRulesets: enabledRulesets.slice(),
  };
  let failedRead = false;

  const readLocalStrict = async key => {
    if ( key === failReadKey && failedRead === false ) {
      failedRead = true;
      throw new Error(`storage read failed for ${key}`);
    }
    return clone(storage.get(key));
  };
  const localWrite = async (key, value) => {
    const cloned = clone(value);
    writes.push([key, cloned]);
    storage.set(key, cloned);
  };
  const buildFunctions = new Function(
    'getBundledRegionalRulesetIds',
    'readLocalStrict',
    'getPreferredLanguageTags',
    'getAutoRegionalRulesetIds',
    'reconcileAutoRegionalRulesetPatch',
    'rulesetConfig',
    'localWrite',
    'reconcileRegionalRulesetOptOutPatch',
    'AUTO_REGIONAL_RULESET_IDS_STORAGE_KEY',
    'REGIONAL_RULESET_OPT_OUT_STORAGE_KEY',
    `${regionalBackgroundFunctionSource}\nreturn {\n` +
      '  patchAutoRegionalRulesets,\n' +
      '  syncRegionalRulesetOptOutState,\n' +
      '};'
  );
  const functions = buildFunctions(
    () => ['deu-0'],
    readLocalStrict,
    async () => ['de-DE'],
    getAutoRegionalRulesetIds,
    reconcileAutoRegionalRulesetPatch,
    rulesetConfig,
    localWrite,
    reconcileRegionalRulesetOptOutPatch,
    AUTO_REGIONAL_RULESET_IDS_STORAGE_KEY,
    REGIONAL_RULESET_OPT_OUT_STORAGE_KEY
  );

  return { ...functions, rulesetConfig, storage, writes };
};

test('preferred language tags use primary subtags and ui locale fallback', () => {
  assert.deepEqual(
    resolvePreferredLanguageTags({
      acceptLanguages: ['de-DE', 'fr-CA', 'de', 'es-419'],
      uiLocale: 'ja',
    }),
    ['de', 'fr', 'es']
  );
  assert.deepEqual(
    resolvePreferredLanguageTags({
      acceptLanguages: [],
      uiLocale: 'pt-BR',
    }),
    ['pt']
  );
});

test('locale-matched auto regional rulesets are filtered by bundled availability', () => {
  assert.deepEqual(
    getAutoRegionalRulesetIds({
      acceptLanguages: ['ru-RU', 'ja-JP', 'bg-BG'],
      availableRulesetIds: ['jpn-1', 'rus-0', 'rus-1'],
    }),
    ['rus-0', 'rus-1', 'jpn-1']
  );
});

test('fresh untouched profiles auto-enable bundled locale-matched regionals', () => {
  const patch = reconcileAutoRegionalRulesetPatch({
    currentEnabledRulesets: ['ublock-filters', 'easylist'],
    storedAutoRegionalRulesetIds: [],
    storedRegionalOptOutIds: [],
    nextAutoRegionalRulesetIds: ['deu-0'],
    regionalRulesetFamilyIds: ['deu-0', 'fra-0'],
  });

  assert.equal(patch.changed, true);
  assert.equal(patch.customized, false);
  assert.deepEqual(patch.addedAutoRulesetIds, ['deu-0']);
  assert.equal(patch.patchedEnabledRulesets.includes('deu-0'), true);
  assert.deepEqual(patch.autoRegionalRulesetIds, ['deu-0']);
});

test('customized profiles with manual regional choices are left untouched', () => {
  const patch = reconcileAutoRegionalRulesetPatch({
    currentEnabledRulesets: ['ublock-filters', 'jpn-1'],
    storedAutoRegionalRulesetIds: [],
    storedRegionalOptOutIds: [],
    nextAutoRegionalRulesetIds: ['deu-0'],
    regionalRulesetFamilyIds: ['deu-0', 'jpn-1'],
  });

  assert.equal(patch.changed, false);
  assert.equal(patch.customized, true);
  assert.deepEqual(patch.patchedEnabledRulesets, ['ublock-filters', 'jpn-1']);
});

test('auto regional patch respects opt-outs and never auto-disables user-enabled regionals', () => {
  const patch = reconcileAutoRegionalRulesetPatch({
    currentEnabledRulesets: ['ublock-filters', 'rus-0', 'fra-0'],
    storedAutoRegionalRulesetIds: ['rus-0'],
    storedRegionalOptOutIds: ['rus-1'],
    nextAutoRegionalRulesetIds: ['rus-0', 'rus-1'],
    regionalRulesetFamilyIds: ['rus-0', 'rus-1', 'fra-0'],
  });

  assert.equal(patch.changed, false);
  assert.equal(patch.patchedEnabledRulesets.includes('fra-0'), true);
  assert.equal(patch.patchedEnabledRulesets.includes('rus-0'), true);
  assert.equal(patch.patchedEnabledRulesets.includes('rus-1'), false);
  assert.deepEqual(patch.autoRegionalRulesetIds, ['rus-0']);
});

test('opt-out reconciliation records manual disable of auto-managed regionals and clears on re-enable', () => {
  const disabledPatch = reconcileRegionalRulesetOptOutPatch({
    enabledRulesets: ['ublock-filters', 'rus-0'],
    storedAutoRegionalRulesetIds: ['rus-0', 'rus-1'],
    storedRegionalOptOutIds: [],
  });

  assert.equal(disabledPatch.changed, true);
  assert.deepEqual(disabledPatch.regionalRulesetOptOutIds, ['rus-1']);

  const reenabledPatch = reconcileRegionalRulesetOptOutPatch({
    enabledRulesets: ['ublock-filters', 'rus-0', 'rus-1'],
    storedAutoRegionalRulesetIds: ['rus-0', 'rus-1'],
    storedRegionalOptOutIds: ['rus-1'],
  });

  assert.equal(reenabledPatch.changed, true);
  assert.deepEqual(reenabledPatch.regionalRulesetOptOutIds, []);
});

for ( const failReadKey of [
  AUTO_REGIONAL_RULESET_IDS_STORAGE_KEY,
  REGIONAL_RULESET_OPT_OUT_STORAGE_KEY,
] ) {
  test(`auto regional background patch does not mutate state when ${failReadKey} read rejects and succeeds on retry`, async () => {
    const harness = createRegionalBackgroundHarness({ failReadKey });

    await assert.rejects(
      harness.patchAutoRegionalRulesets(),
      new RegExp(`storage read failed for ${failReadKey}`)
    );
    assert.deepEqual(harness.rulesetConfig.enabledRulesets, ['ublock-filters']);
    assert.deepEqual(
      harness.storage.get(AUTO_REGIONAL_RULESET_IDS_STORAGE_KEY),
      []
    );
    assert.deepEqual(
      harness.storage.get(REGIONAL_RULESET_OPT_OUT_STORAGE_KEY),
      []
    );
    assert.deepEqual(harness.writes, []);

    const patch = await harness.patchAutoRegionalRulesets();
    assert.equal(patch.changed, true);
    assert.deepEqual(
      harness.rulesetConfig.enabledRulesets,
      ['ublock-filters', 'deu-0']
    );
    assert.deepEqual(
      harness.storage.get(AUTO_REGIONAL_RULESET_IDS_STORAGE_KEY),
      ['deu-0']
    );
    assert.deepEqual(
      harness.storage.get(REGIONAL_RULESET_OPT_OUT_STORAGE_KEY),
      []
    );
    assert.equal(harness.writes.length, 2);
  });
}

for ( const failReadKey of [
  AUTO_REGIONAL_RULESET_IDS_STORAGE_KEY,
  REGIONAL_RULESET_OPT_OUT_STORAGE_KEY,
] ) {
  test(`regional opt-out sync does not mutate storage when ${failReadKey} read rejects and succeeds on retry`, async () => {
    const harness = createRegionalBackgroundHarness({
      autoRegionalRulesetIds: ['rus-0', 'rus-1'],
      failReadKey,
    });
    const enabledRulesets = ['ublock-filters', 'rus-0'];

    await assert.rejects(
      harness.syncRegionalRulesetOptOutState(enabledRulesets),
      new RegExp(`storage read failed for ${failReadKey}`)
    );
    assert.deepEqual(
      harness.storage.get(REGIONAL_RULESET_OPT_OUT_STORAGE_KEY),
      []
    );
    assert.deepEqual(harness.writes, []);

    const changed = await harness.syncRegionalRulesetOptOutState(enabledRulesets);
    assert.equal(changed, true);
    assert.deepEqual(
      harness.storage.get(REGIONAL_RULESET_OPT_OUT_STORAGE_KEY),
      ['rus-1']
    );
    assert.equal(harness.writes.length, 1);
  });
}
