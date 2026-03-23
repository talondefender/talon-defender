import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  AUDITABLE_SUBSYSTEMS,
  classifyProtectedSurface,
  getYouTubeWatchOwnerProfileConfig,
  getScriptletHostExclusions,
  isKnownConsentSelector,
  isRemoteScriptletAllowed,
  isSafeMutationSelector,
  normalizeYouTubeWatchOwnerProfile,
  patternCouldMatchProtectedDomain,
  patternMatchesHostname,
  resolveAuditOverride,
  sanitizeBreakageAuditOverrides,
  YOUTUBE_WATCH_BOOTSTRAP_PUBLIC_DEFAULT,
  YOUTUBE_WATCH_OWNER_PROFILE_DEFAULT,
  YOUTUBE_WATCH_PLAYER_RESPONSE_REWRITE_ENABLED,
  YOUTUBE_WATCH_UPSTREAM_REFERENCE_SNAPSHOT,
} from '../js/breakage-policy.js';

test('protected surface classifier locks down sensitive hosts and paths', () => {
  const login = classifyProtectedSurface('accounts.google.com', '/');
  assert.equal(login.category, 'auth/account');
  assert.equal(login.allowedRiskTier, 1);

  const checkout = classifyProtectedSurface('shop.example.com', '/checkout');
  assert.equal(checkout.category, 'checkout/payment');
  assert.equal(checkout.allowedRiskTier, 1);

  const article = classifyProtectedSurface('example.com', '/news/post');
  assert.equal(article.allowedRiskTier, 3);
});

test('hostname matcher covers wildcard and exact matches', () => {
  assert.equal(patternMatchesHostname('*.stripe.com', 'api.stripe.com'), true);
  assert.equal(patternMatchesHostname('docs.google.com', 'docs.google.com'), true);
  assert.equal(patternMatchesHostname('docs.google.com', 'drive.google.com'), false);
});

test('selector safety rejects page shells and accepts nuisance-specific selectors', () => {
  assert.equal(isSafeMutationSelector('main'), false);
  assert.equal(isSafeMutationSelector('body'), false);
  assert.equal(isSafeMutationSelector('.cookie-banner'), true);
  assert.equal(isSafeMutationSelector('.page-wrapper'), false);
  assert.equal(isKnownConsentSelector('#onetrust-banner-sdk'), true);
});

test('youtube watch live player rewrite kill-switch defaults off', () => {
  assert.equal(YOUTUBE_WATCH_PLAYER_RESPONSE_REWRITE_ENABLED, false);
});

test('youtube watch bootstrap defaults to compatibility-first off', () => {
  assert.equal(YOUTUBE_WATCH_BOOTSTRAP_PUBLIC_DEFAULT, false);
});

test('protected host exposure detection treats wildcards and sensitive domains as risky', () => {
  assert.equal(patternCouldMatchProtectedDomain('*'), true);
  assert.equal(patternCouldMatchProtectedDomain('*.paypal.com'), true);
  assert.equal(patternCouldMatchProtectedDomain('news.example.com'), false);
});

test('remote scriptlet denylist blocks risky tokens', () => {
  assert.equal(isRemoteScriptletAllowed('trusted-click-element'), false);
  assert.equal(isRemoteScriptletAllowed('set-attr'), false);
  assert.equal(isRemoteScriptletAllowed('safe-token'), true);
});

test('youtube owner profiles normalize to known lanes', () => {
  assert.equal(normalizeYouTubeWatchOwnerProfile('talon-current'), 'talon-current');
  assert.equal(normalizeYouTubeWatchOwnerProfile(' upstream-core '), 'upstream-core');
  assert.equal(
    normalizeYouTubeWatchOwnerProfile('upstream-core+talon-wins'),
    'upstream-core+talon-wins'
  );
  assert.equal(normalizeYouTubeWatchOwnerProfile('unknown'), YOUTUBE_WATCH_OWNER_PROFILE_DEFAULT);
});

test('youtube owner profile config advertises upstream snapshot and tactic ownership', () => {
  const talonCurrent = getYouTubeWatchOwnerProfileConfig('talon-current');
  const upstreamCore = getYouTubeWatchOwnerProfileConfig('upstream-core');
  const upstreamCoreWithWins = getYouTubeWatchOwnerProfileConfig('upstream-core+talon-wins');

  assert.equal(talonCurrent.upstreamSnapshot, YOUTUBE_WATCH_UPSTREAM_REFERENCE_SNAPSHOT);
  assert.deepEqual(talonCurrent.activeUpstreamTacticFamilies, []);
  assert.equal(upstreamCore.activeUpstreamTacticFamilies.includes('trusted-prevent-dom-bypass'), true);
  assert.equal(upstreamCore.disabledTalonOverlapFamilies.includes('player-bootstrap-owner'), true);
  assert.equal(
    upstreamCoreWithWins.retainedTalonWinFamilies.includes('player-bootstrap-owner'),
    true
  );
});

test('youtube compatibility exclusions are owner-profile aware', () => {
  assert.deepEqual(
    getScriptletHostExclusions('ublock-filters.trusted-replace-node-text'),
    ['www.youtube.com']
  );
  assert.deepEqual(
    getScriptletHostExclusions('ublock-experimental.trusted-replace-node-text'),
    ['www.youtube.com']
  );
  assert.deepEqual(
    getScriptletHostExclusions('annoyances-overlays.json-prune'),
    ['www.youtube.com']
  );
  assert.deepEqual(
    getScriptletHostExclusions('ublock-filters.trusted-edit-inbound-object'),
    ['www.youtube.com']
  );
  assert.deepEqual(
    getScriptletHostExclusions('ublock-filters.trusted-json-edit-fetch-request'),
    ['www.youtube.com']
  );
  assert.deepEqual(
    getScriptletHostExclusions('ublock-filters.trusted-json-edit-xhr-request'),
    ['www.youtube.com']
  );
  assert.deepEqual(
    getScriptletHostExclusions('ublock-experimental.trusted-json-edit-xhr-response'),
    ['www.youtube.com']
  );
  assert.deepEqual(
    getScriptletHostExclusions('ublock-filters.trusted-prevent-dom-bypass'),
    ['www.youtube.com']
  );
  assert.deepEqual(
    getScriptletHostExclusions('ublock-filters.trusted-replace-fetch-response'),
    ['www.youtube.com']
  );
  assert.deepEqual(
    getScriptletHostExclusions('ublock-filters.json-prune-fetch-response'),
    ['www.youtube.com']
  );
  assert.deepEqual(
    getScriptletHostExclusions('ublock-filters.json-prune-xhr-response'),
    ['www.youtube.com']
  );
  assert.deepEqual(
    getScriptletHostExclusions('ublock-filters.trusted-replace-xhr-response'),
    ['www.youtube.com']
  );
  assert.deepEqual(
    getScriptletHostExclusions('ublock-filters.json-prune'),
    ['www.youtube.com']
  );
  assert.deepEqual(
    getScriptletHostExclusions('ublock-experimental.trusted-json-edit-xhr-request'),
    ['www.youtube.com']
  );
  assert.deepEqual(
    getScriptletHostExclusions('ublock-filters.adjust-setTimeout'),
    ['www.youtube.com']
  );
  assert.deepEqual(
    getScriptletHostExclusions('ublock-filters.trusted-prevent-dom-bypass', {
      youtubeOwnerProfile: 'upstream-core',
    }),
    []
  );
  assert.deepEqual(
    getScriptletHostExclusions('ublock-filters.trusted-json-edit-xhr-request', {
      youtubeOwnerProfile: 'upstream-core',
    }),
    []
  );
  assert.deepEqual(
    getScriptletHostExclusions('ublock-filters.trusted-replace-fetch-response', {
      youtubeOwnerProfile: 'upstream-core+talon-wins',
    }),
    []
  );
  assert.deepEqual(
    getScriptletHostExclusions('ublock-filters.trusted-replace-node-text', {
      youtubeOwnerProfile: 'upstream-core',
    }),
    ['www.youtube.com']
  );
});

