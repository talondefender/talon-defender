import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

import {
  isRemoteScriptletDirectiveId,
  mergeRemoteScriptletReloadHints,
  normalizeRemoteScriptletReloadHint,
  shouldReloadForFrameUrls,
} from '../js/remote-scriptlet-hotfix.js';

// Browser content-script globals always expose timers. Seed the same baseline
// in every VM harness so bounded runtime-message tests exercise transport
// behavior instead of failing on an incomplete test environment.
const createVmContext = vm.createContext.bind(vm);
vm.createContext = (context, ...args) => {
  context.setTimeout ??= setTimeout;
  context.clearTimeout ??= clearTimeout;
  return createVmContext(context, ...args);
};

const readSource = relativePath =>
  fs.readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');

const testHttpsUrl = hostname => [ 'https', '://', hostname, '/' ].join('');

const pathExists = async relativePath => {
  try {
    await fs.access(new URL(`../${relativePath}`, import.meta.url));
    return true;
  } catch {
    return false;
  }
};

const countMatches = (source, pattern) => (source.match(pattern) ?? []).length;

const assertOrderedIncludes = (source, needles, label) => {
  let offset = -1;
  for (const needle of needles) {
    const nextOffset = source.indexOf(needle, offset + 1);
    assert.notEqual(nextOffset, -1, `${label} missing ${needle}`);
    offset = nextOffset;
  }
};

const sourceBetween = (source, startNeedle, endNeedle) => {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, `missing source start: ${startNeedle}`);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.notEqual(end, -1, `missing source end: ${endNeedle}`);
  return source.slice(start, end);
};

test('adaptive subsystems keep the shared helper ordering and omit public remote tactics lanes', async () => {
  const source = await readSource('js/scripting-manager.js');

  assert.match(source, /const TALON_SHADOW_DOM_HELPER_PATH = '\/js\/scripting\/shadow-dom-helper\.js'/);
  assert.match(source, /const TALON_BLOCK_HINTS_PATH = '\/js\/scripting\/block-hints\.js'/);
  assert.match(source, /TALON_SHADOW_DOM_HELPER_PATH,\s*TALON_BLOCK_HINTS_PATH,\s*'\/js\/scripting\/native-heuristics\.js'/);
  assert.match(source, /TALON_SHADOW_DOM_HELPER_PATH,\s*TALON_BLOCK_HINTS_PATH,\s*'\/js\/scripting\/automation\.js'/);
  assert.match(source, /\/js\/scripting\/remote-cosmetics-global\.js/);
  assert.match(source, /\/js\/scripting\/remote-cosmetics-host\.js/);
  assert.doesNotMatch(source, /remote-tactics-bootstrap/);
  assert.doesNotMatch(source, /remote-tactics-main/);
  assert.doesNotMatch(source, /communityBundlePublicTactics/);
  assert.doesNotMatch(source, /registerNationalPostAntiAdblock/);
  assert.doesNotMatch(source, /registerFinancialPostCompatibility/);
  assert.doesNotMatch(source, /registerFinancialPostAntiAdblock/);
});

test('public source does not keep non-shipped tactic interpreter files', async () => {
  const allowlist = await readSource('public-safe-allowlist.txt');

  assert.equal(await pathExists('js/community-tactics.js'), false);
  assert.equal(await pathExists('js/scripting/remote-tactics-bootstrap.js'), false);
  assert.equal(await pathExists('js/scripting/remote-tactics.js'), false);
  assert.equal(await pathExists('test/community-tactics.test.js'), false);
  assert.equal(await pathExists('test/remote-tactics-runtime.test.js'), false);
  assert.equal(allowlist.includes('js/community-tactics.js'), false);
  assert.equal(allowlist.includes('js/scripting/remote-tactics-bootstrap.js'), false);
  assert.equal(allowlist.includes('js/scripting/remote-tactics.js'), false);
  assert.equal(allowlist.includes('test/community-tactics.test.js'), false);
  assert.equal(allowlist.includes('test/remote-tactics-runtime.test.js'), false);
});

test('manifest permissions stay limited to the reviewed blocker surface', async () => {
  const manifest = JSON.parse(await readSource('manifest.json'));

  assert.deepEqual(manifest.permissions, [
    'activeTab',
    'alarms',
    'declarativeNetRequest',
    'offscreen',
    'scripting',
    'storage',
    'unlimitedStorage',
    'userScripts',
    'webNavigation',
  ]);
  assert.deepEqual(manifest.host_permissions, ['<all_urls>']);
  assert.equal(manifest.permissions.includes('cookies'), false);
});

test('packaged uBO popup prevention is wired through the reviewed runtime surface', async () => {
  const configSource = await readSource('js/config.js');
  const managerSource = await readSource('js/scripting-manager.js');
  const preventPopupSource = await readSource('js/prevent-popup.js');
  const packageSource = await readSource('scripts/package-extension.mjs');
  const manifest = JSON.parse(await readSource('manifest.json'));
  const rulesetDetails = JSON.parse(await readSource('rulesets/ruleset-details.json'));

  assert.match(configSource, /popupBlockMode: true/);
  assert.match(managerSource, /import \{ registerPreventPopup \} from '\.\/prevent-popup\.js';/);
  assert.match(managerSource, /registerPreventPopup\(context\)/);
  assert.match(preventPopupSource, /rulesetConfig\.popupBlockMode !== true/);
  assert.match(preventPopupSource, /rulesets\/scripting\/popup\/\$\{id\}\.js/);
  assert.match(packageSource, /pruneRulesetDirectoryById\('rulesets\/scripting\/popup', allowedIds\)/);
  assert.equal(manifest.permissions.includes('offscreen'), true);
  assert.equal(manifest.permissions.includes('userScripts'), true);
  assert.equal(rulesetDetails.some(details => Number(details.popups) > 0), true);
  assert.equal(await pathExists('js/scripting/prevent-popup.js'), true);
  assert.equal(await pathExists('js/scripting/prevent-popup-target.js'), true);
  assert.equal(await pathExists('rulesets/scripting/popup/easylist.js'), true);
});

test('audited non-YouTube popup parity additions have popup and plain DNR coverage', async () => {
  const popupDetails = async relativePath => {
    const context = {};
    context.self = context;
    vm.runInNewContext(await readSource(relativePath), context);
    assert.equal(context.preventPopupDetails.length, 1);
    return context.preventPopupDetails[0];
  };
  const ublockPopup = await popupDetails(
    'rulesets/scripting/popup/ublock-filters.js'
  );
  const japanesePopup = await popupDetails(
    'rulesets/scripting/popup/jpn-1.js'
  );
  const ublockDestinations = [
    'dial2day.com',
    'sa-movie.com',
    'animevice.net',
    'proxyify.info',
    'yifysearch.com',
    'movienewsgo.xyz',
    'yewfjsdi.it.com',
    'clovermovies.com',
    'meimei-movie.com',
    'mytvsoapforum.com',
    'w-solarmovies.com',
    'gomoviescdn.online',
  ];
  const dnrDestinations = ublockDestinations.filter(
    hostname => hostname !== 'yewfjsdi.it.com'
  );
  const expectedRegexPairs = [
    ['itopbloc', '^[^:]+:\\/\\/([^:/]+\\.)?topblockchainsolutions\\.'],
    ['i/live/m', '^[^:]+:\\/\\/([^:/]+\\.)?pussyspace\\..*?\\/live\\/meet-and-fuck\\/'],
    ['i/?r=dir', '\\/\\?r=dir&zoneid='],
    ['i/?refer', '\\/\\?referral=sythe'],
    ['i/sytheb', '\\/sytheb'],
    ['i/clc?ai', '\\/clc\\?aid='],
    ['istreami', '^[^:]+:\\/\\/([^:/]+\\.)?streamingcommunity\\..*?\\/slide-banner\\/'],
    ['iselfser', '^[^:]+:\\/\\/([^:/]+\\.)?selfservesenpai\\.'],
    ['i/ads.js', '\\/ads\\.js\\?api_key=.*?&header='],
    ['i.com/sm', '^[^:]+:\\/\\/([^:/]+\\.)?go\\..*?\\.com\\/smartpop\\/'],
    ['i.com/ea', '^[^:]+:\\/\\/([^:/]+\\.)?go\\..*?\\.com\\/easy\\?'],
    ['iontent.', 'ontent\\.steamplay\\.'],
  ];

  for (const hostname of ublockDestinations) {
    assert.equal(ublockPopup.block.hostnames.includes(hostname), true, hostname);
  }
  for (const [token, regex] of expectedRegexPairs) {
    const offset = ublockPopup.block.regexes.indexOf(token);
    assert.notEqual(offset, -1, token);
    assert.equal(ublockPopup.block.regexes[offset + 1], regex, token);
  }
  assert.equal(
    japanesePopup.block.hostnames.includes('dailyrumor-jp.co.in'),
    true
  );

  const [ublockMain, ublockStrict, japaneseMain, japaneseStrict, details] =
    await Promise.all([
      readSource('rulesets/main/ublock-filters.json').then(JSON.parse),
      readSource('rulesets/strictblock/ublock-filters.json').then(JSON.parse),
      readSource('rulesets/main/jpn-1.json').then(JSON.parse),
      readSource('rulesets/strictblock/jpn-1.json').then(JSON.parse),
      readSource('rulesets/ruleset-details.json').then(JSON.parse),
    ]);
  const requireDestinations = (rules, id, destinations) => {
    const rule = rules.find(candidate => candidate.id === id);
    assert.ok(rule, `missing rule ${id}`);
    for (const hostname of destinations) {
      assert.equal(
        rule.condition.requestDomains.includes(hostname),
        true,
        `${id}: ${hostname}`
      );
    }
  };
  requireDestinations(ublockMain, 2, dnrDestinations);
  requireDestinations(ublockStrict, 1, dnrDestinations);
  requireDestinations(japaneseMain, 7, ['dailyrumor-jp.co.in']);
  requireDestinations(japaneseStrict, 1, ['dailyrumor-jp.co.in']);
  assert.equal(
    ublockMain.find(rule => rule.id === 2)
      .condition.requestDomains.includes('yewfjsdi.it.com'),
    false,
    'the subdomain-only popup entry must not consume redundant DNR coverage'
  );
  assert.equal(details.find(entry => entry.id === 'ublock-filters').popups, 161);
  assert.equal(details.find(entry => entry.id === 'jpn-1').popups, 28);
});

