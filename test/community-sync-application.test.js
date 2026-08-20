import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

const fallbackRules = JSON.parse(
  await fs.readFile(new URL('../automation/community-fallback.json', import.meta.url), 'utf8')
);
const compiledStrictBlockRules = {
  'ublock-filters': JSON.parse(
    await fs.readFile(new URL('../rulesets/strictblock/ublock-filters.json', import.meta.url), 'utf8')
  ),
  'ublock-badware': JSON.parse(
    await fs.readFile(new URL('../rulesets/strictblock/ublock-badware.json', import.meta.url), 'utf8')
  ),
};
const compiledUblockRegexRules = JSON.parse(
  await fs.readFile(new URL('../rulesets/regex/ublock-filters.json', import.meta.url), 'utf8')
);
const compiledTalonSiteFixRules = JSON.parse(
  await fs.readFile(new URL('../rulesets/main/talon-site-fixes.json', import.meta.url), 'utf8')
);

const clone = value => structuredClone(value);

const storageData = Object.create(null);
const sessionData = Object.create(null);
const alarmCreates = [];
const alarmClears = [];
const permissionsState = {
  broadHostPermissions: true,
};
const storageReadFailures = {
  local: new Map(),
  session: new Map(),
};
const storageInvalidReadResponses = {
  local: new Map(),
  session: new Map(),
};
let localStorageReadFailurePredicate = null;
const rulesetResources = {
  '/rulesets/ruleset-details.json': [
    {
      id: 'strict',
      rules: {
        strictblock: 3,
        regex: 0,
      },
    },
    {
      id: 'ublock-filters',
      rules: {
        strictblock: compiledStrictBlockRules['ublock-filters'].length,
        regex: compiledUblockRegexRules.length,
      },
    },
    {
      id: 'ublock-badware',
      rules: {
        strictblock: compiledStrictBlockRules['ublock-badware'].length,
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
  '/rulesets/strictblock/ublock-filters.json': compiledStrictBlockRules['ublock-filters'],
  '/rulesets/strictblock/ublock-badware.json': compiledStrictBlockRules['ublock-badware'],
  '/rulesets/regex/ublock-filters.json': compiledUblockRegexRules,
  '/rulesets/main/talon-site-fixes.json': compiledTalonSiteFixRules,
};

const dnrState = {
  dynamicRules: [],
  sessionRules: [],
  failCommunityUpdateCount: 0,
  failUserUpdateCount: 0,
  failSessionUpdateCount: 0,
  dynamicReadOutcomes: [],
  dynamicUpdateOutcomes: [],
  sessionUpdateOutcomes: [],
  enabledRulesets: [],
  reorderReturnedRules: false,
  dynamicUpdateAttempts: [],
  dynamicUpdateCalls: [],
  sessionUpdateAttempts: [],
  sessionUpdateCalls: [],
};

const DEFAULT_MAX_NUMBER_OF_DYNAMIC_RULES = 5000;
const DEFAULT_MAX_NUMBER_OF_REGEX_RULES = 1000;

const consumeStorageReadFault = (faults, key) => {
  const count = faults.get(key) || 0;
  if (count === 0) { return false; }
  if (count === 1) {
    faults.delete(key);
  } else {
    faults.set(key, count - 1);
  }
  return true;
};

const failNextStorageRead = (areaName, key, count = 1) => {
  storageReadFailures[areaName].set(key, count);
};

const invalidateNextStorageRead = (areaName, key, count = 1) => {
  storageInvalidReadResponses[areaName].set(key, count);
};

const makeStorageArea = (data, areaName) => ({
  async get(key) {
    if (
      areaName === 'local' &&
      typeof localStorageReadFailurePredicate === 'function' &&
      localStorageReadFailurePredicate(key)
    ) {
      localStorageReadFailurePredicate = null;
      throw new Error('simulated transient local storage snapshot failure');
    }
    if (consumeStorageReadFault(storageReadFailures[areaName], key)) {
      throw new Error(`simulated ${areaName} storage read failure for ${key}`);
    }
    if (consumeStorageReadFault(storageInvalidReadResponses[areaName], key)) {
      return null;
    }
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

const emulateChromeRuleOrder = rule => {
  const source = clone(rule);
  const out = {};
  for (const key of ['action', 'condition', 'id', 'priority']) {
    if (Object.hasOwn(source, key) === false) { continue; }
    out[key] = source[key];
  }
  for (const key of Object.keys(source)) {
    if (Object.hasOwn(out, key)) { continue; }
    out[key] = source[key];
  }
  return out;
};

const cloneRulesForApi = rules => {
  const cloned = clone(rules);
  return dnrState.reorderReturnedRules
    ? cloned.map(emulateChromeRuleOrder)
    : cloned;
};

const assertUniqueRuleIds = rules => {
  const ids = rules.map(rule => rule.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error('Rule does not have a unique ID');
  }
};

const assertSupportedRuleConditions = rules => {
  if (dnr.RuleConditionKeys?.TOP_DOMAINS) { return; }
  for (const rule of rules) {
    if (rule.condition?.topDomains !== undefined) {
      throw new Error('RuleCondition.topDomains is not supported');
    }
    if (rule.condition?.excludedTopDomains !== undefined) {
      throw new Error('RuleCondition.excludedTopDomains is not supported');
    }
  }
};

const dnr = {
  MAX_NUMBER_OF_DYNAMIC_RULES: DEFAULT_MAX_NUMBER_OF_DYNAMIC_RULES,
  MAX_NUMBER_OF_REGEX_RULES: DEFAULT_MAX_NUMBER_OF_REGEX_RULES,
  async getDynamicRules(options = {}) {
    if (dnrState.dynamicReadOutcomes.length !== 0) {
      const outcome = dnrState.dynamicReadOutcomes.shift();
      if (outcome instanceof Error) { throw outcome; }
      if (Array.isArray(outcome)) {
        return cloneRulesForApi(filterRulesByIds(outcome, options.ruleIds));
      }
    }
    return cloneRulesForApi(filterRulesByIds(dnrState.dynamicRules, options.ruleIds));
  },
  async updateDynamicRules(details = {}) {
    const { addRules = [], removeRuleIds = [] } = details;
    dnrState.dynamicUpdateAttempts.push({
      details,
      snapshot: clone({ addRules, removeRuleIds }),
    });
    if (dnrState.dynamicUpdateOutcomes.length !== 0) {
      const outcome = dnrState.dynamicUpdateOutcomes.shift();
      if (outcome !== null && outcome !== undefined) {
        throw outcome;
      }
    }
    const hasCommunityRules = addRules.some(rule => rule.id >= 6000000 && rule.id < 7000000);
    if (hasCommunityRules && dnrState.failCommunityUpdateCount > 0) {
      dnrState.failCommunityUpdateCount -= 1;
      throw new Error('simulated community apply failure');
    }
    const touchesUserRules = addRules.some(rule => rule.id >= 9000000) ||
      removeRuleIds.some(id => id >= 9000000);
    if (touchesUserRules && dnrState.failUserUpdateCount > 0) {
      dnrState.failUserUpdateCount -= 1;
      throw new Error('simulated user-rule apply failure');
    }
    const nextRules = dnrState.dynamicRules.filter(
      rule => removeRuleIds.includes(rule.id) === false
    );
    nextRules.push(...clone(addRules));
    assertUniqueRuleIds(nextRules);
    assertSupportedRuleConditions(nextRules);
    dnrState.dynamicUpdateCalls.push(clone({ addRules, removeRuleIds }));
    dnrState.dynamicRules = nextRules;
  },
  async getSessionRules(options = {}) {
    return cloneRulesForApi(filterRulesByIds(dnrState.sessionRules, options.ruleIds));
  },
  async updateSessionRules({ addRules = [], removeRuleIds = [] } = {}) {
    dnrState.sessionUpdateAttempts.push(clone({ addRules, removeRuleIds }));
    if (dnrState.sessionUpdateOutcomes.length !== 0) {
      const outcome = dnrState.sessionUpdateOutcomes.shift();
      if (outcome !== null && outcome !== undefined) { throw outcome; }
    }
    if (dnrState.failSessionUpdateCount > 0) {
      dnrState.failSessionUpdateCount -= 1;
      throw new Error('simulated session update failure');
    }
    const nextRules = dnrState.sessionRules.filter(
      rule => removeRuleIds.includes(rule.id) === false
    );
    nextRules.push(...clone(addRules));
    assertUniqueRuleIds(nextRules);
    dnrState.sessionUpdateCalls.push(clone({ addRules, removeRuleIds }));
    dnrState.sessionRules = nextRules;
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
const manifestExtras = {};

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
    local: makeStorageArea(storageData, 'local'),
    session: makeStorageArea(sessionData, 'session'),
  },
  runtime: {
    getManifest() {
      return {
        homepage_url: 'https://talondefender.com',
        permissions: [],
        ...clone(manifestExtras),
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
  excludeFromStrictBlock,
  patchDefaultRulesets,
  repairDnrReconciliation,
  updateCommunityRules,
  updateDynamicRules,
  updateSessionRules,
  updateTalonSiteFixRuntimeRules,
  updateUserRules,
} = await import(new URL('../js/ruleset-manager.js', import.meta.url));
const {
  dnr: compatDnr,
  retryTransientDynamicRulesUpdate,
} = await import(new URL('../js/ext-compat.js', import.meta.url));

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
  localStorageReadFailurePredicate = null;
  for (const key of Object.keys(storageData)) {
    delete storageData[key];
  }
  for (const key of Object.keys(sessionData)) {
    delete sessionData[key];
  }
  for (const faults of [
    storageReadFailures.local,
    storageReadFailures.session,
    storageInvalidReadResponses.local,
    storageInvalidReadResponses.session,
  ]) {
    faults.clear();
  }
  alarmCreates.length = 0;
  alarmClears.length = 0;
  dnrState.dynamicRules.length = 0;
  dnrState.sessionRules.length = 0;
  dnrState.failCommunityUpdateCount = 0;
  dnrState.failUserUpdateCount = 0;
  dnrState.failSessionUpdateCount = 0;
  dnrState.dynamicReadOutcomes.length = 0;
  dnrState.dynamicUpdateOutcomes.length = 0;
  dnrState.sessionUpdateOutcomes.length = 0;
  dnrState.enabledRulesets.length = 0;
  dnrState.reorderReturnedRules = false;
  dnrState.dynamicUpdateAttempts.length = 0;
  dnrState.dynamicUpdateCalls.length = 0;
  dnrState.sessionUpdateAttempts.length = 0;
  dnrState.sessionUpdateCalls.length = 0;
  delete dnr.RuleConditionKeys;
  dnr.MAX_NUMBER_OF_DYNAMIC_RULES = DEFAULT_MAX_NUMBER_OF_DYNAMIC_RULES;
  dnr.MAX_NUMBER_OF_REGEX_RULES = DEFAULT_MAX_NUMBER_OF_REGEX_RULES;
  remoteBundle = null;
  remoteOverlayResponses.clear();
  overlayFetchLog.length = 0;
  for (const key of Object.keys(manifestExtras)) {
    delete manifestExtras[key];
  }
  permissionsState.broadHostPermissions = true;
  rulesetConfig.enabledRulesets = [];
  rulesetConfig.communityRulesEnabled = true;
  rulesetConfig.communityRulesURL = '';
  rulesetConfig.developerMode = false;
  rulesetConfig.strictBlockMode = true;
};

test('compiled strict-block packs receive globally unique IDs within Talon regex headroom', { concurrency: false }, async () => {
  resetEnvironment();
  dnrState.enabledRulesets.push('ublock-filters', 'ublock-badware');

  const sourceIds = compiledStrictBlockRules['ublock-filters'].map(rule => rule.id);
  const badwareIds = new Set(compiledStrictBlockRules['ublock-badware'].map(rule => rule.id));
  assert.ok(sourceIds.some(id => badwareIds.has(id)), 'fixture must contain overlapping compiled IDs');

  const result = await updateSessionRules();

  assert.equal(result?.error, undefined);
  const strictRules = dnrState.sessionRules.filter(rule => rule.priority === 29);
  assert.equal(strictRules.length, 799);
  assert.equal(new Set(strictRules.map(rule => rule.id)).size, strictRules.length);
  assert.deepEqual(strictRules.map(rule => rule.id), Array.from({ length: 799 }, (_, i) => i + 1));
  assert.ok(strictRules.every(rule => (
    rule.condition.regexFilter !== undefined &&
    rule.action.redirect.regexSubstitution ===
      'chrome-extension://talon-defender-test/strictblock.html#\\0'
  )));
});

test('strict-block regex exhaustion preserves non-regex hostname exclusions', { concurrency: false }, async () => {
  resetEnvironment();
  dnr.MAX_NUMBER_OF_REGEX_RULES = 5;
  dnrState.enabledRulesets.push('strict');
  dnrState.dynamicRules.push(...Array.from({ length: 4 }, (_, i) => ({
    id: i + 1,
    action: { type: 'block' },
    condition: {
      regexFilter: `^https:\\/\\/dynamic-${i + 1}\\.example\\/`,
      resourceTypes: ['script'],
    },
  })));
  await browserStub.storage.local.set({
    excludedStrictBlockHostnames: ['trusted.example'],
  });

  const result = await updateSessionRules();

  assert.equal(result?.error, undefined);
  assert.deepEqual(dnrState.sessionRules, [{
    id: 1,
    action: { type: 'allow' },
    condition: {
      requestDomains: ['trusted.example'],
      resourceTypes: ['main_frame'],
    },
    priority: 29,
  }]);
});

test('strict-block exclusion read failures preserve installed session rules until retry', { concurrency: false }, async () => {
  resetEnvironment();
  dnrState.enabledRulesets.push('strict');
  const installedBefore = [{
    id: 77,
    action: {
      type: 'redirect',
      redirect: {
        regexSubstitution: 'chrome-extension://talon-defender-test/strictblock.html#\\0',
      },
    },
    condition: {
      regexFilter: '^https:\\/\\/last-good\\.example\\/',
      resourceTypes: ['main_frame'],
    },
    priority: 29,
  }];
  dnrState.sessionRules.push(...clone(installedBefore));
  storageData.excludedStrictBlockHostnames = ['permanent.example'];
  sessionData.excludedStrictBlockHostnames = ['temporary.example'];

  failNextStorageRead('local', 'excludedStrictBlockHostnames');
  await assert.rejects(
    updateSessionRules(),
    /simulated local storage read failure/
  );
  assert.deepEqual(dnrState.sessionRules, installedBefore);
  assert.equal(dnrState.sessionUpdateCalls.length, 0);

  const localRetry = await updateSessionRules();
  assert.equal(localRetry?.error, undefined);
  assert.equal(dnrState.sessionUpdateCalls.length, 1);
  assert.ok(dnrState.sessionRules.some(rule => (
    rule.action?.type === 'allow' &&
    rule.condition?.requestDomains?.includes('permanent.example') &&
    rule.condition?.requestDomains?.includes('temporary.example')
  )));

  const afterLocalRetry = clone(dnrState.sessionRules);
  invalidateNextStorageRead('session', 'excludedStrictBlockHostnames');
  await assert.rejects(
    updateSessionRules(),
    /invalid session storage response/
  );
  assert.deepEqual(dnrState.sessionRules, afterLocalRetry);
  assert.equal(dnrState.sessionUpdateCalls.length, 1);

  const sessionRetry = await updateSessionRules();
  assert.equal(sessionRetry?.error, undefined);
  assert.equal(dnrState.sessionUpdateCalls.length, 2);
});

test('adding a strict-block exclusion never overwrites prior hosts after a storage read failure', { concurrency: false }, async () => {
  resetEnvironment();
  storageData.excludedStrictBlockHostnames = ['keep-local.example'];

  failNextStorageRead('local', 'excludedStrictBlockHostnames');
  await assert.rejects(
    excludeFromStrictBlock('new-local.example', true),
    /simulated local storage read failure/
  );
  assert.deepEqual(
    storageData.excludedStrictBlockHostnames,
    ['keep-local.example']
  );

  await excludeFromStrictBlock('new-local.example', true);
  assert.deepEqual(
    storageData.excludedStrictBlockHostnames.sort(),
    ['keep-local.example', 'new-local.example']
  );

  sessionData.excludedStrictBlockHostnames = ['keep-session.example'];
  invalidateNextStorageRead('session', 'excludedStrictBlockHostnames');
  await assert.rejects(
    excludeFromStrictBlock('new-session.example', false),
    /invalid session storage response/
  );
  assert.deepEqual(
    sessionData.excludedStrictBlockHostnames,
    ['keep-session.example']
  );

  await excludeFromStrictBlock('new-session.example', false);
  assert.deepEqual(
    sessionData.excludedStrictBlockHostnames.sort(),
    ['keep-session.example', 'new-session.example']
  );
});

test('strict-block permission cleanup awaits both exclusion stores', { concurrency: false }, async () => {
  resetEnvironment();
  permissionsState.broadHostPermissions = false;
  storageData.excludedStrictBlockHostnames = ['local-exclusion.example'];
  sessionData.excludedStrictBlockHostnames = ['session-exclusion.example'];

  const localArea = browserStub.storage.local;
  const sessionArea = browserStub.storage.session;
  const originalLocalRemove = localArea.remove;
  const originalSessionRemove = sessionArea.remove;
  let releaseLocal;
  let releaseSession;
  let localStarted;
  let sessionStarted;
  const localStartedPromise = new Promise(resolve => { localStarted = resolve; });
  const sessionStartedPromise = new Promise(resolve => { sessionStarted = resolve; });
  const localGate = new Promise(resolve => { releaseLocal = resolve; });
  const sessionGate = new Promise(resolve => { releaseSession = resolve; });

  localArea.remove = async key => {
    localStarted();
    await localGate;
    return originalLocalRemove.call(localArea, key);
  };
  sessionArea.remove = async key => {
    sessionStarted();
    await sessionGate;
    return originalSessionRemove.call(sessionArea, key);
  };

  try {
    let settled = false;
    const updating = updateSessionRules().finally(() => { settled = true; });
    await Promise.all([localStartedPromise, sessionStartedPromise]);
    await Promise.resolve();
    assert.equal(settled, false);

    releaseLocal();
    await Promise.resolve();
    assert.equal(settled, false);
    releaseSession();
    await updating;

    assert.equal(storageData.excludedStrictBlockHostnames, undefined);
    assert.equal(sessionData.excludedStrictBlockHostnames, undefined);
  } finally {
    localArea.remove = originalLocalRemove;
    sessionArea.remove = originalSessionRemove;
  }
});

test('dynamic regex installation drops unsupported topDomains rules on older Chrome', { concurrency: false }, async () => {
  resetEnvironment();
  dnrState.enabledRulesets.push('ublock-filters');
  rulesetConfig.strictBlockMode = false;

  const topDomainRuleCount = compiledUblockRegexRules.filter(
    rule => rule.condition?.topDomains !== undefined
  ).length;
  assert.ok(topDomainRuleCount > 0, 'fixture must contain compiled topDomains rules');

  const result = await updateDynamicRules();

  assert.equal(result?.error, undefined);
  assert.equal(
    dnrState.dynamicRules.length,
    compiledUblockRegexRules.length - topDomainRuleCount
  );
  assert.ok(dnrState.dynamicRules.every(rule => (
    rule.condition?.topDomains === undefined &&
    rule.condition?.excludedTopDomains === undefined
  )));
});

test('dynamic regex installation retains topDomains rules when Chrome advertises support', { concurrency: false }, async () => {
  resetEnvironment();
  dnr.RuleConditionKeys = { TOP_DOMAINS: 'topDomains' };
  dnrState.enabledRulesets.push('ublock-filters');
  rulesetConfig.strictBlockMode = false;

  const result = await updateDynamicRules();

  assert.equal(result?.error, undefined);
  assert.equal(dnrState.dynamicRules.length, compiledUblockRegexRules.length);
  assert.equal(
    dnrState.dynamicRules.filter(rule => rule.condition?.topDomains !== undefined).length,
    compiledUblockRegexRules.filter(
      rule => rule.condition?.topDomains !== undefined
    ).length
  );
});

test('Talon site-fix runtime mirror loads compiled rules once and is idempotent', { concurrency: false }, async () => {
  resetEnvironment();
  dnrState.enabledRulesets.push('talon-site-fixes');
  const expectedRules = compiledTalonSiteFixRules.filter(rule => (
    rule instanceof Object &&
    rule.action?.type === 'block' &&
    rule.condition instanceof Object
  ));

  const first = await updateTalonSiteFixRuntimeRules();

  assert.deepEqual(first, { added: expectedRules.length, removed: 0 });
  assert.equal(dnrState.dynamicUpdateCalls.length, 1);
  assert.deepEqual(
    dnrState.dynamicRules.map(rule => rule.id),
    expectedRules.map((unused, i) => 7000000 + i)
  );
  assert.ok(dnrState.dynamicRules.every(rule => rule.priority >= 500000));

  dnrState.reorderReturnedRules = true;
  const second = await updateTalonSiteFixRuntimeRules();

  assert.deepEqual(second, { added: 0, removed: 0 });
  assert.equal(dnrState.dynamicUpdateCalls.length, 1);

  dnrState.enabledRulesets = dnrState.enabledRulesets.filter(
    id => id !== 'talon-site-fixes'
  );
  const disabled = await updateTalonSiteFixRuntimeRules();

  assert.deepEqual(disabled, { added: 0, removed: expectedRules.length });
  assert.equal(dnrState.dynamicRules.length, 0);
});

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

test('community sync applies bounded first-party redirects and ignores public tactics in store builds', { concurrency: false }, async () => {
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
  assert.equal(storageData.communityBundlePublicTactics, undefined);
  assert.equal(storageData.communityBundleMeta.publicTacticsCount, 0);
  assert.equal(storageData.communityBundleMeta.tacticsHostCount, 0);
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

test('community sync ignores signed public tactics from schema v4 bundles in store builds', { concurrency: false }, async () => {
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
  assert.equal(storageData.communityBundlePublicTactics, undefined);
  assert.equal(storageData.communityBaselinePublicTacticsV1, undefined);
  assert.equal(storageData.communityBundleMeta.publicTacticsCount, 0);
  assert.equal(storageData.communityBundleMeta.tacticsCount, 0);
  assert.equal(storageData.communityBundleMeta.tacticsHostCount, 0);
});

test('community sync does not refresh injectables for tactics-only baseline extras in store builds', { concurrency: false }, async () => {
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
  assert.equal(result.requiresInjectableRefresh, false);
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
  assert.equal(storageData.communityBaselinePublicTacticsV1, undefined);
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
  assert.equal(storageData.communityBundlePublicTactics, undefined);
  assert.equal(storageData.communityBundleMeta.publicTacticsCount, 0);
  assert.equal(storageData.communityBundleMeta.tacticsHostCount, 0);
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
  assert.equal(storageData.communityBundlePublicTactics, undefined);
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

test('community activation snapshot read failure is mutation-free and retryable', { concurrency: false }, async () => {
  resetEnvironment();

  const storedRules = [{
    action: { type: 'block' },
    condition: { urlFilter: '||snapshot-stored.example^' },
  }];
  const storedMeta = {
    version: 'snapshot-stored-v1',
    schemaVersion: 2,
    ttlHours: 6,
    hotfixLane: 'public',
  };
  await browserStub.storage.local.set({
    communityBundleRules: storedRules,
    communityBundleMeta: storedMeta,
    communityBundleLastSuccess: Date.UTC(2026, 2, 25, 17, 0, 0, 0),
    communityBaselineMetaV1: storedMeta,
    communityBaselineRulesV1: storedRules,
  });
  await updateCommunityRules(storedRules, {
    source: 'stored',
    version: storedMeta.version,
    schemaVersion: storedMeta.schemaVersion,
  });
  dnrState.dynamicUpdateCalls.length = 0;

  remoteBundle = await createSignedBundle({
    version: 'snapshot-remote-v2',
    rules: [{
      action: { type: 'block' },
      condition: { urlFilter: '||snapshot-remote.example^' },
    }],
  });
  const storageBefore = clone({ ...storageData });
  const dnrBefore = clone(dnrState.dynamicRules);
  localStorageReadFailurePredicate = key =>
    Array.isArray(key) &&
    key.includes('communityOverlayPayloadsV1') &&
    key.includes('communityBundleLastSuccess') &&
    key.includes('communityInjectableFingerprintV1');

  await assert.rejects(
    syncCommunityRules({ force: true }),
    /community storage read failed: simulated transient local storage snapshot failure/
  );

  assert.deepEqual(clone({ ...storageData }), storageBefore);
  assert.deepEqual(dnrState.dynamicRules, dnrBefore);
  assert.equal(dnrState.dynamicUpdateCalls.length, 0);
  assert.equal(alarmCreates.length, 0);

  const retried = await syncCommunityRules({ force: true });
  assert.equal(retried.source, 'remote');
  assert.equal(retried.meta.version, 'snapshot-remote-v2');
  assert.equal(dnrState.dynamicUpdateCalls.length, 1);
  assert.deepEqual(
    dnrState.dynamicRules
      .filter(rule => rule.id >= 6000000 && rule.id < 7000000)
      .map(rule => rule.condition.urlFilter),
    ['||snapshot-remote.example^']
  );
});

test('community rollback refuses an incomplete snapshot without mutating last-good state', { concurrency: false }, async () => {
  resetEnvironment();
  storageData.communityBundleMeta = { version: 'last-good' };
  dnrState.dynamicRules.push({
    id: 6000000,
    priority: 30,
    action: { type: 'block' },
    condition: { urlFilter: '||last-good.example^' },
  });
  const storageBefore = clone({ ...storageData });
  const dnrBefore = clone(dnrState.dynamicRules);

  await assert.rejects(
    rollbackCommunityActivation({}, 'registration failed'),
    /community rollback snapshot unavailable/
  );

  assert.deepEqual(clone({ ...storageData }), storageBefore);
  assert.deepEqual(dnrState.dynamicRules, dnrBefore);
  assert.equal(dnrState.dynamicUpdateCalls.length, 0);
  assert.equal(alarmCreates.length, 0);
});

test('overlay finalization reads authoritative state before success writes and retries safely', { concurrency: false }, async () => {
  resetEnvironment();
  storageData.communityBundleMeta = { version: 'overlay-candidate' };
  storageData.communityBundleLastSuccess = 123;
  storageData.communityOverlayIndexV1 = {
    'video.example': {
      siteKey: 'video.example',
      version: 'overlay-v2',
      lastStatus: 'updated',
    },
  };
  storageData.communityOverlayPayloadsV1 = {
    'video.example': {
      siteKey: 'video.example',
      version: 'overlay-v2',
      baselineVersion: 'baseline-v1',
      schemaVersion: 3,
      rules: [],
    },
  };
  const activation = {
    kind: 'overlay',
    overlaySiteKey: 'video.example',
    overlayVersion: 'overlay-v2',
    overlayStatus: 'updated',
    overlayReason: 'test-finalize',
  };
  const storageBefore = clone({ ...storageData });
  localStorageReadFailurePredicate = key =>
    Array.isArray(key) &&
    key.includes('communityOverlayIndexV1') &&
    key.includes('communityOverlayPayloadsV1');

  await assert.rejects(
    finalizeCommunityActivationSuccess(activation),
    /community storage read failed: simulated transient local storage snapshot failure/
  );
  assert.deepEqual(clone({ ...storageData }), storageBefore);
  assert.equal(alarmCreates.length, 0);

  const finalized = await finalizeCommunityActivationSuccess(activation);
  assert.ok(finalized.lastSuccess > 123);
  assert.equal(storageData.communityBundleLastSuccess, finalized.lastSuccess);
  assert.equal(
    storageData.communityOverlayIndexV1['video.example'].lastStatus,
    'updated'
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
  assert.equal(
    dnrState.sessionRules.filter(rule => rule.priority === 29).length,
    3
  );
  assert.equal(
    dnrState.sessionRules.filter(rule => rule.condition?.regexFilter !== undefined).length,
    3
  );

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

test('user-rule reconciliation exposes Chrome apply failures for durable retry markers', { concurrency: false }, async () => {
  resetEnvironment();
  rulesetConfig.developerMode = true;
  await browserStub.storage.local.set({
    userDnrRules: textFromRules([
      {
        action: { type: 'block' },
        condition: {
          urlFilter: '||retry.example.com^',
          resourceTypes: ['script'],
        },
      },
    ]),
  });
  dnrState.failUserUpdateCount = 1;

  const result = await updateUserRules();

  assert.equal(result.applyFailed, true);
  assert.match(result.errors.join('\n'), /simulated user-rule apply failure/);
  assert.equal(dnrState.dynamicRules.some(rule => rule.id >= 9000000), false);
});

test('user-rule source read failures never replace last-good DNR state and remain retryable', { concurrency: false }, async () => {
  resetEnvironment();
  rulesetConfig.developerMode = true;
  const lastGoodRule = {
    id: 9000000,
    priority: 1000001,
    action: { type: 'block' },
    condition: {
      urlFilter: '||last-good.example^',
      resourceTypes: ['script'],
    },
  };
  dnrState.dynamicRules.push(clone(lastGoodRule));
  storageData.userDnrRules = textFromRules([{
    action: { type: 'block' },
    condition: {
      urlFilter: '||replacement.example^',
      resourceTypes: ['script'],
    },
  }]);

  failNextStorageRead('local', 'userDnrRules');
  await assert.rejects(
    updateUserRules(),
    /simulated local storage read failure/
  );
  assert.deepEqual(dnrState.dynamicRules, [lastGoodRule]);
  assert.equal(dnrState.dynamicUpdateCalls.length, 0);

  const sourceRetry = await updateUserRules();
  assert.equal(sourceRetry.applyFailed, false);
  assert.equal(dnrState.dynamicUpdateCalls.length, 1);
  assert.equal(
    dnrState.dynamicRules.find(rule => rule.id >= 9000000)?.condition?.urlFilter,
    '||replacement.example^'
  );

  const afterSourceRetry = clone(dnrState.dynamicRules);
  invalidateNextStorageRead('local', 'sandboxFilters.dnrRules');
  await assert.rejects(
    updateUserRules(),
    /invalid local storage response for sandboxFilters\.dnrRules/
  );
  assert.deepEqual(dnrState.dynamicRules, afterSourceRetry);
  assert.equal(dnrState.dynamicUpdateCalls.length, 1);

  const sandboxRetry = await updateUserRules();
  assert.equal(sandboxRetry.applyFailed, false);
  assert.equal(dnrState.dynamicUpdateCalls.length, 2);

  delete storageData.userDnrRules;
  delete storageData['sandboxFilters.dnrRules'];
  const missingKeys = await updateUserRules();
  assert.equal(missingKeys.applyFailed, false);
  assert.equal(dnrState.dynamicRules.some(rule => rule.id >= 9000000), false);
});

test('default-ruleset baseline read failure cannot rewrite selection state before retry', { concurrency: false }, async () => {
  resetEnvironment();
  manifestExtras.declarative_net_request = {
    rule_resources: [
      { id: 'next-default-a', enabled: true, path: 'rulesets/main/a.json' },
      { id: 'next-default-b', enabled: true, path: 'rulesets/main/b.json' },
    ],
  };
  storageData.defaultRulesetIds = ['old-default'];
  rulesetConfig.enabledRulesets = ['old-default'];
  rulesetConfig.rulesetSelectionVersion = 1;

  failNextStorageRead('local', 'defaultRulesetIds');
  await assert.rejects(
    patchDefaultRulesets(),
    /simulated local storage read failure/
  );
  assert.deepEqual(storageData.defaultRulesetIds, ['old-default']);
  assert.deepEqual(rulesetConfig.enabledRulesets, ['old-default']);
  assert.equal(rulesetConfig.rulesetSelectionVersion, 1);

  const retried = await patchDefaultRulesets();
  assert.equal(retried, true);
  assert.deepEqual(
    storageData.defaultRulesetIds,
    ['next-default-a', 'next-default-b']
  );
  assert.deepEqual(
    rulesetConfig.enabledRulesets,
    ['next-default-a', 'next-default-b']
  );
});

test('missing default-ruleset baseline remains a successful empty-baseline fallback', { concurrency: false }, async () => {
  resetEnvironment();
  manifestExtras.declarative_net_request = {
    rule_resources: [
      { id: 'next-default', enabled: true, path: 'rulesets/main/next.json' },
    ],
  };
  rulesetConfig.enabledRulesets = ['custom-selection'];
  rulesetConfig.rulesetSelectionVersion = 1;

  const changed = await patchDefaultRulesets();

  assert.equal(changed, false);
  assert.deepEqual(storageData.defaultRulesetIds, ['next-default']);
  assert.deepEqual(rulesetConfig.enabledRulesets, ['custom-selection']);
});

test('DNR dirty-marker read failure performs no repair mutation and retries safely', { concurrency: false }, async () => {
  resetEnvironment();
  storageData.dnrReconciliationDirtyV1 = true;
  dnrState.dynamicRules.push({
    id: 123,
    priority: 1,
    action: { type: 'block' },
    condition: {
      urlFilter: '||stale-dynamic.example^',
      resourceTypes: ['script'],
    },
  });

  failNextStorageRead('local', 'dnrReconciliationDirtyV1');
  await assert.rejects(
    repairDnrReconciliation(),
    /simulated local storage read failure/
  );
  assert.equal(dnrState.dynamicUpdateCalls.length, 0);
  assert.equal(dnrState.dynamicRules.some(rule => rule.id === 123), true);
  assert.equal(storageData.dnrReconciliationDirtyV1, true);

  const retried = await repairDnrReconciliation();
  assert.equal(retried.repaired, true);
  assert.equal(dnrState.dynamicRules.some(rule => rule.id === 123), false);
  assert.equal(Object.hasOwn(storageData, 'dnrReconciliationDirtyV1'), false);
  const callsAfterRepair = dnrState.dynamicUpdateCalls.length;

  const missingMarker = await repairDnrReconciliation();
  assert.deepEqual(missingMarker, { skipped: 'clean' });
  assert.equal(dnrState.dynamicUpdateCalls.length, callsAfterRepair);
});

test('dynamic ruleset retry helper reports third-attempt recovery and honors injected waits', async () => {
  const retryDelaysMs = [17, 29];
  const observedWaits = [];
  let attempts = 0;

  const result = await retryTransientDynamicRulesUpdate(async () => {
    attempts += 1;
    if (attempts < 3) {
      throw new Error('Internal error while updating dynamic rules.');
    }
  }, {
    retryDelaysMs,
    wait: async delayMs => { observedWaits.push(delayMs); },
  });

  assert.deepEqual(result, { attempts: 3, recovered: true });
  assert.deepEqual(observedWaits, retryDelaysMs);
});

test('setAllowAllRules reports snapshot failures with the base rule ID and performs no writes', { concurrency: false }, async () => {
  resetEnvironment();
  dnrState.dynamicReadOutcomes.push(new Error('simulated dynamic snapshot failure'));

  await assert.rejects(
    compatDnr.setAllowAllRules(
      8000000,
      ['news.example'],
      [],
      false,
      2000000
    ),
    /setAllowAllRules\(8000000\) state snapshot failed: simulated dynamic snapshot failure/
  );

  assert.equal(dnrState.dynamicUpdateAttempts.length, 0);
  assert.equal(dnrState.sessionUpdateAttempts.length, 0);
  assert.equal(storageData.allowAllRulesDiagnosticsV1, undefined);
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

test('setAllowAllRules accepts Chrome-normalized rule object key order', { concurrency: false }, async () => {
  resetEnvironment();
  dnrState.reorderReturnedRules = true;

  const modified = await compatDnr.setAllowAllRules(
    8500000,
    [],
    [],
    true,
    3000000
  );

  assert.equal(modified, true);
  assert.deepEqual(dnrState.dynamicRules, [
    {
      id: 8500000,
      action: { type: 'allowAllRequests' },
      condition: {
        resourceTypes: ['main_frame'],
      },
      priority: 3000000,
    },
  ]);
  assert.deepEqual(dnrState.sessionRules, [
    {
      id: 8500001,
      action: { type: 'allow' },
      condition: {
        tabIds: [-1],
      },
      priority: 3000000,
    },
  ]);
  assert.equal(storageData.allowAllRulesDiagnosticsV1, undefined);
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

  await assert.rejects(
    compatDnr.setAllowAllRules(
      8000000,
      ['news.example'],
      [],
      false,
      2000000
    ),
    /desired state failed and was rolled back/
  );

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

test('setAllowAllRules retries one exact transient dynamic failure with the identical desired delta', { concurrency: false }, async () => {
  resetEnvironment();
  dnrState.dynamicUpdateOutcomes.push(
    new Error('Internal error while updating dynamic rules.')
  );

  const modified = await compatDnr.setAllowAllRules(
    8500000,
    [],
    [],
    true,
    3000000
  );

  assert.equal(modified, true);
  assert.equal(dnrState.dynamicUpdateAttempts.length, 2);
  assert.strictEqual(
    dnrState.dynamicUpdateAttempts[0].details,
    dnrState.dynamicUpdateAttempts[1].details,
    'the retry must reuse the identical atomic dynamic-rule delta'
  );
  assert.equal(dnrState.dynamicUpdateCalls.length, 1);
  assert.equal(dnrState.dynamicRules[0]?.id, 8500000);
  assert.equal(dnrState.sessionRules[0]?.id, 8500001);
});

test('setAllowAllRules rolls back only the dynamic lane when the desired session write rejects', { concurrency: false }, async () => {
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
  dnrState.dynamicUpdateOutcomes.push(
    null,
    new Error('Internal error while updating dynamic rules.'),
    null
  );
  dnrState.failSessionUpdateCount = 1;

  await assert.rejects(
    compatDnr.setAllowAllRules(
      8000000,
      ['news.example'],
      [],
      false,
      2000000
    ),
    reason => {
      assert.match(
        reason.message,
        /setAllowAllRules\(8000000\) desired state failed and was rolled back/
      );
      assert.match(
        reason.message,
        /desired session mutation failed: simulated session update failure/
      );
      return true;
    }
  );

  assert.equal(dnrState.dynamicUpdateAttempts.length, 3);
  assert.strictEqual(
    dnrState.dynamicUpdateAttempts[1].details,
    dnrState.dynamicUpdateAttempts[2].details,
    'the rollback retry must reuse the identical atomic delta'
  );
  assert.equal(
    dnrState.dynamicRules[0]?.condition?.requestDomains?.[0],
    'stored.example',
    'the dynamic rollback must settle before rejection is reported'
  );
  assert.equal(
    dnrState.sessionRules[0]?.condition?.initiatorDomains?.[0],
    'stored.example'
  );
  assert.equal(
    dnrState.sessionUpdateAttempts.length,
    1,
    'an atomically rejected session write must not be rolled back'
  );
  assert.equal(dnrState.sessionUpdateCalls.length, 0);
});

test('setAllowAllRules does not roll back an already-matching dynamic lane after an atomic session rejection', { concurrency: false }, async () => {
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
  dnrState.failSessionUpdateCount = 1;

  await assert.rejects(
    compatDnr.setAllowAllRules(
      8000000,
      ['news.example'],
      [],
      false,
      2000000
    ),
    /setAllowAllRules\(8000000\) desired session mutation failed: simulated session update failure/
  );

  assert.equal(dnrState.dynamicUpdateAttempts.length, 0);
  assert.equal(dnrState.sessionUpdateAttempts.length, 1);
  assert.equal(dnrState.sessionUpdateCalls.length, 0);
  assert.equal(dnrState.dynamicRules[0]?.condition?.requestDomains?.[0], 'news.example');
  assert.deepEqual(dnrState.sessionRules, []);
  assert.equal(storageData.allowAllRulesDiagnosticsV1, undefined);
});

test('setAllowAllRules bounds a legitimate dynamic rollback failure and preserves original phase context', { concurrency: false }, async () => {
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
  dnrState.dynamicUpdateOutcomes.push(
    null,
    new Error('Internal error while updating dynamic rules.'),
    new Error('Internal error while updating dynamic rules.'),
    new Error('Internal error while updating dynamic rules.')
  );
  dnrState.failSessionUpdateCount = 1;

  await assert.rejects(
    compatDnr.setAllowAllRules(
      8000000,
      ['news.example'],
      [],
      false,
      2000000
    ),
    reason => {
      assert.match(reason.message, /rollback mutation failed \(dynamic mutated\)/);
      assert.match(reason.message, /dynamic: Internal error while updating dynamic rules\./);
      assert.match(reason.message, /desired session mutation failed: simulated session update failure/);
      return true;
    }
  );

  assert.equal(dnrState.dynamicUpdateAttempts.length, 4);
  assert.strictEqual(
    dnrState.dynamicUpdateAttempts[1].details,
    dnrState.dynamicUpdateAttempts[2].details
  );
  assert.strictEqual(
    dnrState.dynamicUpdateAttempts[2].details,
    dnrState.dynamicUpdateAttempts[3].details
  );
  assert.equal(
    dnrState.dynamicRules[0]?.condition?.requestDomains?.[0],
    'news.example',
    'the failed rollback must leave the uncertain desired dynamic state observable'
  );
  assert.equal(
    dnrState.sessionRules[0]?.condition?.initiatorDomains?.[0],
    'stored.example'
  );
  assert.equal(storageData.allowAllRulesDiagnosticsV1, undefined);
});

test('setAllowAllRules reports rollback verification read failures without recording success', { concurrency: false }, async () => {
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
  dnrState.dynamicReadOutcomes.push(
    null,
    new Error('simulated rollback verification read failure')
  );
  dnrState.failSessionUpdateCount = 1;

  await assert.rejects(
    compatDnr.setAllowAllRules(
      8000000,
      ['news.example'],
      [],
      false,
      2000000
    ),
    reason => {
      assert.match(reason.message, /rollback verification read failed/);
      assert.match(reason.message, /simulated rollback verification read failure/);
      assert.match(reason.message, /desired session mutation failed: simulated session update failure/);
      return true;
    }
  );

  assert.equal(
    dnrState.dynamicRules[0]?.condition?.requestDomains?.[0],
    'stored.example'
  );
  assert.equal(storageData.allowAllRulesDiagnosticsV1, undefined);
});

test('setAllowAllRules awaits every mutated rollback lane before reporting a rollback failure', { concurrency: false }, async () => {
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
  dnrState.dynamicReadOutcomes.push(
    null,
    []
  );
  dnrState.dynamicUpdateOutcomes.push(
    null,
    new Error('Internal error while updating dynamic rules.'),
    null
  );
  dnrState.sessionUpdateOutcomes.push(
    null,
    new Error('simulated session rollback failure')
  );

  await assert.rejects(
    compatDnr.setAllowAllRules(
      8000000,
      ['news.example'],
      [],
      false,
      2000000
    ),
    reason => {
      assert.match(reason.message, /setAllowAllRules\(8000000\) rollback failed/);
      assert.match(reason.message, /session: simulated session rollback failure/);
      assert.match(reason.message, /desired-state verification failed: state mismatch/);
      return true;
    }
  );

  assert.equal(dnrState.dynamicUpdateAttempts.length, 3);
  assert.strictEqual(
    dnrState.dynamicUpdateAttempts[1].details,
    dnrState.dynamicUpdateAttempts[2].details,
    'the rollback retry must reuse the identical atomic delta'
  );
  assert.equal(
    dnrState.dynamicRules[0]?.condition?.requestDomains?.[0],
    'stored.example',
    'the dynamic rollback must settle even when the session rollback rejects'
  );
  assert.equal(
    dnrState.sessionRules[0]?.condition?.initiatorDomains?.[0],
    'news.example',
    'the rejected session rollback must remain observable'
  );
});

test('setAllowAllRules does not retry actionable or near-match dynamic failures', { concurrency: false }, async () => {
  for (const message of [
    'Rule count exceeded.',
    'Internal error while updating dynamic rules',
    'Error: Internal error while updating dynamic rules.',
  ]) {
    resetEnvironment();
    dnrState.dynamicUpdateOutcomes.push(new Error(message));

    await assert.rejects(
      compatDnr.setAllowAllRules(
        8500000,
        [],
        [],
        true,
        3000000
      ),
      new RegExp(`setAllowAllRules\\(8500000\\) desired dynamic mutation failed: ${message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
    );

    const desiredAttempts = dnrState.dynamicUpdateAttempts.filter(
      attempt => attempt.snapshot.addRules.some(rule => rule.id === 8500000)
    );
    assert.equal(
      desiredAttempts.length,
      1,
      `non-transient failure must not retry: ${message}`
    );
    assert.equal(
      dnrState.dynamicUpdateAttempts.length,
      1,
      'an atomically rejected desired write must not trigger rollback traffic'
    );
    assert.equal(dnrState.sessionUpdateAttempts.length, 0);
  }
});

test('setAllowAllRules bounds a persistent exact desired failure without mutating or rolling back', { concurrency: false }, async () => {
  resetEnvironment();
  for (let i = 0; i < 3; i += 1) {
    dnrState.dynamicUpdateOutcomes.push(
      new Error('Internal error while updating dynamic rules.')
    );
  }

  await assert.rejects(
    compatDnr.setAllowAllRules(
      8500000,
      [],
      [],
      true,
      3000000
    ),
    reason => {
      assert.match(
        reason.message,
        /setAllowAllRules\(8500000\) desired dynamic mutation failed: Internal error while updating dynamic rules\./
      );
      return true;
    }
  );

  assert.equal(dnrState.dynamicUpdateAttempts.length, 3);
  assert.strictEqual(
    dnrState.dynamicUpdateAttempts[0].details,
    dnrState.dynamicUpdateAttempts[1].details
  );
  assert.strictEqual(
    dnrState.dynamicUpdateAttempts[1].details,
    dnrState.dynamicUpdateAttempts[2].details
  );
  assert.equal(dnrState.dynamicUpdateCalls.length, 0);
  assert.equal(dnrState.sessionUpdateAttempts.length, 0);
  assert.deepEqual(dnrState.dynamicRules, []);
  assert.deepEqual(dnrState.sessionRules, []);
  assert.equal(storageData.allowAllRulesDiagnosticsV1, undefined);
});

test('community sync accepts packaged signing-key rotation by signature key id', { concurrency: false }, async () => {
  resetEnvironment();

  manifestExtras.talonCommunityPublicKeysB64 = {
    next: Buffer.alloc(32, 7).toString('base64'),
  };
  const bundle = await createSignedBundle({
    version: 'rotation-v1',
    rules: [
      {
        action: { type: 'block' },
        condition: {
          requestDomains: ['rotation.example'],
          resourceTypes: ['script'],
        },
      },
    ],
  });
  bundle.signature.kid = 'next';

  const result = await applyBaselineBundle(bundle);

  assert.equal(result.source, 'remote');
  assert.equal(storageData.communityBundleMeta.version, 'rotation-v1');
  assert.deepEqual(
    dnrState.dynamicRules
      .filter(rule => rule.id >= 6000000 && rule.id < 7000000)
      .map(rule => rule.condition.requestDomains),
    [['rotation.example']]
  );
});

test('community sync rejects unknown or revoked signing key ids with diagnostics', { concurrency: false }, async () => {
  resetEnvironment();

  const unknownKeyBundle = await createSignedBundle({
    version: 'unknown-key-v1',
    rules: [
      {
        action: { type: 'block' },
        condition: {
          requestDomains: ['unknown-key.example'],
          resourceTypes: ['script'],
        },
      },
    ],
  });
  unknownKeyBundle.signature.kid = 'missing';
  remoteBundle = unknownKeyBundle;

  const unknownKeyResult = await syncCommunityRules({ force: true });
  assert.equal(unknownKeyResult.source, 'fallback');
  assert.match(unknownKeyResult.error, /unknown signing key: missing/);
  assert.match(storageData.communityBundleLastError, /unknown signing key: missing/);

  resetEnvironment();

  manifestExtras.talonCommunityRevokedKeyIds = ['default'];
  remoteBundle = await createSignedBundle({
    version: 'revoked-key-v1',
    rules: [
      {
        action: { type: 'block' },
        condition: {
          requestDomains: ['revoked-key.example'],
          resourceTypes: ['script'],
        },
      },
    ],
  });

  const revokedKeyResult = await syncCommunityRules({ force: true });
  assert.equal(revokedKeyResult.source, 'fallback');
  assert.match(revokedKeyResult.error, /signing key revoked: default/);
  assert.match(storageData.communityBundleLastError, /signing key revoked: default/);
});

test('packaged community emergency disable clears active signed hotfix state without fetching', { concurrency: false }, async () => {
  resetEnvironment();

  await browserStub.storage.local.set({
    communityBundleRules: [
      {
        action: { type: 'block' },
        condition: {
          requestDomains: ['stored-hotfix.example'],
          resourceTypes: ['script'],
        },
      },
    ],
    communityBundleMeta: {
      version: 'stored-hotfix-v1',
      schemaVersion: 2,
      ttlHours: 6,
    },
    communityBundleLastSuccess: Date.UTC(2026, 2, 25, 17, 0, 0, 0),
  });
  await updateCommunityRules(storageData.communityBundleRules, {
    source: 'stored',
    version: 'stored-hotfix-v1',
    schemaVersion: 2,
  });
  manifestExtras.talonCommunitySyncDisabled = true;

  const result = await syncCommunityRules({ force: true });

  assert.equal(result.source, 'cleanup');
  assert.equal(result.cleanupReason, 'signing-disabled');
  assert.equal(Object.hasOwn(storageData, 'communityBundleRules'), false);
  assert.equal(Object.hasOwn(storageData, 'communityBundleMeta'), false);
  assert.deepEqual(
    dnrState.dynamicRules.filter(rule => rule.id >= 6000000 && rule.id < 7000000),
    []
  );
  assert.equal(overlayFetchLog.length, 0);
});

test('packaged community fallback bundle is intentionally empty', { concurrency: false }, () => {
  assert.equal(Array.isArray(fallbackRules), true);
  assert.equal(fallbackRules.length, 0);
});
