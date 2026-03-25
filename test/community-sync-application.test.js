import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

const fallbackRules = JSON.parse(
  await fs.readFile(new URL('../automation/community-fallback.json', import.meta.url), 'utf8')
);

const clone = value => structuredClone(value);

const storageData = Object.create(null);
const alarmCreates = [];
const alarmClears = [];

const dnrState = {
  dynamicRules: [],
  sessionRules: [],
  failCommunityUpdateCount: 0,
};

const makeStorageArea = data => ({
  async get(key) {
    if (key === null) {
      return clone(data);
    }
    if (Array.isArray(key)) {
      const out = {};
      for (const entry of key) {
        if (Object.hasOwn(data, entry)) {
          out[entry] = clone(data[entry]);
        }
      }
      return out;
    }
    if (typeof key === 'string') {
      return Object.hasOwn(data, key)
        ? { [key]: clone(data[key]) }
        : {};
    }
    if (key && typeof key === 'object') {
      const out = {};
      for (const [entry, fallback] of Object.entries(key)) {
        out[entry] = Object.hasOwn(data, entry)
          ? clone(data[entry])
          : fallback;
      }
      return out;
    }
    return {};
  },
  async set(entries) {
    for (const [key, value] of Object.entries(entries || {})) {
      data[key] = clone(value);
    }
  },
  async remove(key) {
    const keys = Array.isArray(key) ? key : [key];
    for (const entry of keys) {
      delete data[entry];
    }
  },
});

const filterRulesByIds = (rules, ruleIds) => {
  if (Array.isArray(ruleIds) === false) {
    return rules;
  }
  return rules.filter(rule => ruleIds.includes(rule.id));
};

const dnr = {
  MAX_NUMBER_OF_DYNAMIC_RULES: 5000,
  MAX_NUMBER_OF_REGEX_RULES: 1000,
  async getDynamicRules(options = {}) {
    return clone(filterRulesByIds(dnrState.dynamicRules, options.ruleIds));
  },
  async updateDynamicRules({ addRules = [], removeRuleIds = [] } = {}) {
    const hasCommunityRules = addRules.some(rule => rule.id >= 6000000 && rule.id < 7000000);
    if (hasCommunityRules && dnrState.failCommunityUpdateCount > 0) {
      dnrState.failCommunityUpdateCount -= 1;
      throw new Error('simulated community apply failure');
    }
    dnrState.dynamicRules = dnrState.dynamicRules.filter(
      rule => removeRuleIds.includes(rule.id) === false
    );
    dnrState.dynamicRules.push(...clone(addRules));
  },
  async getSessionRules(options = {}) {
    return clone(filterRulesByIds(dnrState.sessionRules, options.ruleIds));
  },
  async updateSessionRules({ addRules = [], removeRuleIds = [] } = {}) {
    dnrState.sessionRules = dnrState.sessionRules.filter(
      rule => removeRuleIds.includes(rule.id) === false
    );
    dnrState.sessionRules.push(...clone(addRules));
  },
  async isRegexSupported() {
    return { isSupported: true };
  },
  async getEnabledRulesets() {
    return [];
  },
  async updateEnabledRulesets() {
  },
  async getAvailableStaticRuleCount() {
    return 0;
  },
};

const runtimeBaseUrl = 'chrome-extension://talon-defender-test/';
let remoteBundle = null;

const browserStub = {
  declarativeNetRequest: dnr,
  tabs: {
    TAB_ID_NONE: -1,
  },
  alarms: {
    create(name, info) {
      alarmCreates.push({ name, info: clone(info) });
    },
    async clear(name) {
      alarmClears.push(name);
      return true;
    },
  },
  storage: {
    local: makeStorageArea(storageData),
  },
  runtime: {
    getManifest() {
      return {
        homepage_url: 'https://talondefender.com',
        permissions: [],
      };
    },
    getURL(path = '') {
      return new URL(path, runtimeBaseUrl).toString();
    },
    async sendMessage() {
      return undefined;
    },
  },
};

globalThis.self = globalThis;
globalThis.browser = browserStub;
globalThis.chrome = browserStub;
globalThis.atob ??= value => Buffer.from(value, 'base64').toString('binary');
Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  value: {
  subtle: {
    digest: (...args) => webcrypto.subtle.digest(...args),
    importKey: async () => ({}),
    verify: async () => true,
  },
  },
});
globalThis.fetch = async input => {
  const url = String(input);
  if (url === 'https://api.talondefender.com/v1/community/latest.bundle.json') {
    if (remoteBundle === null) {
      throw new Error('missing remote bundle');
    }
    return {
      ok: true,
      async json() {
        return clone(remoteBundle);
      },
    };
  }
  if (url === new URL('automation/community-fallback.json', runtimeBaseUrl).toString()) {
    return {
      ok: true,
      async json() {
        return clone(fallbackRules);
      },
    };
  }
  throw new Error(`Unexpected fetch URL: ${url}`);
};

const { rulesetConfig } = await import(new URL('../js/config.js', import.meta.url));
const {
  COMMUNITY_SYNC_FAILURE_RETRY_MS,
} = await import(new URL('../js/community-sync-logic.js', import.meta.url));
const { syncCommunityRules } = await import(new URL('../js/community-sync.js', import.meta.url));

const signatureBytesB64 = Buffer.alloc(64).toString('base64');

const sha256Hex = async text => {
  const digest = await webcrypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text)
  );
  return Buffer.from(new Uint8Array(digest)).toString('hex');
};

