import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyRulesetToggleChange,
  getRulesetToggleState,
  normalizeEnabledRulesets,
} from '../options/ruleset-toggle-state.js';

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
