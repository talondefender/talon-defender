import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const readSource = relativePath =>
  fs.readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');

const countMatches = (source, pattern) => (source.match(pattern) ?? []).length;

test('adaptive subsystems keep the shared helper ordering and bounded remote tactics lanes', async () => {
  const source = await readSource('js/scripting-manager.js');

  assert.match(source, /const TALON_SHADOW_DOM_HELPER_PATH = '\/js\/scripting\/shadow-dom-helper\.js'/);
  assert.match(source, /const TALON_BLOCK_HINTS_PATH = '\/js\/scripting\/block-hints\.js'/);
  assert.match(source, /TALON_SHADOW_DOM_HELPER_PATH,\s*TALON_BLOCK_HINTS_PATH,\s*'\/js\/scripting\/native-heuristics\.js'/);
  assert.match(source, /TALON_SHADOW_DOM_HELPER_PATH,\s*TALON_BLOCK_HINTS_PATH,\s*'\/js\/scripting\/automation\.js'/);
  assert.match(source, /\/js\/scripting\/remote-cosmetics-global\.js/);
  assert.match(source, /\/js\/scripting\/remote-cosmetics-host\.js/);
  assert.match(source, /id: 'remote-tactics-bootstrap'/);
  assert.match(source, /id: 'remote-tactics-main'/);
  assert.match(source, /world: 'MAIN'/);
  assert.doesNotMatch(source, /registerNationalPostAntiAdblock/);
  assert.doesNotMatch(source, /registerFinancialPostCompatibility/);
  assert.doesNotMatch(source, /registerFinancialPostAntiAdblock/);
});

test('remote tactics stays packaged and bootstrap caching is explicit', async () => {
  const bootstrapSource = await readSource('js/scripting/remote-tactics-bootstrap.js');
  const mainSource = await readSource('js/scripting/remote-tactics.js');

  assert.match(bootstrapSource, /const STORAGE_KEY = 'communityBundlePublicTactics';/);
  assert.match(bootstrapSource, /let cachedTactics = \[\];/);
  assert.match(bootstrapSource, /let cacheLoaded = false;/);
  assert.match(bootstrapSource, /let pendingRead = null;/);
  assert.match(bootstrapSource, /if \( cacheLoaded \) \{/);
  assert.match(bootstrapSource, /if \( pendingRead instanceof Promise \) \{/);
  assert.match(bootstrapSource, /changes\[STORAGE_KEY\] === undefined/);
  assert.match(bootstrapSource, /cachedTactics = \[\];\s*cacheLoaded = false;/);
  assert.match(mainSource, /self\.fetch = new Proxy\(self\.fetch/);
  assert.match(mainSource, /self\.XMLHttpRequest = class extends NativeXMLHttpRequest/);
  assert.doesNotMatch(mainSource, /\beval\s*\(/);
  assert.doesNotMatch(mainSource, /Function\s*\(/);
  assert.doesNotMatch(mainSource, /import\(/);
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
