import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const readSource = relativePath =>
  fs.readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');

test('adaptive subsystems register the shared shadow DOM helper before their runtime files', async () => {
  const source = await readSource('js/scripting-manager.js');

  assert.match(source, /const TALON_SHADOW_DOM_HELPER_PATH = '\/js\/scripting\/shadow-dom-helper\.js'/);
  assert.match(source, /const TALON_BLOCK_HINTS_PATH = '\/js\/scripting\/block-hints\.js'/);
  assert.match(source, /const TALON_PUBLIC_SUFFIX_DATA_PATH = '\/shared\/public-suffix-data\.js'/);
  assert.match(source, /TALON_SHADOW_DOM_HELPER_PATH,\s*TALON_BLOCK_HINTS_PATH,\s*'\/js\/scripting\/native-heuristics\.js'/);
  assert.match(source, /TALON_SHADOW_DOM_HELPER_PATH,\s*TALON_BLOCK_HINTS_PATH,\s*'\/js\/scripting\/automation\.js'/);
  assert.match(source, /TALON_PUBLIC_SUFFIX_DATA_PATH,\s*'\/shared\/site-key-resolver\.js',\s*'\/js\/scripting\/breakage-guard\.js',\s*TALON_SHADOW_DOM_HELPER_PATH,\s*TALON_BLOCK_HINTS_PATH,\s*'\/js\/scripting\/remote-cosmetics\.js'/);
  assert.match(source, /TALON_SHADOW_DOM_HELPER_PATH,\s*TALON_BLOCK_HINTS_PATH,\s*'\/js\/scripting\/post-hide-cleanup\.js'/);
});