test('youtube compatibility exclusions still emit exact-host exclude matches while watch bootstrap leaves dynamic ownership', async () => {
  const source = await readFile(resolve('js/scripting-manager.js'), 'utf8');
  assert.equal(source.includes('const exactAndWildcardMatchesFromHostnames = hostnames => {'), true);
  assert.equal(source.includes('const pushCompatibilityExcludeMatches = (excludeMatches, hostnames) => {'), true);
  assert.equal(source.includes('`*://${normalized}/*`'), true);
  assert.equal(source.includes('ut.matchFromHostname(normalized)'), true);
  assert.equal(source.includes("id: 'youtube-watch-compat'"), false);
  assert.equal(source.includes('registerEarlyYouTubeWatchCompat'), false);
});

test('youtube watch bootstrap is manifest-declared at document_start with cookies permission', async () => {
  const manifest = JSON.parse(await readFile(resolve('manifest.json'), 'utf8'));
  const youtubeWatchMatch = ['https://' + 'www.youtube.com' + '/watch*'];
  assert.equal(Array.isArray(manifest.permissions), true);
  assert.equal(manifest.permissions.includes('cookies'), true);
  assert.deepEqual(manifest.content_scripts, [
    {
      matches: youtubeWatchMatch,
      js: ['js/scripting/youtube-watch-sanitizer.js'],
      run_at: 'document_start',
      all_frames: false,
      world: 'MAIN',
    },
    {
      matches: youtubeWatchMatch,
      js: ['js/scripting/youtube-watch-bridge.js'],
      run_at: 'document_start',
      all_frames: false,
    },
  ]);
});

test('youtube architecture proof relay is packaged as a public-safe internal page', async () => {
  const manifest = JSON.parse(await readFile(resolve('manifest.json'), 'utf8'));
  const backgroundSource = await readFile(resolve('js/background.js'), 'utf8');
  const bridgeSource = await readFile(resolve('js/scripting/youtube-watch-bridge.js'), 'utf8');
  const sanitizerSource = await readFile(resolve('js/scripting/youtube-watch-sanitizer.js'), 'utf8');
  const allowlist = await readFile(resolve('public-safe-allowlist.txt'), 'utf8');
  const relayHtml = await readFile(resolve('options/youtube-followup-relay.html'), 'utf8');
  const relayScript = await readFile(resolve('js/youtube-followup-relay.js'), 'utf8');
  const youtubeMatch = 'https://' + 'www.youtube.com' + '/*';

  assert.equal(
    manifest.web_accessible_resources.some((entry) =>
      Array.isArray(entry.resources) &&
      entry.resources.includes('options/youtube-followup-relay.html') &&
      entry.resources.includes('js/youtube-followup-relay.js') &&
      Array.isArray(entry.matches) &&
      entry.matches.includes(youtubeMatch)
    ),
    true
  );
  assert.equal(allowlist.includes('options/youtube-followup-relay.html'), true);
  assert.equal(allowlist.includes('js/youtube-followup-relay.js'), true);
  assert.equal(backgroundSource.includes("const YOUTUBE_FOLLOWUP_ARCHITECTURE_PORT_NAME = 'td-yw-followup-architecture-proof';"), true);
  assert.equal(backgroundSource.includes("const YOUTUBE_FOLLOWUP_ARCHITECTURE_TRACK_A_COMMIT = 'track-a-same-origin-commit';"), true);
  assert.equal(backgroundSource.includes("const YOUTUBE_FOLLOWUP_ARCHITECTURE_TRACK_A_PREWARM = 'track-a-prewarm-pool';"), true);
  assert.equal(backgroundSource.includes("const YOUTUBE_FOLLOWUP_ARCHITECTURE_TRACK_A_INTENT_LEASE = 'track-a-exact-anchor-intent-lease';"), true);
  assert.equal(backgroundSource.includes("const YOUTUBE_FOLLOWUP_ARCHITECTURE_TRACK_A_DONOR_OWNER = 'track-a-exact-target-donor-tab-owner';"), true);
  assert.equal(backgroundSource.includes("const YOUTUBE_FOLLOWUP_ARCHITECTURE_RELAY_PAGE = 'options/youtube-followup-relay.html';"), true);
  assert.equal(backgroundSource.includes('runtime.onConnect.addListener(port => {'), true);
  assert.equal(backgroundSource.includes("what === 'startYouTubeFollowupArchitectureJob'"), true);
  assert.equal(backgroundSource.includes("what === 'subscribeYouTubeFollowupArchitectureJob'"), true);
  assert.equal(bridgeSource.includes("const ARCHITECTURE_REQUEST_EVENT = 'td-yw-followup-architecture-proof';"), true);
  assert.equal(bridgeSource.includes("const ARCHITECTURE_RESPONSE_EVENT = 'td-yw-followup-architecture-proof-result';"), true);
  assert.equal(bridgeSource.includes("const ARCHITECTURE_PORT_NAME = 'td-yw-followup-architecture-proof';"), true);
  assert.equal(bridgeSource.includes("action === 'start-relay' || action === 'start-donor-owner'"), true);
  assert.equal(bridgeSource.includes("what: 'startYouTubeFollowupArchitectureJob'"), true);
  assert.equal(bridgeSource.includes('sameOriginCommit,'), true);
  assert.equal(sanitizerSource.includes("const FOLLOWUP_ENTRY_STRATEGY_TRACK_A_COMMIT = 'track-a-same-origin-commit';"), true);
  assert.equal(sanitizerSource.includes("const FOLLOWUP_ENTRY_STRATEGY_TRACK_A_PREWARM = 'track-a-prewarm-pool';"), true);
  assert.equal(sanitizerSource.includes("const FOLLOWUP_ENTRY_STRATEGY_TRACK_A_INTENT_LEASE = 'track-a-exact-anchor-intent-lease';"), true);
  assert.equal(sanitizerSource.includes("const FOLLOWUP_ENTRY_STRATEGY_TRACK_A_DONOR_OWNER = 'track-a-exact-target-donor-tab-owner';"), true);
  assert.equal(relayHtml.includes('../js/youtube-followup-relay.js'), true);
  assert.equal(relayScript.includes("const PAYLOAD_KIND = 'td-yw-track-b-bootstrap-envelope';"), true);
  assert.equal(relayScript.includes("what: 'subscribeYouTubeFollowupArchitectureJob'"), true);
});

