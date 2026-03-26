import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

const fallbackRules = JSON.parse(
  await fs.readFile(new URL('../automation/community-fallback.json', import.meta.url), 'utf8')
);

const clone = value => structuredClone(value);

const storageData = Object.create(null);
const sessionData = Object.create(null);
const alarmCreates = [];
const alarmClears = [];
const permissionsState = {
  broadHostPermissions: true,
};
const rulesetResources = {
  '/rulesets/ruleset-details.json': [
    {
      id: 'strict',
      rules: {
        strictblock: 3,
        regex: 0,
      },
    },
  ],
  '/rulesets/strictblock/strict.json': [
    {
      action: {
        type: 'redirect',
        redirect: {},
      },
      condition: {
        regexFilter: '^https:\\/\\/strict-1\\.example\\/',
        resourceTypes: ['main_frame'],
      },
    },
    {
      action: {
        type: 'redirect',
        redirect: {},
      },
      condition: {
        regexFilter: '^https:\\/\\/strict-2\\.example\\/',
        resourceTypes: ['main_frame'],
      },
    },
    {
      action: {
        type: 'redirect',
        redirect: {},
      },
      condition: {
        regexFilter: '^https:\\/\\/strict-3\\.example\\/',
        resourceTypes: ['main_frame'],
      },
    },
  ],
};

const dnrState = {
  dynamicRules: [],
  sessionRules: [],
  failCommunityUpdateCount: 0,
  failSessionUpdateCount: 0,
  enabledRulesets: [],
};

const DEFAULT_MAX_NUMBER_OF_DYNAMIC_RULES = 5000;
const DEFAULT_MAX_NUMBER_OF_REGEX_RULES = 1000;

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
  MAX_NUMBER_OF_DYNAMIC_RULES: DEFAULT_MAX_NUMBER_OF_DYNAMIC_RULES,
  MAX_NUMBER_OF_REGEX_RULES: DEFAULT_MAX_NUMBER_OF_REGEX_RULES,
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
    if (dnrState.failSessionUpdateCount > 0) {
      dnrState.failSessionUpdateCount -= 1;
      throw new Error('simulated session update failure');
    }
    dnrState.sessionRules = dnrState.sessionRules.filter(
      rule => removeRuleIds.includes(rule.id) === false
    );
    dnrState.sessionRules.push(...clone(addRules));
  },
  async isRegexSupported() {
    return { isSupported: true };
  },
  async getEnabledRulesets() {
    return clone(dnrState.enabledRulesets);
  },
  async updateEnabledRulesets() {
  },
  async getAvailableStaticRuleCount() {
    return 0;
  },
};

const runtimeBaseUrl = 'chrome-extension://talon-defender-test/';
let remoteBundle = null;
const remoteOverlayResponses = new Map();
const overlayFetchLog = [];

const browserStub = {
  declarativeNetRequest: dnr,
  tabs: {
    TAB_ID_NONE: -1,
  },
  permissions: {
    async getAll() {
      return {
        origins: permissionsState.broadHostPermissions ? ['<all_urls>'] : [],
      };
    },
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
    session: makeStorageArea(sessionData),
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
  let parsedUrl = null;
  try {
    parsedUrl = new URL(url);
  } catch {
    parsedUrl = null;
  }
  if (
    parsedUrl &&
    parsedUrl.origin === 'https://api.talondefender.com' &&
    parsedUrl.pathname.startsWith('/v1/community/overlay/') &&
    parsedUrl.pathname.endsWith('.bundle.json')
  ) {
    const siteKey = decodeURIComponent(
      parsedUrl.pathname.slice(
        '/v1/community/overlay/'.length,
        parsedUrl.pathname.length - '.bundle.json'.length
      )
    );
    overlayFetchLog.push({
      siteKey,
      baseline: parsedUrl.searchParams.get('baseline') || '',
      known: parsedUrl.searchParams.get('known') || '',
    });
    const response = remoteOverlayResponses.get(siteKey);
    if (response === undefined) {
      throw new Error(`missing remote overlay: ${siteKey}`);
    }
    if (typeof response.throwMessage === 'string' && response.throwMessage !== '') {
      throw new Error(response.throwMessage);
    }
    const status = Number(response.status) || 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return clone(response.body);
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
  if (Object.hasOwn(rulesetResources, url)) {
    return {
      ok: true,
      async json() {
        return clone(rulesetResources[url]);
      },
    };
  }
  throw new Error(`Unexpected fetch URL: ${url}`);
};

const { rulesetConfig } = await import(new URL('../js/config.js', import.meta.url));
const {
  COMMUNITY_SYNC_FAILURE_RETRY_MS,
} = await import(new URL('../js/community-sync-logic.js', import.meta.url));
const { textFromRules } = await import(new URL('../js/dnr-parser.js', import.meta.url));
const {
  canonicalizeCommunityScriptlets,
  finalizeCommunityActivationSuccess,
  rollbackCommunityActivation,
  scrubPrivateCommunityState,
  syncCommunityOverlayRules,
  syncCommunityRules,
} = await import(new URL('../js/community-sync.js', import.meta.url));
const {
  updateCommunityRules,
  updateSessionRules,
  updateUserRules,
} = await import(new URL('../js/ruleset-manager.js', import.meta.url));
const { dnr: compatDnr } = await import(new URL('../js/ext-compat.js', import.meta.url));

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
  directives,
  scriptlets,
  tactics,
  schemaVersion = 2,
  integrityScope = 'full',
  version = '2026.03.25.1',
  ttlHours,
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
    bundle.directives = directives ?? null;
    bundle.scriptlets = scriptlets ?? null;
    if (schemaVersion >= 4) {
      bundle.tactics = tactics ?? null;
    }
  }
  if (ttlHours !== undefined) {
    bundle.ttlHours = ttlHours;
  }
  const payload = integrityScope === 'full'
    ? {
        rules: bundle.rules,
        cosmetics: bundle.cosmetics ?? null,
        heuristics: bundle.heuristics ?? null,
        directives: bundle.directives ?? null,
        scriptlets: bundle.scriptlets ?? null,
        ...(schemaVersion >= 4 ? { tactics: bundle.tactics ?? null } : {}),
        schemaVersion,
      }
    : {
        schemaVersion,
        rules: bundle.rules,
      };
  bundle.integrity.value = await sha256Hex(JSON.stringify(payload));
  return bundle;
};

const createSignedOverlayBundle = async ({
  siteKey,
  baselineVersion,
  rules,
  cosmetics,
  heuristics,
  directives,
  scriptlets,
  tactics,
  schemaVersion = 3,
  version = 'overlay.2026.03.25.1',
  ttlMinutes = 30,
} = {}) => {
  const bundle = {
    version,
    schemaVersion,
    siteKey,
    baselineVersion,
    ttlMinutes,
    rules: clone(rules),
    cosmetics: cosmetics ?? null,
    heuristics: heuristics ?? null,
    directives: directives ?? null,
    scriptlets: scriptlets ?? null,
    ...(schemaVersion >= 4 ? { tactics: tactics ?? null } : {}),
    integrity: {
      algorithm: 'sha256',
      value: '',
    },
    signature: {
      algorithm: 'ed25519',
      value: signatureBytesB64,
    },
  };
  bundle.integrity.value = await sha256Hex(JSON.stringify({
      siteKey: bundle.siteKey,
      baselineVersion: bundle.baselineVersion,
      ttlMinutes: bundle.ttlMinutes,
      schemaVersion,
      rules: bundle.rules,
      cosmetics: bundle.cosmetics,
      heuristics: bundle.heuristics,
      directives: bundle.directives,
      scriptlets: bundle.scriptlets,
      ...(schemaVersion >= 4 ? { tactics: bundle.tactics ?? null } : {}),
    }));
  return bundle;
};

const applyBaselineBundle = async bundle => {
  remoteBundle = bundle;
  const result = await syncCommunityRules({ force: true });
  if (result.activation) {
    await finalizeCommunityActivationSuccess(result.activation);
  }
  return result;
};

const applyOverlayBundle = async (siteKey, options = {}) => {
  const result = await syncCommunityOverlayRules({
    siteKey,
    force: true,
    reason: 'test-overlay',
    ...options,
  });
  if (result.activation) {
    await finalizeCommunityActivationSuccess(result.activation);
  }
  return result;
};

