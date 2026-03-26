import test from 'node:test';
import assert from 'node:assert/strict';

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
  getAutoRegionalRulesetIds,
  reconcileAutoRegionalRulesetPatch,
  reconcileRegionalRulesetOptOutPatch,
  resolvePreferredLanguageTags,
} = await import(new URL('../js/regional-rulesets.js', import.meta.url));

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
