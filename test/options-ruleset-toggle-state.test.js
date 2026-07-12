import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  applyFilteringModeMutationWithRetry,
  applyRulesetToggleDelta,
  applyRulesetToggleChange,
  createRulesetToggleDelta,
  createSerializedActionQueue,
  filteringModesEqual,
  formatRulesetApplyError,
  getRulesetToggleState,
  mergeFilteringModeChanges,
  normalizeEnabledRulesets,
  normalizeFilteringModes,
} from '../options/ruleset-toggle-state.js';
import {
  planStaticRulesetQuotaChange,
} from '../js/default-rulesets.js';

test('normalizeEnabledRulesets removes duplicates and invalid ids', () => {
  assert.deepEqual(
    normalizeEnabledRulesets(['easylist', '', ' easylist ', null, 'easyprivacy']),
    ['easylist', 'easyprivacy']
  );
});

test('getRulesetToggleState reports full, partial, and disabled states intuitively', () => {
  assert.deepEqual(
    getRulesetToggleState(['ublock-filters', 'easylist'], ['ublock-filters', 'easylist']),
    { enabledCount: 2, allEnabled: true, anyEnabled: true, partial: false }
  );

  assert.deepEqual(
    getRulesetToggleState(['ublock-filters'], ['ublock-filters', 'easylist']),
    { enabledCount: 1, allEnabled: false, anyEnabled: true, partial: true }
  );

  assert.deepEqual(
    getRulesetToggleState([], ['ublock-filters', 'easylist']),
    { enabledCount: 0, allEnabled: false, anyEnabled: false, partial: false }
  );
});

test('applyRulesetToggleChange enables and disables only the targeted rulesets', () => {
  assert.deepEqual(
    applyRulesetToggleChange(
      ['easyprivacy'],
      ['ublock-filters', 'easylist'],
      true
    ).sort(),
    ['easylist', 'easyprivacy', 'ublock-filters']
  );

  assert.deepEqual(
    applyRulesetToggleChange(
      ['ublock-filters', 'easylist', 'easyprivacy'],
      ['ublock-filters', 'easylist'],
      false
    ),
    ['easyprivacy']
  );
});

test('ruleset deltas preserve unrelated rulesets', () => {
  const enableDelta = createRulesetToggleDelta(['annoyances-cookies'], true);
  const disableDelta = createRulesetToggleDelta(['annoyances-overlays'], false);

  assert.deepEqual(enableDelta, {
    enableRulesets: ['annoyances-cookies'],
    disableRulesets: [],
  });
  assert.deepEqual(
    applyRulesetToggleDelta(
      applyRulesetToggleDelta(
        ['easylist', 'annoyances-overlays'],
        enableDelta
      ),
      disableDelta
    ).sort(),
    ['annoyances-cookies', 'easylist']
  );
});

test('serialized action queue preserves rapid mutation order and survives a rejection', async () => {
  const queue = createSerializedActionQueue();
  const events = [];
  let releaseFirst;
  const firstGate = new Promise(resolve => {
    releaseFirst = resolve;
  });

  const first = queue.enqueue(async () => {
    events.push('first:start');
    await firstGate;
    events.push('first:end');
  });
  const failed = queue.enqueue(async () => {
    events.push('second');
    throw new Error('expected');
  });
  const third = queue.enqueue(async () => {
    events.push('third');
  });

  await Promise.resolve();
  assert.deepEqual(events, ['first:start']);
  assert.equal(queue.pendingCount, 3);
  releaseFirst();
  await first;
  await assert.rejects(failed, /expected/);
  await third;

  assert.deepEqual(events, ['first:start', 'first:end', 'second', 'third']);
  assert.equal(queue.pendingCount, 0);
});

test('global-pause resume merges changes made while protection was paused', () => {
  const saved = {
    none: ['allowed.example'],
    basic: [],
    optimal: ['all-urls', 'checkout.example'],
    complete: [],
  };
  const paused = {
    none: ['all-urls'],
    basic: [],
    optimal: [],
    complete: [],
  };
  const changedWhilePaused = {
    none: ['all-urls', 'newly-allowed.example'],
    basic: [],
    optimal: [],
    complete: ['checkout.example'],
  };

  const merged = mergeFilteringModeChanges(saved, paused, changedWhilePaused);
  assert.deepEqual(merged, {
    none: ['allowed.example', 'newly-allowed.example'],
    basic: [],
    optimal: ['all-urls'],
    complete: ['checkout.example'],
  });
  assert.equal(filteringModesEqual(merged, {
    complete: ['checkout.example'],
    optimal: ['all-urls'],
    basic: [],
    none: ['newly-allowed.example', 'allowed.example'],
  }), true);
  assert.equal(normalizeFilteringModes({
    none: ['duplicate.example'],
    basic: [],
    optimal: ['duplicate.example'],
    complete: [],
  }), null);
});