const resetEnvironment = () => {
  for (const key of Object.keys(storageData)) {
    delete storageData[key];
  }
  for (const key of Object.keys(sessionData)) {
    delete sessionData[key];
  }
  alarmCreates.length = 0;
  alarmClears.length = 0;
  dnrState.dynamicRules.length = 0;
  dnrState.sessionRules.length = 0;
  dnrState.failCommunityUpdateCount = 0;
  dnrState.failSessionUpdateCount = 0;
  dnrState.enabledRulesets.length = 0;
  dnr.MAX_NUMBER_OF_DYNAMIC_RULES = DEFAULT_MAX_NUMBER_OF_DYNAMIC_RULES;
  dnr.MAX_NUMBER_OF_REGEX_RULES = DEFAULT_MAX_NUMBER_OF_REGEX_RULES;
  remoteBundle = null;
  remoteOverlayResponses.clear();
  overlayFetchLog.length = 0;
  permissionsState.broadHostPermissions = true;
  rulesetConfig.communityRulesEnabled = true;
  rulesetConfig.communityRulesURL = '';
  rulesetConfig.developerMode = false;
  rulesetConfig.strictBlockMode = true;
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

test('community sync treats stored extras-only state as last-known-good fallback state', { concurrency: false }, async () => {
  resetEnvironment();

  const storedMeta = {
    version: 'stored-extras-v1',
    schemaVersion: 4,
    ttlHours: 6,
  };
  await browserStub.storage.local.set({
    communityBundleRules: [],
    communityBundleMeta: storedMeta,
    communityBundlePublicDirectives: [
      {
        id: 'stored-directive',
        category: 'annoyances',
        action: 'hide',
        hosts: ['=video.example'],
        selectors: ['.stored-directive'],
        fallbackAction: undefined,
        fallbackSelectors: [],
        postActions: [],
        maxApplies: undefined,
      },
    ],
    communityBundlePublicScriptlets: [
      {
        rulesetId: 'ublock-filters',
        token: 'abort-on-property-read',
        hosts: ['video.example'],
        world: 'MAIN',
      },
    ],
    communityBundlePublicTactics: [
      {
        id: 'stored-tactic',
        kind: 'jsonPrune',
        hosts: ['=video.example'],
        transport: 'fetch',
        urlPathPrefixes: ['/api/player'],
        jsonPaths: ['payload.adPlacements'],
      },
    ],
  });

  remoteBundle = await createSignedBundle({
    rules: [
      {
        action: { type: 'block' },
        condition: { urlFilter: '||remote.example^' },
      },
    ],
    version: 'remote-v2',
  });
  dnrState.failCommunityUpdateCount = 1;

  const result = await syncCommunityRules({ force: true });

  assert.equal(result.source, 'stored');
  assert.deepEqual(result.meta, storedMeta);
  assert.equal(storageData.communityBundleMeta.version, 'stored-extras-v1');
  assert.deepEqual(storageData.communityBundlePublicDirectives, [
    {
      id: 'stored-directive',
      category: 'annoyances',
      action: 'hide',
      hosts: ['=video.example'],
      selectors: ['.stored-directive'],
      fallbackAction: undefined,
      fallbackSelectors: [],
      postActions: [],
      maxApplies: undefined,
    },
  ]);
  assert.deepEqual(storageData.communityBundlePublicScriptlets, [
    {
      rulesetId: 'ublock-filters',
      token: 'abort-on-property-read',
      hosts: ['video.example'],
      world: 'MAIN',
    },
  ]);
  assert.deepEqual(storageData.communityBundlePublicTactics, [
    {
      id: 'stored-tactic',
      kind: 'jsonPrune',
      hosts: ['=video.example'],
      transport: 'fetch',
      urlPathPrefixes: ['/api/player'],
      jsonPaths: ['payload.adPlacements'],
    },
  ]);
  assert.deepEqual(
    dnrState.dynamicRules.filter(rule => rule.id >= 6000000 && rule.id < 7000000),
    []
  );
});

test('community sync uses packaged fallback when no stored compiled community state exists', { concurrency: false }, async () => {
  resetEnvironment();

  remoteBundle = await createSignedBundle({
    rules: [
      {
        action: { type: 'block' },
        condition: { urlFilter: '||remote.example^' },
      },
    ],
    version: 'remote-v2',
  });
  dnrState.failCommunityUpdateCount = 1;

  const result = await syncCommunityRules({ force: true });
  const communityRules = dnrState.dynamicRules
    .filter(rule => rule.id >= 6000000 && rule.id < 7000000);

  assert.equal(result.source, 'fallback');
  assert.match(result.error, /apply failed: simulated community apply failure/);
  assert.equal(communityRules.length, fallbackRules.length);
});

test('community sync records combined errors when stored restore fails before packaged fallback succeeds', { concurrency: false }, async () => {
  resetEnvironment();

  await browserStub.storage.local.set({
    communityBundleRules: [
      {
        action: { type: 'block' },
        condition: { urlFilter: '||stored.example^' },
      },
    ],
    communityBundleMeta: {
      version: 'stored-v1',
      schemaVersion: 2,
      ttlHours: 6,
    },
  });

  remoteBundle = await createSignedBundle({
    rules: [
      {
        action: { type: 'block' },
        condition: { urlFilter: '||remote.example^' },
      },
    ],
    version: 'remote-v2',
  });
  dnrState.failCommunityUpdateCount = 2;

  const result = await syncCommunityRules({ force: true });
  const communityRules = dnrState.dynamicRules
    .filter(rule => rule.id >= 6000000 && rule.id < 7000000);

  assert.equal(result.source, 'fallback');
  assert.match(result.error, /apply failed: simulated community apply failure/);
  assert.match(result.error, /stored restore failed: simulated community apply failure/);
  assert.equal(communityRules.length, fallbackRules.length);
});

test('community sync stores signed protected exact-host cosmetics and aligned heuristic tuning', { concurrency: false }, async () => {
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
        '=accounts.google.com': ['.checkout-promo'],
        'accounts.google.com': ['.should-drop'],
        'news.example': ['.inline-promo'],
      },
    },
    heuristics: {
      disableHosts: ['=example.com'],
      labelRegexes: ['sponsored', '('],
      labelSelectors: ['.sponsored-label', 'body', '.sponsored-label'],
      widgetSelectors: ['ins.adsbygoogle', 'html'],
      containerStopSelectors: ['.ad-slot'],
      minScore: 3,
      minScoreLowConfidence: 4,
      minContainerHeight: 30,
      minContainerWidth: 60,
      maxLabelTextLength: 80,
    },
  });

  const result = await syncCommunityRules({ force: true });
  await finalizeCommunityActivationSuccess(result.activation);

  assert.equal(result.source, 'remote');
  assert.equal(result.requiresInjectableRefresh, true);
  assert.deepEqual(storageData.communityBundleCosmetics, {
    all: ['.global-banner'],
    hosts: {
      '=accounts.google.com': ['.checkout-promo'],
      'news.example': ['.inline-promo'],
    },
  });
  assert.deepEqual(storageData.communityBundleHeuristics, {
    disableHosts: ['=example.com'],
    labelRegexes: ['sponsored'],
    labelSelectors: ['.sponsored-label', '.sponsored-label'],
    widgetSelectors: ['ins.adsbygoogle'],
    containerStopSelectors: ['.ad-slot'],
    maxLabelTextLength: 80,
    minContainerHeight: 30,
    minContainerWidth: 60,
    minScore: 3,
    minScoreLowConfidence: 4,
  });
  assert.equal(storageData.communityBundleMeta.cosmeticsCount, 3);
  assert.equal(storageData.communityBundleMeta.hostCosmeticsCount, 2);
  assert.equal(storageData.communityBundleMeta.protectedCosmeticsCount, 1);
  assert.equal(storageData.communityBundleMeta.heuristicRegexCount, 1);
  assert.ok(typeof storageData.communityBundleLastSuccess === 'number');
  assert.equal(Object.hasOwn(storageData, 'communityBundleLastError'), false);
});

