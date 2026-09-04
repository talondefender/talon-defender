import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright';

const rootDir = process.cwd();
const args = process.argv.slice(2);
const argValue = name => args[args.indexOf(name) + 1];
const browserTarget = args.includes('--browser') ? argValue('--browser') : 'chrome';
if (![ 'chrome', 'edge' ].includes(browserTarget)) { throw new Error('unsupported browser target'); }
const packageDir = path.resolve(rootDir, args.includes('--dir') ? argValue('--dir') :
  browserTarget === 'edge' ? 'dist/edge-extension' : 'dist/extension');
let distDir = packageDir;
const existingPackage = args.includes('--existing-package');
const required = args.includes('--required') || process.env.TALON_CHROME_SMOKE_REQUIRED === '1';
const headed = !args.includes('--headless') && process.env.TALON_CHROME_SMOKE_HEADLESS !== '1';
const expectedMajor = args.includes('--expect-major') ? Number(argValue('--expect-major')) : 0;
const reportPath = args.includes('--report') ? path.resolve(argValue('--report')) : '';
const MODE_NONE = 0;
const MODE_OPTIMAL = 2;
const TRUSTED_DIRECTIVE_BASE_RULE_ID = 8000000;
const PAYWALL_DYNAMIC_RULE_ID = 8500000;
const CONTROL_PAGE_PATH = 'web_accessible_resources/noop.html';
const DEFAULT_RULESET_IDS = [
  'ublock-filters',
  'talon-youtube-allow',
  'talon-site-fixes',
  'easylist',
  'easyprivacy',
  'pgl',
  'ublock-badware',
  'urlhaus-full',
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const exists = async filePath => {
  if (!filePath) { return false; }
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

const assert = (condition, message) => {
  if (condition) { return; }
  throw new Error(message);
};

const runPackage = () => {
  const result = spawnSync(process.execPath, [browserTarget === 'edge' ? 'scripts/package-edge-extension.mjs' : 'scripts/package-extension.mjs'], {
    cwd: rootDir,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`package-extension failed with exit code ${result.status}`);
  }
};

const findChromeExecutable = async () => {
  if (browserTarget === 'edge') {
    const edgeCandidates = [process.env.TALON_EDGE_PATH, process.env.EDGE_PATH,
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
      path.join(process.env.PROGRAMFILES || '', 'Microsoft/Edge/Application/msedge.exe'),
      '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
    for (const candidate of edgeCandidates) { if (await exists(candidate)) return candidate; }
    return '';
  }
  const candidates = [
    process.env.TALON_CHROME_PATH,
    process.env.CHROME_PATH,
  ];

  try {
    candidates.push(chromium.executablePath());
  } catch {
  }

  if (process.platform === 'win32') {
    candidates.push(
      path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
      path.join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google/Chrome/Application/chrome.exe')
    );
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser'
    );
  }

  for (const candidate of candidates) {
    if (await exists(candidate)) { return candidate; }
  }
  return '';
};

const getExtensionIdFromManifest = async () => {
  const raw = await fs.readFile(path.join(distDir, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(raw);
  const key = typeof manifest.key === 'string' ? manifest.key.trim() : '';
  if (key === '') { return ''; }
  const digest = createHash('sha256').update(Buffer.from(key, 'base64')).digest();
  const alphabet = 'abcdefghijklmnop';
  let out = '';
  for (let i = 0; i < 16; i += 1) {
    out += alphabet[digest[i] >> 4];
    out += alphabet[digest[i] & 0x0f];
  }
  return out;
};

const getExtensionIdFromServiceWorker = async context => {
  const worker = context.serviceWorkers()[0] ||
    await context.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
  const match = worker?.url()?.match(/^chrome-extension:\/\/([^/]+)\//);
  return match?.[1] || '';
};

const stopExtensionServiceWorker = async (context, page, extensionId) => {
  const session = await context.newCDPSession(page);
  const versions = new Map();
  const collect = event => {
    for (const version of event?.versions || []) {
      versions.set(version.versionId, version);
    }
  };
  session.on('ServiceWorker.workerVersionUpdated', collect);
  try {
    await session.send('ServiceWorker.enable');
    await sleep(500);
    const version = Array.from(versions.values()).find(entry =>
      typeof entry?.scriptURL === 'string' &&
      entry.scriptURL.startsWith(`chrome-extension://${extensionId}/`)
    );
    if (!version?.versionId) { return false; }
    await session.send('ServiceWorker.stopWorker', {
      versionId: version.versionId,
    });
    await sleep(500);
    return true;
  } finally {
    await session.detach().catch(() => {});
  }
};

const waitFor = async (label, fn, { timeoutMs = 15000, intervalMs = 250 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) { return value; }
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  const suffix = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`${label} timed out${suffix}`);
};

const sendRuntimeMessage = (page, message) =>
  page.evaluate(payload => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`runtime message timed out: ${payload.what}`)), 20000);
    chrome.runtime.sendMessage(payload, response => {
      clearTimeout(timeout);
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(response);
    });
  }), message);

