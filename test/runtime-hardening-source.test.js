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
    'alarms',
    'declarativeNetRequest',
    'scripting',
    'storage',
    'webNavigation',
  ]);
  assert.deepEqual(manifest.host_permissions, ['<all_urls>']);
  assert.equal(manifest.permissions.includes('cookies'), false);
});

test('youtube watch registration excludes invasive response mutators on the signed-in web surface', async () => {
  const source = await readSource('js/scripting-manager.js');
  const hostScopedExclusionsMatch = source.match(
    /const HOST_SCOPED_SCRIPTLET_EXCLUSIONS = new Map\(\[\s*\[\s*'www\.youtube\.com',\s*new Set\(\[(?<ids>[\s\S]*?)\]\),\s*\],\s*\]\);/
  );
  const youtubeExclusions = hostScopedExclusionsMatch?.groups?.ids ?? '';

  assert.match(source, /const GLOBAL_SCRIPTLET_EXCLUDED_HOSTNAMES = Object\.freeze\(\[/);
  assert.match(source, /'www\.youtube\.com'/);
  assert.match(source, /const HOST_SCOPED_SCRIPTLET_EXCLUSIONS = new Map\(\[/);
  assert.ok(hostScopedExclusionsMatch);
  assert.match(youtubeExclusions, /'annoyances-overlays\.json-prune'/);
  assert.match(youtubeExclusions, /'ublock-filters\.json-prune-fetch-response'/);
  assert.match(youtubeExclusions, /'ublock-filters\.trusted-replace-fetch-response'/);
  assert.match(youtubeExclusions, /'ublock-filters\.trusted-replace-node-text'/);
  assert.match(youtubeExclusions, /'ublock-filters\.adjust-setTimeout'/);
  assert.doesNotMatch(youtubeExclusions, /'ublock-filters\.trusted-prevent-dom-bypass'/);
  assert.match(youtubeExclusions, /'ublock-filters\.trusted-edit-inbound-object'/);
  assert.match(youtubeExclusions, /'ublock-filters\.trusted-json-edit-fetch-request'/);
  assert.match(youtubeExclusions, /'ublock-filters\.trusted-json-edit-xhr-request'/);
  assert.match(youtubeExclusions, /'ublock-experimental\.trusted-json-edit-xhr-request'/);
  assert.match(source, /const excluded = \[ \.\.\.GLOBAL_SCRIPTLET_EXCLUDED_HOSTNAMES \];/);
  assert.match(source, /return Array\.from\(new Set\(excluded\)\);/);
  assert.match(source, /const localExcludedHostnames = getScriptletExcludedHostnames\(id\);/);
  assert.match(source, /excludeMatches\.push\(\.\.\.ut\.matchesFromHostnames\(localExcludedHostnames\)\);/);
});

test('native heuristics uses a YouTube minimal surface mode instead of full heuristic scanning', async () => {
  const source = await readSource('js/scripting/native-heuristics.js');

  assert.match(source, /const isYouTubeMinimalSurface = hostname === 'www\.youtube\.com' && isTopDocument === true;/);
  assert.match(source, /if \(isYouTubeMinimalSurface\) \{/);
  assert.match(source, /if \(isYouTubeMinimalSurface\) \{\s*installYouTubeWatchNavigationHardening\(\);/s);
  assert.match(source, /mode: 'youtube-minimal'/);
  assert.doesNotMatch(source, /registerNationalPost/);
});

test('public YouTube watch bootstrap lane is restricted to real watch documents', async () => {
  const source = await readSource('js/scripting-manager.js');

  assert.match(source, /function registerYouTubeWatchBootstrap\(context\)/);
  assert.match(source, /id: 'youtube-watch-bootstrap-main'/);
  assert.ok(source.includes("includeGlobs: [ '*://www.youtube.com/watch*' ],"));
});

test('baseline YouTube watch navigation routes through the extension relay after a bounded service-worker bypass', async () => {
  const source = await readSource('js/scripting/native-heuristics.js');
  const baselineBlockMatch = source.match(
    /if \(getYouTubeNavigationArchitecture\(\) === YOUTUBE_WATCH_BASELINE_STRATEGY\) \{[\s\S]*?\n\s*\}/
  );

  assert.match(source, /const YOUTUBE_WATCH_BASELINE_SW_BYPASS_TIMEOUT_MS = 250;/);
  assert.match(source, /const buildYouTubeWatchRelayUrl = targetUrl => \{/);
  assert.match(source, /runtimeApi\.getURL\('web_accessible_resources\/youtube-watch-relay\.html'\)/);
  assert.match(source, /const attemptYouTubePageServiceWorkerBypass = async \(\) => \{/);
  assert.match(source, /serviceWorker\.getRegistrations\(\)/);
  assert.match(source, /registration\.unregister\(\)/);
  assert.match(source, /Promise\.race\(\[ work, timeout \]\)/);
  assert.match(
    source,
    /if \(getYouTubeNavigationArchitecture\(\) === YOUTUBE_WATCH_BASELINE_STRATEGY\) \{[\s\S]*event\.preventDefault\(\);\s*event\.stopImmediatePropagation\(\);[\s\S]*const relayUrl = buildYouTubeWatchRelayUrl\(watchUrl\);[\s\S]*const serviceWorkerBypass = await attemptYouTubePageServiceWorkerBypass\(\);[\s\S]*preNavigationRelayUsed: true,[\s\S]*self\.location\.assign\(relayUrl\);[\s\S]*return;[\s\S]*preNavigationRelayUsed: false,[\s\S]*self\.location\.assign\(watchUrl\.toString\(\)\);[\s\S]*return;\s*\}/
  );
  assert.ok(baselineBlockMatch);
  assert.doesNotMatch(baselineBlockMatch[0], /primeYouTubeWatchLease/);
});

test('youtube relay page validates the target and replaces into a normalized watch URL', async () => {
  const source = await readSource('web_accessible_resources/youtube-watch-relay.js');

  assert.match(source, /function normalizeYouTubeWatchUrl\(value\)/);
  assert.match(source, /if \(url\.origin !== 'https:\/\/www\.youtube\.com'\) \{ return ''; \}/);
  assert.match(source, /if \(url\.pathname !== '\/watch'\) \{ return ''; \}/);
  assert.match(source, /if \(\(url\.searchParams\.get\('v'\) \|\| ''\)\.trim\(\) === ''\) \{ return ''; \}/);
  assert.match(source, /self\.location\.replace\(targetUrl\);/);
});

test('youtube watch fetch bridge is self-origin scoped and timeout bounded', async () => {
  const bootstrapSource = await readSource('js/scripting/youtube-watch-bootstrap.js');
  const heuristicSource = await readSource('js/scripting/native-heuristics.js');

  assert.match(bootstrapSource, /const FETCH_BRIDGE_TIMEOUT_MS = 2500;/);
  assert.match(bootstrapSource, /const isTrustedFetchBridgeEvent = event => \{/);
  assert.match(bootstrapSource, /event\?\.source !== self/);
  assert.match(bootstrapSource, /event\.origin !== WATCH_ORIGIN/);
  assert.match(bootstrapSource, /event\?\.data\?\.type === FETCH_REQUEST_MESSAGE/);
  assert.match(bootstrapSource, /const fetchWatchDocument = requestedUrl => \{/);
  assert.match(bootstrapSource, /new self\.AbortController\(\)/);
  assert.match(bootstrapSource, /controller\.abort\(\)/);
  assert.match(bootstrapSource, /fetchWatchDocument\(requestedUrl\)/);
  assert.match(bootstrapSource, /self\.postMessage\(payload, WATCH_ORIGIN\);/);

  assert.match(heuristicSource, /const YOUTUBE_WATCH_ORIGIN = 'https:\/\/www\.youtube\.com';/);
  assert.match(heuristicSource, /event\?\.source !== self/);
  assert.match(heuristicSource, /event\.origin !== YOUTUBE_WATCH_ORIGIN/);
  assert.match(heuristicSource, /YOUTUBE_WATCH_FETCH_RESPONSE_MESSAGE/);
  assert.match(heuristicSource, /self\.postMessage\(\{[\s\S]*type: YOUTUBE_WATCH_FETCH_REQUEST_MESSAGE,[\s\S]*\}, YOUTUBE_WATCH_ORIGIN\);/);
});

test('baseline YouTube pointer signals do not prime exact-envelope donor work', async () => {
  const source = await readSource('js/scripting/native-heuristics.js');

  assert.match(source, /const navigationArchitecture = getYouTubeNavigationArchitecture\(\);/);
  assert.match(
    source,
    /if \(\s*navigationArchitecture === YOUTUBE_WATCH_EXACT_STRATEGY &&\s*\(signalType === 'pointerdown' \|\| getYouTubePrewarmMode\(\) !== 'off'\)\s*\) \{[\s\S]*primeYouTubeWatchLease\(watchUrl, signalType, \{/
  );
});

test('ready exact-envelope YouTube watch navigation also forces a same-task hard navigation', async () => {
  const source = await readSource('js/scripting/native-heuristics.js');
  const readyBlockMatch = source.match(
    /if \(readyEnvelope !== null\) \{[\s\S]*?\n\s*\}/
  );

  assert.match(
    source,
    /if \(readyEnvelope !== null\) \{[\s\S]*writeEnvelopeToYouTubeStorage\(readyEnvelope,[\s\S]*event\.preventDefault\(\);\s*event\.stopImmediatePropagation\(\);[\s\S]*self\.location\.assign\(watchUrl\.toString\(\)\);[\s\S]*return;\s*\}/
  );
  assert.ok(readyBlockMatch);
  assert.doesNotMatch(readyBlockMatch[0], /setTimeout/);
});

test('youtube watch bootstrap keeps tiny-rn1 recovery active on baseline watch pages', async () => {
  const source = await readSource('js/scripting/youtube-watch-bootstrap.js');

  assert.match(source, /const SERVICE_WORKER_RECOVERY_TIMEOUT_MS = 250;/);
  assert.match(source, /const SERVICE_WORKER_RECOVERY_POLL_MS = 25;/);
  assert.match(source, /const SERVICE_WORKER_RECOVERY_SETTLE_MS = 200;/);
  assert.match(source, /if \(currentWatchUrl === ''\) \{ return; \}/);
  assert.match(
    source,
    /const freezeEligible =\s*navigationArchitecture === EXACT_STRATEGY &&\s*activeEnvelope !== null;/
  );
  assert.match(source, /freezeHeld: freezeEligible,/);
  assert.match(source, /latestEnvelopeRaw: freezeEligible \? latestEnvelopeRaw : '',/);
  assert.match(source, /scheduleRecovery\('tiny-rn1'\)/);
  assert.match(source, /scheduleRecovery\('tiny-rn1-timeout'\)/);
  assert.match(source, /const attemptOriginServiceWorkerRecovery = \(\) => \{/);
  assert.match(source, /while \(Date\.now\(\) <= deadline && attempted === false\) \{/);
  assert.match(source, /const serviceWorker = self\.navigator\?\.serviceWorker;/);
  assert.match(source, /await new Promise\(resolve => \{\s*self\.setTimeout\(resolve, SERVICE_WORKER_RECOVERY_POLL_MS\);/s);
  assert.match(source, /serviceWorker\.getRegistrations\(\)/);
  assert.match(source, /registration\.unregister\(\)/);
  assert.match(source, /Promise\.race\(\[ recoveryWork, timeoutWork \]\)/);
  assert.match(source, /const waitForServiceWorkerRecoverySettle = result => new Promise\(resolve => \{/);
  assert.match(source, /if \(result\?\.changed !== true\) \{\s*resolve\('unchanged'\);/);
  assert.match(source, /serviceWorker\.addEventListener\('controllerchange', \(\) => \{\s*finish\('controllerchange'\);/s);
  assert.match(source, /self\.setTimeout\(\(\) => \{\s*finish\('timeout'\);\s*\}, SERVICE_WORKER_RECOVERY_SETTLE_MS\);/s);
  assert.match(source, /diagnosticState\.serviceWorkerRecoveryAttempted = result\.attempted === true;/);
  assert.match(source, /await waitForServiceWorkerRecoverySettle\(result\);/);
  assert.doesNotMatch(
    source,
    /if \(currentWatchUrl === '' \|\| navigationArchitecture !== EXACT_STRATEGY\) \{ return; \}/
  );
});

test('youtube watch bootstrap installs a live player-response sanitizer when no exact envelope is available', async () => {
  const source = await readSource('js/scripting/youtube-watch-bootstrap.js');

  assert.match(source, /const hasPlayableStreamingData = value => \{/);
  assert.match(source, /const isPlayerResponseOk = value =>/);
  assert.match(source, /const hasAntiAdblockEnforcement = value =>/);
  assert.match(source, /const hasAntiAdblockAuxiliaryUi = value =>/);
  assert.match(source, /const hasAntiAdblockPayload = value =>/);
  assert.match(source, /const adTrackingParamKeyPattern = /);
  assert.match(source, /const adPreloadMessageNamePattern = /);
  assert.match(source, /const repairAntiAdblockPlayerResponse = value => \{/);
  assert.match(source, /delete value\.auxiliaryUi;/);
  assert.match(source, /status: 'OK'/);
  assert.match(source, /delete value\.playabilityStatus\.errorScreen;/);
  assert.match(source, /const sanitizeServiceTrackingParams = \(entries, depth\) => \{/);
  assert.match(source, /adTrackingParamKeyPattern\.test\(trackingKey\)/);
  assert.match(source, /const sanitizePreloadMessageNames = entries => \{/);
  assert.match(source, /adPreloadMessageNamePattern\.test\(entry\)/);
  assert.match(source, /if \(key === 'serviceTrackingParams' && Array\.isArray\(entryValue\)\) \{/);
  assert.match(source, /if \(key === 'preloadMessageNames' && Array\.isArray\(entryValue\)\) \{/);
  assert.match(source, /const sanitizeRawPlayerResponseString = rawValue => \{/);
  assert.match(source, /const sanitizeLivePlayerConfig = target => \{/);
  assert.match(source, /const sanitizeLiveYtcfgBag = bag => \{/);
  assert.match(source, /const sanitizeLiveYtcfg = target => \{/);
  assert.match(source, /if \(activeEnvelope === null\) \{/);
  assert.match(source, /Object\.defineProperty\(self, 'moviePlayerResponse'/);
  assert.match(source, /Object\.defineProperty\(self, 'ytInitialPlayerResponse'/);
  assert.match(source, /Object\.defineProperty\(self, 'ytcfg'/);
  assert.match(source, /Object\.defineProperty\(self, 'ytplayer'/);
  assert.match(source, /const liveProtectedAssignments = new Map\(\[/);
  assert.match(source, /Object\.defineProperty = \(target, property, descriptor\) => \{/);
  assert.match(source, /protectedKeySet\.has\(String\(property\)\)/);
  assert.match(source, /captureLiveProtectedAssignment\(property, descriptor\)/);
  assert.match(source, /Reflect\.defineProperty = \(target, property, descriptor\) => \{/);
  assert.match(source, /const YOUTUBE_PLAYER_RECOVERY_USER_AGENT_VARIANTS = Object\.freeze\(\[/);
  assert.match(source, /const YOUTUBE_PLAYER_RESPONSE_CACHE_KEYS = Object\.freeze\(\[/);
  assert.match(source, /const YOUTUBE_ANTI_ADBLOCK_TEXT_MARKERS = Object\.freeze\(\[/);
  assert.match(source, /onFulfilled\.toString\(\)\.includes\('onAbnormalityDetected'\)/);
  assert.match(source, /const removeAntiAdblockOverlayDom = \(\) => \{/);
  assert.match(source, /const syncRecoveredRawPlayerResponse = repairedResponse => \{/);
  assert.match(source, /const installRecoveredPlayerResponse = \(player, response\) => \{/);
  assert.match(source, /player\.getPlayerResponse = \(\) => repairedResponse;/);
  assert.match(source, /const consumeRecoveredPlayerState = player => \{/);
  assert.match(source, /if \(isPlayerResponseOk\(response\) === false\) \{ return false; \}/);
  assert.match(source, /const forceRecoveredPlayback = player => \{/);
  assert.match(source, /self\.__talonYouTubeWatchOverlayRemoved = true;/);
  assert.match(source, /self\.__talonYouTubeWatchForcePlayAttempted = true;/);
  assert.match(source, /player\.loadVideoById\(/);
  assert.match(source, /if \(isPlayerResponseOk\(response\) === true\) \{ return false; \}/);
  assert.match(source, /applyPlayerRecoveryUserAgentVariant\(variant\);/);
  assert.match(source, /consumeRecoveredPlayerState\(player\);/);
  assert.match(source, /new self\.MutationObserver\(\(\) => \{/);
  assert.match(source, /target\.config\.args\.raw_player_response = nextRawPlayerResponse;/);
  assert.match(source, /bag\.PLAYER_VARS\.raw_player_response = nextRawPlayerResponse;/);
  assert.match(source, /self\.__talonYouTubeWatchPlayerResponseSanitized = true;/);
});

test('youtube watch bootstrap neutralizes high-risk inline anti-adblock scripts before execution', async () => {
  const source = await readSource('js/scripting/youtube-watch-bootstrap.js');

  assert.match(source, /const YOUTUBE_INLINE_SCRIPT_MARKERS = Object\.freeze\(\[/);
  assert.match(source, /'window,"fetch"'/);
  assert.match(source, /'onAbnormalityDetected'/);
  assert.match(source, /const readYouTubeInlineScriptText = node => \{/);
  assert.match(source, /const findYouTubeInlineScriptMarker = text => \{/);
  assert.match(source, /const neutralizeYouTubeInlineScriptNode = node => \{/);
  assert.match(source, /node\.type = 'application\/x-talon-neutralized-script';/);
  assert.match(source, /node\.text = '';/);
  assert.match(source, /node\.textContent = '';/);
  assert.match(source, /node\.innerHTML = '';/);
  assert.match(source, /const installYouTubeInlineScriptNeutralizer = \(\) => \{/);
  assert.match(source, /self\.__talonYouTubeInlineScriptNeutralizerInstalled = true;/);
  assert.match(source, /wrapScriptInsertionMethod\(self\.Node\?\.prototype, 'appendChild'\);/);
  assert.match(source, /wrapScriptInsertionMethod\(self\.Node\?\.prototype, 'insertBefore'\);/);
  assert.match(source, /wrapScriptInsertionMethod\(self\.Node\?\.prototype, 'replaceChild'\);/);
  assert.match(source, /installYouTubeInlineScriptNeutralizer\(\);/);
});

test('ruleset manager injects fixed YouTube ad session rules for the remaining pagead and doubleclick transport', async () => {
  const source = await readSource('js/ruleset-manager.js');

  assert.match(source, /const YOUTUBE_AD_RULES_BASE_RULE_ID = SPECIAL_RULES_REALM \+ 1000;/);
  assert.match(source, /const YOUTUBE_AD_RULES_PRIORITY = STRICTBLOCK_PRIORITY \+ 2;/);
  assert.match(source, /const isYouTubeAdSessionRule = rule =>/);
  assert.match(source, /async function updateYouTubeAdSessionRules\(currentRules, addRules, removeRuleIds\) \{/);
  assert.match(source, /extensionPath: '\/web_accessible_resources\/doubleclick_instream_ad_status\.js'/);
  assert.match(source, /urlFilter: '\|\|googleads\.g\.doubleclick\.net\/pagead\/'/);
  assert.match(source, /urlFilter: '\|\|ad\.doubleclick\.net\/ddm\/'/);
  assert.match(source, /urlFilter: '\|\|pagead2\.googlesyndication\.com\/activeview_ext'/);
  assert.match(source, /urlFilter: '\|\|pagead2\.googlesyndication\.com\/pagead\/'/);
  assert.match(source, /urlFilter: '\|\|tpc\.googlesyndication\.com\/pagead\/'/);
  assert.match(source, /urlFilter: '\|\|ade\.googlesyndication\.com\/'/);
  assert.match(source, /urlFilter: '\|\|youtube\.com\/pagead\/'/);
  assert.match(source, /urlFilter: '\|https:\/\/www\.google\.com\/pagead\/lvz'/);
  assert.match(source, /urlFilter: '\|https:\/\/www\.google\.ca\/pagead\/lvz'/);
  assert.match(source, /await updateYouTubeAdSessionRules\(currentRules, addRulesUnfiltered, removeRuleIds\);/);
  assert.match(source, /if \( Number\.isInteger\(rule\.id\) && rule\.id > 0 \) \{/);
});

test('background runtime refresh uses a fingerprint gate instead of unconditional tab sweeps', async () => {
  const source = await readSource('js/background.js');

  assert.match(source, /let lastInjectableRuntimeFingerprint = '';/);
  assert.match(source, /async function computeInjectableRuntimeFingerprint\(\)/);
  assert.match(source, /enabledRulesets: Array\.isArray\(rulesetConfig\.enabledRulesets\)/);
  assert.match(source, /const shouldRefreshOpenTabs =\s*refreshOpenTabs === true/);
  assert.match(source, /registrationChanged === true/);
  assert.match(source, /runtimeFingerprint !== lastInjectableRuntimeFingerprint/);
  assert.match(source, /lastInjectableRuntimeFingerprint = runtimeFingerprint;/);
  assert.match(source, /runtimeRefreshed: shouldRefreshOpenTabs/);
});

test('startup now performs one eager injectable sync and no YouTube bootstrap reconciliation', async () => {
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

test('automation host-filters first and only loads ruleset state when a gate is present', async () => {
  const source = await readSource('js/scripting/automation.js');

  assert.match(source, /const hostMatchedDirectives = directives\.filter\(hostMatchesDirective\);/);
  assert.match(source, /const requiresRulesetGate = hostMatchedDirectives\.some\(directive =>/);
  assert.match(source, /const enabledRulesets = requiresRulesetGate\s*\?\s*await loadEnabledRulesets\(\)\s*:\s*null;/);
  assert.match(source, /activeDirectives = hostMatchedDirectives/);
  assert.doesNotMatch(source, /NATIONAL_POST_/);
  assert.doesNotMatch(source, /__ubolNationalPostRuntime/);
});

test('ad shell prepaint is reduced to generic selectors without National Post runtime state', async () => {
  const source = await readSource('js/scripting/ad-shell-styles.js');

  assert.match(source, /const BASE_SELECTORS = \[/);
  assert.match(source, /const HOST_SCOPED_SELECTORS = Object\.freeze\(\[/);
  assert.match(source, /style\.textContent = STYLE_TEXT;/);
  assert.doesNotMatch(source, /NATIONAL_POST_/);
  assert.doesNotMatch(source, /__ubolNationalPostRuntime/);
  assert.doesNotMatch(source, /MutationObserver/);
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
