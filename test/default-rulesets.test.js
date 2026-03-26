import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  applyDefaultRulesetFlagsToDetails,
  getDefaultRulesetIdsFromRuleResources,
  reconcileDefaultRulesetPatch,
} from '../js/default-rulesets.js';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const PACKAGED_OUT_DIR = path.join(repoRoot, 'dist', `test-default-rulesets-${process.pid}`);
const EXPECTED_DEFAULT_IDS = [
  'ublock-filters',
  'easylist',
  'easyprivacy',
  'annoyances-overlays',
  'ublock-badware',
  'urlhaus-full',
];
const EXPECTED_REGIONAL_IDS = [
  'deu-0',
  'fra-0',
  'spa-0',
  'spa-1',
  'ita-0',
  'nld-0',
  'jpn-1',
  'kor-1',
  'swe-1',
  'fin-0',
  'tur-0',
  'vie-1',
  'ukr-0',
  'rus-0',
  'rus-1',
  'rou-1',
  'cze-0',
  'grc-0',
  'hun-0',
  'idn-0',
  'mkd-0',
  'lva-0',
  'ltu-0',
  'svn-0',
  'tha-0',
  'chn-0',
  'irn-0',
  'isr-0',
];
const EXPECTED_BLOCKED_REGIONAL_IDS = [
  'bgr-0',
  'hrv-0',
  'isl-0',
  'nor-0',
  'pol-0',
];
const EXPECTED_BUNDLED_IDS = [
  'ublock-filters',
  'easylist',
  'easyprivacy',
  'annoyances-cookies',
  'annoyances-notifications',
  'annoyances-others',
  'annoyances-overlays',
  'annoyances-social',
  'annoyances-widgets',
  'ublock-badware',
  'urlhaus-full',
  ...EXPECTED_REGIONAL_IDS,
];
const EXPECTED_EXTRA_PROTECTION_IDS = [
  'annoyances-cookies',
  'annoyances-notifications',
  'annoyances-others',
  'annoyances-social',
  'annoyances-widgets',
];

const readJson = async relativePath => {
  const absUrl = new URL(relativePath, import.meta.url);
  return JSON.parse(await fs.readFile(absUrl, 'utf8'));
};

const readText = async relativePath => {
  const absUrl = new URL(relativePath, import.meta.url);
  return fs.readFile(absUrl, 'utf8');
};

let packagedBundlePromise;
const getPackagedBundle = () => {
  if (packagedBundlePromise) { return packagedBundlePromise; }
  packagedBundlePromise = (async () => {
    await execFileAsync(
      process.execPath,
      ['scripts/package-extension.mjs', '--out', `dist/test-default-rulesets-${process.pid}`],
      { cwd: repoRoot }
    );
    const readPackagedJson = async (...parts) => {
      const absPath = path.join(PACKAGED_OUT_DIR, ...parts);
      return JSON.parse(await fs.readFile(absPath, 'utf8'));
    };
    return {
      manifest: await readPackagedJson('manifest.json'),
      details: await readPackagedJson('rulesets', 'ruleset-details.json'),
      licensePolicy: await readPackagedJson('rulesets', 'ruleset-license-policy.json'),
    };
  })();
  return packagedBundlePromise;
};