const setLocalStorage = (page, data) =>
  page.evaluate(payload => new Promise((resolve, reject) => {
    chrome.storage.local.set(payload, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(true);
    });
  }), data);

const setSyncStorage = (page, data) =>
  page.evaluate(payload => new Promise((resolve, reject) => {
    chrome.storage.sync.set(payload, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(true);
    });
  }), data);

const getLocalStorage = (page, keys) =>
  page.evaluate(payload => new Promise((resolve, reject) => {
    chrome.storage.local.get(payload, result => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(result);
    });
  }), keys);

const getSyncStorage = (page, keys) =>
  page.evaluate(payload => new Promise((resolve, reject) => {
    chrome.storage.sync.get(payload, result => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(result);
    });
  }), keys);

const getEnabledRulesets = page =>
  page.evaluate(() => new Promise((resolve, reject) => {
    chrome.declarativeNetRequest.getEnabledRulesets(ids => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(ids);
    });
  }));

const getDynamicRules = (page, ruleIds) =>
  page.evaluate(ids => new Promise((resolve, reject) => {
    chrome.declarativeNetRequest.getDynamicRules({ ruleIds: ids }, rules => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(rules);
    });
  }), ruleIds);

const getAllDynamicRules = page =>
  page.evaluate(() => new Promise((resolve, reject) => {
    chrome.declarativeNetRequest.getDynamicRules(rules => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(rules);
    });
  }));

const getAllSessionRules = page =>
  page.evaluate(() => new Promise((resolve, reject) => {
    chrome.declarativeNetRequest.getSessionRules(rules => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(rules);
    });
  }));

const getTabIdForUrl = (page, url) =>
  page.evaluate(targetUrl => new Promise((resolve, reject) => {
    chrome.tabs.query({ url: targetUrl }, tabs => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(Number.isInteger(tabs?.[0]?.id) ? tabs[0].id : -1);
    });
  }), url);

const getRegisteredContentScriptCount = page =>
  page.evaluate(() => new Promise((resolve, reject) => {
    chrome.scripting.getRegisteredContentScripts(entries => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(Array.isArray(entries) ? entries.length : -1);
    });
  }));

const waitForOptionsStartup = page =>
  waitFor('extension startup', async () => {
    const response = await sendRuntimeMessage(page, { what: 'getOptionsPageData' });
    if (typeof response?.error === 'string' && response.error !== '') {
      throw new Error(response.error);
    }
    return Array.isArray(response?.rulesetDetails) && response.rulesetDetails.length > 0
      ? response
      : null;
  }, { timeoutMs: 45000 });

const gotoControlPage = (page, extensionId) =>
  page.goto(`chrome-extension://${extensionId}/${CONTROL_PAGE_PATH}`, {
    waitUntil: 'domcontentloaded',
  });

