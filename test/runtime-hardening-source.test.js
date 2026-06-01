import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const readSource = relativePath =>
  fs.readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');

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

test('packaged cosmetic registrations preload the procedural API before procedural consumers', async () => {
  const managerSource = await readSource('js/scripting-manager.js');
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
  assert.match(filterManagerSource, /export async function registerSandboxFilters/);
  assert.match(filterManagerSource, /browser\.offscreen\.createDocument/);
  assert.match(filterManagerSource, /browser\.userScripts\.register/);
  assert.match(backgroundSource, /registerSandboxFilters\(\)/);
  assert.match(backgroundSource, /runtime\.onUserScriptMessage\.addListener/);
  assert.match(backgroundSource, /unregisterAllUserScripts/);
  assert.match(ownershipSource, /"js\/offscreen\/\*\*"/);
  assert.match(ownershipSource, /"js\/resources\/\*\*"/);
  assert.match(ownershipSource, /"lib\/regexanalyzer\/\*\*"/);
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
  assert.match(clickSource, /if \(toggleChangeInFlight\) \{\s*return;\s*\}/);

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
  const writeSnapshotIndex = commitSource.indexOf('await writeGlobalPauseSnapshot(currentModes);');
  const pauseModesIndex = commitSource.indexOf('modes: PAUSED_FILTERING_MODES');
  const restoreSnapshotIndex = commitSource.indexOf('modes: snapshot');
  const clearSnapshotIndex = commitSource.indexOf('await clearGlobalPauseSnapshot();');
  assert.ok(writeSnapshotIndex !== -1 && pauseModesIndex !== -1);
  assert.ok(restoreSnapshotIndex !== -1 && clearSnapshotIndex !== -1);
  assert.ok(writeSnapshotIndex < pauseModesIndex);
  assert.ok(restoreSnapshotIndex < clearSnapshotIndex);
  assert.match(commitSource, /if \(snapshotWrittenForThisAttempt\) \{\s*await clearGlobalPauseSnapshot\(\);/);

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

test('extension source keeps only the bounded Talon-owned YouTube ad-skip lane', async () => {
  const watchPrefix = 'youtube' + '-watch';
  const relayHtmlPath = `web_accessible_resources/${watchPrefix}-relay.html`;
  const relayScriptPath = `web_accessible_resources/${watchPrefix}-relay.js`;
  const bootstrapPath = `js/scripting/${watchPrefix}-bootstrap.js`;
  const talonYouTubePath = 'js/scripting/youtube-ad-skip.js';
  const managerSource = await readSource('js/scripting-manager.js');
  const talonYouTubeSource = await readSource(talonYouTubePath);
  const heuristicSource = await readSource('js/scripting/native-heuristics.js');
  const backgroundSource = await readSource('js/background.js');
  const rulesetSource = await readSource('js/ruleset-manager.js');
  const allowlist = await readSource('public-safe-allowlist.txt');
  const manifest = JSON.parse(await readSource('manifest.json'));
  const publicResources = (manifest.web_accessible_resources ?? [])
    .flatMap(entry => entry.resources ?? []);

  assert.equal(await pathExists(talonYouTubePath), true);
  assert.equal(await pathExists(bootstrapPath), false);
  assert.equal(await pathExists(relayHtmlPath), false);
  assert.equal(await pathExists(relayScriptPath), false);
  assert.equal(publicResources.some(resource => resource.includes(`${watchPrefix}-relay`)), false);
  assert.equal(publicResources.some(resource => /youtube/i.test(resource)), false);
  assert.equal(allowlist.includes(talonYouTubePath), true);
  assert.equal(allowlist.includes(bootstrapPath), false);
  assert.equal(allowlist.includes(relayHtmlPath), false);
  assert.equal(allowlist.includes(relayScriptPath), false);

  assert.match(managerSource, /TALON_YOUTUBE_AD_SKIP_ID = 'talon-youtube-ad-skip'/);
  assert.match(managerSource, /registerYouTubeAdSkip\(context\)/);
  assert.match(managerSource, /getScriptletExcludedHostnames/);
  assert.match(managerSource, /YOUTUBE_AD_SKIP_HOSTNAMES/);
  assert.match(talonYouTubeSource, /TalonBreakageGuard/);
  assert.match(talonYouTubeSource, /youtubeAdSkip/);
  assert.doesNotMatch(talonYouTubeSource, /chrome\.runtime|browser\.runtime|\bfetch\s*\(|\bXMLHttpRequest\b|runtime\.getURL/);
  assert.doesNotMatch(talonYouTubeSource, /createElement\(['"]script['"]\)/);
  assert.doesNotMatch(managerSource, new RegExp(`${watchPrefix}-bootstrap|registerYouTubeWatchBootstrap|HOST_SCOPED_SCRIPTLET_EXCLUSIONS`));
  assert.doesNotMatch(heuristicSource, new RegExp(`youtube|${'YOUTUBE_' + 'WATCH'}|td_yw`, 'i'));
  assert.doesNotMatch(backgroundSource, new RegExp(`setYouTubeWatch|YouTubeWatch|${watchPrefix}`, 'i'));
  assert.doesNotMatch(rulesetSource, /YOUTUBE_AD_RULES|YouTubeAdSession|updateYouTubeAdSessionRules|youtube\.com/);
});
test('startup performs one eager injectable sync and omits abandoned runtime reconciliation', async () => {
  const source = await readSource('js/background.js');
  const startBlock = source.slice(
    source.indexOf('async function start() {'),
    source.indexOf('/******************************************************************************/', source.indexOf('async function start() {'))
  );

  assert.equal(
    countMatches(startBlock, /syncInjectablesAndRefreshTabs\(\{ runtimeOnly: false \}\)\.catch\(ubolErr\)/g),
    1
  );
  assert.doesNotMatch(startBlock, /registerInjectablesIfEntitled\(\)\.catch\(ubolErr\);/);
  assert.doesNotMatch(startBlock, /syncYouTubeWatchControlCookies/);
  assert.doesNotMatch(startBlock, /syncPrivateYouTubeRuntimeLaneRules/);
  assert.doesNotMatch(source, /requestCompatibilityBackoff/);
  assert.doesNotMatch(source, /runtime\.onConnect\.addListener/);
});

test('popup warmup attempts a bounded injectable recovery before reporting startup not ready', async () => {
  const source = await readSource('js/background.js');

  assert.match(source, /const POPUP_WARMUP_RECOVERY_TIMEOUT_MS = 4000;/);
  assert.match(source, /let popupWarmupRecoveryPromise;/);
  assert.match(source, /async function recoverStartupCoreFromPopupWarmup\(\)/);
  assert.match(
    source,
    /syncInjectablesAndRefreshTabs\(\{\s*runtimeOnly: false,\s*refreshOpenTabs: false,\s*\}\)/
  );
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
  assert.match(source, /activeDirectives = hostMatchedDirectives/);
  assert.doesNotMatch(source, /NATIONAL_POST_/);
  assert.doesNotMatch(source, /__ubolNationalPostRuntime/);
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
  assert.match(source, /const applyPrepaint = \(\) => \{[\s\S]*style\.textContent = STYLE_TEXT;[\s\S]*markMatchedShells\(\);/);
  assert.match(source, /blockHints\.noteElement\(node, \{ ancestors: 1 \}\)/);
  assert.match(source, /if \( document\.documentElement \) \{\s*applyPrepaint\(\);\s*inject\(\)\.catch/);
  assert.match(source, /document\.addEventListener\('readystatechange', \(\) => \{\s*applyPrepaint\(\);\s*inject\(\)\.catch/);
  assert.match(source, /guard\?\.shouldRunSubsystem\?\.\(SUBSYSTEM_ID\) !== false/);
  assert.match(source, /document\.getElementById\(STYLE_ID\)\?\.remove\(\);/);
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
  assert.doesNotMatch(source, /\[data-ad/);
  assert.doesNotMatch(source, /ad-slot/);
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

test('shadow root helper tracks added nodes incrementally and reserves full rescans for removals or load events', async () => {
  const source = await readSource('js/scripting/shadow-dom-helper.js');

  assert.match(source, /let pendingAddedNodes = \[\];/);
  assert.match(source, /let pendingFullRescan = false;/);
  assert.match(source, /const scanAddedNodeTree = node => \{/);
  assert.match(source, /const flushPendingRescan = \(\) => \{/);
  assert.match(source, /if \( pendingFullRescan \) \{\s*rescanNow\(\);/);
  assert.match(source, /for \( const node of addedNodes \) \{\s*changed = scanAddedNodeTree\(node\) \|\| changed;/);
  assert.match(source, /if \( mutation\.removedNodes\?\.length \) \{\s*pendingFullRescan = true;/);
  assert.match(source, /pendingAddedNodes\.push\(node\);/);
});

test('remote cosmetics runtime stats are deduped by scope before messaging background', async () => {
  const source = await readSource('js/scripting/remote-cosmetics.js');

  assert.match(source, /const runtimeStatsByScope = new Map\(\);/);
  assert.match(source, /const previous = runtimeStatsByScope\.get\(scope\);/);
  assert.match(source, /previous\?\.chunkCount === nextStats\.chunkCount/);
  assert.match(source, /runtimeStatsByScope\.set\(scope, nextStats\);/);
  assert.match(source, /runtimeStatsByScope\.delete\(scope\);/);
});