test('packaged uBO scriptlet bundles are wired while Talon token compatibility stays separate', async () => {
  const manifest = JSON.parse(await readSource('manifest.json'));
  const managerSource = await readSource('js/scripting-manager.js');
  const validateSource = await readSource('scripts/validate-mv3-package.mjs');

  assert.equal(manifest.permissions.includes('offscreen'), true);
  assert.equal(manifest.permissions.includes('userScripts'), true);
  assert.equal(await pathExists('rulesets/scripting/scriptlet/main/ublock-filters.js'), true);
  assert.equal(await pathExists('rulesets/scripting/scriptlet/isolated/ublock-filters.js'), true);
  assert.equal(
    await pathExists('js/scripting/scriptlet-token/ublock-experimental.trusted-json-edit-xhr-request.js'),
    true
  );
  assert.equal(await pathExists('js/scripting/scriptlet-token-details.json'), true);
  assert.match(
    managerSource,
    /\/rulesets\/scripting\/scriptlet\/\$\{world\.toLowerCase\(\)\}\/\$\{rulesetId\}\.js/
  );
  assert.match(managerSource, /getScriptletTokenDetails\(\)/);
  assert.match(managerSource, /registerRemoteScriptlets\(context, scriptletTokenDetails\)/);
  assert.match(validateSource, /\^js\\\/scripting\\\/scriptlet-token\\\//);
});

test('packaged uBO scriptlet rules keep replace-node-text payloads readable', async () => {
  const ublockFiltersSource = await readSource('rulesets/scripting/scriptlet/isolated/ublock-filters.js');

  assert.doesNotMatch(ublockFiltersSource, /html\(window\.atob\(/);
  assert.doesNotMatch(ublockFiltersSource, /window\.atob\(\\?"[A-Za-z0-9+/=]{80,}/);
  assert.match(ublockFiltersSource, /Captcha image failed to load/);
});

test('packaged cosmetic registrations preload the procedural API before procedural consumers', async () => {
  const managerSource = await readSource('js/scripting-manager.js');
  const filterManagerSource = await readSource('js/filter-manager.js');
  const backgroundSource = await readSource('js/background.js');
  const proceduralSource = managerSource.slice(
    managerSource.indexOf('function registerProcedural(context) {'),
    managerSource.indexOf('async function registerSpecific(context) {')
  );
  const specificSource = managerSource.slice(
    managerSource.indexOf('async function registerSpecific(context) {'),
    managerSource.indexOf('function registerScriptlet(context, scriptletDetails) {')
  );

  assertOrderedIncludes(
    proceduralSource,
    [
      '/js/scripting/css-api.js',
      '/js/scripting/isolated-api.js',
      '/js/scripting/css-procedural-api.js',
      '/js/scripting/css-procedural.js',
    ],
    'css-procedural registration'
  );
  assertOrderedIncludes(
    specificSource,
    [
      '/js/scripting/css-api.js',
      '/js/scripting/isolated-api.js',
      '/js/scripting/css-procedural-api.js',
      '/js/scripting/css-specific.js',
    ],
    'css-specific registration'
  );
  const customStartSource = sourceBetween(
    filterManagerSource,
    'export function startCustomFilters',
    'export function terminateCustomFilters'
  );
  const customRegistrationSource = sourceBetween(
    filterManagerSource,
    'export async function registerCustomFilters',
    'async function addCustomFiltersNow'
  );
  for (const [source, label] of [
    [customStartSource, 'custom live start'],
    [customRegistrationSource, 'custom document-start registration'],
    [backgroundSource, 'custom open-tab restoration'],
  ]) {
    assertOrderedIncludes(source, [
      '/js/scripting/css-api.js',
      '/js/scripting/css-procedural-api.js',
      '/js/scripting/css-user.js',
    ], label);
  }
});

test('specific cosmetic procedural API load fails closed when injection is unavailable', async () => {
  const source = await readSource('js/scripting/css-specific.js');
  const loadStart = source.indexOf('const ensureProceduralFiltererAPI = async () =>');
  const constructIndex = source.indexOf(
    'new self.ProceduralFiltererAPI(coreSpecificScope)'
  );
  const typeGuardIndex = source.indexOf("typeof self.ProceduralFiltererAPI !== 'function'", loadStart);
  const loaderSource = source.slice(loadStart, constructIndex);

  assert.ok(loadStart !== -1);
  assert.ok(constructIndex !== -1);
  assert.ok(typeGuardIndex !== -1);
  assert.match(loaderSource, /sendRuntimeMessageBounded\(\{/);
  assert.match(loaderSource, /if \( pending instanceof Promise \)/);
  assert.match(loaderSource, /const response = await pending;/);
  assert.match(loaderSource, /typeof self\.ProceduralFiltererAPI !== 'function'/);
  assert.match(
    loaderSource,
    /self\.ProceduralFiltererAPI === pending[\s\S]*self\.ProceduralFiltererAPI = undefined;/
  );
  assert.match(source, /specific procedural CSS API request timed out/);
  assert.match(loaderSource, /throw new Error\('specific procedural CSS API unavailable'\)/);
  assert.ok(
    typeGuardIndex < constructIndex,
    'css-specific must verify the injected API constructor before using new'
  );

  assert.match(source, /self\.listsSpecificProceduralFiltererAPI =[\s\S]*new self\.ProceduralFiltererAPI\(coreSpecificScope\)/);
  assert.match(source, /await self\.listsSpecificProceduralFiltererAPI\.addSelectors\(p\);/);
  assert.match(source, /catch \(reason\) \{[\s\S]*await cleanupSpecificCosmetics\(\);[\s\S]*throw reason;/);
});

test('procedural cosmetic constructor consumers fail closed across optional entrypoints', async () => {
  const cssProceduralSource = await readSource('js/scripting/css-procedural.js');
  const cssUserSource = await readSource('js/scripting/css-user.js');
  const pickerSource = await readSource('js/scripting/picker.js');
  const overlaySource = await readSource('js/scripting/tool-overlay.js');
  const backgroundSource = await readSource('js/background.js');

  assert.match(cssProceduralSource, /const ensureProceduralFiltererAPI = async \(\) =>/);
  assert.match(cssProceduralSource, /if \( pending instanceof Promise \)/);
  assert.match(cssProceduralSource, /const response = await pending;/);
  assert.match(cssProceduralSource, /compiled procedural CSS API request timed out/);
  assert.match(
    cssProceduralSource,
    /self\.ProceduralFiltererAPI === pending[\s\S]*self\.ProceduralFiltererAPI = undefined;/
  );
  assert.match(cssProceduralSource, /new self\.ProceduralFiltererAPI\(coreProceduralScope\)/);
  assert.match(cssProceduralSource, /await self\.listsCompiledProceduralFiltererAPI\.addSelectors\(exceptedSelectors\);/);
  assert.match(cssProceduralSource, /catch \(reason\) \{[\s\S]*await cleanupCompiledProceduralCosmetics\(\);[\s\S]*throw reason;/);

  assert.match(cssUserSource, /typeof self\.ProceduralFiltererAPI !== 'function'/);
  assert.match(cssUserSource, /throw new Error\('custom procedural CSS API unavailable'\)/);
  assert.match(cssUserSource, /details\.proceduralSelectors\.map\(selector =>\s*JSON\.parse\(selector\)/);
  assert.match(cssUserSource, /const filterer = new self\.ProceduralFiltererAPI\('custom'\);/);
  assert.match(cssUserSource, /await filterer\.addSelectors\(proceduralSelectors\);/);

  assert.match(pickerSource, /const createProceduralFilterer = \( \) => \{/);
  assert.match(pickerSource, /typeof self\.ProceduralFiltererAPI !== 'function'/);
  assert.match(pickerSource, /try\s*\{[\s\S]*return new self\.ProceduralFiltererAPI\('picker'\);[\s\S]*\}\s*catch/);
  assert.match(pickerSource, /previewProceduralFiltererAPI\?\.reset\(\);/);
  assert.match(pickerSource, /try\s*\{[\s\S]*await self\.pickerProceduralFilteringAPI\.addSelectors\(\[[\s\S]*JSON\.parse\(selector\)[\s\S]*\]\);[\s\S]*\}\s*catch/);

  assert.match(overlaySource, /typeof self\.ProceduralFiltererAPI !== 'function'/);
  assert.match(overlaySource, /try\s*\{[\s\S]*this\.proceduralFiltererAPI = new self\.ProceduralFiltererAPI\(\);[\s\S]*\}\s*catch\s*\{[\s\S]*return \[\];/);
  assert.match(overlaySource, /try\s*\{[\s\S]*return this\.proceduralFiltererAPI\.qsa\(selector\);[\s\S]*\}\s*catch \(reason\)/);

  const injectCustomFiltersStart = backgroundSource.indexOf("case 'injectCustomFilters':");
  const injectCustomFiltersEnd = backgroundSource.indexOf("case 'injectCSSProceduralAPI':", injectCustomFiltersStart);
  const injectCustomFiltersSource = backgroundSource.slice(injectCustomFiltersStart, injectCustomFiltersEnd);
  assert.match(
    injectCustomFiltersSource,
    /trackLivePageMutation\(async stillCurrent => \{[\s\S]*prepareCustomFilterDetails\([\s\S]*stillCurrent\(\) === false[\s\S]*injectCustomFilters\(\s*tabId,\s*frameId,\s*request\.hostname,\s*preparedDetails,\s*documentId/
  );
  assert.match(injectCustomFiltersSource, /\.catch\(reason => \{[\s\S]*ubolErr\(`injectCustomFilters\/\$\{reason\}`\);[\s\S]*callback\(\{ error: 'inject_custom_filters_failed' \}\);/);
});

test('uBO Lite offscreen and userScripts runtime is packaged behind entitlement sync', async () => {
  const extSource = await readSource('js/ext.js');
  const filterManagerSource = await readSource('js/filter-manager.js');
  const backgroundSource = await readSource('js/background.js');
  const ownershipSource = await readSource('scripts/ubol-source-ownership.json');

  assert.equal(await pathExists('js/offscreen/compile-filters.html'), true);
  assert.equal(await pathExists('js/resources/scriptlets.js'), true);
  assert.equal(await pathExists('lib/regexanalyzer/regex.js'), true);
  assert.match(extSource, /export const supportsUserScripts/);
  assert.match(extSource, /export const isUserScriptsAvailable/);
  assert.match(extSource, /try \{[\s\S]*browser\.userScripts\.getScripts\(\)/);
  assert.match(extSource, /probe\.catch\(\(\) => \{\}\)/);
  assert.match(filterManagerSource, /export function registerSandboxFilters/);
  assert.match(filterManagerSource, /sandboxFilterOperationTail/);
  assert.match(filterManagerSource, /browser\.offscreen\.createDocument/);
  assert.match(filterManagerSource, /browser\.userScripts\.register/);
  assert.match(backgroundSource, /reconcileSandboxFilters\(\)/);
  assert.match(backgroundSource, /userScriptsAvailable: supportsUserScripts && isUserScriptsAvailable\(\)/);
  assert.match(backgroundSource, /runtime\.onUserScriptMessage\.addListener/);
  assert.match(backgroundSource, /unregisterAllUserScripts/);
  assert.match(ownershipSource, /"js\/offscreen\/\*\*"/);
  assert.match(ownershipSource, /"js\/resources\/\*\*"/);
  assert.match(ownershipSource, /"lib\/regexanalyzer\/\*\*"/);
});

test('custom-filter DNR state remains dirty until Chrome confirms reconciliation', async () => {
  const filterManagerSource = await readSource('js/filter-manager.js');
  const backgroundSource = await readSource('js/background.js');
  const rulesetManagerSource = await readSource('js/ruleset-manager.js');
  const desiredRulesWrite = filterManagerSource.indexOf(
    "await localWrite('sandboxFilters.dnrRules', afterRules)"
  );
  const dirtyIntentWrite = filterManagerSource.lastIndexOf(
    'await localWrite(SANDBOX_DNR_DIRTY_KEY, true)',
    desiredRulesWrite
  );

  assert.ok(dirtyIntentWrite !== -1 && dirtyIntentWrite < desiredRulesWrite);
  assert.match(filterManagerSource, /changed: modified \|\| \([\s\S]*dnrStateDirty !== undefined && dnrStateDirty !== false/);
  assert.match(filterManagerSource, /addCustomFilters[\s\S]*markSandboxRegistrationDirtyNow\(\)/);
  assert.match(filterManagerSource, /SANDBOX_REGISTRATION_REVISION_KEY/);
  assert.match(filterManagerSource, /SANDBOX_REGISTRATION_APPLIED_REVISION_KEY/);
  assert.match(filterManagerSource, /Promise\.race\(\[ createPromise, timeoutPromise \]\)/);
  assert.match(rulesetManagerSource, /out\.applyFailed = true;/);
  assert.match(backgroundSource, /async function updateUserRulesAndAcknowledgeSandboxState\(\)/);
  assert.match(backgroundSource, /if \( result\?\.applyFailed === true \) \{[\s\S]*throw new Error/);
  assert.match(backgroundSource, /await localRemove\(SANDBOX_DNR_DIRTY_KEY\);/);
  assert.match(backgroundSource, /isDurableDirtyMarker\(sandboxDnrDirty\) === false/);
  assert.match(backgroundSource, /isDurableDirtyMarker\(sandboxRegistrationDirty\) === false/);
  assert.match(backgroundSource, /sandboxRegistrationAppliedRevision/);
  assert.match(backgroundSource, /localWrite\([\s\S]*SANDBOX_REGISTRATION_APPLIED_REVISION_KEY/);
  assert.match(backgroundSource, /sandboxRegistrationSucceeded && sandboxDnrSucceeded/);
  assert.match(backgroundSource, /isDurableDirtyMarker\(sandboxLiveStateDirty\) \|\|[\s\S]*sandboxAppliedRevision !== sandboxRevision/);
  const fingerprintPersist = backgroundSource.indexOf(
    'await persistInjectableRuntimeState(runtimeFingerprint)'
  );
  const liveRevisionAcknowledge = backgroundSource.indexOf(
    'SANDBOX_REGISTRATION_APPLIED_REVISION_KEY',
    fingerprintPersist
  );
  assert.ok(fingerprintPersist !== -1);
  assert.ok(liveRevisionAcknowledge > fingerprintPersist);
  assert.match(backgroundSource, /case 'addCustomFilters':[\s\S]*syncInjectablesAndRefreshTabs\(\{ runtimeOnly: false \}\)/);
});

test('popup exposes reviewer-visible Allowed Sites controls for the current tab', async () => {
  const popupHtml = await readSource('popup/popup.html');
  const popupSource = await readSource('popup/popup.js');
  const backgroundSource = await readSource('js/background.js');

  assert.match(popupHtml, /id="allowedSitesCard"/);
  assert.match(popupHtml, /data-i18n="optionsAllowedSitesTitle"/);
  assert.match(popupHtml, /id="dynamicHostLabel"/);
  assert.match(popupHtml, /id="dynamicStatus"/);
  assert.match(popupHtml, /id="allowDomain"/);
  assert.match(popupHtml, /data-i18n="popupAllowThisSiteButton"/);
  assert.match(popupHtml, /id="blockDomain"/);

  assert.match(popupSource, /const allowedSitesCardEl = document\.getElementById\("allowedSitesCard"\);/);
  assert.match(popupSource, /let currentSiteLevel = MODE_OPTIMAL;/);
  assert.match(popupSource, /const nextSiteLevel = Number\(panelData\?\.level\);/);
  assert.match(popupSource, /function renderAllowedSitesControls\(\)/);
  assert.match(popupSource, /setSiteMode\(MODE_NONE\)/);
  assert.match(popupSource, /setSiteMode\(getProtectionLevelForCurrentSite\(\)\)/);
  assert.doesNotMatch(popupSource, /Compatibility mode is active on this site/);
  assert.doesNotMatch(popupSource, /Ads may be blocked less aggressively/);
  assert.doesNotMatch(popupSource, /Restore blocking/);
  assert.doesNotMatch(popupSource, /what: "restoreCompatibilityMode"/);
  assert.match(backgroundSource, /compatibilityMode: getActiveCompatibilityModeForHostname\(sanitizedHostname\)/);
  assert.match(backgroundSource, /case 'restoreCompatibilityMode':/);
});

test('popup current-tab allow action is localized in every bundled locale', async () => {
  const localesDir = new URL('../_locales/', import.meta.url);
  const entries = await fs.readdir(localesDir, { withFileTypes: true });
  const locales = entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  const englishMessages = JSON.parse(await readSource('_locales/en/messages.json'));
  const englishLabel = englishMessages.popupAllowThisSiteButton?.message;

  assert.equal(englishLabel, 'Allow this site');

  for (const locale of locales) {
    const messages = JSON.parse(await readSource(`_locales/${locale}/messages.json`));
    const label = messages.popupAllowThisSiteButton?.message;
    assert.equal(typeof label, 'string', `${locale} is missing popupAllowThisSiteButton`);
    assert.notEqual(label.trim(), '', `${locale} has an empty popupAllowThisSiteButton`);
    if (locale !== 'en') {
      assert.notEqual(label, englishLabel, `${locale} falls back to English for popupAllowThisSiteButton`);
    }
  }
});

test('popup protection toggle updates optimistically without blocking on refresh or reload', async () => {
  const popupSource = await readSource('popup/popup.js');
  const popupCss = await readSource('popup/popup.css');
  const clickStart = popupSource.indexOf('async function handleProtectionToggleClick()');
  const clickEnd = popupSource.indexOf('async function commitSiteEnabled', clickStart);
  const commitStart = popupSource.indexOf('async function commitSiteEnabled(enabled)');
  const commitEnd = popupSource.indexOf('async function setSiteMode', commitStart);
  const statusStart = popupSource.indexOf('function updateStatusSummary()');
  const statusEnd = popupSource.indexOf('function updateProtectionSummary', statusStart);
  const clickSource = popupSource.slice(clickStart, clickEnd);
  const commitSource = popupSource.slice(commitStart, commitEnd);
  const statusSource = popupSource.slice(statusStart, statusEnd);

  assert.ok(clickStart !== -1);
  assert.ok(commitStart !== -1);
  assert.ok(statusStart !== -1);
  assert.match(popupSource, /let toggleChangeInFlight = false;/);
  assert.match(clickSource, /if \(toggleChangeInFlight \|\| pendingFilteringMutations !== 0\) \{/);
  assert.match(clickSource, /return runFilteringMutation\(async \(\) => \{/);

  const captureIndex = clickSource.indexOf('const previousState = captureProtectionToggleState();');
  const optimisticIndex = clickSource.indexOf('applyOptimisticProtectionToggle(nextEnabled);');
  const commitIndex = clickSource.indexOf('await commitSiteEnabled(nextEnabled);');
  assert.ok(captureIndex !== -1 && optimisticIndex !== -1 && commitIndex !== -1);
  assert.ok(captureIndex < optimisticIndex);
  assert.ok(optimisticIndex < commitIndex);
  assert.match(clickSource, /restoreProtectionToggleState\(previousState\);/);
  assert.match(clickSource, /reloadCurrentTab\(\s*"reload tab after protection change",\s*nextEnabled \? null : \{ bypassCache: true \}\s*\)\.catch\(\(\) => \{\}\);/);
  assert.match(popupSource, /async function reloadCurrentTab\(context, reloadProperties = null\)/);
  assert.match(popupSource, /chrome\.tabs\.reload\(currentTabId, reloadProperties\);/);

  assert.doesNotMatch(commitSource, /refreshFilteringState\(/);
  assert.doesNotMatch(commitSource, /refreshPopupPanelData\(/);
  assert.doesNotMatch(commitSource, /reloadCurrentTab\(/);
  const writeSnapshotIndex = commitSource.indexOf('await writeGlobalPauseSnapshot(currentState.modes);');
  const pauseModesIndex = commitSource.indexOf('() => PAUSED_FILTERING_MODES');
  const restoreSnapshotIndex = commitSource.indexOf('currentModes => mergeFilteringModeChanges(');
  const clearSnapshotIndex = commitSource.indexOf('await clearGlobalPauseSnapshot(record.revision);');
  assert.ok(writeSnapshotIndex !== -1 && pauseModesIndex !== -1);
  assert.ok(restoreSnapshotIndex !== -1 && clearSnapshotIndex !== -1);
  assert.ok(restoreSnapshotIndex < clearSnapshotIndex);
  assert.ok(writeSnapshotIndex < pauseModesIndex);
  assert.match(commitSource, /const result = await applyFilteringModeMutation\(/);
  assert.match(commitSource, /async staleState => \{\s*await writeGlobalPauseSnapshot\(staleState\.modes\);/);
  assert.equal((commitSource.match(/clearGlobalPauseSnapshot\(/g) || []).length, 1);

  assert.match(popupSource, /function ensureToggleMarkup\(\)/);
  assert.doesNotMatch(statusSource, /toggleButton\.textContent = ""/);
  assert.doesNotMatch(statusSource, /document\.createElement\("span"\)/);
  assert.doesNotMatch(statusSource, /appendChild\(track\)/);
  assert.match(popupCss, /\.switch-track \{[\s\S]*transition: background-color 0\.16s ease;/);
  assert.match(popupCss, /\.switch-knob \{[\s\S]*transition: transform 0\.16s ease, left 0\.16s ease;/);
  assert.match(popupCss, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.switch-track,[\s\S]*\.switch-knob,[\s\S]*\.expired-step-button \{/);
});

test('picker overlay startup requires a one-time background capability claim', async () => {
  const backgroundSource = await readSource('js/background.js');
  const contentOverlaySource = await readSource('js/scripting/tool-overlay.js');
  const frameOverlaySource = await readSource('js/tool-overlay-ui.js');
  const utilsSource = await readSource('js/utils.js');

  const untrustedBoundary = backgroundSource.indexOf('// Does not require trusted origin.');
  const trustedBoundary = backgroundSource.indexOf('// Does require trusted origin.');
  const registerCase = backgroundSource.indexOf("case 'registerOverlaySession'");
  const claimCase = backgroundSource.indexOf("case 'claimOverlaySession'");

  assert.ok(untrustedBoundary !== -1);
  assert.ok(trustedBoundary !== -1);
  assert.ok(registerCase > untrustedBoundary && registerCase < trustedBoundary);
  assert.ok(claimCase > trustedBoundary);
  assert.match(backgroundSource, /const overlaySessions = createOverlaySessionStore\(\);/);
  assert.match(backgroundSource, /isExtensionRuntimeSender\(sender\) === false/);
  assert.match(backgroundSource, /overlaySessions\.register\(\{/);
  assert.match(backgroundSource, /overlaySessions\.claim\(\{/);

  assert.match(contentOverlaySource, /createSessionToken\(\)/);
  assert.match(contentOverlaySource, /self\.crypto\.getRandomValues\(bytes\);/);
  assert.match(contentOverlaySource, /what: 'registerOverlaySession'/);
  assert.match(contentOverlaySource, /capability: token/);
  assert.match(contentOverlaySource, /file,/);
  assert.match(contentOverlaySource, /pageUrl: this\.url\.href/);

  assert.match(frameOverlaySource, /const TOKEN_RE = \/\^\[a-f0-9\]\{32\}\$\/;/);
  assert.match(frameOverlaySource, /what: 'claimOverlaySession'/);
  assert.match(frameOverlaySource, /pageUrl: url/);
  assert.match(frameOverlaySource, /globalThis\.removeEventListener\('message', onStartMessage\);/);
  assert.doesNotMatch(frameOverlaySource, /\{ once: true \}/);

  assert.match(utilsSource, /const OVERLAY_SESSION_TOKEN_RE = \/\^\[a-f0-9\]\{32\}\$\/;/);
  assert.match(utilsSource, /export function createOverlaySessionStore/);
  assert.match(utilsSource, /sessions\.delete\(token\);/);
  assert.match(utilsSource, /entry\.expiresAt <= claimedAt/);
  assert.match(utilsSource, /entry\.file !== file \|\| entry\.pageUrl !== pageUrl/);
});

test('local diagnostics messages require a trusted extension page sender', async () => {
  const source = await readSource('js/background.js');

  for (const what of ['getCommunitySyncDiagnostics', 'getInjectableSyncDiagnostics']) {
    const caseStart = source.indexOf(`case '${what}'`);
    const caseEnd = source.indexOf('case ', caseStart + 1);
    const handlerSource = source.slice(
      caseStart,
      caseEnd === -1 ? source.length : caseEnd
    );

    assert.ok(caseStart !== -1, `${what} handler missing`);
    assert.match(
      handlerSource,
      /isTrustedExtensionSender\(sender\) === false\) \{ return false; \}/,
      `${what} must reject content-script/page senders`
    );
  }
});

test('breakage signal messages are bound to the sender hostname', async () => {
  const source = await readSource('js/background.js');
  const caseStart = source.indexOf("case 'reportBreakageSignal':");
  const caseEnd = source.indexOf("case 'setBreakageAuditOverrides':", caseStart);
  const handlerSource = source.slice(caseStart, caseEnd);

  assert.ok(caseStart !== -1, 'reportBreakageSignal handler missing');
  assert.ok(caseEnd !== -1, 'setBreakageAuditOverrides handler missing');
  assert.match(
    handlerSource,
    /normalizeHttpHostname\(sender\?\.url \|\| sender\?\.tab\?\.url \|\| ''\)/
  );
  assert.match(handlerSource, /if \(senderHostname === ''\) \{ return false; \}/);
  assert.match(
    handlerSource,
    /if \(reportedHostname !== '' && reportedHostname !== senderHostname\) \{[\s\S]*return false;[\s\S]*\}/
  );
  assert.match(handlerSource, /recordBreakageSignal\(senderHostname, request\.signal, details\)/);
  assert.doesNotMatch(handlerSource, /reportedHostname \|\| senderHostname/);
});

test('custom filter compiler messages require the offscreen compiler sender', async () => {
  const source = await readSource('js/filter-manager.js');
  const helperStart = source.indexOf('const EXTENSION_ORIGIN = new URL(runtime.getURL');
  const parseStart = source.indexOf('async function parseRawFilters(text)');
  const handlerStart = source.indexOf('const handler = (request, sender, callback) => {', parseStart);
  const listenerStart = source.indexOf('runtime.onMessage.addListener(handler);', handlerStart);
  const helperSource = source.slice(helperStart, parseStart);
  const handlerSource = source.slice(handlerStart, listenerStart);

  assert.ok(helperStart !== -1, 'isOffscreenCompilerSender helper missing');
  assert.ok(handlerStart !== -1, 'parseRawFilters message handler missing');
  assert.match(helperSource, /const OFFSCREEN_COMPILER_PATH = '\/js\/offscreen\/compile-filters\.html';/);
  assert.match(helperSource, /senderId !== '' && senderId !== runtime\.id/);
  assert.match(helperSource, /parsedURL\.origin === EXTENSION_ORIGIN/);
  assert.match(helperSource, /parsedURL\.pathname === OFFSCREEN_COMPILER_PATH/);
  assert.match(handlerSource, /if \( isOffscreenCompilerSender\(sender\) === false \) \{ return; \}/);
});

test('cosmetic cleanup waits for an in-flight CSS insert before removing it', async () => {
  const source = await readSource('js/scripting/css-api.js');
  const calls = [];
  let finishInsert;
  const context = {
    chrome: {
      runtime: {
        sendMessage(message) {
          calls.push(message.what);
          if (message.what === 'insertCSS') {
            return new Promise(resolve => { finishInsert = resolve; });
          }
          return Promise.resolve({ ok: true });
        },
      },
    },
  };
  context.self = context;
  vm.createContext(context);
  vm.runInContext(source, context);

  const insertPromise = context.cssAPI.insert('.ad{display:none}');
  const cleanupPromise = context.cssAPI.removeAll();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['insertCSS']);

  finishInsert({ ok: true });
  await Promise.all([insertPromise, cleanupPromise]);
  assert.deepEqual(calls, ['insertCSS', 'removeCSS']);
});

test('cosmetic insert transport rejection does not poison a later retry', async () => {
  const source = await readSource('js/scripting/css-api.js');
  let insertAttempts = 0;
  const calls = [];
  const context = {
    chrome: {
      runtime: {
        async sendMessage(message) {
          calls.push(message.what);
          if (message.what === 'insertCSS') {
            insertAttempts += 1;
            if (insertAttempts === 1) {
              throw new Error('forced transport rejection');
            }
          }
          return { ok: true };
        },
      },
    },
  };
  context.self = context;
  vm.createContext(context);
  vm.runInContext(source, context);

  const css = '.retry-after-transport{display:none}';
  await assert.rejects(
    context.cssAPI.insert(css, 'core'),
    /forced transport rejection/
  );
  await context.cssAPI.insert(css, 'core');
  await context.cssAPI.removeAll('core');

  assert.equal(insertAttempts, 2);
  assert.deepEqual(calls, ['insertCSS', 'insertCSS', 'removeCSS']);
});

test('cosmetic reinsert waits for an in-flight removal and restores the sheet', async () => {
  const source = await readSource('js/scripting/css-api.js');
  const calls = [];
  let finishRemove;
  let delayRemove = true;
  const context = {
    chrome: {
      runtime: {
        sendMessage(message) {
          calls.push(message.what);
          if (message.what === 'removeCSS' && delayRemove) {
            delayRemove = false;
            return new Promise(resolve => { finishRemove = resolve; });
          }
          return Promise.resolve({ ok: true });
        },
      },
    },
  };
  context.self = context;
  vm.createContext(context);
  vm.runInContext(source, context);

  const css = '.race{display:none}';
  await context.cssAPI.insert(css, 'core');
  const removal = context.cssAPI.remove(css, 'core');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['insertCSS', 'removeCSS']);

  const reinsert = context.cssAPI.insert(css, 'core');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['insertCSS', 'removeCSS']);
  finishRemove({ ok: true });
  await Promise.all([removal, reinsert]);
  assert.deepEqual(calls, ['insertCSS', 'removeCSS', 'insertCSS']);

  await context.cssAPI.removeAll('core');
  assert.deepEqual(calls, [
    'insertCSS',
    'removeCSS',
    'insertCSS',
    'removeCSS',
  ]);
});

test('cosmetic sheets retain every scope owner until the final owner releases', async () => {
  const source = await readSource('js/scripting/css-api.js');
  const calls = [];
  const context = {
    chrome: {
      runtime: {
        async sendMessage(message) {
          calls.push(message.what);
          return { ok: true };
        },
      },
    },
  };
  context.self = context;
  vm.createContext(context);
  vm.runInContext(source, context);

  const css = '.shared{display:none!important}';
  await Promise.all([
    context.cssAPI.insert(css, 'core'),
    context.cssAPI.insert(css, 'custom'),
  ]);
  assert.deepEqual(calls, ['insertCSS']);

  await context.cssAPI.removeAll('core');
  assert.deepEqual(calls, ['insertCSS']);
  await context.cssAPI.removeAll('custom');
  assert.deepEqual(calls, ['insertCSS', 'removeCSS']);
});

test('plain custom cosmetics use scoped, message-safe chunks and release only that scope', async () => {
  const cssApiSource = await readSource('js/scripting/css-api.js');
  const cssUserSource = await readSource('js/scripting/css-user.js');
  const terminateSource = await readSource('js/scripting/css-user-terminate.js');
  const messages = [];
  const testURL = [ 'https', '://', 'example.invalid', '/' ].join('');
  const selectors = Array.from(
    { length: 18000 },
    (_, index) => `.custom-${index}`
  );
  const context = {
    URL,
    document: {
      baseURI: testURL,
      referrer: '',
      location: {
        href: testURL,
        ancestorOrigins: [],
      },
    },
    chrome: {
      runtime: {
        async sendMessage(message) {
          messages.push(message);
          return { ok: true };
        },
      },
    },
  };
  context.self = context;
  vm.createContext(context);
  vm.runInContext(`self.TalonStagedCustomFilterDetails = {
    plainSelectors: Array.from(
      { length: ${selectors.length} },
      (_, index) => '.custom-' + index
    ),
    proceduralSelectors: [],
  };`, context);
  vm.runInContext(cssApiSource, context);
  vm.runInContext(cssUserSource, context);
  await context.TalonCssUserReady;

  const inserts = messages.filter(message => message.what === 'insertCSS');
  assert.ok(inserts.length > 1);
  assert.equal(inserts.every(message => message.css.length <= 100000), true);
  assert.equal(context.customFilters.plainSelectors.length, selectors.length);

  const termination = vm.runInContext(terminateSource, context);
  await termination;
  const removals = messages.filter(message => message.what === 'removeCSS');
  assert.equal(removals.length, inserts.length);
  assert.deepEqual(
    removals.map(message => message.css),
    inserts.map(message => message.css)
  );
});

test('legacy custom insertion is rolled back before an overlapping terminator completes', async () => {
  const cssUserSource = await readSource('js/scripting/css-user.js');
  const terminateSource = await readSource('js/scripting/css-user-terminate.js');
  const messages = [];
  let resolveInsert;
  const testURL = [ 'https', '://', 'example.invalid', '/' ].join('');
  const context = {
    URL,
    document: {
      baseURI: testURL,
      referrer: '',
      location: { href: testURL, ancestorOrigins: [] },
    },
    cssAPI: {},
    chrome: {
      runtime: {
        sendMessage(message) {
          messages.push(message);
          if (message.what === 'insertCSS') {
            return new Promise(resolve => { resolveInsert = resolve; });
          }
          return Promise.resolve({ ok: true });
        },
      },
    },
  };
  context.self = context;
  vm.createContext(context);
  vm.runInContext(`self.TalonStagedCustomFilterDetails = {
    plainSelectors: ['.legacy-delayed'],
    proceduralSelectors: [],
  };`, context);
  vm.runInContext(cssUserSource, context);
  const startup = context.TalonCssUserReady;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(messages.map(message => message.what), ['insertCSS']);

  const termination = vm.runInContext(terminateSource, context);
  let terminationSettled = false;
  termination.finally(() => { terminationSettled = true; }).catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(terminationSettled, false);
  assert.deepEqual(messages.map(message => message.what), ['insertCSS']);

  resolveInsert({ ok: true });
  await Promise.all([startup, termination]);
  assert.deepEqual(messages.map(message => message.what), [
    'insertCSS',
    'removeCSS',
  ]);
  assert.equal(messages[1].css, messages[0].css);
  assert.equal(context.customFilters, undefined);
  assert.equal(context.TalonPendingCustomFilterDetails, undefined);
  assert.equal(context.TalonCustomCssTerminationDepth, 0);
});

test('custom terminator re-reads a late readiness set and starters abort before fetching details', async () => {
  const cssUserSource = await readSource('js/scripting/css-user.js');
  const terminateSource = await readSource('js/scripting/css-user-terminate.js');
  const messages = [];
  let releaseLateReadiness;
  const lateReadiness = new Promise(resolve => { releaseLateReadiness = resolve; });
  const testURL = [ 'https', '://', 'example.invalid', '/' ].join('');
  const context = {
    URL,
    document: {
      baseURI: testURL,
      referrer: '',
      location: { href: testURL, ancestorOrigins: [] },
    },
    chrome: {
      runtime: {
        async sendMessage(message) {
          messages.push(message);
          return {
            plainSelectors: ['.must-not-insert'],
            proceduralSelectors: [],
          };
        },
      },
    },
  };
  context.self = context;
  vm.createContext(context);

  const termination = vm.runInContext(terminateSource, context);
  const lateReadySet = new Set([lateReadiness]);
  lateReadiness.finally(() => lateReadySet.delete(lateReadiness));
  context.TalonCssUserReadySet = lateReadySet;
  vm.runInContext(cssUserSource, context);
  await context.TalonCssUserReady;
  assert.deepEqual(messages, []);

  let terminationSettled = false;
  termination.finally(() => { terminationSettled = true; }).catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(terminationSettled, false);
  releaseLateReadiness();
  await termination;
  assert.equal(context.TalonCustomCssTerminationDepth, 0);
});

test('custom terminator preserves failed scoped cleanup state for an exact retry', async () => {
  const terminateSource = await readSource('js/scripting/css-user-terminate.js');
  let removeAttempts = 0;
  const context = {
    customFilters: {
      plainSelectors: ['.retry-custom-cleanup'],
      proceduralSelectors: [],
    },
    cssAPI: {
      supportsScopedOwnership: true,
      async removeAll(scope) {
        assert.equal(scope, 'custom');
        removeAttempts += 1;
        if (removeAttempts === 1) {
          throw new Error('forced custom cleanup failure');
        }
      },
    },
    chrome: { runtime: { async sendMessage() { return { ok: true }; } } },
  };
  context.self = context;
  vm.createContext(context);

  await assert.rejects(
    vm.runInContext(terminateSource, context),
    /custom CSS termination was incomplete/
  );
  assert.deepEqual(Array.from(context.customFilters.plainSelectors), [
    '.retry-custom-cleanup',
  ]);

  await vm.runInContext(terminateSource, context);
  assert.equal(removeAttempts, 2);
  assert.equal(context.customFilters, undefined);
  assert.equal(context.TalonPendingCustomFilterDetails, undefined);
  assert.equal(context.TalonStagedCustomFilterDetails, undefined);
});

test('core terminator re-reads late readiness and specific CSS aborts before storage', async () => {
  const specificSource = await readSource('js/scripting/css-specific.js');
  const terminateSource = await readSource('js/scripting/css-core-terminate.js');
  let storageReads = 0;
  let insertCalls = 0;
  let releaseLateReadiness;
  const lateReadiness = new Promise(resolve => { releaseLateReadiness = resolve; });
  const context = {
    document: { location: { hostname: 'example.invalid' } },
    isolatedAPI: {
      contexts: {
        topHostname: 'example.invalid',
        hostnames: ['example.invalid'],
        entities: [],
      },
    },
    specificImports: [],
    cssAPI: {
      async insert() { insertCalls += 1; },
      async removeAll() {},
    },
    chrome: {
      storage: {
        session: {
          async get() { storageReads += 1; return {}; },
          async set() {},
        },
        local: {
          async get() { storageReads += 1; return {}; },
        },
      },
    },
  };
  context.self = context;
  vm.createContext(context);

  const termination = vm.runInContext(terminateSource, context);
  const lateReadySet = new Set([lateReadiness]);
  lateReadiness.finally(() => lateReadySet.delete(lateReadiness));
  context.TalonCssSpecificReadySet = lateReadySet;
  vm.runInContext(specificSource, context);
  await context.TalonCssSpecificReady;
  assert.equal(storageReads, 0);
  assert.equal(insertCalls, 0);

  let terminationSettled = false;
  termination.finally(() => { terminationSettled = true; }).catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(terminationSettled, false);
  releaseLateReadiness();
  await termination;
  assert.equal(context.TalonCoreCssTerminationDepth, 0);
});

test('every cosmetic terminator resolves readiness globals dynamically', async () => {
  for (const path of [
    'js/scripting/css-user-terminate.js',
    'js/scripting/css-core-terminate.js',
    'js/scripting/css-runtime-terminate.js',
  ]) {
    const source = await readSource(path);
    assert.match(source, /const drainReadySets = async globalNames =>/);
    assert.match(
      source,
      /globalNames\.flatMap\(globalName =>[\s\S]*self\[globalName\]/
    );
    assert.doesNotMatch(source, /const drainReadySets = async sets =>/);
  }
});

test('core and full cosmetic terminators detach observers before bounded readiness and remain retryable', async () => {
  for (const path of [
    'js/scripting/css-core-terminate.js',
    'js/scripting/css-runtime-terminate.js',
  ]) {
    const source = await readSource(path);
    const context = {
      Promise,
      AggregateError,
      Date,
      setTimeout(callback) { return setTimeout(callback, 1); },
      clearTimeout(timer) { clearTimeout(timer); },
      cssAPI: { async removeAll() {} },
    };
    context.self = context;
    vm.createContext(context);
    vm.runInContext(`
      self.resetCalls = 0;
      self.resetMayFinish = false;
      self.stalledReady = new Promise(() => {});
      self.TalonCssSpecificReadySet = new Set([ self.stalledReady ]);
      self.listsSpecificProceduralFiltererAPI = {
        reset() {
          self.resetCalls += 1;
          return self.resetMayFinish
            ? Promise.resolve()
            : new Promise(() => {});
        },
      };
    `, context);

    const controller = context.listsSpecificProceduralFiltererAPI;
    const first = vm.runInContext(source, context);
    assert.equal(
      context.resetCalls,
      1,
      `${path} must synchronously begin observer cleanup`
    );
    await assert.rejects(first, reason =>
      reason instanceof AggregateError &&
      reason.errors.some(error => `${error}`.includes('readiness timed out'))
    );
    assert.equal(
      context.listsSpecificProceduralFiltererAPI,
      controller,
      `${path} must retain a failed controller for cleanup retry`
    );

    context.resetMayFinish = true;
    context.TalonCssSpecificReadySet.clear();
    await vm.runInContext(source, context);
    assert.equal(context.resetCalls, 2);
    assert.equal(context.listsSpecificProceduralFiltererAPI, undefined);
    assert.equal(context.TalonCoreCssTerminationDepth, 0);
    if (path.endsWith('css-runtime-terminate.js')) {
      assert.equal(context.TalonCustomCssTerminationDepth, 0);
    }
  }
});

test('procedural CSS fallback removal is bounded and preserves failed sheets for retry', async () => {
  const source = await readSource('js/scripting/css-procedural-api.js');
  const messages = [];
  let removalMaySucceed = false;
  const context = {
    Promise,
    AggregateError,
    document: {},
    MutationObserver: class {
      observe() {}
      disconnect() {}
      takeRecords() { return []; }
    },
    setTimeout,
    clearTimeout,
    chrome: {
      runtime: {
        async sendMessage(message) {
          messages.push(message);
          return removalMaySucceed
            ? { ok: true }
            : { ok: false, error: 'forced fallback failure' };
        },
      },
    },
  };
  context.self = context;
  vm.createContext(context);
  vm.runInContext(source, context);

  const filterer = new context.ProceduralFiltererAPI('fallback-test');
  filterer.cssSheets.add('.fallback-sheet{display:none}');
  await assert.rejects(filterer.reset(), reason =>
    reason instanceof AggregateError &&
    reason.errors.some(error => `${error}`.includes('forced fallback failure'))
  );
  assert.equal(filterer.cssSheets.size, 1);

  removalMaySucceed = true;
  await filterer.reset();
  assert.equal(filterer.cssSheets.size, 0);
  assert.deepEqual(messages.map(message => message.what), [
    'removeCSS',
    'removeCSS',
  ]);
});

test('specific procedural API acquisition clears a rejected promise and succeeds on retry', async () => {
  const source = await readSource('js/scripting/css-specific.js');
  let attempts = 0;
  let context;
  const cacheEntry = {
    t: 1,
    s: [],
    p: [{ raw: '.retry', selector: '.retry' }],
  };
  context = {
    Promise,
    AggregateError,
    URL,
    setTimeout,
    clearTimeout,
    document: { location: { hostname: 'example.invalid' } },
    isolatedAPI: {
      binarySearch() { return -1; },
      contexts: {
        topHostname: 'example.invalid',
        hostnames: ['example.invalid'],
        entities: [],
      },
    },
    cssAPI: {
      async insert() {},
      async removeAll() {},
    },
    chrome: {
      storage: {
        session: {
          async get(key) { return { [key]: cacheEntry }; },
          async set() {},
        },
        local: { async get() { return {}; } },
      },
      runtime: {
        sendMessage() {
          attempts += 1;
          if (attempts === 1) {
            return Promise.reject(new Error('forced acquisition failure'));
          }
          return new Promise(resolve => queueMicrotask(() => {
            context.ProceduralFiltererAPI = class {
              async addSelectors(selectors) {
                context.appliedProceduralSelectors = selectors.length;
              }
              async reset() {}
            };
            resolve({ ok: true });
          }));
        },
      },
    },
  };
  context.self = context;
  vm.createContext(context);

  vm.runInContext(source, context);
  await assert.rejects(
    context.TalonCssSpecificReady,
    /forced acquisition failure/
  );
  assert.equal(context.ProceduralFiltererAPI, undefined);

  vm.runInContext(source, context);
  await context.TalonCssSpecificReady;
  assert.equal(attempts, 2);
  assert.equal(context.appliedProceduralSelectors, 1);
  assert.equal(typeof context.ProceduralFiltererAPI, 'function');
});

test('cosmetic starters check termination before their first asynchronous dependency', async () => {
  const cases = [
    {
      path: 'js/scripting/css-user.js',
      asyncNeedle: 'const details = stagedDetails instanceof Object',
    },
    {
      path: 'js/scripting/css-specific.js',
      asyncNeedle: 'let cacheEntry = await sessionRead(cacheKey)',
    },
    {
      path: 'js/scripting/css-procedural.js',
      asyncNeedle: 'const selectors = [];',
    },
    {
      path: 'js/scripting/css-generic.js',
      asyncNeedle: 'await existingController?.stop?.();',
    },
  ];
  for (const { path, asyncNeedle } of cases) {
    const source = await readSource(path);
    const guardIndex = source.indexOf('if ( runtimeWasTerminated() )');
    const asyncIndex = source.indexOf(asyncNeedle);
    assert.notEqual(guardIndex, -1, `${path} missing early termination guard`);
    assert.notEqual(asyncIndex, -1, `${path} missing ${asyncNeedle}`);
    assert.ok(
      guardIndex < asyncIndex,
      `${path} must abort before reaching ${asyncNeedle}`
    );
  }
});

test('plain custom cosmetic startup rolls back earlier chunks when a later insert fails', async () => {
  const cssApiSource = await readSource('js/scripting/css-api.js');
  const cssUserSource = await readSource('js/scripting/css-user.js');
  const messages = [];
  let insertCount = 0;
  const testURL = [ 'https', '://', 'example.invalid', '/' ].join('');
  const context = {
    URL,
    document: {
      baseURI: testURL,
      referrer: '',
      location: { href: testURL, ancestorOrigins: [] },
    },
    chrome: {
      runtime: {
        async sendMessage(message) {
          messages.push(message);
          if (message.what === 'insertCSS') {
            insertCount += 1;
            if (insertCount === 2) {
              return { ok: false, error: 'forced insert failure' };
            }
          }
          return { ok: true };
        },
      },
    },
  };
  context.self = context;
  vm.createContext(context);
  vm.runInContext(`self.TalonStagedCustomFilterDetails = {
    plainSelectors: Array.from(
      { length: 18000 },
      (_, index) => '.rollback-' + index
    ),
    proceduralSelectors: [],
  };`, context);
  vm.runInContext(cssApiSource, context);
  vm.runInContext(cssUserSource, context);

  await assert.rejects(context.TalonCssUserReady, /forced insert failure/);
  const inserts = messages.filter(message => message.what === 'insertCSS');
  const removals = messages.filter(message => message.what === 'removeCSS');
  assert.equal(inserts.length, 2);
  assert.equal(removals.length, 1);
  assert.equal(removals[0].css, inserts[0].css);
  assert.equal(context.TalonPendingCustomFilterDetails, undefined);
  assert.equal(context.customFilters, undefined);
});

test('procedural cosmetic readiness rejects declarative and token sheet failures', async () => {
  const source = await readSource('js/scripting/css-procedural-api.js');
  const context = {
    document: {},
    MutationObserver: class {
      observe() {}
      disconnect() {}
      takeRecords() { return []; }
    },
    cssAPI: {
      insert() {
        return Promise.reject(new Error('forced procedural CSS failure'));
      },
      remove() { return Promise.resolve(); },
    },
  };
  context.self = context;
  vm.createContext(context);
  vm.runInContext(source, context);

  const declarative = new context.ProceduralFiltererAPI('core');
  await assert.rejects(
    declarative.addDeclaratives([{
      selector: '.declarative-ad',
      action: [ 'style', 'display:none!important;' ],
    }]),
    /forced procedural CSS failure/
  );

  const procedural = new context.ProceduralFiltererAPI('core');
  await assert.rejects(
    procedural.addProcedurals([{
      raw: '.procedural-ad',
      selector: '.procedural-ad',
    }]),
    /forced procedural CSS failure/
  );
});

test('mixed procedural startup rolls back sheets, tokens, and observers on failure', async () => {
  const source = await readSource('js/scripting/css-procedural-api.js');
  const inserted = new Set();
  let insertCount = 0;
  let connectedObservers = 0;
  const targetAttributes = new Set();
  const context = {
    document: {
      querySelectorAll(selector) {
        return selector === '.transactional-procedural' ? [target] : [];
      },
    },
    MutationObserver: class {
      observe() { connectedObservers += 1; }
      disconnect() {
        if (connectedObservers > 0) { connectedObservers -= 1; }
      }
      takeRecords() { return []; }
    },
    requestAnimationFrame(callback) {
      callback();
      return 1;
    },
    cancelAnimationFrame() {},
    cssAPI: {
      async insert(css) {
        insertCount += 1;
        if (insertCount === 2) {
          throw new Error('forced token transaction failure');
        }
        inserted.add(css);
      },
      async remove(css) {
        inserted.delete(css);
      },
    },
  };
  const target = {
    setAttribute(name) { targetAttributes.add(name); },
    removeAttribute(name) { targetAttributes.delete(name); },
  };
  context.self = context;
  vm.createContext(context);
  vm.runInContext(source, context);

  const filterer = new context.ProceduralFiltererAPI('core-test');
  await assert.rejects(
    filterer.addSelectors([
      {
        cssable: true,
        selector: '.transactional-declarative',
        action: ['style', 'display:none!important;'],
      },
      {
        raw: '.transactional-procedural',
        selector: '.transactional-procedural',
      },
    ]),
    /forced token transaction failure/
  );

  assert.equal(inserted.size, 0);
  assert.equal(targetAttributes.size, 0);
  assert.equal(connectedObservers, 0);
  assert.equal(filterer.proceduralFilterer, null);
  assert.equal(filterer.cssSheets.size, 0);
});

test('custom procedural cosmetics apply through the outer transactional API', async () => {
  const proceduralSource = await readSource('js/scripting/css-procedural-api.js');
  const cssUserSource = await readSource('js/scripting/css-user.js');
  const inserted = [];
  const targetAttributes = new Set();
  const testURL = testHttpsUrl('example.invalid');
  const target = {
    setAttribute(name) { targetAttributes.add(name); },
    removeAttribute(name) { targetAttributes.delete(name); },
  };
  const context = {
    URL,
    document: {
      baseURI: testURL,
      referrer: '',
      location: { href: testURL, ancestorOrigins: [] },
      querySelectorAll(selector) {
        return selector === '.custom-procedural-ad' ? [target] : [];
      },
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
      takeRecords() { return []; }
    },
    requestAnimationFrame() { return 1; },
    cancelAnimationFrame() {},
    cssAPI: {
      supportsScopedOwnership: true,
      async insert(css, scope) { inserted.push({ css, scope }); },
      async remove() {},
      async removeAll() {},
      selectorListCssChunks() { return []; },
    },
    chrome: {
      runtime: {
        async sendMessage() { return { ok: true }; },
      },
    },
  };
  context.self = context;
  vm.createContext(context);
  vm.runInContext(proceduralSource, context);
  vm.runInContext(`self.TalonStagedCustomFilterDetails = {
    plainSelectors: [],
    proceduralSelectors: [JSON.stringify({
      raw: '.custom-procedural-ad',
      selector: '.custom-procedural-ad',
    })],
  };`, context);
  vm.runInContext(cssUserSource, context);

  await context.TalonCssUserReady;
  assert.ok(context.customProceduralFiltererAPI);
  assert.equal(
    context.customProceduralFiltererAPI.proceduralFilterer.selectors.length,
    1
  );
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].scope, 'custom');
  assert.equal(targetAttributes.size, 1);
});

test('irreversible custom and core procedural actions require exact-document reloads', async () => {
  const backgroundSource = await readSource('js/background.js');
  const readersSource = sourceBetween(
    backgroundSource,
    'function readIrreversibleCustomProceduralSelectors',
    'async function getIrreversibleProceduralRuntimeByFrame'
  );
  const context = {
    listsCompiledProceduralFiltererAPI: {
      proceduralFilterer: {
        selectors: [
          { raw: 'compiled-remove', action: ['remove'] },
          { raw: 'compiled-style', action: ['style', 'display:none'] },
        ],
      },
    },
    listsSpecificProceduralFiltererAPI: {
      proceduralFilterer: {
        selectors: [
          { raw: 'specific-attr', action: ['remove-attr', 'data-ad'] },
          { raw: 'specific-class', action: ['remove-class', 'sponsored'] },
        ],
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(`${readersSource}
    globalThis.customIrreversible = readIrreversibleCustomProceduralSelectors({
      proceduralSelectors: [
        JSON.stringify({ raw: 'custom-remove', action: ['remove'] }),
        JSON.stringify({ raw: 'custom-attr', action: ['remove-attr', 'data-ad'] }),
        JSON.stringify({ raw: 'custom-class', action: ['remove-class', 'ad'] }),
        JSON.stringify({ raw: 'custom-style', action: ['style', 'display:none'] }),
      ],
    });
    globalThis.coreIrreversible = readIrreversibleCoreProceduralSelectors();
  `, context);

  assert.equal(context.customIrreversible.length, 3);
  assert.equal(context.coreIrreversible.length, 3);
  assert.match(backgroundSource, /getIrreversibleCoreProceduralRuntimeByFrame[\s\S]*'irreversible_core_procedural'/);
  assert.match(backgroundSource, /getIrreversibleCustomProceduralRuntimeByFrame[\s\S]*'irreversible_custom_procedural'/);
  assert.match(backgroundSource, /markReloadNeededForTab\([\s\S]*updateWildcard = true/);
});

test('extension source keeps only bounded static runtime lanes', async () => {
  const watchPrefix = 'youtube' + '-watch';
  const relayHtmlPath = `web_accessible_resources/${watchPrefix}-relay.html`;
  const relayScriptPath = `web_accessible_resources/${watchPrefix}-relay.js`;
  const bootstrapPath = `js/scripting/${watchPrefix}-bootstrap.js`;
  const talonYouTubePath = 'js/scripting/youtube-ad-skip.js';
  const talonYouTubeGuardPath = 'js/scripting/youtube-player-guard.js';
  const talonYouTubeGuardLoaderPath = 'js/scripting/youtube-player-guard-loader.js';
  const frenchStreamMainSiteFixPath = 'rulesets/scripting/scriptlet/main/talon-site-fixes.js';
  const managerSource = await readSource('js/scripting-manager.js');
  const talonYouTubeSource = await readSource(talonYouTubePath);
  const talonYouTubeGuardSource = await readSource(talonYouTubeGuardPath);
  const talonYouTubeGuardLoaderSource = await readSource(talonYouTubeGuardLoaderPath);
  const heuristicSource = await readSource('js/scripting/native-heuristics.js');
  const backgroundSource = await readSource('js/background.js');
  const rulesetSource = await readSource('js/ruleset-manager.js');
  const ownershipSource = await readSource('scripts/ubol-source-ownership.json');
  const allowlist = await readSource('public-safe-allowlist.txt');
  const manifest = JSON.parse(await readSource('manifest.json'));
  const contentScripts = Array.isArray(manifest.content_scripts)
    ? manifest.content_scripts
    : [];
  const publicResources = (manifest.web_accessible_resources ?? [])
    .flatMap(entry => entry.resources ?? []);
  const youtubeGuardMainScripts = contentScripts.filter(entry =>
    Array.isArray(entry.js) &&
    entry.js.includes(talonYouTubeGuardPath)
  );
  const youtubeGuardLoaders = contentScripts.filter(entry =>
    Array.isArray(entry.js) &&
    entry.js.includes(talonYouTubeGuardLoaderPath)
  );
  const frenchStreamMainScripts = contentScripts.filter(entry =>
    Array.isArray(entry.js) &&
    entry.js.includes(frenchStreamMainSiteFixPath)
  );
  const youtubeGuardResources = (manifest.web_accessible_resources ?? []).filter(entry =>
    Array.isArray(entry.resources) &&
    entry.resources.includes(talonYouTubeGuardPath)
  );

  assert.equal(await pathExists(talonYouTubePath), true);
  assert.equal(await pathExists(talonYouTubeGuardPath), true);
  assert.equal(await pathExists(talonYouTubeGuardLoaderPath), true);
  assert.equal(await pathExists('js/scripting/french-stream-site-fix-loader.js'), false);
  assert.equal(await pathExists(bootstrapPath), false);
  assert.equal(await pathExists(relayHtmlPath), false);
  assert.equal(await pathExists(relayScriptPath), false);
  assert.equal(youtubeGuardMainScripts.length, 1);
  assert.deepEqual(youtubeGuardMainScripts[0].matches, [
    '*://*.youtube.com/*',
    '*://*.youtube-nocookie.com/*',
  ]);
  assert.deepEqual(youtubeGuardMainScripts[0].js, [talonYouTubeGuardPath]);
  assert.equal(youtubeGuardMainScripts[0].run_at, 'document_start');
  assert.equal(youtubeGuardMainScripts[0].all_frames, true);
  assert.equal(youtubeGuardMainScripts[0].world, 'MAIN');
  assert.equal(youtubeGuardLoaders.length, 1);
  assert.deepEqual(youtubeGuardLoaders[0].matches, [
    '*://*.youtube.com/*',
    '*://*.youtube-nocookie.com/*',
  ]);
  assert.deepEqual(youtubeGuardLoaders[0].js, [talonYouTubeGuardLoaderPath]);
  assert.equal(youtubeGuardLoaders[0].run_at, 'document_start');
  assert.equal(youtubeGuardLoaders[0].all_frames, true);
  assert.equal(youtubeGuardLoaders[0].world, undefined);
  assert.equal(frenchStreamMainScripts.length, 0);
  assert.equal(youtubeGuardResources.length, 1);
  assert.deepEqual(youtubeGuardResources[0].matches, [
    '*://*.youtube.com/*',
    '*://*.youtube-nocookie.com/*',
  ]);
  assert.equal(
    contentScripts.some(entry =>
      Array.isArray(entry.js) &&
      entry.js.includes(talonYouTubePath)
    ),
    false
  );
  assert.equal(publicResources.includes(frenchStreamMainSiteFixPath), false);
  assert.equal(publicResources.some(resource => resource.includes(`${watchPrefix}-relay`)), false);
  assert.equal(
    publicResources.some(resource =>
      /youtube/i.test(resource) && resource !== talonYouTubeGuardPath
    ),
    false
  );
  assert.equal(allowlist.includes(talonYouTubePath), true);
  assert.equal(allowlist.includes(talonYouTubeGuardPath), true);
  assert.equal(allowlist.includes(talonYouTubeGuardLoaderPath), true);
  assert.equal(allowlist.includes(frenchStreamMainSiteFixPath), true);
  assert.equal(allowlist.includes(bootstrapPath), false);
  assert.equal(allowlist.includes(relayHtmlPath), false);
  assert.equal(allowlist.includes(relayScriptPath), false);

  assert.match(managerSource, /TALON_YOUTUBE_AD_SKIP_ID = 'talon-youtube-ad-skip'/);
  assert.match(managerSource, /TALON_YOUTUBE_PLAYER_GUARD_ID = 'talon-youtube-player-guard'/);
  assert.match(managerSource, /TALON_YOUTUBE_PLAYER_GUARD_PATH = '\/js\/scripting\/youtube-player-guard\.js'/);
  assert.match(managerSource, /function registerYouTubePlayerGuard\(context\)/);
  assert.match(managerSource, /registerYouTubePlayerGuard\(context\)/);
  assert.match(managerSource, /world: 'MAIN'/);
  assert.match(managerSource, /registerYouTubeAdSkip\(context\)/);
  assert.match(managerSource, /getScriptletExcludedHostnames/);
  assert.match(managerSource, /YOUTUBE_AD_SKIP_HOSTNAMES/);
  assert.match(talonYouTubeSource, /TalonBreakageGuard/);
  assert.match(talonYouTubeSource, /youtubeAdSkip/);
  assert.doesNotMatch(talonYouTubeSource, /chrome\.runtime|browser\.runtime|\bfetch\s*\(|\bXMLHttpRequest\b|runtime\.getURL/);
  assert.doesNotMatch(talonYouTubeSource, /createElement\(['"]script['"]\)/);
  assert.match(talonYouTubeGuardSource, /talonYoutubePlayerGuard/);
  assert.match(talonYouTubeGuardSource, /response payloads intact/);
  assert.match(talonYouTubeGuardSource, /installStorageResetLiteGuard/);
  assert.match(talonYouTubeGuardSource, /SSAP_NAMESPACE/);
  assert.doesNotMatch(talonYouTubeGuardSource, /chrome\.runtime|browser\.runtime|runtime\.getURL/);
  assert.doesNotMatch(talonYouTubeGuardSource, /createElement\(['"]script['"]\)/);
  assert.match(talonYouTubeGuardLoaderSource, /talonYoutubePlayerGuardLoader/);
  assert.match(talonYouTubeGuardLoaderSource, /chrome\.runtime\.getURL\(GUARD_SCRIPT_PATH\)/);
  assert.match(talonYouTubeGuardLoaderSource, /createElement\('script'\)/);
  assert.doesNotMatch(talonYouTubeGuardLoaderSource, /\bfetch\s*\(|\bXMLHttpRequest\b/);
  assert.match(managerSource, /const TALON_SITE_FIXES_MAIN_ID = 'talon-site-fixes-main';/);
  assert.match(managerSource, /function registerTalonSiteFixesMain\(context\)/);
  assert.match(managerSource, /id: TALON_SITE_FIXES_MAIN_ID,[\s\S]*allFrames: true,[\s\S]*runAt: 'document_start',[\s\S]*world: 'MAIN'/);
  assert.match(backgroundSource, /isFrenchStreamSiteFixHostname\(hostname\) === false/);
  assert.match(backgroundSource, /isEntitled\(\) === false/);
  assert.match(backgroundSource, /executeRuntimeRefreshLane\([\s\S]*\[ FRENCH_STREAM_SITE_FIX_MAIN_PATH \]/);
  assert.match(backgroundSource, /world: 'MAIN'/);
  assert.match(backgroundSource, /repairDnrReconciliation/);
  assert.match(rulesetSource, /TALON_SITE_FIXES_RUNTIME_BASE_RULE_ID = 7000000/);
  assert.match(rulesetSource, /updateTalonSiteFixRuntimeRules/);
  const privateComparatorToken = String.fromCharCode(99, 111, 102, 102, 101, 101);
  assert.doesNotMatch(talonYouTubeGuardSource, new RegExp(`analytics|posthog|${privateComparatorToken}-break`, 'i'));
  assert.doesNotMatch(talonYouTubeGuardLoaderSource, new RegExp(`analytics|posthog|${privateComparatorToken}-break`, 'i'));
  assert.doesNotMatch(managerSource, new RegExp(`${watchPrefix}-bootstrap|registerYouTubeWatchBootstrap|HOST_SCOPED_SCRIPTLET_EXCLUSIONS`));
  assert.doesNotMatch(heuristicSource, new RegExp(`youtube|${'YOUTUBE_' + 'WATCH'}|td_yw`, 'i'));
  assert.doesNotMatch(backgroundSource, new RegExp(`setYouTubeWatch|YouTubeWatch|${watchPrefix}`, 'i'));
  assert.doesNotMatch(rulesetSource, /YOUTUBE_AD_RULES|YouTubeAdSession|updateYouTubeAdSessionRules|youtube\.com/);
  assert.doesNotMatch(
    ownershipSource,
    new RegExp(`${privateComparatorToken} Break|${privateComparatorToken}-break|youtube ${privateComparatorToken} break|C:\\\\dev`, 'i')
  );
});
test('startup reuses persisted registrations without refreshing open tabs on worker wake', async () => {
  const source = await readSource('js/background.js');
  const startBlock = source.slice(
    source.indexOf('async function startNow({ forcePermissionSync = false } = {}) {'),
    source.indexOf('/******************************************************************************/', source.indexOf('async function startNow({ forcePermissionSync = false } = {}) {'))
  );

  assert.equal(
    countMatches(startBlock, /syncInjectablesAndRefreshTabs\(\{ runtimeOnly: false \}\)\.catch\(ubolErr\)/g),
    0
  );
  assert.match(startBlock, /const startSessionRequired = process\.wakeupRun === false[\s\S]*if \( startSessionRequired \) \{[\s\S]*await startSession\(\{/);
  assert.match(startBlock, /startupInjectableResult = await ensureStartupInjectableState\(\);/);
  assert.match(startBlock, /await scheduleStartupInjectableRetry\(\);[\s\S]*throw reason;/);
  assert.doesNotMatch(startBlock, /registerInjectablesIfEntitled\(\)\.catch\(ubolErr\);/);
  assert.doesNotMatch(startBlock, /syncYouTubeWatchControlCookies/);
  assert.doesNotMatch(startBlock, /syncPrivateYouTubeRuntimeLaneRules/);
  assert.doesNotMatch(source, /requestCompatibilityBackoff/);
  assert.doesNotMatch(source, /runtime\.onConnect\.addListener/);
});

test('popup warmup attempts a bounded injectable recovery before reporting startup not ready', async () => {
  const source = await readSource('js/background.js');
  const recoveryStart = source.indexOf('async function recoverStartupStateForPopup()');
  const recoveryEnd = source.indexOf('async function recoverStartupCoreFromPopupWarmup()', recoveryStart);
  const recoverySource = source.slice(recoveryStart, recoveryEnd);

  assert.match(source, /const POPUP_WARMUP_RECOVERY_TIMEOUT_MS = 4000;/);
  assert.match(source, /let popupWarmupRecoveryPromise;/);
  assert.match(source, /async function recoverStartupCoreFromPopupWarmup\(\)/);
  assert.match(
    recoverySource,
    /const recovery = enqueueEntitlementAction\(async \(\) => \{[\s\S]*const result = await start\(\{ forcePermissionSync: true \}\);/
  );
  assert.match(recoverySource, /startupComplete !== true/);
  assert.match(recoverySource, /startupCoreReady !== true/);
  assert.match(recoverySource, /resolveStartupMutationBarrierGeneration\(recoveryGeneration\)/);
  assert.match(source, /if \( injectableSyncReady \) \{\s*startupCoreReady = true;/);
  assert.match(source, /case 'popupWarmup': \{[\s\S]*recoverStartupCoreFromPopupWarmup\(\)/);
  assert.match(source, /callback\(buildPopupWarmupResponse\(\{/);
});

test('first-popup welcome tab open is single-flight guarded', async () => {
  const source = await readSource('js/background.js');
  const openerStart = source.indexOf('async function openFirstPopupWelcomeOnce()');
  const openerEnd = source.indexOf('const runFirstPopupWelcomeOpen', openerStart);
  const handlerStart = source.indexOf("case 'maybeOpenFirstPopupWelcome':");
  const handlerEnd = source.indexOf("case 'gotoURL':", handlerStart);
  const openerSource = source.slice(openerStart, openerEnd);
  const handlerSource = source.slice(handlerStart, handlerEnd);

  assert.match(source, /import \{ createSingleFlightRunner \} from '\.\/single-flight\.js';/);
  assert.match(source, /const runFirstPopupWelcomeOpen = createSingleFlightRunner\(openFirstPopupWelcomeOnce\);/);
  assert.match(handlerSource, /runFirstPopupWelcomeOpen\(\)\.then\(result => \{\s*callback\(result\);/);
  assert.ok(
    openerSource.indexOf('localWrite(FIRST_POPUP_WELCOME_SEEN_KEY') <
      openerSource.indexOf('gotoURL(url)')
  );
});

test('automation host-filters first and only loads ruleset state when a gate is present', async () => {
  const source = await readSource('js/scripting/automation.js');

  assert.match(source, /const hostMatchedDirectives = directives\.filter\(hostMatchesDirective\);/);
  assert.match(source, /const requiresRulesetGate = hostMatchedDirectives\.some\(directive =>/);
  assert.match(source, /const enabledRulesets = requiresRulesetGate\s*\?\s*await loadEnabledRulesets\(\)\s*:\s*null;/);
  assert.match(source, /const nextActiveDirectives = hostMatchedDirectives/);
  assert.match(source, /if \( enabledRulesets instanceof Set === false \) \{ return false; \}/);
  assert.doesNotMatch(source, /NATIONAL_POST_/);
  assert.doesNotMatch(source, /__ubolNationalPostRuntime/);
});

test('automation registration is omitted unless an enabled overlay source can use it', async () => {
  const managerSource = await readSource('js/scripting-manager.js');
  const registrationSource = sourceBetween(
    managerSource,
    'function registerAutomation(context)',
    'function registerYouTubeAdSkip(context)'
  );

  assert.match(registrationSource, /enabledRulesetIds\.has\('annoyances-overlays'\)/);
  assert.match(registrationSource, /getRemoteAutomationRegistrationMatches\(/);
  assert.match(registrationSource, /packagedAutomationActive === false &&[\s\S]*remoteAutomationMatches\.length === 0[\s\S]*return;/);
  assert.match(registrationSource, /const matches = packagedAutomationActive[\s\S]*: remoteAutomationMatches;/);
  assert.doesNotMatch(registrationSource, /remoteAutomationActive/);
  assert.ok(
    registrationSource.indexOf('return;') <
      registrationSource.indexOf("'/js/scripting/automation.js'")
  );
});

test('ad shell prepaint is guarded and excludes broad generic ad-slot selectors', async () => {
  const source = await readSource('js/scripting/ad-shell-styles.js');
  const blockHintsSource = await readSource('js/scripting/block-hints.js');
  const managerSource = await readSource('js/scripting-manager.js');
  const guardSource = await readSource('js/scripting/breakage-guard.js');
  const autoBackoffSource = await readSource('js/auto-backoff.js');
  const adShellRegister = managerSource.slice(
    managerSource.indexOf('function registerAdShellStyles'),
    managerSource.indexOf('function registerRemoteCosmetics')
  );
  const remoteCosmeticsRegister = managerSource.slice(
    managerSource.indexOf('function registerRemoteCosmetics'),
    managerSource.indexOf('function registerPostHideCleanup')
  );
  const postHideRegister = managerSource.slice(
    managerSource.indexOf('function registerPostHideCleanup'),
    managerSource.indexOf('async function registerInjectables')
  );
  const baseSelectorsSource = sourceBetween(
    source,
    'const BASE_SELECTORS = [',
    'const HOST_SCOPED_SELECTORS = Object.freeze(['
  );

  assert.match(source, /const BASE_SELECTORS = \[/);
  assert.match(source, /const HOST_SCOPED_SELECTORS = Object\.freeze\(\[/);
  assert.match(source, /const SUBSYSTEM_ID = 'adShellStyles';/);
  assert.match(source, /const blockHints = self\.TalonBlockHintsController;/);
  assert.match(source, /host: 'foxweather\.com'/);
  assert.equal(
    source.includes("'.pre-content:has(> .ad-container[class*=\"ad-h-\" i][class*=\"ad-w-\" i])'"),
    true
  );
  assert.equal(
    source.includes("'.ad-container[class*=\"ad-h-\" i][class*=\"ad-w-\" i]'"),
    true
  );
  assert.match(source, /host: 'sdin\.jp'/);
  assert.match(source, /'aside \.rec3:has\(> ins\.adsbygoogle\)'/);
  assert.match(source, /'main > #vdo3:has\(> #min > #vdo-fourm\)'/);
  assert.match(source, /host: 'cnn\.com'/);
  assert.match(source, /'\.ad-slot-header__wrapper'/);
  assert.match(
    source,
    /\.header__wrapper-outer:has\(\.ad-slot-header__wrapper\)[\s\S]*min-height:0!important/
  );
  assert.match(source, /const applyPrepaint = \(\) => \{[\s\S]*style\.textContent = STYLE_TEXT;[\s\S]*markMatchedShells\(\);/);
  assert.match(source, /blockHints\.noteElement\(node, \{ ancestors: 1 \}\)/);
  assert.match(source, /const MAX_MARKED_SHELLS = 96;/);
  assert.match(source, /document\.querySelectorAll\?\.\(selectors\.join\(','\)\)/);
  const startSource = sourceBetween(
    source,
    'const start = () => {',
    'if ( document.documentElement ) {'
  );
  assert.match(startSource, /applyPrepaint\(\)/);
  assert.match(startSource, /const readiness = refresh\(\)/);
  assert.ok(
    startSource.indexOf('applyPrepaint()') < startSource.indexOf('refresh()'),
    'document-start CSS must be inserted before asynchronous guard settlement'
  );
  assert.match(startSource, /self\.TalonAdShellStylesReady = readiness/);
  assert.match(source, /if \( document\.documentElement \) \{\s*start\(\);/);
  assert.match(source, /document\.addEventListener\('readystatechange', start, \{ once: true \}\);/);
  assert.ok(source.indexOf('await shouldRun()') < source.indexOf('applyPrepaint()'));
  assert.match(source, /connectProtectionListener\(\);/);
  assert.match(source, /guard\?\.shouldRunSubsystem\?\.\(SUBSYSTEM_ID\) !== false/);
  assert.match(source, /ownedStyle\?\.remove\(\);/);
  assert.match(source, /style\.setAttribute\(STYLE_MARKER_ATTR, '1'\);/);
  assert.match(source, /style\.textContent = STYLE_TEXT;/);
  assert.match(adShellRegister, /'\/js\/scripting\/breakage-guard\.js',\s*TALON_BLOCK_HINTS_PATH,\s*'\/js\/scripting\/ad-shell-styles\.js'/);
  assert.match(adShellRegister, /pushExactExcludeMatches\([\s\S]*subsystemSuppressionHostnames\?\.adShellStyles/);
  assert.doesNotMatch(remoteCosmeticsRegister, /subsystemSuppressionHostnames\?\.adShellStyles/);
  assert.match(postHideRegister, /id: 'post-hide-cleanup'[\s\S]*runAt: 'document_start'/);
  assert.match(blockHintsSource, /const HINTS_CHANGED_EVENT = 'talon-block-hints-changed';/);
  assert.match(blockHintsSource, /const getRecentElements = \( \) => \{/);
  assert.match(blockHintsSource, /notifyHintsChanged\(count\);/);
  assert.match(guardSource, /'adShellStyles'/);
  assert.match(autoBackoffSource, /'adShellStyles'/);
  assert.doesNotMatch(baseSelectorsSource, /\[data-ad/);
  assert.doesNotMatch(baseSelectorsSource, /ad-slot/);
  assert.doesNotMatch(source, /NATIONAL_POST_/);
  assert.doesNotMatch(source, /__ubolNationalPostRuntime/);
  assert.doesNotMatch(source, /MutationObserver/);
});

test('native heuristic label regexes match international sponsored labels', async () => {
  const config = JSON.parse(await readSource('automation/native-heuristics.json'));
  const regexes = config.labelRegexes.map(pattern => new RegExp(pattern, 'i'));
  const matches = value => regexes.some(re => re.test(value));

  for (const sample of [
    'Sponsored',
    '\u0440\u0435\u043a\u043b\u0430\u043c\u0430',
    '\u5e83\u544a',
    '\u5e7f\u544a',
    '\uad11\uace0',
    'patrocinado',
    'publicit\u00e9',
    'werbung',
    'pubblicit\u00e0',
    'an\u00fancio',
    'advertentie',
    'og\u0142oszenie',
    '\u0625\u0639\u0644\u0627\u0646',
  ]) {
    assert.equal(matches(sample), true, `${sample} should match a native ad label`);
  }
});

test('shadow root helper tracks additions and removals incrementally and reserves full rescans for load events', async () => {
  const source = await readSource('js/scripting/shadow-dom-helper.js');

  assert.match(source, /let pendingAddedNodes = \[\];/);
  assert.match(source, /let pendingFullRescan = false;/);
  assert.match(source, /const continueBudgetedAddedScan = deadline => \{/);
  assert.match(source, /const startBudgetedAddedScan = roots => \{/);
  assert.match(source, /const flushPendingRescan = \(\) => \{/);
  assert.match(source, /if \( pendingFullRescan \) \{[\s\S]*pendingFullRescan = false;\s*startBudgetedFullScan\(\);/);
  assert.match(source, /const FULL_SCAN_TIME_SLICE_MS = 4;/);
  assert.match(source, /const FULL_SCAN_NODE_SLICE = 256;/);
  assert.match(source, /const resumeBudgetedScan = \(\) => \{/);
  assert.match(source, /if \( resumeBudgetedScan\(\) \) \{ return; \}/);
  assert.match(source, /startBudgetedAddedScan\(addedNodes\)/);
  assert.doesNotMatch(source, /scanAddedNodeTree/);
  assert.match(source, /queuePendingMutationNode\(pendingRemovedNodes, node\)/);
  assert.match(source, /const pruneRemovedRoots = removedNodes => \{/);
  assert.match(source, /queuePendingMutationNode\(pendingAddedNodes, node\)/);
});

test('runtime mutation queues enforce hard backpressure limits', async () => {
  const nativeSource = await readSource('js/scripting/native-heuristics.js');
  const postHideSource = await readSource('js/scripting/post-hide-cleanup.js');
  const shadowSource = await readSource('js/scripting/shadow-dom-helper.js');
  const blockHintsSource = await readSource('js/scripting/block-hints.js');
  const automationSource = await readSource('js/scripting/automation.js');

  assert.match(nativeSource, /const MAX_PENDING_LABELS = 512;/);
  assert.match(nativeSource, /pendingLabelOverflowed = true;/);
  assert.match(nativeSource, /const schedulePendingLabelRecovery = \(\) => \{/);
  assert.match(nativeSource, /const MAX_CANDIDATE_SCAN_JOBS = 256;/);
  assert.match(nativeSource, /candidateScanOverflowed = true;/);
  assert.match(postHideSource, /const MAX_PENDING_CANDIDATES = 512;/);
  assert.match(postHideSource, /pendingOverflowed = true;/);
  assert.match(postHideSource, /const schedulePendingRecovery = \( \) => \{/);
  assert.match(postHideSource, /const MAX_COLLECTION_SCAN_JOBS = 256;/);
  assert.match(postHideSource, /const MAX_COLLECTION_SCAN_NODES_PER_SLICE = 128;/);
  assert.match(postHideSource, /pendingHasCapacity\(\) === false/);
  assert.doesNotMatch(postHideSource, /querySelectorAll\(collectionSelectorText\)/);
  assert.match(shadowSource, /const MAX_PENDING_MUTATION_NODES = 512;/);
  assert.match(shadowSource, /pendingFullRescan = true;/);
  assert.match(shadowSource, /const MAX_CONTENT_EVENT_NODES = 128;/);
  assert.match(shadowSource, /overflowed: overflowed === true/);
  assert.match(nativeSource, /event\?\.detail\?\.overflowed === true[\s\S]*collectKnownShadowRootCandidates\(undefined, true\)/);
  assert.match(postHideSource, /event\?\.detail\?\.overflowed === true[\s\S]*collectKnownShadowRoots\(undefined, true\)/);
  assert.match(automationSource, /event\?\.detail\?\.overflowed === true[\s\S]*wakeAllMissedDirectives\(\)/);
  assert.match(blockHintsSource, /const MAX_TRACKED_ELEMENTS = 96;/);
  assert.match(blockHintsSource, /const MAX_HINT_SELECTORS = 128;/);
  assert.match(blockHintsSource, /root\.querySelectorAll\?\.\(selectorText\)/);
  assert.doesNotMatch(blockHintsSource, /root\.querySelectorAll\?\.\(selector\)/);
  assert.match(blockHintsSource, /if \( el\.contains\(hinted\) \) \{ return true; \}/);
  assert.doesNotMatch(blockHintsSource, /querySelector\?\.\(`\[\$\{HINT_ATTR\}\]`\)/);
});

test('breakage classification and automation mutation routing avoid repeated full subtree work', async () => {
  const breakageSource = await readSource('js/scripting/breakage-guard.js');
  const automationSource = await readSource('js/scripting/automation.js');

  assert.match(breakageSource, /const MAX_PRIMARY_SCAN_NODES = 512;/);
  assert.match(breakageSource, /document\.createTreeWalker\(el, 1 \| 4\)/);
  assert.match(breakageSource, /return signals\.overflowed \|\| primarySignalsAreStrong\(signals\);/);
  assert.doesNotMatch(breakageSource, /el\.querySelectorAll\('p'\)/);
  assert.doesNotMatch(breakageSource, /const text = el\.textContent/);

  assert.match(automationSource, /const MUTATION_ROUTE_DELAY_MS = 50;/);
  assert.match(automationSource, /const scheduleMutationRouting = \( \) => \{/);
  assert.match(automationSource, /node\.querySelector\?\.\(selectors\.join\(','\)\)/);
  assert.doesNotMatch(automationSource, /node\.matches\?\.\(selector\) \|\| node\.querySelector\?\.\(selector\)/);
});

test('remote cosmetics runtime stats are deduped by scope before messaging background', async () => {
  const source = await readSource('js/scripting/remote-cosmetics.js');
  const backgroundSource = await readSource('js/background.js');

  assert.match(source, /const runtimeStatsByScope = new Map\(\);/);
  assert.match(source, /const previous = runtimeStatsByScope\.get\(scope\);/);
  assert.match(source, /previous\?\.chunkCount === nextStats\.chunkCount/);
  assert.match(source, /runtimeStatsByScope\.set\(scope, nextStats\);/);
  assert.match(source, /runtimeStatsByScope\.delete\(scope\);/);
  assert.match(backgroundSource, /case 'recordRemoteCosmeticsRuntimeStats':/);
  assert.match(backgroundSource, /reportedHostname !== senderHostname/);
  assert.match(backgroundSource, /REMOTE_COSMETICS_RUNTIME_STATS_REFRESH_MS/);
  assert.match(backgroundSource, /enqueueRemoteCosmeticsRuntimeStatsMutation/);
  assert.match(backgroundSource, /previousScope\?\.chunkCount === nextScope\.chunkCount/);
  assert.match(backgroundSource, /recordRemoteCosmeticsRuntimeStats\(\{[\s\S]*hostname: senderHostname/);
});

test('live refresh preserves top-frame controller scope and frame-level remote cosmetics modes', async () => {
  const source = await readSource('js/background.js');
  const topStart = source.indexOf('const TOP_FRAME_LIVE_RUNTIME_REFRESH_FILES');
  const topEnd = source.indexOf('const REMOTE_COSMETICS_GLOBAL_LIVE_RUNTIME_REFRESH_FILES');
  const topLane = source.slice(topStart, topEnd);

  assert.match(topLane, /native-heuristics\.js/);
  assert.match(topLane, /automation\.js/);
  assert.match(topLane, /post-hide-cleanup\.js/);
  assert.match(topLane, /ad-shell-styles\.js/);
  assert.doesNotMatch(topLane, /remote-cosmetics/);
  assert.match(source, /const BASIC_TOP_FRAME_LIVE_RUNTIME_REFRESH_FILES/);
  assert.match(source, /filteringLevel === MODE_BASIC/);
  assert.match(source, /TalonAdShellStylesController/);
  assert.match(source, /if \( filteringLevel === MODE_NONE \) \{[\s\S]*stopIsolatedRuntimeControllers/);
  assert.match(source, /async function getRuntimeFrameStates\(tabId, fallbackUrl = ''\)/);
  assert.match(source, /parentFrameId: Number\.isInteger\(frame\?\.parentFrameId\)/);
  assert.match(source, /about:\(\?:blank\|srcdoc\)/);
  assert.match(source, /hostname = resolveFrameHostname\(parentFrameId, seen\)/);
  assert.match(source, /frame\.filteringLevel >= MODE_OPTIMAL/);
  assert.match(source, /REMOTE_COSMETICS_GLOBAL_LIVE_RUNTIME_REFRESH_FILES,[\s\S]*frameTargets: frameTargetsFromIds\(remoteEligibleFrameIds\),[\s\S]*readinessGlobals: \[ 'TalonRemoteCosmeticsGlobalReady' \]/);
  assert.match(source, /REMOTE_COSMETICS_HOST_LIVE_RUNTIME_REFRESH_FILES,[\s\S]*frameTargets: frameTargetsFromIds\(hostFrameIds\),[\s\S]*readinessGlobals: \[ 'TalonRemoteCosmeticsHostReady' \]/);
  assert.doesNotMatch(source, /REMOTE_COSMETICS_(?:GLOBAL|HOST)_LIVE_RUNTIME_REFRESH_FILES,[\s\S]{0,120}\{ allFrames: true \}/);
  assert.match(source, /function awaitNamedRuntimeReadiness\(globalNames\)/);
  assert.match(source, /throw new Error\(`runtime readiness unavailable: \$\{globalName\}`\)/);
  assert.match(source, /topFrameLiveRuntimeReadinessGlobals\(topFrameFiles\)/);
  assert.match(source, /names\.push\('TalonNativeHeuristicsReady'\)/);
  assert.match(source, /names\.push\('TalonAutomationReady'\)/);
  assert.match(source, /const maxReadinessTransitions = 8;/);
  assert.match(source, /if \( globalThis\[globalName\] === readiness \) \{ return true; \}/);
  assertOrderedIncludes(source, [
    'const preparedByFrameId = new Map();',
    ': await prepareCustomFilterDetails(frame.hostname);',
    "[ '/js/scripting/css-user-terminate.js' ]",
    'details = await injectCustomFilters(',
    'stagePreparedCustomFilterDetails,',
    "'/js/scripting/css-api.js',",
    "'/js/scripting/css-user.js',",
  ], 'custom-filter live refresh');
  assert.match(source, /const CORE_COSMETIC_TERMINATOR_PATH = '.*css-core-terminate\.js';/);
  assert.match(source, /async function getRegisteredCoreCosmeticDirectives\(\)/);
  assert.match(source, /refreshCoreCosmetics && allFrameIds\.length !== 0/);
  assert.match(source, /CORE_COSMETIC_TERMINATOR_PATH[\s\S]*for \( const directive of coreCosmeticDirectives \)/);
  assert.match(source, /runtimeFingerprint !== lastInjectableRuntimeFingerprint[\s\S]*refreshCoreCosmetics:/);
  assert.match(source, /runtimeRefreshSucceeded[\s\S]*persistInjectableRuntimeState\(runtimeFingerprint\)/);
  assert.match(source, /const documentIds = targets\.map\(target => target\.documentId\)/);
  assert.match(source, /RUNTIME_SCRIPT_DOCUMENT_BATCH_SIZE = 8/);
  assert.match(source, /isRuntimeRefreshTargetUnavailableError\(reason\) === false/);
  assert.match(source, /if \( isRuntimeRefreshTargetUnavailableError\(reason\) \) \{ return true; \}/);
  assert.match(source, /\[ '\/js\/scripting\/css-runtime-terminate\.js' \],[\s\S]*\{ frameTargets \}/);
});

test('runtime readiness follows a replacement promise before committing success', async () => {
  const source = await readSource('js/background.js');
  const readinessSource = sourceBetween(
    source,
    'async function awaitNamedRuntimeReadiness',
    'async function executeRuntimeRefreshLane'
  );
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    `${readinessSource}\n` +
      'globalThis.runReadinessTest = awaitNamedRuntimeReadiness;',
    context
  );

  let resolveFirst;
  const first = new Promise(resolve => { resolveFirst = resolve; });
  const replacement = Promise.reject(new Error('replacement refresh failed'));
  replacement.catch(() => {});
  context.TalonAutomationReady = first;
  const waiting = context.runReadinessTest(['TalonAutomationReady']);
  context.TalonAutomationReady = replacement;
  resolveFirst({ applied: false, stale: true });

  await assert.rejects(waiting, /replacement refresh failed/);
});

test('live refresh continues after exact Chromium child-frame disappearance errors', async () => {
  const source = await readSource('js/background.js');
  const classifierSource = sourceBetween(
    source,
    'const RUNTIME_REFRESH_TARGET_UNAVAILABLE_PATTERNS',
    'async function getRuntimeFrameStates'
  );
  const executePerFrameSource = sourceBetween(
    source,
    'const runtimeTargetBatches',
    'async function awaitNamedRuntimeReadiness'
  );
  const buildHarness = new Function(
    'browser',
    'OPEN_TAB_RUNTIME_REFRESH_CONCURRENCY',
    'RUNTIME_SCRIPT_DOCUMENT_BATCH_SIZE',
    'const executeRuntimeScriptWithTimeout = details => ' +
      'browser.scripting.executeScript(details);\n' +
      `${classifierSource}\n${executePerFrameSource}\n` +
      'return { isRuntimeRefreshTargetUnavailableError, executeScriptPerRuntimeFrame };'
  );
  const attempts = [];
  let failures = new Map([
    [2, new Error('Frame with ID 2 was removed.')],
  ]);
  const browser = {
    scripting: {
      async executeScript(details) {
        const frameId = details?.target?.frameIds?.[0];
        attempts.push(frameId);
        const failure = failures.get(frameId);
        if (failure) { throw failure; }
        return [];
      },
    },
  };
  const harness = buildHarness(browser, 4, 8);

  for (const message of [
    'No tab with id: 7.',
    'No frame with ID: 2',
    'No frame with id 2 in tab with id 7.',
    'Frame with ID 2 was removed.',
    'Tab containing frame with ID 2 was removed.',
    'Frame with ID 2 is not ready',
    'Frame with ID 2 is showing error page',
  ]) {
    assert.equal(
      harness.isRuntimeRefreshTargetUnavailableError(new Error(message)),
      true,
      message
    );
  }
  for (const message of [
    'Permission denied',
    'Cannot access contents of the page.',
    'Could not establish connection. Receiving end does not exist.',
    'Frame with ID two was removed.',
  ]) {
    assert.equal(
      harness.isRuntimeRefreshTargetUnavailableError(new Error(message)),
      false,
      message
    );
  }

  assert.equal(
    await harness.executeScriptPerRuntimeFrame(7, [0, 2, 4], {
      files: ['/js/scripting/example.js'],
    }),
    true
  );
  assert.deepEqual(attempts.slice().sort((a, b) => a - b), [0, 2, 4]);

  attempts.length = 0;
  failures = new Map([[2, new Error('Permission denied')]]);
  await assert.rejects(
    harness.executeScriptPerRuntimeFrame(7, [0, 2, 4], {
      files: ['/js/scripting/example.js'],
    }),
    /Permission denied/
  );
  assert.deepEqual(attempts.slice().sort((a, b) => a - b), [0, 2, 4]);
});

test('document-bound refresh cannot fall through to a reused frame ID after navigation', async () => {
  const source = await readSource('js/background.js');
  const classifierSource = sourceBetween(
    source,
    'const RUNTIME_REFRESH_TARGET_UNAVAILABLE_PATTERNS',
    'async function getRuntimeFrameStates'
  );
  const executePerFrameSource = sourceBetween(
    source,
    'const runtimeTargetBatches',
    'async function awaitNamedRuntimeReadiness'
  );
  const buildHarness = new Function(
    'browser',
    'OPEN_TAB_RUNTIME_REFRESH_CONCURRENCY',
    'RUNTIME_SCRIPT_DOCUMENT_BATCH_SIZE',
    'const executeRuntimeScriptWithTimeout = details => ' +
      'browser.scripting.executeScript(details);\n' +
      `${classifierSource}\n${executePerFrameSource}\n` +
      'return { executeScriptPerRuntimeFrame };'
  );
  const oldDocumentId = '11111111-1111-1111-1111-111111111111';
  const newDocumentId = '22222222-2222-2222-2222-222222222222';
  const attempts = [];
  const browser = {
    scripting: {
      async executeScript(details) {
        attempts.push(details.target);
        if (details.target.documentIds?.[0] === oldDocumentId) {
          throw new Error(`Document with ID ${oldDocumentId} was removed.`);
        }
        return [];
      },
    },
  };
  const harness = buildHarness(browser, 4, 8);

  assert.equal(await harness.executeScriptPerRuntimeFrame(7, [
    { frameId: 3, documentId: oldDocumentId },
    { frameId: 3, documentId: newDocumentId },
  ], { files: ['/js/scripting/example.js'] }), true);
  assert.equal(attempts.length, 3);
  assert.equal(attempts.every(target => target.tabId === 7), true);
  assert.equal(attempts.every(target => target.frameIds === undefined), true);
  assert.deepEqual(
    Array.from(new Set(attempts.flatMap(target => target.documentIds))).sort(),
    [newDocumentId, oldDocumentId].sort()
  );
});

test('live refresh derives mode, hostname, and custom filters from one active document snapshot', async () => {
  const backgroundSource = await readSource('js/background.js');
  const filterManagerSource = await readSource('js/filter-manager.js');
  const frameStateSource = sourceBetween(
    backgroundSource,
    'async function getRuntimeFrameStates',
    'const hostnameMatchesRegistrationPatterns'
  );
  const refreshSource = sourceBetween(
    backgroundSource,
    'async function refreshRuntimeStateForTab',
    'async function refreshRuntimeStateForOpenTabsNow'
  );

  assert.match(frameStateSource, /documentId: typeof frame\?\.documentId === 'string'/);
  assert.match(
    frameStateSource,
    /frame\.documentLifecycle === '' \|\| frame\.documentLifecycle === 'active'/
  );
  assertOrderedIncludes(refreshSource, [
    'const frameStates = await getRuntimeFrameStates(tabId, url);',
    "if ( frameStates.some(frame => frame.documentId === '') )",
    'const topFrameState = frameStates.find(frame => frame.frameId === 0);',
    'hostname = topFrameState.hostname;',
    'filteringLevel = topFrameState.filteringLevel;',
    'url = topFrameState.url;',
    '{ frameId: frame.frameId, documentId: frame.documentId }',
    ': await prepareCustomFilterDetails(frame.hostname);',
    'documentId: frame.documentId,',
    'prepared.documentId',
  ], 'document snapshot refresh');
  assert.match(
    filterManagerSource,
    /const contentScriptTarget = \(tabId, frameId, documentId\) =>[\s\S]*\{ tabId, documentIds: \[ documentId \] \}/
  );
  assert.equal(
    countMatches(
      filterManagerSource,
      /target: contentScriptTarget\(tabId, frameId, documentId\)/g
    ),
    3
  );
  assert.match(
    backgroundSource,
    /const documentId = typeof sender\?\.documentId === 'string'[\s\S]*\? sender\.documentId/
  );
  assert.match(backgroundSource, /startCustomFilters\(\s*tabId,\s*frameId,\s*documentId,/);
  assert.match(backgroundSource, /terminateCustomFilters\(\s*tabId,\s*frameId,\s*documentId,/);
  assert.match(
    backgroundSource,
    /case 'injectCSSProceduralAPI':[\s\S]*documentIds: \[ documentId \]/
  );
});

test('tab closure during getAllFrames counts as a successful open-tab refresh pass', async () => {
  const source = await readSource('js/background.js');
  const classifierSource = sourceBetween(
    source,
    'const RUNTIME_REFRESH_TARGET_UNAVAILABLE_PATTERNS',
    'async function getRuntimeFrameStates'
  );
  const frameStateSource = sourceBetween(
    source,
    'async function getRuntimeFrameStates',
    'const hostnameMatchesRegistrationPatterns'
  );
  const refreshTabSource = sourceBetween(
    source,
    'async function refreshRuntimeStateForTab',
    'async function recoverRuntimeTabFailure'
  );
  const recoverySource = sourceBetween(
    source,
    'async function recoverRuntimeTabFailure',
    'async function refreshRuntimeStateForOpenTabsNow'
  );
  const refreshOpenTabsSource = sourceBetween(
    source,
    'async function refreshRuntimeStateForOpenTabsNow',
    'let openTabRuntimeRefreshPromise'
  );
  const buildHarness = new Function('deps', `
    const {
      browser,
      clearDeferredRuntimeDocuments,
      collectStoredRemoteCosmeticHostnames,
      deferRuntimeDocuments,
      deferredRuntimeDocuments,
      ensureDeferredRuntimeDocumentsHydrated,
      FRENCH_STREAM_SITE_FIX_HOSTNAME,
      getActiveTopDocumentIdentity,
      getFilteringMode,
      getReportedEnabledRulesets,
      isIgnorableRuntimeError,
      MODE_NONE,
      normalizeHttpHostname,
      OPEN_TAB_RUNTIME_REFRESH_CONCURRENCY,
      readLocalStrict,
      REMOTE_COSMETICS_STORAGE_KEY,
      scheduleDeferredRuntimeRetry,
      storedRemoteCosmeticsHaveGlobalSelectors,
      ubolErr,
    } = deps;
    const getRuntimeTabLifecycleGeneration = () => 1;
    const runtimeTabLifecycleMatches = () => true;
    ${classifierSource}
    ${frameStateSource}
    ${refreshTabSource}
    ${recoverySource}
    ${refreshOpenTabsSource}
    return { refreshRuntimeStateForOpenTabsNow };
  `);
  let getAllFramesFailure = new Error('No tab with id: 77.');
  const logged = [];
  const browser = {
    scripting: {
      async executeScript() { return []; },
    },
    tabs: {
      async query() {
        return [{ id: 77, active: true, url: 'https://example.com/' }];
      },
      async get() {
        throw getAllFramesFailure;
      },
    },
    webNavigation: {
      async getAllFrames() { throw getAllFramesFailure; },
    },
  };
  const harness = buildHarness({
    browser,
    clearDeferredRuntimeDocuments: async () => false,
    collectStoredRemoteCosmeticHostnames: () => new Set(),
    deferRuntimeDocuments: async () => true,
    deferredRuntimeDocuments: new Map(),
    ensureDeferredRuntimeDocumentsHydrated: async () => true,
    FRENCH_STREAM_SITE_FIX_HOSTNAME: 'french-stream.one',
    getActiveTopDocumentIdentity: async () => null,
    getFilteringMode: async () => 2,
    getReportedEnabledRulesets: async () => [],
    isIgnorableRuntimeError: () => false,
    MODE_NONE: 0,
    normalizeHttpHostname(value) {
      try { return new URL(value).hostname; } catch { return ''; }
    },
    OPEN_TAB_RUNTIME_REFRESH_CONCURRENCY: 4,
    readLocalStrict: async () => ({}),
    REMOTE_COSMETICS_STORAGE_KEY: 'remoteCosmetics',
    scheduleDeferredRuntimeRetry: async () => true,
    storedRemoteCosmeticsHaveGlobalSelectors: () => false,
    ubolErr: reason => logged.push(String(reason)),
  });

  assert.equal(await harness.refreshRuntimeStateForOpenTabsNow(), true);
  assert.deepEqual(logged, []);

  getAllFramesFailure = new Error('Permission denied');
  assert.equal(await harness.refreshRuntimeStateForOpenTabsNow(), false);
  assert.equal(logged.some(entry =>
    entry.includes('runtime refresh freeze reconciliation failed')
  ), true);
});

test('frozen tabs persist document-bound refresh intent without retrying healthy tabs', async () => {
  const source = await readSource('js/background.js');
  const refreshOpenTabsSource = sourceBetween(
    source,
    'async function refreshRuntimeStateForOpenTabsNow',
    'let openTabRuntimeRefreshPromise'
  );
  const buildHarness = new Function('deps', `
    const {
      browser,
      clearDeferredRuntimeDocuments,
      collectStoredRemoteCosmeticHostnames,
      deferRuntimeDocuments,
      deferredRuntimeDocuments,
      ensureDeferredRuntimeDocumentsHydrated,
      getActiveTopDocumentIdentity,
      getFilteringMode,
      getRegisteredCoreCosmeticDirectives,
      getReportedEnabledRulesets,
      isIgnorableRuntimeError,
      isRuntimeRefreshTargetUnavailableError,
      MODE_NONE,
      normalizeHttpHostname,
      OPEN_TAB_RUNTIME_REFRESH_CONCURRENCY,
      readLocalStrict,
      refreshCalls,
      REMOTE_COSMETICS_STORAGE_KEY,
      storedRemoteCosmeticsHaveGlobalSelectors,
      tabUrlMayHostExtensionRuntime,
      ubolErr,
    } = deps;
    const getRuntimeTabLifecycleGeneration = () => 1;
    const runtimeTabLifecycleMatches = () => true;
    const refreshRuntimeStateForTab = async (...args) => {
      refreshCalls.push(args);
      return true;
    };
    ${refreshOpenTabsSource}
    return {
      refreshRuntimeStateForOpenTabsNow,
    };
  `);
  const refreshCalls = [];
  const deferredEntries = [];
  const logged = [];
  const harness = buildHarness({
    browser: {
      tabs: {
        async query() {
          return [
            {
              id: 71,
              active: false,
              discarded: false,
              frozen: true,
              url: testHttpsUrl('frozen.example'),
            },
            {
              id: 72,
              active: false,
              discarded: true,
              frozen: true,
              url: testHttpsUrl('discarded.example'),
            },
            {
              id: 73,
              active: false,
              discarded: false,
              frozen: true,
              url: 'chrome://settings/',
            },
            {
              id: 74,
              active: true,
              discarded: false,
              frozen: false,
              url: testHttpsUrl('healthy.example'),
            },
          ];
        },
      },
    },
    collectStoredRemoteCosmeticHostnames: () => new Set(),
    clearDeferredRuntimeDocuments: async () => false,
    deferRuntimeDocuments: async entries => {
      deferredEntries.push(...entries);
      return true;
    },
    deferredRuntimeDocuments: new Map(),
    ensureDeferredRuntimeDocumentsHydrated: async () => true,
    getActiveTopDocumentIdentity: async tabId => ({
      tabId,
      documentId: `document-${tabId}`,
      url: testHttpsUrl('frozen.example'),
    }),
    getFilteringMode: async () => 2,
    getRegisteredCoreCosmeticDirectives: async () => [],
    getReportedEnabledRulesets: async () => [],
    isIgnorableRuntimeError: () => false,
    isRuntimeRefreshTargetUnavailableError: () => false,
    MODE_NONE: 0,
    normalizeHttpHostname(value) {
      try {
        const url = new URL(value);
        return /^https?:$/.test(url.protocol) ? url.hostname : '';
      } catch {
        return '';
      }
    },
    OPEN_TAB_RUNTIME_REFRESH_CONCURRENCY: 4,
    readLocalStrict: async () => ({}),
    refreshCalls,
    REMOTE_COSMETICS_STORAGE_KEY: 'remoteCosmetics',
    storedRemoteCosmeticsHaveGlobalSelectors: () => false,
    tabUrlMayHostExtensionRuntime: value => /^https?:/.test(value),
    ubolErr: reason => logged.push(String(reason)),
  });

  assert.equal(await harness.refreshRuntimeStateForOpenTabsNow({
    desiredFingerprint: 'runtime-fingerprint-v2',
  }), true);
  assert.deepEqual(deferredEntries, [{
    tabId: 71,
    topDocumentId: 'document-71',
    operation: 'refresh',
    desiredFingerprint: 'runtime-fingerprint-v2',
    expectedTabGeneration: 1,
    waitForUnfreeze: true,
    incrementFailure: false,
  }]);
  assert.equal(refreshCalls.length, 1);
  assert.equal(refreshCalls[0][0], 74);
  assert.deepEqual(logged, []);
});

test('open-tab refresh hands off work queued in the settlement window', async () => {
  const source = await readSource('js/background.js');
  const coalescerSource = sourceBetween(
    source,
    'let openTabRuntimeRefreshPromise',
    'const resumedTabRuntimeTails'
  );
  const calls = [];
  let resolveFirst;
  let markFirstStarted;
  const firstStarted = new Promise(resolve => { markFirstStarted = resolve; });
  const firstGate = new Promise(resolve => { resolveFirst = resolve; });
  const buildHarness = new Function('refreshRuntimeStateForOpenTabsNow', `
    const lifecycleRuntimeRefreshSuspendedForPaywall = false;
    const SUSPENDED_OPEN_TAB_RUNTIME_REFRESH_STORAGE_KEY = 'pending-refresh';
    let suspendedOpenTabRuntimeRefreshRequest;
    let suspendedOpenTabRuntimeRefreshRevision = 0;
    let suspendedOpenTabRuntimeRefreshHydrationPromise;
    let suspendedOpenTabRuntimeRefreshPersistenceTail = Promise.resolve();
    const readLocalStrict = async () => undefined;
    const localWrite = async () => true;
    const localRemove = async () => true;
    const ubolErr = () => {};
    ${coalescerSource}
    return { refreshRuntimeStateForOpenTabs };
  `);
  const harness = buildHarness(options => {
    calls.push(structuredClone(options));
    if ( calls.length === 1 ) { markFirstStarted(); }
    return calls.length === 1 ? firstGate : Promise.resolve(true);
  });

  const first = harness.refreshRuntimeStateForOpenTabs({
    desiredFingerprint: 'fingerprint-A',
  });
  await firstStarted;
  const settlementWindowCall = firstGate.then(() =>
    harness.refreshRuntimeStateForOpenTabs({
      refreshCoreCosmetics: true,
      desiredFingerprint: 'fingerprint-B',
    })
  );
  resolveFirst(true);

  assert.equal(await first, true);
  assert.equal(await settlementWindowCall, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].refreshCustomFilters, false);
  assert.equal(calls[0].refreshCoreCosmetics, false);
  assert.equal(calls[0].desiredFingerprint, 'fingerprint-A');
  assert.equal(calls[1].refreshCustomFilters, false);
  assert.equal(calls[1].refreshCoreCosmetics, true);
  assert.equal(calls[1].desiredFingerprint, 'fingerprint-B');
  assert.ok(calls[1].revision > calls[0].revision);
});

test('a weaker trailing refresh retains a failed core requirement before acknowledgment', async () => {
  const source = await readSource('js/background.js');
  const coalescerSource = sourceBetween(
    source,
    'let openTabRuntimeRefreshPromise',
    'const resumedTabRuntimeTails'
  );
  const calls = [];
  let rejectFirst;
  let markFirstStarted;
  const firstStarted = new Promise(resolve => { markFirstStarted = resolve; });
  const firstGate = new Promise((resolve, reject) => { rejectFirst = reject; });
  const buildHarness = new Function('refreshRuntimeStateForOpenTabsNow', `
    const lifecycleRuntimeRefreshSuspendedForPaywall = false;
    const SUSPENDED_OPEN_TAB_RUNTIME_REFRESH_STORAGE_KEY = 'pending-refresh';
    let suspendedOpenTabRuntimeRefreshRequest;
    let suspendedOpenTabRuntimeRefreshRevision = 0;
    let suspendedOpenTabRuntimeRefreshHydrationPromise;
    let suspendedOpenTabRuntimeRefreshPersistenceTail = Promise.resolve();
    const readLocalStrict = async () => undefined;
    const localWrite = async () => true;
    const localRemove = async () => true;
    const ubolErr = () => {};
    ${coalescerSource}
    return { refreshRuntimeStateForOpenTabs };
  `);
  const harness = buildHarness(options => {
    calls.push(structuredClone(options));
    if ( calls.length === 1 ) { markFirstStarted(); }
    return calls.length === 1 ? firstGate : Promise.resolve(true);
  });

  const first = harness.refreshRuntimeStateForOpenTabs({
    refreshCoreCosmetics: true,
    desiredFingerprint: 'fingerprint-core-A',
  });
  const trailing = firstGate.catch(() =>
    harness.refreshRuntimeStateForOpenTabs({
      desiredFingerprint: 'fingerprint-B',
    })
  );
  await firstStarted;
  rejectFirst(new Error('core directive read failed'));

  assert.equal(await first, true);
  assert.equal(await trailing, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].refreshCoreCosmetics, true);
  assert.equal(calls[1].desiredFingerprint, 'fingerprint-B');
});

test('runtime script execution is bounded and late settlement triggers document repair', async () => {
  const source = await readSource('js/background.js');
  const timeoutSource = sourceBetween(
    source,
    'function raceWithTimeout',
    'function trackPaywallMutation'
  );
  const buildHarness = new Function('deps', `
    const {
      browser,
      pendingRuntimeScriptOperations,
      pendingTimedOutRuntimeScripts,
      RUNTIME_SCRIPT_EXECUTION_TIMEOUT_MS,
      RUNTIME_SCRIPT_TIMEOUT_PREFIX,
      runtimeRefreshErrorMessage,
      scheduleDeferredRuntimeRetry,
      self,
      ubolErr,
    } = deps;
    ${timeoutSource}
    return { executeRuntimeScriptWithTimeout, pendingTimedOutRuntimeScripts };
  `);
  let resolveLate;
  let calls = 0;
  let repairSchedules = 0;
  const harness = buildHarness({
    browser: {
      scripting: {
        executeScript() {
          calls += 1;
          if (calls === 1) {
            return new Promise(resolve => { resolveLate = resolve; });
          }
          return Promise.resolve([{ result: true }]);
        },
      },
    },
    pendingRuntimeScriptOperations: new Set(),
    pendingTimedOutRuntimeScripts: new Map(),
    RUNTIME_SCRIPT_EXECUTION_TIMEOUT_MS: 5,
    RUNTIME_SCRIPT_TIMEOUT_PREFIX: 'runtime script timeout',
    runtimeRefreshErrorMessage: reason => reason?.message || String(reason || ''),
    scheduleDeferredRuntimeRetry: async () => { repairSchedules += 1; },
    self: globalThis,
    ubolErr: reason => assert.fail(`unexpected late settlement error: ${reason}`),
  });
  const details = {
    func: () => true,
    target: { tabId: 7, documentIds: ['document-timeout'] },
  };

  await assert.rejects(
    harness.executeRuntimeScriptWithTimeout(details),
    /runtime script timeout/
  );
  assert.equal(harness.pendingTimedOutRuntimeScripts.size, 1);
  await assert.rejects(
    harness.executeRuntimeScriptWithTimeout(details),
    /prior target execution is still pending/
  );
  assert.equal(calls, 1);

  resolveLate([{ result: true }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.pendingTimedOutRuntimeScripts.size, 0);
  assert.equal(repairSchedules, 1);
  assert.deepEqual(
    await harness.executeRuntimeScriptWithTimeout(details),
    [{ result: true }]
  );
  assert.equal(calls, 2);
});

test('a tab freezing during refresh is persisted for document-bound recovery', async () => {
  const source = await readSource('js/background.js');
  const refreshTabSource = sourceBetween(
    source,
    'async function refreshRuntimeStateForTab',
    'async function recoverRuntimeTabFailure'
  );
  const recoverySource = sourceBetween(
    source,
    'async function recoverRuntimeTabFailure',
    'async function refreshRuntimeStateForOpenTabsNow'
  );
  assert.match(
    refreshTabSource,
    /catch \(reason\) \{\s*throw reason;\s*\}/
  );

  const buildHarness = new Function('deps', `
    const {
      browser,
      deferRuntimeDocuments,
      deferredRuntimeDocuments,
      ensureDeferredRuntimeDocumentsHydrated,
      getActiveTopDocumentIdentity,
      isRuntimeRefreshTargetUnavailableError,
      isRuntimeScriptTimeoutError,
      runtimeRefreshErrorMessage,
      scheduleDeferredRuntimeRetry,
    } = deps;
    const getRuntimeTabLifecycleGeneration = () => 1;
    const runtimeTabLifecycleMatches = () => true;
    ${recoverySource}
    return { recoverRuntimeTabFailure };
  `);
  const deferred = [];
  let schedules = 0;
  const harness = buildHarness({
    browser: {
      tabs: {
        async get(tabId) {
          return {
            id: tabId,
            discarded: false,
            frozen: true,
            url: testHttpsUrl('newly-frozen.example'),
          };
        },
      },
    },
    deferRuntimeDocuments: async entries => { deferred.push(...entries); },
    getActiveTopDocumentIdentity: async tabId => ({
      tabId,
      documentId: 'newly-frozen-document',
      url: testHttpsUrl('newly-frozen.example'),
    }),
    isRuntimeRefreshTargetUnavailableError: () => false,
    isRuntimeScriptTimeoutError: () => false,
    runtimeRefreshErrorMessage: reason => reason?.message || String(reason || ''),
    scheduleDeferredRuntimeRetry: async () => { schedules += 1; },
  });

  assert.equal(await harness.recoverRuntimeTabFailure(
    { id: 91, url: testHttpsUrl('newly-frozen.example') },
    new Error('Cannot access a frozen tab'),
    'refresh',
    'fingerprint-current'
  ), 'deferred');
  assert.deepEqual(deferred, [{
    tabId: 91,
    topDocumentId: 'newly-frozen-document',
    operation: 'refresh',
    desiredFingerprint: 'fingerprint-current',
    expectedTabGeneration: 1,
    waitForUnfreeze: true,
    incrementFailure: false,
    lastError: 'Cannot access a frozen tab',
  }]);
  assert.equal(schedules, 1);
});

test('frozen paywall tabs persist stop intent without rejecting startup cleanup', async () => {
  const source = await readSource('js/background.js');
  const stopOpenTabsSource = sourceBetween(
    source,
    'async function stopRuntimeStateForOpenTabs',
    'async function completeLateInstallRulesetReset'
  );
  const enablePaywallSource = sourceBetween(
    source,
    'async function enablePaywallNow',
    'async function disablePaywallNow'
  );
  const buildHarness = new Function('deps', `
    const {
      browser,
      clearDeferredRuntimeDocuments,
      deferRuntimeDocuments,
      deferredRuntimeDocuments,
      ensureDeferredRuntimeDocumentsHydrated,
      getActiveTopDocumentIdentity,
      isIgnorableRuntimeError,
      isRuntimeRefreshTargetUnavailableError,
      OPEN_TAB_RUNTIME_REFRESH_CONCURRENCY,
      stopCalls,
      tabUrlMayHostExtensionRuntime,
      ubolErr,
    } = deps;
    const getRuntimeTabLifecycleGeneration = () => 1;
    const runtimeTabLifecycleMatches = () => true;
    const stopRuntimeStateForTab = async tabId => {
      stopCalls.push(tabId);
      return true;
    };
    ${stopOpenTabsSource}
    return { stopRuntimeStateForOpenTabs };
  `);
  const stopCalls = [];
  const deferredEntries = [];
  const harness = buildHarness({
    browser: {
      tabs: {
        async query() {
          return [{
            id: 81,
            active: false,
            discarded: false,
            frozen: true,
            url: testHttpsUrl('frozen-paywall.example'),
          }];
        },
      },
    },
    clearDeferredRuntimeDocuments: async () => false,
    deferRuntimeDocuments: async entries => {
      deferredEntries.push(...entries);
      return true;
    },
    deferredRuntimeDocuments: new Map(),
    ensureDeferredRuntimeDocumentsHydrated: async () => true,
    getActiveTopDocumentIdentity: async tabId => ({
      tabId,
      documentId: `paywall-document-${tabId}`,
      url: testHttpsUrl('frozen-paywall.example'),
    }),
    isIgnorableRuntimeError: () => false,
    isRuntimeRefreshTargetUnavailableError: () => false,
    OPEN_TAB_RUNTIME_REFRESH_CONCURRENCY: 4,
    stopCalls,
    tabUrlMayHostExtensionRuntime: value => /^https?:/.test(value),
    ubolErr: reason => assert.fail(`unexpected stop error: ${reason}`),
  });

  assert.equal(await harness.stopRuntimeStateForOpenTabs(), true);
  assert.deepEqual(deferredEntries, [{
    tabId: 81,
    topDocumentId: 'paywall-document-81',
    operation: 'stop',
    desiredFingerprint: '',
    expectedTabGeneration: 1,
    waitForUnfreeze: true,
    incrementFailure: false,
  }]);
  assert.deepEqual(stopCalls, []);
  assert.match(
    enablePaywallSource,
    /const openTabCleanup = stopRuntimeStateForOpenTabs\(\)\.then\(stopped => \{[\s\S]*if \( stopped !== true \)[\s\S]*throw new Error\('paywall open-tab cleanup was not verified'\)/
  );
});

test('global refresh and stop cannot clear a newer deferred document generation', async () => {
  const source = await readSource('js/background.js');
  const refreshSource = sourceBetween(
    source,
    'async function refreshRuntimeStateForOpenTabsNow',
    'let openTabRuntimeRefreshPromise'
  );
  const stopSource = sourceBetween(
    source,
    'async function stopRuntimeStateForOpenTabs',
    'async function completeLateInstallRulesetReset'
  );
  const makeEntry = (operation, updatedAt) => ({
    tabId: 44,
    topDocumentId: 'document-current',
    operation,
    desiredFingerprint: operation === 'refresh' ? 'fingerprint-current' : '',
    updatedAt,
  });
  const runLane = async operation => {
    const deferredRuntimeDocuments = new Map([
      ['current', makeEntry(operation, 1)],
    ]);
    const clears = [];
    let operationStarted;
    const operationStartedPromise = new Promise(resolve => {
      operationStarted = resolve;
    });
    let finishOperation;
    const operationGate = new Promise(resolve => { finishOperation = resolve; });
    const common = {
      browser: {
        tabs: {
          async query() {
            return [{
              id: 44,
              active: true,
              discarded: false,
              frozen: false,
              url: testHttpsUrl('generation.example'),
            }];
          },
        },
      },
      clearDeferredRuntimeDocuments: async options => {
        clears.push(options);
        const current = deferredRuntimeDocuments.get('current');
        if (current?.updatedAt === options.expectedUpdatedAt) {
          deferredRuntimeDocuments.delete('current');
        }
      },
      deferRuntimeDocuments: async () => true,
      deferredRuntimeDocuments,
      ensureDeferredRuntimeDocumentsHydrated: async () => true,
      getActiveTopDocumentIdentity: async () => ({
        tabId: 44,
        documentId: 'document-current',
        url: testHttpsUrl('generation.example'),
      }),
      isIgnorableRuntimeError: () => false,
      isRuntimeRefreshTargetUnavailableError: () => false,
      OPEN_TAB_RUNTIME_REFRESH_CONCURRENCY: 4,
      tabUrlMayHostExtensionRuntime: value => /^https?:/.test(value),
      ubolErr: reason => assert.fail(`unexpected ${operation} error: ${reason}`),
    };

    let running;
    if (operation === 'refresh') {
      const buildHarness = new Function('deps', `
        const {
          browser,
          clearDeferredRuntimeDocuments,
          collectStoredRemoteCosmeticHostnames,
          deferRuntimeDocuments,
          deferredRuntimeDocuments,
          ensureDeferredRuntimeDocumentsHydrated,
          getActiveTopDocumentIdentity,
          getFilteringMode,
          getRegisteredCoreCosmeticDirectives,
          getReportedEnabledRulesets,
          isIgnorableRuntimeError,
          isRuntimeRefreshTargetUnavailableError,
          MODE_NONE,
          normalizeHttpHostname,
          OPEN_TAB_RUNTIME_REFRESH_CONCURRENCY,
          readLocalStrict,
          refreshRuntimeStateForTab,
          REMOTE_COSMETICS_STORAGE_KEY,
          storedRemoteCosmeticsHaveGlobalSelectors,
          tabUrlMayHostExtensionRuntime,
          ubolErr,
        } = deps;
        const getRuntimeTabLifecycleGeneration = () => 1;
        const runtimeTabLifecycleMatches = () => true;
        ${refreshSource}
        return { refreshRuntimeStateForOpenTabsNow };
      `);
      const harness = buildHarness({
        ...common,
        collectStoredRemoteCosmeticHostnames: () => new Set(),
        getFilteringMode: async () => 2,
        getRegisteredCoreCosmeticDirectives: async () => [],
        getReportedEnabledRulesets: async () => [],
        MODE_NONE: 0,
        normalizeHttpHostname: value => new URL(value).hostname,
        readLocalStrict: async () => ({}),
        refreshRuntimeStateForTab: async () => {
          operationStarted();
          return operationGate;
        },
        REMOTE_COSMETICS_STORAGE_KEY: 'remoteCosmetics',
        storedRemoteCosmeticsHaveGlobalSelectors: () => false,
      });
      running = harness.refreshRuntimeStateForOpenTabsNow();
    } else {
      const buildHarness = new Function('deps', `
        const {
          browser,
          clearDeferredRuntimeDocuments,
          deferRuntimeDocuments,
          deferredRuntimeDocuments,
          ensureDeferredRuntimeDocumentsHydrated,
          getActiveTopDocumentIdentity,
          isIgnorableRuntimeError,
          isRuntimeRefreshTargetUnavailableError,
          OPEN_TAB_RUNTIME_REFRESH_CONCURRENCY,
          stopRuntimeStateForTab,
          tabUrlMayHostExtensionRuntime,
          ubolErr,
        } = deps;
        const getRuntimeTabLifecycleGeneration = () => 1;
        const runtimeTabLifecycleMatches = () => true;
        ${stopSource}
        return { stopRuntimeStateForOpenTabs };
      `);
      const harness = buildHarness({
        ...common,
        stopRuntimeStateForTab: async () => {
          operationStarted();
          return operationGate;
        },
      });
      running = harness.stopRuntimeStateForOpenTabs();
    }

    await operationStartedPromise;
    const newer = makeEntry(operation, 2);
    deferredRuntimeDocuments.set('current', newer);
    finishOperation({ ok: true, topDocumentId: 'document-current' });
    assert.equal(await running, true);
    assert.equal(deferredRuntimeDocuments.get('current'), newer);
    assert.deepEqual(clears, [{
      tabId: 44,
      topDocumentId: 'document-current',
      operation,
      expectedUpdatedAt: 1,
    }]);
  };

  await runLane('refresh');
  await runLane('stop');
});

test('unfreeze, activation fallback, and BFCache restore queue authoritative reconciliation', async () => {
  const source = await readSource('js/background.js');
  const listenerSource = sourceBetween(
    source,
    'const queueLifecycleRuntimeReconcile',
    'runtime.onMessage.addListener'
  );
  const updatedListeners = [];
  const activatedListeners = [];
  const committedListeners = [];
  const timers = [];
  const reconciliations = [];
  const lifecycleClears = [];
  const tabStates = new Map();
  const deferredFrozenRuntimeTabIds = new Set([8]);
  const browser = {
    tabs: {
      onUpdated: { addListener: listener => updatedListeners.push(listener) },
      onActivated: { addListener: listener => activatedListeners.push(listener) },
      async get(tabId) { return tabStates.get(tabId); },
    },
    webNavigation: {
      onCommitted: { addListener: listener => committedListeners.push(listener) },
    },
  };
  const self = {
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
  };
  const buildHarness = new Function('deps', `
    const {
      browser,
      clearReloadNeededStateForTab,
      clearReplacedDeferredRuntimeDocuments,
      deferredFrozenRuntimeTabIds,
      ensureDeferredRuntimeDocumentsHydrated,
      lifecycleRuntimeRefreshSuspendedForPaywall,
      isEntitled,
      isFullyInitialized,
      isRuntimeRefreshTargetUnavailableError,
      invalidateRuntimeTabLifecycle,
      consumePrerenderDocument,
      observePendingUserScriptsPaywallCleanup,
      paywallActive,
      queueRuntimeStateReconcileForTab,
      self,
      ubolErr,
    } = deps;
    ${listenerSource}
  `);
  buildHarness({
    browser,
    clearReloadNeededStateForTab(tabId, options) {
      lifecycleClears.push({ kind: 'reload', tabId, options });
      return Promise.resolve(true);
    },
    clearReplacedDeferredRuntimeDocuments(tabId, documentId) {
      lifecycleClears.push({ kind: 'deferred', tabId, documentId });
      return Promise.resolve(true);
    },
    deferredFrozenRuntimeTabIds,
    ensureDeferredRuntimeDocumentsHydrated: async () => true,
    lifecycleRuntimeRefreshSuspendedForPaywall: false,
    isEntitled: () => true,
    isFullyInitialized: Promise.resolve(),
    isRuntimeRefreshTargetUnavailableError: () => false,
    invalidateRuntimeTabLifecycle: () => true,
    consumePrerenderDocument: async () => null,
    observePendingUserScriptsPaywallCleanup: () => {},
    queueRuntimeStateReconcileForTab(tabId, url) {
      reconciliations.push({ tabId, url });
      return Promise.resolve(true);
    },
    paywallActive: false,
    self,
    ubolErr: reason => assert.fail(`unexpected lifecycle error: ${reason}`),
  });
  assert.equal(updatedListeners.length, 1);
  assert.equal(activatedListeners.length, 1);
  assert.equal(committedListeners.length, 1);

  updatedListeners[0](7, { frozen: true }, { url: testHttpsUrl('ignored.example') });
  updatedListeners[0](7, { status: 'complete' }, { url: testHttpsUrl('ignored.example') });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(reconciliations, []);

  updatedListeners[0](7, { frozen: false }, { url: testHttpsUrl('unfrozen.example') });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(reconciliations, [
    { tabId: 7, url: testHttpsUrl('unfrozen.example') },
  ]);

  tabStates.set(8, { frozen: true, url: testHttpsUrl('still-frozen.example') });
  activatedListeners[0]({ tabId: 8 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reconciliations.length, 1);
  tabStates.set(8, { frozen: false, url: testHttpsUrl('activated.example') });
  activatedListeners[0]({ tabId: 8 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(reconciliations[1], {
    tabId: 8,
    url: testHttpsUrl('activated.example'),
  });

  committedListeners[0]({
    tabId: 9,
    frameId: 1,
    documentLifecycle: 'active',
    transitionQualifiers: ['forward_back'],
    url: testHttpsUrl('child.example'),
  });
  committedListeners[0]({
    tabId: 9,
    frameId: 0,
    documentLifecycle: 'active',
    documentId: 'normal-document',
    transitionQualifiers: [],
    url: testHttpsUrl('normal.example'),
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(timers.length, 0);
  assert.deepEqual(lifecycleClears, [
    {
      kind: 'reload',
      tabId: 9,
      options: {
        currentDocumentId: 'normal-document',
        currentUrl: testHttpsUrl('normal.example'),
        transitionType: '',
        forwardBack: false,
        outermostPrerender: false,
        prerenderCommittedAt: 0,
      },
    },
    {
      kind: 'deferred',
      tabId: 9,
      documentId: 'normal-document',
    },
  ]);
  committedListeners[0]({
    tabId: 9,
    frameId: 0,
    documentLifecycle: 'active',
    documentId: 'restored-document',
    transitionQualifiers: ['forward_back'],
    url: testHttpsUrl('restored.example'),
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 0);
  assert.equal(reconciliations.length, 2);
  timers[0].callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(lifecycleClears.slice(2), [
    {
      kind: 'reload',
      tabId: 9,
      options: {
        currentDocumentId: 'restored-document',
        currentUrl: testHttpsUrl('restored.example'),
        transitionType: '',
        forwardBack: true,
        outermostPrerender: false,
        prerenderCommittedAt: 0,
      },
    },
    {
      kind: 'deferred',
      tabId: 9,
      documentId: 'restored-document',
    },
  ]);
  assert.deepEqual(reconciliations[2], {
    tabId: 9,
    url: testHttpsUrl('restored.example'),
  });

  const reconcileSource = sourceBetween(
    source,
    'async function reconcileRuntimeStateForCurrentTab',
    'function queueRuntimeStateReconcileForTab'
  );
  assert.match(
    reconcileSource,
    /if \( isEntitled\(\) === false \|\| paywallActive \) \{[\s\S]*stopRuntimeStateForTab\(tabId, \{ expectedTabGeneration \}\)/
  );
  assert.match(reconcileSource, /refreshCustomFilters: true/);
  assert.match(reconcileSource, /refreshCoreCosmetics: true/);
});

test('paywall lifecycle cleanup bypasses a rejected full-start gate', async () => {
  const source = await readSource('js/background.js');
  const queueSource = sourceBetween(
    source,
    'const queueLifecycleRuntimeReconcile',
    'browser.tabs?.onUpdated?.addListener'
  );
  const buildHarness = new Function('deps', `
    const {
      isEntitled,
      isFullyInitialized,
      isRuntimeRefreshTargetUnavailableError,
      paywallActive,
      queueRuntimeStateReconcileForTab,
      ubolErr,
    } = deps;
    ${queueSource}
    return { queueLifecycleRuntimeReconcile };
  `);
  const rejectedStartup = Promise.reject(new Error('startup failed'));
  rejectedStartup.catch(() => {});
  const reconciliations = [];
  const harness = buildHarness({
    isEntitled: () => false,
    isFullyInitialized: rejectedStartup,
    isRuntimeRefreshTargetUnavailableError: () => false,
    paywallActive: false,
    queueRuntimeStateReconcileForTab(tabId, url) {
      reconciliations.push({ tabId, url });
      return Promise.resolve(true);
    },
    ubolErr: reason => assert.fail(`unexpected lifecycle failure: ${reason}`),
  });

  harness.queueLifecycleRuntimeReconcile(91, testHttpsUrl('expired.example'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(reconciliations, [{
    tabId: 91,
    url: testHttpsUrl('expired.example'),
  }]);
});

test('failed active document reconciliation stays durable and has a targeted retry lane', async () => {
  const source = await readSource('js/background.js');
  const queueSource = sourceBetween(
    source,
    'function queueRuntimeStateReconcileForTab',
    'async function drainActiveDeferredRuntimeDocuments'
  );
  const pendingEntry = {
    tabId: 33,
    topDocumentId: 'retry-document',
    operation: 'refresh',
    desiredFingerprint: 'fingerprint-retry',
    updatedAt: 10,
  };
  const deferredRuntimeDocuments = new Map([['pending', pendingEntry]]);
  const resumedTabRuntimeTails = new Map();
  let schedules = 0;
  const buildHarness = new Function('deps', `
    const {
      clearDeferredRuntimeDocuments,
      deferredRuntimeDocuments,
      ensureDeferredRuntimeDocumentsHydrated,
      getRuntimeTabLifecycleGeneration,
      isEntitled,
      rememberSuspendedRuntimeReconcileRequest,
      reconcileRuntimeStateForCurrentTab,
      rememberRuntimeReconcileFailure,
      resumedTabRuntimeTails,
      runtimeTabLifecycleMatches,
      scheduleDeferredRuntimeRetry,
    } = deps;
    const lifecycleRuntimeRefreshSuspendedForPaywall = false;
    ${queueSource}
    return { queueRuntimeStateReconcileForTab };
  `);
  const harness = buildHarness({
    clearDeferredRuntimeDocuments: async () => {
      assert.fail('failed reconciliation must not clear durable intent');
    },
    deferredRuntimeDocuments,
    ensureDeferredRuntimeDocumentsHydrated: async () => true,
    getRuntimeTabLifecycleGeneration: () => 1,
    isEntitled: () => true,
    rememberSuspendedRuntimeReconcileRequest: async () => ({ deferred: true }),
    reconcileRuntimeStateForCurrentTab: async () => {
      throw new Error('transient scripting failure');
    },
    rememberRuntimeReconcileFailure: async () => 'deferred',
    resumedTabRuntimeTails,
    runtimeTabLifecycleMatches: () => true,
    scheduleDeferredRuntimeRetry: async () => { schedules += 1; },
  });

  assert.deepEqual(
    await harness.queueRuntimeStateReconcileForTab(33),
    { deferred: true }
  );
  assert.equal(deferredRuntimeDocuments.get('pending'), pendingEntry);
  assert.equal(schedules, 1);
  assert.match(
    source,
    /if \( alarm\?\.name === DEFERRED_RUNTIME_RETRY_ALARM \) \{[\s\S]*drainActiveDeferredRuntimeDocuments\(\)/
  );
  assert.match(
    source,
    /alarm\?\.name === DEFERRED_RUNTIME_RETRY_ALARM[\s\S]*Promise\.resolve\(isFullyInitialized\)/
  );
});

test('paywall suspension drains in-flight per-tab reconciliation before final stop', async () => {
  const source = await readSource('js/background.js');
  const waitSource = sourceBetween(
    source,
    'async function waitForResumedTabRuntimeIdle',
    'async function reconcileRuntimeStateForCurrentTab'
  );
  const queueSource = sourceBetween(
    source,
    'function queueRuntimeStateReconcileForTab',
    'async function drainActiveDeferredRuntimeDocuments'
  );
  const enableSource = sourceBetween(
    source,
    'async function enablePaywallNow',
    'async function clearPaywallAllowAllRulesNow'
  );
  const buildHarness = new Function('deps', `
    const {
      clearDeferredRuntimeDocuments,
      deferredRuntimeDocuments,
      ensureDeferredRuntimeDocumentsHydrated,
      getRuntimeTabLifecycleGeneration,
      isEntitled,
      rememberSuspendedRuntimeReconcileRequest,
      reconcileRuntimeStateForCurrentTab,
      rememberRuntimeReconcileFailure,
      resumedTabRuntimeTails,
      runtimeTabLifecycleMatches,
      scheduleDeferredRuntimeRetry,
    } = deps;
    let lifecycleRuntimeRefreshSuspendedForPaywall = false;
    ${waitSource}
    ${queueSource}
    return {
      queueRuntimeStateReconcileForTab,
      waitForResumedTabRuntimeIdle,
      suspend() { lifecycleRuntimeRefreshSuspendedForPaywall = true; },
    };
  `);
  let releaseReconcile;
  const reconcileGate = new Promise(resolve => { releaseReconcile = resolve; });
  let reconcileStarted;
  const reconcileStartedPromise = new Promise(resolve => {
    reconcileStarted = resolve;
  });
  let reconcileCalls = 0;
  const harness = buildHarness({
    clearDeferredRuntimeDocuments: async () => false,
    deferredRuntimeDocuments: new Map(),
    ensureDeferredRuntimeDocumentsHydrated: async () => true,
    getRuntimeTabLifecycleGeneration: () => 1,
    isEntitled: () => true,
    rememberSuspendedRuntimeReconcileRequest: async () => ({ deferred: true }),
    reconcileRuntimeStateForCurrentTab: async () => {
      reconcileCalls += 1;
      reconcileStarted();
      return reconcileGate;
    },
    rememberRuntimeReconcileFailure: async () => 'deferred',
    resumedTabRuntimeTails: new Map(),
    runtimeTabLifecycleMatches: () => true,
    scheduleDeferredRuntimeRetry: async () => true,
  });

  const oldRefresh = harness.queueRuntimeStateReconcileForTab(61);
  await reconcileStartedPromise;
  harness.suspend();
  assert.deepEqual(
    await harness.queueRuntimeStateReconcileForTab(62),
    { deferred: true }
  );
  assert.equal(reconcileCalls, 1);
  let drained = false;
  const drain = harness.waitForResumedTabRuntimeIdle().then(() => {
    drained = true;
  });
  await Promise.resolve();
  assert.equal(drained, false);
  releaseReconcile({ ok: true, topDocumentId: 'document-61' });
  assert.equal(await oldRefresh, true);
  await drain;
  assert.equal(drained, true);

  assertOrderedIncludes(enableSource, [
    'suspendRegistrationMutationsForPaywall();',
    'waitForRegistrationMutationsToSettle()',
    'unregisterAllContentScripts()',
    'stopRuntimeStateForOpenTabs()',
  ], 'paywall lifecycle drain');
  assert.match(
    source,
    /waitForRegistrationMutationsToSettle\(\)[\s\S]*waitForResumedTabRuntimeIdle\(\)/
  );
});

test('document-bound page mutations abort stale starts and drain dispatched cleanup', async () => {
  const source = await readSource('js/background.js');
  const popupSource = await readSource('js/popup.js');
  const liveMutationSource = sourceBetween(
    source,
    'function livePageMutationMayDispatch',
    'const isDurableDirtyMarker'
  );
  const buildHarness = new Function('deps', `
    const { ubolErr } = deps;
    let livePageMutationGeneration = 0;
    const pendingLivePageMutations = new Set();
    let entitled = true;
    let paywallActive = false;
    let registrationMutationsSuspendedForPaywall = false;
    let lifecycleRuntimeRefreshSuspendedForPaywall = false;
    let startupCoreReady = true;
    const isEntitled = () => entitled;
    ${liveMutationSource}
    return {
      trackLivePageMutation,
      waitForLivePageMutations,
      suspendEntitledRestore() {
        entitled = true;
        livePageMutationGeneration += 1;
        registrationMutationsSuspendedForPaywall = true;
        lifecycleRuntimeRefreshSuspendedForPaywall = true;
      },
      expire() {
        entitled = false;
        paywallActive = true;
        registrationMutationsSuspendedForPaywall = true;
        lifecycleRuntimeRefreshSuspendedForPaywall = true;
      },
    };
  `);
  const harness = buildHarness({ ubolErr: () => {} });
  let releasePreparation;
  let preparationStarted;
  const preparationGate = new Promise(resolve => { releasePreparation = resolve; });
  const preparationStartedGate = new Promise(resolve => { preparationStarted = resolve; });
  let starts = 0;
  const staleStart = harness.trackLivePageMutation(async stillCurrent => {
    preparationStarted();
    await preparationGate;
    if (stillCurrent() === false) { return false; }
    starts += 1;
    return true;
  });
  await preparationStartedGate;
  harness.suspendEntitledRestore();
  releasePreparation();
  assert.equal(await staleStart, false);
  assert.equal(starts, 0);

  harness.expire();
  let releaseCleanup;
  let cleanupDispatched;
  const cleanupGate = new Promise(resolve => { releaseCleanup = resolve; });
  const cleanupDispatchedGate = new Promise(resolve => { cleanupDispatched = resolve; });
  const cleanup = harness.trackLivePageMutation(async () => {
    cleanupDispatched();
    await cleanupGate;
    return true;
  }, { cleanup: true });
  await cleanupDispatchedGate;
  harness.suspendEntitledRestore();
  let drained = false;
  const drain = harness.waitForLivePageMutations().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  releaseCleanup();
  assert.equal(await cleanup, true);
  await drain;
  assert.equal(drained, true);

  const messageMutationSource = sourceBetween(
    source,
    "case 'insertCSS':",
    "case 'promoteComplete':"
  );
  assert.match(messageMutationSource, /insertCSS[\s\S]*trackLivePageMutation[\s\S]*documentIds: \[ documentId \]/);
  assert.match(messageMutationSource, /removeCSS[\s\S]*trackLivePageMutation[\s\S]*documentIds: \[ documentId \][\s\S]*\{ cleanup: true \}/);
  assert.match(source, /case 'injectCustomFilters':[\s\S]*prepareCustomFilterDetails[\s\S]*stillCurrent\(\) === false/);
  assert.match(source, /case 'injectCSSProceduralAPI':[\s\S]*trackLivePageMutation/);
  assert.match(source, /case 'terminateCustomFilters':[\s\S]*\{ cleanup: true \}/);
  assert.doesNotMatch(popupSource, /browser\.scripting\.executeScript/);
  assert.match(popupSource, /what: 'launchElementTool'[\s\S]*tool: 'picker'/);
  assert.match(source, /launchElementToolForTab[\s\S]*trackLivePageMutation[\s\S]*documentIds: \[ identity\.documentId \]/);
});

test('entitled restore is bounded and drains suspended lifecycle intent after registration', async () => {
  const source = await readSource('js/background.js');
  const effectsSource = sourceBetween(
    source,
    'async function applyEntitlementStatusEffects',
    'async function enforceEntitlementNow'
  );
  assertOrderedIncludes(effectsSource, [
    'suspendRegistrationMutationsForPaywall();',
    'raceWithTimeout(',
    'waitForRegistrationMutationsToSettle()',
    "'entitlement restore registration drain timed out'",
    'resumeRegistrationMutationsAfterPaywall();',
    'ensureEntitledRegistrationEffects({',
    'drainSuspendedRuntimeReconcileRequests();',
    'drainSuspendedOpenTabRuntimeRefresh();',
  ], 'bounded paid restore');
  assert.match(
    source,
    /lifecycleRuntimeRefreshSuspendedForPaywall &&[\s\S]*isEntitled\(\)[\s\S]*rememberSuspendedRuntimeReconcileRequest/
  );
  assert.match(
    source,
    /if \( lifecycleRuntimeRefreshSuspendedForPaywall \) \{[\s\S]*rememberSuspendedOpenTabRuntimeRefresh/
  );
  assert.doesNotMatch(
    sourceBetween(source, 'async function enablePaywallNow', 'async function clearPaywallAllowAllRulesNow'),
    /suspendedRuntimeReconcileRequests\.clear|suspendedOpenTabRuntimeRefreshRequest = undefined/
  );
  assert.match(
    source,
    /Any expiry pass may have stopped only part[\s\S]*rememberSuspendedOpenTabRuntimeRefresh\(\{[\s\S]*refreshCustomFilters: true,[\s\S]*refreshCoreCosmetics: true,[\s\S]*if \( failures\.length !== 0 \)/
  );
});

test('remote scriptlet reload intent remains durable until exact-document marking succeeds', async () => {
  const background = await readSource('js/background.js');
  const manager = await readSource('js/scripting-manager.js');
  const markerSource = sourceBetween(
    background,
    'const markTabsForRemoteScriptletReload',
    'const markOpenTabsForSandboxUserScriptReload'
  );
  const syncSource = sourceBetween(
    background,
    'async function syncInjectablesAndRefreshTabsNow',
    'setAdminRuntimeReconciler'
  );
  assert.match(
    manager,
    /browser\.storage\.local\.get\([\s\S]*PENDING_REMOTE_SCRIPTLET_RELOAD_HINT_KEY[\s\S]*mergeRemoteScriptletReloadHints\([\s\S]*browser\.storage\.local\.set\(markerPatch\)/
  );
  assert.match(markerSource, /throw new Error\(`reloadNeeded\/queryTabs\/\$\{reason\}`\)/);
  assert.match(markerSource, /getTabFrameSnapshot\(tabId/);
  assert.match(markerSource, /persist: false,[\s\S]*updateBadge: false,[\s\S]*updateWildcard: false/);
  assert.equal(countMatches(markerSource, /persistReloadNeededTabs\(\)/g), 1);
  assertOrderedIncludes(syncSource, [
    'readLocalStrict(\n            PENDING_REMOTE_SCRIPTLET_RELOAD_HINT_KEY',
    'await applyContentRegistrationReloadHint(registerResult, reloadHint, {',
    'await persistInjectableRuntimeState(runtimeFingerprint);',
  ], 'durable remote reload handoff');
});

test('packaged scriptlet reload intent survives updates, paywall removal, and navigation races', async () => {
  const source = await readSource('js/background.js');
  const reloadHintHelperSource = sourceBetween(
    source,
    'const packagedStaticScriptletReloadHintFromRegistrations = (',
    'async function unregisterAllContentScripts'
  );
  const unregisterSource = sourceBetween(
    source,
    'async function unregisterAllContentScripts',
    'async function unregisterAllUserScripts'
  );
  const paywallSource = sourceBetween(
    source,
    'async function enablePaywallNow',
    'async function clearPaywallAllowAllRulesNow'
  );
  const syncSource = sourceBetween(
    source,
    'async function syncInjectablesAndRefreshTabsNow',
    'function syncInjectablesAndRefreshTabs'
  );
  const reuseSource = sourceBetween(
    source,
    'async function canReusePersistedInjectableRuntimeState',
    'async function updateUserRulesAndAcknowledgeSandboxState'
  );
  const markerSource = sourceBetween(
    source,
    'const markTabsForRemoteScriptletReload',
    'const markOpenTabsForSandboxUserScriptReload'
  );

  assertOrderedIncludes(unregisterSource, [
    'const before = await browser.scripting.getRegisteredContentScripts();',
    'packagedStaticScriptletReloadHintFromRegistrations(before',
    'PENDING_REMOTE_SCRIPTLET_RELOAD_HINT_KEY,',
    'await browser.scripting.unregisterContentScripts();',
  ], 'paywall packaged-scriptlet journal');
  assertOrderedIncludes(paywallSource, [
    '.packagedScriptletReloadHint',
    'markTabsForRemoteScriptletReload(',
    'PENDING_REMOTE_SCRIPTLET_RELOAD_HINT_KEY',
  ], 'paywall packaged-scriptlet handoff');
  assert.match(paywallSource, /\.\.\.packagedScriptletReloadResults/);

  assertOrderedIncludes(syncSource, [
    'const extensionVersionChanged =',
    'await browser.scripting.getRegisteredContentScripts();',
    'packagedStaticScriptletReloadHintFromRegistrations(',
    'PENDING_REMOTE_SCRIPTLET_RELOAD_HINT_KEY,',
    'await applyContentRegistrationReloadHint(registerResult, reloadHint, {',
  ], 'extension-update packaged-scriptlet handoff');
  assert.match(reuseSource, /CONTENT_SCRIPT_REGISTRATION_MUTATION_JOURNAL_KEY/);
  assert.match(reuseSource, /isDurableDirtyMarker\(contentScriptRegistrationMutationJournal\) === false/);
  assert.match(markerSource, /const current = await getTabFrameSnapshot\(candidate\.tabId\);[\s\S]*shouldReloadForFrameUrls\(current\.urls, reloadHint\)[\s\S]*markReloadNeededForTab/);

  const buildReloadHintHelper = new Function('deps', `
    const {
      isRemoteScriptletDirectiveId,
      normalizeRemoteScriptletReloadHint,
    } = deps;
    const recordPackagedStaticScriptletReloadTransition = () => false;
    ${reloadHintHelperSource}
    return packagedStaticScriptletReloadHintFromRegistrations;
  `);
  const buildReloadHint = buildReloadHintHelper({
    isRemoteScriptletDirectiveId,
    normalizeRemoteScriptletReloadHint,
  });
  const remoteRegistration = {
    id: 'remote-scriptlet.isolated.ublock-filters.set-constant',
    js: ['/js/scripting/scriptlet-token/ublock-filters.set-constant.js'],
    matches: ['*://*.scriptlet-target.example/*'],
    excludeMatches: [],
  };

  const paywallRemovalHint = buildReloadHint(
    [remoteRegistration],
    { removed: true }
  );
  assert.deepEqual(
    paywallRemovalHint.before.map(entry => entry.id),
    [remoteRegistration.id]
  );
  assert.deepEqual(paywallRemovalHint.after, []);

  const versionTransitionHint = buildReloadHint([remoteRegistration]);
  assert.deepEqual(versionTransitionHint.before, []);
  assert.deepEqual(
    versionTransitionHint.after.map(entry => entry.id),
    [remoteRegistration.id]
  );
});

test('startup entitlement effects and injectable sync transactions are serialized', async () => {
  const source = await readSource('js/background.js');
  const startSource = sourceBetween(
    source,
    'async function startNow({ forcePermissionSync = false } = {}) {',
    'async function start(options = {}) {'
  );
  const startupRunnerSource = sourceBetween(
    source,
    'const startWithBoundedRetry = async () =>',
    'const queueLifecycleRuntimeReconcile'
  );
  const enqueueSource = sourceBetween(
    source,
    'function enqueueEntitlementAction',
    'async function refreshEntitlement'
  );
  const syncSource = sourceBetween(
    source,
    'let injectableSyncTail',
    'setAdminRuntimeReconciler'
  );
  const popupRecoverySource = sourceBetween(
    source,
    'async function recoverStartupCoreFromPopupWarmup',
    'function shouldHandleMessageBeforeFullInitialization'
  );
  const alarmSource = sourceBetween(
    source,
    'async function onAlarmAfterStartup',
    'browser.alarms?.onAlarm.addListener'
  );

  assertOrderedIncludes(startSource, [
    'setEntitlementStatusForRuntime(await initEntitlement());',
    'entitlementInitialized = true;',
    'await scheduleEntitlementAlarms(entitlementStatus);',
    'await applyEntitlementStatusEffects(entitlementStatus, {',
    'startupInjectableResult = await ensureStartupInjectableState();',
    'startupComplete = true;',
  ], 'serialized startup hydration');
  assertOrderedIncludes(startupRunnerSource, [
    'await start();',
    'resolveStartupMutationBarrierGeneration(startupGeneration);',
  ], 'startup gate resolution');
  assert.match(enqueueSource, /const requiredBarrier = startupMutationBarrier;[\s\S]*allowAfterStartupFailure[\s\S]*requiredBarrier/);
  assert.match(
    source,
    /case 'popupWarmup': \{[\s\S]*observePromiseWithTimeout\([\s\S]*Promise\.resolve\(isFullyInitialized\),[\s\S]*POPUP_WARMUP_RECOVERY_TIMEOUT_MS/
  );
  assert.match(
    source,
    /const effectsRevision = \+\+entitlementEffectsRevision;[\s\S]*effectsRevision !== entitlementEffectsRevision/
  );
  assert.match(syncSource, /injectableSyncTail[\s\S]*syncInjectablesAndRefreshTabsNow\(options\)/);
  assert.match(
    syncSource,
    /const waitForInjectableSyncIdle = async \(\) => \{[\s\S]*injectableSyncTail === observed/
  );
  assert.match(
    source,
    /registrationMutationsSuspendedForPaywall = true;[\s\S]*waitForInjectableSyncIdle\(\)/
  );
  assert.match(
    popupRecoverySource,
    /startupCoreReady = true;/
  );
  assert.match(
    source,
    /const recoveryGeneration = installStartupMutationBarrier\(\);[\s\S]*resolveStartupMutationBarrierGeneration\(recoveryGeneration\)/
  );
  assert.match(
    alarmSource,
    /if \( startupComplete && startupCoreReady \)[\s\S]*prepareFilteringSurfaceReconciliation\(\)[\s\S]*ensureStartupInjectableState\(\)[\s\S]*recoverStartupStateForPopup\(\)[\s\S]*startupCoreReady = startupInjectableResultIsReady\(result\)/
  );
});

test('filtering mode transaction owns the only automatic-selection runtime settlement', async () => {
  const source = await readSource('js/background.js');
  const applySource = sourceBetween(
    source,
    'async function applyAutomaticRulesetSelection',
    'async function ensureAnnoyancesForCompleteDefaultNow'
  );
  const runtimeReconcileSource = sourceBetween(
    source,
    'async function reconcileFilteringModeRuntimeNow',
    'async function reconcileFilteringModeMutation'
  );
  const filteringTransactionSource = sourceBetween(
    source,
    'async function reconcileFilteringModeMutation',
    'async function prepareFilteringSurfaceReconciliation'
  );

  assert.doesNotMatch(
    applySource,
    /registerInjectablesIfEntitled\(\)\.catch\(ubolErr\)/
  );
  assert.doesNotMatch(applySource, /syncInjectablesAndRefreshTabs\(/);
  assert.doesNotMatch(applySource, /broadcastMessage\(/);
  assert.equal(
    countMatches(runtimeReconcileSource, /syncInjectablesAndRefreshTabs\(\{/g),
    1,
    'a filtering-mode transaction performs exactly one live sync'
  );
  assertOrderedIncludes(runtimeReconcileSource, [
    'await ensureAnnoyancesForCompleteDefaultNow();',
    'const beforeSyncResult = await beforeSync?.(mutationResult);',
    'const syncResult = await syncInjectablesAndRefreshTabs({',
    'assertAuthoritativeInjectableSyncResult(syncResult,',
    'clearFilteringSurfaceReconciliationToken(',
    'broadcastVerifiedRulesetRuntimeState();',
  ], 'serialized filtering surface reconciliation');
  assertOrderedIncludes(filteringTransactionSource, [
    'await localWrite(FILTERING_MODE_RECONCILIATION_DIRTY_KEY, {',
    'await scheduleFilteringModeReconciliationRetry();',
    'const mutationResult = await operation();',
    'return await reconcileFilteringModeRuntimeNow({',
  ], 'durable mutation handoff');
});

test('authoritative injectable success requires settled registrations and a durable fingerprint', async () => {
  const source = await readSource('js/background.js');
  const executableResultCheckSource = sourceBetween(
    source,
    'const contentRegistrationResultIsVerified',
    'const applyContentRegistrationReloadHint'
  );
  const resultCheckSource = sourceBetween(
    source,
    'function assertAuthoritativeInjectableSyncResult',
    'const applyContentRegistrationReloadHint'
  );
  const syncSource = sourceBetween(
    source,
    'async function syncInjectablesAndRefreshTabsNow',
    'function syncInjectablesAndRefreshTabs'
  );

  assert.match(
    resultCheckSource,
    /contentRegistrationResultIsVerified\(result\.registerResult\)/
  );
  assert.match(resultCheckSource, /result\.runtimeStatePersisted === true/);
  assert.match(resultCheckSource, /typeof result\.runtimeFingerprint === 'string'/);
  assert.match(resultCheckSource, /error\.code = errorCode/);
  assert.match(
    syncSource,
    /const contentRegistrationSucceeded =\s*contentRegistrationResultIsVerified\(registerResult\)/
  );
  assert.match(syncSource, /runtimeStatePersisted,[\s\S]*retryScheduled,[\s\S]*ok: succeeded/);

  const buildHarness = new Function(`
    ${executableResultCheckSource}
    return assertAuthoritativeInjectableSyncResult;
  `);
  const assertSettled = buildHarness();
  const settled = {
    ok: true,
    registerResult: { ok: true, uncertain: false },
    runtimeStatePersisted: true,
    runtimeFingerprint: 'verified-fingerprint',
    sandboxUserScriptsPending: false,
    sandboxCustomFilterCount: 0,
  };
  assert.equal(assertSettled(settled), settled);
  assert.throws(
    () => assertSettled({
      ok: true,
      skipped: 'not_entitled',
      registerResult: false,
    }, 'filtering_mode_runtime_sync_failed'),
    error => error?.code === 'filtering_mode_runtime_sync_failed'
  );
  const allowedPaywallSkip = {
    ok: true,
    skipped: 'not_entitled',
    registerResult: false,
  };
  assert.equal(
    assertSettled(allowedPaywallSkip, 'startup_sync_failed', {
      allowNotEntitled: true,
    }),
    allowedPaywallSkip
  );
  assert.throws(
    () => assertSettled({
      ...settled,
      sandboxUserScriptsPending: true,
      sandboxCustomFilterCount: 1,
    }),
    error => error?.code === 'injectable_reconciliation_failed'
  );
  assert.equal(assertSettled({
    ...settled,
    sandboxUserScriptsPending: true,
    sandboxCustomFilterCount: 0,
  }).ok, true);
});

test('filtering mode messages do not report success before authoritative reconciliation', async () => {
  const source = await readSource('js/background.js');
  const siteModeSource = sourceBetween(
    source,
    "case 'setFilteringMode':",
    "case 'setPendingFilteringMode':"
  );
  const defaultModeSource = sourceBetween(
    source,
    "case 'setDefaultFilteringMode':",
    "case 'getFilteringModeDetails':"
  );
  const detailsSource = sourceBetween(
    source,
    "case 'setFilteringModeDetails':",
    "case 'excludeFromStrictBlock':"
  );

  for (const handlerSource of [siteModeSource, defaultModeSource, detailsSource]) {
    assert.match(handlerSource, /await reconcileFilteringModeMutation\(/);
    assert.doesNotMatch(handlerSource, /syncInjectablesAndRefreshTabs\(/);
    assert.doesNotMatch(handlerSource, /ensureAnnoyancesForCompleteDefault\(/);
    assert.doesNotMatch(handlerSource, /\.finally\(\(\) => \{\s*callback/);
    assert.match(handlerSource, /filtering_mode_runtime_sync_failed/);
    assert.match(handlerSource, /runtimeVerified: false/);
    assert.match(handlerSource, /retryScheduled:/);
  }
  assertOrderedIncludes(defaultModeSource, [
    'await reconcileFilteringModeMutation(',
    'broadcastMessage({ defaultFilteringMode: afterLevel });',
    'callback(afterLevel);',
  ], 'default mode verified callback');
  assertOrderedIncludes(detailsSource, [
    'await reconcileFilteringModeMutation(',
    'broadcastMessage({ defaultFilteringMode });',
    'callback(await getFilteringModeDetails(true));',
  ], 'filtering details verified callback');

  const settingsSource = await readSource('js/settings.js');
  const popupSource = await readSource('popup/popup.js');
  const legacyPopupSource = await readSource('js/popup.js');
  const optionsSource = await readSource('options/options.js');
  const modeEditorSource = await readSource('js/mode-editor.js');
  const backupRestoreSource = await readSource('js/backup-restore.js');
  assert.match(
    settingsSource,
    /response instanceof Object && response\.error[\s\S]*filteringModeRuntimeVerified = 'false'/
  );
  assert.match(
    popupSource,
    /response && typeof response === "object" && response\.error[\s\S]*throw new Error/
  );
  assert.match(legacyPopupSource, /response instanceof Object && response\.error/);
  assert.equal(
    countMatches(optionsSource, /typeof result === "object" && result\.error/g),
    2
  );
  assert.match(modeEditorSource, /if \( modesAfter\?\.error \)[\s\S]*throw new Error/);
  assert.match(backupRestoreSource, /rulesetResult\?\.error[\s\S]*filteringModeResult\?\.error/);
});

test('filtering surface dirty token survives cut points and is CAS-cleared after verification', async () => {
  const source = await readSource('js/background.js');
  const tokenSource = sourceBetween(
    source,
    'let filteringSurfaceReconciliationTokenCounter',
    'async function reconcileFilteringModeRuntimeNow'
  );
  const preparationSource = sourceBetween(
    source,
    'async function prepareFilteringSurfaceReconciliation',
    'const filteringSurfaceRuntimeResultIsVerified'
  );
  const clearPreparedSource = sourceBetween(
    source,
    'async function clearPreparedFilteringSurfaceReconciliation',
    'function ensureAnnoyancesForCompleteDefault'
  );
  const startSource = sourceBetween(
    source,
    'async function startNow({ forcePermissionSync = false } = {}) {',
    'async function start(options = {}) {'
  );
  const entitlementSource = sourceBetween(
    source,
    'async function applyEntitlementStatusEffects',
    'async function enforceEntitlementNow'
  );
  const retryAlarmSource = sourceBetween(
    source,
    'if (alarm?.name === INJECTABLE_STARTUP_RETRY_ALARM)',
    "if (alarm?.name === ENTITLEMENT_EFFECTS_RETRY_ALARM)"
  );

  assert.match(source, /'filteringSurfaceReconciliationDirtyV1'/);
  assert.match(tokenSource, /filteringSurfaceReconciliationTokenFrom\(current\) !== token/);
  assert.match(tokenSource, /verifyRuntime[\s\S]*canReusePersistedInjectableRuntimeState/);
  assertOrderedIncludes(preparationSource, [
    'token = createFilteringSurfaceReconciliationToken();',
    'await localWrite(FILTERING_MODE_RECONCILIATION_DIRTY_KEY, {',
    'await ensureAnnoyancesForCompleteDefaultNow();',
  ], 'baseline recovery marker');
  assert.match(clearPreparedSource, /return enqueueRulesetMutation\(async \(\) =>[\s\S]*verifyRuntime: true/);
  assertOrderedIncludes(startSource, [
    'await prepareFilteringSurfaceReconciliation();',
    'startupInjectableResult = await ensureStartupInjectableState();',
    'await clearPreparedFilteringSurfaceReconciliation(',
  ], 'startup filtering surface drain');
  assertOrderedIncludes(entitlementSource, [
    'resumeRegistrationMutationsAfterPaywall();',
    'await prepareFilteringSurfaceReconciliation();',
    'await ensureEntitledRegistrationEffects({',
    'await clearPreparedFilteringSurfaceReconciliation(',
  ], 'entitlement filtering surface drain');
  assert.match(retryAlarmSource, /prepareFilteringSurfaceReconciliation\(\)[\s\S]*ensureStartupInjectableState\(\)[\s\S]*clearPreparedFilteringSurfaceReconciliation/);
  assert.match(retryAlarmSource, /filteringSurfaceRetryPending === false/);
});

test('Complete annoyance ownership survives settled starts and entry/exit save retries', async () => {
  const source = await readSource('js/background.js');
  const ensureSource = sourceBetween(
    source,
    'async function ensureAnnoyancesForCompleteDefaultNow',
    'async function scheduleFilteringModeReconciliationRetry'
  );
  const preparationSource = sourceBetween(
    source,
    'async function prepareFilteringSurfaceReconciliation',
    'const filteringSurfaceRuntimeResultIsVerified'
  );
  const buildHarness = new Function('deps', `
    const {
      getDefaultFilteringMode,
      rulesetConfig,
      MODE_COMPLETE,
      ANNOYANCE_RULESET_IDS,
      AUTO_ANNOYANCES_DISABLED_KEY,
      AUTO_ANNOYANCES_BASELINE_KEY,
      readLocalStrict,
      localWrite,
      localRemove,
      applyAutomaticRulesetSelection,
      arrayEqAsSet,
    } = deps;
    ${ensureSource}
    return ensureAnnoyancesForCompleteDefaultNow;
  `);
  const createHarness = ({
    mode = 4,
    enabled = [ 'base' ],
    baseline,
    failApplyAt = 0,
  } = {}) => {
    const storage = new Map();
    if ( baseline !== undefined ) {
      storage.set('baseline', baseline.slice());
    }
    const rulesetConfig = { enabledRulesets: enabled.slice() };
    const applyCalls = [];
    let applyCount = 0;
    const ensure = buildHarness({
      getDefaultFilteringMode: async () => mode,
      rulesetConfig,
      MODE_COMPLETE: 4,
      ANNOYANCE_RULESET_IDS: [ 'annoyance-a', 'annoyance-b' ],
      AUTO_ANNOYANCES_DISABLED_KEY: 'disabled',
      AUTO_ANNOYANCES_BASELINE_KEY: 'baseline',
      readLocalStrict: async key => storage.get(key),
      localWrite: async (key, value) => storage.set(key, value.slice?.() ?? value),
      localRemove: async key => storage.delete(key),
      applyAutomaticRulesetSelection: async ids => {
        applyCount += 1;
        applyCalls.push(ids.slice());
        rulesetConfig.enabledRulesets = ids.slice();
        if ( applyCount === failApplyAt ) {
          throw new Error('injected config save failure');
        }
        return true;
      },
      arrayEqAsSet: (a, b) =>
        a.length === b.length && a.every(id => b.includes(id)),
    });
    return { ensure, storage, rulesetConfig, applyCalls };
  };

  const entry = createHarness({
    enabled: [ 'base' ],
    baseline: [ 'original-base' ],
  });
  await entry.ensure();
  assert.deepEqual(entry.storage.get('baseline'), [ 'original-base' ]);
  assert.deepEqual(entry.applyCalls, [
    [ 'base', 'annoyance-a', 'annoyance-b' ],
  ]);

  const settled = createHarness({
    enabled: [ 'base', 'annoyance-a', 'annoyance-b' ],
    baseline: [ 'base' ],
  });
  assert.equal(await settled.ensure(), false);
  assert.deepEqual(settled.storage.get('baseline'), [ 'base' ]);
  assert.equal(settled.applyCalls.length, 0);

  const exitRetry = createHarness({
    mode: 3,
    enabled: [ 'base', 'annoyance-a', 'annoyance-b' ],
    baseline: [ 'base' ],
    failApplyAt: 1,
  });
  await assert.rejects(exitRetry.ensure(), /injected config save failure/);
  assert.deepEqual(exitRetry.rulesetConfig.enabledRulesets, [ 'base' ]);
  assert.deepEqual(exitRetry.storage.get('baseline'), [ 'base' ]);
  assert.equal(await exitRetry.ensure(), true);
  assert.equal(exitRetry.storage.has('baseline'), false);
  assert.deepEqual(exitRetry.applyCalls, [ [ 'base' ], [ 'base' ] ]);

  assert.match(
    preparationSource,
    /selectionReconciled === false && recoveringDirtyMutation[\s\S]*applyAutomaticRulesetSelection\([\s\S]*rulesetConfig\.enabledRulesets\.slice\(\)/
  );
});

test('manual ruleset journal preserves Complete ownership and replays exact intent', async () => {
  const source = await readSource('js/background.js');
  const planSource = sourceBetween(
    source,
    'async function buildManualRulesetOwnershipPlan',
    'async function applyManualRulesetOwnershipPlan'
  );
  const replaySource = sourceBetween(
    source,
    'async function replayJournaledRulesetMutation',
    'async function applyRulesetMutation'
  );
  const mutationSource = sourceBetween(
    source,
    'async function applyRulesetMutation',
    'async function deferFailedSenderDocumentRuntime'
  );
  const buildPlan = new Function('deps', `
    const {
      getDefaultFilteringMode,
      MODE_COMPLETE,
      ANNOYANCE_RULESET_IDS,
      readLocalStrict,
      AUTO_ANNOYANCES_BASELINE_KEY,
    } = deps;
    ${planSource}
    return buildManualRulesetOwnershipPlan;
  `)({
    getDefaultFilteringMode: async () => 4,
    MODE_COMPLETE: 4,
    ANNOYANCE_RULESET_IDS: [ 'annoyance-a', 'annoyance-b' ],
    readLocalStrict: async () => [ 'base', 'annoyance-a' ],
    AUTO_ANNOYANCES_BASELINE_KEY: 'baseline',
  });
  assert.deepEqual(
    await buildPlan(
      [ 'new-base', 'annoyance-a', 'annoyance-b' ],
      true
    ),
    {
      baselineAction: 'write',
      baselineRulesetIds: [ 'new-base', 'annoyance-a' ],
      annoyancesDisabled: false,
    }
  );
  assert.deepEqual(
    await buildPlan([ 'new-base', 'annoyance-a' ], true),
    { baselineAction: 'remove', annoyancesDisabled: true }
  );

  assertOrderedIncludes(mutationSource, [
    'const ownershipPlan = await buildManualRulesetOwnershipPlan(',
    'await localWrite(FILTERING_MODE_RECONCILIATION_DIRTY_KEY, {',
    "kind: 'ruleset',",
    'desiredRulesetIds: userEnabledRulesets.slice(),',
    'ownershipPlan,',
    'await scheduleFilteringModeReconciliationRetry();',
    'await broadcastUnverifiedRulesetRuntimeState();',
    'result = await enableRulesets(userEnabledRulesets);',
  ], 'ruleset intent journal precedes Chrome mutation');
  assertOrderedIncludes(replaySource, [
    'journal?.desiredRulesetIds',
    'await getRulesetDetails();',
    'await enableRulesets(availableDesiredRulesetIds);',
    'await persistAcceptedRulesetSelection({',
    'ownershipPlan: journal.ownershipPlan,',
    'forceSave: true,',
  ], 'ruleset journal recovery');
  assert.match(
    mutationSource,
    /result\?\.error &&[\s\S]*typeof result\.staticUpdateSucceeded !== 'boolean'[\s\S]*clearFilteringSurfaceReconciliationToken\(dirtyToken\)[\s\S]*retryScheduled: false/
  );
});

test('ruleset UIs wait for explicit verified runtime without arbitrary mutation timeouts', async () => {
  const backgroundSource = await readSource('js/background.js');
  const optionsSource = await readSource('options/options.js');
  const classicSource = await readSource('js/filter-lists.js');
  const adminSource = await readSource('js/admin.js');
  const applyDeltaSource = sourceBetween(
    optionsSource,
    'async function applyRulesetDelta',
    'async function refreshAllowlist'
  );
  const listenerSource = sourceBetween(
    optionsSource,
    'function wireRuntimeStateUpdates',
    'function wireAllowlist'
  );
  const startSource = sourceBetween(
    backgroundSource,
    'async function startNow({ forcePermissionSync = false } = {}) {',
    'async function start(options = {}) {'
  );
  const retryAlarmSource = sourceBetween(
    backgroundSource,
    'if (alarm?.name === INJECTABLE_STARTUP_RETRY_ALARM)',
    "if (alarm?.name === ENTITLEMENT_EFFECTS_RETRY_ALARM)"
  );

  assert.match(applyDeltaSource, /return chrome\.runtime\.sendMessage\(request\)/);
  assert.doesNotMatch(applyDeltaSource, /timeoutMs|sendRuntimeMessageWithTimeout/);
  assert.match(
    listenerSource,
    /typeof message\.runtimeVerified === "boolean"[\s\S]*rulesetRuntimeVerified = message\.runtimeVerified/
  );
  assert.doesNotMatch(
    listenerSource,
    /rulesetRuntimeVerified = message\.runtimeVerified === true/
  );
  assert.match(optionsSource, /entry\.checkbox\.disabled =[\s\S]*rulesetRuntimeVerified === false/);
  assert.match(classicSource, /const runtimeVerified = cachedRulesetData\.runtimeVerified === true/);
  assert.match(classicSource, /fromAdmin \|\| runtimeVerified === false \? '' : null/);
  assert.match(startSource, /rulesetRuntimeIsVerifiedForOptions\(\)[\s\S]*broadcastVerifiedRulesetRuntimeState/);
  assert.match(retryAlarmSource, /rulesetRuntimeIsVerifiedForOptions\(\)[\s\S]*broadcastVerifiedRulesetRuntimeState/);
  assert.equal(
    countMatches(adminSource, /broadcastMessage\(\{ runtimeVerified: false \}\)/g),
    3
  );
  assert.match(adminSource, /managed filtering runtime verification failed/);
});

test('accepted manual ruleset mutations verify runtime and suppress success broadcasts on failure', async () => {
  const source = await readSource('js/background.js');
  const mutationSource = sourceBetween(
    source,
    'async function applyRulesetMutation',
    'async function deferFailedSenderDocumentRuntime'
  );
  const handlerSource = sourceBetween(
    source,
    "case 'applyRulesets':",
    "case 'getDefaultConfig':"
  );

  assert.match(mutationSource, /if \( userIntentAccepted \) \{[\s\S]*syncInjectablesAndRefreshTabs/);
  assert.match(mutationSource, /assertAuthoritativeInjectableSyncResult\(syncResult,[\s\S]*'ruleset_runtime_sync_failed'/);
  assert.match(mutationSource, /runtimeVerified/);
  assert.doesNotMatch(handlerSource, /\.finally\(/);
  assert.match(handlerSource, /if \( result\?\.runtimeVerified === true \)[\s\S]*broadcastMessage/);
  assert.match(handlerSource, /runtimeVerified: false/);
});

test('full startup recovery restores the shared gate before releasing queued license work', async () => {
  const source = await readSource('js/background.js');
  const enqueueSource = sourceBetween(
    source,
    'function enqueueEntitlementAction',
    'async function refreshEntitlement'
  );
  const recoverySource = sourceBetween(
    source,
    'async function recoverStartupStateForPopup',
    'async function recoverStartupCoreFromPopupWarmup'
  );
  const buildHarness = new Function('deps', `
    const { browser, start, ubolErr } = deps;
    const STARTUP_PROCESS_RETRY_ALARM = 'startup-process-retry';
    let entitlementActionTail = Promise.resolve();
    let startupMutationBarrier = Promise.reject(new Error('initial startup failed'));
    startupMutationBarrier.catch(() => {});
    let startupMutationBarrierGeneration = 0;
    let resolveInstalledBarrier;
    const installStartupMutationBarrier = () => {
      startupMutationBarrierGeneration += 1;
      startupMutationBarrier = new Promise(resolve => {
        resolveInstalledBarrier = resolve;
      });
      return startupMutationBarrierGeneration;
    };
    const resolveStartupMutationBarrierGeneration = generation => {
      if (generation === startupMutationBarrierGeneration) {
        resolveInstalledBarrier?.();
      }
    };
    const rejectStartupMutationBarrierGeneration = () => {};
    let startupComplete = false;
    let startupCoreReady = false;
    let startupRecoveryPromise;
    let isFullyInitialized = startupMutationBarrier;
    const startupInjectableResultIsReady = result => result?.ok === true;
    const observeBestEffortOperation = operation => {
      Promise.resolve().then(operation).catch(() => {});
    };
    const invalidateStartupDocumentRuntimeAttempt = () => false;
    const settleStartupDocumentRuntimeUnavailable = () => {};
    const persistStartupDocumentRuntimeRepair = async () => {};
    ${enqueueSource}
    ${recoverySource}
    return {
      enqueueEntitlementAction,
      recoverStartupStateForPopup,
      markRecovered() {
        startupComplete = true;
        startupCoreReady = true;
      },
    };
  `);
  let releaseStart;
  const startGate = new Promise(resolve => { releaseStart = resolve; });
  let harness;
  harness = buildHarness({
    browser: { alarms: { async create() {} } },
    async start() {
      await startGate;
      harness.markRecovered();
      return { ok: true };
    },
    ubolErr: () => {},
  });

  const recovery = harness.recoverStartupStateForPopup();
  let licenseRan = false;
  const license = harness.enqueueEntitlementAction(async () => {
    licenseRan = true;
    return 'licensed';
  });
  await Promise.resolve();
  assert.equal(licenseRan, false);
  releaseStart();
  assert.deepEqual(await recovery, { ok: true });
  assert.equal(await license, 'licensed');
  assert.equal(licenseRan, true);

  assert.match(source, /let isFullyInitialized = startWithBoundedRetry\(\)/);
  assert.match(
    source,
    /startupRecoveryPromise = recovery;[\s\S]*isFullyInitialized = recovery\.then\(\(\) => undefined\)/
  );
  assert.match(source, /startupComplete = true;[\s\S]*return startupInjectableResult;/);
});

test('injectable retry repairs in place and only the guarded cold-start fallback reloads', async () => {
  const source = await readSource('js/background.js');
  const listenerStart = source.indexOf('browser.alarms?.onAlarm.addListener');
  assert.notEqual(listenerStart, -1);
  const listenerSource = source.slice(listenerStart);
  const retryHandlerSource = sourceBetween(
    source,
    'async function handleStartupProcessRetryAlarm',
    'browser.alarms?.onAlarm.addListener'
  );

  assert.match(
    listenerSource,
    /if \( alarm\?\.name === STARTUP_PROCESS_RETRY_ALARM \) \{[\s\S]*handleStartupProcessRetryAlarm\(\)\.catch\(ubolErr\);/
  );
  assert.match(retryHandlerSource, /await recoverStartupStateForPopup\(\);/);
  assert.doesNotMatch(retryHandlerSource, /runtime\.reload\(\)/);
  assert.match(source, /if \( goodStart === false \)[\s\S]*await localWrite\('goodStart', false\);[\s\S]*runtime\.reload\(\);/);
  assert.match(
    listenerSource,
    /alarm\?\.name === INJECTABLE_STARTUP_RETRY_ALARM \|\|[\s\S]*Promise\.resolve\(isFullyInitialized\)[\s\S]*onAlarmAfterStartup\(alarm\)/
  );
  assert.doesNotMatch(
    listenerSource,
    /STARTUP_PROCESS_RETRY_ALARM\s*\|\|\s*alarm\?\.name === INJECTABLE_STARTUP_RETRY_ALARM/
  );
  assert.ok(
    listenerSource.indexOf("alarm?.name === INJECTABLE_STARTUP_RETRY_ALARM") <
      listenerSource.indexOf('isFullyInitialized'),
    'recoverable injectable repair must not depend on the rejected startup promise'
  );
});

test('browser startup synchronously wakes the worker and reuses startup recovery', async () => {
  const source = await readSource('js/background.js');
  const handlerSource = sourceBetween(
    source,
    'function reconcileOnBrowserStartup()',
    'runtime.onStartup.addListener(reconcileOnBrowserStartup);'
  );
  const initializationOffset = source.indexOf(
    'let isFullyInitialized = startWithBoundedRetry()'
  );
  const listenerOffset = source.indexOf(
    'runtime.onStartup.addListener(reconcileOnBrowserStartup);'
  );

  assert.notEqual(initializationOffset, -1);
  assert.ok(listenerOffset > initializationOffset);
  assert.equal(
    countMatches(
      source,
      /runtime\.onStartup\.addListener\(reconcileOnBrowserStartup\);/g
    ),
    1
  );
  assert.match(
    handlerSource,
    /Promise\.resolve\(isFullyInitialized\)[\s\S]*recoverStartupStateForPopup\(\)/
  );

  const buildHandler = new Function('deps', `
    const {
      isFullyInitialized,
      recoverStartupStateForPopup,
      ubolErr,
    } = deps;
    ${handlerSource}
    return reconcileOnBrowserStartup;
  `);

  let resolveInitialStartup;
  const pendingInitialStartup = new Promise(resolve => {
    resolveInitialStartup = resolve;
  });
  let recoveryCount = 0;
  let errors = [];
  let handler = buildHandler({
    isFullyInitialized: pendingInitialStartup,
    async recoverStartupStateForPopup() {
      recoveryCount += 1;
    },
    ubolErr(reason) { errors.push(String(reason)); },
  });
  const observedStartup = handler();
  await Promise.resolve();
  assert.equal(recoveryCount, 0);
  resolveInitialStartup();
  await observedStartup;
  assert.equal(recoveryCount, 0);
  assert.deepEqual(errors, []);

  recoveryCount = 0;
  errors = [];
  handler = buildHandler({
    isFullyInitialized: Promise.reject(new Error('initial startup failed')),
    async recoverStartupStateForPopup() {
      recoveryCount += 1;
      return { ok: true };
    },
    ubolErr(reason) { errors.push(String(reason)); },
  });
  await handler();
  assert.equal(recoveryCount, 1);
  assert.deepEqual(errors, []);

  handler = buildHandler({
    isFullyInitialized: Promise.reject(new Error('initial startup failed')),
    async recoverStartupStateForPopup() {
      throw new Error('recovery failed');
    },
    ubolErr(reason) { errors.push(String(reason)); },
  });
  await handler();
  assert.deepEqual(errors, [ 'runtime.onStartup/Error: recovery failed' ]);
});

test('custom-filter restoration attempts every frame before reporting failures', async () => {
  const source = await readSource('js/background.js');
  const refreshSource = sourceBetween(
    source,
    'async function refreshRuntimeStateForTab',
    'async function refreshRuntimeStateForOpenTabsNow'
  );
  const loopSource = sourceBetween(
    refreshSource,
    'for ( const [ frameId, prepared ] of preparedByFrameId ) {',
    '\n        if ( filteringLevel === MODE_NONE ) {'
  );
  const executableLoopSource = loopSource.slice(
    0,
    loopSource.lastIndexOf('\n        }')
  );
  const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
  const runLoop = new AsyncFunction('deps', `
    const {
      executeRuntimeRefreshLane,
      executeRuntimeStopLane,
      frameTargetsFromIds,
      injectCustomFilters,
      isRuntimeRefreshTargetUnavailableError,
      preparedByFrameId,
      stagePreparedCustomFilterDetails,
      tabId,
      ubolErr,
    } = deps;
    const restorationFailures = [];
    ${executableLoopSource}
  `);
  const attempted = [];
  const staged = [];
  const restored = [];
  const preparedByFrameId = new Map([0, 1, 2].map(frameId => [
    frameId,
    {
      hostname: `frame-${frameId}.example`,
      documentId: `document-${frameId}`,
      details: { plainSelectors: [`.frame-${frameId}`], proceduralSelectors: [] },
    },
  ]));

  await assert.rejects(runLoop({
    async executeRuntimeRefreshLane(tabId, files, options) {
      assert.equal(tabId, 17);
      if (files.includes('/js/scripting/css-user.js')) {
        restored.push(options.frameTargets[0].frameId);
        if (options.frameTargets[0].frameId === 0) {
          throw new Error('forced first-frame restoration failure');
        }
      }
      return true;
    },
    async executeRuntimeStopLane(tabId, func, options) {
      assert.equal(tabId, 17);
      staged.push(options.frameTargets[0].frameId);
      return func(options.args[0]);
    },
    frameTargetsFromIds: ids => ids.map(frameId => ({
      frameId,
      documentId: `document-${frameId}`,
    })),
    async injectCustomFilters(tabId, frameId) {
      assert.equal(tabId, 17);
      attempted.push(frameId);
      if (frameId === 1) {
        throw new Error('Document with ID 11111111-1111-1111-1111-111111111111 was removed.');
      }
      return preparedByFrameId.get(frameId).details;
    },
    isRuntimeRefreshTargetUnavailableError: reason => /was removed/.test(reason.message),
    preparedByFrameId,
    stagePreparedCustomFilterDetails: details => details,
    tabId: 17,
    ubolErr: reason => assert.fail(`unexpected rollback error: ${reason}`),
  }), /custom cosmetic restoration was incomplete/);

  assert.deepEqual(attempted, [0, 1, 2]);
  assert.deepEqual(staged, [0, 2]);
  assert.deepEqual(restored, [0, 2]);
});

test('blob top documents retain origin identity for refresh and paywall candidacy', async () => {
  const source = await readSource('js/background.js');
  const classifierSource = sourceBetween(
    source,
    'const RUNTIME_REFRESH_TARGET_UNAVAILABLE_PATTERNS',
    'async function getRuntimeFrameStates'
  );
  const frameStateSource = sourceBetween(
    source,
    'async function getRuntimeFrameStates',
    'const hostnameMatchesRegistrationPatterns'
  );
  const buildHarness = new Function('deps', `
    const {
      browser,
      getFilteringMode,
      MAX_OPAQUE_CHILD_ORIGIN_PROBES,
      MODE_NONE,
      normalizeHttpHostname,
      OPAQUE_ORIGIN_PROBE_TIMEOUT_MS,
      OPEN_TAB_RUNTIME_REFRESH_CONCURRENCY,
    } = deps;
    ${classifierSource}
    ${frameStateSource}
    return { getRuntimeFrameStates, tabUrlMayHostExtensionRuntime };
  `);
  const blobUrl = [ 'blob:', testHttpsUrl('blob-origin.example'), 'uuid' ].join('');
  const seenHostnames = [];
  const harness = buildHarness({
    browser: {
      scripting: { async executeScript() { return []; } },
      webNavigation: {
        async getAllFrames() {
          return [{
            frameId: 0,
            parentFrameId: -1,
            documentId: 'blob-document',
            documentLifecycle: 'active',
            url: blobUrl,
          }];
        },
      },
    },
    async getFilteringMode(hostname) {
      seenHostnames.push(hostname);
      return 2;
    },
    MODE_NONE: 0,
    MAX_OPAQUE_CHILD_ORIGIN_PROBES: 16,
    OPAQUE_ORIGIN_PROBE_TIMEOUT_MS: 750,
    OPEN_TAB_RUNTIME_REFRESH_CONCURRENCY: 4,
    normalizeHttpHostname(value) {
      try {
        const url = new URL(value);
        return /^https?:$/.test(url.protocol) ? url.hostname : '';
      } catch {
        return '';
      }
    },
  });

  assert.equal(harness.tabUrlMayHostExtensionRuntime(blobUrl), true);
  const frames = await harness.getRuntimeFrameStates(5, blobUrl);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].hostname, 'blob-origin.example');
  assert.equal(frames[0].documentId, 'blob-document');
  assert.deepEqual(seenHostnames, ['blob-origin.example']);
});

test('opaque top documents inherit only a proven initiator and protected pages are skipped', async () => {
  const source = await readSource('js/background.js');
  const classifierSource = sourceBetween(
    source,
    'const RUNTIME_REFRESH_TARGET_UNAVAILABLE_PATTERNS',
    'async function getRuntimeFrameStates'
  );
  const frameStateSource = sourceBetween(
    source,
    'async function getRuntimeFrameStates',
    'const hostnameMatchesRegistrationPatterns'
  );
  const buildHarness = new Function('deps', `
    const {
      browser,
      getFilteringMode,
      MAX_OPAQUE_CHILD_ORIGIN_PROBES,
      MODE_NONE,
      normalizeHttpHostname,
      OPAQUE_ORIGIN_PROBE_TIMEOUT_MS,
      OPEN_TAB_RUNTIME_REFRESH_CONCURRENCY,
    } = deps;
    const executeRuntimeScriptWithTimeout = details =>
      browser.scripting.executeScript(details);
    ${classifierSource}
    ${frameStateSource}
    return { getRuntimeFrameStates, tabUrlMayHostExtensionRuntime };
  `);
  let currentUrl = 'about:blank';
  let originCandidates = [testHttpsUrl('allowed-initiator.example')];
  const seenHostnames = [];
  const harness = buildHarness({
    browser: {
      extension: {
        async isAllowedFileSchemeAccess() { return false; },
      },
      scripting: {
        async executeScript() {
          return [{ result: originCandidates }];
        },
      },
      webNavigation: {
        async getAllFrames() {
          return [{
            frameId: 0,
            parentFrameId: -1,
            documentId: 'opaque-document',
            documentLifecycle: 'active',
            url: currentUrl,
          }];
        },
      },
    },
    async getFilteringMode(hostname) {
      seenHostnames.push(hostname);
      return hostname === 'allowed-initiator.example' ? 0 : 3;
    },
    MODE_NONE: 0,
    MAX_OPAQUE_CHILD_ORIGIN_PROBES: 16,
    OPAQUE_ORIGIN_PROBE_TIMEOUT_MS: 750,
    OPEN_TAB_RUNTIME_REFRESH_CONCURRENCY: 4,
    normalizeHttpHostname(value) {
      try {
        const parsed = new URL(value);
        return /^https?:$/.test(parsed.protocol) ? parsed.hostname : '';
      } catch {
        return '';
      }
    },
  });

  const inherited = await harness.getRuntimeFrameStates(5, currentUrl);
  assert.equal(inherited.length, 1);
  assert.equal(inherited[0].hostname, 'allowed-initiator.example');
  assert.equal(inherited[0].filteringLevel, 0);

  currentUrl = 'blob:null/opaque-id';
  originCandidates = ['blob:null/opaque-id', 'about:blank'];
  const unresolved = await harness.getRuntimeFrameStates(5, currentUrl);
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].hostname, '');
  assert.equal(unresolved[0].filteringLevel, 0);
  assert.deepEqual(seenHostnames, ['allowed-initiator.example']);

  const refreshSource = sourceBetween(
    source,
    'async function refreshRuntimeStateForTab',
    'async function recoverRuntimeTabFailure'
  );
  const buildRefreshHarness = new Function('deps', `
    const {
      browser,
      getActiveTopDocumentIdentity,
      getRuntimeFrameStates,
      isUnprovenOpaqueTopRuntimeUrl,
      runtimeTabLifecycleMatches,
    } = deps;
    ${refreshSource}
    return { refreshRuntimeStateForTab };
  `);
  let unprovenOpaque = true;
  const refreshHarness = buildRefreshHarness({
    browser: { scripting: { executeScript() {} } },
    getActiveTopDocumentIdentity: async tabId => ({
      tabId,
      documentId: 'opaque-document',
      url: currentUrl,
    }),
    getRuntimeFrameStates: async () => [],
    isUnprovenOpaqueTopRuntimeUrl: () => unprovenOpaque,
    runtimeTabLifecycleMatches: () => true,
  });
  assert.deepEqual(
    await refreshHarness.refreshRuntimeStateForTab(5, 0, { url: currentUrl }),
    {
      ok: true,
      skipped: 'unproven_opaque_document',
      topDocumentId: 'opaque-document',
    }
  );
  unprovenOpaque = false;
  await assert.rejects(
    refreshHarness.refreshRuntimeStateForTab(
      5,
      0,
      { url: testHttpsUrl('addressable.example') }
    ),
    /runtime refresh top document unavailable/
  );

  const originReaderSource = sourceBetween(
    source,
    'function readRuntimeDocumentOriginCandidates',
    'async function getRuntimeFrameStates'
  );
  const originContext = {
    URL,
    location: { href: 'about:blank', origin: 'null', ancestorOrigins: [] },
    document: {
      baseURI: testHttpsUrl('hostile-base.example'),
      referrer: testHttpsUrl('real-initiator.example'),
    },
  };
  vm.createContext(originContext);
  vm.runInContext(
    `${originReaderSource}\n` +
      'globalThis.originCandidates = readRuntimeDocumentOriginCandidates();',
    originContext
  );
  assert.deepEqual(
    Array.from(originContext.originCandidates),
    [testHttpsUrl('real-initiator.example').replace(/\/$/, '')]
  );
  originContext.location.href = `data:text/html,${'x'.repeat(2_000_000)}`;
  originContext.document.referrer = '';
  vm.runInContext(
    'globalThis.originCandidates = readRuntimeDocumentOriginCandidates();',
    originContext
  );
  assert.deepEqual(Array.from(originContext.originCandidates), []);

  assert.equal(
    harness.tabUrlMayHostExtensionRuntime(
      testHttpsUrl('chromewebstore.google.com')
    ),
    false
  );
  assert.equal(
    harness.tabUrlMayHostExtensionRuntime('file:///tmp/example.html'),
    false
  );
  assert.equal(
    harness.tabUrlMayHostExtensionRuntime('file:///tmp/example.html', true),
    true
  );

  const fileHarness = buildHarness({
    browser: {
      extension: {
        async isAllowedFileSchemeAccess() { return true; },
      },
      scripting: { async executeScript() { return []; } },
      webNavigation: {
        async getAllFrames() {
          return [
            {
              frameId: 0,
              parentFrameId: -1,
              documentId: 'file-top',
              documentLifecycle: 'active',
              url: 'file:///tmp/top.html',
            },
            {
              frameId: 2,
              parentFrameId: 0,
              documentId: 'file-child',
              documentLifecycle: 'active',
              url: 'file:///tmp/child.html',
            },
          ];
        },
      },
    },
    getFilteringMode: async hostname => hostname === 'all-urls' ? 2 : 0,
    MODE_NONE: 0,
    OPEN_TAB_RUNTIME_REFRESH_CONCURRENCY: 4,
    normalizeHttpHostname: () => '',
  });
  const fileFrames = await fileHarness.getRuntimeFrameStates(
    7,
    'file:///tmp/top.html'
  );
  assert.deepEqual(
    fileFrames.map(frame => [frame.frameId, frame.hostname, frame.filteringLevel]),
    [[0, 'all-urls', 2], [2, 'all-urls', 2]]
  );

  let activeProbes = 0;
  let maxActiveProbes = 0;
  const opaqueChildren = Array.from({ length: 10 }, (_, index) => ({
    frameId: index + 1,
    parentFrameId: 0,
    documentId: `opaque-child-${index + 1}`,
    documentLifecycle: 'active',
    url: 'about:blank',
  }));
  const childHarness = buildHarness({
    browser: {
      scripting: {
        async executeScript(details) {
          activeProbes += 1;
          maxActiveProbes = Math.max(maxActiveProbes, activeProbes);
          await new Promise(resolve => setImmediate(resolve));
          activeProbes -= 1;
          const documentId = details.target.documentIds[0];
          return [{
            result: [testHttpsUrl(`${documentId}.initiator.example`)],
          }];
        },
      },
      webNavigation: {
        async getAllFrames() {
          return [{
            frameId: 0,
            parentFrameId: -1,
            documentId: 'parent-document',
            documentLifecycle: 'active',
            url: testHttpsUrl('parent.example'),
          }, ...opaqueChildren];
        },
      },
    },
    getFilteringMode: async hostname =>
      hostname.endsWith('.initiator.example') ? 1 : 3,
    MODE_NONE: 0,
    normalizeHttpHostname(value) {
      try {
        const parsed = new URL(value);
        return /^https?:$/.test(parsed.protocol) ? parsed.hostname : '';
      } catch {
        return '';
      }
    },
    OPEN_TAB_RUNTIME_REFRESH_CONCURRENCY: 4,
  });
  const childFrames = await childHarness.getRuntimeFrameStates(
    8,
    testHttpsUrl('parent.example')
  );
  assert.equal(childFrames.length, 11);
  assert.equal(
    childFrames.find(frame => frame.frameId === 1).hostname,
    'opaque-child-1.initiator.example'
  );
  assert.equal(childFrames.find(frame => frame.frameId === 1).filteringLevel, 1);
  assert.equal(maxActiveProbes, 4);
});

test('live cosmetic and picker identity ignores hostile base URLs and preserves proven blob origins', async () => {
  const cssUserSource = await readSource('js/scripting/css-user.js');
  const remoteSource = await readSource('js/scripting/remote-cosmetics.js');
  const overlaySource = await readSource('js/scripting/tool-overlay.js');
  const iifeDeclaration = (source, declaration) => {
    const start = source.indexOf(declaration);
    assert.notEqual(start, -1, `missing ${declaration}`);
    const end = source.indexOf('})();', start);
    assert.notEqual(end, -1, `unterminated ${declaration}`);
    return source.slice(start, end + 5);
  };
  const runIdentity = (declaration, resultName, {
    href = 'about:blank',
    origin = 'null',
    referrer = testHttpsUrl('real-initiator.example'),
  } = {}) => {
    const context = {
      URL,
      document: {
        baseURI: testHttpsUrl('hostile-base.example'),
        location: { href, origin, ancestorOrigins: [] },
        referrer,
      },
      location: { href, origin, ancestorOrigins: [] },
    };
    context.self = context;
    vm.createContext(context);
    vm.runInContext(
      `${declaration}\nglobalThis.identityResult = ${resultName};`,
      context
    );
    return context.identityResult;
  };

  const cssIdentity = iifeDeclaration(
    cssUserSource,
    'const effectiveHostname = (() => {'
  );
  const remoteIdentity = iifeDeclaration(
    remoteSource,
    'const hostname = (() => {'
  );
  const overlayIdentity = iifeDeclaration(
    overlaySource,
    'const runtimeDocumentURL = (() => {'
  );
  assert.equal(runIdentity(cssIdentity, 'effectiveHostname'), 'real-initiator.example');
  assert.equal(runIdentity(remoteIdentity, 'hostname'), 'real-initiator.example');
  assert.equal(
    runIdentity(overlayIdentity, 'runtimeDocumentURL').hostname,
    'real-initiator.example'
  );
  const blobState = {
    href: ['blob:https', '://', 'blob-owner.example', '/1234'].join(''),
    origin: testHttpsUrl('blob-owner.example').replace(/\/$/, ''),
    referrer: '',
  };
  assert.equal(
    runIdentity(cssIdentity, 'effectiveHostname', blobState),
    'blob-owner.example'
  );
  assert.equal(
    runIdentity(remoteIdentity, 'hostname', blobState),
    'blob-owner.example'
  );
  assert.equal(
    runIdentity(overlayIdentity, 'runtimeDocumentURL', blobState).hostname,
    'blob-owner.example'
  );
  assert.doesNotMatch(cssIdentity, /baseURI/);
  assert.doesNotMatch(remoteIdentity, /baseURI/);
  assert.doesNotMatch(overlayIdentity, /baseURI/);
});

test('reload markers and deferred document intent are durable and document-bound', async () => {
  const source = await readSource('js/background.js');
  const reloadSource = sourceBetween(
    source,
    'const ensureReloadNeededTabsHydrated',
    'const deferredRuntimeDocumentKey'
  );
  const deferredSource = sourceBetween(
    source,
    'const deferredRuntimeDocumentKey',
    'const pruneDurableRuntimeLifecycleState'
  );
  const stored = {
    reloadNeededTabsV1: {
      12: {
        reason: 'legacy_cosmetic_runtime',
        documentId: 'legacy-document',
        updatedAt: 10,
      },
    },
    deferredRuntimeDocumentsV1: [{
      tabId: 12,
      topDocumentId: 'legacy-document',
      operation: 'refresh',
      desiredFingerprint: 'fingerprint-v2',
      updatedAt: 11,
      waitForUnfreeze: true,
    }],
  };
  const browser = {
    storage: {
      local: {
        async get(key) { return { [key]: stored[key] }; },
        async set(patch) { Object.assign(stored, patch); },
        async remove(key) { delete stored[key]; },
      },
    },
  };
  const buildHarness = new Function('browser', `
    const reloadNeededTabs = new Map();
    const RELOAD_NEEDED_TABS_STORAGE_KEY = 'reloadNeededTabsV1';
    const RELOAD_NEEDED_STORAGE_SCHEMA = 2;
    const MAX_RELOAD_NEEDED_DOCUMENTS_PER_TAB = 8;
    const MAX_RELOAD_SAFE_DOCUMENTS_PER_TAB = 16;
    const RELOAD_SAFE_DOCUMENTS_SESSION_KEY_PREFIX = 'reloadSafeDocumentsV1:';
    const reloadSafeDocumentsSessionKey = tabId =>
      RELOAD_SAFE_DOCUMENTS_SESSION_KEY_PREFIX + tabId;
    const persistReloadSafeDocumentsForTab = async () => true;
    const createReloadNeededTabRecord = () => ({
      documents: new Map(), safeDocumentIds: new Set(),
      wildcardReason: '', wildcardUpdatedAt: 0,
      wildcardAllDocuments: false, wildcardReloadHint: null, revision: 0,
    });
    const pruneReloadNeededTabRecord = record => {
      const documents = Array.from(record.documents.values())
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_RELOAD_NEEDED_DOCUMENTS_PER_TAB);
      record.documents = new Map(documents.map(entry => [entry.documentId, entry]));
      record.safeDocumentIds = new Set(
        Array.from(record.safeDocumentIds).slice(-MAX_RELOAD_SAFE_DOCUMENTS_PER_TAB)
      );
    };
    let reloadNeededTabsHydrationPromise;
    let reloadNeededTabsPersistenceTail = Promise.resolve();
    const DEFERRED_RUNTIME_DOCUMENTS_STORAGE_KEY = 'deferredRuntimeDocumentsV1';
    const deferredRuntimeDocuments = new Map();
    const deferredFrozenRuntimeTabIds = new Set();
    let deferredRuntimeDocumentsHydrationPromise;
    let deferredRuntimeDocumentsPersistenceTail = Promise.resolve();
    const MAX_AUTOMATIC_DEFERRED_REFRESH_FAILURES = 3;
    const DEFERRED_RUNTIME_RETRY_DELAY_MINUTES = 1;
    const DEFERRED_RUNTIME_RETRY_DELAYS_MINUTES = [1, 5, 15, 60];
    const markReloadNeededForTab = async () => false;
    const ubolErr = () => {};
    const runtimeTabLifecycleMatches = () => true;
    ${reloadSource}
    ${deferredSource}
    return {
      clearDeferredRuntimeDocuments,
      deferRuntimeDocuments,
      deferredFrozenRuntimeTabIds,
      deferredRuntimeDocuments,
      ensureDeferredRuntimeDocumentsHydrated,
      ensureReloadNeededTabsHydrated,
      reloadNeededTabs,
    };
  `);
  const harness = buildHarness(browser);
  await Promise.all([
    harness.ensureReloadNeededTabsHydrated(),
    harness.ensureDeferredRuntimeDocumentsHydrated(),
  ]);

  assert.deepEqual(harness.reloadNeededTabs.get(12).documents.get('legacy-document'), {
    reason: 'legacy_cosmetic_runtime',
    documentId: 'legacy-document',
    updatedAt: 10,
    active: true,
  });
  assert.equal(harness.deferredRuntimeDocuments.size, 1);
  assert.deepEqual(Array.from(harness.deferredFrozenRuntimeTabIds), [12]);
  await harness.deferRuntimeDocuments([{
    tabId: 12,
    topDocumentId: 'legacy-document',
    operation: 'stop',
    desiredFingerprint: '',
  }]);
  assert.equal(stored.deferredRuntimeDocumentsV1.length, 1);
  assert.equal(stored.deferredRuntimeDocumentsV1[0].operation, 'stop');
  assert.equal(harness.deferredRuntimeDocuments.size, 1);
  await harness.clearDeferredRuntimeDocuments({ tabId: 12, operation: 'stop' });
  assert.equal(harness.deferredRuntimeDocuments.size, 0);
  assert.equal(stored.deferredRuntimeDocumentsV1, undefined);
  assert.deepEqual(Array.from(harness.deferredFrozenRuntimeTabIds), []);
  assert.match(source, /markReloadNeededForTab = async \([\s\S]*documentId = ''/);
  assert.match(source, /currentDocumentId[\s\S]*forwardBack[\s\S]*outermostPrerender/);
  assert.match(
    source,
    /forwardBack \|\| stalePrerender[\s\S]*record\.safeDocumentIds\.has\(currentDocumentId\)/
  );
});

test('startup pruning cannot delete a newer navigation ledger generation', async () => {
  const source = await readSource('js/background.js');
  const reloadSource = sourceBetween(
    source,
    'const ensureReloadNeededTabsHydrated',
    'const deferredRuntimeDocumentKey'
  );
  const deferredSource = sourceBetween(
    source,
    'const deferredRuntimeDocumentKey',
    'const pruneDurableRuntimeLifecycleState'
  );
  const pruneSource = sourceBetween(
    source,
    'const pruneDurableRuntimeLifecycleState',
    'const getReloadNeededState'
  );
  const stored = {
    reloadNeededTabsV1: {
      12: {
        reason: 'legacy_cosmetic_runtime',
        documentId: 'document-A',
        updatedAt: 10,
      },
    },
    deferredRuntimeDocumentsV1: [{
      tabId: 12,
      topDocumentId: 'document-A',
      operation: 'refresh',
      desiredFingerprint: 'fingerprint-A',
      updatedAt: 10,
    }],
  };
  let identityStarted;
  const identityStartedPromise = new Promise(resolve => { identityStarted = resolve; });
  let resolveIdentity;
  const identityGate = new Promise(resolve => { resolveIdentity = resolve; });
  let identityCallCount = 0;
  let nextIdentity;
  const browser = {
    storage: {
      local: {
        async get(key) { return { [key]: stored[key] }; },
        async set(patch) { Object.assign(stored, structuredClone(patch)); },
        async remove(key) { delete stored[key]; },
      },
    },
    tabs: {
      async query() {
        return [{
          id: 12,
          discarded: false,
          frozen: false,
          url: testHttpsUrl('document-a.example'),
        }];
      },
    },
  };
  const buildHarness = new Function('deps', `
    const {
      browser,
      getActiveTopDocumentIdentity,
      isRuntimeRefreshTargetUnavailableError,
      shouldReloadForFrameUrls,
    } = deps;
    const reloadNeededTabs = new Map();
    const RELOAD_NEEDED_TABS_STORAGE_KEY = 'reloadNeededTabsV1';
    const RELOAD_NEEDED_STORAGE_SCHEMA = 2;
    const MAX_RELOAD_NEEDED_DOCUMENTS_PER_TAB = 8;
    const MAX_RELOAD_SAFE_DOCUMENTS_PER_TAB = 16;
    const RELOAD_SAFE_DOCUMENTS_SESSION_KEY_PREFIX = 'reloadSafeDocumentsV1:';
    const RELOAD_WILDCARD_TTL_MS = 24 * 60 * 60 * 1000;
    const reloadSafeDocumentsSessionKey = tabId =>
      RELOAD_SAFE_DOCUMENTS_SESSION_KEY_PREFIX + tabId;
    const persistReloadSafeDocumentsForTab = async () => true;
    const createReloadNeededTabRecord = () => ({
      documents: new Map(), safeDocumentIds: new Set(),
      wildcardReason: '', wildcardUpdatedAt: 0,
      wildcardAllDocuments: false, wildcardReloadHint: null, revision: 0,
    });
    const pruneReloadNeededTabRecord = record => {
      const documents = Array.from(record.documents.values())
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_RELOAD_NEEDED_DOCUMENTS_PER_TAB);
      record.documents = new Map(documents.map(entry => [entry.documentId, entry]));
      record.safeDocumentIds = new Set(
        Array.from(record.safeDocumentIds).slice(-MAX_RELOAD_SAFE_DOCUMENTS_PER_TAB)
      );
    };
    let reloadNeededTabsHydrationPromise;
    let reloadNeededTabsPersistenceTail = Promise.resolve();
    const DEFERRED_RUNTIME_DOCUMENTS_STORAGE_KEY = 'deferredRuntimeDocumentsV1';
    const deferredRuntimeDocuments = new Map();
    const deferredFrozenRuntimeTabIds = new Set();
    let deferredRuntimeDocumentsHydrationPromise;
    let deferredRuntimeDocumentsPersistenceTail = Promise.resolve();
    const MAX_AUTOMATIC_DEFERRED_REFRESH_FAILURES = 3;
    const DEFERRED_RUNTIME_RETRY_DELAY_MINUTES = 1;
    const DEFERRED_RUNTIME_RETRY_DELAYS_MINUTES = [1, 5, 15, 60];
    const markReloadNeededForTab = async () => false;
    const ubolErr = () => {};
    const runtimeTabLifecycleMatches = () => true;
    ${reloadSource}
    ${deferredSource}
    ${pruneSource}
    return {
      deferRuntimeDocuments,
      deferredRuntimeDocuments,
      ensureDeferredRuntimeDocumentsHydrated,
      ensureReloadNeededTabsHydrated,
      pruneDurableRuntimeLifecycleState,
      reloadNeededTabs,
    };
  `);
  const harness = buildHarness({
    browser,
    getActiveTopDocumentIdentity: async () => {
      if (identityCallCount++ === 0) {
        identityStarted();
        return identityGate;
      }
      return nextIdentity;
    },
    isRuntimeRefreshTargetUnavailableError: () => false,
    shouldReloadForFrameUrls,
  });
  await Promise.all([
    harness.ensureReloadNeededTabsHydrated(),
    harness.ensureDeferredRuntimeDocumentsHydrated(),
  ]);
  const pruning = harness.pruneDurableRuntimeLifecycleState();
  await identityStartedPromise;

  const newerReloadEntry = {
    reason: 'legacy_cosmetic_runtime',
    documentId: 'document-B',
    updatedAt: 11,
  };
  harness.reloadNeededTabs.set(12, newerReloadEntry);
  await harness.deferRuntimeDocuments([{
    tabId: 12,
    topDocumentId: 'document-B',
    operation: 'refresh',
    desiredFingerprint: 'fingerprint-B',
  }]);
  resolveIdentity({
    tabId: 12,
    documentId: 'document-A',
    url: testHttpsUrl('document-a.example'),
  });
  await pruning;

  assert.equal(harness.reloadNeededTabs.get(12), newerReloadEntry);
  assert.equal(harness.deferredRuntimeDocuments.size, 1);
  assert.equal(
    Array.from(harness.deferredRuntimeDocuments.values())[0].topDocumentId,
    'document-B'
  );

  // Browser restart clears storage.session safe IDs but keeps the local
  // wildcard. A host-scoped hint must not become an exact reload notice on an
  // unrelated active page merely because that session evidence was reset.
  const scopedRecord = {
    documents: new Map(),
    safeDocumentIds: new Set(),
    wildcardReason: 'remoteScriptletHotfix',
    wildcardUpdatedAt: Date.now(),
    wildcardAllDocuments: false,
    wildcardReloadHint: {
      before: [{
        id: 'remote-scriptlet.restart-test',
        matches: ['*://*.target.example/*'],
        excludeMatches: [],
      }],
      after: [],
    },
    revision: 1,
  };
  harness.reloadNeededTabs.set(12, scopedRecord);
  nextIdentity = {
    tabId: 12,
    documentId: 'document-C',
    url: testHttpsUrl('unrelated.example'),
    frameUrls: [testHttpsUrl('unrelated.example')],
  };
  await harness.pruneDurableRuntimeLifecycleState();
  assert.equal(scopedRecord.documents.size, 0);
  assert.equal(scopedRecord.safeDocumentIds.has('document-C'), true);

  // The top page can be unrelated while a live child frame is in scope. The
  // already-enumerated bounded frame URL set must still require a reload.
  scopedRecord.documents.clear();
  scopedRecord.safeDocumentIds.clear();
  scopedRecord.revision += 1;
  nextIdentity = {
    tabId: 12,
    documentId: 'document-D',
    url: testHttpsUrl('unrelated.example'),
    frameUrls: [
      testHttpsUrl('unrelated.example'),
      testHttpsUrl('child.target.example'),
    ],
  };
  await harness.pruneDurableRuntimeLifecycleState();
  assert.equal(
    scopedRecord.documents.get('document-D')?.reason,
    'remoteScriptletHotfix'
  );

  // An all-document wildcard is deliberately stronger and remains unchanged.
  scopedRecord.documents.clear();
  scopedRecord.safeDocumentIds.clear();
  scopedRecord.wildcardAllDocuments = true;
  scopedRecord.wildcardReloadHint = null;
  scopedRecord.revision += 1;
  nextIdentity = {
    tabId: 12,
    documentId: 'document-E',
    url: testHttpsUrl('unrelated.example'),
    frameUrls: [testHttpsUrl('unrelated.example')],
  };
  await harness.pruneDurableRuntimeLifecycleState();
  assert.equal(
    scopedRecord.documents.get('document-E')?.reason,
    'remoteScriptletHotfix'
  );
});

test('startup reload-hint classification checks every live child-frame URL', async () => {
  const source = await readSource('js/background.js');
  const identitySource = sourceBetween(
    source,
    'async function getActiveTopDocumentIdentity',
    'const clearReloadNeededStateForTab'
  );
  const buildHarness = new Function('browser', `
    ${identitySource}
    return getActiveTopDocumentIdentity;
  `);
  const frames = [{
    frameId: 0,
    documentId: 'document-many-frames',
    documentLifecycle: 'active',
    url: testHttpsUrl('unrelated.example'),
  }];
  for (let i = 1; i <= 40; i += 1) {
    frames.push({
      frameId: i,
      documentId: `child-${i}`,
      documentLifecycle: 'active',
      url: testHttpsUrl(
        i === 40 ? 'late.target.example' : `noise-${i}.example`
      ),
    });
  }
  const getIdentity = buildHarness({
    webNavigation: {
      async getAllFrames() { return frames; },
    },
  });
  const identity = await getIdentity(12);
  assert.equal(identity.frameUrls.length, 41);
  assert.equal(shouldReloadForFrameUrls(identity.frameUrls, {
    before: [{
      id: 'remote-scriptlet.many-frames',
      matches: ['*://*.target.example/*'],
      excludeMatches: [],
    }],
    after: [],
  }), true);
});

test('session-safe reload evidence cannot be overwritten by an older storage write', async () => {
  const source = await readSource('js/background.js');
  const persistenceSource = sourceBetween(
    source,
    'const persistReloadSafeDocumentsForTab',
    'const readSessionPrerenderRecords'
  );
  let firstSetStarted;
  const firstSetStartedPromise = new Promise(resolve => {
    firstSetStarted = resolve;
  });
  let releaseFirstSet;
  const firstSetGate = new Promise(resolve => { releaseFirstSet = resolve; });
  let setCalls = 0;
  let stored;
  const browser = {
    storage: {
      session: {
        async set(patch) {
          setCalls += 1;
          const snapshot = structuredClone(patch);
          if (setCalls === 1) {
            firstSetStarted();
            await firstSetGate;
          }
          stored = snapshot;
        },
        async remove() { stored = undefined; },
      },
    },
  };
  const buildHarness = new Function('deps', `
    const {
      browser,
      reloadSafeDocumentsPersistenceTails,
      reloadSafeDocumentsSessionKey,
      MAX_RELOAD_SAFE_DOCUMENTS_PER_TAB,
    } = deps;
    ${persistenceSource}
    return persistReloadSafeDocumentsForTab;
  `);
  const persistSafe = buildHarness({
    browser,
    reloadSafeDocumentsPersistenceTails: new Map(),
    reloadSafeDocumentsSessionKey: tabId => `safe:${tabId}`,
    MAX_RELOAD_SAFE_DOCUMENTS_PER_TAB: 16,
  });
  const record = {
    wildcardReason: 'remoteScriptletHotfix',
    wildcardUpdatedAt: 100,
    safeDocumentIds: new Set(['document-A']),
  };
  const first = persistSafe(12, record);
  await firstSetStartedPromise;
  record.safeDocumentIds.add('document-B');
  const second = persistSafe(12, record);
  await Promise.resolve();
  assert.equal(setCalls, 1);
  releaseFirstSet();
  await Promise.all([first, second]);
  assert.deepEqual(stored['safe:12'].documentIds, [
    'document-A',
    'document-B',
  ]);
});

test('a fresh same-scope scriptlet update invalidates prior safe documents', async () => {
  const source = await readSource('js/background.js');
  const wildcardSource = sourceBetween(
    source,
    'const markReloadNeededWildcardForTabs = async (',
    'const getTabFrameSnapshot'
  );
  const reloadHint = {
    before: [],
    after: [{
      id: 'remote-scriptlet.same-scope',
      matches: ['*://*.target.example/*'],
      excludeMatches: [],
    }],
  };
  const record = {
    documents: new Map(),
    safeDocumentIds: new Set(['safe-after-first-update']),
    wildcardReason: 'remoteScriptletHotfix',
    wildcardUpdatedAt: 100,
    wildcardAllDocuments: false,
    wildcardReloadHint: structuredClone(reloadHint),
    revision: 1,
  };
  const reloadNeededTabs = new Map([[12, record]]);
  const buildHarness = new Function('deps', `
    const {
      ensureReloadNeededTabsHydrated,
      getOrCreateReloadNeededTabRecord,
      mergeRemoteScriptletReloadHints,
      persistReloadNeededTabs,
      persistReloadSafeDocumentsForTab,
      reloadNeededTabs,
      REMOTE_SCRIPTLET_RELOAD_REASON,
    } = deps;
    ${wildcardSource}
    return markReloadNeededWildcardForTabs;
  `);
  const markWildcard = buildHarness({
    ensureReloadNeededTabsHydrated: async () => true,
    getOrCreateReloadNeededTabRecord: tabId => reloadNeededTabs.get(tabId),
    mergeRemoteScriptletReloadHints,
    persistReloadNeededTabs: async () => true,
    persistReloadSafeDocumentsForTab: async () => true,
    reloadNeededTabs,
    REMOTE_SCRIPTLET_RELOAD_REASON: 'remoteScriptletHotfix',
  });

  assert.equal(await markWildcard(
    [12],
    'remoteScriptletHotfix',
    { allDocuments: false, reloadHint }
  ), false);
  assert.equal(record.safeDocumentIds.has('safe-after-first-update'), true);

  assert.equal(await markWildcard(
    [12],
    'remoteScriptletHotfix',
    { allDocuments: false, reloadHint, refresh: true }
  ), true);
  assert.equal(record.safeDocumentIds.size, 0);
  assert.ok(record.wildcardUpdatedAt > 100);
});

test('late reload-marker persistence preserves BFCache and newer navigation state', async () => {
  const source = await readSource('js/background.js');
  const markerSource = sourceBetween(
    source,
    'const markReloadNeededForTab = async (',
    'const markReloadNeededWildcardForTabs'
  );
  const reloadNeededTabs = new Map();
  let generation = 1;
  let releasePersistence;
  let persistenceStarted;
  const persistenceStartedPromise = new Promise(resolve => {
    persistenceStarted = resolve;
  });
  const persistenceGate = new Promise(resolve => {
    releasePersistence = resolve;
  });
  const createRecord = () => ({
    documents: new Map(),
    safeDocumentIds: new Set(),
    wildcardReason: '',
    wildcardUpdatedAt: 0,
    wildcardAllDocuments: false,
    wildcardReloadHint: null,
    revision: 0,
  });
  const buildHarness = new Function('deps', `
    const {
      reloadNeededTabs,
      createRecord,
      getGeneration,
      persistReloadNeededTabs,
    } = deps;
    const getRuntimeTabLifecycleGeneration = () => getGeneration();
    const runtimeTabLifecycleMatches = (_tabId, expected) =>
      getGeneration() === expected;
    const ensureReloadNeededTabsHydrated = async () => true;
    const getActiveTopDocumentIdentity = async tabId => ({
      tabId,
      documentId: 'document-A',
      url: '${testHttpsUrl('document-a.example')}',
    });
    const isRuntimeRefreshTargetUnavailableError = () => false;
    const getOrCreateReloadNeededTabRecord = tabId => {
      let record = reloadNeededTabs.get(tabId);
      if (record === undefined) {
        record = createRecord();
        reloadNeededTabs.set(tabId, record);
      }
      return record;
    };
    const pruneReloadNeededTabRecord = () => {};
    const persistReloadSafeDocumentsForTab = async () => true;
    const refreshReloadNeededBadgeForTab = async () => true;
    ${markerSource}
    return { markReloadNeededForTab };
  `);
  const harness = buildHarness({
    reloadNeededTabs,
    createRecord,
    getGeneration: () => generation,
    persistReloadNeededTabs: async () => {
      persistenceStarted();
      await persistenceGate;
      return true;
    },
  });

  const marking = harness.markReloadNeededForTab(
    12,
    'irreversible_custom_procedural',
    'document-A'
  );
  await persistenceStartedPromise;

  // A normal navigation commits while the old marker's durable write is
  // still settling. Its lifecycle pass mutates the same tab record: the old
  // document remains protected for BFCache and the new document is safe.
  generation = 2;
  const sharedRecord = reloadNeededTabs.get(12);
  sharedRecord.documents.get('document-A').active = false;
  sharedRecord.safeDocumentIds.add('document-B');
  releasePersistence();

  assert.equal(await marking, true);
  assert.equal(reloadNeededTabs.get(12), sharedRecord);
  assert.equal(
    sharedRecord.documents.get('document-A').reason,
    'irreversible_custom_procedural'
  );
  assert.equal(sharedRecord.wildcardReason, 'irreversible_custom_procedural');
  assert.equal(sharedRecord.safeDocumentIds.has('document-B'), true);
});

test('late content-script mutation re-marks a document loaded during uncertainty', async () => {
  const source = await readSource('js/background.js');
  const helperSource = sourceBetween(
    source,
    'const contentRegistrationResultIsUncertain',
    'function scheduleUncertainContentRegistrationReconciliation'
  );
  const schedulerSource = sourceBetween(
    source,
    'function scheduleUncertainContentRegistrationReconciliation',
    'async function syncInjectablesAndRefreshTabsNow'
  );
  const buildHarness = new Function('deps', `
    const {
      localRemove,
      markTabsForRemoteScriptletReload,
      PENDING_REMOTE_SCRIPTLET_RELOAD_HINT_KEY,
    } = deps;
    ${helperSource}
    return {
      applyContentRegistrationReloadHint,
      contentRegistrationResultIsVerified,
    };
  `);
  let currentDocumentId = 'document-before-timeout';
  const markedDocumentIds = [];
  let acknowledgeCount = 0;
  const harness = buildHarness({
    PENDING_REMOTE_SCRIPTLET_RELOAD_HINT_KEY: 'pendingReloadHint',
    async markTabsForRemoteScriptletReload() {
      markedDocumentIds.push(currentDocumentId);
    },
    async localRemove(key) {
      assert.equal(key, 'pendingReloadHint');
      acknowledgeCount += 1;
    },
  });
  const reloadHint = {
    before: [{
      id: 'remote-scriptlet.late-removal',
      matches: ['*://*.target.example/*'],
      excludeMatches: [],
    }],
    after: [],
  };

  const uncertain = await harness.applyContentRegistrationReloadHint(
    { ok: false, uncertain: true },
    reloadHint
  );
  assert.deepEqual(uncertain, { marked: true, acknowledged: false });
  assert.equal(acknowledgeCount, 0);

  // A reload can occur while Chrome's timed-out unregister is still live, so
  // the old registration may inject into this newer document before settling.
  currentDocumentId = 'document-loaded-before-late-unregister';
  const reconciled = await harness.applyContentRegistrationReloadHint(
    { ok: true, uncertain: false },
    reloadHint
  );
  assert.deepEqual(reconciled, { marked: true, acknowledged: true });
  assert.deepEqual(markedDocumentIds, [
    'document-before-timeout',
    'document-loaded-before-late-unregister',
  ]);
  assert.equal(acknowledgeCount, 1);
  assert.equal(
    harness.contentRegistrationResultIsVerified({ ok: false, uncertain: false }),
    false
  );
  assert.match(
    schedulerSource,
    /await waitForTimedOutRegistrationOperations\(\);[\s\S]*syncInjectablesAndRefreshTabs\(\{[\s\S]*runtimeOnly: false,[\s\S]*refreshOpenTabs: true/
  );
  assert.doesNotMatch(schedulerSource, /for \(;;\)/);
});

test('unchanged custom filters do not trigger unrelated full-page rebuilds', async () => {
  const source = await readSource('js/background.js');
  const syncSource = sourceBetween(
    source,
    'async function syncInjectablesAndRefreshTabs',
    'setAdminRuntimeReconciler'
  );

  assert.match(
    syncSource,
    /customRuntimeVersionMigrationRequired =[\s\S]*customFilterCount !== 0[\s\S]*persistedInjectableRuntimeState\?\.version !== getCurrentVersion\(\)/
  );
  assert.match(
    syncSource,
    /refreshCustomFilters =[\s\S]*isDurableDirtyMarker\(sandboxLiveStateDirty\)[\s\S]*sandboxAppliedRevision !== sandboxRevision[\s\S]*customRuntimeVersionMigrationRequired/
  );
  assert.doesNotMatch(
    syncSource,
    /sandboxAppliedRevision !== sandboxRevision\s*\|\|\s*sandboxResult\.customFilterCount !== 0/
  );
});

test('diagnostic-only community timestamps do not invalidate injectable runtime state', async () => {
  const source = await readSource('js/background.js');
  const fingerprintSource = sourceBetween(
    source,
    'async function computeInjectableRuntimeFingerprint',
    'async function getRegisteredContentScriptState'
  );
  assert.doesNotMatch(fingerprintSource, /communityBundleMeta|communityMeta/);
  assert.match(fingerprintSource, /communityInjectableFingerprintV1/);

  const buildHarness = new Function('deps', `
    const {
      AUTO_BACKOFF_SUBSYSTEMS_STORAGE_KEY,
      getCurrentVersion,
      getFilteringModeDetails,
      getReportedEnabledRulesets,
      hashRuntimeStateText,
      isUserScriptsAvailable,
      readLocalStrict,
      rulesetConfig,
      SANDBOX_COMPILED_FINGERPRINT_KEY,
      supportsUserScripts,
    } = deps;
    ${fingerprintSource}
    return { computeInjectableRuntimeFingerprint };
  `);
  let diagnosticTimestamp = 100;
  const readKeys = [];
  const harness = buildHarness({
    AUTO_BACKOFF_SUBSYSTEMS_STORAGE_KEY: 'backoffs',
    getCurrentVersion: () => '1.2.3',
    getFilteringModeDetails: async () => ({ optimal: ['all-urls'] }),
    getReportedEnabledRulesets: async () => ['easylist'],
    hashRuntimeStateText: async value => value,
    isUserScriptsAvailable: () => true,
    readLocalStrict: async key => {
      readKeys.push(key);
      if (key === 'communityBundleMeta') {
        return { baselineLastAttempt: diagnosticTimestamp };
      }
      if (key === 'communityInjectableFingerprintV1') return 'behavior-v1';
      if (key === 'backoffs') return {};
      if (key === 'sandbox') return 'sandbox-v1';
      return undefined;
    },
    rulesetConfig: {
      developerMode: false,
      communityRulesEnabled: true,
    },
    SANDBOX_COMPILED_FINGERPRINT_KEY: 'sandbox',
    supportsUserScripts: true,
  });

  const before = await harness.computeInjectableRuntimeFingerprint();
  diagnosticTimestamp = 200;
  const after = await harness.computeInjectableRuntimeFingerprint();
  assert.equal(after, before);
  assert.equal(readKeys.includes('communityBundleMeta'), false);
});

test('authoritative live runtime reads fail closed and expose awaited readiness', async () => {
  const automationSource = await readSource('js/scripting/automation.js');
  const nativeSource = await readSource('js/scripting/native-heuristics.js');
  const remoteSource = await readSource('js/scripting/remote-cosmetics.js');
  const remoteGlobalSource = await readSource('js/scripting/remote-cosmetics-global.js');
  const remoteHostSource = await readSource('js/scripting/remote-cosmetics-host.js');

  assert.doesNotMatch(automationSource, /loadRemoteDirectives[\s\S]{0,1800}\.catch\(\( \) => \[\]\)/);
  assert.doesNotMatch(automationSource, /enabledRulesetsPromise = maybePromise\.then\(readEnabledRulesets\)\.catch/);
  assert.doesNotMatch(automationSource, /Promise\.all\(\[ localPromise, loadRemoteDirectives\(\) \]\)[\s\S]{0,500}\.catch\(\( \) => \[\]\)/);
  assert.match(automationSource, /const directives = await loadDirectives\(\);[\s\S]*resetMutationRouting\(\);/);
  assert.match(automationSource, /self\.TalonAutomationReady = readiness;/);
  assert.match(automationSource, /self\.TalonAutomationReady;\s*$/);

  const nativeInit = nativeSource.slice(
    nativeSource.indexOf('const init = async () =>'),
    nativeSource.indexOf('let config = defaultConfig')
  );
  assertOrderedIncludes(nativeInit, [
    'let nextConfig = await loadConfig();',
    'const remoteConfig = await loadRemoteConfig();',
    'cleanup();',
    'config = nextConfig;',
  ], 'native authoritative refresh');
  assert.doesNotMatch(nativeSource, /fetch\(getURL\(CONFIG_PATH\)\)[\s\S]{0,300}\.catch\(\(\) => defaultConfig\)/);
  assert.match(nativeSource, /if \(configPromise === pending\) \{ configPromise = undefined; \}/);
  assert.match(nativeSource, /if \(remoteConfigPromise === pending\) \{[\s\S]*remoteConfigPromise = undefined;/);
  assert.doesNotMatch(nativeSource, /loadRemoteConfig[\s\S]{0,1000}\.catch\(\(\) => null\)/);
  assert.match(nativeSource, /self\.TalonNativeHeuristicsReady = readiness;/);
  assert.match(nativeSource, /self\.TalonNativeHeuristicsReady;\s*$/);

  assert.match(remoteSource, /const getCosmetics = \( \) => \{[\s\S]*new Promise\(\(resolve, reject\)/);
  assert.match(remoteSource, /const lastError = runtime\?\.lastError;[\s\S]*reject\(new Error/);
  assert.doesNotMatch(remoteSource, /getCosmetics[\s\S]{0,800}resolve\(undefined\)/);
  assert.match(remoteGlobalSource, /self\.TalonRemoteCosmeticsGlobalReady = readiness;/);
  assert.match(remoteHostSource, /self\.TalonRemoteCosmeticsHostReady = readiness;/);
  assert.doesNotMatch(remoteGlobalSource, /install\?\.\([\s\S]*\.catch\?\./);
  assert.doesNotMatch(remoteHostSource, /install\?\.\([\s\S]*\.catch\?\./);
});

test('generic cosmetic surveys use one clock and resumable tree walking', async () => {
  const source = await readSource('js/scripting/css-generic.js');

  assert.match(source, /const monotonicNow = typeof self\.performance\?\.now === 'function'/);
  assert.match(source, /const maxSurveyRootQueue = 256;/);
  assert.match(source, /const maxSurveyMutationRecords = 512;/);
  assert.match(source, /document\.createTreeWalker\(/);
  assert.match(source, /next\(out, deadline\)/);
  assert.doesNotMatch(source, /querySelectorAll\('\[id\],\[class\]'\)/);
  assert.doesNotMatch(source, /const t0 = Date\.now\(\);[\s\S]*performance\.now\(\) >= deadline/);
  assert.match(source, /self\.TalonCssGenericController = \{ stop: stopAll \};/);
});

test('generic cosmetic empty-payload refresh stops a Complete-mode surveyor', async () => {
  const source = await readSource('js/scripting/css-generic.js');
  let stopCalls = 0;
  const self = {
    TalonCssGenericController: {
      stop() {
        stopCalls += 1;
      },
    },
    genericSelectorMaps: [],
    genericDetails: [],
  };

  vm.runInNewContext(source, { self }, { filename: 'css-generic.js' });

  assert.equal(stopCalls, 1);
  assert.equal(self.genericSelectorMaps, undefined);
  assert.equal(self.genericDetails, undefined);
});

test('generic initial readiness spans every survey slice and late failure rolls back early CSS', async () => {
  const source = await readSource('js/scripting/css-generic.js');
  const hashFromStr = (type, value) => {
    const len = value.length;
    const step = len + 7 >>> 3;
    let hash = (type << 5) + type ^ len;
    for (let i = 0; i < len; i += step) {
      hash = (hash << 5) + hash ^ value.charCodeAt(i);
    }
    return hash & 0xFFFF;
  };
  class FakeElement {
    constructor(className = '') {
      this.nodeType = 1;
      this.id = '';
      this.className = className;
      this.parentElement = null;
    }
    getAttribute(name) {
      return name === 'class' ? this.className : null;
    }
    hasAttribute(name) {
      return name === 'class' && this.className !== '';
    }
  }

  const documentElement = new FakeElement();
  const documentNodes = Array.from({ length: 90 }, (_, index) => {
    const node = new FakeElement(
      index === 0 ? 'initial-early' : (index === 89 ? 'initial-late' : 'noise')
    );
    node.parentElement = documentElement;
    return node;
  });
  const timerQueue = new Map();
  const frameQueue = new Map();
  const attemptedCss = [];
  let nextId = 1;
  let now = 0;
  let removeAllCalls = 0;
  const document = {
    documentElement,
    createTreeWalker(root) {
      const nodes = root === documentElement ? documentNodes.slice() : [];
      let index = 0;
      return {
        currentNode: null,
        nextNode() {
          const node = nodes[index++] || null;
          this.currentNode = node;
          return node;
        },
      };
    },
  };
  const self = {
    genericSelectorMaps: [new Map([
      [hashFromStr(0x2E, 'initial-early'), '.hide-initial-early'],
      [hashFromStr(0x2E, 'initial-late'), '.hide-initial-late'],
    ])],
    genericDetails: [{
      highlyGeneric: '',
      exceptions: [],
      hostnames: [],
      hasEntities: false,
    }],
    performance: { now: () => { now += 1; return now; } },
    NodeFilter: { SHOW_ELEMENT: 1 },
    isolatedAPI: { contexts: { hostnames: [], entities: [] } },
    cssAPI: {
      insert(css) {
        attemptedCss.push(css);
        if (css.includes('.hide-initial-late')) {
          return Promise.reject(new Error('late-slice insert failed'));
        }
        return Promise.resolve();
      },
      removeAll(scope) {
        assert.equal(scope, 'generic');
        removeAllCalls += 1;
        return Promise.resolve();
      },
    },
    setTimeout(callback, delay = 0) {
      const id = nextId++;
      timerQueue.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timerQueue.delete(id); },
    requestAnimationFrame(callback) {
      const id = nextId++;
      frameQueue.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) { frameQueue.delete(id); },
  };
  class FakeMutationObserver {
    observe() {}
    disconnect() {}
    takeRecords() { return []; }
  }

  vm.runInNewContext(source, {
    self,
    document,
    MutationObserver: FakeMutationObserver,
    Date,
  }, { filename: 'css-generic.js' });
  let initialReadySettled = false;
  self.TalonCssGenericInitialReady.finally(() => {
    initialReadySettled = true;
  }).catch(() => {});
  await new Promise(resolve => setImmediate(resolve));

  for (let runs = 0; runs < 200; runs += 1) {
    const nextTimer = Array.from(timerQueue.entries())
      .find(([, timer]) => timer.delay === 0);
    if (nextTimer === undefined) { break; }
    const [id, timer] = nextTimer;
    timerQueue.delete(id);
    timer.callback();
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(
    Array.from(timerQueue.values()).some(timer => timer.delay === 0),
    false
  );
  assert.equal(attemptedCss.length, 0);
  assert.equal(initialReadySettled, false);
  assert.equal(frameQueue.size, 1);

  const runNextFrame = async () => {
    const nextFrame = frameQueue.entries().next().value;
    assert.notEqual(nextFrame, undefined);
    const [id, callback] = nextFrame;
    frameQueue.delete(id);
    callback();
    await new Promise(resolve => setImmediate(resolve));
  };
  await runNextFrame();
  assert.match(attemptedCss[0], /\.hide-initial-early/);
  assert.equal(initialReadySettled, false);

  await runNextFrame();
  for (const expectedDelay of [100, 500]) {
    const retry = Array.from(timerQueue.entries())
      .find(([, timer]) => timer.delay === expectedDelay);
    assert.notEqual(retry, undefined);
    const [id, timer] = retry;
    timerQueue.delete(id);
    timer.callback();
    await new Promise(resolve => setImmediate(resolve));
  }

  await assert.rejects(
    self.TalonCssGenericInitialReady,
    /generic CSS insertion failed/
  );
  assert.equal(attemptedCss.length, 4);
  assert.equal(
    attemptedCss.slice(1).every(css => css.includes('.hide-initial-late')),
    true
  );
  assert.equal(removeAllCalls, 1);
  assert.equal(frameQueue.size, 0);
  assert.equal(timerQueue.size, 0);
});

test('generic cosmetic overflow recovers with a bounded full scan and keeps every matched slice', async () => {
  const source = await readSource('js/scripting/css-generic.js');
  const hashFromStr = (type, value) => {
    const len = value.length;
    const step = len + 7 >>> 3;
    let hash = (type << 5) + type ^ len;
    for (let i = 0; i < len; i += step) {
      hash = (hash << 5) + hash ^ value.charCodeAt(i);
    }
    return hash & 0xFFFF;
  };
  class FakeElement {
    constructor(className = '') {
      this.nodeType = 1;
      this.id = '';
      this.className = className;
      this.parentElement = null;
    }
    getAttribute(name) {
      return name === 'class' ? this.className : null;
    }
    hasAttribute(name) {
      return name === 'class' && this.className !== '';
    }
  }

  const documentElement = new FakeElement();
  const documentNodes = [];
  const timerQueue = new Map();
  const frameQueue = new Map();
  let nextTimerId = 1;
  let nextFrameId = 1000;
  let now = 0;
  let observerCallback;
  const insertedCss = [];
  const document = {
    documentElement,
    createTreeWalker(root) {
      const nodes = root === documentElement ? documentNodes.slice() : [];
      let index = 0;
      return {
        currentNode: null,
        nextNode() {
          const node = nodes[index++] || null;
          this.currentNode = node;
          return node;
        },
      };
    },
  };
  const self = {
    genericSelectorMaps: [new Map([
      [hashFromStr(0x2E, 'ad-early'), '.hide-early'],
      [hashFromStr(0x2E, 'ad-late'), '.hide-late'],
    ])],
    genericDetails: [{
      highlyGeneric: '',
      exceptions: [],
      hostnames: [],
      hasEntities: false,
    }],
    performance: {
      now() {
        now += 0.25;
        return now;
      },
    },
    NodeFilter: { SHOW_ELEMENT: 1 },
    isolatedAPI: { contexts: { hostnames: [], entities: [] } },
    cssAPI: {
      insert(css) {
        insertedCss.push(css);
      },
    },
    setTimeout(callback, delay = 0) {
      const id = nextTimerId++;
      timerQueue.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      timerQueue.delete(id);
    },
    requestAnimationFrame(callback) {
      const id = nextFrameId++;
      frameQueue.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      frameQueue.delete(id);
    },
  };
  class FakeMutationObserver {
    constructor(callback) {
      observerCallback = callback;
    }
    observe() {}
    disconnect() {}
    takeRecords() { return []; }
  }
  vm.runInNewContext(source, {
    self,
    document,
    MutationObserver: FakeMutationObserver,
    Date,
  }, { filename: 'css-generic.js' });

  await Promise.resolve();

  for (let i = 0; i < 700; i += 1) {
    const className = i === 10
      ? 'ad-early'
      : (i === 690 ? 'ad-late' : 'noise');
    const node = new FakeElement(className);
    node.parentElement = documentElement;
    documentNodes.push(node);
  }
  observerCallback([{
    type: 'childList',
    addedNodes: documentNodes,
  }]);

  for (let runs = 0; runs < 4000; runs += 1) {
    const nextTimer = Array.from(timerQueue.entries())
      .find(([, timer]) => timer.delay < 30000);
    const nextFrame = frameQueue.entries().next().value;
    if (nextTimer !== undefined) {
      const [id, timer] = nextTimer;
      timerQueue.delete(id);
      timer.callback();
    } else if (nextFrame !== undefined) {
      const [id, callback] = nextFrame;
      frameQueue.delete(id);
      callback();
    } else {
      await new Promise(resolve => setImmediate(resolve));
      if (
        frameQueue.size === 0 &&
        Array.from(timerQueue.values()).every(timer => timer.delay >= 30000)
      ) {
        break;
      }
      continue;
    }
    await new Promise(resolve => setImmediate(resolve));
  }

  assert.ok(insertedCss.length >= 1);
  assert.equal(insertedCss.every(css => css.length <= 100000), true);
  assert.match(insertedCss.join('\n'), /\.hide-early/);
  assert.match(insertedCss.join('\n'), /\.hide-late/);
  await self.TalonCssGenericInitialReady;
  await self.TalonCssGenericController.stop();
});

test('generic cosmetic CSS is chunked below the message cap and permanent failures stop', async () => {
  const source = await readSource('js/scripting/css-generic.js');
  const frameQueue = new Map();
  const timerQueue = new Map();
  let nextId = 1;
  const attemptedCss = [];
  let removeAllCalls = 0;
  const documentElement = {
    nodeType: 1,
    id: '',
    parentElement: null,
    getAttribute() { return null; },
    hasAttribute() { return false; },
  };
  const selectors = Array.from(
    { length: 18000 },
    (_, index) => `.oversized-${index}`
  ).join(',\n');
  const self = {
    genericSelectorMaps: [],
    genericDetails: [{
      highlyGeneric: selectors,
      exceptions: [],
      hostnames: [],
      hasEntities: false,
    }],
    performance: { now: () => 0 },
    NodeFilter: { SHOW_ELEMENT: 1 },
    isolatedAPI: { contexts: { hostnames: [], entities: [] } },
    cssAPI: {
      insert(css) {
        attemptedCss.push(css);
        if (attemptedCss.length === 1) { return Promise.resolve(); }
        return Promise.reject(new Error('permanent insert failure'));
      },
      removeAll(scope) {
        assert.equal(scope, 'generic');
        removeAllCalls += 1;
        return Promise.resolve();
      },
    },
    setTimeout(callback, delay = 0) {
      const id = nextId++;
      timerQueue.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timerQueue.delete(id); },
    requestAnimationFrame(callback) {
      const id = nextId++;
      frameQueue.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) { frameQueue.delete(id); },
  };
  const document = {
    documentElement,
    createTreeWalker() {
      return { nextNode: () => null };
    },
  };
  class FakeMutationObserver {
    observe() {}
    disconnect() {}
    takeRecords() { return []; }
  }

  vm.runInNewContext(source, {
    self,
    document,
    MutationObserver: FakeMutationObserver,
    Date,
  }, { filename: 'css-generic.js' });

  let initialReadySettled = false;
  self.TalonCssGenericInitialReady.finally(() => {
    initialReadySettled = true;
  }).catch(() => {});
  await Promise.resolve();
  assert.equal(initialReadySettled, false);

  for (let runs = 0; runs < 30; runs += 1) {
    const nextFrame = frameQueue.entries().next().value;
    const nextTimer = Array.from(timerQueue.entries())
      .find(([, timer]) => timer.delay < 30000);
    if (nextFrame !== undefined) {
      const [id, callback] = nextFrame;
      frameQueue.delete(id);
      callback();
    } else if (nextTimer !== undefined) {
      const [id, timer] = nextTimer;
      timerQueue.delete(id);
      timer.callback();
    } else {
      await new Promise(resolve => setImmediate(resolve));
      if (
        frameQueue.size === 0 &&
        Array.from(timerQueue.values()).every(timer => timer.delay >= 30000)
      ) {
        break;
      }
      continue;
    }
    await new Promise(resolve => setImmediate(resolve));
  }

  assert.equal(attemptedCss.length, 4);
  assert.equal(attemptedCss.every(css => css.length <= 100000), true);
  await assert.rejects(
    self.TalonCssGenericInitialReady,
    /generic CSS insertion failed/
  );
  assert.equal(frameQueue.size, 0);
  assert.equal(timerQueue.size, 0);
  assert.equal(removeAllCalls, 1);
});

test('remote cosmetics reject unsafe selectors and isolate selector failures', async () => {
  const source = await readSource('js/scripting/remote-cosmetics.js');

  assert.match(source, /const isSafeRemoteSelector = selector => \{/);
  assert.match(source, /UNSAFE_REMOTE_PSEUDO_RE/);
  assert.match(source, /probe\.matches\(selector\);/);
  assert.match(source, /const rule = `\$\{selector\}\$\{CSS_RULE_SUFFIX\}`;/);
  assert.match(source, /currentRules\.push\(rule\);/);
  assert.match(source, /generation !== scopeState\.generation/);
  assert.match(source, /for \( const root of scopeState\.adoptedRoots \) \{/);
  assert.match(source, /scopeState\.adoptedRoots\.clear\(\);/);
});

test('picker preview changes are serialized', async () => {
  const source = await readSource('js/scripting/picker.js');

  assert.match(source, /const run = previewSelector\.promise/);
  assert.match(source, /\.then\(\( \) => previewSelector\.commit\(nextSelector\)\)/);
  assert.match(source, /previewSelector\.promise = run\.catch/);
});

test('startup verifies an empty managed user-script state while Chrome hides the API', async () => {
  const source = await readSource('js/background.js');
  const helperSource = sourceBetween(
    source,
    'const managedUserScriptStateIsReusable = ({',
    'async function persistInjectableRuntimeState'
  );
  const buildHelper = new Function('isDurableDirtyMarker', `
    ${helperSource}
    return managedUserScriptStateIsReusable;
  `);
  const isReusable = buildHelper(value => value !== undefined && value !== false);

  const unavailableEmpty = {
    ids: [],
    fingerprint: 'unavailable',
    unavailable: true,
  };
  assert.equal(isReusable({
    actualState: unavailableEmpty,
    desiredFingerprint: '',
    desiredIds: [],
    mayExistMarker: undefined,
  }), true);
  assert.equal(isReusable({
    actualState: unavailableEmpty,
    desiredFingerprint: '',
    desiredIds: [],
    mayExistMarker: true,
  }), false);
  assert.equal(isReusable({
    actualState: unavailableEmpty,
    desiredFingerprint: 'managed-script-fingerprint',
    desiredIds: ['user.main'],
    mayExistMarker: undefined,
  }), false);
  assert.equal(isReusable({
    actualState: {
      ids: ['user.main'],
      registrationFingerprint: 'managed-script-fingerprint',
    },
    desiredFingerprint: 'managed-script-fingerprint',
    desiredIds: ['user.main'],
    mayExistMarker: true,
  }), true);

  const reuseSource = sourceBetween(
    source,
    'async function canReusePersistedInjectableRuntimeState',
    'async function updateUserRulesAndAcknowledgeSandboxState'
  );
  assert.match(reuseSource, /readLocalStrict\(MANAGED_USER_SCRIPTS_MAY_EXIST_KEY\)\.catch\(\(\) => true\)/);
  assert.match(reuseSource, /managedUserScriptStateIsReusable\(\{/);
});
