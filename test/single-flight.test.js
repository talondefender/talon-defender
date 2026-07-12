import test from 'node:test';
import assert from 'node:assert/strict';

import { createSingleFlightRunner } from '../js/single-flight.js';

const loadOverlaySessionStore = async () => {
  const browserStub = {
    declarativeNetRequest: {},
    permissions: {
      async getAll() {
        return { origins: [] };
      },
    },
    runtime: {
      id: 'talon-defender-test',
      getURL(path = '') {
        return new URL(path, 'chrome-extension://talon-defender-test/').toString();
      },
    },
    storage: {
      local: {
        async get() {
          return {};
        },
        async set() {},
      },
    },
    tabs: {
      TAB_ID_NONE: -1,
    },
  };
  globalThis.self = globalThis;
  globalThis.browser = browserStub;
  globalThis.chrome = browserStub;
  return import('../js/utils.js?overlay-session-test');
};

test('single-flight runner shares one in-flight promise for concurrent callers', async () => {
  let calls = 0;
  let resolveTask;
  const runner = createSingleFlightRunner(() => {
    calls += 1;
    return new Promise(resolve => {
      resolveTask = resolve;
    });
  });

  const first = runner();
  const second = runner();
  assert.equal(first, second);
  assert.equal(calls, 1);

  resolveTask('done');
  assert.equal(await first, 'done');
});

test('single-flight runner clears state after rejection so the next call can recover', async () => {
  let shouldReject = true;
  let calls = 0;
  const runner = createSingleFlightRunner(async () => {
    calls += 1;
    if (shouldReject) {
      shouldReject = false;
      throw new Error('boom');
    }
    return 'recovered';
  });

  await assert.rejects(() => runner(), /boom/);
  assert.equal(calls, 1);
  assert.equal(await runner(), 'recovered');
  assert.equal(calls, 2);
});

test('single-flight trailing mode reruns once for state changes during a task', async () => {
  const resolvers = [];
  let calls = 0;
  const runner = createSingleFlightRunner(() => {
    calls += 1;
    return new Promise(resolve => {
      resolvers.push(resolve);
    });
  }, { trailing: true });

  const first = runner();
  const second = runner();
  const third = runner();
  assert.equal(first, second);
  assert.equal(first, third);
  assert.equal(calls, 1);

  resolvers.shift()('stale');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);

  resolvers.shift()('current');
  assert.equal(await first, 'current');
  assert.equal(calls, 2);
});

test('single-flight trailing mode converges after a superseded failure', async () => {
  let resolveFirst;
  let calls = 0;
  const runner = createSingleFlightRunner(async () => {
    calls += 1;
    if ( calls === 1 ) {
      await new Promise(resolve => {
        resolveFirst = resolve;
      });
      throw new Error('superseded failure');
    }
    return 'recovered';
  }, { trailing: true });

  const pending = runner();
  assert.equal(runner(), pending);
  resolveFirst();
  assert.equal(await pending, 'recovered');
  assert.equal(calls, 2);
});

test('single-flight waitForIdle observes work without requesting a trailing rerun', async () => {
  let release;
  let calls = 0;
  const runner = createSingleFlightRunner(async () => {
    calls += 1;
    await new Promise(resolve => { release = resolve; });
    return 'done';
  }, { trailing: true });

  const operation = runner();
  assert.equal(runner.isRunning(), true);
  let idle = false;
  const waiter = runner.waitForIdle().then(() => { idle = true; });
  await Promise.resolve();
  assert.equal(idle, false);
  assert.equal(calls, 1);

  release();
  assert.equal(await operation, 'done');
  await waiter;
  assert.equal(idle, true);
  assert.equal(runner.isRunning(), false);
  assert.equal(calls, 1);
});

test('single-flight trailing handoff cannot lose a call in the settlement window', async () => {
  let resolveFirst;
  const firstGate = new Promise(resolve => { resolveFirst = resolve; });
  let calls = 0;
  const runner = createSingleFlightRunner(async () => {
    calls += 1;
    if (calls === 1) {
      await firstGate;
      return 'stale';
    }
    return 'current';
  }, { trailing: true });

  const first = runner();
  const idle = runner.waitForIdle();
  const finalizationWindowCall = firstGate.then(() => runner());
  resolveFirst();

  assert.equal(await first, 'current');
  assert.equal(await finalizationWindowCall, 'current');
  await idle;
  assert.equal(calls, 2);
  assert.equal(runner.isRunning(), false);
});

