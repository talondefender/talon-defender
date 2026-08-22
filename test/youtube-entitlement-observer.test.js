import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const readSource = relativePath =>
  fs.readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');

function createHarness(storedEntitlement) {
  const state = {
    adShowing: true,
    feedbackCalls: [],
    intervals: [],
    skipStops: 0,
    storageListener: null,
    storedEntitlement,
    timeouts: [],
  };
  const indicator = {
    hidden: false,
    getClientRects: () => [{ width: 20, height: 20 }],
  };
  const document = {
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
    querySelector(selector) {
      return state.adShowing && selector.includes('ad-showing') ? {} : null;
    },
    querySelectorAll(selector) {
      return state.adShowing && selector.includes('ytp-ad') ? [indicator] : [];
    },
  };
  const context = {
    __talonYoutubeEntitlementObserverTest: true,
    document,
    addEventListener() {},
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
    },
    TalonYoutubeAdSkipController: {
      stop() {
        state.skipStops += 1;
      },
    },
    chrome: {
      storage: {
        local: {
          async get() {
            return { talonEntitlement: state.storedEntitlement };
          },
        },
        onChanged: {
          addListener(listener) {
            state.storageListener = listener;
          },
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
  return { context, state };
}

test('expired YouTube observer stops acceleration and shows feedback only during ads', async () => {
  const source = await readSource('js/scripting/youtube-entitlement-observer.js');
  const now = Date.now();
  const { context, state } = createHarness({
    trialStartMs: now - (8 * 24 * 60 * 60 * 1000),
    deviceId: 'device-expired',
  });
  vm.runInNewContext(source, context);

  const controller = context.__talonYoutubeEntitlementObserverCreateController(context);
  await controller.refresh();
  assert.equal(controller.getState(), 'expired');
  assert.equal(state.skipStops, 1);
  assert.equal(state.intervals.at(-1).delay, 500);
  assert.deepEqual(state.feedbackCalls.at(-1), { active: true, mode: 'expired' });

  state.adShowing = false;
  assert.equal(controller.tick(), false);
  assert.deepEqual(state.feedbackCalls.at(-1), { active: false, mode: 'expired' });
});

test('entitlement observer removes expired feedback immediately after reactivation', async () => {
  const source = await readSource('js/scripting/youtube-entitlement-observer.js');
  const now = Date.now();
  const { context, state } = createHarness({
    trialStartMs: now - (8 * 24 * 60 * 60 * 1000),
    deviceId: 'device-expired',
  });
  vm.runInNewContext(source, context);

  const controller = context.__talonYoutubeEntitlementObserverCreateController(context);
  controller.init();
  await controller.refresh();
  const expiredInterval = state.intervals.at(-1);

  const paidState = {
    trialStartMs: now - (8 * 24 * 60 * 60 * 1000),
    entitledUntilMs: now + 86_400_000,
    graceUntilMs: now + 86_400_000,
    licenseKey: 'TD-TEST',
  };
  state.storageListener({
    talonEntitlement: { newValue: paidState },
  }, 'local');

  assert.equal(controller.getState(), 'entitled');
  assert.equal(expiredInterval.cleared, true);
  assert.deepEqual(state.feedbackCalls.at(-1), { active: false, mode: 'expired' });
});

test('entitlement observer is presentation-only and paywall shutdown owns live skip cleanup', async () => {
  const observerSource = await readSource('js/scripting/youtube-entitlement-observer.js');
  const backgroundSource = await readSource('js/background.js');

  assert.match(observerSource, /TalonYoutubeAdSkipController\?\.stop/);
  assert.match(observerSource, /TalonYoutubeAdFeedbackController\?\.setActive/);
  assert.doesNotMatch(observerSource, /\.playbackRate\s*=/);
  assert.doesNotMatch(observerSource, /\.currentTime\s*=/);
  assert.doesNotMatch(observerSource, /\.muted\s*=/);
  assert.doesNotMatch(observerSource, /\.click\s*\(/);
  assert.doesNotMatch(observerSource, /\bfetch\s*\(|\bXMLHttpRequest\b/);
  assert.match(
    backgroundSource,
    /\[ 'TalonYoutubeAdSkipController', \[ 'stop' \] \]/
  );
});