const createSignedBundle = async ({
  rules,
  cosmetics,
  heuristics,
  schemaVersion = 2,
  integrityScope = 'full',
  version = '2026.03.25.1',
} = {}) => {
  const bundle = {
    version,
    schemaVersion,
    rules: clone(rules),
    integrity: {
      algorithm: 'sha256',
      scope: integrityScope,
      value: '',
    },
    signature: {
      algorithm: 'ed25519',
      value: signatureBytesB64,
    },
  };
  if (integrityScope === 'full') {
    bundle.cosmetics = cosmetics ?? null;
    bundle.heuristics = heuristics ?? null;
    bundle.directives = null;
    bundle.scriptlets = null;
  }
  const payload = integrityScope === 'full'
    ? {
        rules: bundle.rules,
        cosmetics: bundle.cosmetics ?? null,
        heuristics: bundle.heuristics ?? null,
        directives: bundle.directives ?? null,
        scriptlets: bundle.scriptlets ?? null,
        schemaVersion,
      }
    : {
        schemaVersion,
        rules: bundle.rules,
      };
  bundle.integrity.value = await sha256Hex(JSON.stringify(payload));
  return bundle;
};

const resetEnvironment = () => {
  for (const key of Object.keys(storageData)) {
    delete storageData[key];
  }
  alarmCreates.length = 0;
  alarmClears.length = 0;
  dnrState.dynamicRules.length = 0;
  dnrState.sessionRules.length = 0;
  dnrState.failCommunityUpdateCount = 0;
  remoteBundle = null;
  rulesetConfig.communityRulesEnabled = true;
  rulesetConfig.communityRulesURL = '';
  rulesetConfig.developerMode = false;
};

test('community sync falls back to stored rules when remote apply fails', { concurrency: false }, async () => {
  resetEnvironment();

  const storedRules = [
    {
      action: { type: 'block' },
      condition: { urlFilter: '||stored.example^' },
    },
  ];
  const lastSuccess = Date.UTC(2026, 2, 25, 17, 0, 0, 0);
  await browserStub.storage.local.set({
    communityBundleRules: storedRules,
    communityBundleMeta: {
      version: 'stored-v1',
      schemaVersion: 1,
      ttlHours: 24,
    },
    communityBundleLastSuccess: lastSuccess,
  });

  remoteBundle = await createSignedBundle({
    rules: [
      {
        action: { type: 'block' },
        condition: { urlFilter: '||remote.example^' },
      },
    ],
    integrityScope: 'rules',
    version: 'remote-v2',
  });
  dnrState.failCommunityUpdateCount = 1;

  const startedAt = Date.now();
  const result = await syncCommunityRules({ force: true });
  const retryAlarm = alarmCreates.at(-1);

  assert.equal(result.source, 'stored');
  assert.match(result.error, /apply failed: simulated community apply failure/);
  assert.equal(storageData.communityBundleMeta.version, 'stored-v1');
  assert.equal(storageData.communityBundleLastSuccess, lastSuccess);
  assert.match(storageData.communityBundleLastError, /apply failed: simulated community apply failure/);
  assert.ok(typeof storageData.communityBundleLastAttempt === 'number');
  assert.equal(retryAlarm.name, 'community-sync');
  assert.ok(retryAlarm.info.when >= startedAt + COMMUNITY_SYNC_FAILURE_RETRY_MS - 2000);
  assert.ok(retryAlarm.info.when <= Date.now() + COMMUNITY_SYNC_FAILURE_RETRY_MS + 2000);
  assert.deepEqual(
    dnrState.dynamicRules
      .filter(rule => rule.id >= 6000000 && rule.id < 7000000)
      .map(rule => rule.condition.urlFilter),
    ['||stored.example^']
  );
});

test('community sync stores signed global cosmetics and heuristic selector tuning', { concurrency: false }, async () => {
  resetEnvironment();

  remoteBundle = await createSignedBundle({
    rules: [
      {
        action: { type: 'block' },
        condition: { urlFilter: '||remote.example^' },
      },
    ],
    cosmetics: {
      all: ['.global-banner', 'body'],
      hosts: {
        'accounts.google.com': ['.should-drop'],
        'news.example': ['.inline-promo'],
      },
    },
    heuristics: {
      disableHosts: ['example.com'],
      labelRegexes: ['sponsored', '('],
      labelSelectors: ['.sponsored-label', 'body', '.sponsored-label'],
      widgetSelectors: ['ins.adsbygoogle', 'html'],
      containerStopSelectors: ['.ad-slot'],
      minScore: 3,
      minScoreLowConfidence: 4,
    },
  });

  const result = await syncCommunityRules({ force: true });

  assert.equal(result.source, 'remote');
  assert.equal(result.requiresInjectableRefresh, true);
  assert.deepEqual(storageData.communityBundleCosmetics, {
    all: ['.global-banner'],
    hosts: {
      'news.example': ['.inline-promo'],
    },
  });
  assert.deepEqual(storageData.communityBundleHeuristics, {
    disableHosts: ['example.com'],
    labelRegexes: ['sponsored'],
    labelSelectors: ['.sponsored-label', '.sponsored-label'],
    widgetSelectors: ['ins.adsbygoogle'],
    containerStopSelectors: ['.ad-slot'],
    minScore: 4,
    minScoreLowConfidence: 5,
  });
  assert.equal(storageData.communityBundleMeta.cosmeticsCount, 2);
  assert.equal(storageData.communityBundleMeta.hostCosmeticsCount, 1);
  assert.equal(storageData.communityBundleMeta.heuristicRegexCount, 1);
  assert.ok(typeof storageData.communityBundleLastSuccess === 'number');
  assert.equal(Object.hasOwn(storageData, 'communityBundleLastError'), false);
});

test('packaged community fallback bundle is valid and non-empty', { concurrency: false }, () => {
  assert.equal(Array.isArray(fallbackRules), true);
  assert.ok(fallbackRules.length > 0);
  assert.ok(fallbackRules.every(rule => rule?.action?.type === 'block'));
});