test('community sync prioritizes exact-host exceptions and redirects under dynamic quota pressure', { concurrency: false }, async () => {
  resetEnvironment();
  dnr.MAX_NUMBER_OF_DYNAMIC_RULES = 254;

  remoteBundle = await createSignedBundle({
    schemaVersion: 2,
    rules: [
      {
        action: { type: 'block' },
        condition: {
          urlFilter: '||broad.example^',
          resourceTypes: ['script'],
        },
      },
      {
        action: { type: 'block' },
        condition: {
          regexFilter: '^https:' + '\\/\\/regex\\.example/',
          resourceTypes: ['script'],
        },
      },
      {
        action: { type: 'block' },
        condition: {
          requestDomains: ['exact.example'],
          resourceTypes: ['script'],
        },
      },
      {
        action: {
          type: 'redirect',
          redirect: {
            extensionPath: 'web_accessible_resources/noop.js',
          },
        },
        condition: {
          initiatorDomains: ['news.example.com'],
          requestDomains: ['cdn.example.net'],
          resourceTypes: ['script'],
        },
      },
      {
        action: { type: 'allow' },
        condition: {
          initiatorDomains: ['news.example.com'],
          requestDomains: ['cdn.example.net'],
          resourceTypes: ['script'],
        },
      },
      {
        action: { type: 'allowAllRequests' },
        condition: {
          requestDomains: ['news.example.com'],
          resourceTypes: ['main_frame'],
        },
      },
    ],
  });

  const result = await syncCommunityRules({ force: true });
  const communityRules = dnrState.dynamicRules
    .filter(rule => rule.id >= 6000000 && rule.id < 7000000);

  assert.equal(result.source, 'remote');
  assert.equal(result.applied.added, 4);
  assert.equal(result.applied.droppedQuota, 2);
  assert.deepEqual(result.applied.dropped.quotaByClass, {
    exactExceptions: 0,
    exactRedirects: 0,
    exactBlocks: 0,
    broadBlocks: 1,
    regexBlocks: 1,
  });
  assert.deepEqual(
    communityRules.map(rule => ({
      action: rule.action.type,
      requestDomains: rule.condition.requestDomains || [],
      hasRegex: Boolean(rule.condition.regexFilter),
      urlFilter: rule.condition.urlFilter || '',
    })),
    [
      {
        action: 'allow',
        requestDomains: ['cdn.example.net'],
        hasRegex: false,
        urlFilter: '',
      },
      {
        action: 'allowAllRequests',
        requestDomains: ['news.example.com'],
        hasRegex: false,
        urlFilter: '',
      },
      {
        action: 'redirect',
        requestDomains: ['cdn.example.net'],
        hasRegex: false,
        urlFilter: '',
      },
      {
        action: 'block',
        requestDomains: ['exact.example'],
        hasRegex: false,
        urlFilter: '',
      },
    ]
  );
});

test('community sync applies passive packaged XML and media redirect stubs through the signed bundle path', { concurrency: false }, async () => {
  resetEnvironment();

  remoteBundle = await createSignedBundle({
    schemaVersion: 2,
    rules: [
      {
        action: {
          type: 'redirect',
          redirect: {
            extensionPath: 'web_accessible_resources/noop-vast3.xml',
          },
        },
        condition: {
          initiatorDomains: ['video.example.com'],
          requestDomains: ['ads.example.net'],
          resourceTypes: ['xmlhttprequest'],
          domainType: 'thirdParty',
        },
      },
      {
        action: {
          type: 'redirect',
          redirect: {
            extensionPath: 'web_accessible_resources/noop-vmap1.xml',
          },
        },
        condition: {
          initiatorDomains: ['video.example.com'],
          requestDomains: ['ads.example.net'],
          resourceTypes: ['xmlhttprequest'],
          domainType: 'thirdParty',
        },
      },
      {
        action: {
          type: 'redirect',
          redirect: {
            extensionPath: 'web_accessible_resources/noop-0.1s.mp3',
          },
        },
        condition: {
          initiatorDomains: ['audio.example.com'],
          requestDomains: ['ads.example.net'],
          resourceTypes: ['media'],
          domainType: 'thirdParty',
        },
      },
      {
        action: {
          type: 'redirect',
          redirect: {
            extensionPath: 'web_accessible_resources/noop-1s.mp4',
          },
        },
        condition: {
          initiatorDomains: ['video.example.com'],
          requestDomains: ['ads.example.net'],
          resourceTypes: ['media'],
          domainType: 'thirdParty',
        },
      },
    ],
  });

  const result = await syncCommunityRules({ force: true });
  await finalizeCommunityActivationSuccess(result.activation);
  const communityRules = dnrState.dynamicRules
    .filter(rule => rule.id >= 6000000 && rule.id < 7000000);

  assert.equal(result.source, 'remote');
  assert.equal(result.applied.added, 4);
  assert.equal(result.applied.byAction.redirect, 4);
  assert.equal(result.applied.dropped.unsupportedRedirectPath, 0);
  assert.deepEqual(
    communityRules.map(rule => rule.action.redirect.extensionPath).sort(),
    [
      '/web_accessible_resources/noop-vast3.xml',
      '/web_accessible_resources/noop-vmap1.xml',
      '/web_accessible_resources/noop-0.1s.mp3',
      '/web_accessible_resources/noop-1s.mp4',
    ].sort()
  );
});

test('community sync applies bounded first-party redirects and empty collection tactics', { concurrency: false }, async () => {
  resetEnvironment();

  remoteBundle = await createSignedBundle({
    schemaVersion: 4,
    rules: [
      {
        action: {
          type: 'redirect',
          redirect: {
            extensionPath: 'web_accessible_resources/noop.js',
          },
        },
        condition: {
          initiatorDomains: ['video.example.com'],
          requestDomains: ['video.example.com'],
          resourceTypes: ['script'],
          domainType: 'firstParty',
          urlPathPrefix: '/api/player',
        },
      },
    ],
    tactics: [
      {
        id: 'set-empty-array',
        kind: 'jsonSet',
        hosts: ['video.example.com'],
        transport: 'fetch',
        urlPathPrefixes: ['/api/player'],
        jsonPaths: ['payload.adPlacements'],
        value: [],
      },
      {
        id: 'set-empty-object',
        kind: 'jsonSet',
        hosts: ['video.example.com'],
        transport: 'both',
        urlPathPrefixes: ['/api/player'],
        jsonPaths: ['payload.adMetadata'],
        value: {},
      },
    ],
  });

  const result = await syncCommunityRules({ force: true });
  await finalizeCommunityActivationSuccess(result.activation);
  const communityRules = dnrState.dynamicRules
    .filter(rule => rule.id >= 6000000 && rule.id < 7000000);

  assert.equal(result.source, 'remote');
  assert.equal(result.applied.byAction.redirect, 1);
  assert.deepEqual(communityRules, [
    {
      action: {
        type: 'redirect',
        redirect: {
          extensionPath: '/web_accessible_resources/noop.js',
        },
      },
      condition: {
        initiatorDomains: ['video.example.com'],
        requestDomains: ['video.example.com'],
        resourceTypes: ['script'],
        domainType: 'firstParty',
        urlFilter: '||video.example.com/api/player',
      },
      id: communityRules[0].id,
      priority: 1100,
    },
  ]);
  assert.deepEqual(storageData.communityBundlePublicTactics, [
    {
      id: 'set-empty-array',
      kind: 'jsonSet',
      phase: 'response',
      hosts: ['=video.example.com'],
      transport: 'fetch',
      urlPathPrefixes: ['/api/player'],
      jsonPaths: ['payload.adPlacements'],
      value: [],
    },
    {
      id: 'set-empty-object',
      kind: 'jsonSet',
      phase: 'response',
      hosts: ['=video.example.com'],
      transport: 'both',
      urlPathPrefixes: ['/api/player'],
      jsonPaths: ['payload.adMetadata'],
      value: {},
    },
  ]);
  assert.equal(storageData.communityBundleMeta.publicTacticsCount, 2);
  assert.equal(storageData.communityBundleMeta.tacticsHostCount, 1);
});

test('community sync stores signed public directives and scriptlets without developer mode', { concurrency: false }, async () => {
  resetEnvironment();

  remoteBundle = await createSignedBundle({
    rules: [
      {
        action: { type: 'block' },
        condition: { urlFilter: '||remote.example^' },
      },
    ],
    directives: [
      {
        id: 'public-hotfix-checkout',
        category: 'annoyances',
        action: 'hide',
        hosts: ['=checkout.shopify.com'],
        selectors: ['.checkout-promo'],
        fallbackAction: 'hide',
        fallbackSelectors: ['.checkout-promo-fallback'],
      },
      {
        id: 'reject-protected-suffix-host',
        action: 'hide',
        hosts: ['checkout.shopify.com'],
        selectors: ['.should-drop'],
      },
      {
        id: 'reject-protected-click',
        action: 'click',
        hosts: ['=checkout.shopify.com'],
        selectors: ['.should-drop'],
      },
      {
        id: 'reject-broad-hosts',
        action: 'hide',
        selectors: ['.should-drop'],
      },
    ],
    scriptlets: [
      {
        rulesetId: 'ublock-filters',
        token: 'abort-on-property-read',
        hosts: ['=checkout.shopify.com'],
        world: 'MAIN',
      },
      {
        rulesetId: 'ublock-filters',
        token: 'abort-on-property-read',
        hosts: ['video.example'],
        world: 'MAIN',
      },
      {
        rulesetId: 'ublock-filters',
        token: 'abort-on-property-read',
        hosts: ['*'],
        world: 'MAIN',
      },
    ],
    ttlHours: 48,
  });

  const result = await syncCommunityRules({ force: true });
  await finalizeCommunityActivationSuccess(result.activation);

  assert.equal(result.source, 'remote');
  assert.equal(rulesetConfig.developerMode, false);
  assert.equal(storageData.communityBundleMeta.ttlHours, 24);
  assert.equal(storageData.communityBundleMeta.retryMinutes, 15);
  assert.equal(storageData.communityBundleMeta.hotfixLane, 'public');
  assert.equal(storageData.communityBundleMeta.publicDirectivesCount, 1);
  assert.equal(storageData.communityBundleMeta.protectedDirectivesCount, 1);
  assert.equal(storageData.communityBundleMeta.publicScriptletsCount, 1);
  assert.equal(storageData.communityBundleMeta.proofDirectivesCount, 0);
  assert.equal(storageData.communityBundleMeta.proofScriptletsCount, 0);
  assert.deepEqual(storageData.communityBundlePublicDirectives, [
    {
      id: 'public-hotfix-checkout',
      category: 'annoyances',
      hosts: ['=checkout.shopify.com'],
      action: 'hide',
      selectors: ['.checkout-promo'],
      fallbackAction: 'hide',
      fallbackSelectors: ['.checkout-promo-fallback'],
      postActions: [],
      maxApplies: undefined,
    },
  ]);
  assert.deepEqual(storageData.communityBundlePublicScriptlets, [
    {
      rulesetId: 'ublock-filters',
      token: 'abort-on-property-read',
      hosts: ['video.example'],
      world: 'MAIN',
    },
  ]);
  assert.equal(storageData.communityBundlePrivateDirectives, null);
  assert.equal(storageData.communityBundlePrivateScriptlets, null);
  assert.equal(Object.hasOwn(storageData, 'communityBundleDirectives'), false);
  assert.equal(Object.hasOwn(storageData, 'communityBundleScriptlets'), false);
});