test('global-pause CAS re-merges a concurrent site change and retries once', async () => {
  const saved = {
    none: ['allowed.example'],
    basic: [],
    optimal: ['all-urls'],
    complete: [],
  };
  const paused = {
    none: ['all-urls'],
    basic: [],
    optimal: [],
    complete: [],
  };
  const requests = [];
  const result = await applyFilteringModeMutationWithRetry({
    initialState: { ...paused, configRevision: 4 },
    buildModes: currentModes =>
      mergeFilteringModeChanges(saved, paused, currentModes),
    apply: async request => {
      requests.push(request);
      if (requests.length === 1) {
        return {
          error: 'stale_filtering_mode_revision',
          configRevision: 5,
          none: ['all-urls', 'newly-allowed.example'],
          basic: [],
          optimal: [],
          complete: ['checkout.example'],
        };
      }
      return {
        ...request.modes,
        configRevision: 6,
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.deepEqual(requests.map(request => request.expectedRevision), [4, 5]);
  assert.deepEqual(requests[1].modes, {
    none: ['allowed.example', 'newly-allowed.example'],
    basic: [],
    optimal: ['all-urls'],
    complete: ['checkout.example'],
  });
});

test('Pop-ups and Extra protection own disjoint rulesets', async () => {
  const source = await readFile(new URL('../options/options.js', import.meta.url), 'utf8');
  const extraProtectionBlock = source.match(
    /const EXTRA_PROTECTION_RULESETS = \[([\s\S]*?)\];/
  )?.[1] || '';
  assert.doesNotMatch(extraProtectionBlock, /annoyances-overlays/);
  assert.match(source, /rulesets: \["annoyances-overlays"\]/);
  assert.match(source, /enableRulesetIds: delta\.enableRulesets/);
  assert.match(source, /disableRulesetIds: delta\.disableRulesets/);
  assert.match(source, /request\.expectedRevision = rulesetConfigRevision/);
  assert.match(source, /result\?\.error === "stale_ruleset_revision"/);
  assert.doesNotMatch(source, /enabledRulesets: next/);
});

test('customer-facing locale additions are valid and contain no replacement question marks', async () => {
  const localeExpectations = new Map([
    ['ja', ['追加保護', '一部有効']],
    ['ko', ['추가 보호', '일부 활성화']],
    ['fi', ['Lisäsuojaus', 'Osittain käytössä']],
    ['sv', ['Extra skydd', 'Delvis aktiv']],
  ]);
  for (const [locale, [label, partial]] of localeExpectations) {
    const raw = await readFile(
      new URL(`../_locales/${locale}/messages.json`, import.meta.url),
      'utf8'
    );
    const messages = JSON.parse(raw);
    assert.equal(messages.optionsFilterExtraProtectionLabel.message, label);
    assert.equal(messages.uiPartial.message, partial);
    assert.doesNotMatch(messages.optionsFilterExtraProtectionNote.message, /\?/);
    assert.ok(messages.popupRuntimeHotfixReloadNotice.message.length > 10);
    assert.ok(messages.popupRuntimeHotfixReloadButton.message.length > 2);
  }

  for (const locale of ['da', 'de', 'en', 'es', 'fr', 'it', 'nb', 'nl', 'no']) {
    const raw = await readFile(
      new URL(`../_locales/${locale}/messages.json`, import.meta.url),
      'utf8'
    );
    const messages = JSON.parse(raw);
    assert.doesNotMatch(messages.optionsFilterExtraProtectionLabel.message, /\?/);
    assert.doesNotMatch(messages.optionsFilterExtraProtectionNote.message, /\?/);
    assert.ok(messages.popupRuntimeHotfixReloadNotice.message.length > 10);
    assert.ok(messages.popupRuntimeHotfixReloadButton.message.length > 2);
  }

  const popupSource = await readFile(
    new URL('../popup/popup.js', import.meta.url),
    'utf8'
  );
  assert.match(
    popupSource,
    /t\([\s\S]{0,160}"popupRuntimeHotfixReloadNotice"[\s\S]{0,160}"popupRuntimeReloadNotice"/
  );
  assert.match(popupSource, /t\("popupRuntimeHotfixReloadButton"\)/);
  assert.doesNotMatch(
    popupSource,
    /Reload this tab to apply the latest Talon Defender hotfix\./
  );
});

test('planStaticRulesetQuotaChange preserves current state when Chrome static rule quota is too small', () => {
  const details = new Map([
    ['easylist', { rules: { plain: 3000 } }],
    ['regional', { rules: { plain: 5000 } }],
    ['disabled', { rules: { plain: 1000 } }],
  ]);

  assert.deepEqual(
    planStaticRulesetQuotaChange({
      beforeIds: new Set(['easylist', 'disabled']),
      enableRulesetIds: ['regional'],
      disableRulesetIds: ['disabled'],
      rulesetDetails: details,
      availableStaticRuleCount: 2500,
      maxEnabledStaticRulesets: 50,
    }),
    {
      ok: false,
      error: 'static_ruleset_quota_exceeded',
      requiredStaticRuleCount: 5000,
      availableStaticRuleCount: 2500,
      freedStaticRuleCount: 1000,
      projectedAvailableStaticRuleCount: 3500,
    }
  );
});

test('planStaticRulesetQuotaChange accepts requests that fit rule and ruleset limits', () => {
  const details = new Map([
    ['regional', { rules: { plain: 1200 } }],
  ]);
  const plan = planStaticRulesetQuotaChange({
    beforeIds: new Set(['easylist']),
    enableRulesetIds: ['regional'],
    disableRulesetIds: [],
    rulesetDetails: details,
    availableStaticRuleCount: 1500,
    maxEnabledStaticRulesets: 50,
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.requiredStaticRuleCount, 1200);
  assert.equal(plan.projectedAvailableStaticRuleCount, 1500);
});

test('formatRulesetApplyError creates clear quota messages for the options UI', () => {
  assert.equal(
    formatRulesetApplyError({
      error: 'static_ruleset_quota_exceeded',
      staticRuleQuota: {
        requiredStaticRuleCount: 5000,
        projectedAvailableStaticRuleCount: 3500,
      },
    }),
    'Chrome rule limit: needs 5000, available 3500'
  );

  assert.equal(
    formatRulesetApplyError({
      error: 'static_ruleset_count_limit',
      staticRuleQuota: {
        enabledAfterCount: 51,
        maxEnabledStaticRulesets: 50,
      },
    }),
    'Chrome ruleset limit: 51/50'
  );
});