test('startup keeps the youtube watch bootstrap cookie synced from entitlement and filtering mode changes', async () => {
  const source = await readFile(resolve('js/background.js'), 'utf8');
  assert.equal(source.includes("const YOUTUBE_WATCH_BOOTSTRAP_COOKIE_NAME = 'td_yw_boot';"), true);
  assert.equal(source.includes("const YOUTUBE_WATCH_REWRITE_MODE_COOKIE_NAME = 'td_yw_rw';"), true);
  assert.equal(source.includes("const YOUTUBE_WATCH_RUNTIME_LANE_COOKIE_NAME = 'td_yw_lane';"), true);
  assert.equal(source.includes("const YOUTUBE_WATCH_OWNER_PROFILE_COOKIE_NAME = 'td_yw_owner';"), true);
  assert.equal(source.includes("const YOUTUBE_WATCH_BOOTSTRAP_COOKIE_SEEDED_KEY = 'youtubeWatchBootstrapCookieSeeded';"), true);
  assert.equal(source.includes("YOUTUBE_WATCH_BOOTSTRAP_OPT_IN_STORAGE_KEY,"), true);
  assert.equal(source.includes("YOUTUBE_WATCH_BOOTSTRAP_PUBLIC_DEFAULT,"), true);
  assert.equal(source.includes("const bootstrapOptIn = await localRead(YOUTUBE_WATCH_BOOTSTRAP_OPT_IN_STORAGE_KEY)"), true);
  assert.equal(source.includes("if ( YOUTUBE_WATCH_BOOTSTRAP_PUBLIC_DEFAULT !== true && bootstrapOptIn !== true ) {"), true);
  assert.equal(source.includes('async function syncYouTubeWatchBootstrapCookie({ forceWrite = false } = {}) {'), true);
  assert.equal(source.includes('async function syncYouTubeWatchRewriteModeCookie({ forceWrite = false } = {}) {'), true);
  assert.equal(source.includes('async function syncYouTubeWatchRuntimeLaneCookie({ forceWrite = false } = {}) {'), true);
  assert.equal(source.includes('async function syncYouTubeWatchOwnerProfileCookie({ forceWrite = false } = {}) {'), true);
  assert.equal(source.includes('async function syncYouTubeWatchControlCookies({ forceWrite = false } = {}) {'), true);
  assert.equal(source.includes('browser.cookies.get({'), true);
  assert.equal(source.includes('browser.cookies.set({'), true);
  assert.equal(source.includes("name: YOUTUBE_WATCH_BOOTSTRAP_COOKIE_NAME,"), true);
  assert.equal(source.includes("name: YOUTUBE_WATCH_REWRITE_MODE_COOKIE_NAME,"), true);
  assert.equal(source.includes("name: YOUTUBE_WATCH_RUNTIME_LANE_COOKIE_NAME,"), true);
  assert.equal(source.includes("name: YOUTUBE_WATCH_OWNER_PROFILE_COOKIE_NAME,"), true);
  assert.equal(source.includes("path: '/watch',"), true);
  assert.equal(source.includes("sameSite: 'lax',"), true);
  assert.equal(source.includes('await syncYouTubeWatchControlCookies({ forceWrite: true }).catch(ubolErr);'), true);
  assert.equal(source.includes('const out = await setFilteringModeRaw(hostname, afterLevel);'), true);
  assert.equal(source.includes('const out = await setFilteringModeDetailsRaw(details);'), true);
  assert.equal(source.includes('const out = await syncWithBrowserPermissionsRaw();'), true);
  assert.equal(source.includes("const YOUTUBE_FOLLOWUP_COOKIE_CLEAR_NAMES = new Set(["), true);
  assert.equal(source.includes('const youtubeWatchTabState = new Map();'), true);
  assert.equal(source.includes('function parseYouTubeWatchVideoId(url) {'), true);
  assert.equal(source.includes('async function maybeClearYouTubeFollowupCookiesForNavigation(details) {'), true);
  assert.equal(source.includes('armYouTubeFollowupHeaderStripRules(tabId)'), true);
  assert.equal(source.includes('armYouTubeFollowupNextBlockRules(tabId)'), true);
  assert.equal(source.includes('chrome.webNavigation.onBeforeNavigate.addListener(details => {'), true);
  assert.equal(source.includes('chrome.webNavigation.onCommitted.addListener(details => {'), true);
  assert.equal(source.includes("case 'clearYouTubeFollowupCookies': {"), true);
  assert.equal(source.includes('const removed = await browser.cookies.remove(details);'), true);
});

test('youtube watch bridge forwards follow-up cookie-clear requests to background', async () => {
  const source = await readFile(resolve('js/scripting/youtube-watch-bridge.js'), 'utf8');
  assert.equal(source.includes("const REQUEST_EVENT = 'td-yw-followup-cookie-clear';"), true);
  assert.equal(source.includes("const RESPONSE_EVENT = 'td-yw-followup-cookie-clear-result';"), true);
  assert.equal(source.includes("const PREFETCH_REQUEST_EVENT = 'td-yw-followup-prefetch-sections';"), true);
  assert.equal(source.includes("const PREFETCH_RESPONSE_EVENT = 'td-yw-followup-prefetch-sections-result';"), true);
  assert.equal(source.includes("const PREFETCH_DONOR_CAPTURE_EVENT = 'td-yw-followup-prefetch-donor-capture';"), true);
  assert.equal(source.includes("const NAVIGATE_REQUEST_EVENT = 'td-yw-followup-tab-navigate';"), true);
  assert.equal(source.includes("const NAVIGATE_RESPONSE_EVENT = 'td-yw-followup-tab-navigate-result';"), true);
  assert.equal(source.includes("const NEXT_RELEASE_EVENT = 'td-yw-followup-next-release';"), true);
  assert.equal(source.includes("const targetUrl = typeof detail?.targetUrl === 'string' ? detail.targetUrl : '';"), true);
  assert.equal(source.includes("runtime.sendMessage({ what: 'clearYouTubeFollowupCookies', targetUrl }"), true);
  assert.equal(source.includes("runtime.sendMessage(\n                { what: 'prefetchYouTubeFollowupPlayerResponseSections', targetUrl },"), true);
  assert.equal(source.includes('const bootstrapEnvelope =\n            detail?.bootstrapEnvelope && typeof detail.bootstrapEnvelope === \'object\''), true);
  assert.equal(source.includes("what: 'completeYouTubeFollowupPrefetchDonor',"), true);
  assert.equal(source.includes('bootstrapEnvelope,'), true);
  assert.equal(source.includes('health,'), true);
  assert.equal(source.includes("runtime.sendMessage({ what: 'navigateYouTubeFollowupWatch', targetUrl }"), true);
  assert.equal(source.includes("runtime.sendMessage({ what: 'releaseYouTubeFollowupNextBlock' }"), true);
});

test('youtube owner profile control plane is wired through background and sanitizer', async () => {
  const backgroundSource = await readFile(resolve('js/background.js'), 'utf8');
  const sanitizerSource = await readFile(resolve('js/scripting/youtube-watch-sanitizer.js'), 'utf8');

  assert.equal(
    backgroundSource.includes("case 'setYouTubeWatchBootstrapEnabled': {"),
    true
  );
  assert.equal(
    backgroundSource.includes("case 'clearYouTubeWatchBootstrapOverride': {"),
    true
  );
  assert.equal(
    backgroundSource.includes("case 'setYouTubeWatchOwnerProfile': {"),
    true
  );
  assert.equal(
    backgroundSource.includes("case 'clearYouTubeWatchOwnerProfile': {"),
    true
  );
  assert.equal(
    backgroundSource.includes("const YOUTUBE_WATCH_OWNER_PROFILE_COOKIE_NAME = 'td_yw_owner';"),
    true
  );
  assert.equal(
    sanitizerSource.includes("const OWNER_PROFILE_COOKIE = 'td_yw_owner';"),
    true
  );
  assert.equal(
    sanitizerSource.includes("const OWNER_PROFILE_TALON_CURRENT = 'talon-current';"),
    true
  );
  assert.equal(
    sanitizerSource.includes("const OWNER_PROFILE_UPSTREAM_CORE = 'upstream-core';"),
    true
  );
  assert.equal(
    sanitizerSource.includes("const OWNER_PROFILE_UPSTREAM_CORE_TALON_WINS = 'upstream-core+talon-wins';"),
    true
  );
  assert.equal(
    sanitizerSource.includes("self.__talonYouTubeWatchOwnerProfile = ownerProfile;"),
    true
  );
  assert.equal(
    sanitizerSource.includes("self.__talonYouTubeWatchActiveUpstreamTacticFamilies ="),
    true
  );
});