test('community sync marks directives-only baseline extras for immediate injectable refresh', { concurrency: false }, async () => {
  resetEnvironment();

  remoteBundle = await createSignedBundle({
    schemaVersion: 3,
    rules: [],
    directives: [
      {
        id: 'public-directive-only',
        category: 'annoyances',
        action: 'hide',
        hosts: ['=video.example'],
        selectors: ['.directive-only'],
      },
    ],
  });

  const result = await syncCommunityRules({ force: true });

  assert.equal(result.source, 'remote');
  assert.equal(result.requiresInjectableRefresh, true);
});

test('community sync marks scriptlets-only baseline extras for immediate injectable refresh', { concurrency: false }, async () => {
  resetEnvironment();

  remoteBundle = await createSignedBundle({
    schemaVersion: 3,
    rules: [],
    scriptlets: [
      {
        rulesetId: 'ublock-filters',
        token: 'abort-on-property-read',
        hosts: ['video.example'],
        world: 'MAIN',
      },
    ],
  });

  const result = await syncCommunityRules({ force: true });

  assert.equal(result.source, 'remote');
  assert.equal(result.requiresInjectableRefresh, true);
});

test('community sync stores signed public tactics from schema v4 bundles', { concurrency: false }, async () => {
  resetEnvironment();

  remoteBundle = await createSignedBundle({
    schemaVersion: 4,
    rules: [
      {
        action: { type: 'block' },
        condition: { urlFilter: '||remote.example^' },
      },
    ],
    tactics: [
      {
        id: 'prune-ads',
        kind: 'jsonPrune',
        hosts: ['video.example'],
        transport: 'fetch',
        urlPathPrefixes: ['/api/player'],
        jsonPaths: ['payload.adPlacements'],
      },
      {
        id: 'set-empty',
        kind: 'jsonSet',
        hosts: ['video.example'],
        transport: 'both',
        urlPathPrefixes: ['/api/player'],
        jsonPaths: ['payload.adBreakId'],
        value: '',
      },
      {
        id: 'drop-protected',
        kind: 'jsonPrune',
        hosts: ['accounts.google.com'],
        transport: 'fetch',
        urlPathPrefixes: ['/api/player'],
        jsonPaths: ['payload.shouldDrop'],
      },
    ],
  });

  const result = await syncCommunityRules({ force: true });
  await finalizeCommunityActivationSuccess(result.activation);

  assert.equal(result.source, 'remote');
  assert.deepEqual(storageData.communityBundlePublicTactics, [
    {
      id: 'prune-ads',
      kind: 'jsonPrune',
      phase: 'response',
      hosts: ['=video.example'],
      transport: 'fetch',
      urlPathPrefixes: ['/api/player'],
      jsonPaths: ['payload.adPlacements'],
    },
    {
      id: 'set-empty',
      kind: 'jsonSet',
      phase: 'response',
      hosts: ['=video.example'],
      transport: 'both',
      urlPathPrefixes: ['/api/player'],
      jsonPaths: ['payload.adBreakId'],
      value: '',
    },
  ]);
  assert.deepEqual(storageData.communityBaselinePublicTacticsV1, storageData.communityBundlePublicTactics);
  assert.equal(storageData.communityBundleMeta.publicTacticsCount, 2);
  assert.equal(storageData.communityBundleMeta.tacticsCount, 2);
  assert.equal(storageData.communityBundleMeta.tacticsHostCount, 1);
});

test('community sync marks tactics-only baseline extras for immediate injectable refresh', { concurrency: false }, async () => {
  resetEnvironment();

  remoteBundle = await createSignedBundle({
    schemaVersion: 4,
    rules: [],
    tactics: [
      {
        id: 'tactic-only',
        kind: 'jsonPrune',
        hosts: ['video.example'],
        transport: 'fetch',
        urlPathPrefixes: ['/api/player'],
        jsonPaths: ['payload.adPlacements'],
      },
    ],
  });

  const result = await syncCommunityRules({ force: true });

  assert.equal(result.source, 'remote');
  assert.equal(result.requiresInjectableRefresh, true);
});

test('community sync drops internal Talon first-party scopes across remote rules and extras', { concurrency: false }, async () => {
  resetEnvironment();

  remoteBundle = await createSignedBundle({
    schemaVersion: 2,
    rules: [
      {
        action: { type: 'block' },
        condition: {
          requestDomains: ['talondefender.com'],
          resourceTypes: ['script'],
        },
      },
      {
        action: { type: 'allow' },
        condition: {
          initiatorDomains: ['news.example.com'],
          requestDomains: ['talondefender.com'],
          resourceTypes: ['script'],
        },
      },
      {
        action: {
          type: 'redirect',
          redirect: {
            extensionPath: 'web_accessible_resources/noop.js',
          },
        },
        condition: {
          initiatorDomains: ['news.example.com'],
          requestDomains: ['talondefender.com'],
          resourceTypes: ['script'],
        },
      },
      {
        action: { type: 'block' },
        condition: {
          requestDomains: ['cdn.example.net'],
          resourceTypes: ['script'],
        },
      },
    ],
    cosmetics: {
      hosts: {
        '=talondefender.com': ['.should-drop'],
        'news.example': ['.inline-promo'],
      },
    },
    heuristics: {
      disableHosts: ['=talondefender.com', '=news.example'],
    },
    directives: [
      {
        id: 'drop-internal-host',
        action: 'hide',
        hosts: ['=talondefender.com'],
        selectors: ['.should-drop'],
      },
      {
        id: 'keep-external-host',
        action: 'hide',
        hosts: ['news.example'],
        selectors: ['.keep-me'],
      },
    ],
    scriptlets: [
      {
        rulesetId: 'ublock-filters',
        token: 'abort-on-property-read',
        hosts: ['=talondefender.com'],
        world: 'MAIN',
      },
      {
        rulesetId: 'ublock-filters',
        token: 'abort-on-property-read',
        hosts: ['news.example'],
        world: 'MAIN',
      },
    ],
  });

  const result = await syncCommunityRules({ force: true });
  await finalizeCommunityActivationSuccess(result.activation);

  const communityRules = dnrState.dynamicRules
    .filter(rule => rule.id >= 6000000 && rule.id < 7000000);

  assert.equal(result.source, 'remote');
  assert.equal(result.applied.added, 1);
  assert.equal(result.applied.droppedUnsafe, 3);
  assert.deepEqual(
    communityRules.map(rule => rule.condition.requestDomains || []),
    [['cdn.example.net']]
  );
  assert.deepEqual(storageData.communityBundleCosmetics, {
    all: [],
    hosts: {
      'news.example': ['.inline-promo'],
    },
  });
  assert.deepEqual(storageData.communityBundleHeuristics, {
    disableHosts: ['=news.example'],
  });
  assert.deepEqual(storageData.communityBundlePublicDirectives, [
    {
      id: 'keep-external-host',
      category: 'annoyances',
      hosts: ['news.example'],
      action: 'hide',
      selectors: ['.keep-me'],
      fallbackAction: undefined,
      fallbackSelectors: [],
      postActions: [],
      maxApplies: undefined,
    },
  ]);
  assert.deepEqual(storageData.communityBundlePublicScriptlets, [
    {
      rulesetId: 'ublock-filters',
      token: 'abort-on-property-read',
      hosts: ['news.example'],
      world: 'MAIN',
    },
  ]);
});

