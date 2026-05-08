import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  applyDefaultRulesetFlagsToDetails,
  getDefaultRulesetIdsFromRuleResources,
  RULESET_SELECTION_STATE_VERSION,
  reconcileDefaultRulesetPatch,
} from '../js/default-rulesets.js';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
let packagedOutDir;
const EXPECTED_DEFAULT_IDS = [
  'ublock-filters',
  'easylist',
  'easyprivacy',
  'pgl',
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
  'pgl',
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
const getPackagedOutDir = async () => {
  if (packagedOutDir === undefined) {
    packagedOutDir = await fs.mkdtemp(path.join(os.tmpdir(), 'talon-default-rulesets-'));
  }
  return packagedOutDir;
};

after(async () => {
  if (packagedOutDir === undefined) { return; }
  await fs.rm(packagedOutDir, { recursive: true, force: true });
});

const getPackagedBundle = () => {
  if (packagedBundlePromise) { return packagedBundlePromise; }
  packagedBundlePromise = (async () => {
    const outDir = await getPackagedOutDir();
    await execFileAsync(
      process.execPath,
      ['scripts/package-extension.mjs', '--out', outDir],
      { cwd: repoRoot }
    );
    const readPackagedJson = async (...parts) => {
      const absPath = path.join(outDir, ...parts);
      return JSON.parse(await fs.readFile(absPath, 'utf8'));
    };
    return {
      outDir,
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

  assert.equal(ids.includes('annoyances-overlays'), false);
  assert.deepEqual(ids, EXPECTED_DEFAULT_IDS);
});

test('ruleset details can be synced to canonical default flags', () => {
  const synced = applyDefaultRulesetFlagsToDetails([
    { id: 'easylist', enabled: false },
    { id: 'annoyances-overlays', enabled: true },
    { id: 'custom-list', enabled: true },
  ], [
    'easylist'
  ]);

  assert.deepEqual(synced, [
    { id: 'easylist', enabled: true },
    { id: 'annoyances-overlays', enabled: false },
    { id: 'custom-list', enabled: false },
  ]);
});

test('default ruleset migration disables formerly-default overlay rulesets on old profiles', () => {
  const previousDefaults = [
    'ublock-filters',
    'easylist',
    'easyprivacy',
    'annoyances-overlays',
    'ublock-badware',
    'urlhaus-full',
  ];
  const nextDefaults = previousDefaults.filter(id => id !== 'annoyances-overlays');

  const patched = reconcileDefaultRulesetPatch({
    currentEnabledRulesets: previousDefaults,
    storedDefaultRulesetIds: previousDefaults,
    nextDefaultRulesetIds: nextDefaults,
  });

  assert.equal(patched.changed, true);
  assert.equal(patched.patchedEnabledRulesets.includes('annoyances-overlays'), false);
  assert.deepEqual(patched.removedDefaultRulesets, ['annoyances-overlays']);
});

test('default ruleset migration preserves customized profiles and later user opt-outs', () => {
  const previousDefaults = [
    'ublock-filters',
    'easylist',
    'easyprivacy',
    'annoyances-overlays',
    'ublock-badware',
    'urlhaus-full',
  ];
  const nextDefaults = previousDefaults.filter(id => id !== 'annoyances-overlays');

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
  assert.equal(customized.patchedEnabledRulesets.includes('annoyances-overlays'), false);

  const optedInAfterMigration = reconcileDefaultRulesetPatch({
    currentEnabledRulesets: [
      'ublock-filters',
      'easylist',
      'easyprivacy',
      'annoyances-overlays',
      'ublock-badware',
      'urlhaus-full',
    ],
    storedDefaultRulesetIds: nextDefaults,
    nextDefaultRulesetIds: nextDefaults,
  });

  assert.equal(optedInAfterMigration.changed, false);
  assert.equal(optedInAfterMigration.patchedEnabledRulesets.includes('annoyances-overlays'), true);
});

test('default ruleset migration adds pgl only to still-default old profiles', () => {
  const previousDefaults = EXPECTED_DEFAULT_IDS.filter(id => id !== 'pgl');
  const nextDefaults = EXPECTED_DEFAULT_IDS;

  const stillDefault = reconcileDefaultRulesetPatch({
    currentEnabledRulesets: previousDefaults,
    storedDefaultRulesetIds: previousDefaults,
    nextDefaultRulesetIds: nextDefaults,
  });
  assert.equal(stillDefault.changed, true);
  assert.equal(stillDefault.patchedEnabledRulesets.includes('pgl'), true);
  assert.deepEqual(stillDefault.addedDefaultRulesets, ['pgl']);

  const customized = reconcileDefaultRulesetPatch({
    currentEnabledRulesets: previousDefaults.filter(id => id !== 'easyprivacy'),
    storedDefaultRulesetIds: previousDefaults,
    nextDefaultRulesetIds: nextDefaults,
  });
  assert.equal(customized.patchedEnabledRulesets.includes('pgl'), false);
  assert.deepEqual(customized.addedDefaultRulesets, []);
});

test('legacy ruleset selections reset once to the canonical install defaults', () => {
  const patched = reconcileDefaultRulesetPatch({
    currentEnabledRulesets: [
      'annoyances-cookies',
      'annoyances-overlays',
    ],
    storedDefaultRulesetIds: EXPECTED_DEFAULT_IDS,
    nextDefaultRulesetIds: EXPECTED_DEFAULT_IDS,
    rulesetSelectionVersion: 0,
  });

  assert.equal(patched.changed, true);
  assert.equal(patched.resetToDefaults, true);
  assert.equal(patched.storageChanged, true);
  assert.equal(patched.rulesetSelectionVersion, RULESET_SELECTION_STATE_VERSION);
  assert.deepEqual(patched.patchedEnabledRulesets, EXPECTED_DEFAULT_IDS);
});

test('ruleset manager persists rewritten default ids before returning the patch result', async () => {
  const source = await readText('../js/ruleset-manager.js');

  assert.match(source, /await localWrite\('defaultRulesetIds', newDefaultIds\);/);
});

test('background applies startup ruleset maintenance on wakeup runs before skipping the full session path', async () => {
  const source = await readText('../js/background.js');

  assert.match(source, /async function runStartupRulesetMaintenance\(\)/);
  assert.match(source, /if \(process\.wakeupRun\) \{\s*await runStartupRulesetMaintenance\(\)\.catch\(ubolErr\);\s*\}/s);
  assert.match(source, /if \(process\.wakeupRun === false\) \{\s*await startSession\(\);\s*\} else \{/s);
});

test('background materializes filtering-mode DNR before first-install welcome opens', async () => {
  const source = await readText('../js/background.js');
  const startBlock = source.slice(
    source.indexOf('async function start() {'),
    source.indexOf('/******************************************************************************/', source.indexOf('async function start() {'))
  );
  const installBlock = source.slice(
    source.indexOf('runtime.onInstalled.addListener'),
    source.indexOf('browser.alarms?.onAlarm.addListener', source.indexOf('runtime.onInstalled.addListener'))
  );

  assert.match(source, /reconcileFilteringModeDetails as reconcileFilteringModeDetailsRaw/);
  assert.match(source, /let installWelcomeAllowlistReadyPromise;/);
  assert.match(
    source,
    /function ensureInstallWelcomeAllowlistReady\(\) \{[\s\S]*installWelcomeAllowlistReadyPromise = reconcileFilteringModeDetails\(\)\.catch/
  );
  assert.match(
    startBlock,
    /await ensureInstallWelcomeAllowlistReady\(\)\.catch\(ubolErr\);[\s\S]*await syncInjectablesAndRefreshTabs\(\{ runtimeOnly: false \}\)\.catch\(ubolErr\);/
  );
  assert.match(
    source,
    /async function openInstallWelcomeAfterAllowlistReady\(url\) \{[\s\S]*await ensureInstallWelcomeAllowlistReady\(\)\.catch\(reason => \{[\s\S]*await gotoURL\(url\);/
  );
  assert.doesNotMatch(
    source,
    /async function openInstallWelcomeAfterAllowlistReady\(url\) \{[\s\S]*await isFullyInitialized;/
  );
  assert.match(
    installBlock,
    /openInstallWelcomeAfterAllowlistReady\(url\)\.catch\(reason => \{/
  );
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

test('public package excludes remote tactics interpreter artifacts and storage hooks', async () => {
  const { outDir } = await getPackagedBundle();
  const forbiddenPaths = [
    path.join(outDir, 'js', 'community-tactics.js'),
    path.join(outDir, 'js', 'scripting', 'remote-tactics-bootstrap.js'),
    path.join(outDir, 'js', 'scripting', 'remote-tactics.js'),
  ];
  for (const forbiddenPath of forbiddenPaths) {
    await assert.rejects(
      fs.access(forbiddenPath),
      { code: 'ENOENT' },
      `${path.relative(outDir, forbiddenPath)} must not be packaged`
    );
  }

  const filesToScan = [
    path.join(outDir, 'js', 'background.js'),
    path.join(outDir, 'js', 'scripting-manager.js'),
    path.join(outDir, 'js', 'community-sync.js'),
  ];
  const forbiddenTokens = [
    'remote-tactics-bootstrap',
    'remote-tactics-main',
    'communityBundlePublicTactics',
    'communityBaselinePublicTacticsV1',
  ];
  for (const filePath of filesToScan) {
    const text = await fs.readFile(filePath, 'utf8');
    for (const token of forbiddenTokens) {
      assert.equal(
        text.includes(token),
        false,
        `${path.relative(outDir, filePath)} must not contain ${token}`
      );
    }
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