const writeEntitlementState = async (page, { local, sync }) => {
  let localStored = null;
  let syncStored = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await setLocalStorage(page, { talonEntitlement: local });
    await setSyncStorage(page, { talonEntitlementSync: sync });
    await sleep(150);
    localStored = await getLocalStorage(page, ['talonEntitlement']);
    syncStored = await getSyncStorage(page, ['talonEntitlementSync']);
    if (
      localStored?.talonEntitlement?.trialEndMs === local.trialEndMs &&
      syncStored?.talonEntitlementSync?.trialEndMs === sync.trialEndMs
    ) {
      return page;
    }
    await sleep(250 * (attempt + 1));
  }
  assert(
    false,
    `entitlement smoke write did not persist: local=${JSON.stringify(localStored?.talonEntitlement || null)} sync=${JSON.stringify(syncStored?.talonEntitlementSync || null)}`
  );
  return page;
};

const runYouTubePolicySmoke = async (context, control) => {
  const entitlementBefore = (await getLocalStorage(control, ['talonEntitlement'])).talonEntitlement;
  const syncBefore = (await getSyncStorage(control, ['talonEntitlementSync'])).talonEntitlementSync;
  const origin = 'https:' + '//www.youtube.com';
  await context.route(`${origin}/**`, route => route.fulfill({
    status: 200, contentType: 'text/html',
    body: `<!doctype html><title>Local policy test</title><script>
      window.fixtureGuardBeforeInline = window.TalonYoutubePlayerGuardController?.isActive?.() === true;
      localStorage.setItem('yt-enforcement-fixture', 'probe');
      window.fixtureInlineValue = localStorage.getItem('yt-enforcement-fixture');
      window.fixtureDocumentId = Math.random();
    </script><div id="movie_player" class="html5-video-player ad-showing"><video></video></div>`,
  }));
  const setMode = level => sendRuntimeMessage(control, {
    what: 'setFilteringMode', hostname: 'www.youtube.com', level,
  });
  assert(await setMode(MODE_OPTIMAL) === MODE_OPTIMAL, 'YouTube enable failed');
  const fixture = await context.newPage();
  try {
    const extensionId = new URL(control.url()).hostname;
    const stoppedBeforeNavigation = await stopExtensionServiceWorker(context, control, extensionId);
    assert(stoppedBeforeNavigation, 'YouTube first-navigation worker eviction did not run');
    await fixture.goto(`${origin}/watch?v=local-policy-test`);
    const early = await fixture.evaluate(() => ({
      beforeInline: window.fixtureGuardBeforeInline, value: window.fixtureInlineValue,
      document: window.fixtureDocumentId,
    }));
    assert(early.beforeInline && early.value === null, 'YouTube document-start guard was late or missing');
    await waitFor('YouTube ad runtime', () => fixture.evaluate(() =>
      document.querySelector('video').playbackRate === 16));
    assert(await setMode(MODE_NONE) === MODE_NONE, 'YouTube disable failed');
    await waitFor('YouTube live teardown', () => fixture.evaluate(() =>
      window.TalonYoutubePlayerGuardController?.isActive?.() === false &&
      document.querySelector('video').playbackRate === 1));
    const stopped = await fixture.evaluate(() => {
      localStorage.setItem('yt-enforcement-fixture', 'allowed');
      document.dispatchEvent(new Event('visibilitychange'));
      document.dispatchEvent(new Event('yt-navigate-finish'));
      return { value: localStorage.getItem('yt-enforcement-fixture'), document: window.fixtureDocumentId };
    });
    assert(stopped.value === 'allowed' && stopped.document === early.document,
      'YouTube disable modified navigation or kept the storage hook');
    await sleep(800);
    assert(await fixture.evaluate(() => document.querySelector('video').playbackRate) === 1,
      'YouTube event restarted stopped ad playback handling');
    await fixture.reload();
    assert(await fixture.evaluate(() => window.TalonYoutubePlayerGuardController === undefined &&
      window.fixtureInlineValue === 'probe'), 'Allowed Sites still injected YouTube guard');
    await fixture.evaluate(() => {
      window.TalonYoutubePlayerGuardController = { refresh() { window.legacyRefreshCalled = true; } };
    });
    const legacyTabId = await getTabIdForUrl(control, fixture.url());
    await control.evaluate(async tabId => chrome.scripting.executeScript({
      target: { tabId }, world: 'ISOLATED',
      func: () => {
        globalThis.TalonYoutubeAdSkipController = { refresh() { globalThis.legacyAdSkipRefreshed = true; } };
      },
    }), legacyTabId);
    assert(await setMode(MODE_OPTIMAL) === MODE_OPTIMAL, 'YouTube re-enable failed');
    assert(await fixture.evaluate(() => !window.legacyRefreshCalled &&
      window.TalonYoutubePlayerGuardController.revision === undefined),
      'YouTube update stacked on an irreversible legacy guard');
    const isolatedLegacy = await control.evaluate(async tabId => chrome.scripting.executeScript({
      target: { tabId }, world: 'ISOLATED',
      func: () => !globalThis.legacyAdSkipRefreshed && globalThis.TalonYoutubeAdSkipController.revision === undefined,
    }), legacyTabId);
    assert(isolatedLegacy[0]?.result === true, 'YouTube update restarted the legacy isolated controller');
    await fixture.reload();
    assert(await fixture.evaluate(() => window.TalonYoutubePlayerGuardController?.revision === 2),
      'YouTube migration did not complete after natural navigation');
    const expired = {
      trialStartMs: Date.now() - 8 * 24 * 60 * 60 * 1000,
      trialEndMs: Date.now() - 24 * 60 * 60 * 1000,
    };
    await writeEntitlementState(control, {
      local: { ...entitlementBefore, ...expired }, sync: { ...syncBefore, ...expired },
    });
    await waitFor('YouTube expired entitlement', async () =>
      (await sendRuntimeMessage(control, { what: 'getEntitlementStatus' }))?.status === 'expired');
    await waitFor('YouTube entitlement teardown', () => fixture.evaluate(() =>
      window.TalonYoutubePlayerGuardController?.isActive?.() === false &&
      document.querySelector('video').playbackRate === 1));
    await fixture.reload();
    assert(await fixture.evaluate(() => window.TalonYoutubePlayerGuardController === undefined &&
      window.fixtureInlineValue === 'probe'), 'Expired entitlement injected YouTube guard');
    await writeEntitlementState(control, { local: entitlementBefore, sync: syncBefore });
    await waitFor('YouTube restored entitlement', async () =>
      (await sendRuntimeMessage(control, { what: 'getEntitlementStatus' }))?.status === 'trial');
    await waitFor('YouTube entitlement live restoration', () => fixture.evaluate(() =>
      window.TalonYoutubePlayerGuardController?.isActive?.() === true));
    const entitlementAfter = (await getLocalStorage(control, ['talonEntitlement'])).talonEntitlement;
    assert(entitlementAfter.deviceId === entitlementBefore.deviceId &&
      entitlementAfter.trialStartMs === entitlementBefore.trialStartMs &&
      entitlementAfter.trialEndMs === entitlementBefore.trialEndMs,
    'YouTube lifecycle did not preserve device and trial state');
  } finally {
    await fixture.close();
    await context.unroute(`${origin}/**`);
  }
};