test('overlay sync migrates existing compiled community state into baseline storage before site fetches', { concurrency: false }, async () => {
  resetEnvironment();

  storageData.communityBundleMeta = {
    version: 'legacy-baseline.1',
    schemaVersion: 2,
    ttlHours: 6,
  };
  storageData.communityBundleRules = [
    {
      action: { type: 'block' },
      condition: {
        requestDomains: ['legacy.example'],
        resourceTypes: ['script'],
      },
    },
  ];
  storageData.communityBundleCosmetics = {
    all: [],
    hosts: {
      'legacy.example': ['.legacy-box'],
    },
  };
  storageData.communityBundleHeuristics = {
    disableHosts: ['=legacy.example'],
  };
  storageData.communityBundlePublicDirectives = [
    {
      id: 'legacy-directive',
      category: 'annoyances',
      hosts: ['legacy.example'],
      action: 'hide',
      selectors: ['.legacy-box'],
      fallbackAction: undefined,
      fallbackSelectors: [],
      postActions: [],
      maxApplies: undefined,
    },
  ];
  storageData.communityBundlePublicScriptlets = [
    {
      rulesetId: 'ublock-filters',
      token: 'abort-on-property-read',
      hosts: ['legacy.example'],
      world: 'MAIN',
    },
  ];
  storageData.communityBundlePublicTactics = [
    {
      id: 'legacy-tactic',
      kind: 'jsonPrune',
      hosts: ['=legacy.example'],
      transport: 'fetch',
      urlPathPrefixes: ['/api/player'],
      jsonPaths: ['payload.ads'],
    },
  ];
  remoteOverlayResponses.set('video.example', {
    status: 404,
    body: null,
  });

  const result = await syncCommunityOverlayRules({
    siteKey: 'video.example',
    force: true,
    reason: 'migration-check',
  });

  assert.equal(result.source, 'overlay-miss');
  assert.deepEqual(storageData.communityBaselineMetaV1, storageData.communityBundleMeta);
  assert.deepEqual(storageData.communityBaselineRulesV1, storageData.communityBundleRules);
  assert.deepEqual(storageData.communityBaselineCosmeticsV1, storageData.communityBundleCosmetics);
  assert.deepEqual(storageData.communityBaselineHeuristicsV1, storageData.communityBundleHeuristics);
  assert.deepEqual(
    storageData.communityBaselinePublicDirectivesV1,
    storageData.communityBundlePublicDirectives
  );
  assert.deepEqual(
    storageData.communityBaselinePublicScriptletsV1,
    storageData.communityBundlePublicScriptlets
  );
  assert.deepEqual(
    storageData.communityBaselinePublicTacticsV1,
    storageData.communityBundlePublicTactics
  );
  assert.deepEqual(overlayFetchLog, [
    {
      siteKey: 'video.example',
      baseline: 'legacy-baseline.1',
      known: '',
    },
  ]);
});

test('overlay sync merges baseline and site overlay state into the compiled public hotfix bundle', { concurrency: false }, async () => {
  resetEnvironment();

  const baselineBundle = await createSignedBundle({
    version: 'baseline.2026.03.25.1',
    schemaVersion: 4,
    rules: [
      {
        action: { type: 'block' },
        condition: {
          requestDomains: ['baseline.example'],
          resourceTypes: ['script'],
        },
      },
    ],
    cosmetics: {
      hosts: {
        'news.example': ['.baseline-box'],
      },
    },
    heuristics: {
      disableHosts: ['=baseline.example'],
      labelRegexes: ['baseline', 'shared'],
      labelSelectors: ['.baseline-label'],
      maxLabelTextLength: 40,
    },
    directives: [
      {
        id: 'shared-directive',
        action: 'hide',
        hosts: ['news.example'],
        selectors: ['.baseline-hide'],
      },
      {
        id: 'baseline-only',
        action: 'hide',
        hosts: ['news.example'],
        selectors: ['.baseline-only'],
      },
    ],
    scriptlets: [
      {
        rulesetId: 'ublock-filters',
        token: 'abort-on-property-read',
        hosts: ['baseline.example'],
        world: 'MAIN',
      },
    ],
    tactics: [
      {
        id: 'shared-tactic',
        kind: 'jsonSet',
        hosts: ['video.example'],
        transport: 'both',
        urlPathPrefixes: ['/api/player'],
        jsonPaths: ['payload.adBreakId'],
        value: '',
      },
      {
        id: 'baseline-only-tactic',
        kind: 'jsonPrune',
        hosts: ['baseline.example'],
        transport: 'fetch',
        urlPathPrefixes: ['/api/player'],
        jsonPaths: ['payload.baselineAds'],
      },
    ],
  });
  await applyBaselineBundle(baselineBundle);

  remoteOverlayResponses.set('video.example', {
    status: 200,
    body: await createSignedOverlayBundle({
      siteKey: 'video.example',
      baselineVersion: baselineBundle.version,
      version: 'overlay.2026.03.25.1',
      rules: [
        {
          action: { type: 'block' },
          condition: {
            requestDomains: ['overlay.example'],
            resourceTypes: ['script'],
          },
        },
      ],
      cosmetics: {
        hosts: {
          'news.example': ['.baseline-box', '.overlay-box'],
        },
      },
      heuristics: {
        disableHosts: ['=overlay.example', '=baseline.example'],
        labelRegexes: ['overlay', 'shared'],
        labelSelectors: ['.overlay-label', '.baseline-label'],
        maxLabelTextLength: 70,
      },
      directives: [
        {
          id: 'shared-directive',
          action: 'hide',
          hosts: ['news.example'],
          selectors: ['.overlay-hide'],
        },
        {
          id: 'overlay-only',
          action: 'hide',
          hosts: ['news.example'],
          selectors: ['.overlay-only'],
        },
      ],
      scriptlets: [
        {
          rulesetId: 'ublock-filters',
          token: 'abort-on-property-read',
          hosts: ['overlay.example'],
          world: 'MAIN',
        },
      ],
      tactics: [
        {
          id: 'shared-tactic',
          kind: 'jsonSet',
          hosts: ['video.example'],
          transport: 'both',
          urlPathPrefixes: ['/api/player'],
          jsonPaths: ['payload.adBreakId'],
          value: false,
        },
        {
          id: 'overlay-only-tactic',
          kind: 'jsonPrune',
          hosts: ['overlay.example'],
          transport: 'xhr',
          urlPathPrefixes: ['/api/player'],
          jsonPaths: ['payload.overlayAds'],
        },
      ],
      schemaVersion: 4,
    }),
  });

  const result = await applyOverlayBundle('video.example', {
    reason: 'breakage-trigger',
  });
  const communityRules = dnrState.dynamicRules
    .filter(rule => rule.id >= 6000000 && rule.id < 7000000);

  assert.equal(result.source, 'overlay');
  assert.equal(result.applied.added, 2);
  assert.deepEqual(
    communityRules.map(rule => rule.condition.requestDomains || []),
    [['overlay.example'], ['baseline.example']]
  );
  assert.deepEqual(storageData.communityBundleCosmetics, {
    all: [],
    hosts: {
      'news.example': ['.baseline-box', '.overlay-box'],
    },
  });
  assert.deepEqual(storageData.communityBundleHeuristics, {
    disableHosts: ['=overlay.example', '=baseline.example'],
    labelRegexes: ['overlay', 'shared', 'baseline'],
    labelSelectors: ['.overlay-label', '.baseline-label'],
    maxLabelTextLength: 70,
  });
  assert.deepEqual(storageData.communityBundlePublicDirectives, [
    {
      id: 'shared-directive',
      category: 'annoyances',
      hosts: ['news.example'],
      action: 'hide',
      selectors: ['.overlay-hide'],
      fallbackAction: undefined,
      fallbackSelectors: [],
      postActions: [],
      maxApplies: undefined,
    },
    {
      id: 'overlay-only',
      category: 'annoyances',
      hosts: ['news.example'],
      action: 'hide',
      selectors: ['.overlay-only'],
      fallbackAction: undefined,
      fallbackSelectors: [],
      postActions: [],
      maxApplies: undefined,
    },
    {
      id: 'baseline-only',
      category: 'annoyances',
      hosts: ['news.example'],
      action: 'hide',
      selectors: ['.baseline-only'],
      fallbackAction: undefined,
      fallbackSelectors: [],
      postActions: [],
      maxApplies: undefined,
    },
  ]);
  assert.deepEqual(storageData.communityBundlePublicScriptlets, [
    {
      rulesetId: 'ublock-filters',
      token: 'abort-on-property-read',
      hosts: ['baseline.example', 'overlay.example'],
      world: 'MAIN',
    },
  ]);
  assert.deepEqual(storageData.communityBundlePublicTactics, [
    {
      id: 'shared-tactic',
      kind: 'jsonSet',
      phase: 'response',
      hosts: ['=video.example'],
      transport: 'both',
      urlPathPrefixes: ['/api/player'],
      jsonPaths: ['payload.adBreakId'],
      value: false,
    },
    {
      id: 'overlay-only-tactic',
      kind: 'jsonPrune',
      phase: 'response',
      hosts: ['=overlay.example'],
      transport: 'xhr',
      urlPathPrefixes: ['/api/player'],
      jsonPaths: ['payload.overlayAds'],
    },
    {
      id: 'baseline-only-tactic',
      kind: 'jsonPrune',
      phase: 'response',
      hosts: ['=baseline.example'],
      transport: 'fetch',
      urlPathPrefixes: ['/api/player'],
      jsonPaths: ['payload.baselineAds'],
    },
  ]);
  assert.equal(storageData.communityBundleMeta.publicTacticsCount, 3);
  assert.equal(storageData.communityBundleMeta.tacticsHostCount, 3);
  assert.equal(storageData.communityBundleMeta.activeOverlayCount, 1);
  assert.equal(storageData.communityBundleMeta.lastOverlaySiteKey, 'video.example');
  assert.equal(storageData.communityBundleMeta.lastOverlayVersion, 'overlay.2026.03.25.1');
  assert.equal(storageData.communityBundleMeta.lastOverlayStatus, 'updated');
  assert.equal(storageData.communityOverlayIndexV1['video.example'].version, 'overlay.2026.03.25.1');
  assert.deepEqual(overlayFetchLog.at(-1), {
    siteKey: 'video.example',
    baseline: baselineBundle.version,
    known: '',
  });
});