test('remote tactics stays packaged and bounded instead of executing remote code', async () => {
  const bootstrapSource = await readSource('js/scripting/remote-tactics-bootstrap.js');
  const mainSource = await readSource('js/scripting/remote-tactics.js');

  assert.match(bootstrapSource, /communityBundlePublicTactics/);
  assert.match(bootstrapSource, /td-remote-tactics-config/);
  assert.match(mainSource, /self\.fetch = new Proxy\(self\.fetch/);
  assert.match(mainSource, /self\.XMLHttpRequest = class extends NativeXMLHttpRequest/);
  assert.match(mainSource, /td-remote-tactics-request/);
  assert.doesNotMatch(mainSource, /\beval\s*\(/);
  assert.doesNotMatch(mainSource, /Function\s*\(/);
  assert.doesNotMatch(mainSource, /import\(/);
});

test('runtime refresh keeps remote tactics on a host-gated isolated and MAIN-world lane', async () => {
  const source = await readSource('js/background.js');
  const isolatedRefreshBlock = source.slice(
    source.indexOf('const ISOLATED_LIVE_RUNTIME_REFRESH_FILES = Object.freeze(['),
    source.indexOf('const REMOTE_COSMETICS_HOST_LIVE_RUNTIME_REFRESH_FILES = Object.freeze([')
  );

  assert.match(source, /const ISOLATED_LIVE_RUNTIME_REFRESH_FILES = Object\.freeze\(\[/);
  assert.match(source, /const REMOTE_COSMETICS_HOST_LIVE_RUNTIME_REFRESH_FILES = Object\.freeze\(\[[\s\S]*'\/js\/scripting\/remote-cosmetics-host\.js'[\s\S]*\]\);/);
  assert.match(source, /const REMOTE_TACTICS_ISOLATED_LIVE_RUNTIME_REFRESH_FILES = Object\.freeze\(\[[\s\S]*'\/js\/scripting\/remote-tactics-bootstrap\.js'[\s\S]*\]\);/);
  assert.match(source, /const MAIN_WORLD_LIVE_RUNTIME_REFRESH_FILES = Object\.freeze\(\[[\s\S]*'\/js\/scripting\/remote-tactics\.js'[\s\S]*\]\);/);
  assert.match(source, /target: \{ tabId, allFrames: true \}/);
  assert.match(source, /const tabMatchesHostnameSet = async \(/);
  assert.match(source, /if \( hostname !== '' && hostnames\.has\(hostname\) \) \{/);
  assert.match(source, /const frameUrls = await listTabFrameUrls\(tabId, fallbackUrl\)/);
  assert.match(source, /frameUrls\.some\(url => hostnames\.has\(normalizeHttpHostname\(url\)\)\)/);
  assert.match(source, /const shouldRefreshRemoteCosmeticsHost = await tabMatchesHostnameSet\(tabId, \{/);
  assert.match(source, /await executeRuntimeRefreshLane\(\s*tabId,\s*REMOTE_COSMETICS_HOST_LIVE_RUNTIME_REFRESH_FILES/);
  assert.match(source, /await executeRuntimeStopLane\(tabId, stopRemoteCosmeticsHostController\)/);
  assert.match(source, /const shouldRefreshRemoteTactics = await tabMatchesRemoteTacticHosts\(tabId, \{/);
  assert.match(source, /await executeRuntimeRefreshLane\(\s*tabId,\s*REMOTE_TACTICS_ISOLATED_LIVE_RUNTIME_REFRESH_FILES/);
  assert.match(source, /await executeRuntimeRefreshLane\(tabId, MAIN_WORLD_LIVE_RUNTIME_REFRESH_FILES, \{\s*world: 'MAIN',\s*\}\)/);
  assert.match(source, /await executeRuntimeStopLane\(tabId, stopRemoteTacticsBootstrapController\)/);
  assert.match(source, /await executeRuntimeStopLane\(tabId, stopMainWorldRuntimeControllers, \{\s*world: 'MAIN',\s*\}\)/);
  assert.match(source, /readRegisteredRemoteCosmeticHostnames\(\)/);
  assert.match(source, /readRegisteredRemoteTacticHostnames\(\)/);
  assert.match(source, /TalonRemoteTacticsBootstrapController/);
  assert.match(source, /TalonRemoteTacticsController/);
  assert.equal(
    isolatedRefreshBlock.includes('/js/scripting/remote-tactics-bootstrap.js'),
    false
  );
});

test('state-changing background entry points use unified injectable sync and expose reload-needed state', async () => {
  const source = await readSource('js/background.js');

  assert.match(source, /case 'applyRulesets':[\s\S]*syncInjectablesAndRefreshTabs\(\{ runtimeOnly: false \}\)/);
  assert.match(source, /case 'setFilteringMode':[\s\S]*syncInjectablesAndRefreshTabs\(\{ runtimeOnly: false \}\)/);
  assert.match(source, /case 'setDefaultFilteringMode':[\s\S]*syncInjectablesAndRefreshTabs\(\{ runtimeOnly: false \}\)/);
  assert.match(source, /case 'setFilteringModeDetails':[\s\S]*syncInjectablesAndRefreshTabs\(\{ runtimeOnly: false \}\)/);
  assert.match(source, /registerResult instanceof Object && registerResult\.ok === true/);
  assert.match(source, /case 'getTabReloadNeededState':/);
  assert.match(source, /markTabsForRemoteScriptletReload/);
});

test('popup surfaces reload-needed hotfix state with an explicit reload action', async () => {
  const htmlSource = await readSource('popup/popup.html');
  const jsSource = await readSource('popup/popup.js');
  const reloadMatches = jsSource.match(/chrome\.tabs\.reload\(currentTabId\)/g) ?? [];

  assert.match(htmlSource, /id="runtimeNotice"/);
  assert.match(htmlSource, /id="runtimeNoticeReload"/);
  assert.match(jsSource, /self\.addEventListener\("unhandledrejection", \(event\) => \{/);
  assert.match(jsSource, /async function reloadCurrentTab\(context\)/);
  assert.match(jsSource, /ignoreRuntimeError\(error\)/);
  assert.match(jsSource, /what: "getTabReloadNeededState"/);
  assert.match(jsSource, /currentReloadNeededReason === "remoteScriptletHotfix"/);
  assert.match(jsSource, /await reloadCurrentTab\("reload tab for hotfix"\)/);
  assert.equal(reloadMatches.length, 1);
});

test('remote cosmetics uses local style ownership instead of background CSS messaging', async () => {
  const source = await readSource('js/scripting/remote-cosmetics.js');

  assert.doesNotMatch(source, /what:\s*'insertCSS'/);
  assert.doesNotMatch(source, /what:\s*'removeCSS'/);
  assert.match(source, /STYLE_MARKER_ATTR = 'data-talon-remote-cosmetics'/);
  assert.match(source, /STYLE_SCOPE_ATTR = 'data-talon-remote-cosmetics-scope'/);
  assert.match(source, /ensureDocumentStyle\(scope, cssText\)/);
  assert.match(source, /syncShadowStyles\(scope\)/);
});

test('automation queries shadow roots and applies hide styling only to marked nodes', async () => {
  const source = await readSource('js/scripting/automation.js');

  assert.match(source, /shadowController\?\.enumerateRoots\?\.\(\)/);
  assert.match(source, /const buildHideStyleText = id => \{/);
  assert.match(source, /ensureShadowRootHideStyle\(root, styleId, cssText\)/);
  assert.match(source, /syncHideStyles\(activeDirectives\)/);
  assert.match(source, /for \( const selector of selectors \) \{/);
});

test('adaptive lanes opt into related fallback frames beyond scriptlets', async () => {
  const source = await readSource('js/scripting-manager.js');

  assert.match(
    source,
    /id: 'native-heuristics',[\s\S]*matchOriginAsFallback: true/
  );
  assert.match(
    source,
    /id: 'automation',[\s\S]*matchOriginAsFallback: true/
  );
  assert.match(
    source,
    /id: 'remote-cosmetics-global',[\s\S]*matchOriginAsFallback: true/
  );
  assert.match(
    source,
    /id: 'remote-cosmetics-host',[\s\S]*matchOriginAsFallback: true/
  );
  assert.match(
    source,
    /id: 'post-hide-cleanup',[\s\S]*matchOriginAsFallback: true/
  );
});

test('command-triggered picker injection suppresses only ignorable stale-tab failures', async () => {
  const source = await readSource('js/background.js');

  assert.match(
    source,
    /function onCommand\(command, tab\) \{[\s\S]*Number\.isInteger\(tab\?\.id\) === false[\s\S]*browser\.scripting\.executeScript\(\{[\s\S]*target: \{ tabId: tab\.id \},[\s\S]*\}\)\.catch\(ignoreRuntimeError\);/
  );
});
