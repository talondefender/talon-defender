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