test('overlay sync keeps the stored overlay on 204 and refreshes the per-site sync state', { concurrency: false }, async () => {
  resetEnvironment();

  const baselineBundle = await createSignedBundle({
    version: 'baseline.204.1',
    schemaVersion: 2,
    rules: [
      {
        action: { type: 'block' },
        condition: {
          requestDomains: ['baseline.example'],
          resourceTypes: ['script'],
        },
      },
    ],
  });
  await applyBaselineBundle(baselineBundle);

  remoteOverlayResponses.set('video.example', {
    status: 200,
    body: await createSignedOverlayBundle({
      siteKey: 'video.example',
      baselineVersion: baselineBundle.version,
      version: 'overlay.204.1',
      rules: [
        {
          action: { type: 'block' },
          condition: {
            requestDomains: ['overlay.example'],
            resourceTypes: ['script'],
          },
        },
      ],
    }),
  });
  await applyOverlayBundle('video.example');

  const previousPayload = clone(storageData.communityOverlayPayloadsV1['video.example']);
  const previousCompiledRules = clone(storageData.communityBundleRules);
  remoteOverlayResponses.set('video.example', {
    status: 204,
    body: null,
  });

  const result = await syncCommunityOverlayRules({
    siteKey: 'video.example',
    force: true,
    reason: 'refresh-overlay',
  });

  assert.equal(result.source, 'overlay-not-modified');
  assert.deepEqual(storageData.communityOverlayPayloadsV1['video.example'], previousPayload);
  assert.deepEqual(storageData.communityBundleRules, previousCompiledRules);
  assert.equal(storageData.communityOverlayIndexV1['video.example'].version, 'overlay.204.1');
  assert.equal(storageData.communityOverlayIndexV1['video.example'].lastStatus, 'not-modified');
  assert.equal(storageData.communityOverlayIndexV1['video.example'].lastReason, 'refresh-overlay');
  assert.equal(storageData.communityOverlayIndexV1['video.example'].lastError, '');
  assert.deepEqual(overlayFetchLog.at(-1), {
    siteKey: 'video.example',
    baseline: baselineBundle.version,
    known: 'overlay.204.1',
  });
});

test('overlay extras-only updates and removals request immediate injectable refresh', { concurrency: false }, async () => {
  resetEnvironment();

  const baselineBundle = await createSignedBundle({
    version: 'baseline.extras.1',
    schemaVersion: 3,
    rules: [],
  });
  await applyBaselineBundle(baselineBundle);

  remoteOverlayResponses.set('video.example', {
    status: 200,
    body: await createSignedOverlayBundle({
      siteKey: 'video.example',
      baselineVersion: baselineBundle.version,
      version: 'overlay.extras.1',
      rules: [],
      directives: [
        {
          id: 'overlay-directive-only',
          action: 'hide',
          hosts: ['=video.example'],
          selectors: ['.overlay-only'],
        },
      ],
      schemaVersion: 3,
    }),
  });

  const applied = await applyOverlayBundle('video.example', {
    reason: 'overlay-extras-only',
  });

  remoteOverlayResponses.set('video.example', {
    status: 404,
    body: null,
  });
  const removed = await applyOverlayBundle('video.example', {
    reason: 'overlay-extras-removed',
  });

  assert.equal(applied.source, 'overlay');
  assert.equal(applied.requiresInjectableRefresh, true);
  assert.equal(removed.source, 'overlay-removed');
  assert.equal(removed.requiresInjectableRefresh, true);
});

test('overlay sync removes revoked site overlays and recompiles the effective community bundle from baseline only', { concurrency: false }, async () => {
  resetEnvironment();

  const baselineBundle = await createSignedBundle({
    version: 'baseline.remove.1',
    schemaVersion: 2,
    rules: [
      {
        action: { type: 'block' },
        condition: {
          requestDomains: ['baseline.example'],
          resourceTypes: ['script'],
        },
      },
    ],
    directives: [
      {
        id: 'baseline-directive',
        action: 'hide',
        hosts: ['news.example'],
        selectors: ['.baseline'],
      },
    ],
    tactics: [
      {
        id: 'baseline-tactic',
        kind: 'jsonPrune',
        hosts: ['baseline.example'],
        transport: 'fetch',
        urlPathPrefixes: ['/api/player'],
        jsonPaths: ['payload.baselineAds'],
      },
    ],
    schemaVersion: 4,
  });
  await applyBaselineBundle(baselineBundle);

  remoteOverlayResponses.set('video.example', {
    status: 200,
    body: await createSignedOverlayBundle({
      siteKey: 'video.example',
      baselineVersion: baselineBundle.version,
      version: 'overlay.remove.1',
      rules: [
        {
          action: { type: 'block' },
          condition: {
            requestDomains: ['overlay.example'],
            resourceTypes: ['script'],
          },
        },
      ],
      directives: [
        {
          id: 'overlay-directive',
          action: 'hide',
          hosts: ['news.example'],
          selectors: ['.overlay'],
        },
      ],
      tactics: [
        {
          id: 'overlay-tactic',
          kind: 'jsonPrune',
          hosts: ['overlay.example'],
          transport: 'fetch',
          urlPathPrefixes: ['/api/player'],
          jsonPaths: ['payload.overlayAds'],
        },
      ],
      schemaVersion: 4,
    }),
  });
  await applyOverlayBundle('video.example');

  remoteOverlayResponses.set('video.example', {
    status: 404,
    body: null,
  });
  const result = await applyOverlayBundle('video.example', {
    reason: 'overlay-revoked',
  });
  const communityRules = dnrState.dynamicRules
    .filter(rule => rule.id >= 6000000 && rule.id < 7000000);

  assert.equal(result.source, 'overlay-removed');
  assert.equal(result.overlayStatus, 'missing');
  assert.deepEqual(
    communityRules.map(rule => rule.condition.requestDomains || []),
    [['baseline.example']]
  );
  assert.equal(Object.hasOwn(storageData.communityOverlayPayloadsV1, 'video.example'), false);
  assert.equal(storageData.communityBundleMeta.activeOverlayCount, 0);
  assert.deepEqual(storageData.communityBundlePublicDirectives, [
    {
      id: 'baseline-directive',
      category: 'annoyances',
      hosts: ['news.example'],
      action: 'hide',
      selectors: ['.baseline'],
      fallbackAction: undefined,
      fallbackSelectors: [],
      postActions: [],
      maxApplies: undefined,
    },
  ]);
  assert.deepEqual(storageData.communityBundlePublicTactics, [
    {
      id: 'baseline-tactic',
      kind: 'jsonPrune',
      phase: 'response',
      hosts: ['=baseline.example'],
      transport: 'fetch',
      urlPathPrefixes: ['/api/player'],
      jsonPaths: ['payload.baselineAds'],
    },
  ]);
  assert.equal(storageData.communityOverlayIndexV1['video.example'].version, '');
  assert.equal(storageData.communityOverlayIndexV1['video.example'].lastStatus, 'missing');
  assert.ok(storageData.communityOverlayIndexV1['video.example'].negativeUntil > 0);
});