test('canonical default rulesets are derived from manifest rule resources', async () => {
  const manifest = await readJson('../manifest.json');
  const ids = getDefaultRulesetIdsFromRuleResources(
    manifest?.declarative_net_request?.rule_resources
  );

  assert.equal(ids.includes('annoyances-overlays'), true);
  assert.deepEqual(ids, EXPECTED_DEFAULT_IDS);
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

test('source manifest bundles the full annoyance family and public-safe regional lists while keeping the same defaults', async () => {
  const manifest = await readJson('../manifest.json');
  const bundledIds = (manifest?.declarative_net_request?.rule_resources || [])
    .map(entry => entry?.id)
    .filter(id => typeof id === 'string' && id !== '');
  const defaultIds = getDefaultRulesetIdsFromRuleResources(
    manifest?.declarative_net_request?.rule_resources
  );

  assert.deepEqual(bundledIds, EXPECTED_BUNDLED_IDS);
  assert.deepEqual(defaultIds, EXPECTED_DEFAULT_IDS);
  assert.equal(
    EXPECTED_BLOCKED_REGIONAL_IDS.every(id => bundledIds.includes(id) === false),
    true
  );
});

test('packaged build preserves bundled annoyance coverage, regional coverage, defaults, and metadata parity', async () => {
  const { manifest, details, licensePolicy } = await getPackagedBundle();
  const bundledIds = (manifest?.declarative_net_request?.rule_resources || [])
    .map(entry => entry?.id)
    .filter(id => typeof id === 'string' && id !== '');
  const defaultIds = getDefaultRulesetIdsFromRuleResources(
    manifest?.declarative_net_request?.rule_resources
  );
  const detailIds = details
    .map(entry => entry?.id)
    .filter(id => typeof id === 'string' && id !== '');
  const licenseIds = Object.keys(licensePolicy?.rulesets || {}).sort();
  const expectedSortedIds = EXPECTED_BUNDLED_IDS.slice().sort();
  const expectedDefaultIdSet = new Set(EXPECTED_DEFAULT_IDS);

  assert.deepEqual(bundledIds, EXPECTED_BUNDLED_IDS);
  assert.deepEqual(defaultIds, EXPECTED_DEFAULT_IDS);
  assert.deepEqual(detailIds.slice().sort(), expectedSortedIds);
  assert.deepEqual(licenseIds, expectedSortedIds);
  assert.equal(
    EXPECTED_BLOCKED_REGIONAL_IDS.every(id => bundledIds.includes(id) === false),
    true
  );

  for (const entry of details) {
    assert.equal(
      entry.enabled,
      expectedDefaultIdSet.has(entry.id),
      `packaged ruleset-details default flag mismatch for ${entry.id}`
    );
  }
});

test('complete mode annoyance pack includes the full bundled annoyance family set', async () => {
  const manifest = await readJson('../manifest.json');
  const backgroundSource = await readText('../js/background.js');
  const match = /const ANNOYANCE_RULESET_IDS = \[([\s\S]*?)\];/.exec(backgroundSource);

  assert.ok(match, 'ANNOYANCE_RULESET_IDS declaration should exist');

  const ids = Array.from(match[1].matchAll(/'([^']+)'/g), entry => entry[1]);
  const bundledIds = new Set(
    (manifest?.declarative_net_request?.rule_resources || [])
      .map(entry => entry?.id)
      .filter(id => typeof id === 'string' && id !== '')
  );

  assert.deepEqual(ids, EXPECTED_BUNDLED_IDS.filter(id => id.startsWith('annoyances-')));
  assert.equal(ids.every(id => bundledIds.has(id)), true);
  assert.match(backgroundSource, /ANNOYANCE_RULESET_IDS\.every/);
  assert.match(backgroundSource, /enabledBefore\.concat\(ANNOYANCE_RULESET_IDS\)/);
});

test('options extra protection toggle targets the bundled non-default annoyance packs', async () => {
  const optionsSource = await readText('../options/options.js');
  const optionsHtml = await readText('../options/options.html');
  const match = /const EXTRA_PROTECTION_RULESETS = \[([\s\S]*?)\];/.exec(optionsSource);

  assert.ok(match, 'EXTRA_PROTECTION_RULESETS declaration should exist');
  const ids = Array.from(match[1].matchAll(/'([^']+)'|"([^"]+)"/g), entry => entry[1] || entry[2]);
  assert.deepEqual(ids, EXPECTED_EXTRA_PROTECTION_IDS);
  assert.equal(ids.every(id => EXPECTED_BUNDLED_IDS.includes(id)), true);
  assert.match(optionsHtml, /id="filterExtraProtection"/);
});

test('all bundled locales define extra protection toggle strings', async () => {
  const localesDir = path.join(repoRoot, '_locales');
  const localeEntries = await fs.readdir(localesDir, { withFileTypes: true });
  const locales = localeEntries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();

  for (const locale of locales) {
    const messages = await readJson(`../_locales/${locale}/messages.json`);
    for (const key of [
      'optionsFilterExtraProtectionLabel',
      'optionsFilterExtraProtectionNote',
      'uiPartial',
    ]) {
      assert.equal(
        typeof messages?.[key]?.message,
        'string',
        `${locale} should define ${key}`
      );
      assert.notEqual(messages[key].message.trim(), '', `${locale} should not leave ${key} empty`);
    }
  }
});
