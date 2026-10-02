import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const readSource = relativePath =>
  fs.readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');
const expiredPolicy = { ready: true, enabled: true, expired: true };
const entitledPolicy = { ready: true, enabled: true, expired: false };
const disabledPolicy = { ready: true, enabled: false, expired: true };
const settle = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };

function createHarness(policy = expiredPolicy) {
  const state = {
    adShowing: true,
    feedbackCalls: [],
    intervals: [],
    listeners: new Map(),
    policy,
    requests: [],
    runtimeListener: null,
    skipStops: 0,
    storageListener: null,
    timeouts: [],
  };
  const indicator = { hidden: false, getClientRects: () => [{ width: 20, height: 20 }] };
  const addListener = (name, handler) => state.listeners.set(name, handler);
  const removeListener = (name, handler) => {
    if (state.listeners.get(name) === handler) state.listeners.delete(name);
  };
  const document = {
    visibilityState: 'visible',
    addEventListener: addListener,
    removeEventListener: removeListener,
    querySelector(selector) {
      assert.notEqual(selector, 'video', 'the observer must not control playback');
      return state.adShowing && selector.includes('ad-showing') ? indicator : null;
    },
    querySelectorAll(selector) {
      assert.notEqual(selector, 'video', 'the observer must not control playback');
      return state.adShowing && selector.includes('ytp-ad') ? [indicator] : [];
    },
  };
  const context = {
    __talonYoutubeEntitlementObserverTest: true,
    document,
    location: { hostname: 'www.youtube.com', href: 'https:' + '//www.youtube.com/watch?v=fixture' },
    addEventListener: addListener,
    removeEventListener: removeListener,
    clearInterval(id) {
      const entry = state.intervals.find(value => value.id === id);
      if (entry) entry.cleared = true;
    },
    clearTimeout(id) {
      const entry = state.timeouts.find(value => value.id === id);
      if (entry) entry.cleared = true;
    },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    setInterval(handler, delay) {
      const entry = { id: state.intervals.length + 1, handler, delay, cleared: false };
      state.intervals.push(entry);
      return entry.id;
    },
    setTimeout(handler, delay) {
      const entry = { id: state.timeouts.length + 1, handler, delay, cleared: false };
      state.timeouts.push(entry);
      return entry.id;
    },
    TalonYoutubeAdFeedbackController: {
      setActive(active, options) {
        state.feedbackCalls.push({ active: active === true, mode: options?.mode });
        return true;
      },
      stop(options) { state.feedbackCalls.push({ active: false, mode: options?.mode }); },
    },
    TalonYoutubeAdSkipController: { stop() { state.skipStops += 1; } },
    chrome: {
      runtime: {
        async sendMessage(request) {
          state.requests.push(request);
          return typeof state.policy === 'function' ? state.policy(request) : state.policy;
        },
        onMessage: {
          addListener(listener) { state.runtimeListener = listener; },
          removeListener(listener) {
            if (state.runtimeListener === listener) state.runtimeListener = null;
          },
        },
      },
      storage: {
        onChanged: {
          addListener(listener) { state.storageListener = listener; },
          removeListener(listener) {
            if (state.storageListener === listener) state.storageListener = null;
          },
        },
      },
    },
  };
  context.top = context;
  context.window = context;
  context.globalThis = context;
  return { context, document, state };
}

async function createController(policy) {
  const harness = createHarness(policy);
  vm.runInNewContext(await readSource('js/scripting/youtube-entitlement-observer.js'), harness.context);
  return { ...harness, controller: harness.context.__talonYoutubeEntitlementObserverCreateController(harness.context) };
}

test('expired YouTube feedback requires background authorization and is limited to visible ads', async () => {
  const { controller, state } = await createController();
  await controller.start();
  assert.equal(controller.getState(), 'expired');
  assert.equal(state.requests[0].what, 'getYoutubeFeedbackPolicy');
  assert.equal(state.skipStops, 0, 'presentation must not stop or start protection');
  assert.equal(state.intervals.at(-1).delay, 500);
  assert.deepEqual(state.feedbackCalls.at(-1), { active: true, mode: 'expired' });
  state.adShowing = false;
  assert.equal(controller.tick(), false);
  assert.deepEqual(state.feedbackCalls.at(-1), { active: false, mode: 'expired' });
});

test('observer never displays expired feedback without initialized allowed policy', async () => {
  for (const policy of [undefined, null, {}, { ready: false }, disabledPolicy, entitledPolicy]) {
    const { controller, state } = await createController(null);
    state.policy = policy;
    await controller.start();
    assert.equal(state.feedbackCalls.some(call => call.active), false, JSON.stringify(policy));
    assert.equal(state.intervals.some(timer => !timer.cleared), false);
  }
  const { controller, state } = await createController(() => { throw new Error('worker unavailable'); });
  await controller.start();
  assert.equal(state.feedbackCalls.some(call => call.active), false);
  assert.equal(controller.getState(), 'unknown');
});