test('youtube follow-up prep unregisters page service workers and arms tab-scoped cookie header stripping', async () => {
  const sanitizerSource = await readFile(resolve('js/scripting/youtube-watch-sanitizer.js'), 'utf8');
  const backgroundSource = await readFile(resolve('js/background.js'), 'utf8');

  assert.equal(sanitizerSource.includes('const unregisterFollowupServiceWorkers = () => {'), true);
  assert.equal(sanitizerSource.includes('const serviceWorker = navigator.serviceWorker;'), true);
  assert.equal(sanitizerSource.includes('serviceWorker.getRegistrations().then(async registrations => {'), true);
  assert.equal(sanitizerSource.includes('let pendingFollowupNavigationPreparation = null;'), true);
  assert.equal(sanitizerSource.includes('const getForcedWatchNavigationTargetFromEvent = event => {'), true);
  assert.equal(sanitizerSource.includes('targetUrl: normalizeWatchUrl(targetUrl),'), true);
  assert.equal(sanitizerSource.includes('const prepareFollowupNavigation = nextUrl => {'), true);
  assert.equal(sanitizerSource.includes('const FOLLOWUP_DONOR_MIN_FIRST_PAYLOAD_BYTES = 1024;'), true);
  assert.equal(sanitizerSource.includes('const tryEmitFollowupPrefetchDonorSections = () => {'), true);
  assert.equal(sanitizerSource.includes("followupDonorCaptureState.firstPayloadSubstantive !== true"), true);
  assert.equal(sanitizerSource.includes('const isPrefetchedFollowupBootstrapEnvelopeReady = envelope => ('), true);
  assert.equal(sanitizerSource.includes('followupDonorCaptureState.bootstrapEnvelopeProbeDeadlineAt = Date.now() + 2000;'), true);
  assert.equal(sanitizerSource.includes('self.__talonYouTubeWatchFollowupDonorBootstrapEnvelopeProbeTimedOut = true;'), true);
  assert.equal(sanitizerSource.includes("followupDonorCaptureState.firstPayloadSubstantive =\n                        size > FOLLOWUP_DONOR_MIN_FIRST_PAYLOAD_BYTES;"), true);
  assert.equal(sanitizerSource.includes('const buildPrefetchedFollowupBootstrapEnvelopeSeed = entry => {'), true);
  assert.equal(sanitizerSource.includes('const installManagedPrefetchedFollowupBootstrapEnvelopeFromSeed = ('), true);
  assert.equal(sanitizerSource.includes('const buildPrefetchedFollowupPlayerResponseSeed = entry => {'), true);
  assert.equal(sanitizerSource.includes('const preseedPrefetchedFollowupPlayerResponse = () => {'), true);
  assert.equal(sanitizerSource.includes('const seededPlayerResponse = buildPrefetchedFollowupPlayerResponseSeed(entry);'), true);
  assert.equal(sanitizerSource.includes('const seededBootstrapEnvelope = buildPrefetchedFollowupBootstrapEnvelopeSeed(entry);'), true);
  assert.equal(sanitizerSource.includes('self.__talonYouTubeWatchPrefetchedBootstrapEnvelopePreseeded = true;'), true);
  assert.equal(sanitizerSource.includes('self.ytInitialPlayerResponse = clonePayload(seededPlayerResponse);'), true);
  assert.equal(sanitizerSource.includes("nextArgs.raw_player_response = JSON.stringify(clonePayload(seededPlayerResponse));"), true);
  assert.equal(sanitizerSource.includes('preseedPrefetchedFollowupPlayerResponse();'), true);
  assert.equal(sanitizerSource.includes("self.__talonYouTubeWatchPrefetchedBootstrapEnvelopePreseeded !== true"), true);
  assert.equal(sanitizerSource.includes("document.addEventListener('pointerdown', event => {"), true);
  assert.equal(sanitizerSource.includes('clearCookiesAndHardNavigateToWatch(nextUrl);'), true);
  assert.equal(sanitizerSource.includes("document.addEventListener('mousedown', primeFollowupNavigationFromEvent, true);"), true);
  assert.equal(sanitizerSource.includes('location.assign(nextUrl);'), true);
  assert.equal(sanitizerSource.includes("location.replace('about:blank#td-yw-followup-hop');"), true);
  assert.equal(sanitizerSource.includes('prepareFollowupNavigation(normalizedTargetUrl).then(result => {'), true);
  assert.equal(sanitizerSource.includes('requestBackgroundFollowupPlayerResponseSections(normalizedTargetUrl)'), true);
  assert.equal(sanitizerSource.includes('ok => ok === true\n                ? true\n                : prefetchFollowupPlayerResponseSections(normalizedTargetUrl).catch(() => false)'), true);
  assert.equal(sanitizerSource.includes('shouldAttemptNeutralHop ? normalizedTargetUrl : \'\''), true);

  assert.equal(backgroundSource.includes("const YOUTUBE_FOLLOWUP_HEADER_STRIP_RULE_PRIORITY = 3000001;"), true);
  assert.equal(backgroundSource.includes("const YOUTUBE_FOLLOWUP_NEXT_BLOCK_RULE_PRIORITY = 3000002;"), true);
  assert.equal(backgroundSource.includes("const YOUTUBE_FOLLOWUP_NEUTRAL_HOP_URL = 'about:blank#td-yw-followup-hop';"), true);
  assert.equal(backgroundSource.includes("const YOUTUBE_FOLLOWUP_DONOR_PREFETCH_TIMEOUT_MS = 4000;"), true);
  assert.equal(backgroundSource.includes('const YOUTUBE_FOLLOWUP_DONOR_MIN_FIRST_PAYLOAD_BYTES = 1024;'), true);
  assert.equal(backgroundSource.includes('const youtubeFollowupDonorPrefetches = new Map();'), true);
  assert.equal(backgroundSource.includes('const youtubeFollowupDonorTabs = new Map();'), true);
  assert.equal(backgroundSource.includes("urlFilter: '||www.youtube.com/watch?',"), true);
  assert.equal(backgroundSource.includes("urlFilter: '||www.youtube.com/youtubei/v1/next',"), true);
  assert.equal(backgroundSource.includes("{ header: 'cookie', operation: 'remove' }"), true);
  assert.equal(backgroundSource.includes("type: 'block'"), true);
  assert.equal(backgroundSource.includes('function armYouTubeFollowupNeutralHop(tabId, targetUrl) {'), true);
  assert.equal(backgroundSource.includes('function buildYouTubeFollowupDonorUrl(targetUrl, donorToken) {'), true);
  assert.equal(backgroundSource.includes('function sanitizeYouTubeFollowupPrefetchSections(value) {'), true);
  assert.equal(backgroundSource.includes('function sanitizeYouTubeFollowupBootstrapEnvelope(value) {'), true);
  assert.equal(backgroundSource.includes('function sanitizeYouTubeFollowupDonorHealth(value) {'), true);
  assert.equal(backgroundSource.includes('function isYouTubeFollowupDonorAccepted(sections, health) {'), true);
  assert.equal(backgroundSource.includes('function isYouTubeFollowupBootstrapEnvelopeAccepted(envelope) {'), true);
  assert.equal(backgroundSource.includes('const fullPlayerResponse = value.fullPlayerResponse instanceof Object'), true);
  assert.equal(backgroundSource.includes('const responseContext = value.responseContext instanceof Object'), true);
  assert.equal(backgroundSource.includes('const playbackTracking = value.playbackTracking instanceof Object'), true);
  assert.equal(backgroundSource.includes('function finishYouTubeFollowupDonorPrefetch(donorToken, payload = {}) {'), true);
  assert.equal(backgroundSource.includes('function startYouTubeFollowupDonorPrefetch(tabId, targetUrl, callback) {'), true);
  assert.equal(backgroundSource.includes("url: 'about:blank',"), true);
  assert.equal(backgroundSource.includes('await browser.tabs?.update?.(donorTabId, { url: donorUrl });'), true);
  assert.equal(backgroundSource.includes('armYouTubeFollowupHeaderStripRules(donorTabId)'), true);
  assert.equal(backgroundSource.includes('armYouTubeFollowupNextBlockRules(donorTabId)'), true);
  assert.equal(backgroundSource.includes('function armYouTubeFollowupNextBlockRules(tabId) {'), true);
  assert.equal(backgroundSource.includes('function clearYouTubeFollowupNextBlockRules(tabId) {'), true);
  assert.equal(backgroundSource.includes("if ( details.url === YOUTUBE_FOLLOWUP_NEUTRAL_HOP_URL ) {"), true);
  assert.equal(backgroundSource.includes('armYouTubeFollowupHeaderStripRules(tabId)'), true);
  assert.equal(backgroundSource.includes('armYouTubeFollowupNextBlockRules(tabId)'), true);
  assert.equal(backgroundSource.includes("case 'prefetchYouTubeFollowupPlayerResponseSections': {"), true);
  assert.equal(backgroundSource.includes('startYouTubeFollowupDonorPrefetch(tabId, targetUrl, callback);'), true);
  assert.equal(backgroundSource.includes("case 'completeYouTubeFollowupPrefetchDonor': {"), true);
  assert.equal(backgroundSource.includes('const bootstrapEnvelope = sanitizeYouTubeFollowupBootstrapEnvelope('), true);
  assert.equal(backgroundSource.includes("error: 'donor-rejected'"), true);
  assert.equal(backgroundSource.includes("case 'releaseYouTubeFollowupNextBlock': {"), true);
  assert.equal(backgroundSource.includes("case 'navigateYouTubeFollowupWatch': {"), true);
  assert.equal(backgroundSource.includes('browser.tabs?.update?.(tabId, { url: targetUrl })'), true);
});

