import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const readSource = relativePath =>
  fs.readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');

function createHarness() {
  const state = {
    adShowing: true,
    playerClassShowing: true,
    skipShowing: true,
    hiddenInterruptions: 0,
    interruptionShowing: false,
    observerCallback: null,
    observerOptions: null,
    playerObserverCallback: null,
    playerObserverOptions: null,
    fallbackSkipShowing: false,
    shortPlayerSkipShowing: false,
    navigationSkipShowing: false,
    skipEvents: [],
    skipFocuses: 0,
    skipClicks: 0,
    styles: [],
    listeners: [],
    timeoutCallbacks: [],
  };
  const video = {
    muted: false,
    playbackRate: 1,
    duration: 30,
    currentTime: 2,
    paused: false,
    playCalls: 0,
    play() {
      this.paused = false;
      this.playCalls += 1;
      return Promise.resolve();
    },
  };
  const skipButton = {
    disabled: false,
    hidden: false,
    getAttribute: name => (name === 'aria-disabled' ? 'false' : null),
    getClientRects: () => [{ width: 20, height: 20 }],
    matches: selector => selector.includes('ytp-ad-skip') || selector.includes('skip-button'),
    focus: () => {
      state.skipFocuses += 1;
    },
    dispatchEvent: event => {
      state.skipEvents.push(event.type);
      return true;
    },
    click: () => {
      state.skipClicks += 1;
    },
  };
  const fallbackSkipButton = {
    disabled: false,
    hidden: false,
    textContent: 'Skip ads',
    getAttribute: name => (name === 'aria-disabled' ? 'false' : null),
    getClientRects: () => [{ width: 20, height: 20 }],
    matches: () => false,
    focus: () => {
      state.skipFocuses += 1;
    },
    dispatchEvent: event => {
      state.skipEvents.push(event.type);
      return true;
    },
    click: () => {
      state.skipClicks += 1;
    },
  };
  const shortPlayerSkipButton = {
    disabled: false,
    hidden: false,
    textContent: 'Skip',
    getAttribute: name => (name === 'aria-disabled' ? 'false' : null),
    getClientRects: () => [{ width: 20, height: 20 }],
    matches: () => false,
    closest: selector => selector === '.html5-video-player,#movie_player' ? playerElement : null,
    focus: () => {
      state.skipFocuses += 1;
    },
    dispatchEvent: event => {
      state.skipEvents.push(event.type);
      return true;
    },
    click: () => {
      state.skipClicks += 1;
    },
  };
  const navigationSkipButton = {
    disabled: false,
    hidden: false,
    textContent: 'Skip navigation',
    getAttribute: name => {
      if (name === 'aria-disabled') { return 'false'; }
      if (name === 'aria-label') { return 'Skip navigation'; }
      return null;
    },
    getClientRects: () => [{ width: 20, height: 20 }],
    matches: () => false,
    focus: () => {
      state.skipFocuses += 1;
    },
    dispatchEvent: event => {
      state.skipEvents.push(event.type);
      return true;
    },
    click: () => {
      state.skipClicks += 1;
    },
  };
  const styleParent = {
    append: element => {
      state.styles.push(element);
    },
  };
  const playerElement = {
    nodeType: 1,
    matches: selector => selector.includes('.html5-video-player') || selector.includes('#movie_player'),
    querySelectorAll: () => [],
  };
  const interruptionToast = {
    nodeType: 1,
    hidden: false,
    textContent: 'Experiencing interruptions? Find out why',
    style: {
      setProperty: () => {
        state.hiddenInterruptions += 1;
      },
    },
    setAttribute(name, value) {
      if (name === 'aria-hidden' && value === 'true') {
        state.hiddenInterruptions += 1;
      }
    },
    matches: selector => selector.includes('tp-yt-paper-toast') || selector.includes('[role="alert"]'),
    querySelectorAll: () => [],
  };
  const document = {
    visibilityState: 'visible',
    head: styleParent,
    documentElement: styleParent,
    addEventListener: (name, handler) => {
      state.listeners.push({ name, handler });
    },
    createElement: tagName => ({
      tagName,
      id: '',
      textContent: '',
      remove() {
        state.styles = state.styles.filter(style => style !== this);
      },
    }),
    getElementById: id => state.styles.find(style => style.id === id) || null,
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
    querySelectorAll(selector) {
      if (selector === 'video') {
        return [video];
      }
      if (selector.includes('ytp-ad-skip') || selector.includes('skip-ad')) {
        return state.skipShowing ? [skipButton] : [];
      }
      if (selector === 'button,[role="button"]') {
        return [
          state.fallbackSkipShowing ? fallbackSkipButton : null,
          state.shortPlayerSkipShowing ? shortPlayerSkipButton : null,
          state.navigationSkipShowing ? navigationSkipButton : null,
        ].filter(Boolean);
      }
      if (selector.includes('.ad-showing')) {
        return state.adShowing && state.playerClassShowing ? [{ className: 'ad-showing' }] : [];
      }
      if (selector === '.html5-video-player,#movie_player') {
        return [playerElement];
      }
      if (selector.includes('ytp-ad-player-overlay') || selector.includes('ytd-ad-slot-renderer')) {
        return state.adShowing ? [{ className: 'ytp-ad-player-overlay' }] : [];
      }
      if (selector.includes('tp-yt-paper-toast') || selector.includes('[role="alert"]')) {
        return state.interruptionShowing ? [interruptionToast] : [];
      }
      return [];
    },
  };

  const context = {
    __talonYoutubeAdSkipTest: true,
    document,
    location: { hostname: 'www.youtube.com' },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: handler => {
      state.timeoutCallbacks.push(handler);
      return state.timeoutCallbacks.length;
    },
    clearTimeout: () => {},
    addEventListener: () => {},
    MouseEvent: class {
      constructor(type) {
        this.type = type;
      }
    },
    MutationObserver: class {
      constructor(handler) {
        this.handler = handler;
      }
      observe(target, options) {
        if (options?.attributes) {
          state.playerObserverCallback = this.handler;
          state.playerObserverOptions = options;
          return;
        }
        state.observerCallback = this.handler;
        state.observerOptions = options;
      }
      disconnect() {
        state.observerCallback = null;
        state.playerObserverCallback = null;
      }
    },
  };
  context.globalThis = context;
  return { context, interruptionToast, state, video };
}

