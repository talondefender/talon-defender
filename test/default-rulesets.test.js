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
  retryTransientStaticRulesetUpdate,
  RULESET_SELECTION_STATE_VERSION,
  reconcileDefaultRulesetPatch,
} from '../js/default-rulesets.js';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
let packagedOutDir;
const EXPECTED_DEFAULT_IDS = [
  'ublock-filters',
  'talon-youtube-allow',
  'talon-site-fixes',
  'easylist',
  'easyprivacy',
  'pgl',
  'ublock-badware',
  'urlhaus-full',
];
const EXPECTED_REGIONAL_IDS = [
  'alb-0',
  'ara-0',
  'chn-0',
  'cze-0',
  'deu-0',
  'est-0',
  'fin-0',
  'fra-0',
  'grc-0',
  'hrv-0',
  'hun-0',
  'idn-0',
  'ind-0',
  'irn-0',
  'isl-0',
  'isr-0',
  'ita-0',
  'jpn-1',
  'kor-1',
  'ltu-0',
  'lva-0',
  'mkd-0',
  'nld-0',
  'nor-0',
  'rou-1',
  'rus-0',
  'rus-1',
  'spa-0',
  'spa-1',
  'svn-0',
  'swe-1',
  'tha-0',
  'tur-0',
  'ukr-0',
  'vie-1',
];
const EXPECTED_BLOCKED_REGIONAL_IDS = [
  'bgr-0',
  'pol-0',
];
const EXPECTED_BUNDLED_IDS = [
  ...EXPECTED_DEFAULT_IDS,
  'adguard-mobile',
  'block-lan',
  'adguard-spyware-url',
  'annoyances-ai',
  'annoyances-cookies',
  'annoyances-overlays',
  'annoyances-social',
  'annoyances-widgets',
  'annoyances-others',
  'annoyances-notifications',
  ...EXPECTED_REGIONAL_IDS,
];
const EXPECTED_EXTRA_PROTECTION_IDS = [
  'annoyances-ai',
  'annoyances-cookies',
  'annoyances-social',
  'annoyances-widgets',
  'annoyances-others',
  'annoyances-notifications',
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

test('static ruleset updates retry only Chrome exact potentially transient internal error', async () => {
  const waits = [];
  let attempts = 0;
  const recovered = await retryTransientStaticRulesetUpdate(
    async () => {
      attempts += 1;
      if (attempts === 1) { throw new Error('Internal error.'); }
    },
    {
      retryDelaysMs: [25, 50],
      wait: async delayMs => waits.push(delayMs),
    }
  );

  assert.deepEqual(recovered, { attempts: 2, recovered: true });
  assert.deepEqual(waits, [25]);

  await assert.rejects(
    retryTransientStaticRulesetUpdate(
      async () => { throw new Error('MAX_NUMBER_OF_ENABLED_STATIC_RULESETS exceeded'); },
      {
        retryDelaysMs: [25, 50],
        wait: async delayMs => waits.push(delayMs),
      }
    ),
    /MAX_NUMBER_OF_ENABLED_STATIC_RULESETS/
  );
  assert.deepEqual(waits, [25], 'quota and validation failures must not be retried');

  for (const nonExactMessage of [
    'Internal error',
    'INTERNAL ERROR.',
    'Error: Internal error.',
    'Internal error: bad state',
    'Invalid ruleset ID',
    'Permission denied',
    'MAX_NUMBER_OF_ENABLED_STATIC_RULESETS exceeded',
    'regex rule limit exceeded',
  ]) {
    let nonExactAttempts = 0;
    await assert.rejects(
      retryTransientStaticRulesetUpdate(
        async () => {
          nonExactAttempts += 1;
          throw new Error(nonExactMessage);
        },
        {
          retryDelaysMs: [25, 50],
          wait: async delayMs => waits.push(delayMs),
        }
      ),
      new RegExp(nonExactMessage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    );
    assert.equal(nonExactAttempts, 1, `${nonExactMessage} must not be retried`);
  }
  assert.deepEqual(waits, [25]);

  let exhaustedAttempts = 0;
  const retryDelta = Object.freeze({
    enableRulesetIds: Object.freeze(['annoyances-ai']),
    disableRulesetIds: Object.freeze([]),
  });
  const exhaustedDeltas = [];
  await assert.rejects(
    retryTransientStaticRulesetUpdate(
      async () => {
        exhaustedAttempts += 1;
        exhaustedDeltas.push(retryDelta);
        throw new Error('Internal error.');
      },
      {
        retryDelaysMs: [10, 20],
        wait: async delayMs => waits.push(delayMs),
      }
    ),
    /Internal error/
  );
  assert.equal(exhaustedAttempts, 3, 'retry count must stay bounded');
  assert.equal(
    exhaustedDeltas.every(delta => delta === retryDelta),
    true,
    'every attempt must retry the identical atomic delta'
  );
  assert.deepEqual(waits, [25, 10, 20]);

  const managerSource = await readText('../js/ruleset-manager.js');
  assert.match(
    managerSource,
    /const updateEnabledRulesetsWithTransientRetry = details =>[\s\S]*retryTransientStaticRulesetUpdate\([\s\S]*dnr\.updateEnabledRulesets\(details\)/
  );
  assert.equal(
    (managerSource.match(/updateEnabledRulesetsWithTransientRetry\(/g) || []).length,
    2,
    'both interactive changes and durable recovery must use bounded retry'
  );
  assert.match(managerSource, /response\.staticUpdateAttempts = updateResult\.attempts/);
  const enableStart = managerSource.indexOf('async function enableRulesetsNow');
  const enableEnd = managerSource.indexOf('function enableRulesets(ids)', enableStart);
  const enableSource = managerSource.slice(enableStart, enableEnd);
  assert.ok(enableStart >= 0 && enableEnd > enableStart);
  assert.ok(
    enableSource.indexOf('await localWrite(DNR_RECONCILIATION_DIRTY_KEY, true)') <
      enableSource.indexOf('await updateEnabledRulesetsWithTransientRetry'),
    'the durable dirty marker must precede the first retryable Chrome mutation'
  );
  assert.doesNotMatch(
    enableSource,
    /localRemove\(DNR_RECONCILIATION_DIRTY_KEY\)/,
    'exhausted interactive retries must leave repair authority durable'
  );
});

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

test('background keeps service-worker wakeups read-only for persistent DNR state', async () => {
  const source = await readText('../js/background.js');

  assert.doesNotMatch(source, /runStartupRulesetMaintenance/);
  assert.match(
    source,
    /const startSessionRequired = process\.wakeupRun === false \|\|[\s\S]*isCurrentStartSessionCommit\(startSessionCommit\) === false;/
  );
  assert.match(
    source,
    /if \( startSessionRequired \) \{\s*await startSession\(\{\s*forceDynamicRules: initialSetupPending \|\| installResetApplied,/s
  );
  assert.match(source, /startupInjectableResult = await ensureStartupInjectableState\(\);/);
  assert.match(source, /startup injectable state was not verified/);
  assert.match(source, /A warm worker wake never touches already-open browsing tabs/);
});

test('background materializes filtering-mode DNR before first-install welcome opens', async () => {
  const source = await readText('../js/background.js');
  const startBlock = source.slice(
    source.indexOf('async function startNow('),
    source.indexOf('/******************************************************************************/', source.indexOf('async function startNow('))
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
    /if \( initialSetupPending \|\| installResetApplied \) \{[\s\S]*await ensureInstallWelcomeAllowlistReady\(\);[\s\S]*await startSession\(\{[\s\S]*forceDynamicRules: initialSetupPending \|\| installResetApplied/
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

test('YouTube compatibility allow rules outrank dynamic blocking rules', async () => {
  const rules = await readJson('../rulesets/main/talon-youtube-allow.json');
  assert.equal(Array.isArray(rules), true);
  assert.equal(rules.length, 2);
  for (const rule of rules) {
    assert.equal(rule?.action?.type, 'allowAllRequests');
    assert.equal(rule?.priority, 3000000);
    assert.deepEqual(rule?.condition?.resourceTypes, ['main_frame', 'sub_frame']);
  }
});

test('Talon site fixes target French Stream popup abuse narrowly', async () => {
  const rules = await readJson('../rulesets/main/talon-site-fixes.json');
  assert.equal(Array.isArray(rules), true);
  assert.equal(rules.length, 44);
  assert.equal(rules.every(rule => rule?.action?.type === 'block'), true);
  assert.equal(
    rules.some(rule => rule?.condition?.urlFilter === '||french-stream.one/js/9c9e0968.js'),
    true
  );
  assert.equal(
    rules.some(rule =>
      rule?.condition?.urlFilter === '||kw.femalepostin.shop/' &&
      rule?.condition?.initiatorDomains?.includes('french-stream.one') &&
      rule?.condition?.initiatorDomains?.includes('vidzy.cc')
    ),
    true
  );
  assert.equal(
    rules.some(rule =>
      rule?.condition?.urlFilter === '||refer-path.com/phase-action.html' &&
      rule?.condition?.resourceTypes?.includes('main_frame') &&
      rule?.condition?.initiatorDomains?.includes('vidzy.cc') &&
      rule?.condition?.initiatorDomains?.includes('french-stream.one')
    ),
    true
  );
  assert.equal(
    rules.some(rule =>
      rule?.condition?.urlFilter === '||vidzy.cc/js/pop.js' &&
      rule?.condition?.initiatorDomains?.includes('vidzy.cc')
    ),
    true
  );
  assert.equal(
    rules.some(rule =>
      rule?.condition?.urlFilter === '||vidzy.cc/2b0070e0.js' &&
      rule?.condition?.initiatorDomains?.includes('vidzy.cc')
    ),
    true
  );
  assert.equal(
    rules.some(rule =>
      rule?.condition?.urlFilter === '||llvpn.com/tag.min.js' &&
      rule?.condition?.initiatorDomains?.includes('vidzy.cc')
    ),
    true
  );
  assert.equal(
    rules.some(rule =>
      rule?.condition?.urlFilter === '||dp.humpingunfoggy.cfd/' &&
      rule?.condition?.resourceTypes?.includes('script') &&
      rule?.condition?.initiatorDomains?.includes('french-stream.one')
    ),
    true
  );
  assert.equal(
    rules.some(rule =>
      rule?.condition?.urlFilter === '||vascon.kalesrussiaschuln.cyou/' &&
      rule?.condition?.resourceTypes?.includes('xmlhttprequest') &&
      rule?.condition?.initiatorDomains?.includes('french-stream.one')
    ),
    true
  );
  assert.equal(
    rules.some(rule =>
      rule?.condition?.urlFilter === '||wvdme.com/' &&
      rule?.condition?.resourceTypes?.includes('main_frame') &&
      rule?.condition?.initiatorDomains?.includes('vidzy.cc')
    ),
    true
  );
  assert.equal(
    rules.some(rule =>
      rule?.condition?.urlFilter === '||s.click.aliexpress.com/e/_c3iY7qHn' &&
      rule?.condition?.resourceTypes?.includes('main_frame') &&
      rule?.condition?.initiatorDomains?.includes('wvdme.com')
    ),
    true
  );
  assert.equal(
    rules.some(rule =>
      rule?.condition?.urlFilter === '||www.aliexpress.com/p/popular-landing/aliexpress.html' &&
      rule?.condition?.resourceTypes?.includes('main_frame') &&
      rule?.condition?.initiatorDomains?.includes('s.click.aliexpress.com')
    ),
    true
  );
  assert.equal(
    rules.some(rule =>
      rule?.condition?.urlFilter === '||kalesrussiaschuln.cyou/' &&
      rule?.condition?.resourceTypes?.includes('sub_frame') &&
      rule?.condition?.initiatorDomains?.includes('french-stream.one')
    ),
    true
  );
  assert.equal(
    rules.some(rule =>
      rule?.condition?.urlFilter === '||thawier.beholdsresinsimprevu.cfd/' &&
      rule?.condition?.resourceTypes?.includes('xmlhttprequest') &&
      rule?.condition?.initiatorDomains?.includes('vidzy.cc')
    ),
    true
  );
  assert.equal(
    rules.some(rule =>
      rule?.condition?.urlFilter === '||hoinsealch.qpon/' &&
      rule?.condition?.resourceTypes?.includes('script') &&
      rule?.condition?.initiatorDomains?.includes('vidzy.cc')
    ),
    true
  );
  assert.equal(
    rules.some(rule =>
      rule?.condition?.urlFilter === '||fsurl.lol/sso.php' &&
      rule?.condition?.resourceTypes?.includes('sub_frame') &&
      rule?.condition?.initiatorDomains?.includes('french-stream.one')
    ),
    true
  );
  for (const urlFilter of [
    '||bulbedcrus.shop/cx/',
    '||teindpumpage.cfd/',
    '||scrougespongesgutsy.cyou/',
    '||keylesshowk.shop/',
  ]) {
    assert.equal(
      rules.some(rule =>
        rule?.condition?.urlFilter === urlFilter &&
        rule?.condition?.initiatorDomains?.includes('french-stream.one')
      ),
      true,
      `${urlFilter} must be covered for French Stream creative popup chains`
    );
  }
  for (const urlFilter of [
    '||bancusnonpeak.cyou/',
    '||domingbesnarecrex.qpon/',
    '||devilyquondam.cyou/',
  ]) {
    assert.equal(
      rules.some(rule =>
        rule?.condition?.urlFilter === urlFilter &&
        rule?.condition?.resourceTypes?.includes('script') &&
        rule?.condition?.resourceTypes?.includes('sub_frame') &&
        rule?.condition?.initiatorDomains?.includes('french-stream.one') &&
        rule?.condition?.initiatorDomains?.includes('vidzy.cc')
      ),
      true,
      `${urlFilter} must block current French Stream rotating ad loaders`
    );
  }
  assert.equal(
    rules.some(rule =>
      rule?.condition?.urlFilter === '||haivamtuzeton.site/ad/visit.php' &&
      rule?.condition?.resourceTypes?.includes('main_frame') &&
      rule?.condition?.initiatorDomains?.includes('bancusnonpeak.cyou')
    ),
    true
  );
  assert.equal(
    rules.some(rule =>
      rule?.condition?.urlFilter === '||haivamtuzeton.site/' &&
      rule?.condition?.resourceTypes?.includes('script') &&
      rule?.condition?.resourceTypes?.includes('main_frame') &&
      rule?.condition?.initiatorDomains?.includes('domingbesnarecrex.qpon')
    ),
    true
  );
  assert.equal(
    rules.some(rule =>
      rule?.condition?.urlFilter === '||shein.com/risk/challenge' &&
      rule?.condition?.resourceTypes?.includes('main_frame') &&
      rule?.condition?.initiatorDomains?.includes('haivamtuzeton.site')
    ),
    true
  );
  for (const urlFilter of [
    '||gamingamerica.com/',
    '||newsuggest.com/',
    '||endfield.gryphline.com/landing/ua/obt',
    '||best.aliexpress.com/',
    '||oncehuman.game/',
  ]) {
    assert.equal(
      rules.some(rule =>
        rule?.condition?.urlFilter === urlFilter &&
        rule?.condition?.resourceTypes?.includes('main_frame') &&
        rule?.condition?.initiatorDomains?.includes('french-stream.one') &&
        rule?.condition?.initiatorDomains?.includes('vidzy.cc')
      ),
      true,
      `${urlFilter} must block current French Stream player popup landings`
    );
  }
  for (const urlFilter of [
    '.cyou/',
    '.qpon/',
    '.shop/',
    '.cfd/',
  ]) {
    assert.equal(
      rules.some(rule =>
        rule?.condition?.urlFilter === urlFilter &&
        rule?.condition?.resourceTypes?.includes('main_frame') &&
        rule?.condition?.resourceTypes?.includes('script') &&
        rule?.condition?.domainType === 'thirdParty' &&
        rule?.condition?.initiatorDomains?.includes('french-stream.one') &&
        rule?.condition?.initiatorDomains?.includes('vidzy.cc')
      ),
      true,
      `${urlFilter} must be blocked for French Stream-scoped rotating ad hosts`
    );
  }
  for (const urlFilter of [
    '||wk.sanpoiljejuna.cfd/cx/',
    '||hy.shibahsjessing.qpon/cx/',
    '||v2006.com/',
    '||2osb.com/',
    '||webls.net/',
    '||phiglerdail.net/',
    '||s.click.aliexpress.com/e/_c3iY7qHn',
    '||www.aliexpress.com/p/popular-landing/aliexpress.html',
    '||fartingpangane.shop/',
    '||073m.com/',
  ]) {
    assert.equal(
      rules.some(rule =>
        rule?.condition?.urlFilter === urlFilter &&
        rule?.condition?.resourceTypes?.includes('main_frame') &&
        Array.isArray(rule?.condition?.initiatorDomains) === false
      ),
      true,
      `${urlFilter} must have an unscoped main-frame fallback`
    );
  }

  const cosmetics = await readJson('../rulesets/scripting/specific/talon-site-fixes.json');
  assert.deepEqual(cosmetics.selectors, ['#dontfoid']);
  assert.deepEqual(cosmetics.hostnames, ['french-stream.one']);
  assert.equal(cosmetics.hasEntities, false);

  const scriptletDetails = await readJson('../rulesets/scriptlet-details.json');
  const scriptletEntry = scriptletDetails.find(entry => entry?.[0] === 'talon-site-fixes');
  assert.deepEqual(scriptletEntry?.[1]?.MAIN, [
    'french-stream.one',
    'fsvid.lol',
    'kakaflix.lol',
    'uqload.is',
    'vidzy.cc',
  ]);

  const scriptletSource = await readText('../rulesets/scripting/scriptlet/main/talon-site-fixes.js');
  assert.match(scriptletSource, /__talonFrenchStreamPopupGuard/);
  assert.match(scriptletSource, /hidePopupOverlays/);
  assert.match(scriptletSource, /document\.referrer/);
  assert.match(scriptletSource, /Window\.prototype, 'open'/);
  assert.match(scriptletSource, /Object\.defineProperty\(self, 'open'/);
  assert.match(scriptletSource, /shouldBlockPlayerGesturePopupUrl/);
  assert.match(scriptletSource, /shouldBlockPopupNavigation/);
  assert.match(scriptletSource, /shouldShieldFrenchStreamContentNavigation/);
  assert.match(scriptletSource, /safeFrenchStreamContentClickEvents/);
  assert.match(scriptletSource, /shouldBlockPlayerGestureNavigationUrl/);
  assert.match(scriptletSource, /topPlayerGestureSelector/);
  assert.match(scriptletSource, /neutralizePopupBaseTargets/);
  assert.match(scriptletSource, /wrapTargetSetAttribute\(HTMLAnchorElement\.prototype\)/);
  assert.doesNotMatch(scriptletSource, /Element\.prototype\.setAttribute\s*=/);
  assert.match(scriptletSource, /HTMLAnchorElement\.prototype\.click/);
  assert.match(scriptletSource, /HTMLFormElement\.prototype\.submit/);
  assert.match(scriptletSource, /document\.querySelector\('base\[target\]'\)/);
  assert.match(scriptletSource, /itIsMessageForCreative/);
  assert.doesNotMatch(scriptletSource, /isFrenchStreamPlayerFrame === false \) \{ return false; \}\s*const parsed = parseMessageData\(data\)/);
  assert.match(scriptletSource, /Window\.prototype\.postMessage/);
  assert.match(scriptletSource, /__talonFrenchStreamFullscreenIntent/);
  assert.match(scriptletSource, /preventUnsolicitedFullscreenMessage/);
  assert.match(scriptletSource, /removeStartupFlickerFrames/);
  assert.match(scriptletSource, /fsurl\.lol\/sso\.php/);
  assert.match(scriptletSource, /wrapFullscreenRequest\(nativeElementRequestFullscreen, 'requestFullscreen'\)/);
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