const run = async () => {
  if (!existingPackage) { runPackage(); }

  const browserPath = await findChromeExecutable();
  if (browserPath === '') {
    const message = `${browserTarget} smoke skipped: no browser executable found. Set the matching TALON_CHROME_PATH or TALON_EDGE_PATH.`;
    if (required) { throw new Error(message); }
    console.warn(message);
    return;
  }

  let extensionIdFromKey = await getExtensionIdFromManifest();
  if (browserTarget === 'chrome' && expectedMajor === 0) {
    assert(extensionIdFromKey !== '', 'packaged manifest is missing a stable extension key');
  }

  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'talon-chrome-smoke-'));
  distDir = path.join(userDataDir, 'package');
  await fs.cp(packageDir, distDir, { recursive: true });
  const lifecycleServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Talon lifecycle smoke</title>');
  });
  await new Promise((resolve, reject) => {
    lifecycleServer.once('error', reject);
    lifecycleServer.listen(0, '127.0.0.1', resolve);
  });
  const lifecycleAddress = lifecycleServer.address();
  assert(
    lifecycleAddress && typeof lifecycleAddress === 'object',
    'lifecycle smoke server did not expose an address'
  );
  const lifecycleUrl = `http://127.0.0.1:${lifecycleAddress.port}/`;
  const context = await chromium.launchPersistentContext(path.join(userDataDir, 'profile'), {
    executablePath: browserPath,
    headless: headed === false,
    args: [
      ...(headed ? [] : [ '--headless=new' ]),
      `--disable-extensions-except=${distDir}`,
      `--load-extension=${distDir}`,
      '--disable-default-apps',
      '--disable-sync',
      '--no-default-browser-check',
      '--no-first-run',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
    ],
  });

  try {
    const browserVersion = context.browser()?.version() || '';
    if (expectedMajor) {
      assert(Number(browserVersion.split('.')[0]) === expectedMajor,
        `expected browser major ${expectedMajor}, got ${browserVersion}`);
    }
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.hostname === '127.0.0.1' || url.hostname === 'localhost' ||
        url.protocol === 'chrome-extension:' ? route.continue() : route.abort();
    });
    if (extensionIdFromKey === '') { extensionIdFromKey = await getExtensionIdFromServiceWorker(context); }
    assert(extensionIdFromKey !== '', 'loaded extension service worker was not found');
    let page = await context.newPage();
    await gotoControlPage(page, extensionIdFromKey);

    const extensionIdFromWorker = await getExtensionIdFromServiceWorker(context);
    if (extensionIdFromWorker !== '') {
      assert(
        extensionIdFromWorker === extensionIdFromKey,
        `service worker extension id mismatch: ${extensionIdFromWorker} !== ${extensionIdFromKey}`
      );
    }

    let optionsData;
    try {
      optionsData = await waitForOptionsStartup(page);
    } catch (error) {
      const warmup = await sendRuntimeMessage(page, {
        what: 'popupWarmup',
      }).catch(reason => ({ transportError: `${reason}` }));
      const diagnostics = await getLocalStorage(page, [
        'contentScriptRegistrationMutationJournalV1',
        'entitlementEffectsDirtyV1',
        'injectableCssCacheDirtyV1',
        'injectableRuntimeStateV1',
        'injectableSyncDiagnosticsV1',
        'initialSetupPendingV1',
        'pendingRemoteScriptletReloadHintV1',
        'sandboxFilters.dnrDirtyV1',
        'sandboxFilters.registrationDirtyV1',
        'startupDocumentRuntimeDirtyV1',
        'startupSessionCommitV1',
      ]).catch(reason => ({ storageError: `${reason}` }));
      throw new Error(
        `${error instanceof Error ? error.message : error}; ` +
        `popupWarmup=${JSON.stringify(warmup)}; ` +
        `diagnostics=${JSON.stringify(diagnostics)}`
      );
    }
    assert(Array.isArray(optionsData.rulesetDetails), 'options startup response is malformed');

    const enabledRulesets = await waitFor('default DNR rulesets', async () => {
      const ids = await getEnabledRulesets(page);
      return DEFAULT_RULESET_IDS.every(id => ids.includes(id)) ? ids : null;
    });
    assert(
      DEFAULT_RULESET_IDS.every(id => enabledRulesets.includes(id)),
      `default rulesets not enabled: ${enabledRulesets.join(',')}`
    );

    const dynamicRegexRules = await waitFor('base dynamic regex rules', async () => {
      const rules = await getAllDynamicRules(page);
      const regexRules = rules.filter(rule =>
        typeof rule?.condition?.regexFilter === 'string' &&
        rule.id < TRUSTED_DIRECTIVE_BASE_RULE_ID
      );
      return regexRules.length >= 100 ? regexRules : null;
    });
    assert(
      dynamicRegexRules.length >= 100,
      `base dynamic regex rules missing: ${dynamicRegexRules.length}`
    );

    const strictSessionRules = await waitFor('strict-block session rules', async () => {
      const rules = await getAllSessionRules(page);
      const strictRules = rules.filter(rule =>
        rule?.action?.type === 'redirect' &&
        typeof rule?.action?.redirect?.regexSubstitution === 'string'
      );
      return strictRules.length >= 100 ? strictRules : null;
    });
    const strictRuleIds = strictSessionRules.map(rule => rule.id);
    assert(
      new Set(strictRuleIds).size === strictRuleIds.length,
      'strict-block session rules contain duplicate ids'
    );

    const startupErrors = await sendRuntimeMessage(page, { what: 'getConsoleOutput' });
    assert(Array.isArray(startupErrors), 'background error log response is malformed');
    // External DNS is deliberately blocked. This one expected transport error
    // exercises stored/packaged fallback; all other startup errors still fail.
    const unexpectedStartupErrors = startupErrors.filter(entry =>
      String(entry).endsWith('community-sync: Failed to fetch') === false);
    assert(
      unexpectedStartupErrors.length === 0,
      `background startup errors: ${unexpectedStartupErrors.join(' | ')}`
    );

    const lifecyclePage = await context.newPage();
    await lifecyclePage.goto(lifecycleUrl, { waitUntil: 'domcontentloaded' });
    let lifecycleTabId = await getTabIdForUrl(page, lifecycleUrl);
    assert(lifecycleTabId >= 0, 'lifecycle smoke tab was not discoverable');
    const reloadStateBefore = await sendRuntimeMessage(page, {
      what: 'getTabReloadNeededState',
      tabId: lifecycleTabId,
    });
    assert(
      reloadStateBefore?.reason === '',
      `fresh install unexpectedly requested a tab reload: ${JSON.stringify(reloadStateBefore)}`
    );

    // An unpacked-extension reload/update makes Chrome rebuild dynamic
    // content-script registrations. Exercise the same startup repair path in
    // this isolated profile without disabling the command-line-loaded test
    // extension itself.
    const registeredCountBeforeRepair =
      await getRegisteredContentScriptCount(page);
    assert(
      registeredCountBeforeRepair > 0,
      'lifecycle smoke had no registered content scripts to repair'
    );
    await page.evaluate(() => new Promise((resolve, reject) => {
      chrome.scripting.unregisterContentScripts(() => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message));
          return;
        }
        chrome.alarms.create('injectable-startup-retry', {
          when: Date.now() + 100,
        });
        resolve(true);
      });
    }));
    await waitFor('startup registration repair', async () => {
      const count = await getRegisteredContentScriptCount(page);
      return count === registeredCountBeforeRepair ? true : null;
    }, { timeoutMs: 45000 });
    await waitFor('startup registration journal settlement', async () => {
      const state = await getLocalStorage(page, [
        'pendingRemoteScriptletReloadHintV1',
      ]);
      return state?.pendingRemoteScriptletReloadHintV1 === undefined
        ? true
        : null;
    }, { timeoutMs: 45000 });
    lifecycleTabId = await getTabIdForUrl(page, lifecycleUrl);
    assert(lifecycleTabId >= 0, 'lifecycle smoke tab disappeared after extension reload');
    const reloadStateAfter = await sendRuntimeMessage(page, {
      what: 'getTabReloadNeededState',
      tabId: lifecycleTabId,
    });
    assert(
      reloadStateAfter?.reason === '',
      `same-version registration repair requested a tab reload: ${JSON.stringify(reloadStateAfter)}`
    );
    const reloadLedgerAfter = await getLocalStorage(page, [
      'reloadNeededTabsV1',
      'pendingRemoteScriptletReloadHintV1',
    ]);
    assert(
      reloadLedgerAfter?.reloadNeededTabsV1 === undefined,
      `same-version registration repair left a reload ledger: ${JSON.stringify(reloadLedgerAfter)}`
    );
    assert(
      reloadLedgerAfter?.pendingRemoteScriptletReloadHintV1 === undefined,
      `same-version registration repair left a pending journal: ${JSON.stringify(reloadLedgerAfter)}`
    );
    await lifecyclePage.close();

    const wakeStateBefore = await getLocalStorage(page, [
      'injectableSyncDiagnosticsV1',
      'injectableRuntimeStateV1',
    ]);
    const workerStopped = await stopExtensionServiceWorker(
      context,
      page,
      extensionIdFromKey
    ).catch(() => false);
    if (workerStopped) {
      await waitForOptionsStartup(page);
      const wakeStateAfter = await getLocalStorage(page, [
        'injectableSyncDiagnosticsV1',
        'injectableRuntimeStateV1',
      ]);
      assert(
        (Number(wakeStateAfter?.injectableSyncDiagnosticsV1?.updatedAt) || 0) ===
          (Number(wakeStateBefore?.injectableSyncDiagnosticsV1?.updatedAt) || 0),
        'unchanged service-worker wake rebuilt injectable registrations'
      );
      assert(
        JSON.stringify(wakeStateAfter?.injectableRuntimeStateV1 || null) ===
          JSON.stringify(wakeStateBefore?.injectableRuntimeStateV1 || null),
        'unchanged service-worker wake rewrote persisted injectable state'
      );
    } else {
      if (required) { throw new Error('required service-worker eviction assertion could not run'); }
      console.warn('Chrome smoke could not force service-worker eviction; no-op wake assertion skipped.');
    }

    const entitlementReadBefore = await getLocalStorage(page, [
      'injectableSyncDiagnosticsV1',
      'injectableRuntimeStateV1',
    ]);
    await sendRuntimeMessage(page, { what: 'getEntitlementStatus' });
    const entitlementReadAfter = await getLocalStorage(page, [
      'injectableSyncDiagnosticsV1',
      'injectableRuntimeStateV1',
    ]);
    assert(
      JSON.stringify(entitlementReadAfter) === JSON.stringify(entitlementReadBefore),
      'read-only entitlement status request mutated injectable state'
    );

    const now = Date.now();
    const deviceId = `smoke-${now}`;
    page = await writeEntitlementState(page, {
      local: {
        trialStartMs: now - 10 * 24 * 60 * 60 * 1000,
        trialEndMs: now - 24 * 60 * 60 * 1000,
        deviceId,
      },
      sync: {
        trialStartMs: now - 10 * 24 * 60 * 60 * 1000,
        trialEndMs: now - 24 * 60 * 60 * 1000,
      },
    });
    const expiredStatus = await waitFor('expired entitlement paywall', async () => {
      const status = await sendRuntimeMessage(page, { what: 'getEntitlementStatus' });
      if (status?.status !== 'expired') {
        throw new Error(`status=${status?.status || 'missing'}`);
      }
      return status;
    });
    assert(expiredStatus.status === 'expired', 'expired entitlement status was not applied');

    const paywallRules = await waitFor('paywall allow-all rule', async () => {
      const rules = await getDynamicRules(page, [PAYWALL_DYNAMIC_RULE_ID]);
      return rules.length === 1 && rules[0]?.action?.type === 'allowAllRequests'
        ? rules
        : null;
    });
    assert(paywallRules.length === 1, 'paywall allow-all rule was not installed');

    page = await writeEntitlementState(page, {
      local: {
        trialStartMs: now,
        trialEndMs: now + 7 * 24 * 60 * 60 * 1000,
        deviceId,
      },
      sync: {
        trialStartMs: now,
        trialEndMs: now + 7 * 24 * 60 * 60 * 1000,
      },
    });
    const restoredStatus = await waitFor('restored trial entitlement', async () => {
      const status = await sendRuntimeMessage(page, { what: 'getEntitlementStatus' });
      if (status?.status !== 'trial') {
        throw new Error(`status=${status?.status || 'missing'}`);
      }
      return status;
    });
    assert(restoredStatus.status === 'trial', 'trial entitlement was not restored');

    await waitFor('paywall allow-all removal', async () => {
      const rules = await getDynamicRules(page, [PAYWALL_DYNAMIC_RULE_ID]);
      return rules.length === 0 ? true : null;
    });

    const allowSiteLevel = await sendRuntimeMessage(page, {
      what: 'setFilteringMode',
      hostname: 'example.com',
      level: MODE_NONE,
    });
    assert(
      allowSiteLevel === MODE_NONE,
      `allowed site level was not saved: ${JSON.stringify(allowSiteLevel)}`
    );

    const allowedSiteModes = await sendRuntimeMessage(page, { what: 'getFilteringModeDetails' });
    assert(
      Array.isArray(allowedSiteModes?.none) && allowedSiteModes.none.includes('example.com'),
      `Allowed Sites did not list example.com: ${JSON.stringify(allowedSiteModes)}`
    );

    await waitFor('allowed site allow-all DNR rule', async () => {
      const rules = await getDynamicRules(page, [TRUSTED_DIRECTIVE_BASE_RULE_ID]);
      const rule = rules[0];
      return rule?.action?.type === 'allowAllRequests' &&
        Array.isArray(rule?.condition?.requestDomains) &&
        rule.condition.requestDomains.includes('example.com')
        ? rules
        : null;
    });

    const protectSiteLevel = await sendRuntimeMessage(page, {
      what: 'setFilteringMode',
      hostname: 'example.com',
      level: MODE_OPTIMAL,
    });
    assert(protectSiteLevel === MODE_OPTIMAL, `site protection level was not restored: ${protectSiteLevel}`);

    const protectedSiteModes = await sendRuntimeMessage(page, { what: 'getFilteringModeDetails' });
    assert(
      Array.isArray(protectedSiteModes?.none) && protectedSiteModes.none.includes('example.com') === false,
      `Allowed Sites did not remove example.com: ${JSON.stringify(protectedSiteModes)}`
    );

    const quotaMessage = await page.evaluate(async () => {
      const mod = await import(chrome.runtime.getURL('/options/ruleset-toggle-state.js'));
      return mod.formatRulesetApplyError({
        error: 'static_ruleset_quota_exceeded',
        staticRuleQuota: {
          requiredStaticRuleCount: 5000,
          projectedAvailableStaticRuleCount: 3500,
        },
      });
    });
    assert(
      quotaMessage === 'Chrome rule limit: needs 5000, available 3500',
      `unexpected options quota message: ${quotaMessage}`
    );

    await runYouTubePolicySmoke(context, page);
    if (reportPath) {
      await fs.writeFile(reportPath, JSON.stringify({
        browser: browserTarget, version: browserVersion, expectedMajor,
        executable: path.basename(browserPath), verifiedAt: new Date().toISOString(),
      }, null, 2) + '\n');
    }
    console.log(`${browserTarget} smoke passed with ${path.basename(browserPath)} ${context.browser()?.version()} and extension ${extensionIdFromKey}.`);
  } finally {
    await context.close().catch(() => {});
    await new Promise(resolve => lifecycleServer.close(resolve));
    if (!path.resolve(userDataDir).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
      throw new Error('refusing profile cleanup outside the temporary directory');
    }
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
};

run().catch(error => {
  console.error('Chrome smoke failed.');
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