test('YouTube ad skip clicks native skip controls and speeds visible ads without seeking', async () => {
  const source = await readSource('js/scripting/youtube-ad-skip.js');
  const { context, state, video } = createHarness();
  vm.runInNewContext(source, context);

  const controller = context.__talonYoutubeAdSkipCreateController(context);
  assert.equal(controller.tick(), true);
  assert.equal(state.skipClicks, 1);
  assert.equal(state.skipEvents.includes('click'), true);
  assert.equal(state.skipFocuses, 1);
  assert.equal(video.muted, true);
  assert.equal(video.playbackRate, 16);
  assert.equal(video.currentTime, 2);
  assert.equal(state.styles.length, 1);
  assert.equal(state.styles[0].id, 'talon-youtube-ad-skip-style');

  state.adShowing = false;
  state.skipShowing = false;
  assert.equal(controller.tick(), false);
  assert.equal(video.muted, false);
  assert.equal(video.playbackRate, 1);
});

test('YouTube ad skip recognizes visible ad indicators when ad-showing class is absent', async () => {
  const source = await readSource('js/scripting/youtube-ad-skip.js');
  const { context, state, video } = createHarness();
  state.playerClassShowing = false;
  video.paused = true;
  vm.runInNewContext(source, context);

  const controller = context.__talonYoutubeAdSkipCreateController(context);
  assert.equal(controller.tick(), true);
  assert.equal(state.skipClicks, 1);
  assert.equal(video.muted, true);
  assert.equal(video.playbackRate, 16);
  assert.equal(video.paused, false);
  assert.equal(video.playCalls, 1);
});