test('youtube xhr quick-fix registers both request mutators', async () => {
  const source = await readFile(
    resolve(
      'rulesets/scripting/scriptlet/ublock-experimental.trusted-json-edit-xhr-request.js'
    ),
    'utf8'
  );
  assert.match(
    source,
    /const hostnamesMap = new Map\(\[\["www\.youtube\.com",\[0,1\]\]\]\);/
  );
});

test('youtube fetch quick-fixes cover sidebar next and get_watch navigations', async () => {
  const pruneFetchSource = await readFile(
    resolve(
      'rulesets/scripting/scriptlet/ublock-filters.json-prune-fetch-response.js'
    ),
    'utf8'
  );
  const replaceFetchSource = await readFile(
    resolve(
      'rulesets/scripting/scriptlet/ublock-filters.trusted-replace-fetch-response.js'
    ),
    'utf8'
  );

  assert.equal(
    pruneFetchSource.includes('"/\\\\/(?:player|next|get_watch)(?:\\\\?.+)?$/"'),
    true
  );
  assert.equal(
    replaceFetchSource.includes('"/\\\\/(?:player|next|get_watch)(?:\\\\?.+)?$/"'),
    true
  );
  assert.equal(pruneFetchSource.includes('playerAds'), true);
  assert.equal(pruneFetchSource.includes('adBreakHeartbeatParams'), true);
});

test('youtube xhr quick-fixes prune remaining player ad fields', async () => {
  const pruneXhrSource = await readFile(
    resolve(
      'rulesets/scripting/scriptlet/ublock-filters.json-prune-xhr-response.js'
    ),
    'utf8'
  );

  assert.equal(pruneXhrSource.includes('playerAds'), true);
  assert.equal(pruneXhrSource.includes('adBreakHeartbeatParams'), true);
  assert.equal(
    pruneXhrSource.includes('"/\\\\/(?:player|get_watch)(?:\\\\?.+)?$/"'),
    true
  );
});

test('youtube dnr quick-fixes block live ad endpoints at higher priority', async () => {
  const rulesSource = await readFile(resolve('rulesets/main/ublock-filters.json'), 'utf8');

  assert.equal(
    rulesSource.includes('"urlFilter":"||youtube.com/generate_204?"},"id":4551,"priority":50'),
    true
  );
  assert.equal(
    rulesSource.includes('"urlFilter":"||youtube.com/api/stats/qoe?"},"id":4552,"priority":50'),
    true
  );
  assert.equal(
    rulesSource.includes('"urlFilter":"||youtube.com/pagead/adview"},"id":4553,"priority":40'),
    true
  );
  assert.equal(
    rulesSource.includes('"urlFilter":"||youtube.com/pagead/interaction/"},"id":4554,"priority":40'),
    true
  );
  assert.equal(
    rulesSource.includes('"urlFilter":"||googleads.g.doubleclick.net/pagead/id"},"id":4555,"priority":40'),
    true
  );
  assert.equal(
    rulesSource.includes('"urlFilter":"||youtube.com/ptracking?*pltype=adhost"},"id":4556,"priority":40'),
    true
  );
  assert.equal(
    rulesSource.includes('"urlFilter":"||tpc.googlesyndication.com/sodar/"},"id":4557,"priority":40'),
    true
  );
});