test('overlay sync keeps the previous overlay active after a fetch failure and enforces retry backoff', { concurrency: false }, async () => {
  resetEnvironment();

  const baselineBundle = await createSignedBundle({
    version: 'baseline.retry.1',
    schemaVersion: 2,
    rules: [
      {
        action: { type: 'block' },
        condition: {
          requestDomains: ['baseline.example'],
          resourceTypes: ['script'],
        },
      },
    ],
  });
  await applyBaselineBundle(baselineBundle);

  remoteOverlayResponses.set('video.example', {
    status: 200,
    body: await createSignedOverlayBundle({
      siteKey: 'video.example',
      baselineVersion: baselineBundle.version,
      version: 'overlay.retry.1',
      rules: [
        {
          action: { type: 'block' },
          condition: {
            requestDomains: ['overlay.example'],
            resourceTypes: ['script'],
          },
        },
      ],
    }),
  });
  await applyOverlayBundle('video.example');
  const previousPayload = clone(storageData.communityOverlayPayloadsV1['video.example']);
  const previousCompiledRules = clone(storageData.communityBundleRules);

  remoteOverlayResponses.set('video.example', {
    throwMessage: 'network down',
  });
  const errorResult = await syncCommunityOverlayRules({
    siteKey: 'video.example',
    force: true,
    reason: 'network-retry',
  });
  const skippedResult = await syncCommunityOverlayRules({
    siteKey: 'video.example',
    force: false,
    reason: 'network-retry',
  });

  assert.equal(errorResult.source, 'overlay-error');
  assert.match(errorResult.error, /network down/);
  assert.deepEqual(storageData.communityOverlayPayloadsV1['video.example'], previousPayload);
  assert.deepEqual(storageData.communityBundleRules, previousCompiledRules);
  assert.equal(storageData.communityOverlayIndexV1['video.example'].lastStatus, 'error');
  assert.match(storageData.communityOverlayIndexV1['video.example'].lastError, /network down/);
  assert.equal(skippedResult.skipped, 'retry-backoff');
});

test('overlay sync reports baseline mismatches without replacing the active compiled state', { concurrency: false }, async () => {
  resetEnvironment();

  const baselineBundle = await createSignedBundle({
    version: 'baseline.mismatch.1',
    schemaVersion: 2,
    rules: [
      {
        action: { type: 'block' },
        condition: {
          requestDomains: ['baseline.example'],
          resourceTypes: ['script'],
        },
      },
    ],
  });
  await applyBaselineBundle(baselineBundle);
  const previousCompiledRules = clone(storageData.communityBundleRules);

  remoteOverlayResponses.set('video.example', {
    status: 200,
    body: await createSignedOverlayBundle({
      siteKey: 'video.example',
      baselineVersion: 'baseline.other.1',
      version: 'overlay.mismatch.1',
      rules: [
        {
          action: { type: 'block' },
          condition: {
            requestDomains: ['overlay.example'],
            resourceTypes: ['script'],
          },
        },
      ],
    }),
  });

  const result = await syncCommunityOverlayRules({
    siteKey: 'video.example',
    force: true,
    reason: 'baseline-mismatch',
  });

  assert.equal(result.source, 'overlay-baseline-mismatch');
  assert.equal(result.retryWithForcedBaseline, true);
  assert.equal(Object.hasOwn(storageData.communityOverlayPayloadsV1 || {}, 'video.example'), false);
  assert.deepEqual(storageData.communityBundleRules, previousCompiledRules);
  assert.equal(storageData.communityOverlayIndexV1['video.example'].version, 'overlay.mismatch.1');
  assert.equal(storageData.communityOverlayIndexV1['video.example'].baselineVersion, 'baseline.other.1');
  assert.equal(storageData.communityOverlayIndexV1['video.example'].lastStatus, 'baseline-mismatch');
});

test('overlay rules stay ahead of baseline rules under community quota pressure', { concurrency: false }, async () => {
  resetEnvironment();

  dnr.MAX_NUMBER_OF_DYNAMIC_RULES = 251;
  const baselineBundle = await createSignedBundle({
    version: 'baseline.quota.1',
    schemaVersion: 2,
    rules: [
      {
        action: { type: 'block' },
        condition: {
          requestDomains: ['baseline.example'],
          resourceTypes: ['script'],
        },
      },
    ],
  });
  await applyBaselineBundle(baselineBundle);

  remoteOverlayResponses.set('video.example', {
    status: 200,
    body: await createSignedOverlayBundle({
      siteKey: 'video.example',
      baselineVersion: baselineBundle.version,
      version: 'overlay.quota.1',
      rules: [
        {
          action: { type: 'block' },
          condition: {
            requestDomains: ['overlay.example'],
            resourceTypes: ['script'],
          },
        },
      ],
    }),
  });

  const result = await applyOverlayBundle('video.example', {
    reason: 'quota-pressure',
  });
  const communityRules = dnrState.dynamicRules
    .filter(rule => rule.id >= 6000000 && rule.id < 7000000);

  assert.equal(result.source, 'overlay');
  assert.equal(result.applied.added, 1);
  assert.equal(result.applied.droppedQuota, 1);
  assert.deepEqual(result.applied.dropped.quotaByClass, {
    exactExceptions: 0,
    exactRedirects: 0,
    exactBlocks: 1,
    broadBlocks: 0,
    regexBlocks: 0,
  });
  assert.deepEqual(
    communityRules.map(rule => rule.condition.requestDomains || []),
    [['overlay.example']]
  );
});

test('community scriptlet canonicalization merges duplicate hosts and keeps worlds separate', () => {
  const canonical = canonicalizeCommunityScriptlets([
    {
      rulesetId: 'ublock-filters',
      token: 'abort-on-property-read',
      hosts: ['beta.example', 'alpha.example'],
      world: 'MAIN',
    },
    {
      rulesetId: 'ublock-filters',
      token: 'abort-on-property-read',
      hosts: ['alpha.example', '=checkout.shopify.com', '*'],
      world: 'MAIN',
    },
    {
      rulesetId: 'ublock-filters',
      token: 'abort-on-property-read',
      hosts: ['gamma.example'],
      world: 'ISOLATED',
    },
  ]);

  assert.deepEqual(canonical, [
    {
      rulesetId: 'ublock-filters',
      token: 'abort-on-property-read',
      hosts: ['alpha.example', 'beta.example'],
      world: 'MAIN',
    },
    {
      rulesetId: 'ublock-filters',
      token: 'abort-on-property-read',
      hosts: ['gamma.example'],
      world: 'ISOLATED',
    },
  ]);
});

test('community activation rollback restores last-known-good bundle state after injectable failure', { concurrency: false }, async () => {
  resetEnvironment();

  const storedRules = [
    {
      action: { type: 'block' },
      condition: { urlFilter: '||stored.example^' },
    },
  ];
  const storedMeta = {
    version: 'stored-v1',
    schemaVersion: 2,
    ttlHours: 6,
    retryMinutes: 15,
    hotfixLane: 'public',
  };
  const lastSuccess = Date.UTC(2026, 2, 25, 17, 0, 0, 0);
  await browserStub.storage.local.set({
    communityBundleRules: storedRules,
    communityBundleMeta: storedMeta,
    communityBundleLastSuccess: lastSuccess,
    communityBundlePublicScriptlets: [
      {
        rulesetId: 'ublock-filters',
        token: 'abort-on-property-read',
        hosts: ['stored.example'],
        world: 'MAIN',
      },
    ],
  });
  await updateCommunityRules(storedRules, {
    source: 'stored',
    version: storedMeta.version,
    schemaVersion: storedMeta.schemaVersion,
  });

  remoteBundle = await createSignedBundle({
    version: 'remote-v2',
    rules: [
      {
        action: { type: 'block' },
        condition: { urlFilter: '||remote.example^' },
      },
    ],
    scriptlets: [
      {
        rulesetId: 'ublock-filters',
        token: 'abort-on-property-read',
        hosts: ['remote.example'],
        world: 'MAIN',
      },
    ],
  });

  const result = await syncCommunityRules({ force: true });
  const rollbackStartedAt = Date.now();
  const rollback = await rollbackCommunityActivation(
    result.activation,
    'injectable registration failed'
  );
  const retryAlarm = alarmCreates.at(-1);

  assert.equal(result.source, 'remote');
  assert.equal(storageData.communityBundleMeta.version, 'stored-v1');
  assert.equal(storageData.communityBundleMeta.activationStatus, 'rolled_back');
  assert.equal(
    storageData.communityBundleMeta.activationRollbackReason,
    'injectable registration failed'
  );
  assert.equal(
    storageData.communityBundleMeta.activationRollbackAttemptedVersion,
    'remote-v2'
  );
  assert.equal(
    storageData.communityBundleMeta.activationRollbackRestoredVersion,
    'stored-v1'
  );
  assert.equal(storageData.communityBundleLastSuccess, lastSuccess);
  assert.equal(storageData.communityBundleLastError, 'injectable registration failed');
  assert.equal(rollback.lastError, 'injectable registration failed');
  assert.ok(typeof storageData.communityBundleLastAttempt === 'number');
  assert.ok(typeof storageData.communityBundleLastFetch === 'number');
  assert.equal(retryAlarm.name, 'community-sync');
  assert.ok(retryAlarm.info.when >= rollbackStartedAt + COMMUNITY_SYNC_FAILURE_RETRY_MS - 2000);
  assert.deepEqual(
    dnrState.dynamicRules
      .filter(rule => rule.id >= 6000000 && rule.id < 7000000)
      .map(rule => rule.condition.urlFilter),
    ['||stored.example^']
  );
});