test('policy timeouts hide feedback and cold-start retries have a finite budget', async () => {
  const pending = Promise.withResolvers();
  const { controller, state } = await createController(() => pending.promise);
  const starting = controller.start();
  await settle();
  const deadline = state.timeouts.find(timer => !timer.cleared);
  assert.ok(deadline.delay <= 2500, 'a missing worker response must be bounded');
  deadline.cleared = true;
  deadline.handler();
  await starting;
  pending.resolve(expiredPolicy);
  await settle();
  assert.equal(state.feedbackCalls.some(call => call.active), false);

  state.policy = { ready: false };
  for (let i = 0; i < 12; i += 1) {
    const retry = state.timeouts.find(timer => !timer.cleared);
    if (!retry) break;
    retry.cleared = true;
    retry.handler();
    await settle();
  }
  assert.ok(state.requests.length > 1 && state.requests.length <= 10);
  assert.equal(state.timeouts.some(timer => !timer.cleared), false);
  assert.equal(state.feedbackCalls.some(call => call.active), false);
});

test('entitlement changes remove expired feedback before policy refresh and restore no acceleration', async () => {
  const { controller, state } = await createController();
  await controller.start();
  const expiredInterval = state.intervals.at(-1);
  state.policy = entitledPolicy;
  state.storageListener({ talonEntitlement: { newValue: {} } }, 'local');
  await settle();
  assert.equal(controller.getState(), 'entitled');
  assert.equal(expiredInterval.cleared, true);
  assert.equal(state.feedbackCalls.at(-1).active, false);
  assert.equal(state.skipStops, 0);
});

test('background policy notifications refresh an open document without a storage mutation', async () => {
  const { controller, state } = await createController({ ready: false });
  await controller.start();
  state.policy = expiredPolicy;
  state.runtimeListener({ youtubeFeedbackPolicyChanged: true });
  await settle();
  assert.equal(controller.getState(), 'expired');
  assert.equal(state.feedbackCalls.at(-1).active, true);
  state.policy = entitledPolicy;
  state.runtimeListener({ youtubeFeedbackPolicyChanged: true });
  await settle();
  assert.equal(controller.getState(), 'entitled');
  assert.equal(state.feedbackCalls.at(-1).active, false);
});

test('known entitlement boundary refreshes presentation without writing entitlement or reloading', async () => {
  const { controller, state } = await createController({ ...entitledPolicy, refreshAfterMs: 5000 });
  await controller.start();
  const boundary = state.timeouts.find(timer => !timer.cleared && timer.delay === 5000);
  assert.ok(boundary);
  state.policy = expiredPolicy;
  boundary.cleared = true;
  boundary.handler();
  await settle();
  assert.equal(controller.getState(), 'expired');
  assert.equal(state.feedbackCalls.at(-1).active, true);
  assert.equal(state.skipStops, 0);
});

test('Allowed Sites and backoff changes revoke a previously authorized expired overlay', async () => {
  for (const key of ['filteringModeDetails', 'autoBackoffSubsystemsV1']) {
    const { controller, state } = await createController();
    await controller.start();
    state.policy = disabledPolicy;
    state.storageListener({ [key]: { newValue: {} } }, 'local');
    await settle();
    assert.equal(state.feedbackCalls.at(-1).active, false, key);
    assert.equal(controller.getState(), 'disabled', key);
    assert.equal(state.intervals.some(timer => !timer.cleared), false, key);
  }
});

test('stale expired policy replies cannot undo a newer Allowed Sites decision', async () => {
  const pending = Promise.withResolvers();
  const { controller, state } = await createController(() => pending.promise);
  const starting = controller.start();
  await settle();
  state.policy = disabledPolicy;
  state.storageListener({ filteringModeDetails: { newValue: { none: ['youtube.com'] } } }, 'local');
  await settle();
  pending.resolve(expiredPolicy);
  await starting;
  await settle();
  assert.equal(controller.getState(), 'disabled');
  assert.equal(state.feedbackCalls.some(call => call.active), false);
});

test('observer teardown rejects late policy work and can resume with fresh authorization', async () => {
  const pending = Promise.withResolvers();
  const { controller, state } = await createController(() => pending.promise);
  const starting = controller.start();
  await settle();
  const oldStorageListener = state.storageListener;
  controller.stop();
  pending.resolve(expiredPolicy);
  await starting;
  oldStorageListener({ talonEntitlement: { newValue: {} } }, 'local');
  await settle();
  assert.equal(controller.isActive(), false);
  assert.equal(state.feedbackCalls.some(call => call.active), false);
  assert.equal(state.storageListener, null);
  assert.equal(state.runtimeListener, null);
  assert.equal(state.intervals.some(timer => !timer.cleared), false);

  state.policy = expiredPolicy;
  await controller.start();
  assert.equal(controller.getState(), 'expired');
  assert.equal(state.feedbackCalls.at(-1).active, true);
  assert.equal(state.intervals.filter(timer => !timer.cleared).length, 1);
});