test('YouTube ad skip accepts labeled fallback skip controls', async () => {
  const source = await readSource('js/scripting/youtube-ad-skip.js');
  const { context, state, video } = createHarness();
  state.adShowing = false;
  state.skipShowing = false;
  state.fallbackSkipShowing = true;
  vm.runInNewContext(source, context);

  const controller = context.__talonYoutubeAdSkipCreateController(context);
  assert.equal(controller.tick(), true);
  assert.equal(state.skipClicks, 1);
  assert.equal(state.skipEvents.includes('click'), true);
  assert.equal(video.muted, true);
  assert.equal(video.playbackRate, 16);
});

test('YouTube ad skip ignores plain Skip controls without an ad-specific label or class', async () => {
  const source = await readSource('js/scripting/youtube-ad-skip.js');
  const { context, state, video } = createHarness();
  state.adShowing = false;
  state.skipShowing = false;
  state.shortPlayerSkipShowing = true;
  vm.runInNewContext(source, context);

  const controller = context.__talonYoutubeAdSkipCreateController(context);
  assert.equal(controller.tick(), false);
  assert.equal(state.skipClicks, 0);
  assert.equal(state.skipEvents.length, 0);
  assert.equal(video.muted, false);
  assert.equal(video.playbackRate, 1);
});

test('YouTube ad skip ignores non-ad skip navigation controls', async () => {
  const source = await readSource('js/scripting/youtube-ad-skip.js');
  const { context, state, video } = createHarness();
  state.adShowing = false;
  state.skipShowing = false;
  state.navigationSkipShowing = true;
  vm.runInNewContext(source, context);

  const controller = context.__talonYoutubeAdSkipCreateController(context);
  assert.equal(controller.tick(), false);
  assert.equal(state.skipClicks, 0);
  assert.equal(state.skipEvents.length, 0);
  assert.equal(video.muted, false);
  assert.equal(video.playbackRate, 1);
});

test('YouTube ad skip does not seek the player and trigger short-video restart loops', async () => {
  const source = await readSource('js/scripting/youtube-ad-skip.js');
  const { context, state, video } = createHarness();
  video.duration = 45;
  video.currentTime = 0;
  state.skipShowing = false;
  vm.runInNewContext(source, context);

  const controller = context.__talonYoutubeAdSkipCreateController(context);
  assert.equal(controller.tick(), true);
  assert.equal(video.currentTime, 0);

  video.currentTime = 0;
  assert.equal(controller.tick(), true);
  assert.equal(video.currentTime, 0);
  assert.equal(state.skipClicks, 0);
  assert.equal(video.playbackRate, 16);
});

test('YouTube ad skip avoids broad document mutation work and coalesces player churn', async () => {
  const source = await readSource('js/scripting/youtube-ad-skip.js');
  const { context, state } = createHarness();
  state.skipShowing = false;
  vm.runInNewContext(source, context);

  const controller = context.__talonYoutubeAdSkipCreateController(context);
  await controller.start();
  assert.equal(state.observerOptions, null);
  assert.equal(state.observerCallback, null);
  assert.equal(state.playerObserverOptions.attributes, true);
  assert.equal(Array.from(state.playerObserverOptions.attributeFilter).join(','), 'class');

  state.skipClicks = 0;
  state.playerObserverCallback();
  state.playerObserverCallback();

  assert.equal(state.timeoutCallbacks.length, 1);
  assert.equal(state.skipClicks, 0);

  state.timeoutCallbacks.shift()();
  assert.equal(state.skipClicks, 0);
});

