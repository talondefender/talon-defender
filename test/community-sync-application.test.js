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
  scrubPrivateCommunityState,
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
  for (const key of Object.keys(sessionData)) {
    delete sessionData[key];
  }
  alarmCreates.length = 0;
  alarmClears.length = 0;
  dnrState.dynamicRules.length = 0;
  dnrState.sessionRules.length = 0;
  dnrState.failCommunityUpdateCount = 0;
  dnrState.enabledRulesets.length = 0;
  dnr.MAX_NUMBER_OF_DYNAMIC_RULES = DEFAULT_MAX_NUMBER_OF_DYNAMIC_RULES;
  dnr.MAX_NUMBER_OF_REGEX_RULES = DEFAULT_MAX_NUMBER_OF_REGEX_RULES;
  remoteBundle = null;
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
        id: 'public-hotfix-consent',
        category: 'consent',
        action: 'hide',
        hosts: ['news.example'],
        selectors: ['#onetrust-consent-sdk'],
        fallbackAction: 'hide',
        fallbackSelectors: ['#onetrust-consent-sdk'],
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

  assert.equal(result.source, 'remote');
  assert.equal(rulesetConfig.developerMode, false);
  assert.equal(storageData.communityBundleMeta.ttlHours, 24);
  assert.equal(storageData.communityBundleMeta.retryMinutes, 15);
  assert.equal(storageData.communityBundleMeta.hotfixLane, 'public');
  assert.equal(storageData.communityBundleMeta.publicDirectivesCount, 1);
  assert.equal(storageData.communityBundleMeta.publicScriptletsCount, 1);
  assert.equal(storageData.communityBundleMeta.proofDirectivesCount, 0);
  assert.equal(storageData.communityBundleMeta.proofScriptletsCount, 0);
  assert.deepEqual(storageData.communityBundlePublicDirectives, [
    {
      id: 'public-hotfix-consent',
      category: 'consent',
      hosts: ['news.example'],
      action: 'hide',
      selectors: ['#onetrust-consent-sdk'],
      fallbackAction: 'hide',
      fallbackSelectors: ['#onetrust-consent-sdk'],
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
  });
  assert.equal(typeof storageData.allowAllRulesDiagnosticsV1.lastRepairAt, 'number');
});

test('packaged community fallback bundle is valid and non-empty', { concurrency: false }, () => {
  assert.equal(Array.isArray(fallbackRules), true);
  assert.ok(fallbackRules.length > 0);
  assert.ok(fallbackRules.every(rule => rule?.action?.type === 'block'));
});