test('observer does not request policy or present feedback on unrelated hosts or subframes', async () => {
  for (const mode of ['other-host', 'iframe']) {
    const { controller, context, state } = await createController();
    if (mode === 'other-host') context.location.hostname = 'example.com';
    else context.top = {};
    await controller.start();
    assert.equal(state.requests.length, 0, mode);
    assert.equal(state.feedbackCalls.some(call => call.active), false, mode);
  }
});

test('observer leaves protection and network behavior to their existing controllers', async () => {
  const source = await readSource('js/scripting/youtube-entitlement-observer.js');
  assert.doesNotMatch(source, /TalonYoutubeAdSkipController/);
  assert.doesNotMatch(source, /\.playbackRate\s*=|\.currentTime\s*=|\.muted\s*=/);
  assert.doesNotMatch(source, /\.click\s*\(/);
  assert.doesNotMatch(source, /\bfetch\s*\(|\bXMLHttpRequest\b/);
  assert.doesNotMatch(source, /computeState|trialStartMs|licenseKey|entitledUntilMs/);
});

test('feedback policy authenticates the document and preserves entitlement, Allowed Sites and ancestor backoff gates', async () => {
  const source = await readSource('js/background.js');
  const start = source.indexOf('const readYoutubeFeedbackPolicy =');
  const end = source.indexOf('function notifyYoutubeFeedbackPolicyChanged()', start);
  assert.ok(start >= 0 && end > start);
  const state = { initialized: true, startupComplete: true, ready: true, level: 2, status: 'expired', suppressed: new Set(), reads: 0 };
  const readPolicy = new Function('state', `
    const runtime = { id: 'talon-test' };
    const MODE_NONE = 0;
    const normalizeHttpHostname = url => {
      try { const parsed = new URL(url); return /^https?:$/.test(parsed.protocol) ? parsed.hostname : ''; }
      catch { return ''; }
    };
    const isStartupCoreReady = () => state.ready;
    const getFilteringMode = async () => { state.reads += 1; return state.level; };
    const readPopupEntitlementSnapshot = async () => { state.reads += 1; return { status: state.status }; };
    const hasActiveSubsystemBackoff = hostname => state.suppressed.has(hostname);
    let entitlementInitialized, startupComplete;
    ${source.slice(start, end)}
    return sender => {
      entitlementInitialized = state.initialized;
      startupComplete = state.startupComplete;
      return readYoutubeFeedbackPolicy(sender);
    };
  `)(state);
  const sender = {
    id: 'talon-test', frameId: 0, tab: { id: 1 }, documentId: 'document-fixture',
    url: 'https:' + '//www.youtube.com/watch?v=fixture',
  };
  assert.deepEqual(await readPolicy(sender), expiredPolicy);
  for (const patch of [
    { id: 'other-extension' }, { frameId: 1 }, { tab: undefined }, { tab: { id: -1 } },
    { documentId: '' }, { url: 'https://example.com/' },
    { url: 'https:' + '//youtube.com.example.com/' }, { url: 'https:' + '//notyoutube.com/' },
  ]) {
    state.reads = 0;
    assert.deepEqual(await readPolicy({ ...sender, ...patch }), { ready: true, enabled: false, expired: false });
    assert.equal(state.reads, 0, 'rejected sender must not trigger policy work');
  }
  state.initialized = false;
  state.reads = 0;
  assert.equal((await readPolicy(sender)).ready, false);
  assert.equal(state.reads, 0);
  state.initialized = true;
  state.startupComplete = false;
  assert.equal((await readPolicy(sender)).ready, false);
  assert.equal(state.reads, 0);
  state.startupComplete = true;
  state.ready = false;
  assert.equal((await readPolicy(sender)).ready, false);
  state.ready = true;
  state.status = 'loading';
  assert.equal((await readPolicy(sender)).ready, false);
  state.status = 'trial';
  assert.deepEqual(await readPolicy(sender), entitledPolicy);
  state.status = 'expired';
  state.level = 0;
  assert.deepEqual(await readPolicy(sender), disabledPolicy);
  state.level = 2;
  state.suppressed.add('youtube.com');
  assert.deepEqual(await readPolicy(sender), disabledPolicy);
  state.suppressed.clear();
  state.suppressed.add('www.youtube.com');
  assert.deepEqual(await readPolicy(sender), disabledPolicy);
});

test('static YouTube registration contains only top-frame presentation controllers', async () => {
  const manifest = JSON.parse(await readSource('manifest.json'));
  assert.deepEqual(manifest.content_scripts, [{
    matches: ['*://*.youtube.com/*', '*://*.youtube-nocookie.com/*'],
    js: ['js/scripting/youtube-ad-feedback.js', 'js/scripting/youtube-entitlement-observer.js'],
    run_at: 'document_start',
  }]);
});
