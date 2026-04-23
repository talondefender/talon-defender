import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyRulesetToggleChange,
  formatRulesetApplyError,
  getRulesetToggleState,
  normalizeEnabledRulesets,
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
