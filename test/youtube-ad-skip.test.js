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
  const youtubeMatchBlock = managerSource.slice(
    managerSource.indexOf('const getYouTubeAdSkipMatches'),
    managerSource.indexOf('const getYouTubeAdSkipExcludeMatches')
  );
  const youtubeExcludeBlock = managerSource.slice(
    managerSource.indexOf('const getYouTubeAdSkipExcludeMatches'),
    managerSource.indexOf('const readActiveAutoGenericHighHosts')
  );
  assert.match(youtubeMatchBlock, /filteringModeDetails\?\.basic/);
  assert.match(youtubeExcludeBlock, /filteringModeDetails\?\.none/);
  assert.doesNotMatch(youtubeExcludeBlock, /filteringModeDetails\?\.basic/);
  assert.match(managerSource, /const getScriptletExcludedHostnames = \( \) => YOUTUBE_AD_SKIP_HOSTNAMES;/);
  assert.match(managerSource, /function registerYouTubeAdSkip\(context\)/);
  assert.match(managerSource, /registerYouTubeAdSkip\(context\)/);
  assert.match(managerSource, /excludeMatches\.push\(\.\.\.ut\.matchesFromHostnames\(scriptletExcludedHostnames\)\)/);
  assert.match(managerSource, /targetHostnames = ut\.subtractHostnameIters\(\s*targetHostnames,\s*scriptletExcludedHostnames\s*\);/);
  assert.match(ownershipSource, /"js\/scripting\/youtube-ad-skip\.js"/);
  assert.match(ownershipSource, /"js\/scripting\/youtube-player-guard\.js"/);
});