test('YouTube ad skip hides interruption notices added by YouTube before the next full scan', async () => {
  const source = await readSource('js/scripting/youtube-ad-skip.js');
  const { context, interruptionToast, state } = createHarness();
  state.adShowing = false;
  vm.runInNewContext(source, context);

  const controller = context.__talonYoutubeAdSkipCreateController(context);
  await controller.start();
  state.hiddenInterruptions = 0;
  state.skipShowing = false;

  assert.equal(controller.suppressInterruptionNoticeNodes([{
    addedNodes: [interruptionToast],
  }]), true);
  assert.equal(interruptionToast.hidden, true);
  assert.equal(state.hiddenInterruptions > 0, true);
});

test('YouTube ad skip suppresses only the matching interruptions notice', async () => {
  const source = await readSource('js/scripting/youtube-ad-skip.js');
  const { context, state, video } = createHarness();
  state.adShowing = false;
  state.skipShowing = false;
  state.interruptionShowing = true;
  vm.runInNewContext(source, context);

  const controller = context.__talonYoutubeAdSkipCreateController(context);
  assert.equal(controller.tick(), true);
  assert.equal(state.hiddenInterruptions > 0, true);
  assert.equal(video.muted, false);
  assert.equal(video.playbackRate, 1);
});

test('YouTube ad skip is Talon-owned runtime without remote code or page-script injection', async () => {
  const source = await readSource('js/scripting/youtube-ad-skip.js');

  assert.match(source, /talonYoutubeAdSkip/);
  assert.match(source, /youtubeAdSkip/);
  assert.match(source, /TalonBreakageGuard/);
  assert.match(source, /nocookie/);
  assert.doesNotMatch(source, /chrome\.runtime|browser\.runtime/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /\bXMLHttpRequest\b/);
  assert.doesNotMatch(source, /createElement\(['"]script['"]\)/);
  assert.doesNotMatch(source, /runtime\.getURL/);
  assert.doesNotMatch(source, /currentTime\s*=/);
  assert.match(source, /dispatchSkipActivationEvents/);
  assert.match(source, /MouseEvent/);
  assert.match(source, /\.click\(\)/);
  assert.match(source, /ytd-ad-slot-renderer/);
  assert.doesNotMatch(source, /analytics|posthog/i);
});

test('uBO parity registration excludes YouTube scriptlets and keeps Talon lane separate', async () => {
  const managerSource = await readSource('js/scripting-manager.js');
  const ownershipSource = await readSource('scripts/ubol-source-ownership.json');

  assert.match(managerSource, /const TALON_YOUTUBE_AD_SKIP_ID = 'talon-youtube-ad-skip';/);
  assert.match(managerSource, /const TALON_YOUTUBE_AD_SKIP_PATH = '\/js\/scripting\/youtube-ad-skip\.js';/);
  assert.match(managerSource, /const TALON_YOUTUBE_PLAYER_GUARD_ID = 'talon-youtube-player-guard';/);
  assert.match(managerSource, /const TALON_YOUTUBE_PLAYER_GUARD_PATH = '\/js\/scripting\/youtube-player-guard\.js';/);
  assert.match(managerSource, /function registerYouTubePlayerGuard\(context\)/);
  assert.match(managerSource, /registerYouTubePlayerGuard\(context\)/);
  assert.match(managerSource, /world: 'MAIN'/);
  assert.match(managerSource, /getYouTubeRegistrationScopes/);
  assert.match(managerSource, /const getScriptletExcludedHostnames = \( \) => YOUTUBE_AD_SKIP_HOSTNAMES;/);
  assert.match(managerSource, /function registerYouTubeAdSkip\(context\)/);
  assert.match(managerSource, /registerYouTubeAdSkip\(context\)/);
  assert.match(managerSource, /excludeMatches\.push\(\.\.\.ut\.matchesFromHostnames\(scriptletExcludedHostnames\)\)/);
  assert.match(managerSource, /targetHostnames = ut\.subtractHostnameIters\(\s*targetHostnames,\s*scriptletExcludedHostnames\s*\);/);
  assert.match(ownershipSource, /"js\/scripting\/youtube-ad-skip\.js"/);
  assert.match(ownershipSource, /"js\/scripting\/youtube-player-guard\.js"/);
});


test('YouTube ad skip remains stopped after queued callbacks, navigation, and visibility changes', async () => {
  const source = await readSource('js/scripting/youtube-ad-skip.js');
  const { context, state, video } = createHarness();
  vm.runInNewContext(source, context);
  const controller = context.__talonYoutubeAdSkipCreateController(context);
  await controller.start();
  controller.scheduleTick();
  const queued = state.timeoutCallbacks.slice();
  const listeners = state.listeners.slice();
  controller.stop();
  const clicks = state.skipClicks;
  for (const run of queued) run();
  for (const entry of listeners) (entry.handler || entry.callback)?.();
  assert.equal(controller.tick(), false);
  assert.equal(controller.isActive(), false);
  assert.equal(state.skipClicks, clicks);
  assert.equal(video.currentTime, 2);
  assert.equal(video.muted, false);
  assert.equal(video.playbackRate, 1);
  await controller.start();
  assert.equal(controller.isActive(), true);
});

test('YouTube ad skip stop invalidates a pending start and preserves newer user media choices', async () => {
  const source = await readSource('js/scripting/youtube-ad-skip.js');
  const { context, video } = createHarness();
  let ready;
  context.TalonBreakageGuard = { whenReady: () => new Promise(resolve => { ready = resolve; }), shouldRunSubsystem: () => true };
  vm.runInNewContext(source, context);
  const controller = context.__talonYoutubeAdSkipCreateController(context);
  const pending = controller.start();
  controller.stop(); ready();
  assert.equal((await pending).started, false);
  delete context.TalonBreakageGuard;
  await controller.start();
  video.muted = false; video.playbackRate = 1.5;
  controller.stop();
  assert.equal(video.muted, false);
  assert.equal(video.playbackRate, 1.5);
});

const matchesYouTubeScope = (scopes, host) => scopes.some(scope => {
  const accepts = pattern => {
    const root = pattern.slice(4, -2);
    return root.startsWith('*.')
      ? host === root.slice(2) || host.endsWith(root.slice(1))
      : host === root;
  };
  return scope.matches.some(accepts) && !scope.excludeMatches.some(accepts);
});

test('YouTube registration keeps parent opt-outs authoritative over enabled descendants', async () => {
  const { getYouTubeRegistrationScopes } = await import('../js/youtube-registration.js');
  const modes = { optimal: new Set(['all-urls']), none: new Set(['www.youtube.com']) };
  let scopes = getYouTubeRegistrationScopes(modes);
  assert.equal(matchesYouTubeScope(scopes, 'www.youtube.com'), false);
  assert.equal(matchesYouTubeScope(scopes, 'm.youtube.com'), true);
  assert.equal(matchesYouTubeScope(scopes, 'youtube-nocookie.com'), true);
  modes.optimal.add('embedded.www.youtube.com');
  scopes = getYouTubeRegistrationScopes(modes);
  assert.equal(matchesYouTubeScope(scopes, 'embedded.www.youtube.com'), false);
  assert.equal(matchesYouTubeScope(scopes, 'deep.embedded.www.youtube.com'), false);
  assert.equal(matchesYouTubeScope(scopes, 'other.www.youtube.com'), false);
  scopes = getYouTubeRegistrationScopes({ none: new Set(['all-urls']), basic: new Set(['m.youtube.com']) });
  assert.equal(matchesYouTubeScope(scopes, 'm.youtube.com'), true);
  assert.equal(matchesYouTubeScope(scopes, 'child.m.youtube.com'), true);
  assert.equal(matchesYouTubeScope(scopes, 'www.youtube.com'), false);
  assert.equal(matchesYouTubeScope(getYouTubeRegistrationScopes(modes, ['youtube.com']), 'embedded.www.youtube.com'), false);
});

test('YouTube registration follows BASIC fallback and only the authoritative all-urls sentinel', async () => {
  const { getYouTubeRegistrationScopes } = await import('../js/youtube-registration.js');
  for (const modes of [{}, { basic: ['all-urls'] }, { complete: ['all-urls'] }]) {
    const scopes = getYouTubeRegistrationScopes(modes);
    for (const host of ['youtube.com', 'www.youtube.com', 'deep.m.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com']) {
      assert.equal(matchesYouTubeScope(scopes, host), true, host);
    }
    for (const host of ['example.com', 'notyoutube.com', 'youtube.com.example.com', 'notyoutube-nocookie.com']) {
      assert.equal(matchesYouTubeScope(scopes, host), false, host);
    }
  }
  assert.deepEqual(getYouTubeRegistrationScopes({ none: ['all-urls'], optimal: ['all-urls'] }), []);
  assert.deepEqual(getYouTubeRegistrationScopes({ none: ['*'] }), []);
  assert.equal(matchesYouTubeScope(getYouTubeRegistrationScopes({ none: ['all-urls', '*'], basic: ['m.youtube.com'] }), 'm.youtube.com'), true);
  assert.deepEqual(getYouTubeRegistrationScopes({ none: ['com'], complete: ['youtube.com'] }), []);
});

test('YouTube registration preserves exact entries when global sentinels skip ancestor walks', async () => {
  const { getYouTubeRegistrationScopes } = await import('../js/youtube-registration.js');
  const modes = {
    none: ['all-urls', 'www.youtube.com'],
    basic: ['youtube.com'],
  };
  let scopes = getYouTubeRegistrationScopes(modes);
  assert.equal(matchesYouTubeScope(scopes, 'youtube.com'), true);
  assert.equal(matchesYouTubeScope(scopes, 'www.youtube.com'), false);
  assert.equal(matchesYouTubeScope(scopes, 'child.www.youtube.com'), true);
  assert.equal(matchesYouTubeScope(scopes, 'youtube-nocookie.com'), false);
  scopes = getYouTubeRegistrationScopes({ none: ['all-urls'], basic: ['all-urls', 'm.youtube.com'] });
  assert.equal(matchesYouTubeScope(scopes, 'm.youtube.com'), true);
  assert.equal(matchesYouTubeScope(scopes, 'child.m.youtube.com'), false);
  assert.equal(matchesYouTubeScope(scopes, 'www.youtube.com'), false);
});

test('YouTube subsystem suppression dominates exact and descendant enabled scopes', async () => {
  const { getYouTubeRegistrationScopes } = await import('../js/youtube-registration.js');
  const modes = { none: ['all-urls', 'www.youtube.com'], basic: ['youtube.com', 'youtube-nocookie.com'] };
  const scopes = getYouTubeRegistrationScopes(modes, ['www.youtube.com', 'embedded.youtube-nocookie.com']);
  for (const host of ['www.youtube.com', 'child.www.youtube.com', 'embedded.youtube-nocookie.com', 'deep.embedded.youtube-nocookie.com']) {
    assert.equal(matchesYouTubeScope(scopes, host), false, host);
  }
  for (const host of ['m.youtube.com', 'youtube-nocookie.com', 'other.youtube-nocookie.com']) {
    assert.equal(matchesYouTubeScope(scopes, host), true, host);
  }
});


test('YouTube ad skip does not restart a legacy controller during update', async () => {
  const source = await fs.readFile(new URL('../js/scripting/youtube-ad-skip.js', import.meta.url), 'utf8');
  let refreshed = false;
  const context = vm.createContext({ TalonYoutubeAdSkipController: { refresh() { refreshed = true; } } });
  vm.runInContext(source, context);
  assert.equal(refreshed, false);
  assert.equal(context.TalonYoutubeAdSkipController.revision, undefined);
});
