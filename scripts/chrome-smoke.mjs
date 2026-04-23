import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright';

const rootDir = process.cwd();
const distDir = path.resolve(rootDir, 'dist/extension');
const required = process.env.TALON_CHROME_SMOKE_REQUIRED === '1';
const headed = process.env.TALON_CHROME_SMOKE_HEADLESS !== '1';
const PAYWALL_DYNAMIC_RULE_ID = 8500000;
const CONTROL_PAGE_PATH = 'web_accessible_resources/noop.html';
const DEFAULT_RULESET_IDS = [
  'ublock-filters',
  'easylist',
  'easyprivacy',
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
  const result = spawnSync(process.execPath, ['scripts/package-extension.mjs'], {
    cwd: rootDir,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`package-extension failed with exit code ${result.status}`);
  }
};

const findChromeExecutable = async () => {
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
    chrome.runtime.sendMessage(payload, response => {
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

const waitForOptionsStartup = page =>
  waitFor('extension startup', async () => {
    const response = await sendRuntimeMessage(page, { what: 'getOptionsPageData' });
    return Array.isArray(response?.rulesetDetails) && response.rulesetDetails.length > 0
      ? response
      : null;
  });

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

const run = async () => {
  runPackage();

  const browserPath = await findChromeExecutable();
  if (browserPath === '') {
    const message = 'Chrome smoke skipped: no Chrome/Chromium executable found. Set TALON_CHROME_PATH to run it.';
    if (required) { throw new Error(message); }
    console.warn(message);
    return;
  }

  const extensionIdFromKey = await getExtensionIdFromManifest();
  assert(extensionIdFromKey !== '', 'packaged manifest is missing a stable extension key');

  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'talon-chrome-smoke-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: browserPath,
    headless: headed === false,
    args: [
      `--disable-extensions-except=${distDir}`,
      `--load-extension=${distDir}`,
      '--disable-default-apps',
      '--disable-sync',
      '--no-default-browser-check',
      '--no-first-run',
    ],
  });

  try {
    let page = await context.newPage();
    await gotoControlPage(page, extensionIdFromKey);

    const extensionIdFromWorker = await getExtensionIdFromServiceWorker(context);
    if (extensionIdFromWorker !== '') {
      assert(
        extensionIdFromWorker === extensionIdFromKey,
        `service worker extension id mismatch: ${extensionIdFromWorker} !== ${extensionIdFromKey}`
      );
    }

    const optionsData = await waitForOptionsStartup(page);
    assert(Array.isArray(optionsData.rulesetDetails), 'options startup response is malformed');

    const enabledRulesets = await waitFor('default DNR rulesets', async () => {
      const ids = await getEnabledRulesets(page);
      return DEFAULT_RULESET_IDS.every(id => ids.includes(id)) ? ids : null;
    });
    assert(
      DEFAULT_RULESET_IDS.every(id => enabledRulesets.includes(id)),
      `default rulesets not enabled: ${enabledRulesets.join(',')}`
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

    console.log(`Chrome smoke passed with ${path.basename(browserPath)} and extension ${extensionIdFromKey}.`);
  } finally {
    await context.close().catch(() => {});
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
};

run().catch(error => {
  console.error('Chrome smoke failed.');
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
