import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import {
  applyDefaultRulesetFlagsToDetails,
  getDefaultRulesetIdsFromRuleResources,
  reconcileDefaultRulesetPatch,
} from '../js/default-rulesets.js';

const readJson = async relativePath => {
  const absUrl = new URL(relativePath, import.meta.url);
  return JSON.parse(await fs.readFile(absUrl, 'utf8'));
};

test('canonical default rulesets are derived from manifest rule resources', async () => {
  const manifest = await readJson('../manifest.json');
  const ids = getDefaultRulesetIdsFromRuleResources(
    manifest?.declarative_net_request?.rule_resources
  );

  assert.equal(ids.includes('annoyances-overlays'), true);
  assert.deepEqual(ids, [
    'ublock-filters',
    'easylist',
    'easyprivacy',
    'annoyances-overlays',
    'ublock-badware',
    'urlhaus-full',
  ]);
});

test('ruleset details can be synced to canonical default flags', () => {
  const synced = applyDefaultRulesetFlagsToDetails([
    { id: 'easylist', enabled: false },
    { id: 'annoyances-overlays', enabled: false },
    { id: 'custom-list', enabled: true },
  ], [
    'easylist',
    'annoyances-overlays',
  ]);

  assert.deepEqual(synced, [
    { id: 'easylist', enabled: true },
    { id: 'annoyances-overlays', enabled: true },
    { id: 'custom-list', enabled: false },
  ]);
});

test('default ruleset migration enables newly-defaulted rulesets on old profiles', () => {
  const previousDefaults = [
    'ublock-filters',
    'easylist',
    'easyprivacy',
    'ublock-badware',
    'urlhaus-full',
  ];
  const nextDefaults = previousDefaults.concat('annoyances-overlays');

  const patched = reconcileDefaultRulesetPatch({
    currentEnabledRulesets: previousDefaults,
    storedDefaultRulesetIds: previousDefaults,
    nextDefaultRulesetIds: nextDefaults,
  });

  assert.equal(patched.changed, true);
  assert.equal(patched.patchedEnabledRulesets.includes('annoyances-overlays'), true);
  assert.deepEqual(patched.addedDefaultRulesets, ['annoyances-overlays']);
});

test('default ruleset migration preserves customized profiles and later user opt-outs', () => {
  const previousDefaults = [
    'ublock-filters',
    'easylist',
    'easyprivacy',
    'ublock-badware',
    'urlhaus-full',
  ];
  const nextDefaults = previousDefaults.concat('annoyances-overlays');

  const customized = reconcileDefaultRulesetPatch({
    currentEnabledRulesets: [
      'ublock-filters',
      'easylist',
      'ublock-badware',
      'urlhaus-full',
    ],
    storedDefaultRulesetIds: previousDefaults,
    nextDefaultRulesetIds: nextDefaults,
  });

  assert.equal(customized.patchedEnabledRulesets.includes('easyprivacy'), false);
  assert.equal(customized.patchedEnabledRulesets.includes('annoyances-overlays'), true);

  const optedOutAfterMigration = reconcileDefaultRulesetPatch({
    currentEnabledRulesets: [
      'ublock-filters',
      'easylist',
      'easyprivacy',
      'ublock-badware',
      'urlhaus-full',
    ],
    storedDefaultRulesetIds: nextDefaults,
    nextDefaultRulesetIds: nextDefaults,
  });

  assert.equal(optedOutAfterMigration.changed, false);
  assert.equal(optedOutAfterMigration.patchedEnabledRulesets.includes('annoyances-overlays'), false);
});

test('source ruleset metadata matches manifest defaults for bundled rulesets', async () => {
  const manifest = await readJson('../manifest.json');
  const details = await readJson('../rulesets/ruleset-details.json');

  const manifestDefaultIds = new Set(
    getDefaultRulesetIdsFromRuleResources(
      manifest?.declarative_net_request?.rule_resources
    )
  );
  const bundledIds = new Set(
    (manifest?.declarative_net_request?.rule_resources || [])
      .map(entry => entry?.id)
      .filter(id => typeof id === 'string' && id !== '')
  );

  for (const entry of details) {
    if (bundledIds.has(entry?.id) === false) { continue; }
    assert.equal(
      entry.enabled,
      manifestDefaultIds.has(entry.id),
      `ruleset-details.json default flag mismatch for ${entry.id}`
    );
  }
});