test('youtube watch sanitizer targets prettyPrint bootstrap endpoints and strips early player ad fields at first set', async () => {
  const source = await readFile(resolve('js/scripting/youtube-watch-sanitizer.js'), 'utf8');

  assert.equal(source.includes("const WATCH_BOOT_COOKIE = 'td_yw_boot';"), true);
  assert.equal(source.includes("if ( watchBootstrapCookie === '0' ) {"), true);
  assert.equal(source.includes("stage: 'disabled-by-cookie'"), true);
  assert.equal(source.includes('self.__talonYouTubeWatchSanitizerExecutedAt = Date.now();'), true);
  assert.equal(source.includes('self.__talonYouTubeWatchSanitizerExecutedPerfMs ='), true);
  assert.equal(source.includes("const PLAYER_REWRITE_MODE_COOKIE = 'td_yw_rw';"), true);
  assert.equal(source.includes("const RUNTIME_LANE_COOKIE = 'td_yw_lane';"), true);
  assert.equal(source.includes("const PLAYER_REWRITE_MODE_PLAYER = 'player';"), true);
  assert.equal(source.includes("const PLAYER_REWRITE_MODE_PLAYER_BOOTSTRAP = 'player+bootstrap';"), true);
  assert.equal(source.includes("const RUNTIME_LANE_TRANSPORT_SMOOTH = 'transport-smooth';"), true);
  assert.equal(source.includes("const RUNTIME_LANE_BOOTSTRAP_OWNER = 'bootstrap-owner';"), true);
  assert.equal(source.includes("const RUNTIME_LANE_USTREAMER_FLAG_PATCH = 'ustreamer-flag-patch';"), true);
  assert.equal(source.includes("const RUNTIME_LANE_USTREAMER_RN1_36 = 'ustreamer-rn1-36';"), true);
  assert.equal(source.includes("const RUNTIME_LANE_USTREAMER_RN1_39 = 'ustreamer-rn1-39';"), true);
  assert.equal(source.includes("const RUNTIME_LANE_USTREAMER_RN1_155 = 'ustreamer-rn1-155';"), true);
  assert.equal(source.includes("const RUNTIME_LANE_USTREAMER_RN1_278 = 'ustreamer-rn1-278';"), true);
  assert.equal(source.includes("const RUNTIME_LANE_USTREAMER_RN1_36_39 = 'ustreamer-rn1-36-39';"), true);
  assert.equal(source.includes("const RUNTIME_LANE_USTREAMER_RN1_155_278 = 'ustreamer-rn1-155-278';"), true);
  assert.equal(source.includes('case RUNTIME_LANE_USTREAMER_RN1_36:'), true);
  assert.equal(source.includes('case RUNTIME_LANE_USTREAMER_RN1_39:'), true);
  assert.equal(source.includes('case RUNTIME_LANE_USTREAMER_RN1_155:'), true);
  assert.equal(source.includes('case RUNTIME_LANE_USTREAMER_RN1_278:'), true);
  assert.equal(source.includes('case RUNTIME_LANE_USTREAMER_RN1_36_39:'), true);
  assert.equal(source.includes('case RUNTIME_LANE_USTREAMER_RN1_155_278:'), true);
  assert.equal(source.includes("const OWNER_PROFILE_COOKIE = 'td_yw_owner';"), true);
  assert.equal(source.includes("const OWNER_PROFILE_TALON_CURRENT = 'talon-current';"), true);
  assert.equal(source.includes("const OWNER_PROFILE_UPSTREAM_CORE = 'upstream-core';"), true);
  assert.equal(source.includes("const OWNER_PROFILE_UPSTREAM_CORE_TALON_WINS = 'upstream-core+talon-wins';"), true);
  assert.equal(source.includes('const ENABLE_RESPONSE_SANITIZER ='), true);
  assert.equal(source.includes('const ENABLE_GET_WATCH_RESPONSE_SANITIZER ='), true);
  assert.equal(source.includes('const ENABLE_BOOTSTRAP_ALIGNMENT ='), true);
  assert.equal(source.includes('const ENABLE_PLAYER_REQUEST_PATCH = false;'), true);
  assert.equal(source.includes('const ENABLE_FORCED_WATCH_HARD_NAV = true;'), true);
  assert.equal(source.includes('const ENABLE_UPSTREAM_WINDOW_FETCH_NEUTRALIZER ='), true);
  assert.equal(source.includes('const ENABLE_INLINE_PLAYER_RESPONSE_SANITIZER ='), true);
  assert.equal(source.includes('const ENABLE_AD_ENDPOINT_DOM_STUBS = false;'), true);
  assert.equal(source.includes('const ENABLE_AD_ENDPOINT_FETCH_STUBS = ENABLE_TRANSPORT_SMOOTHING;'), true);
  assert.equal(source.includes('const ENABLE_AD_MEDIA_FETCH_STUBS = false;'), true);
  assert.equal(source.includes('const ENABLE_AD_ENDPOINT_XHR_STUBS = ENABLE_TRANSPORT_SMOOTHING;'), true);
  assert.equal(source.includes('const ENABLE_PLAYER_BOOTSTRAP_OWNER ='), true);
  assert.equal(source.includes('runtimeLane === RUNTIME_LANE_BOOTSTRAP_OWNER ||'), true);
  assert.equal(source.includes('ownerProfileConfig.enableTalonPlayerBootstrapOwner === true;'), true);
  assert.equal(source.includes('const ENABLE_USTREAMER_FLAG_PATCH = runtimeLane === RUNTIME_LANE_USTREAMER_FLAG_PATCH;'), true);
  assert.equal(source.includes('const ENABLE_USTREAMER_RN1_EXACT_PATCH ='), true);
  assert.equal(source.includes('const ENABLE_USTREAMER_REQUEST_PATCH ='), true);
  assert.equal(source.includes('const SIDEBAR_SPA_HARD_NAV_PLAYABLE_GRACE_MS = 3000;'), true);
  assert.equal(
    source.includes('const PLAYER_SANITIZE_RESPONSE_RE = /\\/youtubei\\/v1\\/player\\?prettyPrint=false(?:$|&)|\\/player\\?prettyPrint=false(?:$|&)/;'),
    true
  );
  assert.equal(
    source.includes('const GET_WATCH_SANITIZE_RESPONSE_RE = /\\/youtubei\\/v1\\/get_watch\\?prettyPrint=false(?:$|&)|\\/get_watch\\?prettyPrint=false(?:$|&)/;'),
    true
  );
  assert.equal(source.includes("'adPlacements'"), true);
  assert.equal(source.includes("'adPlacementsCount'"), true);
  assert.equal(source.includes("'adSlots'"), true);
  assert.equal(source.includes("'adSlotsCount'"), true);
  assert.equal(source.includes("'playerAds'"), true);
  assert.equal(source.includes("'adBreakHeartbeatParams'"), true);
  assert.equal(source.includes("'no_ads'"), true);
  assert.equal(source.includes("'instreamVideoAdRenderer'"), true);
  assert.equal(source.includes("'playerLegacyDesktopWatchAdsRenderer'"), true);
  assert.equal(source.includes("'clientForecastingAdRenderer'"), true);
  assert.equal(source.includes("'playerBytesSequentialLayoutRenderer'"), true);
  assert.equal(source.includes("'aboveFeedAdLayoutRenderer'"), true);
  assert.equal(source.includes("'adImageViewModel'"), true);
  assert.equal(source.includes("'skipAdViewModel'"), true);
  assert.equal(source.includes('self.XMLHttpRequest = class extends NativeXHR'), true);
  assert.equal(source.includes('NativeResponse.prototype.json = new Proxy'), true);
  assert.equal(source.includes('NativeResponse.prototype.text = new Proxy'), true);
  assert.equal(source.includes('self.fetch = new Proxy'), true);
  assert.equal(source.includes('buildFetchStubResponse'), true);
  assert.equal(source.includes('buildStubProfile'), true);
  assert.equal(source.includes('const classifyTransportSmoothEndpoint = url => {'), true);
  assert.equal(source.includes('const noteStubbedEndpoint = (url, transport) => {'), true);
  assert.equal(source.includes('const notePlayerBootstrapDefined = source => {'), true);
  assert.equal(source.includes('const notePlayerBootstrapIntercepted = source => {'), true);
  assert.equal(source.includes('const notePlayerBootstrapSeen = source => {'), true);
  assert.equal(source.includes('shouldStubAdMediaFetch'), true);
  assert.equal(source.includes('GOOGLEVIDEO_HOST_RE'), true);
  assert.equal(source.includes('NEXT_REQUEST_RE'), true);
  assert.equal(source.includes('const INLINE_DROP_KEYS = new Set(['), true);
  assert.equal(source.includes('const sanitizeInlinePlayerResponse = (value, seen = new WeakSet(), trace = null, path = []) => {'), true);
  assert.equal(source.includes('const maybePatchUstreamerFlag = encodedBlob => {'), true);
  assert.equal(source.includes('const maybePatchPlayerResponseUstreamerConfig = value => {'), true);
  assert.equal(source.includes('const USTREAMER_SLOW_START_CONFIG_PATH = Object.freeze(['), true);
  assert.equal(source.includes('const USTREAMER_PRIMARY_VERSION_PATH = Object.freeze(['), true);
  assert.equal(source.includes('const USTREAMER_PRIMARY_DESCRIPTOR_PATH = Object.freeze(['), true);
  assert.equal(source.includes('const USTREAMER_STABLE_FEATURE_315_PATH = Object.freeze(['), true);
  assert.equal(source.includes('const USTREAMER_STABLE_FEATURE_317_PATH = Object.freeze(['), true);
  assert.equal(source.includes('const USTREAMER_STABLE_VERSION_STRING_PATH = Object.freeze(['), true);
  assert.equal(source.includes('const USTREAMER_STABLE_TIMEOUT_PATH = Object.freeze(['), true);
  assert.equal(source.includes('const USTREAMER_STABLE_START_BUDGET_PATH = Object.freeze(['), true);
  assert.equal(source.includes('const USTREAMER_RN1_FIELD_36_PATH = Object.freeze(['), true);
  assert.equal(source.includes('const USTREAMER_RN1_FIELD_39_PATH = Object.freeze(['), true);
  assert.equal(source.includes('const USTREAMER_RN1_FIELD_155_PATH = Object.freeze(['), true);
  assert.equal(source.includes('const USTREAMER_RN1_FIELD_278_PATH = Object.freeze(['), true);
  assert.equal(source.includes("const USTREAMER_STABLE_VERSION_STRING_BYTES = new self.TextEncoder().encode('v20250922_1226.00');"), true);
  assert.equal(source.includes('const USTREAMER_RN1_EXACT_TARGET_VALUES = Object.freeze({'), true);
  assert.equal(source.includes('const getUstreamerRn1ExactPatchPlan = targetVideoId => {'), true);
  assert.equal(source.includes('const removeProtoFieldAtPath = (rootFields, pathSegments) => rewriteProtoFieldAtPath('), true);
  assert.equal(source.includes('const getProtoFieldAtPath = (rootFields, pathSegments) => {'), true);
  assert.equal(source.includes('const setProtoBytesFieldAtPath = (rootFields, pathSegments, rawValue) => {'), true);
  assert.equal(source.includes('ustreamerSlowProfileNormalized'), true);
  assert.equal(source.includes('ustreamerSlowStartConfigRemoved'), true);
  assert.equal(source.includes('ustreamerRn1ExactPatchPlan'), true);
  assert.equal(source.includes('ustreamerRn1ExactPatchAppliedPaths'), true);
  assert.equal(source.includes('const sanitizeBootstrapPayloadValue = (value, source = \'\', url = location.href) => {'), true);
  assert.equal(source.includes("persistRewriteReport(\n            'player-bootstrap',"), true);
  assert.equal(source.includes('self.__talonYouTubeWatchPlayerResponseRewriteLastReport = report;'), true);
  assert.equal(source.includes('self.__talonYouTubeWatchBootstrapRewriteLastReport = report;'), true);
  assert.equal(source.includes('self.__talonYouTubeWatchPlayerBootstrapDefinedAt = Date.now();'), true);
  assert.equal(source.includes('self.__talonYouTubeWatchPlayerBootstrapInterceptedAt = Date.now();'), true);
  assert.equal(source.includes('self.__talonYouTubeWatchPlayerBootstrapSeen = true;'), true);
  assert.equal(source.includes('const installPlayerBootstrapOwnerPatch = () => {'), true);
  assert.equal(source.includes("const OWNER_MARK = '__td_yw_player_bootstrap_owner';"), true);
  assert.equal(source.includes('const installBootstrapAlignmentPatch = () => {'), true);
  assert.equal(source.includes('const installWindowFetchNeutralizer = () => {'), true);
  assert.equal(source.includes("self.__talonYouTubeWatchWindowFetchNeutralizerInstalled = true;"), true);
  assert.equal(source.includes("const WINDOW_FETCH_INLINE_RE = /window,\\s*\"fetch\"/;"), true);
  assert.equal(source.includes("self.__talonYouTubeWatchWindowFetchNeutralizedScriptCount = 0;"), true);
  assert.equal(source.includes('summarizePlayerResponse'), true);
  assert.equal(source.includes("installSanitizedGlobal('ytInitialPlayerResponse');"), true);
  assert.equal(source.includes('installWindowFetchNeutralizer();'), true);
  assert.equal(source.includes('installPlayerBootstrapOwnerPatch();'), true);
  assert.equal(source.includes('installBootstrapAlignmentPatch();'), true);
  assert.equal(source.includes('self.__talonYouTubeWatchSanitizerPlayerResponseFirstSetSummary ='), true);
  assert.equal(source.includes('self.__talonYouTubeWatchSanitizerPlayerResponseFirstSetAt = Date.now();'), true);
  assert.equal(source.includes("const FOLLOWUP_WATCH_SESSION_KEY = '__td_yw_last_watch';"), true);
  assert.equal(source.includes("const FOLLOWUP_PLAYER_RESPONSE_PREFETCH_SESSION_KEY = '__td_yw_prefetched_pr_sections';"), true);
  assert.equal(source.includes("const FOLLOWUP_COOKIE_CLEAR_REQUEST_EVENT = 'td-yw-followup-cookie-clear';"), true);
  assert.equal(source.includes("const FOLLOWUP_COOKIE_CLEAR_RESPONSE_EVENT = 'td-yw-followup-cookie-clear-result';"), true);
  assert.equal(source.includes("const FOLLOWUP_PREFETCH_REQUEST_EVENT = 'td-yw-followup-prefetch-sections';"), true);
  assert.equal(source.includes("const FOLLOWUP_PREFETCH_RESPONSE_EVENT = 'td-yw-followup-prefetch-sections-result';"), true);
  assert.equal(source.includes("const FOLLOWUP_PREFETCH_DONOR_CAPTURE_EVENT = 'td-yw-followup-prefetch-donor-capture';"), true);
  assert.equal(source.includes("const FOLLOWUP_TAB_NAVIGATE_REQUEST_EVENT = 'td-yw-followup-tab-navigate';"), true);
  assert.equal(source.includes("const FOLLOWUP_TAB_NAVIGATE_RESPONSE_EVENT = 'td-yw-followup-tab-navigate-result';"), true);
  assert.equal(source.includes("const FOLLOWUP_NEXT_RELEASE_EVENT = 'td-yw-followup-next-release';"), true);
  assert.equal(source.includes("const FOLLOWUP_PRECLICK_RELEASE_TIMEOUT_MS = 4000;"), true);
  assert.equal(source.includes("const FOLLOWUP_PRECLICK_TARGET_TTL_MS = 15000;"), true);
  assert.equal(source.includes("const FOLLOWUP_PRECLICK_ANCHOR_STABLE_DELAY_MS = 75;"), true);
  assert.equal(source.includes("const FOLLOWUP_PLAYER_RESPONSE_PREFETCH_TIMEOUT_MS = 1500;"), true);
  assert.equal(source.includes("const FOLLOWUP_PLAYER_RESPONSE_PREFETCH_TTL_MS = 30000;"), true);
  assert.equal(source.includes('const refreshFollowupWatchNavigationState = () => {'), true);
  assert.equal(source.includes('const PLAYER_RESPONSE_LITERAL_ANCHORS = Object.freeze(['), true);
  assert.equal(source.includes('const readFollowupPrefetchDonorToken = () => {'), true);
  assert.equal(source.includes('let followupNextSuppressionUntilEpochMs = 0;'), true);
  assert.equal(source.includes("let followupNextSuppressionTargetUrl = '';"), true);
  assert.equal(source.includes('const armFollowupNextSuppression = nextUrl => {'), true);
  assert.equal(source.includes('const shouldSuppressPendingFollowupNextRequest = url =>'), true);
  assert.equal(source.includes('self.__talonYouTubeWatchReplayFollowupNavigation ='), true);
  assert.equal(source.includes('const extractPrefetchedFollowupPlayerResponseSections = watchDocumentBody => {'), true);
  assert.equal(source.includes('const prefetchFollowupPlayerResponseSections = nextUrl => {'), true);
  assert.equal(source.includes('const markForcedWatchNavigationListenerEvent = event => {'), true);
  assert.equal(source.includes('self.__talonYouTubeWatchFollowupListenerEventType ='), true);
  assert.equal(source.includes('self.__talonYouTubeWatchFollowupListenerTargetUrl = normalizedTargetUrl;'), true);
  assert.equal(source.includes("credentials: 'include'"), true);
  assert.equal(source.includes("redirect: 'follow'"), true);
  assert.equal(source.includes("cache: 'no-store'"), true);
  assert.equal(source.includes("self.__talonYouTubeWatchPrefetchedPlayerResponseOk = ok === true;"), true);
  assert.equal(source.includes('const readStoredPrefetchedFollowupPlayerResponseSections = () => {'), true);
  assert.equal(source.includes('const pendingPrefetchedFollowupPlayerResponseSections ='), true);
  assert.equal(source.includes('const getPlayerResponseVideoId = value => {'), true);
  assert.equal(source.includes('const applyPrefetchedFollowupPlayerResponseSections = value => {'), true);
  assert.equal(source.includes('const emitFollowupPrefetchDonorSections = value => {'), true);
  assert.equal(source.includes('document.dispatchEvent(new CustomEvent(FOLLOWUP_PREFETCH_DONOR_CAPTURE_EVENT, {'), true);
  assert.equal(source.includes('const requestBackgroundFollowupPlayerResponseSections = targetUrl => {'), true);
  assert.equal(source.includes('document.dispatchEvent(new CustomEvent(FOLLOWUP_PREFETCH_REQUEST_EVENT, {'), true);
  assert.equal(source.includes("clonedValue.streamingData = clonePayload("), true);
  assert.equal(source.includes("clonedValue.playerConfig = clonePayload("), true);
  assert.equal(source.includes("self.__talonYouTubeWatchPrefetchedPlayerResponseApplied = true;"), true);
  assert.equal(source.includes('self.__talonYouTubeWatchReplayPoisonPatternTriggered = true;'), true);
  assert.equal(source.includes('self.__talonYouTubeWatchReplayFirstPayloadTiny ='), true);
  assert.equal(source.includes('const REPLAY_POISON_FIRST_PAYLOAD_MAX_BYTES = 1024;'), true);
  assert.equal(source.includes("const REPLAY_POISON_RECOVERY_MODE = 'pause';"), true);
  assert.equal(source.includes('const FOLLOWUP_NEXT_DELAY_TIMEOUT_MS = 30000;'), true);
  assert.equal(source.includes('const SHOULD_USE_EDGE_NEUTRAL_HOP ='), true);
  assert.equal(source.includes('/\\bEdg\\//.test'), true);
  assert.equal(source.includes('const REPLAY_POISON_RECOVERY_DELAY_MS = 75;'), true);
  assert.equal(source.includes('installReplayPoisonedBootstrapGuard();'), true);
  assert.equal(source.includes('requestFollowupCookieClear'), true);
  assert.equal(source.includes('const requestBackgroundFollowupNavigation = targetUrl => {'), true);
  assert.equal(source.includes('const ensureTrackAIntentLeaseStarted = state => {'), true);
  assert.equal(source.includes('const ensureTrackADonorOwnerStarted = state => {'), true);
  assert.equal(source.includes("document.addEventListener('pointerover', event => {"), true);
  assert.equal(source.includes("notePreclickTargetSignal(anchor, signalType);"), true);
  assert.equal(source.includes('const runTrackAExactAnchorIntentLease = nextUrl => {'), true);
  assert.equal(source.includes('const runTrackAExactTargetDonorOwner = nextUrl => {'), true);
  assert.equal(source.includes('document.dispatchEvent(new CustomEvent(FOLLOWUP_TAB_NAVIGATE_REQUEST_EVENT, {'), true);
  assert.equal(source.includes('clearCookiesAndHardNavigateToWatch(nextUrl);'), true);
  assert.equal(source.includes('requestBackgroundFollowupNavigation(normalizedTargetUrl).then(navigated => {'), true);
  assert.equal(source.includes('const isCurrentWatchDocumentForUrl = targetUrl => {'), true);
  assert.equal(source.includes('const markForcedWatchNavigationListenerEvent = event => {'), true);
  assert.equal(source.includes("anchor.closest('yt-lockup-view-model') !== null"), true);
  assert.equal(source.includes("anchor.classList.contains('yt-lockup-view-model__content-image')"), true);
  assert.equal(source.includes("anchor.classList.contains('yt-lockup-view-model__title')"), true);
  assert.equal(source.includes("anchor.classList.contains('yt-lockup-metadata-view-model__title')"), true);
  assert.equal(source.includes('const prefetchPromise = requestBackgroundFollowupPlayerResponseSections('), true);
  assert.equal(source.includes('requestBackgroundFollowupPlayerResponseSections(normalizedTargetUrl).catch(() => false).then('), true);
  assert.equal(source.includes('const createFollowupNextDelayGate = () => {'), true);
  assert.equal(source.includes('self.__talonYouTubeWatchFollowupNextReleaseReason = reason;'), true);
  assert.equal(source.includes('document.dispatchEvent(new CustomEvent(FOLLOWUP_NEXT_RELEASE_EVENT));'), true);
  assert.equal(source.includes('self.__talonYouTubeWatchFollowupNextSuppressedRequestUrl = url;'), true);
  assert.equal(source.includes('shouldDelayFollowupNextRequest(url) && followupNextDelayGate.shouldDelay()'), true);
  assert.equal(source.includes("if ( REPLAY_POISON_RECOVERY_MODE === 'pause-video-only' ) {"), false);
  assert.equal(source.includes("if ( REPLAY_POISON_RECOVERY_MODE === 'pause-cue-video-id' ) {"), false);
  assert.equal(source.includes("if ( REPLAY_POISON_RECOVERY_MODE === 'pause-cancel-playback' ) {"), false);
  assert.equal(source.includes("if ( REPLAY_POISON_RECOVERY_MODE === 'pause-clear-src-only' ) {"), false);
  assert.equal(source.includes("if ( REPLAY_POISON_RECOVERY_MODE === 'pause-clear-video' ) {"), false);
  assert.equal(source.includes('if ( typeof player.cueVideoById === \'function\' ) {'), false);
  assert.equal(source.includes('player.cueVideoByPlayerVars({ videoId: currentVideoId });'), false);
  assert.equal(source.includes("media.closest('#secondary') !== null"), true);
  assert.equal(source.includes('self.HTMLMediaElement.prototype.play = new Proxy'), true);
  assert.equal(source.includes("root.querySelectorAll('video, audio')"), true);
  assert.equal(
    source.includes('PAGEAD_ID_RE'),
    true
  );
  assert.equal(source.includes('QOE_RE'), true);
  assert.equal(source.includes('PTRACKING_RE'), true);
  assert.equal(source.includes('VIEWTHROUGH_RE'), true);
  assert.equal(source.includes('USER_LIST_RE'), true);
  assert.equal(source.includes('LVZ_RE'), true);
  assert.equal(source.includes('AD_STATUS_RE'), true);
  assert.equal(source.includes('LOG_EVENT_RE'), true);
  assert.equal(source.includes('WATCH_URL_RE'), true);
  assert.equal(source.includes('const PLAYER_REFERER_RELOAD_RE = /adunit|instream/i;'), true);
  assert.equal(source.includes("candidate.clientScreen = 'CHANNEL'"), true);
  assert.equal(source.includes("candidate.referer = `${candidate.referer}#reloadxhr`"), true);
  assert.equal(source.includes('buildNoContentResponse'), true);
  assert.equal(source.includes('buildXhrStubProfile'), true);
  assert.equal(source.includes('hardNavigateToWatch'), true);
  assert.equal(source.includes('STUB_PIXEL_URL'), true);
  assert.equal(source.includes("Object.defineProperty(self.HTMLImageElement.prototype, 'src'"), true);
  assert.equal(source.includes("Object.defineProperty(self.HTMLScriptElement.prototype, 'src'"), true);
  assert.equal(source.includes('noopScriptUrls = new WeakMap()'), true);
  assert.equal(source.includes('prepareNoopScriptForInsertion'), true);
  assert.equal(source.includes('queueNoopScriptLoad'), true);
  assert.equal(source.includes('self.google_ad_status = 1;'), true);
  assert.equal(source.includes("anchor.closest('#secondary')"), true);
  assert.equal(source.includes('location.assign(nextUrl);'), true);
  assert.equal(source.includes("currentVideo.removeAttribute('src')"), true);
  assert.equal(source.includes("child.type = 'application/x-talon-noop';"), true);
  assert.equal(source.includes("child.removeAttribute('src');"), true);
  assert.equal(source.includes('self.stop();'), true);
  assert.equal(source.includes('PTRACKING_RE.test(url) || VIEWTHROUGH_RE.test(url)'), true);
});

test('audit overrides keep only known subsystems and resolve by host', () => {
  const overrides = sanitizeBreakageAuditOverrides({
    global: {
      nativeHeuristics: false,
      unknown: true,
    },
    hosts: {
      'news.example.com': {
        remoteCosmetics: false,
        garbage: true,
      },
    },
  });

  assert.deepEqual(Object.keys(overrides.global), ['nativeHeuristics']);
  assert.equal(AUDITABLE_SUBSYSTEMS.includes('remoteCosmetics'), true);
  assert.equal(resolveAuditOverride(overrides, 'news.example.com', 'remoteCosmetics'), false);
  assert.equal(resolveAuditOverride(overrides, 'shop.example.com', 'nativeHeuristics'), false);
  assert.equal(resolveAuditOverride(overrides, 'shop.example.com', 'automation'), undefined);
});