test('ruleset config prefers durable revisions and independently heals corrupt records', async () => {
  const localData = {
    rulesetConfig: {
      configRevision: 8,
      autoReload: false,
      enabledRulesets: ['durable'],
    },
  };
  const sessionData = {
    rulesetConfig: {
      configRevision: 7,
      autoReload: true,
      enabledRulesets: ['stale-session'],
    },
  };
  let rejectNextSessionWrite = false;
  let rejectNextLocalRead = false;
  let rejectNextLocalWrite = false;
  const writeCounts = { local: 0, session: 0 };
  const createArea = (data, isSession = false) => ({
    async get(key) {
      if (isSession === false && rejectNextLocalRead) {
        rejectNextLocalRead = false;
        throw new Error('local read failed');
      }
      if (key === null) return structuredClone(data);
      if (Array.isArray(key)) {
        return Object.fromEntries(key
          .filter(item => Object.hasOwn(data, item))
          .map(item => [item, structuredClone(data[item])]));
      }
      return Object.hasOwn(data, key)
        ? { [key]: structuredClone(data[key]) }
        : {};
    },
    async set(values) {
      if (isSession && rejectNextSessionWrite) {
        rejectNextSessionWrite = false;
        throw new Error('session write failed');
      }
      if (isSession === false && rejectNextLocalWrite) {
        rejectNextLocalWrite = false;
        throw new Error('local write failed');
      }
      writeCounts[isSession ? 'session' : 'local'] += 1;
      Object.assign(data, structuredClone(values));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
  });
  const browserStub = {
    declarativeNetRequest: {},
    permissions: { async getAll() { return { origins: [] }; } },
    runtime: {
      id: 'talon-defender-config-test',
      getManifest() { return { permissions: [] }; },
      getURL(path = '') {
        return new URL(path, 'chrome-extension://talon-defender-config-test/').toString();
      },
    },
    storage: {
      local: createArea(localData),
      session: createArea(sessionData, true),
    },
    tabs: { TAB_ID_NONE: -1 },
  };
  globalThis.self = globalThis;
  globalThis.browser = browserStub;
  globalThis.chrome = browserStub;
  const config = await import('../js/config.js?revision-storage-test');

  await config.loadRulesetConfig();
  assert.equal(config.rulesetConfig.autoReload, false);
  assert.deepEqual(config.rulesetConfig.enabledRulesets, ['durable']);
  assert.deepEqual(sessionData.rulesetConfig, localData.rulesetConfig);

  config.rulesetConfig.autoReload = true;
  await config.saveRulesetConfig();
  assert.equal(localData.rulesetConfig.configRevision, 9);
  assert.deepEqual(sessionData.rulesetConfig, localData.rulesetConfig);

  rejectNextSessionWrite = true;
  config.rulesetConfig.autoReload = false;
  await assert.rejects(() => config.saveRulesetConfig(), /session write failed/);
  config.rulesetConfig.autoReload = true;
  await config.saveRulesetConfig();
  assert.equal(localData.rulesetConfig.configRevision, 11);
  assert.deepEqual(sessionData.rulesetConfig, localData.rulesetConfig);

  const validConfig = structuredClone(localData.rulesetConfig);
  localData.rulesetConfig = [];
  await config.loadRulesetConfig();
  assert.equal(config.rulesetConfig.autoReload, true);
  assert.deepEqual(sessionData.rulesetConfig, validConfig);
  assert.deepEqual(localData.rulesetConfig, validConfig);

  sessionData.rulesetConfig = 'corrupt-session-config';
  await config.loadRulesetConfig();
  assert.equal(config.rulesetConfig.autoReload, true);
  assert.equal(config.process.wakeupRun, false);
  assert.deepEqual(localData.rulesetConfig, validConfig);
  assert.deepEqual(sessionData.rulesetConfig, validConfig);

  const writesBeforeReadFailure = structuredClone(writeCounts);
  rejectNextLocalRead = true;
  await assert.rejects(() => config.loadRulesetConfig(), /local read failed/);
  assert.deepEqual(writeCounts, writesBeforeReadFailure);
  assert.deepEqual(localData.rulesetConfig, validConfig);
  assert.deepEqual(sessionData.rulesetConfig, validConfig);

  localData.rulesetConfig = 'corrupt-local-before-heal';
  sessionData.rulesetConfig = structuredClone(validConfig);
  rejectNextLocalWrite = true;
  await assert.rejects(() => config.loadRulesetConfig(), /local write failed/);
  assert.equal(localData.rulesetConfig, 'corrupt-local-before-heal');
  assert.deepEqual(sessionData.rulesetConfig, validConfig);
  await config.loadRulesetConfig();
  assert.deepEqual(localData.rulesetConfig, validConfig);

  localData.rulesetConfig = { corrupt: true };
  sessionData.rulesetConfig = 42;
  await config.loadRulesetConfig();
  assert.equal(config.process.firstRun, false);
  assert.equal(config.process.wakeupRun, false);
  assert.deepEqual(localData.rulesetConfig, sessionData.rulesetConfig);
  assert.deepEqual(localData.rulesetConfig.enabledRulesets, []);

  localData.rulesetConfig = {
    ...structuredClone(validConfig),
    unrecognizedFutureField: 'must-not-leak',
  };
  delete sessionData.rulesetConfig;
  await config.loadRulesetConfig();
  assert.equal(
    Object.hasOwn(config.rulesetConfig, 'unrecognizedFutureField'),
    false
  );
  assert.equal(
    Object.hasOwn(localData.rulesetConfig, 'unrecognizedFutureField'),
    false
  );

  sessionData.rulesetConfig = structuredClone(validConfig);
  await config.loadRulesetConfig();
  assert.deepEqual(sessionData.rulesetConfig, localData.rulesetConfig);
});

test('granular permission reconciliation preserves Complete sites covered by exact or parent grants', async () => {
  const {
    MODE_BASIC,
    MODE_OPTIMAL,
    applyEffectiveModeDeltaToUser,
    applyManagedFilteringModes,
    reconcileGranularPermissionModes,
    setFilteringModeDetails,
  } = await import('../js/mode-manager.js?granular-permission-test');
  const filteringModes = {
    none: new Set(),
    basic: new Set(['all-urls']),
    optimal: new Set(),
    complete: new Set([
      'exact.example',
      'child.parent.example',
      'revoked.example',
    ]),
  };
  const modified = reconcileGranularPermissionModes({
    filteringModes,
    beforeAllowedHostnames: new Set([
      'exact.example',
      'parent.example',
      'revoked.example',
    ]),
    afterAllowedHostnames: new Set([
      'exact.example',
      'parent.example',
      'new.example',
    ]),
    fallbackMode: MODE_BASIC,
  });

  assert.equal(modified, true);
  assert.equal(filteringModes.complete.has('exact.example'), true);
  assert.equal(filteringModes.complete.has('child.parent.example'), true);
  assert.equal(filteringModes.complete.has('revoked.example'), false);
  assert.equal(filteringModes.optimal.has('new.example'), true);
  assert.equal(MODE_OPTIMAL, 2);

  assert.equal(reconcileGranularPermissionModes({
    filteringModes,
    beforeAllowedHostnames: new Set([
      'exact.example',
      'parent.example',
      'new.example',
    ]),
    afterAllowedHostnames: new Set([
      'exact.example',
      'parent.example',
      'new.example',
    ]),
    fallbackMode: MODE_BASIC,
  }), false);

  const rawUserModes = {
    none: new Set(),
    basic: new Set(),
    optimal: new Set(['all-urls']),
    complete: new Set(['user-complete.example']),
  };
  const managedEffectiveModes = applyManagedFilteringModes(
    rawUserModes,
    'complete',
    ['managed-none.example']
  );
  const desiredEffectiveModes = {
    none: new Set(managedEffectiveModes.none),
    basic: new Set(managedEffectiveModes.basic),
    optimal: new Set(managedEffectiveModes.optimal),
    complete: new Set(managedEffectiveModes.complete),
  };
  desiredEffectiveModes.basic.add('user-basic.example');
  const updatedRawUserModes = {
    none: new Set(rawUserModes.none),
    basic: new Set(rawUserModes.basic),
    optimal: new Set(rawUserModes.optimal),
    complete: new Set(rawUserModes.complete),
  };
  applyEffectiveModeDeltaToUser(
    updatedRawUserModes,
    managedEffectiveModes,
    desiredEffectiveModes
  );

  assert.equal(updatedRawUserModes.optimal.has('all-urls'), true);
  assert.equal(updatedRawUserModes.complete.has('all-urls'), false);
  assert.equal(updatedRawUserModes.none.has('managed-none.example'), false);
  assert.equal(updatedRawUserModes.basic.has('user-basic.example'), true);
  const reappliedEffectiveModes = applyManagedFilteringModes(
    updatedRawUserModes,
    'complete',
    ['managed-none.example']
  );
  assert.equal(reappliedEffectiveModes.complete.has('all-urls'), true);
  assert.equal(reappliedEffectiveModes.none.has('managed-none.example'), true);

  let staleError;
  try {
    await setFilteringModeDetails(rawUserModes, 999);
  } catch (error) {
    staleError = error;
  }
  assert.equal(staleError?.code, 'stale_filtering_mode_revision');
  assert.equal(staleError?.currentDetails?.configRevision, 0);
  assert.deepEqual(staleError?.currentDetails?.optimal, ['all-urls']);
  const storedAfterConflict = await globalThis.browser.storage.local.get(
    'filteringModeDetails'
  );
  assert.equal(storedAfterConflict.filteringModeDetails.configRevision, 0);
});

test('overlay session store registers and claims one valid token once', async () => {
  const { createOverlaySessionStore } = await loadOverlaySessionStore();
  let now = 1000;
  const store = createOverlaySessionStore({
    now: () => now,
    ttlMs: 5000,
  });
  const session = {
    token: 'a'.repeat(32),
    file: '/picker-ui.html',
    pageUrl: 'https://example.com/path',
    tabId: 7,
    frameId: 0,
  };

  assert.deepEqual(store.register(session), { ok: true, expiresAt: 6000 });
  assert.deepEqual(store.claim(session), {
    ok: true,
    file: '/picker-ui.html',
    pageUrl: 'https://example.com/path',
    tabId: 7,
    frameId: 0,
  });
  assert.deepEqual(store.claim(session), { ok: false, error: 'unknown_token' });
});

test('overlay session store rejects malformed and unknown tokens', async () => {
  const { createOverlaySessionStore } = await loadOverlaySessionStore();
  const store = createOverlaySessionStore();

  assert.deepEqual(store.register({
    token: 'not-a-token',
    file: '/picker-ui.html',
    pageUrl: 'https://example.com/',
    tabId: 1,
    frameId: 0,
  }), { ok: false, error: 'invalid_session' });

  assert.deepEqual(store.claim({
    token: 'b'.repeat(32),
    file: '/picker-ui.html',
    pageUrl: 'https://example.com/',
  }), { ok: false, error: 'unknown_token' });
});

test('overlay session store rejects expired tokens', async () => {
  const { createOverlaySessionStore } = await loadOverlaySessionStore();
  let now = 0;
  const store = createOverlaySessionStore({
    now: () => now,
    ttlMs: 1000,
  });
  const session = {
    token: 'c'.repeat(32),
    file: '/unpicker-ui.html',
    pageUrl: 'https://example.org/',
    tabId: 2,
    frameId: 0,
  };

  assert.equal(store.register(session).ok, true);
  now = 1001;
  assert.deepEqual(store.claim(session), { ok: false, error: 'expired_token' });
  assert.equal(store.size, 0);
});

test('overlay session store rejects mismatched file or page URL and consumes the token', async () => {
  const { createOverlaySessionStore } = await loadOverlaySessionStore();
  const store = createOverlaySessionStore();
  const session = {
    token: 'd'.repeat(32),
    file: '/picker-ui.html',
    pageUrl: 'https://example.com/page',
    tabId: 3,
    frameId: 0,
  };

  assert.equal(store.register(session).ok, true);
  assert.deepEqual(store.claim({
    ...session,
    file: '/unpicker-ui.html',
  }), { ok: false, error: 'session_mismatch' });
  assert.deepEqual(store.claim(session), { ok: false, error: 'unknown_token' });

  assert.equal(store.register(session).ok, true);
  assert.deepEqual(store.claim({
    ...session,
    pageUrl: 'https://example.com/other',
  }), { ok: false, error: 'session_mismatch' });
  assert.deepEqual(store.claim(session), { ok: false, error: 'unknown_token' });
});