test('scrubPrivateCommunityState preserves public hotfix state while clearing proof-only extras', { concurrency: false }, async () => {
  resetEnvironment();

  await browserStub.storage.local.set({
    communityBundleCosmetics: {
      all: ['.promo'],
      hosts: {},
    },
    communityBundleHeuristics: {
      labelRegexes: ['sponsored'],
    },
    communityBundlePublicDirectives: [{ id: 'public-dir' }],
    communityBundlePublicScriptlets: [{ rulesetId: 'ublock-filters', token: 'abort-on-property-read' }],
    communityBundlePrivateDirectives: [{ id: 'proof-dir' }],
    communityBundlePrivateScriptlets: [{ rulesetId: 'ublock-filters', token: 'abort-on-property-read' }],
    communityBundleDirectives: [{ id: 'legacy-proof-dir' }],
    communityBundleScriptlets: [{ rulesetId: 'ublock-filters', token: 'abort-on-property-read' }],
  });

  const result = await scrubPrivateCommunityState('developer-mode-off');

  assert.equal(result.cleanupReason, 'developer-mode-off');
  assert.equal(result.requiresInjectableRefresh, true);
  assert.deepEqual(storageData.communityBundlePublicDirectives, [{ id: 'public-dir' }]);
  assert.deepEqual(storageData.communityBundlePublicScriptlets, [
    { rulesetId: 'ublock-filters', token: 'abort-on-property-read' },
  ]);
  assert.equal(Object.hasOwn(storageData, 'communityBundlePrivateDirectives'), false);
  assert.equal(Object.hasOwn(storageData, 'communityBundlePrivateScriptlets'), false);
  assert.equal(Object.hasOwn(storageData, 'communityBundleDirectives'), false);
  assert.equal(Object.hasOwn(storageData, 'communityBundleScriptlets'), false);
});

test('user regex rules rebalance shared regex budget for community and session rules', { concurrency: false }, async () => {
  resetEnvironment();
  dnr.MAX_NUMBER_OF_REGEX_RULES = 5;
  dnrState.enabledRulesets.push('strict');
  rulesetConfig.strictBlockMode = true;
  permissionsState.broadHostPermissions = true;

  const initialSession = await updateSessionRules();
  assert.equal(initialSession?.error, undefined);
  assert.equal(dnrState.sessionRules.length, 3);

  rulesetConfig.developerMode = true;
  await browserStub.storage.local.set({
    userDnrRules: textFromRules([
      {
        action: { type: 'block' },
        condition: {
          regexFilter: '^https:\\/\\/user-1\\.example\\/',
          resourceTypes: ['script'],
        },
      },
      {
        action: { type: 'block' },
        condition: {
          regexFilter: '^https:\\/\\/user-2\\.example\\/',
          resourceTypes: ['script'],
        },
      },
    ]),
  });

  const userResult = await updateUserRules();
  assert.equal(userResult.errors.length, 0);
  assert.equal(
    dnrState.sessionRules.filter(rule => rule.priority === 29).length,
    1
  );

  const communityResult = await updateCommunityRules([
    {
      action: { type: 'block' },
      condition: {
        regexFilter: '^https:\\/\\/community-1\\.example\\/',
        resourceTypes: ['script'],
      },
    },
    {
      action: { type: 'block' },
      condition: {
        regexFilter: '^https:\\/\\/community-2\\.example\\/',
        resourceTypes: ['script'],
      },
    },
    {
      action: { type: 'block' },
      condition: {
        regexFilter: '^https:\\/\\/community-3\\.example\\/',
        resourceTypes: ['script'],
        },
    },
  ], {
    source: 'remote',
    schemaVersion: 2,
  });

  assert.equal(communityResult.added, 2);
  assert.equal(communityResult.droppedRegexQuota, 1);
  assert.deepEqual(
    dnrState.dynamicRules
      .filter(rule => rule.id >= 6000000 && rule.id < 7000000)
      .map(rule => rule.condition.regexFilter),
    [
      '^https:\\/\\/community-1\\.example\\/',
      '^https:\\/\\/community-2\\.example\\/',
    ]
  );
});

test('setAllowAllRules repairs missing session companion rules and records the repair', { concurrency: false }, async () => {
  resetEnvironment();

  dnrState.dynamicRules.push({
    id: 8000000,
    action: { type: 'allowAllRequests' },
    condition: {
      resourceTypes: ['main_frame'],
      requestDomains: ['news.example'],
    },
    priority: 2000000,
  });

  const modified = await compatDnr.setAllowAllRules(
    8000000,
    ['news.example'],
    [],
    false,
    2000000
  );

  assert.equal(modified, true);
  assert.deepEqual(dnrState.dynamicRules, [
    {
      id: 8000000,
      action: { type: 'allowAllRequests' },
      condition: {
        resourceTypes: ['main_frame'],
        requestDomains: ['news.example'],
      },
      priority: 2000000,
    },
  ]);
  assert.deepEqual(dnrState.sessionRules, [
    {
      id: 8000001,
      action: { type: 'allow' },
      condition: {
        tabIds: [-1],
        initiatorDomains: ['news.example'],
      },
      priority: 2000000,
    },
  ]);
  assert.deepEqual(storageData.allowAllRulesDiagnosticsV1, {
    partialRepairCount: 1,
    lastRepairAt: storageData.allowAllRulesDiagnosticsV1.lastRepairAt,
    rollbackCount: 0,
    lastRollbackAt: 0,
  });
  assert.equal(typeof storageData.allowAllRulesDiagnosticsV1.lastRepairAt, 'number');
});

test('setAllowAllRules rolls back partial updates when the session companion write fails', { concurrency: false }, async () => {
  resetEnvironment();

  dnrState.dynamicRules.push({
    id: 8000000,
    action: { type: 'allowAllRequests' },
    condition: {
      resourceTypes: ['main_frame'],
      requestDomains: ['stored.example'],
    },
    priority: 2000000,
  });
  dnrState.sessionRules.push({
    id: 8000001,
    action: { type: 'allow' },
    condition: {
      tabIds: [-1],
      initiatorDomains: ['stored.example'],
    },
    priority: 2000000,
  });
  dnrState.failSessionUpdateCount = 1;

  const modified = await compatDnr.setAllowAllRules(
    8000000,
    ['news.example'],
    [],
    false,
    2000000
  );

  assert.equal(modified, false);
  assert.deepEqual(dnrState.dynamicRules, [
    {
      id: 8000000,
      action: { type: 'allowAllRequests' },
      condition: {
        resourceTypes: ['main_frame'],
        requestDomains: ['stored.example'],
      },
      priority: 2000000,
    },
  ]);
  assert.deepEqual(dnrState.sessionRules, [
    {
      id: 8000001,
      action: { type: 'allow' },
      condition: {
        tabIds: [-1],
        initiatorDomains: ['stored.example'],
      },
      priority: 2000000,
    },
  ]);
  assert.deepEqual(storageData.allowAllRulesDiagnosticsV1, {
    partialRepairCount: 0,
    rollbackCount: 1,
    lastRepairAt: 0,
    lastRollbackAt: storageData.allowAllRulesDiagnosticsV1.lastRollbackAt,
  });
  assert.equal(typeof storageData.allowAllRulesDiagnosticsV1.lastRollbackAt, 'number');
});

test('packaged community fallback bundle is valid and non-empty', { concurrency: false }, () => {
  assert.equal(Array.isArray(fallbackRules), true);
  assert.ok(fallbackRules.length > 0);
  assert.ok(fallbackRules.every(rule => rule?.action?.type === 'block'));
});
